'use strict';
/* N6 — pure notification view-model: a notification carries 1..N reply options
   (Pi questions QP/1 are one case; other agents plug in later through the
   connectors lane, not here). No DOM, no IPC, no network, NO AUDIO. Contracts:
   docs/pi-question-roundtrip.md §2.4-§2.7, docs/desktop-visual-language.md
   §1.1/§2.2/§3, docs/desktop-sound-catalog.md §2-§3. Loaded as a classic
   script (window.AbitoNotify) and by test-node/notify-view-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoNotify = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_OPTIONS = 4; // QP/1 wire cap
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SOUND_ENABLED_DEFAULT = false; // the island contract is silence until the human opts in

  // ---- model -----------------------------------------------------------------
  // `pending` is the host's PendingQuestionView (display text only: never a
  // wire token, scope or suggested option). Returns null for anything that is
  // not a well-formed, answerable notification.
  function fromPending(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !UUID_V4.test(p.id)) return null;
    const kind = p.kind === 'approval' ? 'approval' : p.kind === 'question' ? 'question' : null;
    if (!kind || typeof p.text !== 'string' || !p.text) return null;
    const raw = Array.isArray(p.options) ? p.options.slice(0, MAX_OPTIONS) : [];
    const options = raw.map((o, i) => ({
      index: Number.isInteger(o && o.index) ? o.index : i,
      key: String(i + 1),
      label: String((o && o.label) || ''),
      description: String((o && o.description) || ''),
    }));
    const allowFreeText = p.allow_free_text === true;
    if (kind === 'approval' && (options.length !== 2 || allowFreeText)) return null;
    if (!options.length && !allowFreeText) return null;
    if (options.some(o => !o.label)) return null;
    return { id: p.id, kind, agent: 'pi', text: p.text, options, allowFreeText,
      expiresAt: Number.isFinite(p.expires_at) ? p.expires_at : 0,
      // a Pi-session answer: it authorizes nothing in the backend and never uses the approval card
      approvesProposal: false };
  }

  // ---- trusted gate + keyboard ---------------------------------------------------
  const trusted = event => !!event && event.isTrusted === true;
  // Digit 1..N picks that option. Never while typing, never with a modifier, an
  // IME composition or a repeat, and never from a synthetic event. Enter on its
  // own picks nothing: no option is ever preselected.
  function optionForKey(notification, event, ctx) {
    if (!notification || !trusted(event) || (ctx && ctx.typing)) return -1;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.repeat) return -1;
    if (!/^[1-9]$/.test(String(event.key))) return -1;
    const at = Number(event.key) - 1;
    return at < notification.options.length ? notification.options[at].index : -1;
  }

  // The notification can be answered ONLY while it is actually on screen:
  // expanded island, overview view, no approval card covering it. (A real key
  // must never answer something nobody can see: chat open, compact island.)
  const onScreen = d => !!d && d.phase === 'expanded' && d.view === 'overview' && !d.card;

  // ---- expiry (epoch milliseconds) --------------------------------------------------
  const expired = (expiresAt, now) => !Number.isFinite(expiresAt) || expiresAt <= now;
  function expiryWord(expiresAt, now) {
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return '';
    const ms = expiresAt - now;
    if (ms <= 0) return 'Vencida';
    if (ms < 60000) return '<1 min';
    const min = Math.ceil(ms / 60000);
    if (min < 60) return `${min} min`;
    return `${Math.ceil(min / 60)} h`;
  }
  const fraction = (expiresAt, now, total) => (total > 0 && Number.isFinite(expiresAt)
    ? Math.max(0, Math.min(1, (expiresAt - now) / total)) : 0);

  // ---- outcomes (host QuestionOutcome → icon + one word) -------------------------------
  // «Enviada» is NEUTRAL (live plane): the result is not confirmed. Only the
  // producer's own acknowledgement (answered) is lime. A problem is never hidden.
  const OUTCOMES = Object.freeze({
    sent: { tone: 'live', icon: 'plane', word: 'Enviada', aria: 'Respuesta enviada; todavía sin confirmar', persistent: false },
    answered: { tone: 'go', icon: 'check', word: 'Recibida', aria: 'Pi recibió tu respuesta', persistent: false },
    human_cancelled: { tone: 'faint', icon: 'cross', word: 'Omitida', aria: 'Omitiste la pregunta de Pi', persistent: false },
    expired: { tone: 'faint', icon: 'clock-off', word: 'Vencida', aria: 'La pregunta de Pi venció sin respuesta', persistent: false },
    cancelled: { tone: 'faint', icon: 'cross', word: 'Cancelada', aria: 'Pi retiró la pregunta', persistent: false },
    disconnected: { tone: 'faint', icon: 'plug-off', word: 'Sin Pi', aria: 'Se cortó la conexión con Pi; la pregunta se descartó', persistent: false },
    busy: { tone: 'faint', icon: 'lock', word: 'Ocupada', aria: 'Otra pregunta de Pi se rechazó porque ya había una abierta', persistent: false },
    rejected: { tone: 'red', icon: 'triangle', word: 'Rechazada', aria: 'Pi rechazó la respuesta; no se aplicó a ninguna otra pregunta', persistent: true },
    ack_lost: { tone: 'red', icon: 'triangle', word: 'Sin confirmar', aria: 'No llegó la confirmación de Pi; no se sabe si recibió tu respuesta', persistent: true },
    outcome_unknown: { tone: 'red', icon: 'triangle', word: 'Sin confirmar', aria: 'No se pudo confirmar el envío de la respuesta', persistent: true },
  });
  const outcomeView = outcome => (typeof outcome === 'string' && Object.prototype.hasOwnProperty.call(OUTCOMES, outcome)
    ? { outcome, ...OUTCOMES[outcome] } : null);

  // ---- view phase ---------------------------------------------------------------------
  // Pending always beats a stale notice. Controls die on local expiry, while a
  // send is in flight and while the native window barrier is not idle.
  function phase(snapshot, ctx) {
    const c = ctx || {};
    const s = snapshot && snapshot.available !== false ? snapshot : null;
    if (!s) return { kind: 'none', controlsEnabled: false };
    const n = fromPending(s.pending);
    if (n) {
      const now = Number.isFinite(c.now) ? c.now : Date.now();
      if (expired(n.expiresAt, now)) return { kind: 'expired', notification: n, controlsEnabled: false, outcome: outcomeView('expired') };
      const barrier = s.native_transition && s.native_transition !== 'idle';
      return { kind: c.inFlight ? 'sending' : 'pending', notification: n, controlsEnabled: !c.inFlight && !barrier };
    }
    const outcome = outcomeView(s.notice);
    return outcome ? { kind: 'outcome', outcome, controlsEnabled: false } : { kind: 'none', controlsEnabled: false };
  }

  // ---- sound cues (catalog ids only; playing them is a separate OFF-by-default switch) --------
  const SILENT = new Set(['sent', 'ack_lost', 'outcome_unknown', 'answered', 'human_cancelled', 'rejected', 'busy', 'disconnected', 'cancelled']);
  function soundFor(prev, next) {
    if (!prev || !next) return null; // nothing sounds at start-up or without history
    const before = fromPending(prev.pending), after = fromPending(next.pending);
    if (after && (!before || before.id !== after.id)) return 'snd.attention';
    // an expiry is an EVENT: the question that was pending last time is gone and the host says expired
    // (a retained old notice must not swallow a second expiry, nor re-fire on an unrelated update)
    if (!after && before && next.notice === 'expired') return 'snd.expired';
    if (next.notice && SILENT.has(next.notice)) return null; // «Enviada»/«Sin confirmar» NEVER sound
    return null;
  }
  // At most one cue per 250 ms; the same cue once per 2 s; the rest is dropped.
  function createCueLimiter() {
    let last = -Infinity; const byId = new Map();
    return { allow(id, now) {
      if (!id) return false;
      if (now - last < 250) return false;
      if (byId.has(id) && now - byId.get(id) < 2000) return false;
      last = now; byId.set(id, now); return true;
    } };
  }

  // ---- free text -----------------------------------------------------------------------
  const utf8Bytes = text => {
    let n = 0;
    for (const ch of String(text)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  };
  function textWord(budget, text) {
    if (!text || !budget || budget.allowed !== false) return '';
    return budget.reason === 'frame_too_large' ? 'Muy largo' : 'No válido';
  }
  // The host's byte budget is authoritative: no answer yet, or «not allowed», means no send.
  const canSendText = (budget, text) => !!budget && budget.allowed === true && typeof text === 'string' && text.trim().length > 0;

  return { MAX_OPTIONS, SOUND_ENABLED_DEFAULT, fromPending, trusted, onScreen, optionForKey, expired, expiryWord, fraction,
    outcomeView, phase, soundFor, createCueLimiter, utf8Bytes, textWord, canSendText };
});
