/**
 * dynamic-context.js — 每轮动态状态（走 DSH 的 runtime-context 通道）+ 历史 system 快照清理
 *
 * ── 为什么不能随便注入 ────────────────────────────────────────────────────────
 * deepseek-flash 路由声明了 `systemPromptUpdate: 'in-history'`：系统提示词一变，
 * DSH 会把**整份提示词**追加进历史（不替换）→ 越聊上下文越大、每次调用都更贵。
 * 所以伴侣记忆的 system prompt 只保留「逐轮不变」的内容（文档 / 规则 / 协议），
 * 所有会变的数值（当前说话人、好感度、活跃记忆、演化条目、周期）改由这里输出。
 *
 * ── 输出到哪儿 ───────────────────────────────────────────────────────────────
 * 用 `ctx.systemPrompt.context({...})` —— 这是宿主**专门为动态上下文**准备的通道：
 *   · 内容变化时由宿主合并进「runtime context」快照（界面上是一张上下文卡片，
 *     不会伪装成用户发言——之前自己发 user 消息会在聊天框里弹出大段气泡）；
 *   · 系统提示词本身保持不变，不会触发整份提示词追加；
 *   · 只在内容真的变了才更新，不抖。
 *
 * 另外保留一个一次性清理：老会话里已经堆积的多份 system 提示词快照，只留最新一份。
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDynamicContext } from './prompt.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 动态上下文在 context 通道里的 order（外部贡献允许任意有限值，给它排最后）。 */
const CONTEXT_ORDER = 90000

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
      appendFileSync(file, `${new Date().toISOString()} dynamic-context ${label} ${detail ?? ''}\n`, 'utf8')
    } catch {
      // 诊断日志永远不能影响主链
    }
  }
}

/** 取 system/message 事件里的文本（兼容几种字段形状）。 */
function systemTextOf(event) {
  const message = event?.data?.message
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block && block.type === 'text').map((block) => String(block.text ?? '')).join('\n')
}

/**
 * 一次性清理：把历史里堆积的多份 system prompt 快照只留最新一份，其余清空。
 * 只清「确实是整份提示词」的那种（长度 > 2000 字符），不碰别的 system 消息。
 */
function shrinkSystemSnapshots(session, log) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const snapshots = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'system/message') continue
    const text = systemTextOf(event)
    if (text.length < 2000) continue
    snapshots.push({ seq, event, chars: text.length })
  }
  if (snapshots.length <= 1) return { cleared: 0, kept: snapshots.length }
  const keep = snapshots[snapshots.length - 1]
  let clearedChars = 0
  for (const item of snapshots.slice(0, -1)) {
    if (item.seq === keep.seq) continue
    const data = item.event.data ?? {}
    const emptyMessage = {
      id: `sys_${Math.random().toString(16).slice(2, 10)}`,
      role: 'system',
      content: [],
      source: { kind: 'system-prompt' },
    }
    try {
      session.append(
        'system/message',
        { turn: Number.isFinite(data.turn) ? data.turn : 0, step: Number.isFinite(data.step) ? data.step : 1, message: emptyMessage },
        { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: [item.seq] },
      )
      clearedChars += item.chars
    } catch (error) {
      log('shrink-item-failed', String(error && error.message))
    }
  }
  return { cleared: clearedChars, kept: 1 }
}

/** 取 user/message 事件里的文本。 */
function userTextOf(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block && block.type === 'text').map((block) => String(block.text ?? '')).join('\n')
}

/**
 * 清掉旧版本留下的一次性动态状态消息（以前它是作为 user 消息注入的，会在聊天框里冒充用户发言）。
 * 现在动态状态走 runtime-context 通道，不再需要这些消息。
 */
function clearLegacyDynamicBlocks(session, log) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  let cleared = 0
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'user/message') continue
    const text = userTextOf(event)
    if (!text.trimStart().startsWith('【本轮动态状态')) continue
    const message = {
      id: `ctx_${Math.random().toString(16).slice(2, 10)}`,
      role: 'user',
      content: [],
      source: { kind: 'user' },
    }
    try {
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      cleared += 1
    } catch (error) {
      log('clear-legacy-failed', String(error && error.message))
    }
  }
  return cleared
}

/**
 * 注册每轮动态状态（runtime-context 通道）+ 历史快照清理。
 * @param {object} ctx     daemon 插件上下文（需已注入 systemPrompt）
 * @param {object} manager CompanionManager
 */
export function registerDynamicContext(ctx, manager) {
  if (typeof ctx.on !== 'function') return () => {}
  const log = createLogger(manager)
  const disposers = []

  // ① 动态状态：交给宿主的 runtime-context 通道（内容变化才更新，界面是上下文卡片）
  try {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      const dispose = systemPrompt.context({
        name: 'companion-memory:state',
        order: CONTEXT_ORDER,
        interpolate: false,
        text: (context) => {
          try {
            const agent = context && context.agent
            const sessionId = agent && agent.id ? String(agent.id) : ''
            if (sessionId === '' || !manager.isEnabled(sessionId)) return ''
            const store = manager.storeFor(sessionId)
            if (!store) return ''
            return buildDynamicContext(store)
          } catch (error) {
            log('context-text-failed', String(error && error.message))
            return ''
          }
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } else {
      log('no-context-api', 'systemPrompt.context 不可用，动态状态将不注入')
    }
  } catch (error) {
    log('context-register-failed', String(error && error.message))
  }

  // ② 老会话的 system 快照清理 —— ⚠️ 已停用（2026-10-30）：
  //    shrinkSystemSnapshots / clearLegacyDynamicBlocks 会在 turn/step 之外 append
  //    surface replace 事件。DSH 的持久化校验要求 system/message 必须落在打开的
  //    turn+step 里，这类事件会让整条会话在下次加载时报
  //    "system/message does not match an open turn and step"（session corrupt）。
  //    快照/旧气泡的清理改为手动修复好了的历史数据，不再在运行时改写 surface。
  log('legacy-surface-cleanup-disabled', 'skipped shrink/clear on session surface')

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
