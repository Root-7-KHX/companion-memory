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
import { existsSync, mkdirSync, readdirSync as readdirSyncImpl, readFileSync, renameSync, statSync as statSyncImpl, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPromptPayload } from './prompt.js'
import { cleanMemories, scanHealth } from './clean.js'
import { hierarchyInfo, buildAnnual, buildEpoch, rollbackHierarchy } from './hierarchy.js'
import { digestImportedConversation, resolveImportDigestSettings } from './import-digest.js'

const JSON_BODY_LIMIT = 1024 * 1024

/**
 * 「接入软件」里可以一键开关整个插件（不是插件内部的功能开关）的应用。
 * 面板上的开关会直接改 profile patch 的 disabled 标记，宿主热加载后插件真的加载/卸载。
 */
const APP_PLUGIN_TARGETS = {
  // 留空也安全：真正的映射来自 integrations 清单里的 `plugin` 字段（例如 ai-voice.json）。
  // 需要给某个清单暂时兜底时可以在这里补 { <appId>: { entryId, patchId } }。
}

function profilePatchPath() {
  const dir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (dir !== '') return join(dir, 'cordis.patch.yml')
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== '' ? process.env.DSH_PROFILE.trim() : 'desktop'
  return join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
}

/** 从「接入软件」清单里解析插件型应用（清单带 plugin: 模块名 的，卡片开关就控制整个插件）。 */
async function resolveAppPluginTarget(ctx, manager, appId) {
  const hard = APP_PLUGIN_TARGETS[appId]
  if (hard) return hard
  let moduleName = ''
  try {
    const payload = manager.listIntegrations()
    const items = payload && Array.isArray(payload.items) ? payload.items : []
    const hit = items.find((item) => item && item.id === appId && typeof item.plugin === 'string' && item.plugin.trim() !== '')
    if (hit) moduleName = hit.plugin.trim()
  } catch {
    moduleName = ''
  }
  if (moduleName === '') return null
  const pm = safeGet(ctx, 'pluginManager')
  if (pm && typeof pm.listPlugins === 'function') {
    try {
      const listing = await pm.listPlugins()
      const entries = Array.isArray(listing) ? listing : (listing && Array.isArray(listing.entries) ? listing.entries : [])
      const hit = entries.find((entry) => entry && entry.moduleName === moduleName)
      if (hit) {
        const patchId = typeof hit.patchId === 'string' && hit.patchId !== ''
          ? hit.patchId
          : String(hit.entryId || '').replace(/^include:/, '')
        if (patchId !== '') return { entryId: hit.entryId || ('include:' + patchId), patchId }
      }
    } catch {
      // ignore
    }
  }
  return null
}

async function pluginBackedAppTargets(ctx, manager) {
  const result = { ...APP_PLUGIN_TARGETS }
  let items = []
  try {
    const payload = manager.listIntegrations()
    items = payload && Array.isArray(payload.items) ? payload.items : []
  } catch {
    items = []
  }
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id === '' || item.id in result) continue
    if (typeof item.plugin !== 'string' || item.plugin.trim() === '') continue
    const target = await resolveAppPluginTarget(ctx, manager, item.id)
    if (target) result[item.id] = target
  }
  return result
}

async function readAppPluginEnabled(ctx, manager, appId) {
  const target = await resolveAppPluginTarget(ctx, manager, appId)
  if (!target) throw new Error('不支持的应用：' + appId)
  const pm = safeGet(ctx, 'pluginManager')
  if (pm && typeof pm.listPlugins === 'function') {
    try {
      const result = await pm.listPlugins()
      const entries = Array.isArray(result) ? result : (result && Array.isArray(result.entries) ? result.entries : [])
      const hit = entries.find((entry) => entry && (entry.entryId === target.entryId || entry.patchId === target.patchId))
      if (hit && typeof hit.enabled === 'boolean') return hit.enabled
    } catch {
      // 读不到服务就回退读 patch
    }
  }
  try {
    const lines = readFileSync(profilePatchPath(), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() !== `- id: ${target.patchId}`) continue
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
        const match = /^\s+disabled:\s*(true|false)\s*$/.exec(lines[j])
        if (match) return match[1] !== 'true'
      }
    }
    return true
  } catch {
    return true
  }
}

function writeAppPluginEnabled(target, enabled) {
  if (!target) throw new Error('该应用没有可写的插件行')
  const file = profilePatchPath()
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const value = enabled ? 'false' : 'true'
  let replaced = false
  for (let i = 0; i < lines.length && !replaced; i += 1) {
    if (lines[i].trim() !== `- id: ${target.patchId}`) continue
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      const match = /^(\s+)disabled:\s*(true|false)\s*$/.exec(lines[j])
      if (!match) continue
      lines[j] = `${match[1]}disabled: ${value}`
      replaced = true
      break
    }
  }
  let next = lines.join('\n')
  if (!replaced) {
    if (!next.endsWith('\n')) next += '\n'
    next += `- id: ${target.patchId}\n  disabled: ${value}\n`
  }
  const tmp = `${file}.companion.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
  return enabled
}

/** 启用插件后顺手把它的功能总开关打开（插件加载要一点时间，失败就忽略）。 */
function warmUpAiVoice(ctx) {
  let origin = ''
  try {
    const webServer = safeGet(ctx, 'webServer')
    origin = webServer && typeof webServer.getOrigin === 'function' ? String(webServer.getOrigin() || '') : ''
  } catch {
    origin = ''
  }
  if (origin === '') return
  const timer = setTimeout(async () => {
    try {
      await fetch(origin.replace(/\/+$/, '') + '/ai-voice/api/enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    } catch {
      // 插件没起来就算了，用户还可以在 AI语音 页里自己开
    }
  }, 2500)
  if (typeof timer.unref === 'function') timer.unref()
}

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

function readdirSyncSafe(dir) {
  try {
    return readdirSyncImpl(dir)
  } catch {
    return []
  }
}

function statSyncSafe(file) {
  try {
    return statSyncImpl(file)
  } catch {
    return null
  }
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

/**
 * 把本地接口地址写成文件，供同机的桥接程序（例如 QQ 机器人的入站扩展）发现：
 *   <数据根>/api-endpoint.json = { protocol, host, port, base: 'http://127.0.0.1:<port>/companion/api' }
 *
 * 桥接程序不用猜端口，只要读这个文件；端口变了每 15 秒自动刷新。
 */
export function installBridgeEndpoint(ctx, manager) {
  const webServer = safeGet(ctx, 'webServer')
  const file = manager.endpointFile()
  const write = () => {
    try {
      const port = webServer && Number(webServer.port)
      if (!Number.isFinite(port) || port <= 0) return false
      const protocol = typeof webServer.protocol === 'string' ? webServer.protocol : 'http:'
      const host = '127.0.0.1'
      mkdirSync(dirname(file), { recursive: true })
      const body = JSON.stringify({
        version: 1,
        protocol,
        host,
        port,
        base: protocol + '//' + host + ':' + port + '/companion/api',
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }, null, 2) + '\n'
      writeFileSync(file, body, 'utf8')
      return true
    } catch {
      return false
    }
  }
  write()
  const timer = setInterval(write, 15000)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    try { clearInterval(timer) } catch { /* ignore */ }
  }
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
        case 'voice/file': {
          // 试听/下载本地语音 POC 生成的 wav（D:\AI\语音POC\out）
          const name = String(url.searchParams.get('name') || '').trim()
          if (!/^[A-Za-z0-9._-]+\.wav$/.test(name)) throw new Error('文件名不合法')
          const file = 'D:/AI/语音POC/out/' + name
          if (!existsSync(file)) throw new Error('找不到音频：' + name)
          const bytes = readFileSync(file)
          const inline = url.searchParams.get('inline') === '1'
          response.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
            ...(inline ? {} : { 'content-disposition': 'attachment; filename="' + name + '"' }),
          })
          response.end(bytes)
          return
        }
        case 'voice/list': {
          // 试听页：列出 POC 里的 wav，带 <audio> 播放器
          const dir = 'D:/AI/语音POC/out'
          let items = []
          try {
            for (const name of readdirSyncSafe(dir)) {
              if (!name.toLowerCase().endsWith('.wav')) continue
              const info = statSyncSafe(join(dir, name))
              if (info) items.push({ name, kb: Math.round(info.size / 1024), at: info.mtime.toLocaleString('zh-CN') })
            }
          } catch { /* ignore */ }
          const rows = items.map((item) => '<div style="margin:14px 0"><div><b>' + item.name + '</b> <span style="color:#888">' + item.kb + ' KB · ' + item.at + '</span> · <a download href="/companion/api/voice/file?name=' + encodeURIComponent(item.name) + '">下载</a></div>'
            + '<audio controls preload="none" src="/companion/api/voice/file?inline=1&name=' + encodeURIComponent(item.name) + '" style="width:100%;max-width:520px;margin-top:6px"></audio></div>').join('')
          const html = '<!doctype html><meta charset="utf-8"><title>语音试听</title><body style="font:14px/1.7 system-ui;padding:24px;max-width:760px">'
            + '<h2>VoxCPM2 试听</h2><p style="color:#666">目录：D:\AI\语音POC\out</p>' + (rows || '<p>还没有生成音频。</p>') + '</body>'
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(html)
          return
        }
        case 'pkg/open': {
          // 在资源管理器里打开分发包所在的文件夹（浏览器里点链接就能开）
          const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
          try {
            const { spawn } = await import('node:child_process')
            spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
          } catch { /* ignore */ }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end('<!doctype html><meta charset="utf-8"><title>已打开文件夹</title><body style="font:14px/1.6 system-ui;padding:24px">✅ 已在资源管理器中打开：<code>' + dir.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code><p>如果没看到窗口，去任务栏找一下「dist」。</p></body>')
          return
        }
        case 'pkg': {
          // 一个简单的 HTML 页面：列出分发包 + 提供下载链接和「打开文件夹」按钮
          const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
          let items = []
          try {
            for (const name of readdirSyncSafe(dir)) {
              if (!/^companion-memory-[A-Za-z0-9._-]+\.(zip|tgz)$/.test(name)) continue
              const info = statSyncSafe(join(dir, name))
              if (info) items.push({ name, kb: Math.round(info.size / 1024), at: info.mtime.toLocaleString('zh-CN') })
            }
          } catch { /* ignore */ }
          items.sort((x, y) => y.at.localeCompare(x.at))
          const rows = items.map((item) => '<tr><td>' + item.name + '</td><td>' + item.kb + ' KB</td><td>' + item.at + '</td><td><a href="/companion/api/pkg/download?name=' + encodeURIComponent(item.name) + '">下载</a></td></tr>').join('')
          const html = '<!doctype html><meta charset="utf-8"><title>AI记忆 · 安装包</title>'
            + '<body style="font:14px/1.6 system-ui;padding:24px;max-width:900px">'
            + '<h2>AI记忆 · 安装包</h2>'
            + '<p>文件夹：<code>' + dir.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code> · '
            + '<a href="/companion/api/pkg/open">📂 打开文件夹</a></p>'
            + '<table cellpadding="6" style="border-collapse:collapse;width:100%">'
            + '<tr style="text-align:left;border-bottom:1px solid #ddd"><th>文件</th><th>大小</th><th>时间</th><th></th></tr>'
            + rows + '</table></body>'
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(html)
          return
        }
        case 'pkg/list': {
          // 本地打包好的分发包（D:\AI\插件\dist），供面板/浏览器直接下载
          const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
          const items = []
          try {
            for (const name of readdirSyncSafe(dir)) {
              if (!/^companion-memory-[A-Za-z0-9._-]+\.(zip|tgz)$/.test(name)) continue
              try {
                const info = statSyncSafe(join(dir, name))
                if (info) items.push({ name, bytes: info.size, at: info.mtime.toISOString() })
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          ok(response, { dir, items })
          return
        }
        case 'pkg/download': {
          // 下载一个安装包（只允许 dist 目录里的 companion-memory-*.zip/.tgz）
          const name = String(url.searchParams.get('name') || '').trim()
          if (!/^companion-memory-[A-Za-z0-9._-]+\.(zip|tgz)$/.test(name)) throw new Error('文件名不合法')
          const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
          const file = join(dir, name)
          if (!existsSync(file)) throw new Error('找不到安装包：' + name)
          const bytes = readFileSync(file)
          const type = name.endsWith('.zip') ? 'application/zip' : 'application/gzip'
          response.writeHead(200, {
            'content-type': type,
            'content-length': String(bytes.length),
            'content-disposition': 'attachment; filename="' + name + '"',
            'cache-control': 'no-store',
          })
          response.end(bytes)
          return
        }
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
        case 'memory/health': {
          // 1.1.0-C：记忆体检（只读扫描，不改数据）
          const store = requireStore(manager, pickSession(null, url, manager))
          const memories = store.activeMemories()
          ok(response, {
            ...scanHealth(memories, { interactionDays: store.state.interactionDays, memoryLimit: 30 }),
            interactionDays: store.state.interactionDays,
          })
          return
        }
        case 'hierarchy': {
          // 1.1.0-A：多级记忆压缩状态
          const store = requireStore(manager, pickSession(null, url, manager))
          ok(response, hierarchyInfo(store))
          return
        }
        case 'file': {
          const store = requireStore(manager, pickSession(null, url, manager))
          ok(response, store.readKbFile(url.searchParams.get('path') ?? ''))
          return
        }
        case 'integrations': {
          // 「接入软件」清单：全局，不分对话，也不执行任何代码。
          ok(response, manager.listIntegrations())
          return
        }
        case 'integrations/state': {
          ok(response, { states: manager.readIntegrationStates() })
          return
        }
        case 'apps/state': {
          // 「接入软件」卡片上的插件开关状态（直接反映插件是否真的加载着）
          const apps = {}
          const targets = await pluginBackedAppTargets(ctx, manager)
          for (const appId of Object.keys(targets)) {
            try {
              apps[appId] = { enabled: await readAppPluginEnabled(ctx, manager, appId) }
            } catch {
              apps[appId] = { enabled: true }
            }
          }
          ok(response, { apps })
          return
        }
        case 'qq/bridge': {
          ok(response, manager.bridge().statusSnapshot())
          return
        }
        case 'qq/status': {
          ok(response, manager.qq().statusSnapshot())
          return
        }
        case 'qq/config': {
          ok(response, manager.qq().publicConfig())
          return
        }
        case 'qq/group/info': {
          ok(response, await manager.qq().groupInfo(url.searchParams.get('groupId') ?? ''))
          return
        }
        case 'qq/join-requests': {
          ok(response, await manager.qq().listJoinRequests({ groupId: url.searchParams.get('groupId') ?? '', cursor: url.searchParams.get('cursor') ?? '' }))
          return
        }
        case 'qq/peers': {
          // 见到的 QQ 人/群 + 当前接入白名单（空白 = 全部接）
          ok(response, {
            items: manager.qq().listPeers(100),
            allowedPeers: manager.bridge().config.allowedPeers || [],
          })
          return
        }
        case 'qq/bridge/sessions': {
          // 给面板选「哪个对话的 AI 接 QQ」：dsh 的对话列表（含标题/工作区/是否开了记忆）
          const list = await manager.listSessions()
          ok(response, list)
          return
        }
        case 'qq/voices': {
          ok(response, manager.qq().listVoices(Number(url.searchParams.get('limit') ?? 50)))
          return
        }
        case 'qq/debug/services': {
          const names = ['sessionController', 'sessions', 'sessionQuery', 'agents', 'conversation', 'workspaces', 'workspace', 'sessionRegistry', 'sessionsController']
          const report = {}
          for (const name of names) {
            const service = safeGet(ctx, name)
            if (!service) { report[name] = null; continue }
            const methods = []
            let proto = service
            const seen = new Set()
            while (proto && proto !== Object.prototype && seen.size < 60) {
              for (const key of Object.getOwnPropertyNames(proto)) {
                if (key === 'constructor' || seen.has(key)) continue
                seen.add(key)
                if (typeof service[key] === 'function') methods.push(key)
              }
              proto = Object.getPrototypeOf(proto)
              if (proto === Object.prototype) break
            }
            report[name] = methods.slice(0, 40)
          }
          ok(response, report)
          return
        }
        case 'qq/routes': {
          const bridge = manager.bridge()
          const sessions = await manager.listSessions()
          const items = manager.qq().listPeers(200).map((peer) => ({
            key: peer.key,
            scope: peer.scope,
            peerId: peer.peerId,
            name: peer.name || '',
            count: peer.count || 0,
            lastAt: peer.lastAt || '',
            sessionId: (bridge.config.peerSessions || {})[peer.key] || '',
          }))
          ok(response, {
            items,
            sessions: Array.isArray(sessions && sessions.items) ? sessions.items : [],
            workspaces: Array.isArray(sessions && sessions.groups) ? sessions.groups.map((group) => ({ id: group.workspaceId || '', label: group.label || '', cwd: group.cwd || '' })).filter((item) => item.id !== '') : [],
            defaultSessionId: bridge.config.sessionId || '',
          })
          return
        }
        case 'qq/voiceprint/members': {
          const vp = manager.qq().voiceprint
          const candidates = new Map()
          const add = (externalId, name, msgCount, lastSeenAt) => {
            const key = String(externalId || '').trim()
            if (key === '') return
            const prev = candidates.get(key)
            if (prev) {
              prev.msgCount = Math.max(prev.msgCount, Number(msgCount) || 0)
              if (prev.name === '' && name) prev.name = String(name)
            } else {
              candidates.set(key, { externalId: key, name: String(name || ''), msgCount: Number(msgCount) || 0, lastSeenAt: lastSeenAt || '' })
            }
          }
          try {
            const people = manager.people().list({ limit: 200 })
            for (const person of people.items || []) {
              if (person.platform === 'qq' || person.platform === '') add(person.externalId, person.currentName || '', person.msgCount || 0, person.lastSeenAt)
            }
          } catch { /* ignore */ }
          try {
            for (const peer of manager.qq().listPeers(100)) {
              if (peer && peer.scope === 'c2c') add(peer.peerId, peer.name || '', peer.count || 0, new Date(peer.lastAt || Date.now()).toISOString())
            }
          } catch { /* ignore */ }
          try {
            for (const message of manager.qq().recentMessages(200)) {
              if (message && message.senderId) add(message.senderId, message.senderName || '', 1, message.at)
            }
          } catch { /* ignore */ }
          const items = [...candidates.values()].sort((x, y) => y.msgCount - x.msgCount).slice(0, 200)
          ok(response, { items, allowed: vp ? vp.config.allowedMembers : [] })
          return
        }
        case 'qq/voiceprint/samples': {
          const vp = manager.qq().voiceprint
          ok(response, vp ? vp.samplesList() : [])
          return
        }
        case 'qq/voiceprints': {
          ok(response, manager.qq().voiceprint ? manager.qq().voiceprint.status() : { enabled: false, profiles: [] })
          return
        }
        case 'qq/stickers/dir': {
          ok(response, { dir: manager.qq().stickerDir })
          return
        }
        case 'qq/stickers': {
          ok(response, manager.qq().listStickers(Number(url.searchParams.get('limit') ?? 100)))
          return
        }
        case 'qq/proactive': {
          ok(response, manager.bridge().proactiveSnapshot())
          return
        }
        case 'qq/schedule': {
          ok(response, manager.qq().schedules)
          return
        }
        case 'qq/messages': {
          ok(response, manager.qq().recentMessages(Number(url.searchParams.get('limit') ?? 30)))
          return
        }
        case 'people': {
          // 全局人物档案（QQ 群成员识别）：稳定 ID + 昵称历史 + 改名记录。
          ok(response, manager.people().list({
            q: url.searchParams.get('q') ?? '',
            limit: Number(url.searchParams.get('limit') ?? 200),
          }))
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
        case 'integrations/state':
          ok(response, manager.setIntegrationState(body.id, body.enabled === true))
          return
        case 'apps/toggle': {
          // 直接把整个插件加载/卸载（改 profile patch + 宿主热加载），不是插件内部的功能开关。
          // 立即返回目标状态：面板会先按目标状态显示，宿主热加载完再以真实状态为准。
          const appId = String(body.id ?? '').trim()
          const target = await resolveAppPluginTarget(ctx, manager, appId)
          if (!target) throw new Error('不支持的应用：' + appId)
          const desired = body.enabled === true
          writeAppPluginEnabled(target, desired)
          if (appId === 'ai-voice' && desired) warmUpAiVoice(ctx)
          ok(response, { id: appId, enabled: desired })
          return
        }
        case 'integrations/example':
          // 写一份示例清单，方便第一次接入的人照着改。
          ok(response, manager.writeIntegrationExample())
          return
        case 'integrations/item':
          // 面板「申请接入」表单：把一份清单写进 integrations 目录（同 id 覆盖更新）。
          ok(response, manager.writeIntegration(body))
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
        case 'character-name': {
          // 角色（AI）自己的名字：只有这条路径能写，AI 的 edit_doc 碰不到它。
          // 这里是「本对话的覆盖值」；传空串 = 清除覆盖、跟随全局默认。
          const store = requireStore(manager, sessionId)
          ok(response, store.setCharacterName(body.name))
          return
        }
        case 'character-name/global': {
          // 所有对话共享的默认名字。
          const store = requireStore(manager, sessionId)
          ok(response, store.setGlobalCharacterName(body.name))
          return
        }
        case 'evolve/weight': {
          // 调整某条自我演化条目的权重（1~100）；只有面板会走这里。
          const store = requireStore(manager, sessionId)
          ok(response, store.setEvolutionWeight(body.section, body.id, body.weight))
          return
        }
        case 'favorability': {
          const store = requireStore(manager, sessionId)
          // manual = 面板里手动拖动：直接生效，不被羁绊缓冲。
          ok(response, store.setFavorability(body.value, body.reason, body.speaker, { manual: body.manual === true }))
          return
        }
        case 'bond': {
          const store = requireStore(manager, sessionId)
          // manual = 面板里手动加减：不计入人格演化进度（那是剧情累积）。
          ok(response, store.addBond(body.speaker, body.delta, body.reason, { manual: body.manual === true }))
          return
        }
        case 'evolution/trigger': {
          // 面板手动调整人格演化计数器：reset 清零，progress / due 直接设置。
          const store = requireStore(manager, sessionId)
          ok(response, store.updateEvolutionTrigger(body))
          return
        }
        case 'emotion': {
          const store = requireStore(manager, sessionId)
          ok(response, store.setEmotions({ emotions: body.emotions, reason: body.reason }, { by: 'user' }))
          return
        }
        case 'emotion/types': {
          const store = requireStore(manager, sessionId)
          const added = []
          const removed = []
          for (const input of Array.isArray(body?.add) ? body.add.slice(0, 2) : []) {
            added.push(store.addEmotionType(input))
          }
          for (const ref of Array.isArray(body?.remove) ? body.remove : []) {
            removed.push(store.removeEmotionType(ref))
          }
          ok(response, {
            added: added.map((item) => item.label),
            removed: removed.map((item) => item.label),
            types: store.emotionTypesSnapshot(),
            emotion: store.emotionSnapshot(),
          })
          return
        }
        case 'speaker/delete': {
          const store = requireStore(manager, sessionId)
          const ref = typeof body?.speakerId === 'string' && body.speakerId !== ''
            ? body.speakerId
            : (typeof body?.speaker === 'string' ? body.speaker : '')
          if (ref === '') throw new Error('需要 speaker 或 speakerId')
          const result = store.removeSpeaker(ref)
          ok(response, result)
          return
        }
        case 'speaker': {
          const store = requireStore(manager, sessionId)
          const externalId = typeof body?.externalId === 'string' ? body.externalId.trim() : ''
          const platform = typeof body?.platform === 'string' && body.platform.trim() !== ''
            ? body.platform.trim()
            : (externalId !== '' ? 'qq' : '')
          const switchRef = typeof body?.switchTo === 'string' ? body.switchTo.trim() : ''
          const nameRef = typeof body?.name === 'string' ? body.name.trim() : typeof body?.speaker === 'string' ? body.speaker.trim() : ''
          // 带稳定 ID（QQ openid）时先更新全局人物档案：改名/换群都能认回同一个人。
          let person = null
          let renamed = null
          if (externalId !== '') {
            const registry = manager.people()
            const result = registry.upsert({ platform, externalId, name: nameRef, instance: body?.instance })
            person = result.person
            renamed = result.renamed
          }
          const ref = switchRef || nameRef || (person && person.currentName) || externalId
          if (ref === '') throw new Error('speaker 需要 name（登记新人物）或 switchTo（切换已登记的人）或 externalId（平台稳定 ID）')
          const speaker = store.switchSpeaker(ref, {
            aliases: Array.isArray(body?.aliases) ? body.aliases : (person ? person.names.map((item) => item.name) : undefined),
            note: body?.note,
            externalId,
            platform,
            create: nameRef !== '' || externalId !== '',
          })
          ok(response, {
            speaker: {
              id: speaker.id,
              name: speaker.name,
              favorability: speaker.favorability,
              externalId: speaker.externalId ?? '',
              platform: speaker.platform ?? '',
            },
            renamed,
            person: person ? {
              externalId: person.externalId,
              platform: person.platform,
              currentName: person.currentName,
              aliases: person.names.map((item) => item.name),
              renamedCount: person.renames.length,
              msgCount: person.msgCount,
            } : null,
            speakers: store.speakersSnapshot(),
          })
          return
        }
        case 'memory/add': {
          const store = requireStore(manager, sessionId)
          ok(response, store.addMemory(body.text, body.tags, { source: 'panel' }))
          return
        }
        case 'qq/config': {
          ok(response, manager.qq().saveConfig({
            appId: body.appId,
            appSecret: body.appSecret,
            enabled: body.enabled,
            clearSecret: body.clearSecret === true,
          }))
          return
        }
        case 'qq/start': {
          const bot = manager.qq()
          const started = await bot.start()
          ok(response, started)
          return
        }
        case 'qq/stop': {
          // 手动断开 = 顺手把总开关关掉，免得加载插件时又自动连上。
          const bot = manager.qq()
          bot.saveConfig({ enabled: false })
          ok(response, await bot.stop())
          return
        }
        case 'qq/enabled': {
          // QQ 接入总开关：开 = 记住并尝试连接；关 = 记住、断开、不再收/发消息。
          ok(response, await manager.qq().setEnabled(body.enabled === true))
          return
        }
        case 'qq/media/prune': {
          // 手动触发一次本地媒体清理（图片默认留 3 天、语音 7 天）。
          ok(response, manager.qq().pruneMedia())
          return
        }
        case 'qq/sticker/pickdir': {
          // 系统原生的「选择文件夹」对话框：带「新建文件夹」和「打开」按钮
          const startDir = typeof body?.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : manager.qq().stickerDir
          const csLines = [
                    "using System;",
                    "using System.Runtime.InteropServices;",
                    "public static class FolderPickerX {",
                    "  [ComImport, Guid(\"DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7\")] class FileOpenDialogRCW { }",
                    "  [ComImport, Guid(\"d57c7288-d4ad-4768-be02-9d969532d960\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
                    "  interface IFileOpenDialog {",
                    "    [PreserveSig] int Show(IntPtr parent);",
                    "    void SetFileTypes(uint c, IntPtr p);",
                    "    void SetFileTypeIndex(uint i);",
                    "    void GetFileTypeIndex(out uint i);",
                    "    void Advise(IntPtr p, out uint c);",
                    "    void Unadvise(uint c);",
                    "    void SetOptions(uint f);",
                    "    void GetOptions(out uint f);",
                    "    void SetDefaultFolder(IntPtr p);",
                    "    void SetFolder(IntPtr p);",
                    "    void GetFolder(out IntPtr p);",
                    "    void GetCurrentSelection(out IntPtr p);",
                    "    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);",
                    "    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);",
                    "    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);",
                    "    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);",
                    "    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string l);",
                    "    void GetResult(out IntPtr p);",
                    "    void AddPlace(IntPtr p, int a);",
                    "    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);",
                    "    void Close(int h);",
                    "    void SetClientGuid(ref Guid g);",
                    "    void ClearClientData();",
                    "    void SetFilter(IntPtr p);",
                    "    void GetResults(out IntPtr p);",
                    "    void GetSelectedItems(out IntPtr p);",
                    "  }",
                    "  [ComImport, Guid(\"43826d1e-e718-42ee-bc55-a1e261c37bfe\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
                    "  interface IShellItem {",
                    "    void BindToHandler(IntPtr b, ref Guid h, ref Guid r, out IntPtr p);",
                    "    void GetParent(out IntPtr p);",
                    "    void GetDisplayName(uint s, out IntPtr n);",
                    "    void GetAttributes(uint m, out uint a);",
                    "    void Compare(IntPtr i, uint h, out int o);",
                    "  }",
                    "  public static string Pick(string initialPath) {",
                    "    try {",
                    "      var d = (IFileOpenDialog)new FileOpenDialogRCW();",
                    "      uint opt;",
                    "      d.GetOptions(out opt);",
                    "      d.SetOptions(opt | 0x20u);",
                    "      d.SetTitle(\"选择表情包文件夹\");",
                    "      d.SetOkButtonLabel(\"打开\");",
                    "      if (d.Show(IntPtr.Zero) != 0) return \"\";",
                    "      IntPtr res;",
                    "      d.GetResult(out res);",
                    "      var shell = (IShellItem)Marshal.GetObjectForIUnknown(res);",
                    "      IntPtr name;",
                    "      shell.GetDisplayName(0x80058000u, out name);",
                    "      try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }",
                    "    } catch (Exception ex) {",
                    "      return \"ERR:\" + ex.GetType().Name + \":\" + ex.Message;",
                    "    }",
                    "  }",
                    "}"
          ]
          const cs = csLines.join('\n')
          const safePath = String(startDir).replace(/'/g, "''")
          const script = ['Add-Type -TypeDefinition @"', cs, '"@ -Language CSharp -ErrorAction Stop', "[FolderPickerX]::Pick('" + safePath + "')"].join('\n')
          const { execFile } = await import('node:child_process')
          const picked = await new Promise((resolve) => {
            execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 300000 }, (error, stdout) => {
              resolve(error ? '' : String(stdout || '').trim())
            })
          })
          if (typeof picked === 'string' && picked.startsWith('ERR:')) {
            throw new Error('打开文件夹选择框失败：' + picked.slice(4))
          }
          ok(response, { dir: typeof picked === 'string' ? picked : '' })
          return
        }
        case 'qq/sticker/opendir': {
          // 在资源管理器里打开表情包文件夹
          const dir = typeof body?.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : manager.qq().stickerDir
          const { spawn } = await import('node:child_process')
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
          ok(response, { dir })
          return
        }
        case 'qq/sticker/setdir': {
          // 修改表情包文件夹路径（空 = 回到默认的 qq-stickers）
          ok(response, manager.qq().saveConfig({ stickerDir: typeof body?.dir === 'string' ? body.dir : '' }))
          return
        }
        case 'qq/sticker/upload': {
          // 面板里自己上传一张/多张图片收进表情包库（base64）
          const name = typeof body?.name === 'string' && body.name.trim() !== '' ? body.name : 'upload.jpg'
          const data = typeof body?.data === 'string' ? body.data : ''
          if (data === '') throw new Error('缺少图片内容')
          const { mkdirSync, writeFileSync } = await import('node:fs')
          const { join } = await import('node:path')
          const dir = manager.root + '/qq-images'
          mkdirSync(dir, { recursive: true })
          const safeExt = /^(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test((name.split('.').pop() || '').toLowerCase()) ? (name.split('.').pop() || 'jpg').toLowerCase() : 'jpg'
          const file = 'upload_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 6) + '.' + safeExt
          const target = join(dir, file)
          writeFileSync(target, Buffer.from(data, 'base64'))
          const sticker = manager.qq().addStickerFromFile(target, { from: '手动上传', caption: typeof body?.caption === 'string' ? body.caption : '', captionBy: 'user' })
          ok(response, sticker)
          return
        }
        case 'qq/sticker/add': {
          // 手动把一张图收进表情包库（面板/调试用；AI 走 companion_memory 的 sticker 动作）
          ok(response, manager.qq().addStickerFromFile(body?.path, { from: body?.from, caption: typeof body?.caption === 'string' ? body.caption : '', captionBy: 'user' }))
          return
        }
        case 'qq/sticker/tag': {
          // 带 caption 时直接写「含义备注」（面板手动改，不需要外部打标命令）
          if (typeof body?.caption === 'string') {
            ok(response, manager.qq().setStickerCaption(body?.stickerId, body.caption, 'user'))
            return
          }
          ok(response, manager.qq().tagSticker(body.stickerId))
          return
        }
        case 'qq/sticker/caption': {
          ok(response, manager.qq().setStickerCaption(body?.stickerId, body?.caption, 'user'))
          return
        }
        case 'qq/stream': {
          // 一次性发帧（c2c 流式）：final=true 收尾，false 中间帧
          const stream = manager.qq().openStream({ scope: 'c2c', targetId: body.targetId, msgId: body.msgId })
          ok(response, body.final === false ? await stream.update(body.text) : await stream.done(body.text))
          return
        }
        case 'qq/sticker/send': {
          ok(response, await manager.qq().sendStickerToLatest({ stickerId: body.stickerId }))
          return
        }
        case 'qq/bridge': {
          ok(response, manager.bridge().saveConfig({
            allowedPeers: body.allowedPeers,
            enabled: body.enabled,
            sessionId: body.sessionId,
            approvalEnabled: body.approvalEnabled,
            approvalTimeoutMs: body.approvalTimeoutMs,
            autoCreateSession: body.autoCreateSession,
            autoSessionCwd: body.autoSessionCwd,
            autoSessionWorkspaceId: body.autoSessionWorkspaceId,
          }))
          return
        }
        case 'qq/proactive': {
          // 「AI 主动冒泡」面板：改开关 / 静默时段 / 次数上限
          const patch = {}
          for (const key of ['enabled', 'minSeconds', 'maxPending', 'dailyLimit', 'quietStart', 'quietEnd']) {
            if (body && Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
          }
          if (typeof patch.enabled !== 'boolean') delete patch.enabled
          const bridge = manager.bridge()
          bridge.saveConfig({ proactive: patch })
          ok(response, bridge.proactiveSnapshot())
          return
        }
        case 'qq/proactive/cancel': {
          const bridge = manager.bridge()
          ok(response, bridge.cancelProactive({ id: typeof body.id === 'string' ? body.id : '', all: body.all === true }))
          return
        }
        case 'qq/proactive/fire': {
          // 自测 / 手动催一次：立刻走一遍到点逻辑（同样查窗口、静默时段、当天上限）
          const bridge = manager.bridge()
          const entry = bridge.proactiveItems.find((item) => item && item.id === body.id)
          if (!entry) throw new Error('没有这条主动冒泡')
          await bridge.fireProactive(entry)
          ok(response, bridge.proactiveSnapshot())
          return
        }
        case 'qq/proactive/schedule': {
          // 面板里手动定一条（AI 自己也能通过 companion_memory proactive 定）
          const bridge = manager.bridge()
          ok(response, bridge.scheduleProactive({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            delaySeconds: body.delaySeconds,
            note: typeof body.note === 'string' ? body.note : '',
          }))
          return
        }
        case 'qq/bridge/owner': {
          // 选定「我的账号（用户）」：这个 QQ 账号算 default 用户，其他人的私聊各自单独一个说话人。
          const bridge = manager.bridge()
          ok(response, bridge.saveConfig({ ownerOpenId: typeof body.openId === 'string' ? body.openId : '' }))
          return
        }
        case 'qq/debug/session-exists': {
          const bridge = manager.bridge()
          ok(response, { id: body?.id, exists: await bridge.sessionExists(body?.id) })
          return
        }
        case 'qq/debug/create-session2': {
          const sc = safeGet(ctx, 'sessionController')
          const query = safeGet(ctx, 'sessionQuery')
          const input = { title: body?.title || '调试新建会话2' }
          if (typeof body?.cwd === 'string' && body.cwd !== '') input.cwd = body.cwd
          if (typeof body?.workspaceId === 'string' && body.workspaceId !== '') input.workspaceId = body.workspaceId
          const created = await sc.create(input)
          const id = created && (created.sessionId || created.id)
          let header = null
          try { header = query && typeof query.readSession === 'function' ? await query.readSession(id) : null } catch (error) { header = { error: String(error && error.message ? error.message : error).slice(0, 160) } }
          let initialized = null
          try { initialized = await sc.initializeDefaultModel(id) } catch (error) { initialized = String(error && error.message ? error.message : error).slice(0, 160) }
          ok(response, { id, created, initialized, header: header && (header.header || header), keys: header && typeof header === 'object' ? Object.keys(header).slice(0, 20) : [] })
          return
        }
        case 'qq/debug/try-session': {
          const sc = safeGet(ctx, 'sessionController')
          if (!sc || typeof sc.create !== 'function') throw new Error('没有 sessionController')
          const cwd = typeof body?.cwd === 'string' ? body.cwd : 'D:/AI/插件'
          const created = await sc.create({ cwd, title: '调试新建会话' })
          const id = created && (created.sessionId || created.id)
          const steps = []
          for (const attempt of [
            () => sc.initializeDefaultModel(id),
            () => sc.initializeDefaultModel({ sessionId: id }),
            () => sc.selectModel(id, 'default'),
          ]) {
            try { const value = await attempt(); steps.push({ ok: true, value: typeof value === 'object' ? Object.keys(value || {}).slice(0, 10) : String(value).slice(0, 80) }); break }
            catch (error) { steps.push({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 160) }) }
          }
          let prompted = null
          try {
            await sc.prompt({ requestId: 'dbg-' + Date.now().toString(36), sessionId: id, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：在呢' }] }, AbortSignal.timeout(60000))
            prompted = 'ok'
          } catch (error) {
            prompted = String(error && error.message ? error.message : error).slice(0, 160)
          }
          ok(response, { id, created, steps, prompted })
          return
        }
        case 'qq/debug/fn': {
          const serviceName = String(body?.service || '')
          const method = String(body?.method || '')
          const service = safeGet(ctx, serviceName)
          const fn = service && service[method]
          ok(response, { exists: typeof fn === 'function', source: typeof fn === 'function' ? String(fn).slice(0, 2000) : '' })
          return
        }
        case 'qq/debug/create-session': {
          const sc = safeGet(ctx, 'sessionController')
          if (!sc || typeof sc.create !== 'function') throw new Error('没有 sessionController.create')
          const attempts = []
          for (const input of [{ cwd: body?.cwd, title: body?.title }, { cwd: body?.cwd }, { workspace: body?.cwd }, body || {}]) {
            try {
              const created = await sc.create(input)
              attempts.push({ ok: true, input, type: typeof created, keys: created && typeof created === 'object' ? Object.keys(created).slice(0, 30) : [], id: created && (created.id || created.sessionId || (created.header && created.header.id)) })
              break
            } catch (error) {
              attempts.push({ ok: false, input, error: String(error && error.message ? error.message : error).slice(0, 200) })
            }
          }
          ok(response, { attempts })
          return
        }
        case 'qq/peers/rename': {
          const key = typeof body?.key === 'string' ? body.key.trim() : ''
          if (key === '') throw new Error('需要 key')
          ok(response, { renamed: manager.qq().renamePeer(key, body?.name), items: manager.qq().listPeers(200) })
          return
        }
        case 'qq/peers/delete': {
          // 面板那行右边的 ×：只从列表里去掉这个 QQ 聊天（不删记忆、不动它绑定的会话）。
          const key = typeof body?.key === 'string' ? body.key.trim() : ''
          if (key === '') throw new Error('需要 key')
          ok(response, { removed: manager.qq().forgetPeer(key), key, items: manager.qq().listPeers(200) })
          return
        }
        case 'qq/routes': {
          const bridge = manager.bridge()
          const key = typeof body?.key === 'string' ? body.key.trim() : ''
          if (key === '') throw new Error('需要 key（scope:peerId）')
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          const next = { ...(bridge.config.peerSessions || {}) }
          if (sessionId === '') delete next[key]
          else {
            next[key] = sessionId
            try {
              if (typeof manager.setEnabled === 'function') manager.setEnabled(sessionId, true)
            } catch { /* ignore */ }
          }
          ok(response, bridge.replacePeerSessions(next))
          return
        }
        case 'qq/stt-test': {
          const stt = safeGet(ctx, 'speechToText')
          if (!stt || typeof stt.resolve !== 'function') throw new Error('宿主没有 speechToText 服务')
          const wavPath = typeof body?.path === 'string' ? body.path.trim() : ''
          if (wavPath === '') throw new Error('需要 path 指向一个 WAV 文件')
          const wav = readFileSync(wavPath)
          const attempts = []
          for (const audio of [wav, wav.toString('base64')]) {
            const kind = Buffer.isBuffer(audio) ? 'buffer' : 'base64'
            try {
              const spec = stt.resolve({ audio, language: 'auto' })
              const result = await stt.transcribe(spec, AbortSignal.timeout(60000))
              attempts.push({ kind, ok: true, text: result && typeof result.text === 'string' ? result.text : '', keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 12) : [] })
              break
            } catch (error) {
              attempts.push({ kind, ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) })
            }
          }
          ok(response, { attempts })
          return
        }
        case 'qq/bridge/test-voice': {
          const bridge = manager.bridge()
          let peer = bridge.lastPeer
          if (!peer) {
            const file = join(manager.root, 'qq-messages.jsonl')
            if (existsSync(file)) {
              const tail = readFileSync(file, 'utf8').trim().split('\n').slice(-1)[0]
              const last = tail ? JSON.parse(tail) : null
              if (last && last.peerId) peer = { scope: last.scope, peerId: last.peerId, msgId: last.id, at: Date.now() }
            }
          }
          if (!peer) throw new Error('还没有 QQ 会话可测：先在 QQ 里给机器人发一条消息')
          const voicePath = typeof body?.path === 'string' ? body.path.trim() : ''
          if (voicePath === '') throw new Error('需要 path 指向一条 WAV/SILK 语音')
          await bridge.handleInbound({
            id: 'test-voice-' + Date.now().toString(36),
            scope: peer.scope,
            peerId: peer.peerId,
            senderId: peer.peerId,
            senderName: '测试',
            synthetic: true,
            content: '',
            imageCount: 0,
            voiceCount: 1,
            voicePaths: [voicePath],
          })
          ok(response, { injected: true, target: peer, voice: voicePath })
          return
        }
        case 'qq/bridge/test-inject': {
          const bridge = manager.bridge()
          let peer = bridge.lastPeer
          if (!peer) {
            // 重载后 lastPeer 会清空：从消息台账里捞最近一个 QQ 会话
            const file = join(manager.root, 'qq-messages.jsonl')
            if (existsSync(file)) {
              const tail = readFileSync(file, 'utf8').trim().split('\n').slice(-1)[0]
              const last = tail ? JSON.parse(tail) : null
              if (last && last.peerId) peer = { scope: last.scope, peerId: last.peerId, msgId: last.id, at: Date.now() }
            }
          }
          if (!peer) throw new Error('还没有 QQ 会话可测：先在 QQ 里给机器人发一条消息')
          const text = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text.trim() : '【桥接自测】这条是从插件后台注入的，收到请回一句'
          await bridge.handleInbound({
            id: 'test-' + Date.now().toString(36),
            scope: peer.scope,
            peerId: peer.peerId,
            senderId: peer.peerId,
            senderName: '测试',
            synthetic: true,
            content: text,
            imageCount: 0,
            voiceCount: 0,
          })
          ok(response, { injected: true, target: peer })
          return
        }
        case 'qq/voiceprint/auto': {
          const vp = manager.qq().voiceprint
          if (!vp) throw new Error('声纹模块没加载')
          const voicePath = typeof body?.path === 'string' ? body.path.trim() : ''
          if (voicePath === '') throw new Error('需要 path 指向一个 WAV 文件')
          const found = vp.identifyFromFile(voicePath)
          const profileSeconds = vp.totalSeconds(found && found.name)
          const collectThreshold = profileSeconds < vp.config.freeEnrollSeconds
            ? 0
            : (profileSeconds >= vp.config.maxSeconds ? vp.config.autoCollectAboveWhenFull : vp.config.autoCollectAbove)
          const added = found && !found.empty && found.score >= collectThreshold
            ? vp.addSample(found.name, found.embedding)
            : { added: false, reason: 'below-threshold' }
          ok(response, { found, added, status: vp.status() })
          return
        }
        case 'qq/voiceprint/optimize': {
          const vp = manager.qq().voiceprint
          if (!vp) throw new Error('声纹模块没加载')
          ok(response, { report: vp.optimize(), status: vp.status() })
          return
        }
        case 'qq/voiceprint/register': {
          const vp = manager.qq().voiceprint
          if (!vp) throw new Error('声纹模块没加载')
          if (typeof body.path !== 'string' || body.path.trim() === '') throw new Error('需要 path 指向一个 WAV 文件')
          ok(response, { saved: vp.registerFromFile(body.name, body.path.trim()), status: vp.status() })
          return
        }
        case 'qq/voiceprint/identify': {
          const vp = manager.qq().voiceprint
          if (!vp) throw new Error('声纹模块没加载')
          ok(response, vp.identifyFromFile(body.path))
          return
        }
        case 'qq/voiceprint': {
          ok(response, manager.qq().saveConfig({
            voiceprint: {
              enabled: body.enabled,
              threshold: body.threshold,
              autoCollectAbove: body.autoCollectAbove,
              autoCollectAboveWhenFull: body.autoCollectAboveWhenFull,
              freeEnrollSeconds: body.freeEnrollSeconds,
              maxPerName: body.maxPerName,
              maxSeconds: body.maxSeconds,
            },
          }))
          return
        }
        case 'qq/voiceprint/members': {
          ok(response, manager.qq().saveConfig({ voiceprint: { allowedMembers: Array.isArray(body.allowedMembers) ? body.allowedMembers : [] } }))
          return
        }
        case 'qq/voiceprint/sample/delete': {
          const vp = manager.qq().voiceprint
          if (!vp) throw new Error('声纹模块没加载')
          const deleted = vp.removeSample(body.name, body.index)
          ok(response, { deleted, status: vp.status() })
          return
        }
        case 'qq/voiceprint/remove': {
          const removed = manager.qq().voiceprint ? manager.qq().voiceprint.remove(body.name) : false
          ok(response, { removed, status: manager.qq().voiceprint ? manager.qq().voiceprint.status() : null })
          return
        }
        case 'qq/autosticker': {
          ok(response, manager.qq().saveConfig({
            autoSticker: {
              enabled: body.enabled === true,
              minGapMinutes: body.minGapMinutes,
              maxPerHour: body.maxPerHour,
            },
          }))
          return
        }
        case 'qq/stickers/delete': {
          ok(response, manager.qq().deleteSticker(body.id))
          return
        }
        case 'qq/schedule': {
          ok(response, manager.qq().addSchedule(body))
          return
        }
        case 'qq/schedule/delete': {
          ok(response, manager.qq().deleteSchedule(body.id))
          return
        }
        case 'qq/broadcast': {
          ok(response, await manager.qq().broadcast(body))
          return
        }
        case 'qq/card/send': {
          ok(response, await manager.qq().sendCard(body))
          return
        }
        case 'qq/recall': {
          ok(response, await manager.qq().recallMessage(body))
          return
        }
        case 'qq/mute': {
          ok(response, await manager.qq().setMemberMute(body))
          return
        }
        case 'qq/kick': {
          ok(response, await manager.qq().removeMembers(body))
          return
        }
        case 'qq/join-approve': {
          ok(response, await manager.qq().approveJoinRequest(body))
          return
        }
        case 'qq/send': {
          ok(response, await manager.qq().sendTextWithQuote({
            scope: body.scope,
            targetId: body.targetId,
            content: body.content,
            msgId: body.msgId,
            quoteMessageId: body.quoteMessageId,
          }))
          return
        }
        case 'group/memory': {
          // 群成员总体记忆：全体共有，不针对某个人。
          const store = requireStore(manager, sessionId)
          ok(response, store.addGroupMemory(body.text, body.tags, { weight: body.weight }))
          return
        }
        case 'group/memory/delete': {
          const store = requireStore(manager, sessionId)
          ok(response, store.deleteGroupMemory(body.id))
          return
        }
        case 'memory/archive': {
          const store = requireStore(manager, sessionId)
          const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
          const archived = ids.map((id) => store.archiveMemory(id, '通过侧边栏手动归档').id)
          ok(response, { archived: archived.length })
          return
        }
        case 'memory/weight': {
          // 活跃记忆权重 1~100（默认 50）：越高越靠前、越优先占住注入名额。
          const store = requireStore(manager, sessionId)
          ok(response, store.setMemoryWeight(body.id, body.weight))
          return
        }
        case 'memory/pin': {
          const store = requireStore(manager, sessionId)
          ok(response, store.pinMemory(body.id, body.pinned !== false))
          return
        }
        case 'memory/clean': {
          const store = requireStore(manager, sessionId)
          const backup = store.backupState('体检前')
          const before = store.activeMemories()
          const cleaned = await cleanMemories(ctx, before, { sessionId })
          for (const item of cleaned.dropped) {
            try {
              store.archiveMemory(item.id, `记忆体检：${item.reason}`)
            } catch {
              // 单条归档失败不影响其它条目
            }
          }
          const activeById = new Map(
            store.state.memories
              .filter((memory) => memory.archived !== true)
              .map((memory) => [String(memory.id), memory]),
          )
          const reordered = cleaned.memories.map((memory) => activeById.get(String(memory.id))).filter(Boolean)
          const archived = store.state.memories.filter((memory) => memory.archived === true)
          store.state.memories = [...reordered, ...archived]
          if (cleaned.dropped.length > 0) {
            try {
              store.noteCleanedEntries(cleaned.dropped, {
                tag: '记忆体检',
                source: 'panel',
                kept: cleaned.memories.length,
                modelDropped: cleaned.stats.modelDropped,
              })
            } catch {
              // 归档失败不影响整理结果
            }
          }
          store.persist()
          ok(response, { ...cleaned.stats, backup, archived: cleaned.dropped.length })
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
        case 'hierarchy/annual': {
          // 1.1.0-A：手动生成/刷新最新年报
          const store = requireStore(manager, sessionId)
          const result = await buildAnnual(store, ctx, {
            yearNo: Number(body.yearNo),
            force: body.force === true,
            sessionId,
          })
          ok(response, { ...result, sessionId })
          return
        }
        case 'hierarchy/epoch': {
          // 1.1.0-A：手动把旧跨年沉积 + 当前年报融合成新沉积
          const store = requireStore(manager, sessionId)
          ok(response, { ...(await buildEpoch(store, ctx, { sessionId })), sessionId })
          return
        }
        case 'hierarchy/rollback': {
          // 1.1.0-A：回滚到最近一次备份
          const store = requireStore(manager, sessionId)
          ok(response, rollbackHierarchy(store, body.target === 'epoch' ? 'epoch' : 'annual'))
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
          let info = store.autoPackInfo()
          if (body.every !== undefined) info = store.setAutoPackEvery(body.every)
          if (body.everyTokens !== undefined) info = store.setAutoPackEveryTokens(body.everyTokens)
          ok(response, info)
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
          let payload = body.bundle ?? body
          if (!sessionId) throw new Error('没有识别到当前对话，请先在对话列表中选择一个对话。')
          let store = manager.storeFor(sessionId)
          if (!store) throw new Error('该对话的伴侣记忆数据未能初始化。')
          if (!manager.isEnabled(sessionId)) {
            manager.setEnabled(sessionId, true)
            store = manager.storeFor(sessionId)
          }
          // 1.1.0-B：导入前自动整理记忆（规则去重 + 一次模型排序/筛选；失败则按原样导入）
          let cleanResult = null
          let cleanedDropped = []
          if (body.cleanMemory === true && payload && typeof payload === 'object'
            && Array.isArray(payload.state?.memories) && payload.state.memories.length > 0) {
            const backup = store.backupState('导入前')
            try {
              const cleaned = await cleanMemories(ctx, payload.state.memories, { sessionId })
              payload = { ...payload, state: { ...payload.state, memories: cleaned.memories } }
              cleanedDropped = cleaned.dropped
              cleanResult = { ...cleaned.stats, backup, archived: cleaned.dropped.length }
            } catch (error) {
              cleanResult = {
                error: error instanceof Error ? error.message : String(error),
                backup,
              }
            }
          }
          const result = store.importBundle(payload, { merge: body.merge === true })
          // 被归档的条目在导入完成后写进知识库（覆盖导入时 state 会被替换，所以放在 importBundle 之后）
          if (cleanedDropped.length > 0) {
            try {
              store.noteCleanedEntries(cleanedDropped, {
                tag: '导入前整理',
                source: 'import',
                kept: cleanResult?.kept,
                modelDropped: cleanResult?.modelDropped,
              })
              store.persist()
            } catch {
              // 归档失败不影响导入结果
            }
          }
          // 1.1.2：导入后让 AI 把聊天原文「过一遍」，提炼成活跃记忆（失败不影响导入）。
          let digestResult = null
          const digestSettings = resolveImportDigestSettings(manager.config)
          if (digestSettings.enabled && body.digestChat !== false && result.conversationImported > 0) {
            try {
              digestResult = await digestImportedConversation(ctx, store, payload.conversation?.messages, {
                sessionId,
                settings: digestSettings,
              })
            } catch (error) {
              digestResult = { error: error instanceof Error ? error.message : String(error) }
            }
          }
          ok(response, { ...result, sessionId, clean: cleanResult, digest: digestResult })
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
