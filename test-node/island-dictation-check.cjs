'use strict';
/* S10 (L30) — the dictation pill in the island: view-model contracts and wiring. No DOM, no events, no microphone. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const D = require(path.join(frontend, 'island-dictation.js'));
const src = fs.readFileSync(path.join(frontend, 'island-dictation.js'), 'utf8');
const rust = fs.readFileSync(path.join(__dirname, '..', 'src', 'dictation_cmd.rs'), 'utf8');
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('phases: exactly the six the host emits; anything else changes nothing', () => {
  for (const p of ['idle', 'listening', 'locked', 'thinking', 'copied', 'failed']) assert.equal(D.phaseOf({ phase: p }), p);
  for (const bad of [null, [], 'x', {}, { phase: 'recording' }, { phase: 5 }, { phase: null }]) assert.equal(D.phaseOf(bad), null, JSON.stringify(bad));
  // the page's list is the host's list (dictation_cmd.rs event())
  for (const name of ['idle', 'listening', 'locked', 'thinking', 'copied', 'failed']) assert.ok(rust.includes(`"${name}"`), name);
});

test('notes: the three the host emits map to closed Spanish text; an unknown note is never echoed', () => {
  assert.deepEqual(Object.keys(D.NOTES).sort(), ['clipboardRefused', 'needModel', 'noMicrophone']);
  for (const k of Object.keys(D.NOTES)) assert.ok(rust.includes(`"${k}"`), k);
  assert.match(D.noteOf({ note: 'needModel' }), /modelo de voz/); assert.match(D.noteOf({ note: 'noMicrophone' }), /micrófono/); assert.match(D.noteOf({ note: 'clipboardRefused' }), /portapapeles/);
  for (const bad of [null, {}, { note: '<b>x</b>' }, { note: 'constructor' }, { note: '__proto__' }, { note: 7 }, []]) assert.equal(D.noteOf(bad), null, JSON.stringify(bad));
});

test('bands: always exactly 9 numbers clamped to 0..1; a payload that is not a bands frame is ignored', () => {
  assert.equal(D.BANDS, 9);
  assert.deepEqual(D.bandsOf({ bands: [0, 0.5, 1, 2, -1, NaN, 'x', null, Infinity, 0.3, 0.9] }), [0, 0.5, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(D.bandsOf({ bands: [] }), new Array(9).fill(0));
  for (const bad of [null, [], 'x', {}, { bands: 'x' }, { bands: {} }]) assert.equal(D.bandsOf(bad), null);
  assert.equal(D.barSize(0), 3.4); assert.ok(Math.abs(D.barSize(1) - 19.4) < 1e-9); assert.equal(D.barSize(5), D.barSize(1)); assert.equal(D.barSize(-3), 3.4);
});

test('looks and sizes follow Coucou: listening/thinking = live, locked = hands-free 158, copied/failed = message, idle = resting or toolbar on hover', () => {
  assert.equal(D.lookOf('listening', false), 'live'); assert.equal(D.lookOf('thinking', true), 'live'); assert.equal(D.lookOf('locked', false), 'handsFree');
  assert.equal(D.lookOf('copied', false), 'message'); assert.equal(D.lookOf('failed', false), 'message');
  assert.equal(D.lookOf('idle', false), 'resting'); assert.equal(D.lookOf('idle', true), 'toolbar');
  assert.equal(D.lengthOf('resting'), 44); assert.equal(D.lengthOf('toolbar'), 150); assert.equal(D.lengthOf('handsFree'), 158); assert.equal(D.lengthOf('live'), 118);
  assert.ok(D.lengthOf('message', D.messageOf('copied')) > D.lengthOf('message', D.messageOf('failed')) - 40);
  assert.equal(D.messageOf('copied'), 'Copiado · pegalo con Ctrl+V'); assert.equal(D.messageOf('failed'), 'Micrófono no disponible'); assert.equal(D.messageOf('idle'), null);
});

test('dots: the voice while listening or locked, a slow wave while thinking, nothing otherwise', () => {
  const target = [0.7, 0.2, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(D.dotGoal('listening', 0, 0, target), 0.7); assert.equal(D.dotGoal('locked', 99, 1, target), 0.2);
  assert.equal(D.dotGoal('idle', 0, 0, target), 0); assert.equal(D.dotGoal('copied', 0, 0, target), 0);
  for (let i = 0; i < 9; i++) { const g = D.dotGoal('thinking', 1234 + i * 77, i, target); assert.ok(g >= 0 && g <= 0.5, String(g)); }
});

test('the pill exists only with dictation on: status.prefs.enabled === true; the verbs are the closed ones', () => {
  assert.equal(D.enabledOf({ prefs: { enabled: true } }), true);
  for (const bad of [null, [], {}, { prefs: {} }, { prefs: { enabled: 'yes' } }, { prefs: { enabled: false } }, { prefs: [] }]) assert.equal(D.enabledOf(bad), false, JSON.stringify(bad));
  assert.deepEqual(D.VERBS, { handsFree: 'hands_free', finish: 'finish', cancel: 'cancel', status: 'status' });
  for (const v of Object.values(D.VERBS)) assert.ok(rust.includes(`"${v}"`), v + ' is a verb of dictation_action');
});

test('wiring: closed events and verbs only; trusted clicks; inert in the settings window; never starts the mic or expands the island', () => {
  for (const e of ['dictation:phase', 'dictation:bands', 'dictation:note']) assert.match(src, new RegExp(`listen\\('${e}'`));
  for (const verb of src.match(/payload: \{ action: [^}]+\}/g) || []) assert.match(verb, /action: (verb|api\.VERBS\.status)/, verb);
  assert.match(src, /e\.isTrusted !== true\) return; e\.stopPropagation\(\)/);
  assert.match(src, /label === 'settings'\) return/);
  assert.doesNotMatch(src, /desktop\.expand|desktop\.close|set_prefs|download_model|remove_model|getUserMedia|innerHTML/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="island-dictation\.js"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(css, /\.dcapsule \{[^}]*border-radius: 999px/); assert.match(css, /\.dcapsule\.handsfree \{ box-shadow: inset 0 0 0 1\.5px rgba\(249, 115, 22, 0\.85\)/);
  assert.match(css, /\.dpill \.bars i \{ width: 3\.4px; height: 3\.4px/); assert.match(css, /\.dpill \.pbtn::after \{ content: ""; position: absolute; inset: -8px; \}/, '44px hit around the 28px button');
  assert.match(css, /#capsule\[data-phase="compact"\]\[data-dictation="locked"\] #island/, 'the folded dot shows a live dictation');
});

if (failed) process.exit(1);
