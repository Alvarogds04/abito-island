'use strict';
/* Sileo-style question toast — pure view model (no DOM). Run: node test-node/question-toast-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const ID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const NOW = 1_000_000;
const pending = (over = {}) => ({ id: ID, kind: 'question', text: '¿Querés café o té?', agent: 'pi', agent_label: 'Pi', allow_free_text: false,
  options: [{ index: 0, label: 'Café', description: '' }, { index: 1, label: 'Té', description: '' }], expires_at: NOW + 60000, ...over });
const snap = (over = {}) => ({ available: true, pending: pending(), queued: [], queued_count: 0, notice: null, ...over });

test('a new pending question becomes a toast «<Agente> pregunta» with the first line of the text', () => {
  const v = T.toastView(snap(), { now: NOW });
  assert.deepEqual([v.id, v.kind, v.title, v.body, v.queue], [ID, 'question', 'Pi pregunta', '¿Querés café o té?', null]);
  assert.equal(v.tone, 'action');
  assert.match(v.aria, /Pi pregunta: ¿Querés café o té\?/);
  assert.match(v.aria, /Abrir/);
});

test('permission requests read as a permission and use the warning tone', () => {
  const v = T.toastView(snap({ pending: pending({ kind: 'approval', agent: 'claude-code', text: 'Bash: rm -rf node_modules', options: [{ index: 0, label: 'Permitir', description: '' }, { index: 1, label: 'Denegar', description: '' }] }) }), { now: NOW });
  assert.deepEqual([v.kind, v.title, v.tone], ['approval', 'Claude Code pide permiso', 'warning']);
});

test('only the first non-empty line, control characters flattened, bounded with an ellipsis', () => {
  assert.equal(T.toastView(snap({ pending: pending({ text: '\n\n  Primera línea\nsegunda' }) }), { now: NOW }).body, 'Primera línea');
  assert.equal(T.toastView(snap({ pending: pending({ text: 'a\u0000b\u202ec' }) }), { now: NOW }).body, 'a b c');
  const long = T.toastView(snap({ pending: pending({ text: 'x'.repeat(500) }) }), { now: NOW }).body;
  assert.ok(long.length <= 120 && long.endsWith('…'), long.length);
});

test('hidden when there is nothing to show: no pending, expired, or the island already shows the question', () => {
  assert.equal(T.toastView(snap({ pending: null }), { now: NOW }), null);
  assert.equal(T.toastView(null, { now: NOW }), null);
  assert.equal(T.toastView({ available: false }, { now: NOW }), null);
  assert.equal(T.toastView(snap({ pending: pending({ expires_at: NOW - 1 }) }), { now: NOW }), null, 'expired');
  assert.equal(T.toastView(snap(), { now: NOW, onScreen: true }), null, 'the card is on screen: no duplicate');
  assert.equal(T.toastView(snap({ pending: pending({ text: '' }) }), { now: NOW }), null, 'malformed pending is not a toast');
  assert.equal(T.toastView(snap({ notice: 'answered', pending: null }), { now: NOW }), null, 'answered/cancelled outcomes hide it');
});

test('the human can dismiss one toast (Esc) without answering; a different question shows again', () => {
  assert.equal(T.toastView(snap(), { now: NOW, dismissedId: ID }), null);
  assert.ok(T.toastView(snap(), { now: NOW, dismissedId: '11111111-1111-4111-8111-111111111111' }));
});

test('designed for the queue: «1 de N» when the snapshot carries queued_count', () => {
  assert.equal(T.toastView(snap({ queued_count: 2 }), { now: NOW }).queue, '1 de 3');
  assert.equal(T.toastView(snap({ queued_count: 0 }), { now: NOW }).queue, null);
  assert.equal(T.toastView(snap({ queued_count: -4 }), { now: NOW }).queue, null);
  assert.equal(T.toastView(snap({ queued_count: 'x' }), { now: NOW }).queue, null);
  assert.match(T.toastView(snap({ queued_count: 1 }), { now: NOW }).aria, /1 de 2/);
});

test('opening needs a trusted click and returns only the live id; a synthetic event opens nothing', () => {
  const v = T.toastView(snap(), { now: NOW });
  assert.deepEqual(T.openRequest({ isTrusted: true }, v), { id: ID });
  assert.equal(T.openRequest({ isTrusted: false }, v), null);
  assert.equal(T.openRequest(null, v), null);
  assert.equal(T.openRequest({ isTrusted: true }, null), null);
});

test('the toast never carries an answer: the view has no option list, no send, no decision', () => {
  const v = T.toastView(snap(), { now: NOW });
  for (const key of Object.keys(v)) assert.doesNotMatch(key, /option|answer|decision|send/i, key);
});

test('input region: the island shape grows to include the toast (the host region is a single rectangle)', () => {
  assert.deepEqual(T.shapeWithToast([288, 32], false), [288, 32]);
  const [w, h] = T.shapeWithToast([288, 32], true);
  assert.equal(w, 350);
  assert.equal(h, 32 + T.TOAST.gap + T.TOAST.hMax);
  assert.deepEqual(T.shapeWithToast([640, 160], true), [640, 160 + T.TOAST.gap + T.TOAST.hMax]);
});

test('reveal policy: a new question shows the toast; it no longer expands the island by itself', () => {
  assert.equal(T.revealByToast({ phase: 'compact' }), true);
  assert.equal(T.revealByToast({ phase: 'expanded' }), false, 'expanded: the card itself is the signal');
});

test('Sileo port is vanilla: spring linear() easing, 350x40 pill, gooey filter, no React/npm, reduced motion respected', () => {
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.match(css, /--sileo-spring-easing:\s*linear\(/);
  assert.match(css, /width:\s*350px/);
  assert.match(css, /height:\s*40px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /html\[data-motion="reduce"\]/);
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(js, /feGaussianBlur/);
  assert.match(js, /feColorMatrix/);
  assert.doesNotMatch(js, /require\((['"])react|from ['"]react|import\(/);
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(js, /event\.isTrusted|isTrusted/);
  assert.match(js, /Escape/);
});

test('wiring: shipped in the page and the package, positioned under the island, opens the island on a trusted click, reports its shape', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="question-toast\.css">/);
  assert.match(html, /<script defer src="question-toast\.js"><\/script>/);
  assert.ok(html.indexOf('notify-view.js') < html.indexOf('question-toast.js'), 'the pure notify view loads first');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  assert.match(lib, /'question-toast\.css'/); assert.match(lib, /'question-toast\.js'/);
  const toast = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(toast, /getBoundingClientRect/);
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /addEventListener\('abito:question-open'/);
  assert.match(isl, /window\.desktop\.expand\(\)/);
  assert.match(isl, /addEventListener\('abito:question-toast'/);
  assert.match(isl, /shapeWithToast/);
  assert.match(isl, /revealByToast/);
});

// ---- Sileo motion, ported (hiaaryan/sileo sileo.tsx + constants.ts): the pill MORPHS OUT of the island's bottom edge ------------------
test('spring: motion\'s spring(duration 0.6, bounce 0.25) = damping ratio 0.75, omega 2*pi/0.6; starts at 0, overshoots a little, settles at 1', () => {
  assert.deepEqual(T.SPRING, { duration: 0.6, bounce: 0.25 });
  assert.equal(T.springAt(0), 0);
  assert.equal(T.springAt(-1), 0);
  const samples = Array.from({ length: 200 }, (_, i) => T.springAt(i * 0.01));
  const peak = Math.max(...samples);
  assert.ok(peak > 1.01 && peak < 1.12, `a small overshoot (Sileo bounce), got ${peak}`);
  assert.ok(T.springAt(0.2) > 0.4 && T.springAt(0.2) < 1, 'most of the travel in the first third');
  assert.ok(Math.abs(T.springAt(2) - 1) < 1e-3, 'settled');
  assert.equal(T.springAt(10), 1, 'at rest it is exactly the target');
  assert.ok(Math.abs(T.springAt(0.3, { duration: 0.6, bounce: 0 }) - T.springAt(0.3, { duration: 0.6, bounce: 0 })) === 0 && T.springAt(0.3, { duration: 0.6, bounce: 0 }) <= 1, 'no bounce: never past the target');
  for (const bad of [NaN, Infinity, 'x', undefined]) assert.equal(T.springAt(bad), 0, String(bad));
});
test('morphFrame: at progress 0 the pill IS the island\'s bottom edge (same width, no gap); at 1 it is the content-wide pill centred under it', () => {
  const island = { w: 288, r: 14 };
  const a = T.morphFrame({ progress: 0, island, pillW: 150, open: false });
  assert.equal(a.neck.width, 288 - 2 * 14, 'the neck is the island\'s flat bottom edge (corner radii excluded)');
  assert.equal(a.pill.width, a.neck.width, 'starts exactly as wide as the edge it comes out of: the gooey filter joins them with no gap');
  assert.equal(a.pill.y + a.pill.height, 0, 'and its bottom is the island\'s bottom edge');
  const z = T.morphFrame({ progress: 1, island, pillW: 150, open: false });
  assert.deepEqual([z.pill.width, z.pill.height, z.pill.y], [150, T.TOAST.h, 0]);
  assert.equal(z.pill.x, (T.TOAST.w - 150) / 2, 'centred like the island');
  assert.ok(z.neck.y + z.neck.height <= 0.0001, 'the neck stays inside the island: it never draws below its bottom edge');
  assert.equal(z.body.height, 0, 'collapsed: no body');
  const over = T.morphFrame({ progress: 1.04, island, pillW: 150, open: false });
  assert.ok(over.pill.width < 150, 'the spring overshoot is allowed: it travels past the target in its own direction (260 -> 150 -> a bit under)');
  const wide = T.morphFrame({ progress: 1.04, island: { w: 100, r: 14 }, pillW: 150, open: false });
  assert.ok(wide.pill.width > 150, 'and past it upwards when the island is narrower than the pill');
});
test('morphFrame: expanding opens the 350px body below the pill; the neck always follows the CURRENT island width', () => {
  const open = T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 150, open: true });
  assert.equal(open.body.height, T.TOAST.hMax - T.TOAST.h);
  assert.equal(open.body.width, T.TOAST.w);
  assert.equal(open.neck.width, 640 - 28, 'a wider island, a wider neck');
  assert.equal(open.neck.x, (T.TOAST.w - (640 - 28)) / 2, 'centred on the toast axis (negative x is fine: the SVG overflows)');
  const half = T.morphFrame({ progress: 0.5, island: { w: 640, r: 14 }, pillW: 150, open: true });
  assert.ok(half.pill.width < 612 && half.pill.width > 150, 'the pill is still travelling');
  assert.ok(T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 10, open: false }).pill.width >= T.TOAST.h, 'never narrower than its height');
  assert.ok(T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 9999, open: false }).pill.width <= T.TOAST.w, 'never wider than the toast');
});
test('reduced motion: the toast does not travel — it appears in place and only fades', () => {
  const r = T.morphFrame({ progress: 0, island: { w: 288, r: 14 }, pillW: 150, open: false, reduce: true });
  assert.deepEqual([r.pill.width, r.pill.height], [150, T.TOAST.h], 'the final geometry straight away');
  assert.deepEqual(T.motionPlan(true), { mode: 'fade', springs: false });
  assert.deepEqual(T.motionPlan(false), { mode: 'morph', springs: true });
});
test('flush under the island: no gap, centred on it, and it moves with the island (offset follows the island\'s own bottom edge)', () => {
  assert.equal(T.TOAST.gap, 0, 'touching the island\'s bottom edge');
  assert.deepEqual(T.toastTop({ top: 0, height: 160 }), 160);
  assert.deepEqual(T.toastTop({ top: 2, height: 32 }), 34);
  assert.equal(T.toastTop({ top: -26, height: 32 }), 6, 'an island concealed to the edge pulls the toast up with it');
  for (const bad of [null, undefined, {}, { top: NaN, height: 5 }]) assert.equal(T.toastTop(bad), 0, JSON.stringify(bad));
  assert.deepEqual(T.shapeWithToast([288, 32], true), [350, 32 + T.TOAST.hMax], 'the input region has no dead band between island and toast');
});
test('wiring: the toast follows the island with a ResizeObserver (every frame of its spring), reads its radius, and starts from its edge', () => {
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(js, /new ResizeObserver\(/);
  assert.match(js, /observe\(island\)/);
  assert.match(js, /T\.toastTop\(/);
  assert.match(js, /T\.morphFrame\(/);
  assert.match(js, /T\.springAt\(/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /T\.motionPlan\(/);
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)|dataset\.motion === 'reduce'/);
  assert.doesNotMatch(js, /follow = requestAnimationFrame\(step\)|performance\.now\(\) \+ 900/, 'no fixed 900 ms tracking window that stops following the island');
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.doesNotMatch(css, /top: 48px/, 'no hardcoded position: it is the island\'s edge');
  assert.match(css, /\.q-toast-neck/);
});

console.log(`question-toast-check: ${passed} checks ok`);
