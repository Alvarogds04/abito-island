'use strict';
// #435 T6.4 — the Blobs visual customizer (design page «3 Blobs», blobs-{default,create,
// delete,full,drag}-{dark,light}.png). The renderer is pill-settings.js; these checks
// cover its PUBLIC surface only: the rendered tree and the closed commands it dispatches.
// Local fake DOM, no IPC, no network. Run: node apps/desktop-tauri/test-node/blobs-check.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const frontend = path.join(__dirname, '../frontend');

// A minimal DOM: textContent composition, append, attributes, dataset, listeners.
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.className = '';
    this.dataset = {}; this.attrs = {}; this.handlers = {}; this.value = '';
    this.disabled = false; this.id = ''; this.htmlFor = ''; this.hidden = false;
    this.placeholder = ''; this.title = ''; this.type = ''; this.parentNode = null;
  }
  set textContent(text) { this.children = []; if (text) this.children.push(String(text)); }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  append(...items) { for (const item of items) { this.children.push(item); item.parentNode = this; } }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn); }
  focus() {}
  // A trusted gesture by default; pass { isTrusted: false } for the synthetic cases.
  fire(type, extra = {}) {
    const event = { type, target: this, isTrusted: true, key: '', preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.handlers[type] || []) fn(event);
  }
}
const doc = { createElement: tag => new Node(tag) };

const walk = (node, visit) => {
  visit(node);
  for (const child of node.children) if (typeof child !== 'string') walk(child, visit);
};
const byId = (root, id) => { let hit = null; walk(root, n => { if (n.id === id) hit = n; }); return hit; };
const byClass = (root, cls) => { const hits = []; walk(root, n => { if (String(n.className).split(/\s+/).includes(cls)) hits.push(n); }); return hits; };
const words = root => {
  const texts = [], arias = [];
  walk(root, n => {
    if (n.textContent) texts.push(n.textContent);
    if (n.attrs['aria-label']) arias.push(n.attrs['aria-label']);
  });
  return [...texts, ...arias].join('\n');
};

const C = require(path.join(frontend, 'pill-catalog.js'));
const A = require(path.join(frontend, 'avatar-colors.js'));
const P = require(path.join(frontend, 'pills.js'));
global.window = { AbitoAvatarColors: A, AbitoPillCatalog: C, AbitoPills: P };
const settings = global.window.AbitoPillSettings =
  (() => { require(path.join(frontend, 'pill-settings.js')); return global.window.AbitoPillSettings; })();

// The default main plus three declared pills, one carrying a palette colour: the
// designed default state (3/4 declared, the «Nuevo» slot present).
const THREE = { mainPill: 'integration_claude', declaredPills: ['integration_resend', 'integration_n8n', 'integration_vercel'], pillColors: { integration_resend: 'mint' } };
const FOUR = { mainPill: 'integration_claude', declaredPills: ['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github'] };

function boot(raw, extra = {}) {
  const commands = [];
  let prefs = P.normalize(raw);
  const host = new Node('div');
  host.ownerDocument = doc;
  const options = { saving: false, error: '', putIcon: () => {},
    onCommand(payload) {
      commands.push(payload);
      // The host (settings.js) applies the closed command and re-renders with the
      // saved truth; the harness mirrors exactly that so the renderer is exercised
      // against updated state, never against a stale snapshot.
      const next = payload.action === 'set_pill_color' ? P.setColor(prefs, payload.id, payload.color)
        : payload.action === 'clear_pill_color' ? P.clearColor(prefs, payload.id)
        : payload.action === 'set_blob_color' ? P.setBlobColor(prefs, payload.name, payload.color)
        : payload.action === 'create_blob' ? P.createBlob(prefs, payload.name, payload.color || '')
        : payload.action === 'delete_blob' ? P.deleteBlob(prefs, payload.name)
        : payload.action === 'toggle_declared_pill' ? P.toggle(prefs, payload.id)
        : payload.action === 'set_main_pill' ? P.chooseMain(prefs, payload.id)
        : payload.action === 'reorder_declared_pills' ? P.reorderDeclared(prefs, payload.order)
        : payload.action === 'reorder_blobs' ? P.reorderBlobs(prefs, payload.order) : null;
      if (next) prefs = { ...prefs, ...next };
      settings.render(host, prefs, options);
    }, ...extra };
  settings.render(host, prefs, options);
  return { host, commands, options, rerender: () => settings.render(host, prefs, options) };
}

test('S1 default state: principal card with the island chip, declared tiles with live blobs, the new slot, the island strip and the editor on the first tile', () => {
  const { host } = boot(THREE);
  // The principal card: the main pill, always on the island, with the ONLY disclaimer
  // left on the screen as its chip tooltip.
  const principal = byId(host, 'pill-principal-card');
  assert.ok(principal, 'the principal card exists');
  assert.equal(principal.dataset.pillId, 'integration_claude');
  assert.match(words(principal), /VS Code/, 'the principal card names the main pill');
  assert.match(words(principal), /Siempre en la isla/, 'the island chip is there');
  assert.match(words(principal), /Elegir un blob no conecta el servicio/, 'the only disclaimer rides on the chip');
  // Declared tiles: live blobs (data-colour) + names, and the «Nuevo» slot at 3/4.
  const grid = byId(host, 'pill-declared-grid');
  assert.ok(grid, 'the declared grid exists');
  const tiles = byClass(grid, 'pill-tile');
  assert.equal(tiles.length, 3, 'three declared tiles');
  assert.equal(tiles[0].dataset.pillId, 'integration_resend');
  assert.equal(tiles[0].dataset.color, 'mint', 'a stored palette colour paints the live blob');
  assert.ok(byId(host, 'pill-tile-new'), 'the empty «Nuevo» slot is present at 3/4');
  assert.equal(byId(host, 'pill-slot-count').textContent, '3/4');
  // The island strip mirrors the island: principal + declared in island order.
  const strip = byId(host, 'pill-island-strip');
  assert.ok(strip, 'the island strip exists');
  const items = byClass(strip, 'pill-strip-item');
  assert.deepEqual(items.map(x => x.textContent.trim()), ['VS Code', 'Resend', 'n8n', 'Vercel'],
    'principal + the three declared tiles, the four the island shows');
  assert.equal(byClass(strip, 'pill-strip-item')[1].dataset.color, 'mint', 'the strip paints the stored colour');
  // The editor opens on the first declared tile: read-only name, closed swatches, arrows, principal, delete.
  const name = byId(host, 'pill-editor-name');
  assert.ok(name, 'the editor name field exists');
  assert.equal(name.value, 'Resend');
  assert.ok(name.disabled, 'existing names are read-only (no rename command)');
  const swatches = byClass(host, 'swatch');
  assert.equal(swatches.length, 5, 'the closed five-colour swatch row');
  assert.equal(swatches.filter(x => x.getAttribute('aria-checked') === 'true').length, 1, 'exactly one selected swatch');
  assert.ok(byId(host, 'pill-editor-left') && byId(host, 'pill-editor-right'), 'the order arrows exist');
  assert.ok(byId(host, 'pill-editor-main'), 'the «Principal» button exists');
  assert.ok(byId(host, 'pill-editor-delete'), 'the delete button exists');
});

test('S2 create state (Propio): Crear stays disabled until a name exists; the closed model gates dispatch', () => {
  const { host, commands } = boot(THREE);
  byId(host, 'pill-tile-new').fire('click');
  assert.equal(byId(host, 'create-kind-catalog').getAttribute('aria-pressed'), 'true', 'the chooser opens on Del catálogo (the designed default)');
  byId(host, 'create-kind-custom').fire('click');
  assert.equal(byId(host, 'create-kind-custom').getAttribute('aria-pressed'), 'true', 'Propio is selectable');
  const preview = byClass(host, 'blob-preview')[0];
  assert.ok(preview, 'the large preview exists');
  assert.equal(preview.dataset.color, undefined, 'a new blob has no colour yet');
  const input = byId(host, 'blob-create-input');
  assert.ok(input, 'the create name field exists');
  assert.equal(input.placeholder, 'Nombre del blob');
  assert.equal(input.maxLength, P.MAX_BLOB_NAME);
  const create = byId(host, 'blob-create-button');
  assert.ok(create.disabled, 'Crear is disabled without a name');
  input.value = '   '; input.fire('input');
  assert.ok(byId(host, 'blob-create-button').disabled, 'a blank name never enables Crear');
  input.value = 'Notas'; input.fire('input');
  assert.ok(byId(host, 'blob-create-button').disabled, 'a name alone is not enough (§4.1: name + colour)');
  byClass(host, 'swatch').find(x => x.dataset.color === 'green').fire('click');
  // the swatch re-renders the panel: re-find the button (fresh nodes, like S5's rows)
  const ready = byId(host, 'blob-create-button');
  assert.ok(!ready.disabled, 'name + colour enables Crear');
  ready.fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'a synthetic gesture never dispatches');
  ready.fire('click');
  assert.deepEqual(commands, [{ action: 'create_blob', name: 'Notas', color: 'green' }],
    'the create command goes through the closed gate with the picked colour (§4.1)');
  assert.ok(byId(host, 'blob-create-input') === null, 'the create form is gone after creating');
  // a duplicate of an existing created blob is refused by the model (case-insensitive)
  byId(host, 'pill-tile-new').fire('click');
  byId(host, 'create-kind-custom').fire('click');
  const again = byId(host, 'blob-create-input');
  again.value = 'notas'; again.fire('input');
  byId(host, 'blob-create-button').fire('click');
  assert.equal(commands.length, 1, 'the duplicate name never dispatches');
  // Cancel returns to the editor for the selected tile
  byId(host, 'blob-create-cancel').fire('click');
  assert.ok(byId(host, 'blob-create-input') === null, 'the create form is gone');
  assert.ok(byId(host, 'pill-editor-name'), 'the editor is back');
});

test('S3 delete state: inline confirmation; declared pills quit through toggle, created blobs through delete_blob', () => {
  const { host, commands } = boot(THREE);
  byId(host, 'pill-tile-integration_resend').fire('click');
  byId(host, 'pill-editor-delete').fire('click');
  assert.match(words(host), /¿Eliminar "Resend"\?/, 'the inline confirmation names the blob');
  assert.match(words(host), /Se quita de la isla\./, 'the one-line consequence');
  byId(host, 'pill-editor-cancel-delete').fire('click');
  assert.ok(byId(host, 'pill-editor-delete'), 'cancel returns to the editor');
  byId(host, 'pill-editor-delete').fire('click');
  byId(host, 'pill-editor-confirm-delete').fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'a synthetic confirm never dispatches');
  byId(host, 'pill-editor-confirm-delete').fire('click');
  assert.deepEqual(commands, [{ action: 'toggle_declared_pill', id: 'integration_resend' }],
    'quitting a declared pill uses the existing toggle command');
  // a created blob goes through delete_blob
  const withBlob = { ...THREE, blobs: P.normalize({ customBlobs: [{ name: 'Notas' }] }).blobs };
  const b = boot(withBlob);
  const blobTile = byId(b.host, 'blob-tile-0');
  assert.ok(blobTile, 'the created blob is a tile');
  blobTile.fire('click');
  byId(b.host, 'pill-editor-delete').fire('click');
  byId(b.host, 'pill-editor-confirm-delete').fire('click');
  assert.deepEqual(b.commands, [{ action: 'delete_blob', name: 'Notas' }]);
});

test('S4 full state: 4/4 declared hides the «Nuevo» slot and shows the sun count', () => {
  const { host } = boot(FOUR);
  assert.equal(byId(host, 'pill-slot-count').textContent, '4/4');
  assert.equal(byId(host, 'pill-tile-new'), null, 'no empty slot at 4/4');
  assert.equal(byClass(byId(host, 'pill-declared-grid'), 'pill-tile').length, 4);
});

test('S5 colour swatches: set and clear through the existing closed commands only', () => {
  const { host, commands } = boot(THREE);
  byId(host, 'pill-tile-integration_n8n').fire('click');
  const row = () => byClass(host, 'swatch-row')[0]; // fresh after every re-render
  row().children.find(x => x.dataset.color === 'green').fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'synthetic gestures never dispatch');
  row().children.find(x => x.dataset.color === 'green').fire('click');
  assert.deepEqual(commands, [{ action: 'set_pill_color', id: 'integration_n8n', color: 'green' }]);
  // clicking the selected swatch again clears the colour (the reversible way back)
  row().children.find(x => x.dataset.color === 'mint').fire('click');
  assert.deepEqual(commands[1], { action: 'set_pill_color', id: 'integration_n8n', color: 'mint' });
  row().children.find(x => x.dataset.color === 'mint').fire('click');
  assert.deepEqual(commands[2], { action: 'clear_pill_color', id: 'integration_n8n' }, 're-clicking the current colour clears it');
  // keyboard: the arrows walk the closed palette and choose, like the #384 swatches
  row().children.find(x => x.dataset.color === 'green').fire('keydown', { key: 'ArrowRight' });
  assert.equal(commands[3].color, 'blue', 'ArrowRight chooses the next palette colour');
  // a created blob keeps its colour through set_blob_color, cleared with the empty string
  const withBlob = { ...THREE, blobs: P.normalize({ customBlobs: [{ name: 'Notas', color: 'purple' }] }).blobs };
  const b = boot(withBlob);
  byId(b.host, 'blob-tile-0').fire('click');
  const brow = () => byClass(b.host, 'swatch-row')[0];
  brow().children.find(x => x.dataset.color === 'green').fire('click');
  assert.deepEqual(b.commands, [{ action: 'set_blob_color', name: 'Notas', color: 'green' }]);
  brow().children.find(x => x.dataset.color === 'green').fire('click');
  assert.deepEqual(b.commands[1], { action: 'set_blob_color', name: 'Notas', color: '' }, 'the empty string clears');
});

test('S6 «Principal»: a workspace tile is promoted through set_main_pill; the main, non-workspace and created blobs cannot take it', () => {
  const state = { mainPill: 'integration_claude', declaredPills: ['agent_cursor', 'integration_resend'] };
  const { host, commands } = boot(state);
  byId(host, 'pill-tile-agent_cursor').fire('click');
  const main = byId(host, 'pill-editor-main');
  assert.ok(!main.disabled, 'a declared workspace tile can be made principal');
  main.fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'synthetic gestures never dispatch');
  main.fire('click');
  assert.deepEqual(commands, [{ action: 'set_main_pill', id: 'agent_cursor' }]);
  // the main tile's own editor cannot press it again, a service tile never (the
  // main pill is a workspace choice) and a created blob never
  const again = boot(state);
  byId(again.host, 'pill-principal-card').fire('click');
  assert.ok(byId(again.host, 'pill-editor-main').disabled, 'the principal is already the principal');
  const service = boot(state);
  byId(service.host, 'pill-tile-integration_resend').fire('click');
  assert.ok(byId(service.host, 'pill-editor-main').disabled, 'only a workspace tile can become principal');
  const withBlob = { ...state, blobs: P.normalize({ customBlobs: [{ name: 'Notas' }] }).blobs };
  const b = boot(withBlob);
  byId(b.host, 'blob-tile-0').fire('click');
  assert.ok(byId(b.host, 'pill-editor-main').disabled, 'the main pill is a workspace choice, never a created blob');
});

test('S7 order: the arrows persist a strict permutation, drag dispatches the same closed command', () => {
  const { host, commands } = boot(THREE);
  // the second declared tile moved after the third
  byId(host, 'pill-tile-integration_n8n').fire('click');
  byId(host, 'pill-editor-right').fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'synthetic gestures never dispatch');
  byId(host, 'pill-editor-right').fire('click');
  assert.deepEqual(commands, [{ action: 'reorder_declared_pills', order: ['integration_resend', 'integration_vercel', 'integration_n8n'] }]);
  // edge tiles have their outward arrow disabled
  byId(host, 'pill-tile-integration_resend').fire('click');
  assert.ok(byId(host, 'pill-editor-left').disabled, 'the first tile cannot move earlier');
  assert.ok(!byId(host, 'pill-editor-right').disabled);
  // a created blob reorders through its own closed command
  const withBlob = { ...THREE, blobs: P.normalize({ customBlobs: [{ name: 'Uno' }, { name: 'Dos' }] }).blobs };
  const b = boot(withBlob);
  byId(b.host, 'blob-tile-0').fire('click');
  byId(b.host, 'pill-editor-right').fire('click');
  assert.deepEqual(b.commands, [{ action: 'reorder_blobs', order: ['Dos', 'Uno'] }]);
  // drag: pointerdown on a tile, pointerup on another reorders by the same command
  const d = boot(THREE);
  byId(d.host, 'pill-tile-integration_n8n').fire('pointerdown');
  byId(d.host, 'pill-tile-integration_resend').fire('pointerup');
  assert.deepEqual(d.commands, [{ action: 'reorder_declared_pills', order: ['integration_n8n', 'integration_resend', 'integration_vercel'] }],
    'dropping a tile on another persists the new order');
  byId(d.host, 'pill-tile-integration_resend').fire('pointerdown');
  byId(d.host, 'pill-tile-integration_vercel').fire('pointerup', { isTrusted: false });
  assert.equal(d.commands.length, 1, 'a synthetic drop never dispatches');
});

test('S8 the customizer speaks blob, never pill, and keeps no paragraphs', () => {
  const { host } = boot(THREE);
  const joined = words(host);
  for (const word of joined.split(/\s+/)) {
    assert.doesNotMatch(word, /pill/i, `visible word must not say pill: ${word}`);
  }
  assert.equal((joined.match(/Elegir un blob no conecta el servicio/g) || []).length, 1,
    'the disclaimer appears once, as the principal chip tooltip');
  assert.equal(byClass(host, 'snote').filter(n => n.textContent).length, 0, 'no standing paragraph copy');
});

test('S9 chooser (B): Del catálogo lists offered pills with markers, never pickable for main/declared; Agregar goes through the closed toggle', () => {
  const { host, commands } = boot(THREE);
  byId(host, 'pill-tile-new').fire('click');
  const seg = byId(host, 'create-kind-catalog'), segCustom = byId(host, 'create-kind-custom');
  assert.ok(seg && segCustom, 'the segmented [Del catálogo | Propio] exists');
  assert.equal(seg.getAttribute('aria-pressed'), 'true', 'Del catálogo is the designed default');
  const search = byId(host, 'pill-catalog-search');
  assert.ok(search, 'the search field exists');
  assert.equal(search.placeholder, 'Buscar…', 'the designed placeholder');
  assert.deepEqual(byClass(host, 'pill-catalog-cat').map(x => x.textContent),
    ['Todos', 'Dónde programás', 'Agentes', 'IA', 'Servicios'], 'the category chips');
  assert.match(words(host), /Elegir no conecta la cuenta/, 'the catalog disclaimer');
  const rows = () => byClass(host, 'pill-catalog-row');
  const colourRow = rows().find(x => x.dataset.pillId === 'integration_resend');
  assert.ok(colourRow.children.some(c => String(c.className).includes('blob-visual') && c.dataset.color === 'mint'),
    'each row paints a live 20px blob in the item colour');
  const mainRow = rows().find(x => x.dataset.pillId === 'integration_claude');
  assert.ok(mainRow, 'the main pill is listed');
  assert.match(words(mainRow), /Principal/, 'the main pill wears its marker');
  assert.equal(mainRow.tagName, 'DIV', 'a marked row is not pickable');
  const declaredRow = rows().find(x => x.dataset.pillId === 'integration_resend');
  assert.match(words(declaredRow), /Ya está/, 'a declared pill wears its marker');
  const pickable = rows().filter(x => x.tagName === 'BUTTON');
  assert.ok(pickable.length > 0, 'undeclared offered pills are pickable');
  assert.ok(!pickable.some(x => ['integration_claude', ...THREE.declaredPills].includes(x.dataset.pillId)),
    'marked rows are never pickable');
  assert.ok(byId(host, 'pill-catalog-add').disabled, 'Agregar needs a selected row');
  const target = pickable.find(x => x.dataset.pillId === 'agent_cursor');
  target.fire('click');
  const chosen = byId(host, 'pill-catalog-row-agent_cursor');
  assert.equal(chosen.getAttribute('aria-pressed'), 'true', 'the selected row is pressed');
  assert.ok(chosen.children.some(c => String(c.className).includes('ico')), 'the selected row shows the check icon');
  assert.equal(byId(host, 'pill-catalog-add').disabled, false, 'a selection enables Agregar');
  byId(host, 'pill-catalog-add').fire('click', { isTrusted: false });
  assert.deepEqual(commands, [], 'a synthetic Agregar never dispatches');
  byId(host, 'pill-catalog-add').fire('click');
  assert.deepEqual(commands, [{ action: 'toggle_declared_pill', id: 'agent_cursor' }],
    'Agregar is the existing closed toggle command');
  assert.ok(byId(host, 'blob-create-input') === null, 'the chooser is gone after adding');
  const name = byId(host, 'pill-editor-name');
  assert.ok(name, 'the editor is back');
  assert.equal(name.value, 'Cursor', 'Agregar selects the new tile');
});

test('S9 chooser (B): search and category chips filter the offered list; Cancelar returns without dispatch', () => {
  const { host, commands } = boot(THREE);
  byId(host, 'pill-tile-new').fire('click');
  const search = byId(host, 'pill-catalog-search');
  search.value = 'github'; search.fire('input');
  assert.deepEqual(byClass(host, 'pill-catalog-row').filter(x => x.tagName === 'BUTTON').map(x => x.dataset.pillId),
    ['integration_github'], 'the search filters by name');
  search.value = 'zzzz'; search.fire('input');
  assert.match(words(host), /Sin resultados/, 'an empty search says so in one line');
  search.value = 'GITHUB'; search.fire('input');
  assert.deepEqual(byClass(host, 'pill-catalog-row').filter(x => x.tagName === 'BUTTON').map(x => x.dataset.pillId),
    ['integration_github'], 'the filter is case-insensitive');
  search.value = ''; search.fire('input');
  byClass(host, 'pill-catalog-cat').find(x => x.textContent === 'Agentes').fire('click');
  const agentRows = byClass(host, 'pill-catalog-row').filter(x => x.tagName === 'BUTTON');
  assert.ok(agentRows.length > 0 && agentRows.every(x => C.definition(x.dataset.pillId).category === 'agent'),
    'the category chip filters');
  byClass(host, 'pill-catalog-cat').find(x => x.textContent === 'Todos').fire('click');
  assert.ok(byClass(host, 'pill-catalog-row').filter(x => x.tagName === 'BUTTON').length > agentRows.length,
    'Todos restores the whole list');
  byId(host, 'pill-catalog-cancel').fire('click');
  assert.ok(byId(host, 'blob-create-input') === null, 'the chooser is gone');
  assert.ok(byId(host, 'pill-editor-name'), 'the editor is back');
  assert.deepEqual(commands, [], 'cancel never dispatches');
});
