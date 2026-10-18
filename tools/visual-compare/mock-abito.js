// Abito side: the real frontend over the mocked host. The host snapshots below follow the
// shapes island.js / notify-view.js / spotify-view.js / sessions-ticker.js validate.
(() => {
  const fix = window.__VC_FIX;
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const st = {
    snapshot: { state: 'compact', revision: 1, connections: 1, notices: [], card: null, request: null, motionOverride: true, available: true },
    question: { available: true, pending: null, notice: null, revision: 1 },
    sessions: { type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [] },
    prefs: { mainPill: 'integration_claude', declaredPills: [] },
    spotify: { running: true, track: null, playing: false },
  };
  window.__vcAbito = st;
  window.__VC_INVOKE = (cmd, args) => {
    const p = args.payload || {};
    switch (cmd) {
      case 'desktop_action': return st.snapshot;
      case 'question_action': return st.question;
      case 'prefs_action': return st.prefs;
      case 'hotkey_action': return { enabled: true, combo: 'Ctrl+Alt+A', status: 'active', default: 'Ctrl+Alt+A' };
      case 'spotify_action': return { ok: true, state: st.spotify };
      case 'agent_action': return p.action === 'sessions_list' ? st.sessions : { connection: 'connected', accounts: [], providers: [] };
      case 'chat_action': return { turns: [], active_turn: null };
      case 'models_action': return { available: false, models: [] };
      case 'record_frontend_evidence': case 'drag_press': case 'drag_move': case 'drag_release': return null;
      default: return undefined;
    }
  };
  // Applies a scenario: replaces the pieces and pushes them as the host would.
  window.__vcAbitoSet = (scn) => {
    const { snapshot, ...rest } = scn;
    Object.assign(st, rest);
    st.snapshot = { ...st.snapshot, revision: st.snapshot.revision + 1, ...(snapshot || {}) };
    window.__vcEmit('desktop:state', st.snapshot);
    window.__vcEmit('question:state', st.question);
    window.__vcEmit('prefs:state', st.prefs);
    if (st.spotify) window.__vcEmit('spotify:state', st.spotify);
  };
  window.__vcAbitoUuid = uuid;
  // The tauri global the frontend prefers (withGlobalTauri).
  const I = window.__TAURI_INTERNALS__;
  window.__TAURI__ = {
    core: { invoke: I.invoke },
    event: { listen: async (event, cb) => {
      const id = I.transformCallback(cb);
      await I.invoke('plugin:event|listen', { event, handler: id });
      return () => {};
    } },
  };
})();
