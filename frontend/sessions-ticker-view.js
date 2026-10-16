'use strict';
/* #360 — pure sessions-ticker view-model: a CLOSED projection of the daemon's
   `sessions` frame (live agent sessions with their terminal origin). No DOM
   ownership, no IPC, no network; the only DOM it touches is the container handed
   to render(), written with textContent only. UI copy in Spanish (rioplatense
   voseo). Contracts: apps/desktop-daemon/docs/PROTOCOL.md "Sessions frames".
   Loaded as a classic script (window.AbitoSessionsTicker) and by
   test-node/sessions-ticker-view-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSessionsTicker = Object.freeze(api);
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
