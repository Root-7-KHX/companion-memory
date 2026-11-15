/**
 * performance.js — 每个对话各自的「性能模式」设置。
 *
 * 每个对话一份，互不影响；这里放的是「这个对话要不要省点算力 / 工具表」的开关：
 *   - leanTools      工具表精简：这个对话只留聊天相关工具，省掉约 1.7 万 token/轮
 *   - agentTeam      允许在这个对话里开智能体团队（默认关，开了会多出团队工具与子会话开销）
 * 三档预设就是这两个开关的组合：精简（工具表精简 + 不开团队）、平衡（工具表全量 + 不开团队）、
 * 全力（工具表全量 + 开团队）；手动改单项会自动落到「自定义」。
 * 睡眠期预计算（sleepCompute / sleepIdleMinutes）已经不算性能模式的开关了，它归「习惯模型」管；
 * 本文件只保留这两个字段的读写，兼容旧数据和习惯模型取用，预设与面板都不再碰它。
 *
 * 存储：<数据根>/performance.json
 *   {
 *     "version": 2,
 *     "defaults":  { ... },                // 没单独设置过的对话的初始值
 *     "sessions": { "<sessionId>": { ... } } // 每个对话自己的设置
 *   }
 * 旧版（没有 version 的全局设置）加载时会整份当 defaults，下回保存自动迁移。
 * 所有模块每次用时现读，改完立即生效（无需重启 DSH）。
 * 自动打包的轮数/tokens 属于每个对话自己的记忆配置，不在本文件里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// 「每轮子智能体」的分配（情绪 / 语言习惯 / 记忆 / 操控）存在这里的 ops 字段，
// 每个对话一份；具体运行在 ops-agent.js，本文件只负责存、读、合并。
import { DEFAULT_OPS, describeOps, normalizeOps } from './ops-agent.js'

const FILE_NAME = 'performance.json'
const FILE_VERSION = 2

export const PERFORMANCE_PRESETS = {
  lean: {
    key: 'lean',
    label: '精简模式',
    hint: '工具表只留聊天要用的，不开团队；最省 token，适合只想安静聊天',
    leanTools: true,
    agentTeam: false,
  },
  balanced: {
    key: 'balanced',
    label: '平衡模式',
    hint: '工具表全量、不开团队；功能都齐，只是不跑团队，省掉子会话开销',
    leanTools: false,
    agentTeam: false,
  },
  beast: {
    key: 'beast',
    label: '全力模式',
    hint: '工具表全量、允许开团队；功能最全，token 消耗最高',
    leanTools: false,
    agentTeam: true,
  },
}

// 旧版的 'saver' 预设改名成「精简模式」，读到旧值自动迁移
const PRESET_ALIASES = { saver: 'lean' }

const DEFAULT_SETTINGS = {
  preset: 'balanced',
  leanTools: false,
  agentTeam: false,
  // 睡眠期预计算的兜底值：性能模式页不再展示，留给习惯模型读取
  sleepCompute: true,
  sleepIdleMinutes: 25,
  // 每轮子智能体（操控中心）：默认开，每轮结束都分析一次；分配到的块见 DEFAULT_OPS
  ops: DEFAULT_OPS,
}

function clampMinutes(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.sleepIdleMinutes
  return Math.max(5, Math.min(240, Math.round(parsed)))
}

function normalize(input) {
  const source = input && typeof input === 'object' ? input : {}
  const result = { ...DEFAULT_SETTINGS }
  if (typeof source.leanTools === 'boolean') result.leanTools = source.leanTools
  if (typeof source.agentTeam === 'boolean') result.agentTeam = source.agentTeam
  if (typeof source.sleepCompute === 'boolean') result.sleepCompute = source.sleepCompute
  if (source.sleepIdleMinutes !== undefined) result.sleepIdleMinutes = clampMinutes(source.sleepIdleMinutes)
  // 每轮子智能体：分配本身与预设档无关，单独规整（老数据没有 ops 就用默认值）
  result.ops = normalizeOps(source.ops)
  const rawPreset = typeof source.preset === 'string' ? PRESET_ALIASES[source.preset] || source.preset : ''
  if (rawPreset !== '' && PERFORMANCE_PRESETS[rawPreset]) {
    result.preset = rawPreset
    // 选的是预设档，两个开关就按这一档的定义归正（老数据里对不上的字段也顺手修正）
    result.leanTools = PERFORMANCE_PRESETS[rawPreset].leanTools
    result.agentTeam = PERFORMANCE_PRESETS[rawPreset].agentTeam
  } else if (source.preset === 'custom' || source.preset in PRESET_ALIASES || source.leanTools !== undefined || source.agentTeam !== undefined || source.sleepCompute !== undefined || source.sleepIdleMinutes !== undefined || source.ops !== undefined) {
    // 手动改过单项 → 视为自定义；和某个预设完全一致时归回那个预设
    result.preset = 'custom'
    for (const [key, preset] of Object.entries(PERFORMANCE_PRESETS)) {
      if (preset.leanTools === result.leanTools && preset.agentTeam === result.agentTeam) {
        result.preset = key
        break
      }
    }
  }
  return result
}

function applyPatch(base, patch) {
  const source = patch && typeof patch === 'object' ? patch : {}
  let next = { ...base }
  // 预设：一次性套用工具表 / 团队两个开关（睡眠那两项归习惯模型，不跟着预设变）
  if (typeof source.preset === 'string' && PERFORMANCE_PRESETS[source.preset]) {
    const preset = PERFORMANCE_PRESETS[source.preset]
    next = { ...next, preset: source.preset, leanTools: preset.leanTools, agentTeam: preset.agentTeam }
  } else if (source.preset !== undefined) {
    next.preset = 'custom'
  }
  if (typeof source.leanTools === 'boolean') { next.leanTools = source.leanTools; next.preset = 'custom' }
  if (typeof source.agentTeam === 'boolean') { next.agentTeam = source.agentTeam; next.preset = 'custom' }
  if (typeof source.sleepCompute === 'boolean') { next.sleepCompute = source.sleepCompute; next.preset = 'custom' }
  if (source.sleepIdleMinutes !== undefined) { next.sleepIdleMinutes = clampMinutes(source.sleepIdleMinutes); next.preset = 'custom' }
  // 每轮子智能体的分配：支持只给一部分（例如只改一个块的开关），其余沿用当前值。
  if (source.ops && typeof source.ops === 'object' && !Array.isArray(source.ops)) {
    const baseOps = normalizeOps(next.ops)
    const patch = source.ops
    const patchBlocks = patch.blocks && typeof patch.blocks === 'object' ? patch.blocks : null
    const mergeBlocks = {}
    if (patchBlocks) {
      for (const [key, value] of Object.entries(patchBlocks)) {
        if (value && typeof value === 'object') {
          mergeBlocks[key] = { ...(baseOps.blocks[key] || {}), ...value }
        }
      }
    }
    next.ops = normalizeOps({
      ...baseOps,
      ...patch,
      blocks: { ...baseOps.blocks, ...mergeBlocks },
      model: { ...baseOps.model, ...(patch.model && typeof patch.model === 'object' ? patch.model : {}) },
    })
  }
  return next
}

export function describePerformance(settings) {
  const value = settings || DEFAULT_SETTINGS
  const preset = PERFORMANCE_PRESETS[value.preset]
  return {
    ...value,
    // 面板/接口用：把 ops 展开成带块清单、调用次数估算的描述（存储里仍然是紧凑结构）
    ops: describeOps(value.ops),
    presetLabel: preset ? preset.label : '自定义',
    // 每轮系统提示词里工具定义的粗略估计：精简省约 1.7 万 token，团队工具再加回一部分
    estimatedTools: value.leanTools ? (value.agentTeam ? '精简（含团队工具）' : '精简') : '全量',
  }
}

/**
 * @param {string} rootDir 插件数据根目录；每个对话的设置都记在这里的 performance.json 里
 */
export function createPerformance(rootDir) {
  const root = typeof rootDir === 'string' ? rootDir : ''
  const file = root === '' ? '' : join(root, FILE_NAME)
  let state = load()
  const listeners = new Set()

  function emptyState() {
    return { version: FILE_VERSION, defaults: normalize({}), sessions: {} }
  }

  function load() {
    try {
      if (file === '' || !existsSync(file)) return emptyState()
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.version === FILE_VERSION && raw.defaults) {
        const sessions = {}
        if (raw.sessions && typeof raw.sessions === 'object') {
          for (const [sessionId, value] of Object.entries(raw.sessions)) {
            if (typeof sessionId === 'string' && sessionId.trim() !== '') sessions[sessionId] = normalize(value)
          }
        }
        return { version: FILE_VERSION, defaults: normalize(raw.defaults), sessions }
      }
      // 旧版：整份文件就是一份全局设置，迁移成「默认值」，各对话还没单独设过
      return { version: FILE_VERSION, defaults: normalize(raw), sessions: {} }
    } catch {
      return emptyState()
    }
  }

  function persist() {
    if (file === '') return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
      renameSync(tmp, file)
    } catch {
      // 落盘失败不影响运行中的设置
    }
  }

  function emit(sessionId) {
    for (const listener of listeners) {
      try {
        listener(sessionId, get(sessionId))
      } catch {
        // 单个监听器失败不影响其它
      }
    }
  }

  /** 某个对话当前生效的设置；sessionId 为空时给的是「默认值」。 */
  function get(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const settings = id !== '' && state.sessions[id] ? state.sessions[id] : state.defaults
    return describePerformance({ ...settings })
  }

  /** 只改这一个对话的设置；其它对话不受影响。 */
  function update(sessionId, patch) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') throw new Error('没有识别到当前对话，请先在对话列表中选择一个对话。')
    const base = state.sessions[id] || state.defaults
    state.sessions[id] = normalize(applyPatch(base, patch))
    persist()
    emit(id)
    return get(id)
  }

  /** 这个对话有没有单独存过设置（没存过就是跟着默认值走）。 */
  function hasSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    return id !== '' && Boolean(state.sessions[id])
  }

  /** 清掉某个对话自己的设置，回到默认值；对话被删时可以顺手调用。 */
  function clearSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return false
    if (!state.sessions[id]) return false
    delete state.sessions[id]
    persist()
    emit(id)
    return true
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    get,
    update,
    hasSession,
    clearSession,
    subscribe,
    presets: () => Object.values(PERFORMANCE_PRESETS).map(({ key, label, hint }) => ({ key, label, hint })),
    defaults: () => describePerformance({ ...state.defaults }),
    file,
  }
}

export { DEFAULT_SETTINGS }
