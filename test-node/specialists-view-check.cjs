'use strict';
/* #327 — pure checks for frontend/specialists-view.js (the specialists section's view-model).
   No DOM, no IPC, no network, no colour. Contracts:
   - id is opaque, lowercase ASCII, ^[a-z0-9][a-z0-9._-]{0,31}$ and never one of the reserved
     identities (the principal `abito`, the engine CLIs), so a rename can never move it;
   - the identity shape is the one the avatar panel (#384) consumes by the SAME id: this module
     carries NO colour logic at all (avatar_colors owns assignment and overrides);
   - name 1..40 and instructions 1..2000, multiline allowed, dangerous control characters not;
   - invalid input never mutates and is never rendered as a trusted row.
   Run: node apps/desktop-tauri/test-node/specialists-view-check.cjs (also under cargo test). */
const assert = require('node:assert/strict');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const S = require(path.join(frontend, 'specialists-view.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

// ---- identity: opaque, stable, format-compatible with avatar-colors (#384) -------------------------
test('an id is opaque lowercase ASCII, never derived from the visible name, and compatible with the avatar contract', () => {
  const id = S.newId(Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]));
  assert.equal(id, 'esp-0011223344556677');
  assert.match(id, S.ID_RE);
  assert.ok(S.validId(id));
  // the same bytes always give the same id (no name, no clock, no counter in it)
  assert.equal(S.newId(Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])), id);
  const other = S.newId(Uint8Array.from([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]));
  assert.notEqual(other, id);
  assert.match(other, S.ID_RE);
  assert.equal(id.length <= 32, true, 'the avatar contract caps the id at 32 characters');
});

test('the reserved identities of the avatar contract are refused: the principal and the engine CLIs', () => {
  for (const bad of ['abito', 'pi', 'claude-code', 'codex', 'opencode', '__proto__', 'prototype', 'constructor']) {
    assert.equal(S.validId(bad), false, `${bad} must never be a specialist id`);
  }
  for (const bad of ['', 'A', 'Esp-x', 'esp x', '-esp', '.esp', '_esp', 'esp.'.repeat(9), 42, null, undefined, {}, 'esp-0011223344556677 '.repeat(1) + 'x'.repeat(20)]) {
    assert.equal(S.validId(bad), false, `${JSON.stringify(bad)} must not be a valid id`);
  }
  assert.equal(S.validId('esp-0011223344556677'), true);
  assert.equal(S.validId('a'), true, 'one character is allowed by the contract');
  assert.equal(S.validId('a'.repeat(32)), true);
  assert.equal(S.validId('a'.repeat(33)), false, '33 characters break the avatar contract');
});

test('this module carries no colour logic: avatar_colors (#384) owns assignment and overrides', () => {
  for (const forbidden of ['COLORS', 'colorFor', 'defaultColor', 'colorOf', 'avatarColor', 'defaultsFor']) {
    assert.equal(S[forbidden], undefined, `${forbidden} must live in #384, not here`);
  }
  assert.equal(/green|mint|orange|purple|fnv/i.test(require('node:fs').readFileSync(path.join(frontend, 'specialists-view.js'), 'utf8')), false,
    'no colour name and no colour algorithm may appear in this module');
});

// ---- the create/edit draft ----------------------------------------------------------------------
const model = 'local-abito-gpt';
const draft = extra => Object.assign({ name: 'Investigador', instructions: 'Buscá fuentes y citá.', model }, extra);

test('a valid draft passes; name and instructions are required, trimmed and bounded', () => {
  assert.deepEqual(S.validateDraft(draft(), [model]), { ok: true, word: '' });
  assert.equal(S.validateDraft(draft({ name: '   ' }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ name: 'x'.repeat(S.MAX_NAME + 1) }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ name: '  ' + 'x'.repeat(S.MAX_NAME) + '  ' }), [model]).ok, true, 'the limit is on the trimmed name');
  assert.equal(S.validateDraft(draft({ instructions: '' }), [model]).ok, false, 'a specialist without a specialty is nothing');
  assert.equal(S.validateDraft(draft({ instructions: '   ' }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: 'x'.repeat(S.MAX_INSTRUCTIONS + 1) }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: 'x'.repeat(S.MAX_INSTRUCTIONS) }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ name: 42 }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: null }), [model]).ok, false);
  assert.deepEqual(S.validateDraft(null, [model]).ok, false);
  const bad = S.validateDraft(draft({ name: '' }), [model]);
  assert.equal(bad.field, 'name', 'the failing field is named so the page can point at it');
  assert.ok(bad.word.length > 0);
});

test('multiline instructions are fine; dangerous control characters are not', () => {
  assert.equal(S.validateDraft(draft({ instructions: 'Primero leé.\nDespués resumí.\n\tCon sangría.' }), [model]).ok, true);
  for (const bad of ['nulo\u0000', 'campana\u0007', 'escape\u001b', 'vertical\u000b', 'del\u007f', 'c1\u009f', 'cr\u000d']) {
    assert.equal(S.validateDraft(draft({ instructions: bad }), [model]).ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(S.validateDraft(draft({ name: bad }), [model]).ok, false, `${JSON.stringify(bad)} must be refused in the name too`);
  }
});

test('the model must be null (the picker decides) or one of the verified local profiles', () => {
  assert.equal(S.validateDraft(draft({ model: null }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ model: '' }), [model]).ok, true, 'empty = the same as null');
  assert.equal(S.validateDraft(draft({ model: 'nube-gpt' }), [model]).ok, false, 'no invented model');
  assert.equal(S.validateDraft(draft({ model: 'nube-gpt' }), [model]).field, 'model');
  assert.equal(S.validateDraft(draft({ model: 7 }), [model]).ok, false);
});

// ---- the section view ---------------------------------------------------------------------------
const state = extra => Object.assign({
  v: 1, active: null, persisted: true,
  specialists: [
    { id: 'esp-0011223344556677', name: 'Investigador', instructions: 'Buscá fuentes y citá.', model: 'local-abito-gpt' },
    { id: 'esp-8899aabbccddeeff', name: 'Editor', instructions: 'Corregí sin cambiar el sentido.', model: null },
  ],
}, extra || {});
const listing = {
  selected: 'local-abito-gpt',
  profiles: [
    { profile_id: 'local-abito-gpt', alias: 'Abito-gpt', selectable: true, gate: { state: 'ready' } },
    { profile_id: null, alias: 'otro-alias', selectable: false, gate: { state: 'unavailable' } },
  ],
};

test('no state yet is a wait, never an empty store', () => {
  assert.equal(S.storeView(null, listing).kind, 'loading');
  assert.equal(S.storeView(undefined, listing).kind, 'loading');
  assert.equal(S.storeView(null, listing).rows.length, 0);
});

test('with no active specialist the section says the principal is in charge', () => {
  const v = S.storeView(state(), listing);
  assert.equal(v.kind, 'ready');
  assert.equal(v.active, null);
  assert.equal(v.principal, true);
  assert.equal(v.countWord, '2 especialistas');
  assert.deepEqual(v.rows.map(r => r.name), ['Investigador', 'Editor']);
  assert.deepEqual(v.rows.map(r => r.active), [false, false]);
  assert.equal(S.roleChip(state()), null, 'the principal shows no role chip');
  assert.match(S.storeView(state(), listing).principalNote, /Abito/i);
});

test('the active specialist is marked, named by its id, and shown in the chat chip', () => {
  const v = S.storeView(state({ active: 'esp-8899aabbccddeeff' }), listing);
  assert.equal(v.active.id, 'esp-8899aabbccddeeff');
  assert.deepEqual(v.rows.map(r => r.active), [false, true]);
  assert.equal(v.principal, false);
  const chip = S.roleChip(state({ active: 'esp-8899aabbccddeeff' }));
  assert.equal(chip.word, 'Editor');
  assert.match(chip.aria, /Editor/);
  assert.equal(S.roleChip({ v: 1, active: 'esp-0000000000000000', specialists: [] }), null, 'an active id with no record is no role');
});

test('each row says which model it uses, and an unverified model is never called ready', () => {
  const v = S.storeView(state(), listing);
  assert.equal(v.rows[0].modelLabel, 'Abito-gpt');
  assert.equal(v.rows[1].modelLabel, 'El modelo elegido en «Modelo»', 'a null model follows the picker');
  const gone = S.storeView(state({ specialists: [{ id: 'esp-0011223344556677', name: 'Viejo', instructions: 'x', model: 'ya-no-existe' }] }), listing);
  assert.match(gone.rows[0].modelLabel, /no está|no disponible/i);
  assert.equal(gone.rows[0].modelReady, false);
});

test('invalid records are dropped from the view and never shown as a trusted row', () => {
  const dirty = state({ active: 'abito', specialists: [
    { id: 'abito', name: 'Principal falso', instructions: 'x', model: null },
    { id: 'ESP-MAYUS', name: 'Mayúsculas', instructions: 'x', model: null },
    { id: 'esp-0011223344556677', name: '  ', instructions: 'x', model: null },
    { id: 'esp-8899aabbccddeeff', name: 'Editor', instructions: 'x'.repeat(5000), model: null },
    { id: 'esp-ffeeddccbbaa9988', name: 'Válido', instructions: 'ok', model: null },
    { id: 'esp-ffeeddccbbaa9988', name: 'Duplicado', instructions: 'ok', model: null },
  ] });
  const v = S.storeView(dirty, listing);
  assert.deepEqual(v.rows.map(r => r.name), ['Válido'], 'duplicates and invalid records are filtered');
  assert.equal(v.active, null, 'a reserved or unknown active id is not a role');
  assert.equal(v.countWord, '1 especialista');
});

test('the real local-model limitation is stated, never hidden, and no model is invented', () => {
  const opts = S.modelOptions(listing, 'local-abito-gpt');
  assert.deepEqual(opts.map(o => o.id), [null, 'local-abito-gpt'], 'only the verified selectable profile, plus «the picker decides»');
  assert.equal(opts[1].label, 'Abito-gpt');
  assert.equal(opts[1].selected, true);
  assert.equal(opts[0].selected, false);
  const one = S.modelOptions(listing, null);
  assert.equal(one[0].selected, true);
  assert.match(S.catalogNote(listing), /un solo modelo/i);
  const none = S.catalogNote({ selected: null, profiles: [{ profile_id: null, alias: 'x', selectable: false }] });
  assert.match(none, /ningún modelo/i);
  assert.match(S.catalogNote(listing), /local/i, 'the note says the models are local');
});

test('the count word is singular, plural and honest about zero', () => {
  assert.equal(S.storeView(state({ specialists: [] }), listing).countWord, 'Sin especialistas');
  assert.equal(S.storeView(state({ specialists: [state().specialists[0]] }), listing).countWord, '1 especialista');
  assert.equal(S.storeView(state(), listing).countWord, '2 especialistas');
});

test('a store saved in memory only says so: the panel never claims persistence it does not have', () => {
  assert.equal(S.storeView(state({ persisted: false }), listing).persistenceNote.length > 0, true);
  assert.match(S.storeView(state({ persisted: false }), listing).persistenceNote, /no se guard/i);
  assert.equal(S.storeView(state({ persisted: true }), listing).persistenceNote, '');
});


// ---- the create/edit form state machine (#327 frontend fix) ----------------------------------------
test('Crear starts disabled and is revalidated on EVERY input, without waiting for a re-render', () => {
  const f = S.makeForm();
  f.openNew();
  assert.equal(f.status([model]).canSave, false, 'an empty form cannot be saved');
  f.input('name', 'Investigador');
  assert.equal(f.status([model]).canSave, false, 'a name alone is not a specialist');
  f.input('instructions', 'Buscá fuentes y citá.');
  assert.equal(f.status([model]).canSave, true, 'typing the specialty enables Crear at once');
  f.input('name', '   ');
  const s = f.status([model]);
  assert.equal(s.canSave, false);
  assert.equal(s.field, 'name', 'the failing field is named');
  assert.ok(s.word.length > 0);
});

test('a problem is only shown once the human has typed something (no scolding an empty form)', () => {
  const f = S.makeForm();
  f.openNew();
  assert.equal(f.status([model]).showProblem, false);
  f.input('name', 'x');
  assert.equal(f.status([model]).showProblem, true);
});

test('saving keeps the form and the draft until the backend CONFIRMS; a failure keeps the edit', () => {
  const f = S.makeForm();
  f.openNew();
  f.input('name', 'Investigador');
  f.input('instructions', 'Buscá fuentes\ny citá.');
  const sent = f.submit([model]);
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.draft, { name: 'Investigador', instructions: 'Buscá fuentes\ny citá.', model: null });
  assert.equal(f.state.open, true, 'the form does not close when the click is sent');
  assert.equal(f.state.pending, true);
  assert.equal(f.submit([model]).ok, false, 'a second click while pending sends nothing');
  f.settle(false, 'No se pudo guardar el especialista; no se cambió nada.');
  assert.equal(f.state.open, true, 'a failed save leaves the form open');
  assert.equal(f.state.pending, false, 'and lets the human retry');
  assert.equal(f.state.draft.name, 'Investigador', 'the name survives the failure');
  assert.equal(f.state.draft.instructions, 'Buscá fuentes\ny citá.', 'the specialty survives the failure');
  assert.match(f.state.error, /no se cambió nada/);
  assert.equal(f.status([model]).canSave, true, 'retry is possible');
  f.submit([model]);
  f.settle(true, '');
  assert.equal(f.state.open, false, 'only a confirmed save closes the form');
  assert.equal(f.state.draft.name, '', 'and only then is the draft cleared');
  assert.equal(f.state.error, '');
});

test('editing carries the id; cancel discards; an invalid draft is never sent', () => {
  const f = S.makeForm();
  f.openEdit({ id: 'esp-0011223344556677', name: 'Editor', instructions: 'Corregí.', model: null });
  assert.equal(f.state.editing, 'esp-0011223344556677');
  assert.equal(f.submit([model]).editing, 'esp-0011223344556677', 'an edit never mints a new id');
  f.settle(false, 'x');
  f.input('instructions', '');
  assert.equal(f.submit([model]).ok, false, 'an invalid draft is not sent');
  assert.equal(f.state.pending, false);
  f.cancel();
  assert.equal(f.state.open, false);
  assert.equal(f.state.editing, null);
  assert.equal(f.state.draft.name, '');
});

// ---- explicit selection: a radiogroup with the principal first ---------------------------------------
test('the role choice is a radiogroup: Abito (principal) first, exactly one checked, active:null = principal', () => {
  const none = S.roleChoices(S.storeView(state(), listing));
  assert.deepEqual(none.map(r => r.id), [null, 'esp-0011223344556677', 'esp-8899aabbccddeeff']);
  assert.deepEqual(none.map(r => r.checked), [true, false, false]);
  assert.equal(none[0].label, 'Abito');
  assert.equal(none[0].principal, true);
  const second = S.roleChoices(S.storeView(state({ active: 'esp-8899aabbccddeeff' }), listing));
  assert.deepEqual(second.map(r => r.checked), [false, false, true]);
  assert.equal(second.filter(r => r.checked).length, 1);
  assert.match(second[2].aria, /Editor/);
  const empty = S.roleChoices(S.storeView(state({ specialists: [] }), listing));
  assert.deepEqual(empty.map(r => r.id), [null], 'with no specialists only the principal is offered');
});

test('load_error is unavailable, never healthy empty or principal success', () => {
  for (const specialists of [[], state().specialists]) {
    const failed = state({ load_error: true, persisted: false, specialists });
    const view = S.storeView(failed, listing);
    assert.equal(view.kind, 'unavailable');
    assert.equal(view.principal, false);
    assert.equal(view.countWord, '');
    assert.deepEqual(view.rows, []);
    assert.deepEqual(S.roleChoices(view), []);
    assert.match(view.persistenceNote, /No se pudieron cargar/);
    assert.equal(S.roleChip(failed), null);
  }
});

test('keyboard target supports arrows, wrapping, Home and End without synthetic clicks', () => {
  const choices = S.roleChoices(S.storeView(state(), listing));
  for (const [at, key, expected] of [[0,'ArrowDown',1],[1,'ArrowRight',2],[0,'ArrowUp',2],
    [2,'ArrowLeft',1],[2,'ArrowDown',0],[2,'Home',0],[0,'End',2]]) {
    assert.equal(S.roleKeyIndex(key, at, choices.length), expected);
  }
  assert.equal(S.roleKeyIndex('x', 0, 3), -1);
  assert.equal(S.roleKeyIndex('Home', 0, 0), -1);
});

console.log(`specialists-view-check: ${passed} passed`);
