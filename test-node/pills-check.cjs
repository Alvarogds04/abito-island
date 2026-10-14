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
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function boot({ prefs = {}, failView = false, deferView = false } = {}) {
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
    createElement: tag => new Element(tag), importNode: node => node,
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); }, querySelectorAll: () => [] };
  const backend = { prefs: { sound: false, gain: 0.12, avatarColors: {}, ...M.normalize(prefs) }, rejectNext: false, pendingView: null };
  const window = { addEventListener() {}, __TAURI__: {
    core: { invoke(cmd, { payload }) {
      calls.push({ cmd, payload: clone(payload) });
      if (cmd === 'prefs_action') {
        if (payload.action === 'view') {
          if (deferView) return new Promise(resolve => { backend.pendingView = resolve; });
          return failView ? Promise.reject(new Error('no ipc')) : Promise.resolve(clone(backend.prefs));
        }
        if (backend.rejectNext) { backend.rejectNext = false; return Promise.reject(new Error('save_failed')); }
        const next = payload.action === 'set_main_pill' ? M.chooseMain(backend.prefs, payload.id) : payload.action === 'toggle_declared_pill' ? M.toggle(backend.prefs, payload.id) : null;
        if (next) Object.assign(backend.prefs, next);
        else if (payload.action === 'sound_on') backend.prefs.sound = true;
        else if (payload.action === 'sound_off') backend.prefs.sound = false;
        else if (payload.action === 'set_sound_gain') backend.prefs.gain = payload.gain;
        else if (payload.action === 'set_display_name') backend.prefs.displayName = payload.display_name.trim();
        else if (payload.action === 'set_avatar_color') backend.prefs.avatarColors[payload.identity] = payload.color;
        else return Promise.reject(new Error('invalid_schema'));
        return Promise.resolve(clone(backend.prefs));
      }
      if (cmd === 'agent_action' && payload.action === 'view') return Promise.resolve({ connection: 'no_daemon' });
      if (cmd === 'hotkey_action' && payload.action === 'view') return Promise.resolve({ enabled: false });
      return Promise.reject(new Error('unexpected IPC'));
    } },
    event: { listen(name, fn) { (native[name] ||= []).push(fn); return Promise.resolve(() => {}); } },
  } };
  const ctx = vm.createContext({ window, self: window, document: doc, navigator: { userAgent: 'Linux' },
    DOMParser: class { parseFromString() { const n = new Element('svg'); n.nodeName = 'svg'; return { documentElement: n }; } },
    requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } }, console });
  const load = file => vm.runInContext(read(file), ctx, { filename: file });
  for (const file of ['pill-catalog.js', 'pills.js', 'icons.js', 'pills-view.js']) load(file);
  get('capsule').dataset = { phase: 'expanded', view: 'overview' };
  const emit = value => { backend.prefs = { ...backend.prefs, ...value }; for (const fn of native['prefs:state'] || []) fn({ payload: clone(backend.prefs) }); };
  return { get, calls, backend, doc, load, window, emit, click(id, fields) { assert.ok(get(id), id); get(id).fire('click', fields); } };
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
  for (const file of ['pill-catalog.js', 'pills.js', 'pills-view.js']) assert.ok(scripts.includes(file));
  assert.ok(scripts.indexOf('pill-catalog.js') < scripts.indexOf('pills.js'));
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
  assert.deepEqual(b.get('pill-choices').children.map(x => x.dataset.pillId), ['agent_cursor', 'agent_amp', 'ai_google']);
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
