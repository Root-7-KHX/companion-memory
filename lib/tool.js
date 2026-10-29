/**
 * The single model-facing tool: `companion_memory`.
 *
 * One action-enum tool keeps the tool catalogue small while covering everything
 * the prompt protocol asks for (turn recording, important-verbatim saves,
 * favorability, recent-context recall, knowledge-base search/read, 48h
 * summaries, manual archiving).
 */
import { formatRecentTime } from './recent.js'

const ACTION_DESCRIPTION = [
  'turn_end：每次回复结束前记录本轮（important[] 重要原文、minor_summary 次要摘要、favorability 好感度变化）。',
  'save_important：保存重要原文（important[] 或 text），原文保持原样。',
  'set_favorability：修改好感度（value -100~100、reason 必填）。',
  'search_recent：检索最近 48 小时内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用。',
  'read_recent：读取最近上下文里的完整原话（id，如 msg_xxxxxxxx）。',
  'search_kb：检索知识库归档（query），用于超过 48 小时的旧事。',
  'read_archive：读取知识库归档原文（path，如 archive/2026-10-01.md）。',
  'archive_memory：把指定活跃记忆归档进知识库（ids）。',
  'summary48h：提交 48 小时归纳（digest 必填、period_label、highlights[]、favorability_changes[]）。',
].join('\n')

const importantItemSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '重点内容原文，必须一字不改。' },
    tags: { type: 'array', items: { type: 'string' }, description: '可选标签。' },
  },
  required: ['text'],
  additionalProperties: false,
}

const favorabilityChangeSchema = {
  type: 'object',
  properties: {
    value: { type: 'integer', description: '本条记录时的新好感度（-100~100）。' },
    reason: { type: 'string', description: '变动理由。' },
  },
  required: ['value', 'reason'],
  additionalProperties: false,
}

function textOf(value) {
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  if (typeof value === 'string') return value
  return ''
}

function sessionIdOfExecution(exec, manager) {
  if (exec && exec.agent && exec.agent.id) return String(exec.agent.id)
  return manager.currentSession()
}

function requireStore(exec, manager) {
  const sessionId = sessionIdOfExecution(exec, manager)
  if (!sessionId) throw new Error('无法确定当前对话；请重新打开对话后再试。')
  if (!manager.isEnabled(sessionId)) {
    throw new Error('本对话没有开启伴侣记忆，无法记录或检索。请先在侧边栏【伴侣记忆】面板点击「开启本对话」。')
  }
  const store = manager.storeFor(sessionId)
  if (!store) throw new Error('伴侣记忆数据未能初始化，请稍后重试。')
  return store
}

export function registerTool(ctx, manager) {
  const definition = {
    name: 'companion_memory',
    description: [
      '角色伴侣记忆工具：记录本轮对话、保存重点原文、更新好感度、检索最近 48 小时上下文、检索本地知识库、提交 48 小时归纳。',
      '近期的事用 search_recent/read_recent，超过 48 小时的旧事用 search_kb/read_archive。',
      ACTION_DESCRIPTION,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['turn_end', 'save_important', 'set_favorability', 'search_recent', 'read_recent', 'search_kb', 'read_archive', 'archive_memory', 'summary48h'],
          description: '要执行的动作，说明见工具描述。',
        },
        important: {
          type: 'array',
          description: '需要原样保存到全局活跃记忆的重点信息列表。',
          items: importantItemSchema,
        },
        text: { type: 'string', description: '单条重要原文（save_important 用）。' },
        minor_summary: { type: 'string', description: '本轮次要内容的简短摘要（turn_end 用），写入知识库、不占全局记忆。' },
        turn_summary: { type: 'string', description: '本轮一句话概括（可选，turn_end 用，作为次要摘要的补充）。' },
        favorability: {
          type: 'object',
          description: '本轮好感度变化（turn_end 用）。',
          properties: {
            value: { type: 'integer', description: '新好感度（-100~100）。' },
            reason: { type: 'string', description: '变动理由，必须具体。' },
          },
          required: ['value', 'reason'],
          additionalProperties: false,
        },
        value: { type: 'integer', description: 'set_favorability 的新好感度（-100~100）。' },
        reason: { type: 'string', description: 'set_favorability 的变动理由。' },
        query: { type: 'string', description: 'search_recent / search_kb 的检索词。' },
        limit: { type: 'integer', description: 'search_recent / search_kb 返回条数，默认 6。' },
        id: { type: 'string', description: 'read_recent 的消息 id，例如 msg_xxxxxxxx。' },
        path: { type: 'string', description: 'read_archive 的相对路径，例如 archive/2026-10-01.md。' },
        ids: { type: 'array', items: { type: 'string' }, description: 'archive_memory 的记忆 id 列表。' },
        digest: { type: 'string', description: 'summary48h 的时段小结（提炼后的核心事件与对话要点，不要流水账）。' },
        period_label: { type: 'string', description: 'summary48h 的时段标签，例如 2026-10-26 18:00 ~ 2026-10-28 18:00。' },
        highlights: { type: 'array', items: importantItemSchema, description: 'summary48h 中需要原样保留的重点原文。' },
        favorability_changes: { type: 'array', items: favorabilityChangeSchema, description: 'summary48h 时段内的好感度变化记录。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render(args, value) {
        const message = value && typeof value.message === 'string' ? value.message : '完成。'
        const details = value && typeof value.details === 'string' && value.details !== '' ? `\n\n${value.details}` : ''
        return [{ type: 'text', text: `${message}${details}` }]
      },
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const store = requireStore(exec, manager)
      const action = typeof args?.action === 'string' ? args.action : ''
      switch (action) {
        case 'turn_end': {
          const result = store.recordTurn(args)
          const parts = ['已记录本轮对话。']
          if (result.important > 0) parts.push(`新增重点原文 ${result.important} 条（已进全局活跃记忆）。`)
          if (result.minor) parts.push('次要摘要 1 条已写入知识库归档。')
          if (result.favorability?.changed) {
            parts.push(`好感度 ${result.favorability.from} → ${result.favorability.value}（${result.favorability.reason}）。`)
          } else if (result.favorability && !result.favorability.changed) {
            parts.push('好感度无变化。')
          }
          return { ok: true, message: parts.join('') }
        }
        case 'save_important': {
          const list = Array.isArray(args?.important) ? args.important.map((item) => textOf(item)).filter(Boolean) : []
          if (typeof args?.text === 'string' && args.text.trim() !== '') list.push(args.text)
          if (list.length === 0) throw new Error('save_important 需要 important[] 或 text')
          const saved = []
          const skipped = []
          for (const text of list) {
            const item = Array.isArray(args?.important) ? args.important.find((candidate) => textOf(candidate) === text) : null
            const memory = store.addMemory(text, item?.tags, { source: 'save_important' })
            if (memory) saved.push(memory)
            else skipped.push(text)
          }
          store.persist()
          const parts = [`已保存重点原文 ${saved.length} 条。`]
          if (skipped.length > 0) parts.push(`另有 ${skipped.length} 条与现有原文重复，未重复保存。`)
          return { ok: true, message: parts.join('') }
        }
        case 'set_favorability': {
          const result = store.setFavorability(args?.value, args?.reason)
          return {
            ok: true,
            message: result.changed
              ? `好感度 ${result.from} → ${result.value}，理由：${result.reason}。已归档。`
              : `好感度保持 ${result.value}，没有变化。`,
          }
        }
        case 'search_recent': {
          const result = store.searchRecent(args?.query, args?.limit)
          if (result.results.length === 0) {
            const hint = result.total > 0 ? `（缓存中现有 ${result.total} 条消息）` : ''
            return {
              ok: true,
              message: `最近 48 小时的上下文里没有检索到与「${result.query}」相关的内容${hint}。更早的事已归档进知识库，可改用 search_kb。`,
            }
          }
          const details = result.results
            .map((item, index) => {
              const text = item.text.length > 600 ? `${item.text.slice(0, 600)}…` : item.text
              return `${index + 1}. [${item.time}｜${item.role}｜id:${item.id}]\n${text}`
            })
            .join('\n\n')
          return { ok: true, message: `最近 48 小时上下文检索「${result.query}」命中 ${result.results.length} 条：`, details }
        }
        case 'read_recent': {
          const id = typeof args?.id === 'string' ? args.id : ''
          const entry = store.readRecent(id)
          if (!entry) throw new Error(`最近上下文里没有 id 为 ${id || '(空)'} 的消息；请先用 search_recent 检索。`)
          const text = entry.text.length > 6000 ? `${entry.text.slice(0, 6000)}\n\n（内容过长，已截断至 6000 字符）` : entry.text
          return {
            ok: true,
            message: `已读取 ${entry.id}（${entry.role === 'user' ? '用户' : '角色'}｜${formatRecentTime(entry.ts)}）：`,
            details: text,
          }
        }
        case 'search_kb': {
          const result = store.searchKb(args?.query, args?.limit)
          if (result.results.length === 0) {
            return { ok: true, message: `知识库中没有检索到与「${result.query}」相关的内容。` }
          }
          const details = result.results
            .map((item, index) => `${index + 1}. [${item.file}｜${item.day}]\n${item.snippet}`)
            .join('\n\n')
          return { ok: true, message: `知识库检索「${result.query}」命中 ${result.results.length} 条：`, details }
        }
        case 'read_archive': {
          const file = store.readKbFile(args?.path)
          const content = file.content.length > 6000 ? `${file.content.slice(0, 6000)}\n\n（内容过长，已截断至 6000 字符）` : file.content
          return { ok: true, message: `已读取 ${file.path}：`, details: content }
        }
        case 'archive_memory': {
          const ids = Array.isArray(args?.ids) ? args.ids.filter((id) => typeof id === 'string') : []
          if (ids.length === 0) throw new Error('archive_memory 需要 ids 列表')
          const archived = []
          for (const id of ids) archived.push(store.archiveMemory(id, '按对话要求提前归档').id)
          return { ok: true, message: `已归档 ${archived.length} 条记忆进知识库（原文未改动）。` }
        }
        case 'summary48h': {
          const result = store.writeSummary48h(args)
          const parts = [`已写入 48 小时归纳（时段：${result.periodLabel}）。`]
          if (result.highlights > 0) parts.push(`其中重点原文 ${result.highlights} 条已原样保存。`)
          return { ok: true, message: parts.join('') }
        }
        default:
          throw new Error(`未知 action：${action || '(空)'}`)
      }
    },
  }
  const disposers = []
  if (typeof ctx.tools.guard === 'function') {
    try {
      const offGuard = ctx.tools.guard((execution) => {
        if (!execution || execution.name !== 'companion_memory') return undefined
        const sessionId = sessionIdOfExecution(execution, manager)
        if (!sessionId) return 'companion_memory 只能在聊天对话中使用；当前无法识别对话。'
        if (!manager.isEnabled(sessionId)) {
          return '本对话未开启伴侣记忆，请先在侧边栏【伴侣记忆】面板点击「开启本对话」后再试。'
        }
        return undefined
      })
      if (typeof offGuard === 'function') disposers.push(offGuard)
    } catch {
      // guard is unsupported in this host version; execute() still validates the conversation
    }
  }
  disposers.push(ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
}
