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
  assert.equal(M.view('integration_github', { id: 'integration_github', data: {} }).kind, 'idle');
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

test('stripe: balance in major units, three payments, failed charge is red', () => {
  const v = M.view('integration_stripe', { id: 'integration_stripe', data: { balance: 10250, currency: 'usd', payments: [
    { description: 'Pro', amount: 1250, status: 'succeeded', createdAt: NOW - 60000 }, { amount: 500, status: 'failed', createdAt: NOW }, {}, {}] } }, NOW);
  assert.equal(v.kind, 'payments');
  assert.equal(v.balance, '102.50');
  assert.equal(v.currency, 'USD');
  assert.equal(v.payments.length, 3);
  assert.deepEqual([v.payments[0].amount, v.payments[0].ok, v.payments[1].ok, v.payments[1].text], ['+12.50', true, false, 'Pago']);
});

test('resend: first row carries the subject, recipient is shortened, total survives', () => {
  const v = M.view('integration_resend', { id: 'integration_resend', data: { total: 9, emails: [
    { to: ['ana@x.io'], subject: 'Hola', lastEvent: 'delivered', createdAt: new Date(NOW - 3600000).toISOString() }, { to: 'x', subject: 'B', lastEvent: 'bounced' }] } }, NOW);
  assert.equal(v.kind, 'emails');
  assert.deepEqual([v.total, v.rows[0].to, v.rows[0].subject, v.rows[0].ok, v.rows[1].subject, v.rows[1].ok], [9, 'ana', 'Hola', true, '', false]);
  assert.equal(M.view('integration_resend', { id: 'integration_resend', data: { emails: [] } }).kind, 'idle');
});

test('notion: only https notion pages link out', () => {
  for (const bad of ['http://notion.so/a', 'https://evil.com/notion.so', 'https://notion.so.evil.com/a', 'https://u@notion.so/a', 'javascript:alert(1)', '', null, 'https://x.notion.so/a b']) assert.equal(M.notionUrl(bad), null, String(bad));
  assert.equal(M.notionUrl('https://www.notion.so/Plan-1'), 'https://www.notion.so/Plan-1');
  const v = M.view('integration_notion', { id: 'integration_notion', data: { pages: [{ title: '', emoji: '📝', lastEditedAt: new Date(NOW).toISOString(), url: 'https://evil.com' }] } }, NOW);
  assert.deepEqual([v.rows[0].title, v.rows[0].emoji, v.rows[0].url], ['Sin título', '📝', null]);
});

test('cal.com: soonest first, at most three, empty list is still a card', () => {
  const b = n => ({ title: 'T' + n, start: new Date(2030, 0, n, 9, 5).toISOString() });
  const v = M.view('integration_calcom', { id: 'integration_calcom', data: { bookings: [b(5), b(2), b(9), b(3), { title: 'x', start: 'nope' }] } }, NOW);
  assert.deepEqual(v.rows.map(r => r.title), ['T2', 'T3', 'T5']);
  assert.equal(v.rows[0].when, '02/01 09:05');
  assert.equal(M.view('integration_calcom', { id: 'integration_calcom', data: { bookings: [] } }).kind, 'bookings');
});

test('the renderer never uses innerHTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/island-integrations.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src));
});

test('six services distinguish missing/error/stale/refresh and keep safe open targets', () => {
  for (const id of M.IDS) {
    assert.equal(M.view(id,{id,state:'missing_key',data:{}},NOW).kind,'missing_key');
    const stale=M.view(id,{id,state:'stale',updatedAt:NOW-60000,error:'offline',data:{workflow:'saved'}},NOW);
    assert.equal(stale.stale,true);
    assert.equal(stale.error,'offline');
    assert.equal(M.view(id,{id,state:'refreshing',data:{}},NOW).refreshing,true);
    assert.match(M.openTarget(id),/^https:\/\//);
  }
  assert.equal(M.openTarget('integration_github'),null);
});

test('Cal.com week/day/detail filters dates across month boundaries', () => {
  const day=Date.UTC(2026,9,31);
  const bookings=[{id:'one',start:'2026-10-31T10:00:00Z',title:'Demo',attendeeName:'Ana',attendeeNotes:'Consulta'},
    {id:'two',start:'2026-11-01T10:00:00Z',title:'Next'}, {id:'bad',start:'invalid'}];
  assert.equal(M.calendarView(bookings,'week',day,null).days.length,7);
  assert.deepEqual(M.calendarView(bookings,'week',day,null).rows.map(r=>r.id),['one','two']);
  assert.deepEqual(M.calendarView(bookings,'day',day,null).rows.map(r=>r.id),['one']);
  assert.equal(M.calendarView(bookings,'day',day,'one').detail.attendee,'Ana');
  assert.equal(M.calendarView(bookings,'day',day,'one').detail.notes,'Consulta');
  assert.equal(M.calendarView(bookings,'day',day,'foreign').detail,null);
});
