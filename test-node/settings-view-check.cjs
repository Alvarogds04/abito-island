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

// ---- sections ----------------------------------------------------------------
test('three sections in a fixed order, each with a name and an icon', () => {
  assert.deepEqual(S.SECTIONS.map(s => s.id), ['providers', 'connectors', 'general']);
  for (const s of S.SECTIONS) { assert.ok(s.label && s.icon, s.id); }
  assert.equal(S.nextSection('providers', 1), 'connectors');
  assert.equal(S.nextSection('general', 1), 'providers', 'wraps');
  assert.equal(S.nextSection('providers', -1), 'general');
  assert.equal(S.nextSection('nope', 1), 'providers');
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
  assert.match(html, /role="tablist"/);
  for (const id of ['providers', 'connectors', 'general']) {
    const tag = new RegExp(`<button[^>]*id="tab-${id}"[^>]*>`).exec(html);
    assert.ok(tag, id); assert.match(tag[0], /role="tab"/, id);
  }
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

console.log(`settings-view-check: ${passed} passed`);
