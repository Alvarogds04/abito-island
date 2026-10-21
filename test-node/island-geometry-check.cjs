'use strict';
/* The expanded overview with the REAL css/scripts in a real layout engine: nothing overlaps, nothing is clipped out of reach, every
   control receives its own click. Island = 640x160 (viewport x16..656, y0..160); cards y42..150. Run: node test-node/island-geometry-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-geometry-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const ISLAND = { left: 16, top: 0, right: 656, bottom: 160 };
const CARD = { top: 42, bottom: 150 };
const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
const inside = (a, c) => a.left >= c.left - 0.5 && a.top >= c.top - 0.5 && a.right <= c.right + 0.5 && a.bottom <= c.bottom + 0.5;
const label = e => `${e.id}[${Math.round(e.left)},${Math.round(e.top)},${Math.round(e.right)},${Math.round(e.bottom)}]`;

// every box that draws text or takes a click in the overview, by selector. The mascot (#clay) and its badge are decoration the
// status line must stay clear of; the badge sits ON the mascot by design.
const OWNERS = ['.col-status', '.centre-state', '.centre-steps li', '.centre-empty-title', '.centre-empty-sub', '#centre-cta', '.engine-row-live',
  '.card-left > .who', '#session-jump', '#notices', '.pill-choice', '#blobs-footer', '#clay'];
async function boxes(r) {
  const out = [];
  const list = (await r.measure('#pill-choices'))[0];
  for (const sel of OWNERS) for (const b of await r.measure(sel)) {
    if (!b.shown) continue;
    if (sel === '.pill-choice' && list) {
      // a blob row scrolled out of its list is CLIPPED by it (reachable by scrolling), not drawn outside: measure what is visible
      const top = Math.max(b.top, list.top), bottom = Math.min(b.bottom, list.bottom);
      if (bottom - top < 1) continue;
      out.push({ ...b, top, bottom, h: bottom - top, sel });
    } else out.push({ ...b, sel });
  }
  return out;
}
function noOverlaps(list, why) {
  const bad = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) bad.push(`${label(list[i])} x ${label(list[j])}`);
  assert.deepEqual(bad, [], `${why}: ${bad.join(' | ')}`);
}

(async () => {
  let passed = 0;
  const scenarios = {
    sessions: { github: true },
    'sessions + notices + Pi without account': { github: true, notices: 4, engine: 'account' },
    'no engine (Sin motor) + notices': { notices: 4, engine: 'down' },
    empty: { sessions: [] },
    'empty + no engine': { sessions: [], engine: 'down', notices: 2 },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    const r = await H.open(scenario);
    try {
      const list = await boxes(r);
      noOverlaps(list, `${name}: overlapping boxes`);
      for (const b of list) if (b.sel !== '#clay') assert.ok(inside(b, ISLAND), `${name}: ${label(b)} leaves the island`);
      // the left card's content stays inside the cards' row (nothing drawn into the header or below the island)
      for (const b of list) if (!['#notices'].includes(b.sel)) assert.ok(b.top >= CARD.top - 1 && b.bottom <= CARD.bottom + 1, `${name}: ${label(b)} leaves the 108px card row`);
      // every control receives its own click (the validator clicks by coordinates)
      const hits = [];
      for (const sel of ['#session-jump', '#notice-action', '#notice-dismiss', '#notice-open', '.pill-choice', '.see-all', '.engine-link', '#centre-cta', '#connection:not([disabled])']) hits.push(...await r.hit(sel));
      const blocked = hits.filter(h => !h.ok).map(h => `${h.id}@${h.at} got ${h.got}`);
      assert.deepEqual(blocked, [], `${name}: controls whose click lands on something else: ${blocked.join(' | ')}`);
      passed += 1;
    } catch (e) { await r.screenshot(`/tmp/geo-fail-${name.replace(/\W+/g, '_')}.png`).catch(() => {}); throw e; }
    finally { await r.close(); }
  }

  // the blobs column: at least three rows fully visible, GitHub reachable, nothing pushed out by sessions
  {
    const r = await H.open({ github: true });
    try {
      const list = (await r.measure('#pill-choices'))[0];
      const rows = (await r.measure('.pill-choice')).filter(b => b.shown);
      const full = rows.filter(b => b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5);
      assert.ok(full.length >= 3, `at least 3 blob rows fully visible, got ${full.length} of ${rows.length} (list ${label(list)})`);
      const ids = (await r.page.evaluate(() => [...document.querySelectorAll('.pill-choice')].map(b => b.dataset.pillId)));
      assert.deepEqual(ids.slice(0, 2), ['abito', 'integration_github'], 'declared pills first, sessions after');
      assert.ok(ids.length >= 4, `sessions are rows too (declared + ${ids.length - 2} sessions)`);
      const gh = (await r.measure('#pill-choice-integration_github'))[0];
      assert.ok(gh.top >= list.top - 0.5 && gh.bottom <= list.bottom + 0.5, 'the GitHub blob is reachable without scrolling');
      const blobs = (await r.measure('#blobs'))[0];
      assert.ok(inside(list, blobs), 'the list lives inside its card');
      passed += 1;
    } finally { await r.close(); }
  }

  // the jump button and the centre text never share pixels, whatever the centre says
  {
    const r = await H.open({});
    try {
      const jump = (await r.measure('#session-jump')).find(b => b.shown);
      assert.ok(jump, 'the jump button is shown with a session in the centre');
      const centre = (await r.measure('.col-centre'))[0];
      assert.ok(centre.right <= jump.left + 0.5, `the centre column ends before the jump button (${Math.round(centre.right)} <= ${Math.round(jump.left)})`);
      passed += 1;
    } finally { await r.close(); }
  }

  // focus mode (a question waits): the card takes left + centre, the blobs become a mascot column, still no overlaps
  {
    const r = await H.open({ question: 'plain', github: true });
    try {
      const mode = await r.page.evaluate(() => document.getElementById('capsule').dataset.layout);
      assert.equal(mode, 'focus');
      const q = (await r.measure('#question'))[0], blobs = (await r.measure('#blobs'))[0];
      assert.ok(q.shown && blobs.shown, 'the question card and the mascot column are both visible');
      assert.ok(!overlap(q, blobs), `focus mode: ${label(q)} overlaps ${label(blobs)}`);
      assert.ok(q.right <= blobs.left + 0.5);
      for (const sel of ['#question-skip', '.q-option']) for (const h of await r.hit(sel)) assert.ok(h.ok, `focus mode: ${h.id}@${h.at} got ${h.got}`);
      const qb = [];
      for (const sel of ['#question-asker', '#question-skip', '#question-body', '.q-option']) for (const b of await r.measure(sel)) {
        if (!b.shown) continue;
        // the 44px hit area of a row (margin -6) is bigger than its drawn 32px shape (::after inset 6px): compare what is DRAWN
        if (sel === '.q-option' || sel === '#question-skip') qb.push({ ...b, top: b.top + 6, bottom: b.bottom - 6, h: b.h - 12, sel });
        else qb.push({ ...b, sel });
      }
      noOverlaps(qb, 'focus mode: question card children');
      passed += 1;
    } finally { await r.close(); }
  }
  console.log(`island-geometry-check: ${passed} real-layout checks ok`);
})().catch(e => { console.error(e); process.exit(1); });
