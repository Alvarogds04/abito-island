'use strict';
const assert = require('node:assert/strict');
const { classify, extraScenes, hubPages } = require('../packaging/validate/scenes.cjs');
const expected = ['integracion-github', 'correo-keyring', 'spotify-reproductor', 'sonidos-controles', 'sonidos-audible', 'dictado-sin-modelo', 'voz-sin-modelo', 'voz-reconocimiento', 'bandeja-menu', 'autoinicio', 'personaje-escritorio', 'chat-segundo-turno', 'dictado-inactivo', 'sesiones-motor', 'sin-motor-sin-productor', 'sin-motor-con-productor', 'pi-aviso', 'pi-pregunta'];
for (const name of expected) assert(extraScenes.includes(name), `missing ${name}`);
for (const page of ['general','agents','pills','chat','integrations','shortcuts','voice','dictation','flowsettings','dictionary','snippets','styles','insights','notes','phone']) assert(hubPages.includes(page), `missing hub page ${page}`);
assert.equal(classify({ok:true}).verdict, 'pass');
assert.equal(classify({ok:false,reason:'composer locked'}).verdict, 'fail');
assert.equal(classify({ok:true,errors:['uncaught']}).verdict, 'fail');
assert.equal(classify({}).verdict, 'fail', 'missing evidence cannot pass');
assert.equal(classify({ok:true,unverifiable:'no keyring'}).verdict, 'unverifiable');
assert.equal(classify({ok:false,reason:'blank',unverifiable:'no keyring'}).verdict, 'fail', 'render failure wins over environmental limitation');
assert.equal(classify(null).verdict, 'fail');
assert(extraScenes.includes('ajustes-engranaje'));
for (const page of hubPages) assert(extraScenes.includes(`ajustes-${page}`));
// Detect hub additions rather than silently skipping them.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/shell.js'), 'utf8');
const ids = [...source.matchAll(/\{ id: "([a-z]+)", icon:/g)].map(m => m[1]);
assert.deepEqual([...hubPages].sort(), ids.sort());
console.log(`validate-scenes: verdict and catalog checks passed (${extraScenes.length + 6} scenes)`);

// Exercise the real browser scene driver; emulate only the external trusted-input boundary.
(async () => {
  const vm = require('node:vm');
  let focused = false;
  const clicks = [];
  const element = (x, shown) => ({
    disabled: false, textContent: 'GitHub 17', scrollIntoView() {},
    getBoundingClientRect: () => ({ x, y: 10, width: shown() ? 20 : 0, height: shown() ? 20 : 0 }),
    closest: () => null,
  });
  const githubPill = element(10, () => !focused);
  const abitoPill = element(50, () => true);
  const card = element(90, () => focused);
  const activity = { available: true, activity: { total: 17 } };
  const window = { __validateOrigin: { x: 0, y: 0, scale: 1 }, __TAURI__: {
    core: { invoke: async command => command === 'prefs_action' ? { declaredPills: ['integration_github'] } : command === 'github_action' ? activity : {} },
    event: { emit: async (event, payload) => {
      assert.equal(event, 'validate-input'); assert.equal(payload.kind, 'click');
      clicks.push(payload.x);
      if (payload.x === 20) focused = true;
      else if (payload.x === 60) focused = false;
      else assert.fail('unexpected click target');
    } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8'), {
    window, document: {
      getElementById: id => ({ 'pill-choice-integration_github': githubPill, 'pill-choice-abito': abitoPill })[id],
      querySelector: selector => selector === '.gh-card' ? card : null,
    },
    addEventListener() {}, console: { error() {} }, performance,
    setTimeout: fn => { fn(); return 1; }, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  const result = await window.AbitoValidate.github();
  assert.equal(result.ok, true); assert.equal(result.text, 'GitHub 17'); assert.equal(result.data, activity);
  assert.equal(focused, false, 'GitHub scene must release focus before the Spotify scene');
  assert.deepEqual(clicks, [20, 60], 'focus and cleanup both use the external trusted-click helper');
  console.log('validate-scenes: GitHub scene isolates focus with trusted input');
})().catch(error => { console.error(error); process.exitCode = 1; });
