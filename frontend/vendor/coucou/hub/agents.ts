// Adapted from Coucou src/settings/{main,agents}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito's closed host supplies a bounded plan summary/hash, NOT an upstream diff or file paths.
import { h, clear } from '../views/dom.js';
import { statusDot } from '../settings/parts.js';
import { toggle } from './ui.js';
import { notchSection as section, notchRow as row, notchHint as hint } from './notch.js';
import { session, trusted } from './runtime.js';
import { t } from './i18n-es.js';
const UNAVAILABLE = 'No disponible todavía';
const AGENTS: [string,string,boolean][] = [
  ['codex','Codex',true], ['copilot-cli','GitHub Copilot CLI',true], ['muse','Muse Code',true],
  ['gemini-cli','Gemini CLI',false], ['antigravity','Antigravity',false], ['cursor','Cursor Agent',false],
  ['opencode','OpenCode',false], ['amp','Amp',false], ['hermes','Hermes Agent',false],
];
const flex = (gap: number) => h('div', { style: `display:flex;flex-direction:column;gap:${gap}px` });
const unknownDot = () => {
  const n = statusDot(false); n.style.setProperty('background', '#6b7079'); n.title = UNAVAILABLE; return n;
};
const button = (key: string, fn: () => void, kind = '', disabled = false) => {
  const b = trusted(h('button', { class: kind, text: t(key), onclick: fn })) as HTMLButtonElement;
  b.disabled = disabled; if (disabled) b.title = UNAVAILABLE; return b;
};
export async function renderAgentSettings({ invoke, V, listen, timers }: any) {
  const s = session(invoke, listen, timers), { root, call, work, watch } = s;
  root.style.setProperty('display', 'contents');
  s.message.className = 'abito-settings-feedback notice err';
  let state: any = null, reviewing = false, busy = false;
  const plans: Record<string, any> = {};
  let prefs: any = {}, prefsKnown = false;
  // Never replace a reviewed hash with an unseen backend update. A changed plan is rejected by the host.
  function reviewChange(body: HTMLElement, r: any, install: boolean, redraw: () => void) {
    if (busy || !r || (install && (!r.primary?.command?.plan_hash || !r.summary || !r.reviewable))) return;
    const command = install ? { ...r.primary.command } : r.secondary?.command;
    if (!command) return;
    reviewing = true; clear(body);
    body.append(hint('Vista previa de Abito: resumen del plan; el backend no expone el diff ni la ruta de respaldo.'),
      h('pre', { class: 'diff', text: install ? r.summary : 'Se quitarán los hooks administrados por Abito.' }));
    const confirm = button(install ? 'Back up and write' : 'Back up and remove', () => {
      if (busy) return; busy = true; confirm.disabled = true;
      work(() => call('agent_action', command), next => {
        state = { ...state, ...next }; reviewing = false;
        // A transport acknowledgement is not an installation result: render only the host's actual status.
      }).finally(() => { busy = false; reviewing = false; if (s.alive()) paint(); });
    }, install ? 'primary' : 'danger');
    body.append(h('div', { class: 'row' }, confirm, button('Cancel', () => { reviewing = false; redraw(); })));
  }
  // `integration`: the notify-only Claude Code integrations (weekly recap hooks, status-line relay). Same review and confirm
  // flow as the hooks (summary + the hash the user saw, dated backup, marker-only removal); no paths or relay rows.
  function agentBlock(id: string, name: string, approvals: boolean, claude = false, integration = false) {
    const r = V.agentsView(state, { timedOut: true }).rows?.find((a: any) => a.id === id);
    const installed = r?.state === 'connected' || r?.state === 'outdated';
    const dot = () => !r || r.state === 'unknown' ? unknownDot() : statusDot(installed);
    const body = flex(claude ? 12 : 10), head = h('div', { class: 'row' });
    const stable = (n: HTMLElement) => { if (integration) n.setAttribute('id', `agent-integration-${id}`); return n; };
    const block = stable(claude ? section('Claude Code', body) : flex(8));
    if (claude) {
      const heading = block.children[0]; heading.prepend(dot());
    } else block.append(head, body);
    const redraw = () => {
      clear(body); clear(head);
      const installable = !!r?.primary?.command?.plan_hash && !!r?.summary && r?.reviewable && !busy;
      const install = button(claude ? (installed ? 'Reinstall hooks…' : 'Install hooks…') : (installed ? 'Reinstall…' : 'Install…'),
        () => reviewChange(body, r, true, redraw), 'primary', !installable);
      const remove = r?.secondary ? button(claude ? 'Uninstall hooks…' : 'Uninstall…', () => reviewChange(body, r, false, redraw), 'danger', busy) : null;
      if (claude) {
        body.append(hint(t(installed
          ? 'Abito is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.'
          : 'Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.')),
          row('settings.json', h('span', { class: 'path', text: UNAVAILABLE })),
          row(t('Relay'), h('span', { class: 'path', text: UNAVAILABLE }), unknownDot()),
          h('div', { class: 'notice warn', text: `${UNAVAILABLE} — el backend no expone las rutas del relay ni el diff exacto.` }));
        const actions = h('div', { class: 'row' }, install); if (remove) actions.append(remove); body.append(actions);
      } else {
        head.append(h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:132px' }, dot(), h('span', { style: 'font-size:12.5px', text: name })),
          hint(integration ? t(id === 'recap' ? 'Counts your Claude Code activity for the weekly recap; keeps no commands, paths or prompts.' : 'Shows your plan usage in the island; your own status line keeps working.') : t(approvals ? 'Sessions, and Allow / Deny from the island' : 'Sessions — approvals stay in the agent')),
          h('span', { class: 'spacer' }), install);
        if (remove) head.append(remove);
        if (!integration) body.append(h('span', { class: 'path', text: UNAVAILABLE }));
      }
      // Do not claim paths, relay readiness or a raw diff that sender_ok deliberately strips.
      if (r?.note) body.append(hint(r.note));
    };
    redraw(); return block;
  }
  function paint() {
    if (reviewing) return;
    clear(root);
    const list = flex(14); list.setAttribute('id', 'agent-hook-list');
    const reported = new Set((V.agentsView(state, { timedOut: true }).rows || [])
      .filter((r: any) => r.state !== 'unknown').map((r: any) => r.id));
    const unavailable = h('details', { id: 'agent-hook-unavailable' }, h('summary', { class: 'hint', text: UNAVAILABLE }));
    const catalogue = flex(14);
    // Upstream renders the returned list, not its entire static catalogue. Keep unsupported
    // entries discoverable without pushing Plan usage and the real specialists off-screen.
    for (const [id,name,approvals] of AGENTS) {
      (reported.has(id) ? list : catalogue).append(agentBlock(id,name,approvals));
    }
    if (!list.children.length) list.append(hint(t('Abito could not list the agents.')));
    unavailable.append(catalogue);
    const planBody = flex(12);
    // plan_action decides the state: the Claude relay counts as installed once its numbers are readable.
    const claudeUp = plans.claude?.available === true, codexUp = plans.codex?.available === true;
    // The two switches are Abito prefs (set_show_plan_in_notch / set_show_codex_plan_in_notch), independent of the data.
    const sw = (on: boolean, action: string, key: string) => {
      const n = trusted(toggle(on, value => { work(() => call('prefs_action', { action, [key]: value }), next => { prefs = next; prefsKnown = true; paint(); }, () => paint()); }));
      (n as HTMLButtonElement).disabled = !prefsKnown; return n;
    };
    planBody.append(
      hint(t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Abito adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only.")),
      hint(t('The numbers come from the Claude Code command-line tool. The Claude desktop app does not report them, so the gauge stays empty if you only use the desktop app.')),
      row(t('Show in notch'), sw(prefs.showPlanInNotch === true, 'set_show_plan_in_notch', 'show_plan_in_notch')),
      agentBlock('statusline', t('Relay'), false, false, true),
      hint(t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Abito asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT.")),
      row(t('Show Codex plan in the notch'), sw(prefs.showCodexPlanInNotch === true, 'set_show_codex_plan_in_notch', 'show_codex_plan_in_notch')));
    root.append(agentBlock('claude-code','Claude Code',true,true),
      section(t('Agents'), hint(t("Show other coding agents in the island. Abito adds its entries to each agent's own config: you see the exact change and where the backup goes before anything is written, and uninstalling removes only what Abito added.")), list, ...(catalogue.children.length ? [unavailable] : [])),
      section(t('Plan usage'), planBody), section(t('Weekly recap'), agentBlock('recap', t('Weekly recap'), false, false, true)), s.message);
  }
  const apply = (next: any) => { state = { ...state, ...next }; paint(); };
  paint(); watch('agent:state', apply); watch('prefs:state', next => { prefs = next; prefsKnown = true; paint(); });
  work(() => call('prefs_action', { action: 'view' }), next => { prefs = next; prefsKnown = true; paint(); });
  for (const action of ['claude', 'codex']) work(() => call('plan_action', { action }), (r: any) => { plans[action] = r; paint(); });
  for (const action of ['view','agents_list','hooks_preview']) work(() => call('agent_action', { action }), apply);
  return s.finish();
}
