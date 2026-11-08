/**
 * 睡眠期预计算（sleep-time compute 的本地版）。
 *
 * 思路（抄 Letta 2025 那篇 Sleep-time Compute）：
 *   趁用户不说话的空档，提前把「接下来可能会聊什么、该怎么接」算出来，存成提示；
 *   真正回话的还是主模型，这里只负责把提示词预热。不回答、不改记忆、不碰 QQ。
 *
 * 约束：
 *   - 只在会话「空闲」一段时间后才跑（默认 25 分钟没新消息），不抢正在聊的那个；
 *   - 产出写到 D:\AI\习惯模型\data\sleep\<sessionId>.json，由 prompt.js 读进动态上下文；
 *   - 结果带过期时间（12 小时），过期的不会注入；
 *   - 全本地：跑的是本机 python 脚本，断网也能跑。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULTS = {
  enabled: true,
  pythonPath: 'D:\\AI\\语音POC\\venv-qwen3tts\\Scripts\\python.exe',
  scriptPath: 'D:\\AI\\习惯模型\\scripts\\sleep_compute.py',
  outDir: 'D:\\AI\\习惯模型\\data\\sleep',
  idleMinutes: 25, // 会话空闲多久算「睡着了」
  minIntervalMinutes: 45, // 同一会话两次预计算至少隔这么久
  activeWithinDays: 3, // 只给近几天活跃过的会话预判
  tickMs: 5 * 60 * 1000,
  maxSpawnsPerTick: 2,
}

function loadDefaults(config) {
  const source = config && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key]
    if (typeof value === typeof DEFAULTS[key]) merged[key] = value
  }
  return merged
}

export function createSleepCompute(manager, config = {}) {
  const cfg = loadDefaults(config)
  const root = typeof manager?.root === 'string' ? manager.root : ''
  const sessionsRoot = root === '' ? '' : join(root, 'sessions')
  const state = {
    running: false,
    lastTickAt: null,
    lastSpawnAt: null,
    lastSessionId: null,
    spawned: 0,
    skipped: 0,
    lastError: '',
  }
  const lastSpawnBySession = new Map()
  let timer = null

  /** 会话数据目录里的 recent.json 路径（目录名形如 <sessionId>_<hash>）。 */
  function recentFileOf(sessionId) {
    if (sessionsRoot === '' || !existsSync(sessionsRoot)) return ''
    let names = []
    try {
      names = readdirSync(sessionsRoot)
    } catch {
      return ''
    }
    const exact = names.find((name) => name === sessionId)
    if (exact) {
      const hit = join(sessionsRoot, exact, 'recent.json')
      return existsSync(hit) ? hit : ''
    }
    for (const name of names) {
      if (!name.startsWith(sessionId + '_')) continue
      const hit = join(sessionsRoot, name, 'recent.json')
      if (existsSync(hit)) return hit
    }
    return ''
  }

  function outFileOf(sessionId) {
    return join(cfg.outDir, sessionId + '.json')
  }

  function shouldCompute(sessionId, recentFile) {
    let stat = null
    try {
      stat = statSync(recentFile)
    } catch {
      return false
    }
    const now = Date.now()
    const idleMs = now - stat.mtimeMs
    if (idleMs < cfg.idleMinutes * 60 * 1000) return false
    if (idleMs > cfg.activeWithinDays * 24 * 3600 * 1000) return false
    const lastSpawn = lastSpawnBySession.get(sessionId) || 0
    if (now - lastSpawn < cfg.minIntervalMinutes * 60 * 1000) return false
    const outFile = outFileOf(sessionId)
    if (existsSync(outFile)) {
      try {
        const statOut = statSync(outFile)
        // 缓存还新（不到半个最小间隔）就不重算
        if (now - statOut.mtimeMs < Math.max(10, cfg.minIntervalMinutes / 2) * 60 * 1000) return false
      } catch {
        // 读不到就重算
      }
    }
    return true
  }

  function spawnCompute(sessionId) {
    if (!existsSync(cfg.pythonPath) || !existsSync(cfg.scriptPath)) {
      state.lastError = 'python 或脚本不存在'
      return false
    }
    const outFile = outFileOf(sessionId)
    try {
      const child = spawn(cfg.pythonPath, [cfg.scriptPath, '--session', sessionId, '--out', outFile], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      child.unref()
      lastSpawnBySession.set(sessionId, Date.now())
      state.lastSpawnAt = new Date().toISOString()
      state.lastSessionId = sessionId
      state.spawned += 1
      return true
    } catch (error) {
      state.lastError = String(error && error.message)
      return false
    }
  }

  async function tick() {
    if (state.running || cfg.enabled !== true) return
    state.running = true
    state.lastTickAt = new Date().toISOString()
    let spawned = 0
    try {
      let rows = []
      try {
        rows = typeof manager?.listSessions === 'function' ? await manager.listSessions() : []
      } catch {
        rows = []
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (spawned >= cfg.maxSpawnsPerTick) break
        const sessionId = String(row?.id || '').trim()
        if (sessionId === '' || row?.enabled !== true) continue
        const recentFile = recentFileOf(sessionId)
        if (recentFile === '') continue
        if (!shouldCompute(sessionId, recentFile)) {
          state.skipped += 1
          continue
        }
        if (spawnCompute(sessionId)) spawned += 1
      }
    } catch (error) {
      state.lastError = String(error && error.message)
    } finally {
      state.running = false
    }
  }

  function start() {
    if (timer || cfg.enabled !== true) return
    // 启动后先等一会，避开插件加载、第一轮同步的高峰
    const first = setTimeout(() => {
      tick().catch(() => null)
    }, 90 * 1000)
    if (typeof first.unref === 'function') first.unref()
    timer = setInterval(() => {
      tick().catch(() => null)
    }, cfg.tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    start,
    stop,
    tick,
    state: () => ({ ...state, config: { idleMinutes: cfg.idleMinutes, outDir: cfg.outDir } }),
  }
}
