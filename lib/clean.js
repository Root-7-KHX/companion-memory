/**
 * 记忆清洗与体检（1.1.0-B / 1.1.0-C 共用管线）。
 *
 * 原则（硬约束）：
 *  1. 只做「排序 / 去重 / 归档」——不改写任何一条记忆的原文；
 *  2. 模型只能输出 keep 顺序和 drop 名单，不能生成新文本、不能改草稿；
 *  3. 模型调用失败 / 输出不可校验 → 整体回退，按原样处理（绝不阻塞导入或体检）；
 *  4. 被 drop 的条目必须交给调用方归档，可回溯。
 */

import { callModelText, CLEAN_DEFAULT_MODEL } from './llm-call.js'

const MAX_MODEL_ENTRIES = 80
const SIMILARITY_THRESHOLD = 0.86
const LONG_TEXT = 300

/** 归一化：去空白 + 小写（用于完全去重与相似度）。 */
export function squashText(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

/** 字符 bigram 集合（中文按字、英文按字符都适用）。 */
function bigrams(text) {
  const chars = [...squashText(text)]
  const set = new Set()
  for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1])
  if (chars.length === 1) set.add(chars[0])
  return set
}

/** Dice 相似度（2×交集 / 两集合大小之和），范围 0~1；对短句比 Jaccard 更宽容。 */
export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const value of left) if (right.has(value)) common += 1
  return (2 * common) / (left.size + right.size)
}

/**
 * 规则层：完全重复只留第一条，空条目丢弃。
 * @param {Array<object>} memories
 * @returns {{ kept: Array<object>, dropped: Array<{ id: string, text: string, reason: string }> }}
 */
export function ruleDedupe(memories) {
  const kept = []
  const dropped = []
  const seen = new Map()
  for (const memory of Array.isArray(memories) ? memories : []) {
    const text = typeof memory?.text === 'string' ? memory.text.trim() : ''
    if (text === '') {
      if (memory && memory.id) dropped.push({ id: String(memory.id), text: '', reason: '空条目' })
      continue
    }
    const key = squashText(text)
    if (seen.has(key)) {
      dropped.push({ id: String(memory.id ?? ''), text, reason: `与 ${seen.get(key)} 完全重复` })
      continue
    }
    seen.set(key, String(memory.id ?? `#${kept.length + 1}`))
    kept.push(memory)
  }
  return { kept, dropped }
}

/**
 * 体检扫描：完全重复 / 高度相似 / 超长 / 空条目 / 过期未归档。
 * @param {Array<object>} memories
 * @param {{ interactionDays?: number, memoryLimit?: number }} [options]
 */
export function scanHealth(memories, options = {}) {
  const list = (Array.isArray(memories) ? memories : []).filter((memory) => memory && memory.archived !== true)
  const interactionDays = Number.isFinite(options.interactionDays) ? options.interactionDays : null
  const limit = Number.isFinite(options.memoryLimit) ? options.memoryLimit : 30
  const exact = new Map()
  const long = []
  const empty = []
  const stale = []
  for (const memory of list) {
    const text = typeof memory.text === 'string' ? memory.text.trim() : ''
    const id = String(memory.id ?? '')
    if (text === '') { empty.push(id); continue }
    const key = squashText(text)
    if (!exact.has(key)) exact.set(key, [])
    exact.get(key).push(id)
    if (text.length > LONG_TEXT) long.push({ id, chars: text.length })
    if (interactionDays !== null && Number.isFinite(Number(memory.createdInteractionDay))
      && interactionDays - Number(memory.createdInteractionDay) >= limit) {
      stale.push(id)
    }
  }
  const duplicates = [...exact.values()].filter((ids) => ids.length > 1)
  const similar = []
  const seenPair = new Set()
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      const left = String(a.text ?? '')
      const right = String(b.text ?? '')
      if (squashText(left) === squashText(right)) continue
      const score = similarity(left, right)
      if (score < SIMILARITY_THRESHOLD) continue
      const pair = [String(a.id ?? ''), String(b.id ?? '')].sort().join('|')
      if (seenPair.has(pair)) continue
      seenPair.add(pair)
      similar.push({ ids: [String(a.id ?? ''), String(b.id ?? '')], score: Math.round(score * 100) / 100 })
    }
  }
  const issueCount = duplicates.length + similar.length + long.length + empty.length + stale.length
  return {
    total: list.length,
    issueCount,
    clean: issueCount === 0,
    duplicates,
    similar,
    long,
    empty,
    stale,
  }
}

const CLEAN_INSTRUCTION = [
  '你是「伴侣记忆」的记忆整理器。用户要把一批记忆导入（或做一次记忆体检），请你判断哪些值得保留、按什么顺序排列。',
  '',
  '严格规则：',
  '1. 你只能排序和筛选，不能新增、不能改写任何记忆文字。',
  '2. 输出必须是 JSON，格式：',
  '   {"order":[记忆id按重要度从高到低],"drop":[{"id":"记忆id","reason":"丢弃原因"}]}',
  '3. order 必须包含所有保留条目的 id；drop 里的 id 不能出现在 order 里；id 必须来自输入。',
  '4. 只丢弃：一次性闲聊、已经作废的说法、纯玩笑、和别的条目完全同义且信息更少的重复。',
  '5. 拿不准就保留。角色扮演里「约定 / 称呼变化 / 特殊事件 / 用户偏好」一律保留。',
  '6. 不要输出解释性文字，只输出 JSON。',
].join('\n')

/** 把记忆条目压成给模型看的最小结构。 */
export function buildCleanPayload(memories) {
  return (Array.isArray(memories) ? memories : []).slice(0, MAX_MODEL_ENTRIES).map((memory, index) => ({
    id: String(memory?.id ?? `mem_${index}`),
    text: String(memory?.text ?? '').slice(0, 240),
    tags: Array.isArray(memory?.tags) ? memory.tags.slice(0, 5) : [],
    source: typeof memory?.source === 'string' ? memory.source : '',
    day: typeof memory?.createdDay === 'string' ? memory.createdDay : '',
  }))
}

/** 从模型输出里抠出 JSON（允许被 ```json 包裹）。 */
export function parseCleanJson(text) {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  const parsed = JSON.parse(raw.slice(start, end + 1))
  const order = Array.isArray(parsed.order) ? parsed.order.map(String) : null
  const drop = Array.isArray(parsed.drop) ? parsed.drop : []
  if (!order) throw new Error('JSON 缺少 order 数组')
  const dropList = []
  for (const item of drop) {
    if (!item || typeof item !== 'object') throw new Error('drop 项格式错误')
    const id = String(item.id ?? '')
    if (id === '') throw new Error('drop 项缺少 id')
    dropList.push({ id, reason: String(item.reason ?? '模型判断价值较低').slice(0, 120) })
  }
  return { order, drop: dropList }
}

/**
 * 调模型做清洗，并对输出做严格校验。
 * @returns {Promise<{ order: string[], drop: Array<{id:string, reason:string}> }>}
 */
export async function cleanWithModel(ctx, memories, options = {}) {
  const payload = buildCleanPayload(memories)
  if (payload.length === 0) return { order: [], drop: [] }
  const known = new Set(payload.map((item) => item.id))
  const messages = [
    { role: 'system', content: [{ type: 'text', text: CLEAN_INSTRUCTION }] },
    {
      role: 'user',
      content: [{ type: 'text', text: `记忆条目（JSON）：\n${JSON.stringify(payload, null, 0)}\n\n请输出整理结果 JSON。` }],
    },
  ]
  const text = await callModelText(ctx, {
    messages,
    maxTokens: 2048,
    provider: options.provider || CLEAN_DEFAULT_MODEL.provider,
    model: options.model || CLEAN_DEFAULT_MODEL.model,
    sessionId: options.sessionId,
    signal: options.signal,
  })
  const parsed = parseCleanJson(text)
  const order = []
  const seen = new Set()
  for (const id of parsed.order) {
    if (!known.has(id)) throw new Error(`模型给出的 id 不在输入里：${id}`)
    if (seen.has(id)) throw new Error(`order 里重复的 id：${id}`)
    seen.add(id)
    order.push(id)
  }
  const drop = []
  const dropped = new Set()
  for (const item of parsed.drop) {
    if (!known.has(item.id)) throw new Error(`drop 的 id 不在输入里：${item.id}`)
    if (dropped.has(item.id)) throw new Error(`drop 里重复的 id：${item.id}`)
    if (seen.has(item.id)) throw new Error(`id 同时出现在 order 和 drop：${item.id}`)
    dropped.add(item.id)
    drop.push(item)
  }
  const missing = [...known].filter((id) => !seen.has(id) && !dropped.has(id))
  if (missing.length > 0) throw new Error(`order 漏掉了条目：${missing.join(', ')}`)
  return { order, drop }
}

/**
 * 把清洗计划应用到记忆数组：返回新顺序 + 被归档条目（原文不改）。
 * @param {Array<object>} memories
 * @param {{ order: string[], drop: Array<{id:string, reason:string}> }} plan
 */
export function applyCleanPlan(memories, plan) {
  const list = Array.isArray(memories) ? memories : []
  const byId = new Map(list.map((memory) => [String(memory?.id ?? ''), memory]))
  const dropIds = new Set(plan.drop.map((item) => item.id))
  const dropped = []
  for (const item of plan.drop) {
    const memory = byId.get(item.id)
    if (memory) dropped.push({ id: item.id, text: String(memory.text ?? ''), reason: item.reason })
  }
  const ordered = []
  const used = new Set(dropIds)
  for (const id of plan.order) {
    const memory = byId.get(id)
    if (!memory) continue
    used.add(id)
    ordered.push(memory)
  }
  // 计划外的条目（比如超过 MAX_MODEL_ENTRIES 的尾部）原样追加，保证不丢
  for (const memory of list) {
    const id = String(memory?.id ?? '')
    if (used.has(id)) continue
    ordered.push(memory)
  }
  return { memories: ordered, dropped }
}

/**
 * 完整清洗：规则层 → 模型层（可选）→ 应用。
 *
 * @param {object} ctx 插件上下文
 * @param {Array<object>} memories 待清洗记忆
 * @param {object} [options]
 * @param {boolean} [options.useModel=true] 是否调用模型
 * @param {string} [options.sessionId]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ memories: Array<object>, dropped: Array<{id:string,text:string,reason:string}>, stats: object }>}
 */
export async function cleanMemories(ctx, memories, options = {}) {
  const started = Date.now()
  const original = Array.isArray(memories) ? memories.slice() : []
  const { kept, dropped: ruleDropped } = ruleDedupe(original)
  const stats = {
    total: original.length,
    ruleDropped: ruleDropped.length,
    modelDropped: 0,
    modelUsed: false,
    modelError: '',
    reordered: false,
    durationMs: 0,
  }
  let current = kept
  let dropped = ruleDropped.slice()
  if (options.useModel !== false && kept.length > 3) {
    try {
      const plan = await cleanWithModel(ctx, kept, options)
      const applied = applyCleanPlan(kept, plan)
      current = applied.memories
      dropped = dropped.concat(applied.dropped)
      stats.modelUsed = true
      stats.modelDropped = applied.dropped.length
      stats.reordered = plan.order.join('|') !== kept.map((memory) => String(memory?.id ?? '')).join('|')
    } catch (error) {
      stats.modelError = error instanceof Error ? error.message : String(error)
    }
  }
  stats.dropped = dropped.length
  stats.kept = current.length
  stats.durationMs = Date.now() - started
  return { memories: current, dropped, stats }
}
