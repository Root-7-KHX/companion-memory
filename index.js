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
import { installAgentPrompt } from './lib/prompt.js'
import { registerTool } from './lib/tool.js'
import { registerTracking } from './lib/tracking.js'
import { registerContextCompression } from './lib/context-compress.js'
import { registerHierarchy } from './lib/hierarchy.js'
import { registerDynamicContext } from './lib/dynamic-context.js'
import { registerLeanTools } from './lib/lean-tools.js'
import { registerWebApi } from './lib/api.js'

// `webServer` must be a hard dependency: the panel's `/companion/api/*` routes
// are registered exactly once in `apply`, so a plugin instance that starts
// before the web server is provided would silently lose its HTTP surface.
export const inject = ['systemPrompt', 'tools', 'webServer']

export function apply(ctx, config) {
  const manager = createManager(ctx, config ?? {})

  ctx.effect(() => installAgentPrompt(ctx, manager), 'companion-memory: per-conversation prompt sections')
  ctx.effect(() => registerTool(ctx, manager), 'companion-memory: companion_memory tool')
  ctx.effect(() => registerTracking(ctx, manager), 'companion-memory: conversation tracking')
  ctx.effect(() => registerDynamicContext(ctx, manager), 'companion-memory: per-turn dynamic context')
  ctx.effect(() => registerLeanTools(ctx, manager), 'companion-memory: lean toolset for enabled conversations')
  ctx.effect(() => registerContextCompression(ctx, manager, config ?? {}), 'companion-memory: conversation context compression')
  ctx.effect(() => registerHierarchy(ctx, manager), 'companion-memory: hierarchy memory compression')
  ctx.effect(() => registerWebApi(ctx, manager), 'companion-memory: /companion/api routes')

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
