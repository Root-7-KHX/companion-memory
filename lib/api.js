/**
 * The Host HTTP surface consumed by the sidebar panel.
 *
 * Third-party UI plugins have no generated Remote namespace, so the panel talks
 * to its own Host half over same-origin `/companion/api/*` routes. Requests are
 * fenced exactly like the shipped APIs: loopback / trusted Host / non-cross-site
 * only. Responses always carry `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * Every conversation owns an isolated data set, so data routes accept a
 * `session` parameter (query string for GET, JSON body for POST). When it is
 * omitted the manager falls back to the most recently active conversation.
 */
import { renderPromptPayload } from './prompt.js'

const JSON_BODY_LIMIT = 1024 * 1024

function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

function trustedHostsOf(ctx) {
  const hosts = []
  for (const service of [safeGet(ctx, 'webStartup'), safeGet(ctx, 'webRuntime')]) {
    if (service && Array.isArray(service.trustedHosts)) {
      for (const host of service.trustedHosts) if (typeof host === 'string' && host !== '') hosts.push(host)
    }
  }
  return hosts
}

export function isTrustedApiRequest(ctx, webServer, request) {
  const rawHost = typeof request.headers?.host === 'string' ? request.headers.host : ''
  let hostUrl
  try {
    hostUrl = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  const bindHost = typeof webServer?.host === 'string' ? webServer.host : ''
  const trusted = trustedHostsOf(ctx).some((host) => {
    try {
      return new URL(`http://${host}`).host === hostUrl.host
    } catch {
      return host === hostUrl.host
    }
  })
  if (!isLoopbackHostname(hostname) && !trusted && hostname !== bindHost) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== hostUrl.host) return false
    } catch {
      return false
    }
  }
  return true
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > JSON_BODY_LIMIT) {
        settled = true
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-cache')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function ok(response, value) {
  writeJson(response, 200, { ok: true, value })
}

function fail(response, status, message) {
  writeJson(response, status, { ok: false, error: { message } })
}

export function registerWebApi(ctx, manager) {
  const webServer = safeGet(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  return webServer.register({
    kind: 'prefix',
    path: '/companion/api',
    handler: (request, response) => handleRequest(ctx, webServer, manager, request, response),
  })
}

function pickSession(value, url, manager) {
  const fromValue = typeof value === 'string' ? value.trim() : ''
  if (fromValue !== '') return fromValue
  const fromQuery = url.searchParams.get('session')
  if (typeof fromQuery === 'string' && fromQuery.trim() !== '') return fromQuery.trim()
  if (manager && typeof manager.currentSession === 'function') {
    const fallback = manager.currentSession()
    if (typeof fallback === 'string' && fallback !== '') return fallback
  }
  return null
}

function requireStore(manager, sessionId) {
  if (!sessionId) throw new Error('没有识别到当前对话，请先在对话列表中选择一个对话。')
  if (!manager.isEnabled(sessionId)) throw new Error('本对话未开启伴侣记忆，请先在面板中点击「开启本对话」。')
  const store = manager.storeFor(sessionId)
  if (!store) throw new Error('该对话的伴侣记忆数据未能初始化。')
  return store
}

/**
 * 在某个工作区里新建对话（面板「切换对话」列表里的「＋新建」用）。
 *
 * 走宿主 `sessionController.create()`：给了 workspaceId 才会挂进工作区，
 * 只给 cwd 会落在「未分组」。所以先按路径在工作区注册表里找 id。
 * 建完顺手开启伴侣记忆，让用户可以直接往这个新对话里导入。
 */
async function createSessionFor(ctx, manager, body) {
  const wantedPath = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
  const controller = safeGet(ctx, 'sessionController')
  if (!controller || typeof controller.create !== 'function') {
    throw new Error('宿主没有可用的 sessionController.create()，无法新建对话')
  }
  const options = {}
  if (wantedPath !== '') {
    let workspaceId = ''
    try {
      const registry = safeGet(ctx, 'workspaceRegistry')
      const list = typeof registry?.list === 'function' ? registry.list() ?? [] : []
      const normalize = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
      const key = normalize(wantedPath)
      const hit = list.find((workspace) => normalize(workspace?.path) === key)
        ?? list.find((workspace) => normalize(workspace?.path).includes(key) || key.includes(normalize(workspace?.path)))
      if (hit && hit.id) workspaceId = String(hit.id)
    } catch {
      workspaceId = ''
    }
    if (workspaceId !== '') options.workspaceId = workspaceId
    else options.cwd = wantedPath
  }
  if (typeof body?.agentPreset === 'string' && body.agentPreset.trim() !== '') options.agentPreset = body.agentPreset.trim()
  const created = await controller.create(options)
  const sessionId = String(created?.sessionId ?? created?.id ?? '').trim()
  if (sessionId === '') throw new Error('新建对话失败：宿主没有返回会话 id')
  // 新对话默认开启伴侣记忆，用户可以直接导入
  try {
    manager.setEnabled(sessionId, true)
  } catch {
    // 开启失败不影响会话本身
  }
  try {
    manager.noteVisible(sessionId)
  } catch {
    // ignore
  }
  return { sessionId, workspace: wantedPath, enabled: manager.isEnabled(sessionId) }
}

async function handleRequest(ctx, webServer, manager, request, response) {
  try {
    if (!isTrustedApiRequest(ctx, webServer, request)) {
      fail(response, 403, 'forbidden')
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.replace(/^\/companion\/api\/?/, '')

    if (request.method === 'GET') {
      switch (route) {
        case 'sessions': {
          ok(response, await manager.listSessions())
          return
        }
        case 'state': {
          const sessionId = pickSession(null, url, manager)
          if (!sessionId) {
            ok(response, { enabled: false, sessionId: null })
            return
          }
          if (!manager.isEnabled(sessionId)) {
            ok(response, { enabled: false, sessionId })
            return
          }
          ok(response, { enabled: true, sessionId, ...manager.storeFor(sessionId).snapshot() })
          return
        }
        case 'prompt': {
          const store = requireStore(manager, pickSession(null, url, manager))
          ok(response, renderPromptPayload(store))
          return
        }
        case 'search': {
          const store = requireStore(manager, pickSession(null, url, manager))
          ok(response, store.searchKb(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 6)))
          return
        }
        case 'file': {
          const store = requireStore(manager, pickSession(null, url, manager))
          ok(response, store.readKbFile(url.searchParams.get('path') ?? ''))
          return
        }
        default:
          fail(response, 404, 'unknown route')
          return
      }
    }

    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      const sessionId = pickSession(body.session, url, manager)

      switch (route) {
        case 'enable':
          ok(response, manager.setEnabled(sessionId, body.enabled !== false))
          return
        case 'session/say': {
          // 往指定对话里发一条普通用户消息（新建对话后自动发「你好」，让它不再是空白会话）。
          const target = String(body.session ?? sessionId ?? '').trim()
          if (target === '') throw new Error('没有指定要发送消息的对话')
          const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : '你好'
          const controller = safeGet(ctx, 'sessionController')
          if (!controller || typeof controller.prompt !== 'function') {
            throw new Error('宿主没有可用的 sessionController.prompt()，无法发送消息')
          }
          const requestId = `companion-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
          await controller.prompt(
            { requestId, sessionId: target, mode: 'queue', content: [{ type: 'text', text }] },
            AbortSignal.timeout(20000),
          )
          ok(response, { sessionId: target, text })
          return
        }
        case 'session/new': {
          // 在指定工作区里新建一个对话，并顺手开启伴侣记忆，方便直接导入。
          const created = await createSessionFor(ctx, manager, body)
          ok(response, created)
          return
        }
        case 'select':
          manager.noteVisible(sessionId)
          ok(response, { current: manager.currentSession() })
          return
        case 'doc': {
          const store = requireStore(manager, sessionId)
          if (body && typeof body.fields === 'object' && body.fields !== null) {
            ok(response, store.writeDocFields(body.key, body.fields, body.extra))
          } else {
            ok(response, store.writeDoc(body.key, body.content))
          }
          return
        }
        case 'favorability': {
          const store = requireStore(manager, sessionId)
          ok(response, store.setFavorability(body.value, body.reason, body.speaker))
          return
        }
        case 'speaker': {
          const store = requireStore(manager, sessionId)
          const switchRef = typeof body?.switchTo === 'string' ? body.switchTo.trim() : ''
          const nameRef = typeof body?.name === 'string' ? body.name.trim() : typeof body?.speaker === 'string' ? body.speaker.trim() : ''
          const ref = switchRef || nameRef
          if (ref === '') throw new Error('speaker 需要 name（登记新人物）或 switchTo（切换已登记的人）')
          const speaker = store.switchSpeaker(ref, { aliases: body?.aliases, note: body?.note, create: nameRef !== '' })
          ok(response, {
            speaker: { id: speaker.id, name: speaker.name, favorability: speaker.favorability },
            speakers: store.speakersSnapshot(),
          })
          return
        }
        case 'memory/add': {
          const store = requireStore(manager, sessionId)
          ok(response, store.addMemory(body.text, body.tags, { source: 'panel' }))
          return
        }
        case 'memory/archive': {
          const store = requireStore(manager, sessionId)
          const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
          const archived = ids.map((id) => store.archiveMemory(id, '通过侧边栏手动归档').id)
          ok(response, { archived: archived.length })
          return
        }
        case 'memory/pin': {
          const store = requireStore(manager, sessionId)
          ok(response, store.pinMemory(body.id, body.pinned !== false))
          return
        }
        case 'memory/move': {
          const store = requireStore(manager, sessionId)
          ok(response, store.moveMemory(body.id, body.direction === 'down' ? 'down' : 'up'))
          return
        }
        case 'memory/delete': {
          const store = requireStore(manager, sessionId)
          ok(response, store.deleteMemory(body.id))
          return
        }
        case 'favorability/undo': {
          const store = requireStore(manager, sessionId)
          ok(response, store.undoLastFavorability())
          return
        }
        case 'search': {
          const store = requireStore(manager, sessionId)
          ok(response, store.searchKb(body.query, body.limit))
          return
        }
        case 'read': {
          const store = requireStore(manager, sessionId)
          ok(response, store.readKbFile(body.path))
          return
        }
        case 'auto-pack': {
          const store = requireStore(manager, sessionId)
          ok(response, store.setAutoPackEvery(body.every))
          return
        }
        case 'evolve': {
          const store = requireStore(manager, sessionId)
          ok(
            response,
            store.evolvePersona({
              section: body.section,
              add: body.add,
              remove: body.remove,
              reason: body.reason,
              by: 'user',
            }),
          )
          return
        }
        case 'export': {
          // Export accepts a disabled conversation too: the user may want to move
          // data out of a conversation without turning the plugin on there.
          if (!sessionId) throw new Error('没有识别到当前对话，请先在对话列表中选择一个对话。')
          const store = manager.storeFor(sessionId)
          if (!store) throw new Error('该对话的伴侣记忆数据未能初始化。')
          // 导出要带上「说过的话」：先从活会话读完整聊天记录（含还没被打包进知识库的部分），
          // 读不到时 store.exportBundle 会自动退回 48 小时热缓存。
          let transcript = null
          try {
            transcript = await manager.transcriptOf(sessionId)
          } catch {
            transcript = null
          }
          const exported = store.exportBundle({ sessionId, title: body.title, transcript })
          ok(response, { ...exported.bundle, suggestedName: exported.suggestedName })
          return
        }
        case 'import': {
          const payload = body.bundle ?? body
          if (!sessionId) throw new Error('没有识别到当前对话，请先在对话列表中选择一个对话。')
          let store = manager.storeFor(sessionId)
          if (!store) throw new Error('该对话的伴侣记忆数据未能初始化。')
          if (!manager.isEnabled(sessionId)) {
            manager.setEnabled(sessionId, true)
            store = manager.storeFor(sessionId)
          }
          const result = store.importBundle(payload, { merge: body.merge === true })
          ok(response, { ...result, sessionId })
          return
        }
        default:
          fail(response, 404, 'unknown route')
          return
      }
    }

    fail(response, 405, 'method not supported')
  } catch (error) {
    fail(response, 400, error instanceof Error ? error.message : String(error))
  }
}
