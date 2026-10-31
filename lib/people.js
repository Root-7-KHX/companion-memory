/**
 * people.js —— 平台人物档案（QQ 群成员识别用）
 *
 * 目标：同一个人 **改昵称、换了群、私聊还是群聊**，都能认回同一个「人」。
 *
 * QQ 官方给的是稳定 ID（群消息的 member_openid、私聊的 user_openid；
 * 在同一个机器人实例里这两者一致，见 dsh-qqbot 的 c2c-name 实测结论），
 * 昵称（senderName）只是随时可改的显示名。所以档案以稳定 ID 为主键，
 * 昵称只留作「当前名字 + 历史名字」：
 *
 *   <root>/people/<platform>-<safeId>.json
 *   {
 *     version: 1,
 *     platform: 'qq', instance?: '1906147757',
 *     externalId: 'E9020753...',
 *     currentName: '大肥鱼',
 *     names: [{ name: '旧名字', firstAt, lastAt }],      // 改名前用过的名字，最多 10 个
 *     renames: [{ from, to, at }],                       // 改名事件，最多 20 条
 *     firstSeenAt, lastSeenAt, msgCount
 *   }
 *
 * 只做「认人 + 记录」，不碰好感度：好感度仍然归每个对话自己的 speakers。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME_KEEP = 10
const RENAME_KEEP = 20
const MAX_NAME_LEN = 40
const MAX_ID_LEN = 128

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN)
}

function cleanPlatform(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return /^[a-z0-9_-]{1,24}$/.test(raw) ? raw : 'qq'
}

function cleanExternalId(value) {
  return String(value ?? '').trim().slice(0, MAX_ID_LEN)
}

/** 文件名只保留安全字符；查询/展示都用原始 externalId。 */
function fileSafeId(externalId) {
  const safe = externalId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 96)
  return safe === '' ? 'unknown' : safe
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return file
}

export class PeopleRegistry {
  constructor(rootDir) {
    this.root = String(rootDir ?? '')
    this.dir = join(this.root, 'people')
  }

  fileOf(platform, externalId) {
    return join(this.dir, fileSafeId(platform) + '-' + fileSafeId(externalId) + '.json')
  }

  ensureDir() {
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // 目录建不出来就算了，读侧会当空档案
    }
  }

  read(file) {
    try {
      if (!existsSync(file)) return null
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (!parsed || typeof parsed !== 'object') return null
      return this.normalize(parsed)
    } catch {
      return null
    }
  }

  normalize(raw) {
    const names = Array.isArray(raw.names)
      ? raw.names
          .filter((item) => item && typeof item === 'object' && cleanName(item.name) !== '')
          .map((item) => ({
            name: cleanName(item.name),
            firstAt: typeof item.firstAt === 'string' ? item.firstAt : null,
            lastAt: typeof item.lastAt === 'string' ? item.lastAt : null,
          }))
          .slice(-NAME_KEEP)
      : []
    const renames = Array.isArray(raw.renames)
      ? raw.renames
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            from: cleanName(item.from),
            to: cleanName(item.to),
            at: typeof item.at === 'string' ? item.at : null,
          }))
          .filter((item) => item.from !== '' && item.to !== '')
          .slice(-RENAME_KEEP)
      : []
    return {
      version: 1,
      platform: cleanPlatform(raw.platform),
      instance: typeof raw.instance === 'string' ? raw.instance.trim().slice(0, 64) : '',
      externalId: cleanExternalId(raw.externalId),
      currentName: cleanName(raw.currentName),
      names,
      renames,
      firstSeenAt: typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : new Date().toISOString(),
      lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : new Date().toISOString(),
      msgCount: Number.isFinite(Number(raw.msgCount)) ? Math.max(0, Math.round(Number(raw.msgCount))) : 0,
    }
  }

  persist(person) {
    this.ensureDir()
    const file = this.fileOf(person.platform, person.externalId)
    try {
      const tmp = writeJsonAtomic(file, person)
      return tmp
    } catch {
      return null
    }
  }

  /**
   * 登记一次「这个人刚说话」。
   * 昵称变化时：旧名进 names 历史、写一条 renames、currentName 换新名。
   * 返回 { person, created, renamed }，renamed = {from,to} 或 null。
   */
  upsert(input = {}) {
    const platform = cleanPlatform(input.platform)
    const externalId = cleanExternalId(input.externalId)
    if (externalId === '') throw new Error('people.upsert 需要 externalId')
    const name = cleanName(input.name)
    const now = new Date().toISOString()
    const file = this.fileOf(platform, externalId)
    const person = this.read(file) ?? {
      version: 1,
      platform,
      instance: '',
      externalId,
      currentName: '',
      names: [],
      renames: [],
      firstSeenAt: now,
      lastSeenAt: now,
      msgCount: 0,
    }
    if (typeof input.instance === 'string' && input.instance.trim() !== '') person.instance = input.instance.trim().slice(0, 64)
    let renamed = null
    if (name !== '' && name !== person.currentName) {
      if (person.currentName !== '') renamed = { from: person.currentName, to: name, at: now }
      if (person.currentName !== '') {
        const existing = person.names.find((item) => item.name === person.currentName)
        if (existing) existing.lastAt = now
        else person.names.push({ name: person.currentName, firstAt: person.lastSeenAt, lastAt: now })
      }
      person.currentName = name
      if (renamed) person.renames.push(renamed)
      person.names = person.names.slice(-NAME_KEEP)
      person.renames = person.renames.slice(-RENAME_KEEP)
    }
    person.lastSeenAt = now
    person.msgCount += 1
    this.persist(person)
    return { person: { ...person }, created: person.msgCount === 1, renamed }
  }

  get(platform, externalId) {
    return this.read(this.fileOf(cleanPlatform(platform), cleanExternalId(externalId)))
  }

  /** 列出所有平台人物（最近说话在前）；q 模糊匹配当前昵称/历史昵称/ID。 */
  list(options = {}) {
    this.ensureDir()
    const query = String(options.q ?? '').trim().toLowerCase()
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 200))
    const items = []
    let names = []
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.json'))
    } catch {
      return { dir: this.dir, items: [] }
    }
    for (const name of names) {
      const person = this.read(join(this.dir, name))
      if (!person) continue
      if (query !== '') {
        const haystack = [person.currentName, person.externalId, ...person.names.map((item) => item.name)].join(' ').toLowerCase()
        if (!haystack.includes(query)) continue
      }
      items.push(person)
    }
    items.sort((a, b) => (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0))
    return { dir: this.dir, items: items.slice(0, limit), total: items.length }
  }

  /** 档案目录（面板/桥接排查用） */
  info() {
    let files = 0
    try {
      files = readdirSync(this.dir).filter((name) => name.endsWith('.json')).length
    } catch {
      files = 0
    }
    return { dir: this.dir, count: files }
  }

  /** 给面板看的一条摘要。 */
  static summary(person) {
    if (!person) return null
    return {
      externalId: person.externalId,
      platform: person.platform,
      currentName: person.currentName,
      aliases: person.names.map((item) => item.name),
      renamedCount: person.renames.length,
      lastSeenAt: person.lastSeenAt,
      msgCount: person.msgCount,
    }
  }
}
