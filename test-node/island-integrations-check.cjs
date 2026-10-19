'use strict';
// #489 integration cards: pure view-model only (no DOM, no network).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../frontend/island-integrations.js');
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

test('idle without an update, with a foreign update or an unknown id', () => {
  assert.equal(M.view('integration_vercel', undefined).kind, 'idle');
  assert.equal(M.view('integration_n8n', { id: 'integration_vercel', data: {} }).kind, 'idle');
  assert.equal(M.view('integration_stripe', { id: 'integration_stripe', data: {} }).kind, 'idle');
  assert.equal(M.view('integration_n8n', { id: 'integration_n8n', data: {}, error: null, event: null }).kind, 'idle');
});

test('an error line replaces the card body', () => {
  const v = M.view('integration_vercel', { id: 'integration_vercel', data: {}, error: 'Clave de API no válida (401)' });
  assert.equal(v.kind, 'error');
  assert.equal(v.status, 'Clave de API no válida (401)');
});

test('vercel rows: at most three, state colour, commit and safe url', () => {
  const deployments = [1, 2, 3, 4].map(n => ({ projectName: 'p' + n, state: n === 2 ? 'ERROR' : 'READY', createdAt: NOW - n * 120000, url: 'web-' + n + '.vercel.app', commitMessage: 'fix ' + n, branch: 'main' }));
  const v = M.view('integration_vercel', { id: 'integration_vercel', data: { deployments } }, NOW);
  assert.equal(v.kind, 'list');
  assert.equal(v.rows.length, 3);
  assert.deepEqual(v.rows.map(r => r.ok), [true, false, true]);
  assert.equal(v.rows[0].ago, '2 min');
  assert.equal(v.rows[0].url, 'https://web-1.vercel.app');
  assert.equal(v.rows[0].commit, 'fix 1');
});

test('only vercel.app hosts become links', () => {
  for (const bad of ['evil.com', 'x.vercel.app.evil.com', 'a b.vercel.app', 'u@x.vercel.app', 'x.vercel.app/path', 'x.vercel.app:8080', '', null, 7, 'javascript:alert(1)']) {
    assert.equal(M.vercelUrl(bad), null, String(bad));
  }
  assert.equal(M.vercelUrl('My-App-1.vercel.app'), 'https://my-app-1.vercel.app');
});

test('n8n workflow view carries the event detail as plain text', () => {
  const v = M.view('integration_n8n', { id: 'integration_n8n', data: { workflow: 'Nightly', status: 'error' }, error: null, event: { success: false, label: 'Nightly', detail: 'HTTP\nboom <b>x</b>' } });
  assert.equal(v.kind, 'workflow');
  assert.equal(v.ok, false);
  assert.equal(v.detail, 'HTTP\nboom <b>x</b>');
});

test('timeAgo follows Coucou buckets', () => {
  assert.equal(M.timeAgo(NOW - 5000, NOW), 'ahora');
  assert.equal(M.timeAgo(NOW - 3 * 3600000, NOW), '3 h');
  assert.equal(M.timeAgo(NOW - 2 * 86400000, NOW), '2 d');
  assert.equal(M.timeAgo('nope', NOW), '');
});

test('the renderer never uses innerHTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/island-integrations.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src));
});
