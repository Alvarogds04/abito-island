'use strict';
// Exercise production presentation entry points without a microphone or a live display.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '../frontend');
class Element {
  constructor() { this.dataset = {}; this.style = {}; this.children = []; this.hidden = false; this.classList = { toggle() {} }; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
  querySelector() { return null; }
  remove() {}
}

test('B1 reproduction: expand then collapse settles the visible island and input report at 288x32', () => {
  const source = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  const capsule = new Element(), island = new Element(), clayEl = new Element();
  const calls = [], frames = new Map(); let serial = 0, now = 0;
  const context = vm.createContext({
    capsule, island, clayEl, $: () => null, noticeLane: null,
    window: {}, document: { dispatchEvent() {} }, CustomEvent: class {},
    O: require('../frontend/overview-view.js'), motionReduced: () => false,
    performance: { now: () => now },
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(); },
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; },
  });
  const geometry = source.slice(source.indexOf('  const COMPACT ='), source.indexOf('  // Tauri IPC bridge'));
  const motion = source.slice(source.indexOf('  const W0 ='), source.indexOf('  // ---- motion override'));
  const entry = source.slice(source.indexOf('  function setPhase('), source.indexOf('  // ---- frontend evidence'));
  vm.runInContext(geometry + motion + entry, context);
  function drain() { for (let i = 0; frames.size && i < 300; i++) { now += 16.667; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); } assert.equal(frames.size, 0); }
  context.window.__islandSetState('overview'); drain();
  assert.equal(capsule.dataset.phase, 'expanded'); assert.equal(island.style.width, '640px');
  context.window.__islandSetState('compact'); drain();
  console.log('B1 rendered:', capsule.dataset.phase, island.style.width, island.style.height, 'shape:', JSON.stringify(calls.at(-1)));
  assert.equal(capsule.dataset.phase, 'compact');
  assert.equal(island.style.width, '288px'); assert.equal(island.style.height, '32px');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['island_shape', { payload: { w: 288, h: 32, settled: true } }]);
});

test('B2: enabled dictation stays hidden at boot and after idle; live and pending results appear', async () => {
  const capsule = new Element(), header = new Element(), events = {};
  capsule.dataset = { phase: 'expanded', view: 'overview' };
  const document = {
    getElementById: id => id === 'capsule' ? capsule : id === 'island-header' ? header : null,
    createElement: () => new Element(), createElementNS: () => new Element(),
    documentElement: { dataset: {} }, addEventListener() {},
  };
  const window = { __TAURI__: {
    core: { invoke: () => Promise.resolve({ prefs: { enabled: true } }) },
    event: { listen: (name, fn) => { events[name] = fn; return Promise.resolve(); } },
  } };
  const context = vm.createContext({ document, window, self: window, setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, queueMicrotask() {}, performance: { now: () => 0 } });
  vm.runInContext(fs.readFileSync(path.join(frontend, 'island-dictation.js'), 'utf8'), context);
  await Promise.resolve();
  const pill = header.children[0];
  console.log('B2 rendered at boot: .dpill hidden =', pill.hidden, 'children =', pill.children.length);
  assert.equal(pill.hidden, true, 'enabled is permission to dictate, not an active dictation');
  for (const phase of ['listening', 'locked', 'thinking', 'copied', 'failed', 'idle']) {
    events['dictation:phase']({ payload: { phase } });
    assert.equal(pill.hidden, phase === 'idle', phase);
  }
});
