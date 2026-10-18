'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'frontend/vendor/coucou');
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.style = { setProperty() {} };
    this.classList = { contains: c => this.className.split(' ').includes(c), toggle: (c, on) => {
      const s = new Set(this.className.split(' ')); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' ');
    } };
  }
  setAttribute(k, v) { assert.notEqual(k, 'style'); this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  append(...nodes) { this.children.push(...nodes); }
  fire(k) { for (const f of this.listeners[k] || []) f({ target: this }); }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
}
const all = e => [e, ...e.children.flatMap(all)];
const text = e => [e.textContent || '', ...e.children.map(text)].join(' ');
const controls = section => {
  const nodes = all(section);
  return { buttons: nodes.filter(e => e.tagName === 'button'), volume: nodes.find(e => e.attrs.type === 'range'), close: nodes.find(e => e.attrs.type === 'number'), screen: nodes.find(e => e.tagName === 'select') };
};
(async () => {
  const { renderGeneral } = await import(pathToFileURL(path.join(vendor, 'settings/general.js')));
  const { createBridge } = await import(pathToFileURL(path.join(vendor, 'bridge-abito.js')));
  global.document = { createElement: tag => new Element(tag) };
  global.Bridge = new Proxy({}, { get() { throw Error('No Bridge access allowed'); } });
  const settings = { soundEnabled: true, soundVolume: 0.12, autoCloseInterval: 15, openOnHover: false, screen: 'primary', untouched: { nested: true } };
  const saves = [], section = renderGeneral({ settings, save: next => saves.push(next) });
  assert.equal(section.tagName, 'section');
  for (const label of ['General', 'Sonido', 'Abrir al pasar el cursor', 'Cierre automático', 'Pantalla de la isla']) assert(text(section).includes(label));
  assert.equal(all(section).filter(e => e.className === 'row').length, 4);
  const c = controls(section);
  c.buttons[0].fire('click');
  assert.deepEqual(saves.pop(), { ...settings, soundEnabled: false });
  assert.equal(settings.soundEnabled, true);
  assert.deepEqual([c.volume.attrs.min, c.volume.attrs.max, c.volume.attrs.step], ['0', '0.2', '0.005']);
  c.volume.value = '0.075'; c.volume.fire('input'); assert.equal(saves.length, 0);
  c.volume.fire('change'); assert.deepEqual(saves.pop(), { ...settings, soundEnabled: false, soundVolume: 0.075 });
  c.buttons[1].fire('click'); assert.equal(saves.pop().openOnHover, true);
  for (const [input, expected] of [['0', 0], ['4', 5], ['200', 120], ['abc', 15], ['', 15], ['   ', 15], ['1', 5], ['2', 5], ['3', 5], ['0.4', 5], ['5.6', 6], ['-1', 5]]) {
    c.close.value = input; c.close.fire('change'); const next = saves.pop();
    assert.equal(next.autoCloseInterval, expected); assert.equal(c.close.value, String(expected));
  }
  assert.deepEqual(settings, { soundEnabled: true, soundVolume: 0.12, autoCloseInterval: 15, openOnHover: false, screen: 'primary', untouched: { nested: true } });
  assert('disabled' in c.screen.attrs); assert.deepEqual(c.screen.children.map(e => e.attrs.value), ['primary']);
  c.screen.fire('change'); assert.equal(saves.length, 0);
  const other = renderGeneral({ settings: { ...settings, screen: 'DP-1|raw' }, save() { throw Error('readonly'); } });
  assert.deepEqual(controls(other).screen.children.map(e => e.attrs.value), ['primary', 'DP-1|raw']);
  assert.equal(controls(other).screen.children[1].textContent, 'DP-1|raw');
  assert(!all(section).some(e => e.attrs.value === 'cursor'));
  const note = all(section).filter(e => e.textContent?.startsWith('No disponible en Abito todavía:'));
  assert.equal(note.length, 1);
  for (const name of ['carpeta de sonidos', 'recarga y contador de sonidos', 'inicio automático', 'idioma', 'resumen']) assert(note[0].textContent.includes(name));
  const source = fs.readFileSync(path.join(vendor, 'settings/general.ts'), 'utf8');
  assert(!/Mochi|Coucou/i.test(source.split('\n').slice(1).join('\n')));
  assert(!/Bridge/.test(source));
  const rust = fs.readFileSync(path.join(root, 'src/prefs.rs'), 'utf8');
  const shapes = { view: [], sound_on: [], sound_off: [], set_sound_gain: ['gain'], set_island_interaction: ['open_on_hover', 'auto_close_seconds'] };
  for (const [action, keys] of Object.entries(shapes)) {
    assert(rust.includes(`Some("${action}") if map.len() == ${keys.length + 1}`), action);
    for (const key of keys) assert(rust.includes(`map.get("${key}")`), key);
  }
  for (const [control, value, expected] of [
    ['sound', false, { action: 'sound_off' }], ['sound', true, { action: 'sound_on' }],
    ['volume', '0.08', { action: 'set_sound_gain', gain: 0.08 }],
    ['hover', true, { action: 'set_island_interaction', open_on_hover: true, auto_close_seconds: 15 }],
    ['close', '0', { action: 'set_island_interaction', open_on_hover: false, auto_close_seconds: 0 }],
  ]) {
    const calls = []; let pending;
    const view = { sound: control === 'sound' ? !value : true, gain: 0.12, autoCloseSeconds: 15, openOnHover: false, monitor: null, mainPill: 'integration_claude', declaredPills: [], pillColors: {} };
    const bridge = createBridge(async (command, { payload }) => {
      assert.equal(command, 'prefs_action'); assert.deepEqual(Object.keys(payload).sort(), ['action', ...shapes[payload.action]].sort());
      if (payload.action !== 'view') calls.push(payload);
      return view;
    });
    const s = await bridge.boot();
    const ui = controls(renderGeneral({ settings: s, save: next => { pending = bridge.saveSettings(next); } }));
    if (control === 'sound') ui.buttons[0].fire('click');
    if (control === 'hover') ui.buttons[1].fire('click');
    if (control === 'volume' || control === 'close') { ui[control].value = value; ui[control].fire('change'); }
    await pending; assert.deepEqual(calls, [expected]);
  }
  const hubSource = fs.readFileSync(path.join(vendor, 'hub/general.ts'), 'utf8');
  assert(hubSource.includes("t('seconds after you leave the island')"), 'mounted General retains upstream seconds copy');
  assert(!hubSource.includes('autoCloseSegments'), 'mounted General must not retain segmented auto-close');
  console.log('PASS coucou-general: pure section, immutable saves, commit volume, interval normalization, unavailable rows, real bridge payloads');
})().catch(error => { console.error(error); process.exitCode = 1; });
