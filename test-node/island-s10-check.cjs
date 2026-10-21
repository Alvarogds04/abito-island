'use strict';
/* S10 (10 «Pi terminó», B): the finished notice is a 32px band UNDER the unchanged overview (it replaces nothing), the message is one line,
   buttons [Ver] [OK] receive their clicks, and the band hides while that agent is running again. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s10-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ finishedCard: 'pi', finishedText: 'Migración aplicada, 14 tests pasan y el despliegue de staging quedó verificado sin errores.' });
    try {
      const isl = (await r.measure('#island'))[0];
      assert.equal(Math.round(isl.h), 220, 'overview 184 + a 36px band zone');
      const ov = (await r.measure('#overview-view'))[0]; assert.ok(ov.shown, 'the overview stays visible under the band');
      assert.ok((await r.measure('.centre-state, .centre-empty-title')).some(b => b.shown), 'the centre content is still drawn');
      const band = (await r.measure('#notices'))[0];
      assert.ok(band.shown, 'the band is drawn'); assert.equal(Math.round(band.h), 32, 'fixed 32px'); assert.equal(Math.round(band.top - isl.top), 178, 'under the cards (y 178)');
      assert.ok(band.bottom <= isl.bottom + 0.5, 'inside the island');
      const msg = await r.page.evaluate(() => { const m = document.getElementById('notice-card-message'); return { fits: m.scrollWidth <= m.clientWidth + 1, h: m.getBoundingClientRect().height }; });
      assert.ok(msg.h <= 20, `one line (${msg.h}px)`);
      const ok = await r.hit('#notice-card-ok, #notice-card-terminal'); assert.equal(ok.length, 2); assert.deepEqual(ok.filter(h => !h.ok), [], 'buttons get their click');
      const btnH = await r.page.evaluate(() => [...document.querySelectorAll('#notice-card .btn')].map(b => b.getBoundingClientRect().height)); assert.ok(btnH.every(h => h >= 24), 'targets >= 24px');
    } finally { await r.close(); }
  }
  {
    // the agent that finished is RUNNING again -> the band is gone and the island is back to the overview height
    const r = await H.open({ finishedCard: 'claude-code' });
    try {
      const isl = (await r.measure('#island'))[0]; assert.equal(Math.round(isl.h), 184, 'claude-code runs (api): no band');
      assert.ok(!(await r.measure('#notice-card'))[0].shown, 'the band is hidden while it runs');
    } finally { await r.close(); }
  }
  console.log('island-s10-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });
