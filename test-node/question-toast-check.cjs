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

console.log(`question-toast-check: ${passed} checks ok`);
