'use strict';
/* F019 — open-file-from-diff, view side. PURE: it decides WHEN an open
   request may leave the page and WHAT it may contain; it never opens
   anything, never calls IPC and never guesses a transport (no __TAURI__,
   no fetch). The actual opening is a HOST VERB that does not exist yet:
   per the mount contract (frontend/views-f017-f019.md), a Rust command with
   its own validation is required before this can be wired, and the wire
   payload carries exactly { path } — only a workspace-relative path the diff
   card itself displayed. Request gates mirror the island conventions
   (docs/pi-question-roundtrip.md §2.5, frontend/notify-view.js): a real
   (isTrusted), on-screen, non-typing, modifier-free event. Loaded as a
   classic script (window.AbitoFileOpen) and by
   test-node/file-open-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoFileOpen = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // Bounded memory of paths the diff card actually displayed: the closure is
  // "what is on screen was shown by this card", never "any string".
  const DISPLAYED_MAX = 8;
  const CONTROL = /[\0-\x1f\x7f]/;

  // ONLY clean workspace-relative paths: no absolute form (POSIX, drive,
  // UNC), no `..`/`.` segments, no empty segments, no control characters, no
  // untrimmed whitespace, no home shorthand. Both separators are accepted —
  // tool input may arrive Windows-style — and the Rust verb revalidates.
  function isWorkspaceRelative(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
    if (path !== path.trim()) return false;
    if (CONTROL.test(path)) return false;
    if (path.startsWith('/') || path.startsWith('\\') || path.startsWith('~')) return false;
    if (/^[a-zA-Z]:/.test(path)) return false;
    const segments = path.split(/[\\/]/);
    return segments.length > 0 && segments.every(s => s.length > 0 && s !== '.' && s !== '..');
  }

  // ---- the gate ------------------------------------------------------------------------
  // display(diff): remember the path of a diff the card actually rendered.
  // request(path, ctx): the only way a path may leave the page.
  function createOpenGate() {
    const displayed = []; // insertion-ordered, bounded
    return {
      display(diff) {
        const d = diff && typeof diff === 'object' ? diff : null;
        const p = d ? d.path : null;
        if (!isWorkspaceRelative(p)) return false; // an absolute path is never remembered
        if (!displayed.includes(p)) {
          displayed.push(p);
          while (displayed.length > DISPLAYED_MAX) displayed.shift();
        }
        return true;
      },
      request(path, ctx) {
        if (!isWorkspaceRelative(path) || !displayed.includes(path)) return null;
        const c = ctx || {};
        const ev = c.event;
        if (!ev || ev.isTrusted !== true) return null;
        if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing || ev.repeat) return null;
        if (c.typing === true) return null;
        // Same on-screen contract as the notification lane: expanded island,
        // overview view, no approval card covering the content.
        const s = c.screen || {};
        if (s.phase !== 'expanded' || s.view !== 'overview' || s.card) return null;
        return { verb: 'open_file', path };
      },
    };
  }

  return { isWorkspaceRelative, createOpenGate, DISPLAYED_MAX };
});
