'use strict';
// #345: real Ajustes controls, rendered with existing row/button language.
// Data goes through textContent and the closed catalog, never HTML or credentials.
(function (root) {
  const C = root.AbitoPillCatalog, P = root.AbitoPills, A = root.AbitoAvatarColors;
  if (!C || !P || !A) return;
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
    host.append(el('p', 'snote', 'Elegir un blob no conecta el servicio ni configura cuentas o hooks.'));
    const label = el('label', 'srow-title', 'Blob principal'); label.htmlFor = 'pill-main-setting';
    const main = el('select', 'sfield'); main.id = 'pill-main-setting';
    main.setAttribute('aria-label', 'Blob principal'); main.disabled = !!o.saving;
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
        // #346 F033: colour of this pill — closed palette + «Sin color» (clear), offered
        // rows only (the same gate as the write commands). The row wears only a name
        // normalize already validated.
        const color = P.colorOf(prefs, def.id);
        if (color) line.dataset.color = color;
        if (detail.offered) {
          const pick = el('select', 'sfield pill-color');
          pick.id = `pill-color-${def.id}`;
          pick.setAttribute('aria-label', `Color de ${def.name}`);
          pick.disabled = !!o.saving;
          const none = el('option', '', 'Sin color'); none.value = '';
          pick.append(none);
          for (const name of A.PALETTE) {
            const option = el('option', '', A.label(name)); option.value = name; pick.append(option);
          }
          pick.value = color;
          pick.addEventListener('change', event => {
            if (event.isTrusted !== true || o.saving || pick.value === color) return;
            if (!pick.value) o.onCommand({ action: 'clear_pill_color', id: def.id });
            else o.onCommand({ action: 'set_pill_color', id: def.id, color: pick.value });
          });
          line.append(pick);
        }
        if (!detail.offered) line.append(el('p', 'snote', detail.detail));
        group.append(line);
      }
      groups.append(group);
    }
    host.append(groups);
    // #415 WU2: created blobs — a create form (name + closed palette) and one row per
    // blob in creation order. A created blob is a label + colour entry only: no agent
    // behaviour, nothing connects. Same textContent-only, trusted-gesture rules as above.
    const section = el('section', 'ssec'); section.append(el('h4', 'ssection', 'Tus blobs'));
    const form = el('div', 'srow');
    const input = el('input', 'sfield'); input.id = 'blob-create-input'; input.maxLength = P.MAX_BLOB_NAME;
    input.setAttribute('aria-label', 'Nombre del nuevo blob');
    const pick = el('select', 'sfield pill-color'); pick.id = 'blob-create-color';
    pick.setAttribute('aria-label', 'Color del nuevo blob');
    const none = el('option', '', 'Sin color'); none.value = ''; pick.append(none);
    for (const name of A.PALETTE) {
      const option = el('option', '', A.label(name)); option.value = name; pick.append(option);
    }
    const create = el('button', 'sbtn', 'Crear'); create.type = 'button'; create.id = 'blob-create-button';
    create.disabled = !!o.saving; create.setAttribute('aria-label', 'Crear blob');
    create.addEventListener('click', event => {
      if (event.isTrusted !== true || create.disabled) return;
      const name = input.value.trim();
      const next = P.createBlob(prefs, name, pick.value || '');
      if (!next) return; // closed model gate: bad, duplicate or reserved name never dispatches
      o.onCommand(pick.value ? { action: 'create_blob', name, color: pick.value } : { action: 'create_blob', name });
    });
    form.append(input, pick, create); section.append(form);
    const rows = el('div'); rows.id = 'blob-settings-rows';
    prefs.blobs.forEach((blob, index) => {
      const line = el('div', 'srow'); line.dataset.blobName = blob.name;
      line.append(el('span', 'srow-title', blob.name));
      if (blob.color) line.dataset.color = blob.color;
      const own = el('select', 'sfield pill-color'); own.id = `blob-color-${index}`;
      own.setAttribute('aria-label', `Color de ${blob.name}`); own.disabled = !!o.saving;
      const noColor = el('option', '', 'Sin color'); noColor.value = ''; own.append(noColor);
      for (const name of A.PALETTE) {
        const option = el('option', '', A.label(name)); option.value = name; own.append(option);
      }
      own.value = blob.color;
      own.addEventListener('change', event => {
        if (event.isTrusted !== true || o.saving || own.value === blob.color) return;
        if (!P.setBlobColor(prefs, blob.name, own.value)) return;
        o.onCommand({ action: 'set_blob_color', name: blob.name, color: own.value });
      });
      line.append(own);
      const remove = el('button', 'sbtn', 'Eliminar'); remove.type = 'button'; remove.id = `blob-delete-${index}`;
      remove.disabled = !!o.saving; remove.setAttribute('aria-label', `Eliminar: ${blob.name}`);
      remove.addEventListener('click', event => {
        if (event.isTrusted !== true || remove.disabled || !P.deleteBlob(prefs, blob.name)) return;
        o.onCommand({ action: 'delete_blob', name: blob.name });
      });
      line.append(remove);
      rows.append(line);
    });
    section.append(rows);
    host.append(section);
  }
  root.AbitoPillSettings = Object.freeze({ render });
})(typeof window !== 'undefined' ? window : this);
