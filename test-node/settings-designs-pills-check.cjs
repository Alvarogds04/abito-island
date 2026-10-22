'use strict';
// #503 T3 · S19 · 19 Pestañas activas → Opción A: one row per pill = colour/mascot, name, state (icon + word),
// switch and ONE contextual action (⋮ for ready rows, Configurar/Instalar when something is missing).
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, all, text, dom, Element, load } = require('./settings-designs-check.cjs');

async function mount({ keys = {}, hooks = {}, accounts = [], navigate } = {}) {
  dom();
  Element.prototype.getBoundingClientRect = () => ({ left: 20, bottom: 30 });
  Element.prototype.querySelector = function (selector) { return all(this).find(e => selector === '.' + e.className.split(' ').join('.')) || null; };
  Element.prototype.remove = function () { document.body.removeChild(this); };
  document.removeEventListener = () => {};
  global.window = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
  const { renderPills } = await load('personalization.js');
  const V = require('../frontend/settings-view.js'), S = require('../frontend/specialists-view.js'), A = require('../frontend/avatar-colors.js');
  const P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  const prefs = { theme: 'system', avatarColors: {}, pillColors: {}, declaredPills: [], mainPill: 'integration_claude', islandAgents: [], abitoInstructions: '' };
  const calls = [];
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'specialists_action') return { specialists: [], active: null };
    if (cmd === 'models_action') return { profiles: [] };
    if (cmd === 'secret_action') return { present: keys[p.key] === true };
    if (cmd === 'agent_action') return { connection: 'connected', accounts, hooks: Object.entries(hooks).map(([id, state]) => ({ id, state })) };
    if (p.action === 'toggle_declared_pill') prefs.declaredPills = P.toggle(P.normalize(prefs), p.id).declaredPills;
    if (p.action === 'set_pill_color') prefs.pillColors[p.id] = p.color;
    if (p.action === 'clear_pill_color') delete prefs.pillColors[p.id];
    return structuredClone(prefs);
  };
  const ui = await renderPills({ invoke, V, S, A, P, C, page: 'pills', navigate, listen: async () => () => {} });
  await ui.settled();
  return { ui, calls, C, prefs };
}
const rowOf = (ui, name) => all(ui).filter(e => e.className.split(' ').includes('pill-row')).find(r => all(r).some(e => e.className === 'name' && e.textContent === name));
const stateOf = row => all(row).find(e => e.className.split(' ').includes('state'));
const kindOf = row => ['ok', 'missing', 'soon', 'unknown', 'main'].find(k => stateOf(row).className.split(' ').includes(k));
const buttons = row => all(row).filter(e => e.tagName === 'button');

test('S19 Pills: every row is dot + name + state(icon + word) + switch; a missing key reads «falta llave» with Configurar', async () => {
  const { ui } = await mount({ keys: { 'google-api-key': true } });
  const google = rowOf(ui, 'Google AI'), openai = rowOf(ui, 'OpenAI');
  assert.equal(kindOf(google), 'ok'); assert.equal(kindOf(openai), 'missing');
  const parts = row => [all(stateOf(row)).find(e => e.className === 'state-ico'), all(stateOf(row)).find(e => e.className === 'state-word')];
  const [gi, gw] = parts(google); assert.equal(gi.textContent, '✓'); assert.equal(gi.attrs['aria-hidden'], 'true'); assert.equal(gw.textContent, 'lista');
  const [oi, ow] = parts(openai); assert.equal(oi.textContent, '✗'); assert.equal(ow.textContent, 'falta llave');
  // the state is never colour alone: every state has a word, and the word is the row's accessible state
  for (const r of all(ui).filter(e => e.className.split(' ').includes('pill-row'))) assert(all(stateOf(r)).some(e => e.className === 'state-word' && e.textContent), 'every row says its state in words');
  for (const r of [google, openai]) { assert(all(r).some(e => e.className === 'dot color-dot'), 'colour dot kept'); assert(all(r).some(e => e.className.split(' ').includes('switch'))); }
});

test('S19 Pills: contextual action per row: ready -> ⋮ (colour), missing key -> Configurar, no hooks -> Instalar, soon -> none', async () => {
  const seen = [];
  const { ui } = await mount({ keys: { 'google-api-key': true }, hooks: { 'claude-code': 'connected', cursor: 'not_connected' }, navigate: page => seen.push(page) });
  const google = rowOf(ui, 'Google AI'), openai = rowOf(ui, 'OpenAI'), cursor = rowOf(ui, 'Cursor');
  assert(buttons(google).some(b => b.attrs['aria-label'] === 'Más opciones de Google AI'), '⋮ on a ready row');
  assert(!buttons(google).some(b => ['Configurar', 'Instalar'].includes(b.textContent)));
  const configure = buttons(openai).find(b => b.textContent === 'Configurar'); assert(configure, 'Configurar on a missing key');
  const install = buttons(cursor).find(b => b.textContent === 'Instalar'); assert(install, 'Instalar when hooks are not installed');
  assert(!buttons(openai).some(b => b.attrs['aria-label']?.startsWith('Más opciones')), 'a missing row offers its fix, not the menu');
  configure.fire('click', false); install.fire('click', false); assert.deepEqual(seen, [], 'synthetic clicks do nothing');
  configure.fire('click'); install.fire('click');
  assert.deepEqual(seen, ['integrations', 'integrations'], 'S32: keys and hooks both live on the one «Integraciones y agentes» page');
});

test('S19 Pills: the ⋮ menu opens the colour palette through the SAME closed command; nothing else changed', async () => {
  const { ui, calls, C } = await mount({ keys: { 'google-api-key': true } });
  const google = rowOf(ui, 'Google AI'), more = buttons(google).find(b => b.attrs['aria-label'] === 'Más opciones de Google AI');
  more.fire('click', false); assert.equal(document.body.children.length, 0, 'a synthetic click opens nothing');
  more.fire('click'); assert.equal(document.body.children.length, 1, 'the palette opens');
  const swatch = all(document.body).find(e => e.attrs['aria-label'] && /^#/.test(e.attrs['aria-label']));
  calls.length = 0; swatch.fire('click'); await ui.settled();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'prefs_action'); assert.equal(calls[0][1].action, 'set_pill_color'); assert.equal(calls[0][1].id, 'ai_google');
  // the switch and its closed command are untouched
  calls.length = 0;
  all(google).find(e => e.className.split(' ').includes('switch')).fire('click'); await ui.settled();
  assert.deepEqual(calls.pop(), ['prefs_action', { action: 'toggle_declared_pill', id: 'ai_google' }]);
  ui.dispose(); assert.equal(document.body.children.length, 0);
});

test('S19 Pills: without a navigator the fix buttons are disabled, never a dead click', async () => {
  const { ui } = await mount({ keys: {} });
  const configure = buttons(rowOf(ui, 'OpenAI')).find(b => b.textContent === 'Configurar');
  assert(configure.disabled);
});

test('S19 Pills: the state and action live in the generated module, the hub passes its navigator to the page', () => {
  const fs = require('node:fs');
  const shell = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/shell.ts'), 'utf8');
  assert.match(shell, /renderNotch\(def\.id, container, ctx\.navigate\)/);
  const entry = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  assert.match(entry, /async renderNotch\(page, container, navigate\)/);
  assert.match(entry, /renderPills\(\{ \.\.\.personal, page: 'pills', part: 'tools', navigate \}\)/, 'S32: the hub passes its navigator to the pills part of the one page');
});
