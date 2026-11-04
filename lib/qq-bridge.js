/**
 * qq-bridge.js —— QQ 消息 ⇄ dsh 会话 的双向路由（AI记忆 自带，不依赖 dsh-qqbot）
 *
 * 入站：QQ 收到消息 → 在正文前加「[群聊/私聊｜谁]」→ 塞进配置的 dsh 会话（sessionController.prompt）。
 * 出站：该会话产出 assistant/message → 把正文发回**最近说话的 QQ 会话**（带 msg_id 走被动回复）。
 * 审批：宿主 approval/request → 发带 6 位码的 QQ 卡片（也可以回 /approve CODE）→ 结算。
 *
 * 配置：{数据根}/qq-bridge.json = { enabled, sessionId, approvalEnabled, approvalTimeoutMs }
 * 这一层刻意做得薄：识别/记忆/好感度都在 AI记忆 自己的会话里，QQ 只是它的一个前端。
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describeSpeed } from './voiceprint.js'
import { join } from 'node:path'

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function newCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
}

/**
 * 「AI 主动冒泡」：轮询间隔 + QQ 被动回复窗口（私聊 60 分钟 / 群聊 5 分钟）。
 * 窗口内到点走「回复那条消息」最稳；窗口外到点改走主动消息通道（腾讯可能拦，成败都记在面板里）。
 * 间隔完全由 AI 自己判断：几分钟、几小时、几天、几年都行。
 */
const PROACTIVE_C2C_WINDOW_MS = 60 * 60 * 1000
const PROACTIVE_GROUP_WINDOW_MS = 5 * 60 * 1000
const PROACTIVE_TICK_MS = 15000
/** 单次最多能约多远（10 年）：够「隔几年再发一次」用了，再远没有意义。 */
const PROACTIVE_MAX_DELAY_SECONDS = 10 * 365 * 24 * 3600
const PROACTIVE_PROMPT_MARK = '【主动冒泡 · 到点了】'

function clockOf(value) {
  const date = value instanceof Date ? value : new Date(value)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

function minutesOfClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim())
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** 支持跨夜的静默时段（23:00~08:00）。 */
function inQuietHours(date, start, end) {
  const s = minutesOfClock(start)
  const e = minutesOfClock(end)
  if (s === null || e === null || s === e) return false
  const current = date.getHours() * 60 + date.getMinutes()
  return s < e ? (current >= s && current < e) : (current >= s || current < e)
}

/** 定的到点落在静默时段里 → 挪到这段静默结束之后（别在人家睡觉时冒泡）。 */
function nextQuietEnd(dueAt, start, end) {
  const s = minutesOfClock(start)
  const e = minutesOfClock(end)
  const date = new Date(dueAt)
  if (s === null || e === null || s === e || !inQuietHours(date, start, end)) return dueAt
  date.setSeconds(0, 0)
  date.setHours(Math.floor(e / 60), e % 60, 0, 0)
  if (date.getTime() <= dueAt) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** 「隔了多久」说成人话：分钟 / 小时 / 天。 */
function humanGap(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 90) return '约 ' + minutes + ' 分钟'
  const hours = Math.round(minutes / 60)
  if (hours < 48) return '约 ' + hours + ' 小时'
  return '约 ' + Math.round(hours / 24) + ' 天'
}

function localDayKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}


/** 用户明确说「X 秒/分钟/小时/天后找我」→ 解析出秒数；不是这种就返回 null。 */
const TIMED_REQUEST_RE = /(\d+(?:\.\d+)?|[一二三四五六七八九十两半]+)\s*(秒钟|秒|分钟|分|个小时|小时|天)\s*(?:之后|以后|过后|后)\s*(?:再|来|会|给|主动|记得)?\s*[^。！？!?\n]{0,10}?(找我|叫我|喊我|发消息|发个消息|发我|给我发|提醒我|戳我)/i
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 }

function cnNumberToNumber(text) {
  const raw = String(text || '')
  if (raw === '') return NaN
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  let total = 0
  let current = 0
  for (const char of raw) {
    const value = CN_DIGITS[char]
    if (value === undefined) return NaN
    if (char === '十') { current = (current === 0 ? 1 : current) * 10; total += current; current = 0; continue }
    if (char === '半') { current = current === 0 ? 0.5 : current + 0.5; continue }
    current = current * 10 + value
  }
  return total + current
}

/** 把「5 分钟后过来找我」这种明话拆成秒数。否定说法（别来找我）不算。 */
function parseTimedRequest(text) {
  const match = TIMED_REQUEST_RE.exec(String(text || ''))
  if (!match) return null
  const amount = cnNumberToNumber(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[2]
  const factor = unit === '秒' || unit === '秒钟' ? 1 : unit === '分' || unit === '分钟' ? 60 : unit === '天' ? 86400 : 3600
  const seconds = Math.round(amount * factor)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const verbAt = match[0].search(/(找我|叫我|喊我|发消息|发个消息|发我|给我发|提醒我|戳我)/)
  const prefix = verbAt >= 0 ? match[0].slice(0, verbAt) : ''
  if (/别|不要|不用|甭|无需/.test(prefix)) return null
  return { seconds, phrase: match[0].slice(0, 60) }
}

/** TA 是不是在说「别打扰 / 别发」这类话（这一轮就不该记「漏定」）。 */
function looksLikeQuietRequest(text) {
  const value = String(text || '').replace(/\s+/g, '')
  if (value === '') return false
  if (/(别|不要|不用|甭|先别|暂时别|今天别|今晚别|这两天别)(来|找|发|回|打扰|烦|吵|冒泡|说话|消息|管|催|问)/.test(value)) return true
  if (/(让我安静|我想静静|安静(点|一点|一会|会儿|一下)|别吵|别闹)/.test(value)) return true
  return false
}

/** 读/存 qq-bridge.json 时都过一遍，坏值一律夹回安全范围。 */
function sanitizeProactiveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const clamp = (value, min, max, fallback) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback
    const number = Math.round(Number(value))
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
  }
  const clock = (value, fallback) => minutesOfClock(value) !== null ? String(value).trim() : fallback
  return {
    // 新装默认打开：这个功能就是用户要的「AI 自己决定什么时候冒个泡」
    enabled: raw.enabled !== false,
    // 下面三项不设硬上限：填 0（或负数）都当「不限」，填多大都收，由用户自己决定。
    minSeconds: clamp(raw.minSeconds, 0, PROACTIVE_MAX_DELAY_SECONDS, 60),
    maxPending: clamp(raw.maxPending, 0, 1000000, 3),
    dailyLimit: clamp(raw.dailyLimit, 0, 1000000, 8),
    quietStart: clock(raw.quietStart, '23:00'),
    quietEnd: clock(raw.quietEnd, '08:00'),
  }
}

/** 从 assistant/message 里抽正文（跳过 reasoning / tool 块）。 */
function textOfMessage(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** "/approve ABC123"、"/deny ABC123"、"允许 ABC123" 都认。 */
export function parseApprovalText(text) {
  const value = String(text || '').trim()
  const match = value.match(/^\/(approve|allow|deny|reject)\s+([A-Z0-9]{6})$/i)
    || value.match(/^(允许|同意|拒绝|不同意)\s*([A-Z0-9]{6})$/i)
  if (!match) return null
  const word = match[1].toLowerCase()
  return {
    code: match[2].toUpperCase(),
    outcome: ['approve', 'allow', '允许', '同意'].includes(word) ? 'allowed-once' : 'rejected',
  }
}

export class QqBridge {
  constructor(ctx, bot, manager) {
    this.ctx = ctx
    this.bot = bot
    this.manager = manager
    this.file = join(manager.root, 'qq-bridge.json')
    this.config = this.readConfig()
    this.lastPeer = null
    this.replyBuffer = ''
    this.replySessionId = ''
    this.replyTimer = null
    this.pendingVoiceprint = null
    this.pending = new Map()
    /** 待答提问：token → { resolve, timer, options, qid } */
    this.questions = new Map()
    this.disposers = []
    this.started = false
    this.debugFile = join(manager.root, 'qq-bridge-debug.log')
    /** 会话 id → 最后说话的 QQ 会话（按 chat 独立路由时，回复发回对应的 QQ 聊天） */
    this.lastPeerBySession = new Map()
    /** 本轮已经转发过 assistant 消息的会话 */
    this.repliedTurns = new Set()
    /** 宿主把动态状态当 user 消息注入后，丢掉紧随其后的那条 assistant 消息 */
    this.suppressNext = new Set()
    /** 本轮已经产出过正文的会话（只有「已经发过正文」，后面多出来的那段才算重复） */
    this.textTurns = new Set()
    this.outboxFile = join(manager.root, 'qq-outbox.jsonl')
    this.proactiveFile = join(manager.root, 'qq-proactive.json')
    this.proactiveItems = this.readProactive()
    this.proactiveTimer = null
    this.proactiveBusy = false
    /** 会话 id → 正在冒泡的那条；flushReply 用它把回复定向往对应 QQ 聊天（不跟最近说话的聊天混） */
    this.proactiveSends = new Map()
    /** 用户明说「X 分钟后找我」时先记下来；这轮 AI 只在嘴上答应、没真的定时，就替它兜底排一条 */
    this.timedRequest = null
    /** 这一轮 TA 真的在 QQ 说了话（测试注入不算）：记「漏定」时判断别打扰用 */
    this.turnInbound = new Map()
    /** 最近一次真实入站的内容 + 时间：GUI 里聊天没有 inbound 时，判断「别打扰」用 */
    this.lastInboundText = new Map()
    /** 这一轮是后台/面板注入的假消息（synthetic）：只走「塞给 AI + 回一条」，不触发真实冒泡 */
    this.syntheticTurns = new Set()
    /** 这一轮是不是被主动冒泡叫醒的（自己冒自己不再记漏定，免连环提醒） */
    this.proactiveTurns = new Set()
    /** 会话 id → 上一轮 AI 发了正文却没定下一条（只用来提醒/面板标出，系统绝不代定时间） */
    this.missedProactive = new Map()
  }

  /** 调试：把桥接关键步骤写进 qq-bridge-debug.log（出问题直接看文件）。 */
  dbg(...parts) {
    try {
      appendFileSync(this.debugFile, new Date().toISOString() + ' ' + parts.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ') + '\n', 'utf8')
    } catch { /* ignore */ }
  }

  readConfig() {
    try {
      if (!existsSync(this.file)) return { enabled: false, sessionId: '', approvalEnabled: false, approvalTimeoutMs: 120000, allowedPeers: [], peerSessions: {}, autoCreateSession: true, autoSessionCwd: '', autoSessionWorkspaceId: '', ownerOpenId: '', proactive: sanitizeProactiveConfig(null) }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      return {
        enabled: parsed.enabled === true,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '',
        approvalEnabled: parsed.approvalEnabled === true,
        approvalTimeoutMs: Math.max(5000, Number(parsed.approvalTimeoutMs) || 120000),
        allowedPeers: Array.isArray(parsed.allowedPeers) ? parsed.allowedPeers.map((item) => String(item)).filter(Boolean).slice(0, 200) : [],
        autoCreateSession: parsed.autoCreateSession !== false,
        autoSessionCwd: typeof parsed.autoSessionCwd === 'string' ? parsed.autoSessionCwd.trim() : '',
        autoSessionWorkspaceId: typeof parsed.autoSessionWorkspaceId === 'string' ? parsed.autoSessionWorkspaceId.trim() : '',
        peerSessions: parsed.peerSessions && typeof parsed.peerSessions === 'object' ? Object.fromEntries(Object.entries(parsed.peerSessions).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value])) : {},
        ownerOpenId: typeof parsed.ownerOpenId === 'string' ? parsed.ownerOpenId.trim() : '',
        proactive: sanitizeProactiveConfig(parsed.proactive),
      }
    } catch {
      return { enabled: false, sessionId: '', approvalEnabled: false, approvalTimeoutMs: 120000, allowedPeers: [], peerSessions: {}, autoCreateSession: true, autoSessionCwd: '', autoSessionWorkspaceId: '', ownerOpenId: '', proactive: sanitizeProactiveConfig(null) }
    }
  }

  saveConfig(patch = {}) {
    const next = { ...this.config }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.sessionId === 'string') next.sessionId = patch.sessionId.trim()
    if (typeof patch.approvalEnabled === 'boolean') next.approvalEnabled = patch.approvalEnabled
    if (Number.isFinite(Number(patch.approvalTimeoutMs))) next.approvalTimeoutMs = Math.max(5000, Number(patch.approvalTimeoutMs))
    if (Array.isArray(patch.allowedPeers)) next.allowedPeers = patch.allowedPeers.map((item) => String(item)).filter(Boolean).slice(0, 200)
    if (typeof patch.autoCreateSession === 'boolean') next.autoCreateSession = patch.autoCreateSession
    if (typeof patch.autoSessionCwd === 'string') next.autoSessionCwd = patch.autoSessionCwd.trim()
    if (typeof patch.autoSessionWorkspaceId === 'string') next.autoSessionWorkspaceId = patch.autoSessionWorkspaceId.trim()
    if (patch.peerSessions && typeof patch.peerSessions === 'object') next.peerSessions = { ...(next.peerSessions || {}), ...Object.fromEntries(Object.entries(patch.peerSessions).filter(([, value]) => typeof value === 'string')) }
    if (typeof patch.ownerOpenId === 'string') next.ownerOpenId = patch.ownerOpenId.trim()
    if (patch.proactive && typeof patch.proactive === 'object') next.proactive = sanitizeProactiveConfig({ ...(next.proactive || {}), ...patch.proactive })
    this.config = next
    try {
      // 磁盘上可能已经有别的实例写入的路由映射：合并而不是覆盖
      try {
        const disk = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
        if (disk && disk.peerSessions && typeof disk.peerSessions === 'object') {
          next.peerSessions = { ...disk.peerSessions, ...(next.peerSessions || {}) }
          this.config = next
        }
      } catch { /* ignore */ }
      writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch {
      // ignore
    }
    return this.config
  }

  /** 检查某个会话是否还在（用户可能在界面里把它删了）。查不到/抛错都算不存在。 */
  async sessionExists(sessionId) {
    const id = String(sessionId || '').trim()
    if (id === '') return false
    try {
      const query = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessionQuery') : undefined
      if (query && typeof query.readSession === 'function') {
        const record = await query.readSession(id)
        if (!record) return false
        const header = record.header || record.session || record
        return !(header && (header.deleted === true || header.removed === true))
      }
    } catch {
      return false
    }
    return true
  }

  /** 给某个 QQ 聊天新建一个 dsh 会话，并记下路由（没有指定 AI 的聊天用）。 */
  async createSessionForPeer(peerKey, record, options = {}) {
    // 先看磁盘上的最新映射：已有就直接用，不重复建（force 时跳过，用于旧会话被删）
    if (options.force !== true) try {
      const disk = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      const existing = disk && disk.peerSessions && disk.peerSessions[peerKey]
      if (typeof existing === 'string' && existing !== '') {
        this.config.peerSessions = { ...(this.config.peerSessions || {}), ...(disk.peerSessions || {}) }
        return existing
      }
    } catch { /* ignore */ }
    const controller = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined
    if (!controller || typeof controller.create !== 'function') throw new Error('宿主没有 sessionController.create，建不了新会话')
    const title = 'QQ：' + (record.senderName || (record.scope === 'group' ? '群聊' : '私聊') + ' ' + String(record.peerId || '').slice(0, 8))
    const input = { title }
    // 给 workspaceId 才会落到对应工作区分组；只给 cwd 会被界面归到「未分组」
    if (this.config.autoSessionWorkspaceId) input.workspaceId = this.config.autoSessionWorkspaceId
    else if (this.config.autoSessionCwd) input.cwd = this.config.autoSessionCwd
    const created = await controller.create(input)
    const sessionId = created && (created.sessionId || created.id || (created.header && created.header.id))
    if (!sessionId) throw new Error('新建会话没有拿到 sessionId')
    // 关键：新会话要先初始化默认模型，否则不会出现在会话列表、也不会真正回复
    try {
      if (typeof controller.initializeDefaultModel === 'function') await controller.initializeDefaultModel(sessionId)
    } catch { /* 模型初始化失败就让后面的 prompt 报错，日志里能看到 */ }
    // 新建的会话自动开启 AI记忆（partner memory 的 per-conversation 开关）
    try {
      if (this.manager && typeof this.manager.setEnabled === 'function') this.manager.setEnabled(sessionId, true)
    } catch { /* 开记忆失败不影响转发 */ }
    this.replacePeerSessions({ ...(this.config.peerSessions || {}), [peerKey]: sessionId })
    this.dbg('auto-session', peerKey, '→', sessionId, 'cwd=' + (this.config.autoSessionCwd || '(默认)'))
    return sessionId
  }

  /** 整份替换「每个 QQ 聊天 → 会话」映射（空字符串表示删掉这条映射）。 */
  replacePeerSessions(map = {}) {
    this.config.peerSessions = { ...map }
    try {
      writeFileSync(this.file, JSON.stringify(this.config, null, 2) + '\n', 'utf8')
    } catch { /* ignore */ }
    return this.config.peerSessions
  }

  /** 这个会话是不是被 QQ 桥接路由的（用来关掉宿主的动态状态注入，避免它被当成新用户消息）。 */
  isRoutedSession(sessionId) {
    const id = String(sessionId || '').trim()
    if (id === '') return false
    const ids = [this.config.sessionId, ...Object.values(this.config.peerSessions || {})].filter(Boolean)
    return ids.includes(id)
  }

  statusSnapshot() {
    return {
      enabled: this.config.enabled,
      sessionId: this.config.sessionId,
      approvalEnabled: this.config.approvalEnabled,
      approvalTimeoutMs: this.config.approvalTimeoutMs,
      lastPeer: this.lastPeer ? { scope: this.lastPeer.scope, peerId: this.lastPeer.peerId } : null,
      peerSessions: { ...(this.config.peerSessions || {}) },
      autoCreateSession: this.config.autoCreateSession !== false,
      autoSessionCwd: this.config.autoSessionCwd || '',
      autoSessionWorkspaceId: this.config.autoSessionWorkspaceId || '',
      ownerOpenId: this.config.ownerOpenId || '',
      pendingApprovals: this.pending.size,
      allowedPeers: Array.isArray(this.config.allowedPeers) ? [...this.config.allowedPeers] : [],
      proactive: {
        enabled: this.config.proactive.enabled === true,
        pending: this.proactiveItems.filter((item) => item.status === 'pending').length,
        sentToday: this.sentToday(),
      },
    }
  }

  // ── AI 主动冒泡 ──────────────────────────────────────────────
  // AI 在聊完之后自己约一个时间（多久都行），到点把它叫醒，现场想内容再发到 QQ。
  // 被动回复窗口（私聊 60 分钟 / 群聊 5 分钟）内走回复通道最稳；窗口外到点改走主动消息通道，
  // 腾讯可能拦（40034105 无权限 / 静默丢弃），成败都记在面板里，不静默吞掉。

  readProactive() {
    try {
      if (!existsSync(this.proactiveFile)) return []
      const parsed = JSON.parse(readFileSync(this.proactiveFile, 'utf8').replace(/^\uFEFF/, ''))
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : [])
      const items = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const statuses = ['pending', 'inflight', 'sent', 'skipped', 'failed']
        const entry = {
          id: String(raw.id || ''),
          sessionId: String(raw.sessionId || ''),
          scope: raw.scope === 'group' ? 'group' : 'c2c',
          peerId: String(raw.peerId || ''),
          note: String(raw.note || '').slice(0, 200),
          dueAt: Number(raw.dueAt) || 0,
          createdAt: Number(raw.createdAt) || 0,
          status: statuses.includes(raw.status) ? raw.status : 'failed',
          reason: String(raw.reason || '').slice(0, 240),
          content: String(raw.content || '').slice(0, 240),
          firedAt: Number(raw.firedAt) || 0,
          doneAt: Number(raw.doneAt) || 0,
          sentAt: Number(raw.sentAt) || 0,
          postponed: Number(raw.postponed) || 0,
        }
        if (entry.id === '' || entry.sessionId === '' || entry.peerId === '' || entry.dueAt <= 0) continue
        // 插件重载时正在发的那条退回待发，下一次 tick 会重新判断（窗口过了就标失败）
        if (entry.status === 'inflight') entry.status = 'pending'
        items.push(entry)
      }
      return items
    } catch {
      return []
    }
  }

  saveProactive() {
    try {
      this.pruneProactive()
      writeFileSync(this.proactiveFile, JSON.stringify({ version: 1, items: this.proactiveItems }, null, 2) + '\n', 'utf8')
    } catch { /* ignore */ }
  }

  pruneProactive() {
    const pending = this.proactiveItems.filter((item) => item.status === 'pending' || item.status === 'inflight')
    const done = this.proactiveItems.filter((item) => item.status !== 'pending' && item.status !== 'inflight')
    pending.sort((a, b) => a.dueAt - b.dueAt)
    done.sort((a, b) => (b.doneAt || b.sentAt || 0) - (a.doneAt || a.sentAt || 0))
    this.proactiveItems = pending.concat(done.slice(0, 40))
    return this.proactiveItems
  }

  sentToday() {
    const today = localDayKey(new Date())
    return this.proactiveItems.filter((item) => item.status === 'sent' && item.sentAt > 0 && localDayKey(new Date(item.sentAt)) === today).length
  }

  /** 这个会话最近在跟哪个 QQ 聊天说话（优先 lastPeerBySession；没有就只在唯一映射时认）。 */
  resolveProactivePeer(sessionId) {
    const last = this.lastPeerBySession.get(sessionId)
    if (last && last.scope && last.peerId) return { scope: last.scope === 'group' ? 'group' : 'c2c', peerId: String(last.peerId) }
    const candidates = Object.entries(this.config.peerSessions || {}).filter(([, value]) => value === sessionId).map(([key]) => key)
    if (candidates.length === 1) {
      const index = candidates[0].indexOf(':')
      if (index > 0) return { scope: candidates[0].slice(0, index) === 'group' ? 'group' : 'c2c', peerId: candidates[0].slice(index + 1) }
    }
    return null
  }

  /** 那个 QQ 聊天最后一次说话的时间 + msg_id（优先内存里的实时映射，回退到 bot.recent）。 */
  lastInboundFor(entry) {
    const mapped = this.lastPeerBySession.get(entry.sessionId)
    if (mapped && mapped.scope === entry.scope && String(mapped.peerId) === String(entry.peerId) && Number.isFinite(mapped.at) && mapped.at > 0) {
      return { msgId: mapped.msgId || '', at: mapped.at }
    }
    try {
      const list = Array.isArray(this.bot && this.bot.recent) ? this.bot.recent : []
      const record = list.find((item) => item && item.scope === entry.scope && String(item.peerId) === String(entry.peerId))
      if (record) {
        const at = Date.parse(record.at)
        if (Number.isFinite(at) && at > 0) return { msgId: record.id || '', at }
      }
    } catch { /* ignore */ }
    return null
  }

  proactiveView(entry) {
    const due = new Date(entry.dueAt)
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      scope: entry.scope,
      peerId: entry.peerId,
      note: entry.note || '',
      dueAt: entry.dueAt,
      dueClock: clockOf(due),
      dueDay: localDayKey(due),
      createdAt: entry.createdAt || 0,
      status: entry.status,
      reason: entry.reason || '',
      content: entry.content || '',
      sentAt: entry.sentAt || 0,
      doneAt: entry.doneAt || 0,
    }
  }

  proactiveSnapshot() {
    const config = this.config.proactive
    const pending = this.proactiveItems
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((item) => this.proactiveView(item))
    const recent = this.proactiveItems
      .filter((item) => item.status !== 'pending')
      .sort((a, b) => (b.doneAt || b.sentAt || 0) - (a.doneAt || a.sentAt || 0))
      .slice(0, 10)
      .map((item) => this.proactiveView(item))
    return {
      enabled: config.enabled === true,
      config: { ...config },
      windows: { c2cMinutes: 60, groupMinutes: 5 },
      pending,
      recent,
      // 上一轮「该定没定」的会话（面板标出来，系统不代定）
      missed: [...this.missedProactive.entries()].map(([sessionId, info]) => ({
        sessionId,
        at: (info && info.at) || 0,
        source: (info && info.source) || '',
      })),
      sentToday: this.sentToday(),
      bridgeEnabled: this.config.enabled === true,
      botConnected: Boolean(this.bot && this.bot.connected),
    }
  }


  /** AI 定一条主动冒泡。delaySeconds 秒后到点；note 是「当时想说什么」的念头，到点会原样交给 AI。 */
  scheduleProactive(input = {}) {
    const config = this.config.proactive
    if (this.config.enabled !== true) throw new Error('QQ 桥接总开关是关的，先到 QQ 面板把「用 QQ 接这个对话」打开')
    if (config.enabled !== true) throw new Error('「AI 主动冒泡」现在是关着的，到 QQ 面板把它打开再定')
    const sessionId = String(input.sessionId || '').trim()
    if (sessionId === '') throw new Error('没识别到当前对话，定不了主动冒泡')
    if (!this.isRoutedSession(sessionId)) throw new Error('这个对话没接 QQ，主动消息只能从接了 QQ 的对话发出去（先在 QQ 面板里把对话接上）')
    const peer = this.resolveProactivePeer(sessionId)
    if (!peer) throw new Error('这个对话接了不止一个 QQ 聊天，分不清要冒泡给谁；等最近那个聊天先说话，或者换单独接一个聊天的对话')
    const seconds = Math.round(Number(input.delaySeconds))
    if (!Number.isFinite(seconds)) throw new Error('delaySeconds 要给一个秒数（比如 300 = 5 分钟，86400 = 一天）')
    const queued = this.enqueueProactive({ sessionId, scope: peer.scope, peerId: peer.peerId, seconds, note: input.note })
    // AI 自己定了 → 之前记的「漏定」清掉
    this.missedProactive.delete(sessionId)
    const label = peer.scope === 'group' ? '群聊' : '私聊'
    return {
      ...this.proactiveView(queued.entry),
      peerLabel: 'QQ ' + label + (queued.peerName !== '' ? '「' + queued.peerName + '」' : '') + '（' + String(peer.peerId).slice(0, 8) + '…）',
      delaySeconds: seconds,
      windowMinutes: queued.windowMs / 60000,
      beyondWindow: queued.entry.dueAt - Date.now() > queued.windowMs - 45000,
    }
  }

  /** 真正排进队列：AI 自己定的、以及用户明说「X 分钟后找我」时替它兜底的，都走这里。 */
  enqueueProactive(input = {}) {
    const config = this.config.proactive
    const sessionId = String(input.sessionId || '').trim()
    const scope = input.scope === 'group' ? 'group' : 'c2c'
    const peerId = String(input.peerId || '')
    if (sessionId === '' || peerId === '') throw new Error('没识别到要发给谁')
    const seconds = Math.round(Number(input.seconds))
    if (!Number.isFinite(seconds)) throw new Error('要给一个秒数')
    if (seconds < config.minSeconds) throw new Error('至少隔 ' + config.minSeconds + ' 秒再冒泡')
    if (seconds > PROACTIVE_MAX_DELAY_SECONDS) throw new Error('太远了：最多约 10 年，再远就别定了')
    const windowMs = scope === 'group' ? PROACTIVE_GROUP_WINDOW_MS : PROACTIVE_C2C_WINDOW_MS
    const wantedAt = Date.now() + seconds * 1000
    const dueAt = nextQuietEnd(wantedAt, config.quietStart, config.quietEnd)
    const quietShift = dueAt - wantedAt
    const pending = this.proactiveItems.filter((item) => item.status === 'pending' && item.sessionId === sessionId)
    if (config.maxPending > 0 && pending.length >= config.maxPending) {
      throw new Error('这个对话已经挂了 ' + pending.length + ' 条主动冒泡（上限 ' + config.maxPending + '），先等到点发掉，或者取消一条')
    }
    const baseReason = String(input.reason || '').trim().slice(0, 200)
    let peerName = ''
    try {
      const found = (this.bot.listPeers(200) || []).find((item) => item.key === scope + ':' + peerId)
      peerName = found && found.name ? String(found.name) : ''
    } catch { /* 拿不到名字就用 openid 前缀 */ }
    const quietReason = quietShift > 0 ? '原定 ' + clockOf(wantedAt) + ' 在静默时段（' + config.quietStart + '~' + config.quietEnd + '），自动挪到 ' + clockOf(dueAt) : ''
    const entry = {
      id: 'pr_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
      sessionId,
      scope,
      peerId,
      note: String(input.note || '').trim().slice(0, 200),
      dueAt,
      createdAt: Date.now(),
      status: 'pending',
      reason: [baseReason, quietReason].filter((part) => part !== '').join('；'),
      content: '',
      firedAt: 0,
      doneAt: 0,
      sentAt: 0,
      postponed: 0,
    }
    this.proactiveItems.push(entry)
    this.saveProactive()
    this.dbg('proactive-scheduled', entry.id, scope + ':' + peerId, clockOf(dueAt), 'note=' + JSON.stringify(entry.note.slice(0, 40)))
    return { entry, peerName, windowMs }
  }

  /** 用户明确说「X 秒/分钟/小时/天后找我」→ 先记下来，等 AI 这轮回完再核对它到底定没定。 */
  noteTimedRequest(record, sessionId) {
    this.timedRequest = null
    const parsed = parseTimedRequest(record && record.content)
    if (!parsed) return
    if (parsed.seconds < this.config.proactive.minSeconds) return
    if (parsed.seconds > PROACTIVE_MAX_DELAY_SECONDS) return
    this.timedRequest = {
      sessionId,
      scope: record.scope === 'group' ? 'group' : 'c2c',
      peerId: String(record.peerId || ''),
      msgId: record.id || '',
      seconds: parsed.seconds,
      phrase: parsed.phrase,
      at: Date.now(),
    }
    this.dbg('timed-request', String(parsed.seconds) + 's', parsed.phrase.slice(0, 40))
  }

  /** 这一轮 AI 回完了：它只在嘴上答应、没真的调用 proactive 时，替它把定时补上（不然用户以为定了，其实什么都不会发）。 */
  maybeFallbackTimedRequest(sessionId) {
    const request = this.timedRequest
    if (!request || request.sessionId !== sessionId) return
    this.timedRequest = null
    if (Date.now() - request.at > 5 * 60000) return
    const config = this.config.proactive
    if (this.config.enabled !== true || config.enabled !== true) return
    const created = this.proactiveItems.some((item) => item.sessionId === request.sessionId && Number(item.createdAt || 0) >= request.at - 500)
    if (created) {
      this.dbg('timed-request-ai-ok', request.sessionId.slice(-8))
      return
    }
    try {
      const queued = this.enqueueProactive({
        sessionId: request.sessionId,
        scope: request.scope,
        peerId: request.peerId,
        seconds: request.seconds,
        note: '用户说「' + request.phrase + '」，到点了，主动找 TA 说一句。',
        reason: '系统兜底：用户说「' + request.phrase + '」，AI 没真的定时',
      })
      this.dbg('timed-request-fallback', queued.entry.id, clockOf(queued.entry.dueAt))
    } catch (error) {
      this.dbg('timed-request-fallback-fail', String((error && error.message) || error).slice(0, 120))
    }
  }

  /**
   * 「每轮都由 AI 自己定」：系统不再按默认间隔替它排时间（2026-11-03 用户要求）。
   * 这一轮 AI 发了正文却没留 pending，就记一笔——下一轮提示词和面板会提醒它补；
   * 这里只记状态，绝不代排、绝不代选时间。
   */
  noteProactiveMissed(sessionId, options = {}) {
    const inbound = this.turnInbound.get(sessionId)
    this.turnInbound.delete(sessionId)
    this.proactiveTurns.delete(sessionId)
    // 这一轮没有任何正文（比如只调了工具/被吞掉）就没什么「发完」可言
    if (options.hadText !== true) return false
    // 后台/面板注入的假消息（自测）不参与
    if (options.syntheticTurn === true) {
      this.dbg('proactive-missed-synthetic', sessionId.slice(-8))
      return false
    }
    // TA 明确说了别打扰 / 别发：这一轮不算漏（GUI 聊天没有 inbound 时，看最近 10 分钟内的真实 QQ 消息）
    const quietText = inbound
      ? inbound.text
      : (() => { const last = this.lastInboundText.get(sessionId); return last && Date.now() - last.at <= 10 * 60 * 1000 ? last.text : '' })()
    if (looksLikeQuietRequest(quietText)) {
      this.dbg('proactive-missed-quiet', sessionId.slice(-8))
      return false
    }
    return this.markProactiveMissed(sessionId, 'turn-end')
  }

  /** 记一笔「该定没定」。返回是否真的记上了（没接 QQ / 群聊 / 已经挂着下一条都不记）。 */
  markProactiveMissed(sessionId, source = '') {
    if (this.config.enabled !== true) return false
    if (this.config.proactive.enabled !== true) return false
    if (!this.isRoutedSession(sessionId)) return false
    let peer = null
    try { peer = this.resolveProactivePeer(sessionId) } catch { peer = null }
    // 群聊的主动消息腾讯不给权限（超过 5 分钟窗口必失败），只在私聊里要求每轮都定
    if (!peer || peer.scope !== 'c2c') return false
    const pending = this.proactiveItems.some((item) => item.sessionId === sessionId && item.status === 'pending')
    if (pending) {
      this.missedProactive.delete(sessionId)
      return false
    }
    this.missedProactive.set(sessionId, { at: Date.now(), source: String(source || '') })
    this.dbg('proactive-missed', sessionId.slice(-8), String(source || ''))
    return true
  }

  /** 这个会话上一轮有没有「该定没定」（提示词 / 面板用）。 */
  proactiveMissedFor(sessionId) {
    const hit = this.missedProactive.get(String(sessionId || ''))
    return hit ? { at: hit.at, source: hit.source } : null
  }

  /** turn_end 回执里给 AI 的一句提醒：这一轮到底定没定（系统只核对、不代定）。 */
  proactiveTurnHint(sessionId) {
    if (!sessionId || this.config.enabled !== true) return ''
    if (this.config.proactive.enabled !== true) return ''
    if (!this.isRoutedSession(sessionId)) return ''
    // 后台/面板的测试注入不催：免得一次自测顺手给真人排一条真冒泡
    if (this.syntheticTurns && this.syntheticTurns.has(sessionId)) return ''
    let peer = null
    try { peer = this.resolveProactivePeer(sessionId) } catch { peer = null }
    if (!peer || peer.scope !== 'c2c') return ''
    const pending = this.proactiveItems.some((item) => item.sessionId === sessionId && item.status === 'pending')
    if (pending) {
      this.missedProactive.delete(sessionId)
      return ''
    }
    return '⚠️ 本轮还没定下一次主动冒泡：回复前先调用 companion_memory({action:"proactive", op:"schedule", delaySeconds:秒数, note:"到点想说什么"})，隔多久由你自己判断。系统不会替你定时间——没定就一条都不会有；TA 明确说「别打扰 / 别发」才跳过。'
  }

  listProactive(sessionId = '') {
    const mine = sessionId !== '' ? this.proactiveItems.filter((item) => item.sessionId === sessionId) : this.proactiveItems
    return {
      pending: mine.filter((item) => item.status === 'pending').sort((a, b) => a.dueAt - b.dueAt).map((item) => this.proactiveView(item)),
      recent: mine.filter((item) => item.status !== 'pending').sort((a, b) => (b.doneAt || b.sentAt || 0) - (a.doneAt || a.sentAt || 0)).slice(0, 5).map((item) => this.proactiveView(item)),
    }
  }

  /** TA 一说话，之前挂着的冒泡时间就不算了：全部作废，等 AI 重新判断要不要再定。 */
  cancelPendingForInbound(sessionId) {
    let canceled = 0
    for (const entry of this.proactiveItems) {
      if (entry.status !== 'pending' || entry.sessionId !== sessionId) continue
      entry.status = 'skipped'
      entry.reason = 'TA 说话了，原来定的时间作废，等 AI 重新定'
      entry.doneAt = Date.now()
      canceled += 1
    }
    if (canceled > 0) {
      this.saveProactive()
      this.dbg('proactive-cancel-inbound', sessionId.slice(-8), String(canceled))
    }
    return canceled
  }

  /** 冒泡到点、已经叫醒会话（active），TA 这时又说话了：这条标记成没发，回复走正常聊天。 */
  supersedeInflightProactive(sessionId, synthetic) {
    if (synthetic) return false
    const inflight = this.proactiveSends.get(sessionId)
    if (!inflight || inflight.active !== true) return false
    this.completeProactive(inflight, 'skipped', [], 'TA 先说话了，这条不发了')
    this.dbg('proactive-superseded', String(sessionId).slice(-8))
    return true
  }

  cancelProactive(input = {}) {
    const id = String(input.id || '')
    const sessionId = String(input.sessionId || '')
    const all = input.all === true
    let canceled = 0
    for (const entry of this.proactiveItems) {
      if (entry.status !== 'pending' && entry.status !== 'inflight') continue
      if (id !== '' && entry.id !== id) continue
      if (id === '' && sessionId !== '' && entry.sessionId !== sessionId) continue
      if (id === '' && sessionId === '' && !all) continue
      entry.status = 'skipped'
      entry.reason = '手动取消'
      entry.doneAt = Date.now()
      const pending = this.proactiveSends.get(entry.sessionId)
      if (pending && pending.id === entry.id) {
        if (pending.timer) clearTimeout(pending.timer)
        this.proactiveSends.delete(entry.sessionId)
      }
      canceled += 1
    }
    if (canceled > 0) this.saveProactive()
    return { canceled, pending: this.proactiveSnapshot().pending }
  }

  startProactiveTicker() {
    if (this.proactiveTimer) return
    this.proactiveTimer = setInterval(() => { this.runDueProactive().catch(() => {}) }, PROACTIVE_TICK_MS)
    if (typeof this.proactiveTimer.unref === 'function') this.proactiveTimer.unref()
    const kick = setTimeout(() => { this.runDueProactive().catch(() => {}) }, 5000)
    if (typeof kick.unref === 'function') kick.unref()
  }

  stopProactiveTicker() {
    if (this.proactiveTimer) { clearInterval(this.proactiveTimer); this.proactiveTimer = null }
    for (const pending of this.proactiveSends.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.proactiveSends.clear()
  }

  async runDueProactive(now = Date.now()) {
    if (this.proactiveBusy) return
    const config = this.config.proactive
    if (this.config.enabled !== true || config.enabled !== true) return
    if (!this.bot || this.bot.connected !== true) return
    this.proactiveBusy = true
    try {
      for (const entry of this.proactiveItems.slice()) {
        if (entry.status !== 'pending') continue
        if (entry.dueAt > now) continue
        if (this.proactiveSends.has(entry.sessionId)) continue
        if (config.dailyLimit > 0 && this.sentToday() >= config.dailyLimit) {
          entry.status = 'failed'
          entry.reason = '今天主动冒泡已经到上限（' + config.dailyLimit + ' 次）了'
          entry.doneAt = now
          this.dbg('proactive-daily-limit', entry.id)
          continue
        }
        if (inQuietHours(new Date(entry.dueAt), config.quietStart, config.quietEnd)) {
          const shifted = nextQuietEnd(entry.dueAt, config.quietStart, config.quietEnd)
          entry.dueAt = shifted
          entry.reason = '到点落在静默时段，自动挪到 ' + clockOf(new Date(shifted))
          this.dbg('proactive-quiet', entry.id, '→ ' + clockOf(new Date(shifted)))
          continue
        }
        await this.fireProactive(entry)
      }
      this.saveProactive()
    } finally {
      this.proactiveBusy = false
    }
  }

  async fireProactive(entry) {
    const now = Date.now()
    const windowMs = entry.scope === 'group' ? PROACTIVE_GROUP_WINDOW_MS : PROACTIVE_C2C_WINDOW_MS
    const label = entry.scope === 'group' ? '群聊' : '私聊'
    const last = this.lastInboundFor(entry)
    // 到点时还在被动回复窗口里 → 走「回复最后那条消息」；窗口外 → msgId 留空，改成主动消息发。
    const inWindow = Boolean(last && last.at > 0 && now - last.at <= windowMs - 5000)
    // 对方刚说过话：别冒泡，往后挪两次，挪不动就作废（免得正聊着突然插一条）
    if (inWindow && now - last.at < 120000) {
      const postponed = Number(entry.postponed) || 0
      if (postponed < 2) {
        entry.postponed = postponed + 1
        entry.dueAt = now + 120000
        entry.reason = '对方刚说过话，冒泡往后挪了 2 分钟'
        this.dbg('proactive-postpone', entry.id)
        return
      }
    }
    if (!this.isRoutedSession(entry.sessionId)) {
      entry.status = 'failed'
      entry.reason = '这个对话已经不接 QQ 了'
      entry.doneAt = now
      return
    }
    if (this.proactiveSends.has(entry.sessionId)) return
    const pending = {
      id: entry.id,
      sessionId: entry.sessionId,
      peer: { scope: entry.scope, peerId: entry.peerId, msgId: inWindow ? (last.msgId || '') : '', at: last ? last.at : 0 },
      active: false,
      timer: null,
    }
    this.proactiveSends.set(entry.sessionId, pending)
    entry.status = 'inflight'
    entry.firedAt = now
    this.saveProactive()
    pending.timer = setTimeout(() => {
      if (this.proactiveSends.get(entry.sessionId) !== pending) return
      this.proactiveSends.delete(entry.sessionId)
      entry.status = 'failed'
      entry.reason = '到点了，但会话没有回话（可能正在忙），这条作废'
      entry.doneAt = Date.now()
      this.saveProactive()
      this.dbg('proactive-timeout', entry.id)
    }, 180000)
    if (typeof pending.timer.unref === 'function') pending.timer.unref()
    const promptLines = [
      PROACTIVE_PROMPT_MARK + '现在是 ' + clockOf(now) + (last ? '，离 TA 上一次在 QQ 说话过去了' + humanGap(now - last.at) + '。' : '。'),
      entry.note !== '' ? '你当时留下的念头：' + entry.note : '',
      '想主动跟 TA 说一句就正常回复（1~3 句，像平时发 QQ 那样）；不想说就只回「不发」，这条就不发了。',
      '这条是' + label + (inWindow ? '，会直接发到 QQ ' + label : '，TA 已经很久没说话了，会用主动消息发到 QQ ' + label + '（腾讯可能拦，发不出去也正常）') + '；别提到这条提醒本身，也别解释是定时任务。',
    ].filter((line) => line !== '')
    try {
      await this.injectToSession(entry.sessionId, promptLines.join('\n'))
      this.dbg('proactive-fired', entry.id, label, 'gap=' + (last ? Math.round((now - last.at) / 60000) + 'min' : 'none'), 'inWindow=' + inWindow)
    } catch (error) {
      if (pending.timer) clearTimeout(pending.timer)
      this.proactiveSends.delete(entry.sessionId)
      entry.status = 'failed'
      entry.reason = '到点了，但没能叫醒会话：' + String((error && error.message) || error).slice(0, 120)
      entry.doneAt = Date.now()
      this.saveProactive()
      this.dbg('proactive-inject-fail', entry.id, entry.reason)
    }
  }

  completeProactive(pending, status, lines, reason = '') {
    if (!pending) return
    if (pending.timer) { clearTimeout(pending.timer); pending.timer = null }
    if (this.proactiveSends.get(pending.sessionId) === pending) this.proactiveSends.delete(pending.sessionId)
    const entry = this.proactiveItems.find((item) => item.id === pending.id)
    if (!entry) return
    const now = Date.now()
    entry.status = status
    entry.doneAt = now
    if (status === 'sent') {
      entry.sentAt = now
      entry.content = lines.join(' / ').slice(0, 240)
    }
    if (reason !== '') entry.reason = String(reason).slice(0, 240)
    this.saveProactive()
    this.dbg('proactive-done', entry.id, status, reason.slice(0, 100), lines.join(' / ').slice(0, 80))
    // 这条主动冒泡真的发出去了：下一条也要 AI 自己定；没定就记一笔，下一轮提醒它补（系统不代定）
    if (status === 'sent') this.markProactiveMissed(entry.sessionId, 'bubble-sent')
  }

  start() {
    if (this.started) return
    this.started = true
    const offMessage = this.bot.onEvent((event) => {
      if (!event) return
      if (event.type === 'message') this.handleInbound(event.message).catch(() => {})
      if (event.type === 'interaction') this.handleInteraction(event).catch(() => {})
    })
    this.disposers.push(offMessage)
    if (typeof this.ctx.on === 'function') {
      const offEvent = this.ctx.on('session/event', (session, event) => {
        this.handleOutbound(session, event)
      })
      if (typeof offEvent === 'function') this.disposers.push(offEvent)
      const offApproval = this.ctx.on('approval/request', (request, next) => this.handleApproval(request, next), { prepend: true })
      if (typeof offApproval === 'function') this.disposers.push(offApproval)
      const offQuestion = this.ctx.on('user-questions/request', (request, next) => this.handleQuestion(request, next), { prepend: true })
      if (typeof offQuestion === 'function') this.disposers.push(offQuestion)
    }
    this.startProactiveTicker()
  }

  stop() {
    try { this.flushReply() } catch { /* ignore */ }
    this.stopProactiveTicker()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
    for (const [, pending] of this.pending) {
      try {
        clearTimeout(pending.timer)
        pending.resolve('cancelled')
      } catch {
        // ignore
      }
    }
    this.pending.clear()
    for (const [, q] of this.questions) {
      try {
        clearTimeout(q.timer)
        q.resolve([])
      } catch {
        // ignore
      }
    }
    this.questions.clear()
    this.started = false
  }

  /** 往配置的 dsh 会话塞一条用户消息。 */
  async injectToSession(sessionId, text) {
    const controller = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined
    if (!controller || typeof controller.prompt !== 'function') throw new Error('宿主没有 sessionController.prompt()，无法把消息送进会话')
    const requestId = 'qq-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 6)
    await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(20000))
  }

  async handleInbound(record) {
    if (!record) return
    // 后台/面板注入的假消息（synthetic）：只走「塞给 AI + 回一条」的链路，
    // 不改人物档案、不切说话人、不作废主动冒泡 —— 否则一次自测就会把真人的昵称改掉（2026-11-02 事故）
    const synthetic = record.synthetic === true
    this.lastPeer = { scope: record.scope, peerId: record.peerId, msgId: record.id, at: Date.now() }
    let text = String(record.content || '')
    // 待答提问的文字回答优先
    const answered = this.parseQuestionText(text)
    if (answered) {
      this.settleQuestion(answered.token, answered.selected, answered.custom || '')
      await this.reply(record, '✅ 已记录回答')
      return
    }
    // 审批文字命令
    const parsed = parseApprovalText(text)
    if (parsed) {
      const pending = this.pending.get(parsed.code)
      if (pending && !pending.settled) {
        pending.settled = true
        clearTimeout(pending.timer)
        this.pending.delete(parsed.code)
        pending.resolve(parsed.outcome)
        await this.reply(record, (parsed.outcome === 'allowed-once' ? '✅ 已允许' : '❌ 已拒绝') + '（' + parsed.code + '）')
        return
      }
      await this.reply(record, '没有这个验证码，或已经过期：' + parsed.code)
      return
    }
    const peerKey = record.scope + ':' + record.peerId
    this.dbg('inbound', peerKey, 'text=' + JSON.stringify(text.slice(0, 60)), 'voices=' + (Array.isArray(record.voicePaths) ? record.voicePaths.length : 0), 'images=' + (Array.isArray(record.imagePaths) ? record.imagePaths.length : 0), 'enabled=' + this.config.enabled, 'session=' + this.config.sessionId)
    if (Array.isArray(this.config.allowedPeers) && this.config.allowedPeers.length > 0 && !this.config.allowedPeers.includes(peerKey)) return
    // 声纹命令：/声纹 登记 [名字] / 列表 / 删除 名字 / 开 / 关 / 阈值 0.65
    if (/^\/声纹(\s|$)/.test(text.trim())) {
      await this.handleVoiceprintCommand(record, text.trim())
      return
    }
    // 默认 = 新建：没单独指定会话的聊天，先自动新建一个专属会话；关掉自动新建时才退回默认会话
    let routeSession = (this.config.peerSessions && this.config.peerSessions[peerKey]) || ''
    if (this.config.enabled && routeSession === '' && this.config.autoCreateSession !== false) {
      try {
        routeSession = await this.createSessionForPeer(peerKey, record)
      } catch (error) {
        this.bot.lastError = '自动新建会话失败：' + String(error && error.message ? error.message : error).slice(0, 160)
      }
    }
    // 映射里的会话被用户删了：清掉映射，按「默认=新建」重新建一个
    if (this.config.enabled && routeSession !== '' && this.config.autoCreateSession !== false) {
      const exists = await this.sessionExists(routeSession)
      if (!exists) {
        this.dbg('session-missing', routeSession, '→ 重建')
        const remaining = { ...(this.config.peerSessions || {}) }
        delete remaining[peerKey]
        this.replacePeerSessions(remaining)
        try {
          routeSession = await this.createSessionForPeer(peerKey, record, { force: true })
        } catch (error) {
          this.bot.lastError = '原会话不存在，自动重建失败：' + String(error && error.message ? error.message : error).slice(0, 160)
          routeSession = ''
        }
      }
    }
    if (!this.config.enabled || routeSession === '') return
    this.lastPeerBySession.set(routeSession, { scope: record.scope, peerId: record.peerId, msgId: record.id, at: Date.now() })
    if (!synthetic) {
      this.turnInbound.set(routeSession, { scope: record.scope, peerId: String(record.peerId || ''), text: String(text || ''), at: Date.now() })
      this.lastInboundText.set(routeSession, { text: String(text || ''), at: Date.now() })
      this.noteTimedRequest(record, routeSession)
    } else {
      this.syntheticTurns.add(routeSession)
    }
    // 冒泡已经叫醒会话（inflight）时 TA 又说话了：这条不发了，别让 TA 这轮回复被记到冒泡头上
    // 测试注入的假消息不算「TA 说话」，不动真实排队中的冒泡
    this.supersedeInflightProactive(routeSession, synthetic)
    // TA 又说话了：之前挂着的冒泡时间作废，等 AI 在回复时重新判断要不要再定（用户定的规则）
    // 测试注入的假消息不算「TA 说话」，不动真实排队中的冒泡
    const bouncedProactive = synthetic ? 0 : this.cancelPendingForInbound(routeSession)
    const who = record.scope === 'group' ? '群聊' : '私聊'
    const senderId = String(record.senderId || '')
    const unionId = String(record.unionOpenid || '')
    // 认人/显示都以「跨群、跨私聊统一的 ID」为准：QQ 给了 union_openid 就用它，否则用事件里的稳定 ID。
    // 同一个人在不同群 / 私聊里 ID 不一致时，靠人物档案里的别名把新 ID 认回同一条档案。
    const identityId = unionId !== '' ? unionId : senderId
    let name = record.senderName || identityId.slice(0, 12) || '某人'
    if (synthetic) {
      // 假消息只用一个中性的「测试」标签，绝不 upsert 人物档案
      name = record.senderName || '测试'
    } else {
      try {
        if (identityId !== '' && this.manager && typeof this.manager.people === 'function') {
          const registry = this.manager.people()
          const ids = [unionId, senderId].filter((id) => id !== '')
          const known = typeof registry.resolve === 'function' ? registry.resolve('qq', ids) : null
          const canonicalId = known && known.externalId ? known.externalId : identityId
          const seen = registry.upsert({ platform: 'qq', externalId: canonicalId, name: record.senderName || '', aliases: ids })
          const current = seen && seen.person ? String(seen.person.currentName || '') : ''
          if (current !== '') name = current
        }
        // 私聊事件通常不带昵称：先退回这个聊天的显示名，最后才用 ID 前缀（别让人看着像一个新账号）
        if (identityId !== '' && name === identityId.slice(0, 12)) {
          try {
            const peer = (this.bot.listPeers(200) || []).find((item) => item.key === peerKey)
            if (peer && peer.name && peer.name !== identityId.slice(0, 12)) name = peer.name
          } catch { /* 拿不到聊天显示名就用 ID 前缀 */ }
        }
      } catch { /* 档案失败就用原来的名字 */ }
    }
    const extras = []
    const imagePaths = Array.isArray(record.imagePaths) ? record.imagePaths : []
    if (Number(record.imageCount) > 0 || imagePaths.length > 0) {
      extras.push('（发来 ' + Math.max(Number(record.imageCount) || 0, imagePaths.length) + ' 张图片）')
      for (const path of imagePaths) extras.push('[图片本地文件：' + path + ']')
      if (imagePaths.length > 0) {
        extras.push('（先看一眼再决定：只有真正的表情包/梗图才收进表情包库——companion_memory({action:"sticker", op:"add", path:"…", caption:"这图是什么、发它代表什么"}）；caption 是必须写的含义备注，存进库里以后你发它才知道意味着什么。普通照片、截图、文档图、别人的自拍不要收，也别当表情包发出去）')
      }
    }
    // 语音：SILK → WAV → 声纹比对（本地 CAM++）+ 宿主本地 SenseVoice 转写；失败都带上原因，别静默丢
    const voicePaths = Array.isArray(record.voicePaths) ? record.voicePaths : []
    for (const [voiceIndex, path] of voicePaths.entries()) {
      let wavBuffer = null
      let voiceMs = 0
      let timbreInfo = null
      let spokenText = ''
      const voiceNotes = []
      try {
        const { readFileSync } = await import('node:fs')
        const bytes = readFileSync(path)
        if (String(path).toLowerCase().endsWith('.wav')) {
          wavBuffer = bytes
          voiceMs = Math.round((bytes.length - 44) / 32)
        } else {
          const decoded = await this.bot.silkToWav(bytes)
          wavBuffer = decoded.wav
          voiceMs = decoded.ms
        }
        this.dbg('voice-decoded', path, 'bytes=' + wavBuffer.length, 'ms=' + voiceMs)
        if (voiceIndex === 0) {
          try {
            const vpModule = this.bot.voiceprint
            timbreInfo = vpModule && typeof vpModule.analyzeTimbre === 'function' ? vpModule.analyzeTimbre(wavBuffer) : null
          } catch {
            timbreInfo = null
          }
        }
      } catch (error) {
        this.dbg('voice-decode-fail', path, String(error && error.message ? error.message : error).slice(0, 160))
        extras.push('（发来语音，解码失败：' + String(error && error.message ? error.message : error).slice(0, 80) + '）')
        continue
      }
      // 声纹：私聊自动建档/收录；群聊里只处理「勾选过的人」的声音
      try {
        const vp = this.bot.voiceprint
        if (vp && vp.enabled() && voiceIndex === 0) {
          const isGroup = record.scope === 'group'
          const senderOpenid = String(record.senderId || '')
          const allowedMembers = Array.isArray(vp.config.allowedMembers) ? vp.config.allowedMembers : []
          const groupAllowed = !isGroup || (allowedMembers.length > 0 && allowedMembers.includes(senderOpenid))
          if (groupAllowed) {
            const status = vp.status()
            // 私聊且还没建档 → 自动开始录「我」的声纹（不用先发命令）
            if (!isGroup && !this.pendingVoiceprint && status.namesCount === 0) {
              this.pendingVoiceprint = { name: '我', peerKey, at: Date.now(), remaining: 3 }
            }
            const pending = this.pendingVoiceprint
            if (!isGroup && pending && pending.peerKey === peerKey && Date.now() - pending.at < 10 * 60 * 1000) {
              const saved = vp.register(pending.name, wavBuffer)
              const remaining = Math.max(0, Number(pending.remaining) - 1)
              if (remaining > 0) {
                this.pendingVoiceprint = { ...pending, remaining, at: Date.now() }
                voiceNotes.push('声纹样本 ' + (3 - remaining) + '/3')
                await this.reply(record, '收到第 ' + (3 - remaining) + ' 条样本，再发 ' + remaining + ' 条。')
              } else {
                this.pendingVoiceprint = null
                voiceNotes.push('声纹录好了')
                await this.reply(record, '✅ 录好了，3 条样本都收下了。以后你一说话我就能认出你。')
              }
            } else {
              const found = vp.identify(wavBuffer)
              this.dbg('voiceprint', JSON.stringify(found).slice(0, 200))
              if (timbreInfo && timbreInfo.ok && found.name) {
                try { vp.noteTimbre(found.name, timbreInfo) } catch { /* 记不上就算了 */ }
              }
              const profileSeconds = vp.totalSeconds(found.name)
              const collectThreshold = profileSeconds < vp.config.freeEnrollSeconds
                ? 0
                : (profileSeconds >= vp.config.maxSeconds ? vp.config.autoCollectAboveWhenFull : vp.config.autoCollectAbove)
              if (!found.empty && found.score >= collectThreshold) {
                const collected = vp.addSample(found.name, found.embedding, { seconds: (Number(voiceMs) || 0) / 1000 })
                if (collected.added) voiceNotes.push('声纹已收录')
              }
              if (found.empty) voiceNotes.push('声纹没建档')
              else if (found.matched || (status.namesCount === 1 && found.score >= 0.45)) voiceNotes.push('声纹本人 ' + found.score.toFixed(2))
              else voiceNotes.push('声纹最像 ' + found.name + '（' + found.score.toFixed(2) + '）')
            }
          }
        }
      } catch (error) {
        extras.push('（声纹比对失败：' + String(error && error.message ? error.message : error).slice(0, 80) + '）')
      }
      // 转写
      try {
        const stt = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('speechToText') : undefined
        if (!stt || typeof stt.resolve !== 'function') throw new Error('宿主没有 speechToText 服务')
        const spec = stt.resolve({ audio: wavBuffer, language: 'auto' })
        const result = await stt.transcribe(spec, AbortSignal.timeout(90000))
        const speech = result && typeof result.text === 'string' ? result.text.trim() : ''
        spokenText = speech
        this.dbg('stt', 'text=' + JSON.stringify(speech), 'audioSeconds=' + (result && result.audioSeconds))

      } catch (error) {
        voiceNotes.push('转写失败')
      }
      if (timbreInfo && timbreInfo.ok) {
        const seconds = Math.max(0.2, (Number(voiceMs) || 0) / 1000)
        const speedLabel = spokenText !== '' ? describeSpeed(spokenText.length / seconds) : ''
        const pieces = [timbreInfo.pitchLabel, timbreInfo.loudLabel, timbreInfo.brightLabel]
        if (speedLabel !== '') pieces.push('语速' + speedLabel)
        voiceNotes.push('音色 ' + pieces.join('·'))
      }
      if (voiceIndex === 0 && wavBuffer) {
        const voiceSeconds = Math.round((Number(voiceMs) || 0) / 1000)
        const noteText = voiceNotes.length > 0 ? voiceNotes.join('｜') : ''
        const head = '【语音 ' + voiceSeconds + ' 秒' + (noteText !== '' ? '｜' + noteText : '') + '】'
        extras.push(head + (spokenText !== '' ? spokenText : '（没听清，转写为空）'))
      }
    }
    const body = '【QQ ' + who + '｜' + name + (identityId !== '' ? '｜ID ' + identityId.slice(0, 10) : '') + '】' + (text.trim() === '' ? '' : text) + (extras.length ? ' ' + extras.join(' ') : '')
      + (extras.some((line) => line.startsWith('[图片本地文件')) ? '（看完图如果值得记，再用记忆工具选择性记下描述，别全存）' : '')
      + (bouncedProactive > 0 ? '（提示：你之前定的主动冒泡因为 TA 又说话了已经作废；按默认规则，这一轮还是要重新定一条，隔多久你自己判断。TA 明确说「别打扰 / 别发」时才不定）' : '')
    if (text.trim() === '' && extras.length === 0) {
      // 群里纯 @（QQ 把 @ 后面的文字剥掉后可能只剩空格）：当成「在叫你」，让 AI 回应
      if (record.scope === 'group') {
        this.dbg('empty-group-ping', peerKey)
        text = '（在群里 @ 了你，但没带文字——当他在叫你）'
      } else {
        this.dbg('empty-skip', peerKey)
        return
      }
    }
    // 说话人：选了「我的账号（用户）」之后，本人算 default 用户，其他人各自独立成一个说话人
    // （测试注入的假消息不改说话人）
    if (!synthetic) try {
      const owner = String(this.config.ownerOpenId || '').trim()
      const store = this.manager && this.config.enabled ? this.manager.storeFor(routeSession) : null
      if (store && typeof store.switchSpeaker === 'function' && owner !== '') {
        // 本人的判断也接受「别名」：不同群/私聊 openid 不一致时，靠人物档案里登记的别名认回本人
        let ownerIds = [owner]
        try {
          const person = this.manager.people && typeof this.manager.people === 'function' ? this.manager.people().get('qq', owner) : null
          if (person) ownerIds = [person.externalId, ...(Array.isArray(person.aliases) ? person.aliases : [])].filter(Boolean)
        } catch { /* 档案读不到就只按主 ID 认 */ }
        if (identityId !== '' && ownerIds.includes(identityId)) store.switchSpeaker('default')
        else store.switchSpeaker(name, { externalId: identityId, platform: 'qq', create: true })
      }
    } catch (error) {
      this.dbg('speaker-switch-fail', String(error && error.message ? error.message : error).slice(0, 160))
    }
    this.dbg('inject', 'session=' + routeSession, 'body=' + JSON.stringify(body.slice(0, 260)))
    try {
      await this.injectToSession(routeSession, body)
      this.dbg('inject-ok')
    } catch (error) {
      this.dbg('inject-fail', String(error && error.message ? error.message : error).slice(0, 200))
      // 兜底：会话已经不存在（被删）→ 重建一个并重试一次
      let retried = false
      if (this.config.autoCreateSession !== false) {
        const exists = await this.sessionExists(routeSession)
        if (!exists) {
          try {
            const rebuilt = await this.createSessionForPeer(peerKey, record, { force: true })
            this.lastPeerBySession.set(rebuilt, { scope: record.scope, peerId: record.peerId, msgId: record.id, at: Date.now() })
            await this.injectToSession(rebuilt, body)
            routeSession = rebuilt
            retried = true
            this.dbg('inject-retry-ok', rebuilt)
          } catch (retryError) {
            this.dbg('inject-retry-fail', String(retryError && retryError.message ? retryError.message : retryError).slice(0, 200))
          }
        }
      }
      if (!retried) this.bot.lastError = '转发到 AI 会话失败：' + String(error && error.message ? error.message : error)
    }
  }

  /** QQ 里 /声纹 系列命令：登记、列表、删除、开关、阈值。 */
  async handleVoiceprintCommand(record, rawText) {
    const peerKey = record.scope + ':' + record.peerId
    const parts = rawText.replace(/^\/声纹\s*/, '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] || ''
    const saveVp = (patch) => this.bot.saveConfig({ voiceprint: patch })
    const describe = () => {
      const cur = this.bot.voiceprint
      if (!cur) return '声纹模块没加载'
      const st = cur.status()
      const list = st.profiles.length === 0 ? '还没建档' : st.profiles.map((item) => item.name + '（' + item.samples + ' 条）').join('、')
      return '声纹' + (st.enabled ? '开着' : '关着') + '｜阈值 ' + st.threshold + '｜' + list
    }
    if (sub === '登记' || sub === '注册' || sub === '绑定') {
      const cur = this.bot.voiceprint
      if (!cur || !cur.status().enabled) { await this.reply(record, '声纹功能没开，先发 /声纹 开'); return }
      const name = parts.slice(1).join(' ') || '我'
      this.pendingVoiceprint = { name, peerKey, at: Date.now(), remaining: 3 }
      await this.reply(record, '好，那咱们重录「' + name + '」的声纹：连发 3 条语音，每条 3~5 秒，正常说话就行（不用念口令）。')
      return
    }
    if (sub === '列表' || sub === 'list') { await this.reply(record, describe()); return }
    if (sub === '删除' || sub === '移除' || sub === '删') {
      const name = parts.slice(1).join(' ')
      if (name === '') { await this.reply(record, '要删谁？发 /声纹 删除 名字'); return }
      const removed = this.bot.voiceprint ? this.bot.voiceprint.remove(name) : false
      await this.reply(record, removed ? '删掉了：' + name : '没有这个人的声纹：' + name)
      return
    }
    if (sub === '开') { await saveVp({ enabled: true }); await this.reply(record, '声纹开了。' + describe()); return }
    if (sub === '关') { await saveVp({ enabled: false }); await this.reply(record, '声纹关了。'); return }
    if (sub === '阈值') {
      const value = Number(parts[1])
      if (!Number.isFinite(value) || value < 0.3 || value > 0.99) { await this.reply(record, '阈值要 0.3~0.99，比如 /声纹 阈值 0.65'); return }
      await saveVp({ threshold: value })
      await this.reply(record, '阈值改成 ' + value + '（越高越严）。')
      return
    }
    await this.reply(record, '声纹命令：/声纹 登记 [名字]、/声纹 列表、/声纹 删除 名字、/声纹 阈值 0.65、/声纹 开、/声纹 关')
  }

  /** 取 user/message 事件里的文本（runtime-context 注入也是一条 user 消息）。 */
  userEventText(event) {
    const content = event && event.data && event.data.content
    if (!Array.isArray(content)) return ''
    return content.filter((block) => block && block.type === 'text').map((block) => String(block.text || '')).join('\n')
  }

  /** 发不出去的消息先存着，等下一条 QQ 消息来了用新的被动回复额度补发。 */
  queueOutbox(peer, content) {
    try {
      if (!peer || !peer.scope || !peer.peerId) return
      const entry = { scope: peer.scope, peerId: String(peer.peerId), content: String(content).slice(0, 1500), at: new Date().toISOString() }
      appendFileSync(this.outboxFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch { /* ignore */ }
  }

  /** 把发给这个 peer 的积压消息尽量补发（最多 2 条，用当前这条消息的被动额度）。 */
  async drainOutbox(peer) {
    if (!peer || !peer.scope || !peer.peerId || !peer.msgId) return
    try {
      if (!existsSync(this.outboxFile)) return
      const lines = readFileSync(this.outboxFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
      if (lines.length === 0) return
      const keep = []
      let sent = 0
      for (const line of lines) {
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (!entry || entry.scope !== peer.scope || String(entry.peerId) !== String(peer.peerId)) { keep.push(line); continue }
        if (sent >= 2) { keep.push(line); continue }
        try {
          await this.bot.sendTextWithQuote({ scope: peer.scope, targetId: peer.peerId, content: entry.content, msgId: peer.msgId })
          sent += 1
          this.dbg('outbox-sent', entry.content.slice(0, 60))
        } catch {
          keep.push(line)
        }
      }
      writeFileSync(this.outboxFile, keep.length ? keep.join('\n') + '\n' : '', 'utf8')
    } catch { /* ignore */ }
  }

  /** 把一轮回复攒成一条，回合结束一起发（否则 QQ 上会一行一个气泡）。 */
  queueReply(text, sessionId) {
    const t = String(text || '').trim()
    if (t === '') return
    if (this.replySessionId && this.replySessionId !== sessionId) this.flushReply()
    this.replySessionId = sessionId
    this.replyBuffer = (this.replyBuffer ? this.replyBuffer + '\n' : '') + t
    if (this.replyTimer) clearTimeout(this.replyTimer)
    this.replyTimer = setTimeout(() => this.flushReply(), 8000)
    if (typeof this.replyTimer.unref === 'function') this.replyTimer.unref()
  }

  flushReply() {
    if (this.replyTimer) { clearTimeout(this.replyTimer); this.replyTimer = null }
    const sessionId = this.replySessionId
    const text = String(this.replyBuffer || '').trim()
    this.replyBuffer = ''
    this.replySessionId = ''
    const proactive = sessionId !== '' ? this.proactiveSends.get(sessionId) : null
    const useProactive = Boolean(proactive && proactive.active === true)
    const peer = useProactive ? proactive.peer : ((sessionId !== '' && this.lastPeerBySession.get(sessionId)) || this.lastPeer)
    if (text === '') {
      if (useProactive) this.completeProactive(proactive, 'skipped', [], 'AI 没有回话，这条没发')
      return
    }
    if (!peer) {
      if (useProactive) this.completeProactive(proactive, 'failed', [], '找不到要发给谁')
      return
    }
    if (!useProactive) {
      if (Date.now() - Number(peer.at || 0) > 10 * 60000) return
    }
    // 主动冒泡：窗口外到点时 peer.msgId 是空的 → 直接走主动消息通道；发不出去由下面的兜底逻辑记原因。
    // 按换行拆成多条：AI 每换一行 = QQ 上单独发一条消息（一个气泡一句话）
    // 过滤纯内心独白/碎碎念（（……）这种）、去重，私聊一行一泡（不设上限）
    const rawLines = text.split(/\r?\n+/).map((line) => line.trim()).filter((line) => line !== '')
    const cleaned = rawLines.filter((line) => {
      // 括号旁白整行不发（（……）这种）
      if (/^[（(].*[)）]$/.test(line)) return false
      // 提到「系统快照 / 动态状态 / runtime context」的元信息也不发，只留在后台
      if (/系统快照|动态状态|runtime[\s-]*context|不是他说话/i.test(line)) return false
      if (/^[。…\.\s（）()]+$/.test(line)) return false
      return true
    })
    const deduped = []
    for (const line of cleaned) {
      // 只去掉「同一轮里紧挨着的重复行」；跨轮重复（比如又说了句「嗯。」）照发，别吞他的话
      if (deduped.length > 0 && deduped[deduped.length - 1] === line) continue
      deduped.push(line)
    }
    // 主动冒泡：AI 不想说时可能回「不发」，这句本身不能发出去
    const lines = useProactive ? deduped.filter((line) => !/^不发[。.!！]?$/.test(line)) : deduped
    if (lines.length === 0) {
      if (useProactive) this.completeProactive(proactive, 'skipped', [], 'AI 觉得没什么要说的')
      return
    }
    this.recentSent = (Array.isArray(this.recentSent) ? this.recentSent : []).concat(lines).slice(-12)
    // 群聊：合并成 1 条气泡，但每句之间空一行；私聊保持一行一个气泡
    let outgoing = lines
    if (peer.scope === 'group') {
      outgoing = [lines.join('\n\n').slice(0, 1800)]
    }
    let sentCount = 0
    let lastError = ''
    const sendNext = async (index) => {
      if (index >= outgoing.length) {
        if (useProactive) {
          if (sentCount > 0) this.completeProactive(proactive, 'sent', outgoing.slice(0, sentCount))
          else this.completeProactive(proactive, 'failed', [], lastError !== '' ? lastError : '一条都没发出去')
        }
        return
      }
      const content = outgoing[index].slice(0, 1800)
      try {
        // 不带 quoteMessageId：否则 QQ 会把你那条消息引用成「评论框」
        await this.bot.sendTextWithQuote({ scope: peer.scope, targetId: peer.peerId, content, msgId: peer.msgId })
        sentCount += 1
        this.dbg('sent', content.slice(0, 80))
      } catch (firstError) {
        this.dbg('passive-fail', 'msgId=' + String(peer.msgId || '').slice(0, 24), String((firstError && firstError.message) || firstError).slice(0, 200))
        // 被动回复失败时，退回主动消息再试一次
        let delivered = false
        try {
          await this.bot.sendTextWithQuote({ scope: peer.scope, targetId: peer.peerId, content })
          delivered = true
          sentCount += 1
          this.dbg('sent-active', content.slice(0, 80))
        } catch (error) {
          lastError = String((error && error.message) || firstError).slice(0, 160)
          this.dbg('send-fail', lastError)
        }
        if (!delivered) this.dbg('dropped', content.slice(0, 80))
      }
      // 条间间隔：短一点更像连发（QQ 对单条入站消息有回复条数限制，太快也只是退回主动消息）
      await new Promise((resolve) => setTimeout(resolve, 600))
      await sendNext(index + 1)
    }
    sendNext(0).catch(() => {})
  }

  /** AI 会话产出正文 → 攒起来，turn/end 时一次发回最近说话的 QQ 会话。 */
  handleOutbound(session, event) {
    if (!this.config.enabled) return
    const sessionId = String(session && session.id ? session.id : '')
    if (sessionId === '') return
    const routedSessions = new Set([this.config.sessionId, ...Object.values(this.config.peerSessions || {})].filter(Boolean))
    if (!routedSessions.has(sessionId)) return
    if (!event) return
    if (event.type === 'user/message') {
      const rawUserText = this.userEventText(event).trim()
      // 主动冒泡到点：注入的那条提醒会被当成用户消息投递回来，标记这一轮是「冒泡」的
      if (rawUserText.indexOf(PROACTIVE_PROMPT_MARK) !== -1) {
        const pending = this.proactiveSends.get(sessionId)
        if (pending && pending.active !== true) {
          pending.active = true
          this.dbg('proactive-turn', sessionId.slice(-8))
        }
        this.proactiveTurns.add(sessionId)
        return
      }
      // 宿主会在回合中途把「runtime context」当成一条新的 user 消息投递进来；
      // 模型会以为用户又说话了，于是多回一段。这里标记一下，把紧随其后的那条 assistant 消息丢掉。
      const injected = /^Current runtime context\./.test(rawUserText)
      if (injected && this.textTurns.has(sessionId)) {
        this.suppressNext.add(sessionId)
        this.dbg('context-injected', sessionId.slice(-8))
      }
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data && event.data.message)
      if (this.suppressNext.has(sessionId)) {
        this.suppressNext.delete(sessionId)
        // 只有这一轮已经发过正文时，紧跟其后的那条才算「被 runtime context 骗出来的重复回复」；
        // 还没发过正文说明它是这一轮唯一的一段（比如主动冒泡到点被叫醒的那一轮），吞掉就整条冒泡都不发了
        if (this.textTurns.has(sessionId)) {
          this.dbg('drop-after-context', sessionId.slice(-8))
          return
        }
      }
      this.repliedTurns.add(sessionId)
      if (text !== '') {
        this.textTurns.add(sessionId)
        this.dbg('outbound', 'len=' + text.length, text.slice(0, 120))
        this.queueReply(text, sessionId)
      }
      return
    }
    if (event.type === 'turn/end') {
      const hadText = this.textTurns.has(sessionId)
      const syntheticTurn = this.syntheticTurns.delete(sessionId)
      this.repliedTurns.delete(sessionId)
      this.suppressNext.delete(sessionId)
      this.textTurns.delete(sessionId)
      this.flushReply()
      this.maybeFallbackTimedRequest(sessionId)
      this.noteProactiveMissed(sessionId, { hadText, syntheticTurn })
    }
  }

  /** 按钮回调：ap:allow:CODE / ap:deny:CODE。 */
  async handleInteraction(event) {
    const data = String(event && event.buttonData ? event.buttonData : '')
    // 提问按钮：q:<token>:<选项序号>
    const questionMatch = /^q:([a-z0-9]{4,10}):(\d+)$/.exec(data)
    if (questionMatch) {
      const entry = this.questions.get(questionMatch[1])
      if (entry) {
        const label = entry.options[Number(questionMatch[2])]
        if (typeof label === 'string') {
          this.settleQuestion(questionMatch[1], [label])
          await this.reply({ scope: event.scope, peerId: event.peerId }, '✅ 已记下：' + label)
        }
      }
      return
    }
    // 通用文本按钮：reply:<内容>
    const replyMatch = /^reply:(.+)$/.exec(data)
    if (replyMatch) {
      await this.reply({ scope: event.scope, peerId: event.peerId }, replyMatch[1].slice(0, 200)).catch(() => {})
      return
    }
    const match = /^ap:(allow|deny):([A-Z0-9]{6})$/.exec(data)
    if (!match) return
    const code = match[2]
    const pending = this.pending.get(code)
    if (!pending || pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    this.pending.delete(code)
    pending.resolve(match[1] === 'allow' ? 'allowed-once' : 'rejected')
    try {
      await this.reply({ scope: event.scope, peerId: event.peerId }, (match[1] === 'allow' ? '✅ 已允许' : '❌ 已拒绝') + '（' + code + '）')
    } catch {
      // ignore
    }
  }

  async reply(target, content) {
    if (!target || !target.peerId) return
    await this.bot.sendText({ scope: target.scope, targetId: target.peerId, content })
  }

  /** 解析文字回答："/答 A"、"/答 A,C"、"答 A"、直接回选项原文。 */
  parseQuestionText(text) {
    if (this.questions.size === 0) return null
    const value = String(text || '').trim()
    const token = [...this.questions.keys()][0]
    const entry = this.questions.get(token)
    if (!entry) return null
    const optionLetter = value.match(/^(?:\/)?答\s*([A-Za-z])(?:\s*[,，]\s*([A-Za-z]))*$/i)
    if (optionLetter) {
      const letters = value.replace(/^(?:\/)?答\s*/i, '').split(/[,，\s]+/).filter(Boolean)
      const picked = []
      for (const letter of letters) {
        const index = letter.toUpperCase().charCodeAt(0) - 65
        if (index >= 0 && index < entry.options.length) picked.push(entry.options[index])
      }
      if (picked.length > 0) return { token, selected: picked }
      return null
    }
    const exact = entry.options.find((label) => label === value)
    if (exact) return { token, selected: [exact] }
    if (value !== '') return { token, selected: [], custom: value }
    return null
  }

  settleQuestion(token, selected, custom = '') {
    const entry = this.questions.get(token)
    if (!entry) return false
    this.questions.delete(token)
    clearTimeout(entry.timer)
    entry.resolve({ selected, custom })
    return true
  }

  /**
   * 宿主 user-questions/request → QQ 卡片（单题 + ≤5 选项才接管，其它交回宿主）。
   * 回答方式：点按钮 / 回 "/答 A" / 回选项原文 / 随便回一句当自定义答案。
   */
  async handleQuestion(request, next) {
    try {
      const enabled = (this.config.enabled || this.config.approvalEnabled) && this.lastPeer
      if (!enabled) return next()
      if (Date.now() - this.lastPeer.at > 30 * 60000) return next()
      const questions = Array.isArray(request && request.questions) ? request.questions : []
      if (questions.length !== 1) return next()
      const question = questions[0]
      const options = (Array.isArray(question && question.options) ? question.options : []).map((item) => String(item && item.label ? item.label : '')).filter(Boolean)
      if (options.length === 0 || options.length > 5) return next()
      if (!question || String(question.id || '') === '') return next()
      const token = Math.random().toString(36).slice(2, 8)
      const peer = this.lastPeer
      const lines = []
      if (question.header) lines.push('【' + String(question.header).slice(0, 40) + '】')
      lines.push(String(question.question || '（一个问题）').slice(0, 300))
      options.forEach((label, index) => lines.push(String.fromCharCode(65 + index) + '. ' + label.slice(0, 40)))
      lines.push('点按钮，或回 /答 A（多选用 /答 A,C），其它文字当自定义回答。')
      const answer = new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.questions.has(token)) {
            this.questions.delete(token)
            resolve({ selected: [], custom: '' })
          }
        }, Math.max(5000, Number(this.config.approvalTimeoutMs) || 120000))
        this.questions.set(token, { resolve, timer, options, qid: String(question.id) })
      })
      try {
        await this.bot.sendCard({
          scope: peer.scope,
          targetId: peer.peerId,
          content: lines.join('\n'),
          buttons: options.map((label, index) => ({ label: String.fromCharCode(65 + index) + '. ' + label.slice(0, 10), data: 'q:' + token + ':' + index, style: index === 0 ? 1 : 0 })),
          msgId: peer.msgId,
        })
      } catch {
        await this.reply(peer, lines.join('\n')).catch(() => {})
      }
      const result = await answer
      return { answers: [{ id: String(question.id), selected: Array.isArray(result.selected) ? result.selected : [], custom: result.custom || '' }] }
    } catch {
      return next()
    }
  }

  /** 宿主审批 → QQ 卡片（带码）+ 文字兜底。 */
  async handleApproval(request, next) {
    try {
      if (!this.config.approvalEnabled || !this.lastPeer) return next()
      if (Date.now() - this.lastPeer.at > 30 * 60000) return next()
      if (request && request.signal && request.signal.aborted) return 'cancelled'
      const code = newCode()
      const reason = String((request && request.reason) || '').replace(/[\r\n]+/g, ' ').slice(0, 160)
      const tool = String((request && request.toolName) || '').slice(0, 40)
      const peer = this.lastPeer
      const content = '⚠️ AI 想执行一个需要权限的操作' + (tool ? '（工具：' + tool + '）' : '') + (reason ? '：' + reason : '') + '\n验证码：' + code + '\n点按钮，或回复 /approve ' + code
      const outcome = new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(code)) {
            this.pending.delete(code)
            resolve('rejected')
          }
        }, this.config.approvalTimeoutMs)
        this.pending.set(code, { resolve, timer, settled: false })
      })
      try {
        await this.bot.sendCard({
          scope: peer.scope,
          targetId: peer.peerId,
          content,
          buttons: [
            { label: '✅ 允许本次', data: 'ap:allow:' + code, style: 1 },
            { label: '❌ 拒绝', data: 'ap:deny:' + code, style: 0 },
          ],
          msgId: peer.msgId,
        })
      } catch {
        await this.reply(peer, content).catch(() => {})
      }
      return await outcome
    } catch {
      return next()
    }
  }
}
