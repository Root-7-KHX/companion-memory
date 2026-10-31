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

    /** 通用可折叠卡片：标题栏点击展开/收起（默认收起）。 */
    function CollapsibleCard(props) {
      const { title, badge, defaultOpen = false, children } = props
      const [open, setOpen] = useState(defaultOpen)
      return h(
        'section',
        { className: 'cm-card' },
        h(
          'button',
          { className: 'cm-collapse', type: 'button', onClick: () => setOpen((value) => !value) },
          (open ? '▾ ' : '▸ ') + title + (badge ? '（' + badge + '）' : ''),
        ),
        open ? h('div', null, children) : null,
      )
    }

    const PLUGIN_ID = 'companion-memory'
    const API_BASE = '/companion/api'
    const POLL_MS = 5000
    /** 项目主页：面板底部的 Star 入口用，用户自己决定点不点。 */
    const REPO_URL = 'https://github.com/Root-7-KHX/companion-memory'

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
  --cm-btn-bg: #2f5bea;
  --cm-btn-hover-bg: #2853d6;
  --cm-btn-fg: #ffffff;
  --cm-danger: var(--dsw-alias-state-error-primary, #d92d20);
  --cm-success: var(--dsw-alias-state-success-primary, #067647);
  --cm-warn: var(--dsw-alias-state-warn-primary, #b54708);
  display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; z-index: 1; background: var(--cm-bg); color: var(--cm-text); font: 13px/1.55 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
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

.cm-int-toolbar { display: flex; align-items: center; gap: 8px; }
.cm-person-list { display: flex; flex-direction: column; gap: 10px; }
.cm-person-card { background: var(--cm-surface-2, rgba(15, 23, 42, 0.02)); }
.cm-person-memories { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.cm-person-memory { font-size: 12.5px; line-height: 1.55; color: var(--cm-text, #1f2328); }
.cm-person-memory-text { display: block; }
.cm-person-memory .cm-memory-meta { display: inline-flex; gap: 8px; margin-top: 1px; }
.cm-int-topline { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: -2px 0 -4px; }
.cm-int-topline-hint { font-size: 12px; line-height: 18px; color: var(--cm-text-2, #8b93a1); }
.cm-int-submit { font-size: 12px; line-height: 18px; color: var(--cm-text-2, #8b93a1); text-decoration: none; white-space: nowrap; }
.cm-int-submit:hover { color: var(--cm-brand, #4f6ef7); text-decoration: underline; }
.cm-search-field { position: relative; flex: 1 1 auto; display: flex; align-items: center; }
.cm-search-icon { position: absolute; left: 10px; font-size: 12px; color: var(--cm-text-2, #64748b); pointer-events: none; }
.cm-search-input { width: 100%; box-sizing: border-box; height: 34px; padding: 0 30px 0 30px; border-radius: 8px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.12)); background: var(--cm-bg, #ffffff); color: var(--cm-text, #1f2328); font: inherit; font-size: 13px; outline: none; }
.cm-search-input::placeholder { color: var(--cm-text-2, #94a3b8); }
.cm-search-input:focus { border-color: var(--cm-brand, #2f5bea); box-shadow: 0 0 0 3px rgba(47, 91, 234, 0.14); }
.cm-search-clear { position: absolute; right: 6px; border: 0; background: transparent; color: var(--cm-text-2, #64748b); cursor: pointer; font-size: 15px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
.cm-search-clear:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); color: var(--cm-text, #1f2328); }
.cm-int-meta { margin: 0; font-size: 12px; color: var(--cm-text-2, #64748b); }
.cm-app { display: flex; flex-direction: column; gap: 12px; }
.cm-qq-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0 4px; }
.cm-qq-peers { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 2px; }
.cm-qq-peer { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--cm-text, #1f2328); }

.cm-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; color: var(--cm-text, #1f2328); user-select: none; }
.cm-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.cm-switch-slider { width: 40px; height: 22px; border-radius: 999px; background: rgba(15, 23, 42, 0.28); position: relative; transition: background 0.18s ease; flex: 0 0 auto; }
.cm-switch-slider::after { content: ''; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.18s ease; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.cm-switch input:checked + .cm-switch-slider { background: #3b82f6; }
.cm-switch input:checked + .cm-switch-slider::after { transform: translateX(18px); }
.cm-qq-picker { position: relative; display: flex; flex-direction: column; gap: 6px; flex: 1 1 260px; min-width: 220px; }
.cm-qq-picker-btn { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-qq-picker-panel { position: absolute; z-index: 60; left: 0; right: 0; top: calc(100% + 4px); max-height: 340px; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.18)); border-radius: 10px; background: var(--cm-bg, #ffffff); box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22); }
.cm-qq-picker-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 6px; font-size: 12px; }
.cm-qq-folder { display: flex; flex-direction: column; gap: 2px; }
.cm-qq-folder-head { border: 0; background: transparent; text-align: left; font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: var(--cm-text, #1f2328); }
.cm-qq-folder-head:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); }
.cm-qq-session { border: 0; background: transparent; text-align: left; font: inherit; font-size: 12.5px; padding: 5px 8px 5px 22px; border-radius: 6px; cursor: pointer; color: var(--cm-text, #1f2328); display: flex; justify-content: space-between; gap: 8px; }
.cm-qq-session:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); }
.cm-qq-session-active { background: rgba(47, 91, 234, 0.1); color: var(--cm-brand, #2f5bea); font-weight: 600; }
.cm-qq-form .cm-input { flex: 1 1 180px; min-width: 140px; }
.cm-app-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; background: linear-gradient(135deg, #1e6fff, #0b3fbf); color: #fff; }
.cm-app-title { flex: 1 1 auto; }
.cm-app-head h2 { margin: 0; font-size: 17px; }
.cm-app-sub { margin: 2px 0 0; font-size: 12px; opacity: 0.85; }
.cm-app-body { display: flex; flex-direction: column; gap: 10px; }
.cm-app-card { border: 1px solid rgba(30, 111, 255, 0.22); border-radius: 10px; padding: 12px; background: rgba(30, 111, 255, 0.045); }
.cm-app-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cm-app-card h3 { margin: 0; font-size: 13.5px; }
.cm-qq-members { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cm-qq-member { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
.cm-qq-name { font-weight: 600; }
.cm-qq-id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #1e6fff; }
.cm-qq-plan { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8; }
.cm-app-credits { background: rgba(15, 23, 42, 0.03); border-color: var(--cm-border, rgba(15, 23, 42, 0.12)); }
.cm-int-open { margin-left: auto; }
.cm-int-section { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
.cm-int-section-head { display: flex; align-items: baseline; gap: 8px; }
.cm-int-section-head h3 { margin: 0; font-size: 13px; font-weight: 650; }
.cm-int-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 10px; }
.cm-int-card { display: flex; flex-direction: column; gap: 7px; padding: 12px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 10px; background: var(--cm-bg, #ffffff); }
.cm-int-card:hover { border-color: var(--cm-border-strong, rgba(15, 23, 42, 0.24)); }
.cm-int-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cm-int-card-name { margin: 0; font-size: 13.5px; font-weight: 650; }
.cm-int-card-ver { font-size: 11px; color: var(--cm-text-2, #64748b); font-variant-numeric: tabular-nums; }
.cm-int-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.cm-int-tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); color: var(--cm-text-2, #475569); }
.cm-int-tag-strong { color: var(--cm-brand, #2f5bea); background: rgba(47, 91, 234, 0.1); }
.cm-int-card-desc { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--cm-text-2, #475569); }
.cm-int-card-foot { display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 2px; }
.cm-int-link { margin-left: auto; font-size: 12px; color: var(--cm-brand, #2f5bea); text-decoration: none; }
.cm-int-link:hover { text-decoration: underline; }
.cm-int-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 34px 8px; }
.cm-int-empty-title { font-size: 13.5px; font-weight: 600; color: var(--cm-text, #1f2328); }
.cm-int-empty p { margin: 0; max-width: 520px; line-height: 1.6; }
.cm-int-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; padding: 6px 9px; border-radius: 6px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.05)); color: var(--cm-text, #1f2328); word-break: break-all; }
.cm-int-empty-actions { display: flex; gap: 8px; margin-top: 4px; }
.cm-int-guide { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 10px; background: var(--cm-bg, #ffffff); }
.cm-int-guide-toggle { width: 100%; text-align: left; border: 0; background: transparent; color: var(--cm-text, #1f2328); font: inherit; font-size: 13px; padding: 10px 12px; cursor: pointer; border-radius: 9px; }
.cm-int-guide-toggle:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); }
.cm-int-guide-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; line-height: 1.65; color: var(--cm-text-2, #475569); }
.cm-int-guide-body ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.cm-int-guide-body p { margin: 0; }
.cm-int-guide-body .cm-pre { margin: 0; }
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
.cm-weight { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--cm-text-2, #64748b); }
.cm-weight-input { width: 58px; box-sizing: border-box; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); border-radius: 6px; background: var(--cm-surface-2, #f8fafc); color: var(--cm-text, #1f2328); font: inherit; font-size: 11.5px; padding: 1px 4px; text-align: center; }
.cm-weight-input:focus { outline: 2px solid var(--cm-brand, #2f6bff); outline-offset: -1px; }
.cm-footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 14px 12px; border-top: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); }
.cm-footer-link { color: var(--cm-brand, #2f6bff); font-size: 12px; text-decoration: none; }
.cm-footer-link:hover { text-decoration: underline; }
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
.cm-btn { appearance: none; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); background: var(--cm-bg, #ffffff); color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; padding: 5px 12px; border-radius: 7px; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, filter 120ms ease; }
.cm-btn:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.05)); border-color: var(--cm-border-strong, rgba(15, 23, 42, 0.28)); }
.cm-btn:active { filter: brightness(0.96); }
.cm-btn:focus-visible { outline: 2px solid var(--cm-brand, #2f6bff); outline-offset: 1px; }
.cm-btn:disabled, .cm-btn:disabled:hover { opacity: 0.55; cursor: default; }
/* 主按钮在 hover 时保持蓝底白字：否则通用 .cm-btn:hover 的近白背景会盖掉蓝色，白字就「消失」了 */
.cm-btn-primary { background: var(--cm-btn-bg, #2f5bea); border-color: var(--cm-btn-bg, #2f5bea); color: var(--cm-btn-fg, #ffffff); font-weight: 600; }
.cm-btn-primary:hover { background: var(--cm-btn-hover-bg, #2853d6); border-color: var(--cm-btn-hover-bg, #2853d6); color: var(--cm-btn-fg, #ffffff); }
.cm-btn-primary:active { filter: brightness(0.92); }
.cm-btn-primary:disabled, .cm-btn-primary:disabled:hover { background: var(--cm-btn-bg, #2f5bea); border-color: var(--cm-btn-bg, #2f5bea); color: var(--cm-btn-fg, #ffffff); filter: none; }
.cm-btn-small { padding: 3px 9px; font-size: 12px; }
.cm-btn-ghost { background: transparent; }
.cm-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.cm-import-preview { margin-top: 12px; padding: 10px 12px; border: 1px dashed var(--cm-border-strong, rgba(15, 23, 42, 0.24)); border-radius: 8px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.03)); }
.cm-check { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--cm-text); cursor: pointer; }
.cm-check input { accent-color: var(--cm-brand, #2f6bff); }
.cm-fav-row { display: flex; align-items: center; gap: 14px; margin: 10px 0 4px; }
/* 每个说话人一条独立滑条 */
.cm-fav-list { display: flex; flex-direction: column; gap: 10px; margin: 10px 0 6px; }
.cm-fav-row-inline { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'head head' 'slider slider' 'foot foot'; gap: 6px 10px; align-items: center; margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.03)); }
.cm-fav-row-inline.cm-fav-row-current { outline: 1px solid var(--cm-brand, #2f6bff); outline-offset: -1px; }
.cm-fav-inline-head { grid-area: head; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cm-fav-name { font-weight: 600; font-size: 13px; }
.cm-fav-value-sm { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
  .cm-fav-inline-values { display: inline-flex; align-items: baseline; gap: 8px; }
  .cm-bond-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); color: var(--cm-text-2, #64748b); font-variant-numeric: tabular-nums; }
  .cm-bond-line { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .cm-bond-btn { width: 22px; height: 22px; line-height: 1; padding: 0; border-radius: 6px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.14)); background: var(--cm-surface, #fff); color: var(--cm-text-2, #475569); font-size: 12px; cursor: pointer; }
  .cm-bond-btn:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); }
  .cm-history-bond { font-size: 11px; color: #b45309; font-variant-numeric: tabular-nums; }
.cm-fav-row-inline .cm-slider { grid-area: slider; }
.cm-fav-inline-foot { grid-area: foot; display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.cm-input-small { height: 28px; font-size: 12px; }
/* 配置页文档：每条设定一行（文字 + 权重 + 删除），新增条目一次可加多条 */
.cm-doc-items { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.cm-doc-item { display: flex; align-items: center; gap: 6px; padding: 5px 7px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.1)); border-radius: 8px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.025)); }
.cm-doc-item-text { flex: 1 1 auto; width: auto; min-width: 0; height: 30px; box-sizing: border-box; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); border-radius: 6px; background: var(--cm-bg, #ffffff); color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; padding: 3px 8px; }
.cm-doc-item-text:focus { outline: 2px solid var(--cm-brand, #2f6bff); outline-offset: -1px; }
.cm-doc-item-weight { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--cm-text-2, #64748b); }
.cm-doc-item-weight .cm-weight-input { width: 52px; }
.cm-doc-item-del { flex: 0 0 auto; width: 24px; height: 24px; padding: 0; line-height: 1; font-size: 12px; }
.cm-doc-item-del:hover { color: var(--cm-danger, #d92d20); }
.cm-doc-empty { margin: 0; font-size: 11.5px; color: var(--cm-text-2, #64748b); }
.cm-doc-add { display: flex; align-items: flex-end; gap: 6px; margin-top: 2px; }
.cm-doc-add-text { flex: 1 1 auto; width: auto; min-width: 0; }
.cm-field .cm-doc-add-text { min-height: 44px; }
.cm-doc-add-btn { flex: 0 0 auto; }
/* 好感度卡片跟随页面一起滚动（不做任何固定，避免遮住下面的内容） */
.cm-fav-value { font-size: 34px; font-weight: 700; min-width: 84px; font-variant-numeric: tabular-nums; color: var(--cm-text); }
.cm-fav-controls { flex: 1 1 auto; }
.cm-slider { width: 100%; accent-color: var(--cm-brand, #2f6bff); }
.cm-history { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.cm-history li { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 12px; padding: 4px 6px; border-radius: 6px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.03)); }
.cm-history-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.cm-memory-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.cm-clean-option { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0 2px; font-size: 12px; color: var(--cm-text-2, #475569); cursor: pointer; }
.cm-clean-option input { margin-top: 2px; accent-color: var(--cm-brand, #2f6bff); }
.cm-health { margin: 4px 0 2px; }
.cm-health-list { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--cm-text-2, #475569); display: flex; flex-direction: column; gap: 3px; }
.cm-evo-block { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--cm-border, rgba(15, 23, 42, 0.12)); }
.cm-evo-block:first-of-type { border-top: none; padding-top: 0; }
.cm-evo-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.cm-evo-add { display: flex; gap: 8px; margin-top: 8px; }
.cm-hint-tight { margin: 2px 0 0; }
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
.cm-session { margin: 8px 16px 0; padding: 10px 12px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.14)); border-radius: 10px; background: var(--cm-surface-2, rgba(15, 23, 42, 0.04)); display: flex; flex-direction: column; gap: 6px; position: relative; z-index: 20; }
.cm-session-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cm-session-info { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; flex-wrap: wrap; }
.cm-session-label { font-size: 12px; color: var(--cm-text-2, #64748b); }
.cm-session-name { font-size: 13px; font-weight: 600; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-badge { border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.16)); border-radius: 999px; padding: 0 7px; font-size: 11px; color: var(--cm-text-2, #64748b); }
.cm-badge-on { border-color: var(--cm-success, #067647); color: var(--cm-success, #067647); }
.cm-select { appearance: auto; background: var(--cm-surface, #ffffff); color: var(--cm-text, #1f2328); border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.18)); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12.5px; max-width: 320px; }
.cm-session-workspace { font-size: 11.5px; color: var(--cm-text-2, #64748b); border: 1px dashed var(--cm-border, rgba(15, 23, 42, 0.18)); border-radius: 999px; padding: 0 8px; }
.cm-picker { display: inline-flex; }
.cm-picker-menu { position: absolute; left: 12px; right: 12px; top: calc(100% - 2px); z-index: 40; max-height: 340px; overflow: auto; padding: 6px; border: 1px solid var(--cm-border, rgba(15, 23, 42, 0.18)); border-radius: 10px; background: var(--cm-bg, #ffffff); backdrop-filter: blur(18px) saturate(1.1); box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22); display: flex; flex-direction: column; gap: 2px; }
.cm-picker-backdrop { position: fixed; inset: 0; z-index: 30; background: transparent; }
.cm-picker-group { display: flex; flex-direction: column; gap: 1px; }
.cm-picker-group-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--cm-text-2, #475569); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.cm-picker-group-head:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); }
  .cm-picker-new { margin-left: 6px; padding: 2px 8px; font-size: 11px; flex: 0 0 auto; }
.cm-picker-caret { width: 12px; font-size: 11px; color: var(--cm-text-2, #64748b); }
.cm-picker-group-name { font-weight: 600; color: var(--cm-text, #1f2328); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-picker-group-count { margin-left: auto; font-size: 11px; color: var(--cm-text-2, #64748b); }
.cm-picker-session { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px 5px 24px; border: 0; border-radius: 7px; background: transparent; color: var(--cm-text, #1f2328); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; }
.cm-picker-session:hover { background: var(--cm-surface-2, rgba(15, 23, 42, 0.06)); }
.cm-picker-session-active { background: var(--cm-surface-2, rgba(15, 23, 42, 0.09)); font-weight: 600; }
.cm-picker-dot { font-size: 10px; color: var(--cm-brand, #2f5bea); }
.cm-picker-session-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

    /** 顶部视图 → 侧边栏面板的快速跳转：记住要打开的页签和对话，并切到伴侣记忆面板。 */
    let pendingPanelTab = ''
    let pendingPanelSession = ''
    function openCompanionPanel(tabId, sessionId) {
      pendingPanelTab = typeof tabId === 'string' && tabId !== '' ? tabId : 'config'
      pendingPanelSession = typeof sessionId === 'string' ? sessionId : ''
      try {
        window.dispatchEvent(new CustomEvent('companion-memory:set-tab', { detail: { tab: pendingPanelTab, sessionId: pendingPanelSession } }))
      } catch {
        // CustomEvent 不可用时只靠 pendingPanelTab 生效
      }
      try {
        const layout = (hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('layout') : null)
          || (hostCtx && hostCtx.layout)
        if (layout && typeof layout.selectPanel === 'function') {
          layout.selectPanel(PLUGIN_ID)
          return
        }
      } catch {
        // 落到下面的兜底
      }
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('companion-memory:open-panel'))
        }
      } catch {
        // ignore
      }
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

    // ── theme-aware contrast helpers ───────────────────────────────────────
    // The host theme can be light or dark: `--dsw-alias-brand-primary` is a pale
    // yellow in the dark theme but a dark ink in the light theme. A fixed text
    // color on the brand background therefore becomes unreadable after a theme
    // switch, so we derive the readable foreground from the actual brand color.

    function parseCssColor(value) {
      if (!value) return null
      const text = String(value).trim()
      const rgb = text.match(/^rgba?\(\s*([^)]+)\)$/i)
      if (rgb) {
        const parts = rgb[1]
          .split(/[,\s/]+/)
          .filter((part) => part !== '')
          .map(Number)
        if (parts.length < 3 || Number.isNaN(parts[0]) || Number.isNaN(parts[1]) || Number.isNaN(parts[2])) return null
        // Fully transparent fills give no information about the painted color.
        if (parts.length >= 4 && !Number.isNaN(parts[3]) && parts[3] === 0) return null
        return parts.slice(0, 3)
      }
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
      if (!hex) return null
      let digits = hex[1]
      if (digits.length === 3) digits = digits.split('').map((char) => char + char).join('')
      const number = parseInt(digits.slice(0, 6), 16)
      return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
    }

    function relativeLuminance(value) {
      const channels = parseCssColor(value)
      if (!channels) return null
      const linear = channels.map((channel) => {
        const scaled = channel / 255
        return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    function readableTextColor(background) {
      const luminance = relativeLuminance(background)
      if (luminance === null) return null
      // Contrast ratio against #14171c and against #ffffff; pick the bigger one.
      const contrastDark = (luminance + 0.05) / 0.05
      const contrastLight = 1.05 / (luminance + 0.05)
      return contrastDark >= contrastLight ? '#14171c' : '#ffffff'
    }

    // Fallback when the button fill cannot be read: a light page background means
    // a light theme, whose accent surface is usually dark, and vice versa.
    function invertedTextColor(background) {
      const luminance = relativeLuminance(background)
      if (luminance === null) return null
      return luminance > 0.42 ? '#ffffff' : '#14171c'
    }

    // ── shared bits ────────────────────────────────────────────────────────

    function Pill(props) {
      return h('span', { className: `cm-pill${props.warn ? ' cm-pill-warn' : ''}${props.tone ? ` ${props.tone}` : ''}` }, props.children)
    }

    function StatusBar(props) {
      const snapshot = props.snapshot
      if (!snapshot) return null
      const pending = snapshot.period && snapshot.period.due
      const currentSpeaker = (snapshot.speakers || []).find((item) => item.isCurrent) || null
      return h(
        'div',
        { className: 'cm-pills' },
        h(Pill, { tone: favourTone(snapshot.favorability) }, currentSpeaker && currentSpeaker.id !== 'default' ? `${currentSpeaker.name} 好感 ${signed(snapshot.favorability)}` : `角色对你好感 ${signed(snapshot.favorability)}`),
        (snapshot.speakers || []).length > 1 ? h(Pill, null, `在场 ${snapshot.speakers.length} 人`) : null,
        h(Pill, null, `交互日 ${snapshot.interactionDays}${snapshot.todayCounted ? '（今日已计）' : '（今日未计）'}`),
        h(Pill, null, `对话月 第${snapshot.cycle.index}周期 ${snapshot.cycle.daysInCycle}/${snapshot.cycle.length}`),
        h(Pill, null, `活跃记忆 ${snapshot.memories.activeCount}/${snapshot.memories.limit}`),
        h(Pill, { warn: pending }, pending ? '48小时(聊天)归纳待完成' : '48小时(聊天)归纳未到期'),
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

    // ── 配置文档：条目（文字 + 权重）归一化 ───────────────────────────────
    //
    // 新契约把每个字段解析成 [{ text, weight }]；旧快照只有字符串时，这里在前端
    // 按「；」「;」/换行拆成条目兜底，并识别条目尾部「〔90〕」形式的权重标记。

    const DOC_ITEM_WEIGHT_DEFAULT = 50
    const DOC_ITEM_WEIGHT_MIN = 1
    const DOC_ITEM_WEIGHT_MAX = 100
    const DOC_ITEM_SPLIT_RE = /[；;\n]+/
    const DOC_ITEM_WEIGHT_MARK_RE = /\s*〔(\d{1,3})〕\s*$/

    function clampDocItemWeight(value) {
      const number = Math.round(Number(value))
      if (!Number.isFinite(number)) return DOC_ITEM_WEIGHT_DEFAULT
      return Math.min(DOC_ITEM_WEIGHT_MAX, Math.max(DOC_ITEM_WEIGHT_MIN, number))
    }

    function splitDocItemText(raw) {
      return String(raw ?? '')
        .split(DOC_ITEM_SPLIT_RE)
        .map((part) => part.trim())
        .filter((part) => part !== '')
    }

    /** 一条字符串可能以「〔90〕」结尾（AI 写进 markdown 的权重标记）；空文本返回 null。 */
    function parseDocItemLine(raw) {
      let text = String(raw ?? '').trim()
      let weight = DOC_ITEM_WEIGHT_DEFAULT
      const marked = DOC_ITEM_WEIGHT_MARK_RE.exec(text)
      if (marked) {
        weight = clampDocItemWeight(marked[1])
        text = text.slice(0, marked.index).trim()
      }
      return text === '' ? null : { text, weight }
    }

    function splitDocFieldString(value) {
      const out = []
      for (const part of splitDocItemText(value)) {
        const item = parseDocItemLine(part)
        if (item) out.push(item)
      }
      return out
    }

    function normalizeDocItemList(list) {
      const out = []
      if (!Array.isArray(list)) return out
      for (const entry of list) {
        if (entry && typeof entry === 'object') {
          const text = String(entry.text ?? '').trim()
          if (text !== '') out.push({ text, weight: clampDocItemWeight(entry.weight) })
          continue
        }
        // 服务器也兼容字符串（旧数据/手写 state）：按分隔符拆开再逐条解析。
        if (typeof entry === 'string') out.push(...splitDocFieldString(entry))
      }
      return out
    }

    /**
     * 取某份文档各字段的条目：
     * 1. snapshot.docItems[docKey].fields 存在 → 直接用（后端新契约）；
     * 2. 否则退回旧 snapshot.docFields 的字符串，在前端拆分兜底。
     */
    function buildDocItemFields(serverItems, serverFields, fieldsDef) {
      const out = {}
      const itemFields = serverItems && typeof serverItems === 'object' && serverItems.fields && typeof serverItems.fields === 'object'
        ? serverItems.fields
        : null
      const stringFields = {}
      if (serverFields && typeof serverFields === 'object' && serverFields.fields && typeof serverFields.fields === 'object') {
        for (const key of Object.keys(serverFields.fields)) {
          const value = serverFields.fields[key]
          stringFields[key] = typeof value === 'string' ? value : ''
        }
      }
      for (const field of fieldsDef) {
        if (itemFields) out[field.key] = normalizeDocItemList(itemFields[field.key])
        else out[field.key] = splitDocFieldString(stringFields[field.key])
      }
      return out
    }

    /** 「其他补充」：新契约在 docItems[docKey].extra，旧快照仍在 docFields[docKey].extra。 */
    function docItemExtra(serverItems, serverFields) {
      if (serverItems && typeof serverItems === 'object' && typeof serverItems.extra === 'string') return serverItems.extra
      if (serverFields && typeof serverFields === 'object' && typeof serverFields.extra === 'string') return serverFields.extra
      return ''
    }

    /** 保存前归一化：trim、丢掉空条目、权重夹到 1~100；顺序保持界面顺序。 */
    function serializeDocItemFields(items) {
      const out = {}
      for (const key of Object.keys(items || {})) {
        const list = Array.isArray(items[key]) ? items[key] : []
        const next = []
        for (const item of list) {
          if (!item || typeof item !== 'object') continue
          const text = String(item.text ?? '').trim()
          if (text === '') continue
          next.push({ text, weight: clampDocItemWeight(item.weight) })
        }
        out[key] = next
      }
      return out
    }

    /** 条目权重输入框（1~100，默认 50）：不逐键保存，回车/失焦时 clamp 并提交。 */
    function DocItemWeightInput(props) {
      const { value, onCommit } = props
      const [draft, setDraft] = useState(String(value))
      const editingRef = useRef(false)

      useEffect(() => {
        if (!editingRef.current) setDraft(String(value))
      }, [value])

      const commit = () => {
        editingRef.current = false
        const raw = String(draft).trim()
        const next = raw === '' ? DOC_ITEM_WEIGHT_DEFAULT : clampDocItemWeight(raw)
        setDraft(String(next))
        if (next !== clampDocItemWeight(value)) onCommit(next)
      }

      return h('input', {
        className: 'cm-weight-input',
        type: 'number',
        min: DOC_ITEM_WEIGHT_MIN,
        max: DOC_ITEM_WEIGHT_MAX,
        step: 1,
        value: draft,
        title: '权重 1~100：越大越重要、越优先（默认 50）',
        onChange: (event) => {
          editingRef.current = true
          setDraft(event.target.value)
        },
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      })
    }

    function StructuredDoc(props) {
      const { docKey, title, schema, serverItems, serverFields } = props
      const fieldsDef = schema && Array.isArray(schema.fields) ? schema.fields : []
      const intro = schema && Array.isArray(schema.intro) ? schema.intro : []
      const initialItems = buildDocItemFields(serverItems, serverFields, fieldsDef)
      const initialExtra = docItemExtra(serverItems, serverFields)
      const [items, setItems] = useState(initialItems)
      const [extra, setExtra] = useState(initialExtra)
      // 每个字段「待添加」的草稿：{ [fieldKey]: string }，用户可一次贴多条。
      const [drafts, setDrafts] = useState({})
      const [dirty, setDirty] = useState(false)
      const [status, setStatus] = useState('已保存')
      const itemsRef = useRef(initialItems)
      const extraRef = useRef(initialExtra)
      const savedRef = useRef({ fields: serializeDocItemFields(initialItems), extra: initialExtra })
      const editedRef = useRef(false)
      const timerRef = useRef(null)

      useEffect(() => {
        if (editedRef.current) return
        const incoming = {
          fields: serializeDocItemFields(buildDocItemFields(serverItems, serverFields, fieldsDef)),
          extra: docItemExtra(serverItems, serverFields),
        }
        if (JSON.stringify(incoming) !== JSON.stringify(savedRef.current)) {
          savedRef.current = incoming
          itemsRef.current = incoming.fields
          extraRef.current = incoming.extra
          setItems(incoming.fields)
          setExtra(incoming.extra)
          setDirty(false)
          setStatus('已同步磁盘内容')
        }
      }, [serverItems, serverFields])

      useEffect(
        () => () => {
          if (timerRef.current) clearTimeout(timerRef.current)
        },
        [],
      )

      const save = useCallback(async () => {
        const fields = serializeDocItemFields(itemsRef.current)
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

      const replaceFieldItems = useCallback(
        (fieldKey, nextList) => {
          const next = { ...itemsRef.current, [fieldKey]: nextList }
          itemsRef.current = next
          setItems(next)
          scheduleSave()
        },
        [scheduleSave],
      )

      const changeItemText = useCallback(
        (fieldKey, index, text) => {
          const current = Array.isArray(itemsRef.current[fieldKey]) ? itemsRef.current[fieldKey] : []
          replaceFieldItems(fieldKey, current.map((item, itemIndex) => (itemIndex === index ? { ...item, text } : item)))
        },
        [replaceFieldItems],
      )

      const changeItemWeight = useCallback(
        (fieldKey, index, weight) => {
          const current = Array.isArray(itemsRef.current[fieldKey]) ? itemsRef.current[fieldKey] : []
          replaceFieldItems(fieldKey, current.map((item, itemIndex) => (itemIndex === index ? { ...item, weight: clampDocItemWeight(weight) } : item)))
        },
        [replaceFieldItems],
      )

      const removeItem = useCallback(
        (fieldKey, index) => {
          const current = Array.isArray(itemsRef.current[fieldKey]) ? itemsRef.current[fieldKey] : []
          replaceFieldItems(fieldKey, current.filter((item, itemIndex) => itemIndex !== index))
        },
        [replaceFieldItems],
      )

      const setDraft = useCallback((fieldKey, value) => {
        setDrafts((previous) => ({ ...previous, [fieldKey]: value }))
      }, [])

      const addItems = useCallback(
        (fieldKey) => {
          const candidates = splitDocItemText(drafts[fieldKey] ?? '')
          if (candidates.length === 0) return
          setDraft(fieldKey, '')
          const current = Array.isArray(itemsRef.current[fieldKey]) ? itemsRef.current[fieldKey] : []
          const existing = new Set(current.map((item) => String(item.text ?? '').trim()))
          const added = []
          for (const candidate of candidates) {
            if (existing.has(candidate)) continue
            existing.add(candidate)
            added.push({ text: candidate, weight: DOC_ITEM_WEIGHT_DEFAULT })
          }
          if (added.length === 0) return
          replaceFieldItems(fieldKey, current.concat(added))
        },
        [drafts, replaceFieldItems, setDraft],
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
        h('p', { className: 'cm-lock' }, '以上说明文字为固定内容，不可删改；下面每个字段由一条条独立设定组成，每条都能单独改文字、改 1~100 的权重或删除。'),
        fieldsDef.map((field) => {
          const fieldItems = Array.isArray(items[field.key]) ? items[field.key] : []
          return h(
            'div',
            { className: 'cm-field', key: field.key },
            h('label', { htmlFor: `cm-${docKey}-${field.key}-add` }, field.label),
            fieldItems.length === 0
              ? h('p', { className: 'cm-doc-empty' }, '还没有条目，下面加一条。')
              : h(
                  'div',
                  { className: 'cm-doc-items' },
                  fieldItems.map((item, index) =>
                    h(
                      'div',
                      { className: 'cm-doc-item', key: `${field.key}-${index}` },
                      h('input', {
                        className: 'cm-doc-item-text',
                        type: 'text',
                        spellCheck: false,
                        placeholder: '这一条设定',
                        title: '这条设定（改完自动保存）',
                        value: typeof item.text === 'string' ? item.text : '',
                        onChange: (event) => changeItemText(field.key, index, event.target.value),
                      }),
                      h(
                        'span',
                        { className: 'cm-doc-item-weight', title: '权重 1~100：越大越重要、越优先（默认 50）' },
                        '权重',
                        h(DocItemWeightInput, {
                          value: item.weight,
                          onCommit: (weight) => changeItemWeight(field.key, index, weight),
                        }),
                      ),
                      h(
                        'button',
                        {
                          className: 'cm-btn cm-btn-small cm-btn-ghost cm-doc-item-del',
                          type: 'button',
                          title: '删除这一条',
                          'aria-label': '删除这一条',
                          onClick: () => removeItem(field.key, index),
                        },
                        '✕',
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'cm-doc-add' },
              h('textarea', {
                id: `cm-${docKey}-${field.key}-add`,
                className: 'cm-textarea cm-doc-add-text',
                rows: 2,
                spellCheck: false,
                placeholder: field.placeholder
                  ? `${field.placeholder}（一次加多条用「；」隔开）`
                  : '一条设定一条；一次加多条用「；」「;」或换行隔开',
                value: typeof drafts[field.key] === 'string' ? drafts[field.key] : '',
                onChange: (event) => setDraft(field.key, event.target.value),
              }),
              h(
                'button',
                { className: 'cm-btn cm-btn-small cm-doc-add-btn', type: 'button', onClick: () => addItems(field.key) },
                '添加',
              ),
            ),
          )
        }),
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

    /**
     * 角色（AI）自己的名字：配置页最顶上单独一块，不属于任何一份可编辑文档，
     * 因此 AI 的 edit_doc 改不到它（后端也只有 /character-name* 这两条写入路径）。
     *
     * 两层取值：本对话覆盖（空 = 不覆盖）优先，否则用「所有对话通用」的默认值。
     */
    function CharacterNameCard(props) {
      const globalServer = typeof props.globalValue === 'string' ? props.globalValue : ''
      const overrideServer = typeof props.overrideValue === 'string' ? props.overrideValue : ''
      const effective = typeof props.effective === 'string' ? props.effective : ''
      const [globalDraft, setGlobalDraft] = useState(globalServer)
      const [overrideDraft, setOverrideDraft] = useState(overrideServer)
      const [status, setStatus] = useState('已保存')
      const savedRef = useRef({ global: globalServer, override: overrideServer })
      const editedRef = useRef(false)

      useEffect(() => {
        if (editedRef.current) return
        const incoming = { global: globalServer, override: overrideServer }
        if (JSON.stringify(incoming) !== JSON.stringify(savedRef.current)) {
          savedRef.current = incoming
          setGlobalDraft(globalServer)
          setOverrideDraft(overrideServer)
          setStatus('已同步磁盘内容')
        }
      }, [globalServer, overrideServer])

      const save = useCallback(async () => {
        const nextGlobal = String(globalDraft ?? '').trim()
        const nextOverride = String(overrideDraft ?? '').trim()
        const pending = []
        if (nextGlobal !== savedRef.current.global) pending.push(['/character-name/global', nextGlobal])
        if (nextOverride !== savedRef.current.override) pending.push(['/character-name', nextOverride])
        if (pending.length === 0) {
          editedRef.current = false
          setStatus('已保存')
          return
        }
        try {
          setStatus('保存中…')
          for (const [path, name] of pending) await apiPost(path, { name })
          savedRef.current = { global: nextGlobal, override: nextOverride }
          editedRef.current = false
          setGlobalDraft(nextGlobal)
          setOverrideDraft(nextOverride)
          setStatus('已保存')
        } catch (error) {
          setStatus('保存失败')
        }
      }, [globalDraft, overrideDraft])

      const markEdited = () => {
        editedRef.current = true
        setStatus('未保存')
      }

      const badgeClass = status === '保存失败' || status === '未保存' ? 'cm-badge cm-badge-warn' : 'cm-badge cm-badge-ok'
      return h(
        'div',
        { className: 'cm-doc' },
        h(
          'div',
          { className: 'cm-doc-head' },
          h('h3', { className: 'cm-doc-title' }, '角色名字'),
          h('span', { className: badgeClass }, status),
          h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: save }, '保存'),
        ),
        h(
          'div',
          { className: 'cm-doc-summary' },
          h('p', null, '这是 AI 扮演的那个角色自己的名字（不是你的名字）。填了以后 AI 会知道该怎么自称。'),
          h('p', null, '「所有对话通用」填一次就对全部对话生效；只有某个对话想用别的名字时，才在下面单独填。这一栏只有你能改，AI 改不了，也不在下面三份文档里。'),
        ),
        h(
          'div',
          { className: 'cm-field' },
          h('label', { htmlFor: 'cm-character-name-global' }, '所有对话通用的默认名字'),
          h('input', {
            id: 'cm-character-name-global',
            className: 'cm-input',
            type: 'text',
            maxLength: 40,
            spellCheck: false,
            placeholder: '例如：大肥鱼',
            value: globalDraft,
            onChange: (event) => { markEdited(); setGlobalDraft(event.target.value) },
            onBlur: () => { if (editedRef.current) save() },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); save() } },
          }),
        ),
        h(
          'div',
          { className: 'cm-field' },
          h('label', { htmlFor: 'cm-character-name-override' }, '本对话单独的名字（留空 = 跟随上面的默认）'),
          h('input', {
            id: 'cm-character-name-override',
            className: 'cm-input',
            type: 'text',
            maxLength: 40,
            spellCheck: false,
            placeholder: globalServer ? '留空即使用默认名字（' + globalServer + '）' : '留空即使用默认名字',
            value: overrideDraft,
            onChange: (event) => { markEdited(); setOverrideDraft(event.target.value) },
            onBlur: () => { if (editedRef.current) save() },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); save() } },
          }),
        ),
        h(
          'p',
          { className: 'cm-lock' },
          effective === '' ? '当前这个对话：未设置名字，AI 不会特别声明自己叫什么。' : '当前这个对话生效名字：' + effective,
        ),
      )
    }

    /**
     * 情绪系统卡片：每种情绪各一条独立进度条（0~100，可同时存在）。
     * editable=true（配置页）：可以手动拉动每条 + 写理由保存，也能增删情绪种类。
     */
    function EmotionCard(props) {
      const { snapshot, refresh, notify, editable } = props
      const emotion = (snapshot && snapshot.emotion) || { types: [], reason: '', updatedAtLocal: '' }
      const types = Array.isArray(emotion.types) ? emotion.types : []
      const [draft, setDraft] = useState({})
      const [reason, setReason] = useState('')
      const [newType, setNewType] = useState('')
      const [busy, setBusy] = useState(false)
      const palette = ['#22c55e', '#f59e0b', '#38bdf8', '#8b5cf6', '#ef4444', '#14b8a6', '#f472b6', '#84cc16', '#6b7280']

      const draftValue = (type) => (Number.isFinite(Number(draft[type.key])) ? Number(draft[type.key]) : Number(type.value) || 0)

      const submit = useCallback(async () => {
        const changes = {}
        for (const type of types) {
          const value = draftValue(type)
          if (value !== (Number(type.value) || 0)) changes[type.key] = value
        }
        if (Object.keys(changes).length === 0) { notify('没有改动任何情绪', true); return }
        if (reason.trim() === '') { notify('手动改情绪要写个理由', true); return }
        setBusy(true)
        try {
          await apiPost('/emotion', { emotions: changes, reason: reason.trim() })
          setReason('')
          setDraft({})
          notify('情绪表已更新')
          await refresh()
        } catch (error) {
          notify(`更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [draft, reason, types, notify, refresh])

      const addType = useCallback(async () => {
        const label = newType.trim()
        if (label === '') { notify('先写一个情绪名', true); return }
        setBusy(true)
        try {
          await apiPost('/emotion/types', { add: [{ label }] })
          setNewType('')
          notify(`已新建情绪「${label}」`)
          await refresh()
        } catch (error) {
          notify(`新建失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [newType, notify, refresh])

      const removeType = useCallback(async (label) => {
        setBusy(true)
        try {
          await apiPost('/emotion/types', { remove: [label] })
          notify(`已删除情绪「${label}」`)
          await refresh()
        } catch (error) {
          notify(`删除失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [notify, refresh])

      const strongest = types.slice()
        .filter((type) => Number(type.value) > 0)
        .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))[0]

      return h(
        'section',
        { className: 'cm-card' },
        h(
          'div',
          { className: 'cm-card-head' },
          h('h3', null, '情绪表'),
          h('span', { className: 'cm-muted' }, '每种情绪独立 0~100 · 可同时存在 · 每句实时变化 · 最高优先级参考'),
        ),
        h('p', { className: 'cm-hint' }, '这不是长期关系（好感度/羁绊在下面），是 AI 此刻逐条的心情：可以同时「开心 70 + 悲伤 30」。AI 会优先按最强的几种情绪决定语气和态度。'),
        types.length === 0
          ? h('p', { className: 'cm-muted' }, '暂无情绪种类。')
          : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
            types.map((type, index) => {
              const value = draftValue(type)
              const color = palette[index % palette.length]
              return h(
                'div',
                { key: type.key, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { width: 52, fontSize: 13, color: value > 0 ? color : '#6b7280', fontWeight: value > 0 ? 600 : 400 }, title: type.desc || '' }, type.label),
                h(
                  'div',
                  { style: { position: 'relative', flex: 1, height: 10, borderRadius: 5, background: '#eceef3', overflow: 'hidden' } },
                  h('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: `${value}%`, background: color, opacity: value > 0 ? 1 : 0, transition: 'width .25s' } }),
                ),
                h('span', { style: { width: 34, textAlign: 'right', fontSize: 12, color: '#4b5563' } }, String(value)),
                editable
                  ? h('input', { className: 'cm-slider', style: { width: 100 }, type: 'range', min: 0, max: 100, step: 1, value, onChange: (event) => setDraft((prev) => ({ ...prev, [type.key]: Number(event.target.value) })) })
                  : null,
                editable
                  ? h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', title: '删除这种情绪（有对话在用时会失败）', onClick: () => removeType(type.label), disabled: busy }, '✕')
                  : null,
              )
            }),
          ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, fontSize: 12, color: '#6b7280' } },
          strongest ? h('span', null, `最强：${strongest.label} ${strongest.value}`) : h('span', null, '当前全部为 0（中性）'),
          emotion.updatedAtLocal ? h('span', null, `更新：${emotion.updatedAtLocal}`) : null,
          emotion.reason ? h('span', null, `原因：${emotion.reason}`) : null,
        ),
        editable
          ? h(
            'div',
            { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', { className: 'cm-input', style: { width: 150 }, type: 'text', maxLength: 6, placeholder: '新情绪名，如 嫉妒', value: newType, onChange: (event) => setNewType(event.target.value) }),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: addType, disabled: busy }, '新建情绪'),
              h('span', { className: 'cm-muted' }, '（情绪种类全局共享，AI 也能自己加）'),
            ),
            h('input', { className: 'cm-input', type: 'text', placeholder: '手动改情绪的理由（必填）', value: reason, maxLength: 200, onChange: (event) => setReason(event.target.value) }),
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: submit, disabled: busy }, busy ? '提交中…' : '保存情绪表'),
          )
          : null,
      )
    }

    /** 情绪页：独立大类 —— 只放情绪表 + 最近变化记录。 */
    function EmotionTab(props) {
      const { snapshot, refresh, notify } = props
      if (!snapshot) return h('div', { className: 'cm-empty' }, '加载中…')
      const emotion = snapshot.emotion || { types: [], history: [] }
      const history = Array.isArray(emotion.history) ? emotion.history : []
      return h(
        'div',
        { className: 'cm-tab-body' },
        h('div', { className: 'cm-intro' }, '情绪表是 AI 此刻的即时心情：每种情绪各自一条 0~100 的进度条，可以同时存在（比如又开心又难过）。AI 每轮会自己更新，并优先按这张表决定语气和态度；你也可以在这里手动调整，或新建/删除情绪种类。'),
        h(EmotionCard, { snapshot, refresh, notify, editable: true }),
        history.length > 0
          ? h(
            'section',
            { className: 'cm-card' },
            h('div', { className: 'cm-card-head' }, h('h3', null, '最近情绪变化'), h('span', { className: 'cm-muted' }, '最近的 10 次更新')),
            h(
              'ul',
              { className: 'cm-history' },
              history.slice(0, 10).map((entry, index) => {
                const changes = entry.changes && typeof entry.changes === 'object'
                  ? Object.entries(entry.changes).map(([key, value]) => `${key} ${value}`).join('、')
                  : ''
                return h(
                  'li',
                  { key: `${entry.at}-${index}` },
                  h('span', { className: 'cm-muted' }, formatStamp(entry.at)),
                  h('span', null, changes || '（无变化）'),
                  h('span', { className: 'cm-muted' }, entry.reason || ''),
                  entry.by === 'user' ? h('span', { className: 'cm-muted' }, '（手动）') : null,
                )
              }),
            ),
          )
          : null,
      )
    }

    function ConfigTab(props) {
      const snapshot = props.snapshot
      if (!snapshot) return h('div', { className: 'cm-empty' }, '加载中…')
      const schemaAll = snapshot.docSchema || {}
      const fieldsAll = snapshot.docFields || {}
      const itemsAll = snapshot.docItems || {}
      const aiEdit = snapshot.aiEditDocs || {}
      const editableNames = [aiEdit.personality ? '角色性格' : null, aiEdit.examples ? '预设发言例句' : null, aiEdit.rules ? '允许&禁止行为' : null].filter(Boolean)
      const aiLine = editableDocsLine(aiEdit, editableNames)
      return h(
        'div',
        { className: 'cm-tab-body' },
        // 名字在最顶上：先确定「角色是谁」，下面三份文档才有依附对象。
        h(CharacterNameCard, {
          globalValue: snapshot.characterNameGlobal || '',
          overrideValue: snapshot.characterNameOverride || '',
          effective: snapshot.characterName || '',
        }),
        h(
          'div',
          { className: 'cm-intro' },
          '这三份文档是角色的核心设定：AI 每次对话前都会重新读取，保存后下一轮立刻生效。说明文字固定不可改；下面每个字段都由一条条独立设定组成，每条可以单独给权重（1~100，默认 50，越大越重要、越优先）。想一次加多条，就在「添加条目」框里用「；」隔开（英文分号 ; 和换行也可以），会自动拆成单独条目。角色在长期相处中自己长出来的细节记在「记忆 → AI 自我演化」里。另外「好感度 + 羁绊」的累计变化量每满 50 点，会强制 AI 总结这段对话、小改一次这两份配置文档并更新自我演化条目（进度和手动清零在「记忆 → AI 自我演化」顶部）。',
        ),
        h('div', { className: 'cm-intro' }, aiLine),
        DOC_DEFS.map((definition) =>
          h(StructuredDoc, {
            key: definition.key,
            docKey: definition.key,
            title: definition.title,
            schema: schemaAll[definition.key] || null,
            serverItems: itemsAll[definition.key] || null,
            serverFields: fieldsAll[definition.key] || null,
          }),
        ),
      )
    }

    /** One-line explanation of what the AI may edit in the configuration tab. */
    function editableDocsLine(aiEdit, editableNames) {
      if (!editableNames || editableNames.length === 0) {
        return 'AI 目前不能修改这三份文档，只有你能改；想放开就在 profile 补丁里设置 companion-memory.config.aiEditDocs。'
      }
      const rulesText = aiEdit.rules ? '「允许&禁止行为」也只能在安全底线内小步调整。' : '「允许&禁止行为」只有你能改。'
      return `AI 可以在剧情需要或你明确要求时小步修改：${editableNames.join('、')}（每次必须写原因，改动会自动归档到知识库，你随时可以在这里改回来；AI 改文档时也会按规则给每条配权重，你手动的修改永远优先）。${rulesText}`
    }

    // ── memory tab ─────────────────────────────────────────────────────────

    /**
     * 每个说话人一条独立的好感度滑条。
     * 原来只有「当前说话人」一条，切人要先点按钮；现在「每个人单独拉一条」——
     * 群里几个人各自一行，拖谁的条就是改谁的好感度。
     */
    function SpeakerFavorRow(props) {
      const { speaker, snapshot, refresh, notify } = props
      const [draft, setDraft] = useState(speaker.favorability)
      const [busy, setBusy] = useState(false)
      const [reason, setReason] = useState('')
      const [open, setOpen] = useState(false)

      useEffect(() => {
        setDraft(speaker.favorability)
      }, [speaker.favorability])

      // 拖动停 500ms 自动保存（不用再点按钮），保存后刷新
      useEffect(() => {
        if (Number(draft) === Number(speaker.favorability)) return undefined
        const timer = setTimeout(() => {
          void (async () => {
            setBusy(true)
            try {
              const result = await apiPost('/favorability', {
                value: Number(draft),
                reason: reason.trim() || '用户在面板里手动拖动调整',
                speaker: speaker.name,
                manual: true,
              })
              notify(result && result.changed
                ? `${speaker.name} 的好感度 ${result.from} → ${result.value}`
                : `${speaker.name} 的好感度没有变化`)
              setOpen(false)
              await refresh()
            } catch (error) {
              notify(`更新失败：${error.message}`, true)
            } finally {
              setBusy(false)
            }
          })()
        }, 500)
        return () => clearTimeout(timer)
      }, [draft, reason, notify, refresh, speaker.name, speaker.favorability])

      const submit = useCallback(async () => {
        const reasonText = reason.trim() || '用户在面板里手动调整'
        setBusy(true)
        try {
          const result = await apiPost('/favorability', {
            value: Number(draft),
            reason: reasonText,
            speaker: speaker.name,
            manual: true,
          })
          setReason('')
          setOpen(false)
          notify(result && result.changed
            ? `${speaker.name} 的好感度 ${result.from} → ${result.value}`
            : `${speaker.name} 的好感度没有变化`)
          await refresh()
        } catch (error) {
          notify(`更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [draft, reason, notify, refresh, speaker.name])

      const dirty = Number(draft) !== Number(speaker.favorability)

      const adjustBond = useCallback(async (step) => {
        setBusy(true)
        try {
          const result = await apiPost('/bond', { delta: step, reason: '用户在面板里手动调整羁绊', speaker: speaker.name })
          notify(`羁绊 ${result.bondFrom} → ${result.bond}`)
          await refresh()
        } catch (error) {
          notify(`羁绊更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [notify, refresh, speaker.name])

      return h(
        'div',
        { className: `cm-fav-row cm-fav-row-inline${speaker.isCurrent ? ' cm-fav-row-current' : ''}` },
        h(
          'div',
          { className: 'cm-fav-inline-head' },
          h('span', { className: 'cm-fav-name' }, speaker.name + (speaker.isCurrent ? ' ·当前' : '')),

          h(
            'span',
            { className: 'cm-fav-inline-values' },
            h('span', { className: `cm-fav-value-sm ${favourTone(speaker.favorability)}` }, signed(speaker.favorability)),
            h('span', { className: 'cm-bond-badge', title: '羁绊值：好感度满 ±100 后，AI 继续累积的部分（无上限）' }, `羁绊 ${signed(Number(speaker.bond) || 0)}`),
            h('button', { className: 'cm-bond-btn', type: 'button', title: '手动给羁绊 +1', disabled: busy, onClick: () => void adjustBond(1) }, '+'),
            h('button', { className: 'cm-bond-btn', type: 'button', title: '手动给羁绊 -1', disabled: busy, onClick: () => void adjustBond(-1) }, '−'),
          ),
        ),
        h('input', {
          className: 'cm-slider',
          type: 'range',
          min: -100,
          max: 100,
          step: 1,
          value: draft,
          onChange: (event) => {
            setDraft(Number(event.target.value))
            setOpen(true)
          },
        }),
        h(
          'div',
          { className: 'cm-fav-inline-foot' },
          h('span', { className: 'cm-muted' }, `目标：${signed(draft)}`),
          dirty
            ? h('button', { className: 'cm-btn cm-btn-small cm-btn-primary', type: 'button', disabled: busy, onClick: submit }, busy ? '提交中…' : '保存')
            : h('span', { className: 'cm-muted' }, speaker.isCurrent ? '当前说话人' : '点滑条可调整'),
          dirty
            ? h('button', {
                className: 'cm-btn cm-btn-small cm-btn-ghost',
                type: 'button',
                disabled: busy,
                onClick: () => {
                  setDraft(speaker.favorability)
                  setOpen(false)
                },
              }, '撤销')
            : null,
            h(
                        'button',
                        {
                          className: 'cm-btn cm-btn-small cm-btn-ghost',
                          type: 'button',
                          title: '删除这个人（好感度 / 评价 / 单独记忆一起删）',
                          disabled: busy,
                          onClick: async () => {
                            if (!window.confirm('确定删除「' + speaker.name + '」吗？\n\n他的好感度、多维评价和属于他的单独记忆都会一起删掉，删了找不回来。')) return
                            setBusy(true)
                            try {
                              const result = await apiPost('/speaker/delete', { speakerId: speaker.id, speaker: speaker.name })
                              if (result && result.removed) notify('已删除「' + speaker.name + '」和他的 ' + (result.removedMemories || 0) + ' 条记忆')
                              else notify('没删成：' + ((result && result.reason) || '未知原因'), true)
                              await refresh()
                            } catch (error) {
                              notify('删除失败：' + error.message, true)
                            } finally {
                              setBusy(false)
                            }
                          },
                        },
                        '✕',
                      ),
        ),
        open && dirty
          ? h('input', {
              className: 'cm-input cm-input-small',
              placeholder: '变动理由（可不填，默认：用户在面板里手动调整）',
              value: reason,
              onChange: (event) => setReason(event.target.value),
            })
          : null,
      )
    }

    function FavorabilityCard(props) {
      const { snapshot, refresh, notify, showDetails } = props
      const [draft, setDraft] = useState(snapshot.favorability)
      const [reason, setReason] = useState('')
      const [busy, setBusy] = useState(false)
      const speakers = snapshot.speakers || []
      const currentSpeaker = speakers.find((item) => item.isCurrent) || null
      const currentName = currentSpeaker?.name ?? '当前说话人'

      useEffect(() => {
        setDraft(snapshot.favorability)
      }, [snapshot.favorability])

      // 单人会话的主滑条：停下 500ms 自动保存
      useEffect(() => {
        if (Number(draft) === Number(snapshot.favorability)) return undefined
        if ((snapshot.speakers || []).length > 1) return undefined
        const timer = setTimeout(() => {
          void (async () => {
            setBusy(true)
            try {
              const result = await apiPost('/favorability', {
                value: Number(draft),
                reason: reason.trim() || '用户在面板里手动拖动调整',
                speaker: currentSpeaker?.name,
                manual: true,
              })
              notify(result && result.changed
                ? `好感度 ${result.from} → ${result.value}`
                : '好感度没有变化')
              await refresh()
            } catch (error) {
              notify(`更新失败：${error.message}`, true)
            } finally {
              setBusy(false)
            }
          })()
        }, 500)
        return () => clearTimeout(timer)
      }, [draft, reason, notify, refresh, snapshot.favorability, currentSpeaker])

      const submit = useCallback(async () => {
        if (reason.trim() === '') {
          notify('好感度变动必须写明理由', true)
          return
        }
        setBusy(true)
        try {
          const result = await apiPost('/favorability', { value: Number(draft), reason: reason.trim(), speaker: currentSpeaker?.name, manual: true })
          setReason('')
          notify(result && result.changed ? `好感度 ${result.from} → ${result.value}` : '好感度没有变化')
          await refresh()
        } catch (error) {
          notify(`更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [draft, reason, notify, refresh, currentSpeaker])

      const undoLast = useCallback(async () => {
        setBusy(true)
        try {
          const result = await apiPost('/favorability/undo', { speaker: currentSpeaker?.name })
          notify(`已撤销，好感度回到 ${result.value}`)
          await refresh()
        } catch (error) {
          notify(`撤销失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [notify, refresh, currentSpeaker])

      const switchSpeaker = useCallback(async (id) => {
        setBusy(true)
        try {
          await apiPost('/speaker', { switchTo: id })
          notify('已切换当前说话人')
          await refresh()
        } catch (error) {
          notify(`切换失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [notify, refresh])

      const adjustBond = useCallback(async (step) => {
        setBusy(true)
        try {
          const result = await apiPost('/bond', { delta: step, reason: '用户在面板里手动调整羁绊', speaker: currentSpeaker?.name })
          notify(`羁绊 ${result.bondFrom} → ${result.bond}`)
          await refresh()
        } catch (error) {
          notify(`羁绊更新失败：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [notify, refresh, currentSpeaker])

      const history = snapshot.favorabilityHistory || []

      return h(
        'section',
        { className: 'cm-card' },
        h('div', { className: 'cm-card-head' }, h('h3', null, '好感度'), h('span', { className: 'cm-muted' }, '角色（AI）对每个人 · 好感度 -100 ~ 100 · 羁绊无上限')),
        // ── 每个说话人一条独立滑条（群里人人一条，拖谁就是改谁）──
        speakers.length > 1
          ? h(
              'div',
              { className: 'cm-fav-list' },
              speakers.map((speaker) =>
                h(SpeakerFavorRow, {
                  key: speaker.id,
                  speaker,
                  snapshot,
                  refresh,
                  notify,
                }),
              ),
            )
          : h(
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
                h('div', { className: 'cm-muted' }, `目标值：${signed(draft)}（当前说话人：${currentName}）`),
                h(
                  'div',
                  { className: 'cm-bond-line' },
                  h('span', { className: 'cm-bond-badge', title: '羁绊值：好感度满 ±100 后，AI 继续累积的部分（无上限）' }, `羁绊 ${signed(Number(currentSpeaker?.bond) || 0)}（无上限）`),
                  h('button', { className: 'cm-bond-btn', type: 'button', title: '手动给羁绊 +1', disabled: busy, onClick: () => void adjustBond(1) }, '+1'),
                  h('button', { className: 'cm-bond-btn', type: 'button', title: '手动给羁绊 -1', disabled: busy, onClick: () => void adjustBond(-1) }, '−1'),
                ),
              ),
            ),
        showDetails && speakers.length > 0
          ? h(
              'div',
              { className: 'cm-speaker-vectors' },
              h('p', { className: 'cm-hint' }, '每个人的多维评价（AI 自己打分，0~100）：'),
              speakers.map((item) => h('p', { key: item.id, className: 'cm-muted' }, `${item.name}：${item.vectorText || '（暂无）'}`)),
            )
          : null,
        speakers.length > 1
          ? h(
              'div',
              { className: 'cm-actions' },
              h('span', { className: 'cm-muted' }, '当前说话人：'),
              h('button', {
                className: 'cm-btn cm-btn-small cm-btn-ghost',
                type: 'button',
                disabled: busy,
                onClick: () => switchSpeaker(currentSpeaker?.id ?? speakers[0]?.id),
              }, currentName),
            )
          : null,
        h('textarea', {
          className: 'cm-textarea cm-textarea-small',
          placeholder: '填写本次角色对当前说话人的好感度变动理由（必填；群聊里每个说话人有独立滑条，拖哪条就是改谁）',
          value: reason,
          onChange: (event) => setReason(event.target.value),
          rows: 2,
        }),
        h(
          'div',
          { className: 'cm-actions' },
          h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: submit, disabled: busy }, busy ? '提交中…' : '更新好感度'),
          history.length > 0
            ? h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: undoLast, disabled: busy }, '撤销最近一次')
            : null,
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
                  change.misreport
                    ? h('span', { className: 'cm-muted', title: '跌幅远大于单轮上限、本轮又没有大情绪波动：判定为 AI 把「+N」误写成绝对值的误报，只按小幅结算' }, `目标值 ${change.requested}（疑似误报：跌幅 ${change.misreportRawDrop}，按 ${signed(-(Number(change.misreportDrop) || 0))} 结算${change.absorbed ? `，羁绊抵消 ${change.absorbed}` : ''}）`)
                    : change.stepClamped
                      ? h('span', { className: 'cm-muted', title: '好感度是循序渐进的：单轮降幅超过上限时按上限结算' }, `目标值 ${change.requested}（单轮最多降 ${change.stepLimit}，按 ${change.clampedTo} 结算）`)
                      : null,
                  change.absorbed && !change.misreport
                    ? h('span', { className: 'cm-muted', title: 'AI 这次给出的目标值被「先扣羁绊」规则吸收了' }, `目标值 ${change.requested ?? Number(change.value) - Number(change.absorbed)}｜羁绊抵消 ${change.absorbed}`)
                    : null,
                  change.bond !== undefined && change.bond !== null
                    ? h('span', { className: 'cm-history-bond' }, `羁绊 ${signed(Number(change.bondFrom) || 0)} → ${signed(Number(change.bond) || 0)}`)
                    : null,
                  h('span', null, change.speakerName && change.speakerName !== '用户' ? `${change.speakerName}：${change.reason}` : change.reason),
                ),
              ),
            )
          : h('p', { className: 'cm-muted' }, '暂无好感度变动记录。'),
      )
    }

    function MemoryCard(props) {
      const { memory, showDetails } = props
      const [busy, setBusy] = useState(false)
      const act = useCallback(
        async (path, body, message) => {
          setBusy(true)
          try {
            await apiPost(path, { id: memory.id, ...body })
            props.notify(message)
            await props.refresh()
          } catch (error) {
            props.notify(`操作失败：${error.message}`, true)
          } finally {
            setBusy(false)
          }
        },
        [memory.id, props],
      )
      const archive = () => act('/memory/archive', { ids: [memory.id] }, '已归档进知识库（原文未改动）')
      const pin = () => act('/memory/pin', { pinned: !memory.pinned }, memory.pinned ? '已取消置顶' : '已置顶')
      const up = () => act('/memory/move', { direction: 'up' }, '已上移')
      const down = () => act('/memory/move', { direction: 'down' }, '已下移')
      const remove = () => act('/memory/delete', {}, '已删除这条活跃记忆')
      return h(
        'div',
        { className: 'cm-memory' },
        h('div', { className: 'cm-memory-text' }, memory.text),
        h(
          'div',
          { className: 'cm-memory-meta' },
          h('span', null, `${memory.createdAtLocal ?? memory.createdDay ?? '时间未知'}｜第 ${memory.createdInteractionDay ?? '?'} 交互日`),
          // 向量/权重默认藏在后台，点「显示细节」才展开，避免面板被长串数字刷屏。
          showDetails && memory.vectorText
            ? h('span', { className: 'cm-tag', title: '记忆向量（AI 自己打分）：情感/重要/亲密/敏感/长期/类别' }, memory.vectorText)
            : null,
          h('span', null, `剩余 ${memory.remainingDays} 天`),
          showDetails
            ? h(
              'label',
              { className: 'cm-weight', title: '权重 1~100：越高越靠前、越优先进入上下文（默认 50）。改完按回车或点开别处生效。' },
              '权重',
              h(WeightInput, {
                value: Number(memory.weight) || 50,
                disabled: busy,
                onCommit: (next) => act('/memory/weight', { weight: next }, `权重已改为 ${next}`),
              }),
            )
            : null,
          (memory.tags || []).map((tag) => h('span', { key: tag, className: 'cm-tag' }, tag)),
          Number(memory.recurringCount) > 1
            ? h('span', { className: 'cm-tag', title: '用户反复问到的事，达到次数后自动记进全局记忆' }, `已问 ${memory.recurringCount} 次`)
            : null,
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: pin, disabled: busy }, memory.pinned ? '取消置顶' : '置顶'),
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: up, disabled: busy, title: '上移一位' }, '↑'),
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: down, disabled: busy, title: '下移一位' }, '↓'),
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: archive, disabled: busy }, busy ? '处理中…' : '归档'),
          h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: remove, disabled: busy }, '删除'),
        ),
      )
    }

    /**
     * 权重输入框（1~100）：不逐键提交，回车 / 失焦 / 步进按钮时才保存，
     * 避免每敲一个数字就打一次接口。非法值会被夹到 1~100。
     */
    function WeightInput(props) {
      const { value, disabled, onCommit } = props
      const [draft, setDraft] = useState(String(value))
      const editingRef = useRef(false)
      useEffect(() => {
        if (!editingRef.current) setDraft(String(value))
      }, [value])
      const clamp = (raw) => {
        const number = Math.round(Number(raw))
        if (!Number.isFinite(number)) return 50
        return Math.min(100, Math.max(1, number))
      }
      const commit = () => {
        editingRef.current = false
        const next = clamp(draft)
        setDraft(String(next))
        if (next !== value) onCommit(next)
      }
      return h('input', {
        className: 'cm-weight-input',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        value: draft,
        disabled,
        title: '1~100，越大越重要',
        onChange: (event) => {
          editingRef.current = true
          setDraft(event.target.value)
        },
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      })
    }

    function EvolutionCard(props) {
      const { snapshot, refresh, notify, showDetails } = props
      const evolution = snapshot.evolution || { order: [], sections: {}, total: 0, limit: 12 }
      const order = Array.isArray(evolution.order) ? evolution.order : []
      const [drafts, setDrafts] = useState({})
      const [busyKey, setBusyKey] = useState('')
      const [triggerBusy, setTriggerBusy] = useState(false)

      const resetTrigger = useCallback(
        async () => {
          setTriggerBusy(true)
          try {
            await apiPost('/evolution/trigger', { reset: true })
            notify('人格演化进度已清零')
            await refresh()
          } catch (error) {
            notify(`清零失败：${error.message}`, true)
          } finally {
            setTriggerBusy(false)
          }
        },
        [notify, refresh],
      )

      const addEntry = useCallback(
        async (sectionKey) => {
          const text = String(drafts[sectionKey] || '').trim()
          if (text === '') {
            notify('先写一句要补充的内容再添加', true)
            return
          }
          setBusyKey(sectionKey)
          try {
            await apiPost('/evolve', { section: sectionKey, add: [{ text, reason: '用户手动添加' }], reason: '用户手动添加' })
            setDrafts((prev) => ({ ...prev, [sectionKey]: '' }))
            notify('已添加一条自我演化')
            await refresh()
          } catch (error) {
            notify(`添加失败：${error.message}`, true)
          } finally {
            setBusyKey('')
          }
        },
        [drafts, notify, refresh],
      )

      const removeEntry = useCallback(
        async (sectionKey, id) => {
          setBusyKey(sectionKey)
          try {
            await apiPost('/evolve', { section: sectionKey, remove: [id] })
            notify('已删除这条自我演化')
            await refresh()
          } catch (error) {
            notify(`删除失败：${error.message}`, true)
          } finally {
            setBusyKey('')
          }
        },
        [notify, refresh],
      )

      /** 改权重：1~5，越大表示对角色越重要/越强烈。 */
      const setWeight = useCallback(
        async (sectionKey, id, weight) => {
          setBusyKey(sectionKey)
          try {
            await apiPost('/evolve/weight', { section: sectionKey, id, weight })
            notify(`权重已改为 ${weight}`)
            await refresh()
          } catch (error) {
            notify(`改权重失败：${error.message}`, true)
          } finally {
            setBusyKey('')
          }
        },
        [notify, refresh],
      )

      const trigger = evolution.trigger || { step: 50, progress: 0, due: 0, doneCount: 0, lastDoneAt: null }
      const triggerStep = Number(trigger.step) || 50
      const triggerProgress = Math.max(0, Math.min(triggerStep, Number(trigger.progress) || 0))

      return h(
        'section',
        { className: 'cm-card' },
        h(
          'div',
          { className: 'cm-card-head' },
          h('h3', null, 'AI 自我演化'),
          h('span', { className: 'cm-muted' }, `共 ${evolution.total} 条 · 每区上限 ${evolution.limit}`),
        ),
        h(
          'div',
          { className: 'cm-hint cm-hint-tight' },
          h(
            'div',
            null,
            `人格演化：进度 ${triggerProgress}/${triggerStep}${trigger.due > 0 ? '（强制演化待完成）' : ''}${trigger.doneCount > 0 ? `｜已完成 ${trigger.doneCount} 次` : ''}${trigger.lastDoneAt ? `｜上次完成 ${String(trigger.lastDoneAt).slice(0, 10)}` : ''}`,
          ),
          h(
            'div',
            null,
            `好感度 + 羁绊的累计变化量每满 ${triggerStep} 点，强制 AI 总结这段对话、小改一次配置文档（「配置」页里的角色性格/例句）并更新下面的自我演化条目；完成（turn_end 确认）后计数清零、重新开始计。`,
          ),
          h(
            'div',
            { className: 'cm-bond-line' },
            h(
              'button',
              { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', disabled: triggerBusy, onClick: () => void resetTrigger() },
              '清零进度',
            ),
          ),
        ),
        h(
          'p',
          { className: 'cm-hint' },
          '这些不是用户写下的固定设定：角色在长期对话里会慢慢长出新的性格细节、喜欢/讨厌的事物和行为习惯，由 AI 按剧情理由自行添加，也会写进系统提示。用户可以手动补一条，或删掉不合适的。',
        ),
        order.map((key) => {
          const section = evolution.sections ? evolution.sections[key] : null
          if (!section) return null
          const entries = Array.isArray(section.entries) ? section.entries : []
          return h(
            'div',
            { key, className: 'cm-evo-block' },
            h(
              'div',
              { className: 'cm-evo-head' },
              h('strong', null, section.label),
              h('span', { className: 'cm-muted' }, `${entries.length}/${evolution.limit}`),
            ),
            h('p', { className: 'cm-hint cm-hint-tight' }, section.hint),
            entries.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有条目。')
              : h(
                  'div',
                  { className: 'cm-memory-list' },
                  entries.map((entry) =>
                    h(
                      'div',
                      { key: entry.id, className: 'cm-memory' },
                      h('div', { className: 'cm-memory-text' }, entry.text),
                      h(
                        'div',
                        { className: 'cm-memory-meta' },
                        h(
                          'span',
                          null,
                          `${entry.day || ''}｜${entry.by === 'ai' ? 'AI 演化' : '用户添加'}${entry.reason ? `｜${entry.reason}` : ''}`,
                        ),
                        showDetails
                          ? h(
                            'label',
                            { className: 'cm-weight', title: '权重 1~100：这条对角色有多重要（默认 50）。权重高的会排在提示词前面。改完按回车或点开别处生效。' },
                            '权重',
                            h(WeightInput, {
                              value: Number(entry.weight) || 50,
                              disabled: busyKey === key,
                              onCommit: (next) => setWeight(key, entry.id, next),
                            }),
                          )
                          : null,
                        h(
                          'button',
                          {
                            className: 'cm-btn cm-btn-small cm-btn-ghost',
                            type: 'button',
                            disabled: busyKey === key,
                            onClick: () => removeEntry(key, entry.id),
                          },
                          '删除',
                        ),
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'cm-evo-add' },
              h('input', {
                className: 'cm-input',
                type: 'text',
                placeholder: `补充一条${section.label}，例如……`,
                value: drafts[key] || '',
                onChange: (event) => {
                  const value = event.target.value
                  setDrafts((prev) => ({ ...prev, [key]: value }))
                },
              }),
              h(
                'button',
                { className: 'cm-btn cm-btn-small cm-btn-primary', type: 'button', disabled: busyKey === key, onClick: () => addEntry(key) },
                '添加',
              ),
            ),
          )
        }),
      )
    }

    /** 「每个人单独一份」：某位成员的记忆卡片（默认收起，点标题展开）。 */
    function PersonMemoryCard(props) {
      const { group, speaker, refresh, notify } = props
      const [open, setOpen] = useState(false)
      const avatar = speaker && speaker.externalId ? String(speaker.externalId).slice(0, 8) + '…' : ''
      const count = (group.memories || []).length
      const favorText = speaker ? ' · 好感度 ' + (speaker.favorability >= 0 ? '+' : '') + speaker.favorability : ''
      return h(
        'section',
        { className: 'cm-card cm-person-card' },
        h(
          'button',
          { className: 'cm-collapse', type: 'button', onClick: () => setOpen((value) => !value) },
          (open ? '▾ ' : '▸ ') + group.speakerName + '（' + count + ' 条）' + (avatar !== '' ? ' · openid ' + avatar : '') + favorText,
        ),
        open
          ? h(
              'div',
              null,
              speaker && speaker.vectorText ? h('p', { className: 'cm-hint' }, '评价：' + speaker.vectorText) : null,

              count === 0
                ? h('p', { className: 'cm-muted' }, '还没有关于这个人的单独记忆。')
                : h(
                    'ul',
                    { className: 'cm-person-memories' },
                    (group.memories || []).map((memory) =>
                      h(
                        'li',
                        { key: memory.id, className: 'cm-person-memory' },
                        h('span', { className: 'cm-person-memory-text' }, memory.text),
                        h('span', { className: 'cm-memory-meta' }, (memory.createdAtLocal || memory.createdDay || '') + (memory.weight ? '｜权重 ' + memory.weight : '')),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    /** 群成员总体记忆：全体共有，不针对某个人。 */
    function GroupMemoryList(props) {
      const { snapshot, refresh, notify } = props
      const [busy, setBusy] = useState('')
      const items = snapshot.groupMemories || []
      const remove = useCallback(async (id) => {
        setBusy(id)
        try {
          await apiPost('/group/memory/delete', { id })
          notify('已删除这条群成员总体记忆')
          await refresh()
        } catch (error) {
          notify('删除失败：' + error.message, true)
        } finally {
          setBusy('')
        }
      }, [refresh, notify])
      return h(
        'section',
        { className: 'cm-card' },
        h(
          'div',
          { className: 'cm-card-head' },
          h('h3', null, '群成员总体记忆'),
          h('span', { className: 'cm-muted' }, items.length + ' 条 · 全体共有'),
        ),
        h('p', { className: 'cm-hint' }, '整个群共同的事（群事件、群氛围、大家的约定和梗），不针对某一个人；按日期 + 权重记，每个对话各存一份。'),
        items.length === 0
          ? h('p', { className: 'cm-muted' }, '还没有群成员总体记忆。')
          : h(
              'div',
              { className: 'cm-memory-list' },
              items.map((memory) =>
                h(
                  'div',
                  { key: memory.id, className: 'cm-memory' },
                  h('div', { className: 'cm-memory-text' }, memory.text),
                  h(
                    'div',
                    { className: 'cm-memory-meta' },
                    h('span', null, formatStamp(memory.createdAt) || memory.createdDay || ''),
                    h('span', null, '权重 ' + (memory.weight ?? 50)),
                    h(
                      'button',
                      { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', disabled: busy === memory.id, onClick: () => remove(memory.id) },
                      busy === memory.id ? '…' : '删除',
                    ),
                  ),
                ),
              ),
            ),
      )
    }

    function MemoryTab(props) {
      const { snapshot, refresh, notify } = props
      const [draft, setDraft] = useState('')
      const [tags, setTags] = useState('')
      const [busy, setBusy] = useState(false)
      const [showArchived, setShowArchived] = useState(false)
      const [showLife, setShowLife] = useState(false)
      const [showHabits, setShowHabits] = useState(false)
      const [showGlobalMemories, setShowGlobalMemories] = useState(false)
      // 向量/权重默认藏在后台，需要时再展开（用户不想面板被长串数字占满）。
      const [showDetails, setShowDetails] = useState(false)
      // 1.1.0-C：记忆体检（只读扫描 + 一键整理）
      const [health, setHealth] = useState(null)
      const [healthBusy, setHealthBusy] = useState('')

      const scanMemoryHealth = useCallback(async () => {
        setHealthBusy('scan')
        try {
          const result = await apiGet('/memory/health')
          setHealth(result)
          notify(result.issueCount === 0 ? '记忆很干净，没有发现问题。' : `发现 ${result.issueCount} 个问题（重复/相似/超长/过期）。`)
        } catch (error) {
          notify(`体检失败：${error.message}`, true)
        } finally {
          setHealthBusy('')
        }
      }, [notify])

      const cleanMemoryNow = useCallback(async () => {
        setHealthBusy('clean')
        try {
          const result = await apiPost('/memory/clean', {})
          setHealth(null)
          notify(`已整理：保留 ${result.kept} 条${result.archived ? `、归档 ${result.archived} 条（原文可从知识库找回）` : ''}${result.modelUsed ? '（含模型整理）' : '（仅规则去重）'}${result.backup ? `；已备份 ${result.backup}` : ''}`)
          await refresh()
        } catch (error) {
          notify(`整理失败：${error.message}`, true)
        } finally {
          setHealthBusy('')
        }
      }, [notify, refresh])

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
      const lifeMemories = active.filter((memory) => Array.isArray(memory.tags) && memory.tags.includes('生活'))
      const habitMemories = active.filter((memory) => Array.isArray(memory.tags) && memory.tags.includes('习惯'))
      const archived = snapshot.memories.archived || []
      const memoryById = new Map(active.map((memory) => [String(memory.id), memory]))
      const memoryTextOf = (id) => {
        const memory = memoryById.get(String(id))
        return memory ? String(memory.text || '').slice(0, 80) : '（已不存在的条目）'
      }
      const healthLines = health
        ? [
            health.duplicates.length > 0 ? `完全重复：${health.duplicates.length} 组` : '',
            health.similar.length > 0 ? `高度相似：${health.similar.length} 对` : '',
            health.long.length > 0 ? `超长：${health.long.length} 条` : '',
            health.stale.length > 0 ? `过期未归档：${health.stale.length} 条` : '',
            health.empty.length > 0 ? `空条目：${health.empty.length} 条` : '',
          ].filter(Boolean)
        : []

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(FavorabilityCard, { snapshot, refresh, notify, showDetails }),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '记忆体检'), h('span', { className: 'cm-muted' }, '查重 / 相似 / 超长 / 过期')),
          h('p', { className: 'cm-hint' }, '扫描当前活跃记忆。一键整理只做去重和归档（原文保留在知识库，可检索找回），不改写任何原文；整理前会自动备份 state.json。'),
          health
            ? h(
                'div',
                { className: 'cm-health' },
                h('p', { className: 'cm-muted' }, health.issueCount === 0 ? '没有发现问题 ✅' : `共 ${health.issueCount} 个问题：${healthLines.join('；')}`),
                health.duplicates.length > 0
                  ? h(
                      'ul',
                      { className: 'cm-health-list' },
                      health.duplicates.slice(0, 5).map((ids, index) =>
                        h('li', { key: `dup-${index}` }, `重复：${memoryTextOf(ids[0])}${ids.length > 2 ? `（等 ${ids.length} 条）` : ''}`),
                      ),
                    )
                  : null,
                health.similar.length > 0
                  ? h(
                      'ul',
                      { className: 'cm-health-list' },
                      health.similar.slice(0, 5).map((pair, index) =>
                        h('li', { key: `sim-${index}` }, `相似 ${Math.round(pair.score * 100)}%：${memoryTextOf(pair.ids[0])} ↔ ${memoryTextOf(pair.ids[1])}`),
                      ),
                    )
                  : null,
                health.long.length > 0
                  ? h('p', { className: 'cm-muted' }, `超长条目：${health.long.slice(0, 5).map((item) => `${item.chars} 字`).join(' / ')}`)
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'cm-actions' },
            h('button', { className: 'cm-btn', type: 'button', onClick: scanMemoryHealth, disabled: Boolean(healthBusy) }, healthBusy === 'scan' ? '扫描中…' : '扫描记忆'),
            health && health.issueCount > 0
              ? h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: cleanMemoryNow, disabled: Boolean(healthBusy) }, healthBusy === 'clean' ? '整理中…' : '一键整理')
              : null,
          ),
        ),
        h(CollapsibleCard, { title: '人格演化', defaultOpen: false }, h(EvolutionCard, { snapshot, refresh, notify, showDetails })),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'button',
            { className: 'cm-collapse', type: 'button', onClick: () => setShowGlobalMemories((value) => !value) },
            `${showGlobalMemories ? '▾' : '▸'} 全局活跃记忆（${snapshot.memories.activeCount}/${snapshot.memories.limit} 条上限）`,
          ),
          showGlobalMemories
            ? h(
                'div',
                null,
                h('p', { className: 'cm-hint' }, '重点原文保持原样，AI 只能决定保存/调取，不能改写。满 30 个交互日后自动移入知识库。'),
                h(
                  'div',
                  { className: 'cm-actions' },
                  h(
                    'button',
                    { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => setShowDetails(!showDetails) },
                    showDetails ? '隐藏向量/权重' : '显示向量/权重',
                  ),
                ),
                showDetails && (snapshot.vectorDimensions || []).length > 0
                  ? h('p', { className: 'cm-hint' }, `AI 自己建的全局向量维度（所有对话通用）：${(snapshot.vectorDimensions || []).map((item) => `${item.label}${item.desc ? `（${item.desc}）` : ''}·${item.usedBy ?? 0}条在用`).join('、')}`)
                  : null,
                active.length === 0
                  ? h('p', { className: 'cm-muted' }, '暂无活跃记忆。')
                  : h('div', { className: 'cm-memory-list' }, active.map((memory) => h(MemoryCard, { key: memory.id, memory, refresh, notify, showDetails }))),
              )
            : null,
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'button',
            { className: 'cm-collapse', type: 'button', onClick: () => setShowLife((value) => !value) },
            `${showLife ? '▾' : '▸'} 生活类（${lifeMemories.length} 条 · 每 7 个交互日自动清空）`,
          ),
          showLife
            ? lifeMemories.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有生活记录。AI 会在聊到起床/吃饭/睡觉/出门这些事时自动记一条。')
              : h('div', { className: 'cm-memory-list' }, lifeMemories.map((memory) => h(MemoryCard, { key: memory.id, memory, refresh, notify, showDetails })))
            : null,
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'button',
            { className: 'cm-collapse', type: 'button', onClick: () => setShowHabits((value) => !value) },
            `${showHabits ? '▾' : '▸'} 对话人习惯（${habitMemories.length} 条 · 长期不清）`,
          ),
          showHabits
            ? habitMemories.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有习惯记录。AI 会在聊到作息/上下班上下学/爱吃什么/爱玩什么时自动记一条。')
              : h('div', { className: 'cm-memory-list' }, habitMemories.map((memory) => h(MemoryCard, { key: memory.id, memory, refresh, notify, showDetails })))
            : null,
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
        h(GroupMemoryList, { snapshot, refresh, notify }),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '按成员分开的记忆'),
            h('span', { className: 'cm-muted' }, (snapshot.speakers || []).length + ' 个说话人'),
          ),
          h('p', { className: 'cm-hint' }, '每个人单独一份：他的评价（好感度 / 多维评价）和属于他的记忆；没标明归属的放在最后。'),
          (snapshot.memoriesBySpeaker || []).length === 0
            ? h('p', { className: 'cm-muted' }, '还没有记忆。')
            : h(
                'div',
                { className: 'cm-person-list' },
                (snapshot.memoriesBySpeaker || []).map((group) => {
                  const speaker = (snapshot.speakers || []).find((item) => item.id === group.speakerId) || null
                  return h(PersonMemoryCard, { key: group.speakerId, group, speaker, refresh, notify })
                }),
              ),
        ),
      )
    }

    // ── knowledge tab ──────────────────────────────────────────────────────

    function KnowledgeTab(props) {
      const { notify } = props
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [busy, setBusy] = useState(false)
      const [files, setFiles] = useState(props.snapshot ? props.snapshot.knowledge : { archive: [], monthly: [], packs: [], hierarchy: [] })
      const [viewer, setViewer] = useState(null)
      const [viewerBusy, setViewerBusy] = useState(false)
      // 1.1.0-A：多级记忆压缩状态
      const [hierarchy, setHierarchy] = useState(null)
      const [hierarchyBusy, setHierarchyBusy] = useState('')
      const packInput = useRef(null)
      const tokenPackInput = useRef(null)
      const autoPack = (props.snapshot && props.snapshot.autoPack) || { every: 0, everyTokens: 0, everyTokensCustom: false, turnsSince: 0, tokensSince: 0, totalTurns: 0, count: 0, lastPackAt: null }

      useEffect(() => {
        if (props.snapshot && props.snapshot.knowledge) setFiles(props.snapshot.knowledge)
      }, [props.snapshot])

      useEffect(() => {
        const input = packInput.current
        if (input && document.activeElement !== input) input.value = String(autoPack.every)
      }, [autoPack.every])

      useEffect(() => {
        const input = tokenPackInput.current
        if (input && document.activeElement !== input) input.value = String(autoPack.everyTokens || 0)
      }, [autoPack.everyTokens])

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

      const saveAutoPackTokens = useCallback(async () => {
        const raw = Number(tokenPackInput.current ? tokenPackInput.current.value : autoPack.everyTokens)
        if (!Number.isInteger(raw) || raw < 0 || raw > 10000000) {
          notify('请输入 0 ~ 10000000 之间的整数（0 表示关闭）', true)
          return
        }
        try {
          const value = await apiPost('/auto-pack', { everyTokens: raw })
          notify(value.everyTokens > 0 ? `已保存：每约 ${value.everyTokens} tokens 自动打包一次` : '已关闭 token 自动打包')
        } catch (error) {
          notify(`保存失败：${error.message}`, true)
        }
      }, [autoPack.everyTokens, notify])

      const followAutoPackTokens = useCallback(async () => {
        try {
          const value = await apiPost('/auto-pack', { everyTokens: null })
          notify(`已改为跟随上下文压缩阈值：每约 ${value.everyTokens} tokens 打包一次`)
        } catch (error) {
          notify(`保存失败：${error.message}`, true)
        }
      }, [notify])

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

      const refreshHierarchy = useCallback(async () => {
        try {
          const value = await apiGet('/hierarchy')
          setHierarchy(value)
        } catch {
          setHierarchy(null)
        }
      }, [])

      useEffect(() => {
        void refreshHierarchy()
      }, [refreshHierarchy, props.snapshot && props.snapshot.updatedAt])

      const runHierarchy = useCallback(
        async (action) => {
          setHierarchyBusy(action)
          try {
            const result = await apiPost(`/hierarchy/${action}`, {})
            if (action === 'annual') {
              notify(result.built ? `已生成第 ${result.yearNo} 年度摘要（${Math.round((result.chars || 0) / 1000)}k 字）` : `未生成：${result.reason || '还不满足条件'}`, !result.built)
            } else if (action === 'epoch') {
              notify(result.built ? `已生成跨年沉积（覆盖第 ${result.coversFrom}~${result.coversTo} 年度，第 ${result.compressedTimes} 次压缩）` : `未生成：${result.reason || '还没有年报'}`, !result.built)
            } else {
              notify(`已回滚：${result.restored}（备份 ${result.backup}）`)
            }
            await refreshHierarchy()
            if (props.refresh) await props.refresh()
          } catch (error) {
            notify(`操作失败：${error.message}`, true)
          } finally {
            setHierarchyBusy('')
          }
        },
        [notify, props.refresh, refreshHierarchy],
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
            h('h3', null, '最近两个聊天日上下文'),
            h('span', { className: 'cm-muted' }, props.snapshot && props.snapshot.recent ? `${props.snapshot.recent.count} 条消息` : '—'),
          ),
          h(
            'p',
            { className: 'cm-hint' },
            props.snapshot && props.snapshot.recent && props.snapshot.recent.count > 0
              ? `用户 ${props.snapshot.recent.userCount} 条 / 角色 ${props.snapshot.recent.assistantCount} 条，覆盖 ${formatStamp(props.snapshot.recent.oldestAt)} ~ ${formatStamp(props.snapshot.recent.newestAt)}。`
              : '最近两个聊天日内还没有对话记录。',
          ),
          h('p', { className: 'cm-muted' }, 'AI 回答「刚才/最近/我们说过什么」时从这里检索原始对话原话。这里是「聊天时间」口径：只有真正聊过天的日子才计入 2 天额度，没聊的日子不占用；超出后自动清理，只保留下方知识库里的归档与归纳。'),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h(
            'div',
            { className: 'cm-card-head' },
            h('h3', null, '自动打包'),
            h(
              'span',
              { className: 'cm-muted' },
              [autoPack.every > 0 ? `每 ${autoPack.every} 轮` : '', autoPack.everyTokens > 0 ? `每约 ${autoPack.everyTokens} tokens` : ''].filter(Boolean).join(' 或 ') || '已关闭',
            ),
          ),
          h(
            'p',
            { className: 'cm-hint' },
            '设置后，每累计 N 轮真实对话（你发一句 + 角色回一句算 1 轮）或每累计约 N tokens（按你俩消息估算），系统自动把这段时间的重点原文、次要摘要、48 小时（聊天时间）归纳和好感度变更整理成一份「对话自动打包」文档，放进知识库一并检索。tokens 默认跟随「上下文压缩」的触发阈值；填具体数字 = 自定义，填 0 = 关闭 tokens 触发。',
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
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: saveAutoPack }, '保存轮数'),
            h('span', { className: 'cm-muted' }, autoPack.every > 0 ? `当前区间 ${autoPack.turnsSince}/${autoPack.every} 轮，已打包 ${autoPack.count} 次${autoPack.lastPackAt ? `；上次 ${formatStamp(autoPack.lastPackAt)}` : ''}` : `已累计 ${autoPack.totalTurns} 轮对话`),
          ),
          h(
            'div',
            { className: 'cm-actions' },
            h('input', {
              ref: tokenPackInput,
              className: 'cm-input cm-input-narrow',
              type: 'number',
              min: 0,
              max: 10000000,
              step: 1000,
              defaultValue: String(autoPack.everyTokens || 0),
              'aria-label': '每多少 tokens 自动打包一次',
            }),
            h('button', { className: 'cm-btn', type: 'button', onClick: saveAutoPackTokens }, '保存 tokens'),
            h('button', { className: 'cm-btn', type: 'button', onClick: followAutoPackTokens }, '跟随压缩阈值'),
            h(
              'span',
              { className: 'cm-muted' },
              (autoPack.everyTokensCustom === false ? '（跟随上下文压缩阈值）' : '') +
                (autoPack.everyTokens > 0 ? `当前区间约 ${autoPack.tokensSince}/${autoPack.everyTokens} tokens` : `token 触发已关闭，当前区间约 ${autoPack.tokensSince} tokens`),
            ),
          ),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '层级记忆（多级压缩）'), h('span', { className: 'cm-muted' }, hierarchy ? `已关闭 ${hierarchy.closedYears} 个年度` : '—')),
          h(
            'p',
            { className: 'cm-hint' },
            '每 12 个「30 聊天日」周期算一个年度：自动生成「最新年报」；再下一个年度关闭时，把旧跨年沉积和上一个年报融合成新的「跨年沉积」。只保留这两份高层摘要，越老越浓缩；重点原文（置顶记忆）会原样附在每份摘要末尾，不参与概括。原文永远保留在知识库，可继续下钻。',
          ),
          hierarchy
            ? h(
                'div',
                { className: 'cm-hierarchy' },
                h('p', { className: 'cm-muted' }, `周期进度：${hierarchy.packagedCount} 个已打包（${hierarchy.progress}/${hierarchy.cyclesPerYear}），距下个年报还差 ${hierarchy.cyclesPerYear - hierarchy.progress} 个周期`),
                hierarchy.annual
                  ? h('p', { className: 'cm-muted' }, `最新年报：第 ${hierarchy.annual.coversFrom}~${hierarchy.annual.coversTo} 年度 · ${Math.round((hierarchy.annual.chars || 0) / 1000)}k 字 · ${formatStamp(hierarchy.annual.createdAt)}（压缩 ${hierarchy.annual.compressedTimes} 次）`)
                  : h('p', { className: 'cm-muted' }, '还没有年报（满 12 个周期后自动生成）。'),
                hierarchy.epoch
                  ? h('p', { className: 'cm-muted' }, `跨年沉积：第 ${hierarchy.epoch.coversFrom}~${hierarchy.epoch.coversTo} 年度 · ${Math.round((hierarchy.epoch.chars || 0) / 1000)}k 字 · ${formatStamp(hierarchy.epoch.createdAt)}（第 ${hierarchy.epoch.compressedTimes} 次压缩）`)
                  : h('p', { className: 'cm-muted' }, '还没有跨年沉积（第二个年度关闭时自动生成）。'),
                hierarchy.lastError ? h('p', { className: 'cm-muted' }, `上次自动推进失败：${hierarchy.lastError}`) : null,
                hierarchy.files && hierarchy.files.length > 0
                  ? h(
                      'div',
                      { className: 'cm-kb-list' },
                      hierarchy.files.map((item) =>
                        h(
                          'button',
                          { key: item.path, className: 'cm-kb-item', type: 'button', onClick: () => openFile(item.path) },
                          h('span', { className: 'cm-kb-name' }, item.path.split('/').pop()),
                          h('span', { className: 'cm-muted' }, `${Math.round((item.bytes || 0) / 1000)}k 字`),
                        ),
                      ),
                    )
                  : null,
              )
            : h('p', { className: 'cm-muted' }, '读取中…'),
          h(
            'div',
            { className: 'cm-actions' },
            h('button', { className: 'cm-btn', type: 'button', onClick: () => runHierarchy('annual'), disabled: Boolean(hierarchyBusy) }, hierarchyBusy === 'annual' ? '生成中…' : '生成年度摘要'),
            h('button', { className: 'cm-btn', type: 'button', onClick: () => runHierarchy('epoch'), disabled: Boolean(hierarchyBusy) }, hierarchyBusy === 'epoch' ? '压缩中…' : '融合跨年沉积'),
            hierarchy && (hierarchy.annual || hierarchy.epoch)
              ? h('button', { className: 'cm-btn cm-btn-ghost', type: 'button', onClick: () => runHierarchy('rollback'), disabled: Boolean(hierarchyBusy) }, '回滚到最近备份')
              : null,
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
          h('div', { className: 'cm-card-head' }, h('h3', null, '层级摘要（年报 / 跨年沉积）'), h('span', { className: 'cm-muted' }, `${(files.hierarchy || []).length} 份`)),
          renderFiles(files.hierarchy || [], '满 12 个周期自动生成年报；之后每关闭一个新年度，滚动生成一份跨年沉积。'),
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

    // ── backup tab (export / import) ───────────────────────────────────────

    function BackupTab(props) {
      const { snapshot, notify } = props
      const [busy, setBusy] = useState('')
      const [imported, setImported] = useState(null)
      // 1.1.0-B：导入前自动整理记忆（默认开）
      const [cleanMemory, setCleanMemory] = useState(true)
      const [digestChat, setDigestChat] = useState(true)
      const fileRef = useRef(null)

      if (!snapshot) return h('div', { className: 'cm-empty' }, '加载中…')

      const doExport = async () => {
        setBusy('export')
        try {
          const bundle = await apiPost('/export', { title: props.title || '' })
          const name = bundle.suggestedName || 'companion-memory.json'
          const text = JSON.stringify(bundle, null, 2)
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = name
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          const counts = bundle.conversation && bundle.conversation.counts
          const where = bundle.conversation && bundle.conversation.source === 'session' ? '完整聊天记录' : '48 小时热缓存'
          notify(
            counts
              ? `已导出：${name}（含${where} ${counts.total} 条：用户 ${counts.user} / 角色 ${counts.assistant}）`
              : `已导出记忆文档：${name}`,
          )
        } catch (error) {
          notify(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          setBusy('')
        }
      }

      /** 只导出聊天原文（Markdown），方便直接看/存档。 */
      const doExportChat = async () => {
        setBusy('chat')
        try {
          const bundle = await apiPost('/export', { title: props.title || '' })
          const markdown = bundle.conversation && typeof bundle.conversation.markdown === 'string'
            ? bundle.conversation.markdown
            : '# 聊天原文\n\n（这个对话还没有可导出的聊天原文）'
          const base = (bundle.suggestedName || 'companion-memory.json').replace(/\.json$/i, '')
          const name = `${base}_聊天原文.md`
          const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = name
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          const counts = bundle.conversation && bundle.conversation.counts
          notify(counts ? `已导出聊天原文：${name}（${counts.total} 条）` : `已导出聊天原文：${name}`)
        } catch (error) {
          notify(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          setBusy('')
        }
      }

      const pickFile = () => {
        if (fileRef.current) fileRef.current.click()
      }

      const onFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        setBusy('read')
        try {
          const text = await file.text()
          let parsed = null
          try {
            parsed = JSON.parse(text)
          } catch {
            throw new Error('文件不是合法的 JSON，无法读取。')
          }
          if (!parsed || parsed.$format !== 'companion-memory-bundle') {
            throw new Error('这不是伴侣记忆导出的文档（缺少 $format 标记）。')
          }
          const summary = parsed.summary || {}
          const state = parsed.state || {}
          setImported({
            fileName: file.name,
            exportedAt: parsed.exportedAtLocal || parsed.exportedAt || '未知时间',
            sourceTitle: (parsed.source && parsed.source.title) || '（未记录标题）',
            favorability: typeof summary.favorability === 'number' ? summary.favorability : (typeof state.favorability === 'number' ? state.favorability : 0),
            interactionDays: summary.interactionDays ?? state.interactionDays ?? 0,
            activeMemories: summary.activeMemories ?? (Array.isArray(state.memories) ? state.memories.filter((item) => !item.archived).length : 0),
            files: parsed.knowledge ? Object.keys(parsed.knowledge).length : 0,
            docs: parsed.docs ? Object.keys(parsed.docs).length : 0,
            conversationMessages: (parsed.conversation && parsed.conversation.counts && parsed.conversation.counts.total)
              ?? summary.conversationMessages
              ?? 0,
            conversationChars: Array.isArray(parsed.conversation?.messages)
              ? parsed.conversation.messages.reduce((sum, message) => sum + String(message?.text ?? '').length, 0)
              : 0,
            bundle: parsed,
          })
          notify('已读取记忆文档，请确认下面的摘要后点击导入。')
        } catch (error) {
          setImported(null)
          notify(`读取失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          setBusy('')
        }
      }

      const doImport = async (overwrite) => {
        if (!imported) return
        if (overwrite && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const ok = window.confirm('覆盖会把当前对话的记忆换成本文档的内容（人格文档 / 好感度 / 记忆 / 知识库 / 聊天原文）。确定覆盖吗？')
          if (!ok) return
        }
        setBusy('import')
        try {
          const result = await apiPost('/import', {
            bundle: imported.bundle,
            merge: overwrite ? false : true,
            cleanMemory: cleanMemory === true,
            digestChat: digestChat === true,
          })
          const clean = result.clean
          let cleanText = ''
          if (clean && !clean.error) {
            cleanText = `；记忆整理：保留 ${clean.kept} 条${clean.dropped ? `、归档 ${clean.dropped} 条（原文可检索找回）` : ''}${clean.modelUsed ? '（含模型整理）' : '（仅规则去重）'}`
            if (clean.backup) cleanText += `，已备份 ${clean.backup}`
          } else if (clean && clean.error) {
            cleanText = `；记忆整理未执行（${clean.error}），已按原样导入`
          }
          let digestText = ''
          if (result.digest) {
            if (result.digest.error) {
              digestText = `；AI 回顾未执行（${result.digest.error}）`
            } else if (result.digest.batches > 0) {
              digestText = `；AI 回顾了聊天原文 ${result.digest.batches} 批（约 ${Math.round((result.digest.chars || 0) / 1000)}k 字），新增记忆 ${result.digest.memoriesAdded} 条`
              if (result.digest.duplicates > 0) digestText += `（${result.digest.duplicates} 条重复已跳过）`
              if (result.digest.batchesSkipped > 0) digestText += `；另有 ${result.digest.batchesSkipped} 批超出上限未过`
            } else if (result.digest.batchesSkipped > 0) {
              digestText = `；AI 回顾跳过：${result.digest.batchesSkipped} 批超出上限`
            }
          }
          notify(`导入完成：文档 ${result.docsWritten} 份、知识库文件 ${result.filesWritten} 个${result.filesSkipped ? `（跳过 ${result.filesSkipped} 个已存在）` : ''}${result.conversationImported ? `、聊天原文 ${result.conversationImported} 条${result.conversationSkipped ? `（较早的 ${result.conversationSkipped} 条已跳过）` : ''}` : ''}${cleanText}${digestText}`)
          setImported(null)
          if (props.onReload) await props.onReload()
        } catch (error) {
          notify(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          setBusy('')
        }
      }

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '导出记忆文档'), h('span', { className: 'cm-muted' }, '换对话后也能还原')),
          h(
            'p',
            { className: 'cm-muted' },
            '把当前这个对话的人格文档、好感度、活跃记忆、知识库归档、自动打包设置，以及整个聊天记录原文（包括还没被打包进知识库的上下文）全部打包成一个 JSON 文档。换到别的对话框（或换设备）后导入这份文档，角色就会回到现在的状态。',
          h('p', { className: 'cm-muted' }, `导出对象：面板顶部「当前对话」选中的那个 —— ${props.title || '当前对话'}`),
          ),
          h(
            'div',
            { className: 'cm-actions' },
            h('button', { className: 'cm-btn cm-btn-primary', onClick: doExport, disabled: busy === 'export' }, busy === 'export' ? '导出中…' : '导出为 JSON 文档（含聊天原文）'),
            h('button', { className: 'cm-btn', onClick: doExportChat, disabled: busy === 'chat' }, busy === 'chat' ? '导出中…' : '只导出聊天原文（.md）'),
          ),
        ),
        h(
          'section',
          { className: 'cm-card' },
          h('div', { className: 'cm-card-head' }, h('h3', null, '导入记忆文档'), h('span', { className: 'cm-muted' }, '读取别处的记忆')),
          h('p', { className: 'cm-muted' }, '选择之前导出的 JSON 文档，先看摘要，再选「合并导入」或「覆盖导入」。'),
          h('p', { className: 'cm-muted' }, `导入目标：面板顶部「当前对话」选中的那个 —— ${props.title || '当前对话'}（不是聊天窗口里打开的那个）`),
          h('input', {
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            ref: fileRef,
            onChange: onFile,
          }),
          h(
            'div',
            { className: 'cm-actions' },
            h('button', { className: 'cm-btn', onClick: pickFile, disabled: busy === 'read' }, busy === 'read' ? '读取中…' : '选择 JSON 文档'),
          ),
          imported
            ? h(
                'div',
                { className: 'cm-import-preview' },
                h('div', { className: 'cm-muted' }, `文件：${imported.fileName}`),
                h('dl', { className: 'cm-kv' },
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '导出时间'), h('dd', null, imported.exportedAt)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '来源对话'), h('dd', null, imported.sourceTitle)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '好感度（角色对用户）'), h('dd', null, signed(imported.favorability))),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '聊天交互日'), h('dd', null, `${imported.interactionDays} 个`)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '活跃记忆'), h('dd', null, `${imported.activeMemories} 条`)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '知识库文件'), h('dd', null, `${imported.files} 个`)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '人格文档'), h('dd', null, `${imported.docs} 份`)),
                  h('div', { className: 'cm-kv-row' }, h('dt', null, '聊天原文'), h('dd', null, `${imported.conversationMessages || 0} 条${imported.conversationChars ? `（约 ${Math.round(imported.conversationChars / 1000)}k 字）` : ''}`)),
                ),
                h('p', { className: 'cm-muted' }, '选一个导入方式：合并会保留当前已有内容，只补充缺的；覆盖会用这份文档替换当前对话的记忆。'),
                h(
                  'label',
                  { className: 'cm-clean-option' },
                  h('input', {
                    type: 'checkbox',
                    checked: cleanMemory,
                    disabled: busy === 'import',
                    onChange: (event) => setCleanMemory(event.target.checked),
                  }),
                  h('span', null, '导入前自动整理记忆（去重 + 一次模型排序/归档；重点原文只去重不改写，失败会按原样导入）'),
                ),
                h(
                  'label',
                  { className: 'cm-clean-option' },
                  h('input', {
                    type: 'checkbox',
                    checked: digestChat,
                    disabled: busy === 'import',
                    onChange: (event) => setDigestChat(event.target.checked),
                  }),
                  h('span', null, '导入后让 AI 把聊天原文全部过一遍（分批提炼成记忆，会多花几次模型调用）'),
                ),
                h(
                  'div',
                  { className: 'cm-actions' },
                  h('button', { className: 'cm-btn cm-btn-primary', onClick: () => doImport(false), disabled: busy === 'import' }, busy === 'import' ? '导入中…' : '合并导入（保留现有）'),
                  h('button', { className: 'cm-btn', onClick: () => doImport(true), disabled: busy === 'import' }, busy === 'import' ? '导入中…' : '覆盖导入'),
                  h('button', { className: 'cm-btn', onClick: () => { setImported(null) }, disabled: busy === 'import' }, '取消'),
                ),
              )
            : null,
        ),
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
        ['好感度（角色对当前说话人）', (() => {
          const current = (snapshot.speakers || []).find((item) => item.isCurrent) || null
          const bondText = current && Number.isFinite(Number(current.bond)) ? `｜羁绊 ${signed(Number(current.bond))}（无上限）` : ''
          return `${signed(snapshot.favorability)}（-100 ~ 100）${bondText}${current && current.id !== 'default' ? `｜当前：${current.name}` : ''}`
        })()],
        ['在场人物', (snapshot.speakers || []).length > 1
          ? snapshot.speakers.map((speaker) => `${speaker.name}(${signed(speaker.favorability)})${speaker.isCurrent ? '·当前' : ''}`).join(' / ')
          : '仅当前用户（单人对话；多人时 AI 会自动区分说话人）'],
        ['说话方式', (() => {
          const style = snapshot.replyStyle || { mode: 'brief', maxSentences: 3 }
          if (style.mode === 'off') return '未限制（按角色设定自由发挥）'
          if (style.mode === 'brief') return `简短像真人（默认 ${style.maxSentences} 句内，不用文档格式）`
          if (style.mode === 'normal') return `自然长度（一般 ${style.maxSentences} 句内）`
          return '需要时可详细（仍保持口语化）'
        })()],
        ['48 小时(聊天时间)归纳', period.due ? '已到期，等待本轮对话完成' : period.nextDueAt ? `未到期，预计 ${formatStamp(period.nextDueAt)}` : '尚未开始计时'],
        ['上次归纳时间', period.lastSummaryAt ? formatStamp(period.lastSummaryAt) : '—'],
        ['对话月周期', `第 ${snapshot.cycle.index} 周期，已进行 ${snapshot.cycle.daysInCycle}/${snapshot.cycle.length} 个交互日`],
        ['周期起始日', snapshot.cycle.startDate || '—'],
        ['活跃记忆', `${snapshot.memories.activeCount} 条（上限 ${snapshot.memories.limit} 个交互日自动归档）`],
        ['已归档记忆', `${snapshot.memories.archivedCount} 条`],
        ['知识库归档', `${snapshot.knowledge.archive.length} 天记录 · ${snapshot.knowledge.monthly.length} 份月度包 · ${(snapshot.knowledge.packs || []).length} 份打包/压缩文档`],
        ['自动打包', snapshot.autoPack && (snapshot.autoPack.every > 0 || snapshot.autoPack.everyTokens > 0) ? `${[snapshot.autoPack.every > 0 ? `每 ${snapshot.autoPack.every} 轮` : '', snapshot.autoPack.everyTokens > 0 ? (snapshot.autoPack.everyTokensCustom === false ? `每约 ${snapshot.autoPack.everyTokens} tokens（跟随压缩阈值）` : `每约 ${snapshot.autoPack.everyTokens} tokens`) : ''].filter(Boolean).join(' 或 ')}（已打包 ${snapshot.autoPack.count} 次，当前区间 ${snapshot.autoPack.turnsSince} 轮 / 约 ${snapshot.autoPack.tokensSince} tokens，累计 ${snapshot.autoPack.totalTurns} 轮）` : '已关闭（可在知识库页设置）'],
        ['上下文压缩', snapshot.contextCompression && snapshot.contextCompression.count > 0 ? `已压缩 ${snapshot.contextCompression.count} 次（累计节省约 ${snapshot.contextCompression.shadowedTokens} tokens）${snapshot.contextCompression.lastAt ? `｜最近 ${formatStamp(snapshot.contextCompression.lastAt)}` : ''}` : '尚未触发（上下文接近模型窗口上限时，较早的对话会自动压缩成记忆块）'],
        ['最近两个聊天日上下文', snapshot.recent ? `${snapshot.recent.count} 条（用户 ${snapshot.recent.userCount} / 角色 ${snapshot.recent.assistantCount}）${snapshot.recent.newestAt ? `｜最新 ${formatStamp(snapshot.recent.newestAt)}` : ''}` : '—'],
        ['记录统计', `记录轮次 ${snapshot.stats.turnsRecorded} · 48h(聊天时间)归纳 ${snapshot.stats.summaries} · 月度打包 ${snapshot.stats.monthlyPackages}`],
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
            h('li', null, '好感度是【角色（AI）对用户】的好感度，范围 -100 ~ 100，每次对话结束由 AI 评估并记录理由，不聊天不会自动衰减。'),
            h('li', null, '48 小时（聊天时间）归纳到期后，AI 会在下一轮对话完成时段小结；每满 30 个交互日自动生成月度打包文档。'),
            h('li', null, '可在知识库页设置「每 N 轮对话自动打包一次」：满 N 轮时系统自动把区间内的重点原文、次要摘要、归纳与好感度变更整理成知识库文档。'),
            h('li', null, '知识库归档格式：归档日期：YYYY-MM-DD HH:MM，按日期分组存放。'),
            h('li', null, '最近两个聊天日的原始对话会被缓存，AI 可直接检索原话（聊天时间口径：没聊天的日子不占额度）；超出后自动清理，只保留知识库归档。'),
            h('li', null, '当上下文接近模型窗口上限时，较早的对话会自动压缩成伴侣记忆式的记忆块（重要原文 + 次要摘要 + 好感度变化 + 未完成事项），存进知识库 packs/ 并替换旧对话，长对话可以一直继续下去。'),
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

    // ── 接入软件 tab ────────────────────────────────────────────────────────

    /** 一条清单的可搜索文本：名称 / 说明 / 作者 / 分类 / 标签 / 能力。 */
    function integrationHaystack(item) {
      return [
        item.name,
        item.description,
        item.author,
        item.category,
        ...(Array.isArray(item.tags) ? item.tags : []),
        ...(Array.isArray(item.capabilities) ? item.capabilities : []),
      ]
        .join(' ')
        .toLowerCase()
    }

    /** 主页只认 http(s)，清单里塞 javascript: 之类的一律不渲染。 */
    function integrationHomepage(item) {
      const raw = typeof item.homepage === 'string' ? item.homepage.trim() : ''
      return /^https?:\/\//i.test(raw) ? raw : ''
    }

    /**
     * 「申请收录软件」跳转：GitHub 新建 Issue（用仓库里的收录模板），
     * 和插件市场把「申请收录插件」指到 GitHub 文档是同一个做法。
     */
    const INTEGRATION_SUBMIT_URL =
      'https://github.com/Root-7-KHX/companion-memory/issues/new?template=integration_submission.md'

    /** 示例清单：面板里「怎么接入」那段直接显示它，用户照抄就行。 */
    const SAMPLE_INTEGRATION = {
      id: 'example-software',
      name: '示例软件',
      description: '把这份 JSON 改成你要接入的软件：说清它是什么、能干什么。',
      version: '0.1.0',
      author: '你的名字',
      category: '通道',
      tags: ['示例', '改我'],
      capabilities: ['读消息', '发消息'],
      homepage: 'https://github.com/your-name/your-integration',
    }

    /** 自带的 QQ 机器人应用（点开就能用，不依赖 dsh-qqbot）。 */
    function QqbotBuiltinApp(props) {
      const { onBack } = props
      const [people, setPeople] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(API_BASE + '/people?limit=200', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          setPeople(await unwrap(response))
          setError('')
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }, [])
      useEffect(() => { load() }, [load])
      const [qqStatus, setQqStatus] = useState(null)
      const [qqConfig, setQqConfig] = useState(null)
      const [appIdDraft, setAppIdDraft] = useState('')
      const [secretDraft, setSecretDraft] = useState('')
      const [qqNotice, setQqNotice] = useState('')
      const [qqBusy, setQqBusy] = useState('')
      const [qqMessages, setQqMessages] = useState([])
      const [stickers, setStickers] = useState([])
      const [schedules, setSchedules] = useState([])
      const [stickerBusy, setStickerBusy] = useState('')
      const [scheduleDraft, setScheduleDraft] = useState({ time: '', content: '', scope: 'group', targetId: '', weekdays: '' })
      const [scheduleNotice, setScheduleNotice] = useState('')
      const [groupDraft, setGroupDraft] = useState({ groupId: '', memberId: '', minutes: '10' })
      const [groupNotice, setGroupNotice] = useState('')
      const [joinRequests, setJoinRequests] = useState([])
      const [broadcastDraft, setBroadcastDraft] = useState({ scope: 'group', targetIds: '', content: '' })
      const [broadcastNotice, setBroadcastNotice] = useState('')
      const [broadcastBusy, setBroadcastBusy] = useState(false)
      const [bridge, setBridge] = useState(null)
      const [bridgeDraft, setBridgeDraft] = useState('')
      const [bridgeNotice, setBridgeNotice] = useState('')
      const [qqSessions, setQqSessions] = useState([])
      const [qqSessionGroups, setQqSessionGroups] = useState([])
      const [bridgePickerOpen, setBridgePickerOpen] = useState(false)
      const [collapsedWs, setCollapsedWs] = useState({})
      const [qqPeers, setQqPeers] = useState([])
      const [allowedPeers, setAllowedPeers] = useState([])
      const [allowedDirty, setAllowedDirty] = useState(false)
      const [vpSamples, setVpSamples] = useState([])
      const [vpDraft, setVpDraft] = useState({ freeEnrollSeconds: 60, autoCollectAbove: 0.7, autoCollectAboveWhenFull: 0.8, threshold: 0.55, maxSeconds: 300 })
      const [vpNotice, setVpNotice] = useState('')
      const [vpBusy, setVpBusy] = useState(false)
      const [vpInit, setVpInit] = useState(false)
      const [vpMembers, setVpMembers] = useState([])
      const [vpAllowed, setVpAllowed] = useState([])
      const [vpMemberDraft, setVpMemberDraft] = useState([])
      const [vpMemberNotice, setVpMemberNotice] = useState('')
      const [routes, setRoutes] = useState([])
      const [routeSessions, setRouteSessions] = useState([])
      const [routeDefault, setRouteDefault] = useState('')
      const [routeNotice, setRouteNotice] = useState('')
      const [routeWorkspaces, setRouteWorkspaces] = useState([])
      const [routePickerOpen, setRoutePickerOpen] = useState('')

      const loadQq = useCallback(async () => {
        try {
          const get = (path) => fetch(API_BASE + path, { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(unwrap)
          const [status, config, messages, stickerList, scheduleList, bridgeInfo, sessionList, peerInfo] = await Promise.all([
            get('/qq/status'),
            get('/qq/config'),
            get('/qq/messages?limit=10'),
            get('/qq/stickers?limit=60'),
            get('/qq/schedule'),
            get('/qq/bridge'),
            get('/qq/bridge/sessions'),
            get('/qq/peers'),
          ])
          setBridge(bridgeInfo)
          setQqSessions(Array.isArray(sessionList && sessionList.items) ? sessionList.items : [])
          setQqSessionGroups(Array.isArray(sessionList && sessionList.groups) ? sessionList.groups : [])
          setQqPeers(Array.isArray(peerInfo && peerInfo.items) ? peerInfo.items : [])
          setAllowedPeers(Array.isArray(peerInfo && peerInfo.allowedPeers) ? peerInfo.allowedPeers : [])
          setQqStatus(status)
          setQqConfig(config)
          setQqMessages(Array.isArray(messages) ? messages : [])
          setStickers(Array.isArray(stickerList) ? stickerList : [])
          setSchedules(Array.isArray(scheduleList) ? scheduleList : [])
          try {
            const sampleList = await get('/qq/voiceprint/samples')
            setVpSamples(Array.isArray(sampleList) ? sampleList : [])
          } catch {
            // 声纹接口失败不影响 QQ 主面板
          }
          try {
            const routeInfo = await get('/qq/routes')
            setRoutes(Array.isArray(routeInfo && routeInfo.items) ? routeInfo.items : [])
            setRouteWorkspaces(Array.isArray(routeInfo && routeInfo.workspaces) ? routeInfo.workspaces : [])
            setRouteSessions(Array.isArray(routeInfo && routeInfo.sessions) ? routeInfo.sessions : [])
            setRouteDefault((routeInfo && routeInfo.defaultSessionId) || '')
          } catch {
            // 路由接口失败不影响 QQ 主面板
          }
          try {
            const memberInfo = await get('/qq/voiceprint/members')
            const allowed = Array.isArray(memberInfo && memberInfo.allowed) ? memberInfo.allowed : []
            setVpMembers(Array.isArray(memberInfo && memberInfo.items) ? memberInfo.items : [])
            setVpAllowed(allowed)
            setVpMemberDraft((prev) => (prev.length === 0 ? allowed : prev))
          } catch {
            // 同上
          }
          const vpStatus = status && status.voiceprint
          if (vpStatus) {
            setVpInit((prev) => {
              if (!prev) {
                setVpDraft({
                  freeEnrollSeconds: String(vpStatus.freeEnrollSeconds ?? 60),
                  autoCollectAbove: String(vpStatus.autoCollectAbove ?? 0.7),
                  autoCollectAboveWhenFull: String(vpStatus.autoCollectAboveWhenFull ?? 0.8),
                  threshold: String(vpStatus.threshold ?? 0.55),
                  maxSeconds: String(vpStatus.maxSeconds ?? 300),
                })
              }
              return true
            })
          }
        } catch (caught) {
          setQqNotice('读取连接状态失败：' + caught.message)
        }
      }, [])

      useEffect(() => {
        loadQq()
        const timer = setInterval(loadQq, 5000)
        return () => clearInterval(timer)
      }, [loadQq])

      const connectQq = useCallback(async () => {
        setQqBusy('save')
        try {
          const appId = appIdDraft !== '' ? appIdDraft : (qqConfig && qqConfig.appId) || ''
          await apiPost('/qq/config', { appId, appSecret: secretDraft, enabled: true })
          setSecretDraft('')
          const started = await apiPost('/qq/start', {})
          setQqStatus(started)
          setQqNotice(started && started.connected ? '已连接 QQ' : '配置已保存，正在连接…（同一个机器人只能有一条网关连接）')
          await loadQq()
        } catch (error) {
          setQqNotice('连接失败：' + error.message)
        } finally {
          setQqBusy('')
        }
      }, [appIdDraft, secretDraft, qqConfig, loadQq])

      const disconnectQq = useCallback(async () => {
        setQqBusy('stop')
        try {
          setQqStatus(await apiPost('/qq/stop', {}))
          setQqNotice('已断开 QQ')
        } catch (error) {
          setQqNotice('断开失败：' + error.message)
        } finally {
          setQqBusy('')
        }
      }, [])

      const groupAction = useCallback(async (kind) => {
        setGroupNotice('')
        const groupId = groupDraft.groupId.trim()
        const memberIds = groupDraft.memberId.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean)
        try {
          if (kind === 'info') {
            const info = await apiGet('/qq/group/info?groupId=' + encodeURIComponent(groupId))
            setGroupNotice('群信息：' + JSON.stringify(info).slice(0, 160))
            return
          }
          if (kind === 'requests') {
            const page = await apiGet('/qq/join-requests?groupId=' + encodeURIComponent(groupId))
            setJoinRequests(Array.isArray(page && page.data) ? page.data : [])
            setGroupNotice('拉取到 ' + (Array.isArray(page && page.data) ? page.data.length : 0) + ' 条入群申请')
            return
          }
          if (kind === 'mute') await apiPost('/qq/mute', { groupId, memberOpenids: memberIds, minutes: Number(groupDraft.minutes) || 10 })
          if (kind === 'unmute') await apiPost('/qq/mute', { groupId, memberOpenids: memberIds, unmute: true })
          if (kind === 'kick') await apiPost('/qq/kick', { groupId, memberOpenids: memberIds })
          if (kind === 'approve' || kind === 'decline') await apiPost('/qq/join-approve', { groupId, memberOpenid: memberIds[0] || '', op: kind === 'approve' ? 'approve' : 'decline' })
          setGroupNotice('已执行：' + kind)
        } catch (error) {
          setGroupNotice('失败：' + error.message)
        }
      }, [groupDraft])

      const recallMessage = useCallback(async (message) => {
        try {
          await apiPost('/qq/recall', { scope: message.scope, targetId: message.peerId, messageId: message.id })
          setScheduleNotice('已撤回：' + String(message.content || '').slice(0, 20))
          await loadQq()
        } catch (error) {
          setScheduleNotice('撤回失败：' + error.message)
        }
      }, [loadQq])

      const deleteSticker = useCallback(async (id) => {
        setStickerBusy(id)
        try {
          await apiPost('/qq/stickers/delete', { id })
          await loadQq()
        } catch (error) {
          setScheduleNotice('删表情包失败：' + error.message)
        } finally {
          setStickerBusy('')
        }
      }, [loadQq])

      const addSchedule = useCallback(async () => {
        try {
          const weekdays = String(scheduleDraft.weekdays || '').split(/[,，\s]+/).map(Number).filter((n) => n >= 1 && n <= 7)
          await apiPost('/qq/schedule', { ...scheduleDraft, weekdays })
          setScheduleDraft({ time: '', content: '', scope: 'group', targetId: '', weekdays: '' })
          setScheduleNotice('已添加定时消息')
          await loadQq()
        } catch (error) {
          setScheduleNotice('添加失败：' + error.message)
        }
      }, [scheduleDraft, loadQq])

      const saveBridge = useCallback(async (patch) => {
        try {
          const next = await apiPost('/qq/bridge', { sessionId: bridgeDraft !== '' ? bridgeDraft : (bridge && bridge.sessionId) || '', ...patch })
          setBridge(next)
          setBridgeNotice('已保存')
          await loadQq()
        } catch (error) {
          setBridgeNotice('保存失败：' + error.message)
        }
      }, [bridgeDraft, bridge, loadQq])

      const runBroadcast = useCallback(async () => {
        setBroadcastBusy(true)
        setBroadcastNotice('')
        try {
          const result = await apiPost('/qq/broadcast', broadcastDraft)
          setBroadcastNotice('群发完成：成功 ' + result.sent + ' / 失败 ' + result.failed)
        } catch (error) {
          setBroadcastNotice('群发失败：' + error.message)
        } finally {
          setBroadcastBusy(false)
        }
      }, [broadcastDraft])

      const sendSticker = useCallback(async (stickerId) => {
        try {
          await apiPost('/qq/sticker/send', { stickerId })
          setScheduleNotice('已发表情包')
          await loadQq()
        } catch (error) {
          setScheduleNotice('发表情包失败：' + error.message)
        }
      }, [loadQq])

      const toggleAutoSticker = useCallback(async () => {
        const current = qqConfig && qqConfig.autoSticker ? qqConfig.autoSticker.enabled === true : false
        try {
          await apiPost('/qq/autosticker', { enabled: !current })
          await loadQq()
        } catch (error) {
          setScheduleNotice('切换失败：' + error.message)
        }
      }, [qqConfig, loadQq])

      const deleteSchedule = useCallback(async (id) => {
        try {
          await apiPost('/qq/schedule/delete', { id })
          await loadQq()
        } catch (error) {
          setScheduleNotice('删除失败：' + error.message)
        }
      }, [loadQq])

      const saveAutoRoute = useCallback(async (patch) => {
        if (!bridge) return
        try {
          await apiPost('/qq/bridge', {
            enabled: bridge.enabled === true,
            sessionId: bridge.sessionId || '',
            approvalEnabled: bridge.approvalEnabled === true,
            approvalTimeoutMs: bridge.approvalTimeoutMs,
            autoCreateSession: patch.autoCreateSession !== undefined ? patch.autoCreateSession : bridge.autoCreateSession !== false,
            autoSessionCwd: patch.autoSessionCwd !== undefined ? patch.autoSessionCwd : (bridge.autoSessionCwd || ''),
            autoSessionWorkspaceId: patch.autoSessionWorkspaceId !== undefined ? patch.autoSessionWorkspaceId : (bridge.autoSessionWorkspaceId || ''),
          })
          setRouteNotice('已保存自动新建设置')
          await loadQq()
        } catch (caught) {
          setRouteNotice('保存失败：' + caught.message)
        }
      }, [bridge, loadQq])

      const renamePeerRoute = useCallback(async (key, name) => {
        try {
          await apiPost('/qq/peers/rename', { key, name })
          setRouteNotice('名字已保存')
          await loadQq()
        } catch (caught) {
          setRouteNotice('改名失败：' + caught.message)
        }
      }, [loadQq])

      const setPeerRoute = useCallback(async (key, sessionId) => {
        try {
          await apiPost('/qq/routes', { key, sessionId })
          setRouteNotice('已保存：这条 QQ 聊天走指定会话')
          await loadQq()
        } catch (caught) {
          setRouteNotice('保存失败：' + caught.message)
        }
      }, [loadQq])

      const saveVoiceprint = useCallback(async () => {
        setVpBusy(true)
        try {
          await apiPost('/qq/voiceprint', {
            enabled: true,
            threshold: Number(vpDraft.threshold),
            autoCollectAbove: Number(vpDraft.autoCollectAbove),
            autoCollectAboveWhenFull: Number(vpDraft.autoCollectAboveWhenFull),
            freeEnrollSeconds: Number(vpDraft.freeEnrollSeconds),
            maxSeconds: Number(vpDraft.maxSeconds),
          })
          setVpNotice('声纹设置已保存')
          await loadQq()
        } catch (caught) {
          setVpNotice('保存失败：' + caught.message)
        } finally {
          setVpBusy(false)
        }
      }, [vpDraft, loadQq])

      const toggleVpMember = useCallback((externalId) => {
        setVpMemberDraft((prev) => (prev.includes(externalId) ? prev.filter((item) => item !== externalId) : prev.concat([externalId])))
      }, [])

      const saveVpMembers = useCallback(async () => {
        try {
          await apiPost('/qq/voiceprint/members', { allowedMembers: vpMemberDraft })
          setVpMemberNotice('已保存勾选（' + vpMemberDraft.length + ' 人）')
          await loadQq()
        } catch (caught) {
          setVpMemberNotice('保存失败：' + caught.message)
        }
      }, [vpMemberDraft, loadQq])

      const deleteVoiceSample = useCallback(async (name, index) => {
        try {
          await apiPost('/qq/voiceprint/sample/delete', { name, index })
          setVpNotice('已删除 1 条样本')
          await loadQq()
        } catch (caught) {
          setVpNotice('删除失败：' + caught.message)
        }
      }, [loadQq])

      // 消息转发：当前选中的会话 + 按工作区（文件夹）分组的下拉树
      const selectedSessionId = bridgeDraft !== '' ? bridgeDraft : (bridge && bridge.sessionId) || ''
      const selectedSession = qqSessions.find((item) => item.id === selectedSessionId) || null
      const selectedSessionTitle = selectedSession ? (selectedSession.title || '对话 ' + String(selectedSession.id).slice(0, 8)) : ''
      const bridgeFolders = (qqSessionGroups.length > 0 ? qqSessionGroups : [{ key: '__all__', label: '对话', sessions: qqSessions }])
        .filter((group) => Array.isArray(group.sessions) && group.sessions.length > 0)

      const items = people && Array.isArray(people.items) ? people.items : []
      const vpInfo = qqStatus && qqStatus.voiceprint
      return h(
        'div',
        { className: 'cm-app' },
        h(
          'div',
          { className: 'cm-app-head' },
          h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: onBack }, '← 返回'),
          h('div', { className: 'cm-app-title' }, h('h2', null, 'QQ 机器人'), h('p', { className: 'cm-app-sub' }, '自带应用 · 不用安装 dsh-qqbot')),
          h('button', { className: 'cm-btn cm-btn-small', type: 'button', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'),
        ),
        h(
          'div',
          { className: 'cm-app-body' },
          h(
            'section',
            { className: 'cm-app-card' },
            h('div', { className: 'cm-app-card-head' }, h('h3', null, 'QQ 群聊/私聊 → 选 AI（每条独立）'), h('span', { className: 'cm-badge' }, bridge && bridge.enabled ? '接管中' : '已关'), h('span', { className: 'cm-muted' }, routes.length + ' 条')),
            h('p', { className: 'cm-hint' }, '这里一行就是一个 QQ 群聊/私聊；右边下拉是给这个群单独选一个 AI 会话。群聊要等群里给机器人发过消息（@ 我一次）才会出现在列表里——QQ 官方没有“列出全部群”的接口，只能收到消息后反查群名。'),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '4px 0 6px' } },
              h('span', { className: 'cm-hint', style: { flex: '1 1 100%' } }, '没指定 AI 的聊天默认 = 新建会话，建在：'),
              h(
                'select',
                {
                  className: 'cm-input',
                  style: {
                    flex: '1 1 100%',
                    width: '100%',
                    minWidth: '0',
                    maxWidth: '100%',
                    height: 'auto',
                    minHeight: '38px',
                    padding: '8px 10px',
                    lineHeight: '1.5',
                    fontSize: '13px',
                  },
                  value: (bridge && bridge.autoSessionWorkspaceId) || '',
                  onChange: (event) => saveAutoRoute({ autoSessionWorkspaceId: event.target.value }),
                },
                h('option', { value: '' }, '未指定（默认工作区）'),
                routeWorkspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.label + '（' + workspace.cwd + '）')),
              ),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: '0 0 100%' } },
                h('input', { type: 'checkbox', checked: !(bridge && bridge.autoCreateSession === false), onChange: (event) => saveAutoRoute({ autoCreateSession: event.target.checked }) }),
                h('span', { className: 'cm-hint' }, '自动新建 AI 会话并回答'),
              ),
            ),
            routes.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有 QQ 聊天；QQ 收到消息后这里会自动出现。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  routes.map((item) =>
                    (() => {
                      const currentSession = routeSessions.find((session) => session.id === item.sessionId) || null
                      const currentLabel = currentSession ? (currentSession.title || '对话 ' + String(currentSession.id).slice(0, 8)) : '自动新建会话'
                      const seen = new Set(routeWorkspaces.map((workspace) => workspace.cwd))
                      const loose = routeSessions.filter((session) => !seen.has(session.cwd || ''))
                      const folder = (key, label, sessions) => {
                        const collapsed = collapsedWs['route:' + key] === true
                        return h(
                          'div',
                          { key, className: 'cm-qq-folder' },
                          h(
                            'button',
                            { className: 'cm-qq-folder-head', type: 'button', onClick: () => setCollapsedWs((prev) => ({ ...prev, ['route:' + key]: !collapsed })) },
                            (collapsed ? '▸ ' : '▾ ') + label + '（' + sessions.length + '）',
                          ),
                          collapsed
                            ? null
                            : sessions.map((session) =>
                                h(
                                  'button',
                                  {
                                    key: session.id,
                                    className: 'cm-qq-session' + (session.id === item.sessionId ? ' cm-qq-session-active' : ''),
                                    type: 'button',
                                    title: session.id,
                                    onClick: () => { setPeerRoute(item.key, session.id); setRoutePickerOpen('') },
                                  },
                                  h('span', { className: 'cm-qq-session-name' }, session.title || '对话 ' + String(session.id).slice(0, 8)),
                                  session.enabled ? h('span', { className: 'cm-muted' }, '记忆开') : null,
                                ),
                              ),
                        )
                      }
                      return h(
                        'li',
                        { key: item.key, className: 'cm-qq-member', style: { alignItems: 'center', flexWrap: 'wrap' } },
                        h('input', {
                          className: 'cm-input',
                          style: { flex: '0 0 150px', width: '150px', minWidth: '150px' },
                          defaultValue: item.name || '',
                          placeholder: '未命名',
                          key: item.key + ':' + (item.name || ''),
                          onBlur: (event) => {
                            const next = String(event.target.value || '').trim()
                            if (next !== (item.name || '')) renamePeerRoute(item.key, next)
                          },
                        }),
                        h('span', { className: 'cm-muted', style: { flex: '0 0 56px', textAlign: 'center' } }, item.scope === 'group' ? '（群）' : '（私聊）'),
                        h('span', { className: 'cm-qq-id', style: { flex: '0 0 92px', textAlign: 'left' } }, item.peerId ? String(item.peerId).slice(0, 8) + '…' : ''),
                        h(
                          'div',
                          { className: 'cm-qq-picker' },
                          h(
                            'button',
                            {
                              className: 'cm-btn cm-btn-small cm-qq-picker-btn',
                              type: 'button',
                              title: currentLabel,
                              style: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', lineHeight: '1.4' },
                              onClick: () => setRoutePickerOpen((open) => (open === item.key ? '' : item.key)),
                            },
                            currentLabel + ' ▾',
                          ),
                          routePickerOpen === item.key
                            ? h(
                                'div',
                                { className: 'cm-qq-picker-panel' },
                                h(
                                  'div',
                                  { className: 'cm-qq-picker-head' },
                                  h('span', { className: 'cm-muted' }, '按工作区（文件夹）分组，点文件夹展开/收起'),
                                  h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => setRoutePickerOpen('') }, '收起'),
                                ),
                                h(
                                  'button',
                                  { className: 'cm-btn cm-btn-small', type: 'button', style: { margin: '0 0 6px' }, onClick: () => { setPeerRoute(item.key, ''); setRoutePickerOpen('') } },
                                  '不指定（自动新建会话）',
                                ),
                                routeWorkspaces.map((workspace) => folder(workspace.id, workspace.label || workspace.cwd, routeSessions.filter((session) => (session.cwd || '') === workspace.cwd))),
                                loose.length > 0 ? folder('loose', '未分组', loose) : null,
                              )
                            : null,
                        ),
                        (() => {
                          const allKeys = qqPeers.map((peer) => peer.key)
                          const checked = allowedPeers.length === 0 || allowedPeers.includes(item.key)
                          return h(
                            'label',
                            { className: 'cm-qq-peer', style: { gap: '4px' } },
                            h('input', {
                              type: 'checkbox',
                              checked,
                              onChange: () => {
                                const current = allowedPeers.length === 0 ? allKeys : allowedPeers
                                const next = checked ? current.filter((key) => key !== item.key) : [...new Set([...current, item.key])]
                                const normalized = next.length >= allKeys.length ? [] : next
                                setAllowedPeers(normalized)
                                saveBridge({ allowedPeers: normalized })
                              },
                            }),
                            h('span', { className: 'cm-hint' }, '接'),
                          )
                        })(),
                        h('span', { className: 'cm-muted' }, '消息 ' + item.count),
                      )
                    })(),
                  ),
                ),
            routeNotice ? h('p', { className: 'cm-hint' }, routeNotice) : null,
            h('div', { style: { borderTop: '1px solid rgba(127,127,127,0.25)', margin: '8px 0 6px' } }),
            h('p', { className: 'cm-hint' }, '总开关（关掉就完全不理 QQ）；审批请求会推成 QQ 卡片（按钮或 /approve 验证码都能批）：'),
            h(
              'div',
              { className: 'cm-qq-form' },
              h(
                'label',
                { className: 'cm-switch' },
                h('input', { type: 'checkbox', checked: !!(bridge && bridge.enabled), onChange: (event) => saveBridge({ enabled: event.target.checked }) }),
                h('span', { className: 'cm-switch-slider' }),
                h('span', { className: 'cm-switch-text' }, bridge && bridge.enabled ? '接管中（点一下关闭）' : '已关闭（点一下开启）'),
              ),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => saveBridge({ approvalEnabled: !(bridge && bridge.approvalEnabled) }) }, '审批卡片：' + (bridge && bridge.approvalEnabled ? '开' : '关')),
            ),
            bridgeNotice ? h('p', { className: 'cm-hint' }, bridgeNotice) : null,
            bridge && bridge.lastPeer ? h('p', { className: 'cm-hint' }, '最近 QQ 会话：' + bridge.lastPeer.scope + ' · ' + String(bridge.lastPeer.peerId).slice(0, 12) + '… · 待审批 ' + bridge.pendingApprovals) : null,
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h('div', { className: 'cm-app-card-head' }, h('h3', null, '群成员'), h('span', { className: 'cm-muted' }, items.length + ' 人')),
            h('p', { className: 'cm-hint' }, '按稳定 openid 认人：改昵称也还是同一个人，旧名字留在历史里。'),
            error ? h('div', { className: 'cm-banner cm-banner-error' }, '读取失败：' + error) : null,
            items.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有群成员档案。QQ 侧把消息送进来之后，这里会自动出现（按 openid 归并）。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  items.map((person) =>
                    h(
                      'li',
                      { key: person.externalId, className: 'cm-qq-member' },
                      h('span', { className: 'cm-qq-name' }, person.currentName || '未命名'),
                      h('span', { className: 'cm-qq-id' }, String(person.externalId).slice(0, 10) + '…'),
                      h('span', { className: 'cm-muted' }, '消息 ' + person.msgCount + (person.names && person.names.length ? ' · 曾用名 ' + person.names.map((item) => item.name).join('、') : '')),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h(
              'div',
              { className: 'cm-app-card-head' },
              h('h3', null, '连接 QQ'),
              h('span', { className: 'cm-badge' }, qqStatus ? (qqStatus.connected ? '已连接' : qqStatus.status || '未连接') : '读取中…'),
            ),
            h('p', { className: 'cm-hint' }, '原生连接：AI记忆 自己连 QQ 官方网关（不经过 dsh-qqbot）。同一个机器人只能有一条网关连接，连之前先把 dsh-qqbot 那边的 QQ 停掉，不然会互相顶掉。'),
            h(
              'div',
              { className: 'cm-qq-form' },
              h('input', {
                className: 'cm-input',
                type: 'text',
                placeholder: 'appId',
                value: appIdDraft !== '' ? appIdDraft : (qqConfig && qqConfig.appId) || '',
                onChange: (event) => setAppIdDraft(event.target.value),
              }),
              h('input', {
                className: 'cm-input',
                type: 'password',
                placeholder: qqConfig && qqConfig.hasSecret ? 'appSecret 已保存（留空不改）' : 'appSecret',
                value: secretDraft,
                onChange: (event) => setSecretDraft(event.target.value),
              }),
              h('button', { className: 'cm-btn cm-btn-primary cm-btn-small', type: 'button', disabled: qqBusy !== '', onClick: connectQq }, qqBusy === 'save' ? '连接中…' : '保存并连接'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', disabled: qqBusy !== '', onClick: disconnectQq }, qqBusy === 'stop' ? '断开中…' : '断开'),
            ),
            qqStatus && qqStatus.botName ? h('p', { className: 'cm-hint' }, '机器人：' + qqStatus.botName) : null,
            qqStatus && qqStatus.lastError ? h('p', { className: 'cm-hint' }, '最近错误：' + qqStatus.lastError) : null,
            qqNotice ? h('p', { className: 'cm-hint' }, qqNotice) : null,
            h(
              'p',
              { className: 'cm-hint' },
              '跳转：',
              h('a', { className: 'cm-int-link', href: 'https://q.qq.com/', target: '_blank', rel: 'noreferrer noopener' }, 'QQ AI 开放平台 ↗'),
              ' · ',
              h('a', { className: 'cm-int-link', href: 'https://bot.q.qq.com/wiki/', target: '_blank', rel: 'noreferrer noopener' }, 'QQ 机器人文档 ↗'),
            ),
            h(
              'div',
              { className: 'cm-app-card-head' },
              h('h3', null, '最近收到的 QQ 消息'),
              h('span', { className: 'cm-muted' }, qqMessages.length + ' 条'),
            ),
            qqMessages.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有收到消息。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  qqMessages.map((message) =>
                    h(
                      'li',
                      { key: message.id, className: 'cm-qq-member' },
                      h('span', { className: 'cm-qq-name' }, String(message.senderName || message.senderId || '?').slice(0, 14)),
                      h('span', { className: 'cm-muted' }, message.scope === 'group' ? '群' : '私聊'),
                      h('span', { className: 'cm-person-memory-text' }, String(message.content || '').slice(0, 80)),
                      h(
                        'button',
                        { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => recallMessage(message) },
                        '撤回',
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h(
              'div',
              { className: 'cm-app-card-head' },
              h('h3', null, '声纹（本地识别）'),
              h('span', { className: 'cm-badge' }, vpInfo && vpInfo.enabled ? '开' : '关'),
            ),
            h('p', { className: 'cm-hint' }, '本地 CAM++：QQ 语音先比声纹再转文字。前 N 秒无门槛收录，之后按相似度门槛收；满时长后门槛自动提高。样本可以单条删除。'),
            vpInfo
              ? h(
                  'p',
                  { className: 'cm-hint' },
                  (vpInfo.profiles || []).length === 0
                    ? '还没有声纹档案。'
                    : (vpInfo.profiles || []).map((item) => '「' + item.name + '」已有 ' + item.samples + ' 条样本，共 ' + item.seconds + ' 秒 / 上限 ' + vpInfo.maxSeconds + ' 秒').join('；'),
                )
              : null,
            h(
              'div',
              { className: 'cm-qq-form', style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', { className: 'cm-input', style: { flex: '0 0 120px' }, type: 'number', min: '0', max: '600', value: vpDraft.freeEnrollSeconds, onChange: (event) => setVpDraft({ ...vpDraft, freeEnrollSeconds: event.target.value }) }),
                h('span', { className: 'cm-hint' }, '无门槛收录时长（秒）：这之内你说一句收一句，不卡相似度'),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', { className: 'cm-input', style: { flex: '0 0 120px' }, type: 'number', min: '0.3', max: '0.99', step: '0.01', value: vpDraft.autoCollectAbove, onChange: (event) => setVpDraft({ ...vpDraft, autoCollectAbove: event.target.value }) }),
                h('span', { className: 'cm-hint' }, '常规收录门槛（相似度）：过了无门槛期后，高于这个分才自动收录'),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', { className: 'cm-input', style: { flex: '0 0 120px' }, type: 'number', min: '0.3', max: '0.99', step: '0.01', value: vpDraft.autoCollectAboveWhenFull, onChange: (event) => setVpDraft({ ...vpDraft, autoCollectAboveWhenFull: event.target.value }) }),
                h('span', { className: 'cm-hint' }, '满额门槛（相似度）：存满时长上限后，要更高分才继续收'),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', { className: 'cm-input', style: { flex: '0 0 120px' }, type: 'number', min: '0.3', max: '0.99', step: '0.01', value: vpDraft.threshold, onChange: (event) => setVpDraft({ ...vpDraft, threshold: event.target.value }) }),
                h('span', { className: 'cm-hint' }, '认人阈值（相似度）：低于这个分就标「不像你」，只影响提示，不影响收录'),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', { className: 'cm-input', style: { flex: '0 0 120px' }, type: 'number', min: '10', max: '3600', value: vpDraft.maxSeconds, onChange: (event) => setVpDraft({ ...vpDraft, maxSeconds: event.target.value }) }),
                h('span', { className: 'cm-hint' }, '时长上限（秒）：每个人最多存这么多秒；超了先从最老样本剪'),
              ),
              h('button', { className: 'cm-btn cm-btn-primary cm-btn-small', type: 'button', disabled: vpBusy, onClick: saveVoiceprint }, vpBusy ? '保存中…' : '保存声纹设置'),
            ),
            h(
              'details',
              { className: 'cm-app-card', style: { marginTop: '6px' } },
              h('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, '群聊里认谁的声音（点开勾选）'),
              h('p', { className: 'cm-hint' }, '群语音只有勾选的人才会做声纹识别/收录；不勾就完全不处理群里的语音，避免把别人的声音录进档案。'),
              vpMembers.length === 0
                ? h('p', { className: 'cm-muted' }, '还没有 QQ 人物档案，等群里有消息进来后会自动出现。')
                : h(
                    'ul',
                    { className: 'cm-qq-members' },
                    vpMembers.map((member) =>
                      h(
                        'li',
                        { key: member.externalId, className: 'cm-qq-member' },
                        h(
                          'label',
                          { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                          h('input', { type: 'checkbox', checked: vpMemberDraft.includes(member.externalId), onChange: () => toggleVpMember(member.externalId) }),
                          h('span', null, (member.name || '未命名') + '（' + String(member.externalId).slice(0, 8) + '…）'),
                        ),
                        h('span', { className: 'cm-muted' }, '消息 ' + member.msgCount),
                      ),
                    ),
                  ),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: saveVpMembers }, '保存勾选（' + vpMemberDraft.length + ' 人）'),
              vpMemberNotice ? h('p', { className: 'cm-hint' }, vpMemberNotice) : null,
            ),
            vpNotice ? h('p', { className: 'cm-hint' }, vpNotice) : null,
            vpSamples.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有声纹样本，发几条语音就会自动收录。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  vpSamples.flatMap((entry) =>
                    entry.samples.map((sample) =>
                      h(
                        'li',
                        { key: entry.name + ':' + sample.index, className: 'cm-qq-member' },
                        h('span', { className: 'cm-qq-name' }, entry.name),
                        h('span', { className: 'cm-muted' }, '样本 #' + (sample.index + 1) + ' ｜ 时长 ' + sample.seconds + ' 秒' + (sample.at ? ' ｜ 收录于 ' + new Date(sample.at).toLocaleString() : '')),
                        h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => deleteVoiceSample(entry.name, sample.index) }, '删除'),
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h('div', { className: 'cm-app-card-head' }, h('h3', null, '群发'), h('span', { className: 'cm-muted' }, '串行发送 · 间隔 1.5s · 单次最多 50 个')),
            h(
              'div',
              { className: 'cm-qq-form' },
              h('input', { className: 'cm-input', type: 'text', placeholder: '目标 openid（多个用逗号/换行）', value: broadcastDraft.targetIds, onChange: (event) => setBroadcastDraft({ ...broadcastDraft, targetIds: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '要发的内容', value: broadcastDraft.content, onChange: (event) => setBroadcastDraft({ ...broadcastDraft, content: event.target.value }) }),
              h('button', { className: 'cm-btn cm-btn-primary cm-btn-small', type: 'button', disabled: broadcastBusy, onClick: runBroadcast }, broadcastBusy ? '发送中…' : '开始群发'),
            ),
            broadcastNotice ? h('p', { className: 'cm-hint' }, broadcastNotice) : null,
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h('div', { className: 'cm-app-card-head' }, h('h3', null, '群管理'), h('span', { className: 'cm-muted' }, '官方接口 · 需要机器人是群管理员')),
            h(
              'div',
              { className: 'cm-qq-form' },
              h('input', { className: 'cm-input', type: 'text', placeholder: '群 openid', value: groupDraft.groupId, onChange: (event) => setGroupDraft({ ...groupDraft, groupId: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '成员 openid（多个用逗号）', value: groupDraft.memberId, onChange: (event) => setGroupDraft({ ...groupDraft, memberId: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '禁言分钟', value: groupDraft.minutes, onChange: (event) => setGroupDraft({ ...groupDraft, minutes: event.target.value }) }),
            ),
            h(
              'div',
              { className: 'cm-actions' },
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('info') }, '查群信息'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('mute') }, '禁言'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('unmute') }, '解除禁言'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('kick') }, '踢人'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('requests') }, '查入群申请'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('approve') }, '通过申请'),
              h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => groupAction('decline') }, '拒绝申请'),
            ),
            groupNotice ? h('p', { className: 'cm-hint' }, groupNotice) : null,
            joinRequests.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  joinRequests.map((item, index) =>
                    h(
                      'li',
                      { key: (item.member_openid || '') + index, className: 'cm-qq-member' },
                      h('span', { className: 'cm-qq-name' }, String(item.member_openid || '').slice(0, 12) + '…'),
                      h('span', { className: 'cm-muted' }, String(item.apply_at || item.join_request_id || '').slice(0, 20)),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h(
              'div',
              { className: 'cm-app-card-head' },
              h('h3', null, '表情包库'),
              h(
                'div',
                { className: 'cm-actions' },
                h('span', { className: 'cm-muted' }, stickers.length + ' 张 · 收到图自动入库'),
                h(
                  'button',
                  { className: 'cm-btn cm-btn-small', type: 'button', onClick: toggleAutoSticker },
                  '自动丢表情包：' + (qqConfig && qqConfig.autoSticker && qqConfig.autoSticker.enabled ? '开' : '关'),
                ),
              ),
            ),
            stickers.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有收到过图片表情。QQ 里有人发图，会自动收进来。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  stickers.slice(0, 24).map((sticker) =>
                    h(
                      'li',
                      { key: sticker.id, className: 'cm-qq-member' },
                      h('span', { className: 'cm-qq-name' }, sticker.file.slice(0, 22)),
                      h('span', { className: 'cm-muted' }, Math.round((Number(sticker.bytes) || 0) / 1024) + ' KB · ' + (sticker.from || '未知来源')),
                      h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: () => sendSticker(sticker.id) }, '发一张'),
                      h('button', { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: async () => { try { const tagged = await apiPost('/qq/sticker/tag', { stickerId: sticker.id }); setScheduleNotice('已打标：' + ((tagged.tags || []).join('、') || tagged.caption || '无结果')) } catch (error) { setScheduleNotice('打标失败：' + error.message) } await loadQq() } }, '打标'),
                      h(
                        'button',
                        { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', disabled: stickerBusy === sticker.id, onClick: () => deleteSticker(sticker.id) },
                        stickerBusy === sticker.id ? '…' : '删除',
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card' },
            h(
              'div',
              { className: 'cm-app-card-head' },
              h('h3', null, '定时消息'),
              h('span', { className: 'cm-muted' }, schedules.length + ' 条 · 每天按点发'),
            ),
            h(
              'div',
              { className: 'cm-qq-form' },
              h('input', { className: 'cm-input', type: 'text', placeholder: '09:30', value: scheduleDraft.time, onChange: (event) => setScheduleDraft({ ...scheduleDraft, time: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '到点要发的内容', value: scheduleDraft.content, onChange: (event) => setScheduleDraft({ ...scheduleDraft, content: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '发给谁（群/人 openid，留空=最近聊天的会话）', value: scheduleDraft.targetId, onChange: (event) => setScheduleDraft({ ...scheduleDraft, targetId: event.target.value }) }),
              h('input', { className: 'cm-input', type: 'text', placeholder: '星期几（1-7，逗号分隔，空=每天）', value: scheduleDraft.weekdays, onChange: (event) => setScheduleDraft({ ...scheduleDraft, weekdays: event.target.value }) }),
              h('button', { className: 'cm-btn cm-btn-primary cm-btn-small', type: 'button', onClick: addSchedule }, '添加'),
            ),
            scheduleNotice ? h('p', { className: 'cm-hint' }, scheduleNotice) : null,
            schedules.length === 0
              ? h('p', { className: 'cm-muted' }, '还没有定时消息。')
              : h(
                  'ul',
                  { className: 'cm-qq-members' },
                  schedules.map((item) =>
                    h(
                      'li',
                      { key: item.id, className: 'cm-qq-member' },
                      h('span', { className: 'cm-qq-name' }, item.time),
                      h('span', { className: 'cm-person-memory-text' }, String(item.content || '').slice(0, 60)),
                      h('span', { className: 'cm-muted' }, (item.scope === 'group' ? '群 ' : '私聊 ') + String(item.targetId || '').slice(0, 10)),
                      h(
                        'button',
                        { className: 'cm-btn cm-btn-small cm-btn-ghost', type: 'button', onClick: () => deleteSchedule(item.id) },
                        '删除',
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'cm-app-card cm-app-credits' },
            h('h3', null, '声明 / 参考'),
            h('p', { className: 'cm-hint' }, '参考项目：dsh-qqbot（作者 zaofan，MIT 许可）· https://github.com/zaofan/dsh-qqbot'),
            h('p', { className: 'cm-hint' }, '本应用是 AI记忆 自带实现：界面与交互参考上述项目，群成员识别 / 好感度 / 记忆已替换为 AI记忆 自己的实现；安装本插件即可使用，不需要另装 dsh-qqbot。'),
          ),
        ),
      )
    }

    /** 打开内置应用：目前只有 qqbot 一个。 */
    function BuiltinAppView(props) {
      const { appId, onBack } = props
      if (appId === 'qqbot') return h(QqbotBuiltinApp, { onBack })
      return h(
        'div',
        { className: 'cm-app' },
        h('div', { className: 'cm-app-head' }, h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: onBack }, '← 返回'), h('div', { className: 'cm-app-title' }, h('h2', null, '自带应用'))),
        h('div', { className: 'cm-app-body' }, h('p', { className: 'cm-muted' }, '这个自带应用还没有界面。')),
      )
    }

    function IntegrationCard(props) {
      const item = props.item
      const homepage = integrationHomepage(item)
      return h(
        'article',
        { className: 'cm-int-card' },
        h(
          'div',
          { className: 'cm-int-card-head' },
          h('h3', { className: 'cm-int-card-name' }, item.name),
          h(
            'span',
            { className: 'cm-int-card-ver' },
            (item.builtin ? '自带 · ' : '') + (item.version ? 'v' + item.version : ''),
          ),
        ),
        h(
          'div',
          { className: 'cm-int-tags' },
          item.category ? h('span', { className: 'cm-int-tag cm-int-tag-strong' }, item.category) : null,
          (Array.isArray(item.tags) ? item.tags : []).map((tag) =>
            h('span', { key: 'tag-' + tag, className: 'cm-int-tag' }, tag),
          ),
        ),
        h('p', { className: 'cm-int-card-desc' }, item.description || '这份清单还没写说明。'),
        item.hint ? h('p', { className: 'cm-hint cm-hint-tight' }, item.hint) : null,
        h(
          'div',
          { className: 'cm-int-card-foot' },
          h('span', { className: 'cm-muted' }, item.author ? '作者 ' + item.author : ''),
          item.openable
            ? h(
                'button',
                { className: 'cm-btn cm-btn-small cm-btn-primary cm-int-open', type: 'button', onClick: () => props.onOpen && props.onOpen(item.app) },
                '打开',
              )
            : null,
          homepage
            ? h(
                'a',
                { className: 'cm-int-link', href: homepage, target: '_blank', rel: 'noreferrer noopener' },
                '主页 ↗',
              )
            : null,
        ),
      )
    }

    /** 「接入软件」页：搜索 + 清单卡片 + 怎么接入。 */
    function IntegrationTab(props) {
      const notify = props && typeof props.notify === 'function' ? props.notify : () => {}
      const [query, setQuery] = useState('')
      const [payload, setPayload] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [guideOpen, setGuideOpen] = useState(false)
      // 点开「自带应用」后整页切到应用界面（不离开面板）
      const [openApp, setOpenApp] = useState('')

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(API_BASE + '/integrations', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          setPayload(await unwrap(response))
          setError('')
        } catch (caught) {
          const message = String(caught && caught.message ? caught.message : caught)
          setError(
            /unknown route|HTTP 404/i.test(message)
              ? '清单接口还没生效——重载一次 AI记忆 插件（或重启 DSH）后就能读到目录。'
              : message,
          )
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const makeExample = useCallback(async () => {
        setBusy(true)
        try {
          const created = await apiPost('/integrations/example', {})
          await load()
          notify('已生成示例清单：' + ((created && created.file) || 'example.json'))
        } catch (caught) {
          notify('生成示例失败：' + caught.message, true)
        } finally {
          setBusy(false)
        }
      }, [load, notify])

      const items = payload && Array.isArray(payload.items) ? payload.items : []
      // 本应用自带的接入（内置清单，不需要 integrations 目录）
      const builtinItems = payload && Array.isArray(payload.builtin) ? payload.builtin : []
      const dir = payload && typeof payload.dir === 'string' ? payload.dir : ''
      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const match = (item) => {
        if (tokens.length === 0) return true
        const haystack = integrationHaystack(item)
        return tokens.every((token) => haystack.includes(token))
      }
      const filteredBuiltin = builtinItems.filter(match)
      const filtered = items.filter(match)

      const metaText =
        tokens.length > 0
          ? '自带 ' + filteredBuiltin.length + ' 个 · 外部 ' + filtered.length + ' 个（共匹配 ' + (filteredBuiltin.length + filtered.length) + ' 个）'
          : '自带 ' + builtinItems.length + ' 个 · 外部已接入 ' + items.length + ' 个'

      if (openApp !== '') {
        return h(BuiltinAppView, { appId: openApp, onBack: () => setOpenApp('') })
      }

      return h(
        'div',
        { className: 'cm-tab-body' },
        h(
          'div',
          { className: 'cm-int-topline' },
          h('span', { className: 'cm-int-topline-hint' }, '想让自己的软件也出现在这里？'),
          h(
            'a',
            {
              className: 'cm-int-submit',
              href: INTEGRATION_SUBMIT_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            },
            '申请收录软件 ↗',
          ),
        ),
        h(
          'div',
          { className: 'cm-int-toolbar' },
          h(
            'div',
            { className: 'cm-search-field' },
            h('span', { className: 'cm-search-icon' }, '🔍'),
            h('input', {
              className: 'cm-search-input',
              type: 'text',
              value: query,
              placeholder: '搜索软件、通道或能力，例如：QQ、记忆…',
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== ''
              ? h(
                  'button',
                  { className: 'cm-search-clear', type: 'button', title: '清除搜索', onClick: () => setQuery('') },
                  '×',
                )
              : null,
          ),
          h('button', { className: 'cm-btn cm-btn-small', type: 'button', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'),
        ),
        h('p', { className: 'cm-int-meta' }, metaText),
        error ? h('div', { className: 'cm-banner cm-banner-error' }, '读取清单失败：' + error) : null,
        filteredBuiltin.length > 0
          ? h(
              'div',
              { className: 'cm-int-section' },
              h(
                'div',
                { className: 'cm-int-section-head' },
                h('h3', null, '本应用自带'),
                h('span', { className: 'cm-muted' }, '跟着插件走，不用安装、不用放清单'),
              ),
              h(
                'div',
                { className: 'cm-int-grid' },
                filteredBuiltin.map((item) => h(IntegrationCard, { key: item.id, item, onOpen: setOpenApp })),
              ),
            )
          : null,
        filtered.length > 0
          ? h(
              'div',
              { className: 'cm-int-section' },
              h(
                'div',
                { className: 'cm-int-section-head' },
                h('h3', null, '外部软件'),
                h('span', { className: 'cm-muted' }, '放在 integrations 目录里的清单'),
              ),
              h(
                'div',
                { className: 'cm-int-grid' },
                filtered.map((item) => h(IntegrationCard, { key: item.id, item })),
              ),
            )
          : null,
        filteredBuiltin.length + filtered.length === 0
          ? h(
              'div',
              { className: 'cm-empty cm-int-empty' },
              h(
                'div',
                { className: 'cm-int-empty-title' },
                tokens.length > 0 ? '没有找到「' + query.trim() + '」' : '还没有接入外部软件',
              ),
              h(
                'p',
                null,
                tokens.length > 0
                  ? '换个关键词试试，或者清空搜索看全部。'
                  : '自带接入是跟着插件走的；外部软件把一个清单 JSON 放进下面这个目录，点「刷新」就会出现在这里。',
              ),
              dir ? h('code', { className: 'cm-int-path' }, dir) : null,
              tokens.length === 0
                ? h(
                    'div',
                    { className: 'cm-int-empty-actions' },
                    h('button', { className: 'cm-btn cm-btn-small', type: 'button', disabled: busy, onClick: makeExample }, '生成示例清单'),
                  )
                : null,
            )
          : null,
        h(
          'section',
          { className: 'cm-int-guide' },
          h(
            'button',
            { className: 'cm-int-guide-toggle', type: 'button', onClick: () => setGuideOpen((open) => !open) },
            (guideOpen ? '▾' : '▸') + ' 怎么把一个软件接进来？',
          ),
          guideOpen
            ? h(
                'div',
                { className: 'cm-int-guide-body' },
                h(
                  'ol',
                  null,
                  h('li', null, '在上面那个目录里新建一个 <id>.json 清单（也可以点「生成示例清单」照着改）。'),
                  h('li', null, '至少写 id 和 name；description / version / author / category / tags / homepage 都是可选的，写得越清楚，搜索越好找。'),
                  h('li', null, '回面板点「刷新」，卡片就出现在上面了。'),
                ),
                h(
                  'p',
                  null,
                  '清单只是一份描述，不会执行任何代码。真要让软件动起来（比如 QQ 消息进 AI记忆），由那个软件自己提供桥接或独立插件；这个页只负责把它们列出来、告诉别人有哪些能接。',
                ),
                h('pre', { className: 'cm-pre' }, JSON.stringify(SAMPLE_INTEGRATION, null, 2)),
              )
            : null,
        ),
      )
    }
    // ── panel ──────────────────────────────────────────────────────────────

    const TABS = [
      { id: 'config', label: '配置' },
      { id: 'emotion', label: '情绪' },
      { id: 'memory', label: '记忆' },
      { id: 'knowledge', label: '知识库' },
      { id: 'backup', label: '备份' },
      { id: 'status', label: '状态' },
      { id: 'overview', label: '总览' },
      { id: 'integration', label: '接入软件' },
    ]

    /** 保存 client 侧 ctx，用来调用宿主的 uiWorkspace.openSession 把新对话直接打开。 */
    let hostCtx = null

    /**
     * 顶部栏「伴侣记忆」视图（conversation.view 槽位）：
     * 跟随当前对话，只读速览这个对话的情绪表 / 好感度 / 活跃记忆。
     * 所有请求都显式带 session 参数，避免和侧边栏面板的 activeSession 互相干扰。
     */
    function CompanionConversationView(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      const request = useCallback(async (path, init) => {
        const glue = path.includes('?') ? '&' : '?'
        const url = sessionId === ''
          ? `${API_BASE}${path}`
          : `${API_BASE}${path}${glue}session=${encodeURIComponent(sessionId)}`
        const response = await fetch(url, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          ...(init || {}),
        })
        return unwrap(response)
      }, [sessionId])

      const load = useCallback(async () => {
        if (sessionId === '') { setSnapshot({ enabled: false, sessionId: null }); setError(''); return }
        try {
          const value = await request('/state')
          setSnapshot(value)
          setError('')
        } catch (caught) {
          setError(caught.message)
        }
      }, [request, sessionId])

      useEffect(() => {
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const enable = useCallback(async () => {
        setBusy(true)
        try {
          await request('/enable', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ enabled: true }),
          })
          setNotice('已开启本对话的伴侣记忆')
          await load()
        } catch (caught) {
          setNotice(`开启失败：${caught.message}`)
        } finally {
          setBusy(false)
        }
      }, [request, load])

      if (error !== '') {
        return h('div', { className: 'cm-root' }, h('div', { className: 'cm-banner cm-banner-error' }, `伴侣记忆连接失败：${error}`))
      }
      if (!snapshot) {
        return h('div', { className: 'cm-root' }, h('div', { className: 'cm-empty' }, '加载伴侣记忆…'))
      }
      if (snapshot.enabled !== true) {
        return h(
          'div',
          { className: 'cm-root' },
          h(
            'div',
            { className: 'cm-guide' },
            h('h2', null, '这个对话还没有开启伴侣记忆'),
            h('p', null, '开启后，这个对话会有独立的情绪表、好感度、记忆与知识库；其他对话各自独立、互不影响。'),
            h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: enable, disabled: busy }, busy ? '开启中…' : '开启本对话'),
            notice ? h('p', { className: 'cm-muted' }, notice) : null,
          ),
        )
      }

      const memories = (snapshot.memories && snapshot.memories.active) || []
      const speakers = snapshot.speakers || []
      const currentSpeaker = speakers.find((item) => item.isCurrent) || speakers[0] || null
      return h(
        'div',
        { className: 'cm-root' },
        h(
          'div',
          { className: 'cm-body' },
          h(
            'div',
            { className: 'cm-tab-body' },
            h('div', { className: 'cm-intro' }, '这里是当前对话的伴侣记忆速览（只读）；点下面的按钮可以跳到左侧栏面板里调整。'),
            h(
              'div',
              { className: 'cm-actions' },
              h('button', { className: 'cm-btn cm-btn-primary', type: 'button', onClick: () => openCompanionPanel('emotion', sessionId) }, '去调整情绪'),
              h('button', { className: 'cm-btn', type: 'button', onClick: () => openCompanionPanel('memory', sessionId) }, '去调整记忆'),
              h('button', { className: 'cm-btn', type: 'button', onClick: () => openCompanionPanel('config', sessionId) }, '打开完整面板'),
            ),
            h(EmotionCard, { snapshot, refresh: load, notify: (message) => setNotice(message), editable: false }),
            h(
              'section',
              { className: 'cm-card' },
              h('div', { className: 'cm-card-head' }, h('h3', null, '好感度与关系'), h('span', { className: 'cm-muted' }, '对当前说话人')),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 24, fontWeight: 700, color: favourTone(snapshot.favorability || 0) } }, signed(snapshot.favorability || 0)),
                h('span', { className: 'cm-muted' }, `羁绊 ${signed(Number(currentSpeaker && currentSpeaker.bond) || 0)}`),
                currentSpeaker && currentSpeaker.vectorText ? h('span', { className: 'cm-muted' }, currentSpeaker.vectorText) : null,
              ),
            ),
            h(
              'section',
              { className: 'cm-card' },
              h('div', { className: 'cm-card-head' }, h('h3', null, `活跃记忆（${memories.length}）`), h('span', { className: 'cm-muted' }, '按权重排序')),
              memories.length === 0
                ? h('p', { className: 'cm-muted' }, '这个对话还没有活跃记忆。')
                : h(
                  'div',
                  { className: 'cm-memory-list' },
                  memories.slice(0, 12).map((memory) => h(
                    'div',
                    { key: memory.id, className: 'cm-memory' },
                    h('div', { className: 'cm-memory-text' }, memory.text),
                    h(
                      'div',
                      { className: 'cm-memory-meta' },
                      h('span', null, memory.createdAtLocal || memory.createdDay || ''),
                      h('span', null, `权重 ${Number(memory.weight) || 50}`),
                      memory.vectorText ? h('span', { className: 'cm-tag' }, memory.vectorText) : null,
                    ),
                  )),
                ),
              memories.length > 12 ? h('p', { className: 'cm-muted' }, `还有 ${memories.length - 12} 条…`) : null,
            ),
            notice ? h('div', { className: 'cm-banner' }, notice) : null,
          ),
        ),
      )
    }

    function CompanionPanel() {
      const [snapshot, setSnapshot] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [sessionId, setSessionId] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [tab, setTab] = useState(pendingPanelTab || 'config')
      const [pickerOpen, setPickerOpen] = useState(false)
      const [collapsedGroups, setCollapsedGroups] = useState({})
      const [creating, setCreating] = useState('')
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
          // 从顶部视图跳过来时会带一个明确的目标对话，优先用它。
          const forced = pendingPanelSession
          pendingPanelSession = ''
          let target = forced || sessionRef.current
          if (!forced && target && !known.has(target)) target = ''
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
        const handler = (event) => {
          const detail = event && event.detail
          const nextTab = typeof detail === 'string' ? detail : detail && detail.tab
          const nextSession = detail && typeof detail === 'object' ? detail.sessionId : ''
          if (typeof nextTab === 'string' && nextTab !== '') setTab(nextTab)
          if (typeof nextSession === 'string' && nextSession !== '') {
            sessionRef.current = nextSession
            setSessionId(nextSession)
            loadState(nextSession).catch(() => {})
          }
        }
        window.addEventListener('companion-memory:set-tab', handler)
        return () => window.removeEventListener('companion-memory:set-tab', handler)
      }, [loadState])

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

      /**
       * 在某个工作区里新建对话并直接切过去。
       *
       * 优先走宿主自己的链路（client 服务 uiWorkspace.connectWorkspace + openSession）：
       * 宿主会把新对话挂进工作区、并把它设为「当前空白对话」，侧边栏才会显示并打开它。
       * 直接调后台接口建出来的空会话，宿主界面不会认（空白会话只有在「当前」时才显示）。
       */
      const createSessionInGroup = useCallback(async (group) => {
        const key = String((group && group.key) || '__default__')
        setCreating(key)
        try {
          setActiveSession('')
          const uiWorkspace = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('uiWorkspace') : null
          const workspaceId = group && group.workspaceId ? String(group.workspaceId) : ''
          let newId = ''
          if (uiWorkspace && workspaceId && typeof uiWorkspace.connectWorkspace === 'function') {
            newId = String((await uiWorkspace.connectWorkspace(workspaceId)) || '')
            if (newId && typeof uiWorkspace.openSession === 'function') {
              try {
                uiWorkspace.openSession(newId)
              } catch (openError) {
                // 打不开也不影响创建本身
              }
            }
            if (newId) {
              try {
                await apiPost('/enable', { session: newId, enabled: true })
              } catch (enableError) {
                // 开启失败不影响会话本身，用户可手动开启
              }
              // 自动发一句「你好」：空白会话有消息后才会真正留在工作区列表里
              try {
                await apiPost('/session/say', { session: newId, text: '你好' })
              } catch (sayError) {
                // 发送失败不影响创建
              }
            }
          } else {
            const result = await apiPost('/session/new', { cwd: (group && group.cwd) || '' })
            newId = result && result.sessionId ? String(result.sessionId) : ''
            if (newId && uiWorkspace && typeof uiWorkspace.openSession === 'function') {
              try {
                uiWorkspace.openSession(newId)
              } catch (openError) {
                // ignore
              }
            }
            if (newId) {
              try {
                await apiPost('/session/say', { session: newId, text: '你好' })
              } catch (sayError) {
                // ignore
              }
            }
          }
          notify(newId ? `已新建对话（${(group && group.label) || '当前工作区'}），已开启伴侣记忆并发送「你好」，可以直接导入` : '已新建对话')
          setPickerOpen(false)
          const list = await apiGet('/sessions')
          if (aliveRef.current) setSessions(list)
          if (newId) await switchSession(newId)
        } catch (caught) {
          notify(`新建对话失败：${caught.message}`, true)
        } finally {
          if (aliveRef.current) setCreating('')
        }
      }, [notify, switchSession])

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
      const currentWorkspace = (currentItem && currentItem.workspace) || ''
      const groups = sessions && Array.isArray(sessions.groups) && sessions.groups.length > 0
        ? sessions.groups
        : items.length > 0
          ? [{ key: '__default__', label: '对话', cwd: null, sessions: items }]
          : []
      const enabled = Boolean(snapshot && snapshot.enabled === true)

      let body = h('div', { className: 'cm-empty' }, '加载中…')
      // 「接入软件」页：内容先留空，且不依赖本对话是否开启记忆。
      if (tab === 'integration') {
        body = h(IntegrationTab, { notify })
      } else if (error && !snapshot) {
        body = h('div', { className: 'cm-empty' }, `无法连接 Host：${error}`)
      } else if (!enabled) {
        body = h(
          'div',
          { className: 'cm-guide' },
          h('h2', null, '这个对话还没有开启伴侣记忆'),
          h('p', null, '开启后，三份人格文档、好感度、全局活跃记忆、最近两个聊天日上下文与知识库都只属于「' + currentTitle + '」，其他对话各自独立、互不干扰。'),
          h('p', null, '新对话默认是关闭的；你可以在上面的下拉框里切换到别的对话，也可以随时关闭本对话（数据会保留，不会删除）。'),
        )
      } else if (tab === 'config') {
        body = h(ConfigTab, { snapshot, refresh, notify })
      } else if (tab === 'emotion') {
        body = h(EmotionTab, { snapshot, refresh, notify })
      } else if (tab === 'memory') {
        body = h(MemoryTab, { snapshot, refresh, notify })
      } else if (tab === 'knowledge') {
        body = h(KnowledgeTab, { snapshot, notify })
      } else if (tab === 'backup') {
        body = h(BackupTab, { snapshot, notify })
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
            h('div', null, h('h1', { className: 'cm-title' }, 'AI记忆'), h('p', { className: 'cm-sub' }, '每个对话独立：配置 · 好感度 · 记忆 · 知识库')),
            h('button', { className: 'cm-btn cm-btn-small', type: 'button', onClick: refresh }, '刷新'),
          ),
          enabled && snapshot ? h(StatusBar, { snapshot }) : null,
          // 页签条常驻：本对话没开启记忆时也能点「接入软件」。
          h(
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
          ),
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
              currentWorkspace ? h('span', { className: 'cm-session-workspace', title: currentWorkspace }, `工作区：${currentWorkspace}`) : null,
              h('span', { className: `cm-badge${enabled ? ' cm-badge-on' : ''}` }, enabled ? '已开启' : '未开启'),
            ),
            h(
              'div',
              { className: 'cm-picker' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'cm-btn cm-btn-small',
                  disabled: groups.length === 0,
                  onClick: () => setPickerOpen((open) => !open),
                },
                pickerOpen ? '收起对话列表' : '切换对话',
              ),
              pickerOpen ? h('div', { className: 'cm-picker-backdrop', onClick: () => setPickerOpen(false) }) : null,
              pickerOpen
                ? h(
                    'div',
                    { className: 'cm-picker-menu' },
                    ...groups.map((group) => {
                      const hide = collapsedGroups[group.key] === true
                      return h(
                        'div',
                        { className: 'cm-picker-group', key: group.key || '__default__' },
                        h(
                          'div',
                          {
                            className: 'cm-picker-group-head',
                            role: 'button',
                            tabIndex: 0,
                            onClick: () => setCollapsedGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] })),
                          },
                          h('span', { className: 'cm-picker-caret' }, hide ? '▸' : '▾'),
                          h('span', { className: 'cm-picker-group-name', title: group.cwd || '' }, group.label),
                          h('span', { className: 'cm-picker-group-count' }, `${group.sessions.length}`),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'cm-btn cm-btn-small cm-btn-ghost cm-picker-new',
                              title: `在「${group.label}」里新建一个对话（会自动开启伴侣记忆，可直接导入）`,
                              disabled: creating !== '',
                              onClick: (event) => {
                                event.stopPropagation()
                                createSessionInGroup(group)
                              },
                            },
                            creating === group.key ? '创建中…' : '＋ 新建对话',
                          ),
                        ),
                        hide
                          ? null
                          : group.sessions.map((item) =>
                              h(
                                'button',
                                {
                                  key: item.id,
                                  type: 'button',
                                  className: `cm-picker-session${item.id === sessionId ? ' cm-picker-session-active' : ''}`,
                                  title: item.id,
                                  onClick: () => {
                                    setPickerOpen(false)
                                    if (item.id !== sessionId) switchSession(item.id)
                                  },
                                },
                                h('span', { className: 'cm-picker-dot' }, item.enabled ? '●' : '○'),
                                h('span', { className: 'cm-picker-session-name' }, item.title || `对话 ${item.id.slice(0, 8)}`),
                                item.live ? h('span', { className: 'cm-badge' }, '进行中') : null,
                              ),
                            ),
                      )
                    }),
                  )
                : null,
            ),
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
        // 底部 Star 入口：只放一个可见链接，用户自己点，不做任何自动行为。
        h(
          'div',
          { className: 'cm-footer' },
          h('span', { className: 'cm-muted' }, '觉得好用的话，可以去'),
          h(
            'a',
            {
              className: 'cm-footer-link',
              href: REPO_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            },
            'GitHub 点个 Star ⭐',
          ),
          h('span', { className: 'cm-muted' }, '支持一下。'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
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
                  label: () => 'AI记忆',
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

        // 顶部栏「会话视图」标签：和 对话轨迹 并排。跟随当前对话，只读速览。
        ctx.effect(() => {
          try {
            return ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: PLUGIN_ID,
                  order: 40,
                  label: () => 'AI记忆',
                },
                CompanionConversationView,
              ),
            )
          } catch (error) {
            try { console.warn('[companion-memory] conversation view registration failed', error) } catch {}
            return () => {}
          }
        }, 'companion-memory: conversation view')
      },
    }
  },
})
