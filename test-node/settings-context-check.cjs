'use strict';
// #487: the «Contexto de la ventana activa» switch on the Chat page: off by default, one closed
// prefs_action per change, untrusted clicks send nothing, and the settings guard knows the action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { renderChatSettings } = await import(pathToFileURL(path.join(base, 'chat.js')));
  const V = require('../frontend/settings-view.js'), C = require('../frontend/chat-view.js');
  const calls = []; let on = false, available = false, ui;
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'prefs_action' && p.action === 'set_window_context') { on = p.window_context; return { windowContext: on, windowContextAvailable: available, chosenModels: {} }; }
    if (cmd === 'prefs_action') return { windowContext: on, windowContextAvailable: available, chosenModels: {} };
    if (cmd === 'secret_action') return { present: false };
    return {};
  };
  ui = await renderChatSettings({ invoke, V, C, listen: async () => () => {}, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  const section = all(ui).find(e => e.tagName === 'section' && text(e).includes('Contexto de la ventana activa'));
  assert(section, 'section present');
  assert(text(section).includes('extensión de GNOME no está disponible'), 'missing extension is stated honestly');
  assert(text(section).includes('sh apps/desktop-tauri/gnome-extension/install.sh'), 'exact installation command');
  assert(text(section).includes('gnome-extensions enable abito-context@abito'), 'explicit enable command');
  assert(text(section).includes('cerrar sesión'), 'Wayland first installation requires logout/login');
  const sw = all(section).find(e => e.tagName === 'button' && String(e.className).includes('switch'));
  assert(sw && !sw.disabled, 'switch present and enabled once prefs are known');
  assert(!String(sw.className).includes('on') && sw.attrs['aria-checked'] !== 'true', 'off by default');
  calls.length = 0; sw.fire('click', false); await ui.settled();
  assert.deepEqual(calls, [], 'an untrusted click sends nothing');
  sw.fire('click'); await ui.settled();
  assert.deepEqual(calls.splice(0), [['prefs_action', { action: 'set_window_context', window_context: true }]]);
  const again = all(ui).find(e => e.tagName === 'button' && String(e.className).includes('switch') && all(section).includes(e));
  again.fire('click'); await ui.settled();
  assert.deepEqual(calls.splice(0), [['prefs_action', { action: 'set_window_context', window_context: false }]]);
  assert(text(section).includes('título'), 'the privacy copy says what is read');
  ui.dispose();
  available = true;
  ui = await renderChatSettings({ invoke, V, C, listen: async () => () => {}, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  assert(text(ui).includes('extensión de GNOME está disponible'), 'available state is explicit');
  assert(!text(ui).includes('sh apps/desktop-tauri/gnome-extension/install.sh'), 'do not offer installation when already available');
  assert(text(ui).includes('no se captura la URL'), 'do not promise unsupported URL capture');
  ui.dispose();
  const guard = fs.readFileSync(path.resolve(__dirname, '../frontend/settings-app.js'), 'utf8');
  assert(guard.includes('set_window_context') && guard.includes("typeof args.payload.window_context !== 'boolean'"), 'exact guard in settings-app.js');
  console.log('settings-context-check ok');
})().catch(e => { console.error(e); process.exit(1); });
