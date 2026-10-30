/**
 * Conversation tracking: which conversation is active, interaction days, the
 * 48-hour hot window and the configurable auto-pack counter.
 *
 * Each conversation owns its own data set, so every write is routed through the
 * manager to the session that produced the event. Disabled conversations are
 * completely ignored, which keeps the plugin invisible until the user turns it
 * on for a conversation.
 *
 * The optional diagnostics log is bounded: once it grows past 64 KiB it is
 * rotated to a single header line.
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 64 * 1024

/** Pull the plain text out of a message payload (string, content blocks, or envelope). */
function extractText(value, options = {}) {
  const includeReasoning = options.includeReasoning === true
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const parts = []
    for (const block of value) {
      if (!block || typeof block !== 'object') continue
      if (typeof block.text !== 'string') continue
      const type = block.type
      if (type === 'text' || type === 'output_text' || type === 'input_text' || type === undefined) parts.push(block.text)
      else if (includeReasoning && type === 'reasoning') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim()
    if (value.content !== undefined) return extractText(value.content, options)
  }
  return ''
}

/** Harness-injected runtime metadata is not conversation and must not pollute the hot window. */
function isNoise(text) {
  return /^Time sampled while preparing turn/.test(text) || /^Browser time zone for this request/.test(text)
}

function messageOf(event) {
  const data = event && typeof event === 'object' ? event.data : undefined
  if (!data || typeof data !== 'object') return null
  if (data.message && typeof data.message === 'object') return data.message
  return data
}

function sessionIdOf(session, message) {
  for (const candidate of [session?.id, session?.sessionId, session?.key, message?.sessionId]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

export function registerTracking(ctx, manager) {
  if (typeof ctx.on !== 'function') return () => {}

  const log = (label, detail) => {
    try {
      const file = join(manager.root, 'debug-events.log')
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      if (size > MAX_LOG_BYTES) writeFileSync(file, `# companion-memory event log (rotated at ${new Date().toISOString()})\n`, 'utf8')
      appendFileSync(file, `${new Date().toISOString()} ${label} ${detail ?? ''}\n`, 'utf8')
    } catch {
      // diagnostics must never break the session
    }
  }

  const storeOf = (sessionId) => {
    if (!sessionId || !manager.isEnabled(sessionId)) return null
    return manager.storeFor(sessionId)
  }

  const count = (store) => {
    try {
      store.noteUserActivity()
    } catch (error) {
      log('count-failed', String(error && error.message))
    }
  }

  const remember = (store, role, session, message) => {
    try {
      const raw = message?.content ?? message
      const text = extractText(raw, { includeReasoning: role === 'user' })
      if (text === '' || isNoise(text)) return
      store.recordRecent({ role, text, sessionId: sessionIdOf(session, message) })
      // 用户反复问同一件事时，达到阈值会自动写进全局活跃记忆（「常问」标签）。
      if (role === 'user') {
        try {
          store.noteUserQuestion(text)
        } catch (error) {
          log('recurring-failed', String(error && error.message))
        }
      }
    } catch (error) {
      log(`recent-failed:${role}`, String(error && error.stack ? error.stack.split('\n')[0] : error))
    }
  }

  const packTurn = (store) => {
    try {
      store.noteDialogueTurn()
    } catch (error) {
      log('autopack-failed', String(error && error.message))
    }
  }

  /**
   * Multi-person conversations: if a message starts with "[名字]"/"【名字】" or
   * "已知名字：" and that name is a registered speaker, switch the current
   * speaker before the prompt for this turn is assembled. Unknown names are
   * left to the model (it can register them with the `speaker` action), so a
   * single-person chat never changes behavior.
   */
  const detectSpeakerPrefix = (store, text) => {
    try {
      const trimmed = String(text ?? '').trimStart()
      if (trimmed === '') return
      let name = ''
      const bracket = /^[[【]([^\]】\n]{1,16})[\]】]\s*[:：,，]?\s*/.exec(trimmed)
      if (bracket) name = bracket[1].trim()
      if (name === '') {
        const plain = /^([\u4e00-\u9fa5A-Za-z0-9_]{1,8})\s*[:：]\s*/.exec(trimmed)
        if (plain) name = plain[1].trim()
      }
      if (name === '') return
      const target = store.speakerById(name)
      if (!target) return
      if (store.state.currentSpeaker !== target.id) {
        store.switchSpeaker(target.id)
        log('speaker-switch', `prefix -> ${target.name}`)
      }
    } catch (error) {
      log('speaker-detect-failed', String(error && error.message))
    }
  }

  const pendingUserText = new Map()
  const passiveBusy = new Set()
  const getLlm = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    } catch {
      return undefined
    }
  }

  const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  /** True when this turn still has no recorded memory write. */
  const needsAutoRecord = (store, sessionId) => {
    const pending = pendingUserText.get(sessionId)
    if (!pending) return null
    const lastRecorded = Date.parse(store.state.lastRecordedAt ?? '') || 0
    if (lastRecorded >= pending.at) return null
    return pending
  }

  /** Minimal fallback: one plain流水 summary, no model call. */
  const basicAutoRecord = (store, sessionId, assistantText) => {
    try {
      const pending = needsAutoRecord(store, sessionId)
      if (!pending || typeof assistantText !== 'string' || assistantText.trim() === '') return false
      const summary = `用户：${clip(pending.text, 60)}｜角色：${clip(assistantText, 60)}`
      store.recordTurn({ minorSummary: summary, turnSummary: '（系统兜底记录：AI 本轮未调用 turn_end）' })
      log('auto-turn-record', sessionId)
      return true
    } catch (error) {
      log('auto-turn-record-failed', String(error && error.message))
      return false
    }
  }

  const PASSIVE_PROMPT_HEAD = [
    '你是「伴侣记忆」的自动记录器。下面是一轮对话（用户与角色）。请提取本轮值得记住的内容，严格只输出一个 JSON 对象：',
    '{"important":["..."],"minor_summary":"一句简短摘要","favorability":null 或 {"value":新好感度,"reason":"理由"}}',
    '规则：',
    '- important：只放真正值得长期记的原文（角色人设、双方约定、剧情关键节点、用户固定偏好），每轮最多 2 条，保持原文不改写；没有就空数组。',
    '- minor_summary：30 字以内的次要信息摘要（闲聊、日常、情绪变化）。',
    '- favorability：角色对用户（当前说话人）的新好感度，-100~100；只有剧情明确推动变化时才给，幅度小（一般 ±1~5）；没有变化给 null。',
    '- 不要输出 JSON 以外的任何文字。',
    '',
    '对话：',
  ].join('\n')

  /**
   * Passive turn_end: when the model skipped its own `turn_end`, make one small
   * side model call to extract important quotes + summary + favorability, then
   * write them exactly like the tool action. Falls back to a plain summary when
   * the call fails, so every turn is recorded either way.
   */
  const passiveTurnEnd = async (store, sessionId, session, assistantText) => {
    if (!store.passiveTurnEndEnabled || !store.passiveTurnEndEnabled()) return false
    if (passiveBusy.has(sessionId)) return false
    const pending = needsAutoRecord(store, sessionId)
    if (!pending || typeof assistantText !== 'string' || assistantText.trim() === '') return false
    const llm = getLlm()
    let config
    try {
      config = session?.requestHeader?.()?.config
    } catch {
      config = undefined
    }
    const provider = config && typeof config.provider === 'string' ? config.provider : ''
    const model = config && typeof config.model === 'string' ? config.model : ''
    if (!llm || typeof llm.stream !== 'function' || provider === '' || model === '') return false

    passiveBusy.add(sessionId)
    try {
      const prompt = `${PASSIVE_PROMPT_HEAD}用户：${clip(pending.text, 1500)}\n\n角色：${clip(assistantText, 1500)}`
      const options = {
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 900,
        sessionId: session?.id ?? sessionId,
        purpose: 'compaction',
        ...(config?.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      }
      let output = ''
      for await (const chunk of llm.stream(options)) {
        if (chunk && chunk.type === 'text-delta') output += String(chunk.text ?? '')
        else if (chunk && chunk.type === 'finish' && chunk.reason?.kind === 'error') return false
      }
      const start = output.indexOf('{')
      const end = output.lastIndexOf('}')
      if (start < 0 || end <= start) return false
      let parsed
      try {
        parsed = JSON.parse(output.slice(start, end + 1))
      } catch {
        return false
      }
      if (!parsed || typeof parsed !== 'object') return false
      const important = Array.isArray(parsed.important)
        ? parsed.important.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 3).map((text) => ({ text }))
        : []
      const minor = typeof parsed.minor_summary === 'string' ? parsed.minor_summary.trim() : ''
      const favour = parsed.favorability && Number.isFinite(Number(parsed.favorability.value)) && typeof parsed.favorability.reason === 'string' && parsed.favorability.reason.trim() !== ''
        ? { value: Math.max(-100, Math.min(100, Math.round(Number(parsed.favorability.value)))), reason: parsed.favorability.reason.trim().slice(0, 160) }
        : null
      if (important.length === 0 && minor === '' && favour === null) return false
      // Re-check right before writing: the model may have called turn_end meanwhile.
      if (!needsAutoRecord(store, sessionId)) return false
      store.recordTurn({ important, minorSummary: minor, favorability: favour ?? undefined })
      log('passive-turn-end', `${sessionId} important=${important.length} fav=${favour ? favour.value : 'null'}`)
      return true
    } catch (error) {
      log('passive-turn-end-failed', String(error && error.message))
      return false
    } finally {
      passiveBusy.delete(sessionId)
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      const type = event && typeof event === 'object' ? event.type : undefined
      if (type !== 'user/message' && type !== 'assistant/message') return
      // 上下文压缩产生的 surface 替换消息不是用户真实发言：不计交互日、不进热缓存。
      if (type === 'user/message' && event.sourceEventSeqs !== undefined) return
      const sessionId = sessionIdOf(session, messageOf(event))
      const store = storeOf(sessionId)
      if (!store) return
      if (type === 'user/message') {
        const message = messageOf(event)
        // runtime-context（宿主注入的「Current runtime context」等动态快照）不是用户发言：
        // 它每轮都会生成一条，混进热缓存会污染检索、还会被当成用户说的话。
        const sourceKind = message?.source && typeof message.source === 'object' ? message.source.kind : ''
        if (sourceKind === 'runtime-context') return
        const userText = extractText(message?.content ?? message, { includeReasoning: true })
        // 动态状态块（伴侣记忆自己注入的上下文）不是用户发言：不计交互日、不进热缓存、不触发记录。
        if (userText.trimStart().startsWith('【本轮动态状态')) return
        detectSpeakerPrefix(store, userText)
        if (userText !== '') {
          pendingUserText.set(sessionId, { text: userText, at: Date.now() })
          // 记下这一轮的用户消息时间：同一轮重复调用 turn_end 时靠它去重。
          try {
            store.noteUserMessage()
          } catch (error) {
            log('note-user-message-failed', String(error && error.message))
          }
        }
        count(store)
        packTurn(store)
        remember(store, 'user', session, messageOf(event))
      } else {
        remember(store, 'assistant', session, messageOf(event))
        const assistantText = extractText(messageOf(event)?.content ?? messageOf(event))
        if (typeof store.autoTurnRecordEnabled === 'function' && !store.autoTurnRecordEnabled()) return
        // Passive mode: extract with a side model call, fall back to a plain summary.
        passiveTurnEnd(store, sessionId, session, assistantText)
          .then((ok) => {
            if (!ok) basicAutoRecord(store, sessionId, assistantText)
          })
          .catch(() => basicAutoRecord(store, sessionId, assistantText))
      }
    } catch {
      // never let bookkeeping break a session
    }
  }

  // Track the most recently visible/active conversation for the sidebar panel.
  const onAdded = (summary) => {
    try {
      const sessionId = summary && (summary.sessionId ?? summary.header?.id)
      if (typeof sessionId === 'string' && sessionId !== '') manager.noteVisible(sessionId)
    } catch {
      // ignore
    }
  }
  const onActivity = (sessionId) => {
    try {
      if (typeof sessionId === 'string' && sessionId !== '') manager.noteVisible(sessionId)
    } catch {
      // ignore
    }
  }

  const disposers = []
  disposers.push(ctx.on('session/event', onSessionEvent))
  disposers.push(ctx.on('api-session/added', onAdded))
  disposers.push(ctx.on('api-session/activity', onActivity))

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // ignore
      }
    }
  }
}
