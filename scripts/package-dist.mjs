#!/usr/bin/env node
/**
 * package-dist.mjs — build the release artifacts for this plugin.
 *
 * Reads name / version / files from package.json and writes two packages into
 * the sibling `dist/` folder (default: D:\AI\插件\dist):
 *
 *   <name>-<version>.zip   -> entries under `<name>/...`
 *   <name>-<version>.tgz   -> npm-style tarball, entries under `package/...`
 *
 * Always bundled in addition to `files`: README.md, LICENSE, package.json and
 * (when `files` does not already cover it) the whole docs/ folder, so the
 * screenshots referenced by the README ship with the release.
 *
 * Both archives are written with Node's built-in zlib only (no npm / no
 * external archiver), so Chinese file names survive with correct UTF-8 bytes:
 *   - zip sets general-purpose bit 11 (UTF-8 names)
 *   - tar keeps UTF-8 names as raw bytes (ustar prefix split / pax fallback)
 *
 * Usage:
 *   node scripts/package-dist.mjs
 *   node scripts/package-dist.mjs --out D:\some\dir
 *   node scripts/package-dist.mjs --list        # also print every entry
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// paths & args
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT_DIR = path.resolve(REPO_ROOT, '..', 'dist');

const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules', '.svn']);

function parseArgs(argv) {
  const opts = { outDir: DEFAULT_OUT_DIR, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const value = argv[i + 1];
      if (!value) fail('--out 需要一个目录参数');
      opts.outDir = path.resolve(process.cwd(), value);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      opts.outDir = path.resolve(process.cwd(), arg.slice('--out='.length));
    } else if (arg === '--list' || arg === '-l') {
      opts.list = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      fail(`未知参数: ${arg}（用 --help 看用法）`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`  ⚠ ${message}`);
}

// ---------------------------------------------------------------------------
// package.json + file collection
// ---------------------------------------------------------------------------

function readManifest() {
  const manifestPath = path.join(REPO_ROOT, 'package.json');
  if (!existsSync(manifestPath)) fail(`找不到 package.json: ${manifestPath}`);
  const text = readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    return fail(`package.json 不是合法 JSON: ${err.message}`);
  }
}

function normalizePattern(pattern) {
  return String(pattern)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function isGlob(pattern) {
  return pattern.split('/').some((segment) => segment.includes('*') || segment.includes('?'));
}

function matchSegment(pattern, value) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(value);
}

function matchGlobSegments(patternSegments, pIndex, valueSegments, vIndex) {
  if (pIndex === patternSegments.length) return vIndex === valueSegments.length;
  const segment = patternSegments[pIndex];
  if (segment === '**') {
    for (let i = vIndex; i <= valueSegments.length; i += 1) {
      if (matchGlobSegments(patternSegments, pIndex + 1, valueSegments, i)) return true;
    }
    return false;
  }
  if (vIndex === valueSegments.length) return false;
  if (!matchSegment(segment, valueSegments[vIndex])) return false;
  return matchGlobSegments(patternSegments, pIndex + 1, valueSegments, vIndex + 1);
}

function matchGlob(pattern, relPath) {
  return matchGlobSegments(pattern.split('/'), 0, relPath.split('/'), 0);
}

function walkFiles(absDir, relPrefix, out) {
  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    warn(`读取目录失败，已跳过: ${relPrefix || '.'} (${err.code || err.message})`);
    return;
  }
  for (const dirent of dirents) {
    if (SKIP_NAMES.has(dirent.name)) continue;
    const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
    const abs = path.join(absDir, dirent.name);
    if (dirent.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (dirent.isFile()) {
      out.push(rel);
    }
  }
}

function collectFiles(manifest) {
  const patterns = Array.isArray(manifest.files) ? manifest.files.map(normalizePattern).filter(Boolean) : [];
  if (patterns.length === 0) warn('package.json 没有 files 字段，只打包必备文件与 docs/');

  const collected = new Set();

  for (const pattern of patterns) {
    if (!isGlob(pattern)) {
      const abs = path.join(REPO_ROOT, pattern);
      if (!existsSync(abs)) {
        warn(`files 里的路径不存在，已跳过: ${pattern}`);
        continue;
      }
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const found = [];
        walkFiles(abs, pattern, found);
        if (found.length === 0) warn(`files 里的目录是空的: ${pattern}`);
        for (const rel of found) collected.add(rel);
      } else if (stat.isFile()) {
        collected.add(pattern);
      }
      continue;
    }

    const segments = pattern.split('/');
    const firstGlob = segments.findIndex((segment) => segment.includes('*') || segment.includes('?'));
    const base = segments.slice(0, firstGlob).join('/');
    const baseAbs = base ? path.join(REPO_ROOT, base) : REPO_ROOT;
    if (!existsSync(baseAbs)) {
      warn(`通配符路径的基准目录不存在，已跳过: ${pattern}`);
      continue;
    }
    const found = [];
    walkFiles(baseAbs, base, found);
    const matched = found.filter((rel) => matchGlob(pattern, rel));
    if (matched.length === 0) warn(`通配符没有匹配到文件: ${pattern}`);
    for (const rel of matched) collected.add(rel);
  }

  // Mandatory release files.
  for (const required of ['README.md', 'LICENSE', 'package.json']) {
    const abs = path.join(REPO_ROOT, required);
    if (existsSync(abs) && statSync(abs).isFile()) {
      collected.add(required);
    } else {
      warn(`缺少必备文件: ${required}`);
    }
  }

  // docs/ (screenshots live there) unless `files` already ships it.
  const docsCovered = patterns.some((pattern) => pattern === 'docs' || pattern.startsWith('docs/'));
  const docsAbs = path.join(REPO_ROOT, 'docs');
  if (!docsCovered) {
    if (existsSync(docsAbs) && statSync(docsAbs).isDirectory()) {
      const found = [];
      walkFiles(docsAbs, 'docs', found);
      if (found.length === 0) warn('docs/ 目录是空的');
      for (const rel of found) collected.add(rel);
    } else {
      warn('没有 docs/ 目录，发布包里不会带截图');
    }
  }

  return [...collected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Directory entries needed to represent the given file list, e.g. `lib/`. */
function collectDirPaths(files) {
  const dirs = new Set();
  for (const rel of files) {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    date: (((year - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

function unixMode(mode, isDir) {
  const type = isDir ? 0o040000 : 0o100000;
  return (type | (mode & 0o7777)) >>> 0;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(value) : value.toFixed(1);
  return `${shown} ${units[unit]} (${bytes.toLocaleString('en-US')} 字节)`;
}

// ---------------------------------------------------------------------------
// zip writer (deflate via node:zlib, UTF-8 entry names)
// ---------------------------------------------------------------------------

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = entry.isDir ? Buffer.alloc(0) : entry.data;
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (!entry.isDir && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const { date, time } = dosDateTime(entry.mtime);
    const flags = 0x0800; // bit 11: file name is UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(0x031e, 4); // made by: UNIX, version 3.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    const external =
      (unixMode(entry.isDir ? 0o755 : 0o644, entry.isDir) << 16) | (entry.isDir ? 0x10 : 0x0);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// ---------------------------------------------------------------------------
// tar (ustar + pax fallback) + gzip
// ---------------------------------------------------------------------------

function writeOctal(buffer, offset, length, value) {
  const octal = Math.max(0, Math.floor(value)).toString(8);
  if (octal.length > length - 1) {
    // base-256 encoding for oversized values (never hit by this repo)
    buffer[offset] = 0x80;
    for (let i = 1; i < length; i += 1) buffer[offset + i] = 0;
    let remaining = Math.max(0, Math.floor(value));
    for (let i = length - 1; i >= 1; i -= 1) {
      buffer[offset + i] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    return;
  }
  Buffer.from(octal.padStart(length - 1, '0') + '\0', 'binary').copy(buffer, offset);
}

function splitTarPath(nameBytes) {
  if (nameBytes.length <= 100) return { name: nameBytes, prefix: Buffer.alloc(0) };
  const text = nameBytes.toString('utf8');
  for (let i = text.lastIndexOf('/'); i > 0; i = text.lastIndexOf('/', i - 1)) {
    const prefixBytes = Buffer.from(text.slice(0, i), 'utf8');
    const restBytes = Buffer.from(text.slice(i + 1), 'utf8');
    if (prefixBytes.length <= 155 && restBytes.length > 0 && restBytes.length <= 100) {
      return { name: restBytes, prefix: prefixBytes };
    }
  }
  return null;
}

function tarHeader({ name, prefix, mode, size, mtime, typeflag }) {
  const header = Buffer.alloc(512);
  name.copy(header, 0, 0, Math.min(name.length, 100));
  if (prefix && prefix.length > 0) prefix.copy(header, 345, 0, Math.min(prefix.length, 155));
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtime / 1000));
  header.fill(0x20, 148, 156); // checksum field placeholder
  header.write(typeflag, 156, 'binary');
  header.write('ustar\0', 257, 'binary');
  header.write('00', 263, 'binary');
  header.write('root', 265, 'binary');
  header.write('root', 297, 'binary');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i];
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'binary');
  return header;
}

function padTo512(buffer) {
  const remainder = buffer.length % 512;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(512 - remainder)]);
}

function paxRecord(key, value) {
  const body = Buffer.from(` ${key}=${value}\n`, 'utf8');
  let digits = 1;
  for (;;) {
    const total = digits + body.length;
    const width = String(total).length;
    if (width === digits) return Buffer.concat([Buffer.from(String(total), 'binary'), body]);
    digits = width;
  }
}

function paxHeaderFor(nameBytes, mtime) {
  const text = nameBytes.toString('utf8');
  const placeholder = Buffer.from('PaxHeader/entry', 'utf8');
  const records = Buffer.concat([paxRecord('path', text), paxRecord('mtime', String(Math.floor(mtime / 1000)))]);
  return [
    tarHeader({ name: placeholder, prefix: null, mode: 0o644, size: records.length, mtime, typeflag: 'x' }),
    padTo512(records),
  ];
}

function buildTar(entries) {
  const parts = [];

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const mtime = entry.mtime instanceof Date ? entry.mtime.getTime() : Date.now();
    const mode = entry.isDir ? 0o755 : 0o644;

    let split = splitTarPath(nameBytes);
    if (!split) {
      parts.push(...paxHeaderFor(nameBytes, mtime));
      const fallback = nameBytes.subarray(Math.max(0, nameBytes.length - 100));
      split = { name: fallback, prefix: Buffer.alloc(0) };
    }

    if (entry.isDir) {
      parts.push(tarHeader({ name: split.name, prefix: split.prefix, mode, size: 0, mtime, typeflag: '5' }));
      continue;
    }

    parts.push(
      tarHeader({ name: split.name, prefix: split.prefix, mode, size: entry.data.length, mtime, typeflag: '0' }),
      padTo512(entry.data),
    );
  }

  parts.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法: node scripts/package-dist.mjs [--out <目录>] [--list]');
    return;
  }

  const manifest = readManifest();
  if (!manifest.name) fail('package.json 缺少 name');
  if (!manifest.version) fail('package.json 缺少 version');

  const packageBase = String(manifest.name).includes('/')
    ? String(manifest.name).split('/').pop()
    : String(manifest.name);
  const version = String(manifest.version);
  const files = collectFiles(manifest);
  if (files.length === 0) fail('没有收集到任何文件，无法打包');

  const dirs = collectDirPaths(files);
  const fileEntries = files.map((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    const stat = statSync(abs);
    return { rel, abs, data: readFileSync(abs), mtime: stat.mtime, isDir: false };
  });
  const dirEntries = dirs.map((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    let mtime = new Date();
    try {
      mtime = statSync(abs).mtime;
    } catch {
      /* keep default mtime */
    }
    return { rel, abs, data: Buffer.alloc(0), mtime, isDir: true };
  });

  mkdirSync(opts.outDir, { recursive: true });

  const zipName = `${packageBase}-${version}.zip`;
  const tgzName = `${packageBase}-${version}.tgz`;
  const zipPath = path.join(opts.outDir, zipName);
  const tgzPath = path.join(opts.outDir, tgzName);

  // zip: entries live under `<packageBase>/...`
  const zipEntries = [...dirEntries, ...fileEntries]
    .map((entry) => ({ ...entry, name: `${packageBase}/${entry.rel}${entry.isDir ? '/' : ''}` }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // tgz: npm layout, entries live under `package/...`
  const tarEntries = [...dirEntries, ...fileEntries]
    .map((entry) => ({ ...entry, name: `package/${entry.rel}${entry.isDir ? '/' : ''}` }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const zipBuffer = buildZip(zipEntries);
  writeFileSync(zipPath, zipBuffer);
  const tgzBuffer = zlib.gzipSync(buildTar(tarEntries), { level: 9 });
  writeFileSync(tgzPath, tgzBuffer);

  // ---- report ------------------------------------------------------------
  console.log('');
  console.log(`📦 ${manifest.name}@${version}`);
  console.log(`   仓库: ${REPO_ROOT}`);
  console.log(`   输出: ${opts.outDir}`);
  console.log(`   文件: ${files.length} 个（另含 ${dirs.length} 个目录条目）`);

  const groups = new Map();
  for (const rel of files) {
    const top = rel.includes('/') ? rel.split('/')[0] : '(根目录文件)';
    groups.set(top, (groups.get(top) || 0) + 1);
  }
  const groupText = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ');
  console.log(`   分组: ${groupText}`);

  for (const item of [
    { label: 'zip', file: zipPath, buffer: zipBuffer, root: `${packageBase}/` },
    { label: 'tgz', file: tgzPath, buffer: tgzBuffer, root: 'package/' },
  ]) {
    const stat = statSync(item.file);
    console.log('');
    console.log(`✔ ${item.label.toUpperCase()}  ${item.file}`);
    console.log(`   大小: ${formatSize(stat.size)}`);
    console.log(`   文件: ${files.length} 个（根目录 ${item.root}）`);
  }

  if (opts.list) {
    console.log('');
    console.log('--- zip 内容 ---');
    for (const entry of zipEntries) console.log(`  ${entry.name}`);
  }

  console.log('');
}

main();
