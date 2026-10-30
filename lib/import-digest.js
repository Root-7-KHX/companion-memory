/**
 * 导入记忆时，让 AI 把导入包里的聊天原文「过一遍」（1.1.2）。
 *
 * 背景：导入时会把聊天原文写进知识库、灌进 48 小时热窗口，但 AI 并不会真的
 * 去读——用户之后问「之前聊过什么」只能靠检索碰运气。这里在导入完成后把
 * 原文分批交给模型，提炼成活跃记忆（用户偏好 / 约定 / 剧情关键点），
 * 相当于让角色把旧对话重新回忆一遍。
 *
 * 约束：
 *  - 只在「导入」动作里触发，普通聊天不调用；
 *  - 失败只记录错误，绝不阻塞导入；
 *  - 批次数有上限（默认 8 批），超出的批次在结果里说明。
 */
import { callModelText, CLEAN_DEFAULT_MODEL } from './llm-call.js'

export const DEFAULT_IMPORT_DIGEST = Object.freeze({
  enabled: true,
  /** 单批最多多少字符（太小会多花调用，太大会超过模型窗口）。 */
  batchChars: 12000,
  /** 最多过几批；超出的部分跳过并在结果里报告。 */
  maxBatches: 8,
  /** 单批最多采纳几条记忆。 */
  maxMemoriesPerBatch: 10,
  /** 单批模型输出上限。 */
  maxTokens: 1600,
})

const INSTRUCTION = [
  '你是「伴侣记忆」的回顾整理器。下面会给你一段用户和角色之前真实聊过的对话原文，',
  '请从中提炼值得长期记住的信息，写成简洁的活跃记忆条目。',
  '',
  '只保留这类内容：',
  '- 用户的固定信息与偏好（名字、称呼、喜好、雷区、生活习惯、工作/学习情况等）；',
  '- 双方的约定、承诺、称呼变化、关系进展；',
  '- 重要的剧情事件、关键转折、反复出现的梗；',
  '- 用户明确要求记住的事。',
  '',
  '不要保留：寒暄、流水账、一次性玩笑、已经作废的说法；也不要逐句复述。',
  '',
  '输出严格的 JSON，不要解释、不要代码块：',
  '{"memories":[{"text":"一条记忆（像回忆笔记，不超过 80 字）","weight":50}], "summary":"一句话概括这段对话"}',
  'weight 是 1~100 的重要度：核心设定/约定 80~100，明显偏好 60~79，普通事件 40~59，小事 20~39。',
  'memories 最多 10 条，宁缺毋滥；不要编造对话里没有的内容。',
].join('\n')

/** 和 store.js 的 isTranscriptMessage 保持同一套判定。 */
function isTranscriptMessage(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.text !== 'string' || value.text.trim() === '') return false
  return value.role === 'user' || value.role === 'assistant'
}

/** 合并默认设置；数字项做边界裁剪，防止配置写坏把导入拖死。 */
export function resolveImportDigestSettings(config = {}) {
  const input = config && typeof config === 'object' && config.importDigest && typeof config.importDigest === 'object'
    ? config.importDigest
    : {}
  const pick = (key, fallback, min, max) => {
    const value = Number(input[key])
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  return {
    enabled: input.enabled !== false,
    batchChars: pick('batchChars', DEFAULT_IMPORT_DIGEST.batchChars, 2000, 60000),
    maxBatches: pick('maxBatches', DEFAULT_IMPORT_DIGEST.maxBatches, 1, 64),
    maxMemoriesPerBatch: pick('maxMemoriesPerBatch', DEFAULT_IMPORT_DIGEST.maxMemoriesPerBatch, 1, 30),
    maxTokens: pick('maxTokens', DEFAULT_IMPORT_DIGEST.maxTokens, 256, 6000),
  }
}

/**
 * 把消息按字符数切成批；单条超长消息不切，独占一批。
 * @returns {Array<{text: string, count: number}>}
 */
export function buildImportBatches(messages, batchChars) {
  const limit = Number.isFinite(Number(batchChars)) && Number(batchChars) > 0 ? Math.round(Number(batchChars)) : DEFAULT_IMPORT_DIGEST.batchChars
  const batches = []
  let lines = []
  let size = 0
  let count = 0
  const flush = () => {
    if (lines.length === 0) return
    batches.push({ text: lines.join('\n'), count })
    lines = []
    size = 0
    count = 0
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const prefix = message.role === 'user' ? '用户' : '角色'
    const line = prefix + '：' + message.text
    if (size + line.length + 1 > limit && lines.length > 0) flush()
    lines.push(line)
    size += line.length + 1
    count += 1
  }
  flush()
  return batches
}

/** 从模型输出里抠出 JSON，并做结构校验。 */
export function parseDigestJson(text) {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error('模型返回的 JSON 无法解析')
  }
  const list = Array.isArray(parsed.memories) ? parsed.memories : []
  const memories = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const memoryText = String(item.text ?? '').replace(/\s+/g, ' ').trim()
    if (memoryText === '') continue
    const weight = Number(item.weight)
    memories.push({
      text: memoryText.slice(0, 160),
      weight: Number.isFinite(weight) ? Math.min(100, Math.max(1, Math.round(weight))) : 50,
    })
  }
  return {
    memories,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 200) : '',
  }
}

/**
 * 把导入的聊天原文分批过一遍模型，把提炼出的记忆写进活跃记忆。
 * @returns {Promise<{enabled:boolean, batches:number, batchesSkipped:number, memoriesAdded:number, duplicates:number, chars:number, errors:string[]}>}
 */
export async function digestImportedConversation(ctx, store, messages, options = {}) {
  const settings = options.settings || resolveImportDigestSettings(options.config)
  const stats = {
    enabled: settings.enabled,
    batches: 0,
    batchesSkipped: 0,
    memoriesAdded: 0,
    duplicates: 0,
    chars: 0,
    errors: [],
  }
  if (!settings.enabled) return stats
  const list = (Array.isArray(messages) ? messages : [])
    .filter(isTranscriptMessage)
    .map((message) => ({ role: message.role, text: String(message.text) }))
  if (list.length === 0) return stats

  const batches = buildImportBatches(list, settings.batchChars)
  const use = batches.slice(0, settings.maxBatches)
  stats.batchesSkipped = batches.length - use.length
  const summaries = []

  for (let index = 0; index < use.length; index += 1) {
    const batch = use[index]
    stats.chars += batch.text.length
    try {
      const text = await callModelText(ctx, {
        messages: [
          { role: 'system', content: [{ type: 'text', text: INSTRUCTION }] },
          {
            role: 'user',
            content: [{ type: 'text', text: '下面开始，第 ' + (index + 1) + '/' + use.length + ' 批对话原文：\n\n' + batch.text }],
          },
        ],
        maxTokens: settings.maxTokens,
        provider: options.provider || CLEAN_DEFAULT_MODEL.provider,
        model: options.model || CLEAN_DEFAULT_MODEL.model,
        sessionId: options.sessionId,
        signal: options.signal,
      })
      const parsed = parseDigestJson(text)
      stats.batches += 1
      if (parsed.summary) summaries.push(parsed.summary)
      for (const memory of parsed.memories.slice(0, settings.maxMemoriesPerBatch)) {
        const created = store.addMemory(memory.text, ['导入', 'AI回顾'], {
          weight: memory.weight,
          source: 'import-digest',
        })
        if (created) stats.memoriesAdded += 1
        else stats.duplicates += 1
      }
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (stats.batches > 0) {
    try {
      const line = '导入后 AI 回顾了 ' + stats.batches + ' 批聊天原文（' + stats.chars + ' 字），提炼出 ' +
        stats.memoriesAdded + ' 条活跃记忆' + (summaries.length > 0 ? '。要点：' + summaries.join('；') : '。')
      store.appendArchive('importdigest', line, {
        batches: stats.batches,
        batchesSkipped: stats.batchesSkipped,
        memoriesAdded: stats.memoriesAdded,
      })
    } catch {
      // 归档失败不影响导入
    }
  }
  try {
    store.persist()
  } catch {
    // persist 失败下次写入时会再存
  }
  return stats
}
