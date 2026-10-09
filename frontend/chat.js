'use strict';
/* U1 — the chat surface inside the island (same window, same surface).
   - Talks to Rust ONLY through `chat_action` with the closed command set
     (view/open/back/check/submit/cancel). It never names an endpoint, a
     model, a key or an approval: Rust owns the local target.
   - Renders plain text only (textContent), never HTML; links are not links.
   - Focus moves to the composer only on a deliberate typing intent (the
     human clicks it, or opens the chat from the keyboard). Escape first
     leaves the composer, a second Escape collapses the island; the draft is
     never discarded and lives in page memory only (never storage/disk).
   - Polite live region: one announcement per state change / finished
     answer, never per token. Total silence: no sound anywhere.
   - Motion is island.js's (contract spring/curve, reduced-motion snaps). */
(() => {
  const V = window.AbitoChatView;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const chat = $('chat');
  const openButton = $('open-chat');
  const backButton = $('chat-back');
  const log = $('chat-log');
  const input = $('chat-input');
  const send = $('chat-send');
  const cancel = $('chat-cancel');
  const form = $('chat-composer');
  const status = $('chat-status');
  const targetEl = $('chat-target');
  const problem = $('chat-problem');
  const live = $('chat-live');
  const newer = $('chat-new');
  const stateChip = $('chat-state');
  const draftWord = $('chat-draft-word');
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  for (const el of chat.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
  if (!V || !chat || !input) return;

  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('chat_action', { payload }) : Promise.reject(new Error('no ipc')));

  let view = null;
  let inFlight = false;
  let pendingId = null; // reused if the same draft is re-sent after an IPC failure
  let localProblem = '';

  function setLive(text) {
    if (!text) return;
    live.textContent = '';
    // a new node per message so screen readers announce repeats too
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function renderTarget() {
    const t = view && view.target;
    targetEl.textContent = V.targetAria(t);
    $('chat-target-chip').setAttribute('aria-label', V.targetAria(t));
  }

  function renderLog() {
    const pinned = V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight);
    const before = log.scrollHeight;
    log.textContent = '';
    const turns = (view && Array.isArray(view.turns)) ? view.turns : [];
    if (!turns.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      // §2.3: lock «local» + eye-off, centred; the whole sentence is aria.
      li.setAttribute('role', 'img');
      li.setAttribute('aria-label', 'Escribile a Abito. Responde el modelo local de esta máquina; no ve tu pantalla ni ejecuta nada.');
      li.innerHTML = `<span class="ico">${icon('lock')}</span><span class="ico">${icon('eye-off')}</span>`;
      log.appendChild(li);
    }
    for (const turn of turns) {
      for (const row of V.turnRows(turn)) {
        const li = document.createElement('li');
        li.className = row.kind;
        if (row.short) { // note/error: icon + ONE word; the full text is the accessible name
          li.setAttribute('aria-label', row.text);
          const i = document.createElement('span');
          i.className = 'ico'; i.innerHTML = icon(row.icon);
          const w = document.createElement('span');
          w.className = 'word'; w.textContent = row.kind === 'error' ? row.text : row.short;
          li.append(i, w);
          if (row.kind === 'error') li.dataset.tone = 'red';
        } else li.textContent = row.text;
        log.appendChild(li);
      }
    }
    if (pinned) {
      log.scrollTop = log.scrollHeight;
      newer.hidden = true;
    } else if (log.scrollHeight > before) {
      newer.hidden = false;
    }
  }

  function renderControls() {
    const active = V.activeTurn(view);
    cancel.hidden = !active;
    send.disabled = !V.canSend(view, input.value, inFlight);
    const draftIssue = input.value ? V.draftProblem(input.value) : null;
    problem.textContent = localProblem || draftIssue || '';
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    capsule.dataset.chatAvailability = availability;
    status.textContent = localProblem || V.statusLine(view);
    const sv = V.statusView(view);
    stateChip.dataset.tone = sv.tone;
    stateChip.dataset.kind = sv.kind;
    stateChip.setAttribute('aria-label', localProblem || sv.aria);
    $('chat-state-icon').innerHTML = sv.icon ? icon(sv.icon) : '<span class="dot ' + (sv.kind === 'ready' ? 'go' : '') + '"></span>';
    $('chat-state-word').textContent = sv.word;
    const dw = input.value ? V.draftWord(input.value) : '';
    draftWord.hidden = !dw;
    draftWord.textContent = dw;
    input.dataset.invalid = dw ? 'true' : 'false';
    // R6 pose from REAL lane state only (docs/r6-states-mapping.md): thinking,
    // streaming a reply, or the model down/blocked. Anything else = rest.
    const pose = V.poseFor(view);
    document.dispatchEvent(new CustomEvent('abito:pose', { detail: pose }));

  }

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    const said = V.announcement(view, next);
    view = next;
    renderTarget();
    renderLog();
    renderControls();
    if (capsule.dataset.view === 'chat') setLive(said);
  }

  // ---- open / back --------------------------------------------------------
  let openedByKeyboard = false;
  function openChat(byKeyboard) {
    openedByKeyboard = byKeyboard;
    action({ action: 'open' }).then(apply, () => {});
  }
  openButton.addEventListener('click', event => openChat(event.detail === 0));
  backButton.addEventListener('click', event => {
    const byKeyboard = event.detail === 0;
    action({ action: 'back' }).then(next => {
      apply(next);
      if (byKeyboard) openButton.focus(); // keep keyboard users oriented
    }, () => {});
  });
  document.addEventListener('island:view', event => {
    chat.hidden = event.detail !== 'chat';
    if (event.detail === 'chat') {
      renderLog();
      renderControls();
      if (openedByKeyboard) input.focus(); // deliberate keyboard intent to type
      setLive('Conversación abierta. ' + V.statusLine(view));
    }
    openedByKeyboard = false;
  });

  // ---- composer ---------------------------------------------------------------
  input.addEventListener('input', () => { localProblem = ''; renderControls(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return; // IME owns the key
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!V.canSend(view, input.value, inFlight)) { renderControls(); return; }
    const text = input.value;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    pendingId = pendingId || V.newRequestId(bytes);
    inFlight = true;
    localProblem = '';
    renderControls();
    action({ action: 'submit', text, client_request_id: pendingId }).then(
      () => {
        inFlight = false;
        pendingId = null;
        if (input.value === text) input.value = ''; // accepted: the draft became a turn
        renderControls();
        action({ action: 'view' }).then(apply, () => {});
      },
      error => {
        inFlight = false;
        // typed refusal: keep the draft, say why; a new draft gets a new id
        pendingId = null;
        localProblem = (error && error.message) || 'No se pudo enviar.';
        renderControls();
        setLive(localProblem);
      });
  });
  cancel.addEventListener('click', () => {
    const active = V.activeTurn(view);
    if (!active) return;
    action({ action: 'cancel', turn_id: active.turn_id }).then(
      () => action({ action: 'view' }).then(apply, () => {}), () => {});
  });
  newer.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    newer.hidden = true;
  });
  log.addEventListener('scroll', () => {
    if (V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight)) newer.hidden = true;
  });

  // ---- keyboard: Enter opens from the overview, Escape steps out -----------
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    const expanded = capsule.dataset.phase === 'expanded';
    const inChat = capsule.dataset.view === 'chat';
    const typing = document.activeElement === input;
    if (event.key === 'Escape') {
      if (typing) { input.blur(); log.focus(); event.preventDefault(); return; } // leave typing mode
      if (expanded && window.desktop) { event.preventDefault(); window.desktop.close().catch(() => {}); }
      return;
    }
    if (event.key === 'Enter' && expanded && !inChat) {
      const focused = document.activeElement;
      // Enter on another control (allow/deny/dismiss) keeps its own meaning.
      if (focused && focused !== document.body && focused !== openButton) return;
      event.preventDefault();
      openChat(true);
    }
  });

  // Q1: the deliberate "Open Abito chat and type" activation (second launch
  // with --chat) ends here: Rust already opened the chat and focused the
  // window; put the caret in the composer.
  window.__islandFocusComposer = () => {
    openedByKeyboard = false;
    requestAnimationFrame(() => input.focus());
  };

  // ---- state stream -------------------------------------------------------------
  if (listen) {
    listen('chat:state', event => apply(event && event.payload)).catch(() => {});
  }
  action({ action: 'view' }).then(apply, () => {});
})();
