// Abito-owned settings entry. Only the three existing closed commands are admitted.
import './settings-view.js';
import { startHub } from './vendor/coucou/hub/shell.js';
import { renderGeneral } from './vendor/coucou/hub/general.js';
import { card, row } from './vendor/coucou/hub/ui.js';
const rawInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
const allowed = new Set(['prefs_action', 'hotkey_action', 'settings_window_action']);
const invoke = (command, args) => {
  if (!allowed.has(command) || !rawInvoke) return Promise.reject(new Error('No disponible'));
  return rawInvoke(command, args);
};
const root = document.getElementById('hub');
startHub(root, {
  version: '', flowPages: {},
  async renderNotch(page, container) {
    if (page === 'general') {
      try { container.append(await renderGeneral({ invoke, V: window.AbitoSettings })); }
      catch { container.append(card(row('No disponible', 'No se pudieron leer los ajustes. Vuelve a abrir esta página.'))); }
    } else {
      container.append(card(row(page === 'phone' ? 'No disponible' : 'Próximamente', null)));
    }
  },
}).catch(() => { root.textContent = 'No se pudieron abrir los ajustes.'; });
