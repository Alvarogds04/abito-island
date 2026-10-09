'use strict';
/* U2 — the self-hosted model picker, an internal panel of the chat view
   (same island). Talks to Rust only through `models_action` with the closed
   set list/refresh/select{profile_id}: it can never add an endpoint, enter
   a key or name a remote model. Selecting is explicit (a click on a
   registered, selectable profile) and applies from the next message.
   Plain text only (textContent). Silence. */
(() => {
  const V = window.AbitoChatView;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const panel = $('models');
  const toggle = $('chat-models');
  const list = $('models-list');
  const note = $('models-note');
  const noteButton = $('models-info');
  const meters = $('models-meters');
  const countWord = $('models-count-word');
  const countChip = $('models-count');
  const resources = $('models-resources');
  const refreshButton = $('models-refresh');
  const closeButton = $('models-close');
  const live = $('chat-live');
  if (!V || !panel || !toggle) return;
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // Static own icons (closed registry, never data).
  for (const el of panel.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('models_action', { payload }) : Promise.reject(new Error('no ipc')));

  let listing = null;
  let busy = false;

  function say(text) { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function chipNode(c) {
    const chip = el('span', 'chip');
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', c.label);
    if (c.icon) { const i = el('span', 'ico'); i.innerHTML = icon(c.icon); chip.append(i); }
    if (c.text) chip.append(el('span', 'word', c.text));
    return chip;
  }

  function render() {
    list.textContent = '';
    list.setAttribute('aria-busy', listing ? 'false' : 'true');
    const count = V.modelsCount(listing);
    countWord.textContent = listing ? String(count) : '';
    countChip.setAttribute('aria-label', listing ? `${count} modelo${count === 1 ? '' : 's'} local${count === 1 ? '' : 'es'} verificado${count === 1 ? '' : 's'}` : 'Leyendo modelos locales');
    note.textContent = V.modelsInfo(listing);
    resources.textContent = listing && listing.resources_text ? `Recursos: ${listing.resources_text}` : '';
    meters.textContent = '';
    for (const m of V.modelMeters(listing)) {
      const li = el('li', 'meter');
      li.dataset.key = m.key;
      li.dataset.known = m.known ? 'true' : 'false';
      li.setAttribute('role', 'img');
      li.setAttribute('aria-label', m.aria);
      li.append(el('span', 'meter-label', m.label));
      const bar = el('span', 'meter-bar');
      bar.innerHTML = ICONS ? ICONS.meter(m.fraction) : '';
      li.append(bar);
      meters.append(li);
    }
    if (!listing) { // skeleton: two rows, shape only (still under reduced motion)
      for (let n = 0; n < 2; n++) { const li = el('li', 'skeleton'); li.setAttribute('aria-hidden', 'true'); list.append(li); }
    }
    for (const row of V.modelRows(listing)) {
      const li = el('li', row.selectable ? '' : 'disabled');
      li.dataset.tone = row.tone;
      li.setAttribute('aria-label', row.aria);
      li.append(el('span', 'model-title', row.title));
      const chips = el('span', 'model-chips');
      for (const c of row.chips) chips.append(chipNode(c));
      li.append(chips);
      if (row.word) {
        const state = el('span', 'chip model-word');
        state.dataset.tone = row.tone;
        const i = el('span', 'ico'); i.innerHTML = icon(row.wordIcon);
        state.append(i, el('span', 'word', row.word));
        li.append(state);
      } else {
        const ok = el('span', 'model-ok'); // «ready»: filled dot, shape = filled circle
        ok.setAttribute('aria-hidden', 'true');
        li.append(ok);
      }
      const choose = el('button', 'choose');
      choose.type = 'button';
      choose.innerHTML = row.selected ? icon('check') : '';
      choose.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
      choose.setAttribute('aria-label', `${row.selected ? 'Elegido' : 'Elegir'} ${row.title}`);
      choose.disabled = !row.selectable || row.selected || busy;
      if (row.selectable && !row.selected) {
        choose.addEventListener('click', () => select(row.id, row.title));
      }
      li.append(choose);
      list.appendChild(li);
    }
    refreshButton.disabled = busy;
    refreshButton.dataset.kind = busy ? 'busy' : '';
  }

  function apply(next) { if (next && typeof next === 'object') { listing = next; render(); } }

  function refresh() {
    busy = true; render();
    action({ action: 'refresh' }).then(next => { busy = false; apply(next); say('Modelos locales actualizados.'); },
      () => { busy = false; render(); });
  }
  function select(id, title) {
    busy = true; render();
    action({ action: 'select', profile_id: id }).then(
      next => { busy = false; apply(next); say(`${title} elegido. Se usa desde el próximo mensaje.`); },
      error => { busy = false; render(); say((error && error.message) || 'No se pudo elegir.'); });
  }
  function setInfo(open) {
    noteButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    note.classList.toggle('sr-only', !open);
  }
  noteButton.addEventListener('click', () => setInfo(noteButton.getAttribute('aria-expanded') !== 'true'));
  function open(byKeyboard) {
    panel.hidden = false;
    setInfo(false);
    capsule.dataset.models = 'open';
    toggle.setAttribute('aria-expanded', 'true');
    refresh(); // metadata only, never inference
    if (byKeyboard) refreshButton.focus();
  }
  function close(byKeyboard) {
    panel.hidden = true;
    setInfo(false);
    delete capsule.dataset.models;
    toggle.setAttribute('aria-expanded', 'false');
    if (byKeyboard) toggle.focus();
  }
  toggle.addEventListener('click', e => (panel.hidden ? open(e.detail === 0) : close(e.detail === 0)));
  closeButton.addEventListener('click', e => close(e.detail === 0));
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('island:view', e => { if (e.detail !== 'chat') close(false); });
  if (listen) listen('models:state', ev => apply(ev && ev.payload)).catch(() => {});
  action({ action: 'list' }).then(apply, () => {});
})();
