/**
 * 流式 JSON 解析（边收边解、按路径分流）。
 *
 * 为什么不用 JSON.parse：导出包可能有几个 GB。JSON.parse 必须先拿到完整字符串，
 * 而 V8 单个字符串上限是 0x1fffffe8（≈512M 字符），再加上 Buffer 和字符串两份
 * 拷贝，800MB 左右就会抛
 *   "Cannot create a string longer than 0x1fffffe8 characters"。
 * 这里的做法是：网络上来一块解一块，超大字段（聊天原文数组、知识库文件）
 * 直接分流到回调或磁盘，内存里只剩「当前正在解的那一个值」。
 *
 * handlers：
 *   key   = 点分路径，例如 'conversation.messages'；
 *           以 '.*' 结尾表示前缀匹配（'knowledge.*' 匹配 knowledge 下任意子项）。
 *   value = handler 对象，或 (path) => handler | null 的函数
 *           （需要按路径动态建 handler 时用，例如每个知识库文件一个写盘句柄）。
 *
 * handler 形态：
 *   { type: 'skip' }                          整个值丢掉（对象/数组/字符串都行，不占内存）
 *   { type: 'string', write(chunk), end() }   字符串分片回调（转义已还原成普通字符）
 *   { type: 'array', item(value), end() }     数组逐项回调；元素照常解析成普通 JS 值
 *   { type: 'value', value(v) }               值解析完再回调（不会放进结果对象）
 *   不给 handler                            → 整值解析进内存（默认，适合小字段）
 */

import { StringDecoder } from 'node:string_decoder'

const WS = new Set([' ', '\t', '\r', '\n'])
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
/**
 * 找下一个「" 」或「\」。
 * 千万别写成两次 indexOf：没有反斜杠时 indexOf('\\') 会把整个剩余文本扫一遍，
 * 每条消息都扫一遍就退化成 O(n²)——实测 5 万条里 3.2 万条占了 97% 的时间。
 */
const STRING_STOP = /["\\]/g
/** 「这个值已经被 handler 处理掉了，别再塞进结果里」的哨兵。 */
const HANDLED = Symbol('json-stream-handled')

function isLiteralChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 43 /* + */ || code === 45 /* - */ || code === 46 /* . */
}

export class StreamingJsonReader {
  constructor(options = {}) {
    this.handlers = options.handlers && typeof options.handlers === 'object' ? options.handlers : {}
    this.decoder = new StringDecoder('utf8')
    /** 尚未消费的尾巴（只可能是「半个转义」这种几个字符，不会是整份文档）。 */
    this.text = ''
    this.cursor = 0
    this.frames = [{ kind: 'root', path: '', value: undefined, key: null, handler: null, valueHandler: null }]
    /** 'value' | 'valueOrEnd' | 'keyOrEnd' | 'colon' | 'commaOrEnd' | 'literal' */
    this.expect = 'value'
    this.str = null
    this.literal = ''
    this.literalHandler = null
    this.literalDrop = false
    this.skipping = false
    this.skipDepth = 0
    this.skipInString = false
    this.skipEscape = false
    this.finished = false
    this.result = undefined
    this.bytes = 0
    this.prefixes = []
    for (const key of Object.keys(this.handlers)) {
      if (key.endsWith('.*')) this.prefixes.push([key.slice(0, -1), this.handlers[key]])
    }
    this.prefixes.sort((a, b) => b[0].length - a[0].length)
  }

  /** 喂一块数据（Buffer 或字符串）。可以随便切，多字节字符/转义跨块都没关系。 */
  write(chunk) {
    if (this.finished) return
    let text
    if (typeof chunk === 'string') {
      text = chunk
    } else {
      this.bytes += chunk.length
      text = this.decoder.write(chunk)
    }
    // Windows 上另存/生成的 JSON 常带 BOM，JSON.parse 会直接判成非法，这里先摘掉。
    if (this.text === '' && text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    this.text += text
    this._pump()
  }

  /** 收尾：没有数据了，返回解析出来的根对象。 */
  end() {
    if (!this.finished) {
      this.text += this.decoder.end()
      this._pump()
    }
    if (!this.finished) throw new Error('JSON 没读完（文档被截断或内容不完整）')
    return this.result
  }

  // ── 主循环：能往前走就往前走，走不动（需要下一块）就退出 ────────────────

  _pump() {
    const t = this.text
    let i = this.cursor
    while (i < t.length && !this.finished) {
      if (this.skipping) {
        const before = i
        i = this._scanSkip(t, i)
        if (i === before) break
        continue
      }
      if (this.str) {
        const before = i
        i = this._scanString(t, i)
        if (i === before) break
        continue
      }
      const c = t[i]
      if (WS.has(c)) {
        i += 1
        continue
      }
      if (this.expect === 'literal') {
        const before = i
        i = this._scanLiteral(t, i)
        if (i === before && this.expect === 'literal') break
        continue
      }
      if (this.expect === 'value' || this.expect === 'valueOrEnd') {
        if (this.expect === 'valueOrEnd' && c === ']') {
          i = this._closeArray(i)
          continue
        }
        i = this._startValue(t, i)
        continue
      }
      if (this.expect === 'keyOrEnd') {
        if (c === '}') {
          i = this._closeObject(i)
          continue
        }
        if (c === '"') {
          this.str = { parts: [], isKey: true, drop: false, handler: null, valueHandler: null }
          i += 1
          continue
        }
        throw new Error('JSON 格式不对：对象里应当是键名或 }')
      }
      if (this.expect === 'colon') {
        if (c !== ':') throw new Error('JSON 格式不对：键名后面缺少冒号')
        this.expect = 'value'
        i += 1
        continue
      }
      if (this.expect === 'commaOrEnd') {
        const top = this.frames[this.frames.length - 1]
        if (c === ',') {
          this.expect = top.kind === 'object' ? 'keyOrEnd' : 'valueOrEnd'
          i += 1
          continue
        }
        if (top.kind === 'object' && c === '}') {
          i = this._closeObject(i)
          continue
        }
        if (top.kind === 'array' && c === ']') {
          i = this._closeArray(i)
          continue
        }
        throw new Error('JSON 格式不对：值后面应当是逗号或右括号')
      }
      throw new Error('JSON 格式不对：根值结束后还有多余内容')
    }
    this.text = t.slice(i)
    this.cursor = 0
  }

  // ── 容器 ────────────────────────────────────────────────────────────────

  _nextPath() {
    const top = this.frames[this.frames.length - 1]
    if (top.kind === 'root') return ''
    if (top.kind === 'array') return top.path + '[]'
    return top.path === '' ? String(top.key) : top.path + '.' + top.key
  }

  _resolve(path) {
    if (Object.prototype.hasOwnProperty.call(this.handlers, path)) {
      const hit = this.handlers[path]
      return typeof hit === 'function' ? hit(path) : hit
    }
    for (const [prefix, hit] of this.prefixes) {
      if (path.startsWith(prefix)) return typeof hit === 'function' ? hit(path) : hit
    }
    return null
  }

  _startValue(t, i) {
    const c = t[i]
    const path = this._nextPath()
    const handler = this._resolve(path)
    if (handler && handler.type === 'skip') {
      if (c === '"') {
        this.str = { parts: null, isKey: false, drop: true, handler: null, valueHandler: null }
        return i + 1
      }
      if (c === '{' || c === '[') {
        this.skipping = true
        this.skipDepth = 0
        this.skipInString = false
        this.skipEscape = false
        return i
      }
      this.expect = 'literal'
      this.literal = ''
      this.literalDrop = true
      this.literalHandler = null
      return i
    }
    const valueHandler = handler && handler.type === 'value' ? handler : null
    if (c === '{') {
      this.frames.push({ kind: 'object', path, value: {}, key: null, handler: null, valueHandler })
      this.expect = 'keyOrEnd'
      return i + 1
    }
    if (c === '[') {
      if (handler && handler.type === 'array') {
        this.frames.push({ kind: 'array', path, value: null, handler, index: 0, valueHandler: null })
      } else {
        this.frames.push({ kind: 'array', path, value: [], handler: null, index: 0, valueHandler })
      }
      this.expect = 'valueOrEnd'
      return i + 1
    }
    if (c === '"') {
      this.str = {
        parts: [],
        isKey: false,
        drop: false,
        handler: handler && handler.type === 'string' ? handler : null,
        valueHandler,
      }
      return i + 1
    }
    this.expect = 'literal'
    this.literal = ''
    this.literalDrop = false
    this.literalHandler = valueHandler
    return i
  }

  _closeObject(i) {
    const top = this.frames.pop()
    if (!top || top.kind !== 'object') throw new Error('JSON 格式不对：多余的 }')
    this._pushValue(top.value, top.valueHandler)
    return i + 1
  }

  _closeArray(i) {
    const top = this.frames.pop()
    if (!top || top.kind !== 'array') throw new Error('JSON 格式不对：多余的 ]')
    if (top.handler && typeof top.handler.end === 'function') top.handler.end()
    this._pushValue(top.handler ? HANDLED : top.value, top.valueHandler)
    return i + 1
  }

  _pushValue(value, handler) {
    const top = this.frames[this.frames.length - 1]
    if (!top) throw new Error('JSON 格式不对：值没有落脚点')
    if (top.kind === 'root') {
      this.result = value === HANDLED ? undefined : value
      this.finished = true
      return
    }
    if (handler && typeof handler.value === 'function') {
      if (value !== HANDLED) handler.value(value)
      this.expect = 'commaOrEnd'
      return
    }
    if (top.kind === 'object') {
      if (value !== HANDLED) top.value[top.key] = value
      this.expect = 'commaOrEnd'
      return
    }
    if (top.handler) {
      if (value !== HANDLED) top.handler.item(value)
      top.index += 1
      this.expect = 'commaOrEnd'
      return
    }
    if (value !== HANDLED) top.value.push(value)
    this.expect = 'commaOrEnd'
  }

  // ── 字面量 ──────────────────────────────────────────────────────────────

  _scanLiteral(t, i) {
    let j = i
    while (j < t.length && isLiteralChar(t.charCodeAt(j))) j += 1
    if (j > i) this.literal += t.slice(i, j)
    if (j < t.length) {
      this._finishLiteral()
      return j
    }
    return j
  }

  _finishLiteral() {
    const raw = this.literal
    this.literal = ''
    const handler = this.literalHandler
    const drop = this.literalDrop
    this.literalHandler = null
    this.literalDrop = false
    if (raw === '') throw new Error('JSON 格式不对：空值')
    let value
    if (raw === 'true') value = true
    else if (raw === 'false') value = false
    else if (raw === 'null') value = null
    else {
      const num = Number(raw)
      if (!Number.isFinite(num)) throw new Error('JSON 里有不认识的字面量：' + raw.slice(0, 20))
      value = num
    }
    this._pushValue(drop ? HANDLED : value, handler)
  }

  // ── 字符串 ──────────────────────────────────────────────────────────────

  _emitString(rec, chunk) {
    if (chunk === '') return
    if (rec.handler && typeof rec.handler.write === 'function') rec.handler.write(chunk)
    else if (rec.parts) rec.parts.push(chunk)
  }

  _scanString(t, i) {
    const rec = this.str
    let j = i
    while (j < t.length) {
      STRING_STOP.lastIndex = j
      const hit = STRING_STOP.exec(t)
      const next = hit ? hit.index : -1
      if (next === -1) {
        if (!rec.drop) this._emitString(rec, t.slice(j))
        j = t.length
        break
      }
      if (next > j) {
        if (!rec.drop) this._emitString(rec, t.slice(j, next))
        j = next
      }
      if (t[j] === '"') {
        j += 1
        this.str = null
        if (rec.isKey) {
          const top = this.frames[this.frames.length - 1]
          top.key = rec.parts.join('')
          this.expect = 'colon'
          return j
        }
        if (rec.handler && typeof rec.handler.end === 'function') rec.handler.end()
        const value = rec.drop ? HANDLED : (rec.handler ? HANDLED : rec.parts.join(''))
        this._pushValue(value, rec.valueHandler)
        return j
      }
      // 反斜杠转义：\uXXXX 要 6 个字符，其它 2 个；跨块就等下一块。
      const need = t[j + 1] === 'u' ? 6 : 2
      if (j + need > t.length) return j
      const escape = t.slice(j, j + need)
      let decoded
      if (escape[1] === 'u') {
        const code = Number.parseInt(escape.slice(2), 16)
        if (!Number.isFinite(code)) throw new Error('JSON 里有不合法的 \\u 转义')
        decoded = String.fromCharCode(code)
      } else {
        const mapped = ESCAPES[escape[1]]
        if (mapped === undefined) throw new Error('JSON 里有不支持的转义 \\' + escape[1])
        decoded = mapped
      }
      if (!rec.drop) this._emitString(rec, decoded)
      j += need
    }
    return j
  }

  // ── 整段丢弃（skip 的对象/数组）─────────────────────────────────────────

  _scanSkip(t, i) {
    let j = i
    while (j < t.length) {
      const c = t[j]
      if (this.skipInString) {
        if (this.skipEscape) {
          this.skipEscape = false
          j += 1
          continue
        }
        if (c === '\\') {
          this.skipEscape = true
          j += 1
          continue
        }
        if (c === '"') this.skipInString = false
        j += 1
        continue
      }
      if (c === '"') {
        this.skipInString = true
        j += 1
        continue
      }
      if (c === '{' || c === '[') {
        this.skipDepth += 1
        j += 1
        continue
      }
      if (c === '}' || c === ']') {
        this.skipDepth -= 1
        j += 1
        if (this.skipDepth <= 0) {
          this.skipping = false
          this._pushValue(HANDLED, null)
          return j
        }
        continue
      }
      j += 1
    }
    return j
  }
}

export function createStreamingReader(options) {
  return new StreamingJsonReader(options)
}
