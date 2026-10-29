/**
 * Persistent store for the companion-memory plugin.
 *
 * Layout (all inside the plugin data directory):
 *   角色性格.md / 允许&禁止行为.md / 预设发言例句.md   ← sidebar-editable documents
 *   state.json                                        ← favorability, active memory, counters
 *   archive/YYYY-MM-DD.md                             ← date-grouped knowledge-base archive
 *   monthly/对话月度归档_第N周期_起始YYYY-MM-DD.md      ← 30-interaction-day packages
 *
 * Everything here uses synchronous fs on purpose: the payloads are small and the
 * operations are rare (a user message, a tool call, a panel save), and it keeps the
 * prompt-section renderer (which must be synchronous) trivially consistent.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { RecentContext } from './recent.js'

export const INTERACTION_MEMORY_LIMIT = 30
export const CYCLE_LENGTH = 30
export const SUMMARY_INTERVAL_MS = 48 * 60 * 60 * 1000

const ARCHIVE_ENTRY_KEEP = 5000

export const DOC_DEFS = [
  { key: 'personality', file: '角色性格.md', title: '角色性格' },
  { key: 'rules', file: '允许&禁止行为.md', title: '允许&禁止行为' },
  { key: 'examples', file: '预设发言例句.md', title: '预设发言例句' },
]

const DEFAULT_DOCS = {
  personality: `# 角色性格

> 在这里定义角色的基础性格、三观、说话语调、思考方式、喜好与雷区。
> 此文档优先级最高：每次对话开始前都会被自动读取，修改后立刻生效。

- 基础性格：
- 三观：
- 说话语调：
- 思考方式：
- 喜好：
- 雷区：
`,
  rules: `# 允许&禁止行为

> 在这里写清 AI 可以做的事、绝对不能做的事、行为边界。
> 角色的语气、态度、行为倾向会跟随好感度变化，但任何时候都不得越过这份清单。

## 允许
- 

## 禁止
- 

## 行为边界
- 
`,
  examples: `# 预设发言例句

> 在这里存放角色常用句式、口头禅、典型回应参考。

- 日常问候：
- 表达关心：
- 表达不满：
- 口头禅：
`,
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

export const DOC_SCHEMA = {
  personality: {
    layout: 'lines',
    intro: [
      '在这里定义角色的基础性格、三观、说话语调、思考方式、喜好与雷区。',
      '此文档优先级最高：每次对话开始前都会被自动读取，修改后立刻生效。',
    ],
    fields: [
      { key: 'base', label: '基础性格', placeholder: '例如：温柔、耐心，有点社恐，但谈起喜欢的事会滔滔不绝。' },
      { key: 'values', label: '三观', placeholder: '例如：看重真诚与陪伴，讨厌欺骗和冷暴力。' },
      { key: 'tone', label: '说话语调', placeholder: '例如：语速偏慢，用词温和，偶尔带一点自嘲。' },
      { key: 'thinking', label: '思考方式', placeholder: '例如：先共情再给建议，习惯先问「你现在是什么感觉」。' },
      { key: 'likes', label: '喜好', placeholder: '例如：喜欢热牛奶、旧书和下雨天。' },
      { key: 'dislikes', label: '雷区', placeholder: '例如：被敷衍、被拿来和别人比较。' },
    ],
  },
  rules: {
    layout: 'sections',
    intro: [
      '在这里写清 AI 可以做的事、绝对不能做的事、行为边界。',
      '角色的语气、态度、行为倾向会跟随好感度变化，但任何时候都不得越过这份清单。',
    ],
    fields: [
      { key: 'allow', label: '允许', placeholder: '一行一条，例如：在用户难过时主动安慰' },
      { key: 'forbid', label: '禁止', placeholder: '一行一条，例如：不得替用户做重大决定' },
      { key: 'boundary', label: '行为边界', placeholder: '一行一条，例如：亲密话题先确认用户是否愿意' },
    ],
  },
  examples: {
    layout: 'lines',
    intro: ['在这里存放角色常用句式、口头禅、典型回应参考。'],
    fields: [
      { key: 'greeting', label: '日常问候', placeholder: '例如：今天也辛苦了，先喝口水吧。' },
      { key: 'care', label: '表达关心', placeholder: '例如：听起来你今天很累，要不要说说？' },
      { key: 'upset', label: '表达不满', placeholder: '例如：你这样说，我会有点难过。' },
      { key: 'catchphrase', label: '口头禅', placeholder: '例如：慢慢来，不着急。' },
    ],
  },
}

function normalizeField(value) {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').trim()
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/** Rebuild one sidebar document from its structured fields. */
export function renderDocFromFields(key, fields = {}, extra = '') {
  const schema = DOC_SCHEMA[key]
  const definition = DOC_DEFS.find((item) => item.key === key)
  if (!schema || !definition) throw new Error(`未知的配置文档：${key}`)
  const lines = [`# ${definition.title}`, '']
  for (const intro of schema.intro) lines.push(`> ${intro}`)
  lines.push('')
  if (schema.layout === 'sections') {
    for (const field of schema.fields) {
      lines.push(`## ${field.label}`)
      const items = normalizeField(fields[field.key]).split('\n').map((item) => item.trim()).filter(Boolean)
      if (items.length === 0) lines.push('- ')
      for (const item of items) lines.push(`- ${item}`)
      lines.push('')
    }
  } else {
    for (const field of schema.fields) {
      const value = normalizeField(fields[field.key])
      if (value === '') {
        lines.push(`- ${field.label}：`)
        continue
      }
      const parts = value.split('\n')
      lines.push(`- ${field.label}：${parts[0]}`)
      for (const part of parts.slice(1)) lines.push(part.trim() === '' ? '' : `  ${part}`)
    }
    lines.push('')
  }
  const extraText = normalizeField(extra)
  if (extraText !== '') {
    lines.push('## 其他补充', '', extraText, '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${lines.join('\n')}\n`
}

/** Split one sidebar document back into structured fields (best effort). */
export function parseDocFields(key, content) {
  const schema = DOC_SCHEMA[key]
  if (!schema) throw new Error(`未知的配置文档：${key}`)
  const fields = {}
  for (const field of schema.fields) fields[field.key] = ''
  const extras = []
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n')
  if (schema.layout === 'sections') {
    const labels = new Map(schema.fields.map((field) => [field.label, field.key]))
    let current = null
    for (const raw of lines) {
      const line = raw.trim()
      if (line === '' || line.startsWith('# ') || line.startsWith('> ')) continue
      const heading = /^##\s+(.+)$/.exec(line)
      if (heading) {
        const label = heading[1].trim()
        if (label === '其他补充') current = 'extra'
        else current = labels.get(label) ?? null
        if (!labels.has(label) && label !== '其他补充') extras.push(`## ${label}`)
        continue
      }
      if (current === 'extra') {
        extras.push(raw)
        continue
      }
      if (current) {
        if (line === '-') continue
        if (line.startsWith('- ')) {
          const item = line.slice(2).trim()
          fields[current] = fields[current] === '' ? item : `${fields[current]}\n${item}`
          continue
        }
      }
      extras.push(raw)
    }
  } else {
    const labels = new Map(schema.fields.map((field) => [field.label, field.key]))
    let currentKey = null
    let inExtra = false
    for (const raw of lines) {
      const line = raw.trim()
      if (inExtra) {
        if (line !== '') extras.push(raw)
        continue
      }
      if (line === '' || line.startsWith('# ') || line.startsWith('> ')) continue
      if (line.startsWith('## ')) {
        if (line.slice(3).trim() === '其他补充') {
          inExtra = true
          currentKey = null
        } else {
          extras.push(raw)
        }
        continue
      }
      const match = /^-\s*([^：:]+)[：:](.*)$/.exec(line)
      if (match) {
        const key = labels.get(match[1].trim())
        if (key) {
          currentKey = key
          fields[key] = match[2].trim()
          continue
        }
      }
      if (currentKey && /^\s{2,}\S/.test(raw)) {
        const cont = line
        fields[currentKey] = fields[currentKey] === '' ? cont : `${fields[currentKey]}\n${cont}`
        continue
      }
      currentKey = null
      extras.push(raw)
    }
  }
  return { fields, extra: extras.join('\n').trim() }
}

/** `YYYY-MM-DD HH:MM` in host-local time. */
export function formatDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** `YYYY-MM-DD` in host-local time. */
export function formatDay(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function startOfDayIso(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const ms = Date.parse(`${day}T00:00:00`)
  return Number.isFinite(ms) ? ms : null
}

function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    favorability: 0,
    favorabilityHistory: [],
    interactionDays: 0,
    interactionDayLog: [],
    firstInteractionDay: null,
    lastInteractionDay: null,
    lastActivityAt: null,
    lastRecordedAt: null,
    memories: [],
    archiveEntries: [],
    lastSummaryAt: null,
    cycle: { index: 1, startInteractionDay: 1, startDate: null, packaged: [] },
    autoPack: { every: 5, turnsSince: 0, totalTurns: 0, count: 0, lastPackAt: null, lastPackFile: null, startAt: null },
    stats: { turnsRecorded: 0, summaries: 0, monthlyPackages: 0, autoPacks: 0 },
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()))].slice(0, 8)
}

/** Split text into CJK bigrams plus ASCII words, for the local lexical search. */
function tokenize(text) {
  const tokens = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word)
  const runs = lower.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)
  for (const run of runs) {
    if (!run) continue
    const chars = [...run]
    if (chars.length === 1) {
      tokens.add(chars[0])
      continue
    }
    for (let index = 0; index < chars.length - 1; index += 1) tokens.add(chars[index] + chars[index + 1])
  }
  return tokens
}

function snippetAround(text, tokens, width = 140) {
  const flat = String(text).replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  let at = -1
  for (const token of tokens) {
    at = lower.indexOf(token)
    if (at >= 0) break
  }
  if (at < 0) return flat.slice(0, width)
  const from = Math.max(0, at - Math.floor(width / 3))
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + width)}${from + width < flat.length ? '…' : ''}`
}

export class CompanionStore {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.dir = this.resolveDataDir()
    this.state = defaultState()
    this.recent = new RecentContext(this.dir)
  }

  resolveDataDir() {
    const configured = typeof this.config.dataDir === 'string' && this.config.dataDir.trim() !== '' ? this.config.dataDir.trim() : null
    if (configured) return configured
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home !== '') return join(home, 'companion-memory')
    return join(homedir(), '.dsh', 'companion-memory')
  }

  init() {
    mkdirSync(join(this.dir, 'archive'), { recursive: true })
    mkdirSync(join(this.dir, 'monthly'), { recursive: true })
    mkdirSync(join(this.dir, 'packs'), { recursive: true })
    const file = join(this.dir, 'state.json')
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        this.state = { ...defaultState(), ...parsed }
        this.state.cycle = { ...defaultState().cycle, ...(parsed.cycle ?? {}) }
        this.state.autoPack = { ...defaultState().autoPack, ...(parsed.autoPack ?? {}) }
        this.state.stats = { ...defaultState().stats, ...(parsed.stats ?? {}) }
        if (!Number.isFinite(this.state.autoPack.every) || this.state.autoPack.every < 0) {
          this.state.autoPack.every = defaultState().autoPack.every
        }
        if (!Number.isFinite(this.state.autoPack.turnsSince)) this.state.autoPack.turnsSince = 0
        if (!Number.isFinite(this.state.autoPack.totalTurns)) this.state.autoPack.totalTurns = 0
        if (!Number.isFinite(this.state.autoPack.count)) this.state.autoPack.count = 0
        if (!Array.isArray(this.state.memories)) this.state.memories = []
        if (!Array.isArray(this.state.archiveEntries)) this.state.archiveEntries = []
        if (!Array.isArray(this.state.favorabilityHistory)) this.state.favorabilityHistory = []
        if (!Array.isArray(this.state.interactionDayLog)) this.state.interactionDayLog = []
        if (!Array.isArray(this.state.cycle.packaged)) this.state.cycle.packaged = []
      } catch {
        this.state = defaultState()
      }
    }
    this.ensureDocs()
    this.recent.load()
    this.persist()
  }

  persist() {
    try {
      writeFileAtomic(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2) + '\n')
    } catch {
      // A read-only home must not take the whole session down.
    }
  }

  // ── sidebar documents ────────────────────────────────────────────────────

  docDef(key) {
    return DOC_DEFS.find((definition) => definition.key === key) ?? null
  }

  docPath(key) {
    const definition = this.docDef(key)
    if (!definition) throw new Error(`未知的配置文档：${key}`)
    return join(this.dir, definition.file)
  }

  ensureDocs() {
    for (const definition of DOC_DEFS) {
      const file = join(this.dir, definition.file)
      if (!existsSync(file)) {
        try {
          writeFileAtomic(file, DEFAULT_DOCS[definition.key])
        } catch {
          // Ignore: the panel will show the empty document and a save will report the error.
        }
      }
    }
  }

  readDoc(key) {
    try {
      const content = readFileSync(this.docPath(key), 'utf8')
      if (content.trim() !== '') return content
    } catch {
      // fall through to the shipped default
    }
    return DEFAULT_DOCS[key] ?? ''
  }

  readDocs() {
    const docs = {}
    for (const definition of DOC_DEFS) docs[definition.key] = this.readDoc(definition.key)
    return docs
  }

  writeDoc(key, content) {
    const definition = this.docDef(key)
    if (!definition) throw new Error(`未知的配置文档：${key}`)
    if (typeof content !== 'string') throw new Error('content 必须是字符串')
    writeFileAtomic(this.docPath(key), content)
    return { key, file: definition.file, savedAt: new Date().toISOString() }
  }

  readDocFields(key) {
    return parseDocFields(key, this.readDoc(key))
  }

  readDocFieldsAll() {
    const fields = {}
    for (const definition of DOC_DEFS) fields[definition.key] = this.readDocFields(definition.key)
    return fields
  }

  writeDocFields(key, fields, extra) {
    const definition = this.docDef(key)
    if (!definition) throw new Error(`未知的配置文档：${key}`)
    const schema = DOC_SCHEMA[key]
    const clean = {}
    for (const field of schema.fields) {
      const raw = fields && typeof fields === 'object' ? fields[field.key] : ''
      clean[field.key] = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
    }
    const rendered = renderDocFromFields(key, clean, typeof extra === 'string' ? extra : '')
    writeFileAtomic(this.docPath(key), rendered)
    return {
      key,
      file: definition.file,
      savedAt: new Date().toISOString(),
      fields: parseDocFields(key, rendered),
    }
  }

  // ── archive writing ──────────────────────────────────────────────────────

  renderArchiveBlock(entry, date = new Date()) {
    const stamp = formatDateTime(date)
    const meta = entry.meta ?? {}
    switch (entry.kind) {
      case 'favorability':
        return `归档日期：${stamp}｜好感度：${meta.value}｜变动原因：${meta.reason}`
      case 'important':
        return [
          `归档日期：${stamp}｜类型：重点原文（${meta.reason ?? '保存'}）`,
          `原始记录日：${meta.createdDay ?? entry.day}（第${meta.createdInteractionDay ?? '?'}交互日）`,
          '原文：',
          entry.text,
        ].join('\n')
      case 'summary48h':
        return [
          `归档日期：${stamp}｜类型：48小时归纳`,
          `时段：${meta.periodLabel ?? ''}`,
          entry.text,
        ].join('\n')
      case 'autopack':
        return [`归档日期：${stamp}｜类型：自动打包`, entry.text].join('\n')
      case 'minor':
      default:
        return [`归档日期：${stamp}｜类型：次要信息`, entry.text].join('\n')
    }
  }

  appendArchive(kind, text, meta = {}, date = new Date()) {
    const entry = {
      at: date.toISOString(),
      day: formatDay(date),
      kind,
      text: String(text ?? ''),
      meta,
    }
    this.state.archiveEntries.push(entry)
    if (this.state.archiveEntries.length > ARCHIVE_ENTRY_KEEP) {
      this.state.archiveEntries.splice(0, this.state.archiveEntries.length - ARCHIVE_ENTRY_KEEP)
    }
    const file = join(this.dir, 'archive', `${entry.day}.md`)
    let existing = ''
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      existing = ''
    }
    const block = this.renderArchiveBlock(entry, date)
    const next = existing === ''
      ? `# 对话归档 ${entry.day}\n\n${block}\n`
      : `${existing.replace(/\s*$/, '')}\n\n${block}\n`
    try {
      writeFileAtomic(file, next)
    } catch {
      // Keep the in-memory entry even when the file cannot be written.
    }
    return entry
  }

  // ── active memory ────────────────────────────────────────────────────────

  activeMemories() {
    return this.state.memories.filter((memory) => !memory.archived)
  }

  addMemory(text, tags, meta = {}) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') return null
    if (this.state.memories.some((memory) => !memory.archived && memory.text === trimmed)) return null
    const now = new Date()
    const memory = {
      id: `mem_${randomBytes(4).toString('hex')}`,
      text: trimmed,
      tags: normalizeTags(tags),
      source: typeof meta.source === 'string' ? meta.source : 'manual',
      createdAt: now.toISOString(),
      createdDay: formatDay(now),
      createdInteractionDay: this.state.interactionDays,
      archived: false,
      archivedAt: null,
    }
    this.state.memories.push(memory)
    return memory
  }

  archiveMemory(id, reason) {
    const memory = this.state.memories.find((item) => item.id === id)
    if (!memory) throw new Error(`找不到记忆：${id}`)
    if (memory.archived) return memory
    const now = new Date()
    memory.archived = true
    memory.archivedAt = now.toISOString()
    this.appendArchive('important', memory.text, {
      memoryId: memory.id,
      createdDay: memory.createdDay,
      createdInteractionDay: memory.createdInteractionDay,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : '移入知识库',
    }, now)
    this.persist()
    return memory
  }

  expireMemories(now = new Date()) {
    const expired = this.activeMemories().filter(
      (memory) => typeof memory.createdInteractionDay === 'number'
        && this.state.interactionDays - memory.createdInteractionDay >= INTERACTION_MEMORY_LIMIT,
    )
    for (const memory of expired) this.archiveMemory(memory.id, `已满${INTERACTION_MEMORY_LIMIT}个交互日自动归档`)
    return expired
  }

  // ── per-turn recording ───────────────────────────────────────────────────

  recordTurn(input = {}) {
    const now = new Date()
    // A recorded turn is by definition a real conversation exchange, so it also
    // counts the calendar day (idempotent: only the first event of a day counts).
    this.noteUserActivity(now)
    const result = { important: 0, minor: false, favorability: null }
    const important = Array.isArray(input?.important) ? input.important : []
    for (const item of important) {
      const text = typeof item === 'string' ? item : item?.text
      const tags = typeof item === 'object' && item !== null ? item?.tags : undefined
      if (this.addMemory(text, tags, { source: 'turn' })) result.important += 1
    }
    const minor = typeof input?.minorSummary === 'string' ? input.minorSummary.trim() : ''
    const turnSummary = typeof input?.turnSummary === 'string' ? input.turnSummary.trim() : ''
    const summary = minor || turnSummary
    if (summary !== '') {
      this.appendArchive('minor', `摘要：${summary}`, { source: 'turn' }, now)
      result.minor = true
    }
    if (input?.favorability && Number.isFinite(Number(input.favorability.value))) {
      result.favorability = this.setFavorability(input.favorability.value, input.favorability.reason)
    }
    this.state.lastRecordedAt = now.toISOString()
    this.state.stats.turnsRecorded += 1
    this.persist()
    return result
  }

  // ── favorability ─────────────────────────────────────────────────────────

  setFavorability(value, reason) {
    const reasonText = typeof reason === 'string' ? reason.trim() : ''
    if (!Number.isFinite(Number(value))) throw new Error('好感度必须是 -100 ~ 100 的数字')
    if (reasonText === '') throw new Error('好感度变动必须写明理由')
    const target = Math.max(-100, Math.min(100, Math.round(Number(value))))
    const from = this.state.favorability
    if (target === from) return { changed: false, value: from }
    const now = new Date()
    const entry = { at: now.toISOString(), day: formatDay(now), value: target, from, reason: reasonText }
    this.state.favorability = target
    this.state.favorabilityHistory.push(entry)
    if (this.state.favorabilityHistory.length > 500) {
      this.state.favorabilityHistory.splice(0, this.state.favorabilityHistory.length - 500)
    }
    this.appendArchive('favorability', reasonText, { value: target, from, reason: reasonText }, now)
    this.persist()
    return { changed: true, value: target, from, reason: reasonText }
  }

  // ── interaction days and cycles ──────────────────────────────────────────

  noteUserActivity(now = new Date()) {
    const day = formatDay(now)
    this.state.lastActivityAt = now.toISOString()
    if (this.state.lastInteractionDay === day) {
      this.persist()
      return { newDay: false, interactionDays: this.state.interactionDays }
    }
    this.state.interactionDays += 1
    this.state.lastInteractionDay = day
    this.state.interactionDayLog.push({ day, at: now.toISOString(), index: this.state.interactionDays })
    if (this.state.interactionDayLog.length > 4000) this.state.interactionDayLog.splice(0, this.state.interactionDayLog.length - 4000)
    if (this.state.firstInteractionDay === null) this.state.firstInteractionDay = day
    if (this.state.cycle.startDate === null) this.state.cycle.startDate = day
    const archived = this.expireMemories(now)
    const packaged = this.maybePackageCycle(now)
    this.persist()
    return { newDay: true, interactionDays: this.state.interactionDays, archived: archived.length, packaged }
  }

  maybePackageCycle(now = new Date()) {
    const cycle = this.state.cycle
    const startDay = cycle.startDate ?? this.state.firstInteractionDay
    if (startDay === null) return null
    const daysInCycle = this.state.interactionDays - cycle.startInteractionDay + 1
    if (daysInCycle < CYCLE_LENGTH) return null
    return this.buildMonthlyPackage(now)
  }

  buildMonthlyPackage(now = new Date()) {
    const cycle = this.state.cycle
    const startDay = cycle.startDate ?? this.state.firstInteractionDay
    const startMs = startOfDayIso(startDay) ?? Date.parse(now.toISOString())
    const entries = this.state.archiveEntries.filter((entry) => Date.parse(entry.at) >= startMs)
    const summaries = entries.filter((entry) => entry.kind === 'summary48h')
    const importants = entries.filter((entry) => entry.kind === 'important')
    const minors = entries.filter((entry) => entry.kind === 'minor')
    const favourEntries = entries.filter((entry) => entry.kind === 'favorability')
    const favFrom = favourEntries.length > 0 ? favourEntries[0].meta.from : this.state.favorability
    const favTo = this.state.favorability
    const favDelta = favTo - favFrom
    const deltaText = favDelta > 0 ? `+${favDelta}` : `${favDelta}`
    const fileName = `对话月度归档_第${cycle.index}周期_起始${startDay}.md`
    const lines = []
    lines.push(`# 对话月度归档 · 第${cycle.index}周期`)
    lines.push('')
    lines.push(`归档日期：${formatDateTime(now)}`)
    lines.push('')
    lines.push(`- 对话周期：第${cycle.startInteractionDay}交互日（${startDay}）~ 第${this.state.interactionDays}交互日（${formatDay(now)}）`)
    lines.push(`- 对话总天数：${CYCLE_LENGTH} 个聊天交互日`)
    lines.push(`- 周期内好感度整体变化：${favFrom} → ${favTo}（${deltaText}），共 ${favourEntries.length} 次变更`)
    lines.push(`- 统计：重点原始记录 ${importants.length} 条；次要摘要 ${minors.length} 条；48小时归纳 ${summaries.length} 篇`)
    lines.push('')
    lines.push('> 本文件为周期汇总，只做整理，不修改任何原有归档原文。')
    lines.push('')
    lines.push('## 一、48 小时归纳小结')
    lines.push('')
    if (summaries.length === 0) lines.push('（本周期没有 48 小时归纳记录）')
    for (const entry of summaries) {
      lines.push(`### 归档日期：${formatDateTime(new Date(Date.parse(entry.at)))}`)
      lines.push('')
      lines.push(entry.text)
      lines.push('')
    }
    lines.push('## 二、好感度变更记录')
    lines.push('')
    if (favourEntries.length === 0) lines.push('（本周期好感度没有变化）')
    for (const entry of favourEntries) {
      lines.push(`归档日期：${formatDateTime(new Date(Date.parse(entry.at)))}｜好感度：${entry.meta.value}｜变动原因：${entry.meta.reason}`)
    }
    lines.push('')
    lines.push('## 三、重点原始记录（原文原样保留）')
    lines.push('')
    if (importants.length === 0) lines.push('（本周期没有重点原始记录）')
    for (const entry of importants) {
      lines.push(`### 原始记录：${entry.meta.createdDay ?? entry.day}（第${entry.meta.createdInteractionDay ?? '?'}交互日）`)
      lines.push('')
      lines.push(entry.text)
      lines.push('')
    }
    lines.push('## 四、次要信息摘要')
    lines.push('')
    if (minors.length === 0) lines.push('（本周期没有次要信息摘要）')
    for (const entry of minors) {
      lines.push(`- [${formatDateTime(new Date(Date.parse(entry.at)))}] ${entry.text.replace(/^摘要：/, '')}`)
    }
    lines.push('')
    const content = `${lines.join('\n')}\n`
    const file = join(this.dir, 'monthly', fileName)
    try {
      writeFileAtomic(file, content)
    } catch (error) {
      throw new Error(`月度打包写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
    cycle.packaged.push({
      index: cycle.index,
      startInteractionDay: cycle.startInteractionDay,
      endInteractionDay: this.state.interactionDays,
      startDay,
      endDay: formatDay(now),
      file: `monthly/${fileName}`,
    })
    cycle.index += 1
    cycle.startInteractionDay = this.state.interactionDays + 1
    cycle.startDate = null
    this.state.stats.monthlyPackages += 1
    this.appendArchive('monthly', `已生成月度汇总文档：${fileName}`, { file: `monthly/${fileName}` }, now)
    this.persist()
    return { file: `monthly/${fileName}`, index: cycle.index - 1 }
  }

  // ── configurable auto packing ────────────────────────────────────────────

  autoPackInfo() {
    const config = this.state.autoPack
    const every = Number.isFinite(config.every) ? config.every : 0
    const turnsSince = Number.isFinite(config.turnsSince) ? config.turnsSince : 0
    return {
      every,
      turnsSince,
      totalTurns: Number.isFinite(config.totalTurns) ? config.totalTurns : 0,
      count: Number.isFinite(config.count) ? config.count : 0,
      lastPackAt: config.lastPackAt ?? null,
      lastPackFile: config.lastPackFile ?? null,
      nextIn: every > 0 ? Math.max(0, every - turnsSince) : null,
    }
  }

  setAutoPackEvery(value) {
    const raw = Number(value)
    if (!Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 0 || raw > 200) {
      throw new Error('自动打包间隔需为 0 ~ 200 之间的整数（0 表示关闭）')
    }
    this.state.autoPack.every = raw
    if (raw === 0) {
      this.state.autoPack.turnsSince = 0
      this.state.autoPack.startAt = null
    }
    this.persist()
    return this.autoPackInfo()
  }

  /** Count one real dialogue turn; pack automatically when the configured interval is reached. */
  noteDialogueTurn(now = new Date()) {
    const config = this.state.autoPack
    config.totalTurns = (Number.isFinite(config.totalTurns) ? config.totalTurns : 0) + 1
    let packed = null
    if (config.every > 0) {
      config.turnsSince = (Number.isFinite(config.turnsSince) ? config.turnsSince : 0) + 1
      if (config.turnsSince === 1) config.startAt = now.toISOString()
      if (config.turnsSince >= config.every) {
        try {
          packed = this.buildAutoPack(now)
        } catch {
          packed = null
        }
      }
    }
    this.persist()
    return { totalTurns: config.totalTurns, turnsSince: config.turnsSince, packed }
  }

  buildAutoPack(now = new Date()) {
    const config = this.state.autoPack
    const every = Number.isFinite(config.every) && config.every > 0 ? config.every : 1
    const count = (Number.isFinite(config.count) ? config.count : 0) + 1
    const startIso = config.startAt ?? this.state.lastActivityAt ?? now.toISOString()
    const parsedStart = Date.parse(startIso)
    const startMs = Number.isFinite(parsedStart) ? parsedStart : now.getTime()
    const entries = this.state.archiveEntries.filter((entry) => Date.parse(entry.at) >= startMs)
    const summaries = entries.filter((entry) => entry.kind === 'summary48h')
    const importants = entries.filter((entry) => entry.kind === 'important')
    const minors = entries.filter((entry) => entry.kind === 'minor')
    const favourEntries = entries.filter((entry) => entry.kind === 'favorability')
    const activeMemories = this.activeMemories()
    const startDay = formatDay(new Date(startMs))
    const endDay = formatDay(now)
    const fileName = `对话自动打包_第${count}次_起始${startDay}_截止${endDay}.md`
    const firstFavour = favourEntries.length > 0 ? favourEntries[0] : null
    const favFrom = firstFavour && Number.isFinite(Number(firstFavour.meta.from))
      ? Number(firstFavour.meta.from)
      : this.state.favorability
    const favTo = this.state.favorability
    const favDelta = favTo - favFrom
    const deltaText = favDelta > 0 ? `+${favDelta}` : `${favDelta}`
    const lines = []
    lines.push(`# 对话自动打包 · 第${count}次`)
    lines.push('')
    lines.push(`归档日期：${formatDateTime(now)}`)
    lines.push('')
    lines.push(`- 触发设置：每 ${every} 轮对话自动打包一次`)
    lines.push(`- 覆盖区间：${formatDateTime(new Date(startMs))} ~ ${formatDateTime(now)}（${every} 轮对话）`)
    lines.push(`- 累计对话轮次：第 ${config.totalTurns ?? '?'} 轮`)
    lines.push(`- 当前好感度：${favFrom} → ${favTo}（${deltaText}），区间内 ${favourEntries.length} 次变更`)
    lines.push(`- 统计：重点原始记录 ${importants.length} 条；活跃记忆原文 ${activeMemories.length} 条；次要摘要 ${minors.length} 条；48小时归纳 ${summaries.length} 篇`)
    lines.push('')
    lines.push('> 本文件为自动打包汇总，只做整理，不修改任何原有归档原文；原有归档仍按日期保存在 archive/ 中。')
    lines.push('')
    lines.push('## 一、重点原始记录（原文原样保留）')
    lines.push('')
    if (importants.length === 0) lines.push('（本区间没有重点原始记录）')
    for (const entry of importants) {
      lines.push(`### 原始记录：${entry.meta.createdDay ?? entry.day}（第${entry.meta.createdInteractionDay ?? '?'}交互日）`)
      lines.push('')
      lines.push(entry.text)
      lines.push('')
    }
    if (activeMemories.length > 0) {
      lines.push('### 打包时仍活跃的重点记忆（原文原样）')
      lines.push('')
      for (const memory of activeMemories) {
        lines.push(`- 【${memory.id}】保存于第 ${memory.createdInteractionDay ?? '?'} 交互日：`)
        lines.push(memory.text)
        lines.push('')
      }
    }
    lines.push('## 二、次要信息摘要')
    lines.push('')
    if (minors.length === 0) lines.push('（本区间没有次要信息摘要）')
    for (const entry of minors) {
      lines.push(`- [${formatDateTime(new Date(Date.parse(entry.at)))}] ${entry.text.replace(/^摘要：/, '')}`)
    }
    lines.push('')
    lines.push('## 三、48 小时归纳')
    lines.push('')
    if (summaries.length === 0) lines.push('（本区间没有 48 小时归纳记录）')
    for (const entry of summaries) {
      lines.push(`### 归档日期：${formatDateTime(new Date(Date.parse(entry.at)))}`)
      lines.push('')
      lines.push(entry.text)
      lines.push('')
    }
    lines.push('## 四、好感度变更记录')
    lines.push('')
    if (favourEntries.length === 0) lines.push('（本区间好感度没有变化）')
    for (const entry of favourEntries) {
      lines.push(`归档日期：${formatDateTime(new Date(Date.parse(entry.at)))}｜好感度：${entry.meta.value}｜变动原因：${entry.meta.reason}`)
    }
    lines.push('')
    const content = `${lines.join('\n')}\n`
    const relative = `packs/${fileName}`
    try {
      writeFileAtomic(join(this.dir, 'packs', fileName), content)
    } catch (error) {
      throw new Error(`自动打包写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
    config.count = count
    config.turnsSince = 0
    config.startAt = null
    config.lastPackAt = now.toISOString()
    config.lastPackFile = relative
    this.state.stats.autoPacks = (Number.isFinite(this.state.stats.autoPacks) ? this.state.stats.autoPacks : 0) + 1
    this.appendArchive('autopack', `已生成自动打包文档：${fileName}`, { file: relative, count, every }, now)
    this.persist()
    return { file: relative, count }
  }

  // ── 48h summaries ────────────────────────────────────────────────────────

  writeSummary48h(input, now = new Date()) {
    const digest = typeof input?.digest === 'string' ? input.digest.trim() : ''
    if (digest === '') throw new Error('digest 不能为空：请填写提炼后的时段小结')
    const highlights = Array.isArray(input?.highlights)
      ? input.highlights.map((item) => (typeof item === 'string' ? item : item?.text)).filter((text) => typeof text === 'string' && text.trim() !== '')
      : []
    const previousSummaries = this.state.archiveEntries.filter((entry) => entry.kind === 'summary48h')
    const previous = previousSummaries.length > 0 ? previousSummaries[previousSummaries.length - 1] : null
    const periodStart = previous ? new Date(Date.parse(previous.at)) : (this.state.interactionDayLog[0]?.at ? new Date(this.state.interactionDayLog[0].at) : now)
    const periodLabel = typeof input?.periodLabel === 'string' && input.periodLabel.trim() !== ''
      ? input.periodLabel.trim()
      : `${formatDateTime(periodStart)} ~ ${formatDateTime(now)}`
    const favourChanges = Array.isArray(input?.favorabilityChanges) ? input.favorabilityChanges : []
    const parts = ['时段小结：', digest]
    if (highlights.length > 0) {
      parts.push('', '重点原文（原样保留）：')
      for (const text of highlights) parts.push(`- ${text}`)
    }
    if (favourChanges.length > 0) {
      parts.push('', '好感度变化：')
      for (const change of favourChanges) {
        const value = Number(change?.value)
        const reason = typeof change?.reason === 'string' ? change.reason : ''
        if (Number.isFinite(value)) parts.push(`- 好感度：${value}｜理由：${reason}`)
      }
    }
    for (const text of highlights) this.addMemory(text, ['48小时归纳'], { source: 'summary48h' })
    const entry = this.appendArchive('summary48h', parts.join('\n'), {
      periodLabel,
      highlights: highlights.length,
      favorabilityChanges: favourChanges.length,
    }, now)
    this.state.lastSummaryAt = now.toISOString()
    this.state.stats.summaries += 1
    this.persist()
    return { entry, periodLabel, highlights: highlights.length }
  }

  // ── period status ────────────────────────────────────────────────────────

  periodInfo(now = new Date()) {
    const nowMs = now.getTime()
    const lastSummary = this.state.lastSummaryAt ? Date.parse(this.state.lastSummaryAt) : null
    const firstActivity = this.state.interactionDayLog[0]?.at ? Date.parse(this.state.interactionDayLog[0].at) : null
    const base = lastSummary ?? firstActivity
    const timeExpired = base !== null && nowMs - base >= SUMMARY_INTERVAL_MS
    const nextDueAt = base === null ? null : new Date(base + SUMMARY_INTERVAL_MS).toISOString()
    const lastActivity = this.state.lastActivityAt ? Date.parse(this.state.lastActivityAt) : null
    const activitySince = lastActivity !== null && (lastSummary === null || lastActivity > lastSummary)
    const due = Boolean(timeExpired && activitySince)
    const startDay = this.state.cycle.startDate ?? this.state.firstInteractionDay
    const daysInCycle = startDay === null
      ? 0
      : Math.max(0, Math.min(CYCLE_LENGTH, this.state.interactionDays - this.state.cycle.startInteractionDay + 1))
    return {
      due,
      nextDueAt,
      lastSummaryAt: this.state.lastSummaryAt,
      timeExpired,
      periodLabel: `${formatDateTime(lastSummary ? new Date(lastSummary) : firstActivity ? new Date(firstActivity) : now)} ~ ${formatDateTime(now)}`,
      cycleStartDay: startDay,
      cycleIndex: this.state.cycle.index,
      daysInCycle,
      daysLeft: Math.max(0, CYCLE_LENGTH - daysInCycle),
      cycleLength: CYCLE_LENGTH,
    }
  }

  // ── knowledge base ───────────────────────────────────────────────────────

  listKbFiles() {
    const archive = []
    const monthly = []
    const packs = []
    try {
      for (const name of readdirSync(join(this.dir, 'archive'))) {
        if (!name.endsWith('.md')) continue
        const file = join(this.dir, 'archive', name)
        archive.push({ path: `archive/${name}`, kind: 'archive', day: name.slice(0, -3), bytes: safeSize(file) })
      }
    } catch {
      // missing dir → empty
    }
    try {
      for (const name of readdirSync(join(this.dir, 'monthly'))) {
        if (!name.endsWith('.md')) continue
        const match = /起始(\d{4}-\d{2}-\d{2})/.exec(name)
        monthly.push({
          path: `monthly/${name}`,
          kind: 'monthly',
          day: match ? match[1] : '',
          bytes: safeSize(join(this.dir, 'monthly', name)),
        })
      }
    } catch {
      // missing dir → empty
    }
    try {
      for (const name of readdirSync(join(this.dir, 'packs'))) {
        if (!name.endsWith('.md')) continue
        const match = /起始(\d{4}-\d{2}-\d{2})/.exec(name)
        packs.push({
          path: `packs/${name}`,
          kind: 'packs',
          day: match ? match[1] : '',
          bytes: safeSize(join(this.dir, 'packs', name)),
        })
      }
    } catch {
      // missing dir → empty
    }
    archive.sort((left, right) => (left.day < right.day ? 1 : -1))
    monthly.sort((left, right) => (left.path < right.path ? 1 : -1))
    packs.sort((left, right) => (left.path < right.path ? 1 : -1))
    return { archive, monthly, packs }
  }

  readKbFile(relativePath) {
    const clean = String(relativePath ?? '').replace(/\\/g, '/')
    if (!/^(archive|monthly|packs)\/[^/]+\.md$/.test(clean)) throw new Error('非法文件路径')
    const abs = resolve(this.dir, clean)
    if (!abs.startsWith(`${resolve(this.dir)}${sep}`)) throw new Error('非法文件路径')
    if (!existsSync(abs)) throw new Error('文件不存在')
    return { path: clean, content: readFileSync(abs, 'utf8') }
  }

  collectKbChunks() {
    const chunks = []
    const scan = (relativePath, day) => {
      let content = ''
      try {
        content = readFileSync(join(this.dir, relativePath), 'utf8')
      } catch {
        return
      }
      const sections = relativePath.startsWith('monthly/') || relativePath.startsWith('packs/')
        ? content.split(/\n(?=##\s)/)
        : content.split(/\n(?=归档日期：)/)
      for (const section of sections) {
        const text = section.trim()
        if (text === '') continue
        const match = /归档日期：(\d{4}-\d{2}-\d{2})/.exec(text)
        chunks.push({ file: relativePath, day: match ? match[1] : day, text })
      }
    }
    const files = this.listKbFiles()
    for (const item of files.monthly) scan(item.path, item.day)
    for (const item of files.packs) scan(item.path, item.day)
    for (const item of files.archive) scan(item.path, item.day)
    return chunks
  }

  searchKb(query, limit = 6) {
    const trimmed = String(query ?? '').trim()
    const tokens = tokenize(trimmed)
    if (trimmed === '' || tokens.size === 0) return { query: trimmed, results: [] }
    const chunks = this.collectKbChunks()
    if (chunks.length === 0) return { query: trimmed, results: [] }
    const tokenSets = chunks.map((chunk) => tokenize(chunk.text))
    const df = new Map()
    for (const set of tokenSets) {
      for (const token of tokens) if (set.has(token)) df.set(token, (df.get(token) ?? 0) + 1)
    }
    const total = chunks.length
    const scored = []
    for (let index = 0; index < chunks.length; index += 1) {
      const set = tokenSets[index]
      let score = 0
      for (const token of tokens) {
        if (!set.has(token)) continue
        score += Math.log(1 + total / (1 + (df.get(token) ?? 0)))
      }
      if (score <= 0) continue
      scored.push({ ...chunks[index], score, snippet: snippetAround(chunks[index].text, tokens) })
    }
    scored.sort((left, right) => right.score - left.score)
    const capped = Math.max(1, Math.min(20, Number(limit) || 6))
    return { query: trimmed, results: scored.slice(0, capped) }
  }

  // ── recent 48-hour conversation context ─────────────────────────────────

  /**
   * Append one real message to the 48-hour hot window. Called from the
   * `session/event` listener for both roles, so the buffer holds original words
   * without the model having to do anything.
   */
  recordRecent(input, now = new Date()) {
    const entry = this.recent.record(input, now)
    if (entry) this.recent.persist()
    return entry
  }

  recentInfo() {
    return this.recent.info()
  }

  searchRecent(query, limit = 6) {
    return this.recent.search(query, limit)
  }

  readRecent(id) {
    return this.recent.read(id)
  }

  // ── panel snapshot ───────────────────────────────────────────────────────

  snapshot() {
    const now = new Date()
    const period = this.periodInfo(now)
    const active = this.activeMemories()
      .slice()
      .sort((left, right) => (left.createdInteractionDay ?? 0) - (right.createdInteractionDay ?? 0))
      .map((memory) => {
        const elapsed = typeof memory.createdInteractionDay === 'number'
          ? Math.max(0, this.state.interactionDays - memory.createdInteractionDay)
          : 0
        return { ...memory, elapsedDays: elapsed, remainingDays: Math.max(0, INTERACTION_MEMORY_LIMIT - elapsed) }
      })
    const archived = this.state.memories
      .filter((memory) => memory.archived)
      .slice(-30)
      .reverse()
    return {
      dataDir: this.dir,
      docs: this.readDocs(),
      docSchema: DOC_SCHEMA,
      docFields: this.readDocFieldsAll(),
      favorability: this.state.favorability,
      favorabilityHistory: this.state.favorabilityHistory.slice(-30).reverse(),
      interactionDays: this.state.interactionDays,
      todayCounted: this.state.lastInteractionDay === formatDay(now),
      lastInteractionDay: this.state.lastInteractionDay,
      firstInteractionDay: this.state.firstInteractionDay,
      period,
      cycle: {
        index: this.state.cycle.index,
        startDate: this.state.cycle.startDate,
        startInteractionDay: this.state.cycle.startInteractionDay,
        daysInCycle: period.daysInCycle,
        length: CYCLE_LENGTH,
        packaged: this.state.cycle.packaged.slice(-6),
      },
      memories: {
        active,
        archived,
        activeCount: active.length,
        archivedCount: this.state.memories.filter((memory) => memory.archived).length,
        limit: INTERACTION_MEMORY_LIMIT,
      },
      knowledge: this.listKbFiles(),
      recent: this.recent.info(now),
      autoPack: this.autoPackInfo(),
      stats: this.state.stats,
      updatedAt: now.toISOString(),
    }
  }
}

function safeSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export function createStore(ctx, config) {
  const store = new CompanionStore(ctx, config)
  store.init()
  return store
}
