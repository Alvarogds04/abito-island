'use strict';
/* Sileo-style toast for a NEW question / permission (human request: «una notificación con sileo» below the island).
   Port of the LOOK and MOTION of hiaaryan/sileo (MIT) in vanilla JS: a 350x40 pill that morphs into a body through a gooey SVG
   filter (feGaussianBlur + feColorMatrix), spring easing as CSS linear(), badge + title header, body on expand. No React, no npm.
   It NEVER answers anything: it only shows «<Agente> pregunta» + the first line, and a trusted click asks the island to open
   on that question (the question card is the only place that answers). Pure view functions first (Node tests), DOM mount last.
   Loaded as a classic script (window.AbitoQuestionToast) and by test-node/question-toast-check.cjs. */
(function (root, factory) {
  const N = typeof module === 'object' && module.exports ? require('./notify-view.js') : root.AbitoNotify;
  const api = factory(N);
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AbitoQuestionToast = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, N => {
  // Sileo: HEIGHT 40, WIDTH 350. hMax = pill + the expanded body, the area the host's input region must cover.
  const TOAST = Object.freeze({ w: 350, h: 40, hMax: 96, gap: 0, bodyMax: 120, ms: 8000 }); // S13: an action toast closes after 8 s (info would be 3-5 s); hover/focus pause it

  const firstLine = text => {
    const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim());
    const line = lines.find(Boolean) || '';
    return line.length > TOAST.bodyMax ? `${line.slice(0, TOAST.bodyMax - 1)}…` : line;
  };

  /** The toast for the pending question, or null. ctx: { now, onScreen (the card is visible), dismissedId }. */
  function toastView(snapshot, ctx) {
    const c = ctx || {};
    const s = snapshot && snapshot.available !== false ? snapshot : null;
    const n = s && N.fromPending(s.pending);
    if (!n) return null;
    const now = Number.isFinite(c.now) ? c.now : Date.now();
    if (N.expired(n.expiresAt, now) || c.onScreen === true || c.dismissedId === n.id) return null;
    const body = firstLine(n.text);
    if (!body) return null;
    const approval = n.kind === 'approval';
    const name = N.askerName(n);
    const steps = Array.isArray(n.form) ? n.form.length : 0;
    const title = approval ? `${name} pide permiso` : `${name} pregunta${steps ? ` (${steps} ${steps === 1 ? 'pregunta' : 'preguntas'})` : ''}`;
    const queued = Number.isInteger(s.queued_count) && s.queued_count > 0 ? s.queued_count : 0;
    const queue = queued ? `1 de ${queued + 1}` : null;
    return { id: n.id, kind: n.kind, tone: approval ? 'warning' : 'action', icon: approval ? 'lock' : 'bubble', title, body, queue,
      aria: `${title}: ${body}${queue ? ` (${queue})` : ''}. Abrir la isla para responder.` };
  }

  /** A trusted click asks to open the island on this question. The id only; no answer, no option. */
  const openRequest = (event, view) => (event && event.isTrusted === true && view && view.id ? { id: view.id } : null);

  /** The host input region is one rectangle: grow the reported island shape to include the toast. */
  const shapeWithToast = (shape, shown) => (shown
    ? [Math.max(shape[0], TOAST.w), shape[1] + TOAST.gap + TOAST.hMax] : [shape[0], shape[1]]);

  /** A new question used to expand the island by itself; now the toast is the signal while compact. */
  const revealByToast = ctx => !ctx || ctx.phase !== 'expanded';

  // ---- Sileo's motion (hiaaryan/sileo, MIT): constants.ts SPRING = { duration 0.6 s, bounce 0.25 }, sileo.tsx morph ------------------
  const SPRING = Object.freeze({ duration: 0.6, bounce: 0.25 });
  /** motion's spring(): fraction of the travel done after `t` seconds (0 -> 1, a little overshoot). damping ratio = 1 - bounce. */
  function springAt(t, spring) {
    if (!Number.isFinite(t) || t <= 0) return 0;
    const sp = spring || SPRING;
    const zeta = Math.min(1, Math.max(0, 1 - sp.bounce)), w0 = (2 * Math.PI) / sp.duration;
    if (t > sp.duration * 6) return 1;
    if (zeta >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  const lerp = (a, b, p) => a + (b - a) * p;
  const NECK_H = 12, START_H = 6;
  /**
   * The SVG geometry for one frame (x/y in the toast's own space: y = 0 is the island's bottom edge, x = 0 its left axis of a 350 box).
   * At progress 0 the pill is exactly the island's flat bottom edge (the `neck`), so the gooey filter joins them with no gap; the
   * spring then widens it to the content-wide pill and drops it to 40px, centred. `open` unfolds the 350px body below the pill.
   * progress may exceed 1 (the spring overshoot). Reduced motion skips the travel: the final geometry at once.
   */
  function morphFrame(o) {
    const island = o.island || { w: 288, r: 14 };
    const pillW = Math.min(TOAST.w, Math.max(TOAST.h, Number.isFinite(o.pillW) ? o.pillW : TOAST.h));
    const p = o.reduce ? 1 : (Number.isFinite(o.progress) ? o.progress : 0);
    const edgeW = Math.max(TOAST.h, island.w - 2 * island.r);
    const width = lerp(edgeW, pillW, p), height = lerp(START_H, TOAST.h, p);
    const bodyH = TOAST.hMax - TOAST.h;
    return {
      neck: { x: (TOAST.w - edgeW) / 2, y: -NECK_H, width: edgeW, height: NECK_H },
      pill: { x: (TOAST.w - width) / 2, y: lerp(-START_H, 0, p), width, height },
      body: { x: 0, y: TOAST.h, width: TOAST.w, height: o.open ? lerp(0, bodyH, p) : 0 },
    };
  }
  const motionPlan = reduce => (reduce ? { mode: 'fade', springs: false } : { mode: 'morph', springs: true });
  /** The toast hangs from the island's own bottom edge (its box in the capsule): flush, and it follows the island as it grows. */
  const toastTop = box => (box && Number.isFinite(box.top) && Number.isFinite(box.height) ? box.top + box.height : 0);

  return { SPRING, springAt, morphFrame, motionPlan, toastTop, NECK_H, TOAST, toastView, openRequest, shapeWithToast, revealByToast, firstLine };
});

function mount(T) {
  const doc = document;
  const capsule = doc.getElementById('capsule');
  if (!capsule) return;
  const SVG = 'http://www.w3.org/2000/svg';
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const sv = (tag, attrs) => { const e = doc.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  // <button>: keyboard reachable (Tab, Enter/Space), one control, text only.
  const toast = mk('button', 'q-toast'); toast.id = 'question-toast'; toast.type = 'button'; toast.hidden = true;
  toast.dataset.sileoToast = 'true'; toast.dataset.state = 'action';
  // gooey canvas (Sileo): the island's bottom edge (neck), the pill and the body are blurred and thresholded so they melt into ONE
  // shape: the pill grows OUT of the island instead of sitting under it. y = 0 of the SVG is the island's bottom edge.
  const canvas = mk('div', 'q-toast-canvas'); canvas.setAttribute('aria-hidden', 'true');
  const H = T.TOAST.hMax + T.NECK_H;
  const svg = sv('svg', { width: String(T.TOAST.w), height: String(H), viewBox: `0 ${-T.NECK_H} ${T.TOAST.w} ${H}`, class: 'q-toast-svg' });
  const blur = 8; // Sileo: blur = roundness(16) * BLUR_RATIO(0.5)
  const defs = sv('defs'), filter = sv('filter', { id: 'q-toast-gooey', filterUnits: 'userSpaceOnUse', x: String(-blur * 2), y: String(-T.NECK_H - blur * 2), width: String(T.TOAST.w + blur * 4), height: String(H + blur * 4), 'color-interpolation-filters': 'sRGB' });
  filter.append(sv('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(blur), result: 'blur' }),
    sv('feColorMatrix', { in: 'blur', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10', result: 'goo' }),
    sv('feComposite', { in: 'SourceGraphic', in2: 'goo', operator: 'atop' }));
  defs.append(filter);
  const group = sv('g', { filter: 'url(#q-toast-gooey)' });
  const neckRect = sv('rect', { class: 'q-toast-neck', rx: '0' });
  const pillRect = sv('rect', { class: 'q-toast-pill', rx: '16', ry: '16' });
  const bodyRect = sv('rect', { class: 'q-toast-bodyrect', rx: '16', ry: '16' });
  group.append(neckRect, pillRect, bodyRect); svg.append(defs, group); canvas.append(svg);
  const header = mk('span', 'q-toast-header');
  const badge = mk('span', 'q-toast-badge'); badge.setAttribute('aria-hidden', 'true');
  const title = mk('span', 'q-toast-title'), queue = mk('span', 'q-toast-queue');
  const bar = mk('span', 'q-toast-progress'); bar.setAttribute('aria-hidden', 'true');
  header.append(badge, title, queue, bar);
  // S13: a polite live region announces the toast once (the toast itself is a button with its own label)
  const live = mk('p', 'sr-only'); live.id = 'question-toast-live'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  const content = mk('span', 'q-toast-content'); const bodyText = mk('span', 'q-toast-body'); content.append(bodyText);
  toast.append(canvas, header, content);
  capsule.append(toast, live);

  const icons = window.AbitoIcons;
  // like island.js: the parser only ever receives the CLOSED own registry's literal markup, never data
  const parser = new DOMParser();
  const paintIcon = name => {
    try {
      const markup = icons ? icons.svg(name) : '';
      const parsed = markup ? parser.parseFromString(markup, 'image/svg+xml').documentElement : null;
      badge.replaceChildren(...(parsed && parsed.nodeName === 'svg' ? [doc.importNode(parsed, true)] : []));
    } catch { badge.replaceChildren(); }
  };

  let snapshot = null, view = null, dismissedId = null, shownId = null, expandTimer = 0, collapseTimer = 0, hot = false;
  // S3: the widened compact pill carries the question itself (no separate toast); the toast stays for the hidden strip and the chat view
  const onScreen = () => (capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview' && !capsule.dataset.card)
    || (capsule.dataset.phase === 'compact' && capsule.dataset.compactAsk === 'true' && capsule.dataset.edgeHidden !== 'true');
  const reduced = () => doc.documentElement.dataset.motion === 'reduce' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clear = () => { clearTimeout(expandTimer); clearTimeout(collapseTimer); };
  // S13 countdown: remaining ms survive a pause (hover / focus); the bar is a CSS animation that pauses with it
  let closeTimer = 0, remaining = T.TOAST.ms, startedAt = 0, running = false;
  const stopClose = () => { clearTimeout(closeTimer); closeTimer = 0; };
  const runClose = () => {
    stopClose(); if (!view) return;
    running = true; startedAt = Date.now(); bar.style.animationPlayState = 'running';
    // v8: in the chat view and on the hidden strip the toast is the ONLY click target to the question, so the 8 s only FOLDS its body
    // (the pill stays); only Escape dismisses it
    closeTimer = setTimeout(() => { running = false; if (view) { setExpanded(false); bar.style.opacity = '0'; } }, Math.max(0, remaining));
  };
  const pauseClose = () => { if (!running) return; running = false; stopClose(); remaining = Math.max(0, remaining - (Date.now() - startedAt)); bar.style.animationPlayState = 'paused'; };
  const restartClose = () => { bar.style.opacity = ''; remaining = T.TOAST.ms; bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; bar.style.animationDuration = `${T.TOAST.ms}ms`; runClose(); };
  const island = doc.getElementById('island');
  const set = (el, o) => { for (const k of ['x', 'y', 'width', 'height']) el.setAttribute(k, String(Math.round(o[k] * 100) / 100)); };

  // ---- Sileo's motion: ONE spring clock drives the pill's width/height/position and the body, every frame -------------------
  const anim = { from: 0, to: 0, start: 0, raf: 0, open: false, pillW: T.TOAST.h, progress: 0, bodyProgress: 0, bodyFrom: 0, bodyTo: 0, bodyStart: 0 };
  const islandBox = () => {
    const box = island ? island.getBoundingClientRect() : null;
    const r = island ? parseFloat(getComputedStyle(island).borderBottomLeftRadius) : 14;
    return { box, w: box ? box.width : 288, r: Number.isFinite(r) ? r : 14 };
  };
  // The toast hangs from the island's REAL bottom edge: re-placed on every layout change of the island (its own spring included).
  function place() {
    const { box, w, r } = islandBox();
    toast.style.top = `${Math.round(T.toastTop(box ? { top: box.top - capsule.getBoundingClientRect().top, height: box.height } : null))}px`;
    paintFrame(w, r);
  }
  function paintFrame(w, r) {
    const f = T.morphFrame({ progress: anim.progress, island: { w, r }, pillW: anim.pillW, open: false, reduce: reduced() });
    const bodyP = reduced() ? anim.bodyTo : anim.bodyProgress;
    set(neckRect, f.neck); set(pillRect, f.pill);
    set(bodyRect, { x: 0, y: T.TOAST.h, width: T.TOAST.w, height: Math.max(0, (T.TOAST.hMax - T.TOAST.h) * bodyP) });
  }
  function frame(now) {
    anim.raf = 0;
    const t = (now - anim.start) / 1000;
    anim.progress = anim.from + (anim.to - anim.from) * T.springAt(t);
    const tb = (now - anim.bodyStart) / 1000;
    anim.bodyProgress = anim.bodyFrom + (anim.bodyTo - anim.bodyFrom) * T.springAt(tb, { duration: T.SPRING.duration, bounce: anim.bodyTo ? T.SPRING.bounce : 0 });
    place();
    if (t < T.SPRING.duration * 3 || tb < T.SPRING.duration * 3) anim.raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!anim.raf) anim.raf = requestAnimationFrame(frame); };
  // reduced motion: the toast does not travel, it fades in place (the CSS opacity transition); otherwise the spring morphs it out
  function morphTo(target) {
    anim.from = anim.progress; anim.to = target; anim.start = performance.now();
    if (T.motionPlan(reduced()).springs) kick(); else { anim.progress = target; place(); }
  }
  const setExpanded = open => {
    toast.dataset.expanded = open ? 'true' : 'false';
    toast.setAttribute('aria-expanded', open ? 'true' : 'false');
    anim.open = open; anim.bodyFrom = anim.bodyProgress; anim.bodyTo = open ? 1 : 0; anim.bodyStart = performance.now();
    if (T.motionPlan(reduced()).springs) kick(); else { anim.bodyProgress = anim.bodyTo; place(); }
  };
  // Follow the island every frame of ITS spring (it grows for a long question, shrinks, conceals): a ResizeObserver on the island
  // plus the capsule's own attribute changes. No fixed tracking window.
  if (island && typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!toast.hidden) place(); }).observe(island);
  if (island) new MutationObserver(() => { if (!toast.hidden) place(); }).observe(island, { attributes: true, attributeFilter: ['style'] });
  function render() {
    const next = T.toastView(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId });
    view = next;
    const visible = !!next;
    if (!visible) {
      clear(); stopClose(); running = false; shownId = null; setExpanded(false);
      if (!toast.hidden) {
        // leaving: the pill is pulled back INTO the island (the spring in reverse), then hidden
        toast.dataset.exiting = 'true'; morphTo(0);
        const done = () => { if (!view) { toast.hidden = true; delete toast.dataset.exiting; delete toast.dataset.ready; } };
        setTimeout(done, reduced() ? 0 : 320);
      }
      doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: false } }));
      return;
    }
    delete toast.dataset.exiting;
    toast.dataset.state = next.tone; toast.dataset.kind = next.kind;
    title.textContent = next.title; queue.textContent = next.queue || ''; queue.hidden = !next.queue; bodyText.textContent = next.body;
    toast.setAttribute('aria-label', next.aria);
    paintIcon(next.icon);
    const fresh = shownId !== next.id;
    // the pill is as wide as its header (badge + title + queue), Sileo's measured pill width
    anim.pillW = Math.min(T.TOAST.w, Math.ceil(header.scrollWidth) + 4);
    if (toast.hidden) { toast.hidden = false; anim.progress = 0; place(); void toast.offsetWidth; morphTo(1); }
    else if (fresh) { morphTo(1); }
    toast.dataset.ready = 'true';
    place();
    if (fresh) {
      shownId = next.id; clear(); live.textContent = next.aria; restartClose();
      // Sileo: auto-expand shortly after arriving, auto-collapse after a few seconds unless hovered/focused
      expandTimer = setTimeout(() => { setExpanded(true); collapseTimer = setTimeout(() => { if (!hot) setExpanded(false); }, 4500); }, 250);
    }
    doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: true } }));
  }
  const hold = on => { hot = on; if (on) { clear(); setExpanded(true); pauseClose(); } else { collapseTimer = setTimeout(() => setExpanded(false), 800); if (view && !running) runClose(); } };
  toast.addEventListener('pointerenter', () => hold(true));
  toast.addEventListener('pointerleave', () => hold(false));
  toast.addEventListener('focus', () => hold(true));
  toast.addEventListener('blur', () => hold(false));
  toast.addEventListener('click', event => {
    const req = T.openRequest(event, view);
    if (req) doc.dispatchEvent(new CustomEvent('abito:question-open', { detail: req }));
  });
  toast.addEventListener('keydown', event => {
    if (event.key === 'Escape' && view) { event.preventDefault(); event.stopPropagation(); dismissedId = view.id; render(); }
  });
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const apply = next => { if (next && typeof next === 'object') { snapshot = next; render(); } };
  if (listen) listen('question:state', event => apply(event && event.payload)).catch(() => {});
  if (invoke) invoke('question_action', { payload: { action: 'view' } }).then(apply, () => {});
  new MutationObserver(render).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-card', 'data-compact-ask', 'data-edge-hidden'] });
  setInterval(() => { if (view) render(); }, 5000); // local expiry hides it without a host event
}
