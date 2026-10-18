'use strict';
/* S10 / L19 — the island wears Coucou's geometry literally. CSS contract only (no browser).
   Reference values: Coucou windows/src/style.css @434d6a2b ("Content shell", "Overview", "Agent pills").
   The rules live in frontend/vendor/coucou/island/island.css, loaded after style.css. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'frontend');
const raw = fs.readFileSync(path.join(dir, 'vendor/coucou/island/island.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  }
  return out;
}
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('provenance: MIT citation with commit and copyright; loaded after style.css', () => {
  assert.match(raw, /@434d6a2b, Copyright \(c\) 2026 Louis Raillé, MIT/);
  assert.ok(html.indexOf('href="style.css"') < html.indexOf('vendor/coucou/island/island.css'));
});

test('Coucou palette tokens (style.css :root) are defined with the reference values', () => {
  const root = decls(':root');
  for (const [k, v] of Object.entries({ '--dim': '#9398a1', '--dim-2': '#8e939c', '--dim-3': '#6b7079', '--dim-4': '#5f646d', '--dim-5': '#4b5563', '--card': '#141518', '--card-flat': '#0e0f11', '--hairline': 'rgba(255, 255, 255, 0.035)', '--red': '#f4505e', '--red-text': '#ff8d97', '--green': '#22c55e', '--green-2': '#34d399', '--amber': '#f5a524', '--cyan': '#22d3ee', '--indigo': '#6366f1', '--pink': '#f472b6' }))
    assert.equal(root[k], v, k);
});

test('header: 640x34 at y=8, tabs left (30x22 r11 visual), settings right; tabs pitch 35', () => {
  const h = decls('#island-header');
  assert.equal(h.top, '8px'); assert.equal(h.width, '640px'); assert.equal(h.height, '34px');
  assert.equal(h['flex-direction'], 'row'); assert.equal(h['justify-content'], 'space-between');
  const v = decls('#island-header .tab::after, #island-header .hdr-action::after');
  assert.equal(v.inset, '11px 7px', '44x44 hit -> 30x22 visual');
  assert.equal(v['border-radius'], '11px');
  const hit = decls('#island-header .tab, #island-header .hdr-action');
  assert.equal(hit.width, '44px'); assert.equal(hit.height, '44px', '44px hit area kept');
  assert.equal(hit.margin, '0 -5px');
  assert.equal(decls('.tabs').gap, '1px', '44 - 2*5 + 1 = 35 = 30 + Coucou gap 5');
  assert.equal(decls('#island-header .tab:hover:not([aria-pressed="true"])::after').background, 'rgba(255, 255, 255, 0.07)');
  assert.equal(decls('#island-header .tab[aria-pressed="true"]::after').background, 'var(--tab-on)');
});

test('overview: row at y=42 of 108px, left card 322, right card from x=332 (gap 10)', () => {
  const o = decls('#overview-view');
  assert.equal(o.top, '42px'); assert.equal(o.height, '108px'); assert.equal(o.width, '620px');
  assert.equal(o.left, 'calc(50% - 310px)');
  assert.equal(decls('.card-left').width, '322px');
  assert.equal(decls('#pill-choices').left, '332px');
  const c = decls('.card');
  assert.equal(c['border-radius'], '20px'); assert.equal(c.background, 'var(--card)'); assert.equal(c.border, '1px solid var(--hairline)');
});

test('who row and ticker: 600 12px name, 400 11px tool, 500 13px/22px rows, 108px indent', () => {
  const a = decls('.agentline');
  assert.equal(a.left, '108px'); assert.equal(a.right, '36px');
  assert.equal(decls('.agentline strong').font, '600 12px var(--font)');
  assert.equal(decls('.agentline .source').font, '400 11px var(--font)');
  const d = decls('.overview-detail');
  assert.equal(d.left, '108px'); assert.equal(d.height, '44px'); assert.equal(d.font, '500 13px/22px var(--font)');
});

test('agent pills: 1fr 1fr grid, 28px pill (r999, card-flat, .14 border), label centred, padding 0 8px', () => {
  const g = decls('#pill-choices');
  assert.equal(g['grid-template-columns'], '1fr 1fr'); assert.equal(g.padding, '0 8px'); assert.equal(g['align-content'], 'center');
  assert.equal(g['grid-auto-rows'], '28px'); assert.equal(g.gap, '4px');
  const p = decls('.pill-choice');
  assert.equal(p.height, '28px'); assert.equal(p['border-radius'], '999px'); assert.equal(p.background, 'var(--card-flat)');
  assert.match(p.border, /rgba\(255, 255, 255, 0\.14\)/); assert.equal(p.font, '600 10px var(--font)'); assert.equal(p.color, 'var(--dim-3)');
  assert.equal(decls('.pill-choice span:not(.ico)').padding, '0 8px 0 34px');
  assert.equal(decls('.pill-choice .island-agent-clay')['margin-left'], '7px');
});

test('pill hit area extends 2px into every 4px gap (no overlap between neighbours)', () => {
  assert.equal(decls('.pill-choice::after').inset, '-2px');
});

test('approval/question: one 620x108 card at y=42, padding 4px 16px 4px 116px, gap 5, wash amber/cyan (280px at 50% 130%)', () => {
  const c = decls('#permission, #question');
  assert.equal(c.width, '620px'); assert.equal(c.height, '108px'); assert.equal(c.top, '42px'); assert.equal(c.left, 'calc(50% - 310px)');
  assert.equal(c.padding, '4px 16px 4px 116px'); assert.equal(c.gap, '5px'); assert.equal(c['border-radius'], '20px');
  assert.equal(decls('#permission')['--wash'], 'rgba(245, 165, 36, 0.42)');
  assert.equal(decls('#question')['--wash'], 'rgba(34, 211, 238, 0.38)');
  assert.match(decls('#permission::before, #question::before').background, /radial-gradient\(280px 280px at 50% 130%, var\(--wash\) 0%, rgba\(0, 0, 0, 0\) 70%\)/);
});

test('buttons: Coucou .btn 500 12.5px pill, 30px visual inside the 44px hit; code well and title as in the reference', () => {
  const b = decls('#allow, #deny, .q-option');
  assert.equal(b['min-height'], '44px'); assert.equal(b.font, '500 12.5px var(--font)'); assert.equal(b.padding, '0 13px');
  assert.equal(decls('#allow::after, #deny::after, .q-option::after').inset, '7px 0', '44 - 2*7 = 30 visual');
  assert.equal(decls('#allow::after, #deny::after, .q-option::after')['border-radius'], '999px');
  const code = decls('#permission #operation');
  assert.equal(code.font, '400 12px var(--mono)'); assert.equal(code['border-radius'], '10px'); assert.equal(code.padding, '5px 10px');
  assert.equal(decls('#question-body').font, '600 15px/1.25 var(--font)');
});

test('fold and info: 16px round visual (inset 14 of 44), glyph 8px, 44px hit kept', () => {
  assert.equal(decls('#capsule #permission .icon-btn::after').inset, '14px');
  assert.equal(decls('#permission .icon-btn')['min-width'], '44px');
  assert.equal(decls('#permission .icon-btn .ico svg').width, '8px');
});

test('notices: 44px band on the right card; a confirmed notice takes the whole 620x108 card', () => {
  const n = decls('#notices');
  assert.equal(n.left, 'calc(50% + 22px)'); assert.equal(n.width, '288px'); assert.equal(n.height, '44px'); assert.equal(n.top, '42px');
  const lane = decls('#capsule[data-phase="expanded"][data-notice-view="notices"] #notices');
  assert.equal(lane.width, '620px'); assert.equal(lane.height, '108px'); assert.equal(lane.padding, '4px 16px 4px 116px');
});

test('Spotify card: Coucou np-card (dot 6, title 600 12, sub 400 11, play 20 circle ink, icons 16x18) in the left card column', () => {
  const c = decls('.spotify-card');
  assert.equal(c.left, '108px'); assert.equal(c.right, '310px', 'stays inside the 322px left card'); assert.equal(c.top, '14px');
  assert.equal(decls('.np-title').font, '600 12px var(--font)'); assert.equal(decls('.np-sub').font, '400 11px var(--font)');
  assert.equal(decls('.np-dot').width, '6px');
  const p = decls('.np-play'); assert.equal(p.width, '20px'); assert.equal(p['border-radius'], '50%'); assert.equal(p.background, 'var(--ink)');
  assert.equal(decls('.np-icon').width, '16px'); assert.equal(decls('.np-icon').height, '18px');
  assert.equal(decls('.np-buttons').gap, '10px');
  assert.equal(decls('.np-progress').font, '400 9.5px var(--font)');
  assert.equal(decls('.np-bar').height, '10px'); assert.equal(decls('.np-bar::after').inset, '-17px 0', '44px hit around the 10px bar');
  assert.equal(decls('.np-track').background, 'rgba(255, 255, 255, 0.12)');
  assert.equal(decls('.np-knob').width, '9px');
  assert.equal(decls('.np-volume .np-bar').width, '44px');
  assert.equal(decls('.np-icon::after, .np-play::after').inset, '-10px -5px', 'hit clears the 10px gaps');
});

if (failed) process.exit(1);
