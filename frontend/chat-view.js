'use strict';
/* U1 — pure chat view helpers (no DOM, no IPC, no network). Loaded by the
   island page as a classic script (window.AbitoChatView) and by
   test-node/chat-view-check.cjs through `module.exports`. Every value it
   renders is plain text; the page writes it with textContent only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoChatView = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const DRAFT_MAX = 8000; // Unicode scalars, same as chat.rs DRAFT_MAX_SCALARS

  const LABELS = Object.freeze({
    queued: 'En cola',
    thinking: 'Pensando…',
    streaming: 'Escribiendo…',
    waiting_approval: 'Esperando aprobación',
    completed: 'Respondió',
    cancelled: 'Cancelado',
    error: 'Error',
  });
  const stateLabel = state => LABELS[state] || '';

  const scalarCount = text => Array.from(text).length;

  // Mirrors chat.rs validate_text: C0/DEL/C1 except LF and TAB are refused.
  function draftProblem(text) {
    const normalized = String(text).replace(/\r\n?/g, '\n');
    if (scalarCount(normalized) > DRAFT_MAX) return 'El mensaje supera los 8.000 caracteres.';
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(normalized)) return 'El mensaje contiene caracteres de control.';
    if (!normalized.trim()) return 'El mensaje está vacío.';
    return null;
  }

  const SENDABLE = new Set(['ready', 'busy']);
  function canSend(view, draft, inFlight) {
    if (!view || inFlight || view.active_turn) return false;
    const a = view.availability;
    if (!a || !SENDABLE.has(a.state)) return false;
    return draftProblem(draft) === null;
  }

  function activeTurn(view) {
    if (!view || !view.active_turn || !Array.isArray(view.turns)) return null;
    return view.turns.find(t => t.turn_id === view.active_turn) || null;
  }

  function statusLine(view) {
    if (!view) return 'Chat no disponible.';
    const active = activeTurn(view);
    if (active) {
      const label = stateLabel(active.state);
      return view.queue_note ? `${label} · ${view.queue_note}` : label;
    }
    return (view.availability && view.availability.message) || 'Chat no disponible.';
  }

  const lastTurn = view => (view && Array.isArray(view.turns) && view.turns.length)
    ? view.turns[view.turns.length - 1] : null;

  // Polite live-region text: once per state change / completed turn, never
  // per streamed token.
  function announcement(previous, next) {
    const turn = lastTurn(next);
    if (!turn) return null;
    const before = lastTurn(previous);
    const sameTurn = before && before.turn_id === turn.turn_id;
    if (sameTurn && before.state === turn.state) return null;
    if (turn.state === 'completed') {
      const reply = turn.reply.length > 300 ? turn.reply.slice(0, 300) + '…' : turn.reply;
      return `Abito respondió: ${reply}`;
    }
    if (turn.state === 'error') return (turn.error && turn.error.safe_message) || 'Error';
    return stateLabel(turn.state) || null;
  }

  const atBottom = (scrollTop, scrollHeight, clientHeight) => scrollHeight - scrollTop - clientHeight <= 8;

  function newRequestId(bytes) {
    return 'req-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  // Rows for one turn: user, optional trim note, assistant/error, notes.
  function turnRows(turn) {
    const rows = [{ kind: 'user', text: turn.user_text }];
    if (turn.trimmed_turns > 0) {
      rows.push({
        kind: 'note',
        text: `Para entrar en el contexto del modelo se dejaron afuera ${turn.trimmed_turns} mensajes anteriores.`,
      });
    }
    if (turn.reply) rows.push({ kind: 'assistant', text: turn.reply });
    if (turn.state === 'error') {
      rows.push({ kind: 'error', text: (turn.error && turn.error.safe_message) || 'Error.' });
    } else if (turn.finish_reason === 'limit') {
      rows.push({ kind: 'note', text: 'La respuesta llegó al límite de largo y se cortó.' });
    } else if (turn.state === 'cancelled') {
      rows.push({ kind: 'note', text: 'Cancelado. Lo que el modelo ya procesó no se puede recuperar.' });
    }
    return rows;
  }

  // ---- U2: model picker (plain-text rows) ---------------------------------
  const GATES = Object.freeze({
    ready: 'Listo',
    queue: 'En cola',
    needs_load: 'Requiere cargarlo (Abito no lo hace)',
    unknown: 'Desconocido',
    unavailable: 'No disponible',
  });
  const gateLabel = state => GATES[state] || 'Desconocido';
  const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimal = (value, unit) => {
    const tenths = Math.round(value * 10);
    return `${Math.floor(tenths / 10)},${tenths % 10} ${unit}`;
  };
  const port = origin => String(origin || '').replace(/^http:\/\//, '');

  function modelRows(listing) {
    const profiles = listing && Array.isArray(listing.profiles) ? listing.profiles : [];
    return profiles.map(p => {
      const facts = [`local ${port(p.origin)}`];
      if (Number.isFinite(p.context_tokens)) facts.push(`contexto ${thousands(p.context_tokens)} tokens`);
      if (Number.isFinite(p.max_output_tokens)) facts.push(`salida ≤${thousands(p.max_output_tokens)}`);
      if (Number.isFinite(p.size_bytes)) facts.push(`${decimal(p.size_bytes / 1e9, 'GB')} en memoria`);
      if (Number.isFinite(p.params)) facts.push(`${decimal(p.params / 1e9, 'mil millones')} de parámetros`);
      if (p.quantization) facts.push(p.quantization);
      if (p.vision === false) facts.push('sin visión');
      if (p.vision === true) facts.push('con visión');
      const title = p.alias || `Puerto ${port(p.origin).split(':').pop()} (sin identificar)`;
      return {
        id: p.profile_id || null,
        title,
        facts: facts.join(' · '),
        state: gateLabel(p.gate && p.gate.state),
        message: (p.gate && p.gate.message) || '',
        note: p.note || '',
        selectable: p.selectable === true && !!p.profile_id,
        selected: !!p.profile_id && listing.selected === p.profile_id,
      };
    });
  }

  return { gateLabel, modelRows, DRAFT_MAX, stateLabel, scalarCount, draftProblem, canSend, statusLine, announcement, atBottom, newRequestId, turnRows, activeTurn };
});
