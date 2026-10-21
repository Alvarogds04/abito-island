'use strict';
// #503 T3 · S21 · 21 Chat → Opción A: every provider is a card (name, state icon + word) with Clave, show/hide, Guardar,
// Probar and Quitar; validation is inline next to the field; «Contexto de ventana activa» keeps its switch.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

async function mount({ present = {}, accounts = [], failPresent = false } = {}) {
  let failOnce = false;
  dom();
  const { renderChatSettings } = await load('chat.js');
  const V = require('../frontend/settings-view.js');
  const real = a => a.map(x => ({ accountId: x.accountId, provider: x.provider || 'google', hasCredential: true, config: { nombre: 'N', baseUrl: 'https://x', api: 'a', compat: {}, models: ['m'], defaultModel: 'm' } }));
  const calls = [], events = {};
  const state = { connection: 'connected', ownedAccounts: { accounts: real(accounts) }, providers: [], accounts: [], auth: {}, connectors: { items: [] } };
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'secret_action') { if ((failPresent || failOnce) && p.action === 'present') { failOnce = false; throw new Error('keychain'); } return { present: p.action === 'set' ? true : p.action === 'clear' ? false : present[p.key] === true }; }
    if (cmd === 'prefs_action') return { chosenModels: {}, windowContext: false, windowContextAvailable: true };
    if (cmd === 'models_action') return { profiles: [] };
    return structuredClone(state);
  };
  const ui = await renderChatSettings({ invoke, V, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; }, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  return { ui, calls, state, failNext: () => { failOnce = true; } };
}
const card = (ui, title) => all(ui).find(e => e.tagName === 'section' && all(e).some(h => h.tagName === 'h2' && text(h).trim().startsWith(title)));
const stateOf = c => text(all(c).find(e => e.className.split(' ').includes('card-state'))).replace(/\s+/g, ' ').trim();
const field = (c, id) => all(c).find(e => e.attrs.id === id);
// a control that is `hidden` is not there for the user: only visible buttons count (a DISABLED one still is)
const btn = (scope, word) => all(scope).find(e => e.tagName === 'button' && !e.hidden && (e.textContent === word || e.attrs['aria-label'] === word));
const rowOf = (c, input) => all(c).find(e => e.className === 'row' && e.children.includes(input));

test('S21 Chat: the page is cards in the wireframe order, each provider with its own state badge (icon + word)', async () => {
  const { ui } = await mount({ present: { 'google-api-key': true } });
  assert.deepEqual(all(ui).filter(e => e.tagName === 'h2').map(e => text(e).replace(/\s+/g, ' ').trim()).map(s => s.split(' ').slice(0, 2).join(' ').replace(/ [✓✗·].*/, '')),
    ['Claude', 'Google AI', 'OpenAI', 'OpenRouter', 'Modelos locales', 'Contexto de']);
  assert.equal(stateOf(card(ui, 'Google AI')), '✓ lista'); assert.equal(stateOf(card(ui, 'OpenAI')), '✗ sin clave'); assert.equal(stateOf(card(ui, 'OpenRouter')), '✗ sin clave');
  assert.equal(stateOf(card(ui, 'Claude')), '✗ sin clave');
  for (const t of ['Claude', 'Google AI', 'OpenAI', 'OpenRouter']) assert(all(card(ui, t)).some(e => e.attrs['aria-hidden'] === 'true' && e.className === 'state-ico'), `${t}: the icon is decorative, the word carries the state`);
  assert(card(ui, 'Claude').className.split(' ').includes('abito-card') && card(ui, 'Google AI').className.split(' ').includes('abito-card'));
  // the unreadable keychain says so instead of pretending
  const bad = await mount({ failPresent: true }); assert.equal(stateOf(card(bad.ui, 'OpenAI')), '· No disponible todavía');
});

test('S21 Chat: «Probar» only where a key exists; it checks locally through closed commands and says it did not call the provider', async () => {
  const { ui, calls } = await mount({ present: { 'google-api-key': true }, accounts: [{ accountId: 'key-google' }] });
  const google = card(ui, 'Google AI'), openai = card(ui, 'OpenAI');
  assert(btn(google, 'Probar') && !btn(google, 'Probar').disabled && !btn(google, 'Quitar').hidden);
  // #503 S21 (screen validation): «Probar» is always VISIBLE (the MD shows it on the «sin clave» card too); without a key it is
  // DISABLED and says why, instead of vanishing. «Quitar» has nothing to remove without a key, so it stays hidden.
  const noKey = btn(openai, 'Probar'); assert(noKey && !noKey.hidden, 'visible without a key'); assert.equal(noKey.disabled, true, 'disabled without a key');
  assert.equal(noKey.attrs.title, 'Guarda una clave para poder probarla.'); assert.equal(btn(google, 'Probar').attrs.title, '', 'no tooltip once it can be used'); assert.equal(noKey.attrs['aria-disabled'], 'true');
  assert(!btn(openai, 'Quitar'), 'nothing to remove without a key');
  const reason = all(openai).find(e => e.attrs.id === 'chat-key-test-reason-openai-api-key'); assert(reason, 'the reason is also text, not only a tooltip'); assert.equal(text(reason).trim(), 'Guarda una clave para poder probarla.');
  assert.equal(noKey.attrs['aria-describedby'], reason.attrs.id);
  assert.equal(text(all(google).find(e => e.attrs.id === 'chat-key-test-reason-google-api-key')).trim(), '', 'no reason once a key exists');
  calls.length = 0; btn(google, 'Probar').fire('click', false); await ui.settled(); assert.deepEqual(calls, [], 'synthetic click does nothing');
  btn(google, 'Probar').fire('click'); await ui.settled();
  assert.deepEqual(calls.map(([c, p]) => `${c}:${p.action}`), ['secret_action:present', 'agent_action:view'], 'only closed read commands');
  assert.deepEqual(calls[0][1], { action: 'present', key: 'google-api-key' });
  const verdict = text(google); assert(verdict.includes('Clave guardada y cuenta del chat lista.')); assert(verdict.includes('No se contactó al proveedor.'));
  assert(!calls.some(([, p]) => p.action === 'set' || p.action === 'clear' || /^abito_account/.test(p.action)), 'a test never writes');
  // key stored but no chat account yet
  const noAccount = await mount({ present: { 'openai-api-key': true }, accounts: [] });
  btn(card(noAccount.ui, 'OpenAI'), 'Probar').fire('click'); await noAccount.ui.settled();
  assert(text(card(noAccount.ui, 'OpenAI')).includes('El chat aún no tiene cuenta para este proveedor. Vuelve a guardar la clave.'));
  // the keychain failing while testing is reported, never a green tick
  const failing = await mount({ present: { 'google-api-key': true }, accounts: [{ accountId: 'key-google' }] });
  const probe = btn(card(failing.ui, 'Google AI'), 'Probar'); failing.failNext();
  probe.fire('click'); await failing.ui.settled();
  assert(text(card(failing.ui, 'Google AI')).includes('No se pudo comprobar la clave.'));
  assert(!text(card(failing.ui, 'Google AI')).includes('Clave guardada y cuenta del chat lista.'));
});

test('S21 Chat: show/hide masks the draft only; trusted-only; the field is cleared and re-masked on every save', async () => {
  const { ui, calls } = await mount();
  const c = card(ui, 'OpenAI'), input = field(c, 'chat-key-openai-api-key'), eye = btn(c, 'Mostrar clave');
  assert.equal(input.type, 'password'); assert(eye); assert.equal(eye.attrs['aria-pressed'], 'false');
  eye.fire('click', false); assert.equal(input.type, 'password', 'synthetic click does nothing');
  eye.fire('click'); assert.equal(input.type, 'text'); assert.equal(eye.attrs['aria-pressed'], 'true'); assert.equal(eye.attrs['aria-label'], 'Ocultar clave');
  eye.fire('click'); assert.equal(input.type, 'password'); assert.equal(eye.attrs['aria-pressed'], 'false');
  eye.fire('click'); input.value = 'sk-fixture'; calls.length = 0;
  btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.equal(input.value, ''); assert.equal(input.type, 'password', 'a saved draft is hidden again');
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action'), [['secret_action', { action: 'set', key: 'openai-api-key', value: 'sk-fixture' }]]);
  assert(!text(ui).includes('sk-fixture'));
});

test('S21 Chat: inline validation sits next to the field, blocks the write, and clears as soon as the user types', async () => {
  const { ui, calls } = await mount();
  const c = card(ui, 'OpenRouter'), input = field(c, 'chat-key-openrouter-api-key');
  const error = () => all(c).find(e => e.className.split(' ').includes('field-error'));
  calls.length = 0; input.value = '   '; btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action'), [], 'nothing is written');
  assert.equal(error().textContent, 'Pega la clave antes de guardar.'); assert.equal(error().attrs.role, 'alert');
  assert.equal(input.attrs['aria-invalid'], 'true'); assert.equal(input.attrs['aria-describedby'], error().attrs.id);
  assert(rowOf(c, input).parent === undefined || all(c).indexOf(error()) > all(c).indexOf(input), 'the message comes right after the field, inside the same card');
  input.value = 'sk-or-x'; input.fire('input'); assert.equal(error().textContent, ''); assert.equal(input.attrs['aria-invalid'], 'false');
  input.value = 'bad\u0000key'; btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.equal(error().textContent, 'La clave tiene caracteres no válidos.');
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action' && true).filter(([, p]) => p.action === 'set'), []);
});

test('S21 Chat: every control and closed command that existed survives: keys, model, local models, window context, account sync', async () => {
  const { ui, calls } = await mount({ present: { 'anthropic-api-key': true } });
  for (const id of ['anthropic-api-key', 'google-api-key', 'openai-api-key', 'openrouter-api-key']) assert(field(ui, `chat-key-${id}`), id);
  assert(field(ui, 'chat-anthropic-model')); assert(all(ui).some(e => e.attrs.id === 'chat-url-ollama') && all(ui).some(e => e.attrs.id === 'chat-url-lmstudio') && all(ui).some(e => e.attrs.id === 'chat-url-custom'));
  assert(text(ui).includes('Contexto de la ventana activa')); assert(all(ui).some(e => e.className.split(' ').includes('switch')), 'the window-context switch');
  assert(all(ui).some(e => e.attrs.id === 'chat-local-models'), 'the local models card is addressable (the models list mounts into it)');
  const claude = card(ui, 'Claude'); calls.length = 0;
  field(claude, 'chat-key-anthropic-api-key').value = 'sk-ant-fixture'; btn(claude, 'Guardar clave').fire('click'); await ui.settled();
  assert(calls.some(([c, p]) => c === 'agent_action' && p.action === 'abito_account_create' && p.accountId === 'key-anthropic'), 'the key still becomes a chat account');
  const fs = require('node:fs'), path = require('node:path');
  const entry = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  assert.match(entry, /chat\.querySelector\?\.\('#chat-local-models'\)/, 'the models list mounts by id, not by child index');
});
