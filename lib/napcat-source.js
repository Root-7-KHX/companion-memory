/**
 * napcat-source.js —— 「个人号接入」页里的「本地源码」卡片后端。
 *
 * 管的就是个人号根目录（默认 D:\AI\NapCat）下面这几块：
 *   source\NapCatQQ   本地源码（构建脚本 build.mjs 在里面）
 *   dist\builds\…     构建产物 + manifest
 *   app\napcat        安装版运行件（只替换 bundle 文件，替换前备份到 app\napcat_bak）
 *
 * 职责：读状态、校验补丁、起构建（后台跑 build.mjs）、应用最近一次构建、回滚备份。
 * 全部只在本机操作，不联网（构建时的 pnpm install 除外）。
 */
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找一个能跑 build.mjs 的 node.exe。
 * 插件跑在 DSH 主进程里，process.execPath 是 DSH.exe，不能直接当 node 用。
 * 优先 DSH 运行时里的 node（版本新，pnpm 10 要 >= 22.13），再退到 NapCat 自带的 app\node.exe
 * （它是 22.11，单独用它跑 build.mjs 可以，但 build.mjs 会自己再挑够新的 node 去跑 pnpm）。
 */
function findNodeBinary(fallbackDir) {
  const candidates = []
  const isNode = (file) => /(^|[\\/])node(\.exe)?$/i.test(file)
  const push = (file) => {
    if (!file) return
    if (existsSync(file) && isNode(file) && !candidates.includes(file)) candidates.push(file)
  }
  push(process.env.NAPCAT_NODE)
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  const runtimes = join(dshHome, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    try {
      const names = readdirSync(runtimes).sort((a, b) => (a === 'dsh-primary-runtime' ? -1 : b === 'dsh-primary-runtime' ? 1 : 0))
      for (const name of names) {
        push(join(runtimes, name, 'dependencies', 'node', 'bin', 'node.exe'))
        push(join(runtimes, name, 'dependencies', 'node', 'node.exe'))
      }
    } catch { /* ignore */ }
  }
  if (fallbackDir) push(join(fallbackDir, 'app', 'node.exe'))
  if (isNode(process.execPath)) push(process.execPath)
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (dir.trim() === '') continue
    push(join(dir.trim(), 'node.exe'))
  }
  return candidates[0] || ''
}
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function dirStats(dir, options = {}) {
  const skip = new Set(options.skip || [])
  let bytes = 0
  let files = 0
  let dirs = 0
  let unreadable = 0
  const walk = (current) => {
    let names = []
    try {
      names = readdirSync(current)
    } catch {
      unreadable += 1
      return
    }
    for (const name of names) {
      if (skip.has(name)) continue
      const full = join(current, name)
      let info = null
      try {
        info = statSync(full)
      } catch {
        unreadable += 1
        continue
      }
      if (info.isDirectory()) {
        dirs += 1
        walk(full)
      } else {
        files += 1
        bytes += info.size
      }
    }
  }
  walk(dir)
  return { bytes, files, dirs, unreadable }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

function isAlive(pid) {
  const value = Number(pid) || 0
  if (value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch {
    return false
  }
}

function tailLines(text, max) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.slice(-max)
}

/**
 * @param {object} setup createOneBotSetup 的返回值（要带 napcatDir / killNapcat / launch / getState）
 */
export function createNapcatSource(setup) {
  const state = {
    building: null, // { pid, startedAt, logFile, child }
    lastBuild: null, // { ok, code, startedAt, endedAt, output }
    lastApply: null,
    lastRestore: null,
    nodePath: '',
  }

  const rootDir = () => setup.napcatDir()
  const nodeBinary = () => {
    if (!state.nodePath) state.nodePath = findNodeBinary(rootDir())
    if (!state.nodePath) throw new Error('找不到 node.exe（可设置 NAPCAT_NODE 环境变量指过去）')
    return state.nodePath
  }
  // build.mjs 里还要跑 pnpm / vite，子进程得能从 PATH 里找到 node。
  const buildEnv = () => {
    const bin = nodeBinary()
    const path = dirname(bin) + ';' + (process.env.PATH || '')
    return { ...process.env, PATH: path, NAPCAT_DIST_DIR: distRoot(), NAPCAT_INSTALL_DIR: rootDir() }
  }
  const sourceDir = () => join(rootDir(), 'source', 'NapCatQQ')
  const buildFile = () => join(sourceDir(), 'build.mjs')
  const distRoot = () => join(rootDir(), 'dist')
  const lockFile = () => join(distRoot(), '.building.json')
  const logFile = () => join(distRoot(), 'build.log')
  const latestFile = () => join(distRoot(), 'latest.json')
  const installNapcatDir = () => join(rootDir(), 'app', 'napcat')
  const backupRoot = () => join(rootDir(), 'app', 'napcat_bak')
  const installedBundle = () => join(installNapcatDir(), 'napcat.mjs')

  const releaseVersion = () => {
    const text = readText(buildFile())
    const hit = /RELEASE_VERSION\s*=\s*'([^']+)'/.exec(text)
    return hit ? hit[1] : ''
  }

  const installedInfo = () => {
    const file = installedBundle()
    if (!existsSync(file)) return { installed: false, patched: false, version: '', bytes: 0 }
    const size = (() => { try { return statSync(file).size } catch { return 0 } })()
    const text = readText(file)
    const hit = /"(\d+\.\d+\.\d+)"\s*\|\|\s*"1\.0\.0-dev"/.exec(text)
    return {
      installed: true,
      patched: text.includes('windowsHide: !0') || text.includes('windowsHide:!0'),
      version: hit ? hit[1] : '',
      bytes: size,
    }
  }

  const sourceInfo = () => {
    const dir = sourceDir()
    if (!existsSync(dir)) return { exists: false, bytes: 0, files: 0, version: releaseVersion(), patched: false, processPatched: false, buildScript: false }
    // 体积只算源码：node_modules 和 packages/*/dist 这类构建产物不计进去，不然瘦身后的数字会被重建产物撑大。
    const stats = dirStats(dir, { skip: ['node_modules', '.pnpm-store', 'dist'] })
    const napcatTs = readText(join(dir, 'packages', 'napcat-shell', 'napcat.ts'))
    const processApi = readText(join(dir, 'packages', 'napcat-shell', 'process-api.ts'))
    return {
      exists: true,
      bytes: stats.bytes,
      files: stats.files,
      version: releaseVersion(),
      patched: napcatTs.includes('windowsHide: true'),
      processPatched: processApi.includes('windowsHide?: boolean'),
      buildScript: existsSync(buildFile()),
      hasNodeModules: existsSync(join(dir, 'node_modules')),
      prunedNote: existsSync(join(rootDir(), 'source', '_backup', 'pruned-files.json')),
    }
  }

  const latestInfo = () => {
    const latest = readJson(latestFile())
    if (!latest) return null
    const bundleDir = latest.bundleDir || (latest.latestBuildDir ? join(latest.latestBuildDir, 'bundle') : '')
    return {
      version: latest.version || '',
      builtAt: latest.builtAt || '',
      bundleDir,
      bundleBytes: latest.bundleBytes || 0,
      bundleFiles: Array.isArray(latest.bundleFiles) ? latest.bundleFiles.length : 0,
      checks: latest.checks || {},
      sourceDir: latest.sourceDir || '',
      exists: bundleDir !== '' && existsSync(join(bundleDir, 'napcat.mjs')),
    }
  }

  const listBuilds = (limit = 8) => {
    const dir = join(distRoot(), 'builds')
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter((name) => existsSync(join(dir, name, 'manifest.json')))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((name) => {
          const manifest = readJson(join(dir, name, 'manifest.json')) || {}
          return {
            id: name,
            version: manifest.version || '',
            builtAt: manifest.builtAt || '',
            bundleBytes: manifest.bundleBytes || 0,
            bundleFiles: Array.isArray(manifest.bundleFiles) ? manifest.bundleFiles.length : 0,
          }
        })
    } catch {
      return []
    }
  }

  const listBackups = (limit = 5) => {
    const dir = backupRoot()
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .sort()
        .reverse()
        .slice(0, limit)
        .map((name) => {
          const manifest = readJson(join(dir, name, 'manifest.json')) || {}
          return { id: name, version: manifest.version || '', at: manifest.at || '', files: Array.isArray(manifest.files) ? manifest.files.length : 0 }
        })
    } catch {
      return []
    }
  }

  const buildingInfo = () => {
    // 内存里的任务优先；插件重载后靠锁文件 + pid 判断。
    if (state.building && state.building.child) {
      const startedAt = state.building.startedAt
      return {
        running: true,
        startedAt,
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
        logTail: state.building.logTail.slice(-12),
      }
    }
    const lock = readJson(lockFile())
    if (lock && isAlive(lock.pid)) {
      const text = readText(logFile())
      return {
        running: true,
        startedAt: lock.startedAt || '',
        elapsedMs: lock.startedAt ? Date.now() - new Date(lock.startedAt).getTime() : 0,
        logTail: tailLines(text, 12),
      }
    }
    return {
      running: false,
      startedAt: '',
      elapsedMs: 0,
      logTail: state.lastBuild ? tailLines(state.lastBuild.output, 12) : [],
      // 插件重载后内存里的 lastBuild 会丢：锁文件里留了上次的结束时间和退出码，照样能显示。
      lastBuild: state.lastBuild
        ? { ok: state.lastBuild.ok, code: state.lastBuild.code, startedAt: state.lastBuild.startedAt, endedAt: state.lastBuild.endedAt, logTail: tailLines(state.lastBuild.output, 12) }
        : (lock && lock.endedAt
            ? { ok: Number(lock.code) === 0, code: Number(lock.code), startedAt: lock.startedAt || '', endedAt: lock.endedAt, logTail: tailLines(readText(logFile()), 12) }
            : null),
      lastApply: state.lastApply,
      lastRestore: state.lastRestore,
    }
  }

  const info = () => ({
    rootDir: rootDir(),
    sourceDir: sourceDir(),
    distRoot: distRoot(),
    installDir: installNapcatDir(),
    nodePath: (() => { try { return nodeBinary() } catch { return '' } })(),
    source: sourceInfo(),
    installed: installedInfo(),
    latest: latestInfo(),
    builds: listBuilds(),
    backups: listBackups(),
    building: buildingInfo(),
    fixHint: '重建：装依赖（首次联网）→ 构建 napcat.mjs → 收进 dist；应用：停 NapCat → 备份 → 替换 bundle → 拉起。源码和配置分开，改配置不用重建。',
  })

  /** 补丁 / 环境校验：面板「校验」按钮。 */
  const verify = () => {
    const source = sourceInfo()
    const installed = installedInfo()
    const latest = latestInfo()
    const checks = [
      { id: 'source', label: '源码目录存在', ok: source.exists, detail: sourceDir() },
      { id: 'build-script', label: '构建脚本 build.mjs', ok: source.buildScript, detail: source.buildScript ? buildFile() : '缺失' },
      { id: 'source-patch', label: '源码 worker fork 补丁', ok: source.patched, detail: 'napcat-shell/napcat.ts 的 windowsHide: true' },
      { id: 'process-patch', label: '源码 fork 透传补丁', ok: source.processPatched, detail: 'process-api.ts 的 windowsHide?: boolean' },
      { id: 'installed', label: '安装版已就位', ok: installed.installed, detail: installedInstalledText(installed) },
      { id: 'installed-patch', label: '安装版 bundle 补丁', ok: installed.patched, detail: installed.patched ? 'napcat.mjs 里 windowsHide 在位' : '缺补丁：覆盖安装后会弹黑框' },
      { id: 'latest-build', label: '有可用的构建产物', ok: Boolean(latest && latest.exists), detail: latest ? latest.bundleDir : '还没构建过' },
    ]
    return { checks, ok: checks.every((item) => item.ok) }
  }

  const installedInstalledText = (installed) => {
    if (!installed.installed) return 'app\\napcat\\napcat.mjs 不存在'
    return 'v' + (installed.version || '?') + ' · ' + (installed.bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  /** 后台起一次构建（build.mjs 自己管依赖安装 / 前端静态资源 / 产物校验）。 */
  const startBuild = (options = {}) => {
    if (state.building && state.building.child) return { started: false, already: true, message: '已经在构建了' }
    const lock = readJson(lockFile())
    if (lock && isAlive(lock.pid)) return { started: false, already: true, message: '另一个构建进程还在跑（pid ' + lock.pid + '）' }
    if (!existsSync(buildFile())) throw new Error('找不到源码构建脚本：' + buildFile())
    mkdirSync(distRoot(), { recursive: true })
    const args = [buildFile(), '--json']
    if (options.install === true) args.push('--install')
    if (options.webui === true) args.push('--webui')
    const startedAt = new Date().toISOString()
    const fd = openSync(logFile(), 'w')
    const child = spawn(nodeBinary(), args, {
      cwd: sourceDir(),
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: buildEnv(),
    })
    closeSync(fd)
    const building = { pid: child.pid || 0, startedAt, child, logTail: [], output: '' }
    state.building = building
    try {
      writeFileSync(lockFile(), JSON.stringify({ pid: child.pid || 0, startedAt, sourceDir: sourceDir() }, null, 2) + '\n', 'utf8')
    } catch { /* ignore */ }
    const collector = setInterval(() => {
      try {
        building.logTail = tailLines(readText(logFile()), 40)
      } catch { /* ignore */ }
    }, 1500)
    if (typeof collector.unref === 'function') collector.unref()
    const finish = (code) => {
      try { clearInterval(collector) } catch { /* ignore */ }
      const output = readText(logFile())
      state.lastBuild = { ok: code === 0, code, startedAt, endedAt: new Date().toISOString(), output }
      state.building = null
      try { cpSync(logFile(), join(distRoot(), 'build-' + stamp() + '.log')) } catch { /* ignore */ }
      try { writeFileSync(lockFile(), JSON.stringify({ pid: 0, startedAt, endedAt: new Date().toISOString(), code }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
    }
    child.on('close', finish)
    child.on('error', () => finish(-1))
    return { started: true, pid: child.pid || 0, startedAt, logFile: logFile() }
  }

  /** 应用最近一次构建：停 NapCat → build.mjs --apply-only（备份+替换）→ 重新拉起 → 等端口。 */
  const applyLatest = async () => {
    if (state.building && state.building.child) throw new Error('正在构建，等构建完再应用')
    const latest = latestInfo()
    if (!latest || !latest.exists) throw new Error('还没有可用的构建产物，先点「从源码重建」')
    const before = await setup.getState()
    // 没登录时 WS 端口本来就不通（state.running 为 false），但进程是活着的：
    // 判断要不要停，看进程/WebUI，不看 WS 端口，否则会边跑边替换文件。
    const alive = await Promise.resolve(setup.isNapcatRunning ? setup.isNapcatRunning() : null).catch(() => null)
    const wasRunning = alive === null ? Boolean(before && (before.running || before.webui)) : Boolean(alive)
    if (wasRunning) {
      setup.killNapcat()
      await sleep(1500)
    }
    const applied = spawnSync(nodeBinary(), [buildFile(), '--apply-only', '--json'], {
      cwd: sourceDir(),
      windowsHide: true,
      encoding: 'utf8',
      env: buildEnv(),
      timeout: 120000,
    })
    const stdout = String(applied.stdout || '')
    const stderr = String(applied.stderr || '')
    if (applied.status !== 0) throw new Error('替换失败（exit ' + applied.status + '）：' + tailLines(stderr || stdout, 3).join(' / '))
    const launched = await setup.launch(rootDir(), (before && before.uin) || '')
    let after = null
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000)
      after = await setup.getState().catch(() => null)
      if (after && after.webui) break
    }
    const patched = installedInfo().patched
    const result = {
      ok: Boolean(launched) && patched,
      appliedVersion: latest.version,
      appliedAt: new Date().toISOString(),
      restarted: wasRunning,
      launched,
      patched,
      state: after,
      output: tailLines(stdout, 8),
    }
    state.lastApply = result
    return result
  }

  /** 回滚到最近一次替换前的备份。 */
  const restoreLatest = async () => {
    const backups = listBackups(1)
    if (backups.length === 0) throw new Error('还没有备份（第一次用「应用」时会自动备份）')
    const backupDir = join(backupRoot(), backups[0].id)
    const manifest = readJson(join(backupDir, 'manifest.json')) || {}
    const files = Array.isArray(manifest.files) ? manifest.files : []
    if (files.length === 0) throw new Error('备份里没有文件清单：' + backupDir)
    const before = await setup.getState()
    const alive = await Promise.resolve(setup.isNapcatRunning ? setup.isNapcatRunning() : null).catch(() => null)
    const wasRunning = alive === null ? Boolean(before && (before.running || before.webui)) : Boolean(alive)
    if (wasRunning) {
      setup.killNapcat()
      await sleep(1500)
    }
    for (const rel of files) {
      const from = join(backupDir, rel)
      if (!existsSync(from)) continue
      const to = join(installNapcatDir(), rel)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to)
    }
    const launched = await setup.launch(rootDir(), (before && before.uin) || '')
    const result = {
      ok: true,
      restoredFrom: backupDir,
      restoredVersion: backups[0].version || '',
      files: files.length,
      launched,
      state: await setup.getState().catch(() => null),
    }
    state.lastRestore = result
    return result
  }

  /** 在资源管理器里打开某个目录：source | dist | install | installnapcat | backup */
  const openDir = (kind = 'source') => {
    const map = {
      source: sourceDir(),
      dist: distRoot(),
      install: rootDir(),
      installnapcat: installNapcatDir(),
      backup: backupRoot(),
    }
    const dir = map[kind] || sourceDir()
    if (!existsSync(dir)) throw new Error('目录不存在：' + dir)
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return { dir }
  }

  return { info, verify, startBuild, applyLatest, restoreLatest, openDir, sourceDir, distRoot, installNapcatDir }
}
