// Adapted from Coucou src/hub/pages/{dictation,notes,insights,words,styles,flowsettings,voice}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: inert first-slice layouts, no Flow/voice commands or capture side effects.
import { h } from '../views/dom.js';
import { card, row, button, keyLabel } from './ui.js';
import { t } from './i18n-es.js';
import type { FlowPageRenderer, PageId } from './shell.js';
const definitions: Record<string, [string, string | null, string]> = {
  dictation: ['Hello', "Hold {0} anywhere, speak, let go: it's pasted.", 'Record'],
  notes: ['Notetaker', 'Your calls transcribed person by person, with a summary and the to-dos. No bot in the meeting.', 'Record a call'],
  insights: ['Statistics', 'What you dictated, how fast, and where.', 'This week'],
  dictionary: ['Dictionary', 'Names and words Abito must always spell right.', 'Add a word'],
  snippets: ['Snippets', 'Say the trigger while dictating: Abito pastes the whole text in its place.', 'Add a snippet'],
  styles: ['Styles', 'Claude cleans up what you say, in the style of the app you write in.', 'Add a style'],
  flowsettings: ['Settings', null, 'Enable dictation'],
  voice: ['OK Abito', 'Say « OK Abito », then ask anything: add a pill, play music, the weather, an email to prepare.', 'Enable'],
};
export function renderUnavailable(page: string): HTMLElement {
  const control = button(t(page === 'phone' ? 'Connect' : 'Enable'), () => {});
  control.disabled = true;
  return card(row(page === 'phone' ? 'No disponible' : 'pendiente de conectar', null, control));
}
export const inactivePages: Partial<Record<PageId, FlowPageRenderer>> = Object.fromEntries(
  Object.entries(definitions).map(([page, [title, subtitle, action]]) => [page, (container: HTMLElement, ctx: any) => {
    const control = button(t(action), () => {}); control.disabled = true;
    const key = keyLabel(ctx.status.prefs.key, ctx.status.platform);
    container.append(ctx.hero(page, t(title), subtitle ? t(subtitle, { 0: key }) : null, [], page === 'notes'));
    container.append(h('div', { id: 'settings-root' }, card(row('pendiente de conectar', null, control))));
  }]),
);
