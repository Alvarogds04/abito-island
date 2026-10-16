'use strict';
/* #336 policy/scheduler only. This module never owns native phase, geometry,
   click-vs-drag classification, focus, persistence or approval admission.
   T1b must supply current host/UI facts and atomically guarded host callbacks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoIslandInteraction = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const DEFAULTS = Object.freeze({ autoCloseSeconds: 15, openOnHover: false });
  const HOVER_DELAY_MS = 600;
  const BLOCKERS = Object.freeze(['question', 'approval', 'request', 'decision', 'card',
    'dragging', 'editing', 'composing', 'draft', 'settings', 'models']);

  function validPreferences(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'autoCloseSeconds,openOnHover' &&
      Number.isInteger(value.autoCloseSeconds) && value.autoCloseSeconds >= 5 && value.autoCloseSeconds <= 120 &&
      typeof value.openOnHover === 'boolean';
  }

  // Missing guard facts are not permission. This is only a local policy check;
  // the host MUST recheck live protected state atomically when applying a plan.
  function clearGuards(facts) {
    return !!facts && facts.view === 'overview' && facts.settled === true && facts.nativeReady === true &&
      BLOCKERS.every(key => facts[key] === false);
  }
  function eligible(facts) { return clearGuards(facts) && facts.state === 'expanded'; }

  function createClock(read) {
    if (typeof read !== 'function') throw new TypeError('Clock required.');
    let last = 0;
    return () => {
      const raw = read();
      // Leave enough exact integer range for the largest relative deadline.
      if (Number.isFinite(raw)) last = Math.max(last, Math.min(raw, Number.MAX_SAFE_INTEGER - 120000));
      return last;
    };
  }

  function countdown(deadline, now, seconds) {
    if (!Number.isFinite(deadline) || !Number.isFinite(now) || !validPreferences({ autoCloseSeconds: seconds, openOnHover: false })) return null;
    const remainingMs = Math.max(0, Math.min(120000, deadline - now));
    const windowMs = Math.min(10000, seconds * 600);
    return { remainingMs, seconds: Math.ceil(remainingMs / 1000),
      fraction: Math.min(1, remainingMs / windowMs), visible: remainingMs > 0 && remainingMs <= windowMs };
  }

  // #419: pure decoration renderer for the published countdown values. The
  // module still owns no DOM, listeners or rendering lifecycle: the adapter
  // creates the view with its approved element and feeds it from onCountdown.
  // update(null) and any value without a visible:true finite fraction hide
  // the element; a visible value shows it and writes the clamped fraction as
  // a CSS custom property (style.setProperty, CSP-safe). It never throws on
  // values and never reads native/window state.
  function createCountdownView(element) {
    if (!element || typeof element !== 'object' || !element.style ||
      typeof element.style.setProperty !== 'function')
      throw new TypeError('Countdown view element required.');
    function update(value) {
      if (!value || typeof value !== 'object' || value.visible !== true ||
        !Number.isFinite(value.fraction)) { element.hidden = true; return; }
      element.hidden = false;
      element.style.setProperty('--island-countdown-fraction',
        String(Math.min(1, Math.max(0, value.fraction))));
    }
    return Object.freeze({ update });
  }

  function mouse(event) {
    return !!event && event.isTrusted === true && event.pointerType === 'mouse' && event.buttons === 0;
  }
  function deliberate(event) {
    if (!event || event.isTrusted !== true) return false;
    if (event.type === 'click') return event.button === 0;
    return event.type === 'keydown' && typeof event.key === 'string' && event.key.length > 0 &&
      !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Unidentified', 'Process', 'Dead'].includes(event.key) &&
      event.repeat !== true && event.isComposing !== true && event.keyCode !== 229;
  }

  function createController(options) {
    for (const key of ['now', 'schedule', 'cancel', 'open', 'autoClose', 'onCountdown']) {
      if (!options || typeof options[key] !== 'function') throw new TypeError(`Interaction callback required: ${key}.`);
    }
    const now = createClock(options.now);
    let preferences = DEFAULTS, facts = {}, inside = false, hoverOnly = false;
    let timer = null, deadline = null, stopped = false, opening = false, closing = false;
    let exhausted = false, generation = 0, timerGeneration = 0, published = 'null';

    function emit(value) {
      const key = JSON.stringify(value);
      if (key !== published) { published = key; options.onCountdown(value); }
    }
    function cancelTimer() {
      timerGeneration++;
      if (timer !== null) options.cancel(timer);
      timer = null;
    }
    function clearDeadline() { cancelTimer(); deadline = null; emit(null); }
    function invalidate() { generation++; opening = false; closing = false; }

    // Promise settlement conveys no phase/focus/approval evidence. Only update()
    // can supply authoritative state; generation prevents late resurrection.
    function request(kind) {
      const epoch = generation;
      if (kind === 'open') opening = true; else closing = true;
      function settled(ok) {
        if (stopped || epoch !== generation) return;
        if (kind === 'open') {
          opening = false;
          if (!ok) { hoverOnly = false; exhausted = true; }
          reconcile();
        } else closing = false; // never retry a rejected/spent close on churn
      }
      try { Promise.resolve(options[kind]()).then(() => settled(true), () => settled(false)); }
      catch { settled(false); }
    }

    function reconcile(restart = false) {
      if (stopped) return;
      if (restart) { cancelTimer(); deadline = null; }
      if (!eligible(facts) || inside || opening || closing || exhausted) { clearDeadline(); return; }
      const time = now();
      if (deadline === null) deadline = time + (hoverOnly ? HOVER_DELAY_MS : preferences.autoCloseSeconds * 1000);
      const value = countdown(deadline, time, preferences.autoCloseSeconds);
      const epoch = generation, due = deadline;
      if (value.remainingMs <= 0) {
        exhausted = true; clearDeadline();
        if (!stopped && epoch === generation && deadline === null && eligible(facts) && !inside && !opening && !closing)
          request('autoClose');
        return;
      }
      emit(value);
      // Publication may synchronously close/stop, change guards or re-arm.
      if (stopped || epoch !== generation || due !== deadline || !eligible(facts) ||
        inside || opening || closing || exhausted || timer !== null) return;
      const windowMs = Math.min(10000, preferences.autoCloseSeconds * 600);
      // Sleep until the final countdown window, then integer-second changes.
      // Relative bounded delays avoid epoch/future-date timeout overflow.
      const delay = value.remainingMs > windowMs ? value.remainingMs - windowMs :
        Math.min(value.remainingMs, value.remainingMs % 1000 || 1000);
      const serial = ++timerGeneration;
      timer = options.schedule(() => {
        if (stopped || serial !== timerGeneration) return;
        timer = null; reconcile();
      }, Math.max(1, Math.min(120000, delay)));
    }

    function update(next) {
      if (stopped) return;
      const before = eligible(facts), previousState = facts.state;
      facts = next && typeof next === 'object' ? { ...next } : {};
      if ((previousState === 'expanded' && facts.state !== 'expanded') || facts.state === 'hidden') {
        hoverOnly = false; invalidate(); clearDeadline();
      }
      if (!before && eligible(facts)) exhausted = false;
      reconcile();
    }
    function setPreferences(next) {
      if (stopped) return;
      if (!validPreferences(next)) throw new TypeError('Invalid island interaction preferences.');
      const changedDelay = preferences.autoCloseSeconds !== next.autoCloseSeconds;
      preferences = Object.freeze({ ...next });
      reconcile(changedDelay && deadline !== null && !hoverOnly);
    }
    function enter(event) {
      if (stopped || !mouse(event) || inside) return false;
      inside = true; exhausted = false; clearDeadline();
      if (!preferences.openOnHover || facts.state !== 'compact' || !clearGuards(facts) || opening) return false;
      hoverOnly = true; request('open'); return true;
    }
    function leave(event) {
      if (stopped || !mouse(event) || !inside) return false;
      inside = false; exhausted = false; reconcile(); return true;
    }
    function engage(event) {
      if (stopped || !deliberate(event) || facts.state !== 'expanded') return false;
      const consumedHover = hoverOnly;
      hoverOnly = false; exhausted = false; reconcile(true);
      // Native adapter uses this intent, but still classifies real short-click
      // versus drag itself. This return value is NOT permission to cancel drag.
      return consumedHover;
    }
    function reset() {
      if (stopped) return;
      invalidate(); hoverOnly = false; exhausted = true; clearDeadline();
    }
    function stop() {
      if (stopped) return;
      stopped = true; invalidate(); hoverOnly = false; exhausted = true; clearDeadline();
    }
    function snapshot() {
      return { preferences: { ...preferences }, inside, hoverOnly, deadline, stopped, opening, closing,
        eligible: eligible(facts), countdown: deadline === null ? null : countdown(deadline, now(), preferences.autoCloseSeconds) };
    }
    return Object.freeze({ update, setPreferences, enter, leave, engage, reset, stop, snapshot });
  }
  return Object.freeze({ DEFAULTS, HOVER_DELAY_MS, BLOCKERS, validPreferences, eligible, createClock, countdown, createCountdownView, createController });
});
