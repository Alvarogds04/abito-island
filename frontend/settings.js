'use strict';
/* #306 — the settings panel (providers, connectors, general), an internal panel of the
   chat view like the model picker (same island, same motion). It talks to Rust ONLY
   through three closed commands: `agent_action` (accounts / sign-in / connectors),
   `prefs_action` (sound/gain/name/avatar and local catalog choices) and
   `hotkey_action` (the global shortcut), plus the existing
   window.desktop verbs for system motion. It never sees the agent's token or socket.
   - Plain text only (textContent). No innerHTML anywhere: icons are DOM nodes built from the
     closed own registry (DOMParser), so no data can ever become markup.
   - A key is typed into a MASKED field and sent once through auth_reply (daemon)
     or abito_account_* (local store). The field clears before IPC; keys are never
     placed in snapshots, persistent page drafts, logs or browser storage.
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

  const openers = [$('open-screen-settings')].filter(Boolean); // the chat header gear: the ONE entry (#408)
  // #366 F093: the SAME page runs inside the Rust-created settings window. There the panel
  // fills the window (body[data-window="settings"] CSS) and the island's size is not this
  // page's business. The label is the exact one the sender gate admits (narrow approval).
  const WINDOW_MODE = V.isSettingsWindow(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
    && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  if (WINDOW_MODE) document.body.dataset.window = 'settings';
  const moreGroup = $('connections-more'); // FAKE services cards; render() wipes the body, so it is re-appended per render
  const tabsHost = $('settings-tabs');
  const live = $('settings-live');
  let screen = 'accounts';
  let filter = '';
  let agentsAsk = null;   // { at: engine error counter when agents_list was sent, timer, timedOut }
  let loginTarget = null;  // #408: { providerId, phase: 'active'|'error'|'cancelled', sawFlow } — the login this page started
  let pendingLogin = null; // a login that waits for the account it just asked the engine to create
  let agentState = null;
  let ownedAccounts = null; // masked host projection only, independent of daemon pushes
  let accountForm = null;
  let accountSaving = false;
  let accountError = '';
  let accountNote = null; // #409 T2: outcome of the last removal attempt, in words we own
  let accountGeneration = 0;
  function discardAccountForm() {
    const secret = accountForm && accountForm.querySelector('#account-secret');
    if (secret) secret.value = '';
    accountForm = null; accountError = ''; accountGeneration += 1;
  }
  let prefs = { sound: false };
  let pillSaving = false;
  let pillError = '';
  let gainDraft = null;
  let gainSaving = false;
  let gainError = '';
  // #336 F003: same draft/saving/error pattern as the volume field.
  let autoSaving = false;
  let autoError = '';
  let nameDraft = null; // null follows saved prefs; edited text survives state pushes
  let nameSaving = false;
  let nameError = '';
  let hotkey = null;
  // #390 GD027: the manual restart of the daemon (Ajustes → Conexiones), one in-flight flag
  let daemonBusy = false;
  let daemonNote = null;
  // #327 owns the sole role cache; Settings reads only its immutable id/name projection.
  const AVATAR = window.AbitoAvatarColors;
  const specialistIdentities = () => window.AbitoSpecialistsPanel?.identityView() || { kind: 'loading', identities: [] };
  document.addEventListener('abito:specialist-identities', () => render());
  // F1: feedback belongs to its identity and survives renders/retries until a save succeeds.
  const colorErrors = Object.create(null);
  let motionOverride = true;
  let themeError = ''; // #380: a failed theme save keeps the previous theme and says so
  let capturing = false;
  let pendingOpen = false;
  const drafts = V.makeDrafts(); // what is being typed survives the re-renders (memory only)
  let busy = false;

  const say = text => { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
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

  // #384: the Dot's colour, one row per identity the human can colour. The swatches are a
  // radiogroup of real buttons (keyboard reachable, each with its own name) and the CURRENT
  // colour is also written as a word: the meaning never rides on colour alone
  // (docs/desktop-visual-language.md §1.1 C5).
  const avatarName = id => (AVATAR && AVATAR.isPrincipal(id) ? 'Abito' : specialistIdentities().identities.find(identity => identity.id === id)?.name || String(id));
  function colorRow(row) {
    const line = el('div', 'srow scolors');
    line.dataset.identity = row.id;
    line.dataset.color = row.color;
    line.append(el('span', 'srow-title', row.name));
    const options = el('span', 'sdot-options');
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', `Color de ${avatarName(row.id)}`);
    for (const option of row.options) {
      const b = el('button', 'sdot');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria);
      b.dataset.color = option.color;
      // render() restores focused IDs on both invoke responses and prefs:state events.
      b.id = `dot-color-${row.id}-${option.color}`;
      b.tabIndex = option.selected ? 0 : -1;
      b.append(el('span', 'sdot-swatch'));
      b.append(el('span', 'sdot-label', option.label));
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const buttons = [...options.querySelectorAll('[role="radio"]')];
        const at = buttons.indexOf(b);
        let next = (at + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
        buttons[next].focus();
        chooseColor(row.id, buttons[next].dataset.color);
      });
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseColor(row.id, option.color); });
      options.append(b);
    }
    line.append(options);
    line.append(chipNode({ tone: 'faint', icon: 'check', word: row.label, aria: row.aria }));
    if (colorErrors[row.id]) {
      const error = el('span', 'sdot-error', colorErrors[row.id]);
      error.id = `dot-color-error-${row.id}`;
      options.setAttribute('aria-describedby', error.id);
      error.setAttribute('role', 'status');
      line.append(error);
    }
    return line;
  }
  // The engine and the file are the truth: a failed save says so and keeps the previous colour.
  function chooseColor(identity, color) {
    call('prefs_action', { action: 'set_avatar_color', identity, color }).then(
      p => {
        const saved = AVATAR.resolveColor(identity, p.avatarColors);
        delete colorErrors[identity];
        prefs = p; render();
        say(`Color de ${avatarName(identity)}: ${AVATAR.label(saved)}.`);
      },
      () => {
        colorErrors[identity] = 'No se pudo guardar el color; se mantuvo el anterior.';
        render();
        say(colorErrors[identity]);
      });
  }

  // #380: system / light / dark. The click only SENDS the choice: the host validates the closed
  // enum, persists it and publishes `prefs:state`; theme.js paints from that saved state. So a
  // failed save leaves the previous theme on screen (no optimistic paint, no false «guardado»).
  function chooseTheme(mode) {
    return call('prefs_action', { action: 'set_theme', theme: mode }).then(p => {
      themeError = '';
      prefs = p;
      render();
      const view = V.themeView(p);
      const chosen = view.options.find(o => o.selected) || view.options[0];
      say(`Tema guardado: ${chosen.label}.`);
    }, () => {
      themeError = 'No se pudo guardar el tema; se mantuvo el anterior.';
      render();
      say(themeError);
    });
  }

  // ---- open / close ---------------------------------------------------------------------------------------
  // #408: the sub-tab strip, built once from V.TABS. Roving tabindex + arrow keys (WAI-ARIA tablist).
  function buildTabs() {
    if (!tabsHost) return;
    for (const def of V.TABS) {
      const b = el('button', 'stab');
      b.type = 'button'; b.id = `settings-tab-${def.id}`; b.dataset.tab = def.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', def.id === 'models' ? 'models' : 'settings-body');
      const i = el('span', 'ico'); putIcon(i, def.icon);
      b.append(i, el('span', 'word', def.label));
      b.addEventListener('click', e => { if (e.isTrusted === true) showScreen(def.id); });
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || e.isComposing) return;
        const next = V.tabKeyTarget(def.id, e.key);
        if (!next) return;
        e.preventDefault(); e.stopPropagation();
        showScreen(next);
        const nb = $(`settings-tab-${next}`); if (nb) nb.focus();
      });
      tabsHost.append(b);
    }
  }
  buildTabs();
  // #408: at the Settings size (wide) the tabs are a vertical rail; in the 400 column a wrapping row.
  const RAIL_MIN_W = 600;
  function syncRail() {
    const wide = typeof panel.clientWidth === 'number' && panel.clientWidth >= RAIL_MIN_W;
    panel.dataset.rail = wide ? 'true' : 'false';
    if (tabsHost) tabsHost.setAttribute('aria-orientation', wide ? 'vertical' : 'horizontal');
  }
  window.addEventListener('resize', syncRail);
  function showScreen(id) {
    screen = id;
    id = V.tabAlias(id) || 'accounts';
    screen = id;
    if (id !== 'accounts') { filter = ''; discardAccountForm(); }
    const def = V.tabById(id);
    $('settings-title').textContent = 'Ajustes';
    $('settings-hint').textContent = def.hint;
    $('settings-hint').hidden = !def.hint;
    panel.setAttribute('aria-label', `Ajustes: ${def.title}`);
    if (tabsHost) for (const b of tabsHost.children) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    body.hidden = id === 'models'; // the model picker is its own panel (models.js), shown by the event below
    // #410: the open sub-tab is a PUBLIC DOM attribute of the tabpanel. The compact Conexiones rules
    // (#410 block in style.css) are scoped to it, so every other Ajustes tab keeps its own look.
    body.dataset.screen = id;
    document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: id }));
    if (id === 'accounts') { agent({ action: 'connectors_list' }).catch(() => {}); askAgents(); }
    render();
  }
  // The engine answers `agents_list` with an `agents` frame — or, if it does not know the command, with
  // error{bad_request}, or with silence. All three end the wait (see V.agentsView).
  // #436 T6.5: the read-only hooks preview rides the SAME ask: one extra closed command when the
  // Conexiones tab opens (and never on a timer), so the six rows get their real state cheaply.
  function askAgents() {
    if (agentsAsk) clearTimeout(agentsAsk.timer);
    const ask = { at: (agentState && agentState.last_error && agentState.last_error.n) || 0, timedOut: false, timer: 0 };
    ask.timer = setTimeout(() => { ask.timedOut = true; if (isOpen() && screen === 'accounts') render(); }, V.AGENTS_WAIT_MS);
    agentsAsk = ask;
    agent({ action: 'agents_list' }).catch(() => {});
    agent({ action: 'hooks_preview' }).catch(() => {});
  }
  // The first state normally arrives within a few ms. If it never does, stop saying «Conectando»: the engine
  // is not there, and the screen says so (the same honest word as before, just not before it was asked).
  let connectTimer = 0;
  // #408: Ajustes asks Rust for the Settings size on open and gives it back on close. Rust owns the number
  // (geometry::settings_visible, clamped to the work area); the page only says open/closed. A failure
  // leaves the chat size, which still works (scrolling), so it is never fatal.
  function askSize(openNow) { call('settings_view', { open: openNow }).catch(() => {}); }
  function open(id) {
    clearTimeout(connectTimer);
    if (agentState === null) connectTimer = setTimeout(() => { if (agentState === null) { agentState = { connection: 'no_daemon' }; if (isOpen()) render(); } }, V.CONNECT_WAIT_MS);
    panel.inert = false; panel.dataset.open = 'true'; capsule.dataset.settings = 'open';
    for (const b of openers) b.setAttribute('aria-expanded', 'true');
    if (!WINDOW_MODE) askSize(true); // #366: the own window never resizes the island
    syncRail();
    refreshAll();
    showScreen(id || screen);
    $('settings-close').focus();
  }
  function close(byKeyboard) {
    // #366 F093: in the own window the panel close IS the window close: the ONE closed
    // command asks Rust (the island's size and focus are never this window's business).
    if (WINDOW_MODE) {
      call('settings_window_action', { action: 'close' }).catch(() => {});
      panel.inert = true; delete panel.dataset.open;
      document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: null }));
      if (agentsAsk) { clearTimeout(agentsAsk.timer); agentsAsk = null; }
      discardAccountForm();
      drafts.reset();
      return;
    }
    if (isOpen()) askSize(false);
    panel.inert = true; delete panel.dataset.open; delete capsule.dataset.settings;
    document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: null })); // closes the model picker with it
    capturing = false; filter = ''; pendingLogin = null; loginTarget = null; accountNote = null;
    if (agentsAsk) { clearTimeout(agentsAsk.timer); agentsAsk = null; }
    for (const b of openers) b.setAttribute('aria-expanded', 'false');
    discardAccountForm();
    drafts.reset(); // a half-typed key never outlives the panel
    if (waiting) { clearTimeout(waiting.timer); waiting = null; }
    // #408: focus returns to the control that opened Ajustes (the gear in the chat header)
    if (byKeyboard) { const g = $('open-screen-settings'); if (g) g.focus(); }
  }
  const isOpen = () => panel.dataset.open === 'true';

  // #366 F093: the typed pref chooses. ONE closed command asks Rust for the own window;
  // an answer that says the window was not used (the pref chose in-island) and ANY failure
  // both fall back to the in-island panel — the #408 default is never a dead gear.
  function openWindowOrInIsland() {
    const id = screen;
    call('settings_window_action', { action: 'open' }).then(windowOpen => {
      if (windowOpen && windowOpen.open === true) return; // the own window is up (Rust created it)
      open(id); // the typed pref chose in-island
    }).catch(() => open(screen)); // any failure falls back to in-island Settings too
  }
  // the chat-header gear toggles Ajustes; the gear of the overview opens the chat view first
  for (const b of openers) b.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    if (isOpen()) close(e.detail === 0);
    else if (V.settingsWindowView(prefs).on) openWindowOrInIsland();
    else open(screen);
  });
  const gear = $('open-settings');
  if (gear) gear.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    if (V.settingsWindowView(prefs).on) { openWindowOrInIsland(); return; } // #366: no island detour needed
    pendingOpen = screen;
    call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; });
  });
  document.addEventListener('island:view', e => {
    if (e.detail === 'chat' && pendingOpen) { const id = pendingOpen; pendingOpen = false; open(id); }
    else if (e.detail !== 'chat' && isOpen()) close(false);
  });
  $('settings-close').addEventListener('click', e => { if (e.isTrusted === true) close(e.detail === 0); });
  // #437 D9: «Ventana» in the in-island bar — the shortcut to the full Ajustes window.
  // Built only for the in-island bar (in WINDOW_MODE the page already IS that window).
  // The ONE closed window command only opens when the typed pref says so
  // (settingswindow.rs answers open:false otherwise), so the click first saves the
  // pref through the closed prefs command and then opens the window. «Ventana» means
  // «open Ajustes in the window from now on»: the persistent pref flip is the point,
  // and the General toggle («Abrir Ajustes en ventana») shows the new placement right
  // away because prefs is the saved truth. A failed save or a failed open keeps the
  // panel as it was: the pref is reverted and the failure is said, never silent.
  const ventana = (() => {
    if (WINDOW_MODE) return null;
    const closeBtn = $('settings-close');
    if (!closeBtn || !closeBtn.parentElement) return null;
    const b = el('button', 'sbtn', 'Ventana');
    b.type = 'button';
    b.id = 'settings-window-open';
    b.setAttribute('aria-label', 'Abrir Ajustes en ventana');
    closeBtn.parentElement.insertBefore(b, closeBtn);
    return b;
  })();
  if (ventana) ventana.addEventListener('click', e => {
    if (e.isTrusted !== true || ventana.disabled) return;
    ventana.disabled = true; // one flight at a time; the pref must not flip twice
    call('prefs_action', { action: 'set_settings_window', settings_window: true }).then(p => {
      prefs = p; render(); // the General toggle reflects the new placement immediately
      return call('settings_window_action', { action: 'open' }).then(opened => {
        if (opened && opened.open === true) { close(false); return; } // the panel yields to the window
        throw new Error('the window was not opened');
      });
    }).catch(() => {
      call('prefs_action', { action: 'set_settings_window', settings_window: false }).then(p => { prefs = p; render(); }, () => {});
      say('No se pudo abrir la ventana. Ajustes sigue dentro de la isla.');
    }).finally(() => { ventana.disabled = false; });
  });
  // The inert seam for the visual probe (a script click is rightly not a trusted gesture): a CustomEvent
  // that only opens a screen, never a setting. The shipped binary has no probe, so nothing ever fires it.
  document.addEventListener('abito:settings-select', e => {
    if (e.detail === 'open') { pendingOpen = screen; call('chat_action', { action: 'open' }).catch(() => { pendingOpen = false; }); }
    else if (V.tabAlias(e.detail) && !String(e.detail).includes(':')) { filter = ''; if (isOpen()) showScreen(e.detail); else open(V.tabAlias(e.detail)); }
    // the old accounts:<method> deep links still land on Conexiones; the method choice now lives in each row
    else if (e.detail === 'accounts:oauth' || e.detail === 'accounts:api_key') { if (isOpen()) showScreen('accounts'); else open('accounts'); }
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
  // #366 F093: the gear consults the placement pref even before the panel was ever
  // opened, so the typed choice survives a page reload: one honest view fetch at startup.
  if (!WINDOW_MODE) call('prefs_action', { action: 'view' }).then(p => { prefs = p; }, () => {});
  function applyAgent(next) {
    if (next && typeof next === 'object') {
      if (Object.hasOwn(next, 'ownedAccounts')) ownedAccounts = next.ownedAccounts === null ? null : { accounts: V.ownedAccounts(next.ownedAccounts) };
      // Partial local snapshots cannot erase the independent OAuth/connector state.
      agentState = Object.assign({}, agentState || {}, next);
      settle(agentState); render();
    }
  }
  if (listen) {
    const warnListen = name => err => console.error(`settings: live ${name} events unavailable`, err); // R1: never swallowed again
    listen('agent:state', e => applyAgent(e && e.payload)).catch(warnListen('agent:state'));
    listen('prefs:state', e => { if (e && e.payload) { prefs = e.payload; render(); } }).catch(warnListen('prefs:state'));
    listen('hotkey:state', e => { if (e && e.payload) { hotkey = e.payload; render(); } }).catch(warnListen('hotkey:state'));
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
      if (loginTarget && loginTarget.phase === 'active' && !loginTarget.sawFlow && /^(auth_start|account_create)$/.test(payload.action)) { loginTarget.phase = 'error'; pendingLogin = null; }
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
    chip.hidden = !conn || screen !== 'accounts';
    if (conn) { chip.dataset.tone = conn.tone; chip.setAttribute('aria-label', conn.aria); putIcon($('settings-conn-icon'), conn.icon); $('settings-conn-word').textContent = conn.word; }
    if (screen === 'accounts') { renderAccounts(); renderConnectors(); }
    else if (screen === 'models') { /* models.js owns this panel */ }
    else if (screen === 'specialists') {
      // #327: the human creates a role, chooses it and goes back to the principal from here.
      const panel = window.AbitoSpecialistsPanel;
      if (panel) {
        const host = el('div');
        host.id = 'specialists-section';
        body.append(host);
        panel.renderSection(host);
      } else {
        body.append(el('p', 'snote', 'Los especialistas no están disponibles en esta compilación.'));
      }
    } else renderGeneral(); // pills / appearance / general: each section names its tab
    if (moreGroup) { moreGroup.hidden = !V.servicesGroupVisible(screen); if (!moreGroup.hidden) body.append(moreGroup); }
    body.scrollTop = keep;
    if (focused && $(focused) && body.contains($(focused))) {
      $(focused).focus();
      if (caret) { try { $(focused).setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
    }
  }

  // #308: Abito-owned configuration, not a daemon login or a readiness claim.
  function accountTarget(node) {
    node.style.minHeight = '44px'; node.style.minWidth = '44px';
    node.style.maxWidth = '100%'; node.style.boxSizing = 'border-box';
    return node;
  }
  function renderOwnedAccounts() {
    const section = el('section', 'ssec'); section.id = 'owned-accounts';
    section.append(sectionTitle('Configuración de proveedores'));
    section.append(el('p', 'snote', 'Guardado local en Abito. Conexión no probada; no cambia el modelo del chat.'));
    if (ownedAccounts === null) {
      section.append(el('p', 'snote', 'El almacén de cuentas no está disponible. No se modificó ninguna cuenta.'));
    } else if (accountForm) {
      // Keep the same masked DOM field across unrelated daemon/prefs pushes; never copy its value into drafts.
      section.append(accountForm);
    } else {
      for (const account of ownedAccounts.accounts) {
        const row = el('div', 'srow'); row.style.flexWrap = 'wrap';
        const title = el('b', 'srow-title', account.config.nombre); title.style.overflowWrap = 'anywhere';
        // #410 S2: the credential state is an icon chip from the closed registry (same two words as
        // before) instead of a bare line of muted text. Faint tone: a stored key is CONFIGURATION,
        // never a connection claim (#308).
        row.append(title, chipNode({ tone: 'faint', icon: account.hasCredential ? 'lock' : 'plug-off',
          word: account.hasCredential ? 'Clave guardada' : 'Sin clave' }));
        row.append(accountTarget(wordBtn('Editar', () => { accountForm = makeAccountForm(account); render(); }, { disabled: accountSaving, aria: `Editar ${account.config.nombre}` })));
        // #409 T2 / S5: deletion stays reachable now that the Pi card is gone (same sentences, same non-mutation).
        row.append(accountTarget(wordBtn('Quitar conexión', () => removeAccount(account.accountId), { icon: 'plug-off', disabled: accountSaving, aria: `Quitar conexión: ${account.config.nombre}` })));
        section.append(row);
      }
      const add = accountTarget(wordBtn('Configurar proveedor', () => { accountForm = makeAccountForm(null); render(); }, { disabled: accountSaving }));
      add.id = 'account-add'; section.append(add);
    }
    if (accountNote) { const n = el('p', accountNote.tone === 'red' ? 'snote sproblem' : 'snote', accountNote.say); n.setAttribute('role', accountNote.tone === 'red' ? 'alert' : 'status'); section.append(n); }
    if (accountError) { const error = el('p', 'snote', accountError); error.setAttribute('role', 'alert'); section.append(error); }
    body.append(section);
  }
  // #409 T2: removing an owned account from its row. Success updates the masked snapshot from the
  // reply; failure changes nothing and says so. The verb and sentences are the ones of the removed card.
  function removeAccount(accountId) {
    if (accountSaving) return;
    accountSaving = true; accountNote = null; render();
    agent({ action: 'abito_account_remove', accountId }).then(r => {
      accountSaving = false;
      if (r && Object.hasOwn(r, "ownedAccounts") && r.ownedAccounts) ownedAccounts = { accounts: V.ownedAccounts(r.ownedAccounts) };
      accountNote = { tone: 'go', say: 'Conexión quitada. La clave se borró del almacén de Abito.' }; render(); say(accountNote.say);
    }, () => { accountSaving = false; accountNote = { tone: 'red', say: 'No se pudo quitar la conexión. No se cambió nada.' }; render(); });
  }
  function makeAccountForm(saved) {
    accountError = '';
    const form = el('form', 'sform'); form.id = 'account-form'; form.autocomplete = 'off';
    // Existing sform is horizontal for short auth replies; configuration needs a single narrow column.
    form.style.display = 'flex'; form.style.flexDirection = 'column'; form.style.flexWrap = 'nowrap';
    form.style.alignItems = 'stretch'; form.style.gap = '8px'; form.style.minWidth = '0';
    const field = (id, title, kind, value) => {
      const label = el('label', 'snote', title); label.htmlFor = id;
      const node = accountTarget(el(kind === 'select' ? 'select' : 'input', 'sfield'));
      // Neutralize the auth form's text-input order/flex rule only inside this editor.
      node.id = id; node.style.width = '100%'; node.style.order = '0'; node.style.flex = 'none'; node.autocomplete = 'off';
      if (kind !== 'select') { node.type = kind; node.value = value || ''; node.maxLength = 2048; }
      form.append(label, node); return node;
    };
    const option = (select, value, text) => { const node = el('option', '', text); node.value = value; select.append(node); };
    const provider = field('account-provider', 'Proveedor', 'select');
    const presets = [
      ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1', 'anthropic-messages'],
      ['google', 'Google', 'https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai'],
      ['openai', 'OpenAI', 'https://api.openai.com/v1', 'openai-completions'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions'],
      ['ollama', 'Ollama (local)', 'http://127.0.0.1:11434/v1', 'openai-completions'],
      ['lmstudio', 'LM Studio (local)', 'http://127.0.0.1:1234/v1', 'openai-completions'],
      ['custom', 'Endpoint personalizado (HTTPS)', '', 'openai-completions'],
    ];
    for (const [id, title] of presets) option(provider, id, title);
    if (saved && !presets.some(p => p[0] === saved.provider)) option(provider, saved.provider, saved.provider);
    provider.value = saved ? saved.provider : 'openai'; provider.disabled = !!saved;
    const config = saved ? saved.config : {};
    const name = field('account-name', 'Nombre de la cuenta', 'text', config.nombre || 'OpenAI'); name.maxLength = 80;
    const url = field('account-url', 'URL base (HTTPS remota / HTTP de loopback local)', 'text', config.baseUrl || 'https://api.openai.com/v1');
    const api = field('account-api', 'API', 'select');
    for (const id of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) option(api, id, id);
    api.value = config.api || 'openai-completions';
    const models = field('account-models', 'Modelos (separados por comas)', 'text', (config.models || []).join(', '));
    const defaultModel = field('account-default', 'Modelo predeterminado de esta cuenta', 'text', config.defaultModel); defaultModel.maxLength = 200;
    const credential = field('account-credential', saved && saved.hasCredential ? 'Clave guardada' : 'Sin clave guardada', 'select');
    option(credential, 'keep', 'Conservar'); option(credential, 'set', 'Establecer clave'); option(credential, 'clear', 'Borrar clave');
    const secret = field('account-secret', 'Clave (oculta; nunca se recupera del almacén)', 'password');
    secret.maxLength = 4096; secret.spellcheck = false; secret.disabled = true;
    secret.setAttribute('autocapitalize', 'off'); secret.setAttribute('autocomplete', 'new-password');
    credential.addEventListener('change', e => { if (e.isTrusted === true) { secret.value = ''; secret.disabled = credential.value !== 'set'; } });
    provider.addEventListener('change', e => {
      if (e.isTrusted !== true) return;
      const preset = presets.find(p => p[0] === provider.value);
      if (preset) { name.value = preset[1]; url.value = preset[2]; api.value = preset[3]; }
      secret.value = ''; credential.value = 'keep'; secret.disabled = true;
    });
    const controls = el('div', 'srow-actions'); controls.style.flexWrap = 'wrap'; controls.style.gap = '8px';
    const save = accountTarget(wordBtn('Guardar configuración', () => {}, { primary: true })); save.type = 'submit'; save.id = 'account-save';
    controls.append(save);
    if (saved) {
      const endpoint = accountTarget(wordBtn('Guardar endpoint', () => submit('abito_account_endpoint_set')));
      endpoint.id = 'account-endpoint'; controls.append(endpoint);
    }
    controls.append(accountTarget(wordBtn('Cancelar', () => { discardAccountForm(); render(); })));
    form.append(controls);
    form.addEventListener('submit', e => {
      e.preventDefault(); if (e.isTrusted === true) submit(saved ? 'abito_account_save' : 'abito_account_create');
    });
    function submit(action) {
      if (accountSaving) return;
      const value = { nombre: name.value, baseUrl: url.value, api: api.value, compat: config.compat || {},
        models: models.value.split(',').map(x => x.trim()).filter(Boolean), defaultModel: defaultModel.value };
      if (credential.value === 'set') value.apiKey = secret.value;
      else if (credential.value === 'clear') value.apiKey = null;
      secret.value = ''; // clear BEFORE IPC, including on failure; never keep a retry credential
      const payload = { action, accountId: saved ? saved.accountId : `account-${Date.now().toString(36)}`, provider: provider.value, config: value };
      accountSaving = true; accountError = '';
      const generation = accountGeneration;
      const buttons = [...controls.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
      agent(payload).then(next => {
        accountSaving = false;
        if (generation === accountGeneration) discardAccountForm();
        applyAgent(next); say('Configuración guardada. Conexión no probada.');
      }, () => {
        accountSaving = false;
        if (generation !== accountGeneration) return;
        buttons.forEach(b => { b.disabled = false; });
        accountError = 'No se pudo guardar. Revisá la URL, los modelos y los permisos. Se mantuvo la configuración anterior; volvé a ingresar la clave si corresponde.';
        render(); say(accountError);
      });
      // Payload is only retained by the one IPC invocation, never in the page's persistent draft state.
    }
    return form;
  }

  // ---- Cuentas (gentle-dot AccountsPanel): Conectadas → dos tarjetas de método → lista de proveedores con buscador ----
  function sectionTitle(text) { return el('h3', 'ssection', text); }
  // #390 GD027: ONE closed command stops and relaunches the daemon (Rust owns the whole
  // lifecycle: bounded stop, fresh spawn, bounded wait). The wording is ours; a failure is
  // shown, never hidden; the button disables itself while a restart is in flight.
  function renderDaemonSection() {
    const v = V.daemonRestartView(daemonBusy);
    const sec = el('section', 'ssec'); sec.id = 'daemon-restart';
    sec.append(sectionTitle(v.title));
    sec.append(el('p', 'snote', v.hint));
    const row = el('div', 'srow');
    row.append(el('span', 'srow-title', 'Motor'));
    const actions = el('span', 'srow-actions');
    actions.append(wordBtn(v.action.label, () => restartDaemon(), { icon: 'refresh', disabled: v.action.disabled, aria: v.action.aria }));
    row.append(actions);
    sec.append(row);
    if (daemonNote) {
      const note = el('p', daemonNote.tone === 'red' ? 'snote sproblem' : 'snote', daemonNote.say);
      note.id = 'daemon-restart-note';
      note.setAttribute('role', daemonNote.tone === 'red' ? 'alert' : 'status');
      sec.append(note);
    }
    body.append(sec);
  }
  function restartDaemon() {
    if (daemonBusy) return;
    daemonBusy = true; daemonNote = null; render();
    call('daemon_action', { action: 'restart' }).then(result => {
      daemonBusy = false;
      daemonNote = V.daemonRestartOutcome(result);
      render();
      say(daemonNote.say);
      agent({ action: 'view' }).then(applyAgent, () => {}); // the fresh daemon's state, through the normal channel
    }, error => {
      daemonBusy = false;
      daemonNote = V.daemonRestartOutcome(null, error);
      render();
      say(daemonNote.say);
    });
  }
  function renderAccounts() {
    renderDaemonSection();
    renderOwnedAccounts();
    const st = agentState || { connection: 'connecting', providers: [], accounts: [], profiles: { profiles: [], active: null }, auth: {} };
    const auth = st.auth || {};
    const prompt = V.promptView(auth.prompt);
    drafts.scope(prompt ? `${prompt.flowId}:${prompt.promptId}` : '');
    const eventV = V.eventView(auth.event);
    // a login that was waiting for its brand-new account starts the moment that account shows up
    const ready = V.pendingLoginReady(st, pendingLogin);
    if (ready) { pendingLogin = null; queueMicrotask(() => send({ action: 'auth_start', accountId: ready.accountId, method: ready.method })); }
    const flowLive = !!(prompt || eventV || (auth.flowId && !auth.last));
    // #408: the page remembers WHICH provider started the login, so status, progress and error sit on its card.
    if (loginTarget && loginTarget.phase === 'active') {
      if (flowLive) { loginTarget.sawFlow = true; if (!loginTarget.flowId && auth.flowId) loginTarget.flowId = String(auth.flowId); }
      else if (loginTarget.sawFlow && auth.last) {
        const out = V.flowOutcome(auth.last);
        if (out.word === 'Conectada') loginTarget = null;
        else loginTarget.phase = out.word === 'Cancelado' ? 'cancelled' : 'error';
      }
    }
    if (flowLive && !loginTarget) { body.append(renderFlow(auth, prompt, eventV)); return; } // a flow started elsewhere
    const outcome = loginTarget ? null : V.flowOutcome(auth.last);
    if (outcome && outcome.word === 'Conectada') body.append(chipNode({ tone: outcome.tone, icon: outcome.icon, word: outcome.word, aria: `Inicio de sesión: ${outcome.word}` }));
    // #410 round 2: the compact provider LIST (one row per provider, two buttons: API / Auth).
    // The method filter bar is gone: the two per-row buttons ARE the method choice. The search
    // stays, so a long engine list is still usable.
    const search = el('input', 'sfield'); search.type = 'search'; search.id = 'settings-filter'; search.placeholder = 'Buscar proveedor';
    search.setAttribute('aria-label', 'Buscar proveedor'); search.autocomplete = 'off'; search.maxLength = 80; search.value = filter;
    search.addEventListener('input', () => { filter = search.value; render(); });
    body.append(search);
    const sec = el('section', 'ssec'); sec.id = 'provider-list'; sec.append(sectionTitle('Proveedores de IA'));
    const rows = V.providerRows(st, { filter, flow: loginTarget });
    const list = el('ul', 'srows sconn'); list.setAttribute('aria-label', 'Proveedores');
    for (const r of rows) {
      const li = el('li', 'srow sconn-row'); li.dataset.state = r.status.kind; li.dataset.provider = r.id;
      const head = el('span', 'sconn-head'); head.append(el('b', 'srow-title', r.name), chipNode({ tone: r.status.tone, icon: r.status.icon, word: r.status.word, aria: `${r.name}: ${r.status.word}` }));
      li.append(head);
      if (r.error) { const e = el('p', 'snote sproblem', r.error); e.setAttribute('role', 'alert'); li.append(e); }
      if (r.note) li.append(el('p', 'snote', r.note));
      if (r.status.kind === 'progress' && flowLive) li.append(renderFlow(auth, prompt, eventV, true));
      else if (r.status.kind === 'progress') li.append(el('p', 'snote', 'Preparando el inicio de sesión…'));
      const actions = el('span', 'srow-actions');
      // the two connect words ride the view-model (the human's own: API / Auth); the row's
      // cancel/logout are the same closed verbs as before, just behind state
      const connect = a => wordBtn(a.word, () => loginWith(r.id, a.method), { aria: a.aria, disabled: a.disabled });
      if (r.api) actions.append(connect(r.api));
      if (r.auth) actions.append(connect(r.auth));
      if (r.cancel) actions.append(wordBtn(r.cancel.word, () => cancelLogin(), { icon: 'cross', aria: r.cancel.aria }));
      if (r.logout) actions.append(wordBtn(V.LOGOUT_WORD, () => send({ action: 'account_logout', accountId: r.accountId }, `${r.name}: sesión cerrada.`), { icon: 'plug-off', aria: `${V.LOGOUT_WORD}: ${r.name}` }));
      if (actions.children.length) li.append(actions);
      list.append(li);
    }
    if (!rows.length) list.append(el('li', 'sempty', V.connectionView(st) ? V.connectionView(st).word : 'Sin resultados'));
    sec.append(list); body.append(sec);
  }
  function cancelLogin() {
    const plan = V.cancelPlan(loginTarget);
    if (plan.kind === 'send') { send({ action: 'auth_cancel', flowId: plan.flowId }); return; }
    loginTarget = null; pendingLogin = null; render();
  }
  // «Iniciar sesión» / «Usar una clave»: reuse the provider's account, or create one named after the provider first
  function loginWith(providerId, m) {
    const plan = V.loginPlan(agentState, providerId, m);
    if (!plan) return;
    loginTarget = { providerId, phase: 'active', sawFlow: false };
    render();
    if (plan.kind === 'start') { send({ action: 'auth_start', accountId: plan.accountId, method: plan.method }); return; }
    pendingLogin = V.pendingLogin(agentState, plan.provider, plan.method);
    send({ action: 'account_create', provider: plan.provider, label: plan.label }, `${plan.label}: cuenta creada.`);
  }

  // The sign-in flow. The ONLY secret path: a masked field -> auth_reply -> cleared.
  function renderFlow(auth, prompt, eventV, embedded) {
    const box = el('div', 'sflow'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Inicio de sesión en curso');
    if (eventV) {
      if (eventV.message) box.append(el('p', 'sline', eventV.message));
      if (eventV.userCode) box.append(Object.assign(el('code', 'scode', eventV.userCode), { title: 'Código de verificación' }));
      if (eventV.link) {
        // #421: a real anchor, but href never carries the remote URL (the webview must not navigate away).
        // Every gesture (click, Ctrl/Meta/Shift+click, Enter, middle click, context-menu) is cancelled and
        // only a trusted one opens, through the validated host command. Text via textContent only.
        const a = el('a', 'slink', eventV.link);
        a.setAttribute('href', '#'); a.setAttribute('role', 'link'); a.title = 'Abrir el enlace';
        const open = e => {
          e.preventDefault(); e.stopPropagation();
          if (e.isTrusted === true && invoke) invoke('open_chat_url', { payload: { url: eventV.link } }).catch(() => {});
        };
        a.addEventListener('click', open); a.addEventListener('auxclick', open);
        a.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
        box.append(a);
      } else if (eventV.linkRejected) {
        box.append(el('p', 'sline sub', 'No se pudo abrir el enlace desde acá.')); // never echoes the rejected URL
      }
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
    if (!embedded) box.append(wordBtn('Cancelar', () => send({ action: 'auth_cancel', flowId: prompt ? prompt.flowId : String((auth && auth.flowId) || '') }), { icon: 'cross' }));
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
    const sec = el('section', 'ssec'); sec.append(sectionTitle('Agentes')); sec.id = 'connections-agents';
    if (av.kind === 'unsupported') { sec.append(chipNode(av), el('p', 'snote', av.note)); }
    else if (av.kind !== 'ready') sec.append(chipNode(av.kind === 'loading' ? { tone: 'live', icon: 'ring', word: '', aria: 'Leyendo agentes' } : av));
    else {
      const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Agentes');
      for (const r of av.rows) {
        const li = el('li', 'srow sagent'); li.dataset.state = r.state;
        const head = el('span', 'sagent-head'); head.append(el('b', 'srow-title', r.name), chipNode({ tone: r.tone, icon: r.icon, word: r.word, aria: r.aria }));
        li.append(head);
        // the plan the human is about to approve, in OUR words, right above the button that approves it
        if (r.summary) li.append(el('p', 'splan', r.summary));
        if (r.note) li.append(el('p', r.trust ? 'snote strust' : 'snote', r.note));
        const actions = el('span', 'srow-actions');
        if (r.primary) actions.append(wordBtn(r.primary.label, () => send(r.primary.command, `${r.name}: ${r.primary.label === 'Actualizar' ? 'actualizado' : 'conectado'}.`), { primary: true, aria: `${r.primary.label} ${r.name}. ${r.summary || ''}` }));
        if (r.secondary) actions.append(wordBtn(r.secondary.label, () => send(r.secondary.command, `${r.name}: desconectado.`), { aria: `${r.secondary.label} ${r.name}` }));
        li.append(actions); list.append(li);
      }
      if (!av.rows.length) list.append(el('li', 'sempty', 'Sin agentes'));
      sec.append(list);
    }
    body.append(sec);
    // 2) services (read-only until the engine can connect them)
    const v = V.connectorsView(agentState);
    const svc = el('section', 'ssec'); svc.append(sectionTitle('Servicios')); svc.id = 'connections-services';
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
    const g = V.generalView({ sound: prefs.sound, gain: prefs.gain, motionOverride, hotkey });
    // each section belongs to one tab (#408); a section of another tab is built detached and never attached
    const group = (tab, title, hint) => { const sec = el('section', 'ssec'); sec.append(sectionTitle(title)); if (hint) sec.append(el('p', 'snote', hint)); if (tab === screen) body.append(sec); return sec; };
    // #366 F093: where Ajustes opens — inside the island (default, #408) or in its own
    // window. The typed pref is the only chooser; a failed save keeps the previous
    // placement and says so.
    // T6.3 #434: General groups exactly as the design shows them: PERFIL / ISLA / SONIDO Y ATAJO
    // (design ajustes-ventana-general-{dark,light}.png, DESIGN-NOTES §3). Created in the design's
    // order, filled below. Copy diet: no hint walls, one hint at most.
    const perfil = group('general', 'Perfil');
    const isla = group('general', 'Isla');
    const sound = group('general', 'Sonido y atajo');
    const personal = perfil;
    const nameForm = el('form', 'sname-form sperfil-form'); nameForm.noValidate = true;
    const label = el('label', 'srow-title', 'Nombre'); label.htmlFor = 'settings-display-name';
    const nameInput = el('input', 'sfield'); nameInput.type = 'text'; nameInput.id = 'settings-display-name';
    nameInput.autocomplete = 'off'; nameInput.spellcheck = false;
    nameInput.setAttribute('placeholder', 'Tu nombre (opcional)');
    nameInput.value = nameDraft === null ? (prefs.displayName || '') : nameDraft;
    nameInput.setAttribute('aria-describedby', 'settings-name-error');
    const error = el('p', 'snote'); error.id = 'settings-name-error'; error.setAttribute('role', 'status');
    const save = el('button', 'sbtn primary', nameSaving ? 'Guardando…' : 'Guardar nombre'); save.type = 'submit';
    const paint = () => {
      const issue = V.displayNameProblem(nameInput.value);
      error.textContent = nameError || issue;
      nameInput.setAttribute('aria-invalid', issue ? 'true' : 'false');
      save.disabled = nameSaving || !!issue;
    };
    nameInput.addEventListener('input', () => { nameDraft = nameInput.value; nameError = ''; paint(); });
    nameForm.addEventListener('submit', e => {
      e.preventDefault();
      if (!e.isTrusted || nameSaving || V.displayNameProblem(nameInput.value)) return;
      const typed = nameInput.value;
      nameDraft = typed; nameError = ''; nameSaving = true; paint(); save.textContent = 'Guardando…';
      call('prefs_action', { action: 'set_display_name', display_name: typed }).then(p => {
        nameSaving = false; prefs = p;
        if (nameDraft === typed) nameDraft = null;
        render(); say(p.displayName ? 'Nombre guardado.' : 'Saludo sin nombre guardado.');
        const field = $('settings-display-name'); if (field) field.focus();
      }, () => {
        nameSaving = false; nameError = 'No se pudo guardar. Tu nombre sigue sin cambios; probá de nuevo.';
        render();
        const field = $('settings-display-name'); if (field) field.focus();
      });
    });
    nameForm.append(label, nameInput, error, save); personal.append(nameForm); paint();
    // Sonido y atajo: the toggle keeps its contract; the volume is a SLIDER (D6/design). Same
    // closed command, same validation gate, same honest failure — only the control changes.
    sound.append(toggleRow('sw-sound', 'Sonido', g.sound.on, () => call('prefs_action', { action: g.sound.on ? 'sound_off' : 'sound_on' }).then(p => { prefs = p; render(); say(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); }, () => {})));
    const volRow = el('div', 'srow');
    volRow.append(el('span', 'srow-title', 'Volumen'));
    const volActions = el('span', 'srow-actions');
    const gainInput = el('input', 'sfield srange'); gainInput.type = 'range'; gainInput.id = 'settings-sound-gain';
    gainInput.min = '0'; gainInput.max = '0.2'; gainInput.step = '0.01';
    gainInput.value = gainDraft === null ? String(g.sound.gain) : gainDraft;
    gainInput.setAttribute('aria-label', 'Volumen');
    gainInput.setAttribute('aria-describedby', 'settings-gain-error');
    const gainValue = el('span', 'svolume-value'); gainValue.id = 'settings-sound-gain-value';
    const gainIssue = el('p', 'snote'); gainIssue.id = 'settings-gain-error'; gainIssue.setAttribute('role', 'status');
    const paintGain = () => {
      const percent = `${V.gainPercent(Number(gainInput.value))}%`;
      gainValue.textContent = percent;
      gainInput.setAttribute('aria-valuemin', '0');
      gainInput.setAttribute('aria-valuemax', '0.2');
      gainInput.setAttribute('aria-valuenow', String(gainInput.value));
      gainInput.setAttribute('aria-valuetext', percent);
      const problem = V.soundGainProblem(gainInput.value);
      gainIssue.textContent = gainError || problem;
      gainInput.setAttribute('aria-invalid', (gainError || problem) ? 'true' : 'false');
    };
    gainInput.addEventListener('input', e => {
      if (!e.isTrusted) return;
      gainDraft = gainInput.value; gainError = ''; paintGain();
    });
    gainInput.addEventListener('change', e => {
      if (!e.isTrusted || gainSaving || V.soundGainProblem(gainInput.value)) return;
      const typed = gainInput.value;
      gainDraft = typed; gainError = ''; gainSaving = true; paintGain();
      call('prefs_action', { action: 'set_sound_gain', gain: Number(typed) }).then(p => {
        gainSaving = false; prefs = p;
        if (gainDraft === typed) gainDraft = null;
        render(); say('Volumen guardado.');
      }, () => {
        gainSaving = false; gainError = 'No se pudo guardar. El volumen sigue sin cambios; probá de nuevo.';
        render();
        const field = $('settings-sound-gain'); if (field) field.focus();
      });
    });
    volActions.append(gainInput, gainValue);
    volRow.append(volActions);
    sound.append(volRow, gainIssue); paintGain();
    // Atajo global: same behaviour (capture, reset, enable/disable), restyled to the design row;
    // the backend note becomes the row's sub line instead of a paragraph.
    if (g.hotkey) {
      const h = g.hotkey;
      const row = el('div', 'srow');
      const titles = el('span', 'srow-titles');
      titles.append(el('span', 'srow-title', 'Atajo global'));
      if (h.note) titles.append(el('span', 'srow-sub', h.note));
      row.append(titles);
      row.append(Object.assign(el('kbd', 'skbd', capturing ? 'Pulsá el atajo…' : h.combo), { id: 'settings-combo' }));
      row.append(chipNode({ tone: h.status === 'active' ? 'go' : 'faint', icon: h.backend === 'portal' ? 'check' : 'info', word: h.backendLabel, aria: h.note ? `${h.backendLabel}. ${h.note}` : h.backendLabel }));
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn(capturing ? 'Cancelar' : 'Cambiar', () => { capturing = !capturing; render(); if (capturing) say('Pulsá la combinación nueva; Escape cancela.'); }, { icon: 'refresh' }));
      actions.append(wordBtn('Original', () => call('hotkey_action', { action: 'reset' }).then(r => { hotkey = r; render(); }, () => {})));
      row.append(actions);
      sound.append(row);
      sound.append(toggleRow('sw-hotkey', 'Atajo activo', h.enabled, () => call('hotkey_action', { action: h.enabled ? 'disable' : 'enable' }).then(r => { hotkey = r; render(); }, () => {})));
    }
    // #336 F003/F004: la isla se cierra sola tras la inactividad configurada y se abre al
    // pasar el mouse. The closed command always carries the FULL typed pair (exact keys,
    // integer 5..120 validated by the view-model BEFORE any rate or persistence).
    // T6.3 #434 (coordinator split): Auto-cierre is the design's segmented control «8 s / 15 s /
    // 30 s / Nunca» on the EXISTING contract: presets save through the closed pair, a stored
    // non-preset value renders as its own selected segment (never rewritten), «Nunca» is visibly
    // disabled («Próximamente») until the contract knows it.
    const island = V.islandInteractionView(prefs);
    const autoRow = el('div', 'srow');
    autoRow.append(el('span', 'srow-title', 'Auto-cierre'));
    const autoOptions = el('span', 'sseg'); autoOptions.id = 'settings-autoclose-options';
    autoOptions.setAttribute('role', 'radiogroup');
    autoOptions.setAttribute('aria-label', 'Auto-cierre');
    const autoIssue = el('p', 'snote'); autoIssue.id = 'settings-autoclose-error'; autoIssue.setAttribute('role', 'status');
    const renderAutoSegments = () => {
      autoOptions.textContent = '';
      for (const seg of V.autoCloseSegments(island.autoCloseSeconds)) {
        const b = el('button', 'sseg-btn');
        b.type = 'button';
        b.textContent = seg.label;
        b.id = `autoclose-${seg.seconds === null ? 'never' : seg.seconds}`;
        if (seg.disabled) {
          b.disabled = true;
          b.setAttribute('title', seg.title);
        } else {
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', seg.selected ? 'true' : 'false');
          b.tabIndex = seg.selected ? 0 : -1;
          b.addEventListener('click', e => {
            if (e.isTrusted !== true || autoSaving || seg.selected) return;
            const seconds = seg.seconds;
            const problem = V.autoCloseProblem(String(seconds));
            if (problem) { autoError = problem; paintAuto(); return; }
            autoSaving = true; autoError = ''; paintAuto();
            call('prefs_action', { action: 'set_island_interaction', auto_close_seconds: seconds, open_on_hover: island.openOnHover }).then(p => {
              autoSaving = false; prefs = p;
              render(); say('Cierre automático guardado.');
            }, () => {
              autoSaving = false; autoError = 'No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.';
              render();
            });
          });
        }
        autoOptions.append(b);
      }
    };
    const paintAuto = () => {
      renderAutoSegments();
      autoIssue.textContent = autoError;
    };
    autoRow.append(autoOptions);
    isla.append(autoRow, autoIssue);
    isla.append(toggleRow('sw-island-hover', 'Abrir al pasar el mouse', island.openOnHover, () => {
      const payload = { action: 'set_island_interaction', auto_close_seconds: island.autoCloseSeconds, open_on_hover: !island.openOnHover };
      call('prefs_action', payload).then(
        p => { prefs = p; render(); say(island.openOnHover ? 'La isla ya no se abre al pasar el mouse.' : 'La isla se abre al pasar el mouse.'); },
        () => say('No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.'));
    }));
    // #366 F093: where Ajustes opens — inside the island (default, #408) or in its own
    // window. The typed pref is the only chooser; a failed save keeps the previous
    // placement and says so.
    const placementOn = V.settingsWindowView(prefs).on;
    isla.append(toggleRow('sw-settings-window', 'Abrir Ajustes en ventana', placementOn, () => {
      call('prefs_action', { action: 'set_settings_window', settings_window: !placementOn }).then(p => {
        prefs = p; render();
        say(!placementOn ? 'Ajustes se abre en su ventana.' : 'Ajustes se abre dentro de la isla.');
      }, () => say('No se pudo guardar. La ubicación sigue sin cambios; probá de nuevo.'));
    }));
    paintAuto();
    const motion = group('appearance', 'Movimiento', 'Qué hace la isla cuando tu sistema pide menos animación.');
    motion.append(toggleRow('sw-motion', 'Respetar el movimiento del sistema', g.motion.respectSystem, () => {
      if (!window.desktop) return;
      (g.motion.respectSystem ? window.desktop.animateAnyway() : window.desktop.respectSystemMotion()).then(s => { motionOverride = s.motionOverride !== false; render(); say(motionOverride ? 'Abito se anima siempre.' : 'Abito respeta el movimiento del sistema.'); }, () => {});
    }));
    // #380: the theme. Three fixed choices; the SAVED mode is the truth (the row renders from
    // `prefs`), and applying it is theme.js's job after the host confirms the write.
    const theme = group('appearance', 'Tema', 'Con «Sistema» Abito usa el tema de tu computadora y lo sigue cuando cambia. Con «Claro» u «Oscuro» queda fijo.');
    const themePick = V.themeView(prefs);
    const picker = el('span', 'stheme-options');
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'Tema');
    for (const option of themePick.options) {
      const b = el('button', 'stheme');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria);
      b.id = `theme-mode-${option.id}`;
      b.dataset.mode = option.id;
      b.tabIndex = option.selected ? 0 : -1;
      b.append(el('span', 'stheme-label', option.label));
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const all = [...picker.querySelectorAll('[role="radio"]')];
        const at = all.indexOf(b);
        let next = (at + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + all.length) % all.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = all.length - 1;
        all.forEach((x, i) => { x.tabIndex = i === next ? 0 : -1; });
        all[next].focus();
        chooseTheme(all[next].dataset.mode);
      });
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseTheme(option.id); });
      picker.append(b);
    }
    theme.append(picker);
    if (themeError) {
      const problem = el('p', 'snote', themeError);
      problem.id = 'theme-error';
      problem.setAttribute('role', 'status');
      theme.append(problem);
    }
    // #384: the colour of the Dot. Green is the default and this choice is the ONLY input to it:
    // nothing on screen (a pose, an agent, a notice) repaints it. Sub-Abito rows appear when real
    // identities exist — the list above is the single place they will come from.
    const identities = specialistIdentities();
    const rows = V.colorRows(prefs, AVATAR ? [{ id: AVATAR.PRINCIPAL_ID, name: 'Abito' }, ...identities.identities] : [], AVATAR);
    if (rows.length) {
      const color = group('appearance', 'Color', 'Abito mantiene su color en la isla. El especialista muestra el suyo en su indicador; los colores pueden repetirse.');
      for (const row of rows) color.append(colorRow(row));
      if (identities.kind !== 'ready') {
        const notice = el('p', 'snote', identities.kind === 'loading' ? 'Leyendo los colores de tus especialistas…' : 'Colores de especialistas no disponibles: no se pudieron cargar sus identidades.');
        notice.id = 'specialist-colors-status'; notice.setAttribute('role', 'status'); color.append(notice);
      }
    }
    const pills = window.AbitoPillSettings, model = window.AbitoPills;
    if (pills && model) {
      // #435: the design leaves no standing paragraph on the Blobs screen — the only
      // disclaimer is the principal chip tooltip the renderer owns.
      const section = group('pills', 'Blobs', '');
      pills.render(section, prefs, { saving: pillSaving, error: pillError, putIcon,
        onCommand(payload) {
          if (pillSaving || !isOpen() || screen !== 'pills') return;
          const current = model.normalize(prefs);
          const next = payload.action === 'set_main_pill' ? model.chooseMain(current, payload.id)
            : payload.action === 'toggle_declared_pill' ? model.toggle(current, payload.id)
            : payload.action === 'set_pill_color' ? model.setColor(current, payload.id, payload.color)
            : payload.action === 'clear_pill_color' ? model.clearColor(current, payload.id)
            : payload.action === 'create_blob' ? model.createBlob(current, payload.name, payload.color || '')
            : payload.action === 'delete_blob' ? model.deleteBlob(current, payload.name)
            : payload.action === 'set_blob_color' ? model.setBlobColor(current, payload.name, payload.color)
            : payload.action === 'reorder_declared_pills' ? model.reorderDeclared(current, payload.order)
            : payload.action === 'reorder_blobs' ? model.reorderBlobs(current, payload.order) : null;
          if (!next || (payload.action === 'set_main_pill' && payload.id === current.mainPill)) return;
          pillSaving = true; pillError = ''; render();
          // D4: the principal blob's colour feeds the island CHARACTER through the
          // existing typed pref (avatarColors['abito'] via set_avatar_color) — no new
          // wire field. A promotion carries the promoted blob's palette colour; a
          // recolour of the principal itself carries the new swatch. A colourless
          // promotion changes nothing about the character.
          const characterColor = payload.action === 'set_main_pill' ? model.colorOf(current, payload.id)
            : payload.action === 'set_pill_color' && payload.id === current.mainPill ? payload.color : '';
          call('prefs_action', payload).then(saved => {
            if (!characterColor) {
              pillSaving = false; prefs = saved; render();
              say(payload.action === 'create_blob' ? 'Blob creado. Elegir no conecta el servicio.'
                : payload.action === 'delete_blob' ? 'Blob eliminado.'
                : payload.action === 'set_pill_color' || payload.action === 'set_blob_color' ? 'Color de blob guardado.'
                : payload.action === 'clear_pill_color' ? 'Color de blob quitado.'
                : 'Blob guardado. Elegir no conecta el servicio.');
              return;
            }
            call('prefs_action', { action: 'set_avatar_color', identity: 'abito', color: characterColor }).then(avatarSaved => {
              pillSaving = false; prefs = avatarSaved; render();
              say(payload.action === 'set_pill_color' ? 'Color de blob guardado.' : 'Blob guardado. Elegir no conecta el servicio.');
            }, () => {
              pillSaving = false; prefs = saved; render();
              say('Blob guardado; no se pudo actualizar el color del personaje.');
            });
          }, () => {
            pillSaving = false;
            pillError = payload.action === 'create_blob'
              ? 'No se pudo crear el blob; se mantuvo la lista anterior.'
              : 'No se pudo guardar el blob; se mantuvo la elección anterior.';
            render(); say(pillError);
          });
        },
      });
    }
  }

  // #366 F094 — the quick panel: right-click on an Ajustes gear opens a small popover INSIDE the
  // island with the three most-used toggles (sound, theme, auto-close). A normal click keeps the
  // #408 behaviour untouched. Only the existing closed prefs commands are used; the saved
  // projection is the truth, a failed save keeps the previous value and says so.
  let quick = null;
  function closeQuick() { if (quick) { quick.remove(); quick = null; } }
  function quickSay(text) { say(text); }
  function renderQuick() {
    if (!quick) return;
    const v = V.quickPanelView(prefs);
    const island = V.islandInteractionView(prefs);
    quick.textContent = '';
    quick.append(el('h3', 'ssection', 'Ajustes rápidos'));
    quick.append(toggleRow('quick-sound', 'Sonido', v.sound.on, () =>
      call('prefs_action', { action: v.sound.on ? 'sound_off' : 'sound_on' }).then(
        p => { prefs = p; renderQuick(); quickSay(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); },
        () => quickSay('No se pudo guardar. El sonido sigue sin cambios; probá de nuevo.'))));
    const picker = el('span', 'stheme-options');
    picker.setAttribute('role', 'radiogroup'); picker.setAttribute('aria-label', 'Tema');
    for (const option of v.theme) {
      const b = el('button', 'stheme'); b.type = 'button'; b.id = `quick-theme-${option.id}`;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria); b.append(el('span', 'stheme-label', option.label));
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseTheme(option.id).then(renderQuick); });
      picker.append(b);
    }
    quick.append(picker);
    const form = el('form', 'sname-form'); form.noValidate = true;
    const label = el('label', 'srow-title', 'Cerrar a los (segundos)'); label.htmlFor = 'quick-autoclose';
    const input = el('input', 'sfield'); input.type = 'number'; input.id = 'quick-autoclose';
    input.min = '5'; input.max = '120'; input.step = '1'; input.value = String(v.autoCloseSeconds);
    const issue = el('p', 'snote'); issue.setAttribute('role', 'status');
    const save = el('button', 'sbtn primary', 'Guardar cierre'); save.type = 'submit';
    const paint = () => { const problem = V.autoCloseProblem(input.value); issue.textContent = problem; save.disabled = !!problem; };
    input.addEventListener('input', paint);
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!e.isTrusted || V.autoCloseProblem(input.value)) return;
      call('prefs_action', { action: 'set_island_interaction', auto_close_seconds: Number(input.value), open_on_hover: island.openOnHover }).then(
        p => { prefs = p; renderQuick(); quickSay('Cierre automático guardado.'); },
        () => { issue.textContent = 'No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.'; });
    });
    form.append(label, input, issue, save); quick.append(form); paint();
    quick.append(wordBtn('Todos los ajustes', () => { closeQuick(); open(screen); }));
  }
  function openQuick() {
    if (WINDOW_MODE) return;
    if (quick) { closeQuick(); return; }
    quick = el('div', 'squick'); quick.id = 'settings-quick'; quick.setAttribute('role', 'dialog'); quick.setAttribute('aria-label', 'Ajustes rápidos');
    (document.getElementById('island') || document.body).append(quick);
    renderQuick();
    call('prefs_action', { action: 'view' }).then(p => { prefs = p; renderQuick(); }, () => {});
  }
  for (const g of [...openers, $('open-settings')].filter(Boolean)) g.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (e.isTrusted === true) openQuick();
  });
  document.addEventListener('keydown', e => { if (quick && e.key === 'Escape') { e.stopPropagation(); closeQuick(); } }, true);
  document.addEventListener('pointerdown', e => { if (quick && e.isTrusted === true && !quick.contains(e.target) && !e.target.closest('#open-screen-settings, #open-settings')) closeQuick(); }, true);
  document.addEventListener('island:view', closeQuick);
  // #366 F093: inside the Rust-created settings window the SAME page opens
  // Ajustes at once — the panel IS the window (the island chrome stays hidden
  // by CSS, and the island's own phase machinery is never driven from here).
  if (WINDOW_MODE) open('accounts');
})();
