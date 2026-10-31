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
import { PeopleRegistry } from './people.js'
import { QqBot } from './qq.js'
import { QqBridge } from './qq-bridge.js'

const REGISTRY_VERSION = 1

/**
 * 「接入软件」示例清单：第一次用的人照着改就行。
 * 清单只描述软件，不执行代码——真要跑起来的接入由那个软件自己提供。
 */
const EXAMPLE_INTEGRATION = {
  id: 'example-software',
  name: '示例软件',
  description: '把这份 JSON 改成你要接入的软件：说清它是什么、能干什么。',
  version: '0.1.0',
  author: '你的名字',
  category: '通道',
  tags: ['示例', '改我'],
  homepage: 'https://github.com/your-name/your-integration',
  capabilities: ['读消息', '发消息'],
}

/**
 * 「接入软件」里本应用自带的内置接入（不需要放清单、跟着插件走）。
 * 用户要加别的自带接入时，往这个数组里加一条即可。
 */
const BUILTIN_INTEGRATIONS = [
  {
    id: 'qqbot-app',
    name: 'QQ 机器人',
    kind: '应用',
    description: '点「打开」就能用的自带应用：群成员识别、按人分的评价与记忆都在里面，不依赖安装 dsh-qqbot。',
    version: '1.2.0',
    author: '本插件自带',
    category: '应用',
    tags: ['QQ', '群成员', '自带应用'],
    capabilities: ['群成员识别', '按人分记忆', '群成员总体记忆', '好感度'],
    builtin: true,
    openable: true,
    app: 'qqbot',
    attribution: {
      reference: 'dsh-qqbot',
      referenceUrl: 'https://github.com/zaofan/dsh-qqbot',
      author: 'zaofan',
      license: 'MIT',
      note: '界面与交互参考 dsh-qqbot（MIT 许可）；群成员识别、好感度、记忆已换成 AI记忆 自己的实现，安装本插件即可用，不需要另装 dsh-qqbot。',
    },
  },
]

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

/**
 * Workspace caption for a session: the last path segment of its cwd. Sessions
 * recorded before workspaces existed have no cwd and land in their own bucket.
 */
function workspaceLabel(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '') return '未指定工作区'
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const base = parts.length > 0 ? parts[parts.length - 1] : raw
  return base || '未指定工作区'
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
    // rootDir 让 store 能找到「所有对话共享」的配置（目前是全局角色名字）。
    const store = new CompanionStore(this.ctx, { ...this.config, dataDir: dir, rootDir: this.root })
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
      rows.push({
        id,
        createdAt: isFiniteNumber(header.createdAt) ? header.createdAt : null,
        live: record?.live === true,
        cwd: typeof header.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : null,
      })
      if (rows.length >= 40) break
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
    const current = this.currentSession()
    const rows2 = rows.map((row) => ({
      id: row.id,
      title: titles.get(row.id) ?? '',
      createdAt: row.createdAt,
      live: row.live,
      cwd: row.cwd,
      workspace: workspaceLabel(row.cwd),
      enabled: this.isEnabled(row.id),
    }))
    // Drop untitled, never-used conversations: the panel used to list them as
    // "对话 xxxxxxxx" even though the user never actually talked there. Keep
    // anything titled, anything the user enabled, and the one the panel is
    // currently following.
    const items = rows2.filter((row) => row.title !== '' || row.enabled || row.id === current)
    const known = rows2.find((row) => row.id === current)
    if (current && !items.some((row) => row.id === current)) {
      items.unshift({
        id: current,
        title: known?.title ?? '',
        createdAt: known?.createdAt ?? null,
        live: true,
        cwd: known?.cwd ?? null,
        workspace: workspaceLabel(known?.cwd ?? null),
        enabled: this.isEnabled(current),
      })
    }
    const groups = []
    const byWorkspace = new Map()
    // 路径 → 工作区 id：面板的「＋新建对话」要交给宿主 client 的 uiWorkspace 去建/打开，
    // 它需要 workspaceId（只给 cwd 会落进「未分组」）。
    const workspaceIds = new Map()
    try {
      const registry = this.getService('workspaceRegistry')
      const list = registry && typeof registry.list === 'function' ? registry.list() ?? [] : []
      const normalize = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
      for (const workspace of list) {
        if (!workspace || !workspace.id || !workspace.path) continue
        workspaceIds.set(normalize(workspace.path), String(workspace.id))
      }
    } catch {
      workspaceIds.clear()
    }
    for (const row of items) {
      const key = row.cwd ?? ''
      let group = byWorkspace.get(key)
      if (!group) {
        group = {
          key,
          label: row.workspace,
          cwd: row.cwd,
          workspaceId: workspaceIds.get(String(row.cwd ?? '').replace(/[\\/]+$/, '').toLowerCase()) ?? null,
          sessions: [],
        }
        byWorkspace.set(key, group)
        groups.push(group)
      }
      group.sessions.push(row)
    }
    return { current: current ?? items.find((item) => item.enabled)?.id ?? null, items, groups }
  }

  /**
   * 全局人物档案（QQ 群成员识别）：稳定 ID 为主键、昵称历史 + 改名记录。
   * 跨对话共享（认人），好感度仍归各自对话。
   */
  people() {
    if (!this._people) this._people = new PeopleRegistry(this.root)
    return this._people
  }

  /** 自带的 QQ 机器人连接（原生实现，不依赖 dsh-qqbot）。 */
  qq() {
    if (!this._qq) this._qq = new QqBot(this.root)
    return this._qq
  }

  /** QQ 消息 ⇄ dsh 会话 的路由（入站转发 + 出站回发 + 审批卡片）。 */
  bridge() {
    if (!this._bridge) this._bridge = new QqBridge(this.ctx, this.qq(), this)
    return this._bridge
  }

  /** 给桥接扩展的本地接口地址文件（{root}/api-endpoint.json）。 */
  endpointFile() {
    return join(this.root, 'api-endpoint.json')
  }

  /** 「接入软件」清单目录：{root}/integrations（全局，不分对话）。 */
  integrationsDir() {
    return join(this.root, 'integrations')
  }

  /**
   * 扫描「接入软件」清单（`{root}/integrations/*.json`）。
   *
   * 这一版只读数据、不执行任何代码：清单只描述软件是谁、能干什么。
   * 真正要跑起来的接入（比如 QQ 通道）由那个软件自己提供桥接，不在这里执行。
   * 单个坏清单只跳过它，不影响其它条目。
   */
  listIntegrations() {
    const dir = this.integrationsDir()
    const items = []
    try {
      mkdirSync(dir, { recursive: true })
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'))
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
          const id = String(raw.id ?? entry.name.replace(/\.json$/i, '')).trim()
          const name = String(raw.name ?? raw.title ?? id).trim()
          if (id === '' || name === '') continue
          const list = (value, max) =>
            Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, max) : []
          items.push({
            id,
            name,
            description: String(raw.description ?? raw.desc ?? '').trim(),
            version: String(raw.version ?? '').trim(),
            author: String(raw.author ?? '').trim(),
            category: String(raw.category ?? '').trim(),
            homepage: String(raw.homepage ?? raw.url ?? '').trim(),
            entry: String(raw.entry ?? '').trim(),
            tags: list(raw.tags, 8),
            capabilities: list(raw.capabilities, 12),
            file: join(dir, entry.name),
          })
        } catch {
          // 坏一份清单不影响整个列表。
        }
      }
    } catch {
      // 目录不可读：当作空列表。
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    // 自带接入（内置，不依赖 integrations 目录里的清单）
    return { dir, items, builtin: BUILTIN_INTEGRATIONS.map((item) => ({ ...item })) }
  }

  /** 写一份示例清单（已存在就不覆盖），给第一次接入的人照着改。 */
  writeIntegrationExample() {
    const dir = this.integrationsDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'example.json')
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(EXAMPLE_INTEGRATION, null, 2) + '\n', 'utf8')
    }
    return { dir, file }
  }

  getService(name) {
    if (!this.ctx || typeof this.ctx.get !== 'function') return undefined
    try {
      return this.ctx.get(name)
    } catch {
      return undefined
    }
  }

  /**
   * 读取一个对话的完整聊天记录（导出用）。
   *
   * 顺序：活着的 agent 会话 → sessionQuery.readSession（磁盘里的完整事件日志，
   * 不会把会话变成 live）→ 都不行返回 null，由调用方退回 store.recent（48 小时热缓存）。
   * 这样「没打开过的对话」也能导出全部聊天原文。
   *
   * @returns {Promise<null | Array<{ at: string, role: 'user'|'assistant', text: string }>>}
   */
  async transcriptOf(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (id === '') return null

    // ① 活着的会话
    let events = null
    try {
      const agents = this.getService('agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
      const session = agent?.session ?? null
      if (session && typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
    } catch {
      events = null
    }
    if (!events) {
      try {
        const sessions = this.getService('sessions')
        const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : null
        if (session && typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
      } catch {
        events = null
      }
    }

    // ② 磁盘里读（对话没打开时也能拿到完整历史）
    if (!events) {
      try {
        const query = this.getService('sessionQuery')
        if (query && typeof query.readSession === 'function') {
          const snapshot = await query.readSession(id)
          if (snapshot && Array.isArray(snapshot.events)) events = snapshot.events
        }
      } catch {
        events = null
      }
    }

    if (!Array.isArray(events) || events.length === 0) return null
    return messagesFromEvents(events)
  }
}

/** 从会话事件里抽出「用户 / 角色真正说的话」（纯文本，按时间顺序）。 */
function messagesFromEvents(events) {
  const messages = []
  for (const event of events) {
    const type = event && event.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = event.data ?? {}
    const blocks = type === 'user/message' ? data.content : data.message?.content
    const text = textOfBlocks(blocks)
    if (text === '') continue
    // 跳过上下文注入 / 系统提醒（它们不是「说的话」）
    if (isInjectedContext(text)) continue
    const at = Number.isFinite(event.time) ? new Date(event.time).toISOString() : new Date().toISOString()
    const role = type === 'user/message' ? 'user' : 'assistant'
    const previous = messages[messages.length - 1]
    if (previous && previous.role === role && previous.at === at && previous.text === text) continue
    messages.push({ at, role, text })
  }
  return messages
}

/** 从消息内容块里抽取纯文本（只取 text 块，跳过思考与工具调用）。 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || block.type !== 'text') continue
    const text = String(block.text ?? '').trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

/** 是否是插件/宿主注入的上下文，而不是用户或角色真正说的话。 */
function isInjectedContext(text) {
  const head = text.trimStart()
  if (head.startsWith('【本轮动态状态')) return true
  if (head.startsWith('Current runtime context')) return true
  if (head.startsWith('Time sampled while preparing turn')) return true
  if (head.startsWith('Browser time zone for this request')) return true
  if (head.startsWith('<system-reminder>')) return true
  if (head.startsWith('Companion memory')) return true
  // 人格开场白：DSH 会把「你是一名…」的人设以 ``` 代码块形式作为 user 消息注入
  if (head.startsWith('```')) return true
  // QQ 插件的 @ 方法提示等系统注记
  if (head.startsWith('【@')) return true
  if (head.startsWith('【系统')) return true
  if (head.startsWith('【提醒')) return true
  return false
}

export function createManager(ctx, config) {
  return new CompanionManager(ctx, config)
}
