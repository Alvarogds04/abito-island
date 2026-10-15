'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { engine, clock } = require('./character-harness.cjs');
const fs = require('node:fs');
const path = require('node:path');
const legacy = ['idle', 'listen', 'think', 'speak', 'reject', 'confirm', 'error'];
const added = ['working', 'searching', 'approval', 'question', 'finished', 'ratelimit', 'sleeping', 'dizzy'];
test('R7 adds eight states after the seven stable public names, without thinking alias', () => {
  const { api } = engine(); assert.equal(api.REVISION, 'R7');
  assert.deepEqual(Array.from(api.ORDER), [...legacy, ...added]);
  assert.equal(api.STATES.thinking, undefined);
});
for (const state of [...legacy, ...added]) test(`public setState/step/staticPose renders own clay and distinct ${state}`, () => {
  const { api, svg } = engine(); api.setManual(true); const inst = api.create(svg, { seed: 505 });
  inst.setState(state); const a = inst.step(120), b = inst.step(60);
  assert.equal(b.state, state); assert.notEqual(a.d, b.d); assert.equal(b.eyes.length, 2);
  assert.ok(b.pts.every(p => p.every(Number.isFinite))); inst.staticPose(state);
  const still = inst.sample(); assert.equal(still.state, state);
  inst.setState('not-a-state'); assert.equal(inst.state, state); // existing unknown-name behavior
  const stops = svg.children[0].children[0].children;
  assert.deepEqual(stops.map(e => e.attrs['stop-color']), ['#acdd96', '#8fcb78', '#78b562']);
  assert.equal(svg.children.length, 5, 'same defs/shadow/body/two eye groups, no appendages');
});
test('all R7 static states preserve identity and distinct eye/body poses under honored reduction', () => {
  const { api, svg } = engine(true); const inst = api.create(svg);
  const shapes = new Set();
  for (const state of api.ORDER) { inst.setState(state); const s = inst.sample(); shapes.add(s.d + JSON.stringify(s.eyes)); assert.equal(s.state, state); }
  assert.equal(shapes.size, 15); assert.equal(api.statusKind()[0], 'reduced');
});
test('existing pause, forced motion and hidden-page lifecycle keeps one shared frame loop', () => {
  const h = engine(true); h.api.create(h.svg); h.api.create(h.element()); assert.equal(h.pending(), 0);
  h.api.setForced(true); assert.equal(h.pending(), 1); h.frame(); h.frame(); assert.equal(h.api.frames, 2);
  h.api.setPaused(true); assert.equal(h.pending(), 0); h.frame(); assert.equal(h.api.frames, 2);
  h.api.setPaused(false); assert.equal(h.pending(), 1); h.hide(true); assert.equal(h.pending(), 0);
  h.hide(false); assert.equal(h.pending(), 1); h.api.setForced(false); assert.equal(h.pending(), 0);
});
function setup() {
  const api = require('../frontend/character-motion.js'); const h = engine(), time = clock();
  h.api.setManual(true); const clay = h.api.create(h.svg);
  let blocked = false;
  const c = api.create({ clay, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    blocked: () => blocked, validCard: card => card && card.valid === true,
    notification: snapshot => snapshot && snapshot.pending,
    choosePose: (chat, host) => chat === 'think' || chat === 'speak' ? chat : host || chat || 'idle' });
  return { c, clay, time, block(value) { blocked = value; c.motionChanged(); } };
}
test('public producer controller prioritizes typed live human requests, then legacy chat/host errors', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); c.chat('think'); assert.equal(clay.state, 'think');
  c.host('error'); assert.equal(clay.state, 'think'); c.chat(null); assert.equal(clay.state, 'error');
  c.question({ pending: { kind: 'question', expiresAt: 2000 } }); assert.equal(clay.state, 'question');
  c.snapshot({ card: { valid: true, state: 'pending', expires_at: '1970-01-01T00:00:03Z' }, notices: [] }); assert.equal(clay.state, 'approval');
  time.advance(3000); assert.equal(clay.state, 'error', 'local expiry releases attention without confirm/reject');
  for (const reason of ['Decisión enviada.', 'No se pudo confirmar la decisión.', 'Propuesta vencida.']) {
    c.snapshot({ card: { valid: true, state: 'inert', reason, expires_at: '1970-01-01T00:01:00Z' } }); assert.equal(clay.state, 'error');
  }
  c.host(null); c.chat('speak'); assert.equal(clay.state, 'speak'); c.destroy(); assert.equal(time.count(), 0);
});
test('finished means neutral new settled event only, deduped per session/id; no boot/churn/success', () => {
  const { c, clay, time } = setup(); const notice = (id, sessionId = 'one') => ({ id, sessionId, expiresAt: 60000 });
  c.snapshot({ notices: [notice('old')] }); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('old'), notice('new')] }); assert.equal(clay.state, 'finished');
  time.advance(1800); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('new'), notice('old')] }); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('new', 'two')] }); assert.equal(clay.state, 'finished');
  c.chat('think'); time.advance(100); c.chat(null); assert.equal(clay.state, 'idle', 'suppressed decoration is not replayed');
  c.snapshot({ notices: [notice('late')], card: { valid: true, state: 'pending', expires_at: '1970-01-01T00:01:00Z' } });
  assert.equal(clay.state, 'approval'); c.snapshot({ notices: [notice('late')] }); assert.equal(clay.state, 'idle');
  c.destroy();
});
test('sleep follows 60 s genuine idle, activity/pending/queued draft interrupt; paused/reduced never stale-replays', () => {
  const { c, clay, time, block } = setup(); c.snapshot({ notices: [] }); time.advance(59999); assert.equal(clay.state, 'idle');
  time.advance(1); assert.equal(clay.state, 'sleeping'); c.activity(); assert.equal(clay.state, 'idle');
  c.busy(true); time.advance(70000); assert.equal(clay.state, 'idle'); c.busy(false);
  time.advance(59999); assert.equal(clay.state, 'idle'); time.advance(1); assert.equal(clay.state, 'sleeping');
  c.activity(); block(true); time.advance(70000); assert.equal(clay.state, 'idle'); block(false);
  time.advance(1000); assert.equal(clay.state, 'idle'); c.destroy(); assert.equal(time.count(), 0);
});
test('far-future live card keeps approval through capped deadline and injected scheduler teardown', () => {
  const time = clock(), h = engine(); h.api.setManual(true); const clay = h.api.create(h.svg); const delays = [];
  const c = require('../frontend/character-motion.js').create({ clay, now: time.now,
    setTimer(fn, ms) { delays.push(ms); return time.setTimer(fn, ms); }, clearTimer: time.clearTimer,
    validCard: card => card && card.state === 'pending', notification: () => null, choosePose: () => 'idle' });
  c.snapshot({ card: { state: 'pending', expires_at: '2099-01-01T00:00:00Z' }, notices: [] });
  assert.equal(clay.state, 'approval'); assert.deepEqual(delays, [2147483647]); assert.equal(time.count(), 1);
  time.advance(2147483647); assert.equal(clay.state, 'approval'); assert.deepEqual(delays, [2147483647, 2147483647]);
  c.destroy(); assert.equal(time.count(), 0); time.advance(2147483647); assert.equal(clay.state, 'approval');
});

test('the live island wires host/question snapshots and inactivity to the public controller without native drag changes', () => {
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /AbitoCharacter\.create/); assert.match(island, /character\.snapshot\(snapshot\)/);
  assert.match(island, /characterListen\('question:state'/); assert.match(island, /character\.question/);
  assert.match(island, /character\.activity/); assert.match(island, /O\.choosePose\(chatPose, hostPose\)/);
});
