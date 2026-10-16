'use strict';
/* #352 F034/F035/F036 — the integrations framework: a closed service registry,
   a per-service enable toggle, the connection state, refresh/pause actions and
   an open-target action from a closed URL allowlist. ONE file, the house pattern
   (sessions-ticker.js): the pure view-model, the textContent-only renderer and
   a FAKE provider, browser-only at the tail.

   FAKE DATA ONLY: nothing here talks to a network, opens an account, holds a
   token or touches a real service. The fake provider is LOUD about it — every
   rendered view carries the visible «datos de ejemplo» marker so sample rows can
   never be mistaken for real connections.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   The module is inert until wired: it mounts ONLY when the container exists.
   1. one container inside the Ajustes body:
        <section id="integrations" hidden></section>
   2. one script tag after the modules it reads (theme, icons):
        <script src="integrations-view.js" defer></script>
   On mount it renders the FAKE provider frame into #integrations and wires its
   own buttons; with the container absent it costs nothing. Styling: the single
   append-only block at the end of style.css uses theme tokens only, so light
   and dark resolve with zero raw colors.

   ---- TYPED OPTIONAL PREF PROPOSAL (NOT implemented — prefs.rs needs approval) ----
   To persist the enable toggle, propose ONE typed optional pref:
     integrations_enabled: Option<BTreeMap<String, bool>>   // serde default
   - absent / None  => every service disabled (the default; the view never
     claims a persistence that did not happen);
   - keys: service ids from THIS registry only (9 closed ids); unknown keys are
     dropped on read, never echoed back;
   - values: bool only; more than 9 entries => the pref is refused whole;
   - read through the existing prefs gate; the Rust side would expose
     integrations_get / integrations_set. Until approved, the toggle lives in
     memory only and resets with the page.

   ---- OPEN TARGET ----
   Each service may carry one URL in the frozen ALLOWLIST below (finance has
   none). openTarget hands it out ONLY for an enabled, connected service, and
   the renderer routes it through the EXISTING host command `open_chat_url`
   (main.rs F025), which re-validates with its own rules. The allowlist is a
   strict subset of what that validator accepts, and
   test-node/integrations-view-check.cjs mirrors the Rust rules on purpose.

   Loaded as a classic script (window.AbitoIntegrations) and by
   test-node/integrations-view-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIntegrations = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-integrations/view/1';
  const MAX_SERVICES = 9; // the registry is closed at exactly this size

  // ---- closed registry (card order) ------------------------------------------
  const SERVICES = Object.freeze([
    ['github', 'GitHub'],
    ['deployments', 'Despliegues'],
    ['email', 'Correo'],
    ['payments', 'Pagos'],
    ['notion', 'Notion'],
    ['n8n', 'n8n'],
    ['calendar', 'Calendario'],
    ['slack', 'Slack'],
    ['finance', 'Finanzas'],
  ].map(([id, name]) => Object.freeze({ id, name })));

  // ---- closed connection vocabulary, labeled in Spanish -----------------------
  const STATES = Object.freeze(['disconnected', 'connected', 'error', 'paused']);
  const STATE_LABELS = Object.freeze({
    disconnected: 'sin conectar', connected: 'conectado', error: 'error', paused: 'en pausa',
  });

  // ---- closed URL allowlist (public sites; finance has no target) -------------
  // Every entry satisfies the host open_chat_url validator (see header). The
  // frame NEVER carries a URL: the target lives only here.
  const ALLOWLIST = Object.freeze({
    github: 'https://github.com',
    deployments: 'https://vercel.com',
    email: 'https://resend.com',
    payments: 'https://stripe.com',
    notion: 'https://www.notion.so',
    n8n: 'https://n8n.io',
    calendar: 'https://cal.com',
    slack: 'https://slack.com',
  });

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const rowOf = id => (isStr(id) ? SERVICES.find(s => s.id === id) || null : null);
  const serviceById = rowOf;
  const stateLabel = s => (STATES.includes(s) ? STATE_LABELS[s] : null);

  const rowDefault = () => Object.freeze({ enabled: false, state: 'disconnected', refreshedAt: null });
  const freezeRow = r => Object.freeze({ enabled: r.enabled, state: r.state, refreshedAt: r.refreshedAt });

  // ---- store ------------------------------------------------------------------
  /** The default store: every service disabled and disconnected. Frozen. */
  function createStore() {
    const services = {};
    for (const s of SERVICES) services[s.id] = rowDefault();
    return Object.freeze({ fake: false, services: Object.freeze(services) });
  }

  /**
   * A closed `integrations` frame to a frozen store. Anything off-shape returns
   * null: malformed rows are never half-built, unknown ids are dropped, a frame
   * that carries ONLY unknown rows is refused, duplicates resolve to the FIRST
   * row, and a frame that smuggles an open target (or any extra key) is refused
   * whole — the allowlist lives only in this module.
   */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'integrations' || frame.schema !== SCHEMA) return null;
    if (typeof frame.fake !== 'boolean' || !Array.isArray(frame.services)) return null;
    if (!Object.keys(frame).every(k => ['type', 'schema', 'fake', 'services'].includes(k))) return null;
    if (frame.services.length > MAX_SERVICES) return null;
    const services = {};
    for (const s of SERVICES) services[s.id] = rowDefault();
    const seenIds = new Set();
    let validRows = 0;
    for (const raw of frame.services) {
      if (!isObject(raw)) return null;
      if (!Object.keys(raw).every(k => ['id', 'enabled', 'state'].includes(k))) return null;
      if (!rowOf(raw.id)) continue; // unknown ids are dropped, never repaired
      if (typeof raw.enabled !== 'boolean' || !STATES.includes(raw.state)) return null;
      if (seenIds.has(raw.id)) continue; // duplicate: first wins
      seenIds.add(raw.id);
      validRows += 1;
      services[raw.id] = Object.freeze({ enabled: raw.enabled, state: raw.state, refreshedAt: null });
    }
    if (frame.services.length > 0 && validRows === 0) return null;
    return Object.freeze({ fake: frame.fake, services: Object.freeze(services) });
  }

  /** Shape check for a store built here or by storeFromFrame (defense in depth). */
  function isStore(store) {
    if (!isObject(store) || typeof store.fake !== 'boolean' || !isObject(store.services)) return false;
    if (Object.keys(store.services).length !== SERVICES.length) return false;
    for (const s of SERVICES) {
      const r = store.services[s.id];
      if (!isObject(r) || Object.keys(r).length !== 3) return false;
      if (typeof r.enabled !== 'boolean' || !STATES.includes(r.state)) return false;
      if (r.refreshedAt !== null && !Number.isFinite(r.refreshedAt)) return false;
    }
    return true;
  }

  /** With one mutated row, frozen; null when anything is off (data unchanged). */
  function withRow(store, id, patch) {
    if (!isStore(store) || !rowOf(id)) return null;
    const row = store.services[id];
    const next = freezeRow({ ...row, ...patch });
    const services = {};
    for (const s of SERVICES) services[s.id] = s.id === id ? next : store.services[s.id];
    return Object.freeze({ fake: store.fake, services: Object.freeze(services) });
  }

  // ---- actions (pure; rejected input leaves the store untouched) ---------------
  /** The enable toggle. Bool or nothing. */
  function setEnabled(store, id, value) {
    if (typeof value !== 'boolean') return null;
    return withRow(store, id, { enabled: value });
  }

  /**
   * Refresh: only an ENABLED service refreshes, and the outcome is a closed
   * connection state plus a finite timestamp (the provider decides the state —
   * today the fake provider, later the daemon's frame).
   */
  function refresh(store, id, state, now) {
    if (!isStore(store) || !STATES.includes(state) || !Number.isFinite(now)) return null;
    if (!store.services[id] || !store.services[id].enabled) return null;
    return withRow(store, id, { state, refreshedAt: now });
  }

  /** Pause / resume: only connected pauses, only paused resumes. */
  function togglePause(store, id) {
    if (!isStore(store)) return null;
    const state = store.services[id] && store.services[id].state;
    if (state === 'connected') return withRow(store, id, { state: 'paused' });
    if (state === 'paused') return withRow(store, id, { state: 'connected' });
    return null;
  }

  /**
   * The open target: the allowlisted URL for an ENABLED, CONNECTED service, and
   * nothing else ever opens. The renderer hands this to `open_chat_url`, which
   * re-validates on the host side.
   */
  function openTarget(store, id) {
    if (!isStore(store) || !rowOf(id)) return null;
    const row = store.services[id];
    if (!row.enabled || row.state !== 'connected') return null;
    return ALLOWLIST[id] || null;
  }

  // ---- view (what the renderer paints) ------------------------------------------
  /**
   * The closed projection for the renderer, in registry order, with honest
   * counters and the loud fake flag («datos de ejemplo»). Null for anything
   * that is not a well-formed store plus a finite timestamp.
   */
  function view(store, now) {
    if (!isStore(store) || !Number.isFinite(now)) return null;
    let enabledCount = 0;
    let connectedCount = 0;
    const rows = SERVICES.map(s => {
      const r = store.services[s.id];
      const hasTarget = !!ALLOWLIST[s.id];
      if (r.enabled) enabledCount += 1;
      if (r.state === 'connected') connectedCount += 1;
      return Object.freeze({
        id: s.id, name: s.name, enabled: r.enabled, state: r.state,
        stateLabel: STATE_LABELS[r.state], refreshedAt: r.refreshedAt,
        hasTarget, canOpen: r.enabled && r.state === 'connected' && hasTarget,
      });
    });
    return Object.freeze({ fake: store.fake, rows, enabledCount, connectedCount });
  }

  // ---- fake provider (WU2) + renderer + mount follow at the tail ----

  return {
    SCHEMA, MAX_SERVICES, SERVICES, STATES, ALLOWLIST,
    serviceById, stateLabel, createStore, storeFromFrame, isStore,
    setEnabled, refresh, togglePause, openTarget, view,
  };
});
