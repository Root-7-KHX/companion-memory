/**
 * Session-scoped companion stores.
 *
 * Every conversation ("session") can opt in individually and owns a fully
 * isolated data set: persona documents, favorability, active memories, recent
 * 48h window, knowledge-base archive and auto-pack files. New conversations are
 * off by default; the sidebar panel turns them on or off.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CompanionStore } from './store.js'

const REGISTRY_VERSION = 1

function resolveRoot(config) {
  const configured = typeof config?.dataDir === 'string' && config.dataDir.trim() !== '' ? config.dataDir.trim() : null
  if (configured) return configured
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'companion-memory')
  return join(homedir(), '.dsh', 'companion-memory')
}

function safeSegment(value) {
  const raw = String(value ?? '').trim() || 'session'
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) | 0
  const base = raw.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'session'
  return `${base}_${(hash >>> 0).toString(16)}`
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function copyDirRecursive(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyDirRecursive(from, to)
    else if (!existsSync(to)) copyFileSync(from, to)
  }
}

export class CompanionManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.root = resolveRoot(this.config)
    this.registryFile = join(this.root, 'sessions.json')
    this.stores = new Map()
    mkdirSync(this.root, { recursive: true })
    this.registry = this.loadRegistry()
  }

  loadRegistry() {
    const registry = { version: REGISTRY_VERSION, lastActive: null, legacyMigrated: false, enabled: {} }
    try {
      if (existsSync(this.registryFile)) {
        const parsed = JSON.parse(readFileSync(this.registryFile, 'utf8'))
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.lastActive === 'string' && parsed.lastActive !== '') registry.lastActive = parsed.lastActive
          registry.legacyMigrated = parsed.legacyMigrated === true
          if (parsed.enabled && typeof parsed.enabled === 'object') {
            for (const [key, value] of Object.entries(parsed.enabled)) {
              if (!key) continue
              registry.enabled[key] = {
                enabledAt: value && typeof value.enabledAt === 'string' ? value.enabledAt : new Date().toISOString(),
              }
            }
          }
        }
      }
    } catch {
      // A corrupt registry must never break the plugin; start fresh.
    }
    return registry
  }

  persistRegistry() {
    try {
      mkdirSync(this.root, { recursive: true })
      const temp = `${this.registryFile}.tmp`
      writeFileSync(temp, JSON.stringify(this.registry, null, 2), 'utf8')
      renameSync(temp, this.registryFile)
      return true
    } catch {
      return false
    }
  }

  sessionDir(sessionId) {
    return join(this.root, 'sessions', safeSegment(sessionId))
  }

  isEnabled(sessionId) {
    const key = String(sessionId ?? '').trim()
    if (!key) return false
    return Boolean(this.registry.enabled[key])
  }

  enabledSessions() {
    return Object.keys(this.registry.enabled)
  }

  currentSession() {
    return this.registry.lastActive || null
  }

  noteVisible(sessionId) {
    const key = String(sessionId ?? '').trim()
    if (!key) return
    if (this.registry.lastActive === key) return
    this.registry.lastActive = key
    this.persistRegistry()
  }

  setEnabled(sessionId, enabled) {
    const key = String(sessionId ?? '').trim()
    if (!key) throw new Error('缺少会话 id，无法开启或关闭伴侣记忆')
    if (enabled) {
      this.migrateLegacyOnce(key)
      mkdirSync(this.sessionDir(key), { recursive: true })
      if (!this.registry.enabled[key]) this.registry.enabled[key] = { enabledAt: new Date().toISOString() }
      this.registry.lastActive = key
      this.persistRegistry()
      this.storeFor(key)
      return { sessionId: key, enabled: true }
    }
    delete this.registry.enabled[key]
    this.persistRegistry()
    return { sessionId: key, enabled: false }
  }

  /**
   * First-ever enable migrates the old single-dataset install (documents,
   * state.json, recent window, archive, monthly packs and auto packs) into the
   * chosen conversation so upgrading users do not lose their setup.
   */
  migrateLegacyOnce(sessionId) {
    if (this.registry.legacyMigrated === true) return
    this.registry.legacyMigrated = true
    try {
      const legacyState = join(this.root, 'state.json')
      const legacyDocs = join(this.root, '角色性格.md')
      if (!existsSync(legacyState) && !existsSync(legacyDocs)) return
      const target = this.sessionDir(sessionId)
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        if (entry.name === 'sessions' || entry.name === 'sessions.json') continue
        const from = join(this.root, entry.name)
        const to = join(target, entry.name)
        try {
          if (entry.isDirectory()) copyDirRecursive(from, to)
          else if (!existsSync(to)) copyFileSync(from, to)
        } catch {
          // Best effort: a partial migration is still useful.
        }
      }
    } catch {
      // Never fail an enable because of a migration problem.
    }
  }

  storeFor(sessionId) {
    const key = String(sessionId ?? '').trim()
    if (!key) return null
    const cached = this.stores.get(key)
    if (cached) return cached
    const dir = this.sessionDir(key)
    mkdirSync(dir, { recursive: true })
    const store = new CompanionStore(this.ctx, { ...this.config, dataDir: dir })
    try {
      store.init()
    } catch {
      // init already tolerates most failures; keep the instance usable.
    }
    this.stores.set(key, store)
    return store
  }

  /**
   * Session list for the sidebar panel: newest first, enriched with titles and
   * the per-conversation enabled flag.
   */
  async listSessions() {
    const items = []
    const seen = new Set()
    let records = []
    const query = this.getService('sessionQuery')
    try {
      if (query && typeof query.listSessions === 'function') records = await query.listSessions()
    } catch {
      records = []
    }
    if (!Array.isArray(records) || records.length === 0) {
      const agents = this.getService('agents')
      if (agents && typeof agents.list === 'function') {
        records = agents.list().map((agent) => ({ header: { id: agent.id, createdAt: Date.now() }, live: true }))
      }
    }
    const rows = []
    for (const record of Array.isArray(records) ? records : []) {
      const header = record?.header ?? record ?? {}
      const id = String(header.id ?? record?.sessionId ?? '').trim()
      if (!id || seen.has(id)) continue
      if (header.origin === 'subagent' || record?.origin === 'subagent') continue
      seen.add(id)
      rows.push({ id, createdAt: isFiniteNumber(header.createdAt) ? header.createdAt : null, live: record?.live === true })
      if (rows.length >= 30) break
    }
    const ids = rows.map((row) => row.id)
    const titles = new Map()
    try {
      if (query && typeof query.readTitleSnapshots === 'function' && ids.length > 0) {
        const results = await query.readTitleSnapshots(ids)
        for (const result of Array.isArray(results) ? results : []) {
          const value = result && typeof result === 'object' && 'value' in result ? result.value : result
          const title = value?.title?.title ?? value?.title ?? (typeof value === 'string' ? value : null)
          if (typeof title === 'string' && title.trim() !== '') titles.set(String(result.sessionId ?? result.id ?? ''), title.trim())
        }
      }
    } catch {
      titles.clear()
    }
    for (const row of rows) {
      items.push({
        id: row.id,
        title: titles.get(row.id) ?? '',
        createdAt: row.createdAt,
        live: row.live,
        enabled: this.isEnabled(row.id),
      })
    }
    const current = this.currentSession()
    if (current && !items.some((item) => item.id === current)) {
      items.unshift({ id: current, title: '', createdAt: null, live: true, enabled: this.isEnabled(current) })
    }
    return { current: current ?? items.find((item) => item.enabled)?.id ?? null, items }
  }

  getService(name) {
    if (!this.ctx || typeof this.ctx.get !== 'function') return undefined
    try {
      return this.ctx.get(name)
    } catch {
      return undefined
    }
  }
}

export function createManager(ctx, config) {
  return new CompanionManager(ctx, config)
}
