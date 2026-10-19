// Adapted from Coucou src/settings/main.ts generalSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito-owned persistence, name, theme, shortcut and recap wiring through existing closed hosts.
import { h, clear } from '../views/dom.js';
import { renderRecapRows } from './recap.js';
import { createBridge } from '../bridge-abito.js';
import { toggle, select, button } from './ui.js';
import { t, LANGUAGES } from './i18n-es.js';
import { notchSection, notchRow as row, notchHint as hint } from './notch.js';

// Keep upstream controls literal: a capture guard rejects synthetic gestures
// before their upstream listeners run, including buttons inside segmented controls.
function trusted<T extends HTMLElement>(el: T): T {
  for (const node of [el, ...el.querySelectorAll('button')]) {
    for (const type of ['click', 'change', 'input']) node.addEventListener(type, e => {
      if (!e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
  return el;
}
const identify = <T extends HTMLElement>(el: T, id: string): T => { el.setAttribute('id', id); return el; };
export async function renderGeneral({ invoke, V }: { invoke: (cmd: string, args: any) => Promise<any>; V: any }): Promise<HTMLElement & { dispose(): void; settled(): Promise<void> }> {
  const bridge = createBridge(invoke);
  let settings = await bridge.boot();
  // monitor_action list (read-only names): the saved choice stays offered even if that display is unplugged.
  let monitors: string[] = [];
  const listMonitors = async () => { try { monitors = ((await invoke('monitor_action', { payload: { action: 'list' } }))?.monitors ?? []).map((m: any) => String(m.key)); } catch { monitors = []; } };
  await listMonitors();
  const namedScreens = () => [...new Set([...(settings.screen !== 'primary' && settings.screen !== 'cursor' ? [settings.screen] : []), ...monitors])];
  // sound_action list: names of the cues replaced by the user's own files.
  let customCount = 0;
  const countCustom = async () => { try { customCount = ((await invoke('sound_action', { payload: { action: 'list' } }))?.names ?? []).length; } catch { customCount = 0; } };
  await countCustom();
  let prefs = await invoke('prefs_action', { payload: { action: 'view' } });
  let autostart = await invoke('prefs_action', { payload: { action: 'autostart_view' } });
  let hotkey = await invoke('hotkey_action', { payload: { action: 'view' } });
  const recap = await renderRecapRows({ invoke });
  let queue = Promise.resolve(), issue = '', nameDraft: string | null = null, capturing = false;
  const root = h('div', {});
  const send = (cmd: string, payload: any) => invoke(cmd, { payload });
  const DEFAULT_FAILURE = 'No se pudo guardar. Revisa el valor e inténtalo de nuevo.';
  const run = (work: () => Promise<void>, failure = DEFAULT_FAILURE, repaint = true) => {
    queue = queue.then(async () => {
      try { await work(); issue = ''; }
      catch { issue = failure;
        // a failed SAVE re-reads the real values; a folder that did not open changed nothing, so there is nothing to re-read
        if (failure === DEFAULT_FAILURE) try { settings = await bridge.boot(); prefs = await send('prefs_action', { action: 'view' }); hotkey = await send('hotkey_action', { action: 'view' }); autostart = await send('prefs_action', { action: 'autostart_view' }); } catch { /* Keep error visible, never claim success. */ }
      }
      if (repaint || issue) paint();
    });
  };
  const patch = (change: Record<string, unknown>, repaint = true) => run(async () => { settings = await bridge.saveSettings({ ...settings, ...change }); }, DEFAULT_FAILURE, repaint);
  const directPrefs = (payload: any) => run(async () => { prefs = await send('prefs_action', payload); });
  const shortcut = (payload: any) => run(async () => { hotkey = await send('hotkey_action', payload); });
  function paint() {
    clear(root);
    const g = V.generalView({ sound: settings.soundEnabled, gain: settings.soundVolume, hotkey });
    const name = h('input', { class: 'hub-input', type: 'text', value: nameDraft ?? prefs.displayName ?? '', 'aria-label': 'Nombre visible' }) as HTMLInputElement;
    const nameIssue = h('p', { class: 'hub-note', role: 'status' });
    const save = trusted(button('Guardar nombre', () => {
      if (V.displayNameProblem(name.value)) return;
      const typed = name.value;
      run(async () => { prefs = await send('prefs_action', { action: 'set_display_name', display_name: typed }); if (nameDraft === typed) nameDraft = null; });
    }));
    name.addEventListener('input', e => {
      if (!e.isTrusted) return;
      nameDraft = name.value; nameIssue.textContent = V.displayNameProblem(name.value);
      save.disabled = !!nameIssue.textContent;
    });
    nameIssue.textContent = V.displayNameProblem(name.value); save.disabled = !!nameIssue.textContent;
    const sound = identify(trusted(toggle(g.sound.on, value => patch({ soundEnabled: value }))), 'hub-sound');
    sound.setAttribute('aria-label', t('Sound'));
    const volume = identify(h('input', { type: 'range', min: '0', max: '0.2', step: '0.005', value: String(g.sound.gain), 'aria-label': t('Volume') }) as HTMLInputElement, 'hub-volume');
    // Keep this DOM node alive during a drag; serial saves publish prefs:state live.
    for (const type of ['input', 'change']) volume.addEventListener(type, e => {
      if (!e.isTrusted || V.soundGainProblem(volume.value)) return;
      patch({ soundVolume: Number(volume.value) }, false);
    });
    const hover = identify(trusted(toggle(settings.openOnHover, value => patch({ openOnHover: value }))), 'hub-hover');
    hover.setAttribute('aria-label', t('Open on hover'));
    const seconds = h('input', { type: 'number', min: '0', max: '120', step: '1', style: 'width:72px', value: String(settings.autoCloseInterval), 'aria-label': 'Cierre automático en segundos' }) as HTMLInputElement;
    seconds.addEventListener('change', e => {
      if (!e.isTrusted) return;
      const value = Number(seconds.value);
      if (!seconds.value.trim() || !Number.isInteger(value) || value !== 0 && (value < 5 || value > 120)) { issue = 'Usa 0 o un entero entre 5 y 120 segundos.'; paint(); return; }
      patch({ autoCloseInterval: value });
    });
    const theme = V.themeView(prefs);
    const themeSelect = trusted(select(theme.options.map((o: any) => [o.id, o.label]), theme.mode, value => directPrefs({ action: 'set_theme', theme: value })));
    themeSelect.setAttribute('aria-label', t('Theme'));
    const change = trusted(button(capturing ? 'Cancelar' : 'Cambiar', () => { capturing = !capturing; paint(); }));
    const capture = h('input', { class: 'hub-input', type: 'text', value: capturing ? '' : hotkey.combo, 'aria-label': 'Atajo global', readonly: true }) as HTMLInputElement;
    capture.addEventListener('keydown', e => {
      if (!capturing || !e.isTrusted) return;
      e.preventDefault();
      const combo = V.captureCombo(e);
      if (combo.kind === 'cancel') { capturing = false; paint(); }
      else if (combo.kind === 'combo') { capturing = false; shortcut({ action: 'set', combo: combo.text }); }
    });
    const enabled = trusted(toggle(hotkey.enabled !== false, value => shortcut({ action: value ? 'enable' : 'disable' })));
    enabled.setAttribute('aria-label', 'Atajo activo');
    // Notch pages use settings/main.ts sections and .row, not Flow's hub-card.
    const unavailable = (el: HTMLElement, id: string) => {
      (el as HTMLButtonElement).disabled = true; el.setAttribute('title', 'No disponible todavía');
      return identify(el, id);
    };
    const screen = trusted(select([['primary', t('Main display')], ['cursor', t('Display under the cursor')],
      ...namedScreens().map((name: string): [string,string] => [name,name])], settings.screen, value => {
        if (value !== 'cursor') patch({ screen: value });
      }));
    screen.className = ''; screen.setAttribute('aria-label', t('Island lives on')); screen.setAttribute('id', 'hub-screen');
    const cursor = screen.children[1] as HTMLOptionElement; cursor.disabled = true; cursor.title = 'No disponible todavía';
    const soundsFolder = identify(trusted(h('button', { text: t('Open sounds folder'), onclick: () => { run(async () => { await send('sound_action', { action: 'reveal' }); }, 'No se pudo abrir la carpeta de sonidos (el administrador de archivos no respondió). Ábrela a mano: la carpeta «sounds» dentro de la carpeta de configuración de Abito.'); } })), 'hub-sounds-folder');
    const soundsReload = identify(trusted(h('button', { text: t('Reload sounds'), onclick: () => { run(async () => { await send('sound_action', { action: 'reload' }); await countCustom(); }); } })), 'hub-sounds-reload');
    const language = unavailable(select([['', t('System')], ...LANGUAGES], '', () => {}), 'hub-language'); language.className = '';
    root.append(notchSection(t('General'),
      row(t('Sound'), sound, volume),
      h('div', { class: 'row' }, soundsFolder, soundsReload, h('span', { class: 'hint', text: customCount > 0 ? t('{0} custom', { 0: customCount }) : '' })),
      hint(t("Drop a file named like one of el personaje's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload.")),
      row(t('Open on hover'), hover),
      hint(t('Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.')),
      row(t('Auto-close'), seconds, h('span', { class: 'hint', text: t('seconds after you leave the island') })),
      row(t('Island lives on'), screen), row(t('Theme'), themeSelect),
      row(t('Launch at startup'), (() => {
        const control = identify(trusted(toggle(autostart.enabled === true, enabled => run(async () => {
          autostart = await send('prefs_action', { action: 'set_autostart', enabled });
        }))), 'hub-autostart') as HTMLButtonElement;
        control.setAttribute('aria-pressed', String(autostart.enabled === true));
        control.disabled = typeof autostart.enabled !== 'boolean';
        return control;
      })()),
      recap,
      row(t('Language'), language, h('span', { class: 'hint', text: 'No disponible todavía' })),
      row('Nombre visible', name, save), nameIssue,
      hint('El movimiento no se puede configurar en Abito.'),
      row('Atajo global', capture, change, trusted(button('Original', () => shortcut({ action: 'reset' }))), enabled),
      hint(g.hotkey?.note || g.hotkey?.backendLabel || ''),
      h('p', { class: 'hub-note', role: 'status', text: issue })));
    themeSelect.className = '';
    if (capturing) { capture.focus?.(); }
  }
  paint();
  return Object.assign(root, { dispose: () => recap.dispose(), settled: async () => { await queue; await recap.settled(); } });
}
