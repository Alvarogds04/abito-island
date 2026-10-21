'use strict';
/* #360 — the live agent sessions ticker, in ONE file (one script tag in
   index.html): the pure view-model (closed projection of the daemon's
   `sessions` frame) plus, browser-only, the self-mounting poll loop.
   Conditions from the card review:
   - renders nothing and takes ZERO layout space when there are no sessions;
   - theme tokens only (light and dark resolve them) — no raw colors here;
   - textContent only (every written node is built here);
   - poll floor 2 s (the daemon caches scans for 2 s anyway), paused while the
     page is hidden, at most one ask in flight;
   - Spanish copy (rioplatense voseo), placement PROVISIONAL (fixed bottom-left;
   the human judges it visually). Loaded as a classic script (window.AbitoSessionsTicker)
   and by test-node/sessions-ticker-view-check.cjs (pure API only, no DOM). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AbitoSessionsTicker = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-sessions/view/1';
  const MAX_ROWS = 64; // the daemon never sends more; the view re-checks anyway

  // ---- closed vocabularies (the daemon's, labeled in Spanish) ------------------
  const KIND_LABELS = Object.freeze({ pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' });
  const STATE_LABELS = Object.freeze({ running: 'ejecutando', sleeping: 'inactiva', stopped: 'detenida', zombie: 'zombi', unknown: 'desconocida' });

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  // No separator and no control character may reach a rendered row: the daemon
  // already enforces this, but the view never trusts what it is about to show.
  const cleanCell = v => {
    if (v === null) return null;
    if (typeof v !== 'string' || v === '' || v.includes('/') || v.includes('·') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(v)) return null;
    return v;
  };

  /** One normalized row, or null when anything is off-vocabulary (dropped, never repaired). */
  function rowOf(raw) {
    if (!isObject(raw)) return null;
    const id = typeof raw.id === 'string' && /^s-[0-9a-f]{8}$/.test(raw.id) ? raw.id : null;
    const kindLabel = KIND_LABELS[raw.kind];
    const stateLabel = STATE_LABELS[raw.state];
    if (!id || !kindLabel || !stateLabel) return null;
    const cwd = cleanCell(raw.cwd) ?? null;
    const origin = cleanCell(raw.origin) ?? null;
    // Plain text row: `Pi · mi-proyecto · inactiva · en herdr`. An unknown cwd is
    // an honest «—»; an unknown origin simply has no segment.
    const text = [kindLabel, cwd ?? '—', stateLabel].concat(origin ? [`en ${origin}`] : []).join(' · ');
    const row = { id, kindLabel, cwd, stateLabel, origin, text };
    const tools = raw.tools;
    if (isObject(tools) && (tools.epoch === undefined || (Number.isSafeInteger(tools.epoch) && tools.epoch >= 0)) && Number.isSafeInteger(tools.total) && tools.total >= 0 && tools.total <= 4096 && Array.isArray(tools.steps) && tools.steps.length === Math.min(20, tools.total) && tools.steps.every((s, i) => isObject(s) && s.index === tools.total - tools.steps.length + i + 1 && typeof s.name === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(s.name) && ['running', 'done', 'error'].includes(s.state))) {
      row.tools = { ...(tools.epoch === undefined ? {} : { epoch: tools.epoch }), total: tools.total, steps: tools.steps.map(s => ({ index: s.index, name: s.name, state: s.state })) };
    }
    return row;
  }

  /**
   * The `sessions` frame to a ready view. Anything that is not exactly our frame
   * (a foreign schema, malformed rows) returns null: the caller renders nothing.
   */
  function sessionsView(frame) {
    if (!isObject(frame) || frame.type !== 'sessions' || frame.schema !== SCHEMA) return null;
    if (typeof frame.truncated !== 'boolean' || !Array.isArray(frame.sessions)) return null;
    const rows = [];
    for (const raw of frame.sessions) {
      if (rows.length >= MAX_ROWS) break;
      const row = rowOf(raw);
      if (row) rows.push(row);
    }
    return { state: 'ready', rows, truncated: frame.truncated };
  }

  // Process identities stay separate from catalog identities: several projects
  // can share a source, and Pi is never relabeled as Claude Code.
  const SOURCES = { 'Claude Code': 'integration_claude', Codex: 'agent_codex', Gemini: 'agent_gemini', OpenCode: 'agent_opencode' };
  function sessionRows(view, prefs = {}) {
    return (view?.state === 'ready' ? view.rows : []).map(row => ({
      ...row, session: true, name: row.cwd ?? row.kindLabel, sourcePill: SOURCES[row.kindLabel] || null,
      color: prefs.pillColors?.[SOURCES[row.kindLabel]] || 'blue',
      pose: row.tools?.steps.some(s => s.state === 'running') ? 'working' : row.tools?.steps.at(-1)?.state === 'error' ? 'error' : 'idle',
    })).sort((a, b) => Number(b.sourcePill === prefs.mainPill) - Number(a.sourcePill === prefs.mainPill) || Number(!!b.tools?.total) - Number(!!a.tools?.total));
  }

  /** Copy for an over-cap frame, or null when the list was not cut. */
  function boundedText(view) {
    if (!view || view.state !== 'ready' || !view.truncated) return null;
    return 'Hay más sesiones';
  }

  /** Copy for an unavailable view (no daemon, old daemon, error). */
  function errorText() {
    return 'Sesiones no disponibles';
  }

  // agent_action sends asynchronously: its return value is a cached snapshot, not
  // the response to this scan. Open the lazy connection before sending and let
  // the next poll collect the answer. Null while connected means pending.
  async function requestSessions(invoke) {
    await invoke('agent_action', { payload: { action: 'view' } });
    const state = await invoke('agent_action', { payload: { action: 'sessions_list' } });
    const sessions = state && state.sessions;
    if (sessions && Array.isArray(sessions.rows)) {
      return sessionsView({ type: 'sessions', schema: SCHEMA, sessions: sessions.rows, truncated: sessions.truncated === true }) || { state: 'error' };
    }
    return { state: state && state.connection === 'connected' ? 'pending' : 'error' };
  }

  // ---- render (the only DOM work; textContent only, theme tokens only) ---------
  // Theme tokens: --ink (rows) and --muted (footer) resolve on light AND dark
  // (style.css redefines them under html[data-theme="light"]). No raw colors here.

  /** Renders the view into a container the caller owns. Rows: one text line each. */
  function render(container, view) {
    if (!container) return;
    const rows = view && view.state === 'ready' ? view.rows : [];
    container.textContent = '';
    if (!rows.length && !(view && view.state === 'ready' && view.truncated)) {
      container.style.display = 'none'; // no sessions: nothing rendered, zero layout space
      return;
    }
    container.style.display = '';
    for (const row of rows) {
      const line = document.createElement('div');
      line.textContent = row.text;
      line.style.color = 'var(--ink)';
      line.style.fontSize = '12px';
      line.style.lineHeight = '1.6';
      line.style.whiteSpace = 'nowrap';
      container.append(line);
    }
    const footer = view.state !== 'ready' ? errorText() : (view.truncated ? boundedText(view) : null);
    if (footer) {
      const line = document.createElement('div');
      line.textContent = footer;
      line.style.color = 'var(--muted)';
      line.style.fontSize = '12px';
      line.style.lineHeight = '1.6';
      line.style.whiteSpace = 'nowrap';
      container.append(line);
    }
  }

  // ---- the feed of Coucou's Ticker (S10) --------------------------------------------
  // Only the daemon's internal Pi has a tool stream. Other discovered agents
  // remain useful identities, but process metadata must never invent steps.
  const newMemory = () => ({ log: [], seq: 0, focus: null, selected: false });
  function focus(memory, view, id) {
    const row = view?.state === 'ready' && view.rows.find(r => r.id === id);
    if (!row) return null;
    memory.focus = row; memory.selected = true;
    return feed(memory, view);
  }
  function feed(memory, view) {
    if (view && view.state === 'pending') return { active: false, task: null, who: null };
    const previous = memory.log.join('\n');
    if (!view || view.state !== 'ready') {
      memory.log = [errorText()]; memory.focus = null;
    } else {
      const remembered = view.rows.find(r => r.id === memory.focus?.id);
      if (!remembered) memory.selected = false;
      memory.focus = (memory.selected && remembered) || view.rows.find(r => r.tools?.total > 0) || remembered || view.rows[0] || null;
      if (!view.rows.length) {
        memory.log = []; memory.seq = 0; memory.focus = null;
        return { active: false, task: null, who: null };
      }
      memory.log = ['Sin pasos de herramientas'];
      if (view.truncated) memory.log.push(boundedText(view));
    }
    // Ticker.sync uses a monotonic index, not text equality, to detect updates.
    // Advance on notice transitions too, without counting process metadata.
    if (memory.log.join('\n') !== previous) memory.seq += memory.log.length;
    const f = memory.focus;
    if (f?.tools?.total > 0) {
      const { total, steps } = f.tools;
      return { active: true, task: { steps: steps.map(s => s.name), stepSeq: total - 1, finalLine: steps.some(s => s.state === 'running') ? null : steps.at(-1).name }, who: { name: f.cwd ?? '—', tool: f.kindLabel, count: `${steps.at(-1).index}/${total}` } };
    }
    const steps = memory.log.slice();
    // Neither the availability notice nor the bounded-list notice is a tool.
    const who = f ? { name: f.cwd ?? '—', tool: f.kindLabel, count: '' } : null;
    // An unavailable/bounded notice is not live work: finalLine makes Coucou's Ticker hold it still (no shimmer).
    return { active: true, task: { steps, stepSeq: memory.seq - 1, finalLine: steps.at(-1) ?? null }, who };
  }

  return { SCHEMA, MAX_ROWS, sessionsView, boundedText, errorText, render, newMemory, feed, focus, sessionRows, requestSessions };
});

// ---- browser-only wiring: self-mounting poll through agent_action --------------

function mount(V) {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  if (!invoke) return;

  const POLL_MS = 2000; // the floor: never faster than the daemon's scan cache
  // Coucou's Ticker (vendor/coucou/views/ticker.js, MIT) inside the overview's left card. It is an ES module,
  // so it is loaded with a dynamic import; until it arrives (or if it cannot load) nothing is drawn.
  const overview = document.getElementById('overview-view');
  const leftCard = overview && overview.querySelector('.card-left');
  if (!leftCard) return;
  // Coucou's who-row (dot + name + tool + n/N) over the ticker, and its «Nothing running right now» card when idle.
  const mkEl = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const who = mkEl('div', 'who'); who.hidden = true;
  const whoName = mkEl('span', 'name'), whoTool = mkEl('span', 'tool'), whoCount = mkEl('span', 'count');
  who.append(mkEl('span', 'who-dot'), whoName, whoTool, whoCount);
  leftCard.append(who);
  let ticker = null, raf = 0, shownSession = null, lastView = null, prefs = {}, integrationFocused = false;
  const jump = mkEl('button', 'icon-btn jump', '↗'); jump.id = 'session-jump'; jump.type = 'button'; jump.hidden = true;
  leftCard.append(jump);
  who.style.paddingRight = '22px';
  Object.assign(jump.style, { position: 'absolute', top: '0px', right: '0px', width: '44px', height: '44px', minWidth: '44px', minHeight: '44px', border: '0', background: 'transparent', color: 'var(--muted)', fontSize: '10px', padding: '14px', cursor: 'pointer', pointerEvents: 'auto' });
  const canFocus = () => {
    const d = capsule?.dataset || {};
    return !document.hidden && ['compact', 'expanded'].includes(d.phase) && (d.phase === 'compact' || d.view === 'overview') && !d.card && d.settings !== 'open' && !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  };
  const selectSession = id => {
    if (!V.focus(memory, lastView, id)) return;
    document.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: null } }));
    document.dispatchEvent(new CustomEvent('abito:session-focused', { detail: { id } }));
    show(lastView);
  };
  jump.addEventListener('click', async event => {
    if (event.isTrusted !== true || !canFocus() || !memory.focus || jump.hidden || jump.disabled) return;
    jump.disabled = true;
    try { await invoke('focus_host', { payload: { target: 'terminal' } }); }
    catch { const live = document.getElementById('pill-live'); if (live) live.textContent = 'No se pudo abrir una terminal. La selección es por clase, no por sesión.'; }
    finally { jump.disabled = false; }
  });
  const memory = V.newMemory();
  const frame = now => { raf = 0; if (ticker) { ticker.tick(now); if (ticker.animating && !document.hidden) raf = requestAnimationFrame(frame); } };
  import('./vendor/coucou/views/ticker.js').then(mod => { ticker = new mod.Ticker(); ticker.el.hidden = true; leftCard.append(ticker.el); }).catch(() => {});

  // Coucou's collapsed bar draws up to four small characters (#mini-grid), one per running agent. Abito: one clay per running session.
  const grid = document.getElementById('mini-grid');
  let gridKey = '', minis = [];
  function paintMiniGrid(view) {
    if (!grid) return;
    grid.setAttribute('aria-hidden', 'false'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Sesiones activas');
    const rows = V.sessionRows(view, prefs).slice(0, 4);
    const key = rows.map(r => `${r.id}:${r.text}:${r.color}:${r.pose}:${r.id === memory.focus?.id}`).join('|');
    if (key === gridKey) return;
    gridKey = key;
    for (const m of minis) { try { m.destroy(); } catch { /* decoration */ } }
    const activeId = grid.contains(document.activeElement) ? document.activeElement?.dataset.sessionId : null;
    minis = []; grid.replaceChildren(); grid.dataset.count = String(rows.length);
    if (typeof AbitoClay === 'undefined') return;
    for (const r of rows) {
      const slot = document.createElement('button'); slot.className = 'mini'; slot.type = 'button'; slot.title = r.text;
      slot.dataset.sessionId = r.id;
      slot.setAttribute('aria-label', `Enfocar ${r.name}: ${r.kindLabel}`);
      slot.setAttribute('aria-pressed', String(r.id === memory.focus?.id));
      slot.style.border = '0'; slot.style.padding = '0'; slot.style.background = 'transparent'; slot.style.cursor = 'pointer'; slot.style.pointerEvents = 'auto';
      slot.addEventListener('pointerdown', event => { if (event.isTrusted === true && capsule.dataset.phase === 'compact' && canFocus()) selectSession(r.id); });
      slot.addEventListener('click', event => { if (event.isTrusted === true && canFocus()) selectSession(r.id); });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'island-agent-clay'); svg.dataset.color = r.color;
      const stops = window.AbitoAvatarColors?.gradientStops(r.color);
      for (let i = 0; i < 3; i++) svg.style.setProperty(`--chosen-${i + 1}`, stops?.[i] || '');
      slot.append(svg); grid.append(slot);
      if (r.id === activeId) slot.focus();
      try { minis.push(AbitoClay.create(svg, { state: r.pose, live: document.documentElement.dataset.motion !== 'reduce', viewBox: '36 32 128 128', shadow: false })); } catch { /* decoration */ }
    }
  }
  function show(view) {
    if (!ticker) return;
    lastView = view;
    const main = !memory.selected && V.sessionRows(view, prefs).find(r => r.sourcePill === prefs.mainPill);
    if (main) V.focus(memory, view, main.id);
    const { active, task, who: w } = V.feed(memory, view);
    const session = memory.focus ? `${memory.focus.id}:${!!memory.focus.tools?.total}:${memory.focus.tools?.epoch ?? 0}` : null;
    if (session !== shownSession) { ticker.sync(null); shownSession = session; }
    paintMiniGrid(view);
    ticker.el.hidden = !active;
    who.hidden = !active || !w;
    if (w) { whoName.textContent = w.name; whoTool.textContent = w.tool; whoCount.textContent = w.count; whoCount.hidden = !w.count; }
    if (active) overview.dataset.ticker = 'on'; else delete overview.dataset.ticker;
    ticker.sync(task);
    ticker.el.title = task?.steps?.at(-1) ?? ''; // full text fallback when a long step is cut
    if (!raf && ticker.animating) raf = requestAnimationFrame(frame);
    jump.hidden = !memory.focus || integrationFocused;
    jump.setAttribute('aria-label', `Abrir una terminal por clase · ${w?.name || ''}`);
    jump.title = 'Terminal por clase; no identifica la ventana de esta sesión';
    document.dispatchEvent(new CustomEvent('abito:sessions-view', { detail: { view, focusId: memory.focus?.id || null } }));
  }

  const applyPrefs = raw => {
    const previous = prefs.mainPill; prefs = raw && typeof raw === 'object' ? raw : {};
    if (previous !== prefs.mainPill) {
      const main = V.sessionRows(lastView, prefs).find(r => r.sourcePill === prefs.mainPill);
      if (main) V.focus(memory, lastView, main.id);
    }
    if (lastView) show(lastView);
  };
  let prefsVersion = 0;
  const listen = window.__TAURI__?.event?.listen;
  if (listen) listen('prefs:state', event => { prefsVersion++; applyPrefs(event?.payload); }).catch(() => {});
  const observed = prefsVersion;
  invoke('prefs_action', { payload: { action: 'view' } }).then(raw => { if (observed === prefsVersion) applyPrefs(raw); }, () => {});

  let timer = null;
  let inFlight = false;
  async function ask() {
    if (inFlight) return;
    inFlight = true;
    try {
      show(await V.requestSessions(invoke));
    } catch {
      show({ state: 'error' }); // one honest muted line; rows return on the next good answer
    } finally {
      inFlight = false;
    }
  }
  const capsule = document.getElementById('capsule');
  const active = () => !document.hidden && !!capsule && capsule.dataset.phase === 'expanded';
  const tick = () => { if (active()) ask(); };
  const start = () => { if (!timer) { timer = setInterval(tick, POLL_MS); tick(); } };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const sync = () => (active() ? start() : stop());
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('island:view', sync);
  if (capsule) new MutationObserver(sync).observe(capsule, { attributes: true, attributeFilter: ['data-phase'] });
  document.addEventListener('abito:session-select', event => { if (canFocus()) selectSession(event.detail?.id); });
  document.addEventListener('abito:integration-focus', event => { integrationFocused = !!event.detail?.id; jump.hidden = integrationFocused || !memory.focus; });
  sync();
}
