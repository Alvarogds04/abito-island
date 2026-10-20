// Adapted from Coucou src/hub/pages/{dictation,flowsettings}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: portal-owned keys, seven closed preferences, local history; clipboard-only delivery and live local history.
import { h, clear } from '../views/dom.js';
import { t } from './i18n-es.js';
import { onEvent } from './bridge-shim.js';
import { dataLife } from './data-pages.js';
import { FlowBridge, type Edge, type ModelsStatus } from './flow-shim.js';
import type { HubContext } from './shell.js';
import { button, card, divider, keyKeycap, keycap, label, number, row, segmented, select, toggle, icon, iconButton, shortCount } from './ui.js';
import { trusted } from './runtime.js';
import { emptyState, glowCard } from './hero.js';
const unavailable = <T extends HTMLElement>(el: T): T => { (el as any).disabled = true; el.title = 'No disponible todavía'; return el; };
export function mount(page: HTMLElement, ctx: HubContext) {
  let alive = true;
  const cleanups: (() => void)[] = [];
  const message = h('div', {class:'hub-note', role:'status'});
  const life = {
    alive: () => alive,
    dispose: () => { alive = false; for (const off of cleanups.splice(0)) off(); },
    listen: async (name: string, fn: (p: any) => void) => {
      const off = await onEvent<any>(name, p => { if (alive) fn(p); });
      if (alive) cleanups.push(off); else off();
    },
    watch: async (fn: (m: ModelsStatus) => void) => {
      const off = await onEvent<ModelsStatus>('dictation:models', m => { if (alive) fn(m); });
      if (alive) cleanups.push(off); else off();
    },
    work: async (fn: () => Promise<any>) => {
      if (!alive) return;
      try { return await fn(); }
      catch { if (alive) { message.textContent = 'No se pudo completar. No se anuncia ningún cambio como guardado.'; if (!message.isConnected) page.append(message); } }
    },
  };
  ctx.onLeave = life.dispose;
  return life;
}
/** Same model states/confirmation as upstream; also paints direct remove/download replies. */
export function modelsControl(ctx: HubContext, life: ReturnType<typeof mount>, onReady?: () => void): HTMLElement {
  const el = h('div', {style:'display:flex;align-items:center;gap:8px'});
  let models = ctx.status.models, confirming = false, busy = false;
  const run = (fn: () => Promise<ModelsStatus>) => void life.work(async () => {
    if (busy) return; busy = true;
    try { const next = await fn(); if (life.alive()) { models = next; ctx.status.models = next; ctx.updateModels?.(next); confirming = false; draw(); } }
    finally { busy = false; }
  });
  const click = (text: string, fn: () => void, kind: '' | 'primary' | 'danger' = '', small = false) => trusted(button(text, fn, kind, small));
  const draw = () => {
    clear(el);
    const m = models.parakeet;
    if (m.state === 'missing') el.append(click(t('Download'), () => run(FlowBridge.download), 'primary'));
    else if (m.state === 'downloading') {
      const percent = Math.round(Math.max(0, Math.min(1, m.fraction ?? 0)) * 100);
      el.append(h('div', {class:'hub-progress'}, h('i', {style:`width:${percent}%`})), h('span', {class:'hub-note',text:`${percent} %`}));
    } else if (m.state === 'failed') el.append(h('span', {class:'hub-note',text:m.error, title:m.error,style:'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}), click(t('Retry'), () => run(FlowBridge.download)));
    else if (confirming) el.append(click(t('Remove the models'), () => run(FlowBridge.removeModels), 'danger', true), click(t('Cancel'), () => { confirming = false; draw(); }, '', true));
    else el.append(trusted(h('button', {class:'hub-link',style:'color:var(--hub-green)',text:`✓ ${t('Installed')}`,title:t('Remove the models'),onclick:() => { confirming = true; draw(); }})));
  };
  draw(); void life.watch(next => {
    const wasReady = models.parakeet.state === 'ready';
    models = next; ctx.status.models = next; ctx.updateModels?.(next); draw();
    if (!wasReady && next.parakeet.state === 'ready') onReady?.();
  });
  return el;
}
export async function flowSettingsPage(page: HTMLElement, ctx: HubContext, invoke?: (cmd: string, args: any) => Promise<any>) {
  const life = mount(page, ctx);
  const status = await ctx.refresh();
  if (!life.alive()) return;
  const save = (change: (p: any) => void) => life.work(() => ctx.setPrefs(change));
  const prefs = status.prefs;
  const copied = h('div', {class:'hub-note',role:'status'});
  page.append(ctx.hero("flowsettings", t("Settings"), null));

  // ── Keys ──
  const edges: [Edge, string][] = [["bottom", t("Bottom")], ["left", t("Left")], ["right", t("Right")]];
  page.append(label(t("Keys")));
  const keysCard = card(
    row(t("Hold a key to dictate anywhere"), null, trusted(toggle(prefs.enabled, (on) => save((p) => (p.enabled = on))))),
    divider(),
    row(t("Hold to dictate"), null, keyKeycap("wayland", status.platform)),
    divider(),
    row(t("Where the pill is"), null, trusted(segmented(edges, prefs.edge, (edge) => save((p) => (p.edge = edge))))),
    divider(),
    row(t("Hands-free"), t("Tap twice, speak as long as you like, tap once to paste."), keyKeycap("wayland", status.platform, true)),
    divider(),
    row(t("Paste the last dictation again"), t("When the words went to the wrong place."), trusted(button(t("Paste again"), () => void life.work(async () => {
      await FlowBridge.copyLast();
      if (life.alive()) { copied.textContent = 'Copiado · presiona Ctrl+V para pegar'; }
    }), "", true))),
    divider(),
    row(t("Cancel a dictation"), null, keycap(t("Esc"))),
  );
  if (status.keys === "ok") {
    keysCard.append(h("div", {
      class: "hub-warn",
      text: t("On Wayland, the desktop holds the dictation key for Abito: Ctrl+Alt+V, or the keys you picked when it asked. The first paste asks once to let Abito type for you."),
    }));
  } else if (status.keys !== "ok") {
    keysCard.append(h("div", { class: "hub-warn", text: t("Abito can't watch the keyboard here: use the pill's microphone to dictate.") }));
  }
  page.append(keysCard, copied);

  // ── Microphone ──
  page.append(label(t("Microphone")));
  const mics: [string, string][] = [["", t("System default")], ...status.mics.map((m): [string, string] => [m.name, m.name])];
  if (prefs.mic && !mics.some(([id]) => id === prefs.mic)) mics.push([prefs.mic, prefs.mic]);
  page.append(card(row(t("Microphone"), t("The one Abito listens to for dictation and calls."), trusted(select(mics, prefs.mic, (mic) => save((p) => (p.mic = mic)))))));

  // ── Recognition ──
  page.append(label(t("Recognition")));
  page.append(card(
    row(t("Parakeet, on your computer"), t("The most accurate, offline, 25 languages. Downloaded once (about {0} MB).", { 0: number(status.models.downloadMb) }), modelsControl(ctx, life)),
    h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here, and the recording is dropped as soon as it is pasted.") }),
  ));

  // ── Notetaker ──
  page.append(label(t("Notetaker")));
  page.append(card(
    row(t("Summaries"), null, unavailable(select([["claude", t("Claude (your key)")], ["off", t("No summary")]], "off", () => {}))),
    h("div", { class: "hub-note", text: t("With Claude, the transcript (never the audio) goes to Anthropic with your key from Notch → Chat.") }),
    divider(),
    h("div", { class: "hub-note", text: t("Everything stays on this computer. Tell the people in the call that you are recording.") }),
  ));

  page.append(h('div', {class:'hub-note',text:'No disponible todavía'}));

  // ── App ──
  page.append(label(t("App")));
  const launchPrefs = invoke ? await life.work(() => invoke('prefs_action', {payload:{action:'view'}})) : null;
  if (!life.alive()) return;
  let launchEnabled = launchPrefs?.openSettingsAtLaunch === true;
  const launch = trusted(toggle(launchEnabled, enabled => {
    if (!invoke || typeof launchPrefs?.openSettingsAtLaunch !== 'boolean') return;
    (launch as HTMLButtonElement).disabled = true;
    void life.work(async () => {
      try {
        const next = await invoke('prefs_action', {payload:{action:'set_open_settings_at_launch',enabled}});
        if (typeof next.openSettingsAtLaunch !== 'boolean') throw new Error('No disponible');
        launchEnabled = next.openSettingsAtLaunch;
      } finally {
        if (life.alive()) {
          launch.classList.toggle('on', launchEnabled); launch.setAttribute('aria-pressed', String(launchEnabled));
          (launch as HTMLButtonElement).disabled = false;
        }
      }
    });
  }));
  launch.setAttribute('aria-pressed', String(launchEnabled));
  launch.setAttribute('id', 'hub-open-at-launch'); (launch as HTMLButtonElement).disabled = typeof launchPrefs?.openSettingsAtLaunch !== 'boolean';
  page.append(card(row(t("Open this window when you open Abito"), t("Not when Abito starts with the computer."), launch)));

  // ── Privacy ──
  page.append(label(t("Privacy")));
  const keep: [string, string][] = [["0", t("Don't keep")], ["7", t("7 days")], ["30", t("30 days")], ["365", t("1 year")], ["-1", t("Forever")]];
  const confirmRow = h('div', {class:'hub-row'});
  const erase = () => {
    clear(confirmRow);
    confirmRow.append(trusted(button(t('Erase the history'), () => void life.work(() => FlowBridge.clear(false)), '', true)),
      trusted(button(t('Erase everything'), () => {
        if (!life.alive()) return;
        clear(confirmRow);
        confirmRow.append(h('span', {class:'hub-note',style:'flex:1',text:t('Erase the history and the statistics?')}),
          trusted(button(t('Erase everything'), () => void life.work(async () => { await FlowBridge.clear(true); if (life.alive()) erase(); }), 'danger', true)),
          trusted(button(t('Cancel'), () => { if (life.alive()) erase(); }, '', true)));
      }, '', true)));
  };
  erase();
  page.append(card(
    row(t("Keep the history"), null, trusted(select(keep, String(prefs.keepDays), (v) => save((p) => (p.keepDays = Number(v)))))),
    divider(),
    confirmRow,
    h("div", { class: "hub-note", text: t("The history, the statistics and your notes stay on this computer, in Abito's folder. Dictations are never saved as audio; a call's audio is deleted as soon as its transcript is written.") }),
  ));
}

export async function dictationPage(page: HTMLElement, ctx: HubContext) {
  const life = mount(page, ctx), status = await ctx.refresh(), key = 'Ctrl+Alt+V';
  if (!life.alive()) return;
  const record = unavailable(button(t('Record a call'), () => {}, 'primary'));
  record.prepend(h('span', {class:'hub-rec',style:'background:#170c04;box-shadow:none;margin-inline-end:8px'}));
  page.append(ctx.hero('dictation', t('Hello'), t("Hold {0} anywhere, speak, let go: it's pasted.", {0:key}), [record]));
  page.append(h('div', {class:'hub-note'}));
  if (!status.prefs.enabled || status.models.parakeet.state !== 'ready') {
    const body = h('div', {style:'display:flex;flex-direction:column;gap:12px'},
      h('div', {style:'font:700 17px var(--font)',text:t('Dictate anywhere on your computer')}),
      h('div', {class:'hub-note',style:'color:#b7bbc2;font-size:13px',text:t('Hold {0} in any app, speak, let go: your words are pasted where you type.', {0:key})}),
      row(t('Turn on dictation'), null, trusted(toggle(status.prefs.enabled, on => void life.work(async () => { await ctx.setPrefs(p => {p.enabled = on;}); if (life.alive()) ctx.navigate('dictation'); })))),
      row(t('Parakeet, on your computer'), t('The most accurate, offline, 25 languages. Downloaded once (about {0} MB).', {0:number(status.models.downloadMb)}), modelsControl(ctx, life, () => ctx.navigate('dictation'))));
    page.append(glowCard('#FB923C', body));
  }
  // Refresh only after native writes settle; event payloads never carry dictated text.
  const data = dataLife(page, {...ctx, set onLeave(fn) { ctx.onLeave = () => {life.dispose(); fn?.();}; }});
  const snapshots = await data.load(() => Promise.all([FlowBridge.history(),FlowBridge.stats()]));
  if (!life.alive() || !snapshots) return;
  let [entries, stats] = snapshots, query = '';
  const copied = h('div', {class:'hub-note',role:'status'});
  const search = data.live(h('input', {class:'hub-input',placeholder:t('Search dictations'),type:'search'})) as HTMLInputElement;
  const list = h('div', {style:'display:flex;flex-direction:column;gap:10px'});
  const dayKey = (ms: number) => {const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;};
  const dayTitle = (ms: number) => dayKey(ms) === dayKey(Date.now()) ? t('Today') : dayKey(ms) === dayKey(Date.now()-86400000) ? t('Yesterday') : new Date(ms).toLocaleDateString(document.documentElement.lang || undefined,{weekday:'long',day:'numeric',month:'long'});
  const draw = () => {
    clear(list);
    if (status.prefs.keepDays === 0) {list.append(emptyState(t('The history is off. Turn it on in Settings → Privacy.'))); return;}
    const shown = query ? entries.filter(e => e.text.toLowerCase().includes(query)) : entries;
    if (!shown.length) {list.append(emptyState(query ? t('No dictation matches.') : t('Your dictations will show here. Hold {0} in any app and speak.',{0:key}))); return;}
    let group: HTMLElement, groupDay = '';
    for (const e of shown.slice(0,300)) {
      const d = dayKey(e.date);
      if (d !== groupDay) {groupDay = d; list.append(h('div', {class:'hub-day',text:dayTitle(e.date)})); group = h('div', {class:'hub-entries'}); list.append(group);}
      const when = h('div', {class:'when'}, h('span', {text:new Date(e.date).toLocaleTimeString(document.documentElement.lang || undefined,{hour:'2-digit',minute:'2-digit'})}));
      if (e.app) when.append(h('span', {class:'hub-tag',text:e.app,title:e.app}));
      group!.append(h('div', {class:'hub-entry'},when,h('div', {class:'words',text:e.text}),h('div', {class:'tools'},
        data.live(iconButton('copy',t('Copy'), () => void life.work(async () => {
          await FlowBridge.copyEntry(e.id);
          if (life.alive()) copied.textContent = 'Copiado · presiona Ctrl+V para pegar';
        }))),
        data.live(iconButton('trash',t('Delete'), () => data.change(() => {entries = entries.filter(x => x.id !== e.id);}, () => FlowBridge.deleteEntry(e.id), async () => {entries = await FlowBridge.history();}, draw))))));
    }
  };
  let refreshGeneration = 0;
  const refresh = () => void life.work(async () => {
    const generation = ++refreshGeneration;
    const fresh = await FlowBridge.history();
    if (life.alive() && generation === refreshGeneration) { entries = fresh; draw(); }
  });
  await life.listen('dictation:phase', p => { if (p.phase === 'copied' || p.phase === 'idle') refresh(); });
  await life.listen('dictation:history', refresh);
  if (!life.alive()) return;
  search.addEventListener('input', () => {query = search.value.trim().toLowerCase(); draw();}); draw();
  const left = h('div', {style:'display:flex;flex-direction:column;gap:10px;min-width:0'}, h('div', {class:'hub-history-head'}, label(t('History')), search), copied, list);
  const big = (value: string, text: string) => h('div', {class:'hub-big-number'}, h('b', {text:value}), h('span', {text:t(text)}));
  const check = icon('check'); check.style.setProperty('width','15px'); check.style.setProperty('height','15px'); check.style.setProperty('fill','none'); check.style.setProperty('stroke','currentColor'); check.style.setProperty('stroke-width','2.2');
  const numbers = card(big(shortCount(stats.all.words), 'words dictated'), big(number(stats.all.wordsPerMinute), 'words/min'), big(number(stats.streak), 'days in a row'), divider(), h('div', {class:'hub-ok'}, check, h('span', {text:t('Unlimited and free')})));
  const promo = glowCard('#FB923C', h('div', {style:'font:700 15px var(--font)',text:t('The Notetaker')}),
    h('div', {class:'hub-note',style:'color:#b7bbc2',text:t('Your calls transcribed person by person, with a summary and the to-dos. No bot in the meeting.')}),
    unavailable(h('button', {class:'hub-link',text:t('Open the Notetaker →')})));
  page.append(h('div', {class:'hub-columns'}, left, h('div', {style:'display:flex;flex-direction:column;gap:14px'}, numbers, promo)));
}
