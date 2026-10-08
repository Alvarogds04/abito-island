'use strict';
/* window.desktop — the M1b host facade over Tauri invoke/events.
   Same verbs, same promise results, same snapshot shapes as the Electron
   preload (preload.cjs): no raw IPC objects, no channel selection, no
   arbitrary arguments — `choose` carries an integer index and nothing else.
   Every call goes through the single `desktop_action` command, which
   re-validates sender, payload shape and rate on the Rust side.
   Rejections are typed objects { code, message }:
   - `denied`        — Electron's `Denied` (with the reason attached),
   - `rate-exceeded` — Electron's `Rate exceeded`,
   - `not-yet-wired` — verb whose M3 backing system does not exist yet
     (`dismiss` became wired with the M2 notice transport). */
(() => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;

  if (!window.desktop && invoke) {
    const action = name => invoke('desktop_action', { payload: { action: name } });
    window.desktop = Object.freeze({
      snapshot: () => action('snapshot'),
      expand: () => action('expand'),
      close: () => action('close'),
      hide: () => action('hide'),
      quit: () => action('quit'),
      dismiss: () => action('dismiss'),
      allow: () => action('allow'),
      deny: () => action('deny'),
      // The renderer sends an INDEX, never the chosen text: it is the most
      // exposed part of the app; main decides what the third one is.
      choose: index => invoke('desktop_action', { payload: { action: 'choose', index } }),
      // Motion override: two fixed zero-argument verbs, never a
      // setMotionOverride(bool). Each answers with the fresh snapshot.
      animateAnyway: () => action('animateAnyway'),
      respectSystemMotion: () => action('respectSystemMotion'),
      onState(callback) {
        if (typeof callback !== 'function') throw new TypeError('Callback required');
        if (!listen) return () => {};
        let dead = false;
        let unlisten = null;
        const handler = event => {
          if (!dead && event && event.payload !== undefined) callback(event.payload);
        };
        listen('desktop:state', handler).then(
          fn => { if (dead) fn(); else unlisten = fn; },
          () => { /* no listener: snapshot() remains the pull path */ }
        );
        return () => {
          dead = true;
          if (unlisten) { unlisten(); unlisten = null; }
        };
      },
    });
  }
})();
