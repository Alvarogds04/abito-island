'use strict';
/* F017 RED test — event/result card view-model + spec renderer
   (frontend/event-views.js). LOGIC ONLY follows Coucou's MIT
   windows/src/views/views.ts:650-727 (commit
   71b773f08101237e1ec950efdaee17a626c830e6): four distinct event cards
   (error / finished / confused / note) each with who, title, detail and a
   closed action row. The tone/word/icon mapping follows Abito's own
   docs/desktop-visual-language.md §1.1/§3/§6 (lime NEVER means "someone
   finished"; finished is never a check). Spanish voseo copy. Run: node
   test-node/event-views-check.cjs (exit 0 = pass). */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const E = require(path.join(__dirname, '..', 'frontend', 'event-views.js'));

let n = 0;
const ok = name => { n++; console.log(`ok ${n} - ${name}`); };
const text = spec => (spec.text || '') + (spec.children || []).map(text).join('');
const byClass = (spec, cls) => {
  const found = [];
  const walk = s => {
    if (String(s.class || '').split(' ').includes(cls)) found.push(s);
    for (const c of s.children || []) walk(c);
  };
  walk(spec);
  return found;
};

// ---- surface -----------------------------------------------------------------
for (const fn of ['eventCardView', 'eventCardSpec', 'apply', 'sampleEvents']) {
  assert.equal(typeof E[fn], 'function', `exports ${fn}`);
}
ok('exports the closed API');

// ---- closed vocabulary ----------------------------------------------------------
for (const kind of ['error', 'finished', 'confused', 'note']) {
  const v = E.eventCardView({ kind });
  assert.ok(v && v.kind === kind, `${kind} is a known card`);
}
for (const bad of ['success', 'party', '', null, undefined, 42, 'ERROR']) {
  assert.equal(E.eventCardView({ kind: bad }), null, `unknown kind ${JSON.stringify(bad)} is refused`);
}
ok('closed vocabulary: error/finished/confused/note only');

// ---- error card: honest failure, never hidden -------------------------------------
{
  const v = E.eventCardView({ kind: 'error', who: 'Pi', detail: 'cargo build falló' });
  assert.equal(v.tone, 'red', 'error is red');
  assert.equal(v.icon, 'triangle', 'triangle shape accompanies the colour (C5)');
  assert.equal(v.word, 'Error', 'the word stays visible (§3)');
  assert.ok(v.title, 'error has a default title');
  assert.equal(v.detail, 'cargo build falló', 'detail is shown verbatim');
  const labels = v.actions.map(a => a.label);
  assert.ok(labels.includes('Reintentar'), 'retry is offered');
  assert.ok(v.actions.every(a => a.kind === 'primary' || a.kind === 'secondary'), 'closed action kinds');
  ok('error card is honest, red + triangle + word');
}

// ---- finished card: never a check, never lime (§1.1/§6) -----------------------------
{
  const v = E.eventCardView({ kind: 'finished', who: 'Pi', title: 'Corrí los tests' });
  assert.notEqual(v.tone, 'go', 'lime never means "someone finished"');
  assert.notEqual(v.icon, 'check', 'finished never shows a check');
  assert.equal(v.word, 'Pi terminó', 'the Sileo word is said');
  assert.equal(v.title, 'Corrí los tests', 'the final line is the title');
  assert.ok(v.actions.some(a => a.id === 'dismiss'), 'a dismiss action exists');
  ok('finished card is neutral: no check, no lime');
}

// ---- confused card: self-recovering wait --------------------------------------------
{
  const v = E.eventCardView({ kind: 'confused' });
  assert.equal(v.tone, 'sun', 'confused is the pending/wait tone');
  assert.ok(v.title && v.aria, 'title and aria present');
  assert.deepEqual(v.actions, [], 'confused offers no actions');
  ok('confused card is a wait notice without actions');
}

// ---- note card: message only ----------------------------------------------------------
{
  const v = E.eventCardView({ kind: 'note', title: 'Guardé la nota' });
  assert.equal(v.tone, 'neutral');
  assert.equal(v.title, 'Guardé la nota');
  assert.deepEqual(v.actions, []);
  assert.equal(E.eventCardView({ kind: 'note' }).title, '', 'a note without text shows nothing invented');
  ok('note card carries only its message');
}

// ---- junk input never throws -----------------------------------------------------------
for (const junk of [null, undefined, 7, 'x', {}, { kind: 'error', who: 42 }, { kind: 'error', detail: {} }]) {
  assert.doesNotThrow(() => E.eventCardView(junk));
}
assert.equal(E.eventCardView(null), null);
ok('junk input yields null and never throws');

// ---- spec renderer -----------------------------------------------------------------------
{
  const v = E.eventCardView({ kind: 'error', who: 'Pi', detail: 'falló' });
  const spec = E.eventCardSpec(v, { retry() {}, open() {}, dismiss() {} });
  assert.equal(spec.tag, 'div');
  assert.ok(String(spec.class).includes('event-card'), 'card class present');
  assert.ok(String(spec.class).includes('red') || String(spec.class).includes('tone-red'), 'tone as class');
  assert.ok(text(spec).includes('Error'), 'word visible');
  assert.ok(text(spec).includes('falló'), 'detail verbatim');
  const buttons = byClass(spec, 'event-action');
  assert.equal(buttons.length, v.actions.length, 'one button per action, only with hooks');
  assert.ok(buttons.every(b => b.tag === 'button'), 'actions are real buttons');
  // no hooks → no dead buttons
  const bare = E.eventCardSpec(v, {});
  assert.equal(byClass(bare, 'event-action').length, 0, 'no hooks → no action buttons');
  ok('spec renderer produces a complete card gated by hooks');
}

// ---- the future mount walks specs with textContent only -------------------------------------
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'event-views.js'), 'utf8');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    'no markup sink in the event renderer');
  for (const s of E.sampleEvents()) {
    const v = E.eventCardView(s);
    assert.ok(v, `sample ${s.kind} is valid`);
    const spec = E.eventCardSpec(v, {});
    assert.ok(spec && text(spec).length > 0, `sample ${s.kind} renders text`);
  }
  assert.ok(E.sampleEvents().length >= 4, 'one fake sample per kind');
  ok('static samples cover all four cards; no markup sink');
}

console.log(`\n${n} checks passed`);
