// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
// Adapted for Abito: the classic lexical engine API is visible to ESM. SVG,
// not canvas: create(svg, opts) is the real API. Static instances own no RAF/timer.
declare const AbitoClay: { create(svg: SVGSVGElement, options: any): any };
export function liveMochi(svg: SVGSVGElement, _color = '#F5F6F8', state = 'idle'): any {
  if (typeof AbitoClay === 'undefined') return null;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'xMaxYMid meet');
  return AbitoClay.create(svg, { state, live: false, viewBox: '0 0 200 200', shadow: false });
}
export function hero(_page: string, title: string, subtitle: string | null, actions: HTMLElement[] = [], compact = false): HTMLElement {
  const el = document.createElement('div');
  el.className = compact ? 'hub-hero compact' : 'hub-hero';
  const back = document.createElement('canvas');
  back.className = 'backdrop';
  const character = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  character.setAttribute('class', 'troupe');
  liveMochi(character);
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
