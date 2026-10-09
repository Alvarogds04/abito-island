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
  const resources = $('models-resources');
  const refreshButton = $('models-refresh');
  const closeButton = $('models-close');
  const live = $('chat-live');
  if (!V || !panel || !toggle) return;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('models_action', { payload }) : Promise.reject(new Error('no ipc')));

  let listing = null;
  let busy = false;

  function say(text) { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } }

  function render() {
    list.textContent = '';
    note.textContent = listing ? `${listing.choice_note || ''} ${listing.remote || ''}`.trim() : 'Leyendo modelos locales…';
    resources.textContent = listing && listing.resources_text
      ? `Recursos: ${listing.resources_text}${listing.persisted === false && listing.selected ? ' · elección sólo en memoria' : ''}`
      : '';
    for (const row of V.modelRows(listing)) {
      const li = document.createElement('li');
      if (!row.selectable) li.className = 'disabled';
      const text = document.createElement('div');
      text.className = 'model-text';
      const title = document.createElement('span');
      title.className = 'model-title';
      title.textContent = row.title;
      const facts = document.createElement('span');
      facts.className = 'model-facts';
      facts.textContent = row.facts;
      const state = document.createElement('span');
      state.className = 'model-state';
      state.textContent = `${row.state}: ${row.message}${row.note ? ' ' + row.note : ''}`;
      text.append(title, facts, state);
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.textContent = row.selected ? 'Elegido' : 'Elegir';
      choose.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
      choose.setAttribute('aria-label', `${row.selected ? 'Elegido' : 'Elegir'} ${row.title}`);
      choose.disabled = !row.selectable || row.selected || busy;
      if (row.selectable && !row.selected) {
        choose.addEventListener('click', () => select(row.id, row.title));
      }
      li.append(text, choose);
      list.appendChild(li);
    }
    refreshButton.disabled = busy;
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
  function open(byKeyboard) {
    panel.hidden = false;
    capsule.dataset.models = 'open';
    toggle.setAttribute('aria-expanded', 'true');
    refresh(); // metadata only, never inference
    if (byKeyboard) refreshButton.focus();
  }
  function close(byKeyboard) {
    panel.hidden = true;
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
