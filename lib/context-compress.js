/**
 * 对话上下文压缩（伴侣记忆式）。
 *
 * 长对话会让模型上下文不断变大，最终超过模型窗口。这个模块负责把「较早的
 * 一段对话」压缩成一份伴侣记忆格式的记忆块：
 *
 *   1. 每轮模型请求前（`agent/pre-step`）先量一下当前 surface 的 token 压力；
 *   2. 越过阈值时，挑出最旧的一段「工具调用配对完整」的区间（保留最近一段
 *      原文和最后一条用户消息）；
 *   3. 调一次摘要模型，把这段对话压成伴侣记忆格式（重要原文 + 次要摘要 +
 *      好感度变化 + 未完成事项），并写进本地知识库 `packs/上下文压缩_*.md`；
 *   4. 用一条带摘要的用户消息替换这段旧对话（surface replace），旧消息从此
 *      不再进入上下文；需要细节时模型可以 search_kb / read_archive 检索。
 *
 * 遇到上下文溢出错误（CONTEXT_WINDOW_EXCEEDED）时会强制压缩一次并让本轮
 * 请求重试，作为兜底。
 *
 * 所有行为只对「已在面板开启伴侣记忆」的对话生效，数据与原文都保存在本地。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
const MAX_LOG_BYTES = 256 * 1024

/** 默认设置：可在插件配置 contextCompression 里覆盖。 */
export const DEFAULT_CONTEXT_COMPRESSION = {
  enabled: true,
  /**
   * 绝对触发阈值（token）。surface 用量超过它就开始压缩。
   * 大窗口模型（如 1M）下，按窗口比例算的阈值永远够不到，所以主用绝对阈值。
   * 0 = 不用绝对阈值，退回按窗口比例 thresholdRatio。
   */
  triggerTokens: 40000,
  /**
   * 按窗口比例的兜底阈值：仅当 triggerTokens 为 0 时生效。
   * 注意这是「用量 / 可用窗口」的比例，大窗口下非常迟钝。
   */
  thresholdRatio: 0.6,
  /** 最近至少保留多少 token 的原文（不压缩）。 */
  retainTokens: 8000,
  /** 最近多少条对话消息永远不压缩（按 surface 节点数；默认 8 条）。 */
  retainMessages: 8,
  /** 单次至少压缩多少 token 才值得做（太小的区间直接跳过）。 */
  minCompressTokens: 6000,
  /** 摘要请求的输出上限。 */
  summaryMaxTokens: 3000,
  /** 摘要请求的推理强度（off / low / high / max；空字符串表示不显式指定）。 */
  summaryReasoningEffort: 'low',
  /** 两次自动压缩之间的冷却时间。 */
  cooldownMs: 120000,
  /** 是否在上下文溢出错误后强制压缩并重试。 */
  overflowRecovery: true,
  /** 拿不到模型窗口时的兜底窗口（0 = 不兜底，直接跳过）。 */
  assumedContextWindow: 0,
}

const COMPRESS_INSTRUCTION = [
  '你现在是「伴侣记忆」的对话压缩器。请把上面这段较早的对话，压缩成一份可以长期保存、供角色日后回忆的记忆块。',
  '',
  '严格按下面的格式输出，保持每一节、按顺序（没有内容写「（无）」）：',
  '',
  '## 一、重要原文（原样保留）',
  '- [角色人设、核心设定、剧情关键节点、双方约定、用户固定偏好、主线伏笔的原文；不要改写、删减或脑补]',
  '',
  '## 二、次要摘要',
  '- [闲聊玩笑、一次性话题、次要支线、流水日常的简短摘要]',
  '',
  '## 三、好感度变化',
  '- [角色对用户的好感度变化与理由；没有变化写（无）]',
  '',
  '## 四、未完成的事',
  '- [对话里还没做完的约定、任务或伏笔；没有写（无）]',
  '',
  '规则：',
  '- 重要原文必须保持原样，只做摘录与整理，不得改写核心意思；',
  '- 如果对话里已经有「伴侣记忆 · 上下文压缩」块，那是更早的压缩记忆：保留仍然成立的内容、合并新信息，不要整段照抄；',
  '- 只输出上述内容，不要写解释，不要提及“压缩”或“摘要请求”，不要调用任何工具；',
  '- 用简洁的中文短句，不要逐句复述对话。',
].join('\n')

const CHECKPOINT_TITLE = '【伴侣记忆 · 上下文压缩】'

/** 读取插件配置里的压缩设置（缺省项用默认值）。 */
export function resolveContextCompressionSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const section = raw.contextCompression && typeof raw.contextCompression === 'object'
    ? raw.contextCompression
    : raw.compress && typeof raw.compress === 'object'
      ? raw.compress
      : {}
  const number = (value, fallback, min = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
  }
  return {
    enabled: section.enabled !== false,
    triggerTokens: Math.max(0, number(section.triggerTokens, DEFAULT_CONTEXT_COMPRESSION.triggerTokens)),
    thresholdRatio: Math.min(0.95, Math.max(0.2, number(section.thresholdRatio, DEFAULT_CONTEXT_COMPRESSION.thresholdRatio))),
    retainTokens: Math.max(2000, number(section.retainTokens, DEFAULT_CONTEXT_COMPRESSION.retainTokens)),
    retainMessages: Math.max(2, Math.round(number(section.retainMessages, DEFAULT_CONTEXT_COMPRESSION.retainMessages, 2))),
    minCompressTokens: Math.max(2000, number(section.minCompressTokens, DEFAULT_CONTEXT_COMPRESSION.minCompressTokens)),
    summaryMaxTokens: Math.max(256, number(section.summaryMaxTokens, DEFAULT_CONTEXT_COMPRESSION.summaryMaxTokens)),
    summaryReasoningEffort: typeof section.summaryReasoningEffort === 'string' && section.summaryReasoningEffort !== ''
      ? section.summaryReasoningEffort
      : DEFAULT_CONTEXT_COMPRESSION.summaryReasoningEffort,
    cooldownMs: Math.max(5000, number(section.cooldownMs, DEFAULT_CONTEXT_COMPRESSION.cooldownMs)),
    overflowRecovery: section.overflowRecovery !== false,
    assumedContextWindow: number(section.assumedContextWindow, DEFAULT_CONTEXT_COMPRESSION.assumedContextWindow),
  }
}

// ── token 估算（没有 tokenMeter 服务时的兜底） ─────────────────────────────

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

function estimateBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0
  if (block.type === 'text' || block.type === 'reasoning') {
    return Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  if (block.type === 'tool-call') {
    return Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
      + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN)
      + BLOCK_OVERHEAD
  }
  if (block.type === 'image') return 1000
  return Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0
  const blocks = Array.isArray(message.content) ? message.content : []
  let total = 4
  for (const block of blocks) total += estimateBlockTokens(block)
  return total
}

// ── surface 工具配对平衡（与 @deepseek-ai/dsh-compaction 同思路） ─────────────

function eventDelta(event) {
  if (!event || typeof event !== 'object') return 0
  if (event.type === 'assistant/message') {
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return 0
    return blocks.filter((block) => block && block.type === 'tool-call').length
  }
  if (event.type === 'tool/result') return -1
  return 0
}

/**
 * 计算 surface 每个位置前后是否「工具调用配对已闭合」。
 * balancedAfter[i] = true 表示 nodes[i] 之后可以安全切割。
 */
function surfaceBalance(session) {
  const nodes = session.surface?.nodes ?? []
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const balancedAfter = new Array(nodes.length).fill(false)
  let inFlight = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const event = session.eventAt(nodes[i])
    if (!event) return null
    inFlight += eventDelta(event)
    if (inFlight < 0) return null
    balancedAfter[i] = inFlight === 0
  }
  return { nodes, balancedAfter }
}

/** 是否有一段尚未闭合的原生压缩事务（compaction/start 之后没有 end）。 */
function hasActiveCompaction(session) {
  let seenEnd = false
  let scanned = 0
  for (let seq = session.seq - 1; seq >= 0 && scanned < 400; seq -= 1, scanned += 1) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'session/end-seed') return false
    if (event.type === 'turn/start') return false
    if (event.type === 'compaction/start') return !seenEnd
    if (event.type === 'compaction/end') seenEnd = true
  }
  return false
}

// ── 选中要压缩的区间 ────────────────────────────────────────────────────────

function tokensOfMeasurement(measurement) {
  const map = new Map()
  if (measurement && Array.isArray(measurement.nodes)) {
    for (const node of measurement.nodes) {
      if (!node || typeof node !== 'object') continue
      const seq = node.seq
      const tokens = Number.isFinite(node.tokens) ? node.tokens : node.heuristicTokens
      if (typeof seq === 'number' && Number.isFinite(tokens)) map.set(seq, tokens)
    }
  }
  return map
}

function fallbackTokensByNode(session, nodes) {
  const map = new Map()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    const message = session.deriveEventMessage(event)
    map.set(seq, estimateMessageTokens(message))
  }
  return map
}

/**
 * 挑出最旧的、工具调用配对完整的可压缩区间。
 * 返回 { startSeq, endSeq, startIdx, endIdx, shadowedSeqs, spanTokens } 或 null。
 */
function pickRange(session, tokensBySeq, settings, options = {}) {
  const balance = surfaceBalance(session)
  if (balance === null) return null
  const { nodes, balancedAfter } = balance
  if (nodes.length < 5) return null
  const retainTokens = Number.isFinite(options.retainTokens) ? Math.max(2000, options.retainTokens) : settings.retainTokens
  const minTokens = Number.isFinite(options.minCompressTokens) ? Math.max(2000, options.minCompressTokens) : settings.minCompressTokens
  const tokens = nodes.map((seq) => (tokensBySeq.get(seq) ?? 0))
  const suffix = new Array(nodes.length + 1).fill(0)
  for (let i = nodes.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + tokens[i]

  // 最后一条用户消息必须留在原文里（不能把用户最新的输入压掉）。
  let lastUserIdx = -1
  for (let i = nodes.length - 1; i >= 1; i -= 1) {
    const event = session.eventAt(nodes[i])
    if (event && event.type === 'user/message') {
      lastUserIdx = i
      break
    }
  }
  // 最近 retainMessages 条消息永远保持原文（用户要求：最近几句对话完全不压缩地发过去）。
  const retainMessages = Number.isFinite(options.retainMessages)
    ? Math.max(2, Math.round(options.retainMessages))
    : Math.max(2, Number(settings.retainMessages) || 8)
  const keepTailFrom = Math.max(1, nodes.length - retainMessages)
  let maxEnd = lastUserIdx >= 0 ? lastUserIdx - 1 : nodes.length - 2
  maxEnd = Math.min(maxEnd, keepTailFrom - 1)
  let endIdx = -1
  for (let i = maxEnd; i >= 1; i -= 1) {
    if (!balancedAfter[i]) continue
    if (suffix[i + 1] < retainTokens) continue
    endIdx = i
    break
  }
  if (endIdx < 1) return null

  let startIdx = -1
  for (let i = 1; i <= endIdx; i += 1) {
    if (balancedAfter[i - 1]) {
      startIdx = i
      break
    }
  }
  if (startIdx < 1 || startIdx > endIdx) return null

  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const spanTokens = suffix[startIdx] - suffix[endIdx + 1]
  if (spanTokens < minTokens) return null

  // 压缩必须真的能省出空间，且要包含至少一条用户消息才有记忆价值。
  let userMessages = 0
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event && event.type === 'user/message') userMessages += 1
  }
  if (userMessages === 0) return null

  return {
    startIdx,
    endIdx,
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    shadowedSeqs,
    spanTokens,
  }
}

// ── 摘要请求 ────────────────────────────────────────────────────────────────

/** 把回放消息瘦身：长文本截断、丢掉推理块、图片换成占位文本，节省摘要成本。 */
function slimContent(blocks) {
  const result = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'reasoning') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      result.push({ type: 'text', text: text.length > 3000 ? `${text.slice(0, 2400)}…（后略）` : text })
      continue
    }
    if (block.type === 'tool-call') {
      const args = String(block.arguments ?? '')
      result.push({
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: args.length > 1500 ? `${args.slice(0, 1000)}…` : args,
      })
      continue
    }
    if (block.type === 'image') {
      result.push({ type: 'text', text: '[图片已省略]' })
      continue
    }
    if (block.type === 'file') {
      result.push({ type: 'text', text: `[文件：${block.attachment?.name ?? '未命名'}]` })
      continue
    }
    result.push(block)
  }
  return result
}

function slimMessage(message) {
  if (!message || typeof message !== 'object') return null
  if (message.role === 'system') {
    const text = (Array.isArray(message.content) ? message.content : [])
      .map((block) => (block && block.type === 'text' ? String(block.text ?? '') : ''))
      .join('\n')
    return { role: 'system', content: [{ type: 'text', text: text.length > 6000 ? `${text.slice(0, 5000)}…（后略）` : text }] }
  }
  const base = { role: message.role, content: slimContent(message.content) }
  if (message.role === 'assistant') {
    const source = message.source && message.source.kind === 'model'
      ? { kind: 'model', provider: message.source.provider, model: message.source.model }
      : undefined
    return source ? { ...base, source } : base
  }
  if (message.role === 'tool') {
    return { ...base, toolCallId: message.toolCallId, isError: message.isError === true }
  }
  if (message.role === 'user') {
    return { ...base, source: { kind: 'user' } }
  }
  return base
}

/** 用 surface 节点构造摘要请求的 messages（系统提示 + 旧区间对话 + 指令）。 */
function buildSummarizationInput(session, shadowedSeqs, hasTools) {
  const nodes = session.surface?.nodes ?? []
  const headSeq = nodes[0]
  const headEvent = typeof headSeq === 'number' ? session.eventAt(headSeq) : undefined
  const head = headEvent && headEvent.type === 'system/message' ? session.deriveEventMessage(headEvent) : null
  const region = []
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (!event) return null
    const message = session.deriveEventMessage(event)
    if (message) region.push(message)
  }
  if (region.length === 0) return null
  const rawMessages = head ? [head, ...region] : region
  const messages = []
  for (const message of rawMessages) {
    const slimmed = slimMessage(message)
    if (slimmed) messages.push(slimmed)
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: COMPRESS_INSTRUCTION }] })
  return { messages, hasTools: hasTools === true }
}

async function requestSummary(ctx, session, input, settings, provider, model, signal) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用，无法生成压缩摘要')
  const header = session.requestHeader?.()
  const options = {
    provider,
    model,
    messages: input.messages,
    toolHistory: session.toolHistory(),
    maxTokens: settings.summaryMaxTokens,
    sessionId: session.id,
    purpose: 'compaction',
    ...(settings.summaryReasoningEffort ? { reasoningEffort: settings.summaryReasoningEffort } : {}),
    ...(header?.tools && input.hasTools ? { tools: header.tools } : {}),
    ...(signal ? { signal } : {}),
  }
  let text = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish && finish.kind === 'error') {
    throw new Error(`摘要请求失败：${finish.failure?.message ?? '未知错误'}`)
  }
  if (finish && finish.kind === 'aborted') throw new Error('摘要请求被取消')
  const summary = text.trim()
  if (summary === '') throw new Error('摘要请求没有返回文本')
  return { summary, provider, model }
}

// ── 提交压缩结果 ────────────────────────────────────────────────────────────

function revalidatePlan(session, plan) {
  const nodes = session.surface?.nodes ?? []
  const startIdx = nodes.indexOf(plan.startSeq)
  const endIdx = nodes.indexOf(plan.endSeq)
  if (startIdx < 1 || endIdx < startIdx) return false
  const balance = surfaceBalance(session)
  if (balance === null) return false
  if (!balance.balancedAfter[startIdx - 1] || !balance.balancedAfter[endIdx]) return false
  const current = nodes.slice(startIdx, endIdx + 1)
  if (current.length !== plan.shadowedSeqs.length) return false
  for (let i = 0; i < current.length; i += 1) {
    if (current[i] !== plan.shadowedSeqs[i]) return false
  }
  return true
}

function buildCheckpointText(record, summary) {
  const lines = []
  lines.push(CHECKPOINT_TITLE)
  lines.push('（这段较早的对话已经被压缩成下面的记忆块，原文保存在本地知识库：')
  lines.push(`${record.file}`)
  lines.push('需要细节时用 companion_memory 的 search_kb / read_archive 检索；把下面的内容当作已经发生过的背景，不要重新复述。）')
  lines.push('')
  lines.push(`归档日期：${record.archivedAt}`)
  lines.push('')
  lines.push(summary)
  return lines.join('\n')
}

function appendCheckpoint(session, plan, text) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  return session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
    sourceEventSeqs: [...plan.shadowedSeqs],
  })
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function createLogger(manager) {
  return (label, detail) => {
    try {
      const file = join(manager.root, 'debug-events.log')
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      if (size > MAX_LOG_BYTES) writeFileSync(file, `# companion-memory event log (rotated at ${new Date().toISOString()})\n`, 'utf8')
      const text = detail instanceof Error ? `${detail.message}` : String(detail ?? '')
      appendFileSync(file, `${new Date().toISOString()} ${label} ${text}\n`, 'utf8')
    } catch {
      // 诊断日志不能影响会话
    }
  }
}

/** 量出当前 surface 的用量与可用窗口。 */
async function measureBudget(ctx, session, settings, logger) {
  const header = session.requestHeader?.()
  const config = header?.config
  if (!config || typeof config.provider !== 'string' || config.provider === ''
    || typeof config.model !== 'string' || config.model === '') {
    return null
  }
  const llm = ctx.get?.('llm')
  let contextWindow = 0
  try {
    const context = session.requestContext?.()
    if (context && Number.isFinite(context.contextWindow)) contextWindow = context.contextWindow
  } catch {
    contextWindow = 0
  }
  let defaultMaxTokens = 0
  if (!contextWindow && llm && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(config.provider, config.model)
      if (info && info.context && Number.isFinite(info.context.contextWindow)) contextWindow = info.context.contextWindow
      if (info && Number.isFinite(info.defaultMaxTokens)) defaultMaxTokens = info.defaultMaxTokens
    } catch (error) {
      logger('window-resolve-failed', error)
    }
  }
  if (!contextWindow) contextWindow = settings.assumedContextWindow
  // 拿不到窗口时不再直接放弃：绝对阈值（triggerTokens）只需要知道「用了多少
  // token」，不依赖窗口大小。只有按比例判断才需要 usable。
  const reserved = Number.isFinite(config.maxTokens) ? config.maxTokens : defaultMaxTokens
  const usable = contextWindow > 0 ? contextWindow - reserved : 0
  const needUsable = !(settings.triggerTokens > 0)
  if (needUsable && usable <= 0) return null

  const meter = ctx.get?.('tokenMeter')
  let used = 0
  let tokensBySeq = new Map()
  try {
    if (meter && typeof meter.measure === 'function') {
      const measurement = meter.measure(session)
      if (measurement && Number.isFinite(measurement.totalTokens)) used = measurement.totalTokens
      tokensBySeq = tokensOfMeasurement(measurement)
    }
  } catch (error) {
    logger('token-meter-failed', error)
  }
  if (used <= 0) {
    const nodes = session.surface?.nodes ?? []
    tokensBySeq = fallbackTokensByNode(session, nodes)
    used = 0
    for (const value of tokensBySeq.values()) used += value
  }
  return { contextWindow, reserved, usable, used, tokensBySeq, provider: config.provider, model: config.model }
}

async function maybeCompress(env, session, reason) {
  const { ctx, manager, settings, logger, lastRunAt, busy } = env
  if (!session || typeof session !== 'object') return false
  const sessionId = String(session.id ?? '')
  if (sessionId === '' || !manager.isEnabled(sessionId)) return false
  if (busy.has(sessionId)) return false
  const now = Date.now()
  const last = lastRunAt.get(sessionId) ?? 0
  if (reason !== 'overflow' && now - last < settings.cooldownMs) return false

  const store = manager.storeFor(sessionId)
  if (!store) return false

  const budget = await measureBudget(ctx, session, settings, logger)
  if (!budget) {
    logger('compress-skip', `${sessionId}: 无法解析模型窗口或 token 计量`)
    return false
  }
  const force = reason === 'overflow'
  const ratio = budget.usable > 0 ? budget.used / budget.usable : 0
  // 优先用绝对阈值：大窗口模型（1M）下按比例算的阈值永远够不到，会让上下文
  // 一直涨到很贵才压缩。triggerTokens > 0 时只看绝对用量。
  const overTrigger = settings.triggerTokens > 0
    ? budget.used >= settings.triggerTokens
    : ratio >= settings.thresholdRatio
  if (!force && !overTrigger) return false
  if (hasActiveCompaction(session)) {
    logger('compress-skip', `${sessionId}: 原生压缩事务进行中`)
    return false
  }

  const options = force
    ? { retainTokens: Math.max(2000, Math.round(settings.retainTokens / 3)), minCompressTokens: 2000 }
    : {}
  const plan = pickRange(session, budget.tokensBySeq, settings, options)
  if (!plan) {
    logger('compress-skip', `${sessionId}: 没有可安全压缩的区间（used=${budget.used} tokens, usage=${Math.round(ratio * 100)}%）`)
    return false
  }

  const input = buildSummarizationInput(session, plan.shadowedSeqs, Array.isArray(session.requestHeader?.()?.tools))
  if (!input) return false

  busy.add(sessionId)
  try {
    let result
    try {
      result = await requestSummary(ctx, session, input, settings, budget.provider, budget.model, env.signal)
    } catch (error) {
      logger('compress-summary-failed', error)
      return false
    }
    if (env.signal && env.signal.aborted) return false
    if (!revalidatePlan(session, plan)) {
      logger('compress-aborted', `${sessionId}: 摘要完成前 surface 已变化，放弃本次压缩`)
      return false
    }
    const summaryTokens = Math.ceil(result.summary.length / CHARS_PER_TOKEN)
    if (!force && summaryTokens >= plan.spanTokens) {
      logger('compress-aborted', `${sessionId}: 摘要不比原文小（${summaryTokens} >= ${plan.spanTokens}），放弃`)
      return false
    }
    const record = store.writeContextCompression({
      summary: result.summary,
      seqStart: plan.startSeq,
      seqEnd: plan.endSeq,
      nodeCount: plan.shadowedSeqs.length,
      shadowedTokens: plan.spanTokens,
      provider: result.provider,
      model: result.model,
      reason,
    })
    const text = buildCheckpointText(record, result.summary)
    appendCheckpoint(session, plan, text)
    lastRunAt.set(sessionId, Date.now())
    logger('compress-ok', `${sessionId}: ${plan.shadowedSeqs.length} 个节点 / ${plan.spanTokens} tokens → ${record.file} (${reason})`)
    return true
  } catch (error) {
    logger('compress-failed', error)
    return false
  } finally {
    busy.delete(sessionId)
  }
}

/** 注册对话上下文压缩：只在已开启伴侣记忆的对话上自动工作。 */
export function registerContextCompression(ctx, manager, config) {
  const settings = resolveContextCompressionSettings(config)
  if (!settings.enabled || typeof ctx.on !== 'function') return () => {}
  const logger = createLogger(manager)
  const lastRunAt = new Map()
  const busy = new Set()
  const disposers = []

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload && payload.agent
      const signal = payload && payload.signal
      if (agent && signal && !signal.aborted) {
        await maybeCompress({ ctx, manager, settings, logger, lastRunAt, busy, signal }, agent.session, 'pressure')
      }
    } catch (error) {
      logger('compress-error', error)
    }
    return next()
  }))

  if (settings.overflowRecovery) {
    disposers.push(ctx.on('agent/request-error', async (payload, next) => {
      try {
        const agent = payload && payload.agent
        const failure = payload && payload.failure
        const signal = payload && payload.signal
        if (agent && signal && !signal.aborted && failure && failure.code === CONTEXT_WINDOW_EXCEEDED) {
          const generation = agent.session?.surface?.replaceGeneration ?? 0
          const compacted = await maybeCompress(
            { ctx, manager, settings, logger, lastRunAt, busy, signal },
            agent.session,
            'overflow',
          )
          const nextGeneration = agent.session?.surface?.replaceGeneration ?? 0
          if (compacted && nextGeneration > generation && !signal.aborted) return { kind: 'retry' }
        }
      } catch (error) {
        logger('overflow-recovery-error', error)
      }
      return next()
    }))
  }

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
