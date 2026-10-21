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
  const TOAST = Object.freeze({ w: 350, h: 40, hMax: 96, gap: 8, bodyMax: 120 });

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
    const title = approval ? `${name} pide permiso` : `${name} pregunta`;
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

  return { TOAST, toastView, openRequest, shapeWithToast, revealByToast, firstLine };
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
  // gooey canvas (Sileo): pill + body rects blurred and thresholded so they melt into one shape
  const canvas = mk('div', 'q-toast-canvas'); canvas.setAttribute('aria-hidden', 'true');
  const svg = sv('svg', { width: String(T.TOAST.w), height: String(T.TOAST.hMax), viewBox: `0 0 ${T.TOAST.w} ${T.TOAST.hMax}`, class: 'q-toast-svg' });
  const defs = sv('defs'), filter = sv('filter', { id: 'q-toast-gooey', x: '-20%', y: '-20%', width: '140%', height: '160%', 'color-interpolation-filters': 'sRGB' });
  filter.append(sv('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '5', result: 'blur' }),
    sv('feColorMatrix', { in: 'blur', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10', result: 'goo' }),
    sv('feComposite', { in: 'SourceGraphic', in2: 'goo', operator: 'atop' }));
  defs.append(filter);
  const group = sv('g', { filter: 'url(#q-toast-gooey)' });
  const pillRect = sv('rect', { x: '0', y: '0', width: String(T.TOAST.w), height: String(T.TOAST.h), rx: '16', class: 'q-toast-pill' });
  const bodyRect = sv('rect', { x: '8', y: String(T.TOAST.h - 8), width: String(T.TOAST.w - 16), height: '8', rx: '14', class: 'q-toast-bodyrect' });
  group.append(pillRect, bodyRect); svg.append(defs, group); canvas.append(svg);
  const header = mk('span', 'q-toast-header');
  const badge = mk('span', 'q-toast-badge'); badge.setAttribute('aria-hidden', 'true');
  const title = mk('span', 'q-toast-title'), queue = mk('span', 'q-toast-queue');
  header.append(badge, title, queue);
  const content = mk('span', 'q-toast-content'); const bodyText = mk('span', 'q-toast-body'); content.append(bodyText);
  toast.append(canvas, header, content);
  capsule.append(toast);

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
  const onScreen = () => capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview' && !capsule.dataset.card;
  const setExpanded = open => {
    toast.dataset.expanded = open ? 'true' : 'false';
    bodyRect.setAttribute('height', open ? String(T.TOAST.hMax - T.TOAST.h + 8) : '8');
    toast.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const clear = () => { clearTimeout(expandTimer); clearTimeout(collapseTimer); };
  // Below the island, wherever its spring currently is: follow its bottom edge for the length of a transition.
  const island = doc.getElementById('island');
  let follow = 0;
  const place = () => { if (island) toast.style.top = `${Math.round(island.getBoundingClientRect().bottom + T.TOAST.gap)}px`; };
  const track = () => {
    cancelAnimationFrame(follow); const until = performance.now() + 900;
    const step = now => { place(); if (now < until && !toast.hidden) follow = requestAnimationFrame(step); };
    follow = requestAnimationFrame(step);
  };
  function render() {
    const next = T.toastView(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId });
    view = next;
    const visible = !!next;
    if (!visible) {
      clear(); shownId = null; setExpanded(false);
      if (!toast.hidden) { toast.dataset.exiting = 'true'; const done = () => { if (!view) { toast.hidden = true; delete toast.dataset.exiting; delete toast.dataset.ready; } }; setTimeout(done, doc.documentElement.dataset.motion === 'reduce' ? 0 : 260); }
      doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: false } }));
      return;
    }
    delete toast.dataset.exiting;
    toast.dataset.state = next.tone; toast.dataset.kind = next.kind;
    title.textContent = next.title; queue.textContent = next.queue || ''; queue.hidden = !next.queue; bodyText.textContent = next.body;
    toast.setAttribute('aria-label', next.aria);
    paintIcon(next.icon);
    const fresh = shownId !== next.id;
    if (toast.hidden) { toast.hidden = false; void toast.offsetWidth; }
    toast.dataset.ready = 'true';
    place(); track();
    if (fresh) {
      shownId = next.id; clear();
      // Sileo: auto-expand shortly after arriving, auto-collapse after a few seconds unless hovered/focused
      expandTimer = setTimeout(() => { setExpanded(true); collapseTimer = setTimeout(() => { if (!hot) setExpanded(false); }, 4500); }, 250);
    }
    doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: true } }));
  }
  const hold = on => { hot = on; if (on) { clear(); setExpanded(true); } else collapseTimer = setTimeout(() => setExpanded(false), 800); };
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
  new MutationObserver(render).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-card'] });
  setInterval(() => { if (view) render(); }, 5000); // local expiry hides it without a host event
}
