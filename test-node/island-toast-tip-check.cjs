'use strict';
/* v6 fails: (1) in the CHAT view a click on the question toast must bring the question (view -> overview); (2) the GitHub row carries
   NO native title (a second tooltip), only data-tip + aria-label, and the island tip hides on leave. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-toast-tip-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ question: 'plain', chat: true });
    try {
      const view0 = await r.page.evaluate(() => document.getElementById('capsule').dataset.view);
      assert.equal(view0, 'chat', 'precondition: chat view');
      const t = (await r.measure('#question-toast'))[0];
      assert.ok(t && t.shown, 'the toast is drawn over the chat');
      const hit = (await r.hit('#question-toast'))[0];
      assert.ok(hit && hit.ok, `the toast receives its own click in chat (got ${hit && hit.got})`);
      await r.page.mouse.click(t.left + t.w / 2, t.top + Math.min(t.h, 30) / 2);
      await r.page.waitForTimeout(1500);
      const v = await r.page.evaluate(() => document.getElementById('capsule').dataset.view);
      const sh = await r.page.evaluate(() => (window.__shapes || []).filter(x => x.settled).pop());
      assert.ok(sh && sh.h >= Math.round(t.bottom) - 2, `the native input shape (${JSON.stringify(sh)}) covers the toast (bottom ${Math.round(t.bottom)}) in chat, or the click never reaches the page`);
      assert.notEqual(v, 'chat', 'clicking the toast leaves the chat for the question');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ github: true, githubData: 'real', notices: 0, quick: true });
    try {
      const gh = (await r.measure('#pill-choice-integration_github'))[0];
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2); await r.page.waitForTimeout(1200);
      const n = await r.page.evaluate(() => [...document.querySelectorAll('.gh-row, .gh-card [title], .pill-choice[title]')].filter(e => e.hasAttribute('title')).map(e => e.className));
      await r.page.waitForSelector('.gh-row', { timeout: 5000 }).catch(() => {}); const info = await r.page.evaluate(() => ({ rows: document.querySelectorAll('.gh-row').length, card: !!document.querySelector('.gh-card'), view: document.getElementById('capsule').dataset.view })); assert.ok(info.rows > 0, 'precondition: GitHub rows drawn ' + JSON.stringify(info)); await r.page.hover('.gh-row', { timeout: 5000 }); await r.page.waitForTimeout(600);
      const after = await r.page.evaluate(() => ({ native: (() => { const b = document.querySelector('.gh-row').getBoundingClientRect(); let c = 0; for (let e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); e && e.id !== 'island'; e = e.parentElement) if (e.hasAttribute('title')) c++; return c; })(), tip: !document.getElementById('island-tip').hidden, text: document.getElementById('island-tip').textContent }));
      assert.equal(after.native, 0, 'the element under the pointer and its ancestors carry no native title');
      assert.ok(after.tip && after.text.length > 3, 'the island tip shows on hover');
      await r.page.mouse.move(5, 300); await r.page.waitForTimeout(300);
      assert.equal(await r.page.evaluate(() => document.getElementById('island-tip').hidden), true, 'the tip hides when the pointer leaves');
      void n;
    } finally { await r.close(); }
  }
  console.log('island-toast-tip-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
