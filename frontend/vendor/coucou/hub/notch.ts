// Adapted from Coucou src/settings/main.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Notch sections keep the original settings DOM; Flow uses hub/ui cards instead.
import { h } from '../views/dom.js';
export const notchSection = (title: string, ...children: HTMLElement[]) =>
  h('section', {}, h('h2', {}, h('span', { text: title })), ...children);
export const notchRow = (title: string, ...controls: HTMLElement[]) =>
  h('div', { class: 'row' }, h('label', { text: title }), ...controls);
export const notchHint = (text: string) => h('div', { class: 'hint', text });
