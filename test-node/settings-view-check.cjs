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

// ---- screens (copied from gentle-dot: one screen per header button, each covering the chat body) -------
test('three screens in gentle-dot order — Cuentas, Conectores, Ajustes — each with title, icon and a one-line hint', () => {
  assert.deepEqual(S.SCREENS.map(x => x.id), ['accounts', 'connectors', 'settings']);
  assert.deepEqual(S.SCREENS.map(x => x.title), ['Cuentas', 'Conectores', 'Ajustes']);
  for (const x of S.SCREENS) { assert.ok(x.icon, x.id); assert.ok(x.id === 'settings' || x.hint.length > 20, x.id); }
  assert.equal(S.screenById('connectors').title, 'Conectores');
  assert.equal(S.screenById('nope'), null);
  assert.equal(S.SECTIONS, undefined, 'the tab strip is gone');
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
  assert.equal(S.connectionView(null).word, 'Sin motor');
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
  assert.doesNotMatch(html, /role="tablist"/, 'no tab strip: each screen has its own header button');
  for (const id of ['accounts', 'connectors', 'settings']) {
    const tag = new RegExp(`<button[^>]*id="open-screen-${id}"[^>]*>`).exec(html);
    assert.ok(tag, id); assert.match(tag[0], /aria-label="[^"]{3,}"/, id); assert.match(tag[0], /aria-expanded="false"/, id);
  }
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

test('layout: General fits the 256px chat window without cutting its last row', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  const px = (re, d) => { const m = css.match(re); return m ? Number(m[1]) : d; };
  const win = 256, top = px(/#settings \{[^}]*top:\s*(\d+)px/, 8), bottom = px(/#settings \{[^}]*bottom:\s*(\d+)px/, 8);
  const bar = px(/#settings-bar \{[^}]*min-height:\s*(\d+)px/, 48);
  const gap = px(/#settings \{[^}]*gap:\s*(\d+)px/, 4);
  const bodyGap = px(/#settings-body \{[^}]*gap:\s*(\d+)px/, 4);
  const room = win - top - bottom - bar - gap;
  const rows = 4, rowH = 44; // sound, motion, shortcut, shortcut-enabled
  assert.ok(room >= rows * rowH + (rows - 1) * bodyGap, `room ${room}px < ${rows * rowH + (rows - 1) * bodyGap}px`);
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
  const row = (state, extra = {}) => S.agentsView(agentsState([{ id: 'codex', state, backup: false, detail: null, ...extra }])).rows[0];
  const nc = row('not_connected');
  assert.deepEqual([nc.word, nc.tone, nc.primary && nc.primary.label], ['Sin conectar', 'faint', 'Conectar']);
  assert.deepEqual(nc.primary.command, { action: 'agent_connect', agentId: 'codex' });
  assert.equal(nc.secondary, null);
  const ok = row('connected');
  assert.deepEqual([ok.word, ok.tone, ok.primary], ['Conectado', 'go', null]);
  assert.deepEqual(ok.secondary, { label: 'Desconectar', command: { action: 'agent_disconnect', agentId: 'codex' } });
  const old = row('outdated');
  assert.equal(old.primary.label, 'Actualizar'); assert.equal(old.primary.command.action, 'agent_connect'); assert.equal(old.secondary.label, 'Desconectar');
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

console.log(`settings-view-check: ${passed} passed`);
