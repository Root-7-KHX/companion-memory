/**
 * onebot.js —— OneBot v11 传输层（混入 QqBot），让 AI记忆 的 QQ 接入既能走官方机器人，
 * 也能走 NapCat / LLOneBot 这类协议端（个人号）。
 *
 * 连接方式：**正向 WebSocket**（NapCat 开 websocketServers，插件当客户端连过去），
 *   · 只用 Node 自带的全局 WebSocket（Node ≥ 22），不装任何依赖；
 *   · 入站：post_type=message 的 private / group 消息 → 转成和官方机器人一样的 record 形状；
 *   · 出站：send_private_msg / send_group_msg，消息用 array 格式（text / reply / image）；
 *   · 请求-响应：每个 action 带 echo，回来按 echo 结算 Promise，超时 20 秒。
 *
 * 配置存 {数据根}/qq-bot.json：
 *   { transport: 'official' | 'onebot',
 *     onebot: { url: 'ws://127.0.0.1:6198', token: '', requireMention: true } }
 *
 * 说明：群聊默认和官方机器人行为一致——**只有 @ 机器人 才处理**（requireMention=false 可关）。
 * 语音/卡片/按钮这类官方富媒体能力在 OneBot 模式下降级：语音只记条数、卡片退化成文本。
 */

const ONEBOT_DEFAULT_URL = 'ws://127.0.0.1:6198'
const ONEBOT_CALL_TIMEOUT_MS = 20000
const ONEBOT_IMAGE_LIMIT = 9
const ONEBOT_IMAGE_TIMEOUT_MS = 20000

function obText(value) {
  return value === null || value === undefined ? '' : String(value)
}

function obNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 把 OneBot array 格式的 message 转成给人看的纯文本（图片/语音等只留占位）。 */
function obSegmentsToText(segments) {
  let out = ''
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = obText(seg && seg.type)
    const data = (seg && seg.data) || {}
    if (type === 'text') {
      out += obText(data.text)
    } else if (type === 'at') {
      const qq = obText(data.qq)
      const name = obText(data.name)
      out += ' @' + (qq === 'all' ? '全体成员' : name !== '' ? name : qq) + ' '
    } else if (type === 'face') {
      out += ' [表情] '
    } else if (type === 'mface') {
      out += ' [表情] '
    } else if (type === 'image') {
      out += ' [图片] '
    } else if (type === 'record') {
      out += ' [语音] '
    } else if (type === 'video') {
      out += ' [视频] '
    } else if (type === 'file') {
      out += ' [文件] '
    } else if (type === 'reply') {
      // 引用内容不重复抄一遍
    } else if (type === 'forward') {
      out += ' [合并转发] '
    }
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

function obImageExt(url) {
  try {
    const path = new URL(url).pathname.toLowerCase()
    const match = path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/)
    if (match) return match[1] === 'jpeg' ? 'jpg' : match[1]
  } catch { /* ignore */ }
  return 'jpg'
}

export const oneBotMethods = {
  // ── 配置 ────────────────────────────────────────────────────────────────

  /** 个人号通道是否开启。 */
  obTransport() {
    if (this.config.channels && typeof this.config.channels === 'object') return this.config.channels.onebot === true
    return this.config.transport === 'onebot'
  },

  /** 这条出站消息走哪条通道：显式 channel > 该 peer 最近一条入站的 channel > 唯一开启的通道 > 官方。 */
  sendChannel(input = {}) {
    const explicit = String(input.channel || '')
    if (explicit === 'official' || explicit === 'onebot') return explicit
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const target = String(input.targetId || '')
    const hit = (this.recent || []).find((item) => item.scope === scope && String(item.peerId) === target && (item.channel === 'official' || item.channel === 'onebot'))
    if (hit) return hit.channel
    const channels = this.config.channels && typeof this.config.channels === 'object' ? this.config.channels : {}
    if (channels.onebot === true && channels.official !== true) return 'onebot'
    return 'official'
  },

  /** 是否已经填了地址（面板用来判断「已配置」）。 */
  obConfigured() {
    const cfg = this.config.onebot && typeof this.config.onebot === 'object' ? this.config.onebot : {}
    return obText(cfg.url).trim() !== ''
  },

  /** 带 token 的 ws 地址（token 走 query，NapCat 认这个）。 */
  obUrl() {
    const cfg = this.config.onebot && typeof this.config.onebot === 'object' ? this.config.onebot : {}
    let url = obText(cfg.url).trim() || ONEBOT_DEFAULT_URL
    const token = obText(cfg.token).trim()
    if (token !== '' && !/[?&]access_token=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token)
    }
    return url
  },

  // ── 连接 ────────────────────────────────────────────────────────────────

  /**
   * 连协议端（正向 WS）。open 就算连上；断线交给 scheduleReconnect。
   * @returns {Promise<boolean>} 首连是否成功（失败返回 false，不抛）。
   */
  obConnect() {
    // 先关掉旧连接：重复连接会让同一条消息被收到多次（表现为重复回复/串会话）
    try { this.obDispose() } catch { /* ignore */ }
    return new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let socket
      try {
        socket = new WebSocket(this.obUrl())
      } catch (error) {
        this.lastError = 'OneBot 连接失败：' + String(error && error.message ? error.message : error)
        this.obStatus = 'error'
        this.scheduleReconnect('onebot')
        settle(false)
        return
      }
      this.obSocket = socket
      if (!(this._obPending instanceof Map)) this._obPending = new Map()
      socket.addEventListener('open', () => {
        // 只用 obStatus 记个人号通道自己的状态：官方通道的 this.status 不能被一条 OneBot 连接覆盖
        this.obStatus = 'online'
        this.obConnected = true
        this.lastError = ''
        this.obReconnectDelay = 2000
        this.startScheduleTicker()
        settle(true)
        this.emit({ type: 'ready', botName: this.botName || '' })
        this.obSelfInfo().catch(() => {})
      })
      socket.addEventListener('message', (event) => {
        let payload = null
        try {
          payload = JSON.parse(String(event.data))
        } catch {
          return
        }
        this.obHandlePayload(payload)
      })
      socket.addEventListener('error', () => {
        this.obStatus = 'error'
        this.lastError = 'OneBot WebSocket 连接错误'
      })
      socket.addEventListener('close', () => {
        const wasConnected = this.obConnected === true
        this.obConnected = false
        this.obSocket = null
        // 个人号断开只重连自己这条：scheduleReconnect('onebot') 不会碰官方 WS
        this.obStatus = this.stopped ? 'stopped' : 'reconnecting'
        this.obRejectPending('OneBot 连接已断开')
        if (!this.stopped) {
          this.scheduleReconnect('onebot')
        } else if (wasConnected) {
          this.obStatus = 'stopped'
        }
        settle(false)
      })
    })
  },

  obDispose() {
    try {
      if (this.obSocket) this.obSocket.close()
    } catch {
      // ignore
    }
    this.obSocket = null
    this.obConnected = false
    this.obStatus = 'stopped'
    this.obRejectPending('已停止')
  },

  obRejectPending(reason) {
    if (!(this._obPending instanceof Map)) return
    for (const entry of this._obPending.values()) {
      try {
        entry.reject(new Error(reason))
      } catch { /* ignore */ }
    }
    this._obPending.clear()
  },

  /** 发一个 OneBot action 并等 echo 回来。 */
  obSend(action, params = {}, timeoutMs = ONEBOT_CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = this.obSocket
      if (!socket || socket.readyState !== 1) {
        reject(new Error('OneBot 还没连上'))
        return
      }
      if (!(this._obPending instanceof Map)) this._obPending = new Map()
      const echo = 'ob-' + (++this._obSeq)
      const timer = setTimeout(() => {
        this._obPending.delete(echo)
        reject(new Error('OneBot 调用超时：' + action))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this._obPending.set(echo, {
        resolve: (data) => {
          clearTimeout(timer)
          resolve(data)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this._obPending.delete(echo)
        clearTimeout(timer)
        reject(error)
      }
    })
  },

  async obSelfInfo() {
    try {
      const info = await this.obSend('get_login_info')
      const selfId = obText(info && info.user_id)
      if (selfId !== '') this.selfId = selfId
      const name = obText(info && info.nickname)
      if (name !== '') this.botName = name
    } catch { /* ignore */ }
  },

  // ── 入站 ────────────────────────────────────────────────────────────────

  obHandlePayload(payload) {
    if (!payload || typeof payload !== 'object') return
    // ① action 的响应：按 echo 结算
    const echo = obText(payload.echo)
    if (echo !== '' && this._obPending instanceof Map && this._obPending.has(echo)) {
      const entry = this._obPending.get(echo)
      this._obPending.delete(echo)
      const retcode = payload.retcode
      if (payload.status === 'failed' || (retcode !== undefined && retcode !== 0)) {
        entry.reject(new Error('OneBot 返回失败：' + obText(payload.message || payload.wording || retcode)))
      } else {
        entry.resolve(payload.data !== undefined ? payload.data : payload)
      }
      return
    }
    // ② 生命周期：拿到自己的 QQ 号
    if (payload.post_type === 'meta_event') {
      if (payload.meta_event_type === 'lifecycle' && payload.self_id) {
        this.selfId = obText(payload.self_id)
      }
      return
    }
    // ③ 消息事件（message_sent 是机器人自己发的，忽略，避免自问自答）
    if (payload.post_type === 'message' && payload.message_type !== undefined) {
      this.obHandleMessage(payload).catch((error) => {
        this.lastError = 'OneBot 收消息失败：' + String(error && error.message ? error.message : error)
      })
    }
    if (payload.post_type === 'notice') {
      this.obHandleNotice(payload)
    }
  },

  obHandleNotice(payload) {
    try {
      const type = obText(payload.notice_type)
      const selfId = obText(this.selfId || payload.self_id)
      if (type === 'group_recall' || type === 'friend_recall') return
      if (type === 'group_increase' && obText(payload.user_id) === selfId) {
        this.emit({ type: 'peers-updated' })
      }
    } catch { /* ignore */ }
  },

  async obHandleMessage(payload) {
    // QQ 接入总开关关着的时候，即使还有残影事件也不处理（不路由、不记消息）。
    if (this.config.enabled !== true) return
    const messageType = obText(payload.message_type)
    const scope = messageType === 'group' ? 'group' : 'c2c'
    const segments = Array.isArray(payload.message) ? payload.message : []
    const selfId = obText(this.selfId || payload.self_id)
    const senderId = obText(payload.user_id)
    if (senderId !== '' && senderId === selfId) return
    const cfg = this.config.onebot && typeof this.config.onebot === 'object' ? this.config.onebot : {}
    const atSelf = segments.some((seg) => obText(seg && seg.type) === 'at' && obText(seg && seg.data && seg.data.qq) === selfId)
    // 群聊默认「@ 了才回」，和官方机器人保持一致；requireMention=false 才处理所有群消息
    if (scope === 'group' && cfg.requireMention !== false && !atSelf) return
    const sender = payload.sender && typeof payload.sender === 'object' ? payload.sender : {}
    const record = {
      id: obText(payload.message_id),
      channel: 'onebot',
      scope,
      peerId: scope === 'group' ? obText(payload.group_id) : obText(payload.user_id),
      senderId,
      senderName: obText(sender.card || sender.nickname),
      unionOpenid: '',
      content: obSegmentsToText(segments),
      imageCount: segments.filter((seg) => obText(seg && seg.type) === 'image').length,
      voiceCount: segments.filter((seg) => obText(seg && seg.type) === 'record').length,
      at: new Date().toISOString(),
      rawAt: obNumber(payload.time) * 1000 || Date.now(),
    }
    if (record.peerId === '') return
    if (record.content === '' && record.senderId === '') return
    // 同一条消息（同一 message_id）只处理一次，防止多连接/重连时重复回复
    if (record.id !== '' && this.recent.some((item) => item.channel === 'onebot' && String(item.id) === record.id)) return
    // 图片落盘（桥接转发时要带给 AI）；失败不影响消息本身
    if (record.imageCount > 0) {
      try {
        const paths = await this.obDownloadImages(segments, record.id)
        if (paths.length > 0) record.imagePaths = paths
      } catch { /* ignore */ }
    }
    this.recent.unshift(record)
    if (this.recent.length > 200) this.recent.length = 200
    try {
      const { appendFileSync, mkdirSync } = await import('node:fs')
      mkdirSync(this.root, { recursive: true })
      appendFileSync(this.messagesFile, JSON.stringify(record) + '\n', 'utf8')
    } catch { /* ignore */ }
    this.notePeer(record)
    if (record.scope === 'group' && record.peerId !== '') {
      this.refreshGroupName(record.peerId).catch(() => {})
    }
    try {
      this.maybeAutoSticker(record).catch(() => {})
    } catch { /* ignore */ }
    this.emit({ type: 'message', message: record })
  },

  /** 下载 OneBot 消息里的图片到本地 {数据根}/qq-images，返回本地路径。 */
  async obDownloadImages(segments, messageId) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = this.imageDir
    mkdirSync(dir, { recursive: true })
    const paths = []
    const images = (Array.isArray(segments) ? segments : []).filter((seg) => obText(seg && seg.type) === 'image').slice(0, ONEBOT_IMAGE_LIMIT)
    for (let index = 0; index < images.length; index += 1) {
      const data = (images[index] && images[index].data) || {}
      const url = obText(data.url || data.file)
      if (!/^https?:\/\//i.test(url)) continue
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(ONEBOT_IMAGE_TIMEOUT_MS) })
        if (!response.ok) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) continue
        const name = 'ob-' + obText(messageId || Date.now()) + '-' + index + '.' + obImageExt(url)
        const file = join(dir, name.replace(/[\\/:*?"<>|]/g, '_'))
        writeFileSync(file, buffer)
        paths.push(file)
      } catch { /* 单张失败不影响其它 */ }
    }
    return paths
  },

  // ── 出站 ────────────────────────────────────────────────────────────────

  /** 组 OneBot array 消息：可选引用 + 文本 + 可选图片文件。 */
  obBuildMessage(input = {}) {
    const message = []
    const replyId = obText(input.quoteMessageId || input.msgId).trim()
    if (replyId !== '') message.push({ type: 'reply', data: { id: replyId } })
    const content = obText(input.content).trim()
    if (content !== '') message.push({ type: 'text', data: { text: content } })
    const file = obText(input.file).trim()
    if (file !== '') {
      const normalized = file.replace(/\\/g, '/')
      const uri = /^(https?:|file:|base64:)/i.test(normalized) ? normalized : 'file:///' + normalized
      message.push({ type: 'image', data: { file: uri } })
    }
    return message
  },

  async obSendMessage(input = {}) {
    const scope = input.scope === 'c2c' ? 'c2c' : 'group'
    const targetId = obText(input.targetId).trim()
    const message = this.obBuildMessage(input)
    if (targetId === '' || message.length === 0) throw new Error('发消息需要 targetId 和 content')
    const action = scope === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = scope === 'group'
      ? { group_id: obNumber(targetId), message }
      : { user_id: obNumber(targetId), message }
    const data = await this.obSend(action, params)
    return { ok: true, scope, targetId, id: obText(data && data.message_id) }
  },

  /** 撤回（OneBot 的 delete_msg）。 */
  async obRecall(input = {}) {
    const messageId = obText(input.messageId || input.id).trim()
    if (messageId === '') throw new Error('撤回需要 messageId')
    await this.obSend('delete_msg', { message_id: obNumber(messageId) })
    return { ok: true, messageId }
  },

  /** 群信息：归一成和官方 groupInfo 一样的字段名（groupName / memberCount）。 */
  async obGroupInfo(groupId) {
    const gid = obText(groupId).trim()
    if (gid === '') throw new Error('要查哪个群？填群号')
    const data = await this.obSend('get_group_info', { group_id: obNumber(gid) })
    return {
      groupId: gid,
      groupName: obText(data && data.group_name),
      memberCount: obNumber(data && data.member_count),
      maxMemberCount: obNumber(data && data.max_member_count),
    }
  },

  /** 禁言 / 解除（OneBot 的 set_group_ban，单位秒）。 */
  async obSetMemberMute(input = {}) {
    const gid = obText(input.groupId).trim()
    const ids = (Array.isArray(input.memberOpenids) ? input.memberOpenids : [input.memberOpenids])
      .map((item) => obText(item).trim())
      .filter(Boolean)
      .slice(0, 20)
    if (gid === '' || ids.length === 0) throw new Error('禁言需要群号和成员 QQ 号')
    const seconds = input.unmute === true ? 0 : Math.max(1, Math.min(43200, Number(input.minutes) || 10)) * 60
    for (const id of ids) {
      await this.obSend('set_group_ban', { group_id: obNumber(gid), user_id: obNumber(id), duration: seconds })
    }
    return { ok: true, muted: input.unmute === true ? 0 : ids.length, unmuted: input.unmute === true ? ids.length : 0, seconds }
  },

  /** 踢人（OneBot 的 set_group_kick）。 */
  async obRemoveMembers(input = {}) {
    const gid = obText(input.groupId).trim()
    const ids = (Array.isArray(input.memberOpenids) ? input.memberOpenids : [input.memberOpenids])
      .map((item) => obText(item).trim())
      .filter(Boolean)
      .slice(0, 50)
    if (gid === '' || ids.length === 0) throw new Error('踢人需要群号和成员 QQ 号')
    for (const id of ids) {
      await this.obSend('set_group_kick', { group_id: obNumber(gid), user_id: obNumber(id), reject_add_request: input.blacklist === true })
    }
    return { ok: true, removed: ids.length }
  },
}



