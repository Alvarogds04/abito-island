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
  'check', 'cross', 'clock', 'triangle', 'eye-off', 'lock', 'refresh', 'info', 'plane'];

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

test('the settings screens have their icons (user = Cuentas)', () => {
  for (const name of ['user', 'gear', 'plug', 'ring']) assert.ok(I.NAMES.includes(name), name);
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

test('SENT is "Enviada": neutral live paper plane, never a go check (contract §1.1/§8.4)', () => {
  const v = O.cardView('Decisión enviada.');
  assert.equal(v.kind, 'sent');
  assert.equal(v.word, 'Enviada');
  assert.equal(v.icon, 'plane');
  assert.equal(v.tone, 'live');
  assert.notEqual(v.tone, 'go');
  assert.notEqual(v.icon, 'check');
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

// ---- #373 GD032: severity/kind (Rust is the single admission source) ------
test('existing settled notices render identically (regression: info severity changes nothing)', () => {
  const n = [{ id: 'a', title: 'Pi terminó su turno', detail: 'No confirma que la tarea haya salido bien.', at: NOW - 15000, expiresAt: NOW + 45000 }];
  assert.deepEqual(O.noticeView(n, NOW), {
    text: 'Pi terminó',
    badge: 1,
    fraction: 0.75,
    aria: 'Aviso: Pi terminó su turno. No confirma que la tarea haya salido bien. 1 aviso reciente; se descartan al minuto.',
    tone: '',
  });
  // the Rust model now labels it explicitly: same rendering
  assert.deepEqual(O.noticeView([{ ...n[0], severity: 'info', kind: 'settled' }], NOW), O.noticeView(n, NOW));
});

test('severity classification: error renders red, warning sun, info neutral', () => {
  const failure = [{
    id: 'transport-1', kind: 'transport', severity: 'error',
    title: 'Conexión caída', detail: 'Se cortó la conexión con Pi.',
    at: NOW - 1000, expiresAt: NOW + 60000,
  }];
  const v = O.noticeView(failure, NOW);
  assert.equal(v.tone, 'red', 'an error notice is never neutral');
  assert.equal(v.text, 'Conexión caída');
  assert.match(v.aria, /^Error:/, 'the severity is announced, not only colored');
  assert.match(v.aria, /Conexión caída/);
  const warn = O.noticeView([{ id: 'w', kind: 'settled', severity: 'warning', title: 'Aviso', expiresAt: NOW + 60000 }], NOW);
  assert.equal(warn.tone, 'sun');
  assert.match(warn.aria, /^Advertencia:/);
  // an unknown/absent severity is never a crash and never invents a tone
  assert.equal(O.noticeView([{ id: 'x', title: 'Pi terminó su turno', expiresAt: NOW }], NOW).tone, '');
  assert.equal(O.noticeView([{ id: 'x', severity: 'loud', kind: 'settled', title: 'Pi terminó su turno', expiresAt: NOW }], NOW).tone, '');
});

test('filtered kinds never show: only what Rust admits (settled|transport) reaches the strip', () => {
  const engine = [{ id: 't', kind: 'toast', severity: 'info', title: 'engine toast', expiresAt: NOW + 60000 }];
  assert.equal(O.noticeView(engine, NOW), null, 'an engine-facing toast is never rendered');
  const mixed = [
    { id: 'e', kind: 'engine', title: 'internal', expiresAt: NOW + 60000 },
    { id: 'k', kind: 'heartbeat', title: 'hb', expiresAt: NOW + 60000 },
    { id: 'a', kind: 'settled', severity: 'info', title: 'Pi terminó su turno', expiresAt: NOW + 60000 },
  ];
  const v = O.noticeView(mixed, NOW);
  assert.equal(v.badge, 1, 'only the admitted notice counts');
  assert.equal(v.text, 'Pi terminó');
  // an admitted transport failure renders on its own
  assert.equal(O.noticeView([{ id: 'transport-2', kind: 'transport', severity: 'error', title: 'Conexión caída', expiresAt: NOW + 60000 }], NOW).badge, 1);
});

// ---- #373 wiring: the strip paints the view's tone --------------------------
test('island.js paints the notice strip tone from the view (textContent only)', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(src, /noticesEl\.dataset\.tone\s*=/, 'the strip carries the view tone');
  assert.doesNotMatch(src, /noticesEl\.innerHTML/, 'the strip never writes markup');
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
  const joined = [...css.matchAll(/html\[data-motion="reduce"\][^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n');
  assert.ok(joined, 'reduced-motion rules exist, keyed on html[data-motion="reduce"]');
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

test('R6 margins: card box keeps >=20px from the island edge (reject shake ~2px), viewBox top air', () => {
  const [clay, clayX] = /OVERVIEW_CARD = \{ clay: (\d+), clayX: (\d+)/.exec(islandSrc).slice(1).map(Number);
  assert.ok(clayX - clay / 2 >= 20, `box left ${clayX - clay / 2}`);
  const vb = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  assert.deepEqual(vb, [36, 32, 128, 128]);
});

test('Q2 pose wiring: engine setState only, from abito:pose; no gesture on a SENT/unconfirmed decision', () => {
  assert.match(islandSrc, /clay\.setState\(next\)/);
  assert.match(islandSrc, /'abito:pose'/);
  assert.doesNotMatch(islandSrc, /staticPose|AbitoClay\.STATES|flash\(/);
  // behaviour: every card outcome the host can report keeps R6 at rest
  for (const reason of ['Decisión enviada.', 'No se pudo confirmar la decisión. Esperá una actualización.', 'Decisión en curso.', 'Propuesta vencida.', null]) {
    const kind = O.cardView(reason).kind;
    for (const verb of ['allow', 'deny']) assert.equal(O.gestureFor(kind, verb), null, `${kind}/${verb}`);
  }
});

test('UI.3: compact only carries the sun contour; Escape closes models first; new-answer dot is neutral; rows animate 160ms, still under reduced motion', () => {
  const compactOnly = [...css.matchAll(/#capsule\[data-card-tone="(go|red|faint|live)"\] #island/g)];
  assert.equal(compactOnly.length, 0, 'non-sun contours need data-phase="expanded"');
  assert.match(css, /#capsule\[data-card-tone="sun"\] #island/);
  const chatSrc = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
  assert.ok(chatSrc.indexOf("dataset.models === 'open'") < chatSrc.indexOf('if (typing)'), 'models closes before leaving the composer');
  assert.match(css, /#chat-new \.dot \{ background: var\(--island-live\)/);
  assert.match(css, /#chat-log li\.enter \{ animation: row-in 160ms/);
  assert.match(css, /html\[data-motion="reduce"\] #chat-log li\.enter \{ animation: none/);
  assert.match(islandSrc, /paintCompactFlag\(\); \/\/ an expired card/);
});

test('R6 pose from the host snapshot: only REAL persistent failures give error; the rest never touches the pose', () => {
  const bridge = state => ({ unavailable: false, bridgeStatus: { state } });
  assert.equal(O.snapshotPose(bridge('unhealthy')), 'error');
  assert.equal(O.snapshotPose(bridge('stopped')), 'error');
  assert.equal(O.snapshotPose({ unavailable: true, bridgeStatus: { state: 'healthy' } }), 'error');
  for (const ok of ['disabled', 'starting', 'healthy']) assert.equal(O.snapshotPose(bridge(ok)), null, ok);
  assert.equal(O.snapshotPose(null), null);
  assert.equal(O.snapshotPose({}), null);
  // a sent/conflict card or a notice never changes the pose
  assert.equal(O.snapshotPose({ ...bridge('healthy'), card: { state: 'inert', reason: 'Decisión enviada.' }, notices: [{}] }), null);
  assert.equal(O.snapshotPose({ ...bridge('healthy'), card: { state: 'inert', reason: 'No se pudo confirmar la decisión.' } }), null);
});

test('R6 liveness (#304): the island never pauses the engine; idle is alive by default and the SYSTEM reduced-motion value no longer freezes it unless the human opted in', () => {
  assert.doesNotMatch(islandSrc, /setPaused|setManual/);
  // the engine is forced from ONE place: the motion state (forced unless the human honors the system)
  const forced = islandSrc.match(/setForced\([^)]*\)/g) || [];
  assert.deepEqual(forced, ['setForced(!honorSystem)']);
  assert.match(islandSrc, /honorSystem = window\.AbitoOverview\.honorSystemMotion\(snap\)/);
  assert.match(islandSrc, /AbitoClay\.create\(clayEl, \{ seed: 505/);
  assert.doesNotMatch(islandSrc, /live: false/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /animar|animate/i, 'no «animate» button in the UI');
  // priority order: host error > chat pose > rest
  assert.match(islandSrc, /O\.choosePose\(chatPose, hostPose\)/);
});

test('§9.2 hover: ~1.06 only inside the R6 box, never reduced/dragging, no meaning', () => {
  const box = { left: 20, top: 10, width: 100, height: 100 };
  assert.equal(O.HOVER_SCALE, 1.06);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box), 1.06);
  assert.equal(O.hoverScale({ x: 5, y: 50 }, box), 1);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box, { reduced: true }), 1);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box, { dragging: true }), 1);
  assert.equal(O.hoverScale(null, box), 1);
  assert.doesNotMatch(islandSrc.slice(islandSrc.indexOf('function updateHover'), islandSrc.indexOf("window.addEventListener('pointermove'")), /setState|applyPose|dispatchEvent/);
});

test('§9.2 motion table in CSS: view enter spring after 160ms delay, exit 160ms ease-in, control 300ms, focus 120ms; only transform/opacity; reduced jumps', () => {
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  for (const [name, value] of [['--dur-view-delay', '160ms'], ['--dur-view-in', '400ms'], ['--dur-view-out', '160ms'], ['--dur-control', '300ms'], ['--dur-focus', '120ms']]) {
    assert.match(root, new RegExp(`${name}:\\s*${value}`), name);
  }
  assert.match(root, /--ease-in: cubic-bezier\(\.4, 0, 1, 1\)/);
  for (const sel of ['#capsule[data-phase="expanded"][data-view="chat"] #chat', '#capsule[data-phase="expanded"][data-view="overview"] #open-chat', '#capsule[data-phase="expanded"] #permission', '#capsule[data-phase="expanded"] #notices']) {
    const rule = new RegExp(sel.replace(/[[\]().*+?^${}|\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /var\(--dur-view-delay\)/, `${sel} delays 160ms`);
    assert.match(rule[1], /transform var\(--dur-view-in\) var\(--spring\)/, sel);
  }
  // exit: the hidden state of every view uses the 160ms ease-in (and keeps visibility until it ends)
  assert.equal((css.match(/transition: opacity var\(--dur-view-out\) var\(--ease-in\), transform var\(--dur-view-out\) var\(--ease-in\), visibility 0s linear var\(--dur-view-out\)/g) || []).length >= 4, true);
  // nothing animates width/height/left/top in these transitions
  for (const m of css.matchAll(/transition:([^;]*);/g)) assert.doesNotMatch(m[1], /\b(width|height|left|top|right|bottom|margin|padding)\b/, m[1]);
  assert.match(css, /#clay \{[^}]*scale\(var\(--hover, 1\)\)[^}]*transition: transform var\(--dur-state\)/);
  assert.match(css, /:where\(button, textarea\) \{[^}]*outline: 2px solid transparent[^}]*var\(--dur-focus\)/);
  assert.match(css, /#models-list \.choose\[aria-pressed="true"\] \.ico \{ animation: control-pop var\(--dur-control\) var\(--spring\)/);
  const reduced = [...css.matchAll(/html\[data-motion="reduce"\][^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n');
  assert.match(reduced, /html\[data-motion="reduce"\] #notices, html\[data-motion="reduce"\] #permission, html\[data-motion="reduce"\] #open-chat, html\[data-motion="reduce"\] #chat, html\[data-motion="reduce"\] #models, html\[data-motion="reduce"\] #chat-body, html\[data-motion="reduce"\] #question \{ transition: none !important; transform: none !important/);
  assert.match(reduced, /html\[data-motion="reduce"\] #clay \{ transition: none !important/);
});

test('§5 chat header: R6 ~40px VISIBLE (box x 112/128 within 4px) and inside the header', () => {
  const [box, left, top] = /CHAT = \{[^}]*clay: (\d+), clayLeft: (\d+), clayTop: (\d+)/.exec(islandSrc).slice(1).map(Number);
  const vb = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  const visible = box * 112 / vb[2];
  assert.ok(Math.abs(visible - 40) <= 4, `visible ${visible}`);
  assert.ok(left - box / 2 >= 4 && top >= 2 && top + box <= 56, 'box inside the 48-56px header band');
  assert.match(islandSrc, /const z = 1; \/\/ tight framing in the dot, the overview AND the chat/);
});

test('night review: the bridge is shown (chip «Sin puente», compact triangle) and the host error face is time-boxed', () => {
  const snap = (state, card) => ({ unavailable: false, bridgeStatus: { state }, card: card || null });
  const view = O.bridgeView(snap('unhealthy'));
  assert.equal(view.word, 'Sin puente'); assert.equal(view.icon, 'triangle'); assert.equal(view.tone, 'red');
  assert.equal(O.bridgeView(snap('stopped')).word, 'Sin puente');
  for (const ok of ['healthy', 'starting', 'disabled']) assert.equal(O.bridgeView(snap(ok)), null, ok);
  assert.match(islandSrc, /bridge-word/); assert.match(islandSrc, /card-bridge/); assert.match(islandSrc, /bridgeDown/);
  // time box: error face only ~7s after the failure BEGINS (or while a card depends on the bridge)
  const T0 = 1000000;
  let r = O.hostPoseView(snap('unhealthy'), null, T0);
  assert.equal(r.pose, 'error');
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 6900); assert.equal(r.pose, 'error');
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 7100); assert.equal(r.pose, null, 'calms down after the box');
  assert.equal(r.tracker.since, T0, 'the clock started at the first failure, not at every snapshot');
  r = O.hostPoseView(snap('unhealthy', { state: 'pending' }), r.tracker, T0 + 60000); assert.equal(r.pose, 'error', 'a card that depends on the bridge keeps the face');
  r = O.hostPoseView(snap('healthy'), r.tracker, T0 + 61000); assert.equal(r.pose, null); assert.equal(r.tracker.failing, false);
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 70000); assert.equal(r.pose, 'error', 'a NEW failure restarts the box');
  // priority: the local chat wins over the bridge
  assert.equal(O.choosePose('think', 'error'), 'think');
  assert.equal(O.choosePose('speak', 'error'), 'speak');
  assert.equal(O.choosePose('error', null), 'error');
  assert.equal(O.choosePose(null, 'error'), 'error');
  assert.equal(O.choosePose(null, null), 'idle');
});

test('night review: views are NOT display:none while animating (inert instead), so the §9.2 motion actually runs', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<section id="chat" inert/); assert.doesNotMatch(html, /<section id="chat"[^>]*\shidden/);
  assert.match(html, /<div id="models" inert/); assert.doesNotMatch(html, /<div id="models"[^>]*\shidden/);
  const chatSrc = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
  const modelsSrc = fs.readFileSync(path.join(frontend, 'models.js'), 'utf8');
  assert.doesNotMatch(chatSrc, /\bchat\.hidden\s*=/);
  assert.doesNotMatch(modelsSrc, /panel\.hidden\s*=/);
  assert.match(chatSrc, /chat\.inert = false/); assert.match(chatSrc, /chat\.inert = true; \}, 220\)/);
  assert.match(css, /#models\[data-open="true"\] \{[^}]*var\(--dur-view-delay\)/);
  assert.doesNotMatch(css, /#models\[hidden\]/);
  assert.doesNotMatch(css, /#capsule\[data-models="open"\] #chat-body \{ display: none/);
});

test('N8 vertical chat entrance: the chat (and its models panel) travel along the docked edge, with the contract timing, no display:none', () => {
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  // a variable distance, a direction per docked edge
  assert.match(root, /--view-shift:\s*16px/);
  assert.match(css, /#capsule\[data-edge="top"\]\s*\{[^}]*--view-dir:\s*-1/);
  assert.match(css, /#capsule\[data-edge="bottom"\]\s*\{[^}]*--view-dir:\s*1/);
  for (const sel of ['#chat', '#models']) {
    const rule = new RegExp(`\\n${sel} \\{([^}]*)\\}`).exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /transform: translateY\(calc\(var\(--view-dir\) \* var\(--view-shift\)\)\)/, `${sel} starts displaced along the edge`);
    assert.match(rule[1], /opacity: 0/); assert.match(rule[1], /visibility: hidden/);
    assert.doesNotMatch(rule[1], /display:\s*none/);
  }
  // enter keeps the §9.2 timing: 160ms delay + 400ms spring on transform
  assert.match(css, /data-view="chat"\] #chat \{[^}]*transform var\(--dur-view-in\) var\(--spring\) var\(--dur-view-delay\)/);
  // the old 6px nudge no longer drives the chat/models
  const chatRule = /\n#chat \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(chatRule, /translateY\(6px\)/);
  // reduced motion still jumps
  assert.match(css, /html\[data-motion="reduce"\] #chat, html\[data-motion="reduce"\] #models/);
});

test('#304 motionState: Abito animates ALWAYS by default; the system preference counts only when the human opted to honor it', () => {
  // the human's real session: the system (via GTK/WebKit) says «reduced», Abito must still move
  assert.equal(O.motionState({ systemReduced: true, honorSystem: false }), 'full');
  assert.equal(O.motionState({ systemReduced: false, honorSystem: false }), 'full');
  assert.equal(O.motionState({ systemReduced: true, honorSystem: true }), 'reduce');
  assert.equal(O.motionState({ systemReduced: false, honorSystem: true }), 'full');
  // missing facade / snapshot / junk: the DEFAULT is full, never inherited
  assert.equal(O.motionState({ systemReduced: true }), 'full');
  assert.equal(O.motionState({}), 'full');
  assert.equal(O.motionState(null), 'full');
  // the snapshot field: motionOverride true (the new default) = do NOT honor the system
  assert.equal(O.honorSystemMotion({ motionOverride: true }), false);
  assert.equal(O.honorSystemMotion({ motionOverride: false }), true);
  assert.equal(O.honorSystemMotion(null), false, 'no snapshot yet: animate');
  assert.equal(O.honorSystemMotion({}), false);
});

test('#304 wiring: the page decides motion itself (data-motion on <html>), starts in «full», forces the engine, no inherited media query in JS decisions', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<html lang="es" data-motion="full">/);
  assert.match(islandSrc, /let honorSystem = false;/);
  assert.match(islandSrc, /AbitoOverview\.motionState\(\{ systemReduced: reduced\.matches, honorSystem \}\)/);
  assert.match(islandSrc, /document\.documentElement\.dataset\.motion = /);
  // every snap/animate decision goes through the single motion state
  assert.doesNotMatch(islandSrc, /reduced\.matches && !forceMotion/);
  assert.match(islandSrc, /motionReduced\(\)/);
  // the frozen engine is forced from the first frame unless the human honors the system
  assert.match(islandSrc, /AbitoClay\.setForced\(!honorSystem\)/);
});

test('#302 round dot: the compact island is gentle-dot\'s 66px disc, in step with the native 78x78 window; it takes less room than the pill', () => {
  const geo = fs.readFileSync(path.join(__dirname, '..', 'src', 'geometry.rs'), 'utf8');
  const diameter = Number(/pub const DOT_DIAMETER: i32 = (\d+);/.exec(geo)[1]);
  assert.equal(diameter, 66);
  assert.match(geo, /LOGICAL_COMPACT: \(i32, i32\) = \(DOT_DIAMETER \+ 12, DOT_DIAMETER \+ 12\)/);
  const m = /const COMPACT = \{ w: (\d+), h: (\d+), r: (\d+), gap: (\d+), clay: (\d+), drop: (\d+) \}/.exec(islandSrc);
  assert.ok(m, 'COMPACT constant');
  const [w, h, r, gap, clay] = m.slice(1, 6).map(Number);
  assert.deepEqual([w, h], [diameter, diameter], 'a circle: width = height = the measured diameter');
  assert.equal(r, diameter / 2, 'fully round');
  assert.equal(gap, 6, 'the same edge gap the pill had: the transparent margin is (78-66)/2');
  assert.equal(w + 2 * gap, 78, 'visible dot + margins = the native compact window');
  assert.ok(w * h < 288 * 32, 'less area than the old pill');
  assert.ok(clay >= 48 && clay <= diameter, 'the character box fits the disc');
  const vbx = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  const visible = clay * 112 / vbx[2];
  assert.ok(visible >= 44 && visible <= diameter - 12, `the visible character (${visible.toFixed(1)}px) sits inside the disc with a clear rim`);
});

test('#302 the dot keeps the badge/contour vocabulary: sun/red badge sits ON the disc rim; sun contour only in compact', () => {
  const flag = /#compact-flag \{([^}]*)\}/.exec(css)[1];
  const right = Number(/right:\s*(\d+)px/.exec(flag)[1]), top = Number(/top:\s*(\d+)px/.exec(flag)[1]), size = Number(/width:\s*(\d+)px/.exec(flag)[1]);
  const cx = 66 - right - size / 2, cy = top + size / 2; // badge centre, from the dot's top-left
  const dist = Math.hypot(cx - 33, cy - 33);
  assert.ok(dist <= 33 && dist >= 33 - size / 2 - 4, `badge centre ${dist.toFixed(1)}px from the dot centre must be on the rim, inside the disc`);
  assert.match(css, /#capsule\[data-card-tone="sun"\] #island \{ box-shadow: inset 0 0 0 2px var\(--sun\)/);
});

test('#302 drag/snap/edge memory are untouched: the native window is still a plain rectangle and nothing in the frontend decides docking', () => {
  assert.doesNotMatch(islandSrc, /snap_to_edge|nearest_vertical_edge|anchor_toggle/);
  assert.match(islandSrc, /send\('drag_press'/); assert.match(islandSrc, /send\('drag_release'/);
  assert.match(islandSrc, /island\.style\.borderRadius = r \+ 'px'/);
});

test('CSS structure: braces balance (no stray «}» swallowing the next rule) and every critical top-level rule exists', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (let i = 0; i < plain.length; i += 1) {
    if (plain[i] === '{') depth += 1;
    else if (plain[i] === '}') { depth -= 1; assert.ok(depth >= 0, `stray «}» near line ${plain.slice(0, i).split('\n').length} (comment-stripped)`); }
  }
  assert.equal(depth, 0, 'unclosed «{»');
  // a real parse of the top-level rule list: the rule right after a stray brace is the one that dies
  const top = []; let d = 0, start = 0;
  for (let i = 0; i < plain.length; i += 1) {
    if (plain[i] === '{') { if (d === 0) top.push(plain.slice(start, i).trim()); d += 1; }
    else if (plain[i] === '}') { d -= 1; if (d === 0) start = i + 1; }
  }
  for (const sel of ['.sr-only', '#clay', '#island', '#compact-flag', '#open-chat', '#chat', '#models', '#question']) assert.ok(top.includes(sel), `top-level rule ${sel} must exist; got ${top.length} rules`);
  assert.ok(top.some(t => t.startsWith('html[data-motion="reduce"] #notices')), 'the reduced-motion rules are top-level rules');
});

test('#302 follow-up: the window is BORN at the compact size (tauri.conf.json = geometry::LOGICAL_COMPACT), so there is no 304x44 transparent flash with the disc clipped', () => {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tauri.conf.json'), 'utf8')).app.windows[0];
  } catch (error) {
    assert.fail(`tauri.conf.json unreadable: ${error}`);
  }
  const geo = fs.readFileSync(path.join(__dirname, '..', 'src', 'geometry.rs'), 'utf8');
  const dot = Number(/pub const DOT_DIAMETER: i32 = (\d+);/.exec(geo)[1]);
  assert.deepEqual([conf.width, conf.height], [dot + 12, dot + 12]);
  assert.deepEqual([conf.width, conf.height], [78, 78]);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /All sizes land exactly 304x44/, 'README must not document the old compact size as the contract');
});

test('#305 hotkey feedback: a taken/unsupported/invalid grab is VISIBLE (icon + one word), active is silent, Wayland says «limitado»', () => {
  const v = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, ...extra });
  assert.equal(O.hotkeyView(v('active')), null, 'a working shortcut shows nothing');
  assert.equal(O.hotkeyView(v('disabled', { enabled: false })), null, 'a shortcut the human turned off is not a problem');
  const taken = O.hotkeyView(v('taken'));
  assert.deepEqual([taken.word, taken.icon, taken.tone], ['Atajo ocupado', 'triangle', 'red']);
  assert.match(taken.aria, /Ctrl\+Alt\+A/); assert.match(taken.aria, /otra aplicación/);
  assert.equal(O.hotkeyView(v('unsupported')).word, 'Atajo sin soporte');
  assert.equal(O.hotkeyView(v('invalid')).word, 'Atajo inválido');
  const limited = O.hotkeyView(v('active', { limited: true }));
  assert.deepEqual([limited.word, limited.tone], ['Atajo limitado', 'faint']);
  assert.match(limited.aria, /ventana de X11/);
  assert.equal(O.hotkeyView(null), null); assert.equal(O.hotkeyView({}), null); assert.equal(O.hotkeyView(v('nope')), null);
  // honesty: a problem is never hidden behind «limited»
  assert.equal(O.hotkeyView(v('taken', { limited: true })).word, 'Atajo ocupado');
});

test('U3a win32 hotkey feedback: «Atajo sin soporte» says so WITHOUT the X11 excuse; taken stays «otra aplicación»; a working grab is silent', () => {
  const wv = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, backend: 'win32', portal_note: null, ...extra });
  const unsup = O.hotkeyView(wv('unsupported'));
  assert.equal(unsup.word, 'Atajo sin soporte');
  assert.doesNotMatch(unsup.aria, /X11/, 'there is no X server on Windows; blaming one is the lie U3a kills');
  assert.match(unsup.aria, /no se pudo registrar/);
  const taken = O.hotkeyView(wv('taken'));
  assert.equal(taken.word, 'Atajo ocupado'); assert.match(taken.aria, /otra aplicación/);
  assert.equal(O.hotkeyView(wv('active')), null, 'a real Win32 grab that works says nothing');
  assert.equal(O.hotkeyView(wv('disabled')), null);
});

test('#305 wiring: the island listens to hotkey:state and paints the chip; the page never grabs or answers anything', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="hotkey" class="chip" role="img" hidden/);
  assert.match(islandSrc, /listen\('hotkey:state'/);
  assert.match(islandSrc, /hotkey_action', \{ payload: \{ action: 'view' \} \}/);
  assert.doesNotMatch(islandSrc, /hotkey_action', \{ payload: \{ action: '(set|enable|disable|reset)'/, 'the island only READS the status; changing it belongs to the settings panel (#308)');
});

test('#305b hotkey feedback: the OS permission dialog is explained (accept once), a decline is visible, and the portal route is never «limited»', () => {
  const v = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, backend: 'portal', ...extra });
  const pending = O.hotkeyView(v('permission_pending'));
  assert.deepEqual([pending.word, pending.icon, pending.tone], ['Aceptá el permiso', 'info', 'sun']);
  assert.match(pending.aria, /sistema/); assert.match(pending.aria, /una sola vez/); assert.match(pending.aria, /Ctrl\+Alt\+A/);
  const denied = O.hotkeyView(v('permission_denied'));
  assert.deepEqual([denied.word, denied.icon, denied.tone], ['Atajo sin permiso', 'triangle', 'red']);
  assert.match(denied.aria, /rechazaste|rechazó|no diste/i);
  // the portal route working = silence (never «limitado»); the X11 fallback on Wayland = limited
  assert.equal(O.hotkeyView(v('active', { backend: 'portal', limited: false })), null);
  assert.equal(O.hotkeyView(v('active', { backend: 'x11', limited: true })).word, 'Atajo limitado');
  assert.match(O.hotkeyView(v('active', { backend: 'x11', limited: true })).aria, /ventana de X11/);
  // a permission prompt for a shortcut the human turned off is not shown
  assert.equal(O.hotkeyView(v('permission_pending', { enabled: false })), null);
});

test('#305b the reason the portal was dropped stays visible after the X11 fallback took over (not a 400 ms flash)', () => {
  const v = (extra) => ({ combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: true, backend: 'x11', portal_note: null, ...extra });
  const declined = O.hotkeyView(v({ portal_note: 'permission_denied' }));
  assert.equal(declined.word, 'Atajo limitado'); assert.equal(declined.tone, 'faint');
  assert.match(declined.aria, /rechazaste el permiso/i); assert.match(declined.aria, /ventana de X11/);
  const failed = O.hotkeyView(v({ portal_note: 'unsupported' }));
  assert.match(failed.aria, /portal del sistema no respondió|no pudo/);
  // no note = the plain limited message; a working X11 session with a note still explains it
  assert.doesNotMatch(O.hotkeyView(v()).aria, /rechazaste/);
  assert.equal(O.hotkeyView(v({ limited: false, portal_note: 'permission_denied' })).word, 'Atajo sin permiso', 'on a full X11 session the decline is the only thing worth saying');
});

console.log(`overview-view-check: ${passed} passed`);
