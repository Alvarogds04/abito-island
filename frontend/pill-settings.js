'use strict';
// #435 T6.4: the Blobs visual customizer (design page «3 Blobs», §4 of DESIGN-NOTES).
// A PRINCIPAL blob card, up to four declared tiles with a live blob each, an empty
// «Nuevo» slot, an editor panel (large preview, name, the five-colour swatch row from
// the closed palette, order arrows, «Principal», delete) and the strip «Así se ve en
// la isla». Every paragraph is gone; the only disclaimer is the principal chip tooltip.
// Data goes through textContent and the closed model (pills.js), never HTML or
// credentials. Only trusted gestures change anything; a renderer can only paint what
// normalize kept. Stored/wire names are unchanged (main_pill, declared_pills,
// pill_colors, custom_blobs).
(function (root) {
  const C = root.AbitoPillCatalog, P = root.AbitoPills, A = root.AbitoAvatarColors;
  if (!C || !P || !A) return;
  // The one disclaimer left on the screen: the principal chip tooltip (design §4).
  const DISCLAIMER = 'Elegir un blob no conecta el servicio.';
  // Page-lifetime editor state, the same pattern as the settings drafts: what the
  // human selected survives the re-renders every prefs push causes. `key` is
  // `pill:<catalog id>` or `blob:<name>`; mode is 'edit' | 'create' | 'delete'.
  // #435 §4.1: the chooser drafts — switching [Del catálogo | Propio] discards nothing
  // typed in the other mode until «Cancelar».
  const ui = { key: null, mode: 'edit', createName: '', createColor: '',
    createKind: 'catalog', catalogSearch: '', catalogCat: 'all', catalogPick: '' };
  let drag = null; // an in-flight tile drag: { key, node }
  let lastArgs = null; // [host, raw, options] — internal transitions re-render with them

  function render(host, raw, options) {
    const prefs = P.normalize(raw), o = options || {};
    lastArgs = [host, raw, options];
    host.textContent = '';
    const doc = host.ownerDocument || document;
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag); node.className = cls || '';
      if (text) node.textContent = text;
      return node;
    };
    // A live blob: one closed-palette colour, painted by CSS from the --dot-* stops.
    // Only an already-validated palette name ever reaches the DOM.
    const blob = (cls, color) => {
      const b = el('span', cls || 'blob-visual');
      if (color) b.dataset.color = color;
      return b;
    };
    // ---- editor state reconciliation -------------------------------------------------------------------
    // The selected tile must still exist; otherwise the editor falls back to the
    // first declared tile (the designed default) or, with no tiles at all, to create.
    const declaredTiles = prefs.declaredPills.map(id => ({ key: `pill:${id}`, kind: 'pill', id, name: (C.definition(id) || {}).name || id }));
    const blobTiles = prefs.blobs.map((b, index) => ({ key: `blob:${b.name}`, kind: 'blob', name: b.name, index }));
    // The principal card is a selection target too: its editor edits the character's
    // own colour (D4). It is never the DEFAULT selection — that is the first tile.
    const principalTile = { key: `pill:${prefs.mainPill}`, kind: 'pill', id: prefs.mainPill,
      name: (C.definition(prefs.mainPill) || {}).name || prefs.mainPill, principal: true };
    const tiles = [principalTile, ...declaredTiles, ...blobTiles];
    const known = new Set(tiles.map(t => t.key));
    if (ui.mode === 'delete' && (!known.has(ui.key) || (selectedKeyIsPrincipal()))) ui.mode = 'edit';
    if (ui.mode !== 'create' && !known.has(ui.key)) {
      ui.key = declaredTiles[0]?.key || blobTiles[0]?.key || null;
      ui.mode = ui.key ? 'edit' : 'create';
    }
    function selectedKeyIsPrincipal() { return ui.key === principalTile.key; }
    const selected = ui.key ? tiles.find(t => t.key === ui.key) : null;
    let selectedColor = '';
    if (selected) {
      selectedColor = selected.kind === 'pill' ? P.colorOf(prefs, selected.id) : P.colorOfBlob(prefs, selected.name);
    }

    // ---- left column ------------------------------------------------------------------------------------
    const left = el('div', 'pills-main');
    left.append(el('span', 'psection-label', 'Principal'));
    const principalColor = P.colorOf(prefs, prefs.mainPill);
    const card = el('button', 'pill-principal');
    card.type = 'button'; card.id = 'pill-principal-card';
    card.dataset.pillId = prefs.mainPill;
    card.setAttribute('aria-label', `${(C.definition(prefs.mainPill) || {}).name || prefs.mainPill}: siempre en la isla`);
    card.append(blob('blob-visual', principalColor));
    card.append(el('span', 'pill-name', (C.definition(prefs.mainPill) || {}).name || prefs.mainPill));
    const chip = el('span', 'chip', 'Siempre en la isla');
    chip.dataset.tone = 'faint';
    chip.title = DISCLAIMER; chip.setAttribute('aria-label', DISCLAIMER);
    card.append(chip);
    const crown = el('span', 'ico ico-crown'); (o.putIcon || (() => {}))(crown, 'crown');
    card.append(crown);
    card.addEventListener('click', event => {
      if (event.isTrusted !== true) return;
      ui.key = `pill:${prefs.mainPill}`; ui.mode = 'edit'; paint();
    });
    left.append(card);

    const head = el('div', 'pills-declared-head');
    head.append(el('span', 'psection-label', 'Declaradas'));
    const count = el('span', 'pill-count', `${prefs.declaredPills.length}/${P.MAX_DECLARED}`);
    count.id = 'pill-slot-count';
    count.setAttribute('aria-label', `${prefs.declaredPills.length} de ${P.MAX_DECLARED} declaradas`);
    head.append(count);
    left.append(head);

    const grid = el('div', 'pills-grid'); grid.id = 'pill-declared-grid';
    for (const tile of [...declaredTiles, ...blobTiles]) {
      const b = el('button', 'pill-tile');
      b.type = 'button';
      b.id = tile.kind === 'pill' ? `pill-tile-${tile.id}` : `blob-tile-${tile.index}`;
      if (tile.kind === 'pill') b.dataset.pillId = tile.id; else b.dataset.blobName = tile.name;
      const color = tile.kind === 'pill' ? P.colorOf(prefs, tile.id) : P.colorOfBlob(prefs, tile.name);
      if (color) b.dataset.color = color;
      b.setAttribute('aria-pressed', selected && selected.key === tile.key ? 'true' : 'false');
      b.setAttribute('aria-label', tile.name);
      b.append(blob('blob-visual', color));
      b.append(el('span', 'pill-name', tile.name));
      b.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        ui.key = tile.key; ui.mode = 'edit'; paint();
      });
      // D5: drag to order — the same closed reorder command the arrows dispatch.
      // Reduced motion only softens the visuals (CSS); the reorder itself is the
      // keyboard-equivalent command, never a different code path.
      b.addEventListener('pointerdown', event => {
        if (event.isTrusted !== true) return;
        drag = { key: tile.key, node: b }; b.dataset.dragging = 'true';
      });
      b.addEventListener('pointerup', event => {
        if (event.isTrusted !== true || !drag || drag.key === tile.key) { drag = null; return; }
        delete drag.node.dataset.dragging;
        const source = drag.key; drag = null;
        const list = tile.kind === 'pill' ? [...prefs.declaredPills] : prefs.blobs.map(x => x.name);
        const ids = tile.kind === 'pill' ? list : list; // names for blobs, ids for pills
        const from = source.startsWith('pill:') ? ids.indexOf(source.slice(5)) : ids.indexOf(source.slice(5));
        const at = from < 0 ? -1 : from;
        if (at < 0) return;
        const moved = ids.splice(at, 1)[0];
        ids.splice(ids.indexOf(tile.kind === 'pill' ? tile.id : tile.name), 0, moved);
        const next = tile.kind === 'pill' ? P.reorderDeclared(prefs, ids) : P.reorderBlobs(prefs, ids);
        if (!next) return;
        o.onCommand(tile.kind === 'pill'
          ? { action: 'reorder_declared_pills', order: ids }
          : { action: 'reorder_blobs', order: ids });
        paint();
      });
      b.addEventListener('pointercancel', () => { if (drag) { delete drag.node.dataset.dragging; drag = null; } });
      grid.append(b);
    }
    // The empty «Nuevo» slot: the designed full state (4/4) has none.
    if (prefs.declaredPills.length < P.MAX_DECLARED) {
      const fresh = el('button', 'pill-tile-new');
      fresh.type = 'button'; fresh.id = 'pill-tile-new';
      fresh.setAttribute('aria-label', 'Nuevo blob');
      fresh.append(el('span', 'pill-plus', '+'));
      fresh.append(el('span', 'pill-name', 'Nuevo'));
      fresh.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        ui.key = null; ui.mode = 'create'; ui.createName = ''; ui.createColor = '';
        ui.createKind = 'catalog'; ui.catalogSearch = ''; ui.catalogCat = 'all'; ui.catalogPick = '';
        paint();
      });
      grid.append(fresh);
    }
    left.append(grid);

    left.append(el('span', 'psection-label', 'Así se ve en la isla'));
    const strip = el('div', 'pill-strip'); strip.id = 'pill-island-strip';
    // The island order is the model's order (main, declared, created) and the island
    // itself caps the visible tiles at four — the strip mirrors it node for node.
    for (const def of P.visible(prefs)) {
      const item = el('div', 'pill-strip-item');
      const color = P.colorOf(prefs, def.id);
      if (color) item.dataset.color = color;
      item.append(blob('blob-visual', color));
      item.append(el('span', 'pill-name', def.name));
      strip.append(item);
    }
    for (const b of prefs.blobs) {
      const item = el('div', 'pill-strip-item');
      const color = P.colorOfBlob(prefs, b.name);
      if (color) item.dataset.color = color;
      item.append(blob('blob-visual', color));
      item.append(el('span', 'pill-name', b.name));
      strip.append(item);
    }
    left.append(strip);
    const issue = el('p', 'snote', o.error || ''); issue.id = 'pill-settings-error';
    issue.setAttribute('role', 'status');
    left.append(issue);

    // ---- editor panel -----------------------------------------------------------------------------------
    const editor = el('aside', 'pills-editor'); editor.id = 'pill-editor';
    if (ui.mode === 'create') {
      // §4.1: the segmented control tops both modes; «Del catálogo» is the default.
      const seg = el('div', 'segmented');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Tipo de blob');
      const catSeg = el('button', 'seg', 'Del catálogo'); catSeg.type = 'button'; catSeg.id = 'create-kind-catalog';
      catSeg.setAttribute('aria-pressed', ui.createKind !== 'custom' ? 'true' : 'false');
      catSeg.addEventListener('click', event => {
        if (event.isTrusted !== true || ui.createKind === 'catalog') return;
        ui.createKind = 'catalog'; paint();
      });
      const ownSeg = el('button', 'seg', 'Propio'); ownSeg.type = 'button'; ownSeg.id = 'create-kind-custom';
      ownSeg.setAttribute('aria-pressed', ui.createKind === 'custom' ? 'true' : 'false');
      ownSeg.addEventListener('click', event => {
        if (event.isTrusted !== true || ui.createKind === 'custom') return;
        ui.createKind = 'custom'; paint();
      });
      seg.append(catSeg, ownSeg);
      editor.append(seg);
    }
    if (ui.mode === 'create' && ui.createKind === 'catalog') {
      // §4.1 Mode A: search, category chips, the offered list with markers, the
      // one-line hint, and Agregar/Cancelar. Agregar is today's declaration: the
      // existing closed toggle command, same gates, no new wire surface.
      const search = el('input', 'sfield'); search.id = 'pill-catalog-search';
      search.placeholder = 'Buscar…';
      search.setAttribute('aria-label', 'Buscar en el catálogo');
      search.value = ui.catalogSearch;
      const chips = el('div', 'pill-catalog-cats');
      // §4.1 fixes the chip copy: «IA» — shorter than the catalog's category name.
      const catLabels = { workspace: 'Dónde programás', agent: 'Agentes', ai: 'IA', service: 'Servicios' };
      for (const cat of [{ id: 'all', name: 'Todos' }, ...C.CATEGORIES]) {
        const chip = el('button', 'pill-catalog-cat', cat.id === 'all' ? cat.name : catLabels[cat.id] || cat.name); chip.type = 'button';
        chip.dataset.cat = cat.id;
        chip.setAttribute('aria-pressed', ui.catalogCat === cat.id ? 'true' : 'false');
        chip.addEventListener('click', event => {
          if (event.isTrusted !== true || ui.catalogCat === cat.id) return;
          ui.catalogCat = cat.id; paint();
        });
        chips.append(chip);
      }
      const list = el('div', 'pill-catalog-list'); list.id = 'pill-catalog-list';
      const add = el('button', 'sbtn primary', 'Agregar'); add.type = 'button'; add.id = 'pill-catalog-add';
      add.disabled = o.saving || !ui.catalogPick;
      const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'pill-catalog-cancel';
      const closeChooser = () => {
        ui.mode = 'edit'; ui.catalogPick = ''; ui.catalogSearch = ''; ui.catalogCat = 'all'; paint();
      };
      const rebuild = () => {
        add.disabled = o.saving || !ui.catalogPick; // a selection enables Agregar
        const q = ui.catalogSearch.trim().toLowerCase();
        const defs = C.available().filter(d =>
          (ui.catalogCat === 'all' || d.category === ui.catalogCat) &&
          (!q || d.name.toLowerCase().includes(q)));
        list.textContent = '';
        if (!defs.length) { list.append(el('span', 'pill-catalog-empty', 'Sin resultados')); return; }
        for (const d of defs) {
          const isMain = d.id === prefs.mainPill;
          const isDeclared = prefs.declaredPills.includes(d.id);
          const row = el(isMain || isDeclared ? 'div' : 'button', 'pill-catalog-row');
          row.dataset.pillId = d.id;
          if (!isMain && !isDeclared) {
            row.type = 'button'; row.id = `pill-catalog-row-${d.id}`;
            row.setAttribute('aria-pressed', ui.catalogPick === d.id ? 'true' : 'false');
            row.addEventListener('click', event => {
              if (event.isTrusted !== true) return;
              ui.catalogPick = d.id;
              rebuild(); // selection ring, check icon and Agregar follow
            });
            if (ui.catalogPick === d.id) {
              const ico = el('span', 'ico'); (o.putIcon || (() => {}))(ico, 'check');
              row.append(ico);
            }
          }
          row.append(blob('blob-visual pill-catalog-blob', P.colorOf(prefs, d.id)));
          row.append(el('span', 'pill-catalog-name', d.name));
          if (isMain) row.append(el('span', 'chip', 'Principal'));
          else if (isDeclared) row.append(el('span', 'chip', 'Ya está'));
          list.append(row);
        }
      };
      search.addEventListener('input', event => {
        if (event.isTrusted !== true) return;
        ui.catalogSearch = search.value;
        rebuild(); // the search field keeps its focus: only the list is rebuilt
      });
      add.addEventListener('click', event => {
        if (event.isTrusted !== true || add.disabled) return;
        const id = ui.catalogPick;
        if (!P.toggle(prefs, id)) return; // the same closed gates as today's declaration
        o.onCommand({ action: 'toggle_declared_pill', id });
        ui.mode = 'edit'; ui.key = `pill:${id}`; // §4.1: Agregar selects the new tile
        ui.catalogPick = ''; ui.catalogSearch = ''; ui.catalogCat = 'all';
        paint();
      });
      cancel.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        closeChooser();
      });
      editor.append(search, chips, list, el('span', 'pill-catalog-note', 'Elegir no conecta la cuenta'));
      const actions = el('div', 'editor-actions');
      actions.append(add, cancel);
      editor.append(actions);
      rebuild();
    } else if (ui.mode === 'create') {
      editor.append(blob('blob-visual blob-preview'));
      const nameLabel = el('label', 'srow-title', 'Nombre'); nameLabel.htmlFor = 'blob-create-input';
      editor.append(nameLabel);
      const input = el('input', 'sfield'); input.id = 'blob-create-input';
      input.placeholder = 'Nombre del blob'; input.maxLength = P.MAX_BLOB_NAME;
      input.setAttribute('aria-label', 'Nombre del nuevo blob');
      input.disabled = o.saving;
      input.value = ui.createName;
      const create = el('button', 'sbtn primary', 'Crear'); create.type = 'button'; create.id = 'blob-create-button';
      create.disabled = o.saving;
      const paintCreate = () => { create.disabled = o.saving || !input.value.trim() || !ui.createColor; };
      paintCreate();
      input.addEventListener('input', event => {
        if (event.isTrusted !== true) return;
        ui.createName = input.value; paintCreate();
      });
      editor.append(input);
      editor.append(swatchRow(el, A, ui.createColor, 'Color del nuevo blob', color => {
        ui.createColor = color; // the colour rides along when Crear is pressed
        return null; // never dispatches: creation is one command at the end
      }, o, true));
      const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'blob-create-cancel';
      cancel.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        ui.mode = 'edit'; ui.createName = ''; ui.createColor = ''; paint();
      });
      create.addEventListener('click', event => {
        if (event.isTrusted !== true || create.disabled) return;
        const name = input.value.trim();
        if (!P.createBlob(prefs, name, ui.createColor || '')) return; // closed gate: bad, duplicate or reserved name
        o.onCommand(ui.createColor ? { action: 'create_blob', name, color: ui.createColor } : { action: 'create_blob', name });
        ui.mode = 'edit'; ui.createName = ''; ui.createColor = ''; paint();
      });
      const actions = el('div', 'editor-actions');
      actions.append(create, cancel);
      editor.append(actions);
    } else if (ui.mode === 'delete' && selected) {
      editor.append(blob('blob-visual blob-preview', selectedColor));
      editor.append(el('strong', 'pill-editor-question', `¿Eliminar "${selected.name}"?`));
      editor.append(el('span', 'pill-editor-detail', 'Se quita de la isla.'));
      const confirm = el('button', 'sbtn danger', 'Eliminar'); confirm.type = 'button'; confirm.id = 'pill-editor-confirm-delete';
      confirm.disabled = o.saving;
      confirm.setAttribute('aria-label', `Eliminar: ${selected.name}`);
      confirm.addEventListener('click', event => {
        if (event.isTrusted !== true || confirm.disabled) return;
        // A declared pill quits the island through the existing toggle; a created
        // blob through delete_blob. Both are the shipped closed commands.
        if (selected.kind === 'pill') {
          if (!P.toggle(prefs, selected.id)) return;
          o.onCommand({ action: 'toggle_declared_pill', id: selected.id });
        } else {
          if (!P.deleteBlob(prefs, selected.name)) return;
          o.onCommand({ action: 'delete_blob', name: selected.name });
        }
        ui.mode = 'edit'; paint();
      });
      const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'pill-editor-cancel-delete';
      cancel.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        ui.mode = 'edit'; paint();
      });
      const actions = el('div', 'editor-actions');
      actions.append(confirm, cancel);
      editor.append(actions);
    } else if (selected) {
      editor.append(blob('blob-visual blob-preview', selectedColor));
      const nameLabel = el('label', 'srow-title', 'Nombre'); nameLabel.htmlFor = 'pill-editor-name';
      editor.append(nameLabel);
      const name = el('input', 'sfield'); name.id = 'pill-editor-name';
      name.value = selected.name; name.disabled = true; // no rename command exists; names are fixed
      name.setAttribute('aria-label', 'Nombre');
      editor.append(name);
      const colorLabel = el('label', 'srow-title', 'Color');
      editor.append(colorLabel);
      editor.append(swatchRow(el, A, selectedColor, `Color de ${selected.name}`, color => {
        if (selected.kind === 'pill') {
          if (!color) {
            if (!P.clearColor(prefs, selected.id)) return;
            o.onCommand({ action: 'clear_pill_color', id: selected.id });
          } else {
            if (!P.setColor(prefs, selected.id, color)) return;
            o.onCommand({ action: 'set_pill_color', id: selected.id, color });
          }
        } else {
          if (!P.setBlobColor(prefs, selected.name, color)) return;
          o.onCommand({ action: 'set_blob_color', name: selected.name, color });
        }
        paint();
      }, o, false));
      const actions = el('div', 'editor-actions');
      // D5: the arrows are the keyboard-equivalent of the drag, persisted.
      const list = selected.kind === 'pill' ? prefs.declaredPills : prefs.blobs.map(x => x.name);
      const at = selected.kind === 'pill' ? list.indexOf(selected.id) : list.indexOf(selected.name);
      const move = delta => {
        const to = at + delta;
        if (at < 0 || to < 0 || to >= list.length) return;
        const order = [...list];
        order.splice(to, 0, order.splice(at, 1)[0]);
        const next = selected.kind === 'pill' ? P.reorderDeclared(prefs, order) : P.reorderBlobs(prefs, order);
        if (!next) return;
        o.onCommand(selected.kind === 'pill'
          ? { action: 'reorder_declared_pills', order }
          : { action: 'reorder_blobs', order });
        paint();
      };
      const back = el('button', 'sbtn'); back.type = 'button'; back.id = 'pill-editor-left';
      back.disabled = o.saving || at <= 0;
      back.setAttribute('aria-label', `Mover ${selected.name} antes`);
      const backIcon = el('span', 'ico'); (o.putIcon || (() => {}))(backIcon, 'arrow-left'); back.append(backIcon);
      back.addEventListener('click', event => { if (event.isTrusted === true) move(-1); });
      const forth = el('button', 'sbtn'); forth.type = 'button'; forth.id = 'pill-editor-right';
      forth.disabled = o.saving || at < 0 || at >= list.length - 1;
      forth.setAttribute('aria-label', `Mover ${selected.name} después`);
      const forthIcon = el('span', 'ico'); (o.putIcon || (() => {}))(forthIcon, 'arrow-right');
      forth.append(forthIcon);
      forth.addEventListener('click', event => { if (event.isTrusted === true) move(1); });
      actions.append(back, forth);
      // D4 + D3: «Principal» promotes a declared tile with the existing closed
      // command; the character colour follows in settings.js (the same payload).
      const main = el('button', 'sbtn', 'Principal'); main.type = 'button'; main.id = 'pill-editor-main';
      main.disabled = o.saving || selected.kind === 'blob' || selected.id === prefs.mainPill ||
        !C.mainChoices().some(def => def.id === selected.id);
      main.setAttribute('aria-label', `Hacer principal: ${selected.name}`);
      const crown = el('span', 'ico'); (o.putIcon || (() => {}))(crown, 'crown'); main.append(crown);
      main.append(el('span', 'btn-word', 'Principal'));
      main.addEventListener('click', event => {
        if (event.isTrusted !== true || main.disabled || !P.chooseMain(prefs, selected.id)) return;
        o.onCommand({ action: 'set_main_pill', id: selected.id });
        paint();
      });
      actions.append(main);
      const remove = el('button', 'sbtn danger'); remove.type = 'button'; remove.id = 'pill-editor-delete';
      remove.disabled = o.saving || selected.principal === true; // the principal is never removable
      remove.setAttribute('aria-label', `Eliminar: ${selected.name}`);
      remove.append(el('span', 'btn-word', 'Eliminar'));
      remove.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        ui.mode = 'delete'; paint();
      });
      actions.append(remove);
      editor.append(actions);
    }

    // ---- two-column layout ------------------------------------------------------------------------------
    const layout = el('div', 'pills-layout');
    layout.append(left, editor);
    host.append(layout);
  }
  // Internal transitions (select, open editor states) re-render with the last args.
  function paint() { if (lastArgs) render(...lastArgs); }

  // The five-colour swatch row from the closed palette (avatar-colors.js PALETTE).
  // A real radiogroup with roving tabindex, the #384 pattern: the arrows choose,
  // Home/End jump, and clicking the current colour clears it (the reversible way
  // back, since the design keeps no visible «Sin color» swatch).
  function swatchRow(el, A, current, label, onPick, o, localOnly) {
    const row = el('div', 'swatch-row');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', label);
    const paintRow = () => {
      for (const b of row.children) {
        const on = b.dataset.color === current;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    };
    for (const color of A.PALETTE) {
      const b = el('button', 'swatch');
      b.type = 'button'; b.dataset.color = color;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', color === current ? 'true' : 'false');
      b.setAttribute('aria-label', A.label(color));
      b.disabled = o.saving;
      b.id = `swatch-${localOnly ? 'new' : `${label}`}-${color}`.replace(/[^a-zA-Z0-9-]/g, '-');
      b.tabIndex = color === current ? 0 : -1;
      b.addEventListener('click', event => {
        if (event.isTrusted !== true || b.disabled) return;
        if (color === current) { if (!localOnly) onPick(''); return; }
        if (localOnly) { current = color; onPick(color); paint(); return; } // the create form keeps the pick in ui state
        onPick(color);
      });
      b.addEventListener('keydown', event => {
        if (event.isTrusted !== true || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...row.children];
        const at = buttons.indexOf(b);
        let next = at + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1);
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        next = (next + buttons.length) % buttons.length;
        buttons.forEach((x, i) => { x.tabIndex = i === next ? 0 : -1; });
        buttons[next].focus();
        if (localOnly) { current = buttons[next].dataset.color; onPick(current); paint(); return; }
        onPick(buttons[next].dataset.color);
      });
      row.append(b);
    }
    return row;
  }
  root.AbitoPillSettings = Object.freeze({ render });
})(typeof window !== 'undefined' ? window : this);
