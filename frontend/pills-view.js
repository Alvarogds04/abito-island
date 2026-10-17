'use strict';
// #442: the island is Abito + at most three stored specialists. Selection uses the existing
// role target command; it never connects a service, starts work, or migrates legacy pill data.
(function (root) {
  const doc = typeof document === 'object' ? document : null;
  if (!doc || !root.AbitoAvatarColors) return;
  const get = id => doc.getElementById(id);
  const host = get('pill-choices'), name = get('pill-name'), state = get('pill-state');
  const detail = get('pill-detail'), live = get('pill-live'), capsule = get('capsule');
  if (!host || !name || !state || !detail || !capsule) return;
  const A = root.AbitoAvatarColors;
  let prefs = {}, version = 0, busy = false;
  const mounted = new Map();
  const owner = () => root.AbitoSpecialistsPanel;
  const store = () => owner()?.state().store;
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  };
  const say = text => { if (live) live.textContent = text; };
  function syncClay(item) {
    // Per-instance lifecycle: never change the shared engine's global policy (Abito owns it).
    const mode = !onScreen() || doc.hidden ? 'hidden' : doc.documentElement.dataset.motion === 'reduce' ? 'static' : 'live';
    if (item.mode === mode) return;
    item.clay?.destroy(); item.clay = null; item.mode = mode;
    if (mode !== 'hidden' && typeof AbitoClay !== 'undefined') {
      item.clay = AbitoClay.create(item.svg, { state: 'idle', live: mode === 'live', viewBox: '36 32 128 128', shadow: false });
    }
  }
  const syncVisibility = () => { for (const item of mounted.values()) syncClay(item); };
  function choose(id) {
    if (busy || !owner()) return;
    busy = true;
    owner().act({ action: 'select', id: id === A.PRINCIPAL_ID ? null : id }).then(() => {
      busy = false; paint(); say('Destino elegido. No se inició ninguna tarea.');
    }, () => { busy = false; paint(); say('No se pudo elegir el destino; se mantuvo el anterior.'); });
  }
  function paint() {
    const focused = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.id : null;
    const currentStore = store();
    const agents = root.AbitoSpecialists?.agentsView(currentStore, prefs, A).agents || [];
    const rows = [{ id: A.PRINCIPAL_ID, name: 'Abito', color: A.resolveColor(A.PRINCIPAL_ID, prefs.avatarColors) }, ...agents];
    const storedActive = currentStore?.specialists?.find(r => r.id === currentStore.active);
    const selected = storedActive ? storedActive.id : A.PRINCIPAL_ID;
    const picked = storedActive || rows[0];
    name.textContent = picked.name;
    state.textContent = storedActive && !rows.some(r => r.id === selected) ? 'Fuera de la isla' : 'En reposo';
    detail.textContent = 'Elegir un destino no inicia tareas.';
    detail.setAttribute('aria-label', `${picked.name}: destino de conversación. No se inició ninguna tarea.`);
    const alive = new Set(rows.map(r => r.id));
    for (const [id, item] of mounted) if (!alive.has(id)) { item.clay?.destroy(); mounted.delete(id); }
    const buttons = rows.map(row => {
      let item = mounted.get(row.id);
      if (!item) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'pill-choice';
        button.id = `pill-choice-${row.id}`; button.dataset.pillId = row.id;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'island-agent-clay');
        svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '28'); svg.setAttribute('height', '28');
        const label = doc.createElement('span'); button.append(svg, label);
        item = { button, label, svg, clay: null, mode: null }; mounted.set(row.id, item);
        button.addEventListener('click', event => { if (event.isTrusted === true && onScreen()) choose(row.id); });
      }
      item.label.textContent = row.name; item.button.dataset.color = row.color; item.svg.dataset.color = row.color;
      item.button.setAttribute('aria-pressed', selected === row.id ? 'true' : 'false');
      item.button.setAttribute('aria-label', `${row.name}${row.id === A.PRINCIPAL_ID ? ', principal' : ''}: destino de conversación`);
      syncClay(item);
      return item.button;
    });
    // Updating labels/colours must not detach surviving SVGs or restart browser animations.
    if (host.children.length !== buttons.length || buttons.some((button, i) => host.children[i] !== button)) {
      host.replaceChildren(...buttons);
    }
    if (focused) (get(focused) || get(`pill-choice-${selected}`) || get(`pill-choice-${A.PRINCIPAL_ID}`))?.focus();
  }
  function apply(raw) { prefs = raw && typeof raw === 'object' ? raw : {}; paint(); }
  doc.addEventListener('abito:specialists-changed', paint);
  doc.addEventListener('visibilitychange', syncVisibility);
  if (typeof MutationObserver !== 'undefined') {
    const visibility = new MutationObserver(syncVisibility);
    visibility.observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
    visibility.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  }
  paint();
  const invoke = root.__TAURI__?.core?.invoke || root.__TAURI_INTERNALS__?.invoke;
  const listen = root.__TAURI__?.event?.listen;
  if (listen) listen('prefs:state', event => { version += 1; apply(event?.payload); }).catch(() => {});
  if (invoke) {
    const observed = version;
    invoke('prefs_action', { payload: { action: 'view' } }).then(raw => {
      if (version === observed) apply(raw);
    }, () => say('No se pudieron leer tus blobs guardados. Se muestra Abito sin guardar.'));
  } else say('Sin acceso a preferencias. Se muestra Abito sin guardar.');
})(typeof window !== 'undefined' ? window : this);
