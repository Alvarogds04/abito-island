'use strict';
/* UI.1 — pure checks for frontend/overview-view.js + frontend/icons.js
   (no DOM, no network). Visual contract: docs/desktop-visual-language.md
   §1.2 icons, §2.1/§2.2 text -> visual map, §3 never-remove.
   Run: node apps/desktop-tauri/test-node/overview-view-check.cjs
   Also run by `cargo test` (tests/frontend_overview.rs). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const I = require(path.join(frontend, 'icons.js'));
const O = require(path.join(frontend, 'overview-view.js'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

// ---- icons ---------------------------------------------------------------
const CONTRACT = ['bubble', 'arrow-up', 'square', 'arrow-left', 'chip', 'plug', 'plug-off',
  'check', 'cross', 'clock', 'triangle', 'eye-off', 'lock', 'refresh', 'info'];

test('registry has every contract icon (14 rows, plug/unplugged = 2 shapes)', () => {
  for (const name of CONTRACT) assert.ok(I.NAMES.includes(name), name);
});

test('every icon is own inline SVG: 20px grid, currentColor, 2px round stroke, no external refs', () => {
  for (const name of I.NAMES) {
    const svg = I.svg(name);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 20 20"/, name);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
    assert.match(svg, /aria-hidden="true"/, name);
    assert.match(svg, /stroke="currentColor"/, name);
    assert.match(svg, /stroke-width="2"/, name);
    assert.match(svg, /stroke-linecap="round"/, name);
    assert.doesNotMatch(svg, /<script|href=|url\(|style=|\son\w+=|<image|<use|#[0-9a-f]{3,6}\b/i, name);
    assert.ok((svg.match(/</g) || []).length === (svg.match(/>/g) || []).length, name);
  }
});

test('unknown icon yields an empty string, never throws', () => {
  assert.equal(I.svg('nope'), '');
  assert.equal(I.svg(undefined), '');
});

// ---- expiry --------------------------------------------------------------
const NOW = Date.parse('2026-10-09T12:00:00Z');
test('expiry label is short and relative', () => {
  assert.equal(O.expiryLabel('2026-10-09T12:04:00Z', NOW), '4 min');
  assert.equal(O.expiryLabel('2026-10-09T12:03:30Z', NOW), '4 min'); // rounds up
  assert.equal(O.expiryLabel('2026-10-09T12:00:30Z', NOW), '<1 min');
  assert.equal(O.expiryLabel('2026-10-09T13:30:00Z', NOW), '2 h');
  assert.equal(O.expiryLabel('2026-10-12T12:00:00Z', NOW), '3 d');
  assert.equal(O.expiryLabel('2999-12-31T23:59:59Z', NOW), '+99 d');
});

test('expiry: past or invalid is "Vencida" / empty, never a negative time', () => {
  assert.equal(O.expiryLabel('2026-10-09T12:00:00Z', NOW), 'Vencida');
  assert.equal(O.expiryLabel('2026-10-09T11:00:00Z', NOW), 'Vencida');
  assert.equal(O.expiryLabel('not a date', NOW), '');
  assert.equal(O.expiryLabel(undefined, NOW), '');
});

test('expiry aria keeps the exact ISO date', () => {
  assert.equal(O.expiryAria('2026-10-09T12:04:00Z', NOW), 'Vence en 4 min: 2026-10-09T12:04:00Z');
  assert.equal(O.expiryAria('2026-10-09T11:00:00Z', NOW), 'Vencida: 2026-10-09T11:00:00Z');
});

// ---- approval card state -------------------------------------------------
test('pending: sun tone, no extra word, actionable', () => {
  const v = O.cardView(null);
  assert.equal(v.kind, 'pending');
  assert.equal(v.tone, 'sun');
  assert.equal(v.word, '');
  assert.equal(v.actionable, true);
});

test('SENT is "Enviada" with a go check, never "No disponible"', () => {
  const v = O.cardView('Decisión enviada.');
  assert.equal(v.kind, 'sent');
  assert.equal(v.word, 'Enviada');
  assert.equal(v.icon, 'check');
  assert.equal(v.tone, 'go');
  assert.equal(v.actionable, false);
  assert.doesNotMatch(JSON.stringify(v), /No disponible/);
});

test('expired -> clock slash + "Vencida", faint', () => {
  const v = O.cardView('Propuesta vencida.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['expired', 'clock-off', 'Vencida', 'faint']);
});

test('failed confirmation -> red triangle + "Sin confirmar"', () => {
  for (const r of ['No se pudo confirmar la decisión. Esperá una actualización.', 'No se pudo confirmar la decisión.']) {
    const v = O.cardView(r);
    assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unconfirmed', 'triangle', 'Sin confirmar', 'red']);
  }
});

test('in flight -> live ring, no word, aria "Enviando decisión"', () => {
  const v = O.cardView('Decisión en curso.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['busy', 'ring', '', 'live']);
  assert.equal(v.aria, 'Enviando decisión');
});

test('covered (compact) shows only the sun dot', () => {
  const v = O.cardView('Abrí la tarjeta para decidir.');
  assert.deepEqual([v.kind, v.word, v.tone, v.actionable], ['covered', '', 'sun', false]);
});

test('any other inert reason stays honest: faint lock + "No disponible", full text in aria', () => {
  const v = O.cardView('Puente no disponible.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unavailable', 'lock', 'No disponible', 'faint']);
  assert.match(v.aria, /Puente no disponible\./);
});

test('every non-pending view has a visible word or is an explicit dot/ring', () => {
  for (const r of ['Decisión enviada.', 'Propuesta vencida.', 'No se pudo confirmar la decisión.', 'Puente no disponible.']) {
    assert.ok(O.cardView(r).word.length > 0, r);
  }
});

// ---- connection ----------------------------------------------------------
test('no Pi -> unplugged icon + "Sin Pi" (the duplicate sentence is gone)', () => {
  const v = O.connectionView({ unavailable: false, connections: 0 });
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['down', 'plug-off', 'Sin Pi', 'faint']);
  assert.doesNotMatch(JSON.stringify(v), /Sin conexión con Pi/);
  assert.match(v.detail, /conectás/);
  assert.doesNotMatch(v.detail, /conectas/);
});

test('connected -> plug, go, no word; the "declared identity" caveat lives in aria/detail', () => {
  const v = O.connectionView({ unavailable: false, connections: 1 });
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['connected', 'plug', '', 'go']);
  assert.match(v.aria, /identidad declarada como Pi/);
  assert.match(v.detail, /no confirma/i);
});

test('channel down -> red triangle + "Avisos caídos"', () => {
  const v = O.connectionView({ unavailable: true, connections: 0 });
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unavailable', 'triangle', 'Avisos caídos', 'red']);
  assert.match(v.detail, /no pudo iniciarse/);
});

test('connection view tolerates a missing snapshot', () => {
  assert.equal(O.connectionView(null).kind, 'down');
});

// ---- notice pill ---------------------------------------------------------
test('notice pill: short text, badge, 60 s ring fraction, full text in aria', () => {
  const n = [{ id: 'a', title: 'Pi terminó su turno', detail: 'No confirma que la tarea haya salido bien.', at: NOW - 15000, expiresAt: NOW + 45000 }];
  const v = O.noticeView(n, NOW);
  assert.equal(v.text, 'Pi terminó');
  assert.equal(v.badge, 1);
  assert.equal(v.fraction, 0.75);
  assert.match(v.aria, /Pi terminó su turno/);
  assert.match(v.aria, /1 aviso reciente/);
});

test('notice pill: unknown titles are cut to 3 words; plural; ring clamps', () => {
  const n = [{ id: 'a', title: 'Una cosa muy larga pasó', expiresAt: NOW - 1 }, { id: 'b', title: 'x', expiresAt: NOW }];
  const v = O.noticeView(n, NOW);
  assert.equal(v.text, 'Una cosa muy');
  assert.equal(v.badge, 2);
  assert.equal(v.fraction, 0);
  assert.match(v.aria, /2 avisos recientes/);
  assert.equal(O.noticeView([], NOW), null);
});

// ---- markup contract -----------------------------------------------------
test('every icon-only control in index.html has an aria-label', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  for (const id of ['open-chat', 'notice-dismiss', 'notice-info', 'card-info']) {
    const m = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(m, `#${id} present`);
    assert.match(m[0], /aria-label="[^"]{3,}"/, `#${id} aria-label`);
  }
  for (const id of ['allow', 'deny']) { // icon + WORD (human decision)
    assert.match(html, new RegExp(`id="${id}"[^>]*>[\\s\\S]*?<span class="btn-word">(Permitir|Denegar)</span>`), id);
  }
  assert.match(html, /<script defer src="icons\.js"><\/script>/);
  assert.match(html, /<script defer src="overview-view\.js"><\/script>/);
});

test('overview copy keeps voseo and drops the old duplicated sentences', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8') +
    fs.readFileSync(path.join(frontend, 'overview-view.js'), 'utf8');
  assert.doesNotMatch(src, /No disponible'\s*:\s*'Pendiente'/);
  assert.doesNotMatch(src, /Sin conexión con Pi\./);
  assert.doesNotMatch(src, /conectas /);
});

// ---- UI.1 correction pass --------------------------------------------------
const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
const islandSrc = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
// Declarations of the LAST rule whose selector list contains `sel` exactly,
// outside @media blocks; later rules win like in the cascade.
function decls(sel, source = css) {
  const out = {};
  const plain = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{[^{}]*\{[^{}]*\}\s*\}/g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(x => x.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}
const px = v => (v === undefined ? NaN : parseFloat(v));

test('44px: every control (incl. the card «i») measures >= 44x44', () => {
  const base = decls('.icon-btn');
  const controls = {
    '.icon-btn': base, '#notice-info': { ...base, ...decls('#notice-info') },
    '#notice-dismiss': { ...base, ...decls('#notice-dismiss') }, '#card-info': { ...base, ...decls('#card-info') },
    '#allow': decls('#allow'), '#deny': decls('#deny'), '#open-chat': decls('#open-chat'),
  };
  for (const [name, d] of Object.entries(controls)) {
    const w = Math.max(px(d['min-width']) || 0, px(d.width) || 0);
    const h = Math.max(px(d['min-height']) || 0, px(d.height) || 0);
    assert.ok(w >= 44 && h >= 44, `${name} is ${w}x${h}`);
  }
});

test('notices strip: its content never touches the chat bubble or the pill border', () => {
  const n = decls('#notices');
  const bubble = decls('#open-chat');
  const H = 160; // overview height
  const top = px(n.top), bottom = px(n.bottom), right = px(n.right);
  const contentH = 44 /* #notice-row */ + 44 /* #notice-pill */ + (px(decls('#notice-pill')['margin-top']) || 0);
  assert.ok(H - top - bottom >= contentH, `strip ${H - top - bottom}px < content ${contentH}px`);
  const bubbleTop = H - px(bubble.bottom) - px(bubble.height);
  const bubbleLeftGap = px(bubble.right) + px(bubble.width) + 8; // strip must stop 8px before the bubble
  const verticallyClear = top + contentH <= bubbleTop - 4;
  assert.ok(verticallyClear || right >= bubbleLeftGap, 'strip overlaps the bubble');
  assert.ok(top + contentH <= H - 12, 'content reaches the pill border zone');
  assert.ok(right >= bubbleLeftGap, 'dismiss cross must stay clear of the bubble column');
});

test('reduced motion: the in-flight ring does not rotate (cue kept by blue ring shape)', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)].map(m => m[1]);
  assert.ok(blocks.length, 'reduced-motion block exists');
  const joined = blocks.join('\n');
  assert.match(joined, /\[data-kind="busy"\] \.ico svg\s*\{[^}]*animation:\s*none/);
  assert.doesNotMatch(css, /even under reduced motion/);
});

test('«i» aria-label announces the real state', () => {
  const card = O.cardView('No se pudo confirmar la decisión. Esperá una actualización.');
  assert.equal(O.infoLabel('Ver detalle de la decisión', card.aria),
    'Ver detalle de la decisión: No se pudo confirmar la decisión. Esperá una actualización.');
  const conn = O.connectionView({ connections: 0 });
  assert.match(O.infoLabel('Ver detalle de la conexión', conn.aria), /^Ver detalle de la conexión: Sin Pi/);
  assert.equal(O.infoLabel('Ver', ''), 'Ver');
  assert.match(islandSrc, /\$\('card-info'\)\.setAttribute\('aria-label', O\.infoLabel\(/);
  assert.match(islandSrc, /noticeInfo\.setAttribute\('aria-label', O\.infoLabel\(/);
});

test('§3: a card never hides a missing Pi / downed notices channel', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="card-conn"[^>]*role="img"/);
  assert.match(html, /id="card-conn-word"/);
  assert.match(islandSrc, /card-conn/);
  assert.equal(O.cardConnection(O.connectionView({ connections: 1 })), null);
  assert.equal(O.cardConnection(O.connectionView({ connections: 0 })).word, 'Sin Pi');
  assert.equal(O.cardConnection(O.connectionView({ unavailable: true })).word, 'Avisos caídos');
});

test('R6 visible size: ~128px plain overview, ~72px with the card (scale/viewBox only)', () => {
  const num = re => { const m = re.exec(islandSrc); assert.ok(m, String(re)); return m.slice(1).map(Number); };
  const [units] = num(/R6_VISIBLE_UNITS = (\d+)/);
  const vb = num(/OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/);
  const [plain] = num(/OVERVIEW = \{[^}]*clay: (\d+)/);
  const [card] = num(/OVERVIEW_CARD = \{ clay: (\d+)/);
  const scale = Math.min(1, 1) / Math.max(vb[2], vb[3]);
  assert.ok(Math.abs(units * scale * plain - 128) <= 6, `plain visible ${units * scale * plain}`);
  assert.ok(Math.abs(units * scale * card - 72) <= 4, `card visible ${units * scale * card}`);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(frontend, 'clay-engine.js'))).digest('hex').slice(0, 8), 'e2dc5db3');
});

console.log(`overview-view-check: ${passed} passed`);
