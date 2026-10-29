/**
 * lean-tools.js — 给「伴侣记忆已开启」的对话瘦身工具表
 *
 * 每轮请求都带完整工具定义。默认 profile 有 74 个工具、约 6.7 万字符（≈1.7 万 token），
 * 而陪伴聊天实际用不到电脑操控 / 团队 / 计划任务 / 写代码这些。
 * 这里按会话把「陪伴用不到的重工具」deny 掉，其余保持可见（可逆、只影响该会话）。
 *
 * 用的是宿主 `ctx.tools.restrict({ deny })`：只过滤继承来的全局工具，不动别的插件注册在
 * 本会话作用域里的工具；返回 disposer，撤掉就恢复。
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const DENY_NAMES = [
  // 电脑操控 MCP（约 2.3 万字符）
  'mcp__wincu__windows_computer_use_accessibility_tree',
  'mcp__wincu__windows_computer_use_activate_window',
  'mcp__wincu__windows_computer_use_click',
  'mcp__wincu__windows_computer_use_close_window',
  'mcp__wincu__windows_computer_use_double_click',
  'mcp__wincu__windows_computer_use_drag',
  'mcp__wincu__windows_computer_use_element_info',
  'mcp__wincu__windows_computer_use_find',
  'mcp__wincu__windows_computer_use_focus',
  'mcp__wincu__windows_computer_use_health',
  'mcp__wincu__windows_computer_use_invoke',
  'mcp__wincu__windows_computer_use_keypress',
  'mcp__wincu__windows_computer_use_launch_app',
  'mcp__wincu__windows_computer_use_list_windows',
  'mcp__wincu__windows_computer_use_move',
  'mcp__wincu__windows_computer_use_move_window',
  'mcp__wincu__windows_computer_use_ocr',
  'mcp__wincu__windows_computer_use_screenshot',
  'mcp__wincu__windows_computer_use_scroll',
  'mcp__wincu__windows_computer_use_set_value',
  'mcp__wincu__windows_computer_use_snapshot',
  'mcp__wincu__windows_computer_use_tools',
  'mcp__wincu__windows_computer_use_type_text',
  'mcp__wincu__windows_computer_use_wait',
  'mcp__wincu__windows_computer_use_wait_for',
  // 写代码 / 跑命令（陪伴聊天不需要，避免她真去改机器）
  'pwsh',
  'edit',
  'write',
  'read',
  'glob',
  'grep',
  // 团队 / 子智能体 / 工作流
  'spawn_teammate',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'workflow',
  'subagent',
  'subagent_fork',
  'list_subagent_models',
  // 计划任务 / 后台任务 / 目标
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_list',
  'job_kill',
  'job_list',
  'job_output',
  'create_goal',
  'get_goal',
  'update_goal',
  // 插件 / 界面 / 杂项
  'plugin_manager',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'present',
  'load_workspace_dependencies',
  'working_directory',
  'create_skill',
  'exit_plan_mode',
  'todo_write',
]

function toolsOf(agentCtx) {
  try {
    if (agentCtx && agentCtx.tools) return agentCtx.tools
  } catch {
    // ignore
  }
  try {
    const tools = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined
    if (tools) return tools
  } catch {
    // ignore
  }
  return undefined
}

/**
 * 注册工具瘦身。只对「伴侣记忆已开启」的会话生效；关闭对话 = 自动解除限制。
 * @param {object} ctx
 * @param {object} manager
 */
export function registerLeanTools(ctx, manager) {
  if (typeof ctx.on !== 'function' || typeof manager?.isEnabled !== 'function') return () => {}
  const state = new WeakMap()
  const log = (label, detail) => {
    try {
      const file = join(manager.root, 'debug-events.log')
      appendFileSync(file, `${new Date().toISOString()} lean-tools ${label} ${detail ?? ''}\n`, 'utf8')
    } catch {
      // ignore
    }
  }

  const lift = (entry) => {
    if (entry && typeof entry.dispose === 'function') {
      try {
        entry.dispose()
      } catch {
        // ignore
      }
    }
  }

  const apply = (agent) => {
    try {
      const agentCtx = agent && agent.ctx
      if (!agentCtx) return
      const sessionId = agent && agent.id ? String(agent.id) : ''
      const wanted = sessionId !== '' && manager.isEnabled(sessionId)
      const prev = state.get(agentCtx)
      // 已经挂上（或已确认失败过 3 次）就不再动，避免每步抖工具表
      if (prev && prev.wanted === wanted && (wanted ? prev.dispose !== null || prev.attempts >= 3 : true)) return
      lift(prev)
      if (!wanted) {
        state.set(agentCtx, { wanted, dispose: null, attempts: 0 })
        return
      }
      const tools = toolsOf(agentCtx)
      const restrict = tools && tools.restrict
      if (typeof restrict !== 'function') {
        state.set(agentCtx, { wanted, dispose: null, attempts: 3 })
        log('no-restrict', `session=${sessionId.slice(0, 12)} tools=${typeof tools}`)
        return
      }
      let dispose = null
      let denied = []
      const tryRestrict = (names) => {
        const result = restrict.call(tools, { deny: names })
        denied = names
        if (typeof result === 'function') return result
        if (result && typeof result.dispose === 'function') return () => result.dispose()
        return null
      }
      try {
        dispose = tryRestrict(DENY_NAMES)
      } catch (error) {
        // 宿主的 restrict 只接受「真实存在的全局工具名」。某些工具（团队 / 子智能体 / 插件管理）
        // 是各 agent 作用域里自己注册的，不在全局表里 —— 从报错里把真实全局名单读出来再重试。
        const message = error instanceof Error ? error.message : String(error)
        const match = /known global tools:\s*([\s\S]+)$/.exec(message)
        if (!match) {
          const attempts = (prev && prev.attempts ? prev.attempts : 0) + 1
          state.set(agentCtx, { wanted, dispose: null, attempts })
          log('restrict-failed', `session=${sessionId.slice(0, 12)} attempt=${attempts} ${message}`)
          return
        }
        const known = new Set(match[1].split(',').map((name) => name.trim().replace(/^"|"$/g, '')))
        const filtered = DENY_NAMES.filter((name) => known.has(name))
        if (filtered.length === 0) {
          state.set(agentCtx, { wanted, dispose: null, attempts: 3 })
          log('restrict-skip', `session=${sessionId.slice(0, 12)} 没有可剪的全局工具`)
          return
        }
        try {
          dispose = tryRestrict(filtered)
        } catch (retryError) {
          const attempts = (prev && prev.attempts ? prev.attempts : 0) + 1
          state.set(agentCtx, { wanted, dispose: null, attempts })
          log('restrict-failed', `session=${sessionId.slice(0, 12)} attempt=${attempts} ${retryError instanceof Error ? retryError.message : String(retryError)}`)
          return
        }
      }
      state.set(agentCtx, { wanted, dispose, attempts: 0 })
      if (dispose) log('restricted', `session=${sessionId.slice(0, 12)} deny=${denied.length}/${DENY_NAMES.length}`)
    } catch {
      // 工具瘦身失败绝不能影响对话
    }
  }

  const disposers = []
  const onCreated = (payload) => {
    apply(payload && payload.agent)
  }
  disposers.push(ctx.on('agent/created', onCreated))
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    apply(payload && payload.agent)
    return next()
  }))

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

export { DENY_NAMES }
