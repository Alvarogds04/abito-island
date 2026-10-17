'use strict';
/* #336 T1b-b — wiring contract (S3-S5): index.html loads the T1a module
   BEFORE island.js, and island.js feeds the module the live facts/events and
   calls back ONLY through the existing desktop facade verbs. Source-level
   contract: no DOM execution, no native app, no gesture proof — isTrusted
   rejection stays pinned by the module's own public test
   (island-interaction-check.cjs), never claimed here.
   Run: node apps/desktop-tauri/test-node/island-interaction-wiring-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
// the stub below serves the REAL pure phase view (#439): the island's render
// loop delegates dataset.phase to O.viewPhase, so the fixture must too
const OV = require(path.join(frontend, 'overview-view.js'));
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

test('#336 index.html loads island-interaction.js exactly once, defer, before island.js', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\s+defer\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(scripts.filter(f => f === 'island-interaction.js').length, 1, 'exactly one script tag');
  const at = scripts.indexOf('island-interaction.js');
  assert.ok(at >= 0, 'the module must be in the curated script list');
  assert.ok(at < scripts.indexOf('island.js'), 'defer keeps document order: the module must run first');
  assert.ok(html.indexOf('src="island-interaction.js"') < html.indexOf('src="island.js"'), 'document order');
});

test('#336 island.js creates exactly ONE controller with the six required callbacks and hosted timers', () => {
  const src = read('island.js');
  assert.equal((src.match(/createController\(/g) || []).length, 1, 'one owned scheduler, never two');
  assert.match(src, /AbitoIslandInteraction\s*\?\s*window\.AbitoIslandInteraction\.createController\(\{/, 'the controller comes from the loaded module');
  for (const cb of ['now:', 'schedule:', 'cancel:', 'open:', 'autoClose:', 'onCountdown:']) {
    assert.ok(new RegExp(`\\b${cb}`).test(src), `callback ${cb}`);
  }
  assert.match(src, /schedule: \(fn, ms\) => setTimeout\(fn, ms\)/, 'hosted relative timers only');
  assert.match(src, /cancel: id => clearTimeout\(id\)/, 'the owned timer is cancellable');
});

test('#336 the effects go through the facade verbs and the adapter never moves focus', () => {
  const src = read('island.js');
  assert.match(src, /window\.desktop \? window\.desktop\.expand\(\)/, 'hover open requests the existing expand');
  assert.match(src, /window\.desktop \? window\.desktop\.autoClose\(\)/, 'the close is the new atomic verb');
  assert.match(src, /Promise\.reject\(new Error\('host unavailable'\)\)/, 'a missing host fails honestly');
  // scope the no-focus rule to the #336 adapter block: the file's own
  // pre-existing focus handling (Escape/focusAfterPhase) is not ours to touch.
  const start = src.indexOf('the inactivity interaction feed');
  const end = src.indexOf('---- notices (M2)');
  assert.ok(start >= 0 && end > start, 'the adapter block must exist between the pointer section and notices');
  assert.doesNotMatch(src.slice(start, end), /\.focus\(|set_focus/, 'the adapter never moves focus');
});

test('#336 the feed: facts update on native state/phase/view/DOM changes, prefs feed the typed pair', () => {
  const src = read('island.js');
  assert.match(src, /function syncInteraction\(/, 'one sync entry point');
  assert.match(src, /interaction\.update\(interactionFacts\(\)\)/, 'facts reach the module');
  assert.match(src, /function interactionFacts\(/, 'facts are built in one place');
  // every blocker of the public contract is fed explicitly (fail closed on absence)
  for (const key of ['question:', 'approval:', 'request:', 'decision:', 'card:', 'dragging:', 'editing:', 'composing:', 'draft:', 'settings:', 'models:']) {
    assert.ok(src.includes(key), `blocker fact ${key}`);
  }
  for (const key of ['state:', 'view:', 'settled:', 'nativeReady:']) assert.ok(src.includes(key), `host fact ${key}`);
  // native snapshot + phase/view + focus/draft + IME + prefs are the feed points
  assert.match(src, /syncInteraction\(\);/, 'sync is called from the feeds');
  assert.match(src, /attributeFilter: \['data-phase', 'data-view', 'data-settings', 'data-question', 'data-card'\]/, 'the capsule attributes are observed');
  assert.match(src, /compositionstart/, 'an IME session is a blocker');
  assert.match(src, /interaction\.enter\(/, 'pointer entry feeds the module');
  assert.match(src, /interaction\.leave\(/, 'pointer leave feeds the module');
  assert.match(src, /interaction\.engage\(/, 'a deliberate click/keyboard engagement feeds the module');
  assert.match(src, /setPreferences\(/, 'preferences reach the module');
  assert.match(src, /applyInteractionPrefs\(/, 'the typed pair goes through one guarded adapter');
  assert.match(src, /autoCloseSeconds/, 'the projection field is read');
  assert.match(src, /pagehide.*interaction\.stop\(\)|interaction\.stop\(\)/, 'teardown stops the scheduler');
});

test('#336 no innerHTML is reintroduced in island.js (#411) and the adapter owns no geometry', () => {
  const src = read('island.js');
  assert.doesNotMatch(src, /innerHTML/, 'icons stay DOM nodes, text stays textContent');
  assert.doesNotMatch(src, /setInterval\(.*interaction|requestAnimationFrame\(.*syncInteraction/, 'the scheduler never polls');
});

// ---- #336 L18: the engagement press through the facade spy ------------------
// Executes the REAL island.js + the REAL interaction module in a VM with a
// minimal host fixture; window.desktop and invoke are SPIES. isTrusted:true
// here is HANDLER SIMULATION ONLY — no native gesture, focus or geometry is
// proven (the module's own isTrusted rules stay pinned in
// island-interaction-check.cjs).
function engagementFixture(openOnHover) {
  const vm = require('node:vm');
  const moduleApi = require(path.join(frontend, 'island-interaction.js'));
  const invocations = [];
  const desktopCalls = [];
  const byId = new Map();
  const windowListeners = Object.create(null);
  const documentListeners = Object.create(null);
  const observers = [];
  const resolved = value => ({
    then(ok) { ok(value); return this; },
    catch() { return this; },
    finally(fn) { fn(); return this; },
  });
  const makeEl = () => {
    const listeners = Object.create(null);
    return {
      hidden: true, inert: false, disabled: false, value: '', textContent: '', tabIndex: 0,
      dataset: {},
      style: { width: '', height: '', top: '', bottom: '', left: '', borderRadius: '',
        setProperty() {}, getPropertyValue() { return '1'; } },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, appendChild() {},
      replaceChildren() {},
      addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
      removeEventListener() {},
      fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
      focus() {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
      closest() { return null; },
    };
  };
  const documentStub = {
    documentElement: makeEl(),
    body: makeEl(),
    activeElement: makeEl(), // no matches(): not a text field, so editing stays false
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement() { return makeEl(); }, importNode(n) { return n; },
    addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { for (const fn of documentListeners[ev.type] || []) fn(ev); return true; },
  };
  let snapshotState = { state: 'compact', notices: [], card: null, request: null,
    revision: 1, motionOverride: false, unavailable: false };
  const desktopHandlers = [];
  const desktop = {
    onState(fn) { desktopHandlers.push(fn); return () => {}; },
    snapshot() { return resolved(snapshotState); },
    expand() { desktopCalls.push('expand'); return resolved(snapshotState); },
    close() { desktopCalls.push('close'); return resolved(snapshotState); },
    autoClose() { desktopCalls.push('autoClose'); return resolved(snapshotState); },
    dismiss() { desktopCalls.push('dismiss'); return resolved(snapshotState); },
    click() { return resolved(snapshotState); },
    allow() { return resolved(snapshotState); },
    deny() { return resolved(snapshotState); },
  };
  const sandbox = {
    console,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => 0 },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    DOMParser: class { parseFromString() { return { documentElement: { nodeName: 'svg' } }; } },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    AbitoOverview: {
      viewPhase: OV.viewPhase,
      motionState: () => 'full', honorSystemMotion: () => false, choosePose: () => 'idle',
      hostPoseView: () => ({ tracker: { failing: false, since: 0 }, pose: null }),
      connectionView: () => ({ word: '', detail: '', tone: '', aria: '', icon: '' }),
      bridgeView: () => null, noticeView: () => null, hotkeyView: () => null,
      noticeBandView: () => null, noticeListView: () => null, // #437: the stub keeps the strip empty, like noticeView
      cardConnection: () => null, expiryLabel: () => '', expiryAria: () => '',
      cardView: () => ({ kind: 'inert', tone: '', icon: null, word: '', aria: '' }),
      infoLabel: a => a, hoverScale: () => 1,
    },
    AbitoCharacter: { create: () => ({ chat() {}, dragStart() {}, dragMove() {}, dragEnd() {},
      hover() {}, busy() {}, activity() {}, question() {}, snapshot() {}, destroy() {}, motionChanged() {} }) },
    AbitoIcons: { svg: () => '', ring: () => '' },
    AbitoIslandInteraction: moduleApi,
    __TAURI__: { core: { invoke(cmd, args) {
      invocations.push({ cmd, args });
      if (cmd === 'prefs_action') return resolved({ sound: false, avatarColors: {}, autoCloseSeconds: 15, openOnHover });
      if (cmd === 'hotkey_action') return resolved({ status: 'disabled' });
      if (cmd === 'question_action') return resolved({ available: false, pending: null });
      return resolved({});
    } } },
    desktop,
    document: documentStub,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.addEventListener = (name, fn) => { (windowListeners[name] ||= []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = ev => { for (const fn of windowListeners[ev.type] || []) fn(ev); return true; };
  vm.runInNewContext(read('island.js'), sandbox, { filename: 'island.js' });
  const fire = (bag, type, ev) => { for (const fn of bag[type] || []) fn(ev); };
  const pointer = extra => Object.assign({ isTrusted: true, pointerType: 'mouse', buttons: 0,
    clientX: 5, clientY: 5, isPrimary: true, button: 0 }, extra);
  return {
    invocations, desktopCalls,
    // the boot render mutates the observed attributes: fire them once
    mutate() { for (const o of observers) o.cb([]); },
    seed(state) {
      snapshotState = { ...snapshotState, state };
      for (const fn of desktopHandlers) fn(snapshotState);
      byId.get('capsule').dataset.phase = state === 'expanded' ? 'expanded' : 'compact';
      for (const o of observers) o.cb([]);
    },
    enter() { byId.get('capsule').fire('pointerenter', pointer({ type: 'pointerenter' })); },
    leave() { byId.get('capsule').fire('pointerleave', pointer({ type: 'pointerleave' })); },
    press() { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', target: { closest: () => null } })); },
    // a press on an element that matches the real selector list (e.g. a link): closest honours the selector
    pressOn(tag) { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', ctrlKey: true,
      target: { closest: sel => (String(sel).split(',').map(x => x.trim()).includes(tag) ? {} : null) } })); },
    release() { fire(windowListeners, 'pointerup', pointer({ type: 'pointerup' })); },
    click() { fire(documentListeners, 'click', pointer({ type: 'click' })); },
    dragReleases() { return invocations.filter(i => i.cmd === 'drag_release'); },
  };
}

test('#421 a Ctrl+click press on a link never starts a drag: no drag_press, no toggle, no collapse verb (facade spy)', () => {
  const f = engagementFixture(false);
  f.mutate();
  f.seed('expanded');
  f.pressOn('#settings a');
  f.release();
  assert.equal(f.invocations.filter(i => i.cmd === 'drag_press').length, 0, 'the link owns its click: no native drag press');
  assert.equal(f.dragReleases().length, 0, 'no release to toggle the island');
  assert.deepEqual(f.desktopCalls.filter(c => c !== 'expand'), [], 'no collapse verb after the click');
});

test('#421 narrowness: a press on a bare anchor outside #settings (and on the capsule) still sends drag_press', () => {
  const f = engagementFixture(false);
  f.mutate();
  f.seed('expanded');
  f.pressOn('a');
  f.release();
  assert.equal(f.invocations.filter(i => i.cmd === 'drag_press').length, 1, 'only an anchor inside #settings is exempt');
  f.press();
  f.release();
  assert.equal(f.invocations.filter(i => i.cmd === 'drag_press').length, 2, 'ordinary presses keep dragging');
});

test('#336 L18 the first press after a hover-open releases as cancelled: engaged, never collapsed (facade spy)', () => {
  const f = engagementFixture(true);
  f.mutate(); // the observers exist before the boot render fires
  f.enter();  // trusted mouse entry on the settled compact island -> hover open
  assert.deepEqual(f.desktopCalls, ['expand'], 'the hover requests the existing expand verb');
  f.seed('expanded'); // the native answer: snapshot + settled phase + fact sync
  f.press();
  f.release();
  let releases = f.dragReleases();
  assert.equal(releases.length, 1, 'one drag_release for the press/release pair');
  assert.equal(releases[0].args.cancelled, true,
    'the FIRST press after a hover-open consumes the engagement: cancelled:true skips the toggle (core.rs release)');
  f.click(); // the deliberate click that converts hover-only into the normal delay
  // the NEXT press toggles normally: no cancellation left to spend
  f.press();
  f.release();
  releases = f.dragReleases();
  assert.equal(releases.length, 2);
  assert.equal(releases[1].args.cancelled, false, 'the next click keeps the legacy toggle');
  f.click();
});

test('#336 L18 a click without a hover-open is unchanged: never cancelled (facade spy)', () => {
  const f = engagementFixture(false); // default preference: hover does not open
  f.mutate();
  f.enter();
  assert.deepEqual(f.desktopCalls, [], 'hover-off never requests an open');
  f.press();
  f.release();
  const releases = f.dragReleases();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].args.cancelled, false, 'a plain press/release keeps the legacy path byte for byte');
  f.click();
});

// ---- #419: the approved countdown decoration surface -----------------------

test('#419 index.html carries exactly one aria-hidden hidden countdown element inside #island', () => {
  const html = read('index.html');
  assert.equal((html.match(/id="island-countdown"/g) || []).length, 1, 'exactly one countdown element');
  const el = html.match(/<div id="island-countdown"[^>]*><\/div>/);
  assert.ok(el, 'the element is an empty decoration div');
  assert.match(el[0], /aria-hidden="true"/, 'pure decoration: hidden from the tree');
  assert.match(el[0], / hidden/, 'starts hidden; only the view shows it');
  const island = html.indexOf('<div id="island">');
  const at = html.indexOf('id="island-countdown"');
  const header = html.indexOf('<header id="island-header"');
  assert.ok(island >= 0 && island < at && at < header, 'the bar lives inside #island, before the header');
  assert.doesNotMatch(el[0], /style=|onclick|on\w+=/, 'strict CSP: no inline style or handlers');
});

test('#419 island.js wires the published countdown into the guarded view (two spots only)', () => {
  const src = read('island.js');
  assert.equal((src.match(/createCountdownView\(/g) || []).length, 1, 'the view is created exactly once');
  assert.match(src, /document\.getElementById\('island-countdown'\)/, 'the approved element is the only surface');
  // guarded creation: a missing module, export or element keeps everything a no-op
  const creation = src.match(/const countdownView = [\s\S]*?;/);
  assert.ok(creation, 'one guarded view creation');
  assert.match(creation[0], /window\.AbitoIslandInteraction\s*&&/, 'module present');
  assert.match(creation[0], /createCountdownView/, 'export present');
  assert.match(creation[0], /countdownEl/, 'element present');
  assert.match(src, /onCountdown: value => \{ if \(countdownView\) countdownView\.update\(value\); \}/,
    'the hook renders the published value and nothing else');
  assert.doesNotMatch(src, /innerHTML/, 'no innerHTML anywhere (#411 unchanged)');
});

test('#419 style.css rules: theme tokens, transform token, reduced motion, no system media query', () => {
  const css = read('style.css');
  assert.ok(/#island-countdown \{/.test(css), 'the bar has rules');
  assert.match(css, /transform: scaleX\(var\(--island-countdown-fraction/, 'the fraction drives the shrink');
  const reduce = css.match(/html\[data-motion="reduce"\] #island-countdown[^{]*\{[^}]*\}/);
  assert.ok(reduce && /transition:\s*none/.test(reduce[0]), 'Abito owns reduced motion: reduce removes the transition');
  const block = css.match(/#island-countdown \{[^}]*\}/)[0];
  assert.match(block, /position:\s*absolute/, 'no layout shift: the bar never reflows the island');
  assert.match(block, /pointer-events:\s*none/, 'decoration never intercepts input');
  assert.match(block, /var\(--faint\)/, 'track uses an existing theme token');
  assert.match(block, /height:\s*3px/, '#437 D11: the design draws a 3 px countdown bar at the bottom (was 2 px)');
  assert.ok(/#island-countdown::before \{[^}]*var\(--island-live\)/.test(css), 'fill uses an existing theme token');
  assert.doesNotMatch(css.slice(css.indexOf('#island-countdown')), /@media[^{]*prefers-reduced-motion/,
    'no system media query: island.js paints data-motion');
});

console.log(`island-interaction-wiring-check: ${passed} passed`);
