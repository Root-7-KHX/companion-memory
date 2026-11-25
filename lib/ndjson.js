/**
 * 行式 JSON（NDJSON）读写：用来把超大数组「落到磁盘上排队」，不占内存。
 *
 * 导入几百兆的导出包时，聊天原文可能有几十万条。如果整份 JSON.parse 进内存，
 * 光这一个数组就够呛；所以流式解析时把每个元素直接写一行到临时文件，
 * 后面再按行读回来逐条处理（一次只在内存里放一条）。
 */

import { closeSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** 读文件的缓冲：1MB。再大也就多占 1MB，跟数组长度无关。 */
const READ_BUFFER = 1 << 20

/** 写缓冲：攒够再落盘。导入几十万条时一条一次 writeSync 会把时间全花在系统调用上。 */
const WRITE_BUFFER = 256 * 1024

export function createNdjsonWriter(file) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  let count = 0
  let closed = false
  let pending = []
  let pendingBytes = 0
  const flush = () => {
    if (pending.length === 0) return
    // 一次 writeSync 把整个缓冲写出去（转成 Buffer 只为一次拷贝，比几十万次系统调用便宜得多）
    writeSync(fd, Buffer.from(pending.join(''), 'utf8'))
    pending = []
    pendingBytes = 0
  }
  return {
    write(value) {
      if (closed) throw new Error('NDJSON 写入器已经关闭')
      const line = JSON.stringify(value) + '\n'
      pending.push(line)
      pendingBytes += line.length + 1
      count += 1
      if (pendingBytes >= WRITE_BUFFER) flush()
    },
    close() {
      if (closed) return
      closed = true
      try { flush() } catch { /* ignore */ }
      try { closeSync(fd) } catch { /* ignore */ }
    },
    get count() {
      return count
    },
  }
}

/**
 * 逐条读回 NDJSON。同步生成器：调用方在 for...of 里一条条处理，
 * 文件多大都只占一个缓冲 + 一条记录。
 */
export function* readNdjson(file) {
  const fd = openSync(file, 'r')
  const decoder = new StringDecoder('utf8')
  try {
    const buffer = Buffer.allocUnsafe(READ_BUFFER)
    let tail = ''
    while (true) {
      const read = readSync(fd, buffer, 0, READ_BUFFER, null)
      if (read <= 0) break
      const text = tail + decoder.write(buffer.subarray(0, read))
      let start = 0
      let newline = text.indexOf('\n', start)
      while (newline !== -1) {
        const line = text.slice(start, newline)
        start = newline + 1
        if (line.trim() !== '') yield JSON.parse(line)
        newline = text.indexOf('\n', start)
      }
      tail = text.slice(start)
    }
    const rest = tail + decoder.end()
    if (rest.trim() !== '') yield JSON.parse(rest)
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
  }
}

/** 只读开头若干条（导入后提炼记忆用，不需要整份）。 */
export function readNdjsonHead(file, options = {}) {
  const maxMessages = Number(options.maxMessages) > 0 ? Number(options.maxMessages) : 3000
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 200000
  const out = []
  let chars = 0
  try {
    for (const item of readNdjson(file)) {
      out.push(item)
      const text = item && typeof item.text === 'string' ? item.text : ''
      chars += text.length
      if (out.length >= maxMessages || chars >= maxChars) break
    }
  } catch {
    // 读坏了就用手上已有的，不让提炼拖垮导入
  }
  return out
}
