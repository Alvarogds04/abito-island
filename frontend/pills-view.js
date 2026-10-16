'use strict';
// #345 actual overview controller. Selection is local, never connection/session
// execution. Existing island host connection/notices/cards retain their owners.
(function (root) {
  const C = root.AbitoPillCatalog, P = root.AbitoPills, I = root.AbitoIcons;
  const doc = typeof document === 'object' ? document : null;
  if (!C || !P || !doc || !I) return;
  const get = id => doc.getElementById(id);
  const host = get('pill-choices'), name = get('pill-name'), state = get('pill-state');
  const detail = get('pill-detail'), live = get('pill-live'), capsule = get('capsule');
  if (!host || !name || !state || !detail || !capsule) return;
  let prefs = P.normalize({}), selected = prefs.mainPill, version = 0;
  const parser = new DOMParser();
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  };
  function paint() {
    const focused = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.id : null;
    selected = P.selection(prefs, selected);
    const view = P.detail(selected);
    name.textContent = view.name; state.textContent = view.word;
    detail.textContent = 'Elegir no conecta el servicio.';
    detail.setAttribute('aria-label', view.aria);
    host.textContent = '';
    for (const def of P.visible(prefs)) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'pill-choice';
      button.id = `pill-choice-${def.id}`; button.dataset.pillId = def.id;
      // #346 F033: only an already-validated palette name ever reaches the DOM.
      const color = P.colorOf(prefs, def.id);
      if (color) button.dataset.color = color;
      button.setAttribute('aria-pressed', selected === def.id ? 'true' : 'false');
      button.setAttribute('aria-label', `${def.name}${def.id === prefs.mainPill ? ', principal' : ''}: sin conexión`);
      const glyph = parser.parseFromString(I.svg('plug-off'), 'image/svg+xml').documentElement;
      if (glyph && glyph.nodeName === 'svg') {
        const holder = doc.createElement('span'); holder.className = 'ico';
        holder.append(doc.importNode(glyph, true)); button.append(holder);
      }
      const label = doc.createElement('span'); label.textContent = def.name; button.append(label);
      button.addEventListener('click', event => {
        if (event.isTrusted !== true || !onScreen()) return;
        selected = def.id; paint();
        if (live) live.textContent = P.detail(selected).aria;
      });
      host.append(button);
    }
    if (focused) (get(focused) || get(`pill-choice-${selected}`))?.focus();
  }
  function apply(raw) {
    const next = P.normalize(raw);
    if (next.mainPill !== prefs.mainPill) selected = next.mainPill;
    prefs = next; paint();
  }
  paint();
  const invoke = root.__TAURI__?.core?.invoke || root.__TAURI_INTERNALS__?.invoke;
  const listen = root.__TAURI__?.event?.listen;
  if (listen) listen('prefs:state', event => { version += 1; apply(event?.payload); }).catch(() => {});
  if (invoke) {
    const observed = version;
    invoke('prefs_action', { payload: { action: 'view' } }).then(raw => {
      if (version === observed) apply(raw); // initial read cannot overwrite a newer pushed snapshot
    }, () => { if (live) live.textContent = 'No se pudieron leer tus blobs guardados. Se muestran los valores predeterminados sin guardar.'; });
  } else if (live) live.textContent = 'Sin acceso a preferencias. Se muestran los valores predeterminados sin guardar.';
})(typeof window !== 'undefined' ? window : this);
