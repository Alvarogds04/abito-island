'use strict';
/* #486 desktop character page. Adapted from Coucou windows/src/desktop/main.ts @71b773f,
   Copyright (c) 2026 Louis Raillé, MIT. Draws Abito's clay character and forwards the pointer to
   the closed Rust verbs; where the window is, and what happens on a drop, is Rust's decision. */
(() => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;
  const svg = document.getElementById('clay');
  const call = (name, args) => (invoke ? invoke(name, args).catch(() => undefined) : Promise.resolve(undefined));
  let clay = null;
  try {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clay = window.AbitoClay.create(svg, { state: 'idle', live: !reduce, viewBox: '36 32 128 128', shadow: false });
  } catch { /* the character is decoration; the window still drags */ }
  const DRAG_THRESHOLD = 3; // Coucou DRAG_THRESHOLD
  let press = null;
  let dragging = false;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY, id: e.pointerId };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (!dragging) {
      if (Math.hypot(e.screenX - press.x, e.screenY - press.y) <= DRAG_THRESHOLD) return;
      dragging = true;
      svg.classList.add('dragging');
      call('character_drag_begin', { x: press.x, y: press.y });
    }
    call('character_drag_move', { x: e.screenX, y: e.screenY });
  });
  const release = e => {
    if (!press || e.pointerId !== press.id) return;
    const was = dragging;
    press = null;
    dragging = false;
    svg.classList.remove('dragging');
    if (was) call('character_drag_end', {});
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('dblclick', () => call('character_home', {}));
  window.addEventListener('beforeunload', () => { try { if (clay) clay.destroy(); } catch { /* ignore */ } });
})();
