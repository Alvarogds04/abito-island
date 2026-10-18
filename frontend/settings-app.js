// Abito-owned settings entry. Only existing closed legacy commands are admitted.
import './settings-view.js';
import './chat-view.js';
import './avatar-colors.js';
import './pill-catalog.js';
import './pills.js';
import './specialists-view.js';
import './theme.js';
import { renderAccounts, renderModels } from './vendor/coucou/hub/accounts.js';
import { renderAgentSettings } from './vendor/coucou/hub/agents.js';
import { renderChatSettings } from './vendor/coucou/hub/chat.js';
import { renderPills } from './vendor/coucou/hub/personalization.js';
import { startHub } from './vendor/coucou/hub/shell.js';
import { inactivePages, renderUnavailable } from './vendor/coucou/hub/pages.js';
import { renderGeneral } from './vendor/coucou/hub/general.js';
import { card, row } from './vendor/coucou/hub/ui.js';
const rawInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
const allowed = new Set(['prefs_action', 'hotkey_action', 'settings_window_action', 'agent_action', 'secret_action', 'models_action', 'specialists_action', 'daemon_action']);
const invoke = (command, args) => {
  if (!allowed.has(command) || !rawInvoke) return Promise.reject(new Error('No disponible'));
  if (command === 'daemon_action' && (Object.keys(args || {}).length !== 1 || Object.keys(args?.payload || {}).length !== 1 || args.payload.action !== 'restart')) return Promise.reject(new Error('No disponible'));
  return rawInvoke(command, args);
};
const root = document.getElementById('hub');
const options = { invoke, listen: window.__TAURI__?.event?.listen, V: window.AbitoSettings,
  C: window.AbitoChatView, S: window.AbitoSpecialists, A: window.AbitoAvatarColors, P: window.AbitoPills };
// Catalog and chat view have distinct roles; keep their injected interfaces explicit.
const personal = { ...options, C: window.AbitoPillCatalog };
startHub(root, {
  version: '0.1.0', flowPages: inactivePages,
  async renderNotch(page, container) {
    if (page === 'general') {
      try { container.append(await renderGeneral({ invoke, V: window.AbitoSettings })); }
      catch { container.append(card(row('No disponible', 'No se pudieron leer los ajustes. Vuelve a abrir esta página.'))); }
    } else {
      const mounted = [];
      // Each renderer retains its closed IPC planner and per-mount cleanup.
      try {
        if (page === 'agents') mounted.push(await renderAgentSettings(options));
        if (page === 'pills' || page === 'agents') mounted.push(await renderPills({ ...personal, page }));
        if (page === 'chat') {
          const chat = await renderChatSettings(options); mounted.push(chat);
          const models = await renderModels(options);
          // Preserve Abito's verified model controls inside Coucou's Local models section.
          chat.children[2]?.append(models);
          const disposeChat = chat.dispose;
          chat.dispose = () => { models.dispose(); disposeChat(); };
        }
        if (page === 'chat' || page === 'integrations') mounted.push(await renderAccounts({ ...options, page, keys: page !== 'chat' }));
        if (mounted.length) container.append(...mounted);
        else container.append(renderUnavailable(page));
      } catch {
        for (const ui of mounted) ui.dispose();
        container.append(card(row('No disponible', 'No se pudieron leer los ajustes. Vuelve a abrir esta página.')));
      }
      return () => { for (const ui of mounted) ui.dispose(); };
    }
  },
}).catch(() => { root.textContent = 'No se pudieron abrir los ajustes.'; });
