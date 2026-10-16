'use strict';
/* F018 RED test — pure diff-card spec renderer (frontend/diff-views.js).
   The renderer produces a closed node-spec tree; the future mount point walks
   it with createElement + textContent ONLY (no innerHTML, ever). Layout logic
   follows Coucou's MIT windows/src/views/diff.ts:18-60 (commit
   71b773f08101237e1ec950efdaee17a626c830e6) as logic only: head with back /
   counts / open, line rows with symbol + text, and the too-large / no-changes
   notes. Classes, names and Spanish (voseo) copy are Abito's own. Run: node
   test-node/diff-views-check.cjs (exit 0 = pass). */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const M = require(path.join(__dirname, '..', 'frontend', 'diff-model.js'));
const V = require(path.join(__dirname, '..', 'frontend', 'diff-views.js'));

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

// ---- surface ----------------------------------------------------------------
assert.equal(typeof V.diffCardSpec, 'function');
assert.equal(typeof V.apply, 'function');
ok('exports diffCardSpec and apply');

// ---- head: back, filename, honest counts, open -------------------------------
{
  const d = M.fromEdit('a\nb\nc\n', 'a\nX\nc\n', 'src/f.txt');
  const spec = V.diffCardSpec(d, { dismiss() {}, open() {} });
  assert.equal(spec.tag, 'div');
  assert.ok(String(spec.class).includes('diff-card'));
  const back = byClass(spec, 'diff-back');
  assert.equal(back.length, 1, 'exactly one back control');
  assert.equal(back[0].tag, 'button');
  assert.equal(back[0].aria, 'Volver');
  assert.ok(text(spec).includes('f.txt'), 'head shows the file name, not the whole path');
  const plus = byClass(spec, 'diff-count-plus');
  const minus = byClass(spec, 'diff-count-minus');
  assert.equal(plus.length, 1, 'one plus count');
  assert.equal(text(plus[0]), '+1');
  assert.equal(minus.length, 1, 'one minus count');
  assert.equal(text(minus[0]), '−1');
  const open = byClass(spec, 'diff-open');
  assert.equal(open.length, 1);
  assert.equal(open[0].aria, 'Abrir en el editor');
  ok('head renders back, name, +N/−N and open');
}

// ---- line rows: symbol + text per kind ----------------------------------------
{
  const d = M.fromEdit('a\nb\nc\n', 'a\nX\nc\n', 'f');
  const spec = V.diffCardSpec(d, {});
  const rows = byClass(spec, 'diff-line');
  const kindOf = r => String(r.class).split(' ').find(c => c !== 'diff-line');
  assert.deepEqual(rows.map(kindOf), ['context', 'removed', 'added', 'context'],
    'rows carry the diff kind as a class');
  const syms = rows.map(r => text(byClass(r, 'diff-sym')[0]));
  assert.deepEqual(syms, [' ', '−', '+', ' '], 'shape always accompanies colour (C5)');
  const body = rows.map(r => text(byClass(r, 'diff-text')[0]));
  assert.deepEqual(body, ['a', 'b', 'X', 'c']);
  ok('line rows carry kind, symbol and text');
}

// ---- honest states -------------------------------------------------------------
{
  const none = M.fromEdit('a\n', 'a\n', 'f');
  const s1 = V.diffCardSpec(none, {});
  assert.ok(text(s1).includes('Sin cambios'), 'no-changes is said out loud');
  const big = M.fromEdit('x'.repeat(101 * 1024), 'x'.repeat(101 * 1024) + '\ny\n', 'huge');
  const s2 = V.diffCardSpec(big, {});
  assert.ok(text(s2).includes('Muy grande'), 'too-large is said out loud');
  assert.equal(byClass(s2, 'diff-line').length, 0, 'no line rows for a too-large diff');
  assert.ok(text(s2).includes('+1'), 'counts stay honest');
  assert.equal(byClass(s2, 'diff-count-minus').length, 0, 'no minus badge when nothing was removed');
  ok('too-large and no-changes states stay honest');
}

// ---- hooks gate controls --------------------------------------------------------
{
  const d = M.fromEdit('a\n', 'b\n', 'f');
  assert.equal(byClass(V.diffCardSpec(d, {}), 'diff-back').length, 0, 'no dismiss hook → no back button');
  assert.equal(byClass(V.diffCardSpec(d, {}), 'diff-open').length, 0, 'no open hook → no open button');
  ok('controls appear only with their hook');
}

// ---- junk input -----------------------------------------------------------------
assert.deepEqual(V.diffCardSpec(null, {}), null);
assert.deepEqual(V.diffCardSpec(undefined, {}), null);
assert.deepEqual(V.diffCardSpec('nope', {}), null);
assert.doesNotThrow(() => V.diffCardSpec(M.sampleDiff(), null));
ok('junk input yields null and never throws');

// ---- the future mount walks specs with textContent only --------------------------
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'diff-views.js'), 'utf8');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    'no markup sink in the diff renderer');
  const spec = V.diffCardSpec(M.sampleDiff(), { dismiss() {}, open() {} });
  // apply() is the only DOM step; every text leaf it would write is in the spec.
  const leaves = [];
  const walk = s => { if (s.text != null) leaves.push(s.text); for (const c of s.children || []) walk(c); };
  walk(spec);
  assert.ok(leaves.length > 0, 'spec carries all visible text');
  ok('spec is complete and the module has no markup sink');
}

console.log(`\n${n} checks passed`);
