'use strict';
// #488: the OK Abito page is live. Closed voice_action contract, synthetic gestures
// never reach IPC, nothing starts on its own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { voicePage } = await import(pathToFileURL(path.join(base, 'voice-page.js')));
  const { setInvoke } = await import(pathToFileURL(path.join(base, 'flow-shim.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  const events = new Map(), calls = [];
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const l = events.get(name) || new Set(); events.set(name, l); l.add(fn); return () => l.delete(fn); } } } };
  let st = { prefs: { enabled: false, output: 'system', gender: 'female', sensitivity: 50 }, vad: { state: 'missing' }, downloadMb: 1, parakeet: { state: 'missing' }, listening: false, error: null };
  setInvoke(async (cmd, { payload: p }) => {
    calls.push([cmd, structuredClone(p)]);
    if (cmd === 'voice_action') {
      if (p.action === 'set_prefs') st = { ...st, prefs: { ...p.prefs } };
      if (p.action.startsWith('train_')) {
        const tr = st.training || { recorded: 0, target: 5, active: false, last: null, learned: {} };
        const heard = ['Yes. Avito.', 'yes avito', 'yes avito', 'Yes avito!', 'yes avito'];
        if (p.action === 'train_record') tr.last = heard[tr.recorded], tr.recorded += 1, tr.active = true;
        if (p.action === 'train_undo') tr.recorded -= 1, tr.last = null;
        if (p.action === 'train_cancel') tr.recorded = 0, tr.active = false, tr.last = null;
        if (p.action === 'train_finish') tr.recorded = 0, tr.active = false, tr.learned = { names: ['avito'], leads: ['yes'], phrases: ['yes avito'] };
        if (p.action === 'train_reset') tr.learned = {};
        st = { ...st, training: tr };
        return structuredClone(st);
      }
      if (p.action === 'download_model') st = { ...st, vad: { state: 'downloading', fraction: 0 } };
      return structuredClone(st);
    }
    return { parakeet: { state: 'downloading', fraction: 0 }, downloadMb: 700 };
  });
  const page = new Element('div');
  await voicePage(page, { hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux' }, navigate() {}, set onLeave(_) {} });
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'status' }]], 'only a status read on open');
  assert(!text(page).includes('pendiente de conectar'));
  const sw = all(page).find(e => e.className.includes('switch'));
  sw.fire('click', false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [], 'synthetic gestures never invoke');
  sw.fire('click');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'set_prefs', prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 } }]]);
  const dl = all(page).find(e => e.tagName === 'button' && e.textContent === 'Descargar');
  assert(dl && !dl.disabled, 'download button live');
  dl.fire('click');
  await new Promise(r => setImmediate(r));
  const sent = calls.splice(0);
  assert.deepEqual(sent[0], ['voice_action', { action: 'download_model' }]);
  assert(sent.slice(1).every(([c, p]) => c === 'dictation_action' && p.action === 'download_model'), 'Parakeet is asked for too, through the dictation contract');
  const seg = all(page).filter(e => e.tagName === 'button' && ['Voz del sistema', 'ElevenLabs', 'Solo texto'].includes(e.textContent));
  assert.equal(seg.length, 3);
  seg[2].fire('click'); await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'female', sensitivity: 50 } }]]);
  const range = all(page).find(e => e.tagName === 'input' && e.attrs.type === 'range');
  assert(range, 'sensitivity slider'); calls.length = 0;
  range.value = '80'; range.fire('change', false); await new Promise(r => setImmediate(r)); assert.deepEqual(calls, []);
  range.fire('change'); await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'female', sensitivity: 80 } }]]);
  for (const e of all(page).filter(e => ['button', 'input', 'select'].includes(e.tagName))) assert(!e.disabled || e.textContent === 'Descargar', 'controls are live');
  // «Entrenar mi voz» with a fake recorder: five recordings, undo, save, reset. Models are ready here.
  st = { ...st, vad: { state: 'ready' }, parakeet: { state: 'ready' }, training: { recorded: 0, target: 5, active: false, last: null, learned: {} } };
  const page2 = new Element('div');
  await voicePage(page2, { hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux' }, navigate() {}, set onLeave(_) {} });
  const btn = name => all(page2).find(e => e.tagName === 'button' && e.textContent === name);
  const tick = () => new Promise(r => setTimeout(r, 5));
  calls.length = 0;
  assert(text(page2).includes('5 veces') && !btn('Guardar'), 'idle: explains the training');
  btn('Entrenar mi voz').fire('click'); await tick();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'train_record' }]], 'the first click records once');
  assert(text(page2).includes('Entendí: «Yes. Avito.» — 1/5'), text(page2));
  btn('Repetir la última').fire('click'); await tick();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'train_undo' }]]);
  for (let i = 0; i < 5; i++) { btn('Grabar').fire('click'); await tick(); }
  assert.equal(calls.splice(0).filter(([, q]) => q.action === 'train_record').length, 5);
  assert(text(page2).includes('5/5') && !btn('Grabar'), 'no sixth recording');
  btn('Guardar').fire('click'); await tick();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'train_finish' }]]);
  assert(text(page2).includes('Entendí: «yes avito», «avito» — listo'), text(page2));
  btn('Borrar entrenamiento').fire('click'); await tick();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'train_reset' }]]);
  assert(text(page2).includes('5 veces'), 'reset returns to idle');
  btn('Entrenar mi voz').fire('click', false); await tick();
  assert.deepEqual(calls, [], 'synthetic gestures never record');
  // The closed guard in settings-app.js
  const source = fs.readFileSync(path.resolve(__dirname, '../frontend/settings-app.js'), 'utf8').replace(/^import .*;\n/gm, '');
  const raw = []; document.getElementById = () => new Element('div');
  const ctx = { window: { __TAURI__: { core: { invoke: async (c, a) => { raw.push([c, a]); return {}; } } } }, document, setInvoke() {}, startHub: async () => {}, Set, Promise, inactivePages: {}, TextEncoder, renderUnavailable() {}, card: x => x, row: () => ({}), voicePage, dictationPage() {}, flowSettingsPage() {}, dictionaryPage() {}, snippetsPage() {}, stylesPage() {}, insightsPage() {}, renderGeneral() {} };
  vm.runInNewContext(source + '\nglobalThis.closedInvoke = invoke;', ctx);
  for (const payload of [{ action: 'status' }, { action: 'download_model' }, { action: 'remove_model' }, { action: 'train_record' }, { action: 'train_undo' }, { action: 'train_cancel' }, { action: 'train_finish' }, { action: 'train_reset' }, { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'male', sensitivity: 0 } }]) {
    await ctx.closedInvoke('voice_action', { payload }); assert.deepEqual(raw.pop(), ['voice_action', { payload }]);
  }
  for (const args of [undefined, {}, { payload: { action: 'x' } }, { payload: { action: 'train_record', n: 1 } }, { payload: { action: 'train_wipe' } }, { payload: { action: 'status', a: 1 } }, { payload: { action: 'set_prefs', prefs: { enabled: true, output: 'loud', gender: 'male', sensitivity: 5 } } }, { payload: { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'male' } } }, { payload: { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'male', sensitivity: 101 } } }, { payload: { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'male', sensitivity: 1.5 } } }, { payload: { action: 'set_prefs', prefs: { enabled: 1, output: 'off', gender: 'male', sensitivity: 5 } } }, { payload: { action: 'set_prefs', prefs: { enabled: true, output: 'off', gender: 'male', sensitivity: 5, z: 1 } } }, { payload: { action: 'status' }, extra: 1 }]) await assert.rejects(ctx.closedInvoke('voice_action', args));
  assert.equal(raw.length, 0);
  console.log('voice-page-check ok');
})().catch(e => { console.error(e); process.exit(1); });
