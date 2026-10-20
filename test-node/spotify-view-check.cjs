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

  await test('progress: position runs on from positionAt while playing; ads are not seekable; formatTime is m:ss', () => {
    const st = { running: true, playing: true, position: 30, positionAt: 1000, track: { id: 'spotify:track:1', duration: 200 } };
    const p = S.progressView(st, 11000);
    assert.deepEqual([p.elapsed, p.remaining, p.seekable, p.fraction], ['0:40', '-2:40', true, 0.2]);
    assert.equal(S.progressView({ ...st, playing: false }, 99000).elapsed, '0:30', 'paused: no run-on');
    assert.equal(S.progressView({ ...st, position: 190 }, 99000).elapsed, '3:20', 'clamped to the duration');
    assert.equal(S.progressView({ ...st, track: { id: 'spotify:ad:9', duration: 30 } }, 1000).seekable, false);
    assert.deepEqual(S.progressView({ running: false }, 1).seekable, false);
    assert.equal(S.formatTime(65.9), '1:05'); assert.equal(S.formatTime(-4), '0:00'); assert.equal(S.formatTime(NaN), '0:00');
    assert.equal(S.volumeOf({ volume: 42 }), 42); assert.equal(S.volumeOf({ volume: 400 }), 100); assert.equal(S.volumeOf(null), 0);
  });

  await test('valuedPayload: closed set matching spotify.rs parse_command (seek >=0, volume 0..100 int, shuffle/repeat bool)', () => {
    assert.deepEqual(S.valuedPayload('seek', 12.5), { action: 'seek', value: 12.5 });
    assert.deepEqual(S.valuedPayload('volume', 33.4), { action: 'volume', value: 33 });
    assert.deepEqual(S.valuedPayload('volume', 150), { action: 'volume', value: 100 });
    assert.deepEqual(S.valuedPayload('shuffle', true), { action: 'shuffle', value: true });
    assert.deepEqual(S.valuedPayload('repeat', false), { action: 'repeat', value: false });
    for (const [a, v] of [['seek', NaN], ['seek', 'x'], ['shuffle', 1], ['repeat', 'true'], ['next', 1], ['view', true], ['volume', undefined], ['rm', 1]]) assert.equal(S.valuedPayload(a, v), null, `${a}/${v}`);
  });

  await test('controller: a valued control sends exactly that payload, only while shown', async () => {
    const calls = [];
    const c = S.controller({ invoke: (cmd, a) => { calls.push(a.payload); return Promise.resolve({ ok: true, state: { running: true } }); }, onState() {} });
    await c.control('seek', 5); assert.deepEqual(calls, [], 'not shown: nothing sent');
    await c.show(); await c.control('seek', 5); await c.control('volume', 20); await c.control('seek', NaN); await c.control('shuffle', true);
    assert.deepEqual(calls, [{ action: 'view' }, { action: 'seek', value: 5 }, { action: 'volume', value: 20 }, { action: 'shuffle', value: true }]);
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

  await test('artwork: only native raster bytes for the current local track, never remote URLs', () => {
    const artwork = {artUrl:'file:///tmp/cover.png', mime:'image/png', data:'iVBORw0KGgo='};
    const st = {running:true,track:{artUrl:artwork.artUrl},artwork};
    assert.deepEqual(S.artworkView(st), artwork);
    assert.equal(S.artworkView({...st,track:{artUrl:'file:///tmp/next.png'}}), null);
    assert.equal(S.artworkView({...st,artwork:{...artwork,mime:'image/svg+xml'}}), null);
    assert.equal(S.artworkView({...st,artwork:{...artwork,data:'<svg>'}}), null);
    assert.equal(S.artworkView({running:true,track:{artUrl:'https://i.scdn.co/fixture'}}), null);
  });
  await test('seek: native readback is applied, but late controls after hide cannot repaint', async () => {
    let release; const states=[];
    const ctl=S.controller({invoke:(_cmd,a)=>a.payload.action==='seek'?new Promise(r=>{release=r;}):Promise.resolve({}),onState:s=>states.push(s)});
    await ctl.show(); const pending=ctl.control('seek',90); await ctl.hide();
    release({ok:true,state:{position:90}}); await pending; assert.deepEqual(states,[]);
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
