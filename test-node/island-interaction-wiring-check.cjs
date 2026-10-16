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
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

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

console.log(`island-interaction-wiring-check: ${passed} passed`);
