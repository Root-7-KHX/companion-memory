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

/** Marker written into exported memory bundles so imports can recognise them. */
export const BUNDLE_FORMAT = 'companion-memory-bundle'
export const BUNDLE_FORMAT_VERSION = 1
export const BUNDLE_PLUGIN_VERSION = '0.4.0'

/** How many self-evolved entries each section can hold. */
export const EVOLUTION_SECTION_LIMIT = 12
export const EVOLUTION_LOG_LIMIT = 300

/**
 * Persona details the companion is allowed to grow on its own during a long
 * relationship. These are NOT the user-authored sidebar documents: the user's
 * documents stay the fixed core, while this layer accumulates the small
 * changes a long conversation slowly produces (new likes, new habits, ...).
 */
export const EVOLUTION_SECTIONS = [
  { key: 'traits', label: '性格细节', hint: '基础性格之外，慢慢显露出来的小特质（只做加法，不改写用户写死的核心性格）。' },
  { key: 'likes', label: '喜欢的事物', hint: '相处中逐渐喜欢上的东西，可以越攒越多。' },
  { key: 'dislikes', label: '讨厌/回避的事物', hint: '相处中逐渐讨厌、想避开的东西，也可以越攒越多。' },
  { key: 'habits', label: '行为习惯', hint: '聊天与相处中慢慢养成的习惯、口头禅、小动作。' },
]

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

/** 角色名字：单行、压缩空白、限长，避免脏数据进提示词。 */
const CHARACTER_NAME_LIMIT = 40
function normalizeCharacterName(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, CHARACTER_NAME_LIMIT)
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

/** 本地日期；导出聊天原文时按天分组用（内部别名）。 */
function formatDayLocal(date = new Date()) {
  return formatDay(date)
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
    /**
     * 角色（AI）自己的名字：用户在「配置」页最顶上单独填写，AI 只读。
     * 不放在任何一份可编辑文档里，避免被 edit_doc 改掉。
     */
    characterName: '',
    favorability: 0,
    favorabilityHistory: [],
    // 多人/群聊预留：每个对话可以出现多个「说话人」，好感度按人分别累计。
    // 单人聊天时只有默认说话人（default），行为与旧版本完全一致。
    speakers: {},
    currentSpeaker: 'default',
    interactionDays: 0,
    interactionDayLog: [],
    firstInteractionDay: null,
    lastInteractionDay: null,
    lastActivityAt: null,
    lastRecordedAt: null,
    /** 最近一条用户消息的时间：用来判断「这一轮是否已经记录过」（turn_end 去重） */
    lastUserMessageAt: null,
    memories: [],
    /**
     * 重复提问统计：{ [归一化问题]: { text, count, firstAt, lastAt, memoryId } }
     * 用户反复问同一件事时，达到阈值就自动写进全局活跃记忆（带「常问」标签）。
     */
    questionStats: {},
    archiveEntries: [],
    lastSummaryAt: null,
    cycle: { index: 1, startInteractionDay: 1, startDate: null, packaged: [] },
    autoPack: { every: 5, turnsSince: 0, totalTurns: 0, count: 0, lastPackAt: null, lastPackFile: null, startAt: null },
    contextCompression: { count: 0, lastAt: null, lastFile: null, shadowedTokens: 0, lastRange: null },
    // 1.1.0-A：多级记忆压缩（年度摘要 + 滚动跨年沉积，只保留两份高层摘要）
    hierarchy: {
      version: 1,
      annual: null,
      epoch: null,
      lastRunAt: null,
      lastError: '',
    },
    evolution: {
      updatedAt: null,
      sections: { traits: [], likes: [], dislikes: [], habits: [] },
      log: [],
    },
    stats: { turnsRecorded: 0, summaries: 0, monthlyPackages: 0, autoPacks: 0, evolutions: 0, contextCompressions: 0 },
  }
}

/** 归一化一句"问题"：去标点/空白，用来判断是不是同一件事被反复问。 */
const QUESTION_HINT = /[？?]|吗|呢|什么|怎么|为什么|咋|哪|谁|几点|多少|多久|是不是|能不能|要不要|有没有|好不好|行不行/
function normalizeQuestionKey(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '' || raw.length > 200) return ''
  if (!QUESTION_HINT.test(raw)) return ''
  return raw.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 60)
}

/** 二元组集合，用来算"换个说法问同一件事"的重合度。 */
function bigramsOf(text) {
  const set = new Set()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

function similarQuestion(entryKey, candidateKey) {
  if (entryKey === candidateKey) return true
  const a = bigramsOf(entryKey)
  const b = bigramsOf(candidateKey)
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared) >= 0.75
}

/** 在已统计的问题里找一条近似重复的。 */
function findSimilarQuestion(stats, key) {
  for (const [entryKey, entry] of Object.entries(stats)) {
    if (similarQuestion(entryKey, key)) return entry
  }
  return null
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()))].slice(0, 8)
}

/** 权重统一成 1~100 的整数，非法值一律回落到默认 50。 */
export const EVOLUTION_WEIGHT_DEFAULT = 50
export const EVOLUTION_WEIGHT_MIN = 1
export const EVOLUTION_WEIGHT_MAX = 100

/** 活跃记忆权重：和自我演化共用 1~100 的算法与默认值（50）。 */
export const MEMORY_WEIGHT_DEFAULT = EVOLUTION_WEIGHT_DEFAULT
export function normalizeMemoryWeight(value) {
  return normalizeEvolutionWeight(value)
}

export function normalizeEvolutionWeight(value) {
  // 缺省 / null / 空串 都算"没设置"，回落到默认值；只有真的给了数字才夹到 1~100。
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return EVOLUTION_WEIGHT_DEFAULT
  }
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return EVOLUTION_WEIGHT_DEFAULT
  return Math.min(EVOLUTION_WEIGHT_MAX, Math.max(EVOLUTION_WEIGHT_MIN, number))
}

function normalizeEvolutionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim() : ''
  if (text === '') return null
  return {
    id: typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : `evo_${randomBytes(4).toString('hex')}`,
    text: text.length > 160 ? text.slice(0, 160) : text,
    reason: typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 160) : '',
    by: entry.by === 'user' ? 'user' : 'ai',
    at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
    day: typeof entry.day === 'string' ? entry.day : formatDay(new Date()),
    // 权重 1~100：这条对角色有多重要/多强烈。50 = 默认。老数据没有这个字段按 50 处理。
    weight: normalizeEvolutionWeight(entry.weight),
  }
}

/** Coerce any stored/imported value into a complete evolution layer. */
export function normalizeEvolutionState(value) {
  const source = value && typeof value === 'object' ? value : {}
  const sections = {}
  for (const definition of EVOLUTION_SECTIONS) {
    const list = source.sections && Array.isArray(source.sections[definition.key]) ? source.sections[definition.key] : []
    sections[definition.key] = list.map(normalizeEvolutionEntry).filter(Boolean).slice(0, EVOLUTION_SECTION_LIMIT)
  }
  const log = Array.isArray(source.log)
    ? source.log
      .filter((item) => item && typeof item === 'object')
      .slice(-EVOLUTION_LOG_LIMIT)
      .map((item) => ({
        at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
        action: item.action === 'remove' ? 'remove' : item.action === 'weight' ? 'weight' : 'add',
        section: typeof item.section === 'string' ? item.section : '',
        id: typeof item.id === 'string' ? item.id : '',
        text: typeof item.text === 'string' ? item.text : '',
        reason: typeof item.reason === 'string' ? item.reason : '',
        by: item.by === 'user' ? 'user' : 'ai',
      }))
    : []
  return { updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null, sections, log }
}

/** Union two evolution layers by text, keeping this conversation's ordering. */
function mergeEvolutionState(base, extra) {
  const merged = normalizeEvolutionState(base)
  const other = normalizeEvolutionState(extra)
  for (const definition of EVOLUTION_SECTIONS) {
    const seen = new Set(merged.sections[definition.key].map((entry) => entry.text.toLowerCase()))
    for (const entry of other.sections[definition.key]) {
      if (seen.has(entry.text.toLowerCase())) continue
      if (merged.sections[definition.key].length >= EVOLUTION_SECTION_LIMIT) break
      seen.add(entry.text.toLowerCase())
      merged.sections[definition.key].push(entry)
    }
    merged.sections[definition.key].sort((left, right) => String(left.at).localeCompare(String(right.at)))
  }
  merged.log = dedupeBy([...other.log, ...merged.log], (item) => `${item.at}:${item.action}:${item.id}`).slice(-EVOLUTION_LOG_LIMIT)
  merged.updatedAt = new Date().toISOString()
  return merged
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
    // 单字补充召回（问法与原文用词不一致时，双字片段可能完全对不上）
    for (const char of chars) tokens.add('\u0001' + char)
  }
  return tokens
}

function snippetAround(text, tokens, width = 140) {
  const flat = String(text).replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  let at = -1
  for (const raw of tokens) {
    const token = raw.startsWith('\u0001') ? raw.slice(1) : raw
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
    // 1.1.0：导入前整理 / 记忆体检的自动备份目录（撤销用）
    mkdirSync(join(this.dir, 'backups'), { recursive: true })
    // 1.1.0-A：多级记忆压缩产物（年报 / 跨年沉积 / 备份）
    mkdirSync(join(this.dir, 'hierarchy'), { recursive: true })
    mkdirSync(join(this.dir, 'hierarchy', 'backups'), { recursive: true })
    const file = join(this.dir, 'state.json')
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        this.state = { ...defaultState(), ...parsed }
        this.state.cycle = { ...defaultState().cycle, ...(parsed.cycle ?? {}) }
        this.state.autoPack = { ...defaultState().autoPack, ...(parsed.autoPack ?? {}) }
        this.state.contextCompression = { ...defaultState().contextCompression, ...(parsed.contextCompression ?? {}) }
        this.state.hierarchy = { ...defaultState().hierarchy, ...(parsed.hierarchy ?? {}) }
        this.state.stats = { ...defaultState().stats, ...(parsed.stats ?? {}) }
        if (!Number.isFinite(this.state.autoPack.every) || this.state.autoPack.every < 0) {
          this.state.autoPack.every = defaultState().autoPack.every
        }
        if (!Number.isFinite(this.state.autoPack.turnsSince)) this.state.autoPack.turnsSince = 0
        if (!Number.isFinite(this.state.autoPack.totalTurns)) this.state.autoPack.totalTurns = 0
        if (!Number.isFinite(this.state.autoPack.count)) this.state.autoPack.count = 0
        if (!Array.isArray(this.state.memories)) this.state.memories = []
        if (!this.state.questionStats || typeof this.state.questionStats !== 'object' || Array.isArray(this.state.questionStats)) {
          this.state.questionStats = {}
        }
        // 老数据没有 weight：补默认值，保证排序/提示词一致。
        this.state.memories = this.state.memories.map((memory) => (
          memory && typeof memory === 'object' ? { ...memory, weight: normalizeMemoryWeight(memory.weight) } : memory
        ))
        if (!Array.isArray(this.state.archiveEntries)) this.state.archiveEntries = []
        if (!Array.isArray(this.state.favorabilityHistory)) this.state.favorabilityHistory = []
        if (!Array.isArray(this.state.interactionDayLog)) this.state.interactionDayLog = []
        if (!Array.isArray(this.state.cycle.packaged)) this.state.cycle.packaged = []
        this.state.characterName = normalizeCharacterName(this.state.characterName)
        this.state.evolution = normalizeEvolutionState(this.state.evolution)
        this.normalizeSpeakers()
      } catch {
        this.state = defaultState()
        this.normalizeSpeakers()
      }
    } else {
      this.normalizeSpeakers()
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

  // ── AI document editing ──────────────────────────────────────────────────
  //
  // By default the three sidebar documents are user-owned and the AI may only
  // read them. When `config.aiEditDocs` allows it, the model can rewrite a
  // document itself (small, story-driven adjustments) and every change is
  // archived with its reason so the user can review it in the knowledge base.

  aiEditDocRules() {
    const raw = this.config && typeof this.config === 'object' ? this.config.aiEditDocs : undefined
    const base = { personality: true, examples: true, rules: false }
    if (raw === false) return { personality: false, examples: false, rules: false }
    if (raw && typeof raw === 'object') {
      return {
        personality: raw.personality !== false,
        examples: raw.examples !== false,
        rules: raw.rules === true,
      }
    }
    return base
  }

  // ── 角色名字（全局默认 + 单对话覆盖） ─────────────────────────────────────
  //
  // 名字只由用户在「配置」页填写：它不属于任何一份可编辑文档，所以 edit_doc
  // 改不到它，AI 只能读。两层取值：
  //   1. 本对话的覆盖值（state.characterName，空 = 不覆盖）
  //   2. 所有对话共享的默认值（<root>/character.json）
  // 生效值 = override || global。

  /** 插件数据根目录（sessions/ 的父级）。 */
  resolveRootDir() {
    const configured = typeof this.config.rootDir === 'string' && this.config.rootDir.trim() !== ''
      ? this.config.rootDir.trim()
      : null
    if (configured) return configured
    // 兜底：<root>/sessions/<id>_<hash> → 往上两层。
    const parent = dirname(this.dir)
    return parent.endsWith('sessions') ? dirname(parent) : this.dir
  }

  globalNameFile() {
    return join(this.resolveRootDir(), 'character.json')
  }

  /** 所有对话共享的默认名字；没设置过返回空串。 */
  characterNameGlobal() {
    try {
      const file = this.globalNameFile()
      if (!existsSync(file)) return ''
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return normalizeCharacterName(parsed && parsed.name)
    } catch {
      return ''
    }
  }

  /** 本对话的覆盖名字；空串表示跟随全局默认。 */
  characterNameOverride() {
    return normalizeCharacterName(this.state.characterName)
  }

  /** 最终生效的名字：本对话覆盖优先，否则用全局默认。 */
  characterNameValue() {
    return this.characterNameOverride() || this.characterNameGlobal()
  }

  /** 设置本对话的覆盖值（传空串 = 清除覆盖，跟随全局）。 */
  setCharacterName(value) {
    const from = this.characterNameValue()
    const next = normalizeCharacterName(value)
    this.state.characterName = next
    this.persist()
    return { changed: true, from, value: this.characterNameValue(), override: next }
  }

  /** 设置所有对话共享的默认名字。 */
  setGlobalCharacterName(value) {
    const from = this.characterNameGlobal()
    const next = normalizeCharacterName(value)
    if (next === from) return { changed: false, from, value: next }
    writeFileAtomic(this.globalNameFile(), JSON.stringify({ name: next }, null, 2) + '\n')
    return { changed: true, from, value: next }
  }

  /**
   * How the character should talk back. The default is "brief": short, casual
   * chat-app messages instead of long document-like answers. `off` disables the
   * generated style section entirely and leaves the voice to the three docs.
   */
  replyStyleSettings() {
    const raw = this.config && typeof this.config === 'object' ? this.config.replyStyle : undefined
    if (raw === false || (raw && typeof raw === 'object' && raw.mode === 'off')) {
      return { mode: 'off', maxSentences: 0 }
    }
    const source = raw && typeof raw === 'object' ? raw : {}
    const mode = source.mode === 'normal' || source.mode === 'detailed' ? source.mode : 'brief'
    const fallback = mode === 'brief' ? 3 : mode === 'normal' ? 6 : 0
    const parsed = Number(source.maxSentences)
    const maxSentences = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
    return { mode, maxSentences }
  }

  /**
   * Host-side turn fallback: when the model forgets to call `turn_end`, the
   * tracking layer still records one lightweight turn (day counter, turn count,
   * a tiny archive summary) so the memory timeline never develops holes.
   */
  autoTurnRecordEnabled() {
    const raw = this.config && typeof this.config === 'object' ? this.config.autoTurnRecord : undefined
    return raw !== false
  }

  /**
   * Passive turn_end: when the model forgot to write this turn, the Host asks a
   * small side model call to extract important verbatim quotes, a minor summary
   * and an optional favorability change, then records them exactly like the
   * `turn_end` action would. Enabled by default together with autoTurnRecord.
   */
  passiveTurnEndEnabled() {
    if (!this.autoTurnRecordEnabled()) return false
    const raw = this.config && typeof this.config === 'object' ? this.config.passiveTurnEnd : undefined
    return raw !== false
  }

  writeDocFromAi(key, input = {}) {
    const definition = this.docDef(key)
    if (!definition) throw new Error(`未知的配置文档：${key}`)
    const allowed = this.aiEditDocRules()
    if (!allowed[key]) {
      throw new Error(`当前设置不允许 AI 修改「${definition.title}」；这份文档需要用户在侧边栏里改。`)
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (reason === '') throw new Error('AI 修改配置文档必须写明原因')
    const before = this.readDoc(key)
    let result
    if (input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)) {
      // Partial edits merge with what is already in the document, so the model
      // can change one field without wiping the others.
      const current = this.readDocFields(key)
      const merged = { ...(current.fields ?? {}) }
      for (const [field, value] of Object.entries(input.fields)) {
        if (typeof value === 'string') merged[field] = value
      }
      const extra = typeof input.extra === 'string' ? input.extra : (current.extra ?? '')
      result = this.writeDocFields(key, merged, extra)
    } else if (typeof input.content === 'string' && input.content.trim() !== '') {
      result = this.writeDoc(key, input.content)
    } else {
      throw new Error('edit_doc 需要 fields 对象（逐字段修改）或 content（整篇改写）')
    }
    const after = this.readDoc(key)
    const changed = before !== after
    if (changed) {
      this.appendArchive('doc_edit', `AI 修改了「${definition.title}」：${reason}`.slice(0, 4000), {
        key,
        file: definition.file,
        reason,
      })
      this.persist()
    }
    return { ...result, key, title: definition.title, changed, reason }
  }

  // ── archive writing ──────────────────────────────────────────────────────

  renderArchiveBlock(entry, date = new Date()) {
    const stamp = formatDateTime(date)
    const meta = entry.meta ?? {}
    switch (entry.kind) {
      case 'favorability':
        return `归档日期：${stamp}｜好感度（角色对用户）：${meta.value}${meta.speakerName ? `｜说话人：${meta.speakerName}` : ''}｜变动原因：${meta.reason}`
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
      case 'contextcompress':
        return [`归档日期：${stamp}｜类型：上下文压缩`, entry.text].join('\n')
      case 'doc_edit':
        return [`归档日期：${stamp}｜类型：AI 修改配置文档（${meta.file ?? ''}）`, entry.text].join('\n')
      case 'importclean':
        return [
          `归档日期：${stamp}｜类型：记忆整理（${meta.tag ?? '清洗'}）`,
          `来源：${meta.source ?? '导入前整理'}｜保留 ${meta.kept ?? '?'} 条${Number.isFinite(Number(meta.modelDropped)) ? `｜模型判定归档 ${meta.modelDropped} 条` : ''}`,
          entry.text,
        ].join('\n')
      case 'hierarchy':
        return [`归档日期：${stamp}｜类型：多级记忆压缩`, entry.text].join('\n')
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

  // ── 1.1.0：记忆整理（导入前整理 / 体检）的备份与归档 ─────────────────────

  /**
   * 把当前 state.json 备份到 backups/，作为「整理」的撤销点。
   * @param {string} [tag] 备份标签，例如「导入前」「体检前」
   * @returns {string} 相对 dataDir 的备份路径；失败返回空串
   */
  backupState(tag = 'backup') {
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const safeTag = String(tag).replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 20) || 'backup'
    const relative = `backups/state-${safeTag}-${stamp}.json`
    try {
      mkdirSync(join(this.dir, 'backups'), { recursive: true })
      writeFileAtomic(join(this.dir, relative), `${JSON.stringify({ ...this.state, backedUpAt: now.toISOString(), backupTag: safeTag }, null, 2)}\n`)
      return relative
    } catch {
      return ''
    }
  }

  /**
   * 把整理时被归档的记忆写进知识库（可 search_kb 找回原文，不是真删）。
   * @param {Array<{id:string,text:string,reason:string}>} dropped
   * @param {object} [meta]
   */
  noteCleanedEntries(dropped, meta = {}) {
    const list = Array.isArray(dropped)
      ? dropped.filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
      : []
    if (list.length === 0) return null
    const lines = ['以下条目在导入前整理 / 记忆体检中被归档（原文保留在此，可检索找回）：']
    for (const item of list) lines.push(`- ${item.text}（原因：${item.reason ?? '未说明'}）`)
    return this.appendArchive('importclean', lines.join('\n'), { ...meta, count: list.length }, new Date())
  }

  // ── speakers (multi-person / group-chat ready) ───────────────────────────
  //
  // One conversation may contain several people (group chat or roleplay with
  // multiple characters). Every speaker keeps a fully separate favorability
  // record, while the shared plot memory stays common. Single-person chats
  // keep exactly one "default" speaker and behave like before.

  normalizeSpeakers() {
    const state = this.state
    if (!state.speakers || typeof state.speakers !== 'object' || Array.isArray(state.speakers)) state.speakers = {}
    if (!Array.isArray(state.favorabilityHistory)) state.favorabilityHistory = []
    if (!Number.isFinite(Number(state.favorability))) state.favorability = 0
    const now = new Date().toISOString()
    if (!state.speakers.default) {
      state.speakers.default = {
        id: 'default',
        name: '用户',
        aliases: [],
        favorability: Math.max(-100, Math.min(100, Math.round(Number(state.favorability) || 0))),
        bond: 0,
        note: '',
        firstSeenAt: now,
        lastSeenAt: now,
        lastSpokeAt: null,
        turns: 0,
      }
    }
    for (const [id, raw] of Object.entries(state.speakers)) {
      const speaker = raw && typeof raw === 'object' ? raw : {}
      state.speakers[id] = {
        id,
        name: typeof speaker.name === 'string' && speaker.name.trim() !== '' ? speaker.name.trim().slice(0, 40) : (id === 'default' ? '用户' : id),
        aliases: Array.isArray(speaker.aliases)
          ? [...new Set(speaker.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim().slice(0, 40)))].slice(0, 20)
          : [],
        favorability: Math.max(-100, Math.min(100, Math.round(Number(speaker.favorability) || 0))),
        bond: Number.isFinite(Number(speaker.bond)) ? Math.round(Number(speaker.bond)) : 0,
        note: typeof speaker.note === 'string' ? speaker.note.slice(0, 300) : '',
        firstSeenAt: typeof speaker.firstSeenAt === 'string' ? speaker.firstSeenAt : now,
        lastSeenAt: typeof speaker.lastSeenAt === 'string' ? speaker.lastSeenAt : now,
        lastSpokeAt: typeof speaker.lastSpokeAt === 'string' ? speaker.lastSpokeAt : null,
        turns: Number.isFinite(Number(speaker.turns)) ? Math.max(0, Math.round(Number(speaker.turns))) : 0,
      }
    }
    if (typeof state.currentSpeaker !== 'string' || !state.speakers[state.currentSpeaker]) {
      state.currentSpeaker = Object.keys(state.speakers)[0] ?? 'default'
    }
    const current = state.speakers[state.currentSpeaker]
    if (current) state.favorability = current.favorability
    return state
  }

  /** Find a speaker by id, exact name, or alias (case-insensitive for latin). */
  speakerById(ref) {
    const query = typeof ref === 'string' ? ref.trim() : ''
    if (query === '') return null
    const speakers = this.state.speakers ?? {}
    if (speakers[query]) return speakers[query]
    const lower = query.toLowerCase()
    for (const speaker of Object.values(speakers)) {
      if (speaker.name && speaker.name.toLowerCase() === lower) return speaker
      if (Array.isArray(speaker.aliases) && speaker.aliases.some((alias) => alias.toLowerCase() === lower)) return speaker
    }
    return null
  }

  currentSpeakerRecord() {
    const speakers = this.state.speakers ?? {}
    return speakers[this.state.currentSpeaker] ?? Object.values(speakers)[0] ?? null
  }

  listSpeakers() {
    return Object.values(this.state.speakers ?? {}).sort((left, right) => {
      const leftAt = Date.parse(left.lastSpokeAt ?? left.lastSeenAt ?? '') || 0
      const rightAt = Date.parse(right.lastSpokeAt ?? right.lastSeenAt ?? '') || 0
      if (left.id === 'default') return -1
      if (right.id === 'default') return 1
      return rightAt - leftAt
    })
  }

  speakersSnapshot() {
    const current = this.state.currentSpeaker
    return this.listSpeakers().map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      aliases: [...speaker.aliases],
      favorability: speaker.favorability,
      bond: Number.isFinite(Number(speaker.bond)) ? Number(speaker.bond) : 0,
      note: speaker.note,
      turns: speaker.turns,
      lastSpokeAt: speaker.lastSpokeAt,
      isCurrent: speaker.id === current,
    }))
  }

  /** Resolve (and with `create`, register) one speaker by id / name / alias. */
  resolveSpeaker(ref, options = {}) {
    const existing = this.speakerById(ref)
    if (existing) {
      if (options.note && typeof options.note === 'string' && options.note.trim() !== '') {
        existing.note = options.note.trim().slice(0, 300)
      }
      if (Array.isArray(options.aliases)) {
        const merged = [...new Set([...existing.aliases, ...options.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim())])]
        existing.aliases = merged.slice(0, 20)
      }
      return existing
    }
    if (options.create === false) return null
    const name = typeof ref === 'string' ? ref.trim().slice(0, 40) : ''
    if (name === '') return null
    const now = new Date().toISOString()
    const speaker = {
      id: `sp_${randomBytes(3).toString('hex')}`,
      name,
      aliases: Array.isArray(options.aliases)
        ? [...new Set(options.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim().slice(0, 40)))].slice(0, 20)
        : [],
      favorability: 0,
      bond: 0,
      note: typeof options.note === 'string' ? options.note.trim().slice(0, 300) : '',
      firstSeenAt: now,
      lastSeenAt: now,
      lastSpokeAt: null,
      turns: 0,
    }
    this.state.speakers[speaker.id] = speaker
    return speaker
  }

  /** Make one speaker the current talker (registers unknown names). */
  switchSpeaker(ref, options = {}) {
    const speaker = this.resolveSpeaker(ref, { ...options, create: options.create !== false })
    if (!speaker) throw new Error('没有识别到说话人：请提供名字')
    const now = new Date()
    this.state.currentSpeaker = speaker.id
    this.state.favorability = speaker.favorability
    speaker.lastSeenAt = now.toISOString()
    this.persist()
    return speaker
  }

  /** Count one conversation turn for a speaker and mark them as last speaker. */
  noteSpeakerTurn(ref, now = new Date()) {
    const speaker = this.speakerById(ref) ?? this.currentSpeakerRecord()
    if (!speaker) return null
    speaker.turns += 1
    speaker.lastSpokeAt = now.toISOString()
    speaker.lastSeenAt = now.toISOString()
    this.persist()
    return speaker
  }

  // ── active memory ────────────────────────────────────────────────────────

  activeMemories() {
    return this.state.memories.filter((memory) => !memory.archived)
  }

  /**
   * 活跃记忆的展示/注入顺序：置顶 → 权重高 → 手动顺序（sortIndex）→ 早的在前。
   * 权重一样时，上移/下移仍然有效。
   */
  sortedActiveMemories() {
    return this.activeMemories()
      .map((memory, index) => ({ memory, index }))
      .sort((left, right) => {
        const a = left.memory
        const b = right.memory
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
        const weightDiff = (normalizeMemoryWeight(b.weight) - normalizeMemoryWeight(a.weight))
        if (weightDiff !== 0) return weightDiff
        const aOrder = Number.isFinite(a.sortIndex) ? a.sortIndex : (a.createdInteractionDay ?? 0) * 1000 + left.index
        const bOrder = Number.isFinite(b.sortIndex) ? b.sortIndex : (b.createdInteractionDay ?? 0) * 1000 + right.index
        return aOrder - bOrder
      })
      .map((item) => item.memory)
  }

  addMemory(text, tags, meta = {}) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') return null
    const squash = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase()
    const key = squash(trimmed)
    if (this.state.memories.some((memory) => !memory.archived && squash(memory.text) === key)) return null
    const now = new Date()
    const speaker = (typeof meta.speakerId === 'string' ? this.speakerById(meta.speakerId) : null) ?? this.currentSpeakerRecord()
    const memory = {
      id: `mem_${randomBytes(4).toString('hex')}`,
      text: trimmed,
      tags: normalizeTags(tags),
      source: typeof meta.source === 'string' ? meta.source : 'manual',
      // Which speaker the memory came from (multi-person conversations); the
      // memory itself stays shared plot material.
      speakerId: speaker?.id ?? null,
      speakerName: speaker?.name ?? null,
      createdAt: now.toISOString(),
      createdDay: formatDay(now),
      createdInteractionDay: this.state.interactionDays,
      // Which conversation exchange produced this memory; used for grouping the
      // auto packs ("第 3~5 轮之间记下的重点").
      turnAt: typeof this.state.autoPack?.totalTurns === 'number' ? this.state.autoPack.totalTurns : 0,
      // Pinned memories are shown first and never lose their slot to a crowd of
      // smaller notes.
      pinned: false,
      // 权重 1~100（默认 50）：越高越靠前、越优先占住注入名额。
      weight: normalizeMemoryWeight(meta.weight),
      // 「常问」类记忆记录被问到的次数，面板上显示。
      recurringCount: Number.isFinite(Number(meta.recurringCount)) ? Math.max(1, Math.round(Number(meta.recurringCount))) : 0,
      archived: false,
      archivedAt: null,
    }
    this.state.memories.push(memory)
    return memory
  }

  findActiveMemory(id) {
    const memory = this.state.memories.find((item) => item.id === id)
    if (!memory || memory.archived) throw new Error(`找不到活跃记忆：${id}`)
    return memory
  }

  /** 调整一条活跃记忆的权重（1~100，默认 50）。 */
  setMemoryWeight(id, weight) {
    const memory = this.findActiveMemory(id)
    const from = normalizeMemoryWeight(memory.weight)
    const next = normalizeMemoryWeight(weight)
    if (from === next) return { changed: false, id, from, weight: next }
    memory.weight = next
    this.persist()
    return { changed: true, id, from, weight: next }
  }

  /** Turn a memory into "always show first" (or back to normal order). */
  pinMemory(id, pinned) {
    const memory = this.findActiveMemory(id)
    memory.pinned = Boolean(pinned)
    this.persist()
    return memory
  }

  /**
   * Move a memory up/down inside the active list. Ordering is stored explicitly
   * (`order`), so manual sorting survives restarts and stays independent from
   * creation time.
   */
  moveMemory(id, direction) {
    const active = this.activeMemories()
    const index = active.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`找不到活跃记忆：${id}`)
    const target = index + (direction === 'up' ? -1 : 1)
    if (target < 0 || target >= active.length) return { moved: false, index }
    const current = active[index]
    const other = active[target]
    const currentOrder = current.sortIndex ?? index
    const otherOrder = other.sortIndex ?? target
    current.sortIndex = otherOrder
    other.sortIndex = currentOrder
    this.persist()
    return { moved: true, index: target }
  }

  /** Delete one active memory the user decided they no longer want. */
  deleteMemory(id) {
    const index = this.state.memories.findIndex((item) => item.id === id && !item.archived)
    if (index < 0) throw new Error(`找不到活跃记忆：${id}`)
    const [removed] = this.state.memories.splice(index, 1)
    this.persist()
    return removed
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

  /**
   * 记下最近一条用户消息的时间。
   * 这是 `turn_end` 去重的锚点：同一轮里模型重复调用 turn_end 时，
   * `lastRecordedAt >= lastUserMessageAt` 就说明这一轮已经写过了。
   */
  noteUserMessage(now = new Date()) {
    this.state.lastUserMessageAt = now.toISOString()
    this.persist()
  }

  /** 这一轮（最后一条用户消息之后）是否已经记录过。 */
  turnAlreadyRecorded() {
    const lastRecorded = Date.parse(this.state.lastRecordedAt ?? '') || 0
    const lastUser = Date.parse(this.state.lastUserMessageAt ?? '') || 0
    return lastUser > 0 && lastRecorded >= lastUser
  }

  recordTurn(input = {}) {
    const now = new Date()
    // Multi-person conversations: the caller may name the speaker explicitly.
    if (typeof input?.speaker === 'string' && input.speaker.trim() !== '') {
      this.switchSpeaker(input.speaker, { create: true, reason: 'turn_end' })
    }
    /** 同一轮重复调用：只补“第一次没写的”内容，不重复计数、不重复写摘要 */
    const duplicate = this.turnAlreadyRecorded()
    // A recorded turn is by definition a real conversation exchange, so it also
    // counts the calendar day (idempotent: only the first event of a day counts).
    if (!duplicate) this.noteUserActivity(now)
    const speaker = this.currentSpeakerRecord()
    const result = { important: 0, minor: false, favorability: null, speaker: speaker?.name ?? null, duplicate }
    const important = Array.isArray(input?.important) ? input.important : []
    for (const item of important) {
      const text = typeof item === 'string' ? item : item?.text
      const tags = typeof item === 'object' && item !== null ? item?.tags : undefined
      const weight = typeof item === 'object' && item !== null ? item?.weight : undefined
      if (this.addMemory(text, tags, { source: 'turn', speakerId: speaker?.id, weight })) result.important += 1
    }
    // ⚠️ 工具 schema 用的是 snake_case（minor_summary / turn_summary），
    //    这里两种写法都接受 —— 之前只读 camelCase，导致摘要压根没写进去，
    //    模型看到回执里没有“摘要已写入”，就会再调一次 turn_end（今天 token 暴涨的直接原因）。
    const minorRaw = input?.minorSummary ?? input?.minor_summary
    const turnRaw = input?.turnSummary ?? input?.turn_summary
    const minor = typeof minorRaw === 'string' ? minorRaw.trim() : ''
    const turnSummary = typeof turnRaw === 'string' ? turnRaw.trim() : ''
    const summary = minor || turnSummary
    if (summary !== '' && !duplicate) {
      this.appendArchive('minor', `摘要：${summary}`, { source: 'turn', speakerName: speaker?.name }, now)
      result.minor = true
    }
    if (input?.favorability && Number.isFinite(Number(input.favorability.value))) {
      result.favorability = this.setFavorability(input.favorability.value, input.favorability.reason, speaker?.id)
    }
    // turn_end 里也可以直接带 bond（羁绊值增减量）：好感度满 ±100 后，同一次调用就能继续累积。
    if (Number.isFinite(Number(input?.bond)) && Math.round(Number(input.bond)) !== 0) {
      const bondReason = typeof input?.favorability?.reason === 'string' && input.favorability.reason.trim() !== ''
        ? input.favorability.reason.trim()
        : (typeof input?.bondReason === 'string' && input.bondReason.trim() !== ''
          ? input.bondReason.trim()
          : '本轮关系进一步加深')
      result.bond = this.addBond(speaker?.id, input.bond, bondReason)
    }
    if (speaker && !duplicate) this.noteSpeakerTurn(speaker.id, now)
    this.state.lastRecordedAt = now.toISOString()
    if (!duplicate) this.state.stats.turnsRecorded += 1
    this.persist()
    return result
  }

  // ── favorability ─────────────────────────────────────────────────────────

  /**
   * 配置：好感度下降时是否先扣羁绊（默认开）。
   * 关掉就恢复旧行为——直接扣好感度，只有超过 -100 的部分才动羁绊。
   */
  bondAbsorbsDeduction() {
    const raw = this.config && typeof this.config === 'object' ? this.config.bondAbsorption : undefined
    if (raw === false) return false
    if (raw && typeof raw === 'object' && raw.enabled === false) return false
    return true
  }

  setFavorability(value, reason, speakerRef, options = {}) {
    const reasonText = typeof reason === 'string' ? reason.trim() : ''
    if (!Number.isFinite(Number(value))) throw new Error('好感度必须是数字（-100 ~ 100；超出部分会计入羁绊值）')
    if (reasonText === '') throw new Error('好感度变动必须写明理由')
    const speaker = this.resolveSpeaker(speakerRef ?? this.state.currentSpeaker, { create: true })
    if (!speaker) throw new Error('没有识别到好感度归属的说话人')
    const requested = Math.round(Number(value))
    const target = Math.max(-100, Math.min(100, requested))
    const from = speaker.favorability
    // 好感度上限 ±100；模型给出超过上限的值时，多出来的部分记进「羁绊值」（无上限、可正可负）。
    const overflow = requested - target
    // 满值同向推动：好感度已经在 ±100，模型仍写回同一个满值（说明这一轮关系又深了一点），
    // 记 1 点羁绊——否则「还是这么喜欢」会被当成没有变化，羁绊永远不涨。
    const capPush = target === from && overflow === 0 && Math.abs(target) === 100 ? (target > 0 ? 1 : -1) : 0
    const bondFrom = Number.isFinite(Number(speaker.bond)) ? Number(speaker.bond) : 0
    let bondDelta = overflow + capPush
    // 羁绊当缓冲垫：好感度要往下掉时，先扣羁绊；羁绊不够的那部分才从好感度里扣。
    // 面板手动拖动（options.manual）不走这条，用户直接改就是直接改。
    const drop = from - target
    let absorbed = 0
    let valueTo = target
    if (this.bondAbsorbsDeduction() && options && options.manual !== true && drop > 0 && bondFrom > 0) {
      absorbed = Math.min(bondFrom, drop)
      valueTo = from - (drop - absorbed)
      bondDelta -= absorbed
    }
    const bondTo = bondFrom + bondDelta
    if (valueTo === from && bondDelta === 0) {
      return { changed: false, value: from, bond: bondFrom, speaker: speaker.name }
    }
    const now = new Date()
    const entry = {
      at: now.toISOString(),
      day: formatDay(now),
      value: valueTo,
      from,
      reason: reasonText,
      speakerId: speaker.id,
      speakerName: speaker.name,
    }
    if (absorbed !== 0) entry.absorbed = absorbed
    if (bondDelta !== 0) {
      entry.bond = bondTo
      entry.bondFrom = bondFrom
      entry.overflow = bondDelta
      if (capPush !== 0) entry.capPush = capPush
    }
    speaker.favorability = valueTo
    if (bondDelta !== 0) speaker.bond = bondTo
    if (speaker.id === this.state.currentSpeaker) this.state.favorability = valueTo
    this.state.favorabilityHistory.push(entry)
    if (this.state.favorabilityHistory.length > 500) {
      this.state.favorabilityHistory.splice(0, this.state.favorabilityHistory.length - 500)
    }
    const absorbNote = absorbed !== 0
      ? `（羁绊先行吸收 ${absorbed}，好感度 ${from} → ${valueTo}）`
      : ''
    this.appendArchive('favorability', bondDelta !== 0
      ? `${reasonText}${absorbNote || `（好感度已达上限，${overflow !== 0 ? `溢出 ${overflow > 0 ? '+' : ''}${overflow}` : '满值同向推动'} 计入羁绊值：${bondTo}）`}`
      : `${reasonText}${absorbNote}`, {
      value: target,
      from,
      reason: reasonText,
      speakerId: speaker.id,
      speakerName: speaker.name,
      ...(bondDelta !== 0 ? { bond: bondTo, overflow: bondDelta, ...(capPush !== 0 ? { capPush } : {}) } : {}),
    }, now)
    this.persist()
    return {
      changed: valueTo !== from,
      bondChanged: bondDelta !== 0,
      value: valueTo,
      from,
      bond: Number.isFinite(Number(speaker.bond)) ? Number(speaker.bond) : 0,
      bondFrom,
      overflow,
      capPush,
      absorbed,
      reason: reasonText,
      speaker: speaker.name,
    }
  }

  /**
   * 直接增减「羁绊值」（无上限，可正可负）。好感度到达 ±100 后，
   * AI 还可以继续用它记录更深的关系累积。
   */
  addBond(speakerRef, delta, reason) {
    const reasonText = typeof reason === 'string' ? reason.trim() : ''
    if (!Number.isFinite(Number(delta)) || Math.round(Number(delta)) === 0) throw new Error('羁绊值增减必须是非零数字')
    if (reasonText === '') throw new Error('羁绊值变动必须写明理由')
    const speaker = this.resolveSpeaker(speakerRef ?? this.state.currentSpeaker, { create: true })
    if (!speaker) throw new Error('没有识别到羁绊归属的说话人')
    const step = Math.round(Number(delta))
    const from = Number.isFinite(Number(speaker.bond)) ? Number(speaker.bond) : 0
    speaker.bond = from + step
    const now = new Date()
    this.state.favorabilityHistory.push({
      at: now.toISOString(),
      day: formatDay(now),
      value: speaker.favorability,
      from: speaker.favorability,
      reason: reasonText,
      speakerId: speaker.id,
      speakerName: speaker.name,
      bond: speaker.bond,
      bondFrom: from,
      overflow: step,
      bondOnly: true,
    })
    if (this.state.favorabilityHistory.length > 500) {
      this.state.favorabilityHistory.splice(0, this.state.favorabilityHistory.length - 500)
    }
    this.appendArchive('favorability', `${reasonText}（羁绊值 ${from} → ${speaker.bond}）`, {
      value: speaker.favorability,
      from: speaker.favorability,
      reason: reasonText,
      speakerId: speaker.id,
      speakerName: speaker.name,
      bond: speaker.bond,
      bondFrom: from,
      bondOnly: true,
    }, now)
    this.persist()
    return { changed: true, bond: speaker.bond, bondFrom: from, reason: reasonText, speaker: speaker.name }
  }

  /**
   * Undo the newest favorability change. The history entry is removed and the
   * previous value is restored, so a wrong AI judgement can be taken back
   * without inventing another "reason" for the correction. The original archive
   * line stays untouched (archives are append-only).
   */
  undoLastFavorability(speakerRef) {
    const speaker = speakerRef === undefined ? this.currentSpeakerRecord() : this.speakerById(speakerRef)
    const history = this.state.favorabilityHistory
    let index = -1
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (!speaker || history[i].speakerId === undefined || history[i].speakerId === speaker.id) {
        index = i
        break
      }
    }
    if (index < 0) throw new Error('没有可撤销的好感度变动')
    const entry = history.splice(index, 1)[0]
    const targetSpeaker = this.speakerById(entry.speakerId) ?? speaker
    const restored = Number.isFinite(entry.from) ? entry.from : (targetSpeaker?.favorability ?? this.state.favorability)
    if (targetSpeaker) {
      targetSpeaker.favorability = Math.max(-100, Math.min(100, Math.round(restored)))
      // 这次变动如果同时动了羁绊值，也一起还原
      if (Number.isFinite(Number(entry.bondFrom))) targetSpeaker.bond = Math.round(Number(entry.bondFrom))
    }
    if (!targetSpeaker || targetSpeaker.id === this.state.currentSpeaker) {
      this.state.favorability = Math.max(-100, Math.min(100, Math.round(restored)))
    }
    this.persist()
    return {
      value: this.state.favorability,
      bond: targetSpeaker && Number.isFinite(Number(targetSpeaker.bond)) ? Number(targetSpeaker.bond) : 0,
      reverted: entry,
      speaker: targetSpeaker?.name ?? null,
    }
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

  // ── context compression ──────────────────────────────────────────────────
  //
  // Long conversations get their oldest span compressed into a companion-style
  // memory block (important verbatim + minor digest + favorability + pending
  // items). The block is archived into the local knowledge base under packs/
  // and replaces the raw span in the model-visible surface.

  contextCompressionInfo() {
    const config = this.state.contextCompression ?? {}
    return {
      count: Number.isFinite(config.count) ? config.count : 0,
      lastAt: typeof config.lastAt === 'string' ? config.lastAt : null,
      lastFile: typeof config.lastFile === 'string' ? config.lastFile : null,
      shadowedTokens: Number.isFinite(config.shadowedTokens) ? config.shadowedTokens : 0,
      lastRange: config.lastRange && typeof config.lastRange === 'object' ? config.lastRange : null,
    }
  }

  writeContextCompression(input, now = new Date()) {
    const summary = typeof input?.summary === 'string' ? input.summary.trim() : ''
    if (summary === '') throw new Error('上下文压缩摘要不能为空')
    const config = this.state.contextCompression
    const count = (Number.isFinite(config.count) ? config.count : 0) + 1
    const shadowedTokens = Math.max(0, Number(input?.shadowedTokens) || 0)
    const rawStart = Number(input?.seqStart)
    const rawEnd = Number(input?.seqEnd)
    const seqStart = Number.isFinite(rawStart) ? rawStart : null
    const seqEnd = Number.isFinite(rawEnd) ? rawEnd : null
    const nodeCount = Number.isFinite(Number(input?.nodeCount)) ? Number(input.nodeCount) : 0
    const reason = input?.reason === 'overflow' ? 'overflow' : 'pressure'
    const fileName = `上下文压缩_第${count}次_${formatDay(now)}.md`
    const lines = []
    lines.push(`# 对话上下文压缩 · 第${count}次`)
    lines.push('')
    lines.push(`归档日期：${formatDateTime(now)}`)
    lines.push('')
    lines.push(`- 触发原因：${reason === 'overflow' ? '上下文溢出恢复' : '上下文接近模型窗口上限'}`)
    lines.push(`- 覆盖范围：surface 节点 ${nodeCount} 个（起始 seq ${seqStart ?? '?'}，结束 seq ${seqEnd ?? '?'}）`)
    lines.push(`- 压缩前估算：约 ${shadowedTokens} tokens`)
    lines.push(`- 摘要模型：${input?.provider ?? '?'} / ${input?.model ?? '?'}`)
    lines.push('')
    lines.push('> 本文件是「较早对话」的压缩记忆，供角色回忆使用；原文仍保存在本地会话日志与归档中，需要细节时可用知识库检索。')
    lines.push('')
    lines.push(summary)
    const content = `${lines.join('\n')}\n`
    const relative = `packs/${fileName}`
    writeFileAtomic(join(this.dir, 'packs', fileName), content)
    config.count = count
    config.lastAt = now.toISOString()
    config.lastFile = relative
    config.shadowedTokens = (Number.isFinite(config.shadowedTokens) ? config.shadowedTokens : 0) + shadowedTokens
    config.lastRange = { startSeq: seqStart, endSeq: seqEnd, nodes: nodeCount, tokens: shadowedTokens, reason }
    this.state.stats.contextCompressions = (Number.isFinite(this.state.stats.contextCompressions) ? this.state.stats.contextCompressions : 0) + 1
    this.appendArchive('contextcompress', `已生成上下文压缩记忆：${fileName}`, { file: relative, count, shadowedTokens, reason }, now)
    this.persist()
    return { file: relative, count, shadowedTokens, archivedAt: formatDateTime(now) }
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
    const lastSummary = this.state.lastSummaryAt ? Date.parse(this.state.lastSummaryAt) : null
    const firstActivity = this.state.interactionDayLog[0]?.at ? Date.parse(this.state.interactionDayLog[0].at) : null
    const lastActivity = this.state.lastActivityAt ? Date.parse(this.state.lastActivityAt) : null
    const activitySince = lastActivity !== null && (lastSummary === null || lastActivity > lastSummary)
    // The 48-hour summary is measured in CHAT hours: only conversations advance
    // it. The clock runs from the last summary (or the first chat day) up to the
    // latest conversation, then it is paused by any silence — so coming back
    // after days away does not fail the period immediately.
    const reference = lastActivity !== null && (lastSummary === null || lastActivity > lastSummary) ? lastActivity : null
    const timeExpired = reference !== null && lastSummary !== null ? reference - lastSummary >= SUMMARY_INTERVAL_MS : false
    const nextDueAt = reference !== null
      ? new Date((lastSummary ?? reference) + SUMMARY_INTERVAL_MS).toISOString()
      : null
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
    let hierarchy = []
    try {
      for (const name of readdirSync(join(this.dir, 'hierarchy'))) {
        if (!name.endsWith('.md')) continue
        hierarchy.push({ path: `hierarchy/${name}`, kind: 'hierarchy', day: '', bytes: safeSize(join(this.dir, 'hierarchy', name)) })
      }
    } catch {
      // missing dir → empty
    }
    archive.sort((left, right) => (left.day < right.day ? 1 : -1))
    monthly.sort((left, right) => (left.path < right.path ? 1 : -1))
    packs.sort((left, right) => (left.path < right.path ? 1 : -1))
    hierarchy.sort((left, right) => (left.path < right.path ? 1 : -1))
    return { archive, monthly, packs, hierarchy }
  }

  readKbFile(relativePath) {
    const clean = String(relativePath ?? '').replace(/\\/g, '/')
    if (!/^(archive|monthly|packs|hierarchy)\/[^/]+\.md$/.test(clean)) throw new Error('非法文件路径')
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
      const sections = relativePath.startsWith('monthly/') || relativePath.startsWith('packs/') || relativePath.startsWith('hierarchy/')
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
    // 1.1.0-A：高层摘要（跨年沉积 + 最新年报）优先参与检索，旧事先看它们
    for (const item of files.hierarchy ?? []) scan(item.path, item.day)
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

  // ── self-evolution of the persona ────────────────────────────────────────
  //
  // The user-owned documents are the fixed core; this layer is what the
  // companion itself may slowly grow during a long relationship: extra traits,
  // things it came to like or dislike, and habits it picked up. It is additive
  // by design (the core persona cannot be rewritten) and every AI change must
  // carry a story reason.

  evolutionDef(sectionKey) {
    return EVOLUTION_SECTIONS.find((item) => item.key === sectionKey) ?? null
  }

  evolutionState() {
    if (!this.state.evolution || typeof this.state.evolution !== 'object') {
      this.state.evolution = normalizeEvolutionState(null)
    }
    const evolution = this.state.evolution
    let dirty = false
    if (!evolution.sections || typeof evolution.sections !== 'object') {
      evolution.sections = {}
      dirty = true
    }
    for (const definition of EVOLUTION_SECTIONS) {
      if (!Array.isArray(evolution.sections[definition.key])) {
        evolution.sections[definition.key] = []
        dirty = true
      }
    }
    if (!Array.isArray(evolution.log)) {
      evolution.log = []
      dirty = true
    }
    if (dirty) this.persist()
    return evolution
  }

  evolutionSnapshot() {
    const evolution = this.evolutionState()
    const sections = {}
    const order = []
    let total = 0
    for (const definition of EVOLUTION_SECTIONS) {
      const entries = evolution.sections[definition.key].slice()
      total += entries.length
      order.push(definition.key)
      sections[definition.key] = { key: definition.key, label: definition.label, hint: definition.hint, entries }
    }
    return {
      order,
      sections,
      total,
      limit: EVOLUTION_SECTION_LIMIT,
      updatedAt: evolution.updatedAt ?? null,
      log: evolution.log.slice(-20).reverse(),
    }
  }

  /**
   * Add and/or remove self-evolution entries.
   * @param {{section?: string, add?: Array<string|{text?: string, reason?: string}>, remove?: string[], reason?: string, by?: 'ai'|'user'}} input
   */
  evolvePersona(input = {}) {
    const evolution = this.evolutionState()
    const definition = this.evolutionDef(input.section)
    if (!definition) {
      throw new Error(`未知的演化分区：${input.section || '(空)'}。可选：${EVOLUTION_SECTIONS.map((item) => item.key).join('、')}`)
    }
    const by = input.by === 'user' ? 'user' : 'ai'
    const sharedReason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 160) : ''
    const rawAdds = Array.isArray(input.add) ? input.add : typeof input.add === 'string' ? [input.add] : []
    const additions = rawAdds
      .map((item) => {
        if (typeof item === 'string') return { text: item, reason: sharedReason, weight: EVOLUTION_WEIGHT_DEFAULT }
        if (item && typeof item === 'object') {
          return {
            text: item.text ?? item.value ?? '',
            reason: typeof item.reason === 'string' ? item.reason.trim() : sharedReason,
            weight: item.weight === undefined || item.weight === null ? EVOLUTION_WEIGHT_DEFAULT : normalizeEvolutionWeight(item.weight),
          }
        }
        return { text: '', reason: sharedReason, weight: EVOLUTION_WEIGHT_DEFAULT }
      })
      .filter((item) => String(item.text ?? '').trim() !== '')
    const removals = Array.isArray(input.remove)
      ? [...new Set(input.remove.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
      : []
    if (additions.length === 0 && removals.length === 0) throw new Error('evolve 需要 add 或 remove 至少一项。')
    if (additions.length > 3) throw new Error('一次最多新增 3 条：角色的变化是慢慢长出来的，不要一口气加太多。')
    if (removals.length > 3) throw new Error('一次最多删除 3 条。')

    const entries = evolution.sections[definition.key]
    const now = new Date()
    const removed = []
    for (const id of removals) {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index < 0) continue
      const [entry] = entries.splice(index, 1)
      removed.push(entry)
      evolution.log.push({ at: now.toISOString(), action: 'remove', section: definition.key, id: entry.id, text: entry.text, reason: sharedReason || '手动移除', by })
    }

    const added = []
    const skipped = []
    for (const addition of additions) {
      const text = String(addition.text ?? '').replace(/\s+/g, ' ').trim()
      if (text === '') continue
      if (text.length > 120) throw new Error(`单条演化内容请控制在 120 字以内：「${text.slice(0, 20)}…」`)
      const reason = String(addition.reason ?? '').trim().slice(0, 160)
      if (by === 'ai' && reason === '') throw new Error('AI 自我演化必须带 reason（剧情里发生了什么，才让它有这样的变化）。')
      const normalized = text.toLowerCase()
      if (entries.some((entry) => entry.text.trim().toLowerCase() === normalized)) {
        skipped.push(text)
        continue
      }
      if (entries.length >= EVOLUTION_SECTION_LIMIT) {
        throw new Error(`「${definition.label}」最多保留 ${EVOLUTION_SECTION_LIMIT} 条，请先删除一些旧条目再新增。`)
      }
      const entry = {
        id: `evo_${randomBytes(4).toString('hex')}`,
        text,
        reason: reason || (by === 'user' ? '用户手动添加' : ''),
        weight: normalizeEvolutionWeight(addition.weight),
        by,
        at: now.toISOString(),
        day: formatDay(now),
      }
      entries.push(entry)
      added.push(entry)
      evolution.log.push({ at: now.toISOString(), action: 'add', section: definition.key, id: entry.id, text: entry.text, reason: entry.reason, by })
    }

    if (evolution.log.length > EVOLUTION_LOG_LIMIT) evolution.log = evolution.log.slice(-EVOLUTION_LOG_LIMIT)
    if (added.length > 0 || removed.length > 0) evolution.updatedAt = now.toISOString()
    if (added.length > 0) this.state.stats.evolutions = (Number(this.state.stats.evolutions) || 0) + added.length
    this.persist()
    return {
      section: definition.key,
      label: definition.label,
      added,
      removed: removed.map((entry) => entry.id),
      skipped,
      total: entries.length,
      limit: EVOLUTION_SECTION_LIMIT,
    }
  }

  /** 调整某条演化条目的权重（用户手动改；AI 只能用 evolve 新增时带 weight）。 */
  setEvolutionWeight(section, id, weight) {
    const evolution = this.evolutionState()
    const definition = this.evolutionDef(section)
    if (!definition) {
      throw new Error(`未知的演化分区：${section || '(空)'}。可选：${EVOLUTION_SECTIONS.map((item) => item.key).join('、')}`)
    }
    const entry = evolution.sections[definition.key].find((item) => item.id === id)
    if (!entry) throw new Error('没有找到这条演化条目')
    const next = normalizeEvolutionWeight(weight)
    const from = normalizeEvolutionWeight(entry.weight)
    if (next === from) return { changed: false, section: definition.key, id, from, weight: next }
    entry.weight = next
    evolution.updatedAt = new Date().toISOString()
    evolution.log.push({
      at: evolution.updatedAt,
      action: 'weight',
      section: definition.key,
      id,
      text: entry.text,
      reason: `权重 ${from} → ${next}`,
      by: 'user',
    })
    if (evolution.log.length > EVOLUTION_LOG_LIMIT) evolution.log = evolution.log.slice(-EVOLUTION_LOG_LIMIT)
    this.persist()
    return { changed: true, section: definition.key, id, from, weight: next }
  }

  // ── 重复提问 → 全局记忆 ──────────────────────────────────────────────────

  /** 配置：重复提问检测（默认开启，3 次起算）。 */
  recurringQuestionSettings() {
    const raw = this.config && typeof this.config === 'object' ? this.config.recurringQuestions : undefined
    const source = raw && typeof raw === 'object' ? raw : {}
    const minCount = Math.max(2, Number(source.minCount) || 3)
    const maxTracked = Math.max(20, Number(source.maxTracked) || 200)
    return { enabled: source.enabled !== false, minCount, maxTracked }
  }

  /**
   * 统计一句用户消息是否属于"反复在问的事"。达到阈值后自动落一条活跃记忆。
   * 返回 { counted, count, promoted }；不改变对话行为，失败也不该影响主流程。
   */
  noteUserQuestion(text, now = new Date()) {
    const settings = this.recurringQuestionSettings()
    if (!settings.enabled) return { counted: false, count: 0, promoted: null }
    const key = normalizeQuestionKey(text)
    if (key === '') return { counted: false, count: 0, promoted: null }
    const stats = this.state.questionStats
    let entry = null
    if (stats[key]) {
      entry = stats[key]
    } else {
      // 近似重复（换个说法问同一件事）：与已存在的条目做二元组重合度比较。
      entry = findSimilarQuestion(stats, key)
    }
    const at = now.toISOString()
    const day = formatDay(now)
    if (!entry) {
      if (Object.keys(stats).length >= settings.maxTracked) return { counted: false, count: 0, promoted: null }
      stats[key] = {
        text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        count: 1,
        firstAt: at,
        lastAt: at,
        firstDay: day,
        lastDay: day,
        memoryId: null,
      }
      this.persist()
      return { counted: true, count: 1, promoted: null }
    }
    entry.count = (Number(entry.count) || 0) + 1
    entry.lastAt = at
    entry.lastDay = day
    if (!entry.memoryId && entry.count >= settings.minCount) {
      const weight = Math.min(100, 55 + (entry.count - settings.minCount) * 5)
      const memory = this.addMemory(`用户经常问：${entry.text}`, ['常问'], {
        source: 'recurring',
        weight,
        recurringCount: entry.count,
      })
      if (memory) entry.memoryId = memory.id
      this.state.stats.recurringMemories = (Number(this.state.stats.recurringMemories) || 0) + (memory ? 1 : 0)
      this.persist()
      return { counted: true, count: entry.count, promoted: memory }
    }
    if (entry.memoryId) {
      // 已经落过记忆：更新次数与权重（问得越多越重要）。
      const memory = this.state.memories.find((item) => item.id === entry.memoryId && !item.archived)
      if (memory) {
        memory.recurringCount = entry.count
        memory.weight = Math.max(normalizeMemoryWeight(memory.weight), Math.min(100, 55 + (entry.count - settings.minCount) * 5))
      }
    }
    this.persist()
    return { counted: true, count: entry.count, promoted: null }
  }

  // ── panel snapshot ───────────────────────────────────────────────────────

  snapshot() {
    const now = new Date()
    const period = this.periodInfo(now)
    // 统一走 sortedActiveMemories（置顶 → 权重 → 手动顺序），面板和提示词才能一致。
    const active = this.sortedActiveMemories()
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
      characterName: this.characterNameValue(),
      characterNameGlobal: this.characterNameGlobal(),
      characterNameOverride: this.characterNameOverride(),
      docs: this.readDocs(),
      aiEditDocs: this.aiEditDocRules(),
      replyStyle: this.replyStyleSettings(),
      docSchema: DOC_SCHEMA,
      docFields: this.readDocFieldsAll(),
      favorability: this.state.favorability,
      speakers: this.speakersSnapshot(),
      currentSpeaker: this.state.currentSpeaker,
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
      contextCompression: this.contextCompressionInfo(),
      evolution: this.evolutionSnapshot(),
      stats: this.state.stats,
      updatedAt: now.toISOString(),
    }
  }

  // ── portable memory bundle (export / import) ─────────────────────────────
  //
  // One self-describing JSON document carrying everything that makes this
  // conversation "the same character": the three editable documents, the
  // state (favorability, active memories, interaction-day counters, cycles,
  // packing settings) and the knowledge base files. Importing it into another
  // conversation reproduces the previous state instead of starting over.

  exportBundle(meta = {}) {
    const now = new Date()
    const docs = {}
    for (const definition of DOC_DEFS) docs[definition.key] = this.readDoc(definition.key)

    // ── 聊天原文：导出时把「说过的话」一起带走 ────────────────────────────────
    // 「说过的话」有两个来源，都要包含：
    //   ① 调用方给的 transcript（活会话里的全部消息，含还没被打包进知识库的上下文）；
    //   ② 插件自己的 48 小时热缓存（recent.json）。
    // 有 transcript 用 transcript，没有就退回热缓存；两者都存在时也把热缓存单独留一份。
    const transcript = Array.isArray(meta.transcript) ? meta.transcript.filter(isTranscriptMessage) : []
    const recentEntries = Array.isArray(this.recent?.entries) ? this.recent.entries : []
    const recentMessages = recentEntries
      .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim() !== '')
      .map((entry) => ({
        at: new Date(Number(entry.ts) || Date.now()).toISOString(),
        role: entry.role === 'user' ? 'user' : 'assistant',
        text: String(entry.text),
      }))
    const conversationSource = transcript.length > 0 ? 'session' : recentMessages.length > 0 ? 'recent' : 'none'
    const conversationMessages = transcript.length > 0 ? transcript : recentMessages
    const conversationMarkdown = renderConversationMarkdown(conversationMessages, {
      title: typeof meta.title === 'string' ? meta.title : '',
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
    })

    const files = {}
    for (const group of ['archive', 'monthly', 'packs', 'hierarchy']) {
      const folder = join(this.dir, group)
      let names = []
      try {
        names = readdirSync(folder).filter((name) => name.endsWith('.md'))
      } catch {
        names = []
      }
      for (const name of names) {
        const relative = `${group}/${name}`
        try {
          files[relative] = readFileSync(join(folder, name), 'utf8')
        } catch {
          // Unreadable files are skipped rather than failing the whole export.
        }
      }
    }
    const bundle = {
      $format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      plugin: { name: 'companion-memory', version: BUNDLE_PLUGIN_VERSION },
      exportedAt: now.toISOString(),
      exportedAtLocal: formatDateTime(now),
      source: {
        sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
        title: typeof meta.title === 'string' ? meta.title : null,
        dataDir: this.dir,
      },
      summary: {
        favorability: this.state.favorability,
        speakers: this.speakersSnapshot().length,
        interactionDays: this.state.interactionDays,
        firstInteractionDay: this.state.firstInteractionDay,
        lastInteractionDay: this.state.lastInteractionDay,
        activeMemories: this.activeMemories().length,
        archivedMemories: this.state.memories.filter((memory) => memory.archived).length,
        favorabilityChanges: this.state.favorabilityHistory.length,
        knowledgeFiles: Object.keys(files).length,
        evolutionEntries: Object.values(this.state.evolution.sections).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
        conversationMessages: conversationMessages.length,
        conversationSource,
      },
      docs,
      state: this.state,
      knowledge: files,
      // 聊天原文：message 数组（方便程序读）+ markdown（方便人看）
      conversation: {
        source: conversationSource,
        counts: {
          total: conversationMessages.length,
          user: conversationMessages.filter((message) => message.role === 'user').length,
          assistant: conversationMessages.filter((message) => message.role === 'assistant').length,
          recentWindow: recentMessages.length,
        },
        messages: conversationMessages,
        markdown: conversationMarkdown,
        // 48 小时热缓存单独留一份（即使已经有完整 transcript 也不丢）
        recentMessages,
      },
    }
    return {
      bundle,
      suggestedName: `伴侣记忆_${(bundle.source.title || '对话').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 32)}_${formatDay(now)}.json`,
    }
  }

  importBundle(input, options = {}) {
    if (!input || typeof input !== 'object') throw new Error('导入内容不是有效的伴侣记忆文档。')
    if (input.$format !== BUNDLE_FORMAT) {
      throw new Error('这不是伴侣记忆导出文档（缺少 $format 标记），请选择由本插件「导出」得到的文件。')
    }
    if (Number(input.formatVersion) > BUNDLE_FORMAT_VERSION) {
      throw new Error('导出文档版本比当前插件更新，请先升级伴侣记忆插件。')
    }
    const merge = options.merge === true
    const bundle = input
    const docs = bundle.docs && typeof bundle.docs === 'object' ? bundle.docs : {}
    const knowledge = bundle.knowledge && typeof bundle.knowledge === 'object' ? bundle.knowledge : {}
    const state = bundle.state && typeof bundle.state === 'object' ? bundle.state : null

    // Documents: always take the bundle's text verbatim (they define the persona).
    let docsWritten = 0
    for (const definition of DOC_DEFS) {
      const text = docs[definition.key]
      if (typeof text === 'string' && text !== '') {
        this.writeDoc(definition.key, text)
        docsWritten += 1
      }
    }

    // Knowledge base: never overwrite an existing file unless merging was asked for.
    let filesWritten = 0
    let filesSkipped = 0
    for (const [relative, text] of Object.entries(knowledge)) {
      if (typeof text !== 'string') continue
      if (!/^(archive|monthly|packs|hierarchy)\/[^/\\]+\.md$/.test(relative)) continue
      const target = join(this.dir, relative)
      if (existsSync(target) && !merge) {
        filesSkipped += 1
        continue
      }
      writeFileAtomic(target, text)
      filesWritten += 1
    }

    // State: restore the memory/favorability/counter layer.
    if (state) {
      const blank = defaultState()
      const restored = { ...blank, ...state }
      restored.cycle = { ...blank.cycle, ...(state.cycle ?? {}) }
      restored.autoPack = { ...blank.autoPack, ...(state.autoPack ?? {}) }
      restored.stats = { ...blank.stats, ...(state.stats ?? {}) }
      if (!Array.isArray(restored.memories)) restored.memories = []
      if (!Array.isArray(restored.archiveEntries)) restored.archiveEntries = []
      if (!Array.isArray(restored.favorabilityHistory)) restored.favorabilityHistory = []
      if (!Array.isArray(restored.interactionDayLog)) restored.interactionDayLog = []
      if (!Array.isArray(restored.cycle.packaged)) restored.cycle.packaged = []
      if (!Number.isFinite(Number(restored.favorability))) restored.favorability = 0
      restored.evolution = merge ? mergeEvolutionState(restored.evolution, this.state.evolution) : normalizeEvolutionState(restored.evolution)
      // 1.1.0-A：层级摘要索引跟 state 一起走（缺省时补空结构）
      restored.hierarchy = { ...defaultState().hierarchy, ...(restored.hierarchy && typeof restored.hierarchy === 'object' ? restored.hierarchy : {}) }
      if (merge) {
        // Merge mode: keep this conversation's counters and append histories.
        const current = this.state
        restored.interactionDays = Math.max(current.interactionDays, restored.interactionDays)
        restored.firstInteractionDay =
          current.firstInteractionDay && restored.firstInteractionDay
            ? [current.firstInteractionDay, restored.firstInteractionDay].sort()[0]
            : current.firstInteractionDay || restored.firstInteractionDay
        restored.lastInteractionDay = current.lastInteractionDay || restored.lastInteractionDay
        restored.memories = dedupeBy([...restored.memories, ...current.memories], (memory) => memory.id || memory.text)
        restored.archiveEntries = dedupeBy([...restored.archiveEntries, ...current.archiveEntries], (entry) => entry.id || `${entry.kind}:${entry.at}:${entry.text}`)
        restored.favorabilityHistory = dedupeBy([...restored.favorabilityHistory, ...current.favorabilityHistory], (change) => `${change.at}:${change.value}:${change.reason}`)
        restored.cycle = current.cycle
        restored.autoPack = current.autoPack
        restored.stats = {
          turnsRecorded: Math.max(Number(restored.stats.turnsRecorded) || 0, Number(current.stats.turnsRecorded) || 0),
          summaries: (Number(restored.stats.summaries) || 0) + (Number(current.stats.summaries) || 0),
          monthlyPackages: Math.max(Number(restored.stats.monthlyPackages) || 0, Number(current.stats.monthlyPackages) || 0),
          autoPacks: Math.max(Number(restored.stats.autoPacks) || 0, Number(current.stats.autoPacks) || 0),
        }
        restored.favorability = current.favorabilityHistory.length >= restored.favorabilityHistory.length ? current.favorability : restored.favorability
      }
      this.state = restored
      this.normalizeSpeakers()
      this.persist()
    }

    // ── 聊天原文：把「说过的话」一起带进来 ────────────────────────────────────
    // 导入目标会话时，把导出包里的聊天原文写进知识库归档（可 search_kb/read_archive 检索），
    // 并灌进 48 小时热缓存（可 search_recent 检索），再留一条活跃记忆提醒角色「这些是发生过的」。
    let conversationImported = 0
    let conversationFile = ''
    let conversationChars = 0
    let conversationSkipped = 0
    try {
      const allMessages = Array.isArray(bundle.conversation?.messages)
        ? bundle.conversation.messages.filter(isTranscriptMessage).map((message) => ({
          at: typeof message.at === 'string' ? message.at : new Date().toISOString(),
          role: message.role,
          text: String(message.text),
        }))
        : []
      // 安全护栏：单次导入最多保留最近 500 条、单条最多 6000 字（更早的跳过，避免旧对话爆炸式灌进来）
      const MAX_IMPORT_MESSAGES = 500
      const MAX_IMPORT_CHARS = 6000
      const sliced = allMessages.length > MAX_IMPORT_MESSAGES ? allMessages.slice(-MAX_IMPORT_MESSAGES) : allMessages
      const incoming = sliced.map((message) => ({
        ...message,
        text: message.text.length > MAX_IMPORT_CHARS ? `${message.text.slice(0, MAX_IMPORT_CHARS)}…` : message.text,
      }))
      conversationSkipped = allMessages.length - incoming.length
      conversationChars = incoming.reduce((sum, message) => sum + message.text.length, 0)
      if (incoming.length > 0) {
        const sourceTitle = String((bundle.source && bundle.source.title) || '导入的对话').slice(0, 40)
        const safeTitle = sourceTitle.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24)
        const markdown = renderConversationMarkdown(incoming, { title: `从「${sourceTitle}」导入` })
        conversationFile = `archive/${formatDay(new Date())}-导入聊天原文-${safeTitle}.md`
        writeFileAtomic(join(this.dir, conversationFile), markdown)
        // 灌进热缓存：时间戳放在最近（否则会被「最近两个聊天日」窗口裁掉，检索不到）
        const base = Date.now()
        for (let index = 0; index < incoming.length; index += 1) {
          const message = incoming[index]
          this.recent.record(
            { role: message.role, text: message.text.length > 6000 ? `${message.text.slice(0, 6000)}…` : message.text },
            new Date(base - (incoming.length - index) * 1000),
          )
        }
        this.recent.persist()
        conversationImported = incoming.length
        this.appendArchive('important', `从「${sourceTitle}」导入了 ${incoming.length} 条聊天原文，保存在 ${conversationFile}；需要旧事细节时用 search_kb / read_archive 检索。`, {
          source: 'import',
          file: conversationFile,
          count: incoming.length,
        })
        // 把用户自己说过的关键事实抽成几条活跃记忆：这样不用检索也能直接记得
        // （比如「我晚饭吃了自助烤肉」——问「我吃了什么」时不必依赖字面检索命中）
        const factPattern = /(吃|喝|喜欢|讨厌|爱吃|不吃|名字|叫|生日|工作|学校|课|女朋友|男朋友|家里|住|习惯|答应|约定|记住)/
        const facts = incoming
          .filter((message) => message.role === 'user' && factPattern.test(message.text) && message.text.length <= 300)
          .slice(-6)
        for (const fact of facts) {
          this.addMemory(`用户曾说过：${fact.text.slice(0, 120)}`, ['导入', '用户说过'], { source: 'import' })
        }
        // 留一条活跃记忆，让她知道这些对话是真实发生过的（不是新对话）
        this.addMemory(
          `「${sourceTitle}」之前的聊天原文已导入（${incoming.length} 条，见 ${conversationFile}）：那是你们之前真实聊过的内容，用户提到以前的事时用 search_recent / search_kb 去查，不要说自己不记得。`,
          ['导入', '聊天原文'],
          { source: 'import' },
        )
        this.persist()
      }
    } catch {
      // 导入聊天原文失败不影响文档/状态导入
    }

    return {
      ok: true,
      merge,
      docsWritten,
      filesWritten,
      filesSkipped,
      hasState: Boolean(state),
      restoredFrom: bundle.exportedAt ?? null,
      restoredFromLocal: bundle.exportedAtLocal ?? null,
      favorability: this.state.favorability,
      interactionDays: this.state.interactionDays,
      activeMemories: this.activeMemories().length,
      conversationImported,
      conversationFile,
      conversationSkipped,
      conversationChars,
    }
  }
}

function dedupeBy(items, keyOf) {
  const seen = new Set()
  const output = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const key = String(keyOf(item))
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function safeSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 导出时判断一条记录是不是合法聊天消息。 */
function isTranscriptMessage(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.text !== 'string' || value.text.trim() === '') return false
  return value.role === 'user' || value.role === 'assistant'
}

/**
 * 把聊天原文渲染成人类可读的 Markdown（按日期分组，按时间排序）。
 * 导出 JSON 里同时放 messages 数组和这份 markdown：程序读数组，人读 markdown。
 */
function renderConversationMarkdown(messages, meta = {}) {
  const list = Array.isArray(messages) ? messages : []
  const lines = []
  lines.push(`# 聊天原文${meta.title ? `（${meta.title}）` : ''}`)
  lines.push('')
  lines.push(`导出时间：${formatDateTime(new Date())}`)
  if (meta.sessionId) lines.push(`会话：${meta.sessionId}`)
  lines.push(`共 ${list.length} 条（用户 ${list.filter((message) => message.role === 'user').length} / 角色 ${list.filter((message) => message.role === 'assistant').length}）`)
  lines.push('')
  let lastDay = ''
  for (const message of list) {
    const date = new Date(message.at)
    const valid = !Number.isNaN(date.getTime())
    const day = valid ? formatDayLocal(date) : '未知日期'
    if (day !== lastDay) {
      lines.push(`## ${day}`)
      lines.push('')
      lastDay = day
    }
    const clock = valid ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '--:--'
    const who = message.role === 'user' ? '用户' : '角色'
    const body = String(message.text).replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')
    lines.push(`- ${clock} **${who}**：${body}`)
  }
  if (list.length === 0) lines.push('（这个对话还没有可导出的聊天原文）')
  return lines.join('\n')
}

export function createStore(ctx, config) {
  const store = new CompanionStore(ctx, config)
  store.init()
  return store
}
