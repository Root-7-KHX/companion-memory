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
  'turn_end：每次回复结束前记录本轮（important[] 重要原文、minor_summary 次要摘要、favorability 角色对当前说话人的好感度变化；多人对话可用 speaker 指定说话人）。',
  'save_important：保存重要原文（important[] 或 text），原文保持原样。',
  'set_favorability：修改【角色（你）对当前说话人】的好感度（value -100~100、reason 必填；可用 speaker 指定是谁）。',
  'speaker：多人/群聊里登记或切换说话人（name、aliases、note、reason；switchTo 切到已登记的人）。单人对聊不要调用。',
  'edit_doc：修改侧边栏配置文档（key: personality 角色性格 / examples 预设发言例句 / rules 允许&禁止行为；fields 逐字段修改或 content 整篇改写；reason 必填）。只在剧情需要或用户明确要求时小步修改，改完自动归档。',
  'search_recent：检索最近两个聊天日（聊天时间 48 小时）内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用。',
  'read_recent：读取最近上下文里的完整原话（id，如 msg_xxxxxxxx）。',
  'search_kb：检索知识库归档（query），用于最近两个聊天日之外的旧事。',
  'read_archive：读取知识库归档原文（path，如 archive/2026-10-01.md）。',
  'archive_memory：把指定活跃记忆归档进知识库（ids）。',
  'summary48h：提交 48 小时（聊天时间）归纳（digest 必填、period_label、highlights[]、favorability_changes[]）。',
  'evolve：让角色在长期相处中自己慢慢演化（section: traits/likes/dislikes/habits；add[] 新增 {text, reason}，remove[] 删除 evo_xxxxxxxx；AI 新增必须带 reason）。',
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
    value: { type: 'integer', description: '本条记录时的新好感度（角色对用户，-100~100）。' },
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
      '角色伴侣记忆工具：记录本轮对话、保存重点原文、更新【角色对当前说话人】的好感度、登记/切换多人对话的说话人、检索最近 48 小时上下文、检索本地知识库、提交 48 小时归纳。',
      '近期的事用 search_recent/read_recent，超过 48 小时的旧事用 search_kb/read_archive。',
      ACTION_DESCRIPTION,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['turn_end', 'save_important', 'set_favorability', 'speaker', 'edit_doc', 'search_recent', 'read_recent', 'search_kb', 'read_archive', 'archive_memory', 'summary48h', 'evolve'],
          description: '要执行的动作，说明见工具描述。',
        },
        key: {
          type: 'string',
          enum: ['personality', 'rules', 'examples'],
          description: 'edit_doc 要修改的文档：personality 角色性格 / rules 允许&禁止行为 / examples 预设发言例句。',
        },
        content: { type: 'string', description: 'edit_doc 的整篇改写内容（与 fields 二选一；优先用 fields）。' },
        fields: {
          type: 'object',
          description: 'edit_doc 的逐字段内容，键取自对应文档的字段：personality(base/values/tone/thinking/likes/dislikes)、rules(allow/forbid/boundary，一行一条)、examples(greeting/care/upset/catchphrase)。',
          additionalProperties: { type: 'string' },
        },
        extra: { type: 'string', description: 'edit_doc 的「其他补充」内容。' },
        speaker: {
          type: 'string',
          description: '当前这条消息/这次记录对应的说话人名字（多人对话用；单人对聊可省略，默认就是当前说话人）。设置后会切换当前说话人。',
        },
        name: { type: 'string', description: 'speaker 动作：要登记/切换的人物名字。' },
        switchTo: { type: 'string', description: 'speaker 动作：切到已经登记过的人（名字或 id）。' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'speaker 动作：该人物的别名/昵称。' },
        note: { type: 'string', description: 'speaker 动作：一句话简介，例如「小明：用户的朋友，说话随便」。' },
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
          description: '本轮【角色（你）对用户】的好感度变化（turn_end 用）。',
          properties: {
            value: { type: 'integer', description: '新好感度（角色对用户，-100~100）。' },
            reason: { type: 'string', description: '变动理由，必须具体。' },
          },
          required: ['value', 'reason'],
          additionalProperties: false,
        },
        value: { type: 'integer', description: 'set_favorability 的新好感度（角色对用户，-100~100）。' },
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
        section: {
          type: 'string',
          enum: ['traits', 'likes', 'dislikes', 'habits'],
          description: 'evolve 的演化分区：traits 性格细节、likes 喜欢的事物、dislikes 讨厌/回避的事物、habits 行为习惯。',
        },
        add: {
          type: 'array',
          description: 'evolve 要新增的条目，一次最多 3 条；每项 {text, reason}，text 用 40 字以内短句。',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '新增的人格细节/喜好/讨厌/习惯，短句。' },
              reason: { type: 'string', description: '剧情理由：为什么角色会这样变化。' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'evolve 要删除的旧条目 id 列表（形如 evo_xxxxxxxx），一次最多 3 条。',
        },
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
          const parts = [`已记录本轮对话${result.speaker ? `（说话人：${result.speaker}）` : ''}。`]
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
          const speaker = store.currentSpeakerRecord()
          for (const text of list) {
            const item = Array.isArray(args?.important) ? args.important.find((candidate) => textOf(candidate) === text) : null
            const memory = store.addMemory(text, item?.tags, { source: 'save_important', speakerId: speaker?.id })
            if (memory) saved.push(memory)
            else skipped.push(text)
          }
          store.persist()
          const parts = [`已保存重点原文 ${saved.length} 条。`]
          if (skipped.length > 0) parts.push(`另有 ${skipped.length} 条与现有原文重复，未重复保存。`)
          return { ok: true, message: parts.join('') }
        }
        case 'set_favorability': {
          const result = store.setFavorability(args?.value, args?.reason, args?.speaker)
          const who = result.speaker ? `（对「${result.speaker}」）` : ''
          return {
            ok: true,
            message: result.changed
              ? `好感度${who} ${result.from} → ${result.value}，理由：${result.reason}。已归档。`
              : `好感度${who}保持 ${result.value}，没有变化。`,
          }
        }
        case 'speaker': {
          const switchRef = typeof args?.switchTo === 'string' ? args.switchTo.trim() : ''
          const nameRef = typeof args?.name === 'string' ? args.name.trim() : typeof args?.speaker === 'string' ? args.speaker.trim() : ''
          const ref = switchRef || nameRef
          if (ref === '') {
            const current = store.currentSpeakerRecord()
            return {
              ok: true,
              message: `当前说话人是「${current?.name ?? '用户'}」。请提供 name 登记新人物，或用 switchTo 切换。`,
              details: store.speakersSnapshot().map((item) => `- ${item.name}：${item.favorability}${item.isCurrent ? '（当前）' : ''}`).join('\n'),
            }
          }
          let speaker = store.speakerById(ref)
          if (!speaker && nameRef !== '') {
            speaker = store.switchSpeaker(nameRef, { aliases: args?.aliases, note: args?.note })
          } else if (speaker) {
            speaker = store.switchSpeaker(speaker.id, { aliases: args?.aliases, note: args?.note })
          } else {
            throw new Error(`没有找到人物「${ref}」，请先用 name 登记。`)
          }
          const list = store.speakersSnapshot().map((item) => `- ${item.name}：${item.favorability}${item.isCurrent ? '（当前）' : ''}`).join('\n')
          return {
            ok: true,
            message: `当前说话人已切换为「${speaker.name}」（好感度 ${speaker.favorability}）。${args?.note ? `备注：${String(args.note).slice(0, 120)}。` : ''}`,
            details: list,
          }
        }
        case 'edit_doc': {
          const docKey = typeof args?.key === 'string' ? args.key.trim() : ''
          if (!['personality', 'rules', 'examples'].includes(docKey)) {
            throw new Error('edit_doc 的 key 必须是 personality / rules / examples')
          }
          const fields = args?.fields && typeof args.fields === 'object' && !Array.isArray(args.fields) ? args.fields : undefined
          const content = typeof args?.content === 'string' && args.content.trim() !== '' ? args.content : undefined
          const result = store.writeDocFromAi(docKey, {
            fields,
            content,
            extra: typeof args?.extra === 'string' ? args.extra : undefined,
            reason: args?.reason,
          })
          const parts = [result.changed ? `已修改「${result.title}」。` : `「${result.title}」内容没有变化。`]
          parts.push(`原因：${result.reason}。`)
          return {
            ok: true,
            message: parts.join(''),
            details: result.changed ? '本次修改已写入知识库归档（类型：AI 修改配置文档），用户可以在侧边栏查看或再修改。' : '',
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
        case 'evolve': {
          const result = store.evolvePersona({
            section: args?.section,
            add: args?.add,
            remove: args?.remove,
            reason: args?.reason,
            by: 'ai',
          })
          const parts = [`已在「${result.label}」里留下自我演化：新增 ${result.added.length} 条`]
          if (result.removed.length > 0) parts.push(`、删除 ${result.removed.length} 条`)
          if (result.skipped.length > 0) parts.push(`、跳过重复 ${result.skipped.length} 条`)
          parts.push(`；该分区现有 ${result.total}/${result.limit} 条。`)
          const added = result.added.map((entry) => `- ${entry.text}（${entry.reason}）`).join('\n')
          return { ok: true, message: parts.join(''), details: added }
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
