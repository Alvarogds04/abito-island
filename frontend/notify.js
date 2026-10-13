'use strict';
/* N6 — the notification surface (Pi question with 1..N reply options).
   - Talks to Rust ONLY through `question_action` with the closed set
     view / answer{id,index} / text{id,text} / decline{id} / budget{id,text}.
     It never names a route, a wire token, a scope or a session, and sends no
     label back: the host maps the index to the emitted option.
   - Only a TRUSTED human gesture (event.isTrusted === true) on this view's own
     controls or the digits 1..N answers. No timer, rule or model output ever
     does. Escape only leaves the free-text field; it never declines.
   - Plain text only (textContent). Nothing is persisted in the page.
   - SILENCE: no audio exists. Sound cues are pure ids (N.soundFor) and stay
     unplayed until the human enables sound in a future setting.
   - #266: a NEW question is a reveal event dispatched through `abito:question`
     (the gate is the pure N.createRevealGate); a boot replay of the same
     pending is history and never reveals. Revealing opens the island — it is
     never an answer and never touches the trusted-input rules above. */
(() => {
  const N = window.AbitoNotify;
  const ICONS = window.AbitoIcons;
  const $ = id => document.getElementById(id);
  const root = $('question');
  const capsule = $('capsule');
  if (!N || !root || !ICONS) return;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('question_action', { payload }) : Promise.reject(new Error('no ipc')));
  const icon = name => ICONS.svg(name);
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

  const body = $('question-body');
  const optionsEl = $('question-options');
  const freeform = $('question-freeform');
  const textEl = $('question-text');
  const wordEl = $('question-word');
  const sendEl = $('question-send');
  const skipEl = $('question-skip');
  const live = $('question-live');
  const expiryEl = $('question-expiry');
  const stateEl = $('question-state');
  const askerEl = $('question-asker');

  let snapshot = null;
  let previous = null;
  let inFlight = false;
  let budget = null;
  let budgetSeq = 0;
  let renderedId = null;
  const limiter = N.createCueLimiter();
  const revealGate = N.createRevealGate ? N.createRevealGate() : null;

  const say = text => { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } };
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };

  // D1 (human ruling): a finished question outcome is a CONFIRMATION, not a state. It shows for
  // OUTCOME_MS (3 s; 4 s for the problem outcomes the host marks persistent) and then the island
  // returns to its previous view by itself. The host keeps `notice` in its snapshot; only a NEW
  // outcome (a question that was pending is gone, or the notice word changed) restarts the clock.
  const OUTCOME_MS = 3000, OUTCOME_PROBLEM_MS = 4000;
  let outcomeKey = null, outcomeUntil = 0, outcomeTimer = 0;
  function trackOutcome(prev, next) {
    const view = N.phase(next, { inFlight: false, now: Date.now() });
    if (view.kind !== 'outcome') { outcomeKey = null; outcomeUntil = 0; return; }
    const word = view.outcome.outcome;
    const before = prev ? N.fromPending(prev.pending) : null;
    const fresh = !!before || (prev && prev.notice !== next.notice) || (outcomeKey !== null && outcomeKey !== word);
    if (fresh) {
      outcomeKey = word;
      outcomeUntil = Date.now() + (view.outcome.persistent ? OUTCOME_PROBLEM_MS : OUTCOME_MS);
      clearTimeout(outcomeTimer);
      outcomeTimer = setTimeout(() => render(), outcomeUntil - Date.now() + 30);
    } else if (outcomeKey === null) { outcomeKey = word; outcomeUntil = 0; } // boot replay: history, never shown
  }
  function current() {
    const view = N.phase(snapshot, { inFlight, now: Date.now() });
    if (view.kind === 'outcome' && Date.now() >= outcomeUntil) return { kind: 'none', controlsEnabled: false };
    return view;
  }
  // Every answering path (click, key, text, skip) requires the notification to be
  // visible: expanded + overview + no covering card. Hidden never answers.
  const onScreen = () => N.onScreen({ phase: capsule.dataset.phase, view: capsule.dataset.view, card: capsule.dataset.card });

  function renderOptions(n, enabled) {
    optionsEl.textContent = '';
    for (const o of n.options) {
      const b = el('button', 'q-option');
      b.type = 'button';
      b.dataset.index = String(o.index);
      b.disabled = !enabled;
      b.append(el('span', 'q-key', o.key), el('span', 'q-label', o.label));
      if (o.description) b.append(el('span', 'q-desc', o.description));
      b.setAttribute('aria-label', o.description ? `${o.label}. ${o.description}` : o.label);
      b.setAttribute('aria-keyshortcuts', o.key);
      b.title = o.label; // the full label stays reachable when a narrow row cuts it
      b.addEventListener('click', event => choose(event, o.index));
      optionsEl.append(b);
    }
  }

  function render() {
    const view = current();
    const n = view.notification || null;
    const showing = !!n && onScreen();
    const outcome = view.outcome || null;
    root.inert = !(showing || (outcome && capsule.dataset.view === 'overview'));
    capsule.dataset.question = n ? (view.kind === 'expired' ? 'expired' : 'pending') : (outcome ? 'outcome' : '');
    if (n) {
      if (renderedId !== n.id) { renderedId = n.id; textEl.value = ''; budget = null; renderOptions(n, view.controlsEnabled); say(`${N.askedBy(n)}: ${n.text}`); }
      body.textContent = n.text;
      // #266 S2: the visible asker, slug-derived via textContent only; display-only,
      // so a page without the chip must still answer (same guard style as island.js).
      if (askerEl) askerEl.textContent = N.askedBy(n);
      body.title = n.text; // the full text stays reachable when the view cuts it to two lines
      for (const b of optionsEl.querySelectorAll('button')) b.disabled = !view.controlsEnabled;
      freeform.hidden = !n.allowFreeText;
      skipEl.disabled = !view.controlsEnabled;
      expiryEl.hidden = false;
      $('question-expiry-word').textContent = N.expiryWord(n.expiresAt, Date.now());
      expiryEl.setAttribute('aria-label', `Vence en ${N.expiryWord(n.expiresAt, Date.now())}`);
      expiryEl.dataset.tone = view.kind === 'expired' ? 'faint' : 'sun';
    } else {
      renderedId = null; body.textContent = ''; if (askerEl) askerEl.textContent = ''; optionsEl.textContent = ''; freeform.hidden = true; expiryEl.hidden = true; skipEl.disabled = true;
    }
    skipEl.hidden = !n; // no pending notification: nothing to skip (outcome states show only icon + word)
    paintState(view);
    paintText(view);
  }

  function paintState(view) {
    const o = view.outcome || null;
    stateEl.hidden = !o;
    if (!o) return;
    stateEl.dataset.tone = o.tone;
    stateEl.dataset.kind = o.outcome === 'sent' ? 'sent' : '';
    stateEl.setAttribute('aria-label', o.aria);
    $('question-state-icon').innerHTML = icon(o.icon);
    $('question-state-word').textContent = o.word;
  }

  function paintText(view) {
    const text = textEl.value;
    const word = N.textWord(budget, text);
    wordEl.hidden = !word; wordEl.textContent = word;
    textEl.dataset.invalid = word ? 'true' : 'false';
    sendEl.disabled = !(view.controlsEnabled && N.canSendText(budget, text));
  }

  // ---- answering: trusted gestures only -------------------------------------
  function finish(next) {
    inFlight = false;
    if (next && typeof next === 'object') apply(next); else render();
  }
  function choose(event, index) {
    if (!N.trusted(event)) return;
    if (!onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled) return;
    inFlight = true; render();
    action({ action: 'answer', id: view.notification.id, index }).then(finish, error => { finish(null); say((error && error.message) || 'No se pudo enviar.'); });
  }
  function decline(event) {
    if (!N.trusted(event)) return;
    if (!onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled) return;
    inFlight = true; render();
    action({ action: 'decline', id: view.notification.id }).then(finish, error => { finish(null); say((error && error.message) || 'No se pudo omitir.'); });
  }
  function submitText(event) {
    event.preventDefault();
    if (!N.trusted(event) || !onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled || !N.canSendText(budget, textEl.value)) return;
    const text = textEl.value;
    inFlight = true; render();
    action({ action: 'text', id: view.notification.id, text }).then(next => { textEl.value = ''; budget = null; finish(next); },
      error => { finish(null); say((error && error.message) || 'No se pudo enviar.'); });
  }
  skipEl.addEventListener('click', decline);
  freeform.addEventListener('submit', submitText);
  textEl.addEventListener('input', () => {
    const view = current();
    if (!view.notification) return;
    const seq = ++budgetSeq;
    const value = textEl.value;
    if (!value) { budget = null; paintText(view); return; }
    action({ action: 'budget', id: view.notification.id, text: value }).then(b => { if (seq === budgetSeq) { budget = b; paintText(current()); } },
      () => { if (seq === budgetSeq) { budget = null; paintText(current()); } });
    paintText(view);
  });
  textEl.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); textEl.blur(); return; } // leaves the field, never declines
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!sendEl.disabled) freeform.requestSubmit(); }
  });
  // Digits 1..N pick an option (never while typing, never with modifiers).
  document.addEventListener('keydown', event => {
    const view = current();
    if (!view.notification || !view.controlsEnabled || root.inert || !onScreen()) return;
    const index = N.optionForKey(view.notification, event, { typing: document.activeElement === textEl || /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '') });
    if (index >= 0) { event.preventDefault(); choose(event, index); }
  });

  // ---- state stream ------------------------------------------------------------------
  function apply(next) {
    if (!next || typeof next !== 'object') return;
    previous = snapshot; snapshot = next;
    trackOutcome(previous, next);
    // Cue ids go to the sound engine through the page event (see sound-wiring.js).
    const cue = N.soundFor(previous, snapshot);
    // #313: the gate is the sound ENGINE (off until the human enables it, silent until ready), not a constant
    if (cue && limiter.allow(cue, Date.now())) document.dispatchEvent(new CustomEvent('abito:cue', { detail: cue }));
    render();
    // a pending question is also a compact signal (sun dot): island.js reads capsule.dataset.question
    // #266: a genuinely NEW live question additionally asks the island to reveal itself;
    // the pure gate says which snapshots are events (boot replays and churn are not).
    const reveal = revealGate ? revealGate.question(snapshot, Date.now()) : false;
    document.dispatchEvent(new CustomEvent('abito:question', { detail: { pending: !!(N.fromPending(snapshot.pending)), show: !!capsule.dataset.question, reveal } }));
  }
  document.addEventListener('island:view', render);
  new MutationObserver(render).observe(capsule, { attributes: true, attributeFilter: ['data-card', 'data-view', 'data-phase'] });
  if (listen) listen('question:state', event => apply(event && event.payload)).catch(() => {});
  action({ action: 'view' }).then(apply, () => {});
  setInterval(() => { if (snapshot) render(); }, 5000); // the expiry word and the local-clock «Vencida»
})();
