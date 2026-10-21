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
test('terminal shortcut scenes accept the value the product writes: «focused-session» when a session is focused (fc7f679), «focused-class» only with none', () => {
  const isl = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(isl, /focusedSessionKey \? 'focused-session' : 'focused-class'/, 'the product distinguishes the two');
  const a = between('async function shortcutDispatch()', 'async function shortcutTerminalAbsent()');
  assert.doesNotMatch(a, /shortcutTerminal==='focused-class'/, 'the dispatch scene runs with the overview sessions focused: it must not wait for the class-only value');
  assert.match(a, /\['focused-session','focused-class'\]\.includes\(byId\('capsule'\)\.dataset\.shortcutTerminal\)/, 'either confirmation is a success; «unavailable»/«pending» is not');
  const b = between('async function shortcutTerminalAbsent()', 'async function shortcutAlert()');
  assert.match(b, /\['focused-session','focused-class'\]\.includes\(byId\('capsule'\)\.dataset\.shortcutTerminal\)/);
});
test('the focus scene encodes the A+E rules: every session is a blob row (no 2x2 cap, the focused one stays), the centre names the SAME session the jump targets', () => {
  const f = between('async function sessionsFocus()', 'async function restoreSessionFocus()');
  assert.doesNotMatch(f, /grid\.length<=4/, 'no 2x2 cap of four');
  assert.doesNotMatch(f, /!grid\.includes\(beta\.id\)/, 'the focused session stays a row');
  assert.match(f, /grid\.includes\(beta\.id\)/);
  assert.match(f, /centreName\(\)===/, 'the centre column is read, not the old who-row');
  assert.match(f, /\.centre-name/);
  assert.doesNotMatch(f, /querySelector\('\.who \.name'\)/, 'the who-row text is gone: the centre column says the session name');
});
console.log(`validate-edge-scenes: ${passed} checks ok`);
