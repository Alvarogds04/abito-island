'use strict';
/* F017 — pure event/result card view-model + spec renderer. No DOM, no IPC,
   no network. The four DISTINCT event cards follow Coucou's MIT
   windows/src/views/views.ts:650-727 (louis-cfm/coucou, commit
   71b773f08101237e1ec950efdaee17a626c830e6) as LOGIC ONLY: error / finished /
   confused / note, each with who, title, detail and a closed action row.
   Everything else is Abito's own: the tone/word/icon mapping follows
   docs/desktop-visual-language.md §1.1/§3/§6 (lime NEVER means "someone
   finished"; a finished card never shows a check; real errors stay visible),
   and all copy is Spanish (voseo). The renderer emits a closed node-spec tree
   ({tag, class, text, aria, attrs, children}); apply() walks it with
   createElement + textContent ONLY. Loaded as a classic script
   (window.AbitoEventViews) and by test-node/event-views-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoEventViews = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const KINDS = new Set(['error', 'finished', 'confused', 'note']);
  // Closed per-kind defaults. `word` is the always-visible minimal word (§3);
  // the long story goes to `aria`/detail. Finished is a NEUTRAL settling: no
  // check, no lime — an aviso that someone finished is not a success.
  const CARDS = Object.freeze({
    error: { tone: 'red', icon: 'triangle', word: 'Error',
      title: 'La sesión se cortó por un error.',
      aria: 'La sesión terminó con un error; el detalle está en la tarjeta',
      actions: Object.freeze([
        { id: 'retry', label: 'Reintentar', kind: 'primary' },
        { id: 'open', label: 'Abrir en el editor', kind: 'secondary' },
      ]) },
    finished: { tone: 'neutral', icon: '', word: 'Pi terminó',
      title: 'Pi terminó.',
      aria: 'Pi terminó su turno; el resultado final está en la tarjeta',
      actions: Object.freeze([
        { id: 'open', label: 'Abrir', kind: 'primary' },
        { id: 'dismiss', label: 'Listo', kind: 'secondary' },
      ]) },
    confused: { tone: 'sun', icon: 'clock', word: 'Un segundo',
      title: 'Muchas cosas a la vez.',
      aria: 'Llegaron muchas cosas a la vez; Abito vuelve solo en unos segundos',
      actions: Object.freeze([]) },
    note: { tone: 'neutral', icon: '', word: 'Nota',
      title: '', aria: 'Nota de Abito', actions: Object.freeze([]) },
  });

  const isHook = h => typeof h === 'function';
  const word = v => (typeof v === 'string' ? v : '');

  // The card view for one closed host event. Returns null for anything that
  // is not a known kind; junk never throws and never invents a card.
  function eventCardView(event) {
    const e = event && typeof event === 'object' ? event : null;
    const kind = e && KINDS.has(e.kind) ? e.kind : null;
    if (!kind) return null;
    const base = CARDS[kind];
    const title = word(e.title) || base.title;
    const who = word(e.who);
    const detail = word(e.detail);
    // The finished word names WHO finished; nothing else in the card lies.
    const finishedWord = kind === 'finished' ? `${who || 'Pi'} terminó` : base.word;
    return {
      kind, tone: base.tone, icon: base.icon, word: finishedWord,
      title, detail, aria: base.aria,
      who: kind === 'error' || kind === 'finished' ? who || 'Pi' : '',
      actions: base.actions.map(a => ({ ...a })),
    };
  }

  // ---- spec renderer ----------------------------------------------------------
  const node = (tag, cls, extra) => Object.assign({ tag, class: cls, children: [] }, extra || {});

  function eventCardSpec(view, hooks) {
    const v = view && KINDS.has(view.kind) ? view : null;
    if (!v) return null;
    const h = hooks || {};
    const card = node('div', `event-card tone-${v.tone}`);
    const head = node('div', 'event-head');
    if (v.icon) head.children.push(node('span', `event-ico ico-${v.icon}`, { attrs: { 'aria-hidden': 'true' } }));
    if (v.word) head.children.push(node('span', 'event-word', { text: v.word }));
    if (v.who && v.who !== v.word.replace(' terminó', '')) {
      head.children.push(node('span', 'event-who', { text: v.who }));
    }
    card.children.push(head);
    if (v.title) card.children.push(node('div', 'event-title', { text: v.title }));
    if (v.detail) card.children.push(node('div', 'event-detail', { text: v.detail }));
    if (v.actions.length && (isHook(h[v.actions[0].id]) || isHook(h[v.actions[1] && v.actions[1].id]))) {
      const row = node('div', 'event-actions');
      for (const a of v.actions) {
        if (!isHook(h[a.id])) continue; // no hook → no dead button
        row.children.push(node('button', `event-action ${a.kind}`,
          { attrs: { type: 'button' }, text: a.label, actionId: a.id }));
      }
      if (row.children.length) card.children.push(row);
    }
    return card;
  }

  // The one DOM step a future mount point needs: createElement + textContent.
  function apply(spec, doc) {
    if (!spec || typeof spec.tag !== 'string') return null;
    const d = doc || (typeof document === 'object' ? document : null);
    if (!d) return null;
    const el = d.createElement(spec.tag);
    if (spec.class) el.className = spec.class;
    if (spec.aria) el.setAttribute('aria-label', spec.aria);
    for (const [k, val] of Object.entries(spec.attrs || {})) el.setAttribute(k, String(val));
    if (spec.actionId) el.dataset.actionId = spec.actionId;
    if (spec.text != null) el.textContent = spec.text;
    for (const child of spec.children || []) {
      const c = apply(child, d);
      if (c) el.append(c);
    }
    return el;
  }

  // Documented STATIC samples (fake data; no backend event exists yet) — one
  // per kind, for tests, visual probes and the mount contract examples.
  function sampleEvents() {
    return [
      { kind: 'error', who: 'Pi', detail: 'cargo build falló en 3 archivos' },
      { kind: 'finished', who: 'Pi', title: 'Los 12 tests pasaron' },
      { kind: 'confused' },
      { kind: 'note', title: 'Guardé el resumen del día' },
    ];
  }

  return { eventCardView, eventCardSpec, apply, sampleEvents };
});
