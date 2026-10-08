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
   No window.desktop bridge (M1b), no sounds, no Coucou assets. */
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

  // Called from Rust (WebviewWindow::eval) after every core toggle.
  function setPhase(phase, nextEdge) {
    if (nextEdge === 'top' || nextEdge === 'bottom') edge = nextEdge;
    const t = phase === 'overview' ? 1 : 0;
    target = t;
    if (reduced.matches || Math.abs(t - p) < 1e-9) {
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

  // ---- boot ---------------------------------------------------------------
  render();
  requestAnimationFrame(() => reportEvidence(0));
})();
