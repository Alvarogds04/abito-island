'use strict';
// #345 production scripts at the DOM/event boundary. Local fake DOM/IPC only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const frontend = path.join(__dirname, '../frontend');
const M = require(path.join(frontend, 'pills.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (cause) { throw new Error('test fixture must be JSON serializable', { cause }); }
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function boot({ prefs = {}, failView = false, deferView = false, store = null, specs = [], extraPrefs = {} } = {}) {
  const nodes = new Map(), events = {}, native = {}, calls = [];
  let doc;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
      this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = {};
      this.style = { setProperty() {} }; this.hidden = false; this.disabled = false;
      this.inert = false; this.value = ''; this.scrollTop = 0; this._text = '';
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
    append(...items) { for (const item of items) { const n = typeof item === 'string' ? Object.assign(new Element('#text'), { textContent: item }) : item; this.children.push(n); n.parentNode = this; } }
    replaceChildren(...items) { this.textContent = ''; this.append(...items); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }
    contains(node) { return this === node || this.children.some(x => x.contains(node)); }
    querySelectorAll(selector) {
      const found = [];
      const matches = n => selector === 'button' ? n.tagName === 'BUTTON' : selector === '[data-icon]' ? !!n.dataset.icon : /^#/.test(selector) ? n.id === selector.slice(1) : n.getAttribute('role') === /role="([^"]+)/.exec(selector)?.[1];
      const visit = n => { for (const c of n.children) { if (matches(c)) found.push(c); visit(c); } };
      visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { doc.activeElement = this; }
    fire(type, extra = {}) { const event = { type, target: this, isTrusted: true, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of this.handlers[type] || []) fn(event); }
  }
  const root = new Element();
  for (const match of read('index.html').matchAll(/id="([^"]+)"/g)) {
    const node = new Element(); node.id = match[1]; nodes.set(node.id, node); root.append(node);
  }
  const get = id => nodes.get(id) || root.querySelector(`#${id}`);
  doc = { activeElement: null, body: root, documentElement: new Element(), getElementById: get,
    createElement: tag => new Element(tag), importNode: node => node, createElementNS: (_ns, tag) => new Element(tag),
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); }, querySelectorAll: () => [] };
  const backend = { specs: { v: 1, active: null, persisted: true, load_error: false, specialists: specs.map(x => ({ space: null, spaces: [], permissions: ['read'], model: null, ...x })) },
    prefs: { sound: false, gain: 0.12, avatarColors: {}, islandAgents: null, abitoInstructions: null, ...M.normalize(prefs), ...extraPrefs }, rejectNext: false, rejectSpec: false, specCalls: [], pendingView: null, writes: 0, publications: 0 };
  const window = { addEventListener() {}, __TAURI__: {
    core: { invoke(cmd, { payload }) {
      calls.push({ cmd, payload: clone(payload) });
      if (cmd === 'prefs_action') {
        if (payload.action === 'view') {
          if (deferView) return new Promise(resolve => { backend.pendingView = resolve; });
          return failView ? Promise.reject(new Error('no ipc')) : Promise.resolve(clone(backend.prefs));
        }
        if (backend.rejectNext) { backend.rejectNext = false; return Promise.reject(new Error('save_failed')); }
        const before = JSON.stringify(backend.prefs);
        const next = payload.action === 'set_main_pill' ? M.chooseMain(backend.prefs, payload.id) : payload.action === 'toggle_declared_pill' ? M.toggle(backend.prefs, payload.id) : payload.action === 'set_pill_color' ? M.setColor(backend.prefs, payload.id, payload.color) : payload.action === 'clear_pill_color' ? M.clearColor(backend.prefs, payload.id) : payload.action === 'create_blob' ? M.createBlob(backend.prefs, payload.name, payload.color || '') : payload.action === 'delete_blob' ? M.deleteBlob(backend.prefs, payload.name) : payload.action === 'set_blob_color' ? M.setBlobColor(backend.prefs, payload.name, payload.color) : payload.action === 'reorder_declared_pills' ? M.reorderDeclared(backend.prefs, payload.order) : payload.action === 'reorder_blobs' ? M.reorderBlobs(backend.prefs, payload.order) : null;
        if (next) Object.assign(backend.prefs, next);
        else if (payload.action === 'sound_on') backend.prefs.sound = true;
        else if (payload.action === 'sound_off') backend.prefs.sound = false;
        else if (payload.action === 'set_sound_gain') backend.prefs.gain = payload.gain;
        else if (payload.action === 'set_display_name') backend.prefs.displayName = payload.display_name.trim();
        else if (payload.action === 'set_avatar_color') backend.prefs.avatarColors[payload.identity] = payload.color;
        else if (payload.action === 'set_island_agents') {
          if (!Array.isArray(payload.order) || payload.order.length > 3 || new Set(payload.order).size !== payload.order.length) return Promise.reject(new Error('invalid_schema'));
          backend.prefs.islandAgents = payload.order;
        }
        else if (payload.action === 'set_abito_instructions') backend.prefs.abitoInstructions = payload.text.trim() || null;
        else if (payload.action === 'set_island_interaction') { backend.prefs.autoCloseSeconds = payload.auto_close_seconds; backend.prefs.openOnHover = payload.open_on_hover; }
        else if (payload.action === 'set_settings_window') backend.prefs.settingsWindow = payload.settings_window === true;
        else return Promise.reject(new Error('invalid_schema'));
        if (JSON.stringify(backend.prefs) !== before) {
          backend.writes++; backend.publications++;
          const snapshot = clone(backend.prefs);
          queueMicrotask(() => { for (const fn of native['prefs:state'] || []) fn({ payload: snapshot }); });
        }
        return Promise.resolve(clone(backend.prefs));
      }
      if (cmd === 'specialists_action') {
        const sp = backend.specs;
        if (payload.action === 'view') return Promise.resolve(clone(sp));
        if (backend.rejectSpec) { backend.rejectSpec = false; return Promise.reject(new Error('invalid_specialist')); }
        if (payload.action === 'create') sp.specialists.push({ id: payload.id, name: payload.name, instructions: payload.instructions, model: payload.model, space: null, spaces: [], permissions: ['read'] });
        else if (payload.action === 'update') Object.assign(sp.specialists.find(x => x.id === payload.id), { name: payload.name, instructions: payload.instructions, model: payload.model });
        else if (payload.action === 'delete') { sp.specialists = sp.specialists.filter(x => x.id !== payload.id); if (backend.prefs.islandAgents) backend.prefs.islandAgents = backend.prefs.islandAgents.filter(x => x !== payload.id); }
        else return Promise.reject(new Error('invalid_schema'));
        backend.specCalls.push(clone(payload));
        return Promise.resolve(clone(sp));
      }
      if (cmd === 'models_action') return payload.action === 'list' ? Promise.resolve({ profiles: [{ profile_id: 'gpt-5.1', alias: 'gpt-5.1 · ChatGPT', selectable: true }], selected: backend.model || 'gpt-5.1' })
        : (backend.model = payload.profile_id, Promise.resolve({ profiles: [{ profile_id: 'gpt-5.1', alias: 'gpt-5.1 · ChatGPT', selectable: true }], selected: backend.model }));
      if (cmd === 'agent_action' && payload.action === 'abito_account_remove' && store) return store.remove(payload.accountId);
      if (cmd === 'agent_action' && store && ['abito_account_create', 'abito_account_save', 'abito_account_endpoint_set'].includes(payload.action)) return Promise.resolve({ ownedAccounts: store.apply(payload) });
      if (cmd === 'agent_action' && payload.action === 'view') return Promise.resolve({ connection: 'no_daemon', ownedAccounts: store ? store.view() : undefined });
      if (cmd === 'hotkey_action' && payload.action === 'view') return Promise.resolve({ enabled: false });
      return Promise.reject(new Error('unexpected IPC'));
    } },
    event: { listen(name, fn) { (native[name] ||= []).push(fn); return Promise.resolve(() => {}); } },
  } };
  const ctx = vm.createContext({ window, self: window, document: doc, navigator: { userAgent: 'Linux' },
    DOMParser: class { parseFromString() { const n = new Element('svg'); n.nodeName = 'svg'; return { documentElement: n }; } },
    crypto: require('node:crypto').webcrypto, requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    Event: class { constructor(type) { this.type = type; } }, console });
  const load = file => vm.runInContext(read(file), ctx, { filename: file });
  for (const file of ['pill-catalog.js', 'avatar-colors.js', 'pills.js', 'icons.js', 'pills-view.js', 'specialists-view.js']) load(file);
  get('capsule').dataset = { phase: 'expanded', view: 'overview' };
  const emit = value => { backend.prefs = { ...backend.prefs, ...value }; for (const fn of native['prefs:state'] || []) fn({ payload: clone(backend.prefs) }); };
  return { get, calls, backend, doc, events, load, window, emit, click(id, fields) { assert.ok(get(id), id); get(id).fire('click', fields); } };
}

test('S3/S4 actual shipped overview starts with main+four default choices and named states', async () => {
  const b = boot(); await flush();
  assert.equal(b.get('pill-name').textContent, 'VS Code');
  assert.equal(b.get('pill-state').textContent, 'Sin conexión');
  const buttons = b.get('pill-choices').children;
  assert.deepEqual(buttons.map(x => x.dataset.pillId), [M.DEFAULT_MAIN, ...M.DEFAULT_DECLARED]);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  for (const button of buttons) { assert.equal(button.tagName, 'BUTTON'); assert.ok(button.getAttribute('aria-label')); }
  assert.deepEqual(b.calls, [{ cmd: 'prefs_action', payload: { action: 'view' } }]);
  const scripts = [...read('index.html').matchAll(/src="([^"]+\.js)"/g)].map(x => x[1]);
  for (const file of ['pill-catalog.js', 'avatar-colors.js', 'pills.js', 'pills-view.js']) assert.ok(scripts.includes(file));
  assert.ok(scripts.indexOf('pill-catalog.js') < scripts.indexOf('pills.js'));
  assert.ok(scripts.indexOf('avatar-colors.js') < scripts.indexOf('pills.js'), 'the closed palette module loads before the pill model reads it');
  assert.ok(scripts.indexOf('icons.js') < scripts.indexOf('pills-view.js'));
});

test('S6 trusted actual selection is local-only; synthetic and covered gestures do nothing', async () => {
  const b = boot(); await flush();
  const id = 'pill-choice-integration_resend';
  b.click(id, { isTrusted: false }); assert.equal(b.get('pill-name').textContent, 'VS Code');
  b.click(id, { detail: 0 }); assert.equal(b.get('pill-name').textContent, 'Resend');
  assert.equal(b.get('pill-state').textContent, 'Sin conexión');
  assert.match(b.get('pill-detail').textContent, /no conecta/i);
  for (const fields of [{ phase: 'compact' }, { phase: 'expanded', view: 'chat' },
    { phase: 'expanded', view: 'overview', card: 'pending' },
    { phase: 'expanded', view: 'overview', question: 'pending' },
    { phase: 'expanded', view: 'overview', question: 'expired' },
    { phase: 'expanded', view: 'overview', question: 'outcome' },
    { phase: 'expanded', view: 'overview', noticeView: 'notices' }]) {
    b.get('capsule').dataset = fields; b.click('pill-choice-integration_github');
    assert.equal(b.get('pill-name').textContent, 'Resend');
  }
  assert.equal(b.calls.length, 1, 'selection never sends IPC, provider, connector or native actions');
});

test('S4 prefs event reconciles new main/removal/order and focus without erasing connection controls', async () => {
  const b = boot(); await flush();
  b.get('overview-status').textContent = 'Motor caído'; b.get('overview-detail').textContent = 'Conexión previa';
  b.click('pill-choice-integration_github'); b.get('pill-choice-integration_github').focus();
  b.emit({ mainPill: 'agent_cursor', declaredPills: ['ai_google', 'agent_amp'] });
  assert.equal(b.get('pill-name').textContent, 'Cursor');
  // #435: stored order — before this change the catalog index gave ['agent_cursor', 'agent_amp', 'ai_google'].
  assert.deepEqual(b.get('pill-choices').children.map(x => x.dataset.pillId), ['agent_cursor', 'ai_google', 'agent_amp']);
  assert.equal(b.doc.activeElement.id, 'pill-choice-agent_cursor');
  assert.equal(b.get('overview-status').textContent, 'Motor caído');
  assert.equal(b.get('overview-detail').textContent, 'Conexión previa');
  for (const id of ['notice-open', 'notice-dismiss', 'allow', 'deny', 'open-chat', 'open-settings']) assert.ok(b.get(id), id);
});

test('S6 unknown saved inputs are normalized but never rendered as markup or invented sessions', async () => {
  const b = boot(); await flush();
  b.emit({ mainPill: '<img>', declaredPills: ['__proto__', '<img>', 'integration_music', 'agent_claude-desktop', 'ai_openai', 'ai_openai'] });
  assert.deepEqual(b.get('pill-choices').children.map(x => x.dataset.pillId), [M.DEFAULT_MAIN, 'ai_openai']);
  assert.equal(b.get('pill-choices').textContent.includes('<img>'), false);
  b.emit({ declaredPills: [] }); assert.equal(b.get('pill-choices').children.length, 1);
  assert.equal(b.calls.length, 1);
});

test('S6 failed preference read reports unconfirmed defaults, not successful persistence', async () => {
  const b = boot({ failView: true }); await flush();
  assert.match(b.get('pill-live').textContent, /no se pudieron leer/i);
  assert.equal(b.get('pill-state').textContent, 'Sin conexión');
  assert.equal(b.get('pill-name').textContent, 'VS Code');
  assert.equal(b.calls.length, 1);
});

test('S6 initial prefs read cannot overwrite a newer pushed choice snapshot', async () => {
  const b = boot({ deferView: true });
  b.emit({ mainPill: 'agent_codex', declaredPills: ['agent_amp'] });
  b.backend.pendingView(M.normalize({})); await flush();
  assert.equal(b.get('pill-name').textContent, 'Codex');
  assert.deepEqual(b.get('pill-choices').children.map(x => x.dataset.pillId), ['agent_codex', 'agent_amp']);
});


const allByClass = (root, cls) => {
  const hits = [];
  const visit = n => { for (const c of n.children || []) { if (String(c.className || '').split(/\s+/).includes(cls)) hits.push(c); visit(c); } };
  visit(root); return hits;
};

async function settingsBoot(options, tab = 'pills') {
  const b = boot(options); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js', 'specialists.js']) b.load(file);
  await flush();
  b.click('open-screen-settings'); await flush();
  b.click('settings-tab-' + tab); await flush(); // #408: every section lives in its sub-tab
  return b;
}
const writes = b => b.calls.filter(x => x.cmd === 'prefs_action' && x.payload.action !== 'view');

test('S6 actual legacy sound/gain/name/avatar handlers still retain pill choices', async () => {
  const b=await settingsBoot({prefs:{mainPill:'agent_codex',declaredPills:['ai_google']}}, 'general');
  b.click('sw-sound'); await flush(); assert.equal(b.backend.prefs.sound,true);
  // T6.3 #434: the gain field became a slider committed on change (before: number input + form submit)
  const gain=b.get('settings-sound-gain'); gain.value='0.1'; gain.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain,0.1);
  // T6.3 #434: the display name lives in PERFIL on the General tab now (before: appearance tab)
  const name=b.get('settings-display-name'); name.value='Bea'; name.fire('input'); name.parentNode.fire('submit'); await flush();
  assert.equal(b.backend.prefs.displayName,'Bea');
  b.click('settings-tab-appearance'); await flush();
  b.click('dot-color-abito-blue'); await flush(); assert.equal(b.backend.prefs.avatarColors.abito,'blue');
  assert.equal(b.backend.prefs.mainPill,'agent_codex'); assert.deepEqual(b.backend.prefs.declaredPills,['ai_google']);
  assert.deepEqual(writes(b).map(x=>x.payload.action),['sound_on','set_sound_gain','set_display_name','set_avatar_color']);
  assert.equal(b.get('pill-name').textContent,'Codex');
  assert.ok(!b.get('open-screen-accounts'), '#408: no separate Cuentas/Conectores header buttons'); assert.ok(b.get('settings-tab-accounts')); assert.ok(!b.get('settings-tab-connectors'), 'S8: merged into Conexiones');
});

// T6.3 #434: the volume control is a slider (design ajustes-ventana-general-*): native range
// 0..0.2, keyboard accessible, value shown as text too, committed through the same closed
// command with the same honest failure.
test('T6.3 #434 volume slider: range 0..0.2, aria + percent text, commit on change, honest failure', async () => {
  const b = await settingsBoot({}, 'general');
  const gain = b.get('settings-sound-gain');
  assert.equal(gain.tagName, 'INPUT');
  assert.equal(gain.type, 'range');
  assert.equal(gain.min, '0'); assert.equal(gain.max, '0.2'); assert.equal(gain.step, '0.01');
  assert.equal(gain.getAttribute('aria-valuemin'), '0');
  assert.equal(gain.getAttribute('aria-valuemax'), '0.2');
  assert.equal(gain.getAttribute('aria-valuenow'), '0.12');
  assert.equal(gain.getAttribute('aria-valuetext'), '60%', 'the percent is the position inside 0..0.2');
  assert.equal(gain.getAttribute('aria-label'), 'Volumen');
  assert.equal(b.get('settings-sound-gain-value').textContent, '60%', 'the value is shown as text too');
  // commit on change through the same closed command
  gain.value = '0.05'; gain.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain, 0.05);
  assert.deepEqual(writes(b).map(x => x.payload.action), ['set_sound_gain']);
  // honest failure: nothing saved, the issue is shown, focus returns to the slider
  b.backend.rejectNext = true;
  const retry = b.get('settings-sound-gain'); retry.value = '0.1'; retry.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain, 0.05, 'a failed save keeps the previous gain');
  assert.equal(b.get('settings-sound-gain').getAttribute('aria-invalid'), 'true', 'the re-rendered slider is marked invalid');
  assert.match(b.get('settings-gain-error').textContent, /No se pudo guardar/);
  assert.equal(b.doc.activeElement && b.doc.activeElement.id, 'settings-sound-gain');
});

// T6.3 #434: General groups exactly as the design shows them, with the copy diet.
test('T6.3 #434 General groups: Perfil / Isla / Sonido y atajo, name in Perfil, no hint walls', async () => {
  const b = await settingsBoot({}, 'general');
  const text = b.get('settings-body').textContent;
  for (const word of ['Perfil', 'Isla', 'Sonido y atajo', 'Nombre', 'Auto-cierre', 'Abrir al pasar el mouse', 'Abrir Ajustes en ventana', 'Volumen', 'Atajo global']) {
    assert.ok(text.includes(word), word);
  }
  const name = b.get('settings-display-name');
  assert.ok(name, 'the display name moved into PERFIL on the General tab');
  assert.equal(name.getAttribute('placeholder'), 'Tu nombre (opcional)');
  const win = b.get('sw-settings-window');
  assert.equal(win.getAttribute('aria-label'), 'Abrir Ajustes en ventana');
  assert.equal(b.get('sw-island-hover').getAttribute('aria-label'), 'Abrir al pasar el mouse');
  // the hint walls are gone; the ONE allowed hint is the limited-shortcut note
  assert.ok(!text.includes('Avisos sonoros de la isla'));
  assert.ok(!text.includes('Se cierra sola después'));
  // the name is no longer on the appearance tab
  b.click('settings-tab-appearance'); await flush();
  assert.ok(!b.get('settings-display-name'), 'the name lives in PERFIL (General) now');
});

// T6.3 #434, #438: segmented Auto-cierre «8 s / 15 s / 30 s / Nunca» on the {0} ∪ 5..=120
// contract: presets save through the closed pair, a stored non-preset stays honest, and
// «Nunca» is a real enabled choice that stores 0 through the same closed pair.
test('T6.3 #434 auto-close segmented: presets save, custom value stays honest, Nunca stores 0', async () => {
  const b = await settingsBoot({}, 'general');
  const group = b.get('settings-autoclose-options');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'Auto-cierre');
  const seg = id => b.get('autoclose-' + id);
  for (const id of ['8', '15', '30']) {
    assert.equal(seg(id).getAttribute('role'), 'radio', id);
    assert.equal(seg(id).getAttribute('aria-checked'), id === '15' ? 'true' : 'false', id);
  }
  const never = seg('never');
  assert.equal(never.disabled, false, '#438: «Nunca» is a real choice now');
  assert.equal(never.getAttribute('title'), null);
  assert.equal(never.getAttribute('aria-checked'), 'false');
  // «Nunca» saves 0 through the same closed pair, and the projection keeps it as 0
  const beforeNever = writes(b).length;
  b.click('autoclose-never'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 0);
  assert.equal(writes(b).length, beforeNever + 1, 'exactly one save');
  assert.equal(writes(b).at(-1).payload.action, 'set_island_interaction');
  assert.equal(writes(b).at(-1).payload.auto_close_seconds, 0);
  assert.equal(writes(b).at(-1).payload.open_on_hover, false, 'the closed pair always carries both fields');
  await flush();
  assert.equal(b.get('autoclose-never').getAttribute('aria-checked'), 'true', 'a stored 0 selects «Nunca»');
  // a preset saves through the closed pair
  b.click('autoclose-8'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 8);
  assert.equal(writes(b).length, beforeNever + 2, 'exactly one more save');
  assert.equal(writes(b).at(-1).payload.auto_close_seconds, 8);
  assert.equal(writes(b).at(-1).payload.open_on_hover, false, 'the closed pair always carries both fields');
  // a stored non-preset value renders as its own selected segment, never rewritten
  b.emit({ autoCloseSeconds: 20 }); await flush();
  const custom = b.get('autoclose-20');
  assert.ok(custom, 'the custom value gets its own segment');
  assert.equal(custom.getAttribute('aria-checked'), 'true');
  assert.match(custom.textContent, /20 s/);
  assert.equal(b.get('autoclose-15').getAttribute('aria-checked'), 'false');
  // honest failure keeps the stored value
  b.backend.rejectNext = true;
  b.click('autoclose-30'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 20);
  assert.match(b.get('settings-autoclose-error').textContent, /No se pudo guardar\. La interacción sigue sin cambios/);
  // #438: a stored «Nunca» (0) renders selected after the custom-value flow too
  b.emit({ autoCloseSeconds: 0 }); await flush();
  assert.equal(b.get('autoclose-never').getAttribute('aria-checked'), 'true');
  assert.ok(!b.get('autoclose-20'), '0 is not a foreign value: no extra segment is invented');
});

test('#408 Cuentas renders the provider-list section (and tab selection follows the click) without an engine', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.ok(b.get('provider-list'), 'one provider list');
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
  assert.equal(b.get('settings-tab-pills').getAttribute('aria-selected'), 'false');
  assert.equal(b.get('settings-tab-pills').tabIndex, -1, 'roving tabindex');
  b.click('settings-tab-pills'); await flush();
  assert.equal(b.get('settings-tab-pills').getAttribute('aria-selected'), 'true');
  assert.ok(!b.get('provider-list'), 'only the selected tab is rendered');
});

test('#408 opening Ajustes asks Rust for the Settings size (open only, no numbers) and closing gives it back', async () => {
  const b = await settingsBoot({}, 'general');
  const sizes = () => b.calls.filter(x => x.cmd === 'settings_view').map(x => x.payload);
  assert.deepEqual(sizes(), [{ open: true }]);
  b.click('settings-close'); await flush();
  assert.deepEqual(sizes(), [{ open: true }, { open: false }]);
  b.click('settings-close'); await flush();
  assert.equal(sizes().length, 2, 'closing a closed panel asks nothing');
});

test('#408 Escape closes Ajustes and focus returns to the gear that opened it', async () => {
  const b = await settingsBoot({}, 'general');
  b.get('settings-close').focus();
  const keydown = b.events.keydown || [];
  assert.ok(keydown.length, 'settings.js listens for keydown');
  for (const fn of keydown) fn({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.equal(b.get('settings').inert, true, 'panel closed');
  assert.equal(b.doc.activeElement, b.get('open-screen-settings'), 'focus is back on the gear');
  assert.deepEqual(b.calls.filter(x => x.cmd === 'settings_view').map(x => x.payload).pop(), { open: false });
});

test('#408 S8 Conexiones holds providers, agents and services together; the old connectors deep link lands there', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.ok(b.get('provider-list'), 'providers group');
  assert.ok(b.get('connections-agents'), 'agents group');
  assert.ok(b.get('connections-services'), 'services group');
  b.click('settings-tab-pills'); await flush();
  for (const fn of b.events['abito:settings-select'] || []) fn({ detail: 'connectors' });
  await flush();
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
});

// #409: the Abito-owned account store only — nothing reads Pi's files any more.
function fakeStore({ accounts = [], failRemove = false } = {}) {
  let owned = accounts.map(a => clone(a));
  const view = () => ({ accounts: owned.map(a => clone(a)) });
  return { view, removes: [], saves: [],
    apply(payload) { // the masked host's account verbs: remember the command, never a raw key
      this.saves.push(payload);
      const cfg = payload.config || {};
      const at = owned.findIndex(a => a.accountId === payload.accountId);
      const prev = at >= 0 ? owned[at] : null;
      const hasCredential = Object.hasOwn(cfg, 'apiKey')
        ? typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0
        : (prev ? prev.hasCredential : false);
      const record = { accountId: payload.accountId, provider: payload.provider, hasCredential,
        config: { nombre: cfg.nombre || (prev && prev.config.nombre), baseUrl: cfg.baseUrl, api: cfg.api,
          compat: cfg.compat || {}, models: cfg.models || [], defaultModel: cfg.defaultModel } };
      if (at >= 0) owned[at] = record; else owned.push(record);
      return { accounts: owned.map(a => clone(a)) };
    },
    remove(accountId) {
      this.removes.push(accountId);
      if (failRemove) return Promise.reject({ code: 'save_failed' });
      owned = owned.filter(a => a.accountId !== accountId);
      return Promise.resolve({ ownedAccounts: view() });
    } };
}
const allText = node => node.textContent || '';

test('#409 T1 «Sacarlo»: Conexiones renders no Pi card, sends no pi_connection IPC, keeps the owned nan row', async () => {
  const store = fakeStore({ accounts: [{ accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0', 'm1'], defaultModel: 'm0' } }] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  assert.ok(!b.get('pi-connection'), 'no Pi card, even with an owned nan account');
  const text = allText(b.get('settings-body'));
  assert.ok(!text.includes('Usar la conexión de Pi'), 'no offer label anywhere');
  assert.ok(!text.includes('Volver a copiar desde Pi'), 'no re-copy label anywhere');
  assert.ok(!b.calls.some(c => c.cmd === 'pi_connection'), 'the page never asks the host about Pi');
  assert.ok(text.includes('nan (Pi)'), 'the manual owned-account row still renders');
});

test('#409 T2 «Quitar conexión» lives on the owned-account row: exact sentences, no mutation on failure', async () => {
  const account = { accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } };
  const buttons = b => (b.get('owned-accounts') ? b.get('owned-accounts').querySelectorAll('button') : []).map(x => allText(x));
  // success: the row sends the closed verb, hears back and says the existing sentence
  const store = fakeStore({ accounts: [account] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  assert.ok(buttons(b).includes('Quitar conexión'), 'the owned-account row offers deletion'); // RED before T2
  b.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Quitar conexión').fire('click'); await flush();
  assert.deepEqual(store.removes, ['nan'], 'abito_account_remove carries the accountId');
  assert.equal(b.get('settings-live').textContent, 'Conexión quitada. La clave se borró del almacén de Abito.');
  assert.ok(!buttons(b).includes('Quitar conexión'), 'the row is gone after a successful removal');
  // failure: OUR sentence, the store untouched, the row still there
  const failing = fakeStore({ accounts: [account], failRemove: true });
  const c = boot({ store: failing }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) c.load(file);
  c.click('open-screen-settings'); await flush();
  c.click('settings-tab-accounts'); await flush();
  c.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Quitar conexión').fire('click'); await flush();
  assert.equal(failing.view().accounts.length, 1, 'the store did not change');
  assert.ok(buttons(c).includes('Quitar conexión'), 'the row is still there');
  assert.match(allText(c.get('owned-accounts')), /No se pudo quitar la conexión\. No se cambió nada\./);
});

test('#409 T3 the manual masked editor: full field set, credential options, write-only secret, closed verbs', async () => {
  const KEY = ['synthetic', 'manual', 'key', '0042'].join('-');
  const store = fakeStore({ accounts: [{ accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } }] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  const openEditor = async () => {
    b.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Editar').fire('click'); await flush();
    const form = b.get('account-form'); assert.ok(form, 'the masked editor opens from the row'); return form;
  };
  // S4: every field of makeAccountForm, the identity locked for a saved account, the credential options
  const form = await openEditor();
  for (const id of ['account-provider', 'account-name', 'account-url', 'account-api', 'account-models', 'account-default', 'account-credential', 'account-secret', 'account-save', 'account-endpoint']) {
    assert.ok(b.get(id), `field ${id} exists`);
  }
  assert.equal(b.get('account-provider').disabled, true, 'provider identity cannot be rewritten for a saved account');
  const credential = b.get('account-credential');
  assert.deepEqual(credential.children.map(x => allText(x)), ['Conservar', 'Establecer clave', 'Borrar clave']);
  const secret = b.get('account-secret');
  assert.equal(secret.type, 'password');
  assert.equal(secret.disabled, true, 'the secret stays masked and inert until Establecer clave');
  // «Establecer clave»: the key crosses in the save IPC only, is cleared from the field immediately,
  // and never reaches any rendered text
  credential.value = 'set'; credential.fire('change');
  assert.equal(secret.disabled, false, 'Establecer clave enables the masked field');
  secret.value = KEY;
  form.fire('submit'); await flush();
  const save = b.calls.find(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save');
  assert.ok(save, 'saved through the closed verb');
  assert.equal(save.payload.accountId, 'nan');
  assert.equal(save.payload.config.apiKey, KEY, 'the key travels once, in the save request');
  assert.equal(secret.value, '', 'the field is cleared BEFORE the IPC, on every path');
  assert.ok(!b.get('account-form'), 'the editor closes after a save');
  assert.ok(!allText(b.get('settings-body')).includes(KEY), 'the key is nowhere on the page');
  assert.ok(allText(b.get('owned-accounts')).includes('Clave guardada'), 'the row reports the stored credential');
  // «Conservar»: no apiKey in the payload, the stored credential survives
  await openEditor();
  b.get('account-credential').value = 'keep'; b.get('account-form').fire('submit'); await flush();
  const keep = b.calls.filter(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save').pop();
  assert.ok(!Object.hasOwn(keep.payload.config, 'apiKey'), 'Conservar sends no key at all');
  assert.ok(allText(b.get('owned-accounts')).includes('Clave guardada'), 'Conservar keeps the stored key');
  // «Borrar clave»: apiKey null clears the stored credential, the row says so
  await openEditor();
  b.get('account-credential').value = 'clear'; b.get('account-form').fire('submit'); await flush();
  const clear = b.calls.filter(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save').pop();
  assert.equal(clear.payload.config.apiKey, null, 'Borrar clave sends an explicit null');
  assert.ok(allText(b.get('owned-accounts')).includes('Sin clave'), 'the row reports the cleared credential');
  // the endpoint verb stays reachable from the same editor
  await openEditor();
  b.get('account-endpoint').fire('click'); await flush();
  assert.ok(b.calls.some(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_endpoint_set'), 'endpoint_set sent from the editor');
  // write-only, not never-sent: the manual path crosses the IPC exactly once, in its own save —
  // and the earlier assertions proved it reaches no rendered text and no reply
  const withKey = b.calls.filter(c => JSON.stringify(c.payload).includes(KEY));
  assert.equal(withKey.length, 1, 'the synthetic key crosses the IPC exactly once, in its own save');
  assert.equal(withKey[0].payload.action, 'abito_account_save');
});

// #410 Conexiones compacta (S2/S3): the compaction is scoped by a public DOM attribute, and the one
// plain-text status of the owned-account row rides a chip from the closed icon registry.
const findWhere = (node, pred) => {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children || []) { const hit = findWhere(child, pred); if (hit) return hit; }
  return null;
};

test('#410 the open sub-tab is published on the tabpanel: only Conexiones carries the compact screen', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.equal(b.get('settings-body').dataset.screen, 'accounts', 'Conexiones marks the tabpanel');
  b.click('settings-tab-pills'); await flush();
  assert.equal(b.get('settings-body').dataset.screen, 'pills', 'another tab carries its own screen, so its look is untouched');
  for (const fn of b.events['abito:settings-select'] || []) fn({ detail: 'connectors' });
  await flush();
  assert.equal(b.get('settings-body').dataset.screen, 'accounts', 'the old connectors deep link marks Conexiones again');
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
});

test('#410 the credential state is an icon chip from the closed registry (same words as before)', async () => {
  const account = { accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } };
  const b = boot({ store: fakeStore({ accounts: [account] }) }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  const chip = findWhere(b.get('owned-accounts'), n => String(n.className || '').split(/\s+/).includes('chip'));
  assert.ok(chip, 'the row says the credential state with a chip, not a bare line of text');
  assert.equal(allText(chip), 'Clave guardada', 'the words are unchanged');
  assert.ok(findWhere(chip, n => String(n.className || '').split(/\s+/).includes('ico') && n.children.length),
    'the icon comes from the closed registry (an unknown name renders nothing)');
  // cleared credential: same row, the other registry icon
  const store = fakeStore({ accounts: [account] });
  const c = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) c.load(file);
  c.click('open-screen-settings'); await flush();
  c.click('settings-tab-accounts'); await flush();
  c.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Editar').fire('click'); await flush();
  c.get('account-credential').value = 'clear'; c.get('account-form').fire('submit'); await flush();
  const cleared = findWhere(c.get('owned-accounts'), n => String(n.className || '').split(/\s+/).includes('chip'));
  assert.equal(allText(cleared), 'Sin clave', 'the cleared state keeps its exact word');
  assert.ok(findWhere(cleared, n => String(n.className || '').split(/\s+/).includes('ico') && n.children.length), 'registry icon for «Sin clave»');
});

// #346 F033 — per-pill colours at the DOM/event boundary: validated name in, painted name out.
test('#346 overview paints dataset.color only with an already-validated palette name', async () => {
  const b = boot({ prefs: { pillColors: { integration_claude: 'blue', integration_n8n: 'mint', integration_vercel: '<img src=x>', integration_github: 'MINT' } } });
  await flush();
  assert.equal(b.get('pill-choice-integration_claude').dataset.color, 'blue');
  assert.equal(b.get('pill-choice-integration_n8n').dataset.color, 'mint');
  assert.equal(b.get('pill-choice-integration_vercel').dataset.color, undefined, 'a hostile stored value never paints');
  assert.equal(b.get('pill-choice-integration_github').dataset.color, undefined, 'an off-set value never paints');
  let pushedHostile;
  try { pushedHostile = JSON.parse('{"integration_resend":"expression(alert(1))","integration_claude":"purple"}'); } catch { pushedHostile = null; }
  b.emit({ pillColors: pushedHostile });
  assert.equal(b.get('pill-choice-integration_resend').dataset.color, undefined, 'a hostile pushed value never paints');
  assert.equal(b.get('pill-choice-integration_claude').dataset.color, 'purple', 'the validated name repaints');
  assert.equal(b.get('pill-choices').textContent.includes('<img'), false);
});

// ---- #415 WU2: created blobs (label + colour + order entries, prefs-persisted) ----

test('#415 the blob model creates the human examples and refuses bad names, duplicates, the principal and the ninth blob', () => {
  assert.deepEqual(M.normalize({}).blobs, [], 'a file without blobs reads as none');
  let state = M.normalize({});
  for (const [name, color] of [['Abito GitHub', 'green'], ['Abito Reviewer', ''], ['Abito correo', '']]) {
    const next = M.createBlob(state, name, color);
    assert.ok(next, `${name} must be accepted`);
    state = M.normalize(next);
  }
  assert.deepEqual(state.blobs, [
    { name: 'Abito GitHub', color: 'green' }, { name: 'Abito Reviewer', color: '' }, { name: 'Abito correo', color: '' },
  ]);
  const before = clone(state);
  for (const [name, color] of [
    ['abito github', ''], [' Abito correo ', ''], ['Abito', ''], ['ABITO', ''], // duplicates + the principal
    ['', ''], ['Abito\u{0007}', ''], ['A'.repeat(41), ''], ['Abito GitHub', ''],
    ['Nuevo', 'teal'], ['Nuevo', 42],
  ]) assert.equal(M.createBlob(state, name, color), null, `«${name}» must be refused`);
  assert.deepEqual(state, before, 'a refusal mutates nothing');
  let grown = state;
  for (let i = grown.blobs.length; i < 8; i++) grown = M.normalize(M.createBlob(grown, `B${i}`, ''));
  assert.equal(grown.blobs.length, 8);
  assert.equal(M.createBlob(grown, 'B9', ''), null, 'the ninth blob is refused');
  assert.equal(grown.blobs.length, 8);
  // deletion removes exactly the named entry; unknown names are refused
  const removed = M.deleteBlob(grown, 'B3');
  assert.ok(removed);
  assert.equal(removed.blobs.some(x => x.name === 'B3'), false);
  assert.equal(removed.blobs.length, 7);
  assert.equal(M.deleteBlob(grown, 'Nunca existió'), null);
  assert.equal(M.deleteBlob(grown, 'b3'), null, 'matching is exact, not case-folded');
  assert.deepEqual(grown.blobs.length, 8);
  // the created colour stays inside the closed palette on read
  assert.equal(M.colorOfBlob(grown, 'Abito GitHub'), 'green');
  assert.equal(M.colorOfBlob(grown, 'Abito Reviewer'), '');
});

test('#415 the overview shows created blobs after the catalog order, as label+colour buttons without connection', async () => {
  const b = boot({ prefs: { customBlobs: [{ name: 'Abito GitHub', color: 'mint' }, { name: 'Abito Reviewer' }] } });
  await flush();
  const buttons = b.get('pill-choices').children;
  assert.deepEqual(buttons.map(x => x.dataset.pillId).filter(Boolean), [M.DEFAULT_MAIN, ...M.DEFAULT_DECLARED], 'catalog order unchanged, blobs carry no pillId');
  assert.deepEqual(buttons.map(x => x.dataset.blobName), [undefined, undefined, undefined, undefined, undefined, 'Abito GitHub', 'Abito Reviewer']);
  assert.equal(buttons[5].dataset.color, 'mint');
  assert.equal(buttons[6].dataset.color, undefined);
  assert.match(buttons[5].getAttribute('aria-label'), /Abito GitHub/);
  assert.equal(buttons[5].textContent.includes('Abito GitHub'), true);
  b.emit({ customBlobs: [{ name: 'Abito correo' }] });
  await flush();
  const after = b.get('pill-choices').children;
  assert.equal(after.length, 6, 'the push replaces the whole list');
  assert.deepEqual(after.map(x => x.dataset.blobName), [undefined, undefined, undefined, undefined, undefined, 'Abito correo']);
  assert.deepEqual(after.map(x => x.dataset.pillId).filter(Boolean), [M.DEFAULT_MAIN, ...M.DEFAULT_DECLARED]);
});

async function blobBootUnused() {
  // two declared pills: the «Nuevo» slot only exists below the designed 4/4 full state
  const b = await settingsBoot({ prefs: { declaredPills: ['integration_resend', 'integration_n8n'], customBlobs: [{ name: 'Abito GitHub', color: 'mint' }] } });
  return b;
}

// #435 D4: «Principal» promotes a blob AND feeds the island character colour through
// the existing typed pref (avatarColors['abito'] via set_avatar_color) — no new wire
// field. A colourless promotion changes nothing about the character.

// ---- #442 T7.4: Blobs = agents, through the real settings.js wiring ------------------------------------
const SPECS = [{ id: 'esp-a', name: 'Revisor', instructions: 'Revisa tus PRs' }, { id: 'esp-b', name: 'Notas', instructions: 'Ordena notas' }];
const specWrites = b => b.backend.specCalls;
const swatchOf = (b, color) => allByClass(b.get('blob-editor'), 'swatch').find(x => x.dataset.color === color);

test('#442 Ajustes → Blobs paints the principal (Abito), the agent tiles from the specialist store and the island strip; nothing is written by opening it', async () => {
  const b = await settingsBoot({ specs: SPECS });
  await flush();
  assert.equal(b.get('blob-principal-card').getAttribute('aria-label'), 'Abito: siempre en la isla');
  assert.deepEqual(allByClass(b.get('blob-agent-grid'), 'blob-tile').map(x => x.dataset.agentId), ['esp-a', 'esp-b']);
  assert.equal(b.get('blob-count').textContent, '2/3');
  assert.equal(b.get('pill-principal-card'), null, 'the old principal card is gone');
  assert.equal(b.get('pill-editor-main'), null, 'the per-tile «Principal» button is removed (design §4)');
  assert.deepEqual(writes(b), []); assert.deepEqual(b.backend.specCalls, []); assert.equal(b.backend.writes, 0);
  const scripts = [...read('index.html').matchAll(/src="([^"]+\.js)"/g)].map(x => x[1]);
  assert.ok(scripts.indexOf('pills.js') < scripts.indexOf('pill-settings.js'));
  assert.ok(scripts.indexOf('specialists-view.js') < scripts.indexOf('pill-settings.js'), 'the view-model loads before the renderer reads it');
  assert.ok(scripts.indexOf('pill-settings.js') < scripts.indexOf('settings.js'));
});

test('#442 the Especialistas tab is gone and its deep link lands on Blobs', async () => {
  const b = await settingsBoot({ specs: SPECS });
  assert.equal(b.get('settings-tab-specialists'), null);
  assert.deepEqual(['general', 'accounts', 'models', 'pills', 'appearance'].map(id => !!b.get('settings-tab-' + id)), [true, true, true, true, true]);
});

test('#442 editing an agent sends the closed specialists update with the unchanged fields; a refusal keeps the previous one and says so', async () => {
  const b = await settingsBoot({ specs: SPECS });
  const name = b.get('blob-editor-name'); name.value = 'Revisora'; name.fire('change'); await flush();
  assert.deepEqual(specWrites(b), [{ action: 'update', id: 'esp-a', name: 'Revisora', instructions: 'Revisa tus PRs', model: null, space: null, spaces: [], permissions: ['read'] }]);
  assert.equal(b.backend.specs.specialists[0].name, 'Revisora');
  b.backend.rejectSpec = true;
  const what = b.get('blob-editor-what'); what.value = 'Otra cosa'; what.fire('change'); await flush();
  assert.equal(b.backend.specs.specialists[0].instructions, 'Revisa tus PRs', 'a refused update changes nothing');
  assert.equal(b.get('blob-settings-error').textContent, 'No se pudo guardar el agente; se mantuvo el anterior.');
});

test('#442 colour is the avatar colour of the SAME id; the principal colour is avatarColors.abito (D4)', async () => {
  const b = await settingsBoot({ specs: SPECS });
  swatchOf(b, 'purple').fire('click'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_avatar_color', identity: 'esp-a', color: 'purple' }]);
  assert.equal(b.backend.prefs.avatarColors['esp-a'], 'purple');
  b.click('blob-principal-card'); await flush();
  swatchOf(b, 'orange').fire('click'); await flush();
  assert.deepEqual(writes(b).slice(-1).map(x => x.payload), [{ action: 'set_avatar_color', identity: 'abito', color: 'orange' }]);
  assert.equal(b.backend.prefs.avatarColors.abito, 'orange', 'the island character follows');
  assert.equal(b.backend.prefs.mainPill, M.DEFAULT_MAIN, 'the main pill is untouched');
});

test('#442 «Activo» and the arrows write ONE closed set_island_agents (≤3); the third slot refuses a fourth', async () => {
  const b = await settingsBoot({ specs: [...SPECS, { id: 'esp-c', name: 'Correo', instructions: 'Correo' }, { id: 'esp-d', name: 'Cuarto', instructions: 'Cuarto' }] });
  assert.equal(b.get('blob-count').textContent, '3/3'); assert.equal(b.get('blob-tile-new'), null, 'lleno 3/3');
  assert.ok(b.get('blob-stored'), 'the fourth is kept and reachable');
  b.click('blob-editor-right'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_island_agents', order: ['esp-b', 'esp-a', 'esp-c'] }]);
  b.click('blob-editor-active'); await flush(); // esp-a leaves the island
  assert.deepEqual(writes(b).slice(-1).map(x => x.payload), [{ action: 'set_island_agents', order: ['esp-b', 'esp-c'] }]);
  assert.equal(b.backend.specs.specialists.length, 4, 'nothing stored is deleted');
  assert.ok(b.get('blob-tile-new'), 'a slot is free again');
  assert.equal(b.backend.prefs.mainPill, M.DEFAULT_MAIN);
});

test('#442 «Nuevo agente · Propio» creates the specialist, its colour and its island place, in that order, and selects it', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-tile-new'); await flush(); b.click('create-kind-custom'); await flush();
  b.get('blob-create-input').value = 'Música'; b.get('blob-create-input').fire('input');
  swatchOf(b, 'orange').fire('click'); await flush();
  b.get('blob-create-what').value = 'Pone música'; b.get('blob-create-what').fire('input');
  b.click('blob-create-button'); await flush(); await flush();
  const made = b.backend.specs.specialists[2];
  assert.equal(made.name, 'Música'); assert.equal(made.instructions, 'Pone música'); assert.match(made.id, /^esp-[0-9a-f]{16}$/);
  // with no stored island order the default (first three stored) already includes it: no extra write
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_avatar_color', identity: made.id, color: 'orange' }]);
  assert.equal(b.get('blob-editor-name').value, 'Música', 'the new agent is selected');
  assert.equal(b.get('blob-count').textContent, '3/3');
});

test('#442 «Del catálogo» keeps today\'s declaration gates AND creates the prefilled agent; deleting it quits the declaration (remove/re-add regression)', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: ['integration_resend'] }, specs: SPECS });
  b.click('blob-tile-new'); await flush();
  assert.equal(b.get('create-kind-catalog').getAttribute('aria-pressed'), 'true');
  b.get('pill-catalog-search').value = 'n8n'; b.get('pill-catalog-search').fire('input');
  b.get('pill-catalog-row-integration_n8n').fire('click');
  b.click('pill-catalog-add'); await flush(); await flush();
  const acts = writes(b).map(x => x.payload.action);
  assert.deepEqual(acts.slice(0, 1), ['toggle_declared_pill'], 'the SAME public toggle command declares it');
  assert.deepEqual(writes(b)[0].payload, { action: 'toggle_declared_pill', id: 'integration_n8n' });
  const made = b.backend.specs.specialists.find(x => x.name === 'n8n');
  assert.ok(made && made.instructions.includes('n8n'), 'the agent is created pre-filled from the catalog');
  assert.ok(b.backend.prefs.declaredPills.includes('integration_n8n'));
  // remove ...
  b.click('blob-editor-delete'); await flush(); b.click('blob-delete-confirm'); await flush(); await flush();
  assert.ok(!b.backend.specs.specialists.some(x => x.name === 'n8n'));
  assert.ok(!b.backend.prefs.declaredPills.includes('integration_n8n'), 'the declaration leaves with the agent');
  assert.ok(!/n8n/.test(b.get('blob-saved-before') ? b.get('blob-saved-before').textContent : ''), 'it does not come back as «Guardado de antes»');
  // ... and re-add through the same chooser
  b.click('blob-tile-new'); await flush();
  b.get('pill-catalog-row-integration_n8n').fire('click'); b.click('pill-catalog-add'); await flush(); await flush();
  assert.equal(writes(b).filter(x => x.payload.action === 'toggle_declared_pill' && x.payload.id === 'integration_n8n').length, 3, 'declare, quit, declare again');
  assert.ok(b.backend.prefs.declaredPills.includes('integration_n8n'));
});

test('#442 «Guardados de antes»: a stored custom blob becomes an agent only on the explicit action; the original entry stays', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: [] }, extraPrefs: { customBlobs: [{ name: 'Música', color: 'purple' }] }, specs: SPECS });
  assert.deepEqual(b.backend.specs.specialists.map(x => x.name), ['Revisor', 'Notas'], 'nothing converts by itself');
  allByClass(b.get('blob-saved-before'), 'blob-convert')[0].fire('click'); await flush(); await flush();
  const made = b.backend.specs.specialists[2];
  assert.equal(made.name, 'Música');
  assert.deepEqual(writes(b).map(x => x.payload).slice(0, 1), [{ action: 'set_avatar_color', identity: made.id, color: 'purple' }]);
  assert.deepEqual(b.backend.prefs.customBlobs.map(x => x.name), ['Música'], 'the original stored entry is NOT removed');
  assert.equal(b.get('blob-saved-before'), null, 'it is no longer offered once it has an agent');
});

test('#442 deleting an agent needs the inline confirmation; synthetic gestures and a failed delete change nothing', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-editor-delete'); await flush();
  assert.deepEqual(b.backend.specCalls, [], 'the first click only asks');
  b.get('blob-delete-confirm').fire('click', { isTrusted: false }); await flush();
  assert.deepEqual(b.backend.specCalls, []);
  b.backend.rejectSpec = true;
  b.click('blob-delete-confirm'); await flush();
  assert.equal(b.backend.specs.specialists.length, 2, 'a refused delete keeps the agent');
  assert.match(b.get('blob-settings-error').textContent, /No se pudo guardar el agente/);
  b.click('blob-editor-delete'); await flush(); // the failure returns to the editor: ask again
  b.click('blob-delete-confirm'); await flush();
  assert.deepEqual(b.backend.specCalls.map(x => x.action), ['delete']);
  assert.deepEqual(b.backend.specs.specialists.map(x => x.id), ['esp-b']);
});

test('#442 principal «Qué hace» uses set_abito_instructions and «Modelo» the existing models_action select; no new model key', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-principal-card'); await flush();
  assert.equal(b.get('blob-editor-name').disabled, true);
  const what = b.get('blob-editor-what'); what.value = 'Mi asistente'; what.fire('change'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_abito_instructions', text: 'Mi asistente' }]);
  assert.equal(b.backend.prefs.abitoInstructions, 'Mi asistente');
  assert.ok(b.get('blob-declarativo'));
  const model = b.get('blob-editor-model'); model.value = 'gpt-5.1'; model.fire('change'); await flush();
  assert.deepEqual(b.calls.filter(c => c.cmd === 'models_action' && c.payload.action === 'select').map(c => c.payload), [{ action: 'select', profile_id: 'gpt-5.1' }]);
});

test('#442 an identical state push neither rebuilds the Blobs screen nor restarts a character; leaving the tab disposes them', async () => {
  const b = await settingsBoot({ specs: SPECS });
  const grid = b.get('blob-agent-grid');
  b.emit({}); b.emit({}); await flush();
  assert.equal(b.get('blob-agent-grid'), grid, 'the very same node: no rebuild on identical pushes');
  b.click('settings-tab-general'); await flush();
  b.click('settings-tab-pills'); await flush();
  assert.ok(b.get('blob-agent-grid'));
});
