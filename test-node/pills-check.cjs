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

function boot({ prefs = {}, failView = false, deferView = false, store = null } = {}) {
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
  const backend = { prefs: { sound: false, gain: 0.12, avatarColors: {}, ...M.normalize(prefs) }, rejectNext: false, pendingView: null, writes: 0, publications: 0 };
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
        const next = payload.action === 'set_main_pill' ? M.chooseMain(backend.prefs, payload.id) : payload.action === 'toggle_declared_pill' ? M.toggle(backend.prefs, payload.id) : payload.action === 'set_pill_color' ? M.setColor(backend.prefs, payload.id, payload.color) : payload.action === 'clear_pill_color' ? M.clearColor(backend.prefs, payload.id) : null;
        if (next) Object.assign(backend.prefs, next);
        else if (payload.action === 'sound_on') backend.prefs.sound = true;
        else if (payload.action === 'sound_off') backend.prefs.sound = false;
        else if (payload.action === 'set_sound_gain') backend.prefs.gain = payload.gain;
        else if (payload.action === 'set_display_name') backend.prefs.displayName = payload.display_name.trim();
        else if (payload.action === 'set_avatar_color') backend.prefs.avatarColors[payload.identity] = payload.color;
        else return Promise.reject(new Error('invalid_schema'));
        if (JSON.stringify(backend.prefs) !== before) {
          backend.writes++; backend.publications++;
          const snapshot = clone(backend.prefs);
          queueMicrotask(() => { for (const fn of native['prefs:state'] || []) fn({ payload: snapshot }); });
        }
        return Promise.resolve(clone(backend.prefs));
      }
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
    requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } }, console });
  const load = file => vm.runInContext(read(file), ctx, { filename: file });
  for (const file of ['pill-catalog.js', 'avatar-colors.js', 'pills.js', 'icons.js', 'pills-view.js']) load(file);
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


async function settingsBoot(options, tab = 'pills') {
  const b = boot(options); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  b.click('settings-tab-' + tab); await flush(); // #408: every section lives in its sub-tab
  return b;
}
const writes = b => b.calls.filter(x => x.cmd === 'prefs_action' && x.payload.action !== 'view');

test('S3/S4 actual Ajustes render25 catalog rows, four main choices, defaults and platform refusals', async () => {
  const b = await settingsBoot();
  assert.equal(b.get('pill-main-setting').value, M.DEFAULT_MAIN);
  assert.deepEqual(b.get('pill-main-setting').children.map(x => x.value), ['integration_claude', 'agent_cursor', 'agent_antigravity', 'agent_codex']);
  assert.match(b.get('pill-slot-count').textContent, /4\/4/);
  assert.equal(b.get('pill-settings-rows').querySelectorAll('button').length, 25);
  for (const id of [M.DEFAULT_MAIN, 'agent_claude-desktop', 'integration_music', 'ai_google']) assert.equal(b.get('pill-toggle-' + id).disabled, true, id);
  for (const id of M.DEFAULT_DECLARED) {
    const button = b.get('pill-toggle-' + id);
    assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.ok(button.getAttribute('aria-label'));
  }
  assert.deepEqual(writes(b), []); assert.equal(b.backend.writes, 0);
  const scripts=[...read('index.html').matchAll(/src="([^"]+\.js)"/g)].map(x=>x[1]);
  assert.ok(scripts.indexOf('pills.js') < scripts.indexOf('pill-settings.js'));
  assert.ok(scripts.indexOf('pill-settings.js') < scripts.indexOf('settings.js'));
});

test('S4 actual settings can remove at capacity then add; fifth/main/unsupported additions never dispatch', async () => {
  const b = await settingsBoot(); const before = clone(b.backend.prefs);
  for (const id of ['ai_google', M.DEFAULT_MAIN, 'agent_claude-desktop', 'integration_music']) b.click('pill-toggle-' + id);
  await flush(); assert.deepEqual(writes(b), []); assert.deepEqual(b.backend.prefs, before);
  assert.equal(b.backend.writes, 0); assert.equal(b.backend.publications, 0);
  b.click('pill-toggle-integration_n8n'); await flush();
  assert.match(b.get('pill-slot-count').textContent, /3\/4/);
  b.click('pill-toggle-ai_google'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [
    { action: 'toggle_declared_pill', id: 'integration_n8n' },
    { action: 'toggle_declared_pill', id: 'ai_google' },
  ]);
  assert.deepEqual(b.backend.prefs.declaredPills, ['integration_resend', 'integration_vercel', 'integration_github', 'ai_google']);
  assert.deepEqual(b.get('pill-choices').children.map(x=>x.dataset.pillId), [M.DEFAULT_MAIN,'ai_google','integration_resend','integration_vercel','integration_github']);
  assert.equal(b.backend.writes,2); assert.equal(b.backend.publications,2);
});

test('S4 actual main change removes new-main declaration only and preserves legacy values', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: ['agent_cursor','ai_google'] } });
  b.backend.prefs.sound=true; b.backend.prefs.gain=0.2; b.backend.prefs.displayName='Ana'; b.backend.prefs.avatarColors={abito:'purple'};
  const main=b.get('pill-main-setting'); main.value='agent_cursor'; main.fire('change'); await flush();
  assert.deepEqual(writes(b).map(x=>x.payload),[{action:'set_main_pill',id:'agent_cursor'}]);
  assert.deepEqual(b.backend.prefs.declaredPills,['ai_google']); assert.equal(b.backend.prefs.mainPill,'agent_cursor');
  assert.equal(b.backend.prefs.sound,true); assert.equal(b.backend.prefs.gain,0.2);
  assert.equal(b.backend.prefs.displayName,'Ana'); assert.deepEqual(b.backend.prefs.avatarColors,{abito:'purple'});
  assert.equal(b.get('pill-name').textContent,'Cursor'); assert.equal(b.get('pill-main-setting').value,'agent_cursor');
});

test('S6 settings rejects synthetic/unknown/main-repeat/closed-panel input without writes', async () => {
  const b=await settingsBoot({prefs:{declaredPills:[]}});
  const main=b.get('pill-main-setting'); main.value='agent_cursor'; main.fire('change',{isTrusted:false});
  main.value='unknown'; main.fire('change');
  main.value=M.DEFAULT_MAIN; main.fire('change');
  b.click('pill-toggle-ai_google',{isTrusted:false});
  const old=b.get('pill-toggle-ai_google');
  b.click('settings-close'); old.fire('click'); await flush();
  assert.deepEqual(writes(b),[]); assert.equal(b.backend.writes,0); assert.equal(b.backend.publications,0);
  assert.equal(b.get('pill-name').textContent,'VS Code');
});

test('S6 failed main save keeps previous snapshot and focus; explicit retry succeeds', async () => {
  const b=await settingsBoot(); const before=clone(b.backend.prefs);
  b.backend.rejectNext=true;
  const main=b.get('pill-main-setting'); main.focus(); main.value='agent_cursor'; main.fire('change'); await flush();
  assert.deepEqual(b.backend.prefs,before); assert.equal(b.backend.writes,0); assert.equal(b.backend.publications,0);
  assert.equal(b.get('pill-main-setting').value,M.DEFAULT_MAIN);
  assert.equal(b.get('pill-name').textContent,'VS Code');
  assert.equal(b.get('pill-settings-error').textContent,'No se pudo guardar el blob; se mantuvo la elección anterior.');
  assert.equal(b.doc.activeElement.id,'pill-main-setting');
  const retry=b.get('pill-main-setting'); retry.value='agent_cursor'; retry.fire('change'); await flush();
  assert.equal(b.get('pill-settings-error').textContent,'');
  assert.equal(b.get('pill-name').textContent,'Cursor'); assert.equal(b.backend.writes,1);
});

test('S6 actual legacy sound/gain/name/avatar handlers still retain pill choices', async () => {
  const b=await settingsBoot({prefs:{mainPill:'agent_codex',declaredPills:['ai_google']}}, 'general');
  b.click('sw-sound'); await flush(); assert.equal(b.backend.prefs.sound,true);
  const gain=b.get('settings-sound-gain'); gain.value='0.2'; gain.fire('input'); gain.parentNode.fire('submit'); await flush();
  assert.equal(b.backend.prefs.gain,0.2);
  b.click('settings-tab-appearance'); await flush();
  const name=b.get('settings-display-name'); name.value='Bea'; name.fire('input'); name.parentNode.fire('submit'); await flush();
  assert.equal(b.backend.prefs.displayName,'Bea');
  b.click('dot-color-abito-blue'); await flush(); assert.equal(b.backend.prefs.avatarColors.abito,'blue');
  assert.equal(b.backend.prefs.mainPill,'agent_codex'); assert.deepEqual(b.backend.prefs.declaredPills,['ai_google']);
  assert.deepEqual(writes(b).map(x=>x.payload.action),['sound_on','set_sound_gain','set_display_name','set_avatar_color']);
  assert.equal(b.get('pill-name').textContent,'Codex');
  assert.ok(!b.get('open-screen-accounts'), '#408: no separate Cuentas/Conectores header buttons'); assert.ok(b.get('settings-tab-accounts')); assert.ok(!b.get('settings-tab-connectors'), 'S8: merged into Conexiones');
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

test('#346 Ajustes offers the closed palette plus «Sin color», writes set/clear and keeps every other preference', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: ['agent_cursor', 'ai_google'], pillColors: { agent_cursor: 'blue' } } });
  const rows = () => b.get('pill-settings-rows').children.flatMap(section => section.children).filter(n => n.dataset.pillId);
  const row = id => rows().find(n => n.dataset.pillId === id);
  const pick = b.get('pill-color-agent_cursor');
  assert.ok(pick, 'an offered pill row has a colour control');
  assert.deepEqual(pick.children.map(x => x.value), ['', 'green', 'blue', 'mint', 'orange', 'purple'], 'closed set + selectable «Sin color»');
  assert.deepEqual(pick.children.map(x => x.textContent), ['Sin color', 'Verde', 'Azul', 'Menta', 'Naranja', 'Púrpura']);
  assert.equal(pick.value, 'blue', 'the stored colour is the selected option');
  assert.equal(row('agent_cursor').dataset.color, 'blue', 'the row wears the validated name');
  assert.equal(b.get('pill-color-integration_music'), null, 'a refused pill never gets a colour control');
  assert.equal(b.get('pill-color-agent_claude-desktop'), null, 'an unsupported-on-this-host pill never gets a colour control');
  b.backend.prefs.sound = true; b.backend.prefs.gain = 0.2; b.backend.prefs.displayName = 'Ana'; b.backend.prefs.avatarColors = { abito: 'purple' };
  pick.value = 'mint'; pick.fire('change'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_pill_color', id: 'agent_cursor', color: 'mint' }]);
  assert.equal(b.backend.prefs.pillColors.agent_cursor, 'mint');
  assert.equal(row('agent_cursor').dataset.color, 'mint', 'the row repaints from the saved projection');
  assert.equal(b.backend.prefs.sound, true); assert.equal(b.backend.prefs.gain, 0.2);
  assert.equal(b.backend.prefs.displayName, 'Ana');
  assert.deepEqual(b.backend.prefs.avatarColors, { abito: 'purple' });
  assert.deepEqual(b.backend.prefs.declaredPills, ['agent_cursor', 'ai_google'], 'the catalogue is untouched');
  // «Sin color» is selectable: it sends the closed clear and the row goes neutral.
  const current = b.get('pill-color-agent_cursor');
  current.value = ''; current.fire('change'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [
    { action: 'set_pill_color', id: 'agent_cursor', color: 'mint' },
    { action: 'clear_pill_color', id: 'agent_cursor' },
  ]);
  assert.equal(b.backend.prefs.pillColors.agent_cursor, undefined, 'the projection carries no colour after clear');
  assert.equal(row('agent_cursor').dataset.color, undefined, 'the chip is neutral after clear');
  assert.equal(b.get('pill-color-agent_cursor').value, '', 'the control reads back neutral');
  assert.equal(b.backend.prefs.sound, true, 'clear touches nothing else');
});
