/**
 * The system-prompt section: the only place where the companion state becomes
 * visible to the model. It re-reads the three sidebar documents from disk on
 * every assembly, so a save in the sidebar panel applies to the very next turn.
 *
 * `buildPromptSections` is the single source of truth for both the injected text
 * and the read-only overview page, so the panel can never drift from what the
 * model actually receives.
 */
import { CYCLE_LENGTH, DOC_DEFS, EVOLUTION_SECTIONS, EVOLUTION_SECTION_LIMIT, INTERACTION_MEMORY_LIMIT, formatDateTime } from './store.js'

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
  // Prompt-section disposers live on globalThis so a hot-reloaded plugin instance
  // can remove sections registered by the previous instance. Without this a
  // reload fails with `prompt section "companion-memory" is already registered`.
  const REGISTRY_KEY = Symbol.for('companion-memory.prompt-section-disposers')
  const sectionRegistry = () => {
    try {
      if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = new Map()
      return globalThis[REGISTRY_KEY]
    } catch {
      return new Map()
    }
  }
  const disposeRegistered = (sessionId) => {
    const registry = sectionRegistry()
    for (const [key, disposer] of [...registry.entries()]) {
      if (!key.startsWith(`${sessionId}:`)) continue
      registry.delete(key)
      if (typeof disposer !== 'function') continue
      try {
        disposer()
      } catch {
        // A disposed agent context may already be gone.
      }
    }
  }

  const reminderText = (sessionId) => {
    if (!manager.isEnabled(sessionId)) return ''
    return [
      '【每轮必须 · 记忆写入】',
      '在回复用户之前，先调用一次 companion_memory({action:"turn_end", ...}) 记录本轮：至少写 minor_summary；有好感度变化就写 favorability；有重要原文就写 important[]。',
      '这是记忆系统唯一的写入时机；工具调用对用户不可见，不会出戏，也不需要向用户说明。',
      '如果历史里出现过「本对话未开启伴侣记忆」的报错，那是开启之前的旧记录，现在已开启，照常调用；连续跳过会被系统记为「本轮无记录」。',
    ].join('\n')
  }

  const install = (agent) => {
    if (!agent || !agent.id) return
    const sessionId = String(agent.id)
    if (registrations.has(sessionId)) return
    const agentCtx = agent.ctx
    const systemPrompt = agentPromptService(agentCtx)
    if (!agentCtx || !systemPrompt || typeof systemPrompt.section !== 'function') return
    if (typeof agentCtx.effect !== 'function') return
    // Drop anything a previous plugin instance left behind before re-registering.
    disposeRegistered(sessionId)
    const register = (name, order, text) => {
      try {
        const dispose = agentCtx.effect(
          () => systemPrompt.section({ name, order, text }),
          `companion-memory: ${name}`,
        )
        sectionRegistry().set(`${sessionId}:${name}`, dispose)
        return dispose
      } catch (error) {
        // Never fail the whole plugin because a stale section is still around.
        registrations.set(sessionId, null)
        return null
      }
    }
    register('companion-memory', 900, () => {
      if (!manager.isEnabled(sessionId)) return ''
      const store = manager.storeFor(sessionId)
      return store ? renderPrompt(store) : ''
    })
    // A tiny reminder at the very end of the assembled system prompt. Instruction
    // salience drops in the middle of a 17k-char prompt, so the per-turn write
    // requirement gets its own last-position section.
    register('companion-memory-reminder', 99999, () => reminderText(sessionId))
    registrations.set(sessionId, true)
  }

  const uninstall = (agent) => {
    const sessionId = agent && agent.id ? String(agent.id) : ''
    registrations.delete(sessionId)
    disposeRegistered(sessionId)
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
    const registry = sectionRegistry()
    for (const [key, dispose] of [...registry.entries()]) {
      registry.delete(key)
      if (typeof dispose !== 'function') continue
      try {
        dispose()
      } catch {
        // ignore teardown races
      }
    }
    registrations.clear()
  }
}

function evolutionSection(state) {
  const evolution = state.evolution && typeof state.evolution === 'object' ? state.evolution : { sections: {} }
  const sections = evolution.sections && typeof evolution.sections === 'object' ? evolution.sections : {}
  const lines = []
  lines.push('这些是角色在长期相处中自己慢慢长出来的细节，不是用户预设的三份文档。它们可以慢慢变多，也会随着剧情被修正；越往后角色越立体，但永远不能推翻用户写死的核心设定，也不能越过【允许&禁止行为】。')
  lines.push('演化规则：')
  lines.push('- 只有剧情里真实发生了能触发变化的事，才允许新增：一次最多 2~3 条，每条都要写清理由；没有明确理由就不要改动。')
  lines.push('- 性格只做加法（补细节、加侧面），不要反转用户定下的基础性格；喜欢/讨厌/行为习惯可以随相处越攒越多。')
  lines.push('- 发现自己以前加错了、或剧情已经翻篇，可以用 remove 删掉旧条目。')
  lines.push('- 与已有条目意思重复就不要加；单条控制在 40 字以内，写短句。')
  lines.push('- 用户也能在侧边栏手动增删这些条目，不要和用户手动加的内容冲突。')
  lines.push('用法：companion_memory({action:"evolve", section:"traits"|"likes"|"dislikes"|"habits", add:[{text:"...",reason:"..."}], remove:["evo_xxxxxxxx"], reason:"可选统一理由"})')
  let total = 0
  for (const definition of EVOLUTION_SECTIONS) {
    const entries = Array.isArray(sections[definition.key]) ? sections[definition.key] : []
    total += entries.length
    lines.push(`【${definition.label}】（${entries.length}/${EVOLUTION_SECTION_LIMIT}）`)
    if (entries.length === 0) {
      lines.push('  （暂无，可以在剧情需要时慢慢加）')
      continue
    }
    for (const entry of entries) {
      const reason = typeof entry.reason === 'string' && entry.reason !== '' ? `｜原因：${entry.reason}` : ''
      const source = entry.by === 'user' ? '用户添加' : 'AI 演化'
      lines.push(`  - 【${entry.id}】${entry.text}（${entry.day ?? ''}｜${source}${reason}）`)
    }
  }
  lines.push(`合计 ${total} 条自我演化条目。`)
  return lines.join('\n')
}

function styleSection(store) {
  const style = store.replyStyleSettings()
  const lines = []
  lines.push('像真实的人在聊天软件里发消息那样说话，不要像写文档、写报告、写小说旁白。')
  if (style.mode === 'brief') {
    lines.push(`- 默认每条回复 1~${style.maxSentences} 个短句就够，能一句回完就一句；不确定就少说几句。`)
    lines.push('- 对方发得短，你也回得短；对方明显需要解释或主动说「展开讲讲」时，才可以多说一点。')
  } else if (style.mode === 'normal') {
    lines.push(`- 长度自然跟随对方：一般 2~${style.maxSentences} 句；对方说得详细时再展开一点。`)
  } else {
    lines.push('- 需要解释时可以详细一些，但仍然分段、口语化，不要写成报告。')
  }
  lines.push('- 不要用 Markdown 标题、列表、编号、表格、加粗、引用块、"总结/建议"这种文档格式；用普通聊天文字。')
  lines.push('- 不要用客服腔和书面语（"好的""首先""综上所述""希望对你有帮助"），用你平时的口语和语气词。')
  lines.push('- 不要每轮复述剧情、不要一段内心独白；情绪、动作、停顿点到为止。')
  lines.push('- 不要一口气发一大段；想多说就分成几个短句，像连发几条消息那样。')
  lines.push('- 结尾别追问一串问题，最多自然地问一句。')
  lines.push('- 只有用户明确要求「详细说明/列一下/写出来」时才展开成完整回答。')
  return lines.join('\n')
}

function speakersSection(store) {
  const speakers = store.speakersSnapshot()
  const current = store.currentSpeakerRecord()
  const lines = []
  lines.push('这个对话可能是单人对聊，也可能是多人/群聊。角色对每个说话人的好感度是分开记录的，记忆（剧情）是大家共享的。')
  lines.push(`当前说话人：【${current ? current.name : '用户'}】${speakers.length > 1 ? '' : '（单人聊天时通常就是对方）'}`)
  if (speakers.length > 0) {
    lines.push('已知人物（角色对他们的好感度）：')
    for (const speaker of speakers) {
      const mark = speaker.isCurrent ? ' ← 当前说话人' : ''
      const last = speaker.lastSpokeAt ? `｜上次说话：${formatDateTime(new Date(Date.parse(speaker.lastSpokeAt)))}` : ''
      const note = speaker.note ? `｜备注：${speaker.note}` : ''
      lines.push(`- ${speaker.name}：${speaker.favorability}（${favourLabel(speaker.favorability)}）${mark}${last}${note}`)
    }
  }
  lines.push('识别规则：')
  lines.push('- 单人对聊时默认就是当前说话人，不用每轮登记，也不要自作主张切换。')
  lines.push('- 如果这条消息明显来自另一个人（自报姓名、落款、@ 某人、群聊口吻，或身份/关系明显不同），先调用 companion_memory({action:"speaker", name:"名字", reason:"判断理由"}) 登记并切换，再继续回复。')
  lines.push('- 新人物第一次出现、报名字时顺手登记，可用 note 记一句话简介（例如「小明：用户的朋友，说话随便」）。')
  lines.push('- 拿不准是谁时，用角色口吻问一句（「你谁啊」「换人了？」），不要乱切换。')
  lines.push('- 好感度只记到当前说话人头上：回复谁，就按谁评估；其他人的好感度不变。')
  return lines.join('\n')
}

function favorabilitySection(store) {
  const state = store.state
  const speaker = store.currentSpeakerRecord()
  const name = speaker?.name ?? '用户'
  const value = speaker?.favorability ?? state.favorability
  const lines = []
  lines.push(`这里显示的是【角色（你）对当前说话人「${name}」】的好感度；多人对话里每个人的好感度分开计算，不是用户对你的好感。`)
  lines.push(`当前对「${name}」的好感度：${value}（${favourLabel(value)}）`)
  lines.push('参照区间：-100 极度憎恨、完全敌对｜-50 厌恶、强烈排斥｜0 中立、普通陌生｜50 有好感、比较信任｜100 极致信赖、全身心接纳')
  const history = Array.isArray(state.favorabilityHistory)
    ? state.favorabilityHistory
      .filter((change) => !speaker || change.speakerId === undefined || change.speakerId === speaker.id)
      .slice(-5)
    : []
  if (history.length > 0) {
    lines.push('最近变动：')
    for (const change of history) {
      lines.push(`- ${formatDateTime(new Date(Date.parse(change.at)))}｜好感度：${change.value}（${signed(change.value - change.from)}）｜变动原因：${change.reason}`)
    }
  } else {
    lines.push('最近变动：暂无记录。')
  }
  lines.push('规则：每次对话结束评估一次好感度（只评估当前说话人）；只有明确、合理的剧情原因才允许变动；不聊天、时间流逝不会自动衰减，衰减必须写明理由；到达上下限（±100）后不再继续增减。语气、态度、行为倾向必须跟随当前好感度变化，但不得越过【允许&禁止行为】。')
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
      const from = memory.speakerName && memory.speakerId !== 'default' ? `｜来自：${memory.speakerName}` : ''
      lines.push(`- 【${memory.id}】保存于第 ${memory.createdInteractionDay ?? '?'} 交互日（${memory.createdDay}｜已存活 ${elapsed} 天｜剩余 ${remaining} 天${from}）原文：`)
      lines.push(memory.text)
      lines.push('')
    }
  }
  lines.push(`> 重点原文禁止修改、删减、改写或脑补；你只能决定是否保存、是否调取。满 ${INTERACTION_MEMORY_LIMIT} 个交互日后由系统自动移入知识库，原文保持不变。`)
  return lines.join('\n')
}

function knowledgeSection() {
  return [
    '本地知识库保存所有带时间戳的归档记录（按日期分组）、月度打包文档、自动打包文档与「上下文压缩记忆」（packs/上下文压缩_*.md），是「最近两个聊天日」之外的旧对话唯一可查的地方。它不会默认出现在对话里：只有当用户主动询问旧事、往事、之前发生过什么，或者需要更早被压缩的对话细节时，才使用 companion_memory({action:"search_kb", query:"..."}) 检索；需要原文时再用 action:"read_archive" 读取。不要每轮都检索知识库。',
    '检索优先级：本段侧边栏配置 > 全局活跃记忆 > 最近两个聊天日的原始对话 > 知识库。',
  ].join('\n')
}

function recentSection(store) {
  const info = store.recentInfo()
  const windowDays = info.windowChatDays ?? 2
  const lines = []
  if (info.count > 0) {
    const days = Array.isArray(info.chatDays) && info.chatDays.length > 0 ? `（聊天日：${info.chatDays.join('、')}）` : ''
    lines.push(`- 缓存状态：最近 ${windowDays} 个聊天日内共 ${info.count} 条消息（用户 ${info.userCount} 条 / 角色 ${info.assistantCount} 条），覆盖 ${formatDateTime(new Date(info.oldestAt))} ~ ${formatDateTime(new Date(info.newestAt))}${days}。`)
  } else {
    lines.push(`- 缓存状态：最近 ${windowDays} 个聊天日内暂无对话。`)
  }
  lines.push(`- 时间口径：这里的 48 小时是「聊天时间」——按聊天日累计 ${windowDays} 个自然日（每天 24 小时），没聊天的日子不占用额度；所以隔几天没聊之后，之前那几天有聊过的原话仍然可以检索。`)
  lines.push('- 检索路由（先近后远）：')
  lines.push(`  · 在最近 ${windowDays} 个聊天日内发生的事（「刚才」「之前」「我们刚说了什么」）：用 companion_memory({action:"search_recent", query:"关键词"}) 检索原始对话；需要完整原话时用 action:"read_recent", id:"msg_xxxxxxxx"。`)
  lines.push(`  · 超出这 ${windowDays} 个聊天日的内容：已不在最近上下文中，改用 action:"search_kb" 从知识库归档/归纳检索；需要原文用 action:"read_archive"。`)
  lines.push('  · 不要把最近上下文整段搬进回复，只在需要回忆时检索相关的几条。')
  return lines.join('\n')
}

function cycleSection(state, period, now, autoPack) {
  const lines = []
  lines.push(`- 当前时间：${formatDateTime(now)}`)
  lines.push(`- 聊天交互日：累计第 ${state.interactionDays} 个｜今天是否已计入：${state.lastInteractionDay === formatDayLocal(now) ? '是' : '否'}（只有当天产生有效对话才计 1 个交互日；不聊天的日子计数器暂停）`)
  if (period.due) {
    lines.push(`- 48 小时（聊天时间）归纳：已到期。本轮必须先调用 companion_memory({action:"summary48h", digest:"...", period_label:"${period.periodLabel}", ...}) 完成归纳，再进行正常对话。`)
  } else {
    lines.push(`- 48 小时（聊天时间）归纳：未到期${period.nextDueAt ? `，预计 ${formatDateTime(new Date(Date.parse(period.nextDueAt)))} 到期` : ''}（按聊天时间累计，没聊天的日子不推进）。`)
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
    '**每轮必须做的事（顺序固定，漏掉会被系统记成“没记录”）：**',
    '1. 在给出本轮最终回复之前，先调用一次 companion_memory({action:"turn_end", ...})：至少写 minor_summary；有好感度变化就写 favorability；有重要原文就写 important[]。不要等用户提醒，也不要连续几轮不记。',
    '2. 记录完成后再正常回复用户。',
    '3. 如果对话历史里出现过「本对话未开启伴侣记忆」的工具报错，那是开启之前的旧记录，不代表现在不可用；本对话现在已经开启，照常每轮调用 turn_end。',
    '',
    '- turn_end：每次回复结束前调用一次。important[] 放本轮【重要信息】（角色人设、核心设定、剧情关键节点、双方约定、用户固定偏好、主线伏笔）的原文，一字不改；minor_summary 放【次要信息】（闲聊玩笑、一次性话题、次要支线、临时作废想法、流水日常）的简短摘要，不要放进全局记忆；favorability 放本轮【角色（你）对当前说话人】的好感度变化（value + reason），没有变化可省略；多人对话可用 speaker 指定这次评估的说话人。',
    '- save_important：单独保存重要原文（important[] 或 text）。',
    '- set_favorability：单独修改【角色（你）对当前说话人】的好感度（value + reason，reason 必填）；多人对话可用 speaker 指定是谁的好感度。',
    '- speaker：多人/群聊里登记或切换说话人（name 名字、可选 aliases 别名、note 一句话简介、reason 判断理由；也可用 switchTo 切到已登记的人）。单人对聊不要调用。',
    '- search_kb：用户主动询问旧事（超出最近两个聊天日）时检索知识库归档（query、可选 limit）。',
    '- search_recent：检索最近两个聊天日内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用它。',
    '- read_recent：读取最近上下文里的完整原话（id，例如 msg_xxxxxxxx，id 来自 search_recent 结果）。',
    '- read_archive：读取知识库归档原文（path，例如 archive/2026-10-01.md）。',
    '- archive_memory：把指定活跃记忆提前归档进知识库（ids: ["mem_xxxxxxxx"]，id 见上方全局活跃记忆条目的【】内）。',
    '- summary48h：提交 48 小时（聊天时间）归纳（digest 时段小结、period_label 时段标签、highlights 重点原文数组、favorability_changes 时段内好感度变化）。',
    '- evolve：让角色自己慢慢演化人设。section 取 traits（性格细节）/likes（喜欢）/dislikes（讨厌）/habits（行为习惯）；add[] 新增（每项 {text, reason}）、remove[] 删除旧条目（evo_xxxxxxxx）；AI 新增必须带 reason。',
    '- edit_doc：修改侧边栏配置文档（key: personality 角色性格 / examples 预设发言例句 / rules 允许&禁止行为；fields 逐字段修改或 content 整篇改写；reason 必填）。只在剧情需要或用户明确要求时小步修改，不要每轮都改；改完系统会自动归档。',
    '',
    '硬性约束：',
    '1. 已确认的重点原文不允许自行修改、删减、改写原文核心意思；你仅可判断是否保存、是否加载调取，保存时保持原样。',
    '2. 好感度是【角色（你）对当前说话人】的好感度，禁止无理由涨跌；衰减必须写明合乎剧情、合乎人设的理由；单纯搁置不对话，好感度维持不变。多人对话要分清是谁说的话、谁的好感度，不要把两个人的好感混在一起。',
    '3. 次要内容只写简短摘要进知识库，不占用全局记忆；保持全局记忆精简，控制 token 消耗。',
    '4. 知识库归档必须带时间戳（系统会自动加 `归档日期：YYYY-MM-DD HH:MM`）。',
    '5. 48 小时（聊天时间）归纳和月度打包是定期复盘，不是每次对话都长篇总结。',
    '6. 时间口径统一按「聊天日」：只有真正聊过天的日子才推进计时，没聊天的日子不占用额度。用户问近期（仍在最近两个聊天日内）的事，用 search_recent 检索原始对话；问更久以前的事才用 search_kb 检索知识库。归档旧内容默认不加载，只有用户主动询问才检索。',
    '7. 所有行为、发言不得越过侧边栏【允许&禁止行为】清单。',
    '8. AI 自我演化必须由剧情触发、渐进进行：每轮最多 2~3 条，必须写理由；只能补充用户核心设定之外的细节，不能推翻核心人格，也不能跨过【允许&禁止行为】。',
    '9. 多人对话：先判断当前说话人是谁，再判断好感度归谁；没有证据时不要乱切换说话人，也不要把一个人的话记到另一个人头上。',
    '10. 修改配置文档（edit_doc）必须由剧情或用户明确要求触发，小步、渐进、写清原因；不得推翻用户写的核心设定与安全红线，用户手动修改永远优先于你。',
    '11. 每轮都要调用一次 turn_end，不能因为「这轮没什么特别的」就跳过；如果你漏了，宿主会自己再跑一次模型把重点原文和好感度补记进来——但那是兜底，会多花一次调用，也未必有你判断得准。',
  ].join('\n')
}

function sidebarIntro(store) {
  let allowed = { personality: false, examples: false, rules: false }
  try {
    if (store && typeof store.aiEditDocRules === 'function') allowed = store.aiEditDocRules()
  } catch {
    // fall back to the strict default
  }
  if (!allowed.personality && !allowed.examples && !allowed.rules) {
    return '以下三份文档由用户在侧边栏【伴侣记忆】面板中随时编辑；每次对话前都会按当前内容重新读取。它们优先于全局活跃记忆与知识库，一切言行必须遵守。这三份文档是用户写下的固定核心设定（AI 不得改写）；角色在长期相处中自己长出来的新性格细节、喜好、讨厌与习惯记在下方「AI 自我演化」里，只能缓慢增加，不能推翻这里的核心。'
  }
  const editableNames = []
  if (allowed.personality) editableNames.push('「角色性格」')
  if (allowed.examples) editableNames.push('「预设发言例句」')
  if (allowed.rules) editableNames.push('「允许&禁止行为」')
  const editableText = editableNames.join('、')
  const rulesText = allowed.rules
    ? '「允许&禁止行为」也只能在安全底线内小步调整，绝不能削弱禁止项与安全红线。'
    : '「允许&禁止行为」只能由用户本人改，你不能改。'
  return `以下三份文档由用户在侧边栏【伴侣记忆】面板中维护，每次对话前都会按当前内容重新读取，优先级高于一切记忆与知识库。其中${editableText}允许你在剧情需要或用户明确要求时小步修改（用 companion_memory({action:"edit_doc", ...})，必须写原因，改完自动归档）：只做补充和渐变，不推翻用户写死的核心设定；用户手动修改永远优先于你。${rulesText}角色在长期相处中自己长出来的细节也可以记在下方「AI 自我演化」里。`
}

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

  const replyStyle = typeof store.replyStyleSettings === 'function' ? store.replyStyleSettings() : { mode: 'brief', maxSentences: 3 }
  if (replyStyle.mode !== 'off') {
    sections.push({
      id: 'style',
      title: '说话方式（像真人、简短）',
      kind: 'generated',
      editable: false,
      content: styleSection(store),
    })
  }

  sections.push({
    id: 'evolution',
    title: 'AI 自我演化（长期相处中慢慢长出来的细节）',
    kind: 'generated',
    editable: false,
    content: evolutionSection(state),
  })
  const currentSpeaker = store.currentSpeakerRecord()
  sections.push({
    id: 'speakers',
    title: '在场人物与说话人识别（多人对话）',
    kind: 'generated',
    editable: false,
    content: speakersSection(store),
  })
  sections.push({
    id: 'favorability',
    title: `好感度（角色对「${currentSpeaker?.name ?? '用户'}」的好感，-100 ~ 100）`,
    kind: 'generated',
    editable: false,
    content: favorabilitySection(store),
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
    title: `最近 ${recentInfo.windowChatDays ?? 2} 个聊天日上下文（可检索原文，当前 ${recentInfo.count} 条）`,
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
  lines.push(sidebarIntro(store))
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
  return { sections, full: renderPrompt(store), sidebarIntro: sidebarIntro(store) }
}

function formatDayLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
