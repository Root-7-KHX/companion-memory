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
 *   - the `/companion/api/*` routes used by the sidebar panel.
 *
 * The Client module (`client.js`) owns all rendering.
 */
import { createManager } from './lib/manager.js'
import { installAgentPrompt } from './lib/prompt.js'
import { registerTool } from './lib/tool.js'
import { registerTracking } from './lib/tracking.js'
import { registerWebApi } from './lib/api.js'

export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config) {
  const manager = createManager(ctx, config ?? {})

  ctx.effect(() => installAgentPrompt(ctx, manager), 'companion-memory: per-conversation prompt sections')
  ctx.effect(() => registerTool(ctx, manager), 'companion-memory: companion_memory tool')
  ctx.effect(() => registerTracking(ctx, manager), 'companion-memory: conversation tracking')
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
