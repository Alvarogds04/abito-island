'use strict';
// Node-only suite, discovered alongside the other test-node/*-check.cjs suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'frontend/vendor/coucou');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(fn); }
  removeEventListener(k, fn) { this.listeners.get(k)?.delete(fn); }
  fire(k, props = {}) { const e = { target: this, preventDefault() { this.prevented = true; }, ...props }; for (const fn of [...(this.listeners.get(k) || [])]) fn(e); return e; }
  count() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}
class Element extends Target {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.nodeType = 1; this.offsetWidth = 180; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  contains(n) { return n === this || this.children.some(c => c.contains?.(n)); }
  querySelector(selector) { const classes = selector.slice(1).split('.'); return this.children.find(n => classes.every(c => n.className?.split(' ').includes(c))) || null; }
  getBoundingClientRect() { return { left: 1000, bottom: 30 }; }
  focus() { document.activeElement = this; }
}
const document = Object.assign(new Target(), {
  body: new Element('body'), createElement: tag => new Element(tag),
  createTextNode: data => ({ nodeType: 3, data }),
});
global.document = document;
global.window = Object.assign(new Target(), { innerWidth: 320 });
const palette = () => document.body.children.find(n => n.className === 'palette');
const load = file => import(pathToFileURL(path.join(vendor, file)).href);
function hashTree() {
  const hash = crypto.createHash('sha256');
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else hash.update(path.relative(vendor, file)).update(fs.readFileSync(file)); } }
  walk(vendor); return hash.digest('hex');
}
(async () => {
  // Missing compiled module is the intended RED, before any build side effect.
  const { colorDot } = await load('settings/colors.js');
  const { statusDot, renderDiff } = await load('settings/parts.js');
  const { PILL_PALETTE, parsePillColors } = await load('core/pill-colors.js');
  const { createColorBridge } = await load('bridge-abito.js');
  let colors = {}, picks = 0;
  const dot = colorDot({ id: 'agent_amp', name: 'Agente', color: '#F5F6F8' }, 'width:8px', () => colors, next => { colors = next; picks++; });
  document.body.append(dot);
  assert.equal(dot.getAttribute('role'), 'button');
  assert.equal(dot.getAttribute('tabindex'), '0');
  assert.equal(dot.getAttribute('aria-label'), 'Agente · Color');
  dot.fire('click');
  assert.equal(palette().getAttribute('role'), 'group');
  assert.equal(palette().children.length, PILL_PALETTE.length);
  assert.equal(document.activeElement.getAttribute('aria-pressed'), '');
  assert.equal(palette().style.left, '132px');
  palette().children[1].fire('click');
  assert.equal(picks, 1); assert.equal(colors.agent_amp, '#F4505E');
  assert.equal(palette(), undefined); assert.equal(document.activeElement, dot);
  assert.equal(dot.style.background, '#F4505E');
  assert(dot.fire('keydown', { key: 'Enter' }).prevented);
  assert.equal(palette().children.at(-1).textContent, 'Predeterminado');
  palette().children.at(-1).fire('click'); assert.deepEqual(colors, {});
  dot.fire('keydown', { key: ' ' }); document.fire('keydown', { key: 'Escape' });
  assert.equal(palette(), undefined); assert.equal(document.activeElement, dot);
  dot.fire('click'); dot.fire('click'); assert.equal(palette(), undefined);
  dot.fire('click'); document.fire('mousedown'); assert.equal(palette(), undefined);
  dot.fire('click'); window.fire('resize'); assert.equal(palette(), undefined);
  dot.fire('keydown', { key: 'Tab' }); assert.equal(palette(), undefined);
  dot.fire('click'); dot.fire('keydown', { key: 'Enter' });
  assert.equal(document.body.children.filter(n => n.className === 'palette').length, 1);
  document.fire('keydown', { key: 'Escape' });
  assert.equal(document.count(), 0); assert.equal(window.count(), 0);
  assert.equal(statusDot(true).getAttribute('style'), 'background:#22c55e');
  assert.equal(statusDot(false).getAttribute('style'), 'background:#f4505e');
  const diff = renderDiff('+nuevo\n-viejo\n<img src=x>');
  assert.deepEqual(diff.children.map(n => n.className), ['add', 'del', 'ctx']);
  assert.equal(diff.children[2].textContent, '<img src=x>');
  assert.deepEqual(parsePillColors({ a: 'bad', b: '#abcdef' }), { b: '#ABCDEF' });
  const bridge = createColorBridge();
  assert.deepEqual(bridge.colors(), {});
  assert.throws(() => bridge.pick({ agent_amp: '#F4505E' }), /Abito.*hexadecimal/);
  assert.throws(() => bridge.pick({}), /Abito.*hexadecimal/);
  await assert.rejects(bridge.refresh(), /IPC prefs_action no disponible/);
  const calls = [];
  await createColorBridge(async (...args) => { calls.push(args); return { pillColors: {} }; }).refresh();
  assert.deepEqual(calls, [['prefs_action', { payload: { action: 'view' } }]]);
  await assert.rejects(createColorBridge(async () => ({ pillColors: { agent_amp: 'mint' } })).refresh(), /hexadecimal/);
  await assert.rejects(createColorBridge(async () => null).refresh(), /inválida/);
  await assert.rejects(createColorBridge(async () => { throw new Error('save_failed'); }).refresh(), /save_failed/);
  const { t } = await load('i18n/i18n.js');
  assert.throws(() => t('Unknown'), /Traducción/);
  const before = hashTree();
  for (let i = 0; i < 2; i++) {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-coucou.cjs')], { stdio: 'inherit' });
    assert.equal(hashTree(), before, 'checked-in output and two builds must match');
  }
  console.log(`PASS coucou-vendor: palette, keyboard, focus, cleanup, parts, bridge refusal; deterministic SHA256 ${before}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
