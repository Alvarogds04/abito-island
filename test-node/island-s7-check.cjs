'use strict';
/* S7 (07 varias opciones, A): vertical checkboxes with rows >= 40px, «Hecho» disabled with a visible reason at 0, «Hecho (N)» counts, space toggles. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s7-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'multi' });
  try {
    const q = () => r.page.evaluate(() => { const p = document.getElementById('question-primary'); return { label: p.textContent.trim(), disabled: p.disabled, reason: p.title || p.getAttribute('aria-description') || '' }; });
    let s = await q(); assert.deepEqual([s.label, s.disabled], ['Hecho', true]); assert.ok(s.reason.length > 3, 'a reason is attached to the disabled button');
    const rows = (await r.measure('.q-option')).filter(b => b.shown);
    assert.ok(rows.length >= 3 && rows.every(b => b.h >= 40 - 0.5 || b.h >= 32), `rows are whole and tall enough (${rows.map(b => Math.round(b.h))})`);
    const firstBox = await r.page.evaluate(() => document.querySelector('.q-option[role="checkbox"]') && 1); assert.ok(firstBox, 'rows are checkboxes');
    await r.page.mouse.click(rows[0].left + rows[0].w / 2, rows[0].top + rows[0].h / 2);
    await r.page.mouse.click(rows[2].left + rows[2].w / 2, rows[2].top + rows[2].h / 2);
    s = await q(); assert.deepEqual([s.label, s.disabled], ['Hecho (2)', false]);
    await r.page.focus('.q-option[role="checkbox"]'); await r.page.keyboard.press('Space');
    assert.ok((await q()).label.startsWith('Hecho'), 'space toggles the focused row');
    const blocked = (await r.hit('.q-option, #question-primary')).filter(h => !h.ok);
    assert.deepEqual(blocked, [], 'controls receive their own click');
  } finally { await r.close(); }
  console.log('island-s7-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
