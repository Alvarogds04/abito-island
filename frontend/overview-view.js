'use strict';
/* UI.1 — pure overview view-model (no DOM, no IPC, no network). Maps host
   state to {tone, icon, word, aria} per docs/desktop-visual-language.md
   §2.1/§2.2/§3. Words that stay visible are the "never remove" set; long
   sentences go to `aria`/`detail` (behind the «i» button). Loaded as a
   classic script (window.AbitoOverview) and by
   test-node/overview-view-check.cjs through `module.exports`. Everything is
   plain text; the page writes it with textContent only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoOverview = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // Host reason strings (src/card.rs Reason) the view reacts to.
  const SENT = 'Decisión enviada.';
  const EXPIRED = 'Propuesta vencida.';
  const BUSY = 'Decisión en curso.';
  const COVERED = 'Abrí la tarjeta para decidir.';
  const NOTICE_WINDOW_MS = 60000; // notices are dropped after a minute

  // ---- expiry ------------------------------------------------------------
  function expiryLabel(iso, now) {
    const at = Date.parse(iso);
    if (typeof iso !== 'string' || !Number.isFinite(at)) return '';
    const ms = at - now;
    if (ms <= 0) return 'Vencida';
    if (ms < 60000) return '<1 min';
    const min = Math.ceil(ms / 60000);
    if (min < 60) return `${min} min`;
    const hours = Math.ceil(min / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.ceil(hours / 24);
    return days > 99 ? '+99 d' : `${days} d`;
  }
  function expiryAria(iso, now) {
    const label = expiryLabel(iso, now);
    if (!label) return '';
    return label === 'Vencida' ? `Vencida: ${iso}` : `Vence en ${label}: ${iso}`;
  }

  // ---- approval card -------------------------------------------------------
  // `reason` is the host/feedback reason, or null while the human may decide.
  function cardView(reason) {
    if (reason == null) {
      return { kind: 'pending', tone: 'sun', icon: '', word: '', aria: 'Esperando tu decisión', actionable: true };
    }
    const text = String(reason);
    const inert = (kind, tone, icon, word, aria) => ({ kind, tone, icon, word, aria, actionable: false });
    if (text === SENT) return inert('sent', 'live', 'plane', 'Enviada', 'Decisión enviada; el resultado todavía no está confirmado');
    if (text === EXPIRED) return inert('expired', 'faint', 'clock-off', 'Vencida', 'Propuesta vencida');
    if (text === BUSY) return inert('busy', 'live', 'ring', '', 'Enviando decisión');
    if (text === COVERED) return inert('covered', 'sun', '', '', text);
    if (text.startsWith('No se pudo confirmar la decisión')) {
      return inert('unconfirmed', 'red', 'triangle', 'Sin confirmar', text);
    }
    // Anything else (bridge down, card changed, …) stays honest and visible.
    return inert('unavailable', 'faint', 'lock', 'No disponible', text);
  }

  // ---- connection (Pi) -------------------------------------------------------
  function connectionView(snapshot) {
    const s = snapshot || {};
    const connections = typeof s.connections === 'number' ? s.connections : 0;
    if (s.unavailable === true) {
      return { kind: 'unavailable', tone: 'red', icon: 'triangle', word: 'Avisos caídos',
        aria: 'Avisos locales no disponibles',
        detail: 'El canal local de avisos no pudo iniciarse. No se hizo ninguna conexión con Pi.' };
    }
    if (connections > 0) {
      return { kind: 'connected', tone: 'go', icon: 'plug', word: '',
        aria: 'Conexión local activa · identidad declarada como Pi',
        detail: 'La conexión está activa. Esto no confirma que Pi esté trabajando ni que una tarea haya terminado.' };
    }
    return { kind: 'down', tone: 'faint', icon: 'plug-off', word: 'Sin Pi',
      aria: 'Sin Pi: no hay una sesión conectada',
      detail: 'Los avisos están disponibles solo si conectás una sesión de Pi de forma explícita.' };
  }

  // ---- notice pill (Sileo) ---------------------------------------------------
  const KNOWN_SHORT = { 'Pi terminó su turno': 'Pi terminó' };
  const shortTitle = title => {
    const t = String(title || '').trim();
    return KNOWN_SHORT[t] || t.split(/\s+/).slice(0, 3).join(' ');
  };
  function noticeView(notices, now) {
    if (!Array.isArray(notices) || !notices.length) return null;
    const first = notices[0];
    const left = Number.isFinite(first.expiresAt) ? first.expiresAt - now : 0;
    const n = notices.length;
    const full = [`Aviso: ${first.title}.`, first.detail || '',
      `${n} aviso${n === 1 ? '' : 's'} reciente${n === 1 ? '' : 's'}; se descartan al minuto.`].filter(Boolean).join(' ');
    return { text: shortTitle(first.title), badge: n,
      fraction: Math.max(0, Math.min(1, left / NOTICE_WINDOW_MS)), aria: full };
  }

  // R6 gesture after the human's click. A SENT decision is NOT a confirmed
  // result (§1.1, C23): «Enviada»/«Sin confirmar» keep the character at REST;
  // lifting/smiling (confirm) or shaking (reject) may only come from a real
  // host confirmation, which does not exist yet. Pure, so it is testable.
  const gestureFor = () => null;

  // R6 pose from the host snapshot (docs/r6-states-mapping.md §2.4): a bridge
  // that is not healthy (`unhealthy`/`stopped`) or a transport that could not
  // start (`unavailable`) is a REAL persistent failure -> `error`. `disabled`
  // (no configuration yet), `starting` and `healthy` are not errors. Anything
  // else (a covering card, a conflict, a notice) leaves the pose alone.
  function snapshotPose(snapshot) {
    const s = snapshot || {};
    if (s.unavailable === true) return 'error';
    const bridge = s.bridgeStatus && s.bridgeStatus.state;
    return bridge === 'unhealthy' || bridge === 'stopped' ? 'error' : null;
  }

  // ---- «i» button name: announces the real state, then what it opens ---------
  const infoLabel = (base, stateAria) => (stateAria ? `${base}: ${stateAria}` : base);

  // §3: while a card is on screen the notices strip steps aside, so a missing
  // Pi / downed channel stays visible next to the card (icon + word). A
  // healthy connection needs nothing there.
  const cardConnection = conn => (conn && conn.word ? conn : null);

  return { expiryLabel, expiryAria, cardView, connectionView, noticeView, infoLabel, cardConnection, gestureFor, snapshotPose };
});
