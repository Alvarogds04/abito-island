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
      // NO row may be partly visible: every row is fully inside the list or fully outside it (a 3px sliver of the next row read as a cut row)
      const partial = rows.filter(b => { const vis = Math.min(b.bottom, list.bottom) - Math.max(b.top, list.top); return vis > 0.5 && vis < b.h - 0.5; }).map(b => `${label(b)} shows ${Math.round(Math.min(b.bottom, list.bottom) - Math.max(b.top, list.top))}px of ${Math.round(b.h)}`);
      assert.deepEqual(partial, [], `no blob row is cut by the bottom of the list: ${partial.join(' | ')}`);
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
  // the state the screen validator builds: GitHub declared WITH data, two sessions (one Codex «proyecto-beta»), 4 notices, Pi without an
  // account. The GitHub blob is clicked: its card IS the centre, so the session header / footer rows must not coexist with it.
  {
    const sessions = [{ id: 's-eb4fc4bc', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null }, { id: 's-3b48a1be', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null }];
    for (const theme of ['light', 'dark']) {
      const r = await H.open({ sessions, github: true, githubData: true, notices: 4, engine: 'account', theme });
      try {
        const before = await r.page.evaluate(() => [...document.querySelectorAll('.pill-choice')].map(b => b.dataset.pillId));
        assert.deepEqual(before, ['abito', 'integration_github', 's-eb4fc4bc', 's-3b48a1be'], `${theme}: the evidence grid of the validator`);
        const gh = (await r.measure('#pill-choice-integration_github'))[0], list = (await r.measure('#pill-choices'))[0];
        assert.ok(gh.top >= list.top - 0.5 && gh.bottom <= list.bottom + 0.5, `${theme}: the GitHub blob is a visible row`);
        const at = [gh.left + gh.w / 2, gh.top + gh.h / 2];
        await r.page.mouse.click(at[0], at[1]);
        await r.page.waitForTimeout(1500);
        const shown = await r.page.evaluate(() => document.getElementById('overview-view').dataset.github || null);
        assert.equal(shown, 'on', `${theme}: the GitHub card opened`);
        // the focused integration is the centre: the session centre column and its footer are gone, not drawn underneath
        for (const sel of ['.col-centre', '.centre-foot', '.card-left > .who', '.col-status']) for (const b of await r.measure(sel)) assert.ok(!b.shown, `${theme}: ${sel} is still drawn under the GitHub card`);
        // the card's own rows must not overlap each other or the card's edges
        const rows = [];
        for (const sel of ['.gh-card .int-head', '.gh-card .int-stat', '.gh-card .int-status']) for (const b of await r.measure(sel)) if (b.shown) rows.push({ ...b, sel });
        noOverlaps(rows, `${theme}: GitHub card rows`);
        const card = (await r.measure('.gh-card'))[0];
        for (const b of rows) assert.ok(b.left >= card.left - 0.5 && b.right <= card.right + 0.5 && b.top >= card.top - 0.5 && b.bottom <= card.bottom + 0.5, `${theme}: ${label(b)} leaves the GitHub card ${label(card)}`);
        // the mascot's status line («En reposo») is complete, not clipped
        const st = (await r.measure('.col-status'))[0];
        // GitHub focused hides the status column too: it must not be drawn half-clipped either way
        assert.ok(!st || !st.shown, `${theme}: nothing half-drawn under the card`);
        // the blobs column keeps every OTHER row (the focused integration is the card; the sessions stay)
        const after = await r.page.evaluate(() => [...document.querySelectorAll('.pill-choice')].map(b => b.dataset.pillId));
        assert.deepEqual(after, ['abito', 'integration_github', 's-eb4fc4bc', 's-3b48a1be'], `${theme}: the focused integration STAYS in the column (design 16: «GitHub ◂»), the sessions stay`);
        const active = await r.page.evaluate(() => { const b = document.getElementById('pill-choice-integration_github'); return b && { pressed: b.getAttribute('aria-pressed'), others: [...document.querySelectorAll('.pill-choice')].filter(x => x !== b && x.dataset.centre === 'true').map(x => x.dataset.pillId) }; });
        assert.deepEqual(active, { pressed: 'true', others: [] }, `${theme}: the GitHub row is marked active (aria-pressed) while its card is the centre, and no other row claims the centre`);
        const mark = await r.page.evaluate(() => { const b = document.getElementById('pill-choice-integration_github'); return { centre: b.dataset.centre, arrow: getComputedStyle(b.querySelector('span:not(.ico)'), '::after').content }; });
        assert.equal(mark.centre, 'true'); assert.match(mark.arrow, /◂/, `${theme}: «GitHub ◂» is drawn`);
        // and the way BACK exists: the sessions are still rows, and Abito's row returns to the normal centre
        const home = (await r.measure('#pill-choice-abito'))[0];
        await r.page.mouse.click(home.left + home.w / 2, home.top + home.h / 2);
        await r.page.waitForTimeout(800);
        const back = await r.page.evaluate(() => document.getElementById('overview-view').dataset.github || null);
        assert.equal(back, null, `${theme}: choosing another blob closes the GitHub card`);
        passed += 1;
      } catch (e) { await r.screenshot(`/tmp/geo-fail-github-${theme}.png`).catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // the grouped notices list (validator scene «historial agrupado»): «Ver» opens a LIST over the whole 620x108 card; its rows are
  // reachable, one dismisses exactly one row, and «Descartar todos» is clickable
  {
    const r = await H.open({ notices: 4, engine: 'account', github: true });
    try {
      await r.page.waitForTimeout(500);
      const open = (await r.hit('#notice-action'))[0];
      assert.ok(open && open.ok, `the «Ver» button receives its click: ${JSON.stringify(open)}`);
      const btn = (await r.measure('#notice-action'))[0];
      await r.page.mouse.click(btn.left + btn.w / 2, btn.top + btn.h / 2);
      await r.page.waitForTimeout(800);
      const list = (await r.measure('#notice-list'))[0];
      assert.ok(list && list.shown, 'the grouped list is visible');
      assert.ok(list.w >= 560 && list.h >= 90, `the list takes the whole card, not the 174x28 band: ${label(list)}`);
      const rows = (await r.measure('.notice-list-row')).filter(b => b.shown);
      assert.ok(rows.length >= 2, `at least two list rows are visible and reachable, got ${rows.length}`);
      const hits = [...await r.hit('.notice-list-dismiss'), ...await r.hit('#notice-clear'), ...await r.hit('.notice-list-row')];
      const bad = hits.filter(h => !h.ok).map(h => `${h.id}@${h.at} got ${h.got}`);
      assert.deepEqual(bad, [], `list controls whose click lands elsewhere: ${bad.join(' | ')}`);
      const before = (await r.measure('.notice-list-row')).length;
      const d = (await r.measure('.notice-list-dismiss'))[0];
      await r.page.mouse.click(d.left + d.w / 2, d.top + d.h / 2);
      await r.page.waitForTimeout(600);
      const after = (await r.measure('.notice-list-row')).length;
      assert.equal(after, before - 1, 'dismissing a row removes exactly one');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-notice-list.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // after a question is answered (or declined) and its «Recibida» word expires, the island gives its height back and the mascot returns:
  // a stale «question shown» kept the island 200px tall with the mascot 26px lower, and «En reposo» was drawn over it (screen gate)
  {
    const r = await H.open({ question: 'plain', sessions: [] });
    try {
      const islandH = async () => (await r.measure('#island'))[0].h;
      const clayTop = async () => (await r.measure('#clay'))[0].top;
      assert.ok(await islandH() > 170, `with the question open the island is tall (${await islandH()})`);
      const opt = (await r.measure('.q-option')).find(b => b.shown);
      await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
      await r.page.waitForTimeout(6500); // «Recibida» (3 s) + the spring back
      const mode = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', badge: !document.getElementById('clay-badge').hidden, layout: document.getElementById('capsule').dataset.layout }));
      assert.deepEqual(mode, { q: '', badge: false, layout: 'normal' }, `nothing of the question is left over: ${JSON.stringify(mode)}`);
      assert.ok(Math.abs(await islandH() - 160) < 2, `the island is back to the 160px overview, got ${await islandH()}`);
      assert.ok(Math.abs(await clayTop() - 63) < 2, `the mascot is back at the overview position (63), got ${await clayTop()}`);
      const list = await boxes(r);
      noOverlaps(list, 'after answering: overlapping boxes');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-after-answer.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // THE REAL FAILURE (screen gate 50/3/6): with 2 sessions present, a click on the GitHub row must make GitHub the CENTRE. The first fix made
  // the centre follow the ticker focus for sessions only; the integration selection was overridden and the centre kept «proyecto-beta».
  {
    const sessions = [{ id: 's-eb4fc4bc', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null }, { id: 's-3b48a1be', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null }];
    const r = await H.open({ sessions, github: true, githubData: true, notices: 4, engine: 'account', theme: 'light', unavailable: true });
    try {
      const gh = (await r.measure('#pill-choice-integration_github'))[0];
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2);
      await r.page.waitForTimeout(1500);
      const st = await r.page.evaluate(() => ({ gh: document.getElementById('overview-view').dataset.github || null, card: !!document.querySelector('.gh-card:not([hidden])'),
        centre: getComputedStyle(document.querySelector('.col-centre')).display, name: document.querySelector('.centre-name') ? document.querySelector('.centre-name').textContent : '' }));
      assert.equal(st.gh, 'on', `GitHub is the centre: ${JSON.stringify(st)}`);
      assert.ok(st.card, 'the GitHub card is drawn');
      assert.equal(st.centre, 'none', 'the session centre gives way (an integration selection wins over the ticker focus)');
      // the selected row reads as selected, and clicking a SESSION row returns the centre to that session
      // GitHub now stays a row of the column («GitHub ◂»), so the fourth blob sits below the fold: the human scrolls the list to it
      await r.page.evaluate(() => { document.getElementById('pill-choices').scrollTop = 1e4; });
      await r.page.waitForTimeout(200);
      const sess = (await r.measure('#pill-choice-s-3b48a1be'))[0];
      await r.page.mouse.click(sess.left + sess.w / 2, sess.top + sess.h / 2);
      await r.page.waitForTimeout(900);
      const back = await r.page.evaluate(() => ({ gh: document.getElementById('overview-view').dataset.github || null, name: document.querySelector('.centre-name').textContent }));
      assert.deepEqual(back, { gh: null, name: 'proyecto-beta' }, `a session row returns the centre to that session: ${JSON.stringify(back)}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-github-click.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // The screen validator clicks like click(): scrollIntoView({block:'center'}) on the target, THEN a click at the target's NEW centre. A blob
  // inside the overview must not make an ancestor scroll: #island is overflow:hidden and used to move 31px, shifting every card up (the band
  // from y42 to y11), so the real click landed where the blob no longer was and GitHub never became the centre.
  {
    const sessions = [{ id: 's-eb4fc4bc', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null }, { id: 's-3b48a1be', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null }];
    const r = await H.open({ sessions, github: true, githubData: true, notices: 4, engine: 'account', theme: 'light', unavailable: true });
    try {
      const probe = await r.page.evaluate(async () => {
        const el = document.getElementById('pill-choice-integration_github');
        const bandBefore = document.getElementById('notices').getBoundingClientRect().top;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        const scrolled = [...document.querySelectorAll('*')].filter(n => (n.scrollTop || n.scrollLeft) && n.id !== 'pill-choices').map(n => n.id || n.className);
        return { bandBefore, bandAfter: document.getElementById('notices').getBoundingClientRect().top, scrolled };
      });
      assert.deepEqual(probe.scrolled, [], `scrollIntoView must scroll ONLY the blobs list, not the island (it scrolled: ${probe.scrolled})`);
      assert.equal(probe.bandAfter, probe.bandBefore, 'no card moves when a control is scrolled into view');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-scrollintoview.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // the notice capsule with a LONG title («Conexión caída»): the title ellipsizes inside its own box, never runs under «Abrir» or spills out of the column
  {
    for (const title of ['Conexión caída', 'Conexión caída con el motor del agente local: reintentando en segundo plano']) {
      const r = await H.open({ notices: 1, noticeTitle: title, engine: 'account', github: true });
      try {
        const cap = (await r.measure('#notice-pill'))[0], blobs = (await r.measure('#blobs'))[0];
        assert.ok(cap && cap.shown, 'the notice capsule is shown');
        assert.ok(cap.left >= blobs.left - 0.5 && cap.right <= blobs.right + 0.5, `the capsule stays inside the blobs column: ${label(cap)} vs ${label(blobs)}`);
        const parts = [];
        for (const sel of ['#notice-ring', '#notice-title', '#notice-sub', '#notice-action', '#notice-dismiss']) for (const b of await r.measure(sel)) if (b.shown) {
          // the × keeps a 44px hit box over a 28px band: compare what is DRAWN (its 16px glyph), not the hit area
          parts.push(sel === '#notice-dismiss' ? { ...b, left: b.left + 14, right: b.right - 14, top: b.top + 14, bottom: b.bottom - 14 } : { ...b, sel });
        }
        noOverlaps(parts, `notice capsule «${title.slice(0, 20)}…»`);
        for (const b of parts) assert.ok(b.right <= cap.right + 14 && b.left >= cap.left - 0.5, `${label(b)} leaves the capsule ${label(cap)}`);
        passed += 1;
      } catch (e) { await r.screenshot('/tmp/geo-fail-notice-capsule.png').catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // Ctrl+Alt+T on the REAL island.js: with a session focused the shortcut sends THAT session's key; after the validator scene publishes
  // «no focused session» it sends the plain class verb, so its class fixture stays the window the native readback expects.
  {
    const r = await H.open({});
    try {
      const press = async () => { await r.page.evaluate(() => window.__emit('global-shortcut', 'jumpToTerminal')); await r.page.waitForTimeout(300); return r.page.evaluate(() => (window.__focusCalls || []).at(-1)); };
      const focused = await press();
      assert.equal(focused.target, 'terminal');
      assert.match(String(focused.session), /^s-[0-9a-f]{8}$/, `with a session focused the key travels: ${JSON.stringify(focused)}`);
      await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:sessions-view', { detail: { view: null, focusId: null } })));
      const cleared = await press();
      assert.deepEqual(cleared, { target: 'terminal' }, `with no focused session it is the plain class verb: ${JSON.stringify(cleared)}`);
      const mode = await r.page.evaluate(() => document.getElementById('capsule').dataset.shortcutTerminal);
      assert.equal(mode, 'focused-class', 'and the product reports «focused-class», which is what the class-fixture readback is judged against');
      passed += 1;
    } finally { await r.close(); }
  }
  // v4-01b: a notice capsule in the blobs column must keep its title readable (the real capture showed «Pi… Hace…» and only 3 rows)
  {
    const r = await H.open({ notices: 1, noticeTitle: 'Pi terminó su turno', github: true, engine: 'account' });
    try {
      const title = (await r.measure('#notice-title'))[0], cap = (await r.measure('#notice-pill'))[0];
      const fits = await r.page.evaluate(() => { const t = document.getElementById('notice-title'); return { sw: t.scrollWidth, cw: t.clientWidth, text: t.textContent }; });
      assert.ok(fits.sw <= fits.cw + 1, `the notice title is not truncated in the column: «${fits.text}» needs ${fits.sw}px, has ${fits.cw}px`);
      const sub = await r.page.evaluate(() => { const s = document.getElementById('notice-sub'); const st = getComputedStyle(s); return { shown: st.display !== 'none' && s.getBoundingClientRect().width > 0, w: s.getBoundingClientRect().width }; });
      assert.ok(!sub.shown || sub.w >= 40, `the secondary text is either dropped or readable, never a 12px stub («Hace…»): ${JSON.stringify(sub)}`);
      const rows = (await r.measure('.pill-choice')).filter(b => b.shown);
      const list = (await r.measure('#pill-choices'))[0];
      const whole = rows.filter(b => b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5);
      assert.ok(whole.length >= 3, `with a notice capsule the column still shows >= 3 whole rows, got ${whole.length}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-notice-column.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // v4-12 «Recibida»: after answering, the outcome card and the blobs column must not share pixels (the column overlapped the card's corner)
  {
    for (const kind of ['multi', 'form']) {
      const r = await H.open({ question: kind, github: true });
      try {
        const q0 = (await r.measure('#question'))[0];
        const opt = (await r.measure('.q-option')).find(b => b.shown);
        await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
        if (kind === 'form') { for (let i = 0; i < 2; i++) { await r.page.waitForTimeout(250); const p = (await r.measure('#question-primary')).find(b => b.shown); if (p) await r.page.mouse.click(p.left + p.w / 2, p.top + p.h / 2); } }
        else { await r.page.waitForTimeout(250); const p = (await r.measure('#question-primary')).find(b => b.shown); if (p) await r.page.mouse.click(p.left + p.w / 2, p.top + p.h / 2); }
        await r.page.waitForTimeout(500);
        const state = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question, text: (document.getElementById('question-state-word') || {}).textContent }));
        if (state.q === 'outcome') {
          const card = (await r.measure('#question'))[0], blobs = (await r.measure('#blobs'))[0];
          assert.ok(!overlap(card, blobs) || !blobs.shown, `${kind}: the «${state.text}» card ${label(card)} and the blobs column ${label(blobs)} share pixels`);
        } else { await r.screenshot(`/tmp/geo-note-${kind}.png`).catch(() => {}); }
        passed += 1;
      } catch (e) { await r.screenshot(`/tmp/geo-fail-recibida-${kind}.png`).catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // v4-12-q4-paso1: in a questionnaire step the CHOSEN option shows a clear selected mark (not only the hover highlight)
  {
    const r = await H.open({ question: 'form', github: true });
    try {
      const rows = (await r.measure('.q-option')).filter(b => b.shown);
      assert.ok(rows.length >= 3, 'the step shows its options');
      const before = await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].map(b => b.getAttribute('aria-checked') || b.dataset.selected || ''));
      await r.page.mouse.click(rows[1].left + rows[1].w / 2, rows[1].top + rows[1].h / 2);
      await r.page.waitForTimeout(300);
      await r.page.mouse.move(5, 5); // the pointer leaves: nothing but the selection may still mark the row
      await r.page.waitForTimeout(200);
      const after = await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].map(b => ({ checked: b.getAttribute('aria-checked'), selected: b.dataset.selected, mark: getComputedStyle(b, '::before').content, bg: getComputedStyle(b, '::after').backgroundColor, weight: getComputedStyle(b.querySelector('.q-label')).fontWeight })));
      assert.equal(after[1].selected, 'true', `the chosen row is marked selected: ${JSON.stringify(after[1])}`);
      assert.notEqual(after[1].selected, after[0].selected, 'only the chosen row');
      assert.notEqual(after[1].bg, after[0].bg, `the chosen row looks different WITHOUT hover (background ${after[1].bg} vs ${after[0].bg})`);
      assert.ok(after[1].mark && after[1].mark !== 'none', `a visible mark (a check or a filled radio): ${after[1].mark}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-selected-step.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // L5 (human): answer a question, and WHILE «Recibida» shows click the GitHub blob: the outcome goes at once and GitHub is the centre.
  {
    const r = await H.open({ question: 'plain', github: true, githubData: true });
    try {
      const opt = (await r.measure('.q-option')).find(b => b.shown);
      await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
      await r.page.waitForTimeout(700); // the host reported «answered»; «Recibida» is on screen (it lasts ~3 s)
      const during = await r.page.evaluate(() => document.getElementById('capsule').dataset.question);
      assert.equal(during, 'outcome', `«Recibida» is showing: ${during}`);
      const gh = (await r.measure('#pill-choice-integration_github')).find(b => b.shown);
      assert.ok(gh, 'the GitHub blob is visible while «Recibida» shows');
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2);
      await r.page.waitForTimeout(1200);
      const st = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', gh: document.getElementById('overview-view').dataset.github || null, card: !!document.querySelector('.gh-card:not([hidden])') }));
      assert.deepEqual(st, { q: '', gh: 'on', card: true }, `the outcome is gone and GitHub is the centre, well before the 3 s timer: ${JSON.stringify(st)}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-outcome-click.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  console.log(`island-geometry-check: ${passed} real-layout checks ok`);
})().catch(e => { console.error(e); process.exit(1); });
