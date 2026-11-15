/**
 * Host half of the companion-memory bundle.
 *
 * One plugin instance serves every conversation, but each conversation keeps a
 * fully isolated data set in `sessions/<id>/`. Conversations are off by default
 * and are enabled individually from the sidebar panel.
 *
 * Registers:
 *   - per-conversation system-prompt sections (only for enabled conversations),
 *   - the `companion_memory` tool plus a guard that rejects disabled conversations,
 *   - activity tracking (current conversation, interaction days, 48h window),
 *   - conversation context compression (companion-style memory blocks),
 *   - the `/companion/api/*` routes used by the sidebar panel.
 *
 * The Client module (`client.js`) owns all rendering.
 */
import { createManager } from './lib/manager.js'
import { createOneBotSetup } from './lib/onebot-setup.js'
import { installAgentPrompt } from './lib/prompt.js'
import { registerTool } from './lib/tool.js'
import { registerTracking } from './lib/tracking.js'
import { registerContextCompression } from './lib/context-compress.js'
import { registerHierarchy } from './lib/hierarchy.js'
import { registerDynamicContext } from './lib/dynamic-context.js'
import { registerLeanTools } from './lib/lean-tools.js'
import { installBridgeEndpoint, registerWebApi } from './lib/api.js'
import { createPerformance } from './lib/performance.js'
// 每轮子智能体（操控中心）：每轮结束都分析一次，按分配写回 情绪 / 语言习惯 / 记忆，
// 并产出「操控动作」进 /companion/ops 的动作总线（留给桌宠皮套等外部消费者）。
import { registerOpsAgent } from './lib/ops-agent.js'

// `webServer` must be a hard dependency: the panel's `/companion/api/*` routes
// are registered exactly once in `apply`, so a plugin instance that starts
// before the web server is provided would silently lose its HTTP surface.
export const inject = ['systemPrompt', 'tools', 'webServer']

export function apply(ctx, config) {
  const manager = createManager(ctx, config ?? {})
  // 每个对话各自的「性能模式」设置：工具表精简 / 团队协作 / 睡眠预计算，面板里随时可改
  try {
    manager.performance = createPerformance(manager.root || '')
  } catch {
    manager.performance = null
  }

  ctx.effect(() => installAgentPrompt(ctx, manager), 'companion-memory: per-conversation prompt sections')
  ctx.effect(() => registerTool(ctx, manager), 'companion-memory: companion_memory tool')
  ctx.effect(() => registerTracking(ctx, manager), 'companion-memory: conversation tracking')
  ctx.effect(() => registerDynamicContext(ctx, manager), 'companion-memory: per-turn dynamic context')
  ctx.effect(() => registerOpsAgent(ctx, manager), 'companion-memory: per-turn ops sub-agent (emotion/style/memory/control)')
  ctx.effect(() => registerLeanTools(ctx, manager), 'companion-memory: lean toolset for enabled conversations')
  ctx.effect(() => registerContextCompression(ctx, manager, config ?? {}), 'companion-memory: conversation context compression')
  ctx.effect(() => registerHierarchy(ctx, manager), 'companion-memory: hierarchy memory compression')
  ctx.effect(() => registerWebApi(ctx, manager), 'companion-memory: /companion/api routes')
  ctx.effect(() => installBridgeEndpoint(ctx, manager), 'companion-memory: bridge endpoint file')
  // 自带的 QQ 连接：面板里的总开关打开时，插件加载后自动连；关着就什么都不做。
  // 手动「断开」会把开关一起关掉，所以不会和正在运行的 dsh-qqbot 抢同一个 bot。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const qq = manager.qq()
        const cfg = qq.publicConfig()
        // 官方机器人看 appId+secret；个人号（OneBot）只看协议端地址
        const channels = cfg.channels || { official: true, onebot: false }
        const officialReady = channels.official !== false && cfg.appId !== '' && cfg.hasSecret
        const onebotReady = channels.onebot === true && cfg.onebot && cfg.onebot.url
        if (cfg.enabled === true && (officialReady || onebotReady)) qq.start().catch(() => {})
      } catch {
        // 自动连失败不影响插件其它部分
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, 'companion-memory: qq bot autostart')
  ctx.effect(() => () => { try { manager.qq().stop() } catch { /* ignore */ } }, 'companion-memory: qq bot cleanup')
  ctx.effect(() => {
    const bridge = manager.bridge()
    bridge.start()
    return () => bridge.stop()
  }, 'companion-memory: qq bridge')

  // 插件加载后：没装 NapCat 就预下载；开了个人号通道且 6198 没开，就自动拉起并连上（重启 DSH 后不用手点）
  // 注意：后台只「死了才拉起」（restart:false）。没扫码登录的时候 NapCat 进程本来就活着，
  // 这时候要是照常 kill 再拉，就成了每分钟杀一次、二维码一直换、每回还弹一个黑框。
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        const setup = createOneBotSetup(manager.root || '')
        const installed = await setup.ensureInstalled()
        if (!installed || installed.ok !== true) return
        const qq = manager.qq()
        const cfg = qq.publicConfig()
        const channels = cfg.channels || {}
        if (channels.onebot !== true) return
        const result = await setup.autoConfigure({ restart: false })
        if (result && result.ok === true && cfg.enabled === true) {
          qq.start().catch(() => {})
        }
      } catch { /* ignore */ }
    }, 4000)
    // 看门狗：NapCat 意外退出（崩溃/被关）时，每 60 秒检查一次并自动拉起，保持个人号通道在线
    const keepAlive = setInterval(async () => {
      try {
        const setup = createOneBotSetup(manager.root || '')
        const state = await setup.getState()
        if (state.installed !== true) return
        const qq = manager.qq()
        const cfg = qq.publicConfig()
        if ((cfg.channels || {}).onebot !== true || state.running === true) return
        // 进程还活着（WebUI 端口通）只是没登录：别动它，等扫码。
        if (state.webui === true) return
        const result = await setup.autoConfigure({ restart: false })
        if (result && result.ok === true && cfg.enabled === true) qq.start().catch(() => {})
      } catch { /* ignore */ }
    }, 60000)
    return () => { clearTimeout(timer); clearInterval(keepAlive) }
  }, 'companion-memory: napcat autostart')

  return () => {
    for (const sessionId of manager.enabledSessions()) {
      try {
        const store = manager.stores.get(sessionId)
        if (store) store.persist()
      } catch {
        // ignore teardown failures
      }
    }
  }
}

