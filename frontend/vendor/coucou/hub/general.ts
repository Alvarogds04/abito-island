// Abito-owned General wiring using the MIT hub components; no new IPC commands.
import { h, clear } from '../views/dom.js';
import { createBridge } from '../bridge-abito.js';
import { card, row, toggle, segmented, select, button, label } from './ui.js';
import { t } from './i18n-es.js';

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
export async function renderGeneral({ invoke, V }: { invoke: (cmd: string, args: any) => Promise<any>; V: any }): Promise<HTMLElement & { settled(): Promise<void> }> {
  const bridge = createBridge(invoke);
  let settings = await bridge.boot();
  let prefs = await invoke('prefs_action', { payload: { action: 'view' } });
  let hotkey = await invoke('hotkey_action', { payload: { action: 'view' } });
  let queue = Promise.resolve(), issue = '', nameDraft: string | null = null, capturing = false;
  const root = h('div', {});
  const send = (cmd: string, payload: any) => invoke(cmd, { payload });
  const run = (work: () => Promise<void>) => {
    queue = queue.then(async () => {
      try { await work(); issue = ''; }
      catch { issue = 'No se pudo guardar. Revisa el valor e inténtalo de nuevo.';
        try { settings = await bridge.boot(); prefs = await send('prefs_action', { action: 'view' }); hotkey = await send('hotkey_action', { action: 'view' }); } catch { /* Keep error visible, never claim success. */ }
      }
      paint();
    });
  };
  const patch = (change: Record<string, unknown>) => run(async () => { settings = await bridge.saveSettings({ ...settings, ...change }); });
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
    volume.addEventListener('change', e => {
      if (!e.isTrusted || V.soundGainProblem(volume.value)) return;
      patch({ soundVolume: Number(volume.value) });
    });
    const hover = identify(trusted(toggle(settings.openOnHover, value => patch({ openOnHover: value }))), 'hub-hover');
    hover.setAttribute('aria-label', t('Open on hover'));
    const close = trusted(segmented(V.autoCloseSegments(settings.autoCloseInterval).map((s: any) => [String(s.seconds), s.label]), String(settings.autoCloseInterval), value => patch({ autoCloseInterval: Number(value) })));
    const seconds = h('input', { class: 'hub-input', type: 'number', min: '0', max: '120', step: '1', value: String(settings.autoCloseInterval), 'aria-label': 'Cierre automático en segundos' }) as HTMLInputElement;
    seconds.addEventListener('change', e => {
      if (!e.isTrusted) return;
      const value = Number(seconds.value);
      if (!seconds.value.trim() || !Number.isInteger(value) || value !== 0 && (value < 5 || value > 120)) { issue = 'Usa 0 o un entero entre 5 y 120 segundos.'; paint(); return; }
      patch({ autoCloseInterval: value });
    });
    const theme = V.themeView(prefs);
    const themeSelect = trusted(select(theme.options.map((o: any) => [o.id, o.label]), theme.mode, value => directPrefs({ action: 'set_theme', theme: value })));
    themeSelect.setAttribute('aria-label', t('Theme'));
    const motion = identify(trusted(toggle(false, () => {})), 'hub-motion') as HTMLButtonElement;
    motion.disabled = true; motion.setAttribute('aria-label', t('Motion'));
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
    root.append(label('Perfil'), card(row('Nombre visible', null, name, save), nameIssue),
      label(t('General')), card(row(t('Sound'), null, sound, volume), row(t('Open on hover'), null, hover), row(t('Auto-close'), null, close, seconds)),
      label('Apariencia'), card(row(t('Theme'), null, themeSelect), row(t('Motion'), 'No disponible en esta ventana', motion)),
      label('Atajo global'), card(row('Atajo global', g.hotkey?.note || g.hotkey?.backendLabel || null, capture, change,
        trusted(button('Original', () => shortcut({ action: 'reset' }))),
        enabled)), h('p', { class: 'hub-note', role: 'status', text: issue }));
    if (capturing) { capture.focus?.(); }
  }
  paint();
  return Object.assign(root, { settled: () => queue });
}
