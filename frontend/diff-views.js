'use strict';
/* F018 — pure diff-card spec renderer. Produces a closed node-spec tree
   ({tag, class, text, aria, attrs, children}); the mount point walks it with
   createElement + textContent ONLY (V.apply does exactly that, nothing else).
   Layout LOGIC follows Coucou's MIT windows/src/views/diff.ts:18-60
   (louis-cfm/coucou, commit 71b773f08101237e1ec950efdaee17a626c830e6):
   head with back / +N / −N / open, one row per line with symbol + text, and
   the too-large / no-changes notes. Classes, names and Spanish (voseo) copy
   are Abito's own; no upstream asset, icon or string is copied. Loaded as a
   classic script (window.AbitoDiffViews) and by
   test-node/diff-views-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoDiffViews = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SYMBOLS = { added: '+', removed: '−', context: ' ' };
  const KINDS = new Set(['added', 'removed', 'context']);

  const node = (tag, cls, extra) => Object.assign({ tag, class: cls, children: [] }, extra || {});
  const isHook = h => typeof h === 'function';
  const isDiff = d => !!d && typeof d === 'object' && typeof d.path === 'string' &&
    Number.isInteger(d.added) && Number.isInteger(d.removed) && Array.isArray(d.hunks);

  // One row: the kind as a class (CSS decides the colour), the symbol as the
  // visible shape (colour is never alone) and the line text verbatim.
  function lineRow(line) {
    const kind = KINDS.has(line && line.kind) ? line.kind : 'context';
    const row = node('div', `diff-line ${kind}`);
    row.children.push(node('span', 'diff-sym', { text: SYMBOLS[kind] }));
    row.children.push(node('span', 'diff-text', { text: String(line && line.text || '') }));
    return row;
  }

  // The whole card. `hooks` may carry dismiss() and open(path); a control is
  // rendered only when its hook exists — no dead buttons.
  function diffCardSpec(diff, hooks) {
    if (!isDiff(diff)) return null;
    const h = hooks || {};
    const head = node('div', 'diff-head');
    if (isHook(h.dismiss)) {
      const back = node('button', 'diff-back', { attrs: { type: 'button' }, aria: 'Volver' });
      back.children.push(node('b', 'diff-name', { text: fileNameOf(diff.path) }));
      head.children.push(back);
    } else {
      head.children.push(node('b', 'diff-name', { text: fileNameOf(diff.path) }));
    }
    if (diff.added > 0) head.children.push(node('span', 'diff-count diff-count-plus', { text: `+${diff.added}` }));
    if (diff.removed > 0) head.children.push(node('span', 'diff-count diff-count-minus', { text: `−${diff.removed}` }));
    if (isHook(h.open)) head.children.push(node('button', 'diff-open', { attrs: { type: 'button' }, aria: 'Abrir en el editor' }));

    const card = node('div', 'diff-card');
    card.children.push(head);

    if (diff.tooLarge === true) {
      // Honest degradation: the counts stay, the lines do not pretend.
      card.children.push(node('div', 'diff-note', { text: 'Muy grande para mostrar' }));
      return card;
    }
    const lines = diff.hunks.flatMap(k => (Array.isArray(k.lines) ? k.lines : []))
      .filter(l => KINDS.has(l && l.kind));
    if (lines.length === 0) {
      card.children.push(node('div', 'diff-note', { text: 'Sin cambios' }));
      return card;
    }
    const body = node('div', 'diff-lines');
    for (const line of lines) body.children.push(lineRow(line));
    card.children.push(body);
    return card;
  }

  const fileNameOf = path => {
    const cleaned = String(path).replace(/[\\/]+$/, '');
    const at = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
    return at >= 0 ? cleaned.slice(at + 1) : cleaned;
  };

  // The one DOM step a future mount point needs: walk the spec, create
  // elements, set textContent. No other sink, no attributes beyond what the
  // spec carries.
  function apply(spec, doc) {
    if (!spec || typeof spec.tag !== 'string') return null;
    const d = doc || (typeof document === 'object' ? document : null);
    if (!d) return null;
    const el = d.createElement(spec.tag);
    if (spec.class) el.className = spec.class;
    if (spec.aria) el.setAttribute('aria-label', spec.aria);
    for (const [k, v] of Object.entries(spec.attrs || {})) el.setAttribute(k, String(v));
    if (spec.text != null) el.textContent = spec.text;
    for (const child of spec.children || []) {
      const c = apply(child, d);
      if (c) el.append(c);
    }
    return el;
  }

  return { diffCardSpec, apply };
});
