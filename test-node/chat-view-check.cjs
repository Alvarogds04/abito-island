'use strict';
/* U1 — pure checks for frontend/chat-view.js (no DOM, no network).
   Run: node apps/desktop-tauri/test-node/chat-view-check.cjs
   Also run by `cargo test` (tests/frontend_chat_view.rs). */
const assert = require('node:assert/strict');
const path = require('node:path');
const V = require(path.join(__dirname, '..', 'frontend', 'chat-view.js'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

test('state labels are the contract states, in Spanish', () => {
  assert.equal(V.stateLabel('queued'), 'En cola');
  assert.equal(V.stateLabel('thinking'), 'Pensando…');
  assert.equal(V.stateLabel('streaming'), 'Escribiendo…');
  assert.equal(V.stateLabel('waiting_approval'), 'Esperando aprobación');
  assert.equal(V.stateLabel('completed'), 'Respondió');
  assert.equal(V.stateLabel('cancelled'), 'Cancelado');
  assert.equal(V.stateLabel('error'), 'Error');
  assert.equal(V.stateLabel('nope'), '');
});

test('draft problems mirror the Rust validation', () => {
  assert.equal(V.draftProblem('hola'), null);
  assert.match(V.draftProblem('  \n '), /vacío/);
  assert.equal(V.draftProblem('ñ'.repeat(8000)), null);
  assert.match(V.draftProblem('a'.repeat(8001)), /8\.000/);
  assert.match(V.draftProblem('a\u0000b'), /control/);
  assert.equal(V.draftProblem('a\nb\tc'), null);
  assert.equal(V.scalarCount('😀ñ'), 2);
});

test('send is enabled only with an available model, no active turn and a valid draft', () => {
  const ready = { availability: { state: 'ready' }, active_turn: null };
  assert.equal(V.canSend(ready, 'hola', false), true);
  assert.equal(V.canSend({ ...ready, availability: { state: 'busy' } }, 'hola', false), true);
  for (const state of ['unavailable', 'blocked', 'unchecked']) {
    assert.equal(V.canSend({ ...ready, availability: { state } }, 'hola', false), false, state);
  }
  assert.equal(V.canSend({ ...ready, active_turn: 't-1' }, 'hola', false), false);
  assert.equal(V.canSend(ready, '   ', false), false);
  assert.equal(V.canSend(ready, 'hola', true), false); // a submit is in flight
  assert.equal(V.canSend(null, 'hola', false), false);
});

test('status line: active turn first, then availability, never a guess', () => {
  const view = {
    active_turn: 't-2', queue_note: 'en su cola',
    turns: [{ turn_id: 't-2', state: 'thinking' }],
    availability: { state: 'ready', message: 'Modelo local listo.' },
  };
  assert.equal(V.statusLine(view), 'Pensando… · en su cola');
  assert.equal(V.statusLine({ ...view, active_turn: null, queue_note: null }), 'Modelo local listo.');
  assert.equal(V.statusLine(null), 'Chat no disponible.');
});

test('announcements are per state change and completed turn, never per token', () => {
  const t = (state, reply = '', extra = {}) => ({ turn_id: 't-1', state, reply, ...extra });
  const v = turn => ({ active_turn: turn.state === 'completed' || turn.state === 'error' ? null : 't-1', turns: [turn] });
  assert.equal(V.announcement(v(t('queued')), v(t('thinking'))), 'Pensando…');
  assert.equal(V.announcement(v(t('streaming', 'Ho')), v(t('streaming', 'Hola'))), null);
  assert.equal(V.announcement(v(t('streaming', 'Hola')), v(t('completed', 'Hola'))), 'Abito respondió: Hola');
  assert.equal(
    V.announcement(v(t('thinking')), v(t('error', '', { error: { safe_message: 'El modelo local no responde.' } }))),
    'El modelo local no responde.');
  const long = 'x'.repeat(500);
  assert.ok(V.announcement(v(t('streaming', long)), v(t('completed', long))).length < 330);
  assert.equal(V.announcement(null, v(t('queued'))), 'En cola');
});

test('scroll pins only when the reader is already at the bottom', () => {
  assert.equal(V.atBottom(0, 100, 100), true);
  assert.equal(V.atBottom(296, 400, 100), true);
  assert.equal(V.atBottom(200, 400, 100), false);
});

test('request ids are bounded tokens the Rust gate accepts', () => {
  const id = V.newRequestId(new Uint8Array([0, 1, 2, 255, 16, 32, 64, 128]));
  assert.equal(id, 'req-000102ff10204080');
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
});

test('turn rows render plain text roles and truncation/trim notes', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: '<b>hola</b>', reply: 'chau',
    finish_reason: 'limit', trimmed_turns: 2, error: null,
  });
  assert.deepEqual(rows.map(r => r.kind), ['user', 'note', 'assistant', 'note']);
  assert.equal(rows[0].text, '<b>hola</b>'); // rendered with textContent, never HTML
  assert.match(rows[1].text, /2 mensajes anteriores/);
  assert.match(rows[3].text, /límite/);
  const failed = V.turnRows({ turn_id: 't-2', state: 'error', user_text: 'x', reply: '', error: { safe_message: 'No disponible.' }, trimmed_turns: 0 });
  assert.deepEqual(failed.map(r => r.kind), ['user', 'error']);
  const cancelled = V.turnRows({ turn_id: 't-3', state: 'cancelled', user_text: 'x', reply: 'me', trimmed_turns: 0 });
  assert.match(cancelled[cancelled.length - 1].text, /Cancelado/);
});


// ---- U2: model picker helpers ---------------------------------------------
test('model rows are visible metadata, never "listed" mistaken for "ready"', () => {
  const rows = V.modelRows({
    selected: 'local-abito-gpt',
    profiles: [
      { profile_id: 'local-abito-gpt', origin: 'http://127.0.0.1:11002', alias: 'Abito-gpt', selectable: true,
        gate: { state: 'ready', message: 'Cargado y libre · contexto 65536 tokens.' },
        context_tokens: 65536, max_output_tokens: 1024, size_bytes: 18198045184, params: 35505251456,
        quantization: 'IQ4_XS - 4.25 bpw', vision: false },
      { profile_id: 'diag-11014', origin: 'http://127.0.0.1:11014', alias: null, selectable: false,
        gate: { state: 'unknown', message: 'Responde 404…' } },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].selected, true);
  assert.equal(rows[0].selectable, true);
  assert.equal(rows[0].title, 'Abito-gpt');
  assert.match(rows[0].facts, /127\.0\.0\.1:11002/);
  assert.match(rows[0].facts, /contexto 65\.536/);
  assert.match(rows[0].facts, /salida ≤1\.024/);
  assert.match(rows[0].facts, /18,2 GB/);
  assert.match(rows[0].facts, /35,5 mil millones/);
  assert.match(rows[0].facts, /sin visión/);
  assert.equal(rows[0].state, 'Listo');
  assert.equal(rows[1].selectable, false);
  assert.equal(rows[1].title, 'Puerto 11014');
  assert.equal(rows[1].state, 'Desconocido');
});

test('UI.2 model rows: chips carry numbers, one word only for non-ready gates, full sentence in aria', () => {
  const ready = { profile_id: 'local-abito-gpt', origin: 'http://127.0.0.1:11002', alias: 'Abito-gpt', selectable: true,
    gate: { state: 'ready', message: 'Cargado y libre.' }, context_tokens: 65536, size_bytes: 18198045184,
    params: 35505251456, vision: false };
  const [r, n, d] = V.modelRows({ selected: 'local-abito-gpt', profiles: [ready,
    { ...ready, profile_id: 'x', alias: 'Otro', gate: { state: 'needs_load', message: 'm' } },
    { profile_id: null, origin: 'http://127.0.0.1:11014', alias: null, selectable: false, gate: { state: 'unavailable', message: 'caído' } }] });
  assert.deepEqual(r.chips.map(c => c.text), ['local', '64k', '18,2 GB', '35,5B', '']);
  assert.equal(r.chips[4].icon, 'eye-off');
  assert.equal(r.word, ''); assert.equal(r.tone, 'go');
  assert.match(r.aria, /127\.0\.0\.1:11002/);
  assert.equal(n.word, 'Sin cargar'); assert.equal(n.wordIcon, 'load-off');
  assert.equal(d.word, 'No disponible'); assert.equal(d.tone, 'red'); assert.equal(d.title, 'Puerto 11014');
});

test('UI.2 meters: used share, numbers only in aria, unknown stays honest', () => {
  const m = V.modelMeters({ resources: { mem_total: 100e9, mem_available: 25e9, gpu: { vram_total: 10e9, vram_used: 5e9, gtt_total: 20e9, gtt_used: 0 } } });
  assert.deepEqual(m.map(x => x.key), ['ram', 'vram', 'gtt']);
  assert.equal(m[0].fraction, 0.75);
  assert.match(m[0].aria, /RAM: 75,0 GB en uso de 100,0 GB/);
  const u = V.modelMeters({ resources: { mem_total: null, mem_available: null, gpu: null } });
  assert.ok(u.every(x => !x.known && /desconocida/.test(x.aria)));
  assert.equal(V.modelsCount({ profiles: [{ selectable: true, profile_id: 'a' }, { selectable: false }] }), 1);
});

test('gate state labels distinguish ready, queue, needs_load, unknown, unavailable', () => {
  assert.equal(V.gateLabel('ready'), 'Listo');
  assert.equal(V.gateLabel('queue'), 'En cola');
  assert.equal(V.gateLabel('needs_load'), 'Requiere cargarlo (Abito no lo hace)');
  assert.equal(V.gateLabel('unknown'), 'Desconocido');
  assert.equal(V.gateLabel('unavailable'), 'No disponible');
});

// ---- Q1: notices live region -----------------------------------------------
test('a notice is announced once, when a NEW one arrives, as text only', () => {
  const n = (id, title, detail) => ({ id, sessionId: 's', title, detail });
  assert.equal(V.noticeAnnouncement(null, [n('e1', 'Pi terminó su turno', 'Detalle')]),
    'Aviso: Pi terminó su turno. Detalle');
  assert.equal(V.noticeAnnouncement('e1', [n('e1', 'Pi terminó su turno', 'Detalle')]), null);
  assert.equal(V.noticeAnnouncement('e1', [n('e2', 'Otro', '')]), 'Aviso: Otro.');
  assert.equal(V.noticeAnnouncement('e1', []), null); // dismissal is not announced
  assert.equal(V.noticeAnnouncement(null, null), null);
});

test('compact island keyboard activation: Enter and Space only', () => {
  assert.equal(V.activates({ key: 'Enter' }), true);
  assert.equal(V.activates({ key: ' ' }), true);
  assert.equal(V.activates({ key: 'Enter', isComposing: true }), false);
  assert.equal(V.activates({ key: 'a' }), false);
  assert.equal(V.activates({ key: 'Enter', repeat: true }), false);
});

console.log(`chat-view-check: ${passed} passed`);
