// ops-agent 纯函数 + 假宿主端到端自测（不碰真实 DSH）
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url))
const { createOpsAgent, normalizeOps, parseJsonLoose, describeOps, DEFAULT_OPS, registerOpsAgent } = await import(pathToFileURL(join(LIB_DIR, 'ops-agent.js')).href)

let failed = 0
const check = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name)
  else { failed += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

console.log('── 1. normalizeOps')
const n1 = normalizeOps({ enabled: false, mode: 'split', window: 999, blocks: { emotion: { enabled: false }, control: { enabled: true } } })
check('enabled false 保留', n1.enabled === false)
check('mode split 保留', n1.mode === 'split')
check('window 夹到 40', n1.window === 40, n1.window)
check('emotion 关掉', n1.blocks.emotion.enabled === false)
check('control 打开', n1.blocks.control.enabled === true)
check('style 默认开', n1.blocks.style.enabled === DEFAULT_OPS.blocks.style.enabled)
check('model 归一', n1.model.provider === '' && n1.model.model === '')

console.log('── 2. parseJsonLoose')
const p1 = parseJsonLoose('```json\n{"emotion":{"changes":{"开心":70}}}\n```')
check('围栏 JSON', p1 && p1.emotion.changes.开心 === 70, p1)
const p2 = parseJsonLoose('好的，结果如下：{"style":{"lines":["先说半句"]}} 以上。')
check('前后废话', p2 && p2.style.lines[0] === '先说半句', p2)
const p3 = parseJsonLoose('{"a":"“引号”"}')
check('中文引号兜底', p3 && p3.a === '“引号”' || p3 !== null, p3)
const p4 = parseJsonLoose('not json at all')
check('垃圾返回 null', p4 === null)

console.log('── 3. describeOps')
const d = describeOps({})
check('默认三块开', d.activeBlocks.join(',') === 'emotion,style,memory', d.activeBlocks)
check('estimatedCalls=1（single）', d.estimatedCalls === 1, d.estimatedCalls)
const d2 = describeOps({ mode: 'split' })
check('split 时 = 2（语言习惯是提示层，不调用）', d2.estimatedCalls === 2, d2.estimatedCalls)
check('blocks 带 label', Array.isArray(d.blocks) && d.blocks[0].label === '情绪', d.blocks && d.blocks[0])

console.log('── 4. 假宿主：跑一轮，看四个块有没有写回')
const root = join(tmpdir(), 'ops-agent-test-' + Date.now())
const sessionDir = join(root, 'session-test')
mkdirSync(sessionDir, { recursive: true })
const calls = []
const written = { emotions: null, memories: [], control: null, styleFile: '' }
const llmText = JSON.stringify({
  emotion: { changes: { 开心: 72, 不存在的情绪: 90 }, reason: '测试' },
  style: { lines: ['先回半句再补细节', '习惯用省略号'], reason: '测试' },
  memory: { items: [{ text: '用户喜欢晚上聊', tags: ['偏好'], weight: 70 }] },
  control: { actions: [{ type: 'expression', payload: { name: '爱心眼' }, ttlMs: 12000 }, { type: '', payload: {} }] },
})
const store = {
  dir: sessionDir,
  state: { lastUserMessageAt: '2026-11-13T08:00:00.000Z' },
  recent: { entries: [{ role: 'user', text: '今天好累' }, { role: 'assistant', text: '抱抱你' }] },
  emotionTypesSnapshot: () => [{ key: 'happy', label: '开心' }, { key: 'sad', label: '难过' }],
  setEmotions: (input) => { written.emotions = input; return { changes: input.emotions, reason: input.reason } },
  addMemory: (text, tags, meta) => { written.memories.push({ text, tags, meta }); return { id: 'mem_test', text } },
}
const manager = {
  root,
  isEnabled: () => true,
  storeFor: () => store,
  currentSession: () => 'session-test',
  performance: { get: () => ({ preset: 'balanced', leanTools: false, agentTeam: false, ops: normalizeOps({ enabled: true, mode: 'single', blocks: { control: { enabled: true } } }) }) },
}
const ctx = {
  get(name) {
    if (name === 'llm') return { stream: async function* () { calls.push('llm'); yield { type: 'text-delta', text: llmText }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const agent = createOpsAgent(ctx, manager)
const result = await agent.run('session-test')
check('run ok', result.ok === true, result)
check('模型被调 1 次（single）', calls.length === 1, calls.length)
check('情绪写回只保留已知情绪', written.emotions && written.emotions.emotions && written.emotions.emotions.开心 === 72 && written.emotions.emotions['不存在的情绪'] === undefined, written.emotions)
check('记忆写回带子智能体标签', written.memories.length === 1 && written.memories[0].tags.includes('子智能体'), written.memories)
const state = agent.state('session-test')
check('语言习惯不再被单独调用（提示层，state 里也不写）', state.style.lines.length === 0, state.style)
check('动作队列只收合法 type', state.control.items.length === 1 && state.control.items[0].type === 'expression', state.control)
check('lastRun 有统计', state.lastRun && state.lastRun.applied.emotion === 1 && state.lastRun.applied.control === 1, state.lastRun)
const pending = agent.pending('session-test', 0)
check('pending 能取到动作', pending.items.length === 1 && pending.items[0].seq === 1, pending)
const ack = agent.ack('session-test', [pending.items[0].id])
check('ack 后待取为空', ack.acked === 1 && agent.pending('session-test', 0).items.length === 0, ack)
check('spec 有 controlTypes', Array.isArray(agent.spec().controlTypes) && agent.spec().controlTypes.length >= 3)
agent.dispose()

console.log('── 5. 分块调用模式：每块独立一次请求')
const calls2 = []
let replyIndex = 0
const replies = [
  JSON.stringify({ emotion: { changes: { 难过: 30 } } }),
  JSON.stringify({ style: { lines: ['说话短'] } }),
  JSON.stringify({ memory: { items: [{ text: '记住了' }] } }),
  JSON.stringify({ control: { actions: [{ type: 'motion', payload: { name: '举手' } }] } }),
]
const ctx2 = {
  get(name) {
    if (name === 'llm') return { stream: async function* () { calls2.push(name); yield { type: 'text-delta', text: replies[Math.min(replyIndex++, replies.length - 1)] }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const manager2 = { ...manager, performance: { get: () => ({ ops: normalizeOps({ enabled: true, mode: 'split', blocks: { control: { enabled: true } } }) }) } }
const agent2 = createOpsAgent(ctx2, manager2)
const result2 = await agent2.run('session-test')
check('split 调 3 次（语言习惯是提示层，不调用）', calls2.length === 3, calls2.length)
check('split run ok', result2.ok === true, result2)
agent2.dispose()

console.log('── 5.5 团队模式：真的开子智能体（假 subagents 服务）')
const teamOps = normalizeOps({ enabled: true, mode: 'split', team: true, blocks: { control: { enabled: true } } })
const starts = []
const teamStore = { ...store, dir: join(root, 'session-team') }
mkdirSync(teamStore.dir, { recursive: true })
const teamReplies = [
  JSON.stringify({ emotion: { changes: { 开心: 55 } } }),
  JSON.stringify({ memory: { items: [{ text: '团队模式记一条', tags: ['事件'] }] } }),
  JSON.stringify({ control: { actions: [{ type: 'expression', payload: { name: '爱心眼' } }] } }),
]
let teamIndex = 0
const ctxTeam = {
  get(name) {
    if (name === 'subagents') return {
      getProvider: (provider) => ({ name: provider }),
      startActivation: async (spec) => {
        starts.push(spec)
        const text = teamReplies[Math.min(teamIndex++, teamReplies.length - 1)]
        return { childId: 'child-' + starts.length, name: 'child-' + starts.length, result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }) }
      },
    }
    if (name === 'agents') return { get: (id) => ({ id }) }
    if (name === 'llm') throw new Error('团队模式不该走内部 llm 请求')
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const teamManager = { ...manager, storeFor: () => teamStore, performance: { get: () => ({ ops: teamOps }) } }
const teamAgent = createOpsAgent(ctxTeam, teamManager)
check('normalizeOps 保留 team/teamProvider', teamOps.team === true && teamOps.teamProvider === 'spawn', [teamOps.team, teamOps.teamProvider])
const teamResult = await teamAgent.run('session-test')
check('团队模式开了 3 个子智能体', starts.length === 3, starts.length)
check('子智能体 label 带块名', starts[0] && starts[0].label === '大肥鱼·情绪', starts[0] && starts[0].label)
check('子智能体走 spawn、挂在当前对话下', starts[0] && starts[0].provider === 'spawn' && starts[0].parent && starts[0].parent.id === 'session-test', starts[0] && { provider: starts[0].provider, parent: starts[0].parent })
check('团队模式 run ok、lastRun.team', teamResult.ok === true && teamResult.team === true, teamResult)
check('团队模式结果写回记忆', teamAgent.state('session-test').lastRun.applied.memory === 1 && teamAgent.state('session-test').lastRun.applied.emotion === 1, teamAgent.state('session-test').lastRun)
teamAgent.dispose()

// 团队模式但宿主没有 subagents（老版本/未启用）：自动退回内部请求，不炸
const fallbackCalls = []
const ctxNoTeam = {
  get(name) {
    if (name === 'llm') return { stream: async function* () { fallbackCalls.push(name); yield { type: 'text-delta', text: JSON.stringify({ emotion: { changes: { 开心: 40 } } }) }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const fallbackManager = { ...manager, performance: { get: () => ({ ops: normalizeOps({ enabled: true, mode: 'single', team: true }) }) } }
const fallbackAgent = createOpsAgent(ctxNoTeam, fallbackManager)
const fallbackResult = await fallbackAgent.run('session-test')
check('没有 subagents 服务时退回内部请求', fallbackCalls.length === 1 && fallbackResult.ok === true, { calls: fallbackCalls.length, ok: fallbackResult.ok })
fallbackAgent.dispose()

console.log('── 6. performance.js：ops 默认值与补丁合并')
const perfMod = await import(pathToFileURL(join(LIB_DIR, 'performance.js')).href)
const perfRoot = join(tmpdir(), 'perf-test-' + Date.now())
mkdirSync(perfRoot, { recursive: true })
const perf = perfMod.createPerformance(perfRoot)
const before = perf.get('sess-a')
check('默认 ops.enabled', before.ops && before.ops.enabled === true)
check('面板描述带 blocks', Array.isArray(before.ops.blocks) && before.ops.blocks.length === 4)
const after = perf.update('sess-a', { ops: { blocks: { emotion: { enabled: false } } } })
check('只改 emotion 不影响其它块', after.ops.blocks.find((b) => b.key === 'emotion').enabled === false && after.ops.blocks.find((b) => b.key === 'style').enabled === true, after.ops.blocks.map((b) => b.key + ':' + b.enabled))
check('预设不被 ops 改动影响', after.preset === before.preset, after.preset)
const after2 = perf.update('sess-a', { ops: { mode: 'split' } })
check('mode 改成功', after2.ops.mode === 'split')
const after3 = perf.update('sess-a', { preset: 'beast' })
check('切预设后 ops 保留', after3.preset === 'beast' && after3.ops.mode === 'split' && after3.ops.blocks.find((b) => b.key === 'emotion').enabled === false, after3.preset)
check('工具表开关仍按预设', after3.leanTools === false && after3.agentTeam === true)

console.log('── 7. 情绪波动档位 / 瞬间突变 / 惯性回落')
const opsMod = await import(pathToFileURL(join(LIB_DIR, 'ops-agent.js')).href)
const tn = opsMod.normalizeOps({ emotionTuning: { volatility: 'volatile', decayPerTurn: 20 } })
check('volatility 保留', tn.emotionTuning.volatility === 'volatile')
check('decayPerTurn 可覆盖', tn.emotionTuning.decayPerTurn === 20)
const stable = opsMod.emotionTuningOf({ emotionTuning: { volatility: 'stable' } })
check('stable 不允许突变、上限 25', stable.allowSpike === false && stable.maxJump === 25, stable)
const normal = opsMod.emotionTuningOf({ emotionTuning: { volatility: 'normal' } })
check('normal 允许突变、上限 85、回落 12', normal.allowSpike === true && normal.maxJump === 85 && normal.decayPerTurn === 12, normal)
const volatilePreset = opsMod.emotionTuningOf({ emotionTuning: { volatility: 'volatile' } })
check('一点就炸回落慢（10）', volatilePreset.decayPerTurn === 10, volatilePreset)

// 假宿主：volatile 档，先瞬间跳到愤怒 80，再模拟主模型“一秒冷静”，看惯性把下限抬回来
const emo = { 开心: 0, 愤怒: 0 }
const emoDir = join(root, 'session-emo')
mkdirSync(emoDir, { recursive: true })
const emoStore = {
  dir: emoDir,
  state: { lastUserMessageAt: '2026-11-13T09:00:00.000Z' },
  recent: { entries: [{ role: 'user', text: '你是不是傻' }, { role: 'assistant', text: '……' }] },
  emotionTypesSnapshot: () => [{ key: 'happy', label: '开心' }, { key: 'angry', label: '愤怒' }],
  emotionSnapshot: () => ({ types: [{ label: '开心', value: emo.开心 }, { label: '愤怒', value: emo.愤怒 }], reason: '' }),
  setEmotions: (input) => { for (const [key, value] of Object.entries(input.emotions)) emo[key] = value; return { changes: input.emotions, reason: input.reason } },
  addMemory: () => null,
}
const emoManager = {
  root,
  isEnabled: () => true,
  storeFor: () => emoStore,
  currentSession: () => 'session-emo',
  performance: { get: () => ({ ops: opsMod.normalizeOps({ enabled: true, mode: 'single', blocks: { style: { enabled: false }, memory: { enabled: false }, control: { enabled: false } }, emotionTuning: { volatility: 'volatile' } }) }) },
}
let emoReply = JSON.stringify({ emotion: { changes: { 愤怒: 80 }, reason: '他骂我', spike: true, trigger: '被冒犯' } })
const emoCtx = {
  get(name) {
    if (name === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: emoReply }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const emoAgent = opsMod.createOpsAgent(emoCtx, emoManager)
const run1 = await emoAgent.run('session-emo')
check('情绪瞬间跳到 80', emo.愤怒 === 80, emo)
check('记录为情绪突变', run1.spike === true, run1)
const st1 = emoAgent.state('session-emo')
check('惯性条目 1 条', st1.emotion.spikes.length === 1 && st1.emotion.spikes[0].label === '愤怒', st1.emotion)
emo.愤怒 = 5 // 模拟主模型下一轮 turn_end 想“一秒冷静”
emoReply = '{}' // 这一轮子智能体没给情绪变化
const run2 = await emoAgent.run('session-emo')
check('惯性把下限抬回 70（80 - 每轮 10）', emo.愤怒 === 70, { now: emo.愤怒, run2 })
const st2 = emoAgent.state('session-emo')
check('回落一轮后 floor=70', st2.emotion.spikes[0] && st2.emotion.spikes[0].floor === 70, st2.emotion.spikes)
check('runIndex 累加到 2', st2.emotion.runIndex === 2, st2.emotion.runIndex)
emoAgent.dispose()

console.log('── 8. 跨对话共享：换个对话来聊，情绪还在')
const sharedDefault = opsMod.normalizeOps({})
check('sharedMood 默认开', sharedDefault.sharedMood === true, sharedDefault.sharedMood)
const offShared = opsMod.normalizeOps({ sharedMood: false })
check('sharedMood 可关', offShared.sharedMood === false)
// 第 7 节那次「愤怒 80」应该已经写进整体情绪文件
const globalRaw = JSON.parse(readFileSync(join(root, 'ops-global.json'), 'utf8'))
check('整体情绪文件有愤怒', globalRaw.spikes.some((s) => s.label === '愤怒' && s.value === 80), globalRaw.spikes)
// 另开一个「别的对话」：本地情绪是 0，但被惹到的人换了个对话，仍应被抬到整体情绪下限
const otherEmo = { 愤怒: 0 }
const otherDir = join(root, 'session-other')
mkdirSync(otherDir, { recursive: true })
const otherStore = {
  dir: otherDir,
  state: { lastUserMessageAt: '2026-11-13T09:20:00.000Z' },
  recent: { entries: [{ role: 'user', text: '你好呀' }, { role: 'assistant', text: '……' }] },
  emotionTypesSnapshot: () => [{ key: 'angry', label: '愤怒' }, { key: 'happy', label: '开心' }],
  emotionSnapshot: () => ({ types: [{ label: '愤怒', value: otherEmo.愤怒 }, { label: '开心', value: 0 }], reason: '' }),
  setEmotions: (input) => { for (const [key, value] of Object.entries(input.emotions)) otherEmo[key] = value; return { changes: input.emotions, reason: input.reason } },
  addMemory: () => null,
}
const otherManager = {
  root,
  isEnabled: () => true,
  storeFor: () => otherStore,
  currentSession: () => 'session-other',
  performance: { get: () => ({ ops: opsMod.normalizeOps({ enabled: true, mode: 'single', blocks: { style: { enabled: false }, memory: { enabled: false }, control: { enabled: false } }, emotionTuning: { volatility: 'volatile' } }) }) },
}
const otherCtx = {
  get(name) {
    if (name === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
}
const otherAgent = opsMod.createOpsAgent(otherCtx, otherManager)
await otherAgent.run('session-other')
check('别的对话里情绪也被抬起来（>0）', otherEmo.愤怒 > 0, otherEmo)
const moodNow = otherAgent.mood()
check('mood() 能读到跨对话情绪', Array.isArray(moodNow.spikes) && moodNow.spikes.length >= 1, moodNow)
const directive = otherAgent.moodDirective('session-other')
check('moodDirective 带跨对话说明', typeof directive === 'string' && directive.includes('整体情绪') && directive.includes('跨对话共享'), directive)
otherAgent.dispose()

console.log('── 9. 互喂分块（staged）：先并行出初稿，再带着黑板互相定稿')
const stagedNorm = normalizeOps({ mode: 'staged' })
check('mode staged 保留', stagedNorm.mode === 'staged', stagedNorm.mode)
check('staged 默认 refine = emotion,memory', stagedNorm.staged.refine.join(',') === 'emotion,memory', stagedNorm.staged)
check('staged rounds 默认 2', stagedNorm.staged.rounds === 2)
check('rounds 夹到 2~4', normalizeOps({ staged: { rounds: 9 } }).staged.rounds === 4 && normalizeOps({ staged: { rounds: 0 } }).staged.rounds === 2)
const stagedDesc = describeOps({ mode: 'staged', blocks: { control: { enabled: false } } })
check('语言习惯块标了 hintOnly', stagedDesc.blocks.find((b) => b.key === 'style').hintOnly === true)
check('callBlocks 里没有语言习惯', stagedDesc.callBlocks.join(',') === 'emotion,memory', stagedDesc.callBlocks)
check('staged 估算调用 = 2 块 + 2 互喂 = 4', stagedDesc.estimatedCalls === 4, stagedDesc.estimatedCalls)
check('describeOps 带 stagedPlan', stagedDesc.stagedPlan && stagedDesc.stagedPlan.refine.join(',') === 'emotion,memory', stagedDesc.stagedPlan)
const plan4 = opsMod.stagedPlan({ mode: 'staged' }, ['emotion', 'style', 'memory', 'control'])
check('stagedPlan 只挑活跃块里的互喂块，提示层不占调用', plan4.refine.join(',') === 'emotion,memory' && plan4.calls === 5, plan4)

const promptOf = (request) => request.messages
  .map((message) => (Array.isArray(message.content) ? message.content.map((part) => part.text || '').join('') : ''))
  .join('\n')
const makeStageReply = (request) => {
  const prompt = promptOf(request)
  const later = prompt.includes('第 2 轮') || prompt.includes('第 3 轮')
  if (prompt.includes('- emotion（情绪')) return JSON.stringify({ emotion: { changes: { 难过: later ? 66 : 40 }, reason: later ? '记忆挑出的那句原话太扎心' : '初稿' } })
  if (prompt.includes('- memory（记忆）')) return JSON.stringify({ memory: { items: [{ text: later ? '他说过「不会再来了」' : '初稿记忆', tags: ['事件'] }] } })
  return JSON.stringify({ style: { lines: ['说话短'] } })
}
const makeStagedHost = (bucket) => ({
  get(name) {
    if (name === 'llm') {
      return {
        stream: async function* (request) {
          bucket.push(request)
          yield { type: 'text-delta', text: makeStageReply(request) }
          yield { type: 'finish', reason: { kind: 'ok' } }
        },
      }
    }
    if (name === 'systemPrompt') return { context: () => () => {} }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  on() { return () => {} },
})
const stagedDir = join(root, 'session-staged')
mkdirSync(stagedDir, { recursive: true })
const stagedWritten = { emotions: null, memories: [] }
const stagedStore = {
  dir: stagedDir,
  state: { lastUserMessageAt: '2026-11-14T09:00:00.000Z' },
  recent: { entries: [{ role: 'user', text: '你昨天说的话还算数吗' }, { role: 'assistant', text: '……' }] },
  emotionTypesSnapshot: () => [{ key: 'sad', label: '难过' }, { key: 'happy', label: '开心' }],
  setEmotions: (input) => { stagedWritten.emotions = input; return { changes: input.emotions, reason: input.reason } },
  addMemory: (text, tags, meta) => { stagedWritten.memories.push({ text, tags, meta }); return { id: 'mem_staged', text } },
}
const stagedManager = {
  root,
  isEnabled: () => true,
  storeFor: () => stagedStore,
  currentSession: () => 'session-staged',
  performance: { get: () => ({ ops: normalizeOps({ enabled: true, mode: 'staged', blocks: { control: { enabled: false } } }) }) },
}
const stageReq = []
const stagedAgent = opsMod.createOpsAgent(makeStagedHost(stageReq), stagedManager)
const stagedRun = await stagedAgent.run('session-staged')
const round1 = stageReq.filter((request) => !promptOf(request).includes('第 2 轮'))
const round2 = stageReq.filter((request) => promptOf(request).includes('第 2 轮'))
check('一共 4 次调用（2 并行 + 2 互喂；语言习惯不调用）', stageReq.length === 4, stageReq.length)
check('第 1 轮只有情绪和记忆各一次', round1.length === 2 && !round1.some((request) => promptOf(request).includes('- style（语言习惯')), round1.length)
check('第 2 轮只有情绪和记忆', round2.length === 2 && !round2.some((request) => promptOf(request).includes('- style（语言习惯')), round2.length)
const emoPrompt2 = promptOf(round2.filter((request) => promptOf(request).includes('- emotion（情绪'))[0] || { messages: [] })
const memPrompt2 = promptOf(round2.filter((request) => promptOf(request).includes('- memory（记忆'))[0] || { messages: [] })
check('情绪第 2 轮看得到记忆的初稿', emoPrompt2.includes('初稿记忆') && emoPrompt2.includes('【黑板】'), emoPrompt2.slice(0, 200))
check('记忆第 2 轮看得到情绪的初稿', memPrompt2.includes('难过') && memPrompt2.includes('【黑板】'), memPrompt2.slice(0, 200))
check('语言习惯不进黑板（辅助层不主导）', !emoPrompt2.includes('说话短') && !memPrompt2.includes('说话短'))
check('情绪按记忆定稿（40 -> 66）', stagedWritten.emotions && stagedWritten.emotions.emotions['难过'] === 66, stagedWritten.emotions)
check('记忆被情绪影响后定稿', stagedWritten.memories.length === 1 && stagedWritten.memories[0].text.includes('不会再来了'), stagedWritten.memories)
check('lastRun 记了 staged + 调用次数', stagedRun.mode === 'staged' && stagedRun.calls === 4 && stagedRun.staged && stagedRun.staged.refine.join(',') === 'emotion,memory', stagedRun)
stagedAgent.dispose()

// 第 3 轮：情绪会看到记忆在第 2 轮改过的那版，迭代两次
const stageReq3 = []
const staged3Agent = opsMod.createOpsAgent(makeStagedHost(stageReq3), {
  ...stagedManager,
  storeFor: () => ({ ...stagedStore, dir: join(stagedDir, 'round3'), setEmotions: () => ({ changes: {} }), addMemory: () => null, emotionSnapshot: () => ({ types: [], reason: '' }) }),
  performance: { get: () => ({ ops: normalizeOps({ enabled: true, mode: 'staged', staged: { rounds: 3 }, blocks: { control: { enabled: false }, style: { enabled: false } } }) }) },
})
mkdirSync(join(stagedDir, 'round3'), { recursive: true })
const staged3Run = await staged3Agent.run('session-staged')
check('rounds=3 时调用 2 块 + 2 轮互喂 = 6', stageReq3.length === 6, stageReq3.length)
check('最后一轮是第 3 轮', promptOf(stageReq3[stageReq3.length - 1]).includes('第 3 轮'), promptOf(stageReq3[stageReq3.length - 1]).slice(0, 120))
check('第 3 轮看得到第 2 轮的定稿', promptOf(stageReq3[stageReq3.length - 1]).includes('66'), promptOf(stageReq3[stageReq3.length - 1]).slice(0, 300))
check('rounds=3 的 lastRun.calls', staged3Run.calls === 6, staged3Run.calls)
staged3Agent.dispose()

rmSync(root, { recursive: true, force: true })
rmSync(perfRoot, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
