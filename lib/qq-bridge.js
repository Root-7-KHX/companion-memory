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
import { join } from 'node:path'

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function newCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
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
    this.outboxFile = join(manager.root, 'qq-outbox.jsonl')
  }

  /** 调试：把桥接关键步骤写进 qq-bridge-debug.log（出问题直接看文件）。 */
  dbg(...parts) {
    try {
      appendFileSync(this.debugFile, new Date().toISOString() + ' ' + parts.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ') + '\n', 'utf8')
    } catch { /* ignore */ }
  }

  readConfig() {
    try {
      if (!existsSync(this.file)) return { enabled: false, sessionId: '', approvalEnabled: false, approvalTimeoutMs: 120000, allowedPeers: [], peerSessions: {}, autoCreateSession: true, autoSessionCwd: '', autoSessionWorkspaceId: '' }
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
      }
    } catch {
      return { enabled: false, sessionId: '', approvalEnabled: false, approvalTimeoutMs: 120000, allowedPeers: [], peerSessions: {}, autoCreateSession: true, autoSessionCwd: '', autoSessionWorkspaceId: '' }
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
      pendingApprovals: this.pending.size,
      allowedPeers: Array.isArray(this.config.allowedPeers) ? [...this.config.allowedPeers] : [],
    }
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
  }

  stop() {
    try { this.flushReply() } catch { /* ignore */ }
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
    const who = record.scope === 'group' ? '群聊' : '私聊'
    const senderId = String(record.senderId || '')
    let name = record.senderName || senderId.slice(0, 12) || '某人'
    try {
      // 群聊/私聊同一个人：以稳定 openid 为准，用全局人物档案里的当前名字统一显示
      if (senderId !== '' && this.manager && typeof this.manager.people === 'function') {
        const registry = this.manager.people()
        const person = registry.get('qq', senderId)
        if (person && person.currentName) name = person.currentName
        else if (!person) registry.upsert({ platform: 'qq', externalId: senderId, name: record.senderName || '' })
      }
    } catch { /* 档案失败就用原来的名字 */ }
    const extras = []
    if (Number(record.imageCount) > 0) extras.push('（发来 ' + Number(record.imageCount) + ' 张图片/表情包）')
    for (const path of Array.isArray(record.imagePaths) ? record.imagePaths : []) {
      extras.push('[图片本地文件：' + path + ']')
    }
    // 语音：SILK → WAV → 声纹比对（本地 CAM++）+ 宿主本地 SenseVoice 转写；失败都带上原因，别静默丢
    const voicePaths = Array.isArray(record.voicePaths) ? record.voicePaths : []
    for (const [voiceIndex, path] of voicePaths.entries()) {
      let wavBuffer = null
      let voiceMs = 0
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
                extras.push('【声纹样本 ' + (3 - remaining) + '/3：' + saved.name + '】')
                await this.reply(record, '收到第 ' + (3 - remaining) + ' 条样本，再发 ' + remaining + ' 条。')
              } else {
                this.pendingVoiceprint = null
                extras.push('【声纹录好了：' + saved.name + '】')
                await this.reply(record, '✅ 录好了，3 条样本都收下了。以后你一说话我就能认出你。')
              }
            } else {
              const found = vp.identify(wavBuffer)
              this.dbg('voiceprint', JSON.stringify(found).slice(0, 200))
              const profileSeconds = vp.totalSeconds(found.name)
              const collectThreshold = profileSeconds < vp.config.freeEnrollSeconds
                ? 0
                : (profileSeconds >= vp.config.maxSeconds ? vp.config.autoCollectAboveWhenFull : vp.config.autoCollectAbove)
              if (!found.empty && found.score >= collectThreshold) {
                const collected = vp.addSample(found.name, found.embedding, { seconds: (Number(voiceMs) || 0) / 1000 })
                if (collected.added) extras.push('（声纹相似度高，已自动收录 1 条样本）')
              }
              if (found.empty) extras.push('【声纹：还没建档，发 /声纹 登记 就能认人】')
              else if (found.matched || (status.namesCount === 1 && found.score >= 0.45)) extras.push('【声纹：' + found.name + '（相似度 ' + found.score.toFixed(2) + '）——本人】')
              else extras.push('【声纹：最像 ' + found.name + '（相似度 ' + found.score.toFixed(2) + '，偏低）】')
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
        this.dbg('stt', 'text=' + JSON.stringify(speech), 'audioSeconds=' + (result && result.audioSeconds))
        if (speech !== '') {
          extras.push('【语音转写（' + Math.round((Number(voiceMs) || 0) / 1000) + '秒）：' + speech + '】')
          extras.push('（以上是本地语音转写，可能有同音字/错字；语义拿不准就先确认，别硬猜）')
        } else {
          extras.push('（发来语音，但转写为空）')
        }
      } catch (error) {
        extras.push('（发来语音，转写失败：' + String(error && error.message ? error.message : error).slice(0, 80) + '）')
      }
    }
    if (Number(record.voiceCount) > 0) extras.push('（发来语音，已存档）')
    const body = '【QQ ' + who + '｜' + name + (senderId !== '' ? '｜ID ' + senderId.slice(0, 10) : '') + '】' + (text.trim() === '' ? '' : text) + (extras.length ? ' ' + extras.join(' ') : '')
      + (extras.some((line) => line.startsWith('[图片本地文件')) ? '（看完图如果值得记，再用记忆工具选择性记下描述，别全存）' : '')
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
    const text = String(this.replyBuffer || '').trim()
    this.replyBuffer = ''
    this.replySessionId = ''
    const peer = (this.replySessionId && this.lastPeerBySession.get(this.replySessionId)) || this.lastPeer
    if (text === '' || !peer) return
    if (Date.now() - peer.at > 10 * 60000) return
    // 按换行拆成多条：AI 每换一行 = QQ 上单独发一条消息（一个气泡一句话）
    // 过滤纯内心独白/碎碎念（（……）这种），去重、限流，最多 3 条，避免 AI 复读时刷屏
    const rawLines = text.split(/\r?\n+/).map((line) => line.trim()).filter((line) => line !== '')
    const cleaned = rawLines.filter((line) => {
      const isParenOnly = /^[（(].*[)）]$/.test(line)
      if (isParenOnly && line.length <= 16) return false
      if (/^[。…\.\s（）()]+$/.test(line)) return false
      return true
    })
    const deduped = []
    const recent = Array.isArray(this.recentSent) ? this.recentSent : []
    for (const line of cleaned) {
      if (deduped.length > 0 && deduped[deduped.length - 1] === line) continue
      if (recent.includes(line)) continue
      deduped.push(line)
    }
    let lines = deduped.slice(0, 3)
    if (lines.length === 0) return
    this.recentSent = (Array.isArray(this.recentSent) ? this.recentSent : []).concat(lines).slice(-12)
    // 群聊：合并成 1 条气泡，但每句之间空一行；私聊保持一行一个气泡
    let outgoing = lines
    if (peer.scope === 'group') {
      outgoing = [lines.join('\n\n').slice(0, 1800)]
    }
    const sendNext = async (index) => {
      if (index >= outgoing.length) return
      const content = outgoing[index].slice(0, 1800)
      try {
        // 不带 quoteMessageId：否则 QQ 会把你那条消息引用成"评论框"
        await this.bot.sendTextWithQuote({ scope: peer.scope, targetId: peer.peerId, content, msgId: peer.msgId })
        this.dbg('sent', content.slice(0, 80))
      } catch (firstError) {
        this.dbg('passive-fail', 'msgId=' + String(peer.msgId || '').slice(0, 24), String((firstError && firstError.message) || firstError).slice(0, 200))
        // 被动回复失败时，退回主动消息再试一次
        let delivered = false
        try {
          await this.bot.sendTextWithQuote({ scope: peer.scope, targetId: peer.peerId, content })
          delivered = true
          this.dbg('sent-active', content.slice(0, 80))
        } catch (error) {
          this.dbg('send-fail', String((error && error.message) || firstError).slice(0, 160))
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
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data && event.data.message)
      if (text !== '') {
        this.dbg('outbound', 'len=' + text.length, text.slice(0, 120))
        this.queueReply(text, sessionId)
      }
      return
    }
    if (event.type === 'turn/end') this.flushReply()
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
