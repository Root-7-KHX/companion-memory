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

  const onSessionEvent = (session, event) => {
    try {
      const type = event && typeof event === 'object' ? event.type : undefined
      if (type !== 'user/message' && type !== 'assistant/message') return
      const sessionId = sessionIdOf(session, messageOf(event))
      const store = storeOf(sessionId)
      if (!store) return
      if (type === 'user/message') {
        count(store)
        packTurn(store)
        remember(store, 'user', session, messageOf(event))
      } else {
        remember(store, 'assistant', session, messageOf(event))
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
