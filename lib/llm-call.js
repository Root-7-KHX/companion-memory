/**
 * 通用模型调用：给「导入前整理记忆」「记忆体检」「多级记忆压缩」共用。
 *
 * 走宿主注入的 `llm` 服务（ctx.get('llm')），与 context-compress.js 的摘要复用同一条链路。
 * 任何异常都向上抛，由调用方决定降级（绝不阻塞导入 / 对话）。
 */

export const CLEAN_DEFAULT_MODEL = Object.freeze({
  provider: 'deepseek-account',
  model: 'deepseek-flash',
})

/**
 * 调一次模型，把流式文本拼成完整字符串。
 * @param {object} ctx  插件上下文（需能 ctx.get('llm')）
 * @param {object} options
 * @param {Array}  options.messages  OpenAI 风格消息数组
 * @param {number} [options.maxTokens]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.sessionId]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} 模型文本（已 trim）
 */
export async function callModelText(ctx, options = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')
  const provider = options.provider || CLEAN_DEFAULT_MODEL.provider
  const model = options.model || CLEAN_DEFAULT_MODEL.model
  const request = {
    provider,
    model,
    messages: options.messages,
    maxTokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 2048,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  let text = ''
  for await (const chunk of llm.stream(request)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason && reason.kind === 'error') throw new Error(`模型请求失败：${reason.failure?.message ?? '未知错误'}`)
      if (reason && reason.kind === 'aborted') throw new Error('模型请求被取消')
    }
  }
  const out = text.trim()
  if (out === '') throw new Error('模型没有返回文本')
  return out
}
