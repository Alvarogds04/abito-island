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
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'); // the SYSTEM value: informative only (#304)
  // #304: Abito's own motion state. Default «full»: the system preference is honored
  // only when the human opted in (snapshot.motionOverride === false). Every snap /
  // animate decision, the CSS (html[data-motion]) and the frozen engine follow it.
  let honorSystem = false;
  const motionReduced = () => window.AbitoOverview.motionState({ systemReduced: reduced.matches, honorSystem }) === 'reduce';
  const applyMotion = () => {
    document.documentElement.dataset.motion = motionReduced() ? 'reduce' : 'full';
    if (typeof AbitoClay !== 'undefined' && AbitoClay.forced !== !honorSystem) AbitoClay.setForced(!honorSystem);
  };
  reduced.addEventListener('change', applyMotion);

  // Visible island geometry per state. Native windows: 78x78 compact (the dot plus
  // a 6px transparent margin) and 672x176 overview (set by Rust); margins are the
  // difference. #302: the resting island is gentle-dot's ROUND DOT, a 66px disc
  // (geometry::DOT_DIAMETER); the character fills it. Drag, snap and edge memory
  // are Rust's and only ever see the native rectangle.
  const COMPACT = { w: 66, h: 66, r: 33, gap: 6, clay: 54, drop: 2 };
  // UI.1: R6 is 128px at the left of the plain overview and 72px while the
  // approval card is shown (only scale/position; the engine is frozen).
  const OVERVIEW = { w: 640, h: 160, r: 22, gap: 8, clay: 140, drop: 0, clayX: 82 };
  const OVERVIEW_CARD = { clay: 80, clayX: 62 };
  // The engine draws its body ~112 viewBox units wide inside its 200x160
  // canvas (measured from the captures), so a box of 128px shows a ~70px
  // character. In the overview the SVG viewBox is tightened (attribute only,
  // engine bytes untouched) so box 136 shows ~127px and box 77 shows ~72px.
  const R6_VISIBLE_UNITS = 112;
  const BASE_VB = [0, 20, 200, 160];
  const OVERVIEW_VB = [36, 32, 128, 128];
  // #309: the chat is a vertical COLUMN of the SAME expanded island. Its size arrives from Rust
  // (geometry::chat_visible through __islandSetView; the height follows the work area); this is
  // only the pre-first-push default and must match geometry::CHAT_COLUMN_W / CHAT_PREFERRED_H.
  // §5: the character is ~40px VISIBLE in the chat header: with the tight framing
  // (128 units show ~112) a 46px box shows ~40px.
  const CHAT = { w: 400, h: 640, r: 22, clay: 46, clayLeft: 34, clayTop: 3 };

  // Tauri IPC bridge (app.withGlobalTauri in tauri.conf.json).
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;

  // ---- frozen R6 ---------------------------------------------------------
  let clay = null;
  if (typeof AbitoClay !== 'undefined') {
    clay = AbitoClay.create(clayEl, { seed: 505, viewBox: '0 20 200 160' });
  }
  applyMotion(); // from the first frame: Abito's own motion state, never the inherited one (#304)

  // ---- R6 pose (Q2): only REAL events drive it, through the engine's own
  // setState (no new poses, no redraw). Sources: the chat lane (chat.js
  // dispatches `abito:pose`: think/speak/error while a turn or the model is in
  // that state) and the human's decision once the host says it was SENT
  // A SENT decision keeps the character at rest (O.gestureFor): confirm/reject
  // wait for a real host confirmation.
  let chatPose = null;
  let hostPose = null; // host failures (bridge/transport) — time-boxed by O.hostPoseView
  let hostTracker = { failing: false, since: 0 };
  let hostTimer = 0;
  function refreshHost(snapshot) {
    if (!O) return;
    const r = O.hostPoseView(snapshot, hostTracker, Date.now());
    hostTracker = r.tracker;
    hostPose = r.pose;
    clearTimeout(hostTimer);
    if (r.pose && r.expiresAt) hostTimer = setTimeout(() => refreshHost(current), Math.max(50, r.expiresAt - Date.now() + 50));
    applyPose();
  }
  const POSES = new Set(['think', 'speak', 'error']);
  function applyPose() {
    // Priority (night review): active chat turn > time-boxed host error > the
    // chat's own error > rest (see O.choosePose).
    const next = O ? O.choosePose(chatPose, hostPose) : (chatPose || 'idle');
    if (clay && clay.state !== next) clay.setState(next);
  }
  document.addEventListener('abito:pose', event => {
    const state = event.detail;
    chatPose = POSES.has(state) ? state : null;
    applyPose();
  });

  // ---- motion (contract numbers, JS-driven per frame) --------------------
  const W0 = 2 * Math.PI / 0.5; // spring response: 0.5 s
  const ZETA = 0.72;             // spring damping ratio: 0.72
  const SHRINK_MS = 340;         // shrink duration: 340 ms
  const easeShrink = cubicBezier(0.45, 0, 0.2, 1);

  let cardShown = false; // UI.1: a valid approval card is on screen
  let questionShown = false; // N6: a Pi question/notification is on screen (R6 shrinks like with a card)
  let p = 0;            // progress 0 = compact, 1 = overview
  let v = 0;            // spring velocity
  let target = 0;
  let mode = 'idle';    // 'idle' | 'spring' | 'shrink'
  let t0 = 0, p0 = 0, last = 0, raf = 0;
  let edge = 'top';     // docked vertical edge (mirrors the Rust state)
  // U1: second channel, 0 = overview, 1 = chat (same contract motion).
  const q = { x: 0, v: 0, target: 0, mode: 'idle', t0: 0, x0: 0, last: 0 };

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
    const w = lerp(COMPACT.w, lerp(OVERVIEW.w, CHAT.w, q.x), p);
    const h = lerp(COMPACT.h, lerp(OVERVIEW.h, CHAT.h, q.x), p);
    const r = lerp(COMPACT.r, OVERVIEW.r, p);
    const gap = lerp(COMPACT.gap, OVERVIEW.gap, p);
    const ov = (cardShown || questionShown) ? OVERVIEW_CARD : OVERVIEW;
    const cs = lerp(COMPACT.clay, ov.clay, p);
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
    // R6 is only scaled and positioned (never redrawn): centred in the
    // overview, small at the left of the header in the chat view.
    const csv = lerp(cs, CHAT.clay, q.x);
    const overviewTop = lerp(COMPACT.h, OVERVIEW.h, p) / 2 - drop - cs / 2;
    const z = 1; // tight framing in the dot, the overview AND the chat (the dot's character fills the disc, #302)
    clayEl.setAttribute('viewBox', BASE_VB.map((b, i) => +(b + (OVERVIEW_VB[i] - b) * z).toFixed(2)).join(' '));
    clayEl.style.width = csv + 'px';
    clayEl.style.height = csv + 'px';
    clayEl.style.left = lerp(lerp(w / 2, ov.clayX, p), CHAT.clayLeft, q.x) + 'px';
    clayEl.style.top = lerp(overviewTop, CHAT.clayTop, q.x) + 'px';
    capsule.dataset.edge = edge;
    capsule.dataset.view = q.target === 1 ? 'chat' : 'overview';
    // M1 semantics unchanged: expanded as soon as the island reached it
    // (spring overshoot included); the chat is a VIEW of the expanded phase.
    let phase = 'collapsing';
    if (p >= 1) phase = 'expanded';
    else if (p <= 0) phase = 'compact';
    else if (target > p) phase = 'expanding';
    capsule.dataset.phase = phase;
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
    if (q.mode === 'spring') {
      const dt = Math.min(1 / 30, q.last ? (now - q.last) / 1000 : 1 / 60);
      q.last = now;
      const a = -2 * ZETA * W0 * q.v - W0 * W0 * (q.x - q.target);
      q.v += a * dt;
      q.x += q.v * dt;
      if (Math.abs(q.x - q.target) < 0.002 && Math.abs(q.v) < 0.03) {
        q.x = q.target; q.v = 0; q.mode = 'idle';
      }
    } else if (q.mode === 'shrink') {
      const t = Math.min(1, (now - q.t0) / SHRINK_MS);
      q.x = q.target + (q.x0 - q.target) * (1 - easeShrink(t));
      if (t >= 1) { q.x = q.target; q.mode = 'idle'; }
    }
    render();
    if (mode !== 'idle' || q.mode !== 'idle') raf = requestAnimationFrame(tick);
  }

  // U1: move the chat channel with the contract motion (grow = spring,
  // shrink = 340 ms curve, reduced motion snaps).
  function moveView(t) {
    q.target = t;
    if (motionReduced() || Math.abs(t - q.x) < 1e-9) {
      q.x = t; q.v = 0; q.mode = 'idle'; return;
    }
    if (t > q.x) { q.mode = 'spring'; q.last = 0; }
    else { q.mode = 'shrink'; q.t0 = performance.now(); q.x0 = q.x; }
  }

  // ---- motion override via the window.desktop facade (M1b) --------------
  // Contract 2026-10-07: one machine-wide boolean; only an explicit
  // `animateAnyway` snapshot (motionOverride === true) may animate against
  // prefers-reduced-motion. A missing facade, a failed snapshot or
  // `respectSystemMotion` all leave this false — accessibility wins.
  const applyMotionPref = snap => {
    honorSystem = window.AbitoOverview.honorSystemMotion(snap);
    applyMotion(); // CSS state + the frozen engine (forced unless the human honors the system)
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
    // A collapse always leaves the chat view (Rust resets it too).
    if (t === 0) moveView(0);
    if (motionReduced() || Math.abs(t - p) < 1e-9) {
      p = t; v = 0; mode = 'idle'; render();
      if (q.mode !== 'idle' && !raf) raf = requestAnimationFrame(tick);
      return;
    }
    if (t === 1) { mode = 'spring'; last = 0; }
    else { mode = 'shrink'; t0 = performance.now(); p0 = p; }
    render();
    if (!raf) raf = requestAnimationFrame(tick);
  }
  window.__islandSetState = setPhase;
  // U1: called from Rust (chathost::apply_view) with the chat height from
  // geometry::CHAT_VISIBLE — the frontend never owns that number.
  window.__islandSetView = (view, vw, vh) => {
    if (Number.isInteger(vw) && Number.isInteger(vh) && vw > 0 && vh > 0) { CHAT.w = vw; CHAT.h = vh; }
    moveView(view === 'chat' ? 1 : 0);
    render();
    if (q.mode !== 'idle' && !raf) raf = requestAnimationFrame(tick);
    document.dispatchEvent(new CustomEvent('island:view', { detail: view === 'chat' ? 'chat' : 'overview' }));
  };
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
    // U1: so do the composer, the transcript (text selection) and links of
    // the chat — drag never attaches to text or composer controls.
    if (e.target && e.target.closest && e.target.closest('button, textarea, input, #chat-log, #chat-composer')) return;
    pressed = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    document.body.classList.add('is-dragging');
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); }
    catch { /* pointer capture is best-effort; X11 has an implicit grab */ }
    send('drag_press', { x: e.clientX, y: e.clientY });
  });
  // §9.2 hover on the character: scale only (pure O.hoverScale), no state.
  function updateHover(point) {
    if (!O) return;
    const r = clayEl.getBoundingClientRect();
    // the box is already scaled by --hover: test against the unscaled centre box
    const scale = parseFloat(clayEl.style.getPropertyValue('--hover')) || 1;
    const w = r.width / scale, h = r.height / scale;
    const box = { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    const next = O.hoverScale(point, box, { reduced: motionReduced(), dragging: pressed });
    if (next !== scale) clayEl.style.setProperty('--hover', String(next));
  }
  window.addEventListener('pointermove', e => {
    if (!pressed) { updateHover({ x: e.clientX, y: e.clientY }); return; }
    updateHover(null);
    lastPoint = { x: e.clientX, y: e.clientY };
    send('drag_move', { x: e.clientX, y: e.clientY });
  });
  document.addEventListener('pointerleave', () => updateHover(null));
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
  const noticePill = $('notice-pill');
  const noticeInfo = $('notice-info');
  const O = window.AbitoOverview;
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // Static own icons: closed registry, never data.
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

  // «i» buttons reveal the long sentence that used to be on screen (§2.1);
  // the same text is also the aria name/description of the chip.
  function toggleInfo(button, panel, force) {
    const open = force === undefined ? button.getAttribute('aria-expanded') !== 'true' : force;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
    return open;
  }
  if (noticeInfo) noticeInfo.addEventListener('click', () => toggleInfo(noticeInfo, noticeDetail));

  // Q1: polite announcement of a NEW notice (once), plain text.
  const noticeLive = $('notice-live');
  let lastNoticeId = null;
  // #313: the sound wiring (sound-wiring.js) is optional: no engine, no cue, no error.
  function soundCue(method, arg) {
    const w = window.AbitoSoundWiringInstance;
    try { if (w && typeof w[method] === 'function') w[method](arg); } catch { /* sound never breaks the island */ }
  }
  function announceNotice(notices) {
    const V = window.AbitoChatView;
    if (!V || !noticeLive) return;
    const text = V.noticeAnnouncement(lastNoticeId, notices);
    lastNoticeId = notices.length ? notices[0].id : null;
    if (text) {
      noticeLive.textContent = '';
      requestAnimationFrame(() => { noticeLive.textContent = text; });
    }
  }

  function paintRing(notices) {
    const view = O && O.noticeView(notices, Date.now());
    if (view) $('notice-ring').innerHTML = ICONS.ring(view.fraction);
    return view;
  }
  function renderNotices(snapshot) {
    if (!snapshot || !noticesEl || !O) return;
    const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
    announceNotice(notices);
    soundCue('observeNotices', notices); // #313: only a NEW top notice sounds, never the ones already there at start-up
    const conn = O.connectionView(snapshot);
    connectionEl.dataset.tone = conn.tone;
    connectionEl.setAttribute('aria-label', conn.aria);
    $('connection-icon').innerHTML = icon(conn.icon);
    $('connection-word').textContent = conn.word;
    const bridge = O.bridgeView(snapshot);
    const bridgeChip = $('bridge');
    bridgeChip.hidden = !bridge;
    if (bridge) {
      bridgeChip.dataset.tone = bridge.tone;
      bridgeChip.setAttribute('aria-label', bridge.aria);
      $('bridge-icon').innerHTML = icon(bridge.icon);
      $('bridge-word').textContent = bridge.word;
    }
    const first = notices[0] || null;
    const view = paintRing(notices);
    noticePill.hidden = !view;
    if (view) {
      noticePill.setAttribute('aria-label', view.aria);
      noticeTitle.textContent = view.text;
      noticeCount.textContent = String(view.badge);
    }
    noticeDetail.textContent = first ? `${first.title}. ${first.detail || ''}`.trim() : (bridge ? `${conn.detail} ${bridge.detail}` : conn.detail);
    noticeInfo.setAttribute('aria-label', O.infoLabel(first ? 'Ver detalle del aviso' : 'Ver detalle de la conexión', first ? view.aria : conn.aria));
    noticeDismiss.hidden = !first;
    noticesEl.hidden = false;
    paintCardConn(conn, bridge);
  }
  // §3: the card hides the notices strip, so a missing Pi / downed channel
  // stays visible beside it (icon + word; nothing when healthy).
  function paintCardConn(conn, bridge) {
    const bchip = $('card-bridge');
    if (bchip) {
      bchip.hidden = !bridge;
      if (bridge) {
        bchip.dataset.tone = bridge.tone;
        bchip.setAttribute('aria-label', bridge.aria);
        $('card-bridge-icon').innerHTML = icon(bridge.icon);
        $('card-bridge-word').textContent = bridge.word;
      }
    }
    const chip = $('card-conn');
    if (!chip) return;
    const shown = O.cardConnection(conn);
    chip.hidden = !shown;
    if (!shown) return;
    chip.dataset.tone = shown.tone;
    chip.setAttribute('aria-label', shown.aria);
    $('card-conn-icon').innerHTML = icon(shown.icon);
    $('card-conn-word').textContent = shown.word;
  }
  if (window.desktop) {
    try { window.desktop.onState(snapshot => { current = snapshot; refreshHost(snapshot); renderNotices(snapshot); renderCard(); }); } catch { /* facade optional */ }
    try { window.desktop.snapshot().then(snapshot => { current = snapshot; refreshHost(snapshot); renderNotices(snapshot); renderCard(); soundCue('firstSnapshotRendered'); }, () => {}); } catch { /* facade optional */ }
  }
  // #305: the global shortcut status (READ only: changing it is the settings panel's job, #308).
  function paintHotkey(view) {
    const chip = $('hotkey');
    const h = O && O.hotkeyView(view);
    chip.hidden = !h;
    if (!h) return;
    chip.dataset.tone = h.tone;
    chip.setAttribute('aria-label', h.aria);
    $('hotkey-icon').innerHTML = icon(h.icon);
    $('hotkey-word').textContent = h.word;
  }
  if (invoke) {
    invoke('hotkey_action', { payload: { action: 'view' } }).then(paintHotkey, () => {});
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (listen) listen('hotkey:state', event => paintHotkey(event && event.payload)).catch(() => {});
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
    if (current.state !== 'expanded' || capsule.dataset.phase !== 'expanded' ||
      capsule.dataset.view !== 'overview') return 'Abrí la tarjeta para decidir.';
    return null;
  }
  function paintExpiry(card) {
    const now = Date.now();
    const expiry = $('expiry');
    expiry.textContent = O.expiryLabel(card.expires_at, now);
    expiry.setAttribute('datetime', card.expires_at);
    $('card-expiry').setAttribute('aria-label', O.expiryAria(card.expires_at, now));
  }
  // UI.2 §6 compact indicator: waiting card -> sun dot, channel down -> red
  // triangle. Pure shape+colour; the accessible name says what it means.
  function paintCompactFlag() {
    const flag = $('compact-flag');
    if (!flag) return;
    const card = current && current.card;
    const waiting = validCard(card) && Date.now() < Date.parse(card.expires_at) &&
      (card.state === 'pending' || card.reason === 'Abrí la tarjeta para decidir.'); // covered = still waiting for you
    const questionWaiting = !!(capsule.dataset.question === 'pending');
    const bridgeDown = !!(O && O.bridgeView(current));
    const down = !!(current && current.unavailable === true) || bridgeDown;
    flag.hidden = !(waiting || questionWaiting || down);
    if (flag.hidden) return;
    flag.dataset.tone = (waiting || questionWaiting) ? 'sun' : 'red';
    flag.setAttribute('aria-label', questionWaiting && !waiting ? 'Pi espera tu respuesta' : waiting ? 'Algo espera tu decisión' : (bridgeDown ? 'Sin puente' : 'Avisos caídos'));
    $('compact-flag-icon').innerHTML = (waiting || questionWaiting) ? '<span class="dot"></span>' : icon('triangle');
  }
  function renderCard() {
    paintCompactFlag();
    const card = current && current.card;
    const valid = validCard(card);
    soundCue('observeCard', valid && card.state === 'pending' && typeof card.id === 'string' ? card.id : null); // #313: a card BECOMING pending
    const permission = $('permission');
    if (!permission || !O) return;
    permission.hidden = !valid;
    for (const id of ['operation', 'expiry', 'card-status-word', 'card-reason']) { const el = $(id); if (el) el.textContent = ''; }
    $('expiry').removeAttribute('datetime');
    const allow = $('allow'), deny = $('deny');
    allow.disabled = true;
    deny.disabled = true;
    if (cardShown !== valid) { cardShown = valid; render(); }
    if (!valid) { delete capsule.dataset.card; delete capsule.dataset.cardTone; return; }
    const reason = cardFeedback(card);
    const view = O.cardView(reason);
    $('operation').textContent = card.operation;
    paintExpiry(card);
    $('card-expiry').hidden = view.kind === 'expired' || view.kind === 'sent';
    const status = $('card-status');
    status.dataset.tone = view.tone;
    status.dataset.kind = view.kind;
    status.setAttribute('aria-label', view.aria);
    $('card-status-icon').innerHTML = view.icon ? icon(view.icon) : '<span class="dot"></span>';
    $('card-status-word').textContent = view.word;
    capsule.dataset.card = view.kind;
    capsule.dataset.cardTone = view.tone;
    const detail = $('card-reason');
    detail.textContent = reason || '';
    detail.hidden = !reason;
    detail.classList.toggle('sr-only', $('card-info').getAttribute('aria-expanded') !== 'true');
    $('card-info').hidden = !reason;
    $('card-info').setAttribute('aria-label', O.infoLabel('Ver detalle de la decisión', view.aria));
    allow.disabled = deny.disabled = Boolean(reason || cardFlight);
  }
  const cardInfo = $('card-info');
  if (cardInfo) cardInfo.addEventListener('click', () => {
    const open = cardInfo.getAttribute('aria-expanded') !== 'true';
    cardInfo.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('card-reason').classList.toggle('sr-only', !open);
  });
  // The countdown texts (expiry label, 60 s ring) follow the clock without
  // touching the live regions.
  setInterval(() => {
    if (!current || !O) return;
    if (validCard(current.card)) paintExpiry(current.card);
    paintRing(Array.isArray(current.notices) ? current.notices : []);
    paintCompactFlag(); // an expired card must stop saying «waiting»
    refreshHost(current);
  }, 5000);
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

  // U1: the card's actionability depends on the visible view too.
  document.addEventListener('island:view', () => { if (current) renderCard(); });
  document.addEventListener('abito:question', event => {
    const show = !!(event.detail && event.detail.show);
    if (show !== questionShown) { questionShown = show; render(); }
    paintCompactFlag();
  });

  // ---- Q1: keyboard control of the island itself -------------------------
  // The island never takes focus by itself (tauri.conf focus:false, no
  // set_focus on restore). Once the human has focused it (click), Tab
  // reaches #island-toggle: Enter/Space opens the overview and moves focus
  // to its primary control; in the overview it closes. Escape (chat.js)
  // steps out of the composer, then closes.
  const toggleButton = $('island-toggle');
  let focusAfterPhase = null;
  function syncToggle(state) {
    if (!toggleButton) return;
    const open = state === 'expanded';
    toggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleButton.textContent = open ? 'Cerrar Abito' : 'Abrir Abito';
  }
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      if (!window.desktop) return;
      const open = current && current.state === 'expanded';
      focusAfterPhase = open ? 'island-toggle' : 'open-chat';
      (open ? window.desktop.close() : window.desktop.expand()).then(snap => {
        if (snap) { current = snap; syncToggle(snap.state); }
      }, () => {});
    });
  }
  // Move focus only after the visible phase settled (a hidden control
  // cannot take focus) and only after a keyboard request.
  new MutationObserver(() => {
    const phase = capsule.dataset.phase;
    if (!focusAfterPhase || (phase !== 'expanded' && phase !== 'compact')) return;
    const target = $(focusAfterPhase);
    focusAfterPhase = null;
    if (target) target.focus();
  }).observe(capsule, { attributes: true, attributeFilter: ['data-phase'] });
  if (window.desktop) {
    try { window.desktop.onState(s => syncToggle(s && s.state)); } catch { /* facade optional */ }
  }
  document.addEventListener('keydown', event => {
    // Escape that collapses the island returns focus to the island control.
    if (event.key === 'Escape' && capsule.dataset.phase === 'expanded' &&
      document.activeElement !== $('chat-input')) focusAfterPhase = 'island-toggle';
  }, true);

  // ---- boot ---------------------------------------------------------------
  render();
  renderCard();
  requestAnimationFrame(() => reportEvidence(0));
})();
