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
import { renderIntegrations } from './vendor/coucou/hub/integrations.js';
import { renderShortcuts } from './vendor/coucou/hub/shortcuts.js';
import { renderPills } from './vendor/coucou/hub/personalization.js';
import { startHub } from './vendor/coucou/hub/shell.js';
import { setInvoke } from './vendor/coucou/hub/flow-shim.js';
import { dictationPage, flowSettingsPage } from './vendor/coucou/hub/dictation-pages.js';
import { dictionaryPage, snippetsPage, stylesPage, insightsPage } from './vendor/coucou/hub/data-pages.js';
import { inactivePages, renderUnavailable } from './vendor/coucou/hub/pages.js';
import { voicePage } from './vendor/coucou/hub/voice-page.js';
import { renderGeneral } from './vendor/coucou/hub/general.js';
import { card, row } from './vendor/coucou/hub/ui.js';
const rawInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
const allowed = new Set(['prefs_action', 'hotkey_action', 'settings_window_action', 'agent_action', 'secret_action', 'models_action', 'specialists_action', 'daemon_action', 'plan_action', 'recap_action', 'monitor_action', 'sound_action', 'dictation_action', 'voice_action']);
// The host answers these six commands through ONE shared limiter: 30 calls per fixed 1 s window (src/bridge.rs RATE_LIMIT_PER_WINDOW),
// shared with the island window. A page that reads a lot at load (the combined «Integraciones y agentes» makes ~34 calls) used to get
// `rate-exceeded` on its tail calls and paint «No se pudo completar» before the human touched anything (#503 S32 gate). So they leave
// in order and at most PACE_MAX per rolling second, which keeps every fixed window well under 30 and leaves room for the island.
const LIMITED = new Set(['prefs_action', 'agent_action', 'secret_action', 'models_action', 'specialists_action', 'plan_action']);
const PACE_MAX = 20, PACE_MS = 1000;
const sent = [];
let paceTail = Promise.resolve();
const paced = (command, send) => {
  if (!LIMITED.has(command)) return send();
  const turn = paceTail.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] >= PACE_MS) sent.shift();
      if (sent.length < PACE_MAX) { sent.push(now); return; }
      await new Promise(resolve => setTimeout(resolve, sent[0] + PACE_MS - now + 5));
    }
  });
  paceTail = turn.catch(() => {});
  return turn.then(send);
};
const invoke = (command, args) => {
  if (!allowed.has(command) || !rawInvoke) return Promise.reject(new Error('No disponible'));
  if (command === 'daemon_action' && (Object.keys(args || {}).length !== 1 || Object.keys(args?.payload || {}).length !== 1 || args.payload.action !== 'restart')) return Promise.reject(new Error('No disponible'));
  if (command === 'plan_action' && (Object.keys(args || {}).length !== 1 || Object.keys(args?.payload || {}).length !== 1 || !['claude', 'codex'].includes(args.payload.action))) return Promise.reject(new Error('No disponible'));
  if (command === 'recap_action') {
    const p = args?.payload;
    const fields = Object.keys(p || {});
    if (Object.keys(args || {}).length !== 1 || !p ||
      !((['prefs', 'clear'].includes(p.action) && fields.length === 1) ||
        (p.action === 'set_enabled' && fields.length === 2 && typeof p.enabled === 'boolean'))) return Promise.reject(new Error('No disponible'));
  }
  if (command === 'prefs_action' && ['autostart_view', 'set_autostart', 'set_open_settings_at_launch'].includes(args?.payload?.action)) {
    const p = args.payload, fields = Object.keys(p);
    if (Object.keys(args).length !== 1 || (p.action === 'autostart_view' ? fields.length !== 1 : fields.length !== 2 || typeof p.enabled !== 'boolean')) return Promise.reject(new Error('No disponible'));
  }
  if (command === 'prefs_action' && ['set_show_plan_in_notch', 'set_show_codex_plan_in_notch'].includes(args?.payload?.action)) {
    const p = args.payload, key = p.action === 'set_show_plan_in_notch' ? 'show_plan_in_notch' : 'show_codex_plan_in_notch';
    if (Object.keys(args).length !== 1 || Object.keys(p).length !== 2 || typeof p[key] !== 'boolean') return Promise.reject(new Error('No disponible'));
  }
  if (command === 'prefs_action' && args?.payload?.action === 'set_window_context' &&
    (Object.keys(args).length !== 1 || Object.keys(args.payload).length !== 2 || typeof args.payload.window_context !== 'boolean')) return Promise.reject(new Error('No disponible'));
  if (command === 'prefs_action' && args?.payload?.action === 'set_live_context' &&
    (Object.keys(args).length !== 1 || Object.keys(args.payload).length !== 2 || typeof args.payload.live_context !== 'boolean')) return Promise.reject(new Error('No disponible'));
  if (command === 'monitor_action' && (Object.keys(args || {}).length !== 1 || Object.keys(args?.payload || {}).length !== 1 || args.payload.action !== 'list')) return Promise.reject(new Error('No disponible'));
  if (command === 'sound_action' && (Object.keys(args || {}).length !== 1 || Object.keys(args?.payload || {}).length !== 1 || !['list', 'reveal', 'reload'].includes(args.payload.action))) return Promise.reject(new Error('No disponible'));
  if (command === 'dictation_action') {
    const p = args?.payload, keys = ['enabled', 'key', 'edge', 'mic', 'keepDays', 'cleanup', 'defaultStyle'];
    const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
    const strings = (v, fields) => exact(v, fields) && fields.every(k => typeof v[k] === 'string');
    const list = (v, fields) => Array.isArray(v) && Array.from(v).every(x => strings(x, fields));
    if (!exact(args, ['payload']) || !p ||
      !((exact(p, ['action']) && ['status', 'download_model', 'remove_model', 'running_apps', 'history', 'stats', 'words', 'snippets', 'styles', 'copy_last'].includes(p.action)) ||
        (exact(p, ['action', 'id']) && ['delete_entry', 'copy_entry'].includes(p.action) && typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 64 && !/[^A-Za-z0-9_-]/.test(p.id)) ||
        (exact(p, ['action', 'everything']) && p.action === 'clear_history' && typeof p.everything === 'boolean') ||
        (exact(p, ['action', 'words']) && p.action === 'set_words' && exact(p.words, ['words', 'replacements']) && Array.isArray(p.words.words) && Array.from(p.words.words).every(w => typeof w === 'string') && list(p.words.replacements, ['id', 'from', 'to'])) ||
        (exact(p, ['action', 'snippets']) && p.action === 'set_snippets' && list(p.snippets, ['id', 'trigger', 'text'])) ||
        (exact(p, ['action', 'styles']) && p.action === 'set_styles' && list(p.styles, ['id', 'name', 'style'])) ||
        (exact(p, ['action', 'prefs']) && p.action === 'set_prefs' && exact(p.prefs, keys) &&
          typeof p.prefs.enabled === 'boolean' && ['right_ctrl', 'right_alt', 'right_shift', 'left_ctrl_super'].includes(p.prefs.key) &&
          ['bottom', 'left', 'right'].includes(p.prefs.edge) && typeof p.prefs.mic === 'string' && new TextEncoder().encode(p.prefs.mic).length <= 200 &&
          [0, 7, 30, 365, -1].includes(p.prefs.keepDays) && typeof p.prefs.cleanup === 'boolean' && ['verbatim', 'natural', 'polished'].includes(p.prefs.defaultStyle)))) return Promise.reject(new Error('No disponible'));
  }
  if (command === 'voice_action') {
    const p = args?.payload;
    const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
    if (!exact(args, ['payload']) || !p ||
      !((exact(p, ['action']) && ['status', 'download_model', 'remove_model', 'train_record', 'train_undo', 'train_cancel', 'train_finish', 'train_reset'].includes(p.action)) ||
        (exact(p, ['action', 'prefs']) && p.action === 'set_prefs' && exact(p.prefs, ['enabled', 'output', 'gender', 'sensitivity']) && Number.isInteger(p.prefs.sensitivity) && p.prefs.sensitivity >= 0 && p.prefs.sensitivity <= 100 &&
          typeof p.prefs.enabled === 'boolean' && ['system', 'elevenlabs', 'off'].includes(p.prefs.output) && ['female', 'male'].includes(p.prefs.gender)) ||
        (exact(p, ['action', 'id']) && ['model_download', 'model_cancel', 'model_delete'].includes(p.action) && typeof p.id === 'string' && /^[a-z0-9.-]{1,40}$/.test(p.id)) ||
        (exact(p, ['action', 'speech']) && p.action === 'set_speech' && exact(p.speech, ['language', 'model', 'words']) && typeof p.speech.language === 'string' && /^[a-z]{2,4}$/.test(p.speech.language) &&
          typeof p.speech.model === 'string' && /^[a-z0-9.-]{1,40}$/.test(p.speech.model) && Array.isArray(p.speech.words) && p.speech.words.length <= 50 && p.speech.words.every(w => typeof w === 'string' && w.length <= 40)))) return Promise.reject(new Error('No disponible'));
  }
  return paced(command, () => rawInvoke(command, args));
};
setInvoke(invoke);
const root = document.getElementById('hub');
const options = { invoke, listen: window.__TAURI__?.event?.listen, V: window.AbitoSettings,
  C: window.AbitoChatView, S: window.AbitoSpecialists, A: window.AbitoAvatarColors, P: window.AbitoPills };
// Catalog and chat view have distinct roles; keep their injected interfaces explicit.
const personal = { ...options, C: window.AbitoPillCatalog };
startHub(root, {
  // The page Rust chose when it opened this window (a closed list: the shell ignores anything else), e.g. «Configurar Pi…» -> accounts.
  initialPage: window.__abitoHubPage,
  version: '0.1.0', flowPages: { ...inactivePages, voice: voicePage, dictation: dictationPage, flowsettings: (page, ctx) => flowSettingsPage(page, ctx, invoke), dictionary: dictionaryPage, snippets: snippetsPage, styles: stylesPage, insights: insightsPage },
  async renderNotch(page, container, navigate) {
    if (page === 'general') {
      try {
        const general = await renderGeneral({ invoke, V: window.AbitoSettings }); container.append(general);
        return () => general.dispose?.();
      }
      catch { container.append(card(row('No disponible', 'No se pudieron leer los ajustes. Vuelve a abrir esta página.'))); }
    } else {
      const mounted = [];
      // Each renderer retains its closed IPC planner and per-mount cleanup.
      try {
        // #503 S32: «Pestañas activas», «Integraciones» and «Agentes» are ONE page, drawn by the three renderers one after the other:
        // the main-tool selector + the AI pills, the agents table (+ plan usage, recap), the services, then Abito's instructions and
        // the specialists. Each keeps its own closed IPC planner and cleanup.
        if (page === 'integrations') {
          mounted.push(await renderPills({ ...personal, page: 'pills', part: 'tools', navigate }));
          mounted.push(await renderAgentSettings(options));  // options.P = the pills module: «En la isla» is the pill declaration
        }
        if (page === 'chat') {
          const chat = await renderChatSettings(options); mounted.push(chat);
          const models = await renderModels(options);
          // Preserve Abito's verified model controls inside Coucou's Local models section.
          chat.querySelector?.('#chat-local-models')?.append(models);
          const disposeChat = chat.dispose;
          chat.dispose = () => { models.dispose(); disposeChat(); };
        }
        if (page === 'integrations') mounted.push(await renderIntegrations(personal));
        // #503 S26: the engine and the accounts have their own page; their keys already live in Chat and Integraciones (no second list).
        if (page === 'accounts') mounted.push(await renderAccounts({ ...options, page: 'all', keys: false }));
        if (page === 'shortcuts') mounted.push(await renderShortcuts(options));
        // S32: the «Conectores» list renderAccounts drew under Integraciones repeated every agent (and listed the daemon's read-only
        // catalogue); the agents table above is the one row per agent now. Chat keeps its own.
        if (page === 'chat') mounted.push(await renderAccounts({ ...options, page, keys: false }));
        if (page === 'integrations') mounted.push(await renderPills({ ...personal, page: 'agents', part: 'abito', navigate }));
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
