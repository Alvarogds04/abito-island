'use strict';
// #345: real Ajustes controls, rendered with existing row/button language.
// Data goes through textContent and the closed catalog, never HTML or credentials.
(function (root) {
  const C = root.AbitoPillCatalog, P = root.AbitoPills;
  if (!C || !P) return;
  function render(host, raw, options) {
    const prefs = P.normalize(raw), o = options || {};
    const doc = host.ownerDocument || document;
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag); node.className = cls || '';
      if (text) node.textContent = text;
      return node;
    };
    const count = el('p', 'snote', `${prefs.declaredPills.length}/${P.MAX_DECLARED} declaradas. La principal no ocupa un lugar.`);
    count.id = 'pill-slot-count'; host.append(count);
    host.append(el('p', 'snote', 'Elegir una pill no conecta el servicio ni configura cuentas o hooks.'));
    const label = el('label', 'srow-title', 'Pill principal'); label.htmlFor = 'pill-main-setting';
    const main = el('select', 'sfield'); main.id = 'pill-main-setting';
    main.setAttribute('aria-label', 'Pill principal'); main.disabled = !!o.saving;
    for (const def of C.mainChoices()) {
      const option = el('option', '', def.name); option.value = def.id; main.append(option);
    }
    main.value = prefs.mainPill;
    main.addEventListener('change', event => {
      if (event.isTrusted !== true || o.saving || main.value === prefs.mainPill || !P.chooseMain(prefs, main.value)) return;
      o.onCommand({ action: 'set_main_pill', id: main.value });
    });
    const row = el('div', 'srow'); row.append(label, main); host.append(row);
    const issue = el('p', 'snote', o.error || ''); issue.id = 'pill-settings-error';
    issue.setAttribute('role', 'status'); host.append(issue);
    const groups = el('div'); groups.id = 'pill-settings-rows';
    for (const category of C.CATEGORIES) {
      const group = el('section', 'ssec'); group.append(el('h4', 'ssection', category.name));
      for (const def of C.CATALOG.filter(x => x.category === category.id)) {
        const detail = P.detail(def.id), isMain = def.id === prefs.mainPill;
        const on = prefs.declaredPills.includes(def.id);
        const full = !on && prefs.declaredPills.length >= P.MAX_DECLARED;
        const line = el('div', 'srow'); line.dataset.pillId = def.id;
        line.append(el('span', 'srow-title', def.name));
        const chip = el('span', 'chip'); chip.dataset.tone = 'faint';
        const glyph = el('span', 'ico'); o.putIcon?.(glyph, detail.icon); chip.append(glyph);
        chip.append(el('span', '', isMain ? 'Principal · Sin conexión' : detail.word));
        chip.setAttribute('aria-label', detail.aria); line.append(chip);
        const button = el('button', 'sbtn', isMain ? 'Principal' : on ? 'Quitar' : 'Declarar');
        button.type = 'button'; button.id = `pill-toggle-${def.id}`;
        button.disabled = !!o.saving || isMain || !detail.offered || full;
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.setAttribute('aria-label', `${isMain ? 'Principal' : on ? 'Quitar' : 'Declarar'}: ${def.name}`);
        button.addEventListener('click', event => {
          if (event.isTrusted !== true || button.disabled || !P.toggle(prefs, def.id)) return;
          o.onCommand({ action: 'toggle_declared_pill', id: def.id });
        });
        line.append(button);
        if (!detail.offered) line.append(el('p', 'snote', detail.detail));
        group.append(line);
      }
      groups.append(group);
    }
    host.append(groups);
  }
  root.AbitoPillSettings = Object.freeze({ render });
})(typeof window !== 'undefined' ? window : this);
