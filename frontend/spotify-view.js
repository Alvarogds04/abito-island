'use strict';
/* #467 / #470 — the Spotify card of the island (provisional placement: the overview, below the Abito text).
   Layout and wording adapted from Coucou src/views/spotify.ts (SpotifyCardView), commit 434d6a2b,
   Copyright (c) 2026 Louis Raillé, MIT. Abito's own icons and copy; no artwork (the CSP admits img-src 'self'
   only, so a remote art URL is never requested) and no Spotify mark.

   Wire (src/spotifyhost.rs, island window ONLY — the host refuses the settings label):
     invoke('spotify_action', {payload:{action:'view'|'stop'|'play_pause'|'next'|'previous'}}) -> {ok, state}
     event 'spotify:state' -> PlayerState {running, track:{id,title,artist,album,duration,artUrl}|null, playing, ...}
   `view` when the card becomes visible, `stop` when it goes away (and on unload). Pure view-model first,
   textContent-only renderer, browser-only mount at the tail (house pattern, see integrations-view.js). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoSpotify = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PILL_ID = 'integration_spotify';
  const MAX_TEXT = 120;
  const CONTROLS = Object.freeze({ previous: 'Anterior', play_pause: 'Reproducir o pausar', next: 'Siguiente' });
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clean = (v, max = MAX_TEXT) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('') : '');

  // The card exists only for a Linux host whose prefs name the Spotify pill (main or declared).
  const wanted = (prefs, os) => os === 'linux' && isObject(prefs) &&
    (prefs.mainPill === PILL_ID || (Array.isArray(prefs.declaredPills) && prefs.declaredPills.includes(PILL_ID)));

  // PlayerState -> what the card says. Anything off-shape reads as «not open»: never a guess.
  function cardView(state) {
    if (!isObject(state) || state.running !== true) {
      return { kind: 'closed', title: 'Spotify no está abierto', artist: '', playing: false, controls: false, aria: 'Spotify no está abierto' };
    }
    const track = isObject(state.track) ? state.track : null;
    const title = track ? clean(track.title) : '';
    if (!title) {
      return { kind: 'idle', title: 'Nada en reproducción', artist: '', playing: false, controls: true, aria: 'Spotify: nada en reproducción' };
    }
    const artist = clean(track.artist);
    const playing = state.playing === true;
    return { kind: 'track', title, artist, playing, controls: true, aria: `Spotify: ${title}${artist ? ', ' + artist : ''}. ${playing ? 'Reproduciendo' : 'En pausa'}` };
  }

  const payload = action => (Object.prototype.hasOwnProperty.call(CONTROLS, action) ? { action } : null);

  // The lifecycle: `view` on show, `stop` on hide, nothing twice. `invoke` and `onState` are injected.
  function controller({ invoke, onState }) {
    let shown = false, generation = 0;
    const apply = r => { if (r && isObject(r) && 'state' in r) onState(r.state); };
    return {
      show() {
        if (shown) return Promise.resolve();
        shown = true; const mine = ++generation;
        return invoke('spotify_action', { payload: { action: 'view' } }).then(r => { if (mine === generation && shown) apply(r); }, () => { if (mine === generation) onState(null); });
      },
      hide() {
        if (!shown) return Promise.resolve();
        shown = false; generation += 1;
        return invoke('spotify_action', { payload: { action: 'stop' } }).then(() => {}, () => {});
      },
      control(action) {
        const body = payload(action);
        if (!body || !shown) return Promise.resolve();
        return invoke('spotify_action', { payload: body }).then(apply, () => {});
      },
      isShown: () => shown,
    };
  }

  return { PILL_ID, CONTROLS, wanted, cardView, payload, controller };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const host = doc.getElementById('spotify-card');
  const overview = doc.getElementById('overview-view');
  const capsule = doc.getElementById('capsule');
  const internals = root.__TAURI_INTERNALS__;
  // The settings window runs this same page and the host refuses it: stay inert there.
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (!host || !overview || !capsule || label === 'settings') return;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke) return;
  const os = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent || '') ? 'windows' : 'linux';
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const title = mk('strong', 'spotify-title'), artist = mk('span', 'spotify-artist');
  const text = mk('div', 'spotify-text'); text.append(title, artist);
  const buttons = {};
  const bar = mk('div', 'spotify-controls');
  for (const [action, name] of Object.entries(api.CONTROLS)) {
    const b = mk('button', 'spotify-btn'); b.type = 'button'; b.dataset.action = action; b.setAttribute('aria-label', name);
    b.textContent = action === 'previous' ? '⏮' : action === 'next' ? '⏭' : '⏯';
    b.addEventListener('click', e => { if (e.isTrusted === true) ctl.control(action); });
    buttons[action] = b; bar.append(b);
  }
  host.append(text, bar);
  const live = mk('span', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); host.append(live);
  let lastAria = '';
  function paint(state) {
    const v = api.cardView(state);
    title.textContent = v.title; artist.textContent = v.artist;
    host.dataset.kind = v.kind; host.dataset.playing = v.playing ? 'true' : 'false';
    host.setAttribute('aria-label', v.aria);
    for (const b of Object.values(buttons)) b.disabled = !v.controls;
    buttons.play_pause.textContent = v.playing ? '⏸' : '▶';
    if (v.aria !== lastAria) { lastAria = v.aria; live.textContent = v.aria; }
  }
  const ctl = api.controller({ invoke, onState: paint });
  let prefs = {};
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices' && !doc.hidden;
  };
  function sync() {
    const show = api.wanted(prefs, os) && onScreen();
    host.hidden = !api.wanted(prefs, os) || !show;
    if (show) { overview.dataset.spotify = 'on'; ctl.show(); } else { delete overview.dataset.spotify; ctl.hide(); }
  }
  host.hidden = true; paint(null);
  if (listen) {
    listen('spotify:state', e => { if (ctl.isShown()) paint(e && e.payload); }).catch(() => {});
    listen('prefs:state', e => { prefs = e && isPlain(e.payload) ? e.payload : {}; sync(); }).catch(() => {});
  }
  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  invoke('prefs_action', { payload: { action: 'view' } }).then(p => { prefs = isPlain(p) ? p : {}; sync(); }, () => {});
  doc.addEventListener('visibilitychange', sync);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
  }
  root.addEventListener('pagehide', () => { ctl.hide(); });
}
