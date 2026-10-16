'use strict';
/* F018 RED test — pure diff engine contract (frontend/diff-model.js).
   The engine ports LOGIC ONLY from Coucou's MIT windows/src/core/diff.ts
   (commit 71b773f08101237e1ec950efdaee17a626c830e6): size guards, LCS line
   diff, hunk grouping with 3 context lines, tool-call diff build and the
   too-large count fallback. No upstream asset, icon, string or artwork is
   copied; UI copy is Abito's own Spanish (voseo). Run: node
   test-node/diff-model-check.cjs (exit 0 = pass). */
const assert = require('node:assert/strict');
const path = require('node:path');
const D = require(path.join(__dirname, '..', 'frontend', 'diff-model.js'));

let n = 0;
const ok = name => { n++; console.log(`ok ${n} - ${name}`); };

// ---- surface ---------------------------------------------------------------
for (const fn of ['fileName', 'fromEdit', 'fromNew', 'buildToolDiff', 'isTooLarge',
  'diffLinesCount', 'sampleDiff']) {
  assert.equal(typeof D[fn], 'function', `exports ${fn} as a function`);
}
for (const c of ['MAX_BYTES', 'MAX_LINES', 'MAX_CELLS', 'CONTEXT']) {
  assert.ok(Number.isInteger(D[c]) && D[c] > 0, `${c} is a positive integer`);
}
ok('exports the closed API');

// ---- fileName ---------------------------------------------------------------
assert.equal(D.fileName('/home/u/proj/src/app.rs'), 'app.rs');
assert.equal(D.fileName('C:\\repo\\src\\main.rs'), 'main.rs');
assert.equal(D.fileName('plain.txt'), 'plain.txt');
assert.equal(D.fileName('/dir/'), 'dir'); // trailing separators never yield ''
assert.equal(D.fileName(''), '');
assert.equal(D.fileName(42), '');
ok('fileName handles posix, windows, plain, trailing slash, junk');

// ---- fromEdit: a real edit diff ---------------------------------------------
{
  const d = D.fromEdit('a\nb\nc\n', 'a\nX\nc\n', 'src/f.txt');
  assert.equal(d.tooLarge, false);
  assert.equal(d.path, 'src/f.txt');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  const lines = d.hunks.flatMap(h => h.lines);
  assert.deepEqual(lines.map(l => l.kind),
    ['context', 'removed', 'added', 'context'], 'edit renders one swap with context');
  assert.equal(lines.find(l => l.kind === 'removed').text, 'b');
  assert.equal(lines.find(l => l.kind === 'added').text, 'X');
  // line numbers: context carries both, removed carries orig, added carries new
  assert.deepEqual(
    lines.map(l => [l.origLine, l.newLine]),
    [[1, 1], [2, -1], [-1, 2], [3, 3]]);
  ok('fromEdit produces LCS lines with kinds and line numbers');
}

// ---- fromEdit: identical text is an empty diff -------------------------------
{
  const d = D.fromEdit('same\n', 'same\n', 'f');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.hunks.flatMap(h => h.lines).filter(l => l.kind !== 'context'), []);
  ok('fromEdit with identical text has no added/removed lines');
}

// ---- fromNew: whole-file addition -------------------------------------------
{
  const d = D.fromNew('one\ntwo\nthree\n', 'new.txt');
  assert.equal(d.isNewFile, true);
  assert.equal(d.tooLarge, false);
  assert.equal(d.added, 3);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.hunks.flatMap(h => h.lines).map(l => l.kind),
    ['added', 'added', 'added']);
  assert.deepEqual(d.hunks.flatMap(h => h.lines).map(l => l.newLine), [1, 2, 3]);
  ok('fromNew marks every line added with 1-based new numbers');
}

// ---- hunk context: separate edits stay separate ------------------------------
{
  const old = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
  const neu = old.replace('l5', 'A').replace('l35', 'B');
  const d = D.fromEdit(old, neu, 'big.txt');
  assert.ok(d.hunks.length === 2, `two distant edits → two hunks, got ${d.hunks.length}`);
  // each hunk carries at most 3 context lines on each side of its change
  for (const h of d.hunks) {
    const kinds = h.lines.map(l => l.kind);
    const first = kinds.indexOf(kinds.find(k => k !== 'context'));
    const rev = [...kinds].reverse();
    const last = kinds.length - 1 - rev.indexOf(rev.find(k => k !== 'context'));
    assert.ok(first <= 3 && kinds.length - 1 - last <= 3, 'context capped at 3 per side');
  }
  ok('hunks cap context at 3 lines and split far-apart edits');
}

// ---- too-large fallback: byte guard ------------------------------------------
{
  const big = 'x'.repeat(101 * 1024); // > 100 KiB in each text
  const d = D.fromEdit(big, big + '\ny\n', 'huge.txt'); // append a NEW line: first line unchanged
  assert.equal(D.isTooLarge(d), true);
  assert.deepEqual(d.hunks, [], 'too-large diffs carry no hunks (never rendered)');
  // the fallback still counts honestly
  assert.ok(d.added > 0 && d.removed === 0, 'count fallback counts added lines');
  ok('byte-oversized edit falls back to an honest too-large count');
}

// ---- too-large fallback: line guards ------------------------------------------
{
  const lines = Array.from({ length: D.MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
  const d = D.fromEdit(lines, 'x\n', 'f');
  assert.equal(D.isTooLarge(d), true);
  assert.equal(D.MAX_LINES, 4000);
  assert.equal(D.MAX_BYTES, 200 * 1024);
  assert.equal(D.MAX_CELLS, 1000000);
  ok('line-oversized edit falls back too; guard constants stay upstream');
}

// ---- quadratic bail-out --------------------------------------------------------
{
  const old = Array.from({ length: 1100 }, () => 'same').join('\n');
  const neu = Array.from({ length: 1100 }, () => 'same').join('\n'); // 1100*1100 > MAX_CELLS
  const d = D.fromEdit(old, neu, 'q.txt');
  assert.equal(D.isTooLarge(d), true, 'O(m·n) guard bails before the blowup');
  ok('quadratic cell guard engages before LCS runs');
}

// ---- buildToolDiff: closed tool vocabulary -------------------------------------
{
  assert.equal(D.buildToolDiff('Bash', { command: 'ls' }), null, 'non-file tools yield nothing');
  assert.equal(D.buildToolDiff('Edit', { file_path: 'a', old_string: 'x', new_string: 'x' }), null,
    'no-op edit yields nothing');
  assert.equal(D.buildToolDiff('Edit', { file_path: 'a' }), null, 'missing strings yield nothing');
  assert.equal(D.buildToolDiff('Write', { file_path: 'a', content: '' }), null, 'empty write yields nothing');
  const e = D.buildToolDiff('Edit', { file_path: 'src/a.rs', old_string: 'a\n', new_string: 'b\n' });
  assert.ok(e && e.path === 'src/a.rs' && e.added === 1 && e.removed === 1, 'Edit builds a swap diff');
  const w = D.buildToolDiff('Write', { file_path: 'src/b.rs', content: 'hello\n' });
  assert.ok(w && w.isNewFile === true && w.added === 1, 'Write builds a new-file diff');
  const m = D.buildToolDiff('MultiEdit', { file_path: 'src/c.rs', edits: [
    { old_string: 'a\n', new_string: 'b\n' }, { old_string: 'c\n', new_string: 'd\n' }] });
  assert.ok(m && m.added === 2 && m.removed === 2, 'MultiEdit merges both edits');
  assert.equal(D.buildToolDiff('MultiEdit', { file_path: 'src/c.rs', edits: [] }), null,
    'empty MultiEdit yields nothing');
  ok('buildToolDiff is a closed vocabulary: Edit/Write/MultiEdit only');
}

// ---- untrusted input never throws ----------------------------------------------
for (const args of [[undefined, undefined], [null, null], [7, 'x'], ['a', undefined]]) {
  assert.doesNotThrow(() => D.fromEdit(args[0], args[1], args[2]));
}
assert.deepEqual(D.fromEdit(null, null, 'f'), null, 'null input yields null, not a diff');
assert.equal(D.fromNew(null, 'f'), null);
assert.equal(D.buildToolDiff(null, null), null);
ok('null/junk inputs yield null and never throw');

// ---- static sample (documented fake data for the unbuilt mount) ----------------
{
  const s = D.sampleDiff();
  assert.ok(s && s.path && Array.isArray(s.hunks) && s.hunks.length > 0, 'sample is a real diff shape');
  assert.equal(D.isTooLarge(s), false);
  assert.ok(s.added > 0 && s.removed > 0, 'sample shows both directions');
  ok('sampleDiff provides the documented static fixture');
}

console.log(`\n${n} checks passed`);
