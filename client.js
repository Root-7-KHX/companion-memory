/**
 * Client half of the companion-memory bundle.
 *
 * Registers a sidebar icon (`sidebar.panellist`) plus its central panel (`main`,
 * keyed by the same id) with four tabs: persona docs, memory/favorability,
 * knowledge base and status. All state comes from the Host half's same-origin
 * `/companion/api/*` routes.
 */
window.__ModuleLoader__.load({
  id: '@local/companion-memory',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const PLUGIN_ID = 'companion-memory'
    const API_BASE = '/companion/api'
    const POLL_MS = 5000

    const STYLES = `
.cm-root {
  --cm-text: var(--dsw-alias-label-primary, #1f2328);
  --cm-text-2: color-mix(in srgb, var(--cm-text) 64%, transparent);
  --cm-bg: var(--dsw-alias-bg-base, #ffffff);
  --cm-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --cm-surface-2: var(--dsw-alias-bg-layer-2, #f4f6f9);
  --cm-border: var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.12));
  --cm-border-strong: var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.24));
  --cm-brand: var(--dsw-alias-brand-primary, #2f6bff);
  --cm-on-brand: #14171c;
  --cm-danger: var(--dsw-alias-state-error-primary, #d92d20);
  --cm-success: var(--dsw-alias-state-success-primary, #067647);
  --cm-warn: var(--dsw-alias-state-warn-primary, #b54708);
  display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--cm-bg); color: var(--cm-text); font: 13px/1.55 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.cm-header { position: sticky; top: 0; z-index: 2; flex: 0 0 auto; padding: 14px 16px 0; border-bottom: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); background: var(--cm-bg, #ffffff); }
.cm-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cm-title { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0.01em; }
.cm-sub { margin: 2px 0 0; font-size: 12px; color: var(--cm-text-2, #64748b); }
.cm-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
.cm-pill { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.12)); font-size: 12px; color: var(--cm-text-2, #475569); background: var(--cm-surface-2, rgba(15, 23, 42, 0.035)); }
.cm-pill-warn { border-color: var(--cm-danger, #d92d20); color: var(--cm-danger, #d92d20); }
.cm-tone-good { color: var(--cm-success, #067647); }
.cm-tone-bad { color: var(--cm-danger, #d92d20); }
.cm-tone-neutral { color: var(--cm-text-2, #64748b); }
.cm-tabs { display: flex; gap: 4px; margin: 12px 0 0; }
.cm-tab { appearance: none; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--cm-text-2, #64748b); font: inherit; font-size: 13px; padding: 7px 10px; cursor: pointer; border-radius: 6px 6px 0 0; }
.cm-tab:hover { color: var(--cm-text, #1f2328); background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); }
.cm-tab-active { color: var(--cm-text, #1f2328); border-bottom-color: var(--cm-brand, #2f6bff); font-weight: 600; }
.cm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 40px; }
.cm-tab-body { display: flex; flex-direction: column; gap: 14px; }
.cm-intro { font-size: 12px; color: var(--cm-text-2, #64748b); background: var(--cm-surface-2, rgba(47, 107, 255, 0.06)); border: 1px solid var(--cm-border, rgba(47, 107, 255, 0.14)); border-radius: 8px; padding: 9px 11px; }
.cm-doc, .cm-card { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 10px; padding: 12px; background: var(--cm-bg, #ffffff); }
.cm-doc-head, .cm-card-head { display: flex; align-items: center; gap: 10px; justify-content: space-between; flex-wrap: wrap; }
.cm-doc-head h3, .cm-card-head h3 { margin: 0; font-size: 13.5px; font-weight: 650; }
.cm-doc-summary { margin: 6px 0 2px; padding: 8px 10px; border-left: 2px solid var(--cm-brand, #2f6bff); border-radius: 6px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); color: var(--cm-text-2, #64748b); font-size: 12px; line-height: 1.65; }
.cm-doc-summary p { margin: 0; }
.cm-lock { margin: 6px 0 0; color: var(--cm-text-2, #64748b); font-size: 11.5px; }
.cm-field { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.cm-field label, .cm-extra label { font-size: 12.5px; font-weight: 650; color: var(--cm-text, #1f2328); }
.cm-field .cm-textarea { min-height: 56px; }
.cm-extra { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--cm-border, rgba(15, 23, 42, 0.14)); display: flex; flex-direction: column; gap: 4px; }
.cm-hint { margin: 6px 0 8px; font-size: 12px; color: var(--cm-text-2, #64748b); }
.cm-muted { color: var(--cm-text-2, #64748b); font-size: 12px; }
.cm-badge { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.12)); color: var(--cm-text-2, #64748b); }
.cm-badge-good { color: var(--cm-success, #067647); border-color: currentColor; }
.cm-badge-warn { color: var(--cm-danger, #d92d20); border-color: currentColor; }
.cm-textarea, .cm-input { width: 100%; box-sizing: border-box; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); border-radius: 8px; background: var(--cm-surface-2, #f8fafc); color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; padding: 8px 10px; resize: vertical; }
.cm-textarea { min-height: 120px; line-height: 1.6; }
.cm-textarea-small { min-height: 54px; margin-top: 8px; }
.cm-textarea:focus, .cm-input:focus { outline: 2px solid var(--cm-brand, #2f6bff); outline-offset: -1px; }
.cm-input { height: 32px; }
.cm-input-grow { flex: 1 1 auto; }
.cm-input-narrow { flex: 0 0 120px; width: 120px; }
.cm-btn { appearance: none; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); background: var(--cm-bg, #ffffff); color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.cm-btn:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.05)); }
.cm-btn:disabled { opacity: 0.55; cursor: default; }
.cm-btn-primary { background: var(--cm-brand, #2f6bff); border-color: transparent; color: var(--cm-on-brand); font-weight: 600; }
.cm-btn-primary:hover { filter: brightness(1.06); }
.cm-btn-small { padding: 3px 9px; font-size: 12px; }
.cm-btn-ghost { background: transparent; }
.cm-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.cm-fav-row { display: flex; align-items: center; gap: 14px; margin: 10px 0 4px; }
.cm-fav-value { font-size: 34px; font-weight: 700; min-width: 84px; font-variant-numeric: tabular-nums; color: var(--cm-text); }
.cm-fav-controls { flex: 1 1 auto; }
.cm-slider { width: 100%; accent-color: var(--cm-brand, #2f6bff); }
.cm-history { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.cm-history li { display: grid; grid-template-columns: auto 96px 1fr; gap: 8px; align-items: baseline; font-size: 12px; padding: 4px 6px; border-radius: 6px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.03)); }
.cm-history-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.cm-memory-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.cm-memory { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 8px; padding: 8px 10px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.02)); }
.cm-memory-archived { opacity: 0.72; }
.cm-memory-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; }
.cm-memory-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 11.5px; color: var(--cm-text-2, #64748b); }
.cm-tag { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.14)); border-radius: 999px; padding: 0 7px; font-size: 11px; }
.cm-collapse { appearance: none; border: 0; background: transparent; color: var(--cm-text, #1f2328); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 0; }
.cm-kb-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; max-height: 260px; overflow: auto; }
.cm-kb-item { display: flex; justify-content: space-between; gap: 10px; appearance: none; border: 0; background: transparent; color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; text-align: left; padding: 5px 7px; border-radius: 6px; cursor: pointer; }
.cm-kb-item:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.05)); }
.cm-kb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-results { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.cm-result { border-left: 2px solid var(--cm-brand, #2f6bff); padding: 4px 0 4px 10px; }
.cm-result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cm-result-text { margin-top: 3px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.cm-pre { margin: 10px 0 0; padding: 10px; border-radius: 8px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); font-family: ui-monospace, SFMono-Regular, Consolas, 'Microsoft YaHei', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto; }
.cm-readonly { margin-top: 8px; display: flex; flex-direction: column; gap: 10px; }
.cm-readonly .cm-pre { margin-top: 0; max-height: 220px; }
.cm-block { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 9px; padding: 10px 11px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.025)); }
.cm-block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cm-block-head h4 { margin: 0; font-size: 12.5px; font-weight: 650; }
.cm-full-toggle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cm-kv { margin: 10px 0 0; display: flex; flex-direction: column; gap: 1px; }
.cm-kv-row { display: grid; grid-template-columns: 128px 1fr; gap: 10px; padding: 5px 0; border-top: 1px dashed var(--cm-border, rgba(15, 23, 42, 0.1)); }
.cm-kv-row:first-child { border-top: 0; }
.cm-kv dt { color: var(--cm-text-2, #64748b); font-size: 12px; }
.cm-kv dd { margin: 0; font-size: 12.5px; word-break: break-all; }
.cm-notes { margin: 10px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--cm-text-2, #475569); }
.cm-empty { padding: 26px 8px; text-align: center; color: var(--cm-text-2, #64748b); font-size: 13px; }
.cm-banner { margin: 8px 16px 0; padding: 7px 11px; border-radius: 8px; font-size: 12.5px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.14)); background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); }
.cm-banner-error { border-color: var(--cm-danger, #d92d20); color: var(--cm-danger, #d92d20); }
.cm-banner-ok { border-color: var(--cm-success, #067647); color: var(--cm-success, #067647); }
.cm-session { margin: 8px 16px 0; padding: 10px 12px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.14)); border-radius: 10px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); display: flex; flex-direction: column; gap: 6px; }
.cm-session-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cm-session-info { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; flex-wrap: wrap; }
.cm-session-label { font-size: 12px; color: var(--cm-text-2, #64748b); }
.cm-session-name { font-size: 13px; font-weight: 600; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-badge { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); border-radius: 999px; padding: 0 7px; font-size: 11px; color: var(--cm-text-2, #64748b); }
.cm-badge-on { border-color: var(--cm-success, #067647); color: var(--cm-success, #067647); }
.cm-select { appearance: auto; background: var(--cm-surface, #ffffff); color: var(--cm-text, #1f2328); border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.18)); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12.5px; max-width: 320px; }
.cm-guide { margin: 16px; padding: 18px 18px 20px; border: 1px dashed var(--cm-border-strong, rgba(15, 23, 42, 0.28)); border-radius: 12px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.03)); display: flex; flex-direction: column; gap: 8px; }
.cm-guide h2 { margin: 0; font-size: 16px; }
.cm-guide p { margin: 0; font-size: 13px; color: var(--cm-text-2, #475569); line-height: 1.65; }
`

    const DOC_DEFS = [
      {
        key: 'personality',
        title: '角色性格',
        hint: '定义基础性格、三观、说话语调、思考方式、喜好与雷区。修改后自动保存，下一轮对话立刻生效（优先级最高）。',
      },
      {
        key: 'rules',
        title: '允许&禁止行为',
        hint: '写明可以做的事、绝对不能做的事、行为边界。角色言行任何时候都不得越过这份清单。',
      },
      {
        key: 'examples',
        title: '预设发言例句',
        hint: '存放角色常用句式、口头禅、典型回应参考。',
      },
    ]

    // ── tiny API helpers ───────────────────────────────────────────────────

    // The panel follows one conversation at a time; every data call is scoped to
    // it. `activeSession` is set by the panel before the first data request.
    let activeSession = ''

    function setActiveSession(sessionId) {
      activeSession = typeof sessionId === 'string' ? sessionId : ''
    }

    function withSession(path) {
      if (activeSession === '') return path
      const glue = path.includes('?') ? '&' : '?'
      return `${path}${glue}session=${encodeURIComponent(activeSession)}`
    }

    async function unwrap(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`请求失败（HTTP ${response.status}）`)
      }
      if (!payload || payload.ok !== true) {
        throw new Error((payload && payload.error && payload.error.message) || `请求失败（HTTP ${response.status}）`)
      }
      return payload.value
    }

    async function apiGet(path) {
      const response = await fetch(`${API_BASE}${withSession(path)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      return unwrap(response)
    }

    async function apiPost(path, body) {
      const payload = activeSession === '' ? body ?? {} : { ...(body ?? {}), session: activeSession }
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
      return unwrap(response)
    }

    function clockLabel() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    }

    function formatStamp(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function favourTone(value) {
      if (value <= -25) return 'cm-tone-bad'
      if (value < 25) return 'cm-tone-neutral'
      return 'cm-tone-good'
    }

    function signed(value) {
      return value > 0 ? `+${value}` : `${value}`
    }

    // ── shared bits ────────────────────────────────────────────────────────

    function Pill(props) {
      return h('span', { className: `cm-pill${props.warn ? ' cm-pill-warn' : ''}${props.tone ? ` ${props.tone}` : ''}` }, props.children)
    }

    function StatusBar(props) {
      const snapshot = props.snapshot
      if (!snapshot) return null
      const pending = snapshot.period && snapshot.period.due
      return h(
        'div',
        { className: 'cm-pills' },
        h(Pill, { tone: favourTone(snapshot.favorability) }, `好感度 ${signed(snapshot.favorability)}`),
        h(Pill, null, `交互日 ${snapshot.interactionDays}${snapshot.todayCounted ? '（今日已计）' : '（今日未计）'}`),
        h(Pill, null, `对话月 第${snapshot.cycle.index}周期 ${snapshot.cycle.daysInCycle}/${snapshot.cycle.length}`),
        h(Pill, null, `活跃记忆 ${snapshot.memories.activeCount}/${snapshot.memories.limit}`),
        h(Pill, { warn: pending }, pending ? '48小时归纳待完成' : '48小时归纳未到期'),
      )
    }

    // ── sidebar icon ───────────────────────────────────────────────────────

    function CompanionSidebarIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', margin: '0 auto' },
        },
        h('path', { d: 'M12 20.2c-1.4-1.15-6.6-5-6.6-9.4 0-2.55 1.9-4.4 4.2-4.4 1.2 0 2.1.55 2.4 1.35.3-.8 1.2-1.35 2.4-1.35 2.3 0 4.2 1.85 4.2 4.4 0 4.4-5.2 8.25-6.6 9.4Z' }),
        h('path', { d: 'M15.6 18.2h3.1M15.6 15.2h3.1M15.6 12.2h3.1', opacity: 0.65 }),
        h('path', { d: 'M6.2 20.6h11.6', opacity: 0.45 }),
      )
    }

    // ── config tab ─────────────────────────────────────────────────────────

    function pickFields(source) {
      const out = {}
      if (source && typeof source === 'object' && source.fields && typeof source.fields === 'object') {
        for (const key of Object.keys(source.fields)) {
          const value = source.fields[key]
          out[key] = typeof value === 'string' ? value : ''
        }
      }
      return out
    }

    function StructuredDoc(props) {
      const { docKey, title, schema, serverFields } = props
      const fieldsDef = schema && Array.isArray(schema.fields) ? schema.fields : []
      const intro = schema && Array.isArray(schema.intro) ? schema.intro : []
      const isSections = Boolean(schema && schema.layout === 'sections')
      const initialFields = pickFields(serverFields)
      const initialExtra = serverFields && typeof serverFields.extra === 'string' ? serverFields.extra : ''
      const [values, setValues] = useState(initialFields)
      const [extra, setExtra] = useState(initialExtra)
      const [dirty, setDirty] = useState(false)
      const [status, setStatus] = useState('已保存')
      const valuesRef = useRef(initialFields)
      const extraRef = useRef(initialExtra)
      const savedRef = useRef({ fields: initialFields, extra: initialExtra })
      const editedRef = useRef(false)
      const timerRef = useRef(null)

      useEffect(() => {
        if (editedRef.current) return
        const incoming = {
          fields: pickFields(serverFields),
          extra: serverFields && typeof serverFields.extra === 'string' ? serverFields.extra : '',
        }
        if (JSON.stringify(incoming) !== JSON.stringify(savedRef.current)) {
          savedRef.current = incoming
          valuesRef.current = incoming.fields
          extraRef.current = incoming.extra
          setValues(incoming.fields)
          setExtra(incoming.extra)
          setDirty(false)
          setStatus('已同步磁盘内容')
        }
      }, [serverFields])

      useEffect(
        () => () => {
          if (timerRef.current) clearTimeout(timerRef.current)
        },
        [],
      )

      const save = useCallback(async () => {
        const fields = valuesRef.current
        const extraValue = extraRef.current
        if (JSON.stringify({ fields, extra: extraValue }) === JSON.stringify(savedRef.current)) {
          editedRef.current = false
          setDirty(false)
          setStatus('已保存')
          return
        }
        try {
          await apiPost('/doc', { key: docKey, fields, extra: extraValue })
          savedRef.current = { fields, extra: extraValue }
          editedRef.current = false
          setDirty(false)
          setStatus(`已保存 ${clockLabel()}`)
        } catch (error) {
          setDirty(true)
          setStatus(`保存失败：${error.message}`)
        }
      }, [docKey])

      const scheduleSave = useCallback(() => {
        editedRef.current = true
        setDirty(true)
        setStatus('编辑中…')
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          save()
        }, 600)
      }, [save])

      const onFieldChange = useCallback(
        (key, value) => {
          const next = { ...valuesRef.current, [key]: value }
          valuesRef.current = next
          setValues(next)
          scheduleSave()
        },
        [scheduleSave],
      )

      const onExtraChange = useCallback(
        (value) => {
          extraRef.current = value
          setExtra(value)
          scheduleSave()
        },
        [scheduleSave],
      )

      const saveNow = useCallback(() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        save()
      }, [save])

      const badgeClass = dirty ? 'cm-badge cm-badge-warn' : 'cm-badge cm-badge-good'

      return h(
        'section',
        { className: 'cm-doc' },
        h(
          'div',
          { className: 'cm-doc-head' },
          h('h3', { className: 'cm-doc-title' }, title),
          h('span', { className: badgeClass }, status),
          h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: saveNow }, '立即保存'),
        ),
        intro.length > 0
          ? h(
              'div',
              { className: 'cm-doc-summary' },
              intro.map((line, index) => h('p', { key: index }, line)),
            )
          : null,
        h('p', { className: 'cm-lock' }, '以上说明文字为固定内容，不可删改；下面每个框单独填写，留空表示未设置。'),
        fieldsDef.map((field) =>
          h(
            'div',
            { className: 'cm-field', key: field.key },
            h('label', { htmlFor: `cm-${docKey}-${field.key}` }, field.label),
            h('textarea', {
              id: `cm-${docKey}-${field.key}`,
              className: 'cm-textarea',
              rows: isSections ? 3 : 2,
              spellCheck: false,
              placeholder: field.placeholder || '',
              value: typeof values[field.key] === 'string' ? values[field.key] : '',
              onChange: (event) => onFieldChange(field.key, event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'cm-extra' },
          h('label', { htmlFor: `cm-${docKey}-extra` }, '其他补充'),
          h('p', { className: 'cm-lock' }, '上面没覆盖到的设定可以写在这里，自由填写，非必填。'),
          h('textarea', {
            id: `cm-${docKey}-extra`,
            className: 'cm-textarea',
            rows: 3,
            spellCheck: false,
            placeholder: '例如：说话时会偶尔称呼用户「小笨蛋」，但只在关系亲近后使用。',
            value: extra,
            onChange: (event) => onExtraChange(event.target.value),
          }),
        ),
      )
    }

    function ConfigTab(props) {
      const snapshot = props.snapshot
      if (!snapshot) return h('div', { className: 'cm-empty' }, '加载中…')
      const schemaAll = snapshot.docSchema || {}
      const fieldsAll = snapshot.docFields || {}
      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'div',
          { className: 'cm-intro' },
          '这三份文档是角色的最高优先级配置：AI 每次对话前都会重新读取，保存后下一轮立刻生效。说明文字固定不可改，逐项填写即可。',
        ),
        DOC_DEFS.map((definition) =>
          h(StructuredDoc, {
            key: definition.key,
            docKey: definition.key,
            title: definition.title,
            schema: schemaAll[definition.key] || null,
            serverFields: fieldsAll[definition.key] || null,
          }),
        ),
      )
    }

    // ── memory tab ─────────────────────────────────────────────────────────

    function FavorabilityCard(props) {
      const { snapshot, refresh, notify } = props
      const [draft, setDraft] = useState(snapshot.favorability)
      const [reason, setReason] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        setDraft(snapshot.favorability)
      }, [snapshot.favorability])

      const submit = useCallback(async () => {
        if (reason.trim() === '') {
          notify('好感度变动必须写明理由', true)
          return
        }
        setBusy(true)
        try {
          const result = await apiPost('/favorability', { value: Number(draft), reason: reason.trim() })
          setReason('')
          notify(result && result.changed ? `好感度 ${result.from} → ${result.value}` : '好感度没有变化')
          await refresh()
        } catch (error) {
          notify(`更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [draft, reason, notify, refresh])

      const history = snapshot.favorabilityHistory || []

      return h(
        'section',
        { className: 'cm-card' },
        h('div', { className: 'cm-card-head' }, h('h3', null, '好感度'), h('span', { className: 'cm-muted' }, '-100 ~ 100')),
        h(
          'div',
          { className: 'cm-fav-row' },
          h('div', { className: `cm-fav-value ${favourTone(snapshot.favorability)}` }, signed(snapshot.favorability)),
          h(
            'div',
            { className: 'cm-fav-controls' },
            h('input', {
              className: 'cm-slider',
              type: 'range',
              min: -100,
              max: 100,
              step: 1,
              value: draft,
              onChange: (event) => setDraft(Number(event.target.value)),
            }),
            h('div', { className: 'cm-muted' }, `目标值：${signed(draft)}`),
          ),
        ),
        h('textarea', {
          className: 'cm-textarea cm-textarea-small',
          placeholder: '填写本次好感度变动理由（必填，例如：用户认真倾听了角色的烦恼并给出安慰）',
          value: reason,
          onChange: (event) => setReason(event.target.value),
          rows: 2,
        }),
        h(
          'div',
          { className: 'cm-actions' },
          h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: submit, disabled: busy }, busy ? '提交中…' : '更新好感度'),
        ),
        history.length > 0
          ? h(
              'ul',
              { className: 'cm-history' },
              history.map((change, index) =>
                h(
                  'li',
                  { key: `${change.at}-${index}` },
                  h('span', { className: 'cm-muted' }, formatStamp(change.at)),
                  h('span', { className: `cm-history-value ${favourTone(change.value)}` }, `${change.value}（${signed(change.value - change.from)}）`),
                  h('span', null, change.reason),
                ),
              ),
            )
          : h('p', { className: 'cm-muted' }, '暂无好感度变动记录。'),
      )
    }

    function MemoryCard(props) {
      const { memory } = props
      const [busy, setBusy] = useState(false)
      const archive = useCallback(async () => {
        setBusy(true)
        try {
          await apiPost('/memory/archive', { ids: [memory.id] })
          props.notify('已归档进知识库（原文未改动）')
          await props.refresh()
        } catch (error) {
          props.notify(`归档失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [memory.id, props])
      return h(
        'div',
        { className: 'cm-memory' },
        h('div', { className: 'cm-memory-text' }, memory.text),
        h(
          'div',
          { className: 'cm-memory-meta' },
          h('span', null, `保存于第 ${memory.createdInteractionDay ?? '?'} 交互日（${memory.createdDay}）`),
          h('span', null, `剩余 ${memory.remainingDays} 天`),
          (memory.tags || []).map((tag) => h('span', { key: tag, className: 'cm-tag' }, tag)),
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: archive, disabled: busy }, busy ? '归档中…' : '归档'),
        ),
      )
    }

    function MemoryTab(props) {
      const { snapshot, refresh, notify } = props
      const [draft, setDraft] = useState('')
      const [tags, setTags] = useState('')
      const [busy, setBusy] = useState(false)
      const [showArchived, setShowArchived] = useState(false)

      const saveImportant = useCallback(async () => {
        if (draft.trim() === '') {
          notify('请填写要保存的重点原文', true)
          return
        }
        setBusy(true)
        try {
          await apiPost('/memory/add', {
            text: draft,
            tags: tags
              .split(/[，,]/)
              .map((tag) => tag.trim())
              .filter((tag) => tag !== ''),
          })
          setDraft('')
          setTags('')
          notify('重点原文已保存到全局活跃记忆（原文保持不变）')
          await refresh()
        } catch (error) {
          notify(`保存失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [draft, tags, notify, refresh])

      const active = snapshot.memories.active || []
      const archived = snapshot.memories.archived || []

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(FavorabilityCard, { snapshot, refresh, notify }),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '全局活跃记忆'),
            h('span', { className: 'cm-muted' }, `${snapshot.memories.activeCount}/${snapshot.memories.limit} 条上限`),
          ),
          h('p', { className: 'cm-hint' }, '重点原文保持原样，AI 只能决定保存/调取，不能改写。满 30 个交互日后自动移入知识库。'),
          active.length === 0
            ? h('p', { className: 'cm-muted' }, '暂无活跃记忆。')
            : h('div', { className: 'cm-memory-list' }, active.map((memory) => h(MemoryCard, { key: memory.id, memory, refresh, notify }))),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '手动保存重点原文')),
          h('textarea', {
            className: 'cm-textarea cm-textarea-small',
            placeholder: '粘贴需要原样保存的重点内容（角色人设、核心设定、剧情关键节点、双方约定、用户固定偏好、主线伏笔）',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            rows: 3,
          }),
          h('input', {
            className: 'cm-input',
            type: 'text',
            placeholder: '可选标签，用逗号分隔',
            value: tags,
            onChange: (event) => setTags(event.target.value),
          }),
          h(
            'div',
            { className: 'cm-actions' },
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: saveImportant, disabled: busy }, busy ? '保存中…' : '保存为活跃记忆'),
          ),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'button',
            { className: 'cm-collapse', type: 'button', onClick: () => setShowArchived((value) => !value) },
            `${showArchived ? '▾' : '▸'} 已归档记忆（${snapshot.memories.archivedCount} 条）`,
          ),
          showArchived
            ? archived.length === 0
              ? h('p', { className: 'cm-muted' }, '暂无归档记忆。')
              : h(
                  'div',
                  { className: 'cm-memory-list' },
                  archived.map((memory) =>
                    h(
                      'div',
                      { key: memory.id, className: 'cm-memory cm-memory-archived' },
                      h('div', { className: 'cm-memory-text' }, memory.text),
                      h('div', { className: 'cm-memory-meta' }, h('span', null, `归档于 ${formatStamp(memory.archivedAt)}`)),
                    ),
                  ),
                )
            : null,
        ),
      )
    }

    // ── knowledge tab ──────────────────────────────────────────────────────

    function KnowledgeTab(props) {
      const { notify } = props
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [busy, setBusy] = useState(false)
      const [files, setFiles] = useState(props.snapshot ? props.snapshot.knowledge : { archive: [], monthly: [], packs: [] })
      const [viewer, setViewer] = useState(null)
      const [viewerBusy, setViewerBusy] = useState(false)
      const packInput = useRef(null)
      const autoPack = (props.snapshot && props.snapshot.autoPack) || { every: 0, turnsSince: 0, totalTurns: 0, count: 0, lastPackAt: null }

      useEffect(() => {
        if (props.snapshot && props.snapshot.knowledge) setFiles(props.snapshot.knowledge)
      }, [props.snapshot])

      useEffect(() => {
        const input = packInput.current
        if (input && document.activeElement !== input) input.value = String(autoPack.every)
      }, [autoPack.every])

      const saveAutoPack = useCallback(async () => {
        const raw = Number(packInput.current ? packInput.current.value : autoPack.every)
        if (!Number.isInteger(raw) || raw < 0 || raw > 200) {
          notify('请输入 0 ~ 200 之间的整数（0 表示关闭）', true)
          return
        }
        try {
          const value = await apiPost('/auto-pack', { every: raw })
          notify(value.every > 0 ? `已保存：每 ${value.every} 轮对话自动打包一次` : '已关闭自动打包')
        } catch (error) {
          notify(`保存失败：${error.message}`, true)
        }
      }, [autoPack.every, notify])

      const search = useCallback(async () => {
        if (query.trim() === '') {
          notify('请输入检索词', true)
          return
        }
        setBusy(true)
        try {
          const value = await apiPost('/search', { query: query.trim(), limit: 8 })
          setResults(value)
        } catch (error) {
          notify(`检索失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [query, notify])

      const openFile = useCallback(
        async (path) => {
          setViewerBusy(true)
          try {
            const value = await apiPost('/read', { path })
            setViewer(value)
          } catch (error) {
            notify(`读取失败：${error.message}`, true)
          } finally {
            setViewerBusy(false)
          }
        },
        [notify],
      )

      const renderFiles = (items, emptyText) => {
        if (!items || items.length === 0) return h('p', { className: 'cm-muted' }, emptyText)
        return h(
          'div',
          { className: 'cm-kb-list' },
          items.map((item) =>
            h(
              'button',
              { key: item.path, className: 'cm-kb-item', type: 'button', onClick: () => openFile(item.path) },
              h('span', { className: 'cm-kb-name' }, item.path.split('/').pop()),
              h('span', { className: 'cm-muted' }, item.day || ''),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '最近 48 小时上下文'),
            h('span', { className: 'cm-muted' }, props.snapshot && props.snapshot.recent ? `${props.snapshot.recent.count} 条消息` : '—'),
          ),
          h(
            'p',
            { className: 'cm-hint' },
            props.snapshot && props.snapshot.recent && props.snapshot.recent.count > 0
              ? `用户 ${props.snapshot.recent.userCount} 条 / 角色 ${props.snapshot.recent.assistantCount} 条，覆盖 ${formatStamp(props.snapshot.recent.oldestAt)} ~ ${formatStamp(props.snapshot.recent.newestAt)}。`
              : '最近 48 小时内还没有对话记录。',
          ),
          h('p', { className: 'cm-muted' }, 'AI 回答「刚才/最近/我们说过什么」时从这里检索原始对话原话；超过 48 小时的消息会自动清理，只保留下方知识库里的归档与归纳。'),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '自动打包'), h('span', { className: 'cm-muted' }, autoPack.every > 0 ? `每 ${autoPack.every} 轮一次` : '已关闭')),
          h(
            'p',
            { className: 'cm-hint' },
            '设置后，每累计 N 轮真实对话（你发一句 + 角色回一句算 1 轮），系统自动把这段时间的重点原文、次要摘要、48 小时归纳和好感度变更整理成一份「对话自动打包」文档，放进知识库一并检索。填 0 表示关闭。',
          ),
          h(
            'div',
            { className: 'cm-actions' },
            h('input', {
              ref: packInput,
              className: 'cm-input cm-input-narrow',
              type: 'number',
              min: 0,
              max: 200,
              step: 1,
              defaultValue: String(autoPack.every),
              'aria-label': '每多少轮对话自动打包一次',
            }),
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: saveAutoPack }, '保存'),
            h('span', { className: 'cm-muted' }, autoPack.every > 0 ? `当前区间 ${autoPack.turnsSince}/${autoPack.every} 轮，已打包 ${autoPack.count} 次${autoPack.lastPackAt ? `；上次 ${formatStamp(autoPack.lastPackAt)}` : ''}` : `已累计 ${autoPack.totalTurns} 轮对话`),
          ),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '知识库检索'), h('span', { className: 'cm-muted' }, '本地关键词检索')),
          h(
            'div',
            { className: 'cm-actions' },
            h('input', {
              className: 'cm-input cm-input-grow',
              type: 'text',
              placeholder: '例如：第一次见面、约定、旧事关键词',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') search()
              },
            }),
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: search, disabled: busy }, busy ? '检索中…' : '检索'),
          ),
          results
            ? results.results.length === 0
              ? h('p', { className: 'cm-muted' }, `没有检索到与「${results.query}」相关的内容。`)
              : h(
                  'div',
                  { className: 'cm-results' },
                  results.results.map((item, index) =>
                    h(
                      'div',
                      { key: `${item.file}-${index}`, className: 'cm-result' },
                      h(
                        'div',
                        { className: 'cm-result-head' },
                        h('span', { className: 'cm-muted' }, `${item.file}｜${item.day}`),
                        h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => openFile(item.file) }, '打开归档'),
                      ),
                      h('div', { className: 'cm-result-text' }, item.snippet),
                    ),
                  ),
                )
            : null,
        ),
        viewer
          ? h(
              'section',
              { className: 'cm-card' },
              h(
                'div',
                { className: 'cm-card-head' },
                h('h3', null, viewer.path),
                h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => setViewer(null) }, '关闭'),
              ),
              h('pre', { className: 'cm-pre' }, viewer.content),
            )
          : null,
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '月度打包文档'), h('span', { className: 'cm-muted' }, `${files.monthly.length} 份`)),
          renderFiles(files.monthly, '满 30 个聊天交互日后自动生成。'),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '自动打包文档'), h('span', { className: 'cm-muted' }, `${(files.packs || []).length} 份`)),
          renderFiles(files.packs || [], '按面板里设置的轮数间隔自动生成。'),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '按日期归档'), h('span', { className: 'cm-muted' }, `${files.archive.length} 天`)),
          renderFiles(files.archive, '暂未产生归档记录。'),
        ),
        viewerBusy ? h('div', { className: 'cm-muted' }, '读取中…') : null,
      )
    }

    // ── status tab ─────────────────────────────────────────────────────────

    function StatusTab(props) {
      const snapshot = props.snapshot
      if (!snapshot) return h('div', { className: 'cm-empty' }, '加载中…')
      const period = snapshot.period || {}
      const rows = [
        ['数据目录', snapshot.dataDir],
        ['当前时间', formatStamp(snapshot.updatedAt)],
        ['聊天交互日', `累计第 ${snapshot.interactionDays} 个${snapshot.todayCounted ? '（今天已计入）' : '（今天尚未计入）'}`],
        ['首次对话日', snapshot.firstInteractionDay || '—'],
        ['好感度', `${signed(snapshot.favorability)}（-100 ~ 100）`],
        ['48 小时归纳', period.due ? '已到期，等待本轮对话完成' : period.nextDueAt ? `未到期，预计 ${formatStamp(period.nextDueAt)}` : '尚未开始计时'],
        ['上次归纳时间', period.lastSummaryAt ? formatStamp(period.lastSummaryAt) : '—'],
        ['对话月周期', `第 ${snapshot.cycle.index} 周期，已进行 ${snapshot.cycle.daysInCycle}/${snapshot.cycle.length} 个交互日`],
        ['周期起始日', snapshot.cycle.startDate || '—'],
        ['活跃记忆', `${snapshot.memories.activeCount} 条（上限 ${snapshot.memories.limit} 个交互日自动归档）`],
        ['已归档记忆', `${snapshot.memories.archivedCount} 条`],
        ['知识库归档', `${snapshot.knowledge.archive.length} 天记录 · ${snapshot.knowledge.monthly.length} 份月度包 · ${(snapshot.knowledge.packs || []).length} 份自动打包`],
        ['自动打包', snapshot.autoPack && snapshot.autoPack.every > 0 ? `每 ${snapshot.autoPack.every} 轮一次（已打包 ${snapshot.autoPack.count} 次，当前区间 ${snapshot.autoPack.turnsSince}/${snapshot.autoPack.every} 轮，累计 ${snapshot.autoPack.totalTurns} 轮）` : '已关闭（可在知识库页设置）'],
        ['最近 48 小时上下文', snapshot.recent ? `${snapshot.recent.count} 条（用户 ${snapshot.recent.userCount} / 角色 ${snapshot.recent.assistantCount}）${snapshot.recent.newestAt ? `｜最新 ${formatStamp(snapshot.recent.newestAt)}` : ''}` : '—'],
        ['记录统计', `记录轮次 ${snapshot.stats.turnsRecorded} · 48h归纳 ${snapshot.stats.summaries} · 月度打包 ${snapshot.stats.monthlyPackages}`],
      ]
      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '运行状态')),
          h(
            'dl',
            { className: 'cm-kv' },
            rows.map(([key, value]) =>
              h('div', { key, className: 'cm-kv-row' }, h('dt', null, key), h('dd', null, String(value))),
            ),
          ),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '工作方式')),
          h(
            'ul',
            { className: 'cm-notes' },
            h('li', null, '侧边栏三份配置文档优先级最高，每次对话前自动读取最新内容。'),
            h('li', null, '重要信息原文进入全局活跃记忆，满 30 个聊天交互日后自动归档；次要内容只写简短摘要进知识库。'),
            h('li', null, '好感度 -100 ~ 100，每次对话结束由 AI 评估并记录理由，不聊天不会自动衰减。'),
            h('li', null, '48 小时归纳到期后，AI 会在下一轮对话完成时段小结；每满 30 个交互日自动生成月度打包文档。'),
            h('li', null, '可在知识库页设置「每 N 轮对话自动打包一次」：满 N 轮时系统自动把区间内的重点原文、次要摘要、归纳与好感度变更整理成知识库文档。'),
            h('li', null, '知识库归档格式：归档日期：YYYY-MM-DD HH:MM，按日期分组存放。'),
            h('li', null, '最近 48 小时内的原始对话会被缓存，AI 可直接检索原话；超过 48 小时自动清理，只保留知识库归档。'),
            h('li', null, '归档旧内容默认不加载，只有用户主动询问旧事时才会检索知识库。'),
          ),
        ),
      )
    }

    // ── overview tab (read-only) ───────────────────────────────────────────

    function OverviewTab(props) {
      const { notify } = props
      const [payload, setPayload] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [showFull, setShowFull] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const value = await apiGet('/prompt')
          setPayload(value)
          setError('')
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const copyFull = useCallback(async () => {
        if (!payload || !payload.full) return
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(payload.full)
            notify('已复制完整系统提示文本')
          } else {
            notify('当前环境不支持剪贴板 API', true)
          }
        } catch (caught) {
          notify(`复制失败：${caught.message}`, true)
        }
      }, [payload, notify])

      const sections = payload && Array.isArray(payload.sections) ? payload.sections : []

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'div',
          { className: 'cm-intro' },
          '这里以只读方式列出本插件注入给 AI 的每一块内容（固定文字不可编辑），方便你确认 AI 到底看到了什么。下方「整体」是这些内容拼成的完整段落；整段会随三份文档、好感度与记忆实时变化。',
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '各部分（只读）'),
            h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新'),
          ),
          h(
            'div',
            { className: 'cm-readonly' },
            sections.map((section) =>
              h(
                'div',
                { key: section.id, className: 'cm-block' },
                h(
                  'div',
                  { className: 'cm-block-head' },
                  h('h4', null, section.title),
                  section.editable
                    ? h('span', { className: 'cm-badge cm-badge-good' }, `可编辑 · ${section.file}`)
                    : h('span', { className: 'cm-badge' }, '固定内容'),
                ),
                h('pre', { className: 'cm-pre' }, section.content || '（空）'),
              ),
            ),
          ),
          error ? h('p', { className: 'cm-banner cm-banner-error' }, `读取失败：${error}`) : null,
          !payload && !error ? h('p', { className: 'cm-muted' }, '加载中…') : null,
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '整体（只读）'),
            h(
              'div',
              { className: 'cm-full-toggle' },
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => setShowFull((value) => !value) }, showFull ? '收起整体' : '展开整体'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: copyFull, disabled: !payload }, '复制全文'),
            ),
          ),
          h('p', { className: 'cm-hint' }, 'AI 实际收到的完整系统提示（本插件的整个段落）。内容与上方各部分一致，只是按顺序拼接在一起。'),
          showFull ? h('pre', { className: 'cm-pre' }, payload ? payload.full : '加载中…') : null,
        ),
      )
    }

    // ── panel ──────────────────────────────────────────────────────────────

    const TABS = [
      { id: 'config', label: '配置' },
      { id: 'memory', label: '记忆' },
      { id: 'knowledge', label: '知识库' },
      { id: 'status', label: '状态' },
      { id: 'overview', label: '总览' },
    ]

    function CompanionPanel() {
      const [snapshot, setSnapshot] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [sessionId, setSessionId] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [tab, setTab] = useState('config')
      const aliveRef = useRef(true)
      const sessionRef = useRef('')

      const notify = useCallback((message, isError) => {
        setNotice({ message, isError: Boolean(isError), at: Date.now() })
      }, [])

      const loadState = useCallback(async (target) => {
        setActiveSession(target)
        const value = await apiGet('/state')
        if (aliveRef.current) {
          setSnapshot(value)
          setError('')
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          setActiveSession('')
          const list = await apiGet('/sessions')
          if (!aliveRef.current) return
          setSessions(list)
          const items = (list && list.items) || []
          const known = new Set(items.map((item) => item.id))
          let target = sessionRef.current
          if (target && !known.has(target)) target = ''
          if (!target && list && list.current && known.has(list.current)) target = list.current
          if (!target) target = items[0]?.id || ''
          sessionRef.current = target
          setSessionId(target)
          if (!target) {
            setSnapshot({ enabled: false, sessionId: null })
            setError('')
            return
          }
          await loadState(target)
        } catch (caught) {
          if (aliveRef.current) setError(caught.message)
        }
      }, [loadState])

      useEffect(() => {
        aliveRef.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [refresh])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      const switchSession = useCallback(async (nextId) => {
        sessionRef.current = nextId
        setSessionId(nextId)
        setTab('config')
        setSnapshot(null)
        try {
          await loadState(nextId)
        } catch (caught) {
          setError(caught.message)
        }
      }, [loadState])

      const toggleEnabled = useCallback(async () => {
        const target = sessionRef.current
        if (!target) {
          notify('请先选择一个对话', true)
          return
        }
        setBusy(true)
        try {
          setActiveSession(target)
          const next = !(snapshot && snapshot.enabled === true)
          await apiPost('/enable', { enabled: next })
          notify(next ? '已开启本对话的伴侣记忆' : '已关闭本对话的伴侣记忆（数据仍保留）', false)
          await refresh()
        } catch (caught) {
          notify(caught.message, true)
        } finally {
          setBusy(false)
        }
      }, [snapshot, refresh, notify])

      const items = (sessions && sessions.items) || []
      const currentItem = items.find((item) => item.id === sessionId)
      const currentTitle = currentItem && currentItem.title ? currentItem.title : sessionId ? `对话 ${sessionId.slice(0, 8)}` : '尚未识别到对话'
      const enabled = Boolean(snapshot && snapshot.enabled === true)

      let body = h('div', { className: 'cm-empty' }, '加载中…')
      if (error && !snapshot) {
        body = h('div', { className: 'cm-empty' }, `无法连接 Host：${error}`)
      } else if (!enabled) {
        body = h(
          'div',
          { className: 'cm-guide' },
          h('h2', null, '这个对话还没有开启伴侣记忆'),
          h('p', null, '开启后，三份人格文档、好感度、全局活跃记忆、最近 48 小时上下文与知识库都只属于「' + currentTitle + '」，其他对话各自独立、互不干扰。'),
          h('p', null, '新对话默认是关闭的；你可以在上面的下拉框里切换到别的对话，也可以随时关闭本对话（数据会保留，不会删除）。'),
        )
      } else if (tab === 'config') {
        body = h(ConfigTab, { snapshot })
      } else if (tab === 'memory') {
        body = h(MemoryTab, { snapshot, refresh, notify })
      } else if (tab === 'knowledge') {
        body = h(KnowledgeTab, { snapshot, notify })
      } else if (tab === 'overview') {
        body = h(OverviewTab, { notify })
      } else {
        body = h(StatusTab, { snapshot })
      }

      return h(
        'div',
        { className: 'cm-root' },
        h(
          'header',
          { className: 'cm-header' },
          h(
            'div',
            { className: 'cm-title-row' },
            h('div', null, h('h1', { className: 'cm-title' }, '伴侣记忆'), h('p', { className: 'cm-sub' }, '每个对话独立：配置 · 好感度 · 记忆 · 知识库')),
            h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: refresh }, '刷新'),
          ),
          enabled && snapshot ? h(StatusBar, { snapshot }) : null,
          enabled
            ? h(
                'div',
                { className: 'cm-tabs' },
                TABS.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: `cm-tab${tab === item.id ? ' cm-tab-active' : ''}`,
                      onClick: () => setTab(item.id),
                    },
                    item.label,
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cm-session' },
          h(
            'div',
            { className: 'cm-session-row' },
            h(
              'div',
              { className: 'cm-session-info' },
              h('span', { className: 'cm-session-label' }, '当前对话'),
              h('span', { className: 'cm-session-name', title: sessionId || '' }, currentTitle),
              h('span', { className: `cm-badge${enabled ? ' cm-badge-on' : ''}` }, enabled ? '已开启' : '未开启'),
            ),
            items.length > 1
              ? h(
                  'select',
                  {
                    className: 'cm-select',
                    value: sessionId,
                    onChange: (event) => switchSession(event.target.value),
                  },
                  items.map((item) =>
                    h('option', { key: item.id, value: item.id }, `${item.enabled ? '● ' : '○ '}${item.title || `对话 ${item.id.slice(0, 8)}`}`),
                  ),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: `cm-btn cm-btn-small${enabled ? '' : ' cm-btn-primary'}`,
                disabled: busy || !sessionId,
                onClick: toggleEnabled,
              },
              busy ? '处理中…' : enabled ? '关闭本对话' : '开启本对话',
            ),
          ),
          h('div', { className: 'cm-hint' }, '每个对话拥有独立的人格文档、好感度、记忆与知识库；新对话默认关闭，开启或关闭都不会删除已有数据。'),
        ),
        error && snapshot ? h('div', { className: 'cm-banner' }, `Host 连接异常：${error}`) : null,
        notice
          ? h('div', { className: `cm-banner${notice.isError ? ' cm-banner-error' : ' cm-banner-ok'}` }, notice.message)
          : null,
        h('div', { className: 'cm-body' }, body),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const injectStyles = () => {
          const style = document.createElement('style')
          style.setAttribute('data-companion-memory', 'styles')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }

        ctx.effect(() => injectStyles(), 'companion-memory: panel styles')

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PLUGIN_ID,
                  order: 30,
                  label: () => '伴侣记忆',
                },
                CompanionSidebarIcon,
              ),
            ),
          'companion-memory: sidebar icon',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PLUGIN_ID,
                },
                CompanionPanel,
              ),
            ),
          'companion-memory: main panel',
        )
      },
    }
  },
})
