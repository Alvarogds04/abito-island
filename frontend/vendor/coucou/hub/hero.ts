// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
// Adapted for Abito: plain band, no reserved character/animation/wardrobe.
// clay-engine.js has a classic lexical API, not an ESM export. Keep this API
// compatible without evaluating source text or introducing a second classic script.
export function liveMochi(_canvas: HTMLCanvasElement, _color = '#F5F6F8', _state = 'idle'): null {
  return null;
}
export function hero(_page: string, title: string, subtitle: string | null, actions: HTMLElement[] = [], compact = false): HTMLElement {
  const el = document.createElement('div');
  el.className = compact ? 'hub-hero compact' : 'hub-hero';
  const back = document.createElement('canvas');
  back.className = 'backdrop';
  const character = document.createElement('canvas');
  character.className = 'troupe';
  const copy = document.createElement('div');
  copy.className = 'copy';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement('p');
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, character, copy);
  return el;
}
