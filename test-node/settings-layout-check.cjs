'use strict';
/* Ajustes in a REAL layout engine (headless Chromium, the real settings.html + CSS + scripts, fake Tauri hosts shaped like the real
   ones). The DOM-fake design checks (settings-designs-*) passed while the human's screen validation found: a dropdown where the MD
   asks for segmented pills, a slider on the edge, a title broken «Wi-/Fi.», a column order that disagrees with its header, raw
   «Pulse <Shift><Control>n» in the key cell, a «Conectar» touching the card border, a missing sidebar entry. Only a layout can see
   those. Run: node test-node/settings-layout-check.cjs  (SKIPs loudly without playwright, never a silent pass). */
const assert = require('node:assert/strict');
const H = require('./settings-layout-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED settings-layout-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }
const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('S18 General: «Tema» is three segmented pills Oscuro / Claro / Sistema, one selected, never a dropdown', async r => {
  await r.go('General');
  const pills = await r.page.evaluate(() => { const g = document.getElementById('hub-theme'); return g ? [...g.querySelectorAll('button')].map(b => [b.textContent, b.classList.contains('on'), b.getAttribute('aria-pressed')]) : null; });
  assert.deepEqual(pills, [['Oscuro', false, 'false'], ['Claro', false, 'false'], ['Sistema', true, 'true']]);
  assert.equal(await r.page.evaluate(() => !!document.querySelector('.abito-card select[aria-label="Tema"]')), false, 'no <select> for the theme');
  await r.page.locator('#hub-theme button', { hasText: 'Oscuro' }).click(); await r.page.waitForTimeout(300);
  assert((await r.calls()).some(([c, a]) => c === 'prefs_action' && a === 'set_theme'), 'the same closed set_theme command');
});

test('S18 General: every row of every card stays inside its card (the volume slider no longer overlaps the right edge)', async r => {
  await r.go('General');
  const bad = await r.page.evaluate(() => { const out = []; for (const card of document.querySelectorAll('.abito-card')) { const cb = card.getBoundingClientRect();
    for (const el of card.querySelectorAll('input, select, button, .row')) { const b = el.getBoundingClientRect(); if (!b.width) continue; if (b.right > cb.right - 8 || b.left < cb.left) out.push([el.id || el.className || el.tagName, Math.round(b.right - cb.right)]); } } return out; });
  assert.deepEqual(bad, [], `controls touching or past their card's edge: ${JSON.stringify(bad)}`);
});

test('S18 General: «Atajo del sistema» is not a loose label: it is a value row or it is not there', async r => {
  await r.go('General');
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card .row')].map(row => { const label = row.querySelector('label'); return { label: label ? label.textContent.trim() : '', controls: row.querySelectorAll('input,select,button,.switch,.keycap').length, text: row.textContent.trim().length }; }));
  const loose = rows.filter(x => x.label && x.controls === 0 && x.text <= x.label.length + 1);
  assert.deepEqual(loose, [], `a label with nothing to show: ${JSON.stringify(loose)}`);
});

test('S19 Pills: no card of the page is an empty box (the «Colores de identidad» section drew an empty field over the Abito row)', async r => {
  await r.go('Pestañas activas');
  const empty = await r.page.evaluate(() => [...document.querySelectorAll('.hub-card')].filter(c => !c.children.length && !c.textContent.trim()).map(c => c.parentElement && c.parentElement.querySelector('.hub-label') ? c.parentElement.querySelector('.hub-label').textContent : c.className));
  assert.deepEqual(empty, [], `empty cards: ${JSON.stringify(empty)}`);
  const rows = await r.page.evaluate(() => { const sec = [...document.querySelectorAll('section')].find(s => /colores de identidad/i.test((s.querySelector('.hub-label') || {}).textContent || '')); const card = sec.querySelector('.hub-card'); return { rowInsideCard: !!card && !!card.querySelector('.hub-row'), rows: sec.querySelectorAll('.hub-row').length }; });
  assert(rows.rows > 0 && rows.rowInsideCard, `the Abito colour row must live INSIDE the card: ${JSON.stringify(rows)}`);
});

test('S20 Agentes: with every agent in `error` the table at rest repeats NO failure caption; only a failed action says so, once', async r => {
  await r.go('Agentes');
  const caption = 'No se pudo completar; no se tocó nada.';
  assert.equal((await r.text('.hub-page')).split(caption).length - 1, 0, 'standing captions under the rows');
  assert.equal((await r.page.evaluate(() => [...document.querySelectorAll('.agent-row .agent-state')].filter(e => /No se pudo/.test(e.textContent)).length)) > 0, true, 'the state column still reports the state');
});

test('S20 Agentes: a refused install shows ONE sentence in the status line, and nowhere else', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 680, agentsOk: true, failInstall: true });
  try {
    await f.go('Agentes');
    await f.page.locator('#agent-row-claude-code button', { hasText: 'Instalar hooks' }).click(); await f.page.waitForTimeout(300);
    await f.page.locator('#agent-row-claude-code button', { hasText: 'Respaldar y escribir' }).click(); await f.page.waitForTimeout(800);
    const status = await f.text('#agent-action-status');
    assert.equal(status.trim(), 'No se pudo completar la acción en Claude Code; no se tocó nada.');
    assert.equal((await f.text('.hub-page')).split('no se tocó nada').length - 1, 1, 'exactly one copy on the page');
  } finally { await f.close(); }
});

test('S21 Chat: «Probar» is VISIBLE on a card without a key, disabled, and its reason is on screen as text', async r => {
  await r.go('Chat');
  const probes = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card')].filter(c => c.querySelector('input[id^="chat-key-"]')).map(c => { const b = [...c.querySelectorAll('button')].find(x => x.textContent === 'Probar'); if (!b) return null; const rc = b.getBoundingClientRect(); const reason = c.querySelector('.test-reason');
    return { card: c.querySelector('h2').textContent.trim().slice(0, 12), visible: rc.width > 0 && rc.height > 0, disabled: b.disabled, reason: reason ? reason.textContent : null, reasonVisible: reason ? reason.getBoundingClientRect().height > 0 : false }; }));
  assert(probes.length >= 4 && probes.every(Boolean), `every provider card shows Probar: ${JSON.stringify(probes)}`);
  for (const p of probes) { assert(p.visible, `${p.card}: Probar not visible`); assert(p.disabled, `${p.card}: Probar must be disabled without a key`); assert.equal(p.reason, 'Guarda una clave para poder probarla.'); assert(p.reasonVisible, `${p.card}: the reason must be on screen`); }
});

test('S23 Integraciones: state and actions form COLUMNS shared by every card (a row without «¿Dónde?» no longer shifts «Conectar»), off the card border', async r => {
  await r.go('Integraciones');
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('.int-card')].map(c => { const cb = c.getBoundingClientRect();
    const vis = sel => [...c.querySelectorAll(sel)].filter(b => b.offsetParent);
    const connect = vis('.int-actions button').find(b => b.textContent === 'Conectar'), help = vis('.int-actions button').find(b => b.textContent.startsWith('¿Dónde'));
    const last = vis('.int-actions button').at(-1);
    return { id: c.id, badge: Math.round(c.querySelector('.card-state').getBoundingClientRect().left), connect: connect ? Math.round(connect.getBoundingClientRect().left) : null,
      help: help ? Math.round(help.getBoundingClientRect().left) : null, borderGap: last ? Math.round(cb.right - last.getBoundingClientRect().right) : null }; }));
  const tight = rows.filter(x => x.borderGap !== null && x.borderGap < 8); assert.deepEqual(tight, [], `actions touching the card border: ${JSON.stringify(tight)}`);
  const col = key => [...new Set(rows.filter(x => x[key] !== null).map(x => x[key]))];
  assert.equal(col('badge').length, 1, `state badges are not in one column: ${JSON.stringify(rows.map(x => [x.id, x.badge]))}`);
  assert.equal(col('connect').length, 1, `«Conectar» is not in one column: ${JSON.stringify(rows.filter(x => x.connect !== null).map(x => [x.id, x.connect]))}`);
  assert.equal(col('help').length, 1, `«¿Dónde?» is not in one column: ${JSON.stringify(rows.filter(x => x.help !== null).map(x => [x.id, x.help]))}`);
});

test('S24 Teléfono: no line of the hero ends in a hyphen that splits a word («Wi-/Fi.»)', async r => {
  await r.go('Teléfono');
  const breaks = await r.page.evaluate(() => { const out = [];
    for (const el of document.querySelectorAll('.hub-hero h1, .hub-hero p')) { const node = el.firstChild; if (!node || node.nodeType !== 3) continue; const text = node.textContent; let lastTop = null;
      for (let i = 0; i < text.length; i++) { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1); const rect = range.getClientRects()[0]; if (!rect) continue;
        const top = Math.round(rect.top); if (lastTop !== null && top > lastTop + 4) { const before = text.slice(0, i).trimEnd().slice(-1); const after = text[i]; if (/[-\u2010]/.test(before) && /\p{L}/u.test(after)) out.push(text.slice(Math.max(0, i - 6), i + 4)); } lastTop = top; } }
    return out; });
  assert.deepEqual(breaks, [], `a word split at its hyphen: ${JSON.stringify(breaks)}`);
});

test('S25 Atajos: visual order is Acción | Tecla | Estado, a header over every column, the switch lives INSIDE the action cell', async r => {
  await r.go('Atajos');
  const grid = await r.page.evaluate(() => { const head = [...document.querySelectorAll('.shortcut-head [role=columnheader]')].map(e => [e.textContent, Math.round(e.getBoundingClientRect().left)]);
    const row = document.querySelector('#global-shortcuts .shortcut'); const sw = row.querySelector('.switch').getBoundingClientRect(), name = row.querySelector('.shortcut-name').getBoundingClientRect(), key = row.querySelector('.keycap').getBoundingClientRect(), st = row.querySelector('.shortcut-state').getBoundingClientRect();
    return { head, sw: Math.round(sw.left), name: Math.round(name.left), key: Math.round(key.left), st: Math.round(st.left) }; });
  assert.deepEqual(grid.head.map(h => h[0]), ['Acción', 'Tecla', 'Estado']);
  assert(grid.sw >= grid.head[0][1] - 2 && grid.sw < grid.name, `the switch must sit in the Acción column (header at ${grid.head[0][1]}, switch at ${grid.sw}, name at ${grid.name})`);
  assert(Math.abs(grid.key - grid.head[1][1]) <= 6, `Tecla column misaligned: header ${grid.head[1][1]} vs key ${grid.key}`);
  assert(Math.abs(grid.st - grid.head[2][1]) <= 6, `Estado column misaligned: header ${grid.head[2][1]} vs state ${grid.st}`);
  assert(grid.name < grid.key && grid.key < grid.st, 'Acción, then Tecla, then Estado');
});

test('S25 Atajos: an assigned key reads «Ctrl+Shift+N» (the page\'s canonical modifier order), never the raw portal text «Pulse <Shift><Control>n»; «Pulse…» only while capturing', async r => {
  await r.go('Atajos');
  const keys = await r.page.evaluate(() => [...document.querySelectorAll('#global-shortcuts .keycap')].map(k => k.textContent.trim()));
  assert(keys.length > 0); for (const k of keys) { assert(!/Pulse|<|>/.test(k), `raw instruction in a key cell: ${k}`); assert(/\+|[A-Z]/.test(k), `not a key name: ${k}`); }
  assert(keys.includes('Ctrl+Shift+N'), `expected «Ctrl+Shift+N» in ${JSON.stringify(keys)}`);
  // same modifier order as every other row of the page (Ctrl, Alt, Shift): one convention, not two
  for (const k of keys) { const mods = k.split('+').slice(0, -1); const order = ['Ctrl', 'Alt', 'Shift', 'Win']; assert.deepEqual(mods, [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `modifier order in ${k}`); }
  await r.page.locator('#global-shortcuts .keycap').first().click(); await r.page.waitForTimeout(300);
  assert.match(await r.page.locator('#global-shortcuts .keycap').first().textContent(), /Pulsa/, 'while capturing, the cell asks for the keys');
});

test('Ajustes opens without waiting for the dictation status: the sidebar is there at once even when that host answer takes 3 s', async r => {
  await r.close();
  const slow = await H.open({ width: 960, height: 680, statusDelayMs: 3000 });
  try {
    const ms = await slow.shellAfter();
    assert(ms < 1500, `the sidebar waited ${ms} ms for dictation_action{status} (device enumeration + keychain happen before it answers)`);
    // the page that needs the status still gets it when it arrives
    await slow.page.waitForTimeout(3300);
    assert.match(await slow.text('.hub-status'), /Listo|Dictado|modelo|micr/i, 'the status line is filled in once the real answer lands');
  } finally { await slow.close(); }
});

test('S26 Conexiones: the sidebar has a «Conexiones» entry that opens a page with the engine state first and one card per account', async r => {
  const titles = await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item')].map(e => e.textContent.trim()));
  assert(titles.includes('Conexiones'), `no «Conexiones» entry in ${JSON.stringify(titles)}`);
  await r.go('Conexiones');
  assert.equal((await r.text('.hub-hero h1')).trim(), 'Conexiones');
  // the first thing a person sees: the topmost visible element with an id inside the page
  const first = await r.page.evaluate(() => { const ids = [...document.querySelectorAll('#settings-root [id]')].filter(e => e.getBoundingClientRect().height > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); return ids[0] ? ids[0].id : null; });
  assert.equal(first, 'engine-status', 'the engine state comes first');
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('[id^="provider-"]')].map(e => e.id)), ['provider-pi', 'provider-claude']);
});

test('S26 deep link: opened FOR «Configurar Pi…» (Rust names the page), Ajustes lands on Conexiones, not on Dictado', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 680, page: 'accounts' });
  try {
    await f.shellAfter(); await f.page.waitForTimeout(700);
    const on = await f.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim()));
    assert.deepEqual(on, ['Conexiones'], `landed on ${JSON.stringify(on)}`);
    assert.equal((await f.text('.hub-hero h1')).trim(), 'Conexiones');
  } finally { await f.close(); }
});

test('S26 deep link on an ALREADY OPEN window: Rust sends abito:hub-select and the page changes; a foreign id is ignored', async r => {
  await r.go('General');
  await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:hub-select', { detail: 'accounts' }))); await r.page.waitForTimeout(500);
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim())), ['Conexiones']);
  for (const bad of ['../x', 'Accounts', '', 7, null, { detail: 'general' }, ['general']]) { await r.page.evaluate(b => document.dispatchEvent(new CustomEvent('abito:hub-select', { detail: b })), bad); await r.page.waitForTimeout(150); }
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim())), ['Conexiones'], 'a foreign id never moves the window');
});

test('S26 deep link: an unknown or hostile page name falls back to the default page (the closed list decides)', async r => {
  await r.close();
  for (const bad of ['../x', 'accounts ', '<img>', 'constructor', '__proto__', '']) {
    const f = await H.open({ width: 960, height: 680, page: bad });
    try { await f.shellAfter(); await f.page.waitForTimeout(500);
      const on = await f.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim()));
      assert.deepEqual(on, ['Dictado'], `${JSON.stringify(bad)} -> ${JSON.stringify(on)}`); }
    finally { await f.close(); }
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const r = await H.open({ width: 960, height: 680 });
    try { await fn(r); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`not ok - ${name}\n  ${String(e.message).split('\n')[0]}`); }
    finally { await r.close(); }
  }
  if (failed) process.exitCode = 1; else console.log(`PASS settings-layout: ${tests.length} real-layout checks`);
})();
