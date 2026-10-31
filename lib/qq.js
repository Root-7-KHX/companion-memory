/**
 * qq.js —— AI记忆 自带的 QQ 机器人连接（原生实现，不依赖 dsh-qqbot）
 *
 * 走 QQ 官方机器人协议（https://bot.q.qq.com/wiki）：
 *   ① POST https://bots.qq.com/app/getAppAccessToken 换 access_token（按 expires_in 提前刷新）
 *   ② GET  /gateway 拿 WebSocket 地址
 *   ③ WS 连上后 op2 identify（token = 'QQBot ' + access_token）
 *   ④ op10 hello → 每 heartbeat_interval 发 op1 心跳；op0 dispatch 收事件
 *   ⑤ 回复用 REST：群聊 POST /v2/groups/{群 openid}/messages，私聊 POST /v2/users/{用户 openid}/messages
 *
 * 设计取舍：
 *   · 只用 Node 自带的全局 fetch / WebSocket（Node ≥ 22），不装任何依赖、跟着插件走；
 *   · 配置存 {数据根}/qq-bot.json（appSecret 只存本机文件，面板回显打码）；
 *   · 收到的消息进内存环形缓冲（最近 200 条）+ 落 {数据根}/qq-messages.jsonl，供面板/后续接入 AI 会话；
 *   · 断线自动重连（指数退避），不能连时只记录状态，不影响插件主链。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
/** C2C_MESSAGE_CREATE(1<<25) | GROUP_AT_MESSAGE_CREATE(1<<30) | INTERACTION(1<<26) */
const DEFAULT_INTENTS = (1 << 25) | (1 << 30) | (1 << 26)
import { SpeakerVoiceprint } from './voiceprint.js'

/** 判断一条 attachment 是不是语音：QQ 的 content_type 可能是 voice / silk / audio/*，也可能只给文件名。 */
function isVoiceAttachment(item) {
  if (!item || typeof item !== 'object') return false
  const contentType = String(item.content_type || '').toLowerCase()
  if (contentType.includes('voice') || contentType.includes('silk')) return true
  if (contentType.startsWith('audio/')) return true
  const name = String(item.filename || item.name || '').toLowerCase()
  if (/\.(silk|amr|slk)$/.test(name)) return true
  return false
}

const RECENT_MAX = 200
const HEARTBEAT_FALLBACK_MS = 30000

export class QqBot {
  constructor(rootDir) {
    this.root = String(rootDir ?? '')
    this.configFile = join(this.root, 'qq-bot.json')
    this.messagesFile = join(this.root, 'qq-messages.jsonl')
    this.config = this.readConfig()
    this.ws = null
    this.token = null
    this.tokenExpiresAt = 0
    this.sessionId = ''
    this.seq = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.reconnectDelay = 2000
    this.connected = false
    this.status = 'idle'
    this.lastError = ''
    this.botName = ''
    this.recent = []
    this.listeners = new Set()
    this.stopped = true
    // 表情包库 / 定时消息
    this.stickerDir = join(this.root, 'qq-stickers')
    this.stickerIndexFile = join(this.stickerDir, 'index.json')
    this.peersFile = join(this.root, 'qq-peers.json')
    this.peers = this.readPeers()
    this.voiceDir = join(this.root, 'qq-voices')
    this.voiceIndexFile = join(this.voiceDir, 'index.json')
    this.voices = this.readVoices()
    this.voiceprint = new SpeakerVoiceprint(this.root, this.config.voiceprint)
    this._groupNamePending = new Set()
    // 同一条入站消息的多次被动回复要递增 msg_seq，否则第二段起会被 QQ 判重复发送
    this._msgSeq = new Map()
    this.scheduleFile = join(this.root, 'qq-schedule.json')
    this.scheduleTimer = null
    this.stickers = this.readStickers()
    this.schedules = this.readSchedules()
  }

  readConfig() {
    try {
      if (!existsSync(this.configFile)) return { appId: '', appSecret: '', enabled: false, autoSticker: { enabled: false, minGapMinutes: 10, maxPerHour: 6 }, stickerTaggerCmd: '', voiceprint: { enabled: true, threshold: 0.55, autoCollectAbove: 0.78, maxPerName: 20, maxSeconds: 300, modelPath: '', sherpaModulePath: '' } }
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8').replace(/^\uFEFF/, ''))
      const auto = parsed.autoSticker && typeof parsed.autoSticker === 'object' ? parsed.autoSticker : {}
      return {
        appId: typeof parsed.appId === 'string' ? parsed.appId.trim() : '',
        appSecret: typeof parsed.appSecret === 'string' ? parsed.appSecret.trim() : '',
        enabled: parsed.enabled === true,
        autoSticker: {
          enabled: auto.enabled === true,
          minGapMinutes: Math.max(1, Number(auto.minGapMinutes) || 10),
          maxPerHour: Math.max(1, Number(auto.maxPerHour) || 6),
        },
        // 本地图片/语音保留天数（默认 7 天，过期自动删文件+索引）
        mediaTtlDays: Math.max(1, Number(parsed.mediaTtlDays) || 7),
        // 外部视觉打标命令（可选）：{file} 会替换成本地图片路径，stdout 需输出 {"tags":[...],"caption":"..."}
        stickerTaggerCmd: typeof parsed.stickerTaggerCmd === 'string' ? parsed.stickerTaggerCmd.trim() : '',
        // 本地声纹（CAM++ ONNX 在本地跑）：enabled 默认开，threshold 余弦相似度阈值
        voiceprint: {
          enabled: (parsed.voiceprint && parsed.voiceprint.enabled) !== false,
          threshold: Math.min(0.99, Math.max(0.3, Number(parsed.voiceprint && parsed.voiceprint.threshold) || 0.55)),
          autoCollectAbove: Math.min(0.99, Math.max(0.5, Number(parsed.voiceprint && parsed.voiceprint.autoCollectAbove) || 0.78)),
          autoCollectAboveWhenFull: Math.min(0.99, Math.max(0.5, Number(parsed.voiceprint && parsed.voiceprint.autoCollectAboveWhenFull) || 0.8)),
          freeEnrollSeconds: Math.max(0, Math.min(600, Number(parsed.voiceprint && parsed.voiceprint.freeEnrollSeconds) || 60)),
          allowedMembers: Array.isArray(parsed.voiceprint && parsed.voiceprint.allowedMembers) ? parsed.voiceprint.allowedMembers.map((item) => String(item)).filter(Boolean).slice(0, 200) : [],
          maxPerName: Math.max(1, Math.min(50, Number(parsed.voiceprint && parsed.voiceprint.maxPerName) || 20)),
          maxSeconds: Math.max(10, Math.min(3600, Number(parsed.voiceprint && parsed.voiceprint.maxSeconds) || 300)),
          modelPath: typeof (parsed.voiceprint && parsed.voiceprint.modelPath) === 'string' ? parsed.voiceprint.modelPath.trim() : '',
          sherpaModulePath: typeof (parsed.voiceprint && parsed.voiceprint.sherpaModulePath) === 'string' ? parsed.voiceprint.sherpaModulePath.trim() : '',
        },
      }
    } catch {
      return { appId: '', appSecret: '', enabled: false, voiceprint: { enabled: true, threshold: 0.55, autoCollectAbove: 0.78, maxPerName: 20, maxSeconds: 300, modelPath: '', sherpaModulePath: '' } }
    }
  }

  saveConfig(patch = {}) {
    const next = { ...this.config }
    if (typeof patch.appId === 'string') next.appId = patch.appId.trim()
    // 空字符串表示"不改"，避免面板打码回显把密码抹掉
    if (typeof patch.appSecret === 'string' && patch.appSecret !== '') next.appSecret = patch.appSecret.trim()
    if (typeof patch.clearSecret === 'boolean' && patch.clearSecret) next.appSecret = ''
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.stickerTaggerCmd === 'string') next.stickerTaggerCmd = patch.stickerTaggerCmd.trim()
    if (Number.isFinite(Number(patch.mediaTtlDays))) next.mediaTtlDays = Math.max(1, Math.round(Number(patch.mediaTtlDays)))
    if (patch.voiceprint && typeof patch.voiceprint === 'object') {
      const cur = next.voiceprint && typeof next.voiceprint === 'object' ? next.voiceprint : {}
      next.voiceprint = {
        enabled: typeof patch.voiceprint.enabled === 'boolean' ? patch.voiceprint.enabled : cur.enabled !== false,
        threshold: Number.isFinite(Number(patch.voiceprint.threshold)) ? Math.min(0.99, Math.max(0.3, Number(patch.voiceprint.threshold))) : (Number(cur.threshold) || 0.55),
        autoCollectAbove: Number.isFinite(Number(patch.voiceprint.autoCollectAbove)) ? Math.min(0.99, Math.max(0.5, Number(patch.voiceprint.autoCollectAbove))) : (Number(cur.autoCollectAbove) || 0.78),
        autoCollectAboveWhenFull: Number.isFinite(Number(patch.voiceprint.autoCollectAboveWhenFull)) ? Math.min(0.99, Math.max(0.5, Number(patch.voiceprint.autoCollectAboveWhenFull))) : (Number(cur.autoCollectAboveWhenFull) || 0.8),
        freeEnrollSeconds: Number.isFinite(Number(patch.voiceprint.freeEnrollSeconds)) ? Math.max(0, Math.min(600, Math.round(Number(patch.voiceprint.freeEnrollSeconds)))) : (Number(cur.freeEnrollSeconds) || 60),
        allowedMembers: Array.isArray(patch.voiceprint.allowedMembers) ? patch.voiceprint.allowedMembers.map((item) => String(item)).filter(Boolean).slice(0, 200) : (Array.isArray(cur.allowedMembers) ? cur.allowedMembers : []),
        maxPerName: Number.isFinite(Number(patch.voiceprint.maxPerName)) ? Math.max(1, Math.min(50, Math.round(Number(patch.voiceprint.maxPerName)))) : (Number(cur.maxPerName) || 20),
        maxSeconds: Number.isFinite(Number(patch.voiceprint.maxSeconds)) ? Math.max(10, Math.min(3600, Math.round(Number(patch.voiceprint.maxSeconds)))) : (Number(cur.maxSeconds) || 300),
        modelPath: typeof patch.voiceprint.modelPath === 'string' ? patch.voiceprint.modelPath.trim() : (typeof cur.modelPath === 'string' ? cur.modelPath : ''),
        sherpaModulePath: typeof patch.voiceprint.sherpaModulePath === 'string' ? patch.voiceprint.sherpaModulePath.trim() : (typeof cur.sherpaModulePath === 'string' ? cur.sherpaModulePath : ''),
      }
      this.voiceprint = new SpeakerVoiceprint(this.root, next.voiceprint)
    }
    if (patch.autoSticker && typeof patch.autoSticker === 'object') {
      const current = next.autoSticker && typeof next.autoSticker === 'object' ? next.autoSticker : {}
      next.autoSticker = {
        enabled: typeof patch.autoSticker.enabled === 'boolean' ? patch.autoSticker.enabled : current.enabled === true,
        minGapMinutes: Math.max(1, Number(patch.autoSticker.minGapMinutes) || Number(current.minGapMinutes) || 10),
        maxPerHour: Math.max(1, Number(patch.autoSticker.maxPerHour) || Number(current.maxPerHour) || 6),
      }
    }
    this.config = next
    try {
      mkdirSync(this.root, { recursive: true })
      writeFileSync(this.configFile, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch {
      // 写配置失败不影响运行
    }
    return this.publicConfig()
  }

  publicConfig() {
    return {
      appId: this.config.appId,
      hasSecret: this.config.appSecret !== '',
      enabled: this.config.enabled,
      mediaTtlDays: this.config.mediaTtlDays ?? 7,
      autoSticker: this.config.autoSticker ?? { enabled: false, minGapMinutes: 10, maxPerHour: 6 },
      stickerTaggerCmd: this.config.stickerTaggerCmd ?? '',
    }
  }

  onMessage(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 订阅全部事件（message / interaction / ready / sticker-sent）。 */
  onEvent(listener) {
    return this.onMessage(listener)
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个监听器失败不影响其它
      }
    }
  }

  /** 状态快照（面板用） */
  statusSnapshot() {
    return {
      configured: this.config.appId !== '' && this.config.appSecret !== '',
      appId: this.config.appId,
      status: this.status,
      connected: this.connected,
      botName: this.botName,
      sessionId: this.sessionId,
      lastError: this.lastError,
      recentCount: this.recent.length,
      latest: this.recent[0] || null,
      voiceprint: this.voiceprint ? this.voiceprint.status() : null,
    }
  }

  // ── 官方 REST ─────────────────────────────────────────────────────────

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token
    if (this.config.appId === '' || this.config.appSecret === '') throw new Error('还没有配置 appId / appSecret')
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
    })
    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload.access_token !== 'string') {
      throw new Error('获取 access_token 失败：' + JSON.stringify(payload).slice(0, 120))
    }
    this.token = payload.access_token
    const ttl = Math.max(60, Number(payload.expires_in) || 7200)
    this.tokenExpiresAt = Date.now() + (ttl - 60) * 1000
    return this.token
  }

  async apiRequest(path, init = {}) {
    const token = await this.accessToken()
    const response = await fetch(API_BASE + path, {
      ...init,
      headers: {
        authorization: 'QQBot ' + token,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      payload = text
    }
    if (!response.ok) {
      throw new Error('QQ 接口 ' + path + ' 失败（' + response.status + '）：' + String(text).slice(0, 200))
    }
    return payload
  }

  async gatewayUrl() {
    const payload = await this.apiRequest('/gateway')
    if (!payload || typeof payload.url !== 'string' || !payload.url.startsWith('wss://')) {
      throw new Error('拿不到 QQ 网关地址：' + JSON.stringify(payload).slice(0, 120))
    }
    return payload.url
  }

  // ── 连接 / 收消息 ─────────────────────────────────────────────────────

  async start() {
    if (!this.stopped) return this.statusSnapshot()
    if (this.config.appId === '' || this.config.appSecret === '') throw new Error('还没有配置 appId / appSecret')
    this.stopped = false
    this.status = 'connecting'
    try { this.pruneMedia() } catch { /* ignore */ }
    this.lastError = ''
    try {
      const url = await this.gatewayUrl()
      await this.connect(url)
    } catch (error) {
      this.lastError = String(error && error.message ? error.message : error)
      this.status = 'error'
      this.scheduleReconnect()
    }
    return this.statusSnapshot()
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      let settled = false
      let socket
      try {
        socket = new WebSocket(url)
      } catch (error) {
        reject(error)
        return
      }
      this.ws = socket
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }
      socket.addEventListener('open', () => {
        this.status = 'identifying'
        settle(resolve)
      })
      socket.addEventListener('message', (event) => {
        try {
          this.handleFrame(JSON.parse(String(event.data)))
        } catch {
          // 坏帧忽略
        }
      })
      socket.addEventListener('error', () => {
        this.lastError = 'WebSocket 连接错误'
        this.connected = false
        this.status = 'error'
        this.scheduleReconnect()
        settle(reject, new Error(this.lastError))
      })
      socket.addEventListener('close', () => {
        settle(reject, new Error('WebSocket 在 identify 前被关闭'))
        const wasConnected = this.connected
        this.connected = false
        this.ws = null
        if (!this.stopped) {
          this.status = 'reconnecting'
          this.scheduleReconnect()
        } else if (wasConnected) {
          this.status = 'stopped'
        }
      })
    })
  }

  handleFrame(frame) {
    const op = frame && frame.op
    if (Number.isFinite(frame && frame.s)) this.seq = frame.s
    if (op === 10) {
      // hello：先 identify（用最新的 access_token），再按服务端给的间隔心跳
      this.accessToken()
        .then((token) => {
          this.sendFrame({
            op: 2,
            d: {
              token: 'QQBot ' + token,
              intents: DEFAULT_INTENTS,
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'ai-memory', $device: 'ai-memory' },
            },
          })
        })
        .catch((error) => {
          this.lastError = String(error && error.message ? error.message : error)
          this.status = 'error'
        })
      const interval = Math.max(5000, Number(frame.d && frame.d.heartbeat_interval) || HEARTBEAT_FALLBACK_MS)
      this.startHeartbeat(interval)
      return
    }
    if (op === 11) return
    if (op === 0) {
      const type = frame.t
      if (type === 'READY') {
        this.connected = true
        this.status = 'online'
        this.sessionId = String((frame.d && frame.d.session_id) || '')
        const user = frame.d && frame.d.user
        this.botName = String((user && (user.username || user.id)) || '')
        this.reconnectDelay = 2000
        this.startScheduleTicker()
        this.emit({ type: 'ready', botName: this.botName })
        return
      }
      if (type === 'C2C_MESSAGE_CREATE' || type === 'GROUP_AT_MESSAGE_CREATE') {
        this.handleMessage(type, frame.d || {})
      }
      if (type === 'INTERACTION_CREATE') {
        this.handleInteraction(frame.d || {})
      }
      return
    }
    if (op === 7) {
      // 服务端要求重连
      this.restart()
    }
    if (op === 9) {
      this.lastError = '会话失效（op9），重新连接'
      this.restart()
    }
  }

  sendFrame(payload) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload))
    } catch {
      // 发送失败等重连
    }
  }

  startHeartbeat(interval) {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame({ op: 1, d: this.seq })
    }, interval)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  async handleMessage(type, data) {
    const author = data.author || {}
    const scope = type === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'c2c'
    const record = {
      id: String(data.id || ''),
      scope,
      peerId: scope === 'group' ? String(data.group_openid || '') : String(author.user_openid || ''),
      senderId: String(author.member_openid || author.user_openid || ''),
      senderName: String(author.username || ''),
      content: String(data.content || '').trim(),
      imageCount: (Array.isArray(data.attachments) ? data.attachments : []).filter((item) => String((item && item.content_type) || '').startsWith('image/')).length,
      voiceCount: (Array.isArray(data.attachments) ? data.attachments : []).filter((item) => isVoiceAttachment(item)).length,
      at: new Date().toISOString(),
      rawAt: Number(data.timestamp) || Date.now(),
    }
    if (record.content === '' && record.senderId === '') return
    this.recent.unshift(record)
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX
    try {
      mkdirSync(this.root, { recursive: true })
      appendFileSync(this.messagesFile, JSON.stringify(record) + '\n', 'utf8')
    } catch {
      // 落盘失败不影响收消息
    }
    // 调试：把每条入站消息的原始 payload 都留一份（截断 6000 字符），便于核对 QQ 真实字段
    try {
      if (this.config.debugInbound !== false) {
        appendFileSync(join(this.root, 'qq-inbound-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), t: type, id: record.id, raw: data }).slice(0, 6000) + '\n', 'utf8')
      }
    } catch { /* ignore */ }
    // 图片先下载落盘（路径挂到 record 上，桥接转发时要带给 AI）；语音另存
    try {
      const saved = await this.captureAttachments(data)
      if (Array.isArray(saved) && saved.length > 0) record.imagePaths = saved.map((item) => item.path)
      const savedVoices = await this.captureVoices(data)
      if (Array.isArray(savedVoices) && savedVoices.length > 0) record.voicePaths = savedVoices.map((item) => item.path)
    } catch {
      // ignore
    }
    // 自动丢表情包：冷却/频率闸门都在 maybeAutoSticker 里，失败不影响消息
    try {
      this.maybeAutoSticker(record).catch(() => {})
    } catch {
      // ignore
    }
    this.notePeer(record)
    // 群聊：QQ 不提供“列出机器人所在全部群”，只能收到群消息后反查群信息补名字
    if (record.scope === 'group' && record.peerId !== '') {
      this.refreshGroupName(record.peerId).catch(() => {})
    }
    this.emit({ type: 'message', message: record })
  }

  // ── 发消息 ────────────────────────────────────────────────────────────

  /**
   * 发一条文本。
   * @param {object} input {scope:'group'|'c2c', targetId, content, msgId?, msgSeq?}
   *   msgId 传了就是"被动回复"（5 分钟内有效），不传是"主动消息"（需要官方给主动权限）。
   */
  async sendText(input = {}) {
    const scope = input.scope === 'group' ? 'group' : 'c2c'
    const targetId = String(input.targetId || '').trim()
    const content = String(input.content || '').trim()
    if (targetId === '' || content === '') throw new Error('发消息需要 targetId 和 content')
    const body = { content, msg_type: 0 }
    if (typeof input.msgId === 'string' && input.msgId !== '') {
      body.msg_id = input.msgId
      const seq = this.nextMsgSeq(input.msgId)
      if (seq !== undefined) body.msg_seq = seq
    }
    const path = scope === 'group' ? '/v2/groups/' + encodeURIComponent(targetId) + '/messages' : '/v2/users/' + encodeURIComponent(targetId) + '/messages'
    const payload = await this.apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
    return { ok: true, scope, targetId, id: payload && payload.id ? String(payload.id) : '' }
  }

  // ── 停止 / 重连 ───────────────────────────────────────────────────────

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(60000, this.reconnectDelay * 2)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.stopped) return
      try {
        await this.restart()
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  async restart() {
    this.disposeSocket()
    if (this.stopped) return
    this.status = 'connecting'
    try {
      const url = await this.gatewayUrl()
      await this.connect(url)
    } catch (error) {
      this.lastError = String(error && error.message ? error.message : error)
      this.status = 'error'
      this.scheduleReconnect()
    }
  }

  disposeSocket() {
    this.clearHeartbeat()
    try {
      if (this.ws) this.ws.close()
    } catch {
      // ignore
    }
    this.ws = null
    this.connected = false
    this.seq = null
  }

  async stop() {
    this.stopped = true
    this.status = 'stopped'
    this.stopScheduleTicker()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.disposeSocket()
    return this.statusSnapshot()
  }

  // ── 表情包库（从收到的图片自动收，面板可看可删） ─────────────────────────

  readStickers() {
    try {
      if (!existsSync(this.stickerIndexFile)) return []
      const parsed = JSON.parse(readFileSync(this.stickerIndexFile, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.file === 'string') : []
    } catch {
      return []
    }
  }

  saveStickers() {
    try {
      mkdirSync(this.stickerDir, { recursive: true })
      writeFileSync(this.stickerIndexFile, JSON.stringify(this.stickers.slice(0, 500), null, 2) + '\n', 'utf8')
    } catch {
      // ignore
    }
  }

  /** 收消息时把图片附件落进表情包库（同一 URL 只存一次）。 */
  async captureAttachments(data) {
    const saved = []
    const attachments = Array.isArray(data.attachments) ? data.attachments : []
    for (const item of attachments.slice(0, 3)) {
      try {
        const url = typeof item.url === 'string' ? item.url : ''
        const contentType = String(item.content_type || '')
        if (!/^https:\/\//.test(url) || (contentType !== '' && !contentType.startsWith('image/'))) continue
        if (this.stickers.some((sticker) => sticker.source === url)) continue
        const response = await fetch(url)
        if (!response.ok) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) continue
        const ext = contentType.startsWith('image/svg') ? 'svg' : contentType.startsWith('image/gif') ? 'gif' : contentType.startsWith('image/webp') ? 'webp' : 'jpg'
        const file = 'qq_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 6) + '.' + ext
        mkdirSync(this.stickerDir, { recursive: true })
        writeFileSync(join(this.stickerDir, file), bytes)
        this.stickers.unshift({ id: 'st_' + Math.random().toString(16).slice(2, 10), file, source: url, from: String((data.author && (data.author.username || data.author.member_openid)) || ''), at: new Date().toISOString(), bytes: bytes.length })
        this.saveStickers()
        saved.push({ path: join(this.stickerDir, file), stickerId: this.stickers[0].id, bytes: bytes.length })
        this.emit({ type: 'sticker', sticker: this.stickers[0] })
      } catch {
        // 单张收不进来不影响消息
      }
    }
    return saved
  }

  listStickers(limit = 100) {
    return this.stickers.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
  }

  deleteSticker(id) {
    const index = this.stickers.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到这张表情包：' + id)
    const [removed] = this.stickers.splice(index, 1)
    try {
      const file = join(this.stickerDir, removed.file)
      if (existsSync(file)) writeFileSync(file, '') // 占位清空；索引里已没了
    } catch {
      // ignore
    }
    this.saveStickers()
    return removed
  }

  // ── 引用回复 + 卡片消息 + 按钮回调 ─────────────────────────────────────────

  /**
   * 发文本，可带引用（message_id）。
   * @param {object} input {scope, targetId, content, msgId?, quoteMessageId?}
   */
  async sendTextWithQuote(input = {}) {
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const targetId = String(input.targetId || '').trim()
    const content = String(input.content || '').trim()
    if (targetId === '' || content === '') throw new Error('发消息需要 targetId 和 content')
    const body = { content, msg_type: 0 }
    if (typeof input.msgId === 'string' && input.msgId !== '') body.msg_id = input.msgId
    if (typeof input.quoteMessageId === 'string' && input.quoteMessageId !== '') {
      body.message_reference = { message_id: input.quoteMessageId, ignore_message_reference_error: true }
    }
    const path = scope === 'group' ? '/v2/groups/' + encodeURIComponent(targetId) + '/messages' : '/v2/users/' + encodeURIComponent(targetId) + '/messages'
    let payload
    try {
      payload = await this.apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
    } catch (error) {
      // QQ 提示「消息被去重，请检查请求 msgseq」时：换一个新的 msg_seq 再试一次
      const message = String(error && error.message ? error.message : error)
      if (body.msg_id && (message.includes('40054005') || message.includes('去重') || message.includes('msgseq'))) {
        body.msg_seq = this.nextMsgSeq(input.msgId)
        payload = await this.apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
      } else {
        throw error
      }
    }
    return { ok: true, id: payload && payload.id ? String(payload.id) : '' }
  }

  /**
   * 发按钮卡片（markdown + keyboard，msg_type=2）。
   * @param {object} input {scope, targetId, content, buttons:[{label, data, style?}], msgId?, quoteMessageId?}
   *   style: 1=蓝(推荐) 0=灰 2=红；最多 5 行 × 5 个按钮。
   */
  async sendCard(input = {}) {
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const targetId = String(input.targetId || '').trim()
    const content = String(input.content || '').trim()
    if (targetId === '' || content === '') throw new Error('发卡片需要 targetId 和 content')
    const buttons = Array.isArray(input.buttons) ? input.buttons.slice(0, 5) : []
    const rows = buttons.map((button) => ({
      buttons: [
        {
          id: String(button.data || button.label || '').slice(0, 64),
          render_data: { label: String(button.label || '按钮').slice(0, 12), visited_label: String(button.label || '按钮').slice(0, 12), style: Number(button.style) === 1 ? 1 : 0 },
          action: { type: 1, permission: { type: 2 }, data: String(button.data || '').slice(0, 64), unsupport_tips: '请回复文字' },
        },
      ],
    }))
    if (rows.length === 0) return this.sendTextWithQuote({ scope, targetId, content, msgId: input.msgId, quoteMessageId: input.quoteMessageId })
    const body = { content, msg_type: 2, keyboard: { content: { rows } } }
    if (typeof input.msgId === 'string' && input.msgId !== '') body.msg_id = input.msgId
    if (typeof input.quoteMessageId === 'string' && input.quoteMessageId !== '') {
      body.message_reference = { message_id: input.quoteMessageId, ignore_message_reference_error: true }
    }
    const path = scope === 'group' ? '/v2/groups/' + encodeURIComponent(targetId) + '/messages' : '/v2/users/' + encodeURIComponent(targetId) + '/messages'
    const payload = await this.apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
    return { ok: true, id: payload && payload.id ? String(payload.id) : '' }
  }

  /** 应答按钮回调（官方要求：收到 INTERACTION_CREATE 后 PUT 一下，否则客户端一直转圈）。 */
  async ackInteraction(interactionId) {
    try {
      await this.apiRequest('/interactions/' + encodeURIComponent(interactionId), { method: 'PUT' })
      return true
    } catch {
      return false
    }
  }

  /** 处理一个按钮回调：先 ack，再交给监听器（监听器可用 sendCard/sendText 回话）。 */
  handleInteraction(data) {
    const interactionId = String(data && data.id ? data.id : '')
    if (interactionId === '') return
    this.ackInteraction(interactionId).catch(() => {})
    const inner = data && data.data && typeof data.data === 'object' ? data.data : {}
    if (inner.type !== 11) return
    const resolved = inner.resolved && typeof inner.resolved === 'object' ? inner.resolved : {}
    const buttonData = String(resolved.button_data || '')
    const clicker = String(data.group_member_openid || data.user_openid || '')
    const event = {
      type: 'interaction',
      interactionId,
      buttonData,
      clicker,
      scope: data.group_openid ? 'group' : 'c2c',
      peerId: String(data.group_openid || data.user_openid || ''),
    }
    this.emit(event)
  }

  // ── 群发（串行、带间隔；单项失败不影响其它） ─────────────────────────────

  async broadcast(input = {}) {
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const content = String(input.content || '').trim()
    if (content === '') throw new Error('群发内容不能为空')
    const ids = (Array.isArray(input.targetIds) ? input.targetIds : String(input.targetIds || '').split(/[\s,，;；]+/))
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 50)
    if (ids.length === 0) throw new Error('群发至少填一个目标 openid')
    const gap = Math.max(300, Number(input.gapMs) || 1500)
    const results = []
    for (const targetId of ids) {
      try {
        await this.sendText({ scope, targetId, content })
        results.push({ targetId, ok: true })
      } catch (error) {
        results.push({ targetId, ok: false, error: String(error && error.message ? error.message : error) })
      }
      await new Promise((resolve) => setTimeout(resolve, gap))
    }
    return {
      total: ids.length,
      sent: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    }
  }

  // ── 本地媒体清理：超过保留天数的图片/语音连文件带索引一起删 ───────────────

  pruneMedia(now = new Date()) {
    const ttlDays = Math.max(1, Number(this.config.mediaTtlDays) || 7)
    const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000
    const fresh = []
    let removed = 0
    for (const sticker of this.stickers) {
      const at = Date.parse(sticker.at || '') || 0
      if (at !== 0 && at < cutoff) {
        try { const file = join(this.stickerDir, sticker.file); if (existsSync(file)) { writeFileSync(file, ''); } } catch { /* ignore */ }
        removed += 1
        continue
      }
      fresh.push(sticker)
    }
    this.stickers = fresh
    this.saveStickers()
    const freshVoices = []
    let removedVoices = 0
    for (const voice of this.voices) {
      const at = Date.parse(voice.at || '') || 0
      if (at !== 0 && at < cutoff) {
        try { const file = join(this.voiceDir, voice.file); if (existsSync(file)) { writeFileSync(file, ''); } } catch { /* ignore */ }
        removedVoices += 1
        continue
      }
      freshVoices.push(voice)
    }
    this.voices = freshVoices
    this.saveVoices()
    return { stickers: removed, voices: removedVoices, ttlDays }
  }

  // ── 见过的 QQ 会话（人/群）── 给面板选「AI 接谁」

  readPeers() {
    try {
      if (!existsSync(this.peersFile)) return []
      const parsed = JSON.parse(readFileSync(this.peersFile, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  savePeers() {
    try {
      writeFileSync(this.peersFile, JSON.stringify(this.peers.slice(0, 200), null, 2) + '\n', 'utf8')
    } catch {
      // ignore
    }
  }

  notePeer(record) {
    try {
      const key = record.scope + ':' + record.peerId
      const existing = this.peers.find((item) => item.key === key)
      const at = new Date().toISOString()
      if (existing) {
        existing.name = record.senderName || existing.name || ''
        existing.lastAt = at
        existing.count = (Number(existing.count) || 0) + 1
      } else {
        this.peers.unshift({ key, scope: record.scope, peerId: record.peerId, name: record.senderName || '', firstAt: at, lastAt: at, count: 1 })
      }
      this.peers.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0))
      this.savePeers()
    } catch {
      // ignore
    }
  }

  /** 群消息进来后反查群名，写回 peer 记录（失败就算了，不影响消息） */
  async refreshGroupName(groupId) {
    const key = 'group:' + groupId
    const peer = this.peers.find((item) => item.key === key)
    if (!peer || (peer.name && peer.name.trim() !== '') || this._groupNamePending.has(groupId)) return
    this._groupNamePending.add(groupId)
    try {
      const info = await this.groupInfo(groupId)
      const name = String((info && (info.groupName || info.name)) || '').trim()
      if (name !== '') {
        peer.name = name
        this.savePeers()
        this.emit({ type: 'peers-updated' })
      }
    } catch { /* ignore */ } finally {
      this._groupNamePending.delete(groupId)
    }
  }

  /** 改某个 QQ 会话在面板里的显示名（群/私聊映射不受影响）。 */
  renamePeer(key, name) {
    const target = this.peers.find((item) => item.key === key)
    if (!target) return false
    target.name = String(name || '').trim().slice(0, 40)
    this.savePeers()
    return true
  }

  listPeers(limit = 100) {
    return this.peers.slice(0, Math.max(1, Math.min(200, Number(limit) || 100)))
  }

  // ── 语音消息（收下来存档；解码需要外部工具，见配置 voiceDecodeCmd） ──────

  readVoices() {
    try {
      if (!existsSync(this.voiceIndexFile)) return []
      const parsed = JSON.parse(readFileSync(this.voiceIndexFile, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.file === 'string') : []
    } catch {
      return []
    }
  }

  saveVoices() {
    try {
      mkdirSync(this.voiceDir, { recursive: true })
      writeFileSync(this.voiceIndexFile, JSON.stringify(this.voices.slice(0, 200), null, 2) + '\n', 'utf8')
    } catch {
      // ignore
    }
  }

  listVoices(limit = 50) {
    return this.voices.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  /** 收消息时把语音附件落盘（silk 原文件；能不能播取决于外部解码工具）。 */
  async captureVoices(data) {
    const saved = []
    const attachments = Array.isArray(data.attachments) ? data.attachments : []
    for (const item of attachments.slice(0, 2)) {
      try {
        const url = typeof item.url === 'string' ? item.url : ''
        if (!/^https?:\/\//.test(url) || !isVoiceAttachment(item)) continue
        if (this.voices.some((voice) => voice.source === url)) continue
        const response = await fetch(url)
        if (!response.ok) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) continue
        mkdirSync(this.voiceDir, { recursive: true })
        const file = 'qq_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 6) + '.silk'
        writeFileSync(join(this.voiceDir, file), bytes)
        this.voices.unshift({ id: 'vd_' + Math.random().toString(16).slice(2, 10), file, source: url, from: String((data.author && (data.author.username || data.author.member_openid)) || ''), at: new Date().toISOString(), bytes: bytes.length })
        this.saveVoices()
        saved.push({ path: join(this.voiceDir, file), voiceId: this.voices[0].id, bytes: bytes.length })
        this.emit({ type: 'voice', voice: this.voices[0] })
      } catch {
        // 单条失败不影响消息
      }
    }
    return saved
  }

  // ── SILK → WAV（给宿主本地语音转写 SenseVoice 用） ─────────────────────────

  /** 找到 silk-wasm（profile 里通常有；也支持配置 silkWasmEntry 覆盖）。 */
  async silkModule() {
    if (this._silkModule) return this._silkModule
    const { pathToFileURL } = await import('node:url')
    const candidates = []
    if (typeof this.config.silkWasmEntry === 'string' && this.config.silkWasmEntry.trim() !== '') candidates.push(this.config.silkWasmEntry.trim())
    candidates.push(join(PLUGIN_DIR, 'vendor', 'node_modules', 'silk-wasm', 'lib', 'index.mjs'))
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home !== '') {
      try {
        const { readdirSync } = await import('node:fs')
        for (const profile of readdirSync(join(home, 'profiles'))) {
          candidates.push(join(home, 'profiles', profile, 'node_modules', 'silk-wasm', 'lib', 'index.mjs'))
        }
      } catch { /* ignore */ }
    }
    for (const candidate of candidates) {
      try {
        this._silkModule = await import(pathToFileURL(candidate).href)
        return this._silkModule
      } catch { /* 继续试下一个 */ }
    }
    try {
      this._silkModule = await import('silk-wasm')
      return this._silkModule
    } catch {
      throw new Error('找不到 silk-wasm：请把 qq-bot.json 的 silkWasmEntry 指向 silk-wasm/lib/index.mjs')
    }
  }

  /** SILK 字节 → WAV（16bit 单声道）。 */
  async silkToWav(silkBytes) {
    const mod = await this.silkModule()
    const decode = mod.decode || (mod.default && mod.default.decode)
    if (typeof decode !== 'function') throw new Error('silk-wasm 里没有 decode()')
    const input = silkBytes instanceof Uint8Array ? silkBytes : new Uint8Array(silkBytes)
    let lastError = null
    for (const rate of [16000, 24000, 12000, 8000]) {
      try {
        const decoded = await decode(input, rate)
        const pcm = Buffer.from(decoded.data)
        const channels = 1
        const bits = 16
        const dataSize = pcm.length
        const header = Buffer.alloc(44)
        header.write('RIFF', 0)
        header.writeUInt32LE(36 + dataSize, 4)
        header.write('WAVE', 8)
        header.write('fmt ', 12)
        header.writeUInt32LE(16, 16)
        header.writeUInt16LE(1, 20)
        header.writeUInt16LE(channels, 22)
        header.writeUInt32LE(rate, 24)
        header.writeUInt32LE(rate * channels * bits / 8, 28)
        header.writeUInt16LE(channels * bits / 8, 32)
        header.writeUInt16LE(bits, 34)
        header.write('data', 36)
        header.writeUInt32LE(dataSize, 40)
        return { wav: Buffer.concat([header, pcm]), rate, ms: decoded.duration }
      } catch (error) {
        lastError = error
      }
    }
    throw new Error('SILK 解码失败：' + String((lastError && lastError.message) || lastError).slice(0, 120))
  }

  // ── 表情包视觉打标（可选：走配置里的外部命令；不配就报错说明） ──────────────

  tagSticker(stickerId) {
    const sticker = this.stickers.find((item) => item.id === stickerId)
    if (!sticker) throw new Error('找不到这张表情包：' + stickerId)
    const cmd = String(this.config.stickerTaggerCmd || '').trim()
    if (cmd === '') throw new Error('还没有配置打标命令：在 qq-bot.json 里设 stickerTaggerCmd（例如 "python tag.py --file {file}"），stdout 输出 {"tags":["开心"],"caption":"..."}')
    const file = join(this.stickerDir, sticker.file)
    if (!existsSync(file)) throw new Error('表情包文件不见了：' + sticker.file)
    const parts = cmd.replace(/\{file\}/g, '"' + file + '"').match(/("[^"]*"|\S+)/g) || []
    const argv = parts.map((part) => part.replace(/^"|"$/g, ''))
    const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000, windowsHide: true })
    let parsed = null
    try {
      parsed = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop())
    } catch {
      throw new Error('打标命令的输出不是 JSON：' + String(stdout).slice(0, 160))
    }
    const tags = Array.isArray(parsed && parsed.tags) ? parsed.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8) : []
    const caption = parsed && typeof parsed.caption === 'string' ? parsed.caption.trim().slice(0, 120) : ''
    sticker.tags = tags
    sticker.caption = caption
    sticker.taggedAt = new Date().toISOString()
    this.saveStickers()
    return sticker
  }

  // ── 私聊流式消息（QQ 只对 c2c 开放 stream_messages） ───────────────────────

  /**
   * 打开一个 c2c 流式会话：start(text) → update(fullText)… → done(finalText)。
   * 直接用官方协议：POST /v2/users/{openid}/stream_messages
   *   {input_mode:'replace', input_state:1|10, content_type:'markdown', content_raw, event_id, msg_id, msg_seq, index, stream_msg_id?}
   */
  openStream(input = {}) {
    if (input.scope !== 'c2c' && input.scope !== undefined) throw new Error('流式消息只支持私聊（QQ 官方限制）')
    const targetId = String(input.targetId || '').trim()
    const msgId = String(input.msgId || '').trim()
    if (targetId === '' || msgId === '') throw new Error('流式消息需要 targetId 和 msgId（来自入站消息）')
    const state = { targetId, msgId, msgSeq: (this._msgSeq = (this._msgSeq || 0) + 1), index: 0, streamMsgId: '' }
    const send = async (text, stateCode) => {
      const body = {
        input_mode: 'replace',
        input_state: stateCode,
        content_type: 'markdown',
        content_raw: String(text || ''),
        event_id: msgId,
        msg_id: msgId,
        msg_seq: state.msgSeq,
        index: state.index++,
      }
      if (state.streamMsgId !== '') body.stream_msg_id = state.streamMsgId
      const response = await this.apiRequest('/v2/users/' + encodeURIComponent(targetId) + '/stream_messages', { method: 'POST', body: JSON.stringify(body) })
      if (response && response.id && state.streamMsgId === '') state.streamMsgId = String(response.id)
      return { ok: true, streamMsgId: state.streamMsgId, index: state.index }
    }
    return {
      update: (text) => send(text, 1),
      done: (text) => send(text, 10),
    }
  }

  // ── 表情包发送（官方富媒体：先传 /files 拿 file_info，再发 msg_type=7） ──

  /**
   * 发一张库里的表情包。带 msgId = 被动回复（5 分钟内最稳），不带就是主动消息。
   * 协议（照官方 SDK 核对过）：POST /v2/{groups|users}/{id}/files {file_type:1, file_data:base64} → file_info
   *                          POST /v2/{groups|users}/{id}/messages {msg_type:7, media:{file_info}, msg_seq, msg_id?}
   */
  async sendSticker(input = {}) {
    const sticker = this.stickers.find((item) => item.id === input.stickerId)
    if (!sticker) throw new Error('找不到这张表情包：' + input.stickerId)
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const targetId = String(input.targetId || '').trim()
    if (targetId === '') throw new Error('要发给谁？缺少 targetId')
    const file = join(this.stickerDir, sticker.file)
    if (!existsSync(file)) throw new Error('表情包文件不见了：' + sticker.file)
    const buffer = readFileSync(file)
    if (buffer.length === 0 || buffer.length > 9 * 1024 * 1024) throw new Error('表情包文件为空或超过 9MB')
    const base = scope === 'group' ? '/v2/groups/' : '/v2/users/'
    const target = encodeURIComponent(targetId)
    const upload = await this.apiRequest(base + target + '/files', {
      method: 'POST',
      body: JSON.stringify({ file_type: 1, srv_send_msg: false, file_data: buffer.toString('base64') }),
    })
    const fileInfo = upload && upload.file_info
    if (typeof fileInfo !== 'string' || fileInfo === '') throw new Error('上传表情包失败：' + JSON.stringify(upload).slice(0, 160))
    this._msgSeq = (this._msgSeq || 0) + 1
    const body = { msg_type: 7, media: { file_info: fileInfo }, msg_seq: this._msgSeq }
    if (typeof input.msgId === 'string' && input.msgId !== '') body.msg_id = input.msgId
    await this.apiRequest(base + target + '/messages', { method: 'POST', body: JSON.stringify(body) })
    return { ok: true, stickerId: sticker.id, scope, targetId }
  }

  /** 手动发一张：目标默认最近收到消息的会话（带 msg_id 当被动回复）。 */
  async sendStickerToLatest(input = {}) {
    const latest = this.recent[0] || null
    if (!latest) throw new Error('还没有收到过消息，不知道该发给谁')
    return this.sendSticker({
      stickerId: input.stickerId,
      scope: latest.scope,
      targetId: latest.peerId,
      msgId: latest.id,
    })
  }

  /** 自动丢表情包：有消息进来时按冷却和频率闸门随机挑一张回过去。 */
  async maybeAutoSticker(record) {
    const cfg = this.config.autoSticker || {}
    if (cfg.enabled !== true || this.stickers.length === 0 || this.connected !== true) return null
    const now = Date.now()
    const gapMs = Math.max(1, Number(cfg.minGapMinutes) || 10) * 60000
    if (now - (this.lastAutoStickerAt || 0) < gapMs) return null
    const hourAgo = now - 3600000
    this.autoStickerTimes = (this.autoStickerTimes || []).filter((at) => at > hourAgo)
    if (this.autoStickerTimes.length >= (Number(cfg.maxPerHour) || 6)) return null
    const dayAgo = now - 24 * 3600000
    const fresh = this.stickers.filter((item) => !item.lastUsedAt || Date.parse(item.lastUsedAt) < dayAgo)
    const pool = fresh.length > 0 ? fresh : this.stickers
    const sticker = pool[Math.floor(Math.random() * pool.length)]
    if (!sticker) return null
    this.lastAutoStickerAt = now
    this.autoStickerTimes.push(now)
    sticker.lastUsedAt = new Date(now).toISOString()
    this.saveStickers()
    try {
      await this.sendSticker({ stickerId: sticker.id, scope: record.scope, targetId: record.peerId, msgId: record.id })
      this.emit({ type: 'sticker-sent', sticker, messageId: record.id })
      return sticker
    } catch (error) {
      this.lastError = '自动发表情包失败：' + String(error && error.message ? error.message : error)
      return null
    }
  }

  // ── 定时消息（每天 HH:MM 自动发一条；不填 targetId 就发给最近聊过的会话） ────

  readSchedules() {
    try {
      if (!existsSync(this.scheduleFile)) return []
      const parsed = JSON.parse(readFileSync(this.scheduleFile, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.time === 'string') : []
    } catch {
      return []
    }
  }

  saveSchedules() {
    try {
      writeFileSync(this.scheduleFile, JSON.stringify(this.schedules.slice(0, 100), null, 2) + '\n', 'utf8')
    } catch {
      // ignore
    }
  }

  addSchedule(input = {}) {
    const time = String(input.time || '').trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间格式要 HH:MM，例如 09:30')
    const content = String(input.content || '').trim()
    if (content === '') throw new Error('要发的内容不能为空')
    const latest = this.recent[0] || null
    const weekdays = (Array.isArray(input.weekdays) ? input.weekdays : [])
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 7)
      .slice(0, 7)
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : ''
    const entry = {
      id: 'sc_' + Math.random().toString(16).slice(2, 10),
      time,
      content: content.slice(0, 500),
      scope: input.scope === 'c2c' ? 'c2c' : 'group',
      targetId: String(input.targetId || (latest ? latest.peerId : '')).trim(),
      // 不填 = 每天；weekdays = 只在星期几发（1=周一 … 7=周日）；date = 只在某天发一次
      weekdays,
      date,
      lastRunDay: '',
    }
    this.schedules.push(entry)
    this.saveSchedules()
    return entry
  }

  deleteSchedule(id) {
    const index = this.schedules.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到这条定时消息：' + id)
    const [removed] = this.schedules.splice(index, 1)
    this.saveSchedules()
    return removed
  }

  startScheduleTicker() {
    this.stopScheduleTicker()
    this.scheduleTimer = setInterval(() => {
      this.runDueSchedules().catch(() => {})
    }, 30000)
    if (typeof this.scheduleTimer.unref === 'function') this.scheduleTimer.unref()
  }

  stopScheduleTicker() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer)
      this.scheduleTimer = null
    }
  }

  async runDueSchedules(now = new Date()) {
    // 每天顺手清一次过期本地媒体（图片/语音）
    const pruneDay = now.toISOString().slice(0, 10)
    if (this.lastMediaPruneDay !== pruneDay) {
      this.lastMediaPruneDay = pruneDay
      try { this.pruneMedia(now) } catch { /* ignore */ }
    }
    if (!this.connected) return []
    const pad = (value) => String(value).padStart(2, '0')
    const clock = pad(now.getHours()) + ':' + pad(now.getMinutes())
    const day = now.toISOString().slice(0, 10)
    const sent = []
    const weekday = now.getDay() === 0 ? 7 : now.getDay()
    for (const item of this.schedules) {
      if (item.time !== clock || item.lastRunDay === day) continue
      if (item.targetId === '') continue
      if (item.date && item.date !== day) continue
      if (Array.isArray(item.weekdays) && item.weekdays.length > 0 && !item.weekdays.includes(weekday)) continue
      try {
        await this.sendText({ scope: item.scope, targetId: item.targetId, content: item.content })
        item.lastRunDay = day
        sent.push(item)
      } catch (error) {
        this.lastError = '定时消息发送失败：' + String(error && error.message ? error.message : error)
      }
    }
    if (sent.length > 0) this.saveSchedules()
    return sent
  }

  // ── 群管理 / 撤回（照官方接口，2026-10-31 从 dsh-qqbot 的实现核对端点后重写） ──

  /** 撤回消息（2 分钟内有效）。scope=group 走群，c2c 走私聊。 */
  async recallMessage(input = {}) {
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const targetId = String(input.targetId || '').trim()
    const messageId = String(input.messageId || '').trim()
    if (targetId === '' || messageId === '') throw new Error('撤回需要 targetId 和 messageId')
    const base = scope === 'group' ? '/v2/groups/' : '/v2/users/'
    await this.apiRequest(base + encodeURIComponent(targetId) + '/messages/' + encodeURIComponent(messageId), { method: 'DELETE' })
    return { ok: true, scope, targetId, messageId }
  }

  /** 查群基本信息（群名/人数；11255 = 群不存在或已注销）。 */
  async groupInfo(groupId) {
    const gid = String(groupId || '').trim()
    if (gid === '') throw new Error('要查哪个群？填群 openid')
    return this.apiRequest('/v2/groups/' + encodeURIComponent(gid) + '/info')
  }

  /**
   * 群成员禁言 / 解除（需要机器人是群管理员）。
   * 官方接口：POST /v2/groups/{gid}/restrict_chat_setting，body {members:[{op:'add'|'del', member_openid, mute_expire_at}]}。
   * 实测怪癖：add 一次只吃 1 个人（多个报 50015013），del 支持批量 —— 这里沿用逐条 add。
   * @param {object} input {groupId, memberOpenids: string[], minutes?: number, unmute?: boolean}
   */
  async setMemberMute(input = {}) {
    const gid = String(input.groupId || '').trim()
    const ids = (Array.isArray(input.memberOpenids) ? input.memberOpenids : [input.memberOpenids])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 20)
    if (gid === '' || ids.length === 0) throw new Error('禁言需要群 openid 和成员 openid')
    const url = '/v2/groups/' + encodeURIComponent(gid) + '/restrict_chat_setting'
    if (input.unmute === true) {
      await this.apiRequest(url, {
        method: 'POST',
        body: JSON.stringify({ members: ids.map((id) => ({ op: 'del', member_openid: id, mute_expire_at: '' })) }),
      })
      return { ok: true, unmuted: ids.length }
    }
    const minutes = Math.max(1, Math.min(43200, Number(input.minutes) || 10))
    const expire = new Date(Date.now() + minutes * 60000).toISOString()
    for (const id of ids) {
      await this.apiRequest(url, {
        method: 'POST',
        body: JSON.stringify({ members: [{ op: 'add', member_openid: id, mute_expire_at: expire }] }),
      })
    }
    return { ok: true, muted: ids.length, minutes, until: expire }
  }

  /** 批量踢人（需要管理员；可顺带拉黑）。 */
  async removeMembers(input = {}) {
    const gid = String(input.groupId || '').trim()
    const ids = (Array.isArray(input.memberOpenids) ? input.memberOpenids : [input.memberOpenids])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 50)
    if (gid === '' || ids.length === 0) throw new Error('踢人需要群 openid 和成员 openid')
    await this.apiRequest('/v2/groups/' + encodeURIComponent(gid) + '/batch_remove_members', {
      method: 'POST',
      body: JSON.stringify({ member_openids: ids, add_to_member_blacklist: input.blacklist === true }),
    })
    return { ok: true, removed: ids.length }
  }

  /** 入群申请列表（机器人是管理员时可用）。 */
  async listJoinRequests(input = {}) {
    const gid = String(input.groupId || '').trim()
    if (gid === '') throw new Error('要查哪个群的入群申请？填群 openid')
    const params = new URLSearchParams()
    if (input.cursor) params.set('cursor', String(input.cursor))
    const qs = params.toString() ? '?' + params.toString() : ''
    return this.apiRequest('/v2/groups/' + encodeURIComponent(gid) + '/join_request_list' + qs)
  }

  /** 审批入群申请：op = approve | decline。 */
  async approveJoinRequest(input = {}) {
    const gid = String(input.groupId || '').trim()
    const member = String(input.memberOpenid || '').trim()
    const op = input.op === 'decline' ? 'decline' : 'approve'
    if (gid === '' || member === '') throw new Error('审批需要群 openid 和申请人 openid')
    const body = { op }
    if (op === 'decline' && typeof input.rejectReason === 'string' && input.rejectReason !== '') body.reject_reason = input.rejectReason
    if (input.blacklist === true) body.add_to_member_blacklist = true
    await this.apiRequest('/v2/groups/' + encodeURIComponent(gid) + '/approval_join_request/' + encodeURIComponent(member), {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return { ok: true, op, memberOpenid: member }
  }

  recentMessages(limit = 50) {
    return this.recent.slice(0, Math.max(1, Math.min(RECENT_MAX, Number(limit) || 50)))
  }
}
