'use strict';
/* Abito island host — unit M1a.
   - Renders the frozen R6 clay engine (clay-engine.js, SVG-DOM) scaled and
     positioned inside the native window; never redrawn, no extra poses.
   - Animates compact<->overview with the approved contract motion:
     grow = spring response 0.5s / damping 0.72, shrink = 340ms
     cubic-bezier(.45,0,.2,1), prefers-reduced-motion snaps instantly, silence.
   - Forwards raw pointer events to the Rust core handlers, which own every
     decision (click-vs-drag threshold, edge snap keeping X, clamping, grow
     anchoring). This file never decides geometry policy.
   - Reports frontend evidence (SVG element count, canvas absence) to Rust.
   - Reads the motion override through the window.desktop facade (M1b):
     `animateAnyway` forces motion even under prefers-reduced-motion;
     everything else fails CLOSED to accessibility (M1a behaviour).
   No sounds, no Coucou assets. */
(() => {
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const island = $('island');
  const clayEl = $('clay');
  const label = $('label');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // Visible island geometry per state. Native windows: 304x44 compact and
  // 672x176 overview (set by Rust); margins are the difference.
  const COMPACT = { w: 288, h: 32, r: 14, gap: 6, clay: 44, drop: 0 };
  const OVERVIEW = { w: 640, h: 160, r: 22, gap: 8, clay: 104, drop: 16 };

  // Tauri IPC bridge (app.withGlobalTauri in tauri.conf.json).
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;

  // ---- frozen R6 ---------------------------------------------------------
  let clay = null;
  if (typeof AbitoClay !== 'undefined') {
    clay = AbitoClay.create(clayEl, { seed: 505, viewBox: '0 20 200 160' });
  }

  // ---- motion (contract numbers, JS-driven per frame) --------------------
  const W0 = 2 * Math.PI / 0.5; // spring response: 0.5 s
  const ZETA = 0.72;             // spring damping ratio: 0.72
  const SHRINK_MS = 340;         // shrink duration: 340 ms
  const easeShrink = cubicBezier(0.45, 0, 0.2, 1);

  let p = 0;            // progress 0 = compact, 1 = overview
  let v = 0;            // spring velocity
  let target = 0;
  let mode = 'idle';    // 'idle' | 'spring' | 'shrink'
  let t0 = 0, p0 = 0, last = 0, raf = 0;
  let edge = 'top';     // docked vertical edge (mirrors the Rust state)

  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = t => ((ax * t + bx) * t + cx) * t;
    const sampleY = t => ((ay * t + by) * t + cy) * t;
    const dX = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sampleX(t) - x;
        if (Math.abs(err) < 1e-5) break;
        const d = dX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      if (!(t >= 0 && t <= 1)) { // bisection fallback
        let lo = 0, hi = 1;
        for (let i = 0; i < 24 && Math.abs(sampleX(t) - x) > 1e-5; i++) {
          if (sampleX(t) < x) lo = t; else hi = t;
          t = (lo + hi) / 2;
        }
      }
      return sampleY(t);
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  function render() {
    const w = lerp(COMPACT.w, OVERVIEW.w, p);
    const h = lerp(COMPACT.h, OVERVIEW.h, p);
    const r = lerp(COMPACT.r, OVERVIEW.r, p);
    const gap = lerp(COMPACT.gap, OVERVIEW.gap, p);
    const cs = lerp(COMPACT.clay, OVERVIEW.clay, p);
    const drop = lerp(COMPACT.drop, OVERVIEW.drop, p);
    island.style.width = w + 'px';
    island.style.height = h + 'px';
    island.style.borderRadius = r + 'px';
    // Anchored to the docked edge: grows downward from the top, upward from
    // the bottom — matching the native grow anchoring done by Rust.
    if (edge === 'top') {
      island.style.top = gap + 'px';
      island.style.bottom = 'auto';
    } else {
      island.style.bottom = gap + 'px';
      island.style.top = 'auto';
    }
    clayEl.style.width = cs + 'px';
    clayEl.style.height = cs + 'px';
    clayEl.style.top = (h / 2 - drop - cs / 2) + 'px';
    label.style.opacity = String(Math.max(0, Math.min(1, (p - 0.7) / 0.3)));
    capsule.dataset.edge = edge;
    capsule.dataset.phase = p >= 1 ? 'expanded'
      : p <= 0 ? 'compact'
      : (target > p ? 'expanding' : 'collapsing');
  }

  function tick(now) {
    raf = 0;
    if (mode === 'spring') {
      const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const a = -2 * ZETA * W0 * v - W0 * W0 * (p - target);
      v += a * dt;
      p += v * dt;
      if (Math.abs(p - target) < 0.002 && Math.abs(v) < 0.03) {
        p = target; v = 0; mode = 'idle';
      }
    } else if (mode === 'shrink') {
      const t = Math.min(1, (now - t0) / SHRINK_MS);
      p = p0 * (1 - easeShrink(t));
      if (t >= 1) { p = target; mode = 'idle'; }
    }
    render();
    if (mode !== 'idle') raf = requestAnimationFrame(tick);
  }

  // ---- motion override via the window.desktop facade (M1b) --------------
  // Contract 2026-10-07: one machine-wide boolean; only an explicit
  // `animateAnyway` snapshot (motionOverride === true) may animate against
  // prefers-reduced-motion. A missing facade, a failed snapshot or
  // `respectSystemMotion` all leave this false — accessibility wins.
  let forceMotion = false;
  const applyMotionPref = snap => {
    forceMotion = !!(snap && snap.motionOverride === true);
  };
  if (window.desktop) {
    try { window.desktop.onState(applyMotionPref); } catch { /* facade optional */ }
    try { window.desktop.snapshot().then(applyMotionPref, () => {}); } catch { /* facade optional */ }
  }

  // Called from Rust (WebviewWindow::eval) after every core toggle.
  function setPhase(phase, nextEdge) {
    if (nextEdge === 'top' || nextEdge === 'bottom') edge = nextEdge;
    const t = phase === 'overview' ? 1 : 0;
    target = t;
    if ((reduced.matches && !forceMotion) || Math.abs(t - p) < 1e-9) {
      p = t; v = 0; mode = 'idle'; render(); return;
    }
    if (t === 1) { mode = 'spring'; last = 0; }
    else { mode = 'shrink'; t0 = performance.now(); p0 = p; }
    render();
    if (!raf) raf = requestAnimationFrame(tick);
  }
  window.__islandSetState = setPhase;
  window.__islandSetEdge = e => {
    if (e === 'top' || e === 'bottom') { edge = e; render(); }
  };

  // ---- frontend evidence for the read-back probe -------------------------
  function reportEvidence(attempt) {
    if (!invoke) return;
    const svgs = clayEl.querySelectorAll('*').length;
    const canvases = document.querySelectorAll('canvas').length;
    const revision = typeof AbitoClay !== 'undefined' ? AbitoClay.REVISION : 'unavailable';
    try {
      invoke('record_frontend_evidence', { svgs, canvases, revision }).catch(err => {
        console.error('record_frontend_evidence failed', err);
        if (attempt < 3) setTimeout(() => reportEvidence(attempt + 1), 500);
      });
    } catch (err) {
      console.error('record_frontend_evidence threw', err);
      if (attempt < 3) setTimeout(() => reportEvidence(attempt + 1), 500);
    }
  }

  // ---- pointer tracking (webview reports; Rust decides) ------------------
  let pressed = false;
  let lastPoint = { x: 0, y: 0 };
  const send = (cmd, args) => {
    if (!invoke) return;
    try { invoke(cmd, args).catch(err => console.error(cmd, err)); }
    catch (err) { console.error(cmd, err); }
  };
  const release = (pt, cancelled) => {
    if (!pressed) return;
    pressed = false;
    document.body.classList.remove('is-dragging');
    send('drag_release', { x: pt.x, y: pt.y, cancelled });
  };
  window.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    // Interactive elements own their clicks: a press on the dismiss button
    // must not drag or toggle the island (Rust still owns every decision).
    if (e.target && e.target.closest && e.target.closest('button')) return;
    pressed = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    document.body.classList.add('is-dragging');
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); }
    catch { /* pointer capture is best-effort; X11 has an implicit grab */ }
    send('drag_press', { x: e.clientX, y: e.clientY });
  });
  window.addEventListener('pointermove', e => {
    if (!pressed) return;
    lastPoint = { x: e.clientX, y: e.clientY };
    send('drag_move', { x: e.clientX, y: e.clientY });
  });
  window.addEventListener('pointerup', e => release({ x: e.clientX, y: e.clientY }, false));
  window.addEventListener('pointercancel', e => release({ x: e.clientX, y: e.clientY }, true));
  // Focus loss mid-drag (e.g. alt-tab): reconcile without toggling.
  window.addEventListener('blur', () => release(lastPoint, true));

  // ---- notices (M2): DISPLAY text only ---------------------------------
  // Sileo-style local notice in the island, own code, total silence: the
  // snapshot carries the text, this block renders it, and nothing here ever
  // decides, approves or opens anything. `dismiss` only clears what is
  // shown; the approval card above is the ONLY thing that can reach
  // `/execute`, and only through a trusted human click.
  const noticesEl = $('notices');
  const connectionEl = $('connection');
  const noticeTitle = $('notice-title');
  const noticeDetail = $('notice-detail');
  const noticeCount = $('notice-count');
  const noticeDismiss = $('notice-dismiss');

  function renderNotices(snapshot) {
    if (!snapshot || !noticesEl) return;
    const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
    const first = notices[0] || null;
    const unavailable = snapshot.unavailable === true;
    const connections = typeof snapshot.connections === 'number' ? snapshot.connections : 0;
    connectionEl.textContent = unavailable ? 'Avisos locales no disponibles.'
      : connections > 0 ? 'Conexión local activa · identidad declarada como Pi.'
      : 'Sin conexión con Pi.';
    noticeTitle.textContent = first ? first.title
      : unavailable ? 'Avisos locales no disponibles'
      : connections > 0 ? 'Sin avisos nuevos' : 'Sin conexión con Pi.';
    noticeDetail.textContent = first ? (first.detail || '')
      : unavailable ? 'El canal local de avisos no pudo iniciarse. No se hizo ninguna conexión con Pi.'
      : connections > 0
        ? 'La conexión está activa. Esto no confirma que Pi esté trabajando ni que una tarea haya terminado.'
        : 'Los avisos están disponibles solo si conectas una sesión de Pi de forma explícita.';
    noticeCount.textContent = first
      ? `${notices.length} aviso${notices.length === 1 ? '' : 's'} reciente${notices.length === 1 ? '' : 's'} · se descartan al minuto`
      : '';
    noticeDismiss.hidden = !first;
    noticesEl.hidden = false;
  }
  if (window.desktop) {
    try { window.desktop.onState(snapshot => { current = snapshot; renderNotices(snapshot); renderCard(); }); } catch { /* facade optional */ }
    try { window.desktop.snapshot().then(snapshot => { current = snapshot; renderNotices(snapshot); renderCard(); }, () => {}); } catch { /* facade optional */ }
  }
  if (noticeDismiss) {
    noticeDismiss.addEventListener('click', event => {
      event.preventDefault();
      // Wired with M2: clears the first notice; a dismissal is never a
      // decision and never reaches Pi as approval.
      try { window.desktop && window.desktop.dismiss().then(renderNotices, () => {}); } catch { /* facade optional */ }
    });
  }

  // ---- approval card (M3): DISPLAY only; the host is the boundary ------
  // The card fields come from the snapshot; the renderer sends NOTHING but
  // the human's click (`allow`/`deny`, zero arguments — never an id or a
  // hash). Rust re-validates card id, expiry and payload_hash before any
  // `/execute`. A notice never approves anything, an untrusted event never
  // reaches the host, and controls are locked while a decision is in
  // flight. Ported guards from the legacy renderer.js (validCard shape +
  // calendar, cardFeedback reasons, isTrusted + flight lock).
  let current = null;
  let cardFlight = null;
  let cardFailure = null;

  function validCard(card) {
    if (!card || Array.isArray(card) || Object.keys(card).sort().join(',') !== 'expires_at,operation,reason,state' ||
      typeof card.operation !== 'string' || !card.operation.trim() || card.operation.length > 120 ||
      /[\x00-\x1f\x7f-\x9f]/.test(card.operation) || typeof card.expires_at !== 'string') return false;
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(card.expires_at);
    if (!parts || parts[0] !== card.expires_at || !Number.isFinite(Date.parse(card.expires_at))) return false;
    const [, y, m, d, h, min, s, oh, om] = parts;
    const leap = +y % 4 === 0 && (+y % 100 !== 0 || +y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return +m >= 1 && +m <= 12 && +d >= 1 && +d <= days[+m - 1] && +h <= 23 && +min <= 59 &&
      +s <= 59 && (oh === undefined || (+oh <= 23 && +om <= 59)) &&
      ((card.state === 'pending' && card.reason === null) ||
        (card.state === 'inert' && typeof card.reason === 'string' && Boolean(card.reason.trim())));
  }
  function cardKey(card) { return JSON.stringify([card.operation, card.expires_at]); }
  function cardFeedback(card) {
    if (card.state === 'inert') return card.reason;
    if (Date.now() >= Date.parse(card.expires_at)) return 'Propuesta vencida.';
    if (cardFlight) return 'Decisión en curso.';
    if (cardFailure && cardFailure.key === cardKey(card) && current.revision <= cardFailure.revision)
      return 'No se pudo confirmar la decisión. Esperá una actualización.';
    if (current.state !== 'expanded' || capsule.dataset.phase !== 'expanded') return 'Abrí la tarjeta para decidir.';
    return null;
  }
  function renderCard() {
    const card = current && current.card;
    const valid = validCard(card);
    const permission = $('permission');
    if (!permission) return;
    permission.hidden = !valid;
    for (const id of ['operation', 'expiry', 'card-state', 'card-reason']) { const el = $(id); if (el) el.textContent = ''; }
    const expiry = $('expiry');
    if (expiry) expiry.removeAttribute('datetime');
    const allow = $('allow'), deny = $('deny');
    if (allow) allow.disabled = true;
    if (deny) deny.disabled = true;
    if (!valid) return;
    $('operation').textContent = card.operation;
    expiry.textContent = card.expires_at;
    expiry.setAttribute('datetime', card.expires_at);
    const reason = cardFeedback(card);
    $('card-state').textContent = reason ? 'No disponible' : 'Pendiente';
    $('card-reason').textContent = reason || '';
    $('card-reason').hidden = !reason;
    allow.disabled = deny.disabled = Boolean(reason || cardFlight);
  }
  async function decideCard(verb, event) {
    renderCard(); // Recheck expiry/phase even without a newer snapshot.
    const card = current && current.card;
    if (event.isTrusted !== true || !validCard(card) || cardFeedback(card) || cardFlight) return;
    const intent = { key: cardKey(card), revision: current.revision };
    cardFlight = intent;
    renderCard(); // Lock BOTH controls before invoking the host verb.
    try {
      const state = await window.desktop[verb](); // zero arguments; never a proposal id
      cardFlight = null;
      if (state && Number.isSafeInteger(state.revision) && state.revision > intent.revision &&
        state.revision > current.revision) {
        current = state;
        renderCard();
        renderNotices(state);
      } else if (validCard(current.card) && cardKey(current.card) === intent.key && current.card.state === 'pending')
        cardFailure = { key: intent.key, revision: current.revision };
    } catch {
      cardFlight = null;
      if (validCard(current.card) && cardKey(current.card) === intent.key)
        cardFailure = { key: intent.key, revision: current.revision };
    }
    renderCard(); // Never blindly revive controls or infer success.
  }
  const allowButton = $('allow');
  const denyButton = $('deny');
  if (allowButton) allowButton.addEventListener('click', event => { void decideCard('allow', event); });
  if (denyButton) denyButton.addEventListener('click', event => { void decideCard('deny', event); });

  // ---- boot ---------------------------------------------------------------
  render();
  renderCard();
  requestAnimationFrame(() => reportEvidence(0));
})();
