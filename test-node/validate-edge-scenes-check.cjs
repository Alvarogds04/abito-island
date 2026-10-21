'use strict';
/* The screen validator's edge scenes must follow the product decisions: «Ocultar tras» is SECONDS (5..300), and only a pending
   question blocks the edge hide (status/retained notices do not). Source-level contract on the scene driver: the scenes themselves
   drive the shared desktop and are run by the parent, never here. Run: node test-node/validate-edge-scenes-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8');
const between = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `${from} .. ${to}`); return src.slice(a, b); };
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

test('no scene uses the retired minutes command or reads absenceMinutes', () => {
  assert.doesNotMatch(src, /set_absence_minutes/);
  assert.doesNotMatch(src, /absenceMinutes/);
});
test('edgeIdle sets 5 seconds, waits at most 15 s, asserts the elapsed window, and edgeWake restores the previous seconds', () => {
  const idle = between('async function edgeIdle()', 'async function edgeWake()');
  assert.match(idle, /action:'set_absence_seconds',seconds:5/);
  assert.match(idle, /,15000\)/, 'the wait gives up after 15 s');
  assert.match(idle, /const elapsed=performance\.now\(\)-began;/);
  assert.match(idle, /elapsed>=4000/, 'not before ~5 s (1 s tolerance for the fold settling)');
  assert.match(idle, /elapsed<=15000/);
  assert.doesNotMatch(idle, /66000|59000|un minuto/);
  const wake = between('async function edgeWake()', 'async function islandHoverPin()');
  assert.match(wake, /action:'set_absence_seconds',seconds:edgeIdlePrefs\.absenceSeconds/);
});
test('the retained-notices scene now asserts the NEW rule: retained notices do not block the edge hide', () => {
  const cycle = between('async function noticeCycle()', 'let noticeEdgeSound');
  assert.doesNotMatch(cycle, /retainedBlocksEdge/);
  assert.match(cycle, /retainedDoesNotBlockEdge/);
  assert.match(cycle, /edgeHidden==='true'/);
});
test('the pending-question scene still asserts a pending question is never concealed', () => {
  const alert = between('async function shortcutAlert()', 'async function ');
  assert.match(alert, /neverConcealed=byId\('capsule'\)\.dataset\.edgeHidden!=='true'/);
});
test('the answer scene still finds the vertical rows: <button class="q-option"> inside #question-options whose text names the option', () => {
  assert.match(src, /querySelectorAll\('#question-options \.q-option'\)\]\.find\(b=>visible\(b\) && b\.textContent\.includes\('Validar'\)\)/);
  const notify = fs.readFileSync(path.join(__dirname, '../frontend/notify.js'), 'utf8');
  assert.match(notify, /el\('button', r\.kind === 'other' \? 'q-option q-other' : 'q-option'\)/, 'rows keep the q-option class');
  assert.match(notify, /el\('span', 'q-label', r\.label\)/, 'and carry the label text the scene matches');
});
console.log(`validate-edge-scenes: ${passed} checks ok`);
