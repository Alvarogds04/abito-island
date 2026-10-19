'use strict';
/* #489 — the island cards of the integration pills (n8n, Vercel; more services follow), as Coucou's views/integrations.ts.
   Adapted from Coucou windows/src/views/integrations.ts @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Own DOM builders
   (textContent only), Spanish copy, Coucou's .int-* classes (island-integrations.css).

   Wire (src/integrationshost.rs, island window ONLY):
     invoke('integration_action', {payload:{action:'view'}})                      -> {updates:{<pillId>:Update}}
     invoke('integration_action', {payload:{action:'refresh', id:'integration_n8n'}})
     event 'integration:update' -> Update {id, data, error, event:{success,label,detail}|null}
   The host polls only declared pills with a saved key, so no update means «not set up / nothing yet».
   The card shows while a pill is focused: document event 'abito:integration-focus' {detail:{id}} (null clears).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIntegrationCard = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const IDS = Object.freeze(['integration_n8n', 'integration_vercel']);
  const GREEN = '#22C55E', RED = '#F4505E';
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clean = (v, max = 200) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('') : '');
  const text = (v, max = 2000) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')].slice(0, max).join('') : '');

  /** «hace 3 min» as Coucou's timeAgo. */
  function timeAgo(value, now = Date.now()) {
    const at = typeof value === 'number' ? value : Date.parse(String(value));
    const diff = (now - at) / 1000;
    if (!Number.isFinite(diff)) return '';
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    return Math.floor(diff / 86400) + ' d';
  }

  /** Only a vercel.app deployment host leaves the page (the host re-validates again). */
  function vercelUrl(host) {
    if (typeof host !== 'string' || !host || host.length > 300 || /[\s\u0000-\u001f\u007f/@:?#\\]/.test(host)) return null;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(host) ? 'https://' + host.toLowerCase() : null;
  }

  /** An Update (possibly absent) → the closed view the renderer draws. Never a guess: off-shape is «sin datos». */
  function view(id, update, now = Date.now()) {
    const base = { id, kind: 'idle', error: '', status: 'Sin datos todavía', name: id === 'integration_n8n' ? 'n8n' : 'Vercel' };
    if (!IDS.includes(id) || !isObject(update) || update.id !== id) return base;
    if (typeof update.error === 'string' && update.error) return { ...base, kind: 'error', error: clean(update.error), status: clean(update.error) };
    const data = isObject(update.data) ? update.data : {};
    if (id === 'integration_vercel') {
      const rows = (Array.isArray(data.deployments) ? data.deployments : []).filter(isObject).slice(0, 3).map(d => ({
        project: clean(d.projectName, 80), state: clean(d.state, 12), ok: d.state === 'READY',
        ago: timeAgo(d.createdAt, now), commit: clean(d.commitMessage, 200), branch: clean(d.branch, 80), url: vercelUrl(d.url),
      }));
      return rows.length ? { ...base, kind: 'list', rows } : base;
    }
    const ev = isObject(update.event) ? update.event : null;
    if (!ev && typeof data.workflow !== 'string') return base;
    return {
      ...base, kind: 'workflow', ok: ev ? ev.success === true : data.status === 'success',
      workflow: clean(ev ? ev.label : data.workflow, 120) || 'Workflow', detail: ev ? text(ev.detail) : '',
    };
  }
  const STATE_LABEL = Object.freeze({ READY: 'Listo', CANCELED: 'Cancelado', ERROR: 'Error' });
  return { IDS, GREEN, RED, view, timeAgo, vercelUrl, STATE_LABEL, clean };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsule = doc.getElementById('capsule');
  const overview = doc.getElementById('overview-view');
  const leftCard = overview && overview.querySelector('.card-left');
  if (!capsule || !leftCard) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke || label === 'settings') return;

  const host = doc.createElement('div'); host.className = 'int-host'; host.hidden = true; leftCard.append(host);
  let focus = null, detail = false; const updates = {};
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices' && !doc.hidden;
  };
  const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt) n.textContent = txt; return n; };
  const dot = color => { const n = el('i', 'dot'); n.style.background = color; return n; };
  const head = (color, name, kind) => { const h = el('div', 'int-head'); h.append(dot(color), el('b', '', name), el('span', '', kind)); return h; };
  const back = () => { const b = el('button', 'int-back', '‹'); b.type = 'button'; b.setAttribute('aria-label', 'Volver'); b.addEventListener('click', e => { if (e.isTrusted === true) { detail = false; draw(); } }); return b; };
  const more = () => { const b = el('button', 'int-more', '…'); b.type = 'button'; b.title = 'Detalles'; b.addEventListener('click', e => { if (e.isTrusted === true) { detail = true; draw(); } }); return b; };
  const badge = (ok, txt) => { const c = ok ? api.GREEN : api.RED; const b = el('span', 'int-badge', txt); b.style.color = c; b.style.background = c + '24'; return b; };
  const open = url => { if (url) invoke('open_chat_url', { payload: { url } }).catch(() => {}); };

  function card(v) {
    const c = el('div', 'int-card');
    if (v.id === 'integration_vercel') {
      c.append(head('#7C5CFF', 'Vercel', 'Despliegues'));
      if (v.kind !== 'list') { c.append(statusLine(v)); return c; }
      const rows = el('div', 'int-rows');
      v.rows.forEach((r, i) => {
        const row = el('div', i === 0 ? 'int-row first' : 'int-row');
        row.append(dot(r.ok ? api.GREEN : api.RED), el('span', 'int-name', r.project), el('span', 'int-ago', r.ago));
        if (i === 0) row.append(more());
        rows.append(row);
      });
      c.append(rows); return c;
    }
    c.append(head('#F29B38', 'n8n', 'Workflow'));
    if (v.kind !== 'workflow') { c.append(statusLine(v)); return c; }
    const pill = el('button', 'int-pill'); pill.type = 'button';
    const color = v.ok ? api.GREEN : api.RED;
    pill.style.background = color + '1a'; pill.style.borderColor = color + '38';
    pill.append(dot(color), el('span', 'int-name', v.workflow), el('span', '', '…'));
    pill.addEventListener('click', e => { if (e.isTrusted === true) { detail = true; draw(); } });
    const actions = el('div', 'int-actions'); actions.append(pill); c.append(actions); return c;
  }
  function statusLine(v) {
    const s = el('div', 'int-status'); s.append(dot(v.kind === 'error' ? api.RED : '#6B7079'), el('span', '', v.status)); return s;
  }
  function detailCard(v) {
    const c = el('div', 'int-card detail'), h = el('div', 'int-detail-head');
    if (v.id === 'integration_vercel') {
      const d = v.rows[0];
      h.append(back(), dot(d.ok ? api.GREEN : api.RED), el('b', '', d.project), badge(d.ok, api.STATE_LABEL[d.state] || 'Error'));
      const body = el('div', 'int-detail-body');
      if (d.commit) body.append(el('div', 'int-commit', d.commit));
      const meta = el('div', 'int-meta'); if (d.branch) meta.append(el('span', '', d.branch)); meta.append(el('span', '', 'hace ' + d.ago)); body.append(meta);
      if (d.url) { const l = el('button', 'int-link', d.url.slice(8)); l.type = 'button'; l.addEventListener('click', e => { if (e.isTrusted === true) open(d.url); }); body.append(l); }
      c.append(h, body); return c;
    }
    h.append(back(), dot(v.ok ? api.GREEN : api.RED), el('b', '', v.workflow), badge(v.ok, v.ok ? 'Éxito' : 'Falló'));
    c.append(h, v.detail ? el('pre', 'int-detail-text', v.detail) : el('div', 'int-status', v.ok ? 'Completado correctamente.' : 'No hay detalles del error.'));
    return c;
  }
  function draw() {
    const show = api.IDS.includes(focus) && onScreen();
    host.hidden = !show;
    if (show) overview.dataset.integration = 'on'; else delete overview.dataset.integration;
    if (!show) { detail = false; return; }
    const v = api.view(focus, updates[focus]);
    const hasDetail = (v.kind === 'list') || (v.kind === 'workflow');
    host.replaceChildren(detail && hasDetail ? detailCard(v) : card(v));
  }
  const announce = () => doc.dispatchEvent(new CustomEvent('abito:integration-seen', { detail: { ids: Object.keys(updates) } }));
  const setUpdate = u => {
    if (!u || typeof u.id !== 'string' || !api.IDS.includes(u.id)) return;
    updates[u.id] = u; announce(); draw();
    if (u.event && typeof u.event === 'object') doc.dispatchEvent(new CustomEvent('abito:integration-badge', { detail: { id: u.id } }));
  };
  doc.addEventListener('abito:integration-focus', e => {
    const id = e && e.detail && typeof e.detail.id === 'string' ? e.detail.id : null;
    if (id !== focus) detail = false; focus = id; draw();
    if (focus && onScreen()) invoke('integration_action', { payload: { action: 'refresh', id: focus } }).then(r => { for (const u of Object.values((r && r.updates) || {})) setUpdate(u); }, () => {});
  });
  if (listen) listen('integration:update', e => setUpdate(e && e.payload)).catch(() => {});
  invoke('integration_action', { payload: { action: 'view' } }).then(r => { for (const u of Object.values((r && r.updates) || {})) if (u && api.IDS.includes(u.id)) updates[u.id] = u; announce(); draw(); }, () => {});
  doc.addEventListener('visibilitychange', draw);
  if (typeof MutationObserver !== 'undefined') new MutationObserver(draw).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
}
