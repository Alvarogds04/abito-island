'use strict';
/* #347 R7 presentation controller. State/finite recovery mechanics informed by
   Coucou windows/src/mochi/engine.ts and island/island.ts, Copyright 2026
   Louis Raillé, MIT. No reserved character designs, eye paths, assets or audio.
   Public producer inputs only; no approval/answer/geometry authority. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoCharacter = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SLEEP_MS = 60000, FINISHED_MS = 1800;
  function create(options) {
    const { clay, choosePose, validCard, notification } = options;
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const applyState = options.applyState || (next => { if (clay && clay.state !== next) clay.setState(next); });
    const blocked = options.blocked || (() => false);
    let snapshot = null, question = null, chat = null, host = null, occupied = false;
    let lastActivity = now(), finishedUntil = 0, timer = 0, destroyed = false;
    let baseline = false;
    const seen = new Set();
    const noticeKey = n => n && typeof n.id === 'string' && typeof n.sessionId === 'string' &&
      Number.isFinite(n.expiresAt) && n.expiresAt > now() ? JSON.stringify([n.sessionId, n.id]) : null;
    function attention() {
      const card = snapshot && snapshot.card;
      const expiry = card && Date.parse(card.expires_at);
      if (validCard(card) && card.state === 'pending' && expiry > now()) return { state: 'approval', expiry };
      const n = notification(question);
      if (n && (n.kind === 'approval' || n.kind === 'question') && n.expiresAt > now()) return { state: n.kind, expiry: n.expiresAt };
      return null;
    }
    function producer() { const pending = attention(); return pending ? pending.state : choosePose(chat, host); }
    function sync() {
      if (destroyed) return;
      clearTimer(timer); timer = 0;
      const at = now(), source = producer(), pending = attention();
      // Urgent/active facts cancel decorations, never defer them until later.
      if (source !== 'idle' || occupied || blocked()) { finishedUntil = 0; lastActivity = at; }
      let state = source;
      if (source === 'idle' && !occupied && !blocked()) {
        if (finishedUntil > at) state = 'finished';
        else if (at - lastActivity >= SLEEP_MS) state = 'sleeping';
      }
      applyState(state);
      let due = Infinity;
      if (pending) due = pending.expiry;
      if (finishedUntil > at) due = Math.min(due, finishedUntil);
      if (source === 'idle' && !occupied && !blocked() && state !== 'sleeping') due = Math.min(due, lastActivity + SLEEP_MS);
      // Browsers/Node coerce delays above signed int32 to 1 ms: cap, then recheck.
      if (Number.isFinite(due)) timer = setTimer(sync, Math.min(2147483647, Math.max(1, due - at)));
    }
    function observe(next) {
      snapshot = next || {};
      let fresh = false;
      for (const n of Array.isArray(snapshot.notices) ? snapshot.notices : []) {
        const key = noticeKey(n); if (!key) continue;
        if (baseline && !seen.has(key)) fresh = true;
        seen.add(key);
      }
      baseline = true;
      // Host store dedupes 256 identities; keep presentation memory bounded too.
      while (seen.size > 256) seen.delete(seen.values().next().value);
      if (fresh) {
        lastActivity = now();
        if (producer() === 'idle' && !occupied && !blocked()) finishedUntil = now() + FINISHED_MS;
      }
      sync();
    }
    return {
      snapshot: observe,
      question(next) { question = next; lastActivity = now(); sync(); },
      chat(next) { chat = next === 'think' || next === 'speak' || next === 'error' ? next : null; sync(); },
      host(next) { host = next === 'error' ? next : null; sync(); },
      busy(value) { occupied = !!value; lastActivity = now(); sync(); },
      activity() { lastActivity = now(); finishedUntil = 0; sync(); },
      motionChanged() { lastActivity = now(); finishedUntil = 0; sync(); },
      get state() { return clay ? clay.state : producer(); },
      destroy() { destroyed = true; clearTimer(timer); timer = 0; },
    };
  }
  return { create, SLEEP_MS, FINISHED_MS };
});
