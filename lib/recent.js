/**
 * Recent conversation context (48-hour hot window).
 *
 * Every real user/assistant message of every session is appended to a small
 * local buffer. The buffer is the "context memory": while an exchange is less
 * than 48 hours old the model can search the ORIGINAL words; once it ages out it
 * is gone from the buffer and the only remaining trace is the knowledge base
 * (daily archives + periodic summaries), which is exactly the retrieval split
 * the sidebar documents ask for.
 *
 * The buffer is bounded both by time and by entry count, is persisted as a
 * single JSON file next to the other companion files, and never enters the
 * system prompt verbatim (only counts and routing rules are injected).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000
const MAX_ENTRIES = 400
const MAX_TEXT = 6000

function pad(value) {
  return String(value).padStart(2, '0')
}

export function formatRecentTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function tokenize(text) {
  const tokens = new Set()
  const lower = String(text ?? '').toLowerCase()
  const cjk = lower.match(/[\u3400-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
    if (run.length === 1) tokens.add(run)
  }
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word)
  return tokens
}

function snippetAround(text, tokens, width = 160) {
  const lower = text.toLowerCase()
  let hit = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0) {
      hit = index
      break
    }
  }
  if (hit < 0) return text.slice(0, width * 2)
  const start = Math.max(0, hit - Math.floor(width / 2))
  const stop = Math.min(text.length, hit + width)
  const prefix = start > 0 ? '…' : ''
  const suffix = stop < text.length ? '…' : ''
  return `${prefix}${text.slice(start, stop)}${suffix}`
}

export class RecentContext {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'recent.json')
    this.entries = []
    this.loaded = false
  }

  load(now = new Date()) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      this.entries = entries
        .filter((entry) => entry && typeof entry.ts === 'number' && typeof entry.text === 'string')
        .map((entry) => ({
          id: String(entry.id ?? ''),
          ts: entry.ts,
          role: entry.role === 'user' ? 'user' : 'assistant',
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          text: entry.text,
        }))
    } catch {
      this.entries = []
    }
    this.loaded = true
    this.prune(now)
    return this.entries.length
  }

  prune(now = new Date()) {
    const cutoff = now.getTime() - RECENT_WINDOW_MS
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => entry.ts >= cutoff)
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES)
    return before - this.entries.length
  }

  record(input, now = new Date()) {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (text === '') return null
    this.prune(now)
    const entry = {
      id: `msg_${Math.random().toString(16).slice(2, 10)}`,
      ts: now.getTime(),
      role: input.role === 'user' ? 'user' : 'assistant',
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES)
    return entry
  }

  persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: this.entries }), 'utf8')
      renameSync(temporary, this.file)
      return true
    } catch {
      // persistence must never break a conversation
      return false
    }
  }

  info(now = new Date()) {
    this.prune(now)
    const entries = this.entries
    const userCount = entries.filter((entry) => entry.role === 'user').length
    return {
      count: entries.length,
      userCount,
      assistantCount: entries.length - userCount,
      oldestAt: entries.length > 0 ? new Date(entries[0].ts).toISOString() : null,
      newestAt: entries.length > 0 ? new Date(entries[entries.length - 1].ts).toISOString() : null,
      windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
    }
  }

  search(query, limit = 6, now = new Date()) {
    this.prune(now)
    const trimmed = typeof query === 'string' ? query.trim() : ''
    const entries = this.entries
    if (trimmed === '' || entries.length === 0) {
      return { query: trimmed, total: entries.length, results: [] }
    }
    const queryTokens = tokenize(trimmed)
    if (queryTokens.size === 0) return { query: trimmed, total: entries.length, results: [] }

    const documents = entries.map((entry) => ({ entry, tokens: tokenize(entry.text) }))
    const df = new Map()
    for (const document of documents) {
      for (const token of new Set(document.tokens)) df.set(token, (df.get(token) ?? 0) + 1)
    }
    const scored = []
    for (const document of documents) {
      let score = 0
      for (const token of queryTokens) {
        if (!df.has(token)) continue
        let tf = 0
        for (const candidate of document.tokens) if (candidate === token) tf += 1
        if (tf === 0) continue
        score += (1 + Math.log(tf)) * Math.log(1 + documents.length / (1 + df.get(token)))
      }
      if (score <= 0) continue
      const ageMs = now.getTime() - document.entry.ts
      const recency = 1 + 0.15 * Math.max(0, 1 - ageMs / RECENT_WINDOW_MS)
      scored.push({ entry: document.entry, score: score * recency })
    }
    scored.sort((left, right) => right.score - left.score || right.entry.ts - left.entry.ts)

    const capped = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 6))
    return {
      query: trimmed,
      total: entries.length,
      results: scored.slice(0, capped).map(({ entry, score }) => ({
        id: entry.id,
        role: entry.role === 'user' ? '用户' : '角色',
        time: formatRecentTime(entry.ts),
        text: entry.text,
        snippet: snippetAround(entry.text, queryTokens),
        score: Number(score.toFixed(3)),
      })),
    }
  }

  read(id) {
    if (typeof id !== 'string' || id === '') return null
    return this.entries.find((entry) => entry.id === id) ?? null
  }
}

export function createRecentContext(dir) {
  return new RecentContext(dir)
}
