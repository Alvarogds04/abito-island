'use strict';
/* T7.3 island controls (design §1/§2, design/export/png island frames):
   every island control is 32px VISUAL inside a 44px HIT area (the T6.1 hit-ring
   pattern: the visible pill is drawn on the ::after inset layer), the rail tab
   is 36px visual, the chat composer input row is 36px. CSS contract only (no
   browser): the declarations of each selector across style.css, in cascade
   order. Scoped to the island's own selectors — Ajustes (.sbtn/.sfield/.stab)
   is T7.2's surface and is NOT touched here. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'frontend');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('rail tabs keep the 44px hit height and draw a 36px visual on ::after (design §1: rail tab 36)', () => {
  assert.equal(decls('#island-header .tab, #island-header .hdr-action')['height'], '44px');
  const a = decls('#island-header .tab::after');
  assert.equal(a.inset, '4px', '44 hit - 2x4 inset = 36 visual');
  assert.equal(a['border-radius'], '10px');
  assert.equal(decls('#island-header .tab[aria-pressed="true"]').background, 'transparent', 'the visible tab fill moves to ::after');
  assert.equal(decls('#island-header .tab[aria-pressed="true"]::after').background, 'var(--tab-on)');
});

test('question options: 32px visual inside the 44px hit area (design §2)', () => {
  assert.equal(decls('.q-option')['min-height'], '44px');
  const a = decls('.q-option::after');
  assert.equal(a.inset, '6px', '44 hit - 2x6 inset = 32 visual');
  assert.equal(a['border-radius'], '10px');
  assert.equal(a['background'], 'var(--btn-bg)');
  assert.equal(decls('.q-option').background, 'transparent', 'the visible fill moves to ::after');
});

test('approval buttons: 32px visual inside the 44px hit area, «Permitir» primary (design §2)', () => {
  for (const sel of ['#allow', '#deny']) {
    assert.equal(decls(sel)['min-height'], '44px');
    assert.equal(decls(sel + '::after').inset, '6px');
    assert.equal(decls(sel).background, 'transparent');
  }
  assert.equal(decls('#allow::after').background, 'var(--primary-bg)', 'Permitir is the primary');
  assert.equal(decls('#deny::after').background, 'var(--btn-bg)');
});

test('«Omitir» stays a ghost 32px visual in a 44px hit area (design §2)', () => {
  assert.equal(decls('#question-skip')['min-height'], '44px');
  assert.equal(decls('#question-skip::after').inset, '6px');
  assert.equal(decls('#question-skip').background, 'transparent');
});

test('island icon buttons draw a 32px visual on ::after and keep the 44px hit area', () => {
  assert.equal(decls('.icon-btn')['min-width'], '44px', 'base hit area unchanged');
  assert.equal(decls('.icon-btn').background, 'transparent');
  const a = decls('#capsule .icon-btn::after');
  assert.equal(a.inset, '6px', 'island-scoped 32px visual ring');
  assert.equal(a['border-radius'], '10px');
});

test('chat composer: 36px input row, 36px round buttons in 44px hit areas (design §2)', () => {
  assert.equal(decls('#chat-input')['min-height'], '36px');
  const round = decls('#chat-composer .round');
  assert.equal(round.width, '44px', 'hit area stays 44');
  assert.equal(round.height, '44px');
  assert.equal(decls('#chat-composer .round::after').inset, '4px', '44 hit - 2x4 inset = 36 visual');
  const auto = fs.readFileSync(path.join(dir, 'chat.js'), 'utf8');
  assert.match(auto, /const MIN_INPUT = 36/, 'autosize grows from the 36px design row');
});

test('the free-text question field matches the 36px composer row (design §2)', () => {
  assert.equal(decls('#question-text')['min-height'], '36px');
});
test('island icon buttons never override the absolute placement of #card-info/#notice-info', () => {
  assert.equal(decls('#capsule .icon-btn').position, undefined, 'a (1,1,0) position rule would beat the (1,0,0) absolute rules');
  assert.equal(decls('.icon-btn').position, 'relative', 'the ::after ring anchors on the base class (0,1,0), which ids still override');
  assert.equal(decls('#card-info').position, 'absolute', 'the info button keeps its corner placement');
  assert.equal(decls('#card-fold').position, 'relative', 'T7.3: the fold sits in the action row (isla-approval)');
});
test('chat top bar: visible title «Abito» before the gear/back buttons (design isla-chat-*)', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header id="chat-header">'), html.indexOf('</header>', html.indexOf('<header id="chat-header">')));
  assert.match(header, /<h2 id="chat-title">Abito<\/h2>[\s\S]*id="open-screen-settings"[\s\S]*id="chat-back"/);
  const t = decls('#chat-title');
  assert.equal(t['font-size'], 'var(--fs-body)');
  assert.equal(t['font-weight'], '600');
});
console.log(`island-controls-check: ${failed ? failed + ' FAILED' : 'all passed'}`);
if (failed) process.exitCode = 1;
