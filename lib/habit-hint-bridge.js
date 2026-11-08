/**
 * 「习惯提示小模型」（独立插件 @local/habit-hint）→ 「对话人习惯」记忆的接入桥。
 *
 * 设计约束（和用户确认过的）：
 *   - 不改 habit-hint 的任何代码，也不改它往系统提示词注入的行为；
 *   - 只读它已经公开的接口 GET /habit-hint/api/status（这就是「原有留的接口」；
 *     面板/训练/开关全部照旧，这里只是另一个读者）；
 *   - 不碰 QQ 通道：QQ 路由会话直接跳过，避免影响 QQ 那边的回复；
 *   - 抽到的习惯写进对应会话的「对话人习惯」记录，复用 store.addMemory 的
 *     强度机制（新的建立 50，重复的 +10 封顶 100，久不提会衰减），
 *     所以它们在面板的习惯区里和主 AI 自己记的习惯完全一样。
 *
 * 状态落在 <数据根>/habit-hint-sync.json，只记同步进度和最近一次结果，不存记忆正文。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATUS_PATH = '/habit-hint/api/status'
const SYNC_FILE = 'habit-hint-sync.json'
const MAX_HABITS_PER_RUN = 3
const MIN_HABIT_CHARS = 3
const MAX_HABIT_CHARS = 60
const FETCH_TIMEOUT_MS = 6000
const SYNC_INTERVAL_MS = 30 * 1000
const FIRST_SYNC_DELAY_MS = 20 * 1000
// 同一句话的习惯重复导入有冷却：小模型每轮都会重新抽到同样的习惯，
// 不拦一下会每半分钟把强度 +10，几分钟就全顶到 100。
const IMPORT_COOLDOWN_MS = 30 * 60 * 1000

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJsonSafe(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 带超时的 GET：宿主内其它插件的同源接口，拿不到就当没有，绝不影响主流程。 */
async function fetchJson(url) {
  if (typeof fetch !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch { /* ignore */ } }, FETCH_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = await response.json()
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {object} manager CompanionManager
 * @param {{ getOrigin?: () => string }} options getOrigin 返回 http://127.0.0.1:<port>
 */
export function createHabitHintBridge(manager, options = {}) {
  const root = typeof manager?.root === 'string' && manager.root !== '' ? manager.root : ''
  const file = root === '' ? '' : join(root, SYNC_FILE)
  const getOrigin = typeof options.getOrigin === 'function' ? options.getOrigin : () => ''
  const initial = file === '' ? {} : readJsonSafe(file, {})
  const state = {
    enabled: initial.enabled !== false,
    lastAttemptAt: typeof initial.lastAttemptAt === 'string' ? initial.lastAttemptAt : null,
    lastSyncAt: typeof initial.lastSyncAt === 'string' ? initial.lastSyncAt : null,
    lastFingerprint: typeof initial.lastFingerprint === 'string' ? initial.lastFingerprint : '',
    lastSessionId: typeof initial.lastSessionId === 'string' ? initial.lastSessionId : null,
    lastError: typeof initial.lastError === 'string' ? initial.lastError : '',
    lastSkip: typeof initial.lastSkip === 'string' ? initial.lastSkip : '',
    lastImported: Array.isArray(initial.lastImported) ? initial.lastImported.slice(0, 10) : [],
    importedTotal: Number.isFinite(Number(initial.importedTotal)) ? Number(initial.importedTotal) : 0,
    lastPreview: initial.lastPreview && typeof initial.lastPreview === 'object' ? initial.lastPreview : null,
    recentImports: initial.recentImports && typeof initial.recentImports === 'object' && Array.isArray(initial.recentImports) === false ? initial.recentImports : {},
  }
  let timer = null
  let running = null

  const persist = () => {
    if (file === '') return
    writeJsonSafe(file, state)
  }

  const stateValue = () => ({
    enabled: state.enabled,
    lastAttemptAt: state.lastAttemptAt,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    lastSkip: state.lastSkip,
    lastSessionId: state.lastSessionId,
    lastImported: state.lastImported,
    importedTotal: state.importedTotal,
    lastPreview: state.lastPreview,
    autoEverySeconds: Math.round(SYNC_INTERVAL_MS / 1000),
  })

  /**
   * 拉一次 habit-hint 的 lastHints，把其中「习惯」写进对应会话的记忆。
   * 返回一段可以直接给面板/接口看的小结。
   */
  async function sync(payload = {}) {
    const force = payload.force === true
    state.lastAttemptAt = new Date().toISOString()
    if (state.enabled !== true) {
      state.lastSkip = 'disabled'
      persist()
      return { ...stateValue(), ok: false, reason: '已关闭自动接入' }
    }
    const origin = String(getOrigin() || '').replace(/\/+$/, '')
    if (origin === '') {
      state.lastSkip = 'no-origin'
      state.lastError = '还没拿到本机接口地址（等面板开过一次再说）'
      persist()
      return { ...stateValue(), ok: false, reason: state.lastError }
    }
    const payloadJson = await fetchJson(origin + STATUS_PATH)
    if (!payloadJson) {
      state.lastSkip = 'fetch-failed'
      state.lastError = '读不到 /habit-hint/api/status（插件没加载或还没起来）'
      persist()
      return { ...stateValue(), ok: false, reason: state.lastError }
    }
    const value = payloadJson.value && typeof payloadJson.value === 'object' ? payloadJson.value : payloadJson
    if (value.enabled === false) {
      state.lastSkip = 'plugin-disabled'
      state.lastError = '习惯提示插件处于关闭状态'
      persist()
      return { ...stateValue(), ok: false, reason: state.lastError }
    }
    const lastHints = value.lastHints && typeof value.lastHints === 'object' ? value.lastHints : null
    // habit-hint 的 lastHints 用 `session` 存会话 id（老版本可能叫 sessionId），两种都认。
    const hintsSessionId = lastHints
      ? String(lastHints.session || lastHints.sessionId || '').trim()
      : ''
    const habits = lastHints && Array.isArray(lastHints.habits) ? lastHints.habits : []
    state.lastPreview = lastHints === null ? null : {
      at: typeof lastHints.at === 'string' ? lastHints.at : null,
      sessionId: hintsSessionId === '' ? null : hintsSessionId,
      habits: habits.map(normalizeText).filter(Boolean).slice(0, MAX_HABITS_PER_RUN),
      important: Array.isArray(lastHints.important) ? lastHints.important.map(normalizeText).filter(Boolean).slice(0, 5) : [],
      hints: Array.isArray(lastHints.hints) ? lastHints.hints.map(normalizeText).filter(Boolean).slice(0, 5) : [],
    }
    state.lastError = ''
    if (habits.length === 0) {
      state.lastSkip = 'no-hints-yet'
      persist()
      return { ...stateValue(), ok: true, imported: [], reason: '小模型还没产出习惯（要再聊几轮）' }
    }
    const sessionId = hintsSessionId
    if (sessionId === '' || typeof manager?.isEnabled !== 'function' || manager.isEnabled(sessionId) !== true) {
      state.lastSkip = 'session-not-enabled'
      persist()
      return { ...stateValue(), ok: false, reason: '这条提示对应的会话没开伴侣记忆，先不写' }
    }
    // QQ 只负责把消息送进这个会话：会话本身和普通会话一样对待，照常写入。
    const fingerprint = `${sessionId}|${lastHints.at || ''}|${habits.map(normalizeText).join('\u0001')}`
    if (force !== true && fingerprint !== '' && fingerprint === state.lastFingerprint) {
      state.lastSkip = 'unchanged'
      persist()
      return { ...stateValue(), ok: true, imported: [], reason: '和上次是同一批提示，不重复写' }
    }
    const batch = []
    for (const raw of habits.slice(0, MAX_HABITS_PER_RUN)) {
      const text = normalizeText(raw)
      if (text.length < MIN_HABIT_CHARS || text.length > MAX_HABIT_CHARS) continue
      batch.push(text)
    }
    if (batch.length === 0) {
      state.lastSkip = 'empty-after-filter'
      persist()
      return { ...stateValue(), ok: true, imported: [], reason: '这批提示没有可用的短习惯句' }
    }
    // 同一句话刚写过就别再加强：小模型每轮都会重新抽到相同习惯
    const now = Date.now()
    const recent = state.recentImports && typeof state.recentImports === 'object' ? state.recentImports : {}
    const due = batch.filter((text) => {
      const last = Number(recent[`${sessionId}|${text}`] || 0)
      return !(last > 0 && now - last < IMPORT_COOLDOWN_MS)
    })
    if (due.length === 0) {
      state.lastSkip = 'cooldown'
      persist()
      return { ...stateValue(), ok: true, imported: [], reason: '这批习惯刚写过，先不重复加强' }
    }
    let store = null
    try {
      store = manager.storeFor(sessionId)
    } catch {
      store = null
    }
    if (!store || typeof store.addMemory !== 'function') {
      state.lastSkip = 'no-store'
      state.lastError = '该会话的记忆数据未能初始化'
      persist()
      return { ...stateValue(), ok: false, reason: state.lastError }
    }
    const imported = []
    for (const text of due) {
      try {
        const before = Array.isArray(store.state?.memories) ? store.state.memories.length : 0
        const memory = store.addMemory(text, ['习惯', '小模型'], {
          source: 'habit-hint',
          category: '偏好',
        })
        if (!memory) continue
        const after = Array.isArray(store.state?.memories) ? store.state.memories.length : before
        imported.push({
          text,
          id: memory.id,
          new: after > before,
          strength: Number(memory.habitStrength) || null,
        })
      } catch {
        // 单条失败不影响其它条
      }
    }
    if (imported.length > 0 && typeof store.persist === 'function') store.persist()
    if (imported.length > 0) {
      for (const item of imported) recent[`${sessionId}|${item.text}`] = now
      const keys = Object.keys(recent)
      if (keys.length > 200) {
        keys.sort((a, b) => Number(recent[a] || 0) - Number(recent[b] || 0))
        for (const key of keys.slice(0, keys.length - 200)) delete recent[key]
      }
      state.recentImports = recent
    }
    state.lastFingerprint = fingerprint
    state.lastSessionId = sessionId
    state.lastSkip = ''
    if (imported.length > 0) {
      state.lastSyncAt = new Date().toISOString()
      state.importedTotal += imported.length
      state.lastImported = imported
    }
    persist()
    return {
      ...stateValue(),
      ok: true,
      imported,
      reason: imported.length > 0
        ? `接入 ${imported.length} 条习惯（${imported.filter((item) => item.new).length} 条新建，${imported.filter((item) => !item.new).length} 条加强）`
        : '这批提示没有写进去',
    }
  }

  const tick = () => {
    if (running) return
    running = sync({ force: false })
      .catch(() => null)
      .finally(() => { running = null })
  }

  const start = () => {
    if (timer !== null) return
    const first = setTimeout(tick, FIRST_SYNC_DELAY_MS)
    if (typeof first.unref === 'function') first.unref()
    timer = setInterval(tick, SYNC_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const stop = () => {
    if (timer !== null) {
      try { clearInterval(timer) } catch { /* ignore */ }
      timer = null
    }
  }

  const setEnabled = (next) => {
    state.enabled = next === true
    state.lastSkip = state.enabled ? '' : 'disabled'
    persist()
    return stateValue()
  }

  return { state: stateValue, sync, start, stop, setEnabled }
}
