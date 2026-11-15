/**
 * onebot-setup.js —— 个人号（NapCat）自动安装 + 自动配置。
 *
 * 面板上一个按钮：没有 NapCat 就自动下载解压到插件数据目录，没登录就拉起并给出二维码，
 * 登录后自动补 WebSocket 服务端配置、等端口就绪、回填地址。
 *
 * 目录：优先 {数据根}/napcat；如果机器上已有 D:\AI\NapCat 且完好，就继续用它（兼容老配置）。
 * 配置：{数据根}/onebot-setup.json = { napcatDir }。
 */
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

const NAPCAT_VERSION = 'v4.18.42'
const NAPCAT_ASSET = 'NapCat.Shell.Windows.Node.zip'
const NAPCAT_URLS = [
  'https://github.com/NapNeko/NapCatQQ/releases/download/' + NAPCAT_VERSION + '/' + NAPCAT_ASSET,
  'https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/' + NAPCAT_VERSION + '/' + NAPCAT_ASSET,
  'https://mirror.ghproxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/' + NAPCAT_VERSION + '/' + NAPCAT_ASSET,
]

function isPortOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createOneBotSetup(rootDir) {
  const stateFile = join(rootDir, 'onebot-setup.json')

  const readSetup = () => {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const saveSetup = (patch = {}) => {
    const next = { ...readSetup(), ...patch }
    try {
      mkdirSync(rootDir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch { /* ignore */ }
    return next
  }

  const isInstalledAt = (dir) => existsSync(join(dir, 'app', 'napcat', 'napcat.mjs'))

  /**
   * NapCat shell 是「主进程 + worker 子进程」结构，worker 是 fork 出来的 node 进程。
   * Windows 上 fork 不带 windowsHide 时会新建一个控制台窗口（黑框）；用户一关窗，worker 收到
   * CTRL_CLOSE 直接退出（退出码 0xC000013A），主进程马上自动重拉，于是黑框反复弹。
   * 这里给它补上 windowsHide，幂等：重装 NapCat 后第一次拉起会自动再补一次。
   */
  const WORKER_STDIO_ANCHOR = 'stdio: Nh ? "pipe" : ["inherit", "pipe", "pipe", "ipc"]'
  const patchWorkerWindowless = (dir) => {
    const file = join(dir, 'app', 'napcat', 'napcat.mjs')
    try {
      let text = readFileSync(file, 'utf8')
      if (text.includes('windowsHide: !0, ' + WORKER_STDIO_ANCHOR)) return true
      if (!text.includes(WORKER_STDIO_ANCHOR)) return false
      text = text.replace(WORKER_STDIO_ANCHOR, 'windowsHide: !0, ' + WORKER_STDIO_ANCHOR)
      writeFileSync(file, text, 'utf8')
      return true
    } catch {
      return false
    }
  }

  const napcatDir = () => {
    const configured = String(readSetup().napcatDir || '').trim()
    if (configured !== '') return configured
    if (isInstalledAt('D:\\AI\\NapCat')) return 'D:\\AI\\NapCat'
    return join(rootDir, 'napcat')
  }

  const configDir = () => join(napcatDir(), 'app', 'napcat', 'config')
  const qrcodeFile = () => join(napcatDir(), 'app', 'napcat', 'cache', 'qrcode.png')
  const pidFile = () => join(napcatDir(), 'napcat.pid')
  const readPid = () => {
    try {
      const pid = Number(String(readFileSync(pidFile(), 'utf8')).trim()) || 0
      return pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  /** 下载 + 解压 NapCat 到 {数据根}/napcat。 */
  const installNapcat = async (dir) => {
    mkdirSync(dir, { recursive: true })
    const zip = join(dir, NAPCAT_ASSET)
    let lastError = ''
    for (const url of NAPCAT_URLS) {
      try {
        const response = await fetch(url, { redirect: 'follow' })
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
        await new Promise((resolve, reject) => {
          const out = createWriteStream(zip)
          const reader = response.body.getReader()
          const pump = () => reader.read().then(({ done, value }) => {
            if (done) { out.end(resolve); return }
            out.write(Buffer.from(value), () => pump())
          }).catch(reject)
          out.on('error', reject)
          pump()
        })
        break
      } catch (error) {
        lastError = String(error && error.message ? error.message : error)
      }
    }
    if (!existsSync(zip)) return { ok: false, error: '下载 NapCat 失败：' + lastError }
    const appDir = join(dir, 'app')
    const unzip = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + appDir + "' -Force"], { windowsHide: true })
    if (unzip.status !== 0) return { ok: false, error: '解压 NapCat 失败（' + (unzip.stderr ? unzip.stderr.toString().slice(0, 200) : 'exit ' + unzip.status) + '）' }
    if (!isInstalledAt(dir)) return { ok: false, error: '解压后没找到 app/napcat/napcat.mjs，压缩包结构可能变了' }
    try { writeFileSync(join(dir, '启动NapCat.bat'), '@echo off\r\nchcp 65001 >nul\r\ntitle NapCat\r\ncd /d "%~dp0app"\r\n"%~dp0app\\napcat.bat" -q %1\r\npause\r\n', 'utf8') } catch { /* ignore */ }
    return { ok: true }
  }

  const findOnebotConfig = () => {
    let names = []
    try {
      names = readdirSync(configDir()).filter((name) => /^onebot11_\d+\.json$/.test(name))
    } catch {
      return null
    }
    if (names.length === 0) return null
    names.sort((a, b) => {
      try { return statSync(join(configDir(), a)).mtimeMs - statSync(join(configDir(), b)).mtimeMs } catch { return a.localeCompare(b) }
    })
    const name = names[names.length - 1]
    try {
      const file = join(configDir(), name)
      return { file, uin: name.replace(/^onebot11_/, '').replace(/\.json$/, ''), json: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
    } catch {
      return null
    }
  }

  const readQr = () => {
    try {
      const file = qrcodeFile()
      if (!existsSync(file)) return ''
      const buf = readFileSync(file)
      return buf.length > 0 ? 'data:image/png;base64,' + buf.toString('base64') : ''
    } catch {
      return ''
    }
  }

  /** 保证 NapCat 里有「WebSocket 服务端」，返回 {port, token}。 */
  const ensureServer = (found) => {
    const json = found.json
    if (!json.network || typeof json.network !== 'object') json.network = {}
    if (!Array.isArray(json.network.websocketServers)) json.network.websocketServers = []
    const entry = json.network.websocketServers.find((item) => item && Number(item.port) > 0)
    if (entry) return { port: Number(entry.port), token: String(entry.token || '') }
    const created = { name: 'ai-memory', enable: true, host: '127.0.0.1', port: 6198, messagePostFormat: 'array', reportSelfMessage: false, token: '', enableForcePushEvent: true, debug: false, heartInterval: 30000 }
    json.network.websocketServers.push(created)
    try { writeFileSync(found.file, JSON.stringify(json, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
    return { port: created.port, token: '' }
  }

  const launch = async (dir, uin) => {
    if (await isNapcatRunning()) return true
    const app = join(dir, 'app')
    const nodeExe = join(app, 'node.exe')
    const entry = join(app, 'index.js')
    if (!existsSync(nodeExe) || !existsSync(entry)) return false
    const logFile = join(dir, 'napcat.log')
    try { rmSync(logFile, { force: true }) } catch { /* ignore */ }
    // 旧二维码作废：不然面板会把上一轮的过期码当成新的显示出来。
    try { rmSync(qrcodeFile(), { force: true }) } catch { /* ignore */ }
    let fd = -1
    try {
      // 直接从 DSH 主进程 spawn，windowsHide + detached 走 CREATE_NO_WINDOW：
      // 不建控制台，Windows 11 就不会再把它塞进 Windows Terminal 弹黑框。
      // 之前用 wscript + WScript.Shell.Exec 包一层 cmd，Exec 会新建控制台窗口，所以一直弹黑框。
      // stdout/stderr 直接重定向到日志文件句柄，不加 cmd 包装，进程树也干净。
      fd = openSync(logFile, 'w')
      const args = [entry]
      if (uin) args.push('-q', String(uin))
      const child = spawn(nodeExe, args, {
        cwd: app,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      })
      child.unref()
      try { writeFileSync(pidFile(), String(child.pid || 0), 'utf8') } catch { /* ignore */ }
      try { saveSetup({ napcatPid: child.pid || 0 }) } catch { /* ignore */ }
      return true
    } catch {
      return false
    } finally {
      if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } }
    }
  }

  const getState = async () => {
    const dir = napcatDir()
    const found = findOnebotConfig()
    const port = found ? Number((found.json.network?.websocketServers || []).find((item) => Number(item?.port) > 0)?.port || 0) : 0
    const running = port > 0 ? await isPortOpen(port).catch(() => false) : false
    const webui = await isPortOpen(6099).catch(() => false)
    return {
      napcatDir: dir,
      installed: isInstalledAt(dir),
      // 有配置只代表登录过；真正「在线」要看 WS 端口通不通，否则前端会一直以为已登录、不出二维码。
      loggedIn: Boolean(found) && running,
      hasAccount: Boolean(found),
      uin: found ? found.uin : '',
      port,
      running,
      webui,
      hasQr: readQr() !== '',
      wsUrl: port > 0 ? 'ws://127.0.0.1:' + port : '',
    }
  }

  /**
   * 一键：装 NapCat → 没登录就出二维码 → 补 WS → 等端口 → 返回 ws 地址。
   * options.restart = false 时只「死了才拉起」，不会去杀一个活着但还没登录的 NapCat：
   * 后台看门狗走这条路，不然没扫码的时候它每分钟杀掉重拉一次，二维码一直换、还每回弹黑框。
   */
  const autoConfigure = async (options = {}) => {
    const restart = options.restart !== false
    const dir = napcatDir()
    if (!isInstalledAt(dir)) {
      const installed = await installNapcat(dir)
      if (!installed.ok) return installed
    }
    let found = findOnebotConfig()
    if (!found) {
      await launch(dir, '')
      let qr = ''
      for (let i = 0; i < 25 && qr === ''; i += 1) {
        await sleep(600)
        qr = readQr()
      }
      return { ok: false, needLogin: qr !== '', qr, error: qr === '' ? 'NapCat 已拉起但二维码还没出来，再点一次或者看 NapCat 窗口' : '' }
    }
    const server = ensureServer(found)
    const open = await isPortOpen(server.port).catch(() => false)
    let launched = false
    if (!open) {
      if (restart === false && (await isNapcatRunning())) {
        // 进程还活着，只是没登录：保留现场，二维码也别换，等扫码
        return { ok: false, needLogin: true, qr: readQr(), error: 'NapCat 在跑但还没登录，扫面板上这张码就行' }
      }
      // 没连上（多半是登录态失效）：先收掉旧进程，再拉一次，拿到的一定是刚生成的二维码。
      if (restart) {
        killNapcat()
        await sleep(1200)
      }
      launched = await launch(dir, found.uin)
      if (!launched) return { ok: false, error: '拉起 NapCat 失败（找不到 app\\node.exe 或 app\\index.js）' }
    }
    let ready = open
    for (let i = 0; i < 40 && !ready; i += 1) {
      await sleep(800)
      ready = await isPortOpen(server.port).catch(() => false)
    }
    if (!ready) return { ok: false, needLogin: true, qr: readQr(), error: 'NapCat 还没登录（端口没起来），扫码后会自动继续' }
    return { ok: true, launched, uin: found.uin, port: server.port, token: server.token, wsUrl: 'ws://127.0.0.1:' + server.port }
  }

  /** NapCat 进程是否已经在跑：只看上次拉起的 pid（走 pid 文件，不调 PowerShell，避免闪黑框）。 */
  const isNapcatRunning = async () => {
    if (await isPortOpen(6099).catch(() => false)) return true
    const pid = readPid()
    if (pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 只关掉 NapCat 自己的进程树（cmd → node → QQ 子进程），不碰 DSH 的进程。 */
  const killNapcat = () => {
    const pid = readPid()
    if (pid > 0) {
      // 拉起时包了一层 cmd，单杀 pid 会留下 node 子进程，必须连树一起杀。
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
      try { saveSetup({ napcatPid: 0 }) } catch { /* ignore */ }
    }
    try { rmSync(pidFile(), { force: true }) } catch { /* ignore */ }
    return true
  }

  /** 插件启动时预热：没装就提前下载好（失败不影响其它功能）。 */
  const ensureInstalled = async () => {
    const dir = napcatDir()
    if (isInstalledAt(dir)) return { ok: true, installed: true }
    return installNapcat(dir)
  }

  /** 更换 QQ 号：停掉 NapCat、清掉快速登录缓存、重新拉起并出二维码。 */
  const switchAccount = async () => {
    const dir = napcatDir()
    if (!isInstalledAt(dir)) {
      const installed = await installNapcat(dir)
      if (!installed.ok) return installed
    }
    killNapcat()
    await sleep(1500)
    try {
      const cache = join(dir, 'app', 'napcat', 'cache')
      if (existsSync(cache)) rmSync(cache, { recursive: true, force: true })
    } catch { /* ignore */ }
    await launch(dir, '').catch(() => {})
    let qr = ''
    for (let i = 0; i < 25 && qr === ''; i += 1) {
      await sleep(600)
      qr = readQr()
    }
    return { ok: false, needLogin: true, switched: true, qr, error: qr === '' ? '已重启 NapCat，但二维码还没出来，稍后再点一次' : '' }
  }

  // 源码构建 / 应用那一套（napcat-source.js）要用：停进程、拉起、查状态。
  return {
    getState,
    autoConfigure,
    saveSetup,
    napcatDir,
    qr: readQr,
    installNapcat,
    ensureInstalled,
    switchAccount,
    killNapcat,
    launch,
    isNapcatRunning,
    findOnebotConfig,
    readPid,
  }
}
