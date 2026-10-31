/**
 * The single model-facing tool: `companion_memory`.
 *
 * One action-enum tool keeps the tool catalogue small while covering everything
 * the prompt protocol asks for (turn recording, important-verbatim saves,
 * favorability, recent-context recall, knowledge-base search/read, 48h
 * summaries, manual archiving).
 */
import { formatRecentTime } from './recent.js'
import { memoryRecordStamp, describeMemoryVector } from './store.js'

const ACTION_DESCRIPTION = [
  'turn_end：每次回复结束前记录本轮（important[] 重要原文、minor_summary 次要摘要、favorability 角色对当前说话人的好感度变化；多人对话可用 speaker 指定说话人）。favorability 里可带 spike:true，声明这一轮是真实的大幅情绪冲击、允许大幅下调。**每轮只调一次**，回执出现「已记录本轮对话」或「本轮已经记录过」就不要再调。若刚完成一次强制人格演化（好感度+羁绊累计变化满 50 点触发），带 evolutionDone:true + evolution_summary（总结这段对话）。',
  'save_important：保存重要原文（important[] 或 text），原文保持原样。',
  'emotion：更新情绪表（emotions: {"开心":70,"委屈":20}，只报变化的那几种，0=回落；**多种情绪可以同时存在**，不需要正负抵消），必须带 reason。它是本轮行为的最高优先级参考：语气、态度、主动性、亲近程度都要先服从它。turn_end 里也能带 emotions + emotionReason。',
  'emotion_type：AI 自己增删全局情绪种类（emotionTypes:[{label 1~6字, desc}]，emotionRemoveTypes:[名字]）；有对话在用的情绪（非 0 分）删不掉。',
  'set_favorability：修改【角色（你）对当前说话人】的好感度（value、reason 必填；可用 speaker 指定是谁）。好感度上限 ±100，给出超过 ±100 的值时超出部分自动计入羁绊值；要降好感度时会先扣羁绊值，羁绊不够才真正降好感度（回执会说明实际扣了什么）。每次好感度/羁绊的变化都会累加进「人格演化进度」：每满 50 点强制演化一次。若目标值跌幅离谱（超过单轮降幅上限的 3 倍）而本轮没有大情绪波动，会按「疑似误报」只小幅结算；真实的大幅波动请同轮更新情绪表，或带 spike:true。',
  'bond：增减【角色（你）对当前说话人】的羁绊值（delta 可正可负、无上限、reason 必填）—— 好感度到 ±100 封顶后，仍可用它记录更深的信任、默契和共同经历。羁绊变化同样累加进人格演化进度。',
  'speaker：多人/群聊里登记或切换说话人（name、aliases、note、reason；switchTo 切到已登记的人）。单人对聊不要调用。',
  'speaker_vector：更新某个说话人的多维评价（speaker 指定人，speakerVector: {"信任":80,"亲近":70}，0~100，只改传进来的维度；turn_end 里也可直接带 speakerVector）。',
  'speaker_dimension：自己新建/删除全局的说话人评价维度（dimensions: [{label 1~8字, desc 一句话, default 0~100}]，一次最多 2 个、总共最多 12 个；removeDimensions 删除，有说话人在用的维度会被拒绝）。',
  'edit_doc：修改侧边栏配置文档（key: personality 角色性格 / examples 预设发言例句 / rules 允许&禁止行为；fields 逐字段修改或 content 整篇改写；reason 必填）。fields 的每个值是一组「条目 + 权重」：可以用 [{text:"...", weight:90}] 数组，也可以直接写字符串（多条用「；」隔开，条目可带〔90〕权重标记）。每条权重 1~100（默认 50）：核心设定/底线 90~100、明显的偏好或雷区 70~89、普通描述 40~69、顺带一提 1~39；用户手动设过的权重尽量保留。只在这两种时候用：①人格演化满 50 点触发后，按对话总结做一次小步修改；②用户明确要求。不要每轮都改，改完自动归档。',
  'vector：给某条已有记忆重新打向量分（id + vector）——剧情后面变了性质时用，比如原本普通的约定后来变成雷区。id 见动态上下文/面板里的【mem_xxxxxxxx】。',
  'vector_dimension：自己新建一个全局的向量维度（所有对话通用，存共享文件；dimensions: [{label 1~8字, desc 一句话, default 0~100}]，一次最多 2 个、总共最多 12 个），之后所有记忆都能用 vector.custom 按这个维度打分；removeDimensions 删掉不用的维度——有记忆还在用这个维度时会被拒绝，得先用 vector 把那些记忆的分数清掉。',
  'search_recent：检索最近两个聊天日（聊天时间 48 小时）内的原始对话（query、可选 limit），问「刚才/最近」的事时优先用。',
  'read_recent：读取最近上下文里的完整原话（id，如 msg_xxxxxxxx）。',
  'search_kb：检索知识库归档（query），用于最近两个聊天日之外的旧事。',
  'read_archive：读取知识库归档原文（path，如 archive/2026-10-01.md）。',
  'archive_memory：把指定活跃记忆归档进知识库（ids）。',
  'summary48h：提交 48 小时（聊天时间）归纳（digest 必填、period_label、highlights[]、favorability_changes[]）。',
  'evolve：让角色在长期相处中自己慢慢演化（section: traits/likes/dislikes/habits；add[] 新增 {text, reason, weight}，weight 1~100 表示重要程度、默认 50；remove[] 删除 evo_xxxxxxxx；AI 新增必须带 reason）。只在这两种时候用：①人格演化满 50 点触发后；②用户明确要求。平时不要主动增删。',
].join('\n')

const importantItemSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '重点内容原文，必须一字不改。' },
    tags: { type: 'array', items: { type: 'string' }, description: '可选标签。' },
    weight: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: '活跃记忆权重 1~100（默认 50）：这条对角色有多重要。设定/底线/长期约定 90~100，重要事件 70~89，普通 40~69，琐事 1~39。越高越靠前、越优先进入上下文。',
    },
    vector: {
      type: 'object',
      description: '这条记忆的向量：由 AI 根据剧情自己打分，不填用默认值。分数只用于排序/取舍/语气，不改变原文。',
      properties: {
        valence: { type: 'integer', minimum: -100, maximum: 100, description: '情感倾向：负=难过/雷区/坏回忆，正=开心/喜欢/好回忆。' },
        importance: { type: 'integer', minimum: 0, maximum: 100, description: '重要程度：设定/底线/长期约定 90~100，重要事件 70~89，普通 40~69，琐事 0~39。' },
        intimacy: { type: 'integer', minimum: 0, maximum: 100, description: '亲密/私人程度：越私人越高。' },
        sensitivity: { type: 'integer', minimum: 0, maximum: 100, description: '敏感/踩雷风险：越高越要小心处理。' },
        persistence: { type: 'integer', minimum: 0, maximum: 100, description: '长期有效性：越高越不容易过期（约定/底线高，日常低）。' },
        category: { type: 'string', enum: ['偏好', '约定', '事件', '人物', '雷区', '日常', '其他'], description: '记忆类别。' },
        custom: {
          type: 'object',
          description: '自定义维度的分数：{"维度名": 0~100}。维度要先通过 vector_dimension 建好，否则不会展示。',
          additionalProperties: { type: 'integer', minimum: 0, maximum: 100 },
        },
        aspects: {
          type: 'array',
          maxItems: 3,
          description: 'AI 自定义的其他方面，例如 [{name:"饮食", score:80}]，名字不超过 12 字。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '方面名称，例如「饮食」「工作」「家人」。' },
              score: { type: 'integer', minimum: 0, maximum: 100, description: '这个方面的分数 0~100。' },
            },
            required: ['name', 'score'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    category: { type: 'string', enum: ['偏好', '约定', '事件', '人物', '雷区', '日常', '其他'], description: '可选：直接写类别（等价于 vector.category）。' },
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
      '「伴侣记忆」工具：记录本轮对话、保存重点原文、更新【角色对当前说话人】的好感度、登记/切换多人对话的说话人、检索最近 48 小时上下文、检索本地知识库、提交 48 小时归纳。',
      '近期的事用 search_recent/read_recent，超过 48 小时的旧事用 search_kb/read_archive。',
      ACTION_DESCRIPTION,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['turn_end', 'save_important', 'emotion', 'emotion_type', 'set_favorability', 'bond', 'speaker', 'speaker_vector', 'speaker_dimension', 'edit_doc', 'vector', 'vector_dimension', 'search_recent', 'read_recent', 'search_kb', 'read_archive', 'archive_memory', 'summary48h', 'evolve'],
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
          description: 'edit_doc 的逐字段内容，键取自对应文档的字段：personality(base/values/tone/thinking/likes/dislikes)、rules(allow/forbid/boundary)、examples(greeting/care/upset/catchphrase)。每个值是条目数组 [{text:"...", weight:90}]，或字符串（多条用「；」隔开、条目可带〔90〕标记）；weight 1~100，默认 50。',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: '条目内容（单条，不用带「；」）。' },
                    weight: { type: 'integer', minimum: 1, maximum: 100, description: '权重 1~100，默认 50，越大越重要。' },
                  },
                  required: ['text'],
                },
              },
            ],
          },
        },
        extra: { type: 'string', description: 'edit_doc 的「其他补充」内容。' },
        speaker: {
          type: 'string',
          description: '当前这条消息/这次记录对应的说话人名字（多人对话用；单人对聊可省略，默认就是当前说话人）。设置后会切换当前说话人。',
        },
        name: { type: 'string', description: 'speaker 动作：要登记/切换的人物名字。' },
        emotions: {
          type: 'object',
          description: '情绪表：{"情绪名": 0~100, ...}，只报变化的那几种；0=这种情绪回落。多种情绪可以同时存在（如 {"开心":70,"悲伤":30}）。emotion 动作 / turn_end 用。',
          additionalProperties: { type: 'integer', minimum: 0, maximum: 100 },
        },
        emotionReason: {
          type: 'string',
          description: '本轮情绪变化的原因（emotion 动作 / turn_end 用；emotion 动作必须带，turn_end 推荐带）。',
        },
        emotionTypes: {
          type: 'array',
          maxItems: 2,
          description: 'emotion_type 动作：要新建的情绪种类（全局，所有对话通用）。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '情绪名，1~6 个字，例如「嫉妒」「愧疚」。' },
              desc: { type: 'string', description: '一句话说明这种情绪是什么感觉。' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        emotionRemoveTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'emotion_type 动作：要删除的情绪名（有对话在用的删不掉）。',
        },
        speakerVector: {
          type: 'object',
          description: 'speaker_vector / turn_end 用：某个说话人的多维评价，{"维度名": 0~100 分数}；只改传进来的维度。可用维度见动态状态，或先 speaker_dimension 新建。',
          additionalProperties: { type: 'integer', minimum: 0, maximum: 100 },
        },
        speakerDimensions: {
          type: 'array',
          maxItems: 2,
          description: 'speaker_dimension 动作：要新建的说话人评价维度（全局，所有对话通用）。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '维度名，1~8 个字，例如「耐心」「幽默」。' },
              desc: { type: 'string', description: '一句话说明这个维度衡量什么。' },
              default: { type: 'integer', minimum: 0, maximum: 100, description: '默认分 0~100，默认 50。' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        speakerRemoveDimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'speaker_dimension 动作：要删除的说话人评价维度名（有说话人在用的会被拒绝）。',
        },
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
            value: { type: 'integer', description: '新的好感度绝对值（不是增量！-100~100；超过上限的部分自动计入羁绊值；下降时优先扣羁绊值，所以不要为了“+3”传 3）。' },
            reason: { type: 'string', description: '变动理由，必须具体。' },
            spike: { type: 'boolean', description: '声明这是真实的大幅情绪冲击：允许这一轮的好感度大幅下调（不受「误报防呆」限制）。正常剧情不用传。' },
          },
          required: ['value', 'reason'],
          additionalProperties: false,
        },
        value: { type: 'integer', description: '新的好感度绝对值（不是增量！-100~100；超过上限的部分自动计入羁绊值；下降时优先扣羁绊值，所以不要为了“+3”传 3）。' },
        bond: { type: 'integer', description: 'turn_end 用：本轮【角色（你）对当前说话人】的羁绊值增减（可正可负，无上限）。好感度已到 ±100 后，用它记录更深的关系累积，比单独调用 bond 更省。' },
        evolutionDone: { type: 'boolean', description: 'turn_end 用：强制人格演化（好感度+羁绊累计变化满 50 点）完成后带 true 确认；系统会核对本次触发后确实有 edit_doc 和 evolve 的改动，核对通过才清零并重新开始计。' },
        evolution_summary: { type: 'string', description: 'turn_end 用：这次人格演化的对话总结（一两句话），和 evolutionDone 一起提交，写进知识库归档。' },
        delta: { type: 'integer', description: 'bond 动作要增减的羁绊值（可正可负，无上限）。' },
        reason: { type: 'string', description: 'set_favorability / bond 的变动理由。' },
        spike: { type: 'boolean', description: 'set_favorability 用：声明真实的大幅情绪冲击，允许超过单轮降幅的大幅下调（不传则按剧情/情绪自动判断）。' },
        query: { type: 'string', description: 'search_recent / search_kb 的检索词。' },
        limit: { type: 'integer', description: 'search_recent / search_kb 返回条数，默认 6。' },
        id: { type: 'string', description: 'read_recent 的消息 id，例如 msg_xxxxxxxx。' },
        path: { type: 'string', description: 'read_archive 的相对路径，例如 archive/2026-10-01.md。' },
        ids: { type: 'array', items: { type: 'string' }, description: 'archive_memory 的记忆 id 列表。' },
        vector: { type: 'object', description: 'vector 动作：要给记忆重新打分的向量（字段同 important[].vector：valence/importance/intimacy/sensitivity/persistence/category/aspects/custom）。' },
        dimensions: {
          type: 'array',
          maxItems: 2,
          description: 'vector_dimension 动作：要新建的自定义维度，一次最多 2 个。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '维度名，1~8 个字，例如「饮食」「工作」「家人」。' },
              desc: { type: 'string', description: '一句话说明这个维度衡量什么，例如「对饮食的偏好和忌口」。' },
              default: { type: 'integer', minimum: 0, maximum: 100, description: '这个维度的默认分（0~100，默认 50）。' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        removeDimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'vector_dimension 动作：要删除的自定义维度名。',
        },
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
          description: 'evolve 要新增的条目，一次最多 3 条；每项 {text, reason, weight}，text 用 40 字以内短句。',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '新增的人格细节/喜好/讨厌/习惯，短句。' },
              reason: { type: 'string', description: '剧情理由：为什么角色会这样变化。' },
              weight: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: '权重 1~100（默认 50）：这条对角色有多重要/多强烈。底线级厌恶或核心偏好 90~100，明显偏好 70~89，普通 40~69，小事 1~39。只影响排序与取舍。',
              },
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
          if (result.duplicate) {
            // 同一轮重复调用：明确回“已记录”，避免模型为了补摘要再调一次（这会白白多烧一轮上下文）。
            const dup = ['本轮已经记录过，不用再调 turn_end。']
            if (result.important > 0) dup.push(`另外补存重点原文 ${result.important} 条。`)
            if (result.minor) dup.push('摘要已补写入知识库。')
            if (result.favorability?.changed) dup.push(`好感度 ${result.favorability.from} → ${result.favorability.value}。`)
            if (result.emotion) {
              const changes = Object.entries(result.emotion.changes).map(([key, value]) => `${key} ${value}`).join('、')
              dup.push(`情绪表已更新：${changes}。`)
            }
            return { ok: true, message: dup.join('') }
          }
          const parts = [`已记录本轮对话${result.speaker ? `（说话人：${result.speaker}）` : ''}。`]
          if (result.important > 0) parts.push(`新增重点原文 ${result.important} 条（已进全局活跃记忆）。`)
          if (result.minor) parts.push('次要摘要 1 条已写入知识库归档。')
          if (result.favorability?.changed) {
            const clampNote = result.favorability.stepClamped
              ? `（请求值 ${result.favorability.requested}、跌幅 ${result.favorability.from - result.favorability.requested} 超过单轮降幅上限 ${result.favorability.stepLimit}，已收窄到 ${result.favorability.clampedTo}）`
              : ''
            const guardNote = result.favorability.misreport
              ? `（⚠️ 目标值 ${result.favorability.requested} 跌幅 ${result.favorability.misreportRawDrop} 太离谱、本轮也没有大情绪波动，判为疑似误报，防呆只按 -${result.favorability.misreportDrop} 结算）`
              : ''
            parts.push(`好感度 ${result.favorability.from} → ${result.favorability.value}（${result.favorability.reason}）${clampNote}${guardNote}。`)
          } else if (result.favorability && !result.favorability.changed) {
            const absorbed = Number(result.favorability.absorbed) || 0
            const guardNote = result.favorability.misreport
              ? `；⚠️ 目标值 ${result.favorability.requested} 跌幅 ${result.favorability.misreportRawDrop} 太离谱、本轮没有大情绪波动，判为疑似误报，防呆只按 -${result.favorability.misreportDrop} 结算`
              : ''
            parts.push(absorbed > 0
              ? `好感度无变化（目标值 ${result.favorability.requested}，被羁绊抵消 ${absorbed}，羁绊 ${result.favorability.bondFrom} → ${result.favorability.bond}）${guardNote}。注意 value 是绝对值不是增量：想加深关系请传当前值或更高，别传比当前值小的数。`
              : `好感度无变化${Number.isFinite(Number(result.favorability.requested)) ? `（目标值 ${result.favorability.requested}）` : ''}${guardNote}。`)
          }
          const bondStep = result.favorability?.capPush || result.favorability?.overflow || 0
          if (result.favorability?.bondChanged && bondStep !== 0) {
            parts.push(`好感度已满，同向推动记入羁绊值 ${result.favorability.bondFrom} → ${result.favorability.bond}（${bondStep > 0 ? '+' : ''}${bondStep}）。`)
          }
          if (result.emotion) {
            const changes = Object.entries(result.emotion.changes).map(([key, value]) => `${key} ${value}`).join('、')
            parts.push(`情绪表：${changes}（${result.emotion.reason}）。`)
          }
          if (result.emotionError) parts.push(`情绪未更新（${result.emotionError}）。`)
          if (!result.emotion && !result.emotionError) {
            parts.push('⚠️ 本轮没有更新情绪表——情绪要实时跟着每句话变，下一轮请补上 emotions + emotionReason。')
          }
          if (result.bond) parts.push(`羁绊值 ${result.bond.bondFrom} → ${result.bond.bond}（${result.bond.reason}）。`)
          if (result.evolutionDone) {
            if (result.evolutionDone.consumed) {
              parts.push(`🧬 人格演化已完成（第 ${result.evolutionDone.count} 次），计数已清零、重新开始计。`)
            } else {
              const missing = Array.isArray(result.evolutionDone.missing) ? result.evolutionDone.missing : []
              parts.push(missing.length > 0
                ? `⚠️ 人格演化还没完成：${missing.join('；')}。补齐后再在 turn_end 里带 evolutionDone:true。`
                : `⚠️ 人格演化还没完成（${result.evolutionDone.reason ?? '还需要继续'}）。`)
            }
          }
          if (result.evolution && result.evolution.due > 0 && !(result.evolutionDone && result.evolutionDone.consumed)) {
            parts.push(`🧬 强制人格演化还挂着：好感度+羁绊累计变化已满 ${result.evolution.step} 点。请先总结最近这段对话，再 edit_doc 小改「角色性格/预设发言例句」+ evolve 更新自我演化条目，最后在 turn_end 带 evolutionDone:true + evolution_summary。`)
          }
          if (result.speakerVector) parts.push(`对「${result.speakerVector.speaker}」的多维评价已更新：${result.speakerVector.text}。`)
          if (result.speakerVectorError) parts.push(`多维评价未更新（${result.speakerVectorError}）。`)
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
            const memory = store.addMemory(text, item?.tags, { source: 'save_important', speakerId: speaker?.id, weight: item?.weight, vector: item?.vector, category: item?.category })
            if (memory) saved.push(memory)
            else skipped.push(text)
          }
          store.persist()
          const stamp = saved.length > 0 ? memoryRecordStamp(saved[0]) : ''
          const parts = [`已保存重点原文 ${saved.length} 条`]
          if (stamp !== '') parts.push(`（记录时间 ${stamp}）`)
          if (saved.length > 0) parts.push(`（向量：${describeMemoryVector(saved[0].vector, store.vectorDimensionsSnapshot())}）`)
          parts.push('。')
          if (skipped.length > 0) parts.push(`另有 ${skipped.length} 条与现有原文重复，未重复保存。`)
          return { ok: true, message: parts.join('') }
        }
        case 'set_favorability': {
          const result = store.setFavorability(args?.value, args?.reason, args?.speaker, { spike: args?.spike === true })
          const who = result.speaker ? `（对「${result.speaker}」）` : ''
          const parts = []
          if (result.absorbed) {
            parts.push(`先扣羁绊值 ${result.absorbed}（${result.bondFrom} → ${result.bond}），好感度只降了 ${result.from - result.value}`)
            parts.push('注意 value 是绝对值不是增量：想加深关系请传当前值或更高（如 100 / 103），别传比当前值小的数')
          } else if (result.bondChanged) {
            parts.push(`羁绊值 ${result.bondFrom} → ${result.bond}`)
          }
          if (result.overflow) {
            parts.push(`超出上限 ${result.overflow > 0 ? '+' : ''}${result.overflow} 计入羁绊值`)
          }
          const extra = parts.length > 0 ? `（${parts.join('；')}）` : ''
          const targetNote = Number.isFinite(Number(result.requested)) && Number(result.requested) !== Number(result.from)
            ? (result.misreport
              ? `目标值 ${result.requested} 跌幅 ${result.misreportRawDrop} 太离谱（本轮没有大情绪波动），疑似把「+N」误写成绝对值，防呆只按 -${result.misreportDrop} 结算；`
              : result.stepClamped
                ? `目标值 ${result.requested} 超过单轮降幅上限 ${result.stepLimit}，按 ${result.clampedTo} 结算；`
                : `目标值 ${result.requested}；`)
            : ''
          return {
            ok: true,
            message: result.changed
              ? `好感度${who} ${result.from} → ${result.value}，理由：${result.reason}。${targetNote}${extra}已归档。`
              : `好感度${who}保持 ${result.value}，没有变化。${targetNote}${extra}`,
          }
        }
        case 'bond': {
          const result = store.addBond(args?.speaker, args?.delta, args?.reason)
          const who = result.speaker ? `（对「${result.speaker}」）` : ''
          return {
            ok: true,
            message: `羁绊值${who} ${result.bondFrom} → ${result.bond}，理由：${result.reason}。已归档。`,
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
        case 'vector': {
          const memoryId = typeof args?.id === 'string' ? args.id.trim() : ''
          if (memoryId === '') throw new Error('vector 需要 id：要打分的那条记忆 id（mem_xxxxxxxx）')
          const result = store.setMemoryVector(memoryId, args?.vector)
          return {
            ok: true,
            message: `已更新「${result.id}」的向量：${result.vectorText}。`,
          }
        }
        case 'vector_dimension': {
          const additions = Array.isArray(args?.dimensions) ? args.dimensions.slice(0, 2) : []
          const removals = Array.isArray(args?.removeDimensions) ? args.removeDimensions : []
          if (additions.length === 0 && removals.length === 0) {
            const list = store.vectorDimensionsSnapshot()
            const usage = store.vectorDimensionUsage()
            return {
              ok: true,
              message: list.length === 0
                ? '目前没有自定义维度（内置维度：情感/重要/亲密/敏感/长期 + 类别）。'
                : `当前自定义维度 ${list.length} 个：${list.map((item) => `${item.label}（${item.desc || '无说明'}，默认 ${item.default}，${usage[item.label] ?? 0} 条记忆在用）`).join('、')}。`,
              details: list.map((item) => `- ${item.label}：${item.desc || '无说明'}（默认 ${item.default}，${usage[item.label] ?? 0} 条记忆在用）`).join('\n'),
            }
          }
          const added = []
          const removed = []
          const failures = []
          for (const input of additions) {
            try {
              added.push(store.addVectorDimension(input))
            } catch (error) {
              failures.push(String(error && error.message ? error.message : error))
            }
          }
          for (const ref of removals) {
            try {
              removed.push(store.removeVectorDimension(ref))
            } catch (error) {
              failures.push(String(error && error.message ? error.message : error))
            }
          }
          const parts = []
          if (added.length > 0) parts.push(`新建维度 ${added.length} 个：${added.map((item) => `${item.label}（默认 ${item.default}）`).join('、')}`)
          if (removed.length > 0) parts.push(`删除维度 ${removed.length} 个：${removed.map((item) => item.label).join('、')}`)
          if (failures.length > 0) parts.push(`跳过 ${failures.length} 个（${failures.join('；')}）`)
          const list = store.vectorDimensionsSnapshot()
          parts.push(`；当前共 ${list.length} 个自定义维度。`)
          return { ok: true, message: parts.join('') }
        }
        case 'emotion': {
          const payload = args?.emotions && typeof args.emotions === 'object' && !Array.isArray(args.emotions)
            ? args.emotions
            : null
          if (!payload || Object.keys(payload).length === 0) {
            const snapshot = store.emotionSnapshot()
            const table = snapshot.types.map((type) => `${type.label} ${type.value}`).join('｜')
            throw new Error(`emotion 需要 emotions:{"情绪名": 0~100, ...}。当前情绪表：${table}（可用情绪：${snapshot.types.map((type) => type.label).join('、')}）。`)
          }
          const result = store.setEmotions({ emotions: payload, reason: args?.emotionReason ?? args?.reason })
          const changes = Object.entries(result.changes).map(([key, value]) => `${key} ${value}`).join('、')
          return {
            ok: true,
            message: `情绪表已更新：${changes}（理由：${result.reason}）。接下来先按这些情绪决定语气和态度；多种情绪可以并存，不要互相抵消。`,
          }
        }
        case 'emotion_type': {
          const additions = Array.isArray(args?.emotionTypes) ? args.emotionTypes.slice(0, 2) : []
          const removals = Array.isArray(args?.emotionRemoveTypes) ? args.emotionRemoveTypes : []
          if (additions.length === 0 && removals.length === 0) {
            const list = store.emotionTypesSnapshot()
            const usage = store.emotionTypeUsage()
            return {
              ok: true,
              message: `当前情绪种类 ${list.length} 种：${list.map((item) => `${item.label}（${item.desc || '无说明'}，${usage[item.label] ?? 0} 个对话在用）`).join('、')}。`,
            }
          }
          const added = []
          const removed = []
          const failures = []
          for (const input of additions) {
            try { added.push(store.addEmotionType(input)) } catch (error) { failures.push(String(error && error.message ? error.message : error)) }
          }
          for (const ref of removals) {
            try { removed.push(store.removeEmotionType(ref)) } catch (error) { failures.push(String(error && error.message ? error.message : error)) }
          }
          const parts = []
          if (added.length > 0) parts.push(`新建情绪 ${added.length} 种：${added.map((item) => item.label).join('、')}`)
          if (removed.length > 0) parts.push(`删除情绪 ${removed.length} 种：${removed.map((item) => item.label).join('、')}`)
          if (failures.length > 0) parts.push(`跳过 ${failures.length} 个（${failures.join('；')}）`)
          parts.push(`；当前共 ${store.emotionTypesSnapshot().length} 种情绪。`)
          return { ok: true, message: parts.join('') }
        }
        case 'speaker_vector': {
          const values = args?.speakerVector && typeof args.speakerVector === 'object' && !Array.isArray(args.speakerVector)
            ? args.speakerVector
            : null
          if (!values || Object.keys(values).length === 0) throw new Error('speaker_vector 需要 speakerVector：{"维度名": 0~100 分数}')
          const result = store.setSpeakerVector(args?.speaker, values)
          return { ok: true, message: `已更新对「${result.speaker}」的多维评价：${result.text}。` }
        }
        case 'speaker_dimension': {
          const additions = Array.isArray(args?.speakerDimensions) ? args.speakerDimensions.slice(0, 2) : []
          const removals = Array.isArray(args?.speakerRemoveDimensions) ? args.speakerRemoveDimensions : []
          if (additions.length === 0 && removals.length === 0) {
            const list = store.speakerVectorDimensionsSnapshot()
            const usage = store.speakerVectorDimensionUsage()
            return {
              ok: true,
              message: `当前说话人评价维度 ${list.length} 个：${list.map((item) => `${item.label}（${item.desc || '无说明'}，默认 ${item.default}，${usage[item.label] ?? 0} 个说话人在用）`).join('、')}。`,
            }
          }
          const added = []
          const removed = []
          const failures = []
          for (const input of additions) {
            try { added.push(store.addSpeakerVectorDimension(input)) } catch (error) { failures.push(String(error && error.message ? error.message : error)) }
          }
          for (const ref of removals) {
            try { removed.push(store.removeSpeakerVectorDimension(ref)) } catch (error) { failures.push(String(error && error.message ? error.message : error)) }
          }
          const parts = []
          if (added.length > 0) parts.push(`新建维度 ${added.length} 个：${added.map((item) => `${item.label}（默认 ${item.default}）`).join('、')}`)
          if (removed.length > 0) parts.push(`删除维度 ${removed.length} 个：${removed.map((item) => item.label).join('、')}`)
          if (failures.length > 0) parts.push(`跳过 ${failures.length} 个（${failures.join('；')}）`)
          parts.push(`；当前共 ${store.speakerVectorDimensionsSnapshot().length} 个说话人评价维度。`)
          return { ok: true, message: parts.join('') }
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
          if (result.changed) {
            const trigger = store.evolutionTriggerSnapshot()
            parts.push(`人格演化计数已重新开始计${trigger.due > 0 ? '（强制演化还待确认）' : ''}。`)
          }
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
          const trigger = store.evolutionTriggerSnapshot()
          parts.push(`人格演化计数已重新开始计${trigger.due > 0 ? `（强制演化还待确认：完成 edit_doc 后 turn_end 带 evolutionDone:true）` : ''}。`)
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
