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

/** 语速标签：字/秒 */
export function describeSpeed(charsPerSecond) {
  const speed = Number(charsPerSecond)
  if (!Number.isFinite(speed) || speed <= 0) return ''
  if (speed < 2) return '慢'
  if (speed < 4.5) return '正常'
  return '快'
}

/**
 * 粗略音色分析（本地、不依赖模型）：
 * 基频 → 低沉 / 中低 / 中高 / 清亮；响度 → 小声 / 一般 / 洪亮；过零率 → 柔和 / 均衡 / 明亮。
 * 只给粗略标签，别当成专业声学分析。
 */
export function analyzeTimbre(buffer) {
  const { samples, sampleRate } = wavToSamples(buffer)
  const RATE = 16000
  const limitSeconds = 30
  const maxSamples = Math.min(samples.length, Math.floor(sampleRate * limitSeconds))
  const data = sampleRate === RATE
    ? samples.subarray(0, maxSamples)
    : (() => {
        const ratio = sampleRate / RATE
        const out = new Float32Array(Math.max(1, Math.floor(maxSamples / ratio)))
        for (let i = 0; i < out.length; i++) {
          const pos = i * ratio
          const i0 = Math.floor(pos)
          const i1 = Math.min(maxSamples - 1, i0 + 1)
          const frac = pos - i0
          out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
        }
        return out
      })()
  const frame = Math.round(RATE * 0.04)
  const hop = Math.round(RATE * 0.02)
  if (data.length < frame * 2) return { ok: false, reason: '太短' }
  const minLag = Math.floor(RATE / 500)
  const maxLag = Math.min(frame - 2, Math.floor(RATE / 60))
  const pitches = []
  let rmsSum = 0
  let rmsCount = 0
  let zcrSum = 0
  let frameCount = 0
  for (let start = 0; start + frame <= data.length; start += hop) {
    let energy = 0
    let zc = 0
    for (let i = start; i < start + frame; i++) {
      const v = data[i]
      energy += v * v
      if (i > start && ((data[i - 1] < 0 && v >= 0) || (data[i - 1] >= 0 && v < 0))) zc += 1
    }
    const rms = Math.sqrt(energy / frame)
    rmsSum += rms
    rmsCount += 1
    zcrSum += zc / frame
    frameCount += 1
    if (rms < 0.012) continue
    const scores = new Float32Array(maxLag - minLag + 1)
    let bestNcc = 0
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0
      let e1 = 0
      let e2 = 0
      for (let i = start; i < start + frame - lag; i++) {
        const a = data[i]
        const b = data[i + lag]
        corr += a * b
        e1 += a * a
        e2 += b * b
      }
      const ncc = corr / Math.sqrt(e1 * e2 + 1e-12)
      scores[lag - minLag] = ncc
      if (ncc > bestNcc) bestNcc = ncc
    }
    if (bestNcc >= 0.42) {
      // 取「第一个够强的峰」而不是全局最大，避免把周期选中成 2 倍、3 倍（八度偏低）
      const bar = Math.max(0.42, bestNcc * 0.9)
      for (let i = 0; i < scores.length; i += 1) {
        const ncc = scores[i]
        if (ncc < bar) continue
        const prev = i > 0 ? scores[i - 1] : -1
        const next = i + 1 < scores.length ? scores[i + 1] : -1
        if (ncc >= prev && ncc >= next) {
          pitches.push(RATE / (minLag + i))
          break
        }
      }
    }
  }
  const meanRms = rmsCount === 0 ? 0 : rmsSum / rmsCount
  const meanZcr = frameCount === 0 ? 0 : zcrSum / frameCount
  pitches.sort((a, b) => a - b)
  const pitchHz = pitches.length === 0 ? 0 : Math.round(pitches[Math.floor(pitches.length / 2)])
  const rmsDb = meanRms <= 0 ? -90 : Math.round(20 * Math.log10(meanRms) * 10) / 10
  const zcr = Math.round(meanZcr * 1000) / 1000
  const pitchLabel = pitchHz === 0
    ? '不明'
    : pitchHz < 130
      ? '低沉'
      : pitchHz < 200
        ? '中低音'
        : pitchHz < 260
          ? '中高音'
          : '清亮'
  const loudLabel = rmsDb < -34 ? '小声' : rmsDb < -22 ? '音量一般' : '洪亮'
  const brightLabel = zcr < 0.06 ? '柔和' : zcr < 0.14 ? '均衡' : '明亮'
  return {
    ok: true,
    pitchHz,
    pitchLabel,
    rmsDb,
    loudLabel,
    zcr,
    brightLabel,
    voicedRatio: Math.round((pitches.length / Math.max(1, frameCount)) * 100) / 100,
    summary: pitchLabel + ' · ' + loudLabel + ' · ' + brightLabel,
  }
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
        const timbreHistory = Array.isArray(value && value.timbreHistory)
          ? value.timbreHistory
              .filter((item) => item && typeof item === 'object')
              .map((item) => ({
                pitchHz: Number(item.pitchHz) || 0,
                rmsDb: Number(item.rmsDb) || 0,
                zcr: Number(item.zcr) || 0,
                speed: typeof item.speed === 'string' ? item.speed : '',
                at: Number(item.at) || Date.now(),
              }))
              .slice(-5)
          : []
        if (samples.length > 0) out[String(name)] = { samples, timbreHistory, updatedAt: Number(value.updatedAt) || Date.now() }
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
          timbreHistory: Array.isArray(value.timbreHistory) ? value.timbreHistory.slice(-5) : [],
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
        timbre: this.timbreOf(name),
      })),
    }
  }

  /** 单段语音的粗略音色估算（转发到模块里的 analyzeTimbre） */
  analyzeTimbre(buffer) {
    return analyzeTimbre(buffer)
  }

  /** 把一次估算记进这个人的档案（只留最近 5 次，聚合时用） */
  noteTimbre(name, features) {
    const key = String(name || '').trim()
    if (key === '' || !features || features.ok !== true) return false
    const entry = this.profiles[key]
    if (!entry) return false
    if (!Array.isArray(entry.timbreHistory)) entry.timbreHistory = []
    entry.timbreHistory.push({
      pitchHz: Number(features.pitchHz) || 0,
      rmsDb: Number(features.rmsDb) || 0,
      zcr: Number(features.zcr) || 0,
      speed: typeof features.speed === 'string' ? features.speed : '',
      at: Date.now(),
    })
    entry.timbreHistory = entry.timbreHistory.slice(-5)
    this.saveProfiles()
    return true
  }

  /** 这个人整体的音色标签（基频取中位数，响度/过零率取平均） */
  timbreOf(name) {
    const key = String(name || '').trim()
    const entry = this.profiles[key]
    if (!entry) return null
    const history = Array.isArray(entry.timbreHistory) ? entry.timbreHistory : []
    const pitches = history.map((item) => Number(item.pitchHz)).filter((value) => value > 0)
    if (pitches.length === 0) return null
    pitches.sort((a, b) => a - b)
    const pitchHz = Math.round(pitches[Math.floor(pitches.length / 2)])
    const rmsList = history.map((item) => Number(item.rmsDb)).filter((value) => Number.isFinite(value))
    const zcrList = history.map((item) => Number(item.zcr)).filter((value) => Number.isFinite(value))
    const rmsDb = rmsList.length ? rmsList.reduce((a, b) => a + b, 0) / rmsList.length : -90
    const zcr = zcrList.length ? zcrList.reduce((a, b) => a + b, 0) / zcrList.length : 0
    const speeds = history.map((item) => item.speed).filter(Boolean)
    const speed = speeds.length ? speeds[speeds.length - 1] : ''
    const pitchLabel = pitchHz < 130 ? '低沉' : pitchHz < 200 ? '中低音' : pitchHz < 260 ? '中高音' : '清亮'
    const loudLabel = rmsDb < -34 ? '小声' : rmsDb < -22 ? '音量一般' : '洪亮'
    const brightLabel = zcr < 0.06 ? '柔和' : zcr < 0.14 ? '均衡' : '明亮'
    return {
      pitchHz,
      rmsDb: Math.round(rmsDb * 10) / 10,
      zcr: Math.round(zcr * 1000) / 1000,
      pitchLabel,
      loudLabel,
      brightLabel,
      speed,
      summary: pitchLabel + ' · ' + loudLabel + ' · ' + brightLabel + (speed ? ' · 语速' + speed : ''),
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
    try {
      const timbre = analyzeTimbre(wavBuffer)
      if (timbre && timbre.ok) this.noteTimbre(key, timbre)
    } catch { /* 音色估算失败不影响登记 */ }
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
