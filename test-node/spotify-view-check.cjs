'use strict';
/* #467 — pure checks for frontend/spotify-view.js (view-model + show/hide lifecycle). No DOM, no IPC.
   Run: node apps/desktop-tauri/test-node/spotify-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const S = require(path.join(frontend, 'spotify-view.js'));
let passed = 0;
const test = async (_n, fn) => { await fn(); passed += 1; };

(async () => {
  await test('wanted: only Linux and only when prefs name the pill (main or declared)', () => {
    assert.equal(S.wanted({ mainPill: 'integration_spotify' }, 'linux'), true);
    assert.equal(S.wanted({ mainPill: 'integration_claude', declaredPills: ['integration_spotify'] }, 'linux'), true);
    assert.equal(S.wanted({ mainPill: 'integration_spotify' }, 'windows'), false);
    for (const bad of [null, undefined, [], 'x', {}, { declaredPills: 'integration_spotify' }, { declaredPills: ['integration_github'] }]) assert.equal(S.wanted(bad, 'linux'), false);
  });

  await test('cardView: track/artist from the state, quiet line when Spotify is closed', () => {
    const t = S.cardView({ running: true, playing: true, track: { title: 'Song', artist: 'Band', artUrl: 'https://x/y.png' } });
    assert.deepEqual([t.kind, t.title, t.artist, t.playing, t.controls], ['track', 'Song', 'Band', true, true]);
    assert.match(t.aria, /Song, Band\. Reproduciendo/);
    assert.equal(S.cardView({ running: true, playing: false, track: { title: 'S', artist: '' } }).aria, 'Spotify: S. En pausa');
    const c = S.cardView({ running: false, track: null });
    assert.deepEqual([c.kind, c.title, c.controls], ['closed', 'Spotify no está abierto', false]);
    assert.equal(S.cardView({ running: true, track: null }).kind, 'idle');
    for (const bad of [null, undefined, 'x', [], { running: 'yes' }]) assert.equal(S.cardView(bad).kind, 'closed');
    assert.equal(S.cardView({ running: true, track: { title: 5 } }).kind, 'idle');
  });

  await test('cardView: text is bounded and control characters never reach the card', () => {
    const v = S.cardView({ running: true, playing: true, track: { title: 'a\u0000b\nc' + 'z'.repeat(500), artist: 'q' } });
    assert.ok(!/[\u0000-\u001f]/.test(v.title));
    assert.ok([...v.title].length <= 120);
  });

  await test('payload: closed control set', () => {
    assert.deepEqual(S.payload('next'), { action: 'next' });
    for (const bad of ['view', 'stop', 'seek', 'volume', '', 'rm', undefined]) assert.equal(S.payload(bad), null);
  });

  await test('controller: view once on show, stop once on hide, controls only while shown', async () => {
    const calls = [], states = [];
    const state = { running: true, playing: true, track: { title: 'T', artist: 'A' } };
    const ctl = S.controller({ invoke: (cmd, a) => { calls.push([cmd, a.payload.action]); return Promise.resolve({ ok: true, state }); }, onState: s => states.push(s) });
    await ctl.control('next');
    assert.deepEqual(calls, [], 'no control before the card is shown');
    await ctl.show(); await ctl.show();
    assert.deepEqual(calls, [['spotify_action', 'view']]);
    assert.deepEqual(states, [state]);
    await ctl.control('play_pause'); await ctl.control('seek');
    assert.deepEqual(calls.map(c => c[1]), ['view', 'play_pause']);
    await ctl.hide(); await ctl.hide();
    assert.deepEqual(calls.map(c => c[1]), ['view', 'play_pause', 'stop']);
    await ctl.control('next');
    assert.equal(calls.length, 3);
  });

  await test('controller: a failing view reads as closed; a late answer after hide is dropped', async () => {
    const states = [];
    const bad = S.controller({ invoke: () => Promise.reject({ code: 'unsupported' }), onState: s => states.push(s) });
    await bad.show();
    assert.deepEqual(states, [null]);
    let release; const late = []; 
    const slow = S.controller({ invoke: (c, a) => (a.payload.action === 'view' ? new Promise(r => { release = r; }) : Promise.resolve({})), onState: s => late.push(s) });
    const p = slow.show(); await slow.hide(); release({ ok: true, state: { running: true } }); await p;
    assert.deepEqual(late, []);
  });

  await test('wiring: loaded by index.html, one section, CSP untouched, no image/network use, settings window inert', () => {
    const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
    assert.equal((html.match(/src="spotify-view\.js"/g) || []).length, 1);
    assert.equal((html.match(/id="spotify-card"/g) || []).length, 1);
    const src = fs.readFileSync(path.join(frontend, 'spotify-view.js'), 'utf8');
    assert.ok(!/innerHTML|createElement\('img'\)|new Image|fetch\(|artUrl\b.*src/.test(src.replace(/\/\*[\s\S]*?\*\//, '')));
    assert.match(src, /label === 'settings'/);
    assert.match(src, /pagehide/);
  });

  console.log(`spotify-view-check: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
