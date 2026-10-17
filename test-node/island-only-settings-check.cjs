'use strict';
// Real shipped HTML/scripts/CSS in isolated headless Chromium. Only native IPC is mocked.
// No preview, service, sockets, npm packages, or persistent user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(root, '.browser-check-'));
const browser = spawn(process.env.CHROMIUM || '/snap/bin/chromium', [
  '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', stderr = '';
const pending = new Map(), events = new Map();
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const eventKey = `${message.sessionId}:${message.method}`;
    if (events.has(eventKey)) { const resolve = events.get(eventKey); events.delete(eventKey); resolve(); }
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result); }
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
const deadline = setTimeout(() => { console.error('Chromium check timed out\n' + stderr); browser.kill(); process.exitCode = 1; }, process.argv.length > 2 ? 25000 : 80000);
async function page(legacy) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width:1000, height:900, deviceScaleFactor:1, mobile:false });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.calls = []; window.listeners = {}; window.errors = [];
    addEventListener('error', e => errors.push(e.message));
    window.host = {state:'expanded', available:true, connections:1, notices:[], motionOverride:true, pending:null, card:null};
    window.prefs = {sound:false,settingsWindow:${legacy},theme:'dark',autoCloseSeconds:0};
    window.push = notices => { host.notices = notices; (listeners['desktop:state'] || []).forEach(fn => fn({payload:host})); };
    const invoke = async (cmd, args) => {
      const p = args && args.payload; calls.push({cmd,p});
      if (cmd === 'prefs_action') return prefs;
      if (cmd === 'settings_window_action') return {action:p.action,open:${legacy}};
      if (cmd === 'chat_action' && p.action === 'open') { __islandSetState('overview','top'); __islandSetView('chat',400,640); return {}; }
      if (cmd === 'settings_view') { __islandSetView('chat',p.open ? 720 : 400,p.open ? 680 : 640); return {}; }
      if (cmd === 'desktop_action') { if (p.action === 'dismiss') push(host.notices.filter(n => n.id !== (p.id || host.notices[0]?.id))); return host; }
      if (cmd === 'agent_action') return {connection:'no_daemon'};
      if (cmd === 'specialists_action') return {specialists:[],active:null};
      return {};
    };
    window.__TAURI_INTERNALS__ = {metadata:{currentWindow:{label:'main'}},invoke};
    window.__TAURI__ = {core:{invoke},event:{listen:async (name,fn) => { (listeners[name] ||= []).push(fn); return () => {}; }}};
  ` });
  const loaded = new Promise(resolve => {
    // Page load is observed through CDP, not a timed sleep.
    events.set(`${sessionId}:Page.loadEventFired`, resolve);
  });
  await command('Page.navigate', { url: pathToFileURL(path.join(root, 'frontend/index.html')).href });
  await loaded;
  const click = async selector => {
    const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await command('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...point });
    await command('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...point });
  };
  const settled = () => evaluate(`new Promise(resolve => {
    let last = '', still = 0;
    const frame = () => {
      const island = document.querySelector('#island'), capsule = document.querySelector('#capsule');
      const size = island.style.width + ',' + island.style.height;
      still = size === last && capsule.dataset.phase === 'expanded' ? still + 1 : 0; last = size;
      if (still >= 10) resolve(); else requestAnimationFrame(frame);
    }; frame();
  })`);
  return { evaluate, click, settled, command, close: () => send('Target.closeTarget', { targetId }) };
}
(async () => {
  if (process.argv.includes('--motion')) {
    const p = await page(false);
    const failures = [];
    for (const edge of ['top','bottom']) for (const [w,h] of [[400,640],[720,680]]) {
      await p.evaluate(`__islandSetState('overview',${JSON.stringify(edge)}); __islandSetView('chat',${w},${h})`); await p.settled();
      const frames = await p.evaluate(`(() => {
        const e=document.querySelector('#island'), read=() => ({w:parseFloat(e.style.width),h:parseFloat(e.style.height),top:e.style.top,bottom:e.style.bottom});
        const before=read(); __islandSetView('overview',640,160); return {before,first:read()};
      })()`);
      console.log(`motion ${edge}: ${JSON.stringify(frames)}`);
      if (Math.abs(frames.first.h - frames.before.h) > 0.1 || Math.abs(frames.first.w - frames.before.w) > 0.1) failures.push(`${edge}: overview dimensions overwrote the outgoing chat before its shrink`);
      await p.settled();
      const final = await p.evaluate(`({w:parseFloat(document.querySelector('#island').style.width),h:parseFloat(document.querySelector('#island').style.height)})`);
      assert.deepEqual(final, {w:640,h:160});
      assert.equal(frames.first[edge], '8px', `${edge} anchoring retained`);
    }
    await p.command('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await p.evaluate(`host.motionOverride=false; push([])`);
    for (const [view,w,h] of [['chat',400,640],['overview',640,160],['chat',720,680],['overview',640,160]]) {
      const instant = await p.evaluate(`__islandSetView('${view}',${w},${h}); ({w:parseFloat(document.querySelector('#island').style.width),h:parseFloat(document.querySelector('#island').style.height)})`);
      assert.deepEqual(instant, {w,h}, 'reduced motion snaps to final dimensions');
    }
    await p.close(); assert.deepEqual(failures, []);
    console.log('motion: top/bottom retain outgoing chat geometry before shrink and land on overview PASS');
    return;
  }
  if (process.argv.includes('--notices')) {
    const failures = [];
    const check = (value, message) => { if (!value) failures.push(message); };
    const p = await page(false);
    const capture = async name => {
      if (process.env.ABITO_BROWSER_EVIDENCE !== '1') return;
      const dir = path.resolve(root, '../../docs/desktop/evidence/island-only-settings-444');
      fs.mkdirSync(dir, {recursive:true});
      const shot = await p.command('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(shot.data, 'base64'));
      console.log(`Chromium DPR1 screenshot: ${path.join(dir, name + '.png')}`);
    };
    await p.command('Emulation.setDeviceMetricsOverride', { width:672, height:176, deviceScaleFactor:1, mobile:false });
    await p.evaluate(`__islandSetState('overview','top')`); await p.settled();
    for (const count of [0,1,2,8]) {
      await p.evaluate(`push(Array.from({length:${count}},(_,i) => ({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),kind:'settled',title:'Pi terminó Revisar PR '+i,detail:'Completado',at:Date.now(),expiresAt:Date.now()+60000})))`);
      const band = await p.evaluate(`(() => {const e=document.querySelector('#notice-pill'),r=e.getBoundingClientRect();return {hidden:e.hidden,w:r.width,bg:getComputedStyle(e).backgroundColor,title:document.querySelector('#notice-title').textContent};})()`);
      if (count === 0) check(band.hidden, '0 notices: no notice band');
      if (count === 1) {
        check(!band.hidden, '1 notice: visible single band');
        check(Math.abs(band.w - 164) < 1, '1 notice: existing single-band width stays unchanged');
      }
      if (count > 1) {
        check(Math.abs(band.w - 416) < 1, `${count} notices: grouped band must span 416 logical px, got ${band.w}`);
        check(band.title === `${count} avisos`, `${count} notices: exact grouped title`);
        check(/^rgb\(/.test(band.bg), `${count} notices: opaque card background prevents overview text bleed`);
        await capture(`notice-group-${count}`);
        await p.click('#notice-action');
        await capture(`notice-list-${count}`);
      }
      const geometry = await p.evaluate(`(() => {
        const rect = id => { const e=document.querySelector(id),r=e.getBoundingClientRect(),s=getComputedStyle(e); return {x:r.x,y:r.y,w:r.width,h:r.height,scroll:e.scrollHeight,client:e.clientHeight,display:s.display,visibility:s.visibility,opacity:s.opacity}; };
        return {count:${count},title:document.querySelector('#notice-title').textContent,band:rect('#notice-pill'),pane:rect('#notices'),list:rect('#notice-list'),rows:[...document.querySelectorAll('.notice-list-row')].map(e => ({h:e.getBoundingClientRect().height,y:e.getBoundingClientRect().y})),errors};
      })()`);
      console.log(JSON.stringify(geometry));
      if (count > 1) {
        check(Math.abs(geometry.list.w - 416) < 1, `${count} notices: list must span 416 logical px, got ${geometry.list.w}`);
        check(geometry.list.h >= 100, `${count} notices: list needs visible room for rows, got ${geometry.list.h}`);
        check(geometry.list.y + geometry.list.h <= 176, `${count} notices: list stays within native 176 logical px`);
        check(geometry.rows.every(r => Math.abs(r.h - 32) < 1), 'list rows are 32 logical px');
        check(await p.evaluate(`!calls.some(c => c.cmd === 'desktop_action' && c.p.action === 'click')`), 'Ver does not bypass native notice admission');
        if (count === 2) {
          await p.evaluate(`push(host.notices.slice(0,1))`);
          check(await p.evaluate(`!document.querySelector('#notice-pill').hidden`), '2→1: remaining single notice is visible on the SAME state push');
        }
        if (count === 8) {
          const scroll = await p.evaluate(`(() => {const e=document.querySelector('#notice-rows'); e.lastElementChild.scrollIntoView({block:'nearest'}); return {client:e.clientHeight,scroll:e.scrollHeight,top:e.scrollTop};})()`);
          check(scroll.client > 0 && scroll.scroll > scroll.client && scroll.top > 0, '8 notices: real bounded row viewport scrolls to last item');
          await p.click('.notice-list-row:last-child .notice-list-dismiss');
          check(await p.evaluate(`host.notices.length === 7 && !host.notices.some(n => n.id === '00000000-0000-4000-8000-000000000007')`), 'last row dismissal removes its exact id, not first');
          check(await p.evaluate(`calls.filter(c => c.cmd === 'desktop_action' && c.p.action === 'dismiss').at(-1)?.p.id === '00000000-0000-4000-8000-000000000007'`), 'dismissal carries exact id through real public facade');
        }
        await p.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
        check(await p.evaluate(`document.querySelector('#notice-list').hidden && document.querySelector('#capsule').dataset.view === 'overview'`), 'Escape returns to overview without native navigation');
      }
    }
    await p.close();
    assert.deepEqual(failures, [], 'notice renderer geometry/transition failures');
    console.log('notice geometry: 0/1/2/8 notices and 2→1 same-push return PASS');
    return;
  }
  for (const legacy of [false, true]) {
    const p = await page(legacy);
    await p.evaluate(`__islandSetState('overview','top')`); await p.settled();
    // Native compatibility entry uses the public selection event; actual
    // keyboard button activation is driven separately with trusted CDP input.
    await p.evaluate(`document.dispatchEvent(new CustomEvent('abito:settings-select',{detail:'open'}))`);
    await p.settled();
    assert.equal(await p.evaluate(`document.querySelector('#settings').dataset.open`), 'true', `legacy ${legacy}: public native entry stays in island`);
    await p.evaluate(`document.dispatchEvent(new CustomEvent('abito:settings-select',{detail:'general'}))`);
    assert.equal(await p.evaluate(`Boolean(document.querySelector('#settings-window-open, #sw-settings-window'))`), false, 'no placement controls');
    await p.click('#settings-close');
    await p.evaluate(`__islandSetView('chat',400,640)`); await p.settled();
    await p.click('#open-screen-settings');
    assert.equal(await p.evaluate(`document.querySelector('#settings').dataset.open`), 'true', `legacy ${legacy}: chat gear stays in island`);
    await p.click('#settings-close'); await p.settled();
    await p.evaluate(`document.querySelector('#open-screen-settings').focus()`);
    assert.equal(await p.evaluate(`document.activeElement.id`), 'open-screen-settings', 'gear accepts keyboard focus');
    // CDP needs Enter's character as well as keyDown to run native button
    // activation (matching a real key press, not a raw-key-only event).
    await p.command('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await p.command('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert.equal(await p.evaluate(`document.querySelector('#settings').dataset.open`), 'true', `legacy ${legacy}: trusted keyboard gear stays in island`);
    await p.command('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await p.command('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await p.evaluate(`document.activeElement.id`), 'open-screen-settings', 'Escape restores gear focus');
    await p.evaluate(`__islandSetView('overview',640,160)`); await p.settled();
    await p.click('#open-settings');
    assert.equal(await p.evaluate(`document.querySelector('#settings').dataset.open`), 'true', `legacy ${legacy}: overview gear stays in island`);
    assert.deepEqual(await p.evaluate(`calls.filter(c => c.cmd === 'settings_window_action' || c.p?.action === 'set_settings_window')`), []);
    assert.equal(await p.evaluate(`prefs.settingsWindow`), legacy, 'stored preference remains untouched');
    assert.deepEqual(await p.evaluate(`errors`), [], 'real scripts load without browser errors');
    console.log(`island-only-settings-check: legacy ${legacy}, keyboard + both gears + no controls + unchanged stored data PASS`);
    await p.close();
  }
  // The ordinary Node sweep must also exercise notice layout and the native
  // view-size callback, not just the Settings entry paths.
  for (const mode of ['--notices', '--motion']) {
    const child = spawnSync(process.execPath, [__filename, mode], { stdio:'inherit', timeout:30000 });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `${mode} browser checks`);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  clearTimeout(deadline);
  browser.once('close', () => fs.rmSync(profile, { recursive:true, force:true, maxRetries:3 }));
  browser.kill();
});
