/**
 * 「从 GitHub 获取插件」目录（Host 侧）。
 *
 * 匿名读取几个公开仓库的最新 Release / 分支归档信息，给「接入软件」页的卡片和详情页用。
 * 只读取信息和下载链接，**不下载、不安装、不执行**任何东西（下载是浏览器行为）。
 *
 * 数据源优先级：
 *   ① GitHub REST API（/releases?per_page=1）——信息最全；
 *   ② 匿名 API 限流（60 次/小时，共享出口 IP 很容易打满）或网络失败时，自动回退到
 *      releases.atom（版本/时间/发布说明）+ releases/expanded_assets（资产列表）
 *      + 仓库 HTML（description/default_branch）——这些页面不走 API 配额。
 *
 * 结果内存缓存 10 分钟；单个仓库失败只让该条目带 error，不影响其它仓库。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 默认「收录的插件」清单（只列作者自己收录的仓库；AI记忆 自己不进下载区）。
 * 用户可以在 {数据根目录}/github-plugins.json 里维护自己的清单：加插件只改那个文件，不用改代码。
 * 字段：owner / repo / name / intro（中文简介，优先于仓库英文 description）。
 */
export const DEFAULT_GITHUB_PLUGINS = [
  {
    owner: 'Root-7-KHX',
    repo: 'ai-voice',
    name: 'AI语音',
    intro: '本地音色工作台：文字描述造声音、录音/参考音复刻、哭腔笑声等情绪表演，内置 9 个本地 TTS 引擎，可导出音频。',
  },
  {
    owner: 'Root-7-KHX',
    repo: 'habit-hint',
    name: '习惯提示小模型',
    intro: '本地 0.6B 小模型：每几轮读最近聊天，生成「习惯 / 重点 / 提示语」注入系统提示词，按对话条数自动触发训练。',
  },
]

const MANIFEST_FILE_NAME = 'github-plugins.json'

const CACHE_TTL_MS = 10 * 60 * 1000
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30000
const USER_AGENT = 'companion-memory-github-catalog (+https://github.com/Root-7-KHX/companion-memory)'

let cache = null
let apiLimitedUntil = 0

// ── 小工具 ────────────────────────────────────────────────────────────────

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripHtml(html) {
  // 先解 HTML 实体（atom 里 content 是「转义过的 HTML」），再把标签换成换行/删掉
  return decodeEntities(String(html || ''))
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|td|th)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 读/建「收录清单」{数据根目录}/github-plugins.json；不存在就写一份默认的，方便用户以后自己加。 */
function loadPluginList(options = {}) {
  const dataDir = typeof options.dataDir === 'string' && options.dataDir.trim() !== '' ? options.dataDir.trim() : ''
  if (dataDir === '') {
    return { list: DEFAULT_GITHUB_PLUGINS.slice(), file: '', source: 'default', error: '' }
  }
  const file = join(dataDir, MANIFEST_FILE_NAME)
  const normalize = (raw) => {
    const list = []
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== 'object') continue
      const owner = typeof item.owner === 'string' ? item.owner.trim() : ''
      const repo = typeof item.repo === 'string' ? item.repo.trim() : ''
      if (owner === '' || repo === '') continue
      list.push({
        owner,
        repo,
        name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : repo,
        intro: typeof item.intro === 'string' ? item.intro.trim() : '',
      })
    }
    return list
  }
  try {
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(file, JSON.stringify(DEFAULT_GITHUB_PLUGINS, null, 2) + '\n', 'utf8')
      return { list: DEFAULT_GITHUB_PLUGINS.slice(), file, source: 'created', error: '' }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const list = normalize(parsed)
    if (list.length === 0) {
      return { list: DEFAULT_GITHUB_PLUGINS.slice(), file, source: 'default-empty', error: '收录清单是空的，已回退到默认两条' }
    }
    return { list, file, source: 'manifest', error: '' }
  } catch (error) {
    return {
      list: DEFAULT_GITHUB_PLUGINS.slice(),
      file,
      source: 'default-bad',
      error: '收录清单读取失败，已回退到默认两条：' + String(error && error.message ? error.message : error).slice(0, 200),
    }
  }
}

/** 清单文件的 mtime:size 签名：用户改了 github-plugins.json 就立刻绕过 10 分钟缓存。 */
function manifestSignature(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return 'none'
  try {
    const st = statSync(join(dataDir.trim(), MANIFEST_FILE_NAME))
    return String(st.mtimeMs) + ':' + String(st.size)
  } catch {
    return 'missing'
  }
}

async function httpGet(url, accept) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text, headers: response.headers }
  } finally {
    clearTimeout(timer)
  }
}

function profileDir() {
  const fromEnv = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (fromEnv !== '') return fromEnv
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== '' ? process.env.DSH_PROFILE.trim() : 'desktop'
  return join(home, 'profiles', profile)
}

/** 本机已安装版本（从 profile 的 node_modules/@local/<repo>/package.json 读；读不到空字符串）。 */
function readLocalVersion(info) {
  try {
    const file = join(profileDir(), 'node_modules', '@local', info.repo, 'package.json')
    if (!existsSync(file)) return ''
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

function markApiLimited() {
  apiLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
}

// ── ① REST API 路径 ─────────────────────────────────────────────────────────

async function fetchReleaseViaApi(info) {
  const url = `https://api.github.com/repos/${info.owner}/${info.repo}/releases?per_page=1`
  const res = await httpGet(url, 'application/vnd.github+json')
  if (res.status === 403 || res.status === 429) {
    // 匿名配额打满（共享出口 IP 很容易）→ 冷却期内全部走网页接口
    markApiLimited()
    return { kind: 'blocked' }
  }
  if (res.status === 404) return { kind: 'none' }
  if (!res.ok) throw new Error('GitHub API HTTP ' + res.status)
  let list = null
  try {
    list = JSON.parse(res.text)
  } catch {
    throw new Error('GitHub API 返回不是 JSON')
  }
  if (!Array.isArray(list) || list.length === 0) return { kind: 'none' }
  const release = list[0] || {}
  const assets = Array.isArray(release.assets)
    ? release.assets.map((asset) => ({
      name: String(asset.name || ''),
      size: Number(asset.size) || 0,
      url: String(asset.browser_download_url || ''),
    })).filter((asset) => asset.name !== '' && asset.url !== '')
    : []
  return {
    kind: 'release',
    data: {
      version: String(release.tag_name || release.name || ''),
      publishedAt: String(release.published_at || release.created_at || ''),
      notes: String(release.body || '').slice(0, 4000),
      assets,
    },
  }
}

async function fetchRepoInfoViaApi(info) {
  const url = `https://api.github.com/repos/${info.owner}/${info.repo}`
  const res = await httpGet(url, 'application/vnd.github+json')
  if (res.status === 403 || res.status === 429) {
    markApiLimited()
    return { kind: 'blocked' }
  }
  if (!res.ok) return { kind: 'none' }
  try {
    const repo = JSON.parse(res.text)
    return {
      kind: 'repo',
      data: {
        description: String(repo.description || ''),
        defaultBranch: String(repo.default_branch || 'main'),
      },
    }
  } catch {
    return { kind: 'none' }
  }
}

// ── ② 网页/Atom 回退路径（不走 API 配额） ────────────────────────────────────

async function fetchAssetsViaHtml(info, tag) {
  if (!tag) return []
  const url = `https://github.com/${info.owner}/${info.repo}/releases/expanded_assets/${encodeURIComponent(tag)}`
  const res = await httpGet(url)
  if (!res.ok) return []
  const assets = []
  const rows = String(res.text).split(/<li /).slice(1)
  const units = { Bytes: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }
  for (const row of rows) {
    const hrefMatch = row.match(/href="(\/[^"]+\/releases\/download\/[^"]+)"/)
    if (!hrefMatch) continue
    const path = decodeEntities(hrefMatch[1])
    const fileName = path.split('/').pop() || ''
    const nameMatch = row.match(/<span class="text-bold">([^<]+)<\/span>/)
    const sizeMatch = row.match(/([\d.]+)\s*(Bytes|KB|MB|GB)<\/span>/)
    const size = sizeMatch ? Math.round(Number(sizeMatch[1]) * (units[sizeMatch[2]] || 1)) : 0
    assets.push({
      name: nameMatch ? decodeEntities(nameMatch[1]).trim() : fileName,
      size,
      url: 'https://github.com' + path,
    })
  }
  const seen = new Set()
  return assets.filter((asset) => {
    if (seen.has(asset.url)) return false
    seen.add(asset.url)
    return true
  })
}

async function fetchReleaseViaHtml(info) {
  const res = await httpGet(`https://github.com/${info.owner}/${info.repo}/releases.atom`, 'application/atom+xml')
  if (!res.ok) return { kind: 'none' }
  const entry = String(res.text).match(/<entry>([\s\S]*?)<\/entry>/)
  if (!entry) return { kind: 'none' }
  const block = entry[1]
  const tagMatch = block.match(/releases\/tag\/([^"']+)/) || block.match(/<title>([^<]+)<\/title>/)
  const tag = tagMatch ? decodeEntities(tagMatch[1]).trim() : ''
  if (tag === '') return { kind: 'none' }
  const publishedMatch = block.match(/<updated>([^<]+)<\/updated>/)
  const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)
  const notes = contentMatch ? stripHtml(contentMatch[1]).slice(0, 4000) : ''
  return {
    kind: 'release',
    data: {
      version: tag,
      publishedAt: publishedMatch ? publishedMatch[1].trim() : '',
      notes,
      assets: await fetchAssetsViaHtml(info, tag),
    },
  }
}

async function fetchRepoViaHtml(info) {
  const res = await httpGet(`https://github.com/${info.owner}/${info.repo}`)
  if (!res.ok) return { description: '', defaultBranch: 'main' }
  const text = String(res.text)
  const descMatch = text.match(/<meta name="description" content="([^"]*)"/) || text.match(/<meta property="og:description" content="([^"]*)"/)
  const branchMatch = text.match(/"defaultBranch":"([^"]+)"/)
  let description = descMatch ? decodeEntities(descMatch[1]).trim() : ''
  // 去掉 GitHub 自动附加的「 - owner/repo」尾巴
  description = description.replace(/\s+-\s+[^\s-]+\/[^\s-]+$/, '').trim()
  return {
    description,
    defaultBranch: branchMatch ? decodeEntities(branchMatch[1]).trim() : 'main',
  }
}

// ── 组装 ───────────────────────────────────────────────────────────────────

/** 首选资产：优先 .tgz，其次 .zip，再其次第一个资产；都没有返回 null。 */
function preferredAsset(assets) {
  const list = Array.isArray(assets) ? assets : []
  return list.find((asset) => /\.tgz$/i.test(asset.name))
    || list.find((asset) => /\.tar\.gz$/i.test(asset.name))
    || list.find((asset) => /\.zip$/i.test(asset.name))
    || list[0]
    || null
}

async function fetchOne(info) {
  const base = {
    id: info.repo,
    name: info.name || info.repo,
    owner: info.owner,
    repo: info.repo,
    plugin: info.plugin || ('@local/' + info.repo),
    homepage: info.homepage || ('https://github.com/' + info.owner + '/' + info.repo),
    intro: info.intro || '',
    localVersion: readLocalVersion(info),
  }

  let release = null
  let repoInfo = null

  // ① API（若未被限流冷却）
  if (Date.now() >= apiLimitedUntil) {
    try {
      const apiRelease = await fetchReleaseViaApi(info)
      if (apiRelease.kind === 'release') release = apiRelease.data
      else if (apiRelease.kind === 'none') {
        const apiRepo = await fetchRepoInfoViaApi(info)
        if (apiRepo.kind === 'repo') repoInfo = apiRepo.data
      }
    } catch {
      // 网络异常：交给下面的网页回退再试一次
    }
  }

  // ② 网页回退（API 限流 / 失败 / 没拿到 Release 时）
  if (!release) {
    const htmlRelease = await fetchReleaseViaHtml(info)
    if (htmlRelease.kind === 'release') release = htmlRelease.data
  }
  // 仓库说明 / 默认分支：API 没拿到就用仓库 HTML 补一次（有 Release 时也要，卡片上要显示说明）
  if (!repoInfo) repoInfo = await fetchRepoViaHtml(info)

  const branch = (repoInfo && repoInfo.defaultBranch) || 'main'
  const assets = release ? release.assets : []
  const preferred = preferredAsset(assets)
  const archiveUrl = release
    ? `https://github.com/${info.owner}/${info.repo}/archive/refs/tags/${encodeURIComponent(release.version)}.zip`
    : `https://github.com/${info.owner}/${info.repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`

  return {
    ...base,
    // 中文简介优先用收录清单里的 intro；清单没写才回退仓库英文 description
    intro: (info.intro && info.intro !== '') ? info.intro : ((repoInfo && repoInfo.description) || ''),
    description: (repoInfo && repoInfo.description) || '',
    version: release ? release.version : '',
    publishedAt: release ? release.publishedAt : '',
    notes: release ? release.notes : '',
    assets,
    hasRelease: Boolean(release),
    defaultBranch: branch,
    downloadUrl: preferred ? preferred.url : archiveUrl,
    archiveUrl,
  }
}

// ── 对外 ───────────────────────────────────────────────────────────────────

function errorItem(info, error) {
  const branch = 'main'
  const archiveUrl = `https://github.com/${info.owner}/${info.repo}/archive/refs/heads/${branch}.zip`
  return {
    id: info.repo,
    name: info.name || info.repo,
    owner: info.owner,
    repo: info.repo,
    plugin: info.plugin || ('@local/' + info.repo),
    homepage: info.homepage || ('https://github.com/' + info.owner + '/' + info.repo),
    intro: info.intro || '',
    localVersion: readLocalVersion(info),
    description: '',
    version: '',
    publishedAt: '',
    notes: '',
    assets: [],
    hasRelease: false,
    defaultBranch: branch,
    downloadUrl: archiveUrl,
    archiveUrl,
    error: String(error && error.message ? error.message : error).slice(0, 300),
  }
}

/**
 * 读取「收录的插件」GitHub 目录（10 分钟内存缓存；改清单文件会立即生效）。
 * options.dataDir = companion-memory 的数据根目录（github-plugins.json 放这里）。
 * 单个仓库失败只让该条目带 error，不影响其它仓库。
 */
export async function getGithubCatalog(options = {}) {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
  const loaded = loadPluginList({ dataDir })
  const signature = manifestSignature(dataDir)
  const now = Date.now()
  if (cache && cache.signature === signature && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, cached: true }
  }

  // 清单里的仓库并行取（各自内部再串行取 release/assets/repo），失败各自降级
  const items = await Promise.all(loaded.list.map((info) => (
    fetchOne(info).catch((error) => errorItem(info, error))
  )))

  const notes = []
  if (Date.now() < apiLimitedUntil) {
    notes.push('GitHub 匿名 API 暂时限流，已自动改用网页接口读取（信息仍然是最新的，只是资产大小可能显示不全）')
  }
  if (loaded.error) notes.push(loaded.error)

  const value = {
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
    manifestFile: loaded.file,
    manifestSource: loaded.source,
    apiLimited: Date.now() < apiLimitedUntil,
    note: notes.join('；'),
    items,
  }
  cache = { at: Date.now(), signature, value }
  return { ...value, cached: false }
}
