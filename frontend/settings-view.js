'use strict';
/* #306 — the settings panel's PURE view-model (no DOM, no IPC, no network, no secrets).
   Three sections: providers (accounts and sign-in through the island agent), connectors
   (persisted state, read-only) and general (sound, system motion, global shortcut).
   Every state is icon + at most one word (docs/desktop-visual-language.md §3); a problem
   is never hidden. Loaded as a classic script (window.AbitoSettings) and by
   test-node/settings-view-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSettings = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SECTIONS = Object.freeze([
    Object.freeze({ id: 'providers', label: 'Proveedores', icon: 'chip' }),
    Object.freeze({ id: 'connectors', label: 'Conectores', icon: 'plug' }),
    Object.freeze({ id: 'general', label: 'General', icon: 'info' }),
  ]);
  function nextSection(current, step) {
    const i = SECTIONS.findIndex(s => s.id === current);
    if (i < 0) return SECTIONS[0].id;
    return SECTIONS[(i + step + SECTIONS.length) % SECTIONS.length].id;
  }

  // ---- connection to the island agent (the daemon) ------------------------------------
  const CONNECTION = Object.freeze({
    no_daemon: ['Sin motor', 'plug-off', 'faint', 'El motor del agente no está corriendo; las cuentas y los proveedores no están disponibles.'],
    lost: ['Motor caído', 'triangle', 'red', 'Se perdió la conexión con el motor del agente.'],
    bad_session: ['Sesión no válida', 'triangle', 'red', 'El archivo de sesión del motor no es de fiar (permisos o formato); no se usó.'],
    refused: ['Motor no responde', 'triangle', 'red', 'El motor rechazó o no completó la conexión.'],
  });
  function connectionView(state) {
    const c = state && state.connection;
    if (c === 'connected') return null;
    const row = Object.prototype.hasOwnProperty.call(CONNECTION, c) ? CONNECTION[c] : CONNECTION.no_daemon;
    return { kind: c in CONNECTION ? c : 'no_daemon', word: row[0], icon: row[1], tone: row[2], aria: `${row[0]}: ${row[3]}` };
  }
  const connected = state => !!state && state.connection === 'connected';

  // ---- providers / accounts --------------------------------------------------------------
  const METHOD_ORDER = ['api_key', 'oauth'];
  function providerOf(state, id) {
    return ((state && state.providers) || []).find(p => p.id === id) || null;
  }
  function loginMethods(state, accountId) {
    const account = ((state && state.accounts) || []).find(a => a.accountId === accountId);
    if (!account || account.local === true) return [];
    const provider = providerOf(state, account.provider);
    const offered = provider ? provider.methods : [];
    return METHOD_ORDER.filter(m => offered.includes(m));
  }
  function accountRows(state) {
    const accounts = (state && state.accounts) || [];
    const profiles = (state && state.profiles) || { profiles: [], active: null };
    const activeProfile = (profiles.profiles || []).find(p => p.id === profiles.active) || null;
    return accounts.map(a => {
      const provider = providerOf(state, a.provider);
      const active = !!activeProfile && activeProfile.provider === a.provider;
      const inUse = (profiles.profiles || []).some(p => p.provider === a.provider);
      const local = a.local === true;
      const signedIn = a.configured === true;
      const actions = [];
      if (!local && loginMethods(state, a.accountId).length) actions.push('login');
      if (!local && signedIn) actions.push('logout');
      if (!inUse) actions.push('remove');
      const chips = local ? [{ icon: 'lock', text: 'local' }] : [];
      return {
        accountId: a.accountId, label: a.label, providerName: provider ? provider.name : a.provider, local, active, chips, actions,
        state: signedIn || local ? { word: '', icon: '', tone: 'go' } : { word: 'Sin sesión', icon: 'plug-off', tone: 'faint' },
      };
    });
  }
  const SAFE_LABEL = s => typeof s === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(s);
  function createValidity(state, providerId, label) {
    const no = (word = '') => ({ ok: false, word });
    if (!connected(state) || !providerOf(state, providerId)) return no();
    if (typeof label !== 'string' || !label.trim()) return no();
    if (!SAFE_LABEL(label)) return no('No válido');
    if (Array.from(label).length > 80) return no('Muy largo');
    return { ok: true, word: '' };
  }

  // ---- sign-in: secrets ---------------------------------------------------------------------------
  const KEYLIKE = /\b(api[\s_-]?key|key|token|secret|password|passphrase|contrase(?:ñ|n)a|clave|credencial|credential)\b/i;
  function maskInput(prompt) {
    if (!prompt || typeof prompt !== 'object') return true; // no data = mask (the safe default)
    if (prompt.secret === true) return true;
    if (KEYLIKE.test(String(prompt.message || ''))) return true;
    return /^(sk|pk|ghp|xox|AIza)[-_.]/i.test(String(prompt.placeholder || ''));
  }
  function promptView(prompt) {
    if (!prompt || typeof prompt !== 'object') return null;
    const control = prompt.kind === 'select' && Array.isArray(prompt.options) && prompt.options.length ? 'select' : prompt.kind === 'confirm' ? 'confirm' : 'input';
    return {
      flowId: String(prompt.flowId || ''), promptId: String(prompt.promptId || ''), control,
      message: String(prompt.message || ''), masked: control === 'input' && maskInput(prompt), placeholder: String(prompt.placeholder || ''),
      options: control === 'select' ? prompt.options.map(o => ({ id: String(o.id), label: String(o.label || o.id) })) : [],
    };
  }
  const MAX_REPLY = 4096;
  function replyValid(value) {
    return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= MAX_REPLY && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function eventView(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const link = typeof ev.url === 'string' && ev.url.startsWith('https://') ? ev.url
      : typeof ev.verificationUri === 'string' && ev.verificationUri.startsWith('https://') ? ev.verificationUri : null;
    return { message: String(ev.message || ''), instructions: String(ev.instructions || ''), userCode: String(ev.userCode || ''), link };
  }
  function flowOutcome(last) {
    if (!last || typeof last !== 'object') return null;
    if (last.ok === true) return { word: 'Conectada', icon: 'check', tone: 'go' };
    if (last.cancelled === true) return { word: 'Cancelado', icon: 'cross', tone: 'faint' };
    return { word: 'No se pudo', icon: 'triangle', tone: 'red' };
  }

  // ---- connectors (persisted, read-only) ---------------------------------------------------------------
  const CONNECTOR_STATUS = Object.freeze({
    connected: ['', '', 'go'], failed: ['Falló', 'triangle', 'red'], disabled: ['Apagado', 'plug-off', 'faint'],
    needs_setup: ['Falta configurar', 'info', 'sun'],
  });
  const CONNECTORS_NOTE = 'Estado guardado en este equipo; puede no coincidir con lo que está pasando ahora.';
  function connectorsView(state) {
    const c = (state && state.connectors) || { state: 'loading', items: [] };
    if (c.state === 'unavailable') return { kind: 'unavailable', word: 'No disponible', icon: 'plug-off', tone: 'faint', aria: 'No disponible: el motor no tiene conectores configurados.' };
    if (c.state === 'failed') return { kind: 'failed', word: 'Sin datos', icon: 'triangle', tone: 'red', aria: 'Sin datos: no se pudieron leer los conectores.' };
    if (c.state !== 'ready' && state && state.connection && state.connection !== 'connected' && state.connection !== 'connecting') {
      const cv = connectionView(state); // no live engine: waiting forever would be a lie
      if (cv) return { kind: 'no_engine', word: cv.word, icon: cv.icon, tone: cv.tone, aria: cv.aria };
    }
    if (c.state !== 'ready') return { kind: 'loading', word: '', icon: 'ring', tone: 'live', aria: 'Leyendo conectores' };
    const items = (c.items || []).map(i => {
      const row = Object.prototype.hasOwnProperty.call(CONNECTOR_STATUS, i.status) ? CONNECTOR_STATUS[i.status] : ['Desconocido', 'info', 'faint'];
      return { id: i.id, label: i.label, word: row[0], icon: row[1], tone: row[2], sends: i.mode === 'read_and_send' };
    });
    return { kind: 'ready', items, empty: items.length === 0 };
  }

  // ---- general --------------------------------------------------------------------------------------------
  const soundDefault = () => false; // the island contract is silence until the human opts in
  function generalView(input) {
    const i = input || {};
    const h = i.hotkey || null;
    const hotkey = !h ? null : {
      combo: String(h.combo || ''), enabled: h.enabled !== false, status: String(h.status || ''),
      backend: h.backend === 'portal' ? 'portal' : 'x11',
      backendLabel: h.backend === 'portal' ? 'Atajo del sistema' : (h.limited ? 'Atajo limitado (X11)' : 'Atajo de X11'),
      note: h.portal_note === 'permission_denied' ? 'Rechazaste el permiso del sistema, por eso usa el atajo limitado.'
        : h.portal_note === 'unsupported' ? 'El portal del sistema no respondió o no pudo registrarlo.' : '',
    };
    return {
      sound: { on: i.sound === true },
      // motionOverride true (the default) = animate: the system preference is NOT honored
      motion: { respectSystem: i.motionOverride === false },
      hotkey,
    };
  }

  // ---- hotkey capture (a pressed combination -> canonical text) -------------------------------------------------------
  const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Super']);
  function captureCombo(event) {
    if (!event || event.isTrusted !== true || event.isComposing || event.repeat) return { kind: 'ignore' };
    if (event.key === 'Escape') return { kind: 'cancel' };
    if (MODIFIER_KEYS.has(event.key)) return { kind: 'wait' };
    const code = String(event.code || '');
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
    else if (code === 'Space') key = 'Space';
    if (!key) return { kind: 'unsupported' };
    if (!(event.ctrlKey || event.altKey || event.metaKey)) return { kind: 'needs_modifier' };
    const mods = [];
    if (event.ctrlKey) mods.push('Ctrl');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Super');
    return { kind: 'combo', text: [...mods, key].join('+') };
  }

  // ---- what to tell the human after a command ---------------------------------------------------------------------
  // The page used to say «Cuenta creada» when it WROTE the command. The engine answers later (state
  // frames) and may refuse (`error{failed|busy|bad_request|...}`): success is only said when the state
  // that came back carries no error newer than the one we had when we sent it.
  const ENGINE_ERRORS = Object.freeze({
    failed: ['No se pudo', 'triangle', 'red'], busy: ['Motor ocupado', 'lock', 'sun'],
    bad_request: ['Pedido no válido', 'triangle', 'red'], rate_limited: ['Demasiados pedidos', 'clock', 'sun'],
    unavailable: ['No disponible', 'plug-off', 'faint'], not_busy: ['Nada en curso', 'info', 'faint'], unknown_ask: ['Pedido desconocido', 'info', 'faint'],
  });
  const errorSeq = st => (st && st.last_error && Number.isInteger(st.last_error.n) ? st.last_error.n : 0);
  function commandOutcome(before, after, okSay) {
    const failure = (word, icon, tone) => ({ ok: false, word, icon, tone, say: `${word}.` });
    if (!after || typeof after !== 'object') return failure('No se pudo', 'triangle', 'red');
    if (after.connection && after.connection !== 'connected') {
      const cv = connectionView(after);
      return cv ? failure(cv.word, cv.icon, cv.tone) : failure('No se pudo', 'triangle', 'red');
    }
    if (errorSeq(after) > errorSeq(before)) {
      const code = after.last_error && after.last_error.code;
      const row = Object.prototype.hasOwnProperty.call(ENGINE_ERRORS, code) ? ENGINE_ERRORS[code] : ENGINE_ERRORS.failed;
      return failure(row[0], row[1], row[2]);
    }
    return { ok: true, say: okSay };
  }

  // The shortcut backend answers `set` with the status it ended in. «Cambiado» only when it is really active.
  const HOTKEY_SET_FAILS = Object.freeze({
    taken: 'Atajo ocupado: lo usa otra aplicación.', invalid: 'Atajo inválido: necesita Ctrl, Alt o Súper.',
    unsupported: 'Atajo sin soporte: no se pudo registrar.', permission_denied: 'Atajo sin permiso: rechazaste el permiso del sistema.',
  });
  function hotkeySetOutcome(view, typed) {
    if (!view || typeof view !== 'object') return { ok: false, say: 'No se pudo cambiar el atajo.' };
    if (Object.prototype.hasOwnProperty.call(HOTKEY_SET_FAILS, view.status)) return { ok: false, say: HOTKEY_SET_FAILS[view.status] };
    if (view.status === 'permission_pending') return { ok: null, say: 'Falta confirmar el permiso del sistema para cambiar el atajo.' };
    const combo = typeof view.combo === 'string' && view.combo ? view.combo : String(typed || '');
    return { ok: true, say: `Atajo cambiado a ${combo}.` };
  }

  // ---- drafts: what the human is typing survives a re-render --------------------------------------------------------
  // The panel rebuilds its DOM on every state push (the portal pushes every 400 ms while its dialog is open),
  // which used to wipe a half-typed key. Kept here, per field id, inside one «scope» (one prompt/flow); a
  // new scope starts empty so one prompt's key is never carried into the next. Memory only, never persisted.
  function makeDrafts() {
    let scopeId = '';
    let values = Object.create(null);
    return {
      get: id => values[id] || '',
      set(id, v) { values[id] = String(v); },
      clear(id) { delete values[id]; },
      scope(next) { if (next !== scopeId) { scopeId = next; values = Object.create(null); } },
      reset() { scopeId = ''; values = Object.create(null); },
    };
  }

  return { commandOutcome, hotkeySetOutcome, makeDrafts, SECTIONS, SOUND_DEFAULT: false, CONNECTORS_NOTE, nextSection, connectionView, accountRows, loginMethods, createValidity,
    maskInput, promptView, replyValid, eventView, flowOutcome, connectorsView, soundDefault, generalView, captureCombo };
});
