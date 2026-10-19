// Adapted from Coucou src/settings/main.ts apiSection/chatProvidersSection/localSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: secret_action never retrieves values; arbitrary server connections are unavailable in the closed host.
import { h, clear } from '../views/dom.js';
import { statusDot } from '../settings/parts.js';
import { providerDef, urlExposure } from '../core/providers.js';
import { notchSection as section, notchRow as row, notchHint as hint } from './notch.js';
import { toggle } from './ui.js';
import { session, trusted } from './runtime.js';
import { t } from './i18n-es.js';
import { keyAccountCommand } from './keyaccounts.js';
const UNAVAILABLE = 'No disponible todavía';
const STORE = 'Secret Service (GNOME Keyring, KWallet)';
const CLOUD = [
  ['google','Google AI','AIza…','aistudio.google.com'],
  ['openai','OpenAI','sk-…','platform.openai.com'],
  ['openrouter','OpenRouter','sk-or-…','openrouter.ai/keys'],
];
const button = (key: string, fn: () => void, kind = '') => trusted(h('button', { class: kind, text: t(key), onclick: fn })) as HTMLButtonElement;
const input = (type: string, placeholder: string, id: string) => h('input', {
  id, type, placeholder, autocomplete: 'off', spellcheck: 'false', style: 'flex:1 1 auto;min-width:0',
}) as HTMLInputElement;
export async function renderChatSettings({ invoke, V, listen, timers }: any) {
  const s = session(invoke, listen, timers), { root, call, work, watch } = s;
  root.style.setProperty('display', 'contents');
  s.message.className = 'abito-settings-feedback notice err';
  const present: Record<string,boolean | undefined> = {};
  let state: any = null, prefs: any = {}, modelBusy = false;
  const keyRefresh: Record<string,() => void> = {};
  function keyRow(id: string, title: string, placeholder: string, primary = false) {
    const field = input('password', placeholder, `chat-key-${id}`); field.maxLength = 2048;
    const dot = statusDot(false), feedback = h('div', {}), stateLabel = hint('');
    let busy = false;
    const refresh = () => {
      const known = typeof present[id] === 'boolean';
      dot.style.setProperty('background', !known ? '#6b7079' : present[id] ? '#22c55e' : '#f4505e');
      stateLabel.textContent = !known ? UNAVAILABLE : t(present[id] ? 'Key saved in the {store}.' : 'No key yet — the chat needs one.', { store: STORE });
      field.placeholder = present[id] ? `••••••••  ${t('(stored)')}` : placeholder;
      remove.style.setProperty('display', present[id] ? '' : 'none');
    };
    const change = (action: string) => {
      if (busy) return;
      const value = field.value.trim(); field.value = ''; // BEFORE IPC, including failures; no secret draft/log/storage.
      const payload = V.keyPayload(action, id, value); if (!payload) return;
      busy = true; save.disabled = remove.disabled = true; clear(feedback);
      work(() => call('secret_action', payload), result => {
        if (result?.present !== (action === 'set')) { feedback.append(h('div', { class: 'notice err', text: 'No se confirmó el cambio de la clave.' })); return; }
        present[id] = result.present;
        if (primary) feedback.append(h('div', { class: 'notice ok', text: action === 'set' ? t('Key saved in the {store}.', {store: STORE}) : t('Key removed.') }));
        refresh();
        // The key also becomes (or stops being) a provider account the chat can use. The value only lives in this closure
        // until the one account command is sent; it is never rendered, logged or kept.
        const account = keyAccountCommand(id, action as 'set' | 'clear', value, V.ownedAccounts(state?.ownedAccounts));
        if (account) work(() => call('agent_action', account), next => { state = { ...state, ...next }; drawModels(); },
          () => feedback.append(h('div', { class: 'notice err', text: 'La clave quedó guardada, pero no se pudo crear la cuenta del chat. Créala en Cuentas.' })));
      }, error => {
        dot.style.setProperty('background', '#f5a524');
        feedback.append(h('div', { class: 'notice err', text: V.keyError(error) }));
      }).finally(() => { busy = false; save.disabled = remove.disabled = false; });
    };
    const save = button(primary ? 'Save key' : 'Save', () => change('set'), primary ? 'primary' : '');
    const remove = button('Remove', () => change('clear'), 'danger');
    const r = row(title, field, save, remove);
    if (!primary) {
      const p = providerDef(id.replace('-api-key',''));
      clear(r.children[0] as HTMLElement);
      r.children[0].append(h('i', { class: 'dot', style: `background:${p.accent};margin-right:8px` }), h('span', { text: title }));
      r.append(dot);
    }
    keyRefresh[id] = refresh; refresh();
    return { r, dot, stateLabel, feedback };
  }
  const api = keyRow('anthropic-api-key', t('API key'), 'sk-ant-...', true);
  const model = trusted(h('select', { id: 'chat-anthropic-model', 'aria-label': t('Model') })) as HTMLSelectElement;
  function drawModels() {
    clear(model);
    const view = V.modelsTabView(state, prefs.chosenModels || {});
    const group = view.groups?.find((g: any) => g.id === 'anthropic' && g.connected);
    const offered = group?.models || [];
    if (!offered.length) {
      // Do not invent callable cloud model ids: show the upstream catalogue, disabled.
      for (const [id,name] of [['claude-opus-5','Claude Opus 5'],['claude-sonnet-5','Claude Sonnet 5'],['claude-haiku-4-5','Claude Haiku 4.5']]) model.append(h('option', { value:id, text:name }));
    } else for (const m of offered) model.append(h('option', { value: m.id, text: m.name }));
    model.value = offered.find((m: any) => m.chosen)?.id || offered[0]?.id || 'claude-opus-5';
    model.disabled = modelBusy || !offered.length; model.title = offered.length ? 'Modelos elegidos de Abito; no cambia el modelo activo de una conversación.' : UNAVAILABLE;
  }
  model.addEventListener('change', e => {
    if (!e.isTrusted || model.disabled || modelBusy) return;
    const group = V.modelsTabView(state, prefs.chosenModels || {}).groups?.find((g: any) => g.id === 'anthropic' && g.connected);
    const choice = group?.models.find((m: any) => m.id === model.value); if (!choice || choice.chosen) return;
    // Same chosen-model preference as the legacy Modelos tab; preserve the other chosen models.
    const payload = V.chosenModelsPayload(V.chosenToggle(prefs.chosenModels || {}, 'anthropic', choice.id), 'anthropic');
    if (!payload) return; modelBusy = true; model.disabled = true;
    work(() => call('prefs_action', payload), next => { prefs = next; }).finally(() => { modelBusy = false; if (s.alive()) drawModels(); });
  });
  const apiSection = section('Claude', api.stateLabel, api.r, row(t('Model'), model), api.feedback);
  apiSection.children[0].prepend(api.dot);
  const providers = h('div', { style:'display:flex;flex-direction:column;gap:8px' });
  for (const [id,name,placeholder,site] of CLOUD) {
    const k = keyRow(providerDef(id).key!, name, placeholder);
    providers.append(k.r, h('div', { class: 'hint', style: 'margin:-4px 0 0 144px', text: t('Key from {site}', {site}) }), k.feedback);
  }
  const locals = h('div', { style:'display:flex;flex-direction:column;gap:14px' });
  for (const [id,name,usual] of [['ollama','Ollama','http://127.0.0.1:11434'],['lmstudio','LM Studio','http://127.0.0.1:1234'],['custom','OpenAI-compatible','']]) {
    const p = providerDef(id), block = h('div', { style:'display:flex;flex-direction:column;gap:6px' });
    const url = input('text', usual || 'https://llm.example.com', `chat-url-${id}`);
    const key = input('password', t('API key (optional)'), `chat-local-key-${id}`); key.disabled = true; key.title = UNAVAILABLE;
    const connect = button('Connect', () => {}, 'primary'); connect.disabled = true; connect.title = UNAVAILABLE;
    const exposure = h('div', {});
    const showExposure = () => {
      const kind = urlExposure(url.value || usual); clear(exposure);
      const copy = kind === 'local' ? 'Nothing leaves your PC: the server runs on this computer.'
        : kind === 'remote' ? 'This address is another machine: what you ask is sent to it.'
        : kind === 'remote-http' ? 'This address is another machine, over plain http: what you ask travels unencrypted.'
        : 'Not a valid http:// or https:// address.';
      if (kind !== 'invalid' || url.value.trim()) exposure.append(hint(t(copy)));
    };
    url.addEventListener('input', e => { if (e.isTrusted) showExposure(); });
    const label = h('label', {}, h('i', { class:'dot', style:`background:${p.accent};margin-right:8px` }), h('span', { text:t(name) }));
    block.append(h('div', { class:'row' }, label, url, connect));
    if (id === 'custom') block.append(row('', key));
    block.append(hint(`${UNAVAILABLE} — conexión de direcciones arbitrarias; los modelos verificados de Abito siguen debajo.`), exposure);
    showExposure(); locals.append(block);
  }
  // #487 (NotchBuddy feature 8): Abito prefs switch, off by default. Reads the previous window's app and title only while on.
  const ctxBody = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const paintContext = () => {
    clear(ctxBody);
    const sw = trusted(toggle(prefs.windowContext === true, value => { work(() => call('prefs_action', { action: 'set_window_context', window_context: value }), next => { prefs = next; paintContext(); }, () => paintContext()); }));
    (sw as HTMLButtonElement).disabled = typeof prefs.windowContext !== 'boolean';
    ctxBody.append(row(t('Active window context'), sw));
  };
  paintContext();
  root.append(apiSection,
    section(t('Chat providers'), hint(t('Chat with Google AI, OpenAI or OpenRouter instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the system keychain. These providers get no web search and no tools: they can answer, never act on this computer.')), providers),
    section(t('Local models'), hint(t('Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box.')), locals),
    section(t('Active window context'), hint(t('When you open the chat, Abito reads the app name and the title of the window you were using and attaches them to your first message. Off by default; nothing is read while it is off. The title goes to the model you chat with.')), ctxBody), s.message);
  drawModels();
  watch('agent:state', next => { state = { ...state, ...next }; drawModels(); });
  watch('prefs:state', next => { prefs = next; drawModels(); paintContext(); });
  for (const key of ['anthropic-api-key', ...CLOUD.map(([id]) => providerDef(id).key!)]) work(() => call('secret_action', V.keyPayload('present', key)), result => { present[key] = result?.present === true; keyRefresh[key](); });
  for (const action of ['view','models_list']) work(() => call('agent_action', { action }), next => { state = { ...state, ...next }; drawModels(); });
  work(() => call('prefs_action', { action:'view' }), next => { prefs = next; drawModels(); paintContext(); });
  return s.finish();
}
