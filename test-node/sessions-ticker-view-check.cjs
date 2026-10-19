'use strict';
/* #360 — pure checks for frontend/sessions-ticker.js (the live agent sessions
   ticker: pure view-model + browser-only mount; Node exercises the pure API). No DOM, no network, no IPC. The view is a CLOSED projection
   of the daemon's `sessions` frame: kind/state labels and plain text rows in
   Spanish (rioplatense voseo), ready to render with textContent only.
   Run: node apps/desktop-tauri/test-node/sessions-ticker-view-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const T = require(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'));

let passed = 0; const async = [];
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') async.push(r.then(() => { passed += 1; })); else passed += 1; }
  catch (e) { console.error(`FAIL ${name}`); throw e; }
}

const row = (over = {}) => ({ id: 's-0123abcd', kind: 'pi', cwd: 'mi-proyecto', state: 'sleeping', origin: 'herdr', ...over });
const frame = (over = {}) => ({ type: 'sessions', schema: 'abito-sessions/view/1', sessions: [row()], truncated: false, ...over });

// ---- model -------------------------------------------------------------------
test('the frame maps to a ready view with closed labels', () => {
  const v = T.sessionsView(frame());
  assert.equal(v.state, 'ready');
  assert.equal(v.truncated, false);
  assert.deepEqual(v.rows, [{ id: 's-0123abcd', kindLabel: 'Pi', cwd: 'mi-proyecto', stateLabel: 'inactiva', origin: 'herdr', text: 'Pi · mi-proyecto · inactiva · en herdr' }]);
});

test('the closed vocabularies: kinds and states label in Spanish; unknown rows never render', () => {
  const kinds = frame({ sessions: [
    row({ kind: 'pi' }), row({ kind: 'claude-code' }), row({ kind: 'codex' }), row({ kind: 'opencode' }), row({ kind: 'gemini' }),
  ] });
  assert.deepEqual(T.sessionsView(kinds).rows.map(r => r.kindLabel), ['Pi', 'Claude Code', 'Codex', 'OpenCode', 'Gemini']);
  // an off-table kind is dropped, never invented a label for
  assert.equal(T.sessionsView(frame({ sessions: [row({ kind: 'bash' })] })).rows.length, 0);
  const states = frame({ sessions: [
    row({ state: 'running' }), row({ state: 'sleeping' }), row({ state: 'stopped' }), row({ state: 'zombie' }), row({ state: 'unknown' }),
  ] });
  assert.deepEqual(T.sessionsView(states).rows.map(r => r.stateLabel), ['ejecutando', 'inactiva', 'detenida', 'zombi', 'desconocida']);
});

test('a malformed frame is refused; malformed rows are dropped, never half-rendered', () => {
  assert.equal(T.sessionsView(null), null);
  assert.equal(T.sessionsView({ type: 'error', code: 'failed' }), null);
  assert.equal(T.sessionsView({ type: 'sessions', schema: 'other', sessions: [], truncated: false }), null, 'a foreign schema is not ours');
  assert.equal(T.sessionsView(frame({ sessions: 'x' })), null);
  assert.equal(T.sessionsView(frame({ truncated: 'yes' })), null);
  // one bad row never hides the good ones: vocabulary rows are dropped per row,
  // and a text cell that arrives dirty is sanitized to the honest «—»
  const mixed = T.sessionsView(frame({ sessions: [row({ id: 7 }), row(), row({ state: 'dancing' }), row({ cwd: '/full/path' })] }));
  assert.equal(mixed.rows.length, 2, 'the two rows with a known id/kind/state survive');
  assert.deepEqual(mixed.rows.map(r => r.text), ['Pi · mi-proyecto · inactiva · en herdr', 'Pi · — · inactiva · en herdr']);
  // a frame with only bad rows is a valid, EMPTY view: render() then hides it
  assert.equal(T.sessionsView(frame({ sessions: [row({ id: 'nope' })] })).rows.length, 0);
});

test('row text: segments join with ·; unknown cwd shows —; a null origin omits the segment', () => {
  assert.equal(T.sessionsView(frame({ sessions: [row({ cwd: null })] })).rows[0].text, 'Pi · — · inactiva · en herdr');
  assert.equal(T.sessionsView(frame({ sessions: [row({ origin: null })] })).rows[0].text, 'Pi · mi-proyecto · inactiva');
  assert.equal(T.sessionsView(frame({ sessions: [row({ cwd: null, origin: null })] })).rows[0].text, 'Pi · — · inactiva');
});

test('caps: at most 64 rows render; truncation carries the bounded-list copy', () => {
  const many = frame({ sessions: Array.from({ length: 70 }, (_, i) => row({ id: `s-${String(i).padStart(8, '0')}` })), truncated: true });
  const v = T.sessionsView(many);
  assert.equal(v.rows.length, 64);
  assert.equal(v.truncated, true);
  assert.match(T.boundedText(v), /más/i);
  assert.equal(T.boundedText(T.sessionsView(frame())), null);
});

test('error copy: one honest Spanish line for an unavailable view', () => {
  assert.match(T.errorText(), /no disponibles/);
});

test('render is DOM-guarded: no rows clears and hides; rows are textContent-only', () => {
  if (typeof document === 'undefined') return; // pure Node run: the DOM path runs under cargo test / browser
  const host = document.createElement('div');
  T.render(host, T.sessionsView(frame()));
  assert.equal(host.children.length, 1);
  assert.equal(host.firstChild.textContent, 'Pi · mi-proyecto · inactiva · en herdr');
  assert.equal(host.style.display, '', 'visible with rows');
  T.render(host, { state: 'ready', rows: [], truncated: false });
  assert.equal(host.children.length, 0);
  assert.equal(host.style.display, 'none', 'zero layout space without sessions');
});

// ---- the feed of Coucou's Ticker (S10) ------------------------------------------
test('feed: a session that appears is one step; the same list again adds nothing; stepSeq is the newest step index', () => {
  const m = T.newMemory();
  const v1 = T.sessionsView(frame());
  let r = T.feed(m, v1);
  assert.equal(r.active, true);
  assert.deepEqual(r.task, { steps: ['Pi · mi-proyecto · inactiva · en herdr'], stepSeq: 0, finalLine: null });
  r = T.feed(m, v1);
  assert.equal(r.task.steps.length, 1, 'unchanged list: no new step');
  const v2 = T.sessionsView(frame({ sessions: [row(), row({ id: 's-0123abce', kind: 'codex', cwd: 'otro', state: 'running', origin: null })] }));
  r = T.feed(m, v2);
  assert.deepEqual([r.task.steps.length, r.task.stepSeq], [2, 1]);
  assert.equal(r.task.steps[1], 'Codex · otro · ejecutando');
});

test('feed: no sessions hides the ticker and forgets the history; an error is shown once; bounded lists say so once', () => {
  const m = T.newMemory();
  T.feed(m, T.sessionsView(frame()));
  const none = T.feed(m, T.sessionsView(frame({ sessions: [] })));
  assert.deepEqual([none.active, none.task], [false, null]);
  assert.deepEqual([m.log.length, m.seq], [0, 0]);
  const e1 = T.feed(m, { state: 'error' }), e2 = T.feed(m, { state: 'error' });
  assert.equal(e1.active, true);
  assert.deepEqual(e2.task.steps, ['Sesiones no disponibles'], 'one line, not one per poll');
  const b = T.newMemory();
  T.feed(b, T.sessionsView(frame({ truncated: true })));
  const again = T.feed(b, T.sessionsView(frame({ truncated: true })));
  assert.equal(again.task.steps.filter(x => x === T.boundedText({ state: 'ready', truncated: true })).length, 1);
});

test('feed: the log is capped at 20 steps and stepSeq keeps counting', () => {
  const m = T.newMemory();
  let r;
  for (let i = 0; i < 25; i++) r = T.feed(m, T.sessionsView(frame({ sessions: [row({ cwd: `p${i}` })] })));
  assert.equal(r.task.steps.length, 20); assert.equal(r.task.stepSeq, 24);
});

test('wiring: the mount feeds Coucou\'s Ticker through a dynamic import of the vendored module', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'), 'utf8');
  assert.match(src, /import\('\.\/vendor\/coucou\/views\/ticker\.js'\)/);
  assert.doesNotMatch(src, /position:fixed/);
});

test('poll opens the lazy connection and treats an unanswered scan as pending, not unavailable', async () => {
  const calls = [];
  let sessions = null;
  const invoke = async (command, { payload }) => {
    assert.equal(command, 'agent_action');
    calls.push(payload.action);
    if (payload.action === 'sessions_list') assert.equal(calls.at(-2), 'view');
    return { connection: 'connected', sessions };
  };
  const pending = await T.requestSessions(invoke);
  assert.equal(pending.state, 'pending');
  assert.equal(T.feed(T.newMemory(), pending).active, false);
  sessions = { rows: [row()], truncated: false };
  assert.equal((await T.requestSessions(invoke)).rows[0].cwd, 'mi-proyecto');
  sessions = { rows: [], truncated: false };
  assert.equal(T.feed(T.newMemory(), await T.requestSessions(invoke)).active, false);
  assert.deepEqual(await T.requestSessions(async () => ({ connection: 'disconnected', sessions: null })), { state: 'error' });
});

// ---- tiny harness result (functions defined above) -----------------------------
Promise.all(async).then(() => { console.log(`sessions-ticker-view-check: ${passed} checks ok`); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
