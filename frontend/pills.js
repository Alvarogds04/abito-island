'use strict';
// #345 F032: selections, not connections. Pure; stored-load normalization is
// deliberately separate from strict submitted-choice validation.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./pill-catalog.js') : root.AbitoPillCatalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoPills = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, C => {
  const DEFAULT_MAIN = 'integration_claude';
  const MAX_DECLARED = 4;
  const DEFAULT_DECLARED = Object.freeze(['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github']);
  const isMain = (id, os) => C.mainChoices(os).some(def => def.id === id);
  function normalize(raw, os = C.HOST_OS) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mainPill = isMain(input.mainPill, os) ? input.mainPill : DEFAULT_MAIN;
    const values = Array.isArray(input.declaredPills) ? input.declaredPills : DEFAULT_DECLARED;
    const declaredPills = [];
    for (const id of values) {
      if (id !== mainPill && C.offered(id, os) && !declaredPills.includes(id) && declaredPills.length < MAX_DECLARED) declaredPills.push(id);
    }
    return { mainPill, declaredPills };
  }
  function valid(state, os = C.HOST_OS) {
    return !!state && isMain(state.mainPill, os) && Array.isArray(state.declaredPills) &&
      state.declaredPills.length <= MAX_DECLARED && new Set(state.declaredPills).size === state.declaredPills.length &&
      state.declaredPills.every(id => id !== state.mainPill && C.offered(id, os));
  }
  function toggle(state, id, os = C.HOST_OS) {
    if (!valid(state, os) || id === state.mainPill || !C.offered(id, os)) return null;
    const active = state.declaredPills.includes(id);
    if (!active && state.declaredPills.length >= MAX_DECLARED) return null;
    return { mainPill: state.mainPill, declaredPills: active ? state.declaredPills.filter(x => x !== id) : [...state.declaredPills, id] };
  }
  function chooseMain(state, id, os = C.HOST_OS) {
    if (!valid(state, os) || !isMain(id, os)) return null;
    return { mainPill: id, declaredPills: state.declaredPills.filter(x => x !== id) };
  }
  // Future pure ordering seam, not an invented external-session producer.
  function order(items, mainPill) {
    const rank = id => id === mainPill ? -2 : C.definition(id) ? C.CATALOG.findIndex(def => def.id === id) : -1;
    return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(x => x.item);
  }
  function visible(raw, os = C.HOST_OS) {
    const state = normalize(raw, os);
    return order([state.mainPill, ...state.declaredPills].map(C.definition), state.mainPill);
  }
  const selection = (raw, id, os = C.HOST_OS) => visible(raw, os).some(def => def.id === id) ? id : normalize(raw, os).mainPill;
  function detail(id, os = C.HOST_OS) {
    const def = C.definition(id);
    if (!def) return null;
    const offered = C.offered(id, os);
    const word = offered ? 'Sin conexión' : 'No disponible';
    const detail = def.platform === 'excluded' ? 'Apple Music queda fuera de la versión 0.2.' :
      !offered ? 'Esta integración no tiene soporte en este sistema.' :
      'Elegir esta pill no conecta el servicio. No hay una sesión activa disponible para esta vista.';
    return { id, name: def.name, offered, connected: false, word, detail, icon: 'plug-off', tone: 'faint', aria: `${def.name}: ${word}. ${detail}` };
  }
  return { DEFAULT_MAIN, DEFAULT_DECLARED, MAX_DECLARED, normalize, valid, toggle, chooseMain, order, visible, selection, detail };
});
