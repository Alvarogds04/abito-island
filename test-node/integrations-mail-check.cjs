'use strict';
/* #370 F103 — pure checks for frontend/integrations-mail.js (the Mail service
   card: a read-list, an open message and a compose form inside the island).
   FAKE data only: no network, no accounts, no tokens. Sending is NOT wired: it
   returns a closed «no conectado» refusal and changes nothing.
   Run: node apps/desktop-tauri/test-node/integrations-mail-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const M = require(path.join(frontend, 'integrations-mail.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const store0 = () => M.storeFromFrame(M.fakeFrame());
const goodDraft = () => ({ to: 'ana@example.com', subject: 'Hola', body: 'Texto de ejemplo.' });

// ---- frame / store ----------------------------------------------------------
test('fake frame: closed shape, marked fake, accepted by its own validator', () => {
  const f = M.fakeFrame();
  assert.equal(f.type, 'mail');
  assert.equal(f.schema, M.SCHEMA);
  assert.equal(f.fake, true);
  assert.ok(f.messages.length > 0 && f.messages.length <= M.MAX_MESSAGES);
  assert.ok(M.storeFromFrame(f));
  assert.deepEqual(M.fakeFrame(), M.fakeFrame(), 'deterministic');
});

test('storeFromFrame: malformed frames are refused whole', () => {
  const ok = M.fakeFrame();
  const m = ok.messages[0];
  const cases = [null, {}, [], 'x', 7,
    { ...ok, type: 'other' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 'yes' },
    { ...ok, messages: 'x' }, { ...ok, token: 't' },
    { ...ok, messages: Array.from({ length: M.MAX_MESSAGES + 1 }, (_, i) => ({ ...m, id: `x${i}` })) },
    { ...ok, messages: [m, { ...m }] }, // duplicate id
    { ...ok, messages: [{ ...m, id: '__proto__' }] }, { ...ok, messages: [{ ...m, id: '' }] },
    { ...ok, messages: [{ ...m, from: '' }] }, { ...ok, messages: [{ ...m, from: 'x'.repeat(M.MAX_FROM + 1) }] },
    { ...ok, messages: [{ ...m, subject: 'x'.repeat(M.MAX_SUBJECT + 1) }] },
    { ...ok, messages: [{ ...m, body: 'x'.repeat(M.MAX_BODY + 1) }] },
    { ...ok, messages: [{ ...m, read: 1 }] }, { ...ok, messages: [{ ...m, minutesAgo: -1 }] },
    { ...ok, messages: [{ ...m, url: 'https://x' }] }, { ...ok, messages: [null] }];
  for (const bad of cases) assert.equal(M.storeFromFrame(bad), null, JSON.stringify(bad).slice(0, 80));
});

test('store is frozen; nothing is open at the start', () => {
  const s = store0();
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.messages));
  for (const msg of s.messages) assert.ok(Object.isFrozen(msg));
  assert.equal(s.openId, null);
});

// ---- read-list + open message -------------------------------------------------
test('view: list rows in order with unread count, ago, bounded preview; banner is loud', () => {
  const v = M.view(store0());
  assert.equal(v.fake, true);
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(v.rows.length, store0().messages.length);
  assert.equal(v.unread, v.rows.filter(r => !r.read).length);
  for (const r of v.rows) { assert.ok(r.preview.length <= M.MAX_PREVIEW); assert.match(r.ago, /^(ahora|hace )/); }
  assert.equal(v.open, null);
  const real = M.view(M.storeFromFrame({ ...M.fakeFrame(), fake: false }));
  assert.equal(real.banner, null);
  assert.equal(M.view(null), null);
});

test('openMessage: opens one message, marks it read; unknown ids change nothing', () => {
  const s = store0();
  const unreadId = s.messages.find(x => !x.read).id;
  const opened = M.openMessage(s, unreadId);
  assert.equal(opened.openId, unreadId);
  assert.equal(opened.messages.find(x => x.id === unreadId).read, true);
  assert.equal(s.messages.find(x => x.id === unreadId).read, false, 'the old store is untouched');
  const v = M.view(opened);
  assert.equal(v.open.id, unreadId);
  assert.equal(typeof v.open.body, 'string');
  assert.equal(v.unread, M.view(s).unread - 1);
  for (const bad of ['nope', '', '__proto__', 'constructor', null, undefined, 7]) assert.equal(M.openMessage(s, bad), null, String(bad));
  assert.equal(M.openMessage({}, unreadId), null);
});

test('closeMessage returns to the list and keeps the read state', () => {
  const s = store0();
  const id = s.messages[0].id;
  const closed = M.closeMessage(M.openMessage(s, id));
  assert.equal(closed.openId, null);
  assert.equal(closed.messages.find(x => x.id === id).read, true);
  assert.equal(M.closeMessage({}), null);
});

// ---- compose form model --------------------------------------------------------
test('createDraft: empty, frozen, three closed fields', () => {
  const d = M.createDraft();
  assert.deepEqual(d, { to: '', subject: '', body: '' });
  assert.ok(Object.isFrozen(d));
});

test('setField: closed fields, strings only, bounded; rejected input leaves the draft untouched', () => {
  const d = M.createDraft();
  const next = M.setField(d, 'to', 'ana@example.com');
  assert.equal(next.to, 'ana@example.com');
  assert.equal(d.to, '', 'immutable');
  for (const [f, v] of [['cc', 'x'], ['__proto__', 'x'], ['to', 5], ['to', null],
    ['to', 'x'.repeat(M.MAX_TO + 1)], ['subject', 'x'.repeat(M.MAX_SUBJECT + 1)], ['body', 'x'.repeat(M.MAX_BODY + 1)]]) {
    assert.equal(M.setField(d, f, v), null, `${f}`);
  }
  assert.equal(M.setField({ to: 1 }, 'to', 'a'), null, 'not a draft');
});

test('validateDraft: a good draft passes; each rule reports its own Spanish error', () => {
  assert.deepEqual(M.validateDraft(goodDraft()), { ok: true, errors: {} });
  const e = (over) => M.validateDraft({ ...goodDraft(), ...over });
  assert.equal(e({ to: '' }).errors.to, 'Falta el destinatario.');
  for (const bad of ['ana', 'ana@', '@example.com', 'a b@example.com', 'ana@example', 'a@b@c.com', 'ana@example.com, bob@example.com', 'ana@example.com\n']) {
    assert.equal(e({ to: bad }).errors.to, 'El destinatario no es una dirección válida.', JSON.stringify(bad));
  }
  assert.equal(e({ to: '  ana@example.com ' }).ok, true, 'surrounding spaces are forgiven');
  assert.equal(e({ subject: '   ' }).errors.subject, 'Falta el asunto.');
  assert.equal(e({ subject: 'a\nb' }).errors.subject, 'El asunto no admite saltos de línea ni caracteres de control.');
  assert.equal(e({ body: '  ' }).errors.body, 'Falta el mensaje.');
  assert.equal(e({ body: 'ok\nlínea\ttab' }).ok, true, 'the body keeps newlines and tabs');
  assert.equal(e({ body: 'a\u0000b' }).errors.body, 'El mensaje contiene caracteres de control.');
  const all = M.validateDraft(M.createDraft());
  assert.equal(all.ok, false);
  assert.deepEqual(Object.keys(all.errors).sort(), ['body', 'subject', 'to']);
  assert.equal(M.validateDraft(null).ok, false);
  assert.equal(M.validateDraft({ to: 1, subject: 2, body: 3 }).ok, false);
});

test('send is NOT wired: a valid draft is refused «no conectado», never a success, nothing changes', () => {
  const d = Object.freeze(goodDraft());
  const before = JSON.stringify(d);
  const r = M.send(d);
  assert.deepEqual(r, { ok: false, reason: 'not_connected', message: 'No conectado: el envío todavía no está disponible.' });
  assert.match(r.message, /no conectado/i);
  assert.equal(JSON.stringify(d), before);
  assert.ok(Object.isFrozen(r));
});

test('send: an invalid draft reports validation first, still never ok', () => {
  const r = M.send(M.createDraft());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
  assert.ok(r.errors.to && r.errors.subject && r.errors.body);
  assert.equal(M.send(null).ok, false);
  assert.equal(M.send(undefined).reason, 'invalid');
});

// ---- source hygiene ---------------------------------------------------------------
test('source: textContent only, no network, no window.open, no raw colours, mount inert', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-mail.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage|open_chat_url/);
  assert.match(src, /Datos de ejemplo/);
  assert.match(src, /getElementById\('integrations-mail'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /isTrusted !== true/, 'synthetic events never act');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/);
});

test('render (DOM-guarded): list, open message and compose form; invalid view hides the host', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  const s = store0();
  M.render(host, M.view(s), M.createDraft(), null);
  assert.equal(host.hidden, false);
  assert.ok(host.querySelector('.ml-fake').textContent.includes('datos de ejemplo'));
  assert.equal(host.querySelectorAll('.ml-row').length, s.messages.length);
  assert.ok(host.querySelector('form.ml-compose'));
  M.render(host, M.view(M.openMessage(s, s.messages[0].id)), M.createDraft(), null);
  assert.ok(host.querySelector('.ml-open'));
  M.render(host, null, M.createDraft(), null);
  assert.equal(host.hidden, true);
});

console.log(`integrations-mail-check: ${passed} checks ok`);
