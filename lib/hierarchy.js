/**
 * 多级记忆压缩（1.1.0-A）：日 → 月 → 最新年报 → 滚动跨年沉积。
 *
 * 规则（见 docs/多级记忆压缩设计.md）：
 *  · 年度 = 12 个「30 交互日」周期（按聊天时间）；
 *  · 高层摘要只保留两份：`annual-最新.md`（最新年度，只压一轮）+ `epoch-累积.md`（所有更早年度，反复压）；
 *  · 新年度关闭时：`新 epoch = 压(旧 epoch + 旧年报)`，旧年报并入后不再单独保留（只留备份）；
 *  · `important` / pinned 记忆原样附在每份摘要末尾，绝不参与概括；
 *  · 原文（月度包/日归档）永不删除。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callModelText } from './llm-call.js'

export const CYCLES_PER_YEAR = 12
const MAX_MONTHLY_CHARS = 8000
const MAX_TOTAL_CHARS = 60000
const MAX_PINNED_CHARS = 6000
const ANNUAL_FILE = 'annual-最新.md'
const EPOCH_FILE = 'epoch-累积.md'

function hierarchyDir(store) {
  return join(store.dir, 'hierarchy')
}

function backupsDir(store) {
  return join(hierarchyDir(store), 'backups')
}

function ensureDirs(store) {
  mkdirSync(backupsDir(store), { recursive: true })
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function readText(store, relative) {
  try {
    return readFileSync(join(store.dir, relative), 'utf8')
  } catch {
    return ''
  }
}

function writeText(store, relative, text) {
  ensureDirs(store)
  writeFileSync(join(store.dir, relative), text)
}

/** 备份一个层级文件（回滚用），返回备份相对路径。 */
export function backupHierarchyFile(store, relative) {
  const abs = join(store.dir, relative)
  if (!existsSync(abs)) return ''
  ensureDirs(store)
  const base = relative.split('/').pop()
  const target = `hierarchy/backups/${base}.${stamp()}.bak`
  try {
    copyFileSync(abs, join(store.dir, target))
    return target
  } catch {
    return ''
  }
}

/** 当前层级状态（面板/接口用）。 */
export function hierarchyInfo(store) {
  const state = store.state
  const h = state.hierarchy && typeof state.hierarchy === 'object' ? state.hierarchy : {}
  const packaged = Array.isArray(state.cycle?.packaged) ? state.cycle.packaged : []
  const closedYears = Math.floor(packaged.length / CYCLES_PER_YEAR)
  const progress = packaged.length % CYCLES_PER_YEAR
  const files = []
  for (const dir of ['hierarchy']) {
    try {
      for (const name of readdirSync(join(store.dir, dir))) {
        if (!name.endsWith('.md')) continue
        const rel = `${dir}/${name}`
        let bytes = 0
        try { bytes = readFileSync(join(store.dir, rel)).length } catch { bytes = 0 }
        files.push({ path: rel, bytes })
      }
    } catch {
      // 目录不存在
    }
  }
  return {
    annual: h.annual ?? null,
    epoch: h.epoch ?? null,
    closedYears,
    packagedCount: packaged.length,
    progress,
    cyclesPerYear: CYCLES_PER_YEAR,
    nextAnnualAt: (closedYears + 1) * CYCLES_PER_YEAR,
    files,
    lastRunAt: h.lastRunAt ?? null,
    lastError: h.lastError ?? '',
  }
}

/** 本年度对应的月度包（按周期 index 12 个一组）。 */
export function monthlyFilesOfYear(store, yearNo) {
  const packaged = Array.isArray(store.state.cycle?.packaged) ? store.state.cycle.packaged : []
  const from = (yearNo - 1) * CYCLES_PER_YEAR + 1
  const to = yearNo * CYCLES_PER_YEAR
  return packaged
    .filter((item) => Number.isFinite(Number(item.index)) && Number(item.index) >= from && Number(item.index) <= to)
    .sort((left, right) => Number(left.index) - Number(right.index))
}

/** pinned / 重点原文清单：原样附在摘要末尾，不参与概括。 */
function pinnedBlock(store) {
  const memories = Array.isArray(store.state.memories) ? store.state.memories : []
  const pinned = memories.filter((memory) => memory && memory.pinned === true && !memory.archived && typeof memory.text === 'string')
  const lines = []
  let chars = 0
  for (const memory of pinned) {
    const text = memory.text.trim()
    if (text === '') continue
    if (chars + text.length > MAX_PINNED_CHARS) break
    lines.push(`- ${text}`)
    chars += text.length
  }
  return lines.join('\n')
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const ANNUAL_INSTRUCTION = [
  '你是「伴侣记忆」的年度记忆压缩器。请把一年（12 个周期）的月度记录压缩成一份年度摘要。',
  '',
  '要求：',
  '1. 只做压缩和整理，不新增任何事实，不编造。',
  '2. 保留：人物与关系变化、重要事件（第一次/纪念/冲突与和好）、约定与承诺、用户偏好与雷区、长期伏笔与未完成的事。',
  '3. 已经不重要的一次性闲聊可以略过；重要的细节尽量保留。',
  '4. 输出 Markdown 正文（不要标题、不要前言），不超过 3000 字。',
].join('\n')

const EPOCH_INSTRUCTION = [
  '你是「伴侣记忆」的跨年记忆压缩器。输入是「更早多年的跨年沉积」+「上一个年度的年报」。',
  '请把它们合并压缩成一份新的跨年沉积，供以后检索旧事。',
  '',
  '要求：',
  '1. 只做压缩合并，不新增事实；越老的年份可以越概括，上一个年度的细节尽量保留。',
  '2. 保留：人物与关系、重要事件、约定与承诺、用户偏好与雷区、长期伏笔。',
  '3. 输出 Markdown 正文（不要标题、不要前言），不超过 2000 字。',
].join('\n')

function pinnedSection(pinned) {
  return pinned === '' ? '' : `\n\n## 关键记忆（原样保留，未参与概括）\n${pinned}`
}

/** 生成第 yearNo 年度的年报（L3）。 */
export async function buildAnnual(store, ctx, options = {}) {
  const yearNo = Number(options.yearNo)
  if (!Number.isFinite(yearNo) || yearNo < 1) throw new Error('年度编号无效')
  const packs = monthlyFilesOfYear(store, yearNo)
  if (packs.length < CYCLES_PER_YEAR && options.force !== true) {
    return { built: false, reason: `第${yearNo}年度还差 ${CYCLES_PER_YEAR - packs.length} 个月度包` }
  }
  if (packs.length === 0) return { built: false, reason: '没有可用的月度包' }
  const parts = []
  let total = 0
  for (const pack of packs) {
    const text = clip(readText(store, pack.file), MAX_MONTHLY_CHARS)
    if (text === '') continue
    if (total + text.length > MAX_TOTAL_CHARS) break
    parts.push(`## 第${pack.index}周期（起始 ${pack.startDay ?? '?'}）\n\n${text}`)
    total += text.length
  }
  if (parts.length === 0) return { built: false, reason: '月度包内容为空' }
  const pinned = pinnedBlock(store)
  const from = (yearNo - 1) * CYCLES_PER_YEAR + 1
  const messages = [
    { role: 'system', content: [{ type: 'text', text: ANNUAL_INSTRUCTION }] },
    {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          `第${yearNo}年度（第${from}~第${yearNo * CYCLES_PER_YEAR}周期）的月度记录：`,
          '',
          parts.join('\n\n'),
          '',
          pinned === '' ? '' : `另外这些关键记忆必须原样保留（不要改写）：\n${pinned}`,
        ].join('\n'),
      }],
    },
  ]
  const body = await callModelText(ctx, { messages, maxTokens: 3000, sessionId: options.sessionId })
  const now = new Date()
  const header = [
    `# 年度摘要 · 第${yearNo}年度`,
    '',
    `覆盖：第${from}~第${yearNo * CYCLES_PER_YEAR}周期（共 ${CYCLES_PER_YEAR} 个聊天周期）`,
    `生成：${now.toISOString()}`,
    '压缩次数：1（最新年报）',
    '',
    '> 本文件由月度摘要压缩而来。月度包与日归档原文保留在知识库，可继续下钻。',
    '',
  ].join('\n')
  const content = `${header}${body}${pinned === '' ? '\n' : `${pinnedSection(pinned)}\n`}`
  const previousBackup = backupHierarchyFile(store, `hierarchy/${ANNUAL_FILE}`)
  writeText(store, `hierarchy/${ANNUAL_FILE}`, content)
  const h = store.state.hierarchy
  h.annual = {
    file: `hierarchy/${ANNUAL_FILE}`,
    coversFrom: 1,
    coversTo: yearNo,
    compressedTimes: 1,
    createdAt: now.toISOString(),
    chars: content.length,
    sourceCycles: packs.map((pack) => Number(pack.index)),
    backup: previousBackup,
  }
  h.lastRunAt = now.toISOString()
  h.lastError = ''
  store.appendArchive('hierarchy', `已生成年度摘要：第${yearNo}年度（压缩 ${parts.length} 个月度包）`, { file: `hierarchy/${ANNUAL_FILE}` }, now)
  store.persist()
  return { built: true, yearNo, chars: content.length, backup: previousBackup }
}

/** 生成新的跨年沉积（L4）：压(旧 epoch + 上一个年报)。 */
export async function buildEpoch(store, ctx, options = {}) {
  const h = store.state.hierarchy
  const annual = options.annual ?? h.annual
  if (!annual) return { built: false, reason: '还没有年报可以并入' }
  const annualText = readText(store, annual.file)
  if (annualText === '') return { built: false, reason: '年报文件不存在' }
  const oldEpochText = h.epoch && h.epoch.file ? readText(store, h.epoch.file) : ''
  const pinned = pinnedBlock(store)
  const messages = [
    { role: 'system', content: [{ type: 'text', text: EPOCH_INSTRUCTION }] },
    {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          oldEpochText === ''
            ? '（还没有跨年沉积，本次从上一个年报开始生成）'
            : `上一版跨年沉积（覆盖第${h.epoch.coversFrom}~第${h.epoch.coversTo}年度，已被压缩 ${h.epoch.compressedTimes} 次）：\n\n${clip(oldEpochText, MAX_TOTAL_CHARS)}`,
          '',
          `上一个年度摘要（第${annual.coversTo}年度，只压过一轮）：\n\n${clip(annualText, MAX_TOTAL_CHARS)}`,
          '',
          pinned === '' ? '' : `这些关键记忆必须原样保留（不要改写）：\n${pinned}`,
        ].join('\n'),
      }],
    },
  ]
  const body = await callModelText(ctx, { messages, maxTokens: 2000, sessionId: options.sessionId })
  const now = new Date()
  const coversFrom = h.epoch ? h.epoch.coversFrom : annual.coversFrom
  const coversTo = annual.coversTo
  const compressedTimes = (h.epoch ? Number(h.epoch.compressedTimes) || 0 : 0) + 1
  const header = [
    `# 跨年沉积 · 第${coversFrom}~${coversTo}年度`,
    '',
    `覆盖：第${coversFrom}~第${coversTo}年度（含更早年份的多次压缩）`,
    `生成：${now.toISOString()}`,
    `压缩次数：${compressedTimes}`,
    '',
    '> 越老的年份越概括；最新年报只压过一轮，细节更多。原文可按层下钻。',
    '',
  ].join('\n')
  const content = `${header}${body}${pinned === '' ? '\n' : `${pinnedSection(pinned)}\n`}`
  const epochBackup = backupHierarchyFile(store, `hierarchy/${EPOCH_FILE}`)
  const annualBackup = backupHierarchyFile(store, annual.file)
  writeText(store, `hierarchy/${EPOCH_FILE}`, content)
  h.epoch = {
    file: `hierarchy/${EPOCH_FILE}`,
    coversFrom,
    coversTo,
    compressedTimes,
    createdAt: now.toISOString(),
    chars: content.length,
    backup: epochBackup,
    foldedAnnualBackup: annualBackup,
  }
  h.lastRunAt = now.toISOString()
  h.lastError = ''
  store.appendArchive('hierarchy', `已生成跨年沉积：第${coversFrom}~${coversTo}年度（第 ${compressedTimes} 次压缩）`, { file: `hierarchy/${EPOCH_FILE}` }, now)
  store.persist()
  return { built: true, coversFrom, coversTo, compressedTimes, chars: content.length, backup: epochBackup }
}

/**
 * 自动推进：每凑满 12 个月度包就生成年报；新年度关闭时先把旧年报并入跨年沉积。
 * 便宜：只有「年度关闭」时才调用模型，其它时候只读 state 判断。
 */
export async function maybeAdvanceHierarchy(store, ctx, options = {}) {
  const h = store.state.hierarchy
  const info = hierarchyInfo(store)
  if (info.closedYears === 0) return { action: 'none' }
  let annual = h.annual ?? null
  const actions = []
  for (let yearNo = (annual ? annual.coversTo : 0) + 1; yearNo <= info.closedYears; yearNo += 1) {
    if (annual) {
      const epochResult = await buildEpoch(store, ctx, { annual, sessionId: options.sessionId })
      if (epochResult.built) actions.push(`epoch:${epochResult.coversTo}`)
      else actions.push(`epoch-skip:${epochResult.reason}`)
    }
    const annualResult = await buildAnnual(store, ctx, { yearNo, sessionId: options.sessionId })
    if (annualResult.built) actions.push(`annual:${yearNo}`)
    else actions.push(`annual-skip:${annualResult.reason}`)
    annual = store.state.hierarchy.annual
  }
  return { action: actions.length > 0 ? 'advanced' : 'none', actions }
}

/** 回滚：把某个层级文件恢复成最近一次备份。 */
export function rollbackHierarchy(store, target) {
  const name = target === 'epoch' ? EPOCH_FILE : ANNUAL_FILE
  let backups = []
  try {
    backups = readdirSync(backupsDir(store)).filter((item) => item.startsWith(`${name}.`)).sort()
  } catch {
    backups = []
  }
  const latest = backups.pop()
  if (!latest) throw new Error('没有可用的备份')
  copyFileSync(join(backupsDir(store), latest), join(store.dir, `hierarchy/${name}`))
  store.appendArchive('hierarchy', `已回滚 ${name} 到备份 ${latest}`, { file: `hierarchy/${name}`, backup: latest }, new Date())
  store.persist()
  return { restored: `hierarchy/${name}`, backup: `hierarchy/backups/${latest}` }
}

/** 每轮检查（便宜）：只在年度关闭时调用模型；失败只记录，不影响对话。 */
export function registerHierarchy(ctx, manager) {
  const log = typeof manager.log === 'function' ? manager.log : () => {}
  const running = new Set()
  const tick = () => {
    let sessions = []
    try {
      sessions = typeof manager.enabledSessions === 'function' ? manager.enabledSessions() : []
    } catch {
      sessions = []
    }
    for (const sessionId of sessions) {
      if (running.has(sessionId)) continue
      let store = null
      try {
        store = manager.storeFor(sessionId)
      } catch {
        store = null
      }
      if (!store) continue
      running.add(sessionId)
      Promise.resolve()
        .then(() => maybeAdvanceHierarchy(store, ctx, { sessionId }))
        .catch((error) => {
          try {
            store.state.hierarchy.lastError = error instanceof Error ? error.message : String(error)
            store.persist()
          } catch {
            // ignore
          }
          log(`hierarchy 自动推进失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => running.delete(sessionId))
    }
  }
  return ctx.on('agent/pre-step', async (payload, next) => {
    try {
      tick()
    } catch {
      // 自动推进失败不影响对话
    }
    return next()
  })
}
