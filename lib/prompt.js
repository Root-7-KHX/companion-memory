/**
 * The system-prompt section: the only place where the companion state becomes
 * visible to the model. It re-reads the three sidebar documents from disk on
 * every assembly, so a save in the sidebar panel applies to the very next turn.
 *
 * `buildPromptSections` is the single source of truth for both the injected text
 * and the read-only overview page, so the panel can never drift from what the
 * model actually receives.
 */
import { CYCLE_LENGTH, DOC_DEFS, INTERACTION_MEMORY_LIMIT, formatDateTime } from './store.js'

function favourLabel(value) {
  if (value <= -75) return '极度憎恨、完全敌对'
  if (value <= -25) return '厌恶、强烈排斥'
  if (value < 25) return '中立、普通陌生'
  if (value < 75) return '有好感、比较信任'
  return '极致信赖、全身心接纳'
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`
}

function docBody(content) {
  return typeof content === 'string' && content.trim() !== '' ? content.trim() : '（空）'
}

function agentPromptService(agentCtx) {
  if (!agentCtx) return undefined
  if (typeof agentCtx.get === 'function') {
    const direct = agentCtx.get('systemPrompt')
    if (direct) return direct
  }
  return agentCtx.systemPrompt
}

/**
 * Register one prompt section per live agent so each conversation renders its
 * own data set and disabled conversations receive no section at all.
 */
export function installAgentPrompt(ctx, manager) {
  const registrations = new Map()

  const install = (agent) => {
    if (!agent || !agent.id) return
    const sessionId = String(agent.id)
    if (registrations.has(sessionId)) return
    const agentCtx = agent.ctx
    const systemPrompt = agentPromptService(agentCtx)
    if (!agentCtx || !systemPrompt || typeof systemPrompt.section !== 'function') return
    if (typeof agentCtx.effect !== 'function') return
    const dispose = agentCtx.effect(() => systemPrompt.section({
      name: 'companion-memory',
      order: 900,
      text: () => {
        if (!manager.isEnabled(sessionId)) return ''
        const store = manager.storeFor(sessionId)
        return store ? renderPrompt(store) : ''
      },
    }), 'companion-memory: per-conversation prompt section')
    registrations.set(sessionId, dispose)
  }

  const uninstall = (agent) => {
    const sessionId = agent && agent.id ? String(agent.id) : ''
    const dispose = registrations.get(sessionId)
    registrations.delete(sessionId)
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch {
        // A disposed agent context may already be gone.
      }
    }
  }

  const stopCreated = typeof ctx.on === 'function' ? ctx.on('agent/created', ({ agent }) => install(agent)) : undefined
  const stopDisposed = typeof ctx.on === 'function' ? ctx.on('agent/disposed', ({ agent }) => uninstall(agent)) : undefined

  // Cover agents that are already alive when the plugin (re)loads.
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents && typeof agents.list === 'function') {
    for (const agent of agents.list()) install(agent)
  }

  return () => {
    if (typeof stopCreated === 'function') stopCreated()
    if (typeof stopDisposed === 'function') stopDisposed()
    for (const dispose of registrations.values()) {
      try {
        dispose()
      } catch {
        // ignore teardown races
      }
    }
    registrations.clear()
  }
}

function favorabilitySection(state) {
  const lines = []
  lines.push(`当前好感度：${state.favorability}（${favourLabel(state.favorability)}）`)
  lines.push('参照区间：-100 极度憎恨、完全敌对｜-50 厌恶、强烈排斥｜0 中立、普通陌生｜50 有好感、比较信任｜100 极致信赖、全身心接纳')
  const recent = state.favorabilityHistory.slice(-5)
  if (recent.length > 0) {
    lines.push('最近变动：')
    for (const change of recent) {
      lines.push(`- ${formatDateTime(new Date(Date.parse(change.at)))}｜好感度：${change.value}（${signed(change.value - change.from)}）｜变动原因：${change.reason}`)
    }
  } else {
    lines.push('最近变动：暂无记录。')
  }
  lines.push('规则：每次对话结束评估一次好感度；只有明确、合理的剧情原因才允许变动；不聊天、时间流逝不会自动衰减，衰减必须写明理由；到达上下限（±100）后不再继续增减。语气、态度、行为倾向必须跟随当前好感度变化，但不得越过【允许&禁止行为】。')
  return lines.join('\n')
}

function memorySection(state, active) {
  const lines = []
  if (active.length === 0) {
    lines.push('（暂无）')
  } else {
    for (const memory of active) {
      const elapsed = typeof memory.createdInteractionDay === 'number'
        ? Math.max(0, state.interactionDays - memory.createdInteractionDay)
        : 0
      const remaining = Math.max(0, INTERACTION_MEMORY_LIMIT - elapsed)
      lines.push(`- 【${memory.id}】保存于第 ${memory.createdInteractionDay ?? '?'} 交互日（${memory.createdDay}｜已存活 ${elapsed} 天｜剩余 ${remaining} 天）原文：`)
      lines.push(memory.text)
      lines.push('')
    }
  }
  lines.push(`> 重点原文禁止修改、删减、改写或脑补；你只能决定是否保存、是否调取。满 ${INTERACTION_MEMORY_LIMIT} 个交互日后由系统自动移入知识库，原文保持不变。`)
  return lines.join('\n')
}

function knowledgeSection() {
  return [
    '本地知识库保存所有带时间戳的归档记录（按日期分组）、月度打包文档与自动打包文档，是超过 48 小时的对话唯一可查的地方。它不会默认出现在对话里：只有当用户主动询问旧事、往事、之前发生过什么，才使用 companion_memory({action:"search_kb", query:"..."}) 检索；需要原文时再用 action:"read_archive" 读取。不要每轮都检索知识库。',
    '检索优先级：本段侧边栏配置 > 全局活跃记忆 > 最近 48 小时上下文 > 知识库。',
  ].join('\n')
}

function recentSection(store) {
  const info = store.recentInfo()
  const lines = []
  if (info.count > 0) {
    lines.push(`- 缓存状态：最近 ${info.windowHours} 小时内共 ${info.count} 条消息（用户 ${info.userCount} 条 / 角色 ${info.assistantCount} 条），覆盖 ${formatDateTime(new Date(info.oldestAt))} ~ ${formatDateTime(new Date(info.newestAt))}。`)
  } else {
    lines.push(`- 缓存状态：最近 ${info.windowHours} 小时内暂无对话。`)
  }
  lines.push('- 检索路由（先近后远）：')
  lines.push('  · 48 小时内发生的事（「刚才」「之前」「我们刚说了什么」）：用 companion_memory({action:"search_recent", query:"关键词"}) 检索原始对话；需要完整原话时用 action:"read_recent", id:"msg_xxxxxxxx"。')
  lines.push('  · 超过 48 小时的内容：已不在最近上下文中，改用 action:"search_kb" 从知识库归档/归纳检索；需要原文用 action:"read_archive"。')
  lines.push('  · 不要把最近上下文整段搬进回复，只在需要回忆时检索相关的几条。')
  return lines.join('\n')
}

function cycleSection(state, period, now, autoPack) {
  const lines = []
  lines.push(`- 当前时间：${formatDateTime(now)}`)
  lines.push(`- 聊天交互日：累计第 ${state.interactionDays} 个｜今天是否已计入：${state.lastInteractionDay === formatDayLocal(now) ? '是' : '否'}（只有当天产生有效对话才计 1 个交互日；不聊天的日子计数器暂停）`)
  if (period.due) {
    lines.push(`- 48 小时归纳：已到期。本轮必须先调用 companion_memory({action:"summary48h", digest:"...", period_label:"${period.periodLabel}", ...}) 完成归纳，再进行正常对话。`)
  } else {
    lines.push(`- 48 小时归纳：未到期${period.nextDueAt ? `，预计 ${formatDateTime(new Date(Date.parse(period.nextDueAt)))} 到期` : ''}。`)
  }
  lines.push(`- 对话月打包：第 ${state.cycle.index} 周期，已进行 ${period.daysInCycle}/${CYCLE_LENGTH} 个交互日（满 ${CYCLE_LENGTH} 个交互日由系统自动生成月度汇总文档，不需要你手动操作）。`)
  if (autoPack && autoPack.every > 0) {
    lines.push(`- 自动打包：用户设置为每 ${autoPack.every} 轮对话自动打包一次；当前区间已累计 ${autoPack.turnsSince}/${autoPack.every} 轮，累计 ${autoPack.totalTurns} 轮，已打包 ${autoPack.count} 次${autoPack.lastPackAt ? `，上次 ${formatDateTime(new Date(Date.parse(autoPack.lastPackAt)))}` : ''}（满额时由系统自动写进知识库，不需要你手动操作）。`)
  } else {
    lines.push('- 自动打包：当前关闭（用户可在侧边栏知识库页设置每 N 轮对话自动打包一次）。')
  }
  return lines.join('\n')
}

function protocolSection() {
  return [
    '你拥有一个记忆工具 `companion_memory`，通过 action 调用：',
    '- turn_end：每次回复结束前调用一次。important[] 放本轮【重要信息】（角色人设、核心设定、剧情关键节点、双方约定、用户固定偏好、主线伏笔）的原文，一字不改；minor_summary 放【次要信息】（闲聊玩笑、一次性话题、次要支线、临时作废想法、流水日常）的简短摘要，不要放进全局记忆；favorability 放本轮好感度变化（value + reason），没有变化可省略。',
    '- save_important：单独保存重要原文（important[] 或 text）。',
    '- set_favorability：单独修改好感度（value + reason，reason 必填）。',
    '- search_kb：用户主动询问旧事（超过 48 小时）时检索知识库归档（query、可选 limit）。',
    '- search_recent：检索最近 48 小时内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用它。',
    '- read_recent：读取最近上下文里的完整原话（id，例如 msg_xxxxxxxx，id 来自 search_recent 结果）。',
    '- read_archive：读取知识库归档原文（path，例如 archive/2026-10-01.md）。',
    '- archive_memory：把指定活跃记忆提前归档进知识库（ids: ["mem_xxxxxxxx"]，id 见上方全局活跃记忆条目的【】内）。',
    '- summary48h：提交 48 小时归纳（digest 时段小结、period_label 时段标签、highlights 重点原文数组、favorability_changes 时段内好感度变化）。',
    '',
    '硬性约束：',
    '1. 已确认的重点原文不允许自行修改、删减、改写原文核心意思；你仅可判断是否保存、是否加载调取，保存时保持原样。',
    '2. 好感度禁止无理由涨跌；衰减必须写明合乎剧情、合乎人设的理由；单纯搁置不对话，好感度维持不变。',
    '3. 次要内容只写简短摘要进知识库，不占用全局记忆；保持全局记忆精简，控制 token 消耗。',
    '4. 知识库归档必须带时间戳（系统会自动加 `归档日期：YYYY-MM-DD HH:MM`）。',
    '5. 48 小时归纳和月度打包是定期复盘，不是每次对话都长篇总结。',
    '6. 用户问近期（48 小时内）的事，用 search_recent 检索原始对话；问更久以前的事才用 search_kb 检索知识库。归档旧内容默认不加载，只有用户主动询问才检索。',
    '7. 所有行为、发言不得越过侧边栏【允许&禁止行为】清单。',
  ].join('\n')
}

const SIDEBAR_INTRO = '以下三份文档由用户在侧边栏【伴侣记忆】面板中随时编辑；每次对话前都会按当前内容重新读取。它们优先于全局活跃记忆与知识库，一切言行必须遵守。'

/**
 * Structured view of everything this plugin contributes to the system prompt.
 * `kind: 'doc'` blocks are the editable sidebar documents; the rest are fixed
 * generated content. Used by the injected prompt and the read-only overview tab.
 */
export function buildPromptSections(store) {
  const now = new Date()
  const state = store.state
  const docs = store.readDocs()
  const period = store.periodInfo(now)
  const active = store.activeMemories()
  const sections = []

  for (const definition of DOC_DEFS) {
    sections.push({
      id: definition.key,
      title: definition.title,
      kind: 'doc',
      editable: true,
      file: definition.file,
      content: docBody(docs[definition.key]),
    })
  }

  sections.push({
    id: 'favorability',
    title: '好感度（范围 -100 ~ 100）',
    kind: 'generated',
    editable: false,
    content: favorabilitySection(state),
  })
  sections.push({
    id: 'memory',
    title: `全局活跃记忆（上限 ${INTERACTION_MEMORY_LIMIT} 个聊天交互日，当前 ${active.length} 条）`,
    kind: 'generated',
    editable: false,
    content: memorySection(state, active),
  })
  sections.push({
    id: 'knowledge',
    title: '知识库（默认不加载，按需检索）',
    kind: 'generated',
    editable: false,
    content: knowledgeSection(),
  })
  const recentInfo = store.recentInfo()
  sections.push({
    id: 'recent',
    title: `最近 48 小时上下文（可检索原文，当前 ${recentInfo.count} 条）`,
    kind: 'generated',
    editable: false,
    content: recentSection(store),
  })
  sections.push({
    id: 'cycle',
    title: '对话周期状态',
    kind: 'generated',
    editable: false,
    content: cycleSection(state, period, now, store.autoPackInfo()),
  })
  sections.push({
    id: 'protocol',
    title: '记忆工具协议（必须遵守）',
    kind: 'generated',
    editable: false,
    content: protocolSection(),
  })

  return sections
}

export function renderPrompt(store) {
  const sections = buildPromptSections(store)
  const docs = sections.filter((section) => section.kind === 'doc')
  const rest = sections.filter((section) => section.kind !== 'doc')
  const lines = []

  lines.push('## 侧边栏配置（最高优先级 · 实时生效）')
  lines.push('')
  lines.push(SIDEBAR_INTRO)
  lines.push('')
  for (const doc of docs) {
    lines.push(`### 【${doc.title}】`)
    lines.push(doc.content)
    lines.push('')
  }
  for (const section of rest) {
    lines.push(`## ${section.title}`)
    lines.push('')
    lines.push(section.content)
    lines.push('')
  }

  return lines.join('\n')
}

/** Payload for the read-only overview tab: per-block sections plus the whole text. */
export function renderPromptPayload(store) {
  const sections = buildPromptSections(store)
  return { sections, full: renderPrompt(store), sidebarIntro: SIDEBAR_INTRO }
}

function formatDayLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
