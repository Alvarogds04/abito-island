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

  // ---- bridge (approval) down: its own chip, §3 «never hide a problem» ------
  function bridgeView(snapshot) {
    const bridge = snapshot && snapshot.bridgeStatus && snapshot.bridgeStatus.state;
    if (bridge !== 'unhealthy' && bridge !== 'stopped') return null;
    return { kind: 'down', tone: 'red', icon: 'triangle', word: 'Sin puente',
      aria: 'Sin puente: el puente de aprobación no responde; no se puede decidir hasta que vuelva',
      detail: 'El puente que lleva tu decisión al backend no responde. Las decisiones quedan sin enviar.' };
  }

  // ---- R6 error face from the HOST: time-boxed, never a permanent mask ------
  // docs/r6-states-mapping §2.4/§3.1 (night review): the host failure shows the
  // `error` pose for HOST_ERROR_MS after it BEGINS, or for as long as a card /
  // decision that depends on the bridge is on screen; afterwards the chip and
  // the compact triangle keep carrying the fact, the character calms down.
  const HOST_ERROR_MS = 7000;
  function hostPoseView(snapshot, tracker, now) {
    const t = tracker || { failing: false, since: 0 };
    const failing = snapshotPose(snapshot) === 'error';
    const next = { failing, since: failing ? (t.failing ? t.since : now) : 0 };
    if (!failing) return { pose: null, tracker: next };
    const bridgeDependent = bridgeView(snapshot) !== null && !!(snapshot && snapshot.card);
    const fresh = now - next.since < HOST_ERROR_MS;
    return { pose: fresh || bridgeDependent ? 'error' : null, tracker: next, expiresAt: next.since + HOST_ERROR_MS };
  }
  // Priority (night review): the chat is local and independent of the bridge, so
  // an ACTIVE turn (think/speak) wins; then the host failure; then the chat's own
  // persistent error; else rest.
  function choosePose(chat, host) {
    if (chat === 'think' || chat === 'speak') return chat;
    return host || chat || 'idle';
  }

  // #304 — Abito's OWN motion state. WebKit derives prefers-reduced-motion from
  // GtkSettings (gtk-enable-animations), which can be «off» in a session where the
  // human never asked for it, leaving the island frozen. So the system value is
  // IGNORED by default: motion is «full» unless the human opted to honor the system
  // preference (`honorSystem`, the `respectSystemMotion` setting).
  function motionState(input) {
    const i = input || {};
    return i.honorSystem === true && i.systemReduced === true ? 'reduce' : 'full';
  }
  // snapshot.motionOverride === true (the new default) = do NOT honor the system.
  const honorSystemMotion = snapshot => !!snapshot && snapshot.motionOverride === false;

  // ---- #305 global shortcut feedback ------------------------------------------------------
  // A working shortcut is silent. A problem is NEVER hidden (§3): icon + one word.
  const HOTKEY_PROBLEMS = Object.freeze({
    taken: ['Atajo ocupado', 'triangle', 'red', 'está en uso por otra aplicación; elegí otra combinación'],
    unsupported: ['Atajo sin soporte', 'triangle', 'red', 'no se pudo registrar: no hay un servidor X11 accesible'],
    invalid: ['Atajo inválido', 'triangle', 'red', 'no es una combinación válida: necesita Ctrl, Alt o Súper'],
    // portal route (#305b): the OS asks the human ONCE; a decline is visible and the X11 fallback takes over
    permission_denied: ['Atajo sin permiso', 'triangle', 'red', 'no se activó porque rechazaste el permiso del sistema; usamos el atajo limitado de X11'],
  });
  function hotkeyView(view) {
    if (!view || typeof view !== 'object' || view.enabled === false) return null;
    const combo = String(view.combo || '');
    const problem = Object.prototype.hasOwnProperty.call(HOTKEY_PROBLEMS, view.status) ? HOTKEY_PROBLEMS[view.status] : null;
    if (problem) {
      return { kind: view.status, word: problem[0], icon: problem[1], tone: problem[2], aria: `${problem[0]}: ${combo} ${problem[3]}` };
    }
    if (view.status === 'permission_pending') {
      return { kind: 'permission_pending', word: 'Aceptá el permiso', icon: 'info', tone: 'sun',
        aria: `Aceptá el permiso: el sistema te pregunta si Abito puede usar el atajo ${combo}; respondé una sola vez y queda guardado` };
    }
    if (view.status === 'active' && view.limited === true) {
      return { kind: 'limited', word: 'Atajo limitado', icon: 'info', tone: 'faint',
        aria: `Atajo limitado: ${combo} solo funciona mientras una ventana de X11 tiene el foco (sesión Wayland)` };
    }
    return null;
  }

  // §9.2: R6 hover scale. Pure: 1.06 only while the pointer is inside the
  // character's box and the system does NOT ask for reduced motion; never
  // while dragging. It carries no meaning and never touches the pose.
  const HOVER_SCALE = 1.06;
  function hoverScale(point, box, opts) {
    const o = opts || {};
    if (o.reduced || o.dragging || !point || !box) return 1;
    const inside = point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;
    return inside ? HOVER_SCALE : 1;
  }

  // ---- «i» button name: announces the real state, then what it opens ---------
  const infoLabel = (base, stateAria) => (stateAria ? `${base}: ${stateAria}` : base);

  // §3: while a card is on screen the notices strip steps aside, so a missing
  // Pi / downed channel stays visible next to the card (icon + word). A
  // healthy connection needs nothing there.
  const cardConnection = conn => (conn && conn.word ? conn : null);

  return { expiryLabel, expiryAria, cardView, connectionView, noticeView, infoLabel, cardConnection, gestureFor, snapshotPose, motionState, honorSystemMotion, bridgeView, hostPoseView, choosePose, hotkeyView, HOST_ERROR_MS, hoverScale, HOVER_SCALE };
});
