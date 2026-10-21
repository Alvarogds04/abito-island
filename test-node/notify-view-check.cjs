'use strict';
/* N6 — pure checks for frontend/notify-view.js (notifications with 1..N reply
   options; Pi questions QP/1 are one case). No DOM, no network, no audio.
   Contracts: docs/pi-question-roundtrip.md §2.4-§2.7, docs/desktop-visual-language.md
   §1.1/§2.2/§3, docs/desktop-sound-catalog.md §2-§3.
   Run: node apps/desktop-tauri/test-node/notify-view-check.cjs (also by cargo test). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'notify-view.js'));
let passed = 0;
const pendingTests = [];
const test = (name, fn) => { const r = fn(); if (r && typeof r.then === 'function') pendingTests.push(r.then(() => { passed += 1; })); else passed += 1; };

const ID = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const pending = (extra = {}) => ({ id: ID, kind: 'question', text: '¿Qué rama uso?', allow_free_text: false, expires_at: 2000000,
  options: [{ index: 0, label: 'main', description: '' }, { index: 1, label: 'develop', description: 'rama de integración' }], ...extra });
const snap = (p = null, extra = {}) => ({ available: true, pending: p, deliveries: [], ready_connections: 1, notice: null, native_transition: 'idle', ...extra });

// ---- model ---------------------------------------------------------------
test('model: a notification has 1..N reply options with 1-based keys; agent-agnostic with Pi as the only producer today', () => {
  const n = N.fromPending(pending());
  assert.equal(n.id, ID); assert.equal(n.kind, 'question'); assert.equal(n.agent, 'pi');
  assert.deepEqual(n.options.map(o => [o.index, o.key, o.label]), [[0, '1', 'main'], [1, '2', 'develop']]);
  assert.equal(n.options[1].description, 'rama de integración');
  assert.equal(n.allowFreeText, false); assert.equal(n.expiresAt, 2000000);
  // the generic model accepts 1 option (an acknowledgement) up to the wire cap, without inventing a producer
  assert.equal(N.fromPending(pending({ options: [{ index: 0, label: 'Entendido', description: '' }] })).options.length, 1);
  assert.equal(N.MAX_OPTIONS, 4);
  assert.equal(N.fromPending(pending({ options: Array.from({ length: 6 }, (_, i) => ({ index: i, label: `o${i}`, description: '' })) })).options.length, 4, 'never more than the QP/1 cap');
  assert.equal(N.fromPending(null), null);
  assert.equal(N.fromPending({}), null);
  assert.equal(N.fromPending(pending({ id: 'not-a-uuid' })), null, 'a malformed id never renders');
  const text = N.fromPending(pending({ options: [], allow_free_text: true }));
  assert.equal(text.options.length, 0); assert.equal(text.allowFreeText, true);
  assert.equal(N.fromPending(pending({ options: [], allow_free_text: false })), null, 'neither options nor free text is no notification');
});

test('approval kind: exactly two options, never free text (a Pi-session answer, NOT an Abito proposal approval)', () => {
  const ok = N.fromPending(pending({ kind: 'approval', options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] }));
  assert.equal(ok.kind, 'approval'); assert.equal(ok.approvesProposal, false);
  assert.equal(N.fromPending(pending({ kind: 'approval', options: [{ index: 0, label: 'Sí', description: '' }] })), null);
  assert.equal(N.fromPending(pending({ kind: 'approval', allow_free_text: true, options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] })), null);
});

// ---- keyboard ---------------------------------------------------------------
test('keyboard 1..N: a bare digit picks that option; modifiers, IME, repeats, typing and non-trusted events never do', () => {
  const n = N.fromPending(pending());
  const key = (k, extra = {}) => ({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, repeat: false, ...extra });
  assert.equal(N.optionForKey(n, key('1'), { typing: false }), 0);
  assert.equal(N.optionForKey(n, key('2'), { typing: false }), 1);
  assert.equal(N.optionForKey(n, key('3'), { typing: false }), -1, 'beyond N');
  assert.equal(N.optionForKey(n, key('0'), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('a'), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('1'), { typing: true }), -1, 'digits belong to the text field while typing');
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(N.optionForKey(n, key('1', { [mod]: true }), { typing: false }), -1, mod);
  assert.equal(N.optionForKey(n, key('1', { isTrusted: false }), { typing: false }), -1, 'synthetic events never answer');
  assert.equal(N.optionForKey(n, key('1', { isComposing: true }), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('1', { repeat: true }), { typing: false }), -1);
  assert.equal(N.optionForKey(null, key('1'), { typing: false }), -1);
  // Enter never submits an option on its own (nothing is preselected)
  assert.equal(N.optionForKey(n, key('Enter'), { typing: false }), -1);
});

test('trusted gate: only event.isTrusted === true reaches the host', () => {
  assert.equal(N.trusted({ isTrusted: true }), true);
  for (const bad of [{ isTrusted: false }, {}, null, undefined, { isTrusted: 'true' }, { isTrusted: 1 }]) assert.equal(N.trusted(bad), false);
});

// ---- expiry -------------------------------------------------------------------
test('expiry: short relative word, «Vencida» at/after the deadline, honest on junk', () => {
  const T = 1000000;
  assert.equal(N.expiryWord(T + 4 * 60000, T), '4 min');
  assert.equal(N.expiryWord(T + 30000, T), '<1 min');
  assert.equal(N.expiryWord(T + 90 * 60000, T), '2 h');
  assert.equal(N.expiryWord(T, T), 'Vencida');
  assert.equal(N.expiryWord(T - 1, T), 'Vencida');
  assert.equal(N.expiryWord('x', T), '');
  assert.equal(N.expired(T, T), true); assert.equal(N.expired(T + 1, T), false);
  assert.equal(N.fraction(T + 150000, T, 300000), 0.5);
  assert.equal(N.fraction(T + 600000, T, 300000), 1); assert.equal(N.fraction(T - 5, T, 300000), 0);
});

// ---- outcomes -----------------------------------------------------------------
test('outcomes: every host outcome has icon+word; «Enviada» is NEUTRAL (live plane, never go/check); only a producer ack is lime', () => {
  const all = ['busy', 'expired', 'disconnected', 'cancelled', 'sent', 'answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown'];
  for (const o of all) { const v = N.outcomeView(o); assert.ok(v && v.word && v.icon && v.tone && v.aria, o); }
  const sent = N.outcomeView('sent');
  assert.deepEqual([sent.word, sent.icon, sent.tone], ['Enviada', 'plane', 'live']);
  assert.notEqual(sent.tone, 'go'); assert.notEqual(sent.icon, 'check');
  for (const o of ['ack_lost', 'outcome_unknown']) { const v = N.outcomeView(o); assert.equal(v.word, 'Sin confirmar'); assert.equal(v.tone, 'red'); assert.equal(v.icon, 'triangle'); assert.equal(v.persistent, true); }
  assert.equal(N.outcomeView('rejected').persistent, true);
  assert.equal(N.outcomeView('answered').tone, 'go');
  assert.equal(N.outcomeView('answered').word, 'Recibida');
  for (const o of all.filter(x => x !== 'answered')) assert.notEqual(N.outcomeView(o).tone, 'go', `${o} must not look like success`);
  assert.equal(N.outcomeView('expired').word, 'Vencida');
  assert.equal(N.outcomeView('disconnected').word, 'Sin Pi');
  assert.equal(N.outcomeView('human_cancelled').word, 'Omitida');
  assert.equal(N.outcomeView('nope'), null); assert.equal(N.outcomeView(null), null);
});

// ---- sound cues (pure; no audio exists) ------------------------------------------
test('sound cues follow the catalog: attention on a NEW pending question, expired once; «Enviada»/«Sin confirmar» NEVER sound', () => {
  const none = snap(null);
  assert.equal(N.soundFor(none, snap(pending())), 'snd.attention');
  assert.equal(N.soundFor(snap(pending()), snap(pending())), null, 'same question: no repeat');
  assert.equal(N.soundFor(snap(pending({ id: ID })), snap(pending({ id: '4a2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2c' }))), 'snd.attention', 'a different question is new');
  assert.equal(N.soundFor(null, snap(pending())), null, 'nothing sounds at start-up (no previous snapshot)');
  assert.equal(N.soundFor(snap(pending()), snap(null, { notice: 'expired' })), 'snd.expired');
  assert.equal(N.soundFor(snap(null, { notice: 'expired' }), snap(null, { notice: 'expired' })), null, 'a persisting condition sounds once');
  for (const silent of ['sent', 'ack_lost', 'outcome_unknown', 'answered', 'human_cancelled', 'rejected', 'busy', 'disconnected', 'cancelled']) {
    assert.equal(N.soundFor(snap(pending()), snap(null, { notice: silent, deliveries: [{ id: ID, expires_at: 1, state: 'sent' }] })), null, `${silent} is silent`);
  }
  assert.equal(N.soundFor(snap(null, { notice: 'sent' }), snap(null, { notice: 'ack_lost' })), null);
  // the cue is only an id: playing it is a separate switch, ON by default and the human can turn it off
  assert.equal(N.SOUND_ENABLED_DEFAULT, true);
});

test('rate limit: at most one cue per 250 ms and the same cue once per 2 s; bursts are dropped, not queued', () => {
  const rl = N.createCueLimiter();
  assert.equal(rl.allow('snd.attention', 1000), true);
  assert.equal(rl.allow('snd.expired', 1100), false, '<250ms');
  assert.equal(rl.allow('snd.expired', 1300), true);
  assert.equal(rl.allow('snd.attention', 2500), false, 'same cue <2s');
  assert.equal(rl.allow('snd.attention', 3400), true);
  assert.equal(rl.allow(null, 9999), false);
});

// ---- view phases ------------------------------------------------------------------
test('phase: pending → sending (in flight) → sent (host delivery) → final outcome; nothing infers success', () => {
  assert.equal(N.phase(snap(pending()), { inFlight: false, now: 1 }).kind, 'pending');
  assert.equal(N.phase(snap(pending()), { inFlight: true, now: 1 }).kind, 'sending');
  const afterSend = snap(null, { deliveries: [{ id: ID, expires_at: 5, state: 'sent' }], notice: 'sent' });
  assert.equal(N.phase(afterSend, {}).kind, 'outcome'); assert.equal(N.phase(afterSend, {}).outcome.word, 'Enviada');
  assert.equal(N.phase(snap(null, { notice: 'answered' }), {}).outcome.word, 'Recibida');
  assert.equal(N.phase(snap(null), {}).kind, 'none');
  assert.equal(N.phase(null, {}).kind, 'none');
  assert.equal(N.phase({ available: false }, {}).kind, 'none');
  // pending always beats a stale notice
  assert.equal(N.phase(snap(pending(), { notice: 'ack_lost' }), { now: 1 }).kind, 'pending');
  // a local-clock expiry is shown as «Vencida» and the controls are dead
  const expired = N.phase(snap(pending({ expires_at: 1000 })), { now: 2000 });
  assert.equal(expired.kind, 'expired'); assert.equal(expired.controlsEnabled, false);
  assert.equal(N.phase(snap(pending()), { inFlight: true, now: 1 }).controlsEnabled, false, 'controls lock while a send is in flight');
  assert.equal(N.phase(snap(pending()), { now: 1 }).controlsEnabled, true);
  // the native barrier (a window transition in flight) disables answering without hiding the question
  assert.equal(N.phase(snap(pending(), { native_transition: 'native_transition_busy' }), { now: 1 }).controlsEnabled, false);
  assert.equal(N.phase(snap(pending(), { native_transition: 'native_transition_degraded' }), { now: 1 }).controlsEnabled, false);
});

// ---- free text ----------------------------------------------------------------------
test('free text: UTF-8 byte count, host budget is authoritative, empty/whitespace never sends, the word is one of the contract words', () => {
  assert.equal(N.utf8Bytes('abc'), 3); assert.equal(N.utf8Bytes('ñ'), 2); assert.equal(N.utf8Bytes('🙂'), 4);
  assert.equal(N.textWord({ allowed: true }, 'hola'), '');
  assert.equal(N.textWord({ allowed: false, reason: 'frame_too_large' }, 'x'), 'Muy largo');
  assert.equal(N.textWord({ allowed: false, reason: 'invalid_answer' }, 'x'), 'No válido');
  assert.equal(N.canSendText({ allowed: true }, 'hola'), true);
  assert.equal(N.canSendText({ allowed: true }, '   '), false);
  assert.equal(N.canSendText({ allowed: true }, ''), false);
  assert.equal(N.canSendText({ allowed: false, reason: 'frame_too_large' }, 'x'), false);
  assert.equal(N.canSendText(null, 'hola'), false, 'no budget answer yet: the host must say yes first');
});

// ---- markup / wiring contract -----------------------------------------------------------
test('markup: icon-only controls are named, «Omitir» keeps its WORD, options keep their LABEL (decisions are never icon-only)', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="notify-view\.js"><\/script>/);
  assert.match(html, /<script defer src="notify\.js"><\/script>/);
  assert.match(html, /id="question"[^>]*aria-label="Pi pregunta"/);
  assert.match(html, /id="question-skip"[^>]*>[\s\S]*?<span class="btn-word">Omitir<\/span>/);
  assert.match(html, /id="question-send"[^>]*aria-label="[^"]{3,}"/);
  assert.match(html, /id="question-text"[^>]*maxlength="/);
  assert.match(html, /placeholder="Escribí…"/);
});
test('wiring: only trusted events call question_action; no timer, rule or model output ever answers', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.trusted\(event\)/);
  assert.match(src, /question_action/);
  // every answering call sits behind the trusted gate: no `answer` action outside a handler that checks it
  const calls = [...src.matchAll(/action:\s*'(answer|text|decline)'/g)];
  assert.ok(calls.length >= 3);
  assert.doesNotMatch(src, /setTimeout\([^)]*(answer|decline|send)/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'question text is never persisted');
  assert.doesNotMatch(src, /innerHTML\s*=\s*[^;]*(q\.|pending|text|label|description)/, 'plain text only');
  assert.doesNotMatch(src, /new Audio|AudioContext|\.play\(/, 'silence: no audio exists yet');
});

test('R6 shrinks like with a card while a notification is on screen (never covers the options)', () => {
  const island = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(island, /questionShown \? \{ \.\.\.OVERVIEW_CARD, cy: [^}]*\} : cardShown \? OVERVIEW_CARD : OVERVIEW/, 'both a card and a question use the small character; the question centres lower in its 200px island (S10)');
  assert.match(island, /'abito:question'/);
  const notify = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(notify, /show: !!capsule\.dataset\.question/);
});

test('layout: head row carries expiry + text + Omitir; Omitir exists only while something is pending', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const head = /<div id="question-head">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(head.indexOf('question-expiry') < head.indexOf('question-body') && head.indexOf('question-body') < head.indexOf('question-skip'));
  assert.match(fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8'), /skipEl\.hidden = !n;/);
});

test('snd.expired: a SECOND expiry fires even when the old «expired» notice is retained; an unrelated update never re-fires', () => {
  assert.equal(N.soundFor(snap(pending(), { notice: 'expired' }), snap(null, { notice: 'expired' })), 'snd.expired');
  assert.equal(N.soundFor(snap(null, { notice: 'expired' }), snap(null, { notice: 'expired' })), null);
});

test('onScreen: only expanded + overview + no covering card', () => {
  assert.equal(N.onScreen({ phase: 'expanded', view: 'overview', card: undefined }), true);
  for (const d of [{ phase: 'compact', view: 'overview' }, { phase: 'expanding', view: 'overview' }, { phase: 'expanded', view: 'chat' },
    { phase: 'expanded', view: 'overview', card: 'pending' }, {}, null]) assert.equal(N.onScreen(d), false, JSON.stringify(d));
});

// ---- BEHAVIOUR: run the real notify.js against a tiny fake DOM --------------------------------
function harness(dataset) {
  const vm = require('node:vm');
  const calls = [];
  const listeners = {};
  const node = (id) => {
    const n = { id, dataset: {}, hidden: false, inert: true, disabled: false, value: '', textContent: '', title: '', children: [],
      listeners: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null; }, append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      querySelectorAll() { return []; }, requestSubmit() {}, blur() {}, focus() {}, innerHTML: '' };
    Object.defineProperty(n, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = v; if (v === '') this.children = []; } });
    return n;
  };
  const ids = ['question', 'capsule', 'question-body', 'question-options', 'question-freeform', 'question-text', 'question-word', 'question-send',
    'question-skip', 'question-live', 'question-expiry', 'question-state', 'question-expiry-word', 'question-state-icon', 'question-state-word'];
  const nodes = Object.fromEntries(ids.map(id => [id, node(id)]));
  Object.assign(nodes.capsule.dataset, dataset);
  const doc = { getElementById: id => nodes[id] || null, createElement: tag => node(tag), addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent() {}, activeElement: { tagName: 'OL' } };
  const win = { AbitoNotify: N, AbitoIcons: { svg: () => '' }, __TAURI__: { core: { invoke: (name, args) => { calls.push(args.payload); return Promise.resolve(args.payload.action === 'view' ? view : {}); } } } };
  const view = snap(pending({ expires_at: Date.now() + 120000 }));
  const ctx = vm.createContext({ window: win, document: doc, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: f => f(), MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, Date });
  vm.runInContext(fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8'), ctx);
  return { calls, nodes, key: (k, extra) => { for (const f of listeners.keydown || []) f({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, preventDefault() {}, ...extra }); } };
}
const settle = () => new Promise(r => setImmediate(r));

test('BEHAVIOUR: a real digit answers ONLY while the notification is on screen (chat open / compact / card covering / mid-transition → never)', async () => {
  const cases = [
    [{ phase: 'expanded', view: 'overview' }, true],
    [{ phase: 'expanded', view: 'chat' }, false],
    [{ phase: 'compact', view: 'overview' }, false],
    [{ phase: 'expanding', view: 'overview' }, false],
    [{ phase: 'expanded', view: 'overview', card: 'pending' }, false],
  ];
  const results = [];
  for (const [dataset, expected] of cases) {
    const h = harness(dataset);
    await settle(); await settle();
    h.nodes.question.inert = !expected ? h.nodes.question.inert : h.nodes.question.inert; // the guard must NOT rely on inert alone
    h.nodes.question.inert = false; // worst case: inert says «live»
    h.key('1');
    await settle();
    const answered = h.calls.some(c => c.action === 'answer');
    results.push([JSON.stringify(dataset), answered]);
    assert.equal(answered, expected, `${JSON.stringify(dataset)} -> answered=${answered}`);
  }
  // typing / modifiers / untrusted never answer even when visible
  for (const extra of [{ isTrusted: false }, { ctrlKey: true }, { repeat: true }]) {
    const h = harness({ phase: 'expanded', view: 'overview' }); await settle(); await settle(); h.nodes.question.inert = false;
    h.key('1', extra); await settle();
    assert.equal(h.calls.some(c => c.action === 'answer'), false, JSON.stringify(extra));
  }
});

test('BEHAVIOUR: the visible-only rule is checked on EVERY answering path (source)', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  for (const fn of ['function choose', 'function decline', 'function submitText']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 400);
    assert.match(body, /onScreen\(\)/, fn);
  }
  assert.match(src, /root\.inert \|\| !onScreen\(\)/);
});

// ---- P1: who is asking ---------------------------------------------------
test('agent: no field = Pi; a valid slug names the asker; a bad one never reaches the screen', () => {
  assert.equal(N.fromPending(pending()).agent, 'pi');
  assert.equal(N.askedBy(N.fromPending(pending())), 'Pi pregunta');
  const cc = N.fromPending(pending({ agent: 'claude-code', agent_label: 'Claude Code' }));
  assert.equal(cc.agent, 'claude-code');
  assert.equal(N.askedBy(cc), 'Claude Code pregunta');
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'codex', agent_label: 'Codex' }))), 'Codex pregunta');
  // the label is never trusted blindly: derived from the slug when missing or off
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'opencode' }))), 'OpenCode pregunta');
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'gemini-cli' }))), 'Gemini Cli pregunta');
  for (const bad of ['Claude Code', '', '<b>x</b>', 'a'.repeat(33), 7, null, {}, '../x', 'x\ny']) {
    const n = N.fromPending(pending({ agent: bad, agent_label: '<img src=x>' }));
    assert.equal(n.agent, 'pi', `a bad agent falls back to the safe default: ${JSON.stringify(bad)}`);
    assert.equal(N.askedBy(n), 'Pi pregunta');
  }
  // a hostile label next to a good slug is ignored (the label comes from the slug)
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'codex', agent_label: '<script>x</script>' }))), 'Codex pregunta');
});

test('agent: the screen reader and title use the asker, written with textContent only', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.askedBy\(n\)|askedBy\(n\)/, 'the live-region announcement names the asker');
  assert.doesNotMatch(src, /say\(`Pi pregunta/, 'no hardcoded Pi in the announcement');
  // innerHTML is only for our own static icons: never for the asker or the question text
  assert.doesNotMatch(src, /innerHTML[^\n]*(askedBy|agent|\.text\b)/);
});

Promise.all(pendingTests).then(() => console.log(`notify-view-check: ${passed} passed`), e => { console.error(e); process.exit(1); });

// ---- S3: «Agente · proyecto» and «1 de N» ---------------------------------
test('S3 askerLine: agent and project name, the project only when it is a well-formed name', () => {
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex', project_name: 'proyecto-beta' }))), 'Codex · proyecto-beta');
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'claude-code', project_name: 'workspace' }))), 'Claude Code · workspace');
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex' }))), 'Codex', 'no project name: just the agent');
  for (const bad of ['', ' x', 'x ', 'a/b', '<img src=x>', 'x'.repeat(65), 7, null, {}, 'x\ny']) {
    assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex', project_name: bad }))), 'Codex', `bad project: ${JSON.stringify(bad)}`);
  }
});
test('S3 queueLabel: «1 de N» only while others wait behind the shown question', () => {
  const snap = (queued_count, extra = {}) => ({ pending: pending(), queued_count, ...extra });
  assert.equal(N.queueLabel(snap(0)), '');
  assert.equal(N.queueLabel(snap(1)), '1 de 2');
  assert.equal(N.queueLabel(snap(7)), '1 de 8');
  for (const bad of [undefined, null, -1, 1.5, '3', NaN, 99]) assert.equal(N.queueLabel(snap(bad)), '', JSON.stringify(bad));
  assert.equal(N.queueLabel(null), '');
  assert.equal(N.queueLabel({ pending: null, queued_count: 3 }), '', 'nothing shown, nothing to count');
});
test('S3 wiring: the island paints the asker line and the queue label with textContent', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /askerName\.textContent = N\.askerLine\(n\)/);
  assert.match(src, /queueEl\.textContent = N\.queueLabel\(snapshot\)/);
  assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /id="question-queue"/);
});
