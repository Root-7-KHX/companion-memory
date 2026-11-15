/**
 * ops-agent.js — 每轮「子智能体」（操控中心）
 *
 * 用户的原始需求（2026-11-13）：
 *   「性能模式那里，调用那个子智能体，你要让他每一轮都调用。但是调用可以分配：
 *     一块可以分配情绪，一块可以分配语言习惯，一块可以分配记忆等等。
 *     还要留一个接口，以后有什么操控的（比如大肥鱼的皮套），就用这里面的操控。」
 *
 * 它是什么：
 *   一个宿主侧的「每轮都跑」的小分析器。每轮对话结束（宿主 `agent/turn-stopping`）
 *   后，拿最近 N 条对话去调一次模型（默认跟随当前对话的模型，可固定），
 *   按「分配到的块」分别产出结果并写回记忆系统：
 *     · emotion 情绪   → store.setEmotions()，直接写进情绪表
 *     · style   语言习惯 → 存 <会话数据目录>/ops.json，并注入下一轮动态上下文
 *     · memory  记忆   → store.addMemory()（子智能体自己判断值不值得记）
 *     · control 操控   → 写进「操控总线」队列，等外部消费者（皮套等）来取
 *
 * 操控总线（留给以后的接口）：
 *   GET  /companion/ops/control/pending?session=<id>&after=<seq>  取一批动作
 *   POST /companion/ops/control/ack      {"session":…, "ids":[…]}  确认已消费
 *   GET  /companion/ops/spec             接口说明 + 动作规范
 *   动作形状：{ id, seq, type, payload, ttlMs, createdAt }
 *   约定：皮套以后轮询 pending，实现「表情/动作/视线/参数」这类操控；
 *         type 现在自由字符串，内置约定见 OPS_CONTROL_TYPES，未知 type 原样透传。
 *
 * 其余接口：
 *   GET  /companion/ops/state?session=<id>   当前配置 + 上一次运行结果 + 语言习惯 + 待取动作数
 *   POST /companion/ops/run                  立即跑一次（面板「立即分析本轮」）
 *   POST /companion/ops/config               改分配（等价于 POST /companion/api/performance 带 ops）
 *
 * 开关/分配存在 performance.json 的 ops 字段里（每个对话一份，见 performance.js）。
 * 所有失败都只写日志、绝不影响对话主链。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { callModelText, CLEAN_DEFAULT_MODEL } from './llm-call.js'
import { isTrustedApiRequest } from './api.js'

const STATE_FILE = 'ops.json'
// 跨对话共享的「整体情绪」：她自己的心情，不分对话、不分是谁在跟她说话
const GLOBAL_FILE = 'ops-global.json'
const STATE_VERSION = 1
const MAX_LOG_BYTES = 512 * 1024
const RUN_TIMEOUT_MS = 90 * 1000
const CONTROL_LIMIT = 100
const CONTROL_TTL_DEFAULT = 15000
const CONTROL_TTL_MAX = 600000

/** 能分配到「每轮子智能体」的块。key 与 ops.json / performance.json 里的一致。 */
export const OPS_BLOCKS = [
  {
    key: 'emotion',
    label: '情绪',
    hint: '每轮读出角色此刻的情绪变化（只能写已存在的情绪种类；没有明显变化就不写）。',
  },
  {
    key: 'style',
    label: '语言习惯',
    hint: '从用户说话方式里提炼「怎么说话」（句式、口头禅、长度、语气），写进下一轮动态上下文。',
  },
  {
    key: 'memory',
    label: '记忆',
    hint: '自己判断这一轮有没有值得长期记的（人设、约定、剧情节点、固定偏好），像 turn_end 一样写进记忆。',
  },
  {
    key: 'control',
    label: '操控（预留接口）',
    hint: '产出可被外部消费的操控动作（表情/动作/视线/参数），以后皮套从这里取；现在只排进总线。',
  },
]

/** 分配到的块可以分别调用，也可以合成一次调用。 */
export const OPS_MODES = [
  { key: 'single', label: '一次调用', hint: '所有块合成一次模型调用，最省；各块互相知道彼此内容。' },
  { key: 'split', label: '分块调用', hint: '每个块各调一次模型，互不影响；块多时更慢、更贵，但结果更干净。' },
]

/** 控制总线的内置动作类型（给以后接皮套用；未知 type 也原样透传）。 */
export const OPS_CONTROL_TYPES = [
  { type: 'expression', desc: '切表情：payload { name: "爱心眼" }，配 ttlMs 到时自动收回' },
  { type: 'motion', desc: '播动作：payload { name: "举手" }' },
  { type: 'look', desc: '看哪里：payload { x: 0~1, y: 0~1 }' },
  { type: 'say', desc: '让她说一句话：payload { text: "…" }（皮套可以只做口型）' },
  { type: 'param', desc: '直接写 Live2D 参数：payload { id: "ParamAngleX", value: 20 }' },
  { type: 'emote', desc: '情绪表达：payload { emotion: "开心", intensity: 0~1 }' },
]

/**
 * 情绪波动档位：决定「子智能体能不能瞬间让她变脸、变多大、多久回落」。
 * 用户反馈：以前的 AI 情绪太稳定、不会瞬间变换 —— 这里给它「当场发火/当场开心」的权限。
 */
export const OPS_EMOTION_PRESETS = {
  stable: {
    key: 'stable',
    label: '稳定',
    hint: '不主动制造突变：单次最多 ±25，不注入情绪指令（还是那个情绪平稳的样子）。',
    allowSpike: false,
    maxJump: 25,
    decayPerTurn: 6,
    inject: false,
  },
  normal: {
    key: 'normal',
    label: '正常',
    hint: '有明显触发（被冒犯/被夸/被撩/被冷落）就当场变脸，最多跳到 85，每轮回落 12。',
    allowSpike: true,
    maxJump: 85,
    decayPerTurn: 12,
    inject: true,
  },
  sensitive: {
    key: 'sensitive',
    label: '敏感',
    hint: '更容易被带情绪：可以瞬间拉满，漏点小刺也会记一会儿，每轮回落 18。',
    allowSpike: true,
    maxJump: 100,
    decayPerTurn: 18,
    inject: true,
  },
  volatile: {
    key: 'volatile',
    label: '一点就炸',
    hint: '有触发就朝 100 冲，而且回落慢（每轮 10）：生气会持续好几轮，得哄。',
    allowSpike: true,
    maxJump: 100,
    decayPerTurn: 10,
    inject: true,
  },
}

export const DEFAULT_OPS = Object.freeze({
  enabled: true,
  mode: 'single',
  // 送进子智能体的最近消息条数（user+assistant 都算）
  window: 12,
  // 空 = 跟随当前对话的模型；填了就用这一对（例如本地小模型）
  model: { provider: '', model: '' },
  blocks: {
    emotion: { enabled: true, hint: '' },
    style: { enabled: true, hint: '' },
    memory: { enabled: true, hint: '' },
    control: { enabled: false, hint: '' },
  },
  // 情绪波动与惯性（用户要求：允许瞬间变换情绪，并且不要秒冷静）
  emotionTuning: {
    volatility: 'normal',
    // 每轮回落的点数；填了就覆盖档位自带的回落速度
    decayPerTurn: null,
    // 是否把「还在气头上」写成下一轮的行为指令
    inject: true,
  },
  // 情绪跨对话共享：在任意一个对话里被惹到，换个人来聊她也还是那个心情
  sharedMood: true,
})

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

/** 把任意输入（面板补丁 / 旧文件）规整成一份完整的 ops 配置。 */
export function normalizeOps(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const model = source.model && typeof source.model === 'object' ? source.model : {}
  const blocksSource = source.blocks && typeof source.blocks === 'object' ? source.blocks : {}
  const blocks = {}
  for (const definition of OPS_BLOCKS) {
    const raw = blocksSource[definition.key] && typeof blocksSource[definition.key] === 'object' ? blocksSource[definition.key] : {}
    blocks[definition.key] = {
      enabled: raw.enabled === undefined ? DEFAULT_OPS.blocks[definition.key].enabled : raw.enabled === true,
      hint: typeof raw.hint === 'string' ? raw.hint.trim().slice(0, 400) : '',
    }
  }
  const tuningSource = source.emotionTuning && typeof source.emotionTuning === 'object' ? source.emotionTuning : {}
  const volatility = OPS_EMOTION_PRESETS[tuningSource.volatility] ? tuningSource.volatility : DEFAULT_OPS.emotionTuning.volatility
  const decayOverride = tuningSource.decayPerTurn
  return {
    enabled: source.enabled === undefined ? DEFAULT_OPS.enabled : source.enabled === true,
    mode: OPS_MODES.some((item) => item.key === source.mode) ? source.mode : DEFAULT_OPS.mode,
    window: clampInt(source.window, 4, 40, DEFAULT_OPS.window),
    model: {
      provider: typeof model.provider === 'string' ? model.provider.trim() : '',
      model: typeof model.model === 'string' ? model.model.trim() : '',
    },
    blocks,
    emotionTuning: {
      volatility,
      decayPerTurn: decayOverride === undefined || decayOverride === null
        ? null
        : clampInt(decayOverride, 0, 30, OPS_EMOTION_PRESETS[volatility].decayPerTurn),
      inject: tuningSource.inject === undefined ? DEFAULT_OPS.emotionTuning.inject : tuningSource.inject === true,
    },
    sharedMood: source.sharedMood === undefined ? DEFAULT_OPS.sharedMood : source.sharedMood === true,
  }
}

/** 某个对话实际生效的情绪参数（档位 + 覆盖 + 注入开关）。 */
export function emotionTuningOf(ops) {
  const normalized = normalizeOps(ops)
  const tuning = normalized.emotionTuning
  const preset = OPS_EMOTION_PRESETS[tuning.volatility] || OPS_EMOTION_PRESETS.normal
  return {
    volatility: tuning.volatility,
    label: preset.label,
    allowSpike: preset.allowSpike,
    maxJump: preset.maxJump,
    decayPerTurn: tuning.decayPerTurn === null ? preset.decayPerTurn : tuning.decayPerTurn,
    inject: tuning.inject && preset.inject !== false,
  }
}

/** 给面板/接口用的描述（带 block/mode 清单）。 */
export function describeOps(input) {
  const ops = normalizeOps(input)
  const activeBlocks = OPS_BLOCKS.filter((definition) => ops.blocks[definition.key].enabled).map((definition) => definition.key)
  return {
    ...ops,
    blocks: OPS_BLOCKS.map((definition) => ({ ...definition, ...ops.blocks[definition.key] })),
    modes: OPS_MODES.map((item) => ({ ...item })),
    emotionPresets: Object.values(OPS_EMOTION_PRESETS).map(({ key, label, hint }) => ({ key, label, hint })),
    emotionTuning: emotionTuningOf(ops),
    activeBlocks,
    // 一次「单块调用」或「合一次调用」的粗略成本提示（面板上显示，不参与逻辑）
    estimatedCalls: ops.enabled ? (ops.mode === 'split' ? activeBlocks.length : (activeBlocks.length > 0 ? 1 : 0)) : 0,
  }
}

// ── 会话状态（ops.json） ──────────────────────────────────────────────────────

function emptyState() {
  return {
    version: STATE_VERSION,
    style: { lines: [], updatedAt: null, reason: '' },
    control: { seq: 0, items: [] },
    // 情绪惯性：runIndex 每次运行 +1，spikes 记着「还在气头上」的条目，按轮回落
    emotion: { runIndex: 0, spikes: [] },
    lastRun: null,
  }
}

function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const style = raw.style && typeof raw.style === 'object' ? raw.style : {}
  const control = raw.control && typeof raw.control === 'object' ? raw.control : {}
  const emotion = raw.emotion && typeof raw.emotion === 'object' ? raw.emotion : {}
  return {
    version: STATE_VERSION,
    style: {
      lines: Array.isArray(style.lines) ? style.lines.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 8) : [],
      updatedAt: typeof style.updatedAt === 'string' ? style.updatedAt : null,
      reason: typeof style.reason === 'string' ? style.reason : '',
    },
    control: {
      seq: Number.isFinite(Number(control.seq)) ? Math.max(0, Math.round(Number(control.seq))) : 0,
      items: Array.isArray(control.items) ? control.items.filter((item) => item && typeof item === 'object').slice(-CONTROL_LIMIT) : [],
    },
    emotion: {
      runIndex: Number.isFinite(Number(emotion.runIndex)) ? Math.max(0, Math.round(Number(emotion.runIndex))) : 0,
      spikes: Array.isArray(emotion.spikes)
        ? emotion.spikes
            .filter((spike) => spike && typeof spike === 'object' && typeof spike.label === 'string' && Number.isFinite(Number(spike.value)))
            .slice(-6)
            .map((spike) => ({
              label: spike.label,
              value: Math.max(0, Math.min(100, Math.round(Number(spike.value)))),
              floor: Math.max(0, Math.min(100, Math.round(Number(spike.floor ?? spike.value) || 0))),
              runIndex: Number.isFinite(Number(spike.runIndex)) ? Math.max(0, Math.round(Number(spike.runIndex))) : 0,
              trigger: typeof spike.trigger === 'string' ? spike.trigger.slice(0, 60) : '',
              reason: typeof spike.reason === 'string' ? spike.reason.slice(0, 160) : '',
              at: typeof spike.at === 'string' ? spike.at : null,
            }))
        : [],
    },
    lastRun: raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : null,
  }
}

// ── 文本 / JSON 小工具 ────────────────────────────────────────────────────────

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function messageOf(event) {
  const data = event && typeof event === 'object' ? event.data : undefined
  if (!data || typeof data !== 'object') return null
  if (data.message && typeof data.message === 'object') return data.message
  return data
}

function extractText(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const parts = []
    for (const block of value) {
      if (!block || typeof block !== 'object') continue
      if (typeof block.text !== 'string') continue
      if (block.type === 'text' || block.type === 'output_text' || block.type === 'input_text' || block.type === undefined) {
        parts.push(block.text)
      }
    }
    return parts.join('\n').trim()
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim()
    if (value.content !== undefined) return extractText(value.content)
  }
  return ''
}

const NEGATIVE_EMOTIONS = new Set(['愤怒', '生气', '委屈', '悲伤', '难过', '焦虑', '烦躁', '烦', '失望', '疲惫', '厌恶', '嫉妒', '愧疚', '不安', '害怕'])
const POSITIVE_EMOTIONS = new Set(['开心', '高兴', '兴奋', '依恋', '喜欢', '感动', '害羞', '期待', '心动'])

/** 把「还在气头上」翻译成具体的行为指令（否则主模型容易一秒钟变回理智）。 */
function emotionDirective(label) {
  if (NEGATIVE_EMOTIONS.has(label)) return '这轮要把这种情绪明显带出来：可以变冷、顶回去、话变少，但别一秒冷静下来，也别急着讲道理或道歉；对方哄之前别自己先和好。'
  if (POSITIVE_EMOTIONS.has(label)) return '这轮语气亮一点、更愿意接话，可以主动一点。'
  return '这轮别把这种情绪藏起来。'
}

/** 宽松解析：去掉 ```json 围栏、取第一个 {…}、把中文引号拉直后再试一次。 */export function parseJsonLoose(text) {
  let raw = String(text ?? '').trim()
  if (raw === '') return null
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const attempt = (candidate) => {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  const direct = attempt(raw)
  if (direct) return direct
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = raw.slice(start, end + 1)
  const straight = attempt(slice)
  if (straight) return straight
  const fixed = attempt(slice.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"))
  return fixed
}

export function createOpsAgent(ctx, manager) {
  const log = (label, detail) => {
    try {
      const file = join(manager.root, 'ops.log')
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      if (size > MAX_LOG_BYTES) writeFileSync(file, `# ops-agent log (rotated at ${new Date().toISOString()})\n`, 'utf8')
      appendFileSync(file, `${new Date().toISOString()} ${label} ${detail ?? ''}\n`, 'utf8')
    } catch {
      // 诊断日志永远不能影响主链
    }
  }

  /** 每个对话一份运行态：最近对话缓冲、最近一次运行、是否在跑。 */
  const runtime = new Map()
  const stateCache = new Map()
  const fallbackTimers = new Map()
  // 兜底触发只在「这一轮真的结束了（agent 空闲）」时才跑，避免在带工具调用的多步回合中途
  // 更新语言习惯、把动态上下文改掉（那会让宿主把新快照当成一条用户消息投进来）。
  const agentStatus = new Map()

  const runtimeOf = (sessionId) => {
    if (!runtime.has(sessionId)) {
      runtime.set(sessionId, { messages: [], lastSignature: '', running: false, lastModelConfig: null })
    }
    return runtime.get(sessionId)
  }

  const opsConfig = (sessionId) => {
    try {
      const perf = manager.performance && typeof manager.performance.get === 'function' ? manager.performance.get(sessionId) : null
      return normalizeOps(perf && perf.ops ? perf.ops : DEFAULT_OPS)
    } catch {
      return normalizeOps(DEFAULT_OPS)
    }
  }

  const stateFileOf = (sessionId) => {
    try {
      const store = manager.storeFor(sessionId)
      if (store && typeof store.dir === 'string' && store.dir !== '') return join(store.dir, STATE_FILE)
    } catch {
      // ignore
    }
    return ''
  }

  const readState = (sessionId) => {
    const cached = stateCache.get(sessionId)
    if (cached) return cached
    const file = stateFileOf(sessionId)
    let state = emptyState()
    try {
      if (file !== '' && existsSync(file)) state = normalizeState(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      state = emptyState()
    }
    stateCache.set(sessionId, state)
    return state
  }

  const writeState = (sessionId, next) => {
    const file = stateFileOf(sessionId)
    const state = normalizeState(next)
    stateCache.set(sessionId, state)
    if (file === '') return state
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      log('persist-failed', String(error && error.message))
    }
    return state
  }

  // ── 跨对话共享的「整体情绪」（ops-global.json） ─────────────────────────────
  // 用户要求：在任意一个对话里被惹到，换个人来跟她说话，她也还在气头上。
  // 这里只存「情绪基线」，注入与行为指令见 moodDirective()。
  const globalFile = typeof manager.root === 'string' && manager.root !== '' ? join(manager.root, GLOBAL_FILE) : ''
  let globalCache = null

  const emptyGlobal = () => ({ version: 1, runIndex: 0, spikes: [], updatedAt: null })

  const normalizeGlobal = (raw) => {
    if (!raw || typeof raw !== 'object') return emptyGlobal()
    return {
      version: 1,
      runIndex: Number.isFinite(Number(raw.runIndex)) ? Math.max(0, Math.round(Number(raw.runIndex))) : 0,
      spikes: Array.isArray(raw.spikes)
        ? raw.spikes
            .filter((spike) => spike && typeof spike === 'object' && typeof spike.label === 'string' && Number.isFinite(Number(spike.value)))
            .slice(-6)
            .map((spike) => ({
              label: spike.label,
              value: Math.max(0, Math.min(100, Math.round(Number(spike.value)))),
              floor: Math.max(0, Math.min(100, Math.round(Number(spike.floor ?? spike.value) || 0))),
              runIndex: Number.isFinite(Number(spike.runIndex)) ? Math.max(0, Math.round(Number(spike.runIndex))) : 0,
              decayPerTurn: Number.isFinite(Number(spike.decayPerTurn)) ? Math.max(1, Math.min(30, Math.round(Number(spike.decayPerTurn)))) : 12,
              trigger: typeof spike.trigger === 'string' ? spike.trigger.slice(0, 60) : '',
              reason: typeof spike.reason === 'string' ? spike.reason.slice(0, 160) : '',
              originSession: typeof spike.originSession === 'string' ? spike.originSession : '',
              at: typeof spike.at === 'string' ? spike.at : null,
            }))
        : [],
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  const readGlobal = () => {
    if (globalCache) return globalCache
    let state = emptyGlobal()
    try {
      if (globalFile !== '' && existsSync(globalFile)) state = normalizeGlobal(JSON.parse(readFileSync(globalFile, 'utf8')))
    } catch {
      state = emptyGlobal()
    }
    globalCache = state
    return state
  }

  const writeGlobal = (next) => {
    const state = normalizeGlobal(next)
    state.updatedAt = new Date().toISOString()
    globalCache = state
    if (globalFile === '') return state
    try {
      mkdirSync(dirname(globalFile), { recursive: true })
      const tmp = `${globalFile}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(tmp, globalFile)
    } catch (error) {
      log('global-persist-failed', String(error && error.message))
    }
    return state
  }

  /** 每跑一次（任意对话）整体情绪就回落一轮：跨对话均匀衰减。 */
  const advanceGlobal = () => {
    const state = readGlobal()
    const runIndex = state.runIndex + 1
    const spikes = state.spikes
      .map((spike) => ({
        ...spike,
        floor: Math.max(0, Math.round(spike.value - (spike.decayPerTurn || 12) * (runIndex - spike.runIndex))),
      }))
      .filter((spike) => spike.floor > 0)
    return writeGlobal({ ...state, runIndex, spikes })
  }

  const recordGlobalSpike = (sessionId, spike, tuning) => {
    try {
      const state = readGlobal()
      const value = Math.max(0, Math.min(100, Math.round(Number(spike.value) || 0)))
      const spikes = state.spikes.filter((item) => item.label !== spike.label)
      spikes.push({
        label: spike.label,
        value,
        floor: value,
        runIndex: state.runIndex,
        decayPerTurn: tuning.decayPerTurn,
        trigger: String(spike.trigger || '').slice(0, 60),
        reason: String(spike.reason || '').slice(0, 160),
        originSession: sessionId,
        at: new Date().toISOString(),
      })
      writeGlobal({ ...state, spikes: spikes.slice(-6) })
    } catch (error) {
      log('global-spike-failed', String(error && error.message))
    }
  }

  /** 把整体情绪翻译成「这一轮该怎么说话」的指令；没有情绪时返回空串。 */
  const moodDirective = (sessionId, options = {}) => {
    try {
      const state = readGlobal()
      const active = state.spikes.filter((spike) => spike.floor > 0)
      if (active.length === 0) return ''
      const compact = options.compact === true
      const lines = active.map((spike) => {
        const trigger = spike.trigger !== '' ? `，触发：${spike.trigger}` : ''
        const elsewhere = spike.originSession !== '' && spike.originSession !== sessionId ? '（是在另一个对话里被惹到的）' : ''
        const decay = `每轮回落 ${spike.decayPerTurn || 12}`
        if (compact) return `- ${spike.label} ${spike.floor}/100${trigger}${elsewhere}；${decay}`
        return `- ${spike.label} ${spike.floor}/100${trigger}${elsewhere}；${decay}。${emotionDirective(spike.label)}`
      })
      const head = options.compact === true
        ? '【整体情绪（跨对话共享，还没消）】\n'
        : '【整体情绪（跨对话共享，还没消）】这是她自己的心情，不是针对这轮这个人，但语气会带着走：\n'
      return head + lines.join('\n')
    } catch (error) {
      log('mood-directive-failed', String(error && error.message))
      return ''
    }
  }

  // ── 结果写回 ────────────────────────────────────────────────────────────────

  const applyEmotion = (sessionId, store, payload, tuning, sharedMood) => {
    try {
      const source = payload && typeof payload === 'object' ? payload : {}
      const raw = source.changes || source.emotion || source
      if (!raw || typeof raw !== 'object') return null
      const types = store.emotionTypesSnapshot()
      const byLabel = new Map()
      for (const type of types) byLabel.set(type.label, type)
      let current = new Map()
      try {
        const snapshot = store.emotionSnapshot()
        if (snapshot && Array.isArray(snapshot.types)) for (const type of snapshot.types) current.set(type.label, Number(type.value) || 0)
      } catch {
        current = new Map()
      }
      const emotions = {}
      for (const [key, value] of Object.entries(raw)) {
        const type = byLabel.get(key) || types.find((item) => item.key === key)
        if (!type) continue
        const score = Number(value)
        if (!Number.isFinite(score)) continue
        let target = Math.max(0, Math.min(100, Math.round(score)))
        // 「稳定」档：单次最多 ±25，不让 AI 忽然变脸
        if (tuning.allowSpike !== true) {
          const now = current.get(type.label) ?? 0
          const delta = target - now
          if (Math.abs(delta) > tuning.maxJump) target = Math.max(0, Math.min(100, now + Math.sign(delta) * tuning.maxJump))
        }
        emotions[type.label] = target
      }
      if (Object.keys(emotions).length === 0) return null
      const reason = typeof source.reason === 'string' && source.reason.trim() !== ''
        ? source.reason.trim()
        : '每轮子智能体分析'
      const result = store.setEmotions({ emotions, reason }, { by: 'ai' })
      // 记为「情绪惯性」：带 spike 的、或一次跳了 25 点以上的，都按「还在这个情绪里」跟踪回落
      const spike = source.spike === true
      const trigger = typeof source.trigger === 'string' ? source.trigger.trim().slice(0, 60) : ''
      const biggestJump = Object.entries(emotions).reduce((max, [label, value]) => {
        const delta = Math.abs(value - (current.get(label) ?? 0))
        return delta > max.delta ? { label, delta, value } : max
      }, { label: '', delta: 0, value: 0 })
      if (tuning.allowSpike === true && biggestJump.delta >= 25 && (spike || trigger !== '')) {
        recordSpike(sessionId, {
          label: biggestJump.label,
          value: biggestJump.value,
          trigger: trigger || (source.spike === true ? '情绪触发' : ''),
          reason,
        })
        // 跨对话共享：把这个心情也记成「整体情绪」，别的对话/别的用户来聊她还是这个心情
        if (sharedMood === true) {
          recordGlobalSpike(sessionId, {
            label: biggestJump.label,
            value: biggestJump.value,
            trigger: trigger || (source.spike === true ? '情绪触发' : ''),
            reason,
          }, tuning)
        }
      }
      return { emotions: result.changes, reason: result.reason, spike: spike && tuning.allowSpike === true, trigger }
    } catch (error) {
      log('apply-emotion-failed', String(error && error.message))
      return null
    }
  }

  /** 记一条「情绪还没散」，供以后每轮按 decayPerTurn 回落。 */
  const recordSpike = (sessionId, spike) => {
    try {
      const state = readState(sessionId)
      const spikes = state.emotion.spikes.filter((item) => item.label !== spike.label)
      spikes.push({
        label: spike.label,
        value: Math.max(0, Math.min(100, Math.round(Number(spike.value) || 0))),
        floor: Math.max(0, Math.min(100, Math.round(Number(spike.value) || 0))),
        runIndex: state.emotion.runIndex,
        trigger: String(spike.trigger || '').slice(0, 60),
        reason: String(spike.reason || '').slice(0, 160),
        at: new Date().toISOString(),
      })
      writeState(sessionId, { ...state, emotion: { ...state.emotion, spikes: spikes.slice(-6) } })
    } catch (error) {
      log('record-spike-failed', String(error && error.message))
    }
  }

  /**
   * 每轮先给「还在气头上」的情绪兜底：按轮回落，但当前值低于本轮下限时抬回去。
   * （主模型下一轮 turn_end 若试图一秒冷静，这里会在回合结束时把情绪拉回底线。）
   */
  const applyEmotionInertia = (sessionId, store, tuning, sharedMood) => {
    try {
      const state = readState(sessionId)
      const runIndex = state.emotion.runIndex + 1
      const spikes = []
      const applied = {}
      let current = new Map()
      try {
        const snapshot = store.emotionSnapshot()
        if (snapshot && Array.isArray(snapshot.types)) for (const type of snapshot.types) current.set(type.label, Number(type.value) || 0)
      } catch {
        current = new Map()
      }
      for (const spike of state.emotion.spikes) {
        const elapsed = Math.max(0, runIndex - spike.runIndex)
        const floor = Math.max(0, Math.round(spike.value - tuning.decayPerTurn * elapsed))
        if (floor <= 0) continue
        const now = current.get(spike.label) ?? 0
        if (now < floor) applied[spike.label] = floor
        spikes.push({ ...spike, floor })
      }
      // 跨对话共享的整体情绪：别的对话里惹出来的心情，在这个对话里也要抬到同一个下限
      if (sharedMood === true) {
        for (const spike of readGlobal().spikes) {
          if (spike.floor <= 0) continue
          const now = current.get(spike.label) ?? 0
          const already = applied[spike.label] ?? 0
          if (now < spike.floor && spike.floor > already) applied[spike.label] = spike.floor
        }
      }
      if (Object.keys(applied).length > 0) {
        try {
          const detail = spikes.map((spike) => `${spike.label}≥${spike.floor}`).join('、')
          const globalDetail = sharedMood === true
            ? readGlobal().spikes.filter((spike) => spike.floor > 0).map((spike) => `${spike.label}≥${spike.floor}`).join('、')
            : ''
          const labelText = [detail, globalDetail].filter(Boolean).join('、')
          // 这句 reason 会出现在动态上下文 / QQ 的 turn_end 回执里，提醒主模型「别一秒冷静」
          store.setEmotions({ emotions: applied, reason: `情绪还没散（${labelText || '整体情绪'}，每轮回落 ${tuning.decayPerTurn}）：按这个情绪来，别一秒冷静` }, { by: 'ai' })
        } catch (error) {
          log('inertia-apply-failed', String(error && error.message))
        }
      }
      writeState(sessionId, { ...state, emotion: { runIndex, spikes } })
      return spikes
    } catch (error) {
      log('inertia-failed', String(error && error.message))
      return []
    }
  }

  const applyStyle = (sessionId, store, payload) => {
    try {
      const raw = payload && typeof payload === 'object' ? payload : {}
      const candidates = Array.isArray(raw.lines) ? raw.lines : Array.isArray(raw.style) ? raw.style : []
      const lines = candidates
        .filter((line) => typeof line === 'string' && line.trim() !== '')
        .map((line) => clip(line, 80))
        .slice(0, 6)
      if (lines.length === 0) return null
      const state = readState(sessionId)
      const next = {
        ...state,
        style: {
          lines,
          updatedAt: new Date().toISOString(),
          reason: typeof raw.reason === 'string' ? clip(raw.reason, 120) : '每轮子智能体分析',
        },
      }
      writeState(sessionId, next)
      return { lines, updatedAt: next.style.updatedAt }
    } catch (error) {
      log('apply-style-failed', String(error && error.message))
      return null
    }
  }

  const applyMemory = (store, payload) => {
    try {
      const raw = payload && typeof payload === 'object' ? payload : {}
      const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.memories) ? raw.memories : []
      const written = []
      for (const item of items.slice(0, 3)) {
        const text = typeof item === 'string' ? item : (item && typeof item.text === 'string' ? item.text : '')
        if (text.trim() === '') continue
        const tags = Array.isArray(item && item.tags) ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 4) : []
        if (!tags.includes('子智能体')) tags.push('子智能体')
        const weight = Number(item && item.weight)
        const memory = store.addMemory(text.trim(), tags, {
          source: 'ops-agent',
          weight: Number.isFinite(weight) ? Math.max(1, Math.min(100, Math.round(weight))) : 60,
        })
        if (memory) written.push({ id: memory.id, text: memory.text })
      }
      return written.length > 0 ? { items: written } : null
    } catch (error) {
      log('apply-memory-failed', String(error && error.message))
      return null
    }
  }

  const applyControl = (sessionId, payload) => {
    try {
      const raw = payload && typeof payload === 'object' ? payload : {}
      const list = Array.isArray(raw.actions) ? raw.actions : Array.isArray(raw.control) ? raw.control : []
      const accepted = []
      const state = readState(sessionId)
      let seq = state.control.seq
      const items = [...state.control.items]
      const now = new Date().toISOString()
      for (const action of list.slice(0, 6)) {
        if (!action || typeof action !== 'object') continue
        const type = typeof action.type === 'string' ? action.type.trim().slice(0, 40) : ''
        if (type === '') continue
        const payloadObject = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload) ? action.payload : {}
        seq += 1
        const item = {
          id: `act_${seq}_${Math.random().toString(16).slice(2, 6)}`,
          seq,
          sessionId,
          type,
          payload: payloadObject,
          ttlMs: clampInt(action.ttlMs, 1000, CONTROL_TTL_MAX, CONTROL_TTL_DEFAULT),
          createdAt: now,
          acked: false,
        }
        items.push(item)
        accepted.push(item)
      }
      if (accepted.length === 0) return null
      writeState(sessionId, {
        ...state,
        control: { seq, items: items.filter((item) => item && item.acked !== true).slice(-CONTROL_LIMIT) },
      })
      return { actions: accepted }
    } catch (error) {
      log('apply-control-failed', String(error && error.message))
      return null
    }
  }

  // ── 提示词 ──────────────────────────────────────────────────────────────────

  const EMOTION_TRIGGERS = '被冒犯/被骂、被冷落/被敷衍、约定被放鸽子、被夸/被撩、被关心、被吓到、对方难过/求助、对方越界或开黄腔'

  /**
   * 情绪块的提示词：核心是「先判断这一轮该不该有情绪」，允许当场变脸、也允许不生气，
   * 但必须有真实触发、不能为了戏剧性无端发火。
   */
  const emotionTask = (tuning) => {
    const ceiling = tuning.allowSpike ? tuning.maxJump : 25
    const spikeLine = tuning.allowSpike
      ? `有明确触发就允许「当场变脸」：可以从 0 直接跳到 60~${ceiling}，带 spike:true + trigger；没有触发只做小幅调整（±10 以内）或写 0 回落。`
      : `当前档位是「稳定」：单次最多 ±${ceiling}，不要写 spike，也不要制造突变。`
    return [
      `- emotion（情绪 + 判断「要不要生气」）：先判断这一轮有没有情绪触发事件（${EMOTION_TRIGGERS}）。`,
      `  ${spikeLine}`,
      '  判断要求：触发必须真的发生在对话里；同一件事不要连着几轮反复升级；对方在开玩笑就别真生气。',
      '  只使用下面「可用情绪」里的词，多种情绪可以同时存在。',
      '  格式："emotion": {"changes": {"愤怒": 78}, "reason": "为什么变", "spike": true, "trigger": "被冒犯"}',
    ].join('\n')
  }

  const BLOCK_TASKS = {
    style: `- style（语言习惯）：从用户（以及角色自己）的说话里提炼「该怎么说话」，2~4 条短句，例如「喜欢先回一句短句再补细节」「常用省略号开头」「别用书面总结腔」。只写稳定习惯，别写这一轮的具体内容。
  格式："style": {"lines": ["…", "…"], "reason": "依据"}`,
    memory: `- memory（记忆）：只挑真正值得长期记的（人设、双方约定、剧情关键节点、用户固定偏好），最多 2 条，尽量保留原文、不要改写。没有就省略。
  格式："memory": {"items": [{"text": "原文", "tags": ["约定"], "weight": 60}]}`,
    control: `- control（操控，预留）：产出可以被外部（例如桌宠皮套）消费的动作。这一轮没有明确的动作需求就省略。
  动作类型：${OPS_CONTROL_TYPES.map((item) => item.type).join(' / ')}。
  格式："control": {"actions": [{"type": "expression", "payload": {"name": "爱心眼"}, "ttlMs": 12000}]}`,
  }

  const blockHintText = (ops, store) => {
    const tuning = emotionTuningOf(ops)
    const parts = []
    for (const definition of OPS_BLOCKS) {
      const block = ops.blocks[definition.key]
      if (!block || block.enabled !== true) continue
      parts.push(definition.key === 'emotion' ? emotionTask(tuning) : BLOCK_TASKS[definition.key])
      if (block.hint !== '') parts.push(`  （本对话额外要求：${block.hint}）`)
    }
    if (parts.length === 0) return ''
    const types = (() => {
      try {
        return store.emotionTypesSnapshot().map((type) => type.label)
      } catch {
        return []
      }
    })()
    return [
      '你是「大肥鱼」伴侣系统的每轮分析子智能体（操控中心）。每轮对话结束后，你独立分析这一轮，把结论交给系统。',
      '严格只输出一个 JSON 对象，不要输出 JSON 以外的任何文字。本次分配给你的块如下：',
      ...parts,
      types.length > 0 ? `可用情绪：${types.join('、')}（分数 0~100，0 = 这种情绪回落）。` : '',
      `情绪波动档位：${tuning.label}（每轮自然回落 ${tuning.decayPerTurn} 点）。`,
      '注意：这是后台分析，不面向用户说话；宁可少写，也不要编造。',
    ].filter((line) => line !== '').join('\n')
  }

  const transcriptText = (messages) => messages
    .map((message) => `${message.role === 'user' ? '用户' : '角色'}：${clip(message.text, 400)}`)
    .join('\n')

  // ── 运行 ────────────────────────────────────────────────────────────────────

  const pickModel = (sessionId) => {
    const ops = opsConfig(sessionId)
    if (ops.model.provider !== '' && ops.model.model !== '') return ops.model
    const rt = runtimeOf(sessionId)
    const config = rt.lastModelConfig
    if (config && typeof config.provider === 'string' && typeof config.model === 'string' && config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
    return { provider: CLEAN_DEFAULT_MODEL.provider, model: CLEAN_DEFAULT_MODEL.model }
  }

  const requestOnce = async (sessionId, ops, store, messages, blocks, signal) => {
    const model = pickModel(sessionId)
    const system = blockHintText({ ...ops, blocks: Object.fromEntries(Object.entries(ops.blocks).map(([key, value]) => [key, { ...value, enabled: blocks.includes(key) }])) }, store)
    const userText = [
      '这是最近的对话（越靠后越新）：',
      transcriptText(messages),
      '',
      '请按分配输出 JSON。',
    ].join('\n')
    const text = await callModelText(ctx, {
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: userText }] },
      ],
      maxTokens: 900,
      provider: model.provider,
      model: model.model,
      signal,
    })
    const parsed = parseJsonLoose(text)
    if (!parsed) throw new Error(`模型输出不是合法 JSON：${clip(text, 120)}`)
    return parsed
  }

  const runOnce = async (sessionId, options = {}) => {
    const ops = opsConfig(sessionId)
    if (ops.enabled !== true) return { ok: false, skipped: 'disabled' }
    const store = (() => {
      try {
        return manager.isEnabled(sessionId) ? manager.storeFor(sessionId) : null
      } catch {
        return null
      }
    })()
    if (!store) { log('run-skip', `session=${sessionId.slice(0, 12)} not-enabled`); return { ok: false, skipped: 'not-enabled' } }
    const rt = runtimeOf(sessionId)
    if (rt.running) return { ok: false, skipped: 'busy' }
    const activeBlocks = OPS_BLOCKS.filter((definition) => ops.blocks[definition.key].enabled).map((definition) => definition.key)
    if (activeBlocks.length === 0) return { ok: false, skipped: 'no-blocks' }
    const tuning = emotionTuningOf(ops)
    const sharedMood = ops.sharedMood === true
    // 每跑一次（任意对话）整体情绪都回落一轮；再把这个对话的情绪抬到整体下限
    advanceGlobal()
    let activeSpikes = []
    if (activeBlocks.includes('emotion')) {
      activeSpikes = applyEmotionInertia(sessionId, store, tuning, sharedMood)
    }
    let messages = rt.messages.slice(-ops.window)
    // 手动运行（面板「立即分析本轮」）时缓冲可能是空的：用 48 小时热缓存里最近几条兜底
    if (messages.length === 0 && options.manual === true) {
      try {
        const recent = store && store.recent && Array.isArray(store.recent.entries) ? store.recent.entries.slice(-ops.window) : []
        messages = recent
          .filter((entry) => entry && typeof entry.text === 'string' && entry.text !== '')
          .map((entry) => ({ role: entry.role === 'user' ? 'user' : 'assistant', text: entry.text, at: 0 }))
      } catch {
        messages = []
      }
    }
    if (messages.length === 0) { log('run-skip', `session=${sessionId.slice(0, 12)} empty`); return { ok: false, skipped: 'empty' } }

    rt.running = true
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
    const actions = {}
    let errorText = ''
    try {
      if (ops.mode === 'split') {
        // 分块调用：一块一次，逐块落结果；某块失败不影响其它块
        for (const key of activeBlocks) {
          try {
            const parsed = await requestOnce(sessionId, ops, store, messages, [key], controller.signal)
            actions[key] = parsed
          } catch (error) {
            actions[key] = { error: String(error && error.message ? error.message : error) }
          }
        }
      } else {
        const parsed = await requestOnce(sessionId, ops, store, messages, activeBlocks, controller.signal)
        for (const key of activeBlocks) actions[key] = parsed
      }
    } catch (error) {
      errorText = String(error && error.message ? error.message : error)
    } finally {
      clearTimeout(timer)
      rt.running = false
    }

    const applied = { emotion: null, style: null, memory: null, control: null }
    let failed = errorText !== ''
    if (errorText === '') {
      if (activeBlocks.includes('emotion')) {
        const payload = actions.emotion && !actions.emotion.error ? actions.emotion.emotion || actions.emotion : null
        applied.emotion = applyEmotion(sessionId, store, payload, tuning, sharedMood)
      }
      if (activeBlocks.includes('style')) {
        const payload = actions.style && !actions.style.error ? actions.style.style || actions.style : null
        applied.style = applyStyle(sessionId, store, payload)
      }
      if (activeBlocks.includes('memory')) {
        const payload = actions.memory && !actions.memory.error ? actions.memory.memory || actions.memory : null
        applied.memory = applyMemory(store, payload)
      }
      if (activeBlocks.includes('control')) {
        const payload = actions.control && !actions.control.error ? actions.control.control || actions.control : null
        applied.control = applyControl(sessionId, payload)
      }
      const blockErrors = Object.values(actions).filter((value) => value && typeof value === 'object' && value.error)
      if (blockErrors.length > 0 && Object.keys(applied).every((key) => applied[key] === null)) {
        failed = true
        errorText = blockErrors.map((value) => value.error).join('；').slice(0, 300)
      }
    }

    const durationMs = Date.now() - startedAt
    const lastRun = {
      at: new Date().toISOString(),
      ms: durationMs,
      mode: ops.mode,
      blocks: activeBlocks,
      applied: {
        emotion: applied.emotion ? Object.keys(applied.emotion.emotions || {}).length : 0,
        style: applied.style ? applied.style.lines.length : 0,
        memory: applied.memory ? applied.memory.items.length : 0,
        control: applied.control ? applied.control.actions.length : 0,
      },
      spike: applied.emotion ? applied.emotion.spike === true : false,
      inertia: activeSpikes.length,
      volatility: tuning.volatility,
      error: errorText,
    }
    const state = readState(sessionId)
    writeState(sessionId, { ...state, lastRun })
    log('run', `session=${sessionId.slice(0, 12)} mode=${ops.mode} blocks=${activeBlocks.join(',')} ms=${durationMs} ${errorText ? `error=${clip(errorText, 200)}` : 'ok'}`)
    return { ok: errorText === '', ...lastRun, skipped: options.manual ? undefined : undefined }
  }

  /** 同一轮只跑一次：用「消息条数 + 最后一条时间」当签名去重。 */
  const scheduleRun = (sessionId, reason) => {
    try {
      if (sessionId === '' || !manager.isEnabled(sessionId)) return
      const ops = opsConfig(sessionId)
      if (ops.enabled !== true) return
      const rt = runtimeOf(sessionId)
      const last = rt.messages[rt.messages.length - 1]
      const signature = `${rt.messages.length}:${last ? last.at : 0}`
      if (signature === rt.lastSignature) return
      rt.lastSignature = signature
      log('schedule', `session=${sessionId.slice(0, 12)} reason=${reason || ''} msgs=${rt.messages.length}`)
      void runOnce(sessionId).catch((error) => log('run-threw', String(error && error.message)))
    } catch (error) {
      log('schedule-failed', String(error && error.message))
    }
  }

  // ── 事件：收集对话 + 每轮触发 ───────────────────────────────────────────────

  const onSessionEvent = (session, event) => {
    try {
      const type = event && typeof event === 'object' ? event.type : ''
      if (type !== 'user/message' && type !== 'assistant/message') return
      if (type === 'user/message' && event.sourceEventSeqs !== undefined) return
      const sessionId = session && typeof session.id === 'string' ? session.id : ''
      if (sessionId === '' || !manager.isEnabled(sessionId)) return
      const message = messageOf(event)
      const kind = message && message.source && typeof message.source === 'object' ? message.source.kind : ''
      if (kind === 'runtime-context') return
      const text = extractText(message && message.content !== undefined ? message.content : message)
      if (text === '') return
      const ops = opsConfig(sessionId)
      if (ops.enabled !== true) return
      const rt = runtimeOf(sessionId)
      rt.messages.push({ role: type === 'user/message' ? 'user' : 'assistant', text, at: Date.now() })
      const cap = Math.max(ops.window * 3, 24)
      if (rt.messages.length > cap) rt.messages.splice(0, rt.messages.length - cap)
      // 记下当前对话的模型选择，子智能体默认跟随它
      try {
        const config = session && session.requestHeader ? session.requestHeader()?.config : null
        if (config && typeof config.provider === 'string' && typeof config.model === 'string') rt.lastModelConfig = config
      } catch {
        // ignore
      }
      if (type === 'assistant/message') {
        // 兜底：宿主没发 turn-stopping 时（异常中断等），2.5 秒后也跑一次；
        // 只有 agent 已经空闲（这一轮真结束了）才跑，避免多步回合中途改上下文。
        const previous = fallbackTimers.get(sessionId)
        if (previous) clearTimeout(previous)
        const timer = setTimeout(() => {
          fallbackTimers.delete(sessionId)
          if (agentStatus.get(sessionId) !== 'idle') return
          scheduleRun(sessionId, 'assistant-fallback')
        }, 2500)
        if (typeof timer.unref === 'function') timer.unref()
        fallbackTimers.set(sessionId, timer)
      }
    } catch (error) {
      log('collect-failed', String(error && error.message))
    }
  }

  const onTurnStopping = (payload) => {
    try {
      const agent = payload && payload.agent
      const sessionId = agent && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return
      log('turn-stopping', `session=${sessionId.slice(0, 12)} enabled=${manager.isEnabled(sessionId)}`)
      const timer = fallbackTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        fallbackTimers.delete(sessionId)
      }
      scheduleRun(sessionId, 'turn-stopping')
    } catch {
      // ignore
    }
  }

  // ── 注入：语言习惯 → 下一轮动态上下文 ───────────────────────────────────────

  const frozen = new Map()
  const registerPromptContext = () => {
    try {
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (!systemPrompt || typeof systemPrompt.context !== 'function') return () => {}
      const dispose = systemPrompt.context({
        name: 'companion-memory:ops',
        order: 90001,
        interpolate: false,
        text: (context) => {
          try {
            const agent = context && context.agent
            const sessionId = agent && agent.id ? String(agent.id) : ''
            if (sessionId === '' || !manager.isEnabled(sessionId)) return ''
            const ops = opsConfig(sessionId)
            if (ops.enabled !== true) return ''
            const store = manager.storeFor(sessionId)
            if (!store) return ''
            // QQ 路由的会话不走 runtime-context 注入（宿主会把刷新后的快照当成一条新的用户消息
            // 投递，模型会以为用户又说话了）：和 dynamic-context.js 保持同一道判断。
            try {
              const bridge = typeof manager.bridge === 'function' ? manager.bridge() : null
              if (bridge && typeof bridge.isRoutedSession === 'function' && bridge.isRoutedSession(sessionId)) return ''
            } catch {
              // 判断失败就按普通会话处理
            }
            const anchor = String(store.state?.lastUserMessageAt || '')
            const cached = frozen.get(sessionId)
            if (cached && cached.anchor === anchor) return cached.text
            const state = readState(sessionId)
            const parts = []
            if (state.style.lines.length > 0) {
              parts.push('【说话习惯（每轮子智能体提炼，回话时照着来）】\n' + state.style.lines.map((line) => `- ${line}`).join('\n'))
            }
            // 情绪惯性：跨对话共享时用「整体情绪」（换个对话/换个用户也带着），
            // 关掉共享时退回只看本对话的突变。
            const tuning = emotionTuningOf(ops)
            if (ops.sharedMood === true) {
              const moodText = moodDirective(sessionId)
              if (moodText !== '') parts.push(moodText)
            } else if (tuning.inject && state.emotion.spikes.length > 0) {
              let current = new Map()
              try {
                const snapshot = store.emotionSnapshot()
                if (snapshot && Array.isArray(snapshot.types)) for (const type of snapshot.types) current.set(type.label, Number(type.value) || 0)
              } catch {
                current = new Map()
              }
              const lines = state.emotion.spikes
                .map((spike) => {
                  const now = current.get(spike.label) ?? 0
                  if (now <= 0) return ''
                  const trigger = spike.trigger !== '' ? `，触发：${spike.trigger}` : ''
                  const directive = emotionDirective(spike.label)
                  return `- ${spike.label} ${now}/100（本轮下限 ${spike.floor}${trigger}；每轮自然回落 ${tuning.decayPerTurn} 点）。${directive}`
                })
                .filter((line) => line !== '')
              if (lines.length > 0) {
                parts.push('【情绪惯性（刚被触发，这一轮按它来，别一秒冷静）】\n' + lines.join('\n'))
              }
            }
            const text = parts.join('\n\n')
            frozen.set(sessionId, { anchor, text })
            return text
          } catch {
            return ''
          }
        },
      })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch {
      return () => {}
    }
  }

  // ── 对外接口（HTTP） ────────────────────────────────────────────────────────

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          reject(new Error('body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw === '') return resolve({})
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('invalid JSON body'))
        }
      })
      request.on('error', reject)
    })
  }

  function pickSession(value, url) {
    const fromValue = typeof value === 'string' ? value.trim() : ''
    if (fromValue !== '') return fromValue
    const fromQuery = url.searchParams.get('session')
    if (typeof fromQuery === 'string' && fromQuery.trim() !== '') return fromQuery.trim()
    try {
      const current = manager.currentSession ? manager.currentSession() : ''
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // ignore
    }
    return ''
  }

  function specValue() {
    return {
      version: 1,
      description: '每轮子智能体（操控中心）产出的动作总线；外部消费者（桌宠皮套等）轮询取动作。',
      blocks: OPS_BLOCKS,
      modes: OPS_MODES,
      controlTypes: OPS_CONTROL_TYPES,
      actionShape: { id: 'string', seq: 'number', type: 'string', payload: 'object', ttlMs: 'number', createdAt: 'ISO8601' },
      endpoints: {
        pending: 'GET /companion/ops/control/pending?session=<id>&after=<seq>',
        ack: 'POST /companion/ops/control/ack {"session":"<id>","ids":["act_…"]}',
        state: 'GET /companion/ops/state?session=<id>',
        run: 'POST /companion/ops/run {"session":"<id>"}',
      },
    }
  }

  const pendingOf = (sessionId, after) => {
    const state = readState(sessionId)
    const items = state.control.items.filter((item) => item && item.acked !== true && Number(item.seq) > after)
    return { sessionId, lastSeq: state.control.seq, items }
  }

  const ackOf = (sessionId, ids) => {
    const state = readState(sessionId)
    const wanted = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
    let acked = 0
    const items = state.control.items.map((item) => {
      if (item && wanted.has(item.id) && item.acked !== true) {
        acked += 1
        return { ...item, acked: true, ackedAt: new Date().toISOString() }
      }
      return item
    })
    writeState(sessionId, { ...state, control: { ...state.control, items } })
    return { acked }
  }

  const registerApi = () => {
    try {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (!webServer || typeof webServer.register !== 'function') return () => {}
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/companion/ops',
        handler: async (request, response) => {
          const send = (status, value) => {
            const body = JSON.stringify(value)
            response.statusCode = status
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.setHeader('cache-control', 'no-cache')
            response.setHeader('content-length', Buffer.byteLength(body))
            response.end(body)
          }
          try {
            if (!isTrustedApiRequest(ctx, webServer, request)) {
              send(403, { ok: false, error: { message: 'forbidden' } })
              return
            }
            const url = new URL(request.url ?? '/', 'http://dsh.internal')
            const route = url.pathname.replace(/^\/companion\/ops\/?/, '')
            const method = request.method
            if (method === 'GET' && (route === '' || route === 'spec')) {
              send(200, { ok: true, value: specValue() })
              return
            }
            if (method === 'GET' && route === 'state') {
              const sessionId = pickSession('', url)
              if (sessionId === '') throw new Error('没有识别到当前对话')
              const ops = describeOps(opsConfig(sessionId))
              const state = readState(sessionId)
              send(200, {
                ok: true,
                value: {
                  sessionId,
                  ops,
                  running: runtimeOf(sessionId).running,
                  lastRun: state.lastRun,
                  style: state.style,
                  emotion: state.emotion,
                  mood: readGlobal(),
                  sharedMood: ops.sharedMood === true,
                  control: pendingOf(sessionId, 0),
                  enabled: manager.isEnabled(sessionId),
                },
              })
              return
            }
            if (method === 'GET' && route === 'control/pending') {
              const sessionId = pickSession('', url)
              if (sessionId === '') throw new Error('没有识别到当前对话')
              const after = Number(url.searchParams.get('after') || 0)
              send(200, { ok: true, value: pendingOf(sessionId, Number.isFinite(after) ? after : 0) })
              return
            }
            if (method === 'POST' && route === 'control/ack') {
              const body = await readBody(request)
              const sessionId = pickSession(body.session, url)
              if (sessionId === '') throw new Error('没有识别到当前对话')
              send(200, { ok: true, value: ackOf(sessionId, body.ids) })
              return
            }
            if (method === 'POST' && route === 'run') {
              const body = await readBody(request)
              const sessionId = pickSession(body.session, url)
              if (sessionId === '') throw new Error('没有识别到当前对话')
              // 手动运行：缓冲为空时 runOnce 会用 48 小时热缓存兜底，这里不用额外补
              const rt = runtimeOf(sessionId)
              rt.running = false
              rt.lastSignature = ''
              const result = await runOnce(sessionId, { manual: true })
              send(200, { ok: true, value: result })
              return
            }
            if (method === 'POST' && route === 'config') {
              const body = await readBody(request)
              const sessionId = pickSession(body.session, url)
              if (sessionId === '') throw new Error('没有识别到当前对话')
              const perf = manager.performance
              if (!perf || typeof perf.update !== 'function') throw new Error('性能模式不可用')
              const next = perf.update(sessionId, { ops: body.patch && typeof body.patch === 'object' ? body.patch : body.ops })
              send(200, { ok: true, value: describeOps(next.ops) })
              return
            }
            send(404, { ok: false, error: { message: `unknown route: ${route}` } })
          } catch (error) {
            send(500, { ok: false, error: { message: String(error && error.message ? error.message : error) } })
          }
        },
      })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      log('api-register-failed', String(error && error.message))
      return () => {}
    }
  }

  // ── 挂钩 ────────────────────────────────────────────────────────────────────

  const disposers = []
  const offContext = registerPromptContext()
  if (typeof offContext === 'function') disposers.push(offContext)
  const offApi = registerApi()
  if (typeof offApi === 'function') disposers.push(offApi)
  if (typeof ctx.on === 'function') {
    try {
      disposers.push(ctx.on('session/event', onSessionEvent))
    } catch (error) {
      log('hook-session-failed', String(error && error.message))
    }
    try {
      disposers.push(ctx.on('agent/turn-stopping', onTurnStopping))
    } catch (error) {
      // 老版本宿主没有这个事件：靠 assistant 消息的兜底定时器
      log('hook-turn-stopping-failed', String(error && error.message))
    }
    try {
      disposers.push(ctx.on('agent/status', (payload) => {
        try {
          const agent = payload && payload.agent
          const sessionId = agent && typeof agent.id === 'string' ? agent.id : ''
          const status = payload && typeof payload.status === 'string' ? payload.status : ''
          if (sessionId === '' || status === '') return
          agentStatus.set(sessionId, status)
          log('agent-status', `session=${sessionId.slice(0, 12)} status=${status}`)
          // 变成空闲 = 这一轮真的结束了：这是最稳的「每轮」触发点（比 turn-stopping 更保险）
          if (status === 'idle') {
            const timer = fallbackTimers.get(sessionId)
            if (timer) {
              clearTimeout(timer)
              fallbackTimers.delete(sessionId)
            }
            scheduleRun(sessionId, 'agent-idle')
          }
        } catch {
          // ignore
        }
      }))
    } catch (error) {
      log('hook-agent-status-failed', String(error && error.message))
    }
  }

  let enabledCount = '?'
  try {
    enabledCount = Array.isArray(manager.enabledSessions()) ? manager.enabledSessions().length : '?'
  } catch {
    // ignore
  }
  log('ready', `sessions-enabled=${enabledCount}`)

  return {
    /** 立刻跑一次（面板/接口/测试用）。 */
    run: (sessionId) => runOnce(sessionId, { manual: true }),
    config: (sessionId) => describeOps(opsConfig(sessionId)),
    state: (sessionId) => readState(sessionId),
    /** 跨对话共享的整体情绪（面板/接口/其它插件看现状用）。 */
    mood: () => readGlobal(),
    /** 给提示词/QQ 回执用的「整体情绪」行为指令；没有情绪时返回空串。 */
    moodDirective: (sessionId, options) => moodDirective(sessionId, options || {}),
    pending: pendingOf,
    ack: ackOf,
    spec: specValue,
    dispose: () => {
      for (const timer of fallbackTimers.values()) {
        try {
          clearTimeout(timer)
        } catch {
          // ignore
        }
      }
      fallbackTimers.clear()
      runtime.clear()
      stateCache.clear()
      frozen.clear()
      agentStatus.clear()
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // ignore
        }
      }
    },
  }
}

/** index.js 挂载入口（事件 + 动态上下文 + /companion/ops 路由）。 */
export function registerOpsAgent(ctx, manager) {
  const agent = createOpsAgent(ctx, manager)
  manager.opsAgent = agent
  return () => {
    try {
      agent.dispose()
    } catch {
      // ignore
    }
    if (manager.opsAgent === agent) manager.opsAgent = null
  }
}
