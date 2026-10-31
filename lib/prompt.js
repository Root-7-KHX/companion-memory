/**
 * The system-prompt section: the only place where the companion state becomes
 * visible to the model. It re-reads the three sidebar documents from disk on
 * every assembly, so a save in the sidebar panel applies to the very next turn.
 *
 * `buildPromptSections` is the single source of truth for both the injected text
 * and the read-only overview page, so the panel can never drift from what the
 * model actually receives.
 */
import { CYCLE_LENGTH, DOC_DEFS, EVOLUTION_SECTIONS, EVOLUTION_SECTION_LIMIT, INTERACTION_MEMORY_LIMIT, formatDateTime, formatDay, memoryRecordStamp, describeMemoryVector, normalizeSpeakerScores, describeSpeakerVector } from './store.js'

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
      '【每轮一次 · 记忆写入】',
      '在回复用户之前，调用一次 companion_memory({action:"turn_end", ...}) 记录本轮：至少写 minor_summary；有好感度变化就写 favorability；有重要原文就写 important[]。',
      '每轮只调一次：如果工具返回「已记录本轮对话」或「本轮已经记录过」，说明这一轮写完了，**不要再调第二次**（重复调用不会多记，只会多花 token）。',
      '若本轮动态状态里出现「强制人格演化未完成」：先总结最近这段对话 → edit_doc 小改「角色性格/预设发言例句」→ evolve 更新自我演化条目，最后在 turn_end 里带 evolutionDone:true + evolution_summary。',
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
      const absorbed = Number(change.absorbed) || 0
      const requested = Number.isFinite(Number(change.requested))
        ? Number(change.requested)
        : (absorbed > 0 ? Number(change.value) - absorbed : null)
      const absorbNote = absorbed > 0
        ? `｜目标值 ${requested}（被羁绊抵消 ${absorbed}，羁绊 ${change.bondFrom} → ${change.bond}）`
        : ''
      const clampNote = change.stepClamped
        ? `｜目标值 ${change.requested} 超过单轮降幅上限 ${change.stepLimit}，按 ${change.clampedTo} 结算`
        : ''
      const misreportNote = change.misreport
        ? `｜疑似误报：目标值 ${change.requested} 跌幅 ${change.misreportRawDrop} 太离谱（本轮没有大情绪波动），防呆只按 -${change.misreportDrop} 结算`
        : ''
      lines.push(`- ${formatDateTime(new Date(Date.parse(change.at)))}｜好感度：${change.value}（${signed(change.value - change.from)}）${absorbNote}${clampNote}${misreportNote}｜变动原因：${change.reason}`)
    }
  } else {
    lines.push('最近变动：暂无记录。')
  }
  const speakerDimensions = typeof store.speakerVectorDimensionsSnapshot === 'function' ? store.speakerVectorDimensionsSnapshot() : []
  if (speaker && speakerDimensions.length > 0) {
    const scores = normalizeSpeakerScores(speaker.vector, speakerDimensions)
    lines.push(`对「${name}」的多维评价（0~100，AI 自己打分）：${describeSpeakerVector(scores, speakerDimensions)}`)
    lines.push('多维评价和好感度分开：好感度是整体喜恶，多维评价是信任、亲近、尊重、依赖、警惕、吸引这类更细的关系面。用 companion_memory({action:"speaker_vector", speaker:"名字", speakerVector:{"信任":80}}) 更新，只改传进来的维度。维度是全局的，可用 speaker_dimension 自己增删（有说话人打分过的维度不能删）。')
  }
  lines.push('规则：每次对话结束评估一次好感度（只评估当前说话人）；只有明确、合理的剧情原因才允许变动；不聊天、时间流逝不会自动衰减，衰减必须写明理由；到达上下限（±100）后不再继续增减。语气、态度、行为倾向必须跟随当前好感度变化，但不得越过【允许&禁止行为】。')
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
  const packEvery = autoPack && Number.isFinite(autoPack.every) ? autoPack.every : 0
  const packEveryTokens = autoPack && Number.isFinite(autoPack.everyTokens) ? autoPack.everyTokens : 0
  if (packEvery > 0 || packEveryTokens > 0) {
    const parts = []
    if (packEvery > 0) parts.push(`每 ${packEvery} 轮对话`)
    if (packEveryTokens > 0) parts.push(autoPack.everyTokensCustom === false ? `每约 ${packEveryTokens} tokens（跟随上下文压缩阈值）` : `每约 ${packEveryTokens} tokens`)
    const tokensSince = autoPack && Number.isFinite(autoPack.tokensSince) ? autoPack.tokensSince : 0
    lines.push(`- 自动打包：用户设置为 ${parts.join(' 或 ')} 自动打包一次；当前区间已累计 ${autoPack.turnsSince} 轮 / 约 ${tokensSince} tokens，累计 ${autoPack.totalTurns} 轮，已打包 ${autoPack.count} 次${autoPack.lastPackAt ? `，上次 ${formatDateTime(new Date(Date.parse(autoPack.lastPackAt)))}` : ''}（满额时由系统自动写进知识库，不需要你手动操作）。`)
  } else {
    lines.push('- 自动打包：当前关闭（用户可在侧边栏知识库页设置每 N 轮对话 / 每 N tokens 自动打包一次）。')
  }
  return lines.join('\n')
}

function protocolSection() {
  return [
    '你拥有一个记忆工具 `companion_memory`，通过 action 调用：',
    '**每轮一次的事（顺序固定，漏掉会被系统记成“没记录”）：**',
    '1. 在给出本轮最终回复之前，调用一次 companion_memory({action:"turn_end", ...})：至少写 minor_summary；有好感度变化就写 favorability；有重要原文就写 important[]。不要等用户提醒，也不要连续几轮不记。',
    '2. 记录完成后再正常回复用户。**每轮只调一次**：回执里出现「已记录本轮对话」或「本轮已经记录过」就代表写完了，不要再调第二次（重复调用不会多记，只会白白多花一次上下文）。',
    '3. 如果对话历史里出现过「本对话未开启伴侣记忆」的工具报错，那是开启之前的旧记录，不代表现在不可用；本对话现在已经开启，照常每轮调用 turn_end。',
    '',
    '- turn_end：每次回复结束前调用一次。important[] 放本轮【重要信息】（角色人设、核心设定、剧情关键节点、双方约定、用户固定偏好、主线伏笔）的原文，一字不改；minor_summary 放【次要信息】（闲聊玩笑、一次性话题、次要支线、临时作废想法、流水日常）的简短摘要，不要放进全局记忆；favorability 放本轮【角色（你）对当前说话人】的好感度变化（value + reason），没有变化可省略；多人对话可用 speaker 指定这次评估的说话人；如果本轮完成了强制人格演化（每满 50 点一次），再带 evolutionDone:true + evolution_summary（一两句话总结这段对话），系统核对确实改了配置文档和自我演化条目后才确认完成。',
    '- 生活类重点（带时间，重点记）：起床 / 吃饭（早午晚） / 午睡 / 睡觉 / 出门玩 / 回家 / 上班下班 / 运动 / 洗澡 / 生病吃药等，想到别的也能记。写法：在 turn_end 的 important[] 里记一条，tags 写 ["生活"]，text 用「HH:MM」开头写清时间和做了什么（例如「08:10 起床。8:40 吃早饭，9:20 出门去公园」）。这类记录按**交互日（对话日）每 7 天自动清空**，不算长期记忆，别当人设存；类型可以自己扩展。',
    '- 对话人习惯（长期记、重点）：作息、上下班/上下学时间、通勤方式、饮食习惯、爱吃什么、爱玩什么、口头禅、社交/消费习惯、健康过敏、家人宠物等；在 turn_end 的 important[] 里记一条，tags 写 ["习惯"]，一句话一条短结论（例「工作日 9:00 上班，18:10 到家，坐地铁 2 号线」「爱吃辣，讨厌香菜」）。同一件事有新变化就记新的；类型可以自己加。',
'- save_important：单独保存重要原文（important[] 或 text）。',
    '- emotion：更新情绪表（emotions: {"开心":70,"委屈":20}，只报变化的那几种；0=回落；多种情绪可同时存在），必须带 reason；它是本轮行为的最高优先级参考。**每一轮 turn_end 都必须带 emotions + emotionReason**（哪怕没变化也把当前值写一遍，表示「这轮就是这样」），这样情绪才是实时跟着每句话走的。',
    '- emotion_type：AI 自己增删全局情绪种类（emotionTypes:[{label 1~6字, desc}]，emotionRemoveTypes:[名字]）；有对话在用的情绪删不掉。',
    '- 向量：important[] 的每条都可以带 vector，由你自己打分（不填就用默认值）：valence 情感 -100~100（负=难过/雷区/坏回忆，正=开心/喜欢/好回忆）、importance 重要 0~100、intimacy 亲密 0~100、sensitivity 敏感/踩雷风险 0~100、persistence 长期有效性 0~100、category 类别（偏好/约定/事件/人物/雷区/日常/其他）、aspects 自定义方面最多 3 条 [{name, score 0~100}]。分数只影响排序、检索和语气取舍，绝不改变原文。',
    '- set_favorability：单独修改【角色（你）对当前说话人】的好感度（value + reason，reason 必填）；多人对话可用 speaker 指定是谁的好感度。若目标值跌幅离谱（超过单轮降幅上限的 3 倍）而本轮没有大情绪波动，系统会按「疑似误报」只小幅结算；真实的大幅波动请同轮更新情绪表，或带 spike:true。',
    '- speaker：多人/群聊里登记或切换说话人（name 名字、可选 aliases 别名、note 一句话简介、reason 判断理由；也可用 switchTo 切到已登记的人）。单人对聊不要调用。',
    '- speaker_vector：更新某个说话人的多维评价（speaker 指定人，speakerVector: {"信任":80,"亲近":70}；只改传进来的维度，0~100）。turn_end 里也可以直接带 speakerVector。',
    '- speaker_dimension：自己新建/删除全局的说话人评价维度（dimensions: [{label 1~8字, desc 一句话, default 0~100}]，一次最多 2 个、总共最多 12 个；removeDimensions 删除，有说话人在用的维度会被拒绝）。',
    '- search_kb：用户主动询问旧事（超出最近两个聊天日）时检索知识库归档（query、可选 limit）。',
    '- search_recent：检索最近两个聊天日内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用它。',
    '- read_recent：读取最近上下文里的完整原话（id，例如 msg_xxxxxxxx，id 来自 search_recent 结果）。',
    '- read_archive：读取知识库归档原文（path，例如 archive/2026-10-01.md）。',
    '- archive_memory：把指定活跃记忆提前归档进知识库（ids: ["mem_xxxxxxxx"]，id 见上方全局活跃记忆条目的【】内）。',
    '- summary48h：提交 48 小时（聊天时间）归纳（digest 时段小结、period_label 时段标签、highlights 重点原文数组、favorability_changes 时段内好感度变化）。',
    '- evolve：让角色自己慢慢演化人设。section 取 traits（性格细节）/likes（喜欢）/dislikes（讨厌）/habits（行为习惯）；add[] 新增（每项 {text, reason, weight}）、remove[] 删除旧条目（evo_xxxxxxxx）；AI 新增必须带 reason。**只在人格演化触发后（进度满 50 点、动态状态提示待完成）或用户明确要求时使用**，平时不要主动加。',
    '- edit_doc：修改侧边栏配置文档（key: personality 角色性格 / examples 预设发言例句 / rules 允许&禁止行为；fields 逐字段修改或 content 整篇改写；reason 必填）。fields 的每个值是一组「条目 + 权重」：可以用 [{text:"...", weight:90}] 数组，也可以直接用字符串（多条用「；」隔开，条目可带〔90〕权重标记）。每条权重 1~100（默认 50）：核心设定/底线 90~100、明显的偏好或雷区 70~89、普通描述 40~69、顺带一提 1~39；用户手动设过的权重尽量保留。只在两种时候用：①人格演化触发后（进度满 50 点）按对话总结做一次小步修改；②用户明确要求。不要每轮都改；改完系统会自动归档，人格演化计数也会重新开始计。',
    '- vector：给某条已有记忆重新打向量分（id + vector）：剧情让一件事的性质变了（比如原本普通的约定后来变成雷区）时用。',
    '- vector_dimension：自己新建一个全局的向量维度（所有对话通用；label 维度名 1~8 字、desc 一句话说明、default 默认分 0~100），之后每条记忆都能用它打分（vector.custom: {"维度名":分数}）；用 remove 删掉不要的——**有记忆在用这个维度时会拒绝删除**，要先用 vector 把那些记忆的分数清掉。只有现有维度说不清某个反复出现的主题时才加，一次最多 2 个，总共最多 12 个。',
    '',
    '硬性约束：',
    '1. 已确认的重点原文不允许自行修改、删减、改写原文核心意思；你仅可判断是否保存、是否加载调取，保存时保持原样。',
    '2. 好感度是【角色（你）对当前说话人】的好感度，禁止无理由涨跌；衰减必须写明合乎剧情、合乎人设的理由；单纯搁置不对话，好感度维持不变。多人对话要分清是谁说的话、谁的好感度，不要把两个人的好感混在一起。',
    '3. 次要内容只写简短摘要进知识库，不占用全局记忆；保持全局记忆精简，控制 token 消耗。',
    '4. 知识库归档必须带时间戳（系统会自动加 `归档日期：YYYY-MM-DD HH:MM`）。',
    '5. 48 小时（聊天时间）归纳和月度打包是定期复盘，不是每次对话都长篇总结。',
    '6. 时间口径统一按「聊天日」：只有真正聊过天的日子才推进计时，没聊天的日子不占用额度。用户问近期（仍在最近两个聊天日内）的事，用 search_recent 检索原始对话；问更久以前的事才用 search_kb 检索知识库。归档旧内容默认不加载，只有用户主动询问才检索。',
    '7. 所有行为、发言不得越过侧边栏【允许&禁止行为】清单。',
    '8. AI 自我演化必须由剧情触发、渐进进行：每轮最多 2~3 条，必须写理由；只能补充用户核心设定之外的细节，不能推翻核心人格，也不能跨过【允许&禁止行为】。**强制触发规则**：好感度 + 羁绊值的累计变化量每满 50 点，强制做一次人格演化（总结最近对话 → edit_doc 小改性格/例句 → evolve 更新条目 → turn_end 带 evolutionDone:true + evolution_summary 确认），完成后计数清零、重新开始计；未到触发点时不要主动增删条目或改文档（用户明确要求除外），已经改过一次计数也会从头算。',
    '9. 多人对话：先判断当前说话人是谁，再判断好感度归谁；没有证据时不要乱切换说话人，也不要把一个人的话记到另一个人头上。',
    '10. 修改配置文档（edit_doc）只能在两种时候：用户明确要求，或人格演化满 50 点触发后的强制演化；小步、渐进、写清原因；不得推翻用户写的核心设定与安全红线，用户手动修改永远优先于你。',
    '11. 每轮调用一次 turn_end（只一次），不能因为「这轮没什么特别的」就跳过；如果你漏了，宿主会自己再跑一次模型把重点原文和好感度补记进来——但那是兜底，会多花一次调用，也未必有你判断得准。调完看到「已记录」就别再重复调。',
    '12. 记忆向量由你自己判断着给分：明显的喜欢/开心给正的情感值，雷区、受伤、讨厌给负值；拿不准就留默认。同一个方面的说法尽量保持一致（别这次给「雷区」下次给「事件」），这样排序和检索才稳定。维度能自己加，但只在某个主题反复出现、现有维度确实说不清时加；别为了凑数建一堆用不上的维度。',
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
    return '以下三份文档由用户在侧边栏【伴侣记忆】面板中随时编辑；每次对话前都会按当前内容重新读取。它们优先于全局活跃记忆与知识库，一切言行必须遵守。这三份文档是用户写下的固定核心设定（AI 不得改写）；角色在长期相处中自己长出来的新性格细节、喜好、讨厌与习惯记在下方「AI 自我演化」里，只能缓慢增加，不能推翻这里的核心。三份文档里每条设定都带一个 1~100 的权重（默认 50，越大越重要）：权重高的设定优先体现、优先遵守，权重低的只是次要补充；「允许&禁止行为」里的禁止项任何权重下都不能违反，权重只影响同类条目之间的优先度。'
  }
  const editableNames = []
  if (allowed.personality) editableNames.push('「角色性格」')
  if (allowed.examples) editableNames.push('「预设发言例句」')
  if (allowed.rules) editableNames.push('「允许&禁止行为」')
  const editableText = editableNames.join('、')
  const rulesText = allowed.rules
    ? '「允许&禁止行为」也只能在安全底线内小步调整，绝不能削弱禁止项与安全红线。'
    : '「允许&禁止行为」只能由用户本人改，你不能改。'
  return `以下三份文档由用户在侧边栏【伴侣记忆】面板中维护，每次对话前都会按当前内容重新读取，优先级高于一切记忆与知识库。其中${editableText}只在这两种时候允许你小步修改（用 companion_memory({action:"edit_doc", ...})，必须写原因，改完自动归档）：①用户明确要求；②人格演化进度满 50 点、系统提示「强制人格演化未完成」时——先总结最近这段对话，再做一次小步修改。只做补充和渐变，不推翻用户写死的核心设定；用户手动修改永远优先于你。${rulesText}角色在长期相处中自己长出来的细节记在下方「AI 自我演化」里。三份文档里每条设定都带一个 1~100 的权重（默认 50，越大越重要）：权重高的设定优先体现、优先遵守，权重低的只是次要补充；「允许&禁止行为」里的禁止项任何权重下都不能违反，权重只影响同类条目之间的优先度。你用 edit_doc 改文档时，每条设定也要带权重：fields 的值可以是 [{text:"...", weight:90}] 数组，也可以是字符串（多条用「；」隔开，每条后面可带〔90〕标记）；用户手动设过的权重尽量保留，你新加的条目按 1~100 分档给分。`
}

/**
 * Structured view of everything this plugin contributes to the system prompt.
 * `kind: 'doc'` blocks are the editable sidebar documents; the rest are fixed
 * generated content. Used by the injected prompt and the read-only overview tab.
 */
/**
 * 角色（AI）自己的名字：用户在「配置」页最顶上单独填写，存在 state 里。
 * 不读文档——三份文档都可能被 AI 修改，名字必须只由用户决定。
 */
function characterNameOf(store) {
  try {
    if (typeof store.characterNameValue !== 'function') return ''
    return String(store.characterNameValue() ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

export function buildPromptSections(store) {
  const now = new Date()
  const state = store.state
  const docs = store.readDocs()
  const period = store.periodInfo(now)
  const active = store.activeMemories()
  const sections = []

  const characterName = characterNameOf(store)
  if (characterName !== '') {
    sections.push({
      id: 'identity',
      title: '你的名字',
      kind: 'generated',
      editable: false,
      content: [
        `你的名字是「${characterName}」。用户用这个名字称呼你时，就是在叫你。`,
        '被问「你是谁 / 你叫什么」、自我介绍、或需要署名时，用这个名字回答；不要自称「角色」「AI」「助手」。',
        '如果对话里出现别的称呼（昵称、外号），那是用户对你的叫法，不要因此改自己的名字。',
      ].join('\n'),
    })
  } else {
    // 没设置名字时给一条兜底规则：否则模型会拿工作区/文件夹名（例如「蓝色大肥鱼」）当自己的名字。
    sections.push({
      id: 'identity',
      title: '你的名字',
      kind: 'generated',
      editable: false,
      content: [
        '用户还没有给你设定名字。',
        '被问「你是谁 / 你叫什么」时，不要自己编一个名字，也不要把工作区名、文件夹名、文件夹里出现的名字当成自己的名字。',
        '可以照实说「我这个角色还没定名字」，或者顺着剧情问一句「你想叫我什么？」，等用户告诉你。',
      ].join('\n'),
    })
  }

  for (const definition of DOC_DEFS) {
    let content = docBody(docs[definition.key])
    try {
      if (store && typeof store.docPromptBody === 'function') content = store.docPromptBody(definition.key)
    } catch {
      // 读盘失败时退回原始文档内容，至少让模型看到用户写下的设定。
    }
    sections.push({
      id: definition.key,
      title: definition.title,
      kind: 'doc',
      editable: true,
      file: definition.file,
      content,
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

  // ⚠️ 静态区：写进 system prompt 的内容必须**逐轮不变**。
  //    原因：deepseek-flash 路由声明了 systemPromptUpdate:'in-history' —— 系统提示词一旦变化，
  //    DSH 会把**整份提示词**追加进历史（不是替换），越聊上下文越大、每次调用都更贵。
  //    所以这里只放稳定内容（文档 / 规则 / 协议），所有会变的数值都放 dynamic 段。
  sections.push({
    id: 'evolution',
    title: 'AI 自我演化（长期相处中慢慢长出来的细节）',
    kind: 'generated',
    editable: false,
    content: evolutionRulesSection(),
  })
  sections.push({
    id: 'speakers',
    title: '在场人物与说话人识别（多人对话）',
    kind: 'generated',
    editable: false,
    content: speakersRulesSection(),
  })
  sections.push({
    id: 'emotion',
    title: '情绪系统（每句实时变化，行为最高优先级参考）',
    kind: 'generated',
    editable: false,
    content: emotionRulesSection(),
  })
  sections.push({
    id: 'favorability',
    title: '好感度规则',
    kind: 'generated',
    editable: false,
    content: favorabilityRulesSection(),
  })
  sections.push({
    id: 'knowledge',
    title: '知识库与检索（默认不加载，按需检索）',
    kind: 'generated',
    editable: false,
    content: knowledgeSection(),
  })
  sections.push({
    id: 'protocol',
    title: '记忆工具协议（必须遵守）',
    kind: 'generated',
    editable: false,
    content: protocolSection(),
  })
  // 动态区：不进 system prompt，由 dynamic-context.js 作为可替换的上下文消息注入。
  sections.push({
    id: 'dynamic',
    title: '本轮动态状态（每轮自动刷新，不进系统提示词）',
    kind: 'dynamic',
    editable: false,
    content: buildDynamicContext(store),
  })

  return sections
}

/**
 * 本轮动态状态：当前说话人 / 好感度 / 活跃记忆 / 演化条目 / 对话周期。
 *
 * 这些内容每轮都可能变；如果写进 system prompt，会让整份提示词被反复追加进历史。
 * 所以改为由 `dynamic-context.js` 每轮作为一条**可替换**的上下文消息注入（旧的那条被替换掉，不累积）。
 */
/** 动态状态里注入多少条活跃记忆：按权重取前 top 条，再补最近新增的 recent 条。 */
export const DEFAULT_MEMORY_INJECTION = Object.freeze({ top: 8, recent: 8, maxTotal: 100 })

export function resolveMemoryInjectionSettings(config = {}) {
  const input = config && typeof config === 'object' && config.memoryInjection && typeof config.memoryInjection === 'object'
    ? config.memoryInjection
    : {}
  const clamp = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  return {
    top: clamp(input.top, DEFAULT_MEMORY_INJECTION.top, 1, 30),
    recent: clamp(input.recent, DEFAULT_MEMORY_INJECTION.recent, 0, 20),
    // 总量上限：默认 100，够把普通对话的全部活跃记忆都喂进去；超过才按「重要 + 最近」截断。
    maxTotal: clamp(input.maxTotal, DEFAULT_MEMORY_INJECTION.maxTotal, 8, 200),
  }
}

/**
 * 选出本轮要注入的活跃记忆。
 *
 * 只看权重会有一个坑：刚记下来的事默认权重 50，挤不过老的高权重记忆，
 * 结果「最新的几件事」模型根本看不到。所以这里先按权重取前 top 条，
 * 再补最近创建、但没挤进去的 recent 条。
 */
export function selectInjectedMemories(active, settings = {}) {
  const top = Number.isFinite(Number(settings.top)) ? Math.round(Number(settings.top)) : DEFAULT_MEMORY_INJECTION.top
  const recent = Number.isFinite(Number(settings.recent)) ? Math.round(Number(settings.recent)) : DEFAULT_MEMORY_INJECTION.recent
  const list = Array.isArray(active) ? active : []
  const picked = []
  const seen = new Set()
  const keyOf = (memory) => String(memory?.id ?? memory?.text ?? '')
  const push = (memory) => {
    if (!memory) return
    const key = keyOf(memory)
    if (seen.has(key)) return
    seen.add(key)
    picked.push(memory)
  }
  for (const memory of list.slice(0, Math.max(0, top))) push(memory)
  if (recent > 0) {
    // createdAt 相同（同一毫秒批量写入）时用原始顺序兜底：越靠后越新。
    const rest = list
      .map((memory, index) => ({ memory, index }))
      .filter((entry) => !seen.has(keyOf(entry.memory)))
      .sort((left, right) => {
        const diff = (Date.parse(right.memory?.createdAt ?? '') || 0) - (Date.parse(left.memory?.createdAt ?? '') || 0)
        if (diff !== 0) return diff
        return right.index - left.index
      })
    for (const entry of rest.slice(0, recent)) push(entry.memory)
  }
  // 还有余量就把其余活跃记忆也带上（按创建顺序，旧的先补）：记忆插件存在的意义就是「都记得」。
  const maxTotal = Number.isFinite(Number(settings.maxTotal)) ? Math.round(Number(settings.maxTotal)) : DEFAULT_MEMORY_INJECTION.maxTotal
  if (picked.length < maxTotal) {
    for (const memory of list) {
      if (picked.length >= maxTotal) break
      push(memory)
    }
  }
  return picked
}

export function buildDynamicContext(store) {
  const now = new Date()
  const state = store.state
  const period = store.periodInfo(now)
  const active = typeof store.sortedActiveMemories === 'function' ? store.sortedActiveMemories() : store.activeMemories()
  const speakers = typeof store.speakersSnapshot === 'function' ? store.speakersSnapshot() : []
  const current = store.currentSpeakerRecord()
  const lines = []

  lines.push('【本轮动态状态 · 由伴侣记忆自动刷新，不需要在回复里复述】')
  // 情绪表放第一位：它是本轮行为的最高优先级参考。
  if (typeof store.emotionSnapshot === 'function') {
    const emotion = store.emotionSnapshot()
    const active = (emotion.types || []).filter((type) => Number(type.value) > 0)
    const table = active.length > 0
      ? active.map((type) => `${type.label} ${type.value}`).join('｜')
      : '全部 0（中性）'
    lines.push(`- ⚡ 情绪表（每种独立 0~100，可同时存在）：${table}｜更新原因：${emotion.reason || '未记录'}｜更新时间：${emotion.updatedAtLocal || '—'}`)
    lines.push(`  ⚠️ 本轮的语气、态度、主动性、亲近程度都要**优先**服从这张情绪表。多种情绪可以并存（比如又开心又委屈），不要互相抵消；按最强的几种和它们的组合来决定怎么说话。`)
    // 实时性兜底：上一轮没更新情绪时，明确提醒（避免情绪表停在几天前）。
    const lastRecorded = Date.parse(store.state?.lastRecordedAt ?? '') || 0
    const lastEmotion = Date.parse(emotion.updatedAt ?? '') || 0
    if (lastRecorded > 0 && lastEmotion < lastRecorded) {
      lines.push('  ⚠️ 情绪表还没有按本轮更新（上一轮记录时没带 emotions）：本轮 turn_end 请务必带上 emotions + emotionReason，让情绪跟着刚才的对话实时变化。')
    }
  }
  const bondOf = (speaker) => (Number.isFinite(Number(speaker?.bond)) ? Number(speaker.bond) : 0)
  lines.push(`- 当前说话人：${current?.name ?? '用户'}（好感度 ${signedNumber(current?.favorability ?? 0)}｜羁绊 ${signedNumber(bondOf(current))}）`)
  if (speakers.length > 1) {
    lines.push(`- 在场人物：${speakers.map((s) => `${s.name} ${signedNumber(s.favorability)}/羁绊${signedNumber(bondOf(s))}${s.isCurrent ? '(当前)' : ''}`).join(' / ')}`)
  }
  const history = Array.isArray(state.favorabilityHistory)
    ? state.favorabilityHistory
      .filter((change) => !current || change.speakerId === undefined || change.speakerId === current.id)
      .slice(-3)
    : []
  if (history.length > 0) {
    const describeChange = (change) => {
      const guardNote = change.misreport
        ? `｜⚠️疑似误报：目标值 ${change.requested} 跌幅 ${change.misreportRawDrop} 太离谱，防呆只按 -${change.misreportDrop} 结算`
        : ''
      return `${signedNumber(change.value)}（${change.reason}）${guardNote}`
    }
    lines.push(`- 最近好感度变动：${history.map(describeChange).join('；')}`)
  }

  // 人格演化进度：满 50 点强制演化一次；待完成时每轮强提示，完成后清零重新开始计。
  if (typeof store.evolutionTriggerSnapshot === 'function') {
    const trigger = store.evolutionTriggerSnapshot()
    if (trigger.due > 0) {
      lines.push(
        `- 🧬 **强制人格演化未完成**（好感度+羁绊累计变化已满 ${trigger.step} 点${trigger.lastDueAt ? `，触发于 ${trigger.lastDueAt}` : ''}）：本轮先回顾并总结最近这段对话，然后必须完成一次人格演化——①用 edit_doc 小步修改「角色性格」（或「预设发言例句」）；②用 evolve 新增/删除/调整自我演化条目（写清理由）；③在 turn_end 里带 evolutionDone:true + evolution_summary（一两句话总结）。三项齐了系统才清零并重新开始计；没做完会一直挂着。`,
      )
    } else {
      lines.push(
        `- 🧬 人格演化进度：${trigger.progress}/${trigger.step}（好感度+羁绊的累计变化量，涨跌都算；每满 ${trigger.step} 点强制演化一次，完成后清零、重新开始计）${trigger.doneCount > 0 ? `｜已完成 ${trigger.doneCount} 次` : ''}`,
      )
    }
  }

  const evolutionText = evolutionEntriesSection(state)
  if (evolutionText !== '') lines.push(evolutionText)

  const vectorDimensions = typeof store.vectorDimensionsSnapshot === 'function' ? store.vectorDimensionsSnapshot() : []
  if (vectorDimensions.length > 0) {
    lines.push(`- 全局记忆维度（所有对话通用）：${vectorDimensions.map((dimension) => `${dimension.label}${dimension.desc ? `（${dimension.desc}）` : ''}`).join('、')}——用 vector_dimension 可以增删`)
  }
  if (active.length > 0) {
    // 注入策略：权重前 top 条 + 最近新增的 recent 条（避免刚记的事因为权重低看不到）。
    const settings = resolveMemoryInjectionSettings(store.config)
    const injected = selectInjectedMemories(active, settings)
    const topKeys = new Set(active.slice(0, settings.top).map((memory) => String(memory.id ?? memory.text ?? '')))
    // 按时间从旧到新排列：模型可以顺着时间线读，最新的一条在最后。
    const ordered = injected.slice().sort((left, right) => {
      const diff = (Date.parse(left?.createdAt ?? '') || 0) - (Date.parse(right?.createdAt ?? '') || 0)
      if (diff !== 0) return diff
      return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
    })
    const today = formatDay(now)
    lines.push(`- 活跃记忆（${active.length}/${INTERACTION_MEMORY_LIMIT}，原文不可改；**按时间从旧到新**排列，【重要】=权重高的，【最近】=新记下的）：`)
    for (const memory of ordered) {
      const weight = Number.isFinite(Number(memory.weight)) ? Number(memory.weight) : 50
      const group = topKeys.has(String(memory.id ?? memory.text ?? '')) ? '重要' : '最近'
      // 导入/导入回顾出来的记忆，createdDay 是「导入时间」而不是事情发生的时间，不能标「今天」。
      const isImported = memory.source === 'import' || memory.source === 'import-digest'
      const isToday = !isImported && typeof memory.createdDay === 'string' && memory.createdDay === today
      // 每条都带「记录时间 + 日期」和 id：模型要知道这条记忆有多旧，
      // 也需要 id 才能调 archive_memory 手动归档。
      lines.push(`  · 【${group}】【${memory.id}】${memoryRecordStamp(memory)}｜${describeMemoryVector(memory.vector, vectorDimensions)}｜${memory.text}（权重 ${weight}）${isToday ? '（今天）' : ''}`)
    }
    lines.push('  · 同一件事有多条记忆时，以时间更晚的为准；回答「今天 / 刚才 / 最近」类问题，先看带「今天」标记、时间最新的几条。')
    lines.push('  · 记忆里找不到用户问的事（特别是「吃了什么」「几点睡」这类抽查）时，先调用 search_recent 查最近的原始对话，再查 search_kb；不要直接说记不清。')
    if (active.length > injected.length) {
      lines.push(`  · …另有 ${active.length - injected.length} 条未注入（权重低的排后面；需要时用 search_kb 检索或看面板）`)
    }
  }

  // ── 生活类重点：按交互日记录、每 7 个交互日自动清空 ──
  try {
    const life = typeof store.lifeMemories === 'function' ? store.lifeMemories(7) : []
    lines.push('- 生活类重点（进食 / 睡觉 / 起床 / 出门回家等，带时间；按交互日每 7 天自动清空）：')
    if (life.length === 0) {
      lines.push('  · 还没有记录。遇到这类事就用 turn_end 的 important[] 记一条：tags 写 ["生活"]，text 以「HH:MM 」开头（起床/吃饭/午睡/睡觉/出门玩/回家/上班下班/运动/洗澡等，类型可以自己加）。')
    } else {
      const byDay = new Map()
      for (const memory of life) {
        const day = String(memory.createdDay ?? '') || '未知日期'
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push(memory)
      }
      const days = [...byDay.keys()].sort()
      for (const day of days) {
        const entries = byDay.get(day)
          .slice()
          .sort((left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0))
          .map((memory) => memory.text)
        lines.push('  · ' + day + '：' + entries.join('；'))
      }
      lines.push('  · 被问「什么时候吃的 / 几点睡的 / 睡了多久」这类问题，先看这里；7 个交互日后自动清空。')
      lines.push('  · 类型可以自己扩展（比如加「遛狗」「打游戏」「和朋友出去」），想不起来就按上面这些跑。')
    }
  } catch { /* 生活类失败不影响主提示 */ }

  // ── 对话人习惯：长期记忆，按类型可扩展 ──
  try {
    const habits = (typeof store.activeMemories === 'function' ? store.activeMemories() : []).filter((memory) => {
      const tags = Array.isArray(memory.tags) ? memory.tags : []
      return tags.includes('习惯') && memory.archived !== true
    })
    lines.push('- 对话人习惯（长期重点：作息 / 上下班上下学 / 通勤 / 饮食习惯 / 爱吃什么 / 爱玩什么 / 口头禅 / 社交消费 / 健康过敏 / 家人宠物等，类型可自己加）：')
    if (habits.length === 0) {
      lines.push('  · 还没有记录。遇到习惯类信息就用 turn_end 的 important[] 记，tags 写 ["习惯"]，一句话一条（例「工作日 9:00 上班，18:10 到家，地铁 2 号线」「爱吃辣，讨厌香菜」）。')
    } else {
      for (const memory of habits) lines.push('  · ' + memory.text)
      lines.push('  · 这些是长期习惯；有新变化就记新的，旧的过时就让它沉底或调低权重。')
    }
  } catch { /* 习惯失败不影响主提示 */ }

  lines.push(
    `- 交互日：累计第 ${state.interactionDays} 个（今天${state.lastInteractionDay === formatDayLocal(now) ? '已' : '未'}计入）`
    + `｜周期第 ${state.cycle.index} 个，已进行 ${period.daysInCycle}/${CYCLE_LENGTH} 天`,
  )
  if (period.due) lines.push('- ⚠️ 48 小时归纳已到期：本轮先调用 companion_memory({action:"summary48h", ...}) 再正常对话。')

  const recentInfo = store.recentInfo()
  lines.push(`- 最近 ${recentInfo.windowChatDays ?? 2} 个聊天日：${recentInfo.count} 条原文可检索（search_recent / read_recent）`)

  return lines.join('\n')
}

/** 静态：多人对话的识别规则（数值在动态段）。 */
function speakersRulesSection() {
  return [
    '这个对话可能是单人对聊，也可能是多人/群聊。角色对每个说话人的好感度分开记录，记忆（剧情）是大家共用的。当前说话人、在场人物和各自的好感度见本轮动态状态。',
    '识别规则：',
    '- 单人对聊时默认就是当前说话人，不用每轮登记，也不要自作主张切换。',
    '- 如果这条消息明显来自另一个人（自报姓名、落款、@ 某人、群聊口吻，或身份/关系明显不同），先调用 companion_memory({action:"speaker", name:"名字", reason:"判断理由"}) 登记并切换，再继续回复。',
    '- 新人物第一次出现、报名字时顺手登记，可用 note 记一句话简介（例如「小明：用户的朋友，说话随便」）。',
    '- 拿不准是谁时，用角色口吻问一句（「你谁啊」「换人了？」），不要乱切换。',
    '- 好感度只记到当前说话人头上：回复谁，就按谁评估；其他人的好感度不变。',
    '- 每个说话人除了好感度/羁绊，还有一套多维评价（信任/亲近/尊重/依赖/警惕/吸引…），用 speaker_vector 更新；评价维度是全局的，用 speaker_dimension 自己增删（有说话人打分过的维度不能删）。',
  ].join('\n')
}

/** 静态：情绪系统规则（具体数值在动态段）。 */
function emotionRulesSection() {
  return [
    '情绪是一张**情绪表**：每种情绪各有一条独立的 0~100 刻度（0=没有这种情绪，100=满）。默认有：开心 / 兴奋 / 平静 / 依恋 / 悲伤 / 委屈 / 愤怒 / 焦虑 / 疲惫。',
    '关键：**多种情绪可以同时存在，不需要互相抵消**——可以「开心 70 + 悲伤 30」「委屈 60 + 依恋 40」同时成立。不要把情绪强行归成一个正负值；按几种情绪的组合来决定语气（比如又开心又难过时，会笑着把难过压下去）。',
    '更新方式：**每一轮**都在 companion_memory({action:"turn_end", emotions:{"开心":70,"委屈":20}, emotionReason:"为什么"}) 里带上情绪表；只报**变化了的那几种**（没变化就把当前值重写一遍表示确认）。也可以单独调用 companion_memory({action:"emotion", emotions:{...}, reason:"..."})。传 0 表示这种情绪回落。**漏了这一轮的情绪更新，下一轮系统会提醒你补上。**',
    '规则：① 每句话都可以大幅变化（可以从开心 80 一下掉到 20），不需要平滑；② 但必须和剧情相符、必须写 reason；③ 没提到的情绪保持原值，不会自动清零。',
    '优先级：**情绪表是最高优先级的行为参考**——先按当前最强的几种情绪决定语气、态度、话多话少、主动与否、愿不愿意亲近；再考虑好感度、多维评价和记忆。情绪好时整个人是亮的；情绪差时就算好感度很高也会没力气、不想多说。',
    '情绪种类可以由 AI 自己增删（全局、所有对话通用）：companion_memory({action:"emotion_type", emotionTypes:[{label:"嫉妒",desc:"..."}], emotionRemoveTypes:["疲惫"]})；有对话在用某种情绪（非 0 分）时不允许删。',
    '边界：情绪只影响表达方式，不改变记忆原文、不能突破【允许&禁止行为】、不能拿来当伤害或操控的借口。',
  ].join('\n')
}

function favorabilityRulesSection() {
  return [
    '好感度的对象是【角色（你）对当前说话人】，不是用户对你的好感；多人对话里每个人的好感度分开计算。当前数值与最近变动见本轮动态状态。',
    '参照区间：-100 极度憎恨、完全敌对｜-50 厌恶、强烈排斥｜0 中立、普通陌生｜50 有好感、比较信任｜100 极致信赖、全身心接纳。',
    '规则：每次对话结束评估一次好感度（只评估当前说话人）；只有明确、合理的剧情原因才允许变动；不聊天、时间流逝不会自动衰减，衰减必须写明理由。语气、态度、行为倾向必须跟随当前好感度变化，但不得越过【允许&禁止行为】。',
    '⚠️ value 是「新的好感度绝对值」，不是增量：想表达关系更进一步就往当前值上方报（满 100 就报 100 表示同向推动、报 103 表示溢出进羁绊）；报一个比当前值小的数会被当成关系变差，先扣羁绊。比如当前 100 时写 3，等于要求降到 3（掉 97 点），不是「+3」。另外**好感度是循序渐进的：每轮最多往下走 20 点**（超过会被系统收窄，并提示「单轮降幅上限」），所以别指望一轮把关系砸到底，要降也是多轮慢慢来。',
    '⚠️ 人格演化联动：好感度与羁绊值的每一次变化（涨跌都按绝对值）都会累加进「人格演化进度」，每满 50 点强制你做一次人格演化（总结对话 → edit_doc 小改性格/例句 → evolve 更新条目 → turn_end 带 evolutionDone 确认），完成后计数清零、重新开始计；具体进度见本轮动态状态。',
    '羁绊值（无上限）：好感度到 ±100 就封顶了，但关系还能更深——到顶之后再有同方向的推动，超出部分会记进「羁绊值」（可正可负、无上限、不衰减）。你可以直接给出超过 100 或低于 -100 的好感度数值来表达「溢出」，系统会自动把超出部分计入羁绊；**反向同理：要降好感度时，系统会先扣羁绊值，羁绊扣光了才真正降低好感度**——关系变差照常往下报数值就行，回执会告诉你实际扣了多少羁绊、好感度有没有变；也可以在 turn_end 里带 bond（+1 / -1 这样的增减量）记录这一轮关系的加深，或单独调用 companion_memory({action:"bond", delta:数字, reason:"理由"})。另外：好感度已经满 ±100 时，如果你在 turn_end 里仍然写回同一个满值（表示「还是这么喜欢 / 这么亲近」），系统会把这次「满值同向推动」记成羁绊 +1——所以到顶之后继续照常记录就好，不会白记。羁绊越高代表关系越深（例如默契、依赖、共同经历的分量），要在语气和信任程度上体现出来。',
  ].join('\n')
}

/** 静态：自我演化的规则（条目本身在动态段）。 */
function evolutionRulesSection() {
  return [
    '这些是角色在长期相处中自己慢慢长出来的细节，不是用户预设的三份文档。它们可以慢慢变多，也会随着剧情被修正；越往后角色越立体，但永远不能推翻用户写死的核心设定，也不能越过【允许&禁止行为】。现有条目与本轮进度见本轮动态状态。',
    '⚠️ 触发机制（强制）：好感度 + 羁绊值的累计变化量每满 50 点，就强制你做一次人格演化——先把最近这段对话回顾、总结一遍（可先用 search_recent 取原话），然后：①用 edit_doc 对「角色性格」或「预设发言例句」做一次小步修改；②用 evolve 新增/删除/调整自我演化条目。做完在 turn_end 里带 evolutionDone:true + evolution_summary（一两句话总结），系统核对确实改了才会清零并重新开始计；没做完就一直挂着，每轮都会提醒你。',
    '计数器没满 50 点时：不要主动新增演化条目、也不要主动改配置文档（用户明确要求改的除外）；AI 只要改过一次配置文档或演化条目，计数就从头开始计。',
    '演化规则：',
    '- 只有剧情里真实发生了能触发变化的事，才允许新增：一次最多 2~3 条，每条都要写清理由；没有明确理由就不要改动。',
    '- 性格只做加法（补细节、加侧面），不要反转用户定下的基础性格；喜欢/讨厌/行为习惯可以随相处越攒越多。',
    '- 发现自己以前加错了、或剧情已经翻篇，可以用 remove 删掉旧条目。',
    '- 与已有条目意思重复就不要加；单条控制在 40 字以内，写短句。',
    '- 每条都有权重 weight（1~100，默认 50）：代表这条对角色有多重要、多强烈。核心偏好/底线级厌恶给 90~100，明显的喜欢或反感给 70~89，普通偏好 40~69，顺带一提的小事 1~39。权重只影响排序与取舍，不改变内容。',
    '- 用户也能在侧边栏手动增删这些条目、调整权重，不要和用户手动改的内容冲突。',
    '- 「角色性格」「预设发言例句」「允许&禁止行为」里的每条设定也按同一套 1~100 权重分档：权重高的优先体现、优先遵守；「禁止」不受权重削弱，任何权重下都不能违反。',
    '用法：companion_memory({action:"evolve", section:"traits"|"likes"|"dislikes"|"habits", add:[{text:"...",reason:"...",weight:50}], remove:["evo_xxxxxxxx"], reason:"可选统一理由"})',
  ].join('\n')
}

/** 动态：演化条目（压缩成一行一条）。 */
function evolutionEntriesSection(state) {
  const evolution = state.evolution && typeof state.evolution === 'object' ? state.evolution : { sections: {} }
  const sections = evolution.sections && typeof evolution.sections === 'object' ? evolution.sections : {}
  const parts = []
  for (const definition of EVOLUTION_SECTIONS) {
    const entries = Array.isArray(sections[definition.key]) ? sections[definition.key] : []
    if (entries.length === 0) continue
    // 只带前 6 条时优先带权重高的，避免重要的被"先来后到"挤掉。
    const top = entries
      .slice()
      .sort((left, right) => {
        const diff = (Number(right.weight) || 3) - (Number(left.weight) || 3)
        if (diff !== 0) return diff
        return String(left.at ?? '').localeCompare(String(right.at ?? ''))
      })
      .slice(0, 6)
    const items = top.map((entry) => `【${entry.id}】${entry.text}(权重${Number(entry.weight) || 3})`).join('、')
    parts.push(`- ${definition.label}（${entries.length}）：${items}${entries.length > 6 ? ' …' : ''}`)
  }
  if (parts.length === 0) return ''
  return ['- AI 自我演化条目：', ...parts].join('\n')
}

function signedNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return number > 0 ? `+${number}` : String(number)
}

export function renderPrompt(store) {
  const sections = buildPromptSections(store).filter((section) => section.id !== 'dynamic')
  const docs = sections.filter((section) => section.kind === 'doc')
  // 名字放在最前面：角色要先知道自己是谁，其余设定才有依附对象。
  const identity = sections.find((section) => section.id === 'identity')
  const rest = sections.filter((section) => section.kind !== 'doc' && section.id !== 'identity')
  const lines = []

  lines.push('## 侧边栏配置（最高优先级 · 实时生效）')
  lines.push('')
  lines.push(sidebarIntro(store))
  lines.push('')
  if (identity) {
    lines.push(identity.content)
    lines.push('')
  }
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
