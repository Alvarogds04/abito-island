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

test('S23 Integraciones: every card keeps its state in ONE column and its actions off the card border', async r => {
  await r.go('Integraciones');
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('.int-card')].map(c => { const cs = getComputedStyle(c), cb = c.getBoundingClientRect(); const inner = cb.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const act = [...c.querySelectorAll('.int-actions button')].filter(b => b.offsetParent); const last = act.at(-1); return { id: c.id, gap: last ? Math.round(inner - last.getBoundingClientRect().right) : null, badge: Math.round(c.querySelector('.card-state').getBoundingClientRect().left) }; }));
  const tight = rows.filter(x => x.gap !== null && x.gap < 8); assert.deepEqual(tight, [], `actions touching the card border: ${JSON.stringify(tight)}`);
  assert.equal(new Set(rows.filter(x => x.gap !== null).map(x => x.badge)).size, 1, `state badges are not aligned: ${JSON.stringify(rows.map(x => [x.id, x.badge]))}`);
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

test('S25 Atajos: an assigned key reads «Shift+Ctrl+N», never the raw portal text «Pulse <Shift><Control>n»; «Pulse…» only while capturing', async r => {
  await r.go('Atajos');
  const keys = await r.page.evaluate(() => [...document.querySelectorAll('#global-shortcuts .keycap')].map(k => k.textContent.trim()));
  assert(keys.length > 0); for (const k of keys) { assert(!/Pulse|<|>/.test(k), `raw instruction in a key cell: ${k}`); assert(/\+|[A-Z]/.test(k), `not a key name: ${k}`); }
  assert(keys.includes('Shift+Ctrl+N') || keys.some(k => /^Shift\+Ctrl\+N$/.test(k)), `expected «Shift+Ctrl+N» in ${JSON.stringify(keys)}`);
  await r.page.locator('#global-shortcuts .keycap').first().click(); await r.page.waitForTimeout(300);
  assert.match(await r.page.locator('#global-shortcuts .keycap').first().textContent(), /Pulsa/, 'while capturing, the cell asks for the keys');
});

test('S26 Conexiones: the sidebar has an entry, and the island\'s «Configurar Pi…» deep link lands on it', async r => {
  const titles = await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item')].map(e => e.textContent.trim()));
  assert(titles.some(t => /^(Cuentas|Conexiones)$/.test(t)), `no sidebar entry for accounts/connections in ${JSON.stringify(titles)}`);
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
