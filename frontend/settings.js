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

  const openers = V.SCREENS.map(x => $(`open-screen-${x.id}`)).filter(Boolean);
  const live = $('settings-live');
  let screen = 'accounts';
  let method = null;      // Cuentas: null = the two method cards, else 'oauth' | 'api_key' (the provider list)
  let filter = '';
  let agentsAsk = null;   // { at: engine error counter when agents_list was sent, timer, timedOut }
  let pendingLogin = null; // a login that waits for the account it just asked the engine to create
  let agentState = null;
  let prefs = { sound: false };
  let hotkey = null;
  let motionOverride = true;
  let capturing = false;
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
  // gentle-dot: one header button per screen; a screen covers the chat body; opening one replaces the other.
  function showScreen(id) {
    screen = id;
    if (id !== 'accounts') { method = null; filter = ''; }
    const def = V.screenById(id);
    $('settings-title').textContent = def.title;
    $('settings-hint').textContent = def.hint;
    $('settings-hint').hidden = !def.hint;
    panel.setAttribute('aria-label', def.title);
    for (const b of openers) b.setAttribute('aria-expanded', b.id === `open-screen-${id}` ? 'true' : 'false');
    if (id === 'connectors') { agent({ action: 'connectors_list' }).catch(() => {}); askAgents(); }
    render();
  }
  // The engine answers `agents_list` with an `agents` frame — or, if it does not know the command, with
  // error{bad_request}, or with silence. All three end the wait (see V.agentsView).
  function askAgents() {
    if (agentsAsk) clearTimeout(agentsAsk.timer);
    const ask = { at: (agentState && agentState.last_error && agentState.last_error.n) || 0, timedOut: false, timer: 0 };
    ask.timer = setTimeout(() => { ask.timedOut = true; if (isOpen() && screen === 'connectors') render(); }, V.AGENTS_WAIT_MS);
    agentsAsk = ask;
    agent({ action: 'agents_list' }).catch(() => {});
  }
  function open(id) {
    panel.inert = false; panel.dataset.open = 'true'; capsule.dataset.settings = 'open';
    refreshAll();
    showScreen(id || screen);
    $('settings-close').focus();
  }
  function close(byKeyboard) {
    panel.inert = true; delete panel.dataset.open; delete capsule.dataset.settings;
    capturing = false; method = null; filter = ''; pendingLogin = null;
    if (agentsAsk) { clearTimeout(agentsAsk.timer); agentsAsk = null; }
    for (const b of openers) b.setAttribute('aria-expanded', 'false');
    drafts.reset(); // a half-typed key never outlives the panel
    if (waiting) { clearTimeout(waiting.timer); waiting = null; }
    // the panel lives in the chat view: focus returns to the chat input
    if (byKeyboard) { const c = $('chat-input'); if (c && !c.disabled) c.focus(); }
  }
  const isOpen = () => panel.dataset.open === 'true';

  // the header buttons toggle their screen; the gear of the overview opens the chat view first
  for (const b of openers) b.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const id = b.id.replace('open-screen-', '');
    if (isOpen() && screen === id) close(e.detail === 0); else open(id);
  });
  const gear = $('open-settings');
  if (gear) gear.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    pendingOpen = 'settings';
    call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; });
  });
  document.addEventListener('island:view', e => {
    if (e.detail === 'chat' && pendingOpen) { const id = pendingOpen; pendingOpen = false; open(id); }
    else if (e.detail !== 'chat' && isOpen()) close(false);
  });
  $('settings-close').addEventListener('click', e => { if (e.isTrusted === true) close(e.detail === 0); });
  // The inert seam for the visual probe (a script click is rightly not a trusted gesture): a CustomEvent
  // that only opens a screen, never a setting. The shipped binary has no probe, so nothing ever fires it.
  document.addEventListener('abito:settings-select', e => {
    if (e.detail === 'open') { pendingOpen = 'settings'; call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; }); }
    else if (V.screenById(e.detail)) { method = null; filter = ''; if (isOpen()) showScreen(e.detail); else open(e.detail); }
    else if (e.detail === 'accounts:oauth' || e.detail === 'accounts:api_key') { method = e.detail.split(':')[1]; if (isOpen()) showScreen('accounts'); else open('accounts'); }
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

  // DEBT (#306): the engine also pushes a `settings` frame that holds ITS copy of the shortcut. This panel
  // ignores it and keeps the island's own hotkey.json as the only store, so the two can drift. Reconciling
  // them needs a decision about which store wins, not a patch here.

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
    chip.hidden = !conn || screen === 'settings';
    if (conn) { chip.dataset.tone = conn.tone; chip.setAttribute('aria-label', conn.aria); putIcon($('settings-conn-icon'), conn.icon); $('settings-conn-word').textContent = conn.word; }
    if (screen === 'accounts') renderAccounts();
    else if (screen === 'connectors') renderConnectors();
    else renderGeneral();
    body.scrollTop = keep;
    if (focused && $(focused) && body.contains($(focused))) {
      $(focused).focus();
      if (caret) { try { $(focused).setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
    }
  }

  // ---- Cuentas (gentle-dot AccountsPanel): Conectadas → dos tarjetas de método → lista de proveedores con buscador ----
  function sectionTitle(text) { return el('h3', 'ssection', text); }
  function renderAccounts() {
    const st = agentState || { connection: 'no_daemon', providers: [], accounts: [], profiles: { profiles: [], active: null }, auth: {} };
    const auth = st.auth || {};
    const prompt = V.promptView(auth.prompt);
    drafts.scope(prompt ? `${prompt.flowId}:${prompt.promptId}` : '');
    const eventV = V.eventView(auth.event);
    // a login that was waiting for its brand-new account starts the moment that account shows up
    const ready = V.pendingLoginReady(st, pendingLogin);
    if (ready) { pendingLogin = null; queueMicrotask(() => send({ action: 'auth_start', accountId: ready.accountId, method: ready.method })); }
    if (prompt || eventV || (auth.flowId && !auth.last)) { body.append(renderFlow(auth, prompt, eventV)); return; }
    const outcome = V.flowOutcome(auth.last);
    if (outcome) body.append(chipNode({ tone: outcome.tone, icon: outcome.icon, word: outcome.word, aria: `Inicio de sesión: ${outcome.word}` }));
    if (method === null) {
      const have = V.connectedAccounts(st);
      if (have.length) {
        const sec = el('section', 'ssec'); sec.append(sectionTitle('Conectadas'));
        const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Cuentas conectadas');
        for (const r of have) {
          const li = el('li', 'srow'); li.append(el('b', 'srow-title', r.providerName));
          if (r.local) li.append(chipNode({ tone: 'faint', icon: 'lock', word: 'local', aria: 'Sólo local' }));
          else li.append(wordBtn(V.LOGOUT_WORD, () => send({ action: 'account_logout', accountId: r.accountId }, `${r.providerName}: sesión cerrada.`), { icon: 'plug-off', aria: `${V.LOGOUT_WORD}: ${r.providerName}` }));
          list.append(li);
        }
        sec.append(list); body.append(sec);
      }
      const cards = el('div', 'smethods');
      for (const c of V.METHOD_CARDS) {
        const b = el('button', 'smethod'); b.type = 'button';
        b.append(el('b', '', c.title), el('span', '', c.hint));
        b.addEventListener('click', e => { if (e.isTrusted === true) { method = c.id; filter = ''; render(); } });
        cards.append(b);
      }
      body.append(cards);
      return;
    }
    // provider list for the chosen method
    const back = wordBtn('Volver', () => { method = null; filter = ''; render(); }, { icon: 'arrow-left' }); back.classList.add('sback');
    body.append(back);
    const search = el('input', 'sfield'); search.type = 'search'; search.id = 'settings-filter'; search.placeholder = 'Buscar proveedor';
    search.setAttribute('aria-label', 'Buscar proveedor'); search.autocomplete = 'off'; search.maxLength = 80; search.value = filter;
    search.addEventListener('input', () => { filter = search.value; render(); });
    body.append(search);
    const card = V.METHOD_CARDS.find(c => c.id === method);
    const sec = el('section', 'ssec'); sec.append(sectionTitle(card.title), el('p', 'snote', card.hint));
    const rows = V.providerList(st, method, filter);
    const list = el('ul', 'srows'); list.setAttribute('aria-label', card.title);
    for (const r of rows) {
      const li = el('li', 'srow'); li.append(el('b', 'srow-title', r.name));
      if (r.connected) li.append(chipNode({ tone: 'go', icon: 'check', word: 'Conectado', aria: `${r.name}: conectado` }));
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn(r.actionLabel, () => loginWith(r.id, method), { primary: method === 'oauth', aria: `${r.actionLabel}: ${r.name}`, disabled: !V.loginPlan(st, r.id, method) }));
      if (r.canLogout) actions.append(wordBtn(V.LOGOUT_WORD, () => send({ action: 'account_logout', accountId: r.accountId }, `${r.name}: sesión cerrada.`), { aria: `${V.LOGOUT_WORD}: ${r.name}` }));
      li.append(actions); list.append(li);
    }
    if (!rows.length) list.append(el('li', 'sempty', V.connectionView(st) ? V.connectionView(st).word : 'Sin resultados'));
    sec.append(list); body.append(sec);
  }
  // «Iniciar sesión» / «Usar una clave»: reuse the provider's account, or create one named after the provider first
  function loginWith(providerId, m) {
    const plan = V.loginPlan(agentState, providerId, m);
    if (!plan) return;
    if (plan.kind === 'start') { send({ action: 'auth_start', accountId: plan.accountId, method: plan.method }); return; }
    pendingLogin = V.pendingLogin(agentState, plan.provider, plan.method);
    send({ action: 'account_create', provider: plan.provider, label: plan.label }, `${plan.label}: cuenta creada.`);
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

  // ---- Conectores (gentle-dot ConnectorsPanel): your code agents with ONE click, then the services ----------------------
  function renderConnectors() {
    // 1) agents: Conectar / Actualizar / Desconectar. The click IS the confirmation; the engine installs with a
    //    backup. Nothing here asks the human to open a terminal.
    const av = V.agentsView(agentState, agentsAsk ? { askedAtError: agentsAsk.at, timedOut: agentsAsk.timedOut } : {});
    const sec = el('section', 'ssec'); sec.append(sectionTitle('Agentes de código'));
    if (av.kind === 'unsupported') { sec.append(chipNode(av), el('p', 'snote', av.note)); }
    else if (av.kind !== 'ready') sec.append(chipNode(av.kind === 'loading' ? { tone: 'live', icon: 'ring', word: '', aria: 'Leyendo agentes' } : av));
    else {
      const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Agentes de código');
      for (const r of av.rows) {
        const li = el('li', 'srow sagent'); li.dataset.state = r.state;
        const head = el('span', 'sagent-head'); head.append(el('b', 'srow-title', r.name), chipNode({ tone: r.tone, icon: r.icon, word: r.word, aria: r.aria }));
        li.append(head);
        if (r.note) li.append(el('p', 'snote', r.note));
        const actions = el('span', 'srow-actions');
        if (r.primary) actions.append(wordBtn(r.primary.label, () => send(r.primary.command, `${r.name}: ${r.primary.label === 'Actualizar' ? 'actualizado' : 'conectado'}.`), { primary: true, aria: `${r.primary.label} ${r.name}` }));
        if (r.secondary) actions.append(wordBtn(r.secondary.label, () => send(r.secondary.command, `${r.name}: desconectado.`), { aria: `${r.secondary.label} ${r.name}` }));
        li.append(actions); list.append(li);
      }
      if (!av.rows.length) list.append(el('li', 'sempty', 'Sin agentes'));
      sec.append(list);
    }
    body.append(sec);
    // 2) services (read-only until the engine can connect them)
    const v = V.connectorsView(agentState);
    const svc = el('section', 'ssec'); svc.append(sectionTitle('Servicios'));
    if (v.kind !== 'ready') svc.append(chipNode(v));
    else {
      const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Servicios');
      for (const i of v.items) {
        const li = el('li', 'srow'); li.append(el('b', 'srow-title', i.label));
        if (i.sends) li.append(chipNode({ tone: 'sun', icon: 'arrow-up', word: 'Puede enviar', aria: 'Este conector puede enviar, no sólo leer' }));
        if (i.word || i.icon) li.append(chipNode({ tone: i.tone, icon: i.icon, word: i.word, aria: i.word || 'Conectado' }));
        list.append(li);
      }
      if (v.empty) list.append(el('li', 'sempty', 'Sin servicios'));
      svc.append(list, el('p', 'snote', V.CONNECTORS_NOTE + ' Por ahora sólo se pueden ver; conectarlos llega con el motor.'));
    }
    body.append(svc);
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
  // ---- Ajustes (gentle-dot SettingsPanel): «Atajo de teclado» first, then the rest, each under its own heading -----------
  function renderGeneral() {
    const g = V.generalView({ sound: prefs.sound, motionOverride, hotkey });
    const group = (title, hint) => { const sec = el('section', 'ssec'); sec.append(sectionTitle(title)); if (hint) sec.append(el('p', 'snote', hint)); body.append(sec); return sec; };
    if (g.hotkey) {
      const sec = group('Atajo de teclado', 'Abre y oculta la isla desde cualquier app.');
      const h = g.hotkey;
      const row = el('div', 'srow');
      row.append(el('span', 'srow-title', 'Atajo'));
      row.append(Object.assign(el('kbd', 'skbd', capturing ? 'Pulsá el atajo…' : h.combo), { id: 'settings-combo' }));
      row.append(chipNode({ tone: h.status === 'active' ? 'go' : 'faint', icon: h.backend === 'portal' ? 'check' : 'info', word: h.backendLabel, aria: h.note ? `${h.backendLabel}. ${h.note}` : h.backendLabel }));
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn(capturing ? 'Cancelar' : 'Cambiar', () => { capturing = !capturing; render(); if (capturing) say('Pulsá la combinación nueva; Escape cancela.'); }, { icon: 'refresh' }));
      actions.append(wordBtn('Original', () => call('hotkey_action', { action: 'reset' }).then(r => { hotkey = r; render(); }, () => {})));
      row.append(actions);
      sec.append(row);
      sec.append(toggleRow('sw-hotkey', 'Atajo activo', h.enabled, () => call('hotkey_action', { action: h.enabled ? 'disable' : 'enable' }).then(r => { hotkey = r; render(); }, () => {})));
      if (h.note) sec.append(el('p', 'snote', h.note));
    }
    const sound = group('Sonido', 'Avisos sonoros de la isla. Empieza apagado.');
    sound.append(toggleRow('sw-sound', 'Sonido', g.sound.on, () => call('prefs_action', { action: g.sound.on ? 'sound_off' : 'sound_on' }).then(p => { prefs = p; render(); say(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); }, () => {})));
    const motion = group('Movimiento', 'Qué hace la isla cuando tu sistema pide menos animación.');
    motion.append(toggleRow('sw-motion', 'Respetar el movimiento del sistema', g.motion.respectSystem, () => {
      if (!window.desktop) return;
      (g.motion.respectSystem ? window.desktop.animateAnyway() : window.desktop.respectSystemMotion()).then(s => { motionOverride = s.motionOverride !== false; render(); say(motionOverride ? 'Abito se anima siempre.' : 'Abito respeta el movimiento del sistema.'); }, () => {});
    }));
  }
})();
