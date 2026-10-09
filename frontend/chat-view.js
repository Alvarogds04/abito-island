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

  // UI.2 chat (docs/desktop-visual-language.md §2.3/§3): the header state as
  // {tone, icon, word, kind, aria}. A word stays ONLY for problems
  // («Modelo caído», «Error», «Bloqueado», «Ocupado»); the full sentence is aria.
  function statusView(view) {
    const aria = statusLine(view);
    const mk = (kind, tone, icon, word) => ({ kind, tone, icon, word, aria });
    if (!view) return mk('down', 'red', 'triangle', 'Modelo caído');
    const active = activeTurn(view);
    if (active) {
      if (active.state === 'waiting_approval') return mk('waiting', 'sun', '', '');
      if (active.state === 'queued') return mk('queued', 'live', 'clock', '');
      return mk('busy', 'live', 'ring', ''); // thinking / streaming: blue open arc, spun by the page
    }
    const state = view.availability && view.availability.state;
    if (state === 'ready') return mk('ready', 'go', '', '');
    if (state === 'busy') return mk('occupied', 'live', 'clock', 'Ocupado');
    if (state === 'blocked') return mk('blocked', 'red', 'triangle', 'Bloqueado');
    if (state === 'unavailable') return mk('down', 'red', 'triangle', 'Modelo caído');
    return mk('checking', 'live', 'ring', '');
  }
  // R6 pose for the chat lane, from real state only: a turn thinking -> think,
  // streaming -> speak; the model down/blocked or a failed last turn -> error;
  // everything else (ready, queued, waiting for approval) -> rest (null).
  function poseFor(view) {
    if (!view) return null;
    const active = activeTurn(view);
    if (active) return active.state === 'thinking' ? 'think' : active.state === 'streaming' ? 'speak' : null;
    const a = view.availability && view.availability.state;
    if (a === 'unavailable' || a === 'blocked') return 'error';
    const last = Array.isArray(view.turns) && view.turns.length ? view.turns[view.turns.length - 1] : null;
    return last && last.state === 'error' ? 'error' : null;
  }
  // Draft problem as one visible word; empty draft shows nothing.
  function draftWord(text) {
    const normalized = String(text).replace(/\r\n?/g, '\n');
    if (scalarCount(normalized) > DRAFT_MAX) return 'Muy largo';
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(normalized)) return 'Caracteres no válidos';
    return '';
  }
  const targetAria = t => (t ? `${t.alias}, sólo local, ${String(t.origin || '').replace(/^http:\/\//, '')}` : 'Sin modelo local elegido');

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
        kind: 'note', short: 'Recortado', icon: 'info',
        text: `Para entrar en el contexto del modelo se dejaron afuera ${turn.trimmed_turns} mensajes anteriores.`,
      });
    }
    if (turn.reply) rows.push({ kind: 'assistant', text: turn.reply });
    if (turn.state === 'error') {
      rows.push({ kind: 'error', short: 'Error', icon: 'triangle', text: (turn.error && turn.error.safe_message) || 'Error.' });
    } else if (turn.finish_reason === 'limit') {
      rows.push({ kind: 'note', short: 'Cortado por largo', icon: 'info', text: 'La respuesta llegó al límite de largo y se cortó.' });
    } else if (turn.state === 'cancelled') {
      rows.push({ kind: 'note', short: 'Cancelado', icon: 'cross', text: 'Cancelado. Lo que el modelo ya procesó no se puede recuperar.' });
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

  // Visual model row (docs/desktop-visual-language.md §2.4): chips carry the
  // numbers, the gate gets ONE word only when it is not «ready» (§3: never
  // hide a problem), and the full sentence stays in `aria`/`facts`.
  const GATE_WORDS = Object.freeze({
    queue: { word: 'En cola', icon: 'clock', tone: 'live' },
    needs_load: { word: 'Sin cargar', icon: 'load-off', tone: 'faint' },
    unknown: { word: 'Desconocido', icon: 'info', tone: 'faint' },
    unavailable: { word: 'No disponible', icon: 'triangle', tone: 'red' },
  });
  const oneDecimal = n => {
    const tenths = Math.round(n * 10);
    return tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)},${tenths % 10}`;
  };
  const kTokens = n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

  function modelChips(p) {
    const chips = [{ icon: 'lock', text: 'local', label: 'Sólo local' }];
    if (Number.isFinite(p.context_tokens)) chips.push({ icon: '', text: kTokens(p.context_tokens), label: `Contexto ${thousands(p.context_tokens)} tokens` });
    if (Number.isFinite(p.size_bytes)) chips.push({ icon: '', text: `${oneDecimal(p.size_bytes / 1e9)} GB`, label: `${decimal(p.size_bytes / 1e9, 'GB')} en memoria` });
    if (Number.isFinite(p.params)) chips.push({ icon: '', text: `${oneDecimal(p.params / 1e9)}B`, label: `${decimal(p.params / 1e9, 'mil millones')} de parámetros` });
    if (p.vision === false) chips.push({ icon: 'eye-off', text: '', label: 'Sin visión' });
    if (p.vision === true) chips.push({ icon: 'eye', text: '', label: 'Con visión' });
    return chips;
  }

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
      const title = p.alias || `Puerto ${port(p.origin).split(':').pop()}`;
      const gateState = p.gate && p.gate.state;
      const selectable = p.selectable === true && !!p.profile_id;
      let gate = GATE_WORDS[gateState] || (gateState === 'ready' ? null : GATE_WORDS.unknown);
      if (!gate && !selectable) gate = { word: 'Sin verificar', icon: 'lock', tone: 'faint' };
      const message = (p.gate && p.gate.message) || '';
      const note = p.note || '';
      return {
        id: p.profile_id || null,
        title,
        facts: facts.join(' · '),
        state: gateLabel(gateState),
        message,
        note,
        chips: modelChips(p),
        word: gate ? gate.word : '',
        wordIcon: gate ? gate.icon : '',
        tone: gate ? gate.tone : 'go',
        aria: `${title}: ${gateLabel(gateState)}. ${facts.join(', ')}. ${message} ${note}`.replace(/\s+/g, ' ').trim(),
        selectable,
        selected: !!p.profile_id && listing.selected === p.profile_id,
      };
    });
  }

  // Three meters (RAM, VRAM, GTT): fill = USED share; the numbers live in aria.
  const gb = bytes => decimal(bytes / 1e9, 'GB');
  function modelMeters(listing) {
    const r = (listing && listing.resources) || {};
    const gpu = r.gpu || null;
    const make = (key, label, used, total, unknownText) => {
      const known = Number.isFinite(used) && Number.isFinite(total) && total > 0;
      return {
        key, label, known,
        fraction: known ? Math.max(0, Math.min(1, used / total)) : 0,
        aria: known ? `${label}: ${gb(used)} en uso de ${gb(total)}` : `${label}: ${unknownText}`,
      };
    };
    const ramUsed = Number.isFinite(r.mem_total) && Number.isFinite(r.mem_available) ? r.mem_total - r.mem_available : NaN;
    return [
      make('ram', 'RAM', ramUsed, r.mem_total, 'desconocida'),
      make('vram', 'VRAM', gpu && gpu.vram_used, gpu && gpu.vram_total, 'desconocida'),
      make('gtt', 'GTT', gpu && gpu.gtt_used, gpu && gpu.gtt_total, 'desconocida'),
    ];
  }

  // «i» sentence for the panel: the paragraph that used to be on screen.
  function modelsInfo(listing) {
    if (!listing) return 'Leyendo modelos locales.';
    const kept = listing.persisted === false && listing.selected ? ' Elección sólo en memoria: se pierde al cerrar Abito.' : '';
    return `${listing.choice_note || ''} ${listing.remote || ''}${kept}`.replace(/\s+/g, ' ').trim();
  }
  const modelsCount = listing => (listing && Array.isArray(listing.profiles) ? listing.profiles.filter(p => p.selectable === true && p.profile_id).length : 0);

  // ---- Q1: notices + compact activation ----------------------------------
  // Announce a notice once, when a NEW first notice appears (never on
  // dismissal, never twice). Plain text.
  function noticeAnnouncement(lastId, notices) {
    const first = Array.isArray(notices) && notices.length ? notices[0] : null;
    if (!first || first.id === lastId) return null;
    const detail = first.detail ? ` ${first.detail}` : '';
    return `Aviso: ${first.title}.${detail}`;
  }
  const activates = e => !!e && !e.isComposing && !e.repeat && (e.key === 'Enter' || e.key === ' ');

  return { poseFor, statusView, draftWord, targetAria, noticeAnnouncement, activates, gateLabel, modelRows, modelMeters, modelsInfo, modelsCount, DRAFT_MAX, stateLabel, scalarCount, draftProblem, canSend, statusLine, announcement, atBottom, newRequestId, turnRows, activeTurn };
});
