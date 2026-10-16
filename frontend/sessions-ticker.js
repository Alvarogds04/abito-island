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
    return { id, kindLabel, cwd, stateLabel, origin, text };
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

  /** Copy for an over-cap frame, or null when the list was not cut. */
  function boundedText(view) {
    if (!view || view.state !== 'ready' || !view.truncated) return null;
    return 'Hay más sesiones: la lista está acotada';
  }

  /** Copy for an unavailable view (no daemon, old daemon, error). */
  function errorText() {
    return 'Sesiones no disponibles';
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

  return { SCHEMA, MAX_ROWS, sessionsView, boundedText, errorText, render };
});

// ---- browser-only wiring: self-mounting poll through agent_action --------------

function mount(V) {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  if (!invoke) return;

  const POLL_MS = 2000; // the floor: never faster than the daemon's scan cache
  const host = document.createElement('div');
  host.setAttribute('data-abito', 'sessions-ticker');
  host.style.cssText = 'position:fixed;left:14px;bottom:10px;z-index:40;pointer-events:none;display:none;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:70vw;';
  document.body.append(host);

  // The Rust host folds the `sessions` frame into ClientState.sessions
  // ({rows, truncated}); rebuild OUR closed frame shape for the pure view.
  const toFrame = state => (state && Array.isArray(state.rows))
    ? { type: 'sessions', schema: V.SCHEMA, sessions: state.rows, truncated: state.truncated === true }
    : null;

  let timer = null;
  let inFlight = false;
  async function ask() {
    if (inFlight) return;
    inFlight = true;
    try {
      const state = await invoke('agent_action', { payload: { action: 'sessions_list' } });
      const view = V.sessionsView(toFrame(state && state.sessions));
      V.render(host, view || { state: 'error' });
    } catch {
      V.render(host, { state: 'error' }); // one honest muted line; rows return on the next good answer
    } finally {
      inFlight = false;
    }
  }
  const tick = () => { if (!document.hidden) ask(); };
  const start = () => { if (!timer) { timer = setInterval(tick, POLL_MS); tick(); } };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
}
