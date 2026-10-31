/* 本地声纹：SILK→WAV 后提取 192 维说话人向量（CAM++ 中文 16k ONNX），比对后认出是谁。
 * 依赖 vendor/sherpa-onnx-node（含 kaldi fbank、ONNX 推理、线性重采样），全部本地跑，不走网络。
 * 样本按「音频时长」管理：每个人最多 maxSeconds 秒（默认 300 秒 = 5 分钟），
 * 每条语音把自身时长计进去，超出预算先淘汰最老的样本；另有 maxPerName 条数上限兜底。 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(LIB_DIR, '..')
const DEFAULT_MODEL = join(PLUGIN_DIR, 'models', 'campplus_zh_16k.onnx')
const DEFAULT_SHERPA = join(PLUGIN_DIR, 'vendor', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')
const TARGET_RATE = 16000

/** 解析 16bit PCM WAV → { samples: Float32Array, sampleRate } */
export function wavToSamples(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件')
  }
  let offset = 12
  let fmt = null
  let dataStart = -1
  let dataLen = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataStart = body
      dataLen = Math.min(size, buf.length - body)
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || dataStart < 0) throw new Error('WAV 缺少 fmt/data 段')
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('只支持 16bit PCM WAV（实际 format=' + fmt.format + ' bits=' + fmt.bits + '）')
  const frames = Math.floor(dataLen / (2 * fmt.channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += buf.readInt16LE(dataStart + (i * fmt.channels + c) * 2)
    samples[i] = sum / fmt.channels / 32768
  }
  return { samples, sampleRate: fmt.sampleRate }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

export class SpeakerVoiceprint {
  constructor(rootDir, config = {}) {
    this.root = String(rootDir || '')
    this.file = join(this.root, 'voiceprint.json')
    this.config = this.normalizeConfig(config)
    this._mod = null
    this._extractor = null
    this._resamplers = new Map()
    this.profiles = this.readProfiles()
  }

  normalizeConfig(config = {}) {
    const c = config && typeof config === 'object' ? config : {}
    return {
      enabled: c.enabled !== false,
      threshold: Math.min(0.99, Math.max(0.3, Number(c.threshold) || 0.55)),
      autoCollectAbove: Math.min(0.99, Math.max(0.5, Number(c.autoCollectAbove) || 0.78)),
      // 时长预算满（300 秒）之后，自动收录门槛调高到这个值
      autoCollectAboveWhenFull: Math.min(0.99, Math.max(0.5, Number(c.autoCollectAboveWhenFull) || 0.8)),
      // 前这么多秒的语音无门槛收录
      freeEnrollSeconds: Math.max(0, Math.min(600, Number(c.freeEnrollSeconds) || 60)),
      // 群聊里只有勾选过的人（openid）才做声纹识别/收录
      allowedMembers: Array.isArray(c.allowedMembers) ? c.allowedMembers.map((item) => String(item)).filter(Boolean).slice(0, 200) : [],
      maxPerName: Math.max(1, Math.min(50, Number(c.maxPerName) || 20)),
      // 每个人声纹样本的总时长预算（秒），默认 5 分钟
      maxSeconds: Math.max(10, Math.min(3600, Number(c.maxSeconds) || 300)),
      modelPath: typeof c.modelPath === 'string' && c.modelPath.trim() !== '' ? c.modelPath.trim() : DEFAULT_MODEL,
      sherpaModulePath: typeof c.sherpaModulePath === 'string' && c.sherpaModulePath.trim() !== '' ? c.sherpaModulePath.trim() : DEFAULT_SHERPA,
    }
  }

  readProfiles() {
    try {
      if (!existsSync(this.file)) return {}
      const parsed = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      const profiles = parsed && typeof parsed.profiles === 'object' && parsed.profiles ? parsed.profiles : {}
      const out = {}
      for (const [name, value] of Object.entries(profiles)) {
        const raw = Array.isArray(value && value.embeddings) ? value.embeddings : []
        const samples = []
        for (const item of raw) {
          // 兼容旧格式：[...192个数]
          if (Array.isArray(item) && item.length > 0) {
            samples.push({ v: item, sec: 3, at: Number(value && value.updatedAt) || Date.now() })
          } else if (item && Array.isArray(item.v) && item.v.length > 0) {
            samples.push({ v: item.v, sec: Math.max(0, Number(item.sec) || 0), at: Number(item.at) || Date.now() })
          }
        }
        if (samples.length > 0) out[String(name)] = { samples, updatedAt: Number(value.updatedAt) || Date.now() }
      }
      return out
    } catch {
      return {}
    }
  }

  saveProfiles() {
    try {
      mkdirSync(this.root, { recursive: true })
      const profiles = {}
      for (const [name, value] of Object.entries(this.profiles)) {
        profiles[name] = {
          embeddings: value.samples.map((sample) => ({ v: sample.v, sec: sample.sec, at: sample.at })),
          updatedAt: value.updatedAt,
        }
      }
      writeFileSync(this.file, JSON.stringify({ profiles }, null, 2) + '\n', 'utf8')
    } catch { /* ignore */ }
  }

  enabled() {
    return this.config.enabled === true
  }

  totalSeconds(name) {
    const entry = this.profiles[name]
    if (!entry) return 0
    return entry.samples.reduce((sum, sample) => sum + (Number(sample.sec) || 0), 0)
  }

  status() {
    const names = Object.keys(this.profiles)
    return {
      enabled: this.enabled(),
      threshold: this.config.threshold,
      autoCollectAbove: this.config.autoCollectAbove,
      autoCollectAboveWhenFull: this.config.autoCollectAboveWhenFull,
      freeEnrollSeconds: this.config.freeEnrollSeconds,
      allowedMembers: this.config.allowedMembers.slice(),
      maxPerName: this.config.maxPerName,
      maxSeconds: this.config.maxSeconds,
      modelReady: existsSync(this.config.modelPath),
      sherpaReady: existsSync(this.config.sherpaModulePath),
      modelPath: this.config.modelPath,
      namesCount: names.length,
      profiles: names.map((name) => ({
        name,
        samples: this.profiles[name].samples.length,
        seconds: Math.round(this.totalSeconds(name) * 10) / 10,
        updatedAt: this.profiles[name].updatedAt,
      })),
    }
  }

  sherpa() {
    if (this._mod) return this._mod
    if (!existsSync(this.config.sherpaModulePath)) throw new Error('没有本地声纹引擎：' + this.config.sherpaModulePath)
    const mod = createRequire(pathToFileURL(this.config.sherpaModulePath).href)(this.config.sherpaModulePath)
    this._mod = mod
    return mod
  }

  extractor() {
    if (this._extractor) return this._extractor
    if (!existsSync(this.config.modelPath)) throw new Error('没有声纹模型：' + this.config.modelPath)
    const sherpa = this.sherpa()
    this._extractor = new sherpa.SpeakerEmbeddingExtractor({ model: this.config.modelPath, numThreads: 1, debug: false, provider: 'cpu' })
    return this._extractor
  }

  resample(samples, fromRate) {
    if (fromRate === TARGET_RATE) return samples
    const sherpa = this.sherpa()
    let resampler = this._resamplers.get(fromRate)
    if (!resampler) {
      resampler = new sherpa.LinearResampler(fromRate, TARGET_RATE)
      this._resamplers.set(fromRate, resampler)
    }
    return resampler.resample(samples)
  }

  /** WAV Buffer → { embedding, seconds } */
  embedWavDetailed(buffer) {
    const { samples, sampleRate } = wavToSamples(buffer)
    if (samples.length < TARGET_RATE / 4) throw new Error('语音太短（不足 0.25 秒）')
    const seconds = samples.length / sampleRate
    const pcm = this.resample(samples, sampleRate)
    const extractor = this.extractor()
    const stream = extractor.createStream()
    stream.acceptWaveform({ sampleRate: TARGET_RATE, samples: pcm })
    stream.inputFinished()
    if (!extractor.isReady(stream)) throw new Error('语音特征不足，算不出声纹')
    const emb = extractor.compute(stream, false)
    return { embedding: Array.from(emb), seconds }
  }

  /** WAV Buffer → 192 维声纹向量（兼容旧调用） */
  embedWav(buffer) {
    return this.embedWavDetailed(buffer).embedding
  }

  isNearDuplicate(a, b) {
    return cosine(a, b) > 0.985
  }

  /** 加一条样本：近重复跳过；按「总时长预算」淘汰最老的；条数上限兜底 */
  addSample(name, embedding, options = {}) {
    const key = String(name || '').trim()
    if (key === '' || !Array.isArray(embedding) || embedding.length === 0) return { added: false, reason: 'bad-input' }
    const seconds = Math.max(0, Number(options.seconds) || 0)
    const existing = this.profiles[key] || { samples: [], updatedAt: Date.now() }
    if (existing.samples.some((known) => this.isNearDuplicate(embedding, known.v))) {
      return { added: false, reason: 'duplicate', samples: existing.samples.length, seconds: this.totalSeconds(key) }
    }
    const samples = existing.samples.slice()
    samples.push({ v: embedding, sec: seconds, at: Date.now() })
    // 条数上限：超出时淘汰「跟其它样本最像、最没信息量」的一条（保留最新）
    while (samples.length > this.config.maxPerName) {
      let worstIndex = 0
      let worstScore = Infinity
      for (let i = 0; i < samples.length - 1; i++) {
        let sum = 0
        let count = 0
        for (let j = 0; j < samples.length; j++) {
          if (i === j) continue
          sum += cosine(samples[i].v, samples[j].v)
          count += 1
        }
        const average = count === 0 ? 0 : sum / count
        if (average < worstScore) { worstScore = average; worstIndex = i }
      }
      samples.splice(worstIndex, 1)
    }
    // 时长预算：超了多少秒，就从最老的样本上「剪掉」多少秒（够剪就整条删，不够就只剪一部分时长）
    let total = samples.reduce((sum, sample) => sum + (Number(sample.sec) || 0), 0)
    if (total > this.config.maxSeconds) {
      let deficit = total - this.config.maxSeconds
      while (deficit > 1e-6 && samples.length > 1) {
        const oldest = samples[0]
        const oldestSeconds = Math.max(0, Number(oldest.sec) || 0)
        if (oldestSeconds <= deficit + 1e-6) {
          // 这条不够剪，整条去掉，继续从下一条老的剪
          deficit -= oldestSeconds
          samples.shift()
        } else {
          // 只剪这条的一部分时长（比如新加 60 秒，就从最老那条剪 60 秒）
          oldest.sec = Math.round((oldestSeconds - deficit) * 1000) / 1000
          deficit = 0
        }
      }
      total = samples.reduce((sum, sample) => sum + (Number(sample.sec) || 0), 0)
    }
    this.profiles[key] = { samples, updatedAt: Date.now() }
    this.saveProfiles()
    return { added: true, samples: samples.length, seconds: Math.round(total * 10) / 10, name: key }
  }

  /** 整理库：去近重复、剔离群样本（少于 4 条不动） */
  optimize() {
    const report = []
    for (const [name, value] of Object.entries(this.profiles)) {
      const before = value.samples.length
      let list = value.samples.slice()
      const deduped = []
      for (const sample of list) {
        if (!deduped.some((known) => this.isNearDuplicate(sample.v, known.v))) deduped.push(sample)
      }
      if (deduped.length > 3) {
        const centroid = new Array(deduped[0].v.length).fill(0)
        for (const sample of deduped) for (let i = 0; i < centroid.length; i++) centroid[i] += sample.v[i] / deduped.length
        const kept = deduped.filter((sample) => cosine(centroid, sample.v) >= 0.4)
        list = kept.length >= 3 ? kept : deduped
      } else {
        list = deduped
      }
      if (list.length !== before) this.profiles[name] = { samples: list, updatedAt: Date.now() }
      report.push({ name, before, after: list.length, seconds: Math.round(this.totalSeconds(name) * 10) / 10 })
    }
    this.saveProfiles()
    return report
  }

  /** 登记/追加一个名字的声纹样本（自动带时长） */
  register(name, wavBuffer) {
    const key = String(name || '').trim()
    if (key === '') throw new Error('名字不能为空')
    const detailed = this.embedWavDetailed(wavBuffer)
    const result = this.addSample(key, detailed.embedding, { seconds: detailed.seconds })
    if (result.added === false && result.reason === 'duplicate') {
      return { name: key, samples: result.samples, seconds: result.seconds, dim: detailed.embedding.length, duplicate: true }
    }
    return { name: key, samples: result.samples, seconds: result.seconds, dim: detailed.embedding.length }
  }

  remove(name) {
    const key = String(name || '').trim()
    if (!this.profiles[key]) return false
    delete this.profiles[key]
    this.saveProfiles()
    return true
  }

  /** 每个名字的样本明细（面板用）：索引、时长、时间 */
  samplesList() {
    const out = []
    for (const [name, value] of Object.entries(this.profiles)) {
      out.push({
        name,
        seconds: Math.round(this.totalSeconds(name) * 10) / 10,
        samples: value.samples.map((sample, index) => ({
          index,
          seconds: Math.round((Number(sample.sec) || 0) * 10) / 10,
          at: sample.at,
        })),
      })
    }
    return out
  }

  /** 删掉某个名字名下第 index 条样本 */
  removeSample(name, index) {
    const key = String(name || '').trim()
    const entry = this.profiles[key]
    const position = Number(index)
    if (!entry || !Number.isInteger(position) || position < 0 || position >= entry.samples.length) return false
    entry.samples.splice(position, 1)
    if (entry.samples.length === 0) delete this.profiles[key]
    else entry.updatedAt = Date.now()
    this.saveProfiles()
    return true
  }

  /** 从 WAV 文件登记（面板/调试用） */
  registerFromFile(name, filePath) {
    return this.register(name, readFileSync(filePath))
  }

  /** 从 WAV 文件比对（面板/调试用） */
  identifyFromFile(filePath) {
    return this.identify(readFileSync(filePath))
  }

  /** 比对：返回最相似的名字和分数（低于阈值也返回分数和向量，由调用方决定怎么标） */
  identify(wavBuffer, threshold) {
    const names = Object.keys(this.profiles)
    if (names.length === 0) return { name: '', score: 0, matched: false, empty: true }
    const detailed = this.embedWavDetailed(wavBuffer)
    let best = { name: '', score: -1 }
    for (const name of names) {
      for (const sample of this.profiles[name].samples) {
        const score = cosine(detailed.embedding, sample.v)
        if (score > best.score) best = { name, score }
      }
    }
    const limit = Number.isFinite(Number(threshold)) ? Number(threshold) : this.config.threshold
    return { name: best.name, score: best.score, matched: best.score >= limit, empty: false, embedding: detailed.embedding, seconds: detailed.seconds }
  }
}
