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
          ok(response, store.setFavorability(body.value, body.reason))
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
