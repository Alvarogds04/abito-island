'use strict';
/* #306 — the settings panel (providers, connectors, general), an internal panel of the
   chat view like the model picker (same island, same motion). It talks to Rust ONLY
   through three closed commands: `agent_action` (accounts / sign-in / connectors),
   `prefs_action` (sound) and `hotkey_action` (the global shortcut), plus the existing
   window.desktop verbs for system motion. It never sees the agent's token or socket.
   - Plain text only (textContent). No innerHTML anywhere: icons are DOM nodes built from the
     closed own registry (DOMParser), so no data can ever become markup.
   - A key is typed into a MASKED field, sent once as `auth_reply`, and the field is
     cleared at once: nothing is kept in the page, nothing is logged or stored.
   - Only trusted gestures (event.isTrusted) change anything. */
(() => {
  const V = window.AbitoSettings;
  const ICONS = window.AbitoIcons;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const panel = $('settings');
  const body = $('settings-body');
  if (!V || !ICONS || !panel || !body) return;
  // Icons are built as DOM nodes from the CLOSED own registry (an unknown name yields nothing):
  // no markup is ever written with innerHTML, so no data can become markup.
  const parser = new DOMParser();
  function icon(name) {
    const markup = ICONS.svg(name);
    if (!markup) return null;
    const doc = parser.parseFromString(markup, 'image/svg+xml');
    return doc.documentElement && doc.documentElement.nodeName === 'svg' ? document.importNode(doc.documentElement, true) : null;
  }
  function putIcon(host, name) {
    host.textContent = '';
    const node = name ? icon(name) : null;
    if (node) host.append(node);
  }
  for (const holder of panel.querySelectorAll('[data-icon]')) putIcon(holder, holder.dataset.icon);
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));
  const agent = payload => call('agent_action', payload);

  const tabs = Array.from(panel.querySelectorAll('[role="tab"]'));
  const live = $('settings-live');
  let section = 'providers';
  let agentState = null;
  let prefs = { sound: false };
  let hotkey = null;
  let motionOverride = true;
  let capturing = false;
  let createDraft = { provider: '', label: '' };
  let pendingOpen = false;
  const drafts = V.makeDrafts(); // what is being typed survives the re-renders (memory only)
  let busy = false;

  const say = text => { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  function iconBtn(name, label, onClick, extra) {
    const b = el('button', 'icon-btn ' + (extra || ''));
    b.type = 'button'; b.setAttribute('aria-label', label); putIcon(b, name);
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(e); });
    return b;
  }
  function wordBtn(word, onClick, opts) {
    const o = opts || {};
    const b = el('button', 'sbtn' + (o.primary ? ' primary' : ''));
    b.type = 'button';
    if (o.icon) { const i = el('span', 'ico'); putIcon(i, o.icon); b.append(i); }
    b.append(el('span', 'btn-word', word));
    if (o.aria) b.setAttribute('aria-label', o.aria);
    b.disabled = !!o.disabled;
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(e); });
    return b;
  }
  function chipNode(view) {
    const c = el('span', 'chip'); c.dataset.tone = view.tone; c.setAttribute('role', 'img'); c.setAttribute('aria-label', view.aria || view.word);
    if (view.icon) { const i = el('span', 'ico'); putIcon(i, view.icon); c.append(i); }
    if (view.word) c.append(el('span', 'word', view.word));
    return c;
  }

  // ---- open / close ---------------------------------------------------------------------------------------
  function open() {
    panel.inert = false; panel.dataset.open = 'true'; capsule.dataset.settings = 'open';
    refreshAll();
    const first = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
    if (first) first.focus();
  }
  function close(byKeyboard) {
    panel.inert = true; delete panel.dataset.open; delete capsule.dataset.settings;
    capturing = false;
    drafts.reset(); // a half-typed key never outlives the panel
    if (waiting) { clearTimeout(waiting.timer); waiting = null; }
    // the gear is overview-only; the panel lives in the chat view, so focus returns to the chat input
    if (byKeyboard) { const c = $('chat-input'); if (c && !c.disabled) c.focus(); }
  }
  const isOpen = () => panel.dataset.open === 'true';

  // the gear lives in the overview; the panel lives in the chat-sized view: open it through the chat view
  const gear = $('open-settings');
  if (gear) gear.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    pendingOpen = true;
    call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; });
  });
  document.addEventListener('island:view', e => {
    if (e.detail === 'chat' && pendingOpen) { pendingOpen = false; open(); }
    else if (e.detail !== 'chat' && isOpen()) close(false);
  });
  $('settings-close').addEventListener('click', e => { if (e.isTrusted === true) close(e.detail === 0); });

  // ---- tabs (roving tabindex, arrows, Home/End) ---------------------------------------------------------------------
  function selectSection(id, focus) {
    section = id;
    for (const t of tabs) { const on = t.id === `tab-${id}`; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
    body.setAttribute('aria-labelledby', `tab-${id}`);
    render();
    if (id === 'connectors') agent({ action: 'connectors_list' }).catch(() => {});
  }
  for (const t of tabs) {
    t.addEventListener('click', e => { if (e.isTrusted === true) selectSection(t.id.replace('tab-', ''), false); });
    t.addEventListener('keydown', e => {
      if (e.isComposing) return;
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (step) { e.preventDefault(); selectSection(V.nextSection(section, step), true); }
      else if (e.key === 'Home') { e.preventDefault(); selectSection(V.SECTIONS[0].id, true); }
      else if (e.key === 'End') { e.preventDefault(); selectSection(V.SECTIONS[V.SECTIONS.length - 1].id, true); }
    });
  }
  // The inert seam for the visual probe (a script click is rightly not a trusted gesture): a CustomEvent
  // that only opens the panel or selects which tab is shown, never a setting. The shipped binary has no
  // probe, so nothing ever fires it.
  document.addEventListener('abito:settings-select', e => {
    if (e.detail === 'open') { pendingOpen = true; call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; }); }
    else if (V.SECTIONS.some(x => x.id === e.detail)) selectSection(e.detail, false);
  });
  // Escape: the shortcut capture first, then the panel (never the island)
  document.addEventListener('keydown', e => {
    if (!isOpen() || e.isComposing) return;
    if (capturing) {
      const r = V.captureCombo(e);
      if (r.kind === 'ignore') return;
      e.preventDefault(); e.stopPropagation();
      if (r.kind === 'wait') return;
      capturing = false;
      if (r.kind === 'combo') setHotkey(r.text);
      else if (r.kind === 'needs_modifier') say('El atajo necesita Ctrl, Alt o Súper.');
      else if (r.kind === 'unsupported') say('Esa tecla no se puede usar en un atajo.');
      render();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  }, true);

  // ---- data ---------------------------------------------------------------------------------------------------------------
  function refreshAll() {
    agent({ action: 'view' }).then(applyAgent, () => {});
    call('prefs_action', { action: 'view' }).then(p => { prefs = p; render(); }, () => {});
    call('hotkey_action', { action: 'view' }).then(h => { hotkey = h; render(); }, () => {});
    if (window.desktop) window.desktop.snapshot().then(s => { motionOverride = s.motionOverride !== false; render(); }, () => {});
  }
  function applyAgent(next) { if (next && typeof next === 'object') { agentState = next; settle(next); render(); } }
  if (listen) {
    listen('agent:state', e => applyAgent(e && e.payload)).catch(() => {});
    listen('prefs:state', e => { if (e && e.payload) { prefs = e.payload; render(); } }).catch(() => {});
    listen('hotkey:state', e => { if (e && e.payload) { hotkey = e.payload; render(); } }).catch(() => {});
  }
  // A command is only «done» when the engine says so: the invoke result is the state at WRITE time, the answer
  // arrives later as `agent:state`. `waiting` holds what we sent; the next state either carries a newer
  // engine error (say it, with icon+word) or a real change (say the success). Silence past the deadline is
  // reported honestly, never as success.
  const WAIT_MS = 5000;
  let waiting = null;
  const withoutError = st => JSON.stringify(Object.assign({}, st, { last_error: null }));
  function settle(after) {
    if (!waiting) return;
    const w = waiting;
    const out = V.commandOutcome(w.before, after, w.okSay);
    if (out.ok === false) { waiting = null; clearTimeout(w.timer); say(out.say); showFailure(out); return; }
    if (after && withoutError(after) !== w.beforeJson) { waiting = null; clearTimeout(w.timer); if (w.okSay) say(w.okSay); }
  }
  function showFailure(out) {
    const chip = $('settings-conn');
    chip.hidden = false; chip.dataset.tone = out.tone; chip.setAttribute('aria-label', out.say);
    putIcon($('settings-conn-icon'), out.icon); $('settings-conn-word').textContent = out.word;
    clearTimeout(failureTimer); failureTimer = setTimeout(() => render(), 6000);
  }
  let failureTimer = 0;
  function send(payload, okSay) {
    if (busy) return;
    busy = true;
    const before = agentState;
    if (waiting) clearTimeout(waiting.timer);
    waiting = okSay ? { before, beforeJson: withoutError(before), okSay, timer: setTimeout(() => { waiting = null; say('El motor no respondió.'); showFailure({ word: 'Sin respuesta', icon: 'clock', tone: 'sun', say: 'Sin respuesta.' }); }, WAIT_MS) } : null;
    agent(payload).then(next => { busy = false; applyAgent(next); }, error => {
      busy = false;
      if (waiting) { clearTimeout(waiting.timer); waiting = null; }
      say((error && error.message) || 'No se pudo completar.'); render();
    });
  }
  function setHotkey(text) {
    call('hotkey_action', { action: 'set', combo: text }).then(h => {
      hotkey = h; render();
      const out = V.hotkeySetOutcome(h, text); // «cambiado» only when the backend really took it
      say(out.say);
    }, error => say((error && error.message) || 'No se pudo cambiar el atajo.'));
  }

  // ---- rendering --------------------------------------------------------------------------------------------------------------
  function render() {
    if (!isOpen()) return;
    const keep = body.scrollTop;
    const active = document.activeElement;
    const focused = active && active.id;
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    body.textContent = '';
    const conn = V.connectionView(agentState);
    const chip = $('settings-conn');
    chip.hidden = !conn || section === 'general';
    if (conn) { chip.dataset.tone = conn.tone; chip.setAttribute('aria-label', conn.aria); putIcon($('settings-conn-icon'), conn.icon); $('settings-conn-word').textContent = conn.word; }
    if (section === 'providers') renderProviders();
    else if (section === 'connectors') renderConnectors();
    else renderGeneral();
    body.scrollTop = keep;
    if (focused && $(focused) && body.contains($(focused))) {
      $(focused).focus();
      if (caret) { try { $(focused).setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
    }
  }

  function renderProviders() {
    const st = agentState || { connection: 'no_daemon', providers: [], accounts: [], profiles: { profiles: [], active: null }, auth: {} };
    const auth = st.auth || {};
    const prompt = V.promptView(auth.prompt);
    drafts.scope(prompt ? `${prompt.flowId}:${prompt.promptId}` : '');
    const eventV = V.eventView(auth.event);
    if (prompt || eventV || (auth.flowId && !auth.last)) body.append(renderFlow(auth, prompt, eventV));
    const outcome = V.flowOutcome(auth.last);
    if (outcome && !prompt) body.append(chipNode({ tone: outcome.tone, icon: outcome.icon, word: outcome.word, aria: `Inicio de sesión: ${outcome.word}` }));
    const rows = V.accountRows(st);
    const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Cuentas');
    for (const r of rows) list.append(accountRow(r, st));
    if (!rows.length && V.connectionView(st) === null) list.append(el('li', 'sempty', ''));
    body.append(list);
    body.append(createForm(st));
  }

  function accountRow(r, st) {
    const li = el('li', 'srow');
    li.append(el('span', 'srow-title', r.label), el('span', 'srow-sub', r.providerName));
    for (const c of r.chips) li.append(chipNode({ tone: 'faint', icon: c.icon, word: c.text, aria: 'Sólo local' }));
    if (r.active) li.append(chipNode({ tone: 'go', icon: 'check', word: '', aria: 'En uso por el perfil activo' }));
    if (r.state.word) li.append(chipNode({ tone: r.state.tone, icon: r.state.icon, word: r.state.word, aria: r.state.word }));
    const actions = el('span', 'srow-actions');
    if (r.actions.includes('login')) {
      for (const m of V.loginMethods(st, r.accountId)) {
        actions.append(wordBtn(m === 'api_key' ? 'Clave' : 'Cuenta', () => send({ action: 'auth_start', accountId: r.accountId, method: m }), { icon: m === 'api_key' ? 'lock' : 'plug', aria: `Conectar ${r.label} con ${m === 'api_key' ? 'una clave' : 'tu cuenta'}` }));
      }
    }
    if (r.actions.includes('logout')) actions.append(wordBtn('Salir', () => send({ action: 'account_logout', accountId: r.accountId }, `${r.label}: sesión cerrada.`), { icon: 'plug-off', aria: `Cerrar sesión de ${r.label}` }));
    if (r.actions.includes('remove')) actions.append(iconBtn('cross', `Quitar la cuenta ${r.label}`, () => send({ action: 'account_remove', accountId: r.accountId }, `${r.label} quitada.`)));
    li.append(actions);
    return li;
  }

  function createForm(st) {
    const form = el('form', 'sform'); form.noValidate = true;
    const sel = el('select', 'sfield'); sel.setAttribute('aria-label', 'Proveedor');
    sel.append(Object.assign(el('option', '', 'Proveedor'), { value: '' }));
    for (const p of st.providers || []) sel.append(Object.assign(el('option', '', p.name), { value: p.id }));
    sel.value = createDraft.provider;
    const inp = el('input', 'sfield'); inp.type = 'text'; inp.placeholder = 'Nombre de la cuenta'; inp.maxLength = 80; inp.autocomplete = 'off'; inp.id = 'settings-create-label';
    inp.setAttribute('aria-label', 'Nombre de la cuenta'); inp.value = createDraft.label;
    const word = el('span', 'chip'); word.dataset.tone = 'red'; word.hidden = true;
    const submit = wordBtn('Crear', () => {}, { icon: 'check', primary: true, disabled: true });
    submit.type = 'submit';
    const refresh = () => {
      createDraft = { provider: sel.value, label: inp.value };
      const v = V.createValidity(st, sel.value, inp.value);
      submit.disabled = !v.ok; word.hidden = !v.word; word.textContent = v.word;
    };
    sel.addEventListener('change', refresh); inp.addEventListener('input', refresh);
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (e.isTrusted !== true) return;
      const v = V.createValidity(st, sel.value, inp.value);
      if (!v.ok) return;
      const label = inp.value;
      createDraft = { provider: '', label: '' };
      send({ action: 'account_create', provider: sel.value, label }, `Cuenta ${label} creada.`);
    });
    form.append(sel, inp, word, submit);
    refresh();
    return form;
  }

  // The sign-in flow. The ONLY secret path: a masked field -> auth_reply -> cleared.
  function renderFlow(auth, prompt, eventV) {
    const box = el('div', 'sflow'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Inicio de sesión en curso');
    if (eventV) {
      if (eventV.message) box.append(el('p', 'sline', eventV.message));
      if (eventV.userCode) box.append(Object.assign(el('code', 'scode', eventV.userCode), { title: 'Código de verificación' }));
      if (eventV.link) box.append(el('p', 'sline sub', eventV.link)); // shown as text: Abito opens nothing by itself
    }
    if (prompt) {
      box.append(el('p', 'sline', prompt.message));
      if (prompt.control === 'select') {
        for (const o of prompt.options) box.append(wordBtn(o.label, () => reply(prompt, o.id)));
      } else if (prompt.control === 'confirm') {
        box.append(wordBtn('Sí', () => reply(prompt, 'yes'), { primary: true }), wordBtn('No', () => reply(prompt, 'no')));
      } else {
        const f = el('form', 'sform');
        const inp = el('input', 'sfield'); inp.id = 'settings-secret';
        inp.type = prompt.masked ? 'password' : 'text';
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off'); inp.maxLength = 4096;
        inp.placeholder = prompt.placeholder || (prompt.masked ? 'Pegá tu clave' : 'Escribí…');
        inp.setAttribute('aria-label', prompt.masked ? 'Clave (se oculta al escribir)' : 'Respuesta');
        const send1 = wordBtn('Enviar', () => {}, { icon: 'arrow-up', primary: true, disabled: true });
        send1.type = 'submit';
        inp.value = drafts.get('settings-secret'); // a re-render (the portal pushes every 400 ms) never eats a half-typed key
        send1.disabled = !V.replyValid(inp.value);
        inp.addEventListener('input', () => { drafts.set('settings-secret', inp.value); send1.disabled = !V.replyValid(inp.value); });
        f.addEventListener('submit', e => {
          e.preventDefault();
          if (e.isTrusted !== true || !V.replyValid(inp.value)) return;
          const value = inp.value;
          inp.value = ''; // gone from the page before the round trip even starts
          drafts.clear('settings-secret');
          reply(prompt, value);
        });
        f.append(inp, send1);
        box.append(f);
      }
    }
    box.append(wordBtn('Cancelar', () => send({ action: 'auth_cancel', flowId: prompt ? prompt.flowId : String((auth && auth.flowId) || '') }), { icon: 'cross' }));
    return box;
  }
  function reply(prompt, value) {
    agent({ action: 'auth_reply', flowId: prompt.flowId, promptId: prompt.promptId, value }).then(applyAgent, () => say('No se pudo enviar la respuesta.'));
  }

  function renderConnectors() {
    const v = V.connectorsView(agentState);
    if (v.kind !== 'ready') { body.append(chipNode(v)); return; }
    const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Conectores');
    for (const i of v.items) {
      const li = el('li', 'srow'); li.append(el('span', 'srow-title', i.label));
      if (i.sends) li.append(chipNode({ tone: 'sun', icon: 'arrow-up', word: 'Puede enviar', aria: 'Este conector puede enviar, no sólo leer' }));
      if (i.word || i.icon) li.append(chipNode({ tone: i.tone, icon: i.icon, word: i.word, aria: i.word || 'Conectado' }));
      list.append(li);
    }
    if (v.empty) list.append(el('li', 'sempty', 'Sin conectores'));
    body.append(list, el('p', 'snote', V.CONNECTORS_NOTE));
  }

  function toggleRow(id, word, on, onClick, extraChip) {
    const row = el('div', 'srow');
    row.append(el('span', 'srow-title', word));
    if (extraChip) row.append(extraChip);
    const b = el('button', 'switch'); b.type = 'button'; b.id = id; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.setAttribute('aria-label', word);
    b.append(el('span', 'knob'));
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(); });
    row.append(b);
    return row;
  }
  function renderGeneral() {
    const g = V.generalView({ sound: prefs.sound, motionOverride, hotkey });
    body.append(toggleRow('sw-sound', 'Sonido', g.sound.on, () => call('prefs_action', { action: g.sound.on ? 'sound_off' : 'sound_on' }).then(p => { prefs = p; render(); say(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); }, () => {})));
    body.append(toggleRow('sw-motion', 'Respetar el movimiento del sistema', g.motion.respectSystem, () => {
      if (!window.desktop) return;
      (g.motion.respectSystem ? window.desktop.animateAnyway() : window.desktop.respectSystemMotion()).then(s => { motionOverride = s.motionOverride !== false; render(); say(motionOverride ? 'Abito se anima siempre.' : 'Abito respeta el movimiento del sistema.'); }, () => {});
    }));
    if (g.hotkey) {
      const h = g.hotkey;
      const row = el('div', 'srow');
      row.append(el('span', 'srow-title', 'Atajo'));
      row.append(Object.assign(el('kbd', 'skbd', capturing ? 'Pulsá el atajo…' : h.combo), { id: 'settings-combo' }));
      row.append(chipNode({ tone: h.status === 'active' ? 'go' : 'faint', icon: h.backend === 'portal' ? 'check' : 'info', word: h.backendLabel, aria: h.note ? `${h.backendLabel}. ${h.note}` : h.backendLabel }));
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn(capturing ? 'Cancelar' : 'Cambiar', () => { capturing = !capturing; render(); if (capturing) say('Pulsá la combinación nueva; Escape cancela.'); }, { icon: 'refresh' }));
      actions.append(wordBtn('Original', () => call('hotkey_action', { action: 'reset' }).then(r => { hotkey = r; render(); }, () => {})));
      row.append(actions);
      body.append(row);
      body.append(toggleRow('sw-hotkey', 'Atajo activo', h.enabled, () => call('hotkey_action', { action: h.enabled ? 'disable' : 'enable' }).then(r => { hotkey = r; render(); }, () => {})));
      if (h.note) body.append(el('p', 'snote', h.note));
    }
  }
})();
