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
check('split 时 = 3', d2.estimatedCalls === 3, d2.estimatedCalls)
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
check('语言习惯落盘 2 条', state.style.lines.length === 2, state.style)
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
check('split 调 4 次', calls2.length === 4, calls2.length)
check('split run ok', result2.ok === true, result2)
agent2.dispose()

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

rmSync(root, { recursive: true, force: true })
rmSync(perfRoot, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
