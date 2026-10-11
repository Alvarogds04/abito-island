'use strict';
/* U1 — pure checks for frontend/chat-view.js (no DOM, no network).
   Run: node apps/desktop-tauri/test-node/chat-view-check.cjs
   Also run by `cargo test` (tests/frontend_chat_view.rs). */
const fs = require('node:fs');
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

test('UI.2 chat status: a word only for problems; shapes carry the rest', () => {
  const base = { turns: [], active_turn: null, queue_note: null };
  const v = (state, msg) => V.statusView({ ...base, availability: { state, message: msg || '' } });
  assert.deepEqual([v('ready').kind, v('ready').word, v('ready').tone], ['ready', '', 'go']);
  assert.equal(v('unavailable', 'El modelo local no responde').word, 'Modelo caído');
  assert.equal(v('unavailable', 'x').tone, 'red');
  assert.equal(v('blocked').word, 'Bloqueado');
  assert.equal(v('busy').word, 'Ocupado');
  assert.equal(v('unchecked').icon, 'ring');
  assert.match(v('unavailable', 'El modelo local no responde').aria, /no responde/);
  const turn = state => ({ turn_id: 't', state, user_text: 'x', reply: '', trimmed_turns: 0 });
  const act = state => V.statusView({ turns: [turn(state)], active_turn: 't', availability: { state: 'ready', message: '' } });
  assert.equal(act('thinking').icon, 'ring');
  assert.equal(act('streaming').tone, 'live');
  assert.equal(act('waiting_approval').tone, 'sun');
  assert.equal(act('queued').icon, 'clock');
  assert.equal(V.statusView(null).word, 'Modelo caído');
});

test('UI.2 composer: one visible word for draft problems, none for empty', () => {
  assert.equal(V.draftWord('a'.repeat(8001)), 'Muy largo');
  assert.equal(V.draftWord('hola\u0001'), 'Caracteres no válidos');
  assert.equal(V.draftWord(''), '');
  assert.equal(V.draftWord('   '), '');
});

test('UI.2 rows: short word + icon, full text kept for aria', () => {
  const rows = V.turnRows({ turn_id: 't', state: 'cancelled', user_text: 'x', reply: 'me', trimmed_turns: 2, finish_reason: 'limit' });
  assert.equal(rows.find(r => r.short === 'Recortado').icon, 'info');
  const cut = V.turnRows({ turn_id: 't', state: 'completed', user_text: 'x', reply: 'r', trimmed_turns: 0, finish_reason: 'limit' });
  assert.equal(cut[cut.length - 1].short, 'Cortado por largo');
  const can = V.turnRows({ turn_id: 't', state: 'cancelled', user_text: 'x', reply: 'r', trimmed_turns: 0 });
  assert.equal(can[can.length - 1].short, 'Cancelado');
  const err = V.turnRows({ turn_id: 't', state: 'error', user_text: 'x', reply: '', error: { safe_message: 'Sin modelo.' }, trimmed_turns: 0 });
  assert.equal(err[err.length - 1].icon, 'triangle');
});

test('UI.2 chat markup: icon-only controls are named, copy is voseo, labels Vos/Abito gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  for (const id of ['chat-models', 'chat-back', 'chat-send', 'chat-cancel', 'chat-new']) {
    assert.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)[0], /aria-label="[^"]{3,}"/, id);
  }
  assert.match(html, /placeholder="Escribí…"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /content: "(Vos|Abito): "/);
});

// Real cascade resolution (not a text regex): which `animation` declaration
// WINS for a described element under a given media preference. Supports the
// selector subset style.css uses: tag, #id, .class, [attr="v"], descendant.
function cascadeAnimation(css, chain, reduced) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = []; // {sel, value, spec, order}
  let order = 0;
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0; j++; }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith('@media')) {
        const ok = head.includes('prefers-reduced-motion: reduce') ? reduced
          : head.includes('prefers-reduced-motion: no-preference') ? !reduced : false;
        if (ok) walk(body, head);
        continue;
      }
      if (head.startsWith('@')) continue;
      const m = /(?:^|;)\s*animation\s*:\s*([^;]+)/.exec(body);
      if (!m) continue;
      for (const sel of head.split(',')) rules.push({ sel: sel.trim(), value: m[1].trim(), order: order++ });
    }
  };
  walk(plain, null);
  const parseCompound = c => {
    const out = { tag: null, id: null, classes: [], attrs: [], spec: [0, 0, 0] };
    const re = /([#.]?[\w-]+)|\[([\w-]+)="([^"]*)"\]/g;
    let m;
    while ((m = re.exec(c))) {
      if (m[2]) { out.attrs.push([m[2], m[3]]); out.spec[1]++; }
      else if (m[1][0] === '#') { out.id = m[1].slice(1); out.spec[0]++; }
      else if (m[1][0] === '.') { out.classes.push(m[1].slice(1)); out.spec[1]++; }
      else { out.tag = m[1]; out.spec[2]++; }
    }
    return out;
  };
  const matches = (c, el) => (!c.tag || c.tag === el.tag) && (!c.id || c.id === el.id) &&
    c.classes.every(k => (el.classes || []).includes(k)) && c.attrs.every(([k, v]) => (el.attrs || {})[k] === v);
  const winners = rules.map(r => {
    const parts = r.sel.split(/\s+/).map(parseCompound);
    // last compound must match the element; earlier ones an ancestor, in order
    let k = parts.length - 1;
    if (!matches(parts[k], chain[chain.length - 1])) return null;
    let e = chain.length - 2; k -= 1;
    while (k >= 0 && e >= 0) { if (matches(parts[k], chain[e])) k -= 1; e -= 1; }
    if (k >= 0) return null;
    return { ...r, spec: parts.reduce((a, p) => a.map((v, n) => v + p.spec[n]), [0, 0, 0]) };
  }).filter(Boolean);
  winners.sort((a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order);
  return winners.length ? winners[winners.length - 1].value : null;
}

test('#304 motion: the CASCADE is keyed on Abito\'s OWN html[data-motion], never on the system media query (system reduced + Abito full → the ring spins)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /@media[^{]*prefers-reduced-motion/, 'the page must not inherit the system preference through CSS');
  for (const kind of ['busy', 'checking']) {
    const under = mode => [{ tag: 'html', attrs: { 'data-motion': mode } }, { tag: 'span', id: 'chat-state', attrs: { 'data-kind': kind }, classes: ['chip'] },
      { tag: 'span', classes: ['ico'] }, { tag: 'svg' }];
    // second arg = the SYSTEM media query: TRUE in both cases (the WebKit-inherited reduced of the human's session)
    const reduce = cascadeAnimation(css, under('reduce'), true);
    assert.ok(reduce === null || reduce === 'none', `Abito reduce: ${kind} resolves to ${reduce}`);
    assert.match(cascadeAnimation(css, under('full'), true), /^spin /, `Abito full + system reduced: ${kind} still spins`);
    assert.match(cascadeAnimation(css, under('full'), false), /^spin /);
  }
  // the harness itself must detect the old bug: a spinning rule AFTER the stop wins
  const buggy = 'html[data-motion="reduce"] #a .b { animation: none; }\nhtml[data-motion="reduce"] #a .b { animation: spin 1s; }';
  assert.match(cascadeAnimation(buggy, [{ tag: 'html', attrs: { 'data-motion': 'reduce' } }, { tag: 'p', id: 'a' }, { tag: 'i', classes: ['b'] }], true), /^spin/);
});

test('Q2 poseFor: only real lane state maps to a pose; the rest is rest', () => {
  const t = state => ({ turn_id: 't', state, user_text: 'x', reply: '', trimmed_turns: 0 });
  const v = (state, turns = [], active = null) => ({ turns, active_turn: active, availability: { state, message: '' } });
  assert.equal(V.poseFor(null), null);
  assert.equal(V.poseFor(v('ready')), null);
  assert.equal(V.poseFor(v('ready', [t('thinking')], 't')), 'think');
  assert.equal(V.poseFor(v('ready', [t('streaming')], 't')), 'speak');
  assert.equal(V.poseFor(v('ready', [t('queued')], 't')), null);
  assert.equal(V.poseFor(v('ready', [t('waiting_approval')], 't')), null);
  assert.equal(V.poseFor(v('unavailable')), 'error');
  assert.equal(V.poseFor(v('blocked')), 'error');
  assert.equal(V.poseFor(v('ready', [t('error')])), 'error');
  assert.equal(V.poseFor(v('ready', [t('completed')])), null);
  assert.equal(V.poseFor(v('unchecked')), null);
});

test('UI.3: «Respuesta nueva» is hidden whenever the conversation is empty (found in the probe PNGs)', () => {
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chatSrc, /if \(!turns\.length\) \{\s*newer\.hidden = true;/);
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

// ---- #309: the chat is a vertical column --------------------------------------------------------
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const rule = sel => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };

test('column: the chat padding is symmetric (the 60px R6 gutter of the horizontal header is gone)', () => {
  const pad = rule('#chat').match(/padding:\s*([^;]+);/);
  assert.ok(pad, '#chat has padding');
  const parts = pad[1].trim().split(/\s+/).map(x => parseInt(x, 10));
  assert.ok(parts.length >= 3, pad[1]);
  const [, right, , left = right] = [parts[0], parts[1], parts[2], parts[3]];
  assert.equal(left, right, `left ${left} must equal right ${right}`);
  assert.ok(left <= 20, `a narrow column cannot spend ${left}px per side`);
});

test('column: the agent state is its own full-width strip above the history, not a header chip', () => {
  assert.match(html, /<[a-z]+[^>]*id="chat-status-strip"/, 'the strip exists');
  assert.ok(html.indexOf('id="chat-status-strip"') < html.indexOf('id="chat-log"'), 'it sits above the history');
  assert.ok(html.indexOf('id="chat-state"') > html.indexOf('id="chat-status-strip"') && html.indexOf('id="chat-state"') < html.indexOf('id="chat-log"'), 'the state chip lives in the strip');
});

test('column: a message uses the column, not percentages of the old 640 width', () => {
  const user = rule('#chat-log li.user');
  const asst = rule('#chat-log li.assistant');
  assert.doesNotMatch(user, /margin-left:\s*\d+%/, 'no percentage gutter on the human bubble');
  assert.match(user, /max-width:\s*(8\d|9\d)%/);
  assert.match(asst, /max-width:\s*100%|max-width:\s*none/, 'the answer takes the whole column');
});

test('column: the composer is a full-width bottom bar and the log scrolls on its own', () => {
  assert.match(rule('#chat-body'), /flex:\s*1/);
  assert.match(rule('#chat-body'), /min-height:\s*0/);
  assert.match(rule('#chat-log'), /overflow-y:\s*auto/);
  assert.match(rule('#chat-log'), /flex:\s*1/);
  assert.match(rule('#chat-composer'), /align-items:\s*flex-end/);
  assert.match(rule('#chat-input'), /flex:\s*1/);
});

test('column: the composer grows with what is typed (up to a cap), never past the column', () => {
  const input = rule('#chat-input');
  assert.match(input, /min-height:\s*44px/);
  const max = input.match(/max-height:\s*(\d+)px/);
  assert.ok(max && Number(max[1]) >= 88 && Number(max[1]) <= 160, 'a few lines, then it scrolls');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(src, /scrollHeight/, 'the textarea is auto-sized from its content');
  assert.match(src, /input\.value = ''; autosize\(\)/, 'a sent draft shrinks the composer back');
});

test('column: touch targets stay >= 44px', () => {
  assert.match(rule('#chat-composer .round'), /width:\s*44px/);
  assert.match(rule('#chat-composer .round'), /height:\s*44px/);
  assert.match(rule('#chat-input'), /min-height:\s*44px/);
});

test('column: the horizontal chat constants are gone from the page', () => {
  const island = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'island.js'), 'utf8');
  assert.doesNotMatch(island, /const CHAT = \{ w: 640, h: 240/);
  assert.match(island, /const CHAT = \{ w: 400/);
  assert.match(island, /window\.__islandSetView = \(view, vw, vh\)/, 'the size still comes from Rust');
});

test('column: a silent «ready» takes no row; only a state with a word opens the strip', () => {
  const strip = rule('#chat-status-strip');
  assert.match(strip, /min-height:\s*0/, 'the strip has no fixed height');
  assert.match(css, /#chat-status-strip:has\(#chat-state\[data-kind="ready"\]\)\s*\{[^}]*display:\s*none/);
  assert.match(css, /#chat-status-strip:has\(#chat-state\[data-kind=""\]\)\s*\{[^}]*display:\s*none/);
});

console.log(`chat-view-check: ${passed} passed`);
