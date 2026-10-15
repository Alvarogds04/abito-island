'use strict';
/* U1 — the chat surface inside the island (same window, same surface).
   - Talks to Rust through `chat_action` with the closed command set
     (view/open/back/check/submit/cancel) and, for the F024 model row, through
     two more CLOSED sets: `models_action` (list/select of the verified local
     registry — the same verbs Ajustes → Modelos uses) and `specialists_action`
     (view only, to name the role that fixes a model). It never names an
     endpoint, a key, an account, a provider or an approval: Rust owns the
     local target.
   - Message rows use the small F025 markdown DOM renderer (text nodes only).
     Safe web links use open_chat_url, which independently validates in Rust.
     Greeting, notifications and error/system text retain their plain handlers.
   - Focus moves to the composer only on a deliberate typing intent (the
     human clicks it, or opens the chat from the keyboard). Escape first
     leaves the composer, a second Escape collapses the island; the draft is
     never discarded and lives in page memory only (never storage/disk).
   - Polite live region: one announcement per state change / finished
     answer, never per token. Total silence: no sound anywhere.
   - Motion is island.js's (contract spring/curve, reduced-motion snaps). */
(() => {
  const V = window.AbitoChatView;
  const M = window.AbitoChatMarkdown;
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
  // F024: the model row above the composer (index.html `chat-model-row`).
  const modelBtn = $('chat-model-btn');
  const modelName = $('chat-model-name');
  const modelPicker = $('chat-model-picker');
  const modelNote = $('chat-model-note');
  const problem = $('chat-problem');
  const live = $('chat-live');
  const newer = $('chat-new');
  const stateChip = $('chat-state');
  const draftWord = $('chat-draft-word');
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // Parse only the closed, trusted icon registry, never message bytes.
  // Greeting and message content are constructed separately as text nodes.
  const svgParser = new DOMParser();
  function iconNode(name) {
    const doc = svgParser.parseFromString(icon(name), 'image/svg+xml');
    return doc.documentElement && doc.documentElement.nodeName === 'svg'
      ? document.importNode(doc.documentElement, true) : null;
  }
  for (const el of chat.querySelectorAll('[data-icon]')) {
    const node = iconNode(el.dataset.icon);
    el.replaceChildren(...(node ? [node] : []));
  }
  if (!V || !chat || !input) return;

  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));
  const action = payload => call('chat_action', payload);
  const modelsAction = payload => call('models_action', payload);
  const specialistsAction = payload => call('specialists_action', payload);

  let view = null;
  let inFlight = false;
  let pendingId = null; // reused if the same draft is re-sent after an IPC failure
  let localProblem = '';
  const createButton = $('chat-create');
  const conversationsButton = $('chat-conversations');
  const conversationsPanel = $('conversations');
  const conversationsList = $('conversations-list');
  let olderTurns = [];
  let historyBefore = null;
  let paging = false;
  let historyGeneration = 0;

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

  // ---- F024: the model row above the composer ---------------------------------
  // The row shows the EFFECTIVE target of the next turn (Rust already resolved
  // the active role into it) and opens a picker over the SAME closed
  // `models_action` set Ajustes → Modelos uses (R3): a click selects a
  // registered, selectable local profile and it applies from the NEXT message.
  // The page never learns or sends an endpoint, a key or a provider (S5).
  let specialistsView = null; // `specialists_action view` + `specialists:state`
  let modelListing = null;    // `models_action list` + `models:state`
  let modelBusy = false;      // one selection in flight
  let pickerOpen = false;

  function renderPicker() {
    if (!modelPicker || !modelNote) return;
    modelPicker.replaceChildren();
    // R4: ONE line, inside the picker, re-appended after every repaint (the
    // children were just cleared). The node itself lives in index.html.
    const note = V.modelRoleNote(view, V.activeRole(specialistsView));
    modelNote.textContent = note;
    modelNote.hidden = !note;
    if (note) modelPicker.append(modelNote);
    const enabled = V.modelButtonEnabled(view);
    for (const row of V.modelRows(modelListing)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-row';
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = row.title;
      const state = document.createElement('span');
      state.className = 'picker-state';
      state.textContent = row.state;
      b.append(name, state);
      b.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
      b.setAttribute('aria-label', `${row.selected ? 'Elegido. ' : 'Elegir. '}${row.aria}`);
      b.disabled = !row.selectable || row.selected || modelBusy || !enabled;
      if (row.selectable && !row.selected) b.addEventListener('click', () => selectModel(row.id, row.title));
      modelPicker.append(b);
    }
  }

  function renderModelRow() {
    if (!modelBtn || !modelName) return;
    const role = V.activeRole(specialistsView);
    modelName.textContent = V.modelButtonLabel(view, role); // R1: text, never markup
    modelBtn.setAttribute('aria-label', V.modelButtonAria(view, role)); // R4/R5
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    modelBtn.dataset.avail = view && view.target ? availability : 'unchecked';
    const enabled = V.modelButtonEnabled(view); // R2
    modelBtn.disabled = !enabled || modelBusy;
    if (!enabled && pickerOpen) {
      // A running turn freezes the target; a down/blocked chosen one refuses
      // like Send does. The row closes instead of offering a dead choice.
      pickerOpen = false;
      if (modelPicker) { modelPicker.hidden = true; modelPicker.inert = true; }
      modelBtn.setAttribute('aria-expanded', 'false');
      if (modelNote) { modelNote.textContent = ''; modelNote.hidden = true; }
      return;
    }
    if (!pickerOpen && modelNote) { modelNote.textContent = ''; modelNote.hidden = true; }
    if (pickerOpen) renderPicker();
  }

  function loadModelListing() {
    modelsAction({ action: 'list' }).then(next => {
      modelListing = next;
      if (pickerOpen) renderPicker();
    }, () => { /* the picker keeps the last listing it has, if any */ });
  }

  function setPicker(open) {
    pickerOpen = !!open && V.modelButtonEnabled(view);
    if (modelPicker) {
      modelPicker.hidden = !pickerOpen;
      modelPicker.inert = !pickerOpen;
    }
    modelBtn.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
    renderModelRow();
    if (pickerOpen) loadModelListing();
  }

  function selectModel(id, title) {
    if (modelBusy) return;
    modelBusy = true;
    renderModelRow();
    modelsAction({ action: 'select', profile_id: id }).then(() => {
      modelBusy = false;
      setPicker(false); // upstream parity: the picker closes on a choice
      renderModelRow(); // the republished chat:state carries the new target
      setLive(`${title} elegido. Se usa desde el próximo mensaje.`);
    }, error => {
      modelBusy = false;
      renderModelRow();
      setLive((error && error.message) || 'No se pudo elegir el modelo.');
    });
  }

  function applySpecialists(next) {
    if (!next || typeof next !== 'object') return;
    specialistsView = next;
    renderModelRow();
  }

  if (modelBtn) modelBtn.addEventListener('click', () => setPicker(!pickerOpen));

  // #310: the history is reconciled against what is drawn, never rebuilt. Measured before the fix: sending one
  // message removed 23 nodes to go from 2 to 4 rows and moved the first row twice (the flash).
  let drawn = [];            // the rows as last drawn, in order
  function paintRow(li, row) {
    li.className = row.kind;
    li.textContent = '';
    li.removeAttribute('aria-label'); delete li.dataset.tone;
    if (row.short) { // note/error: icon + ONE word; the full text is the accessible name
      li.setAttribute('aria-label', row.text);
      const i = document.createElement('span');
      i.className = 'ico';
      const node = iconNode(row.icon); if (node) i.append(node);
      const w = document.createElement('span');
      w.className = 'word'; w.textContent = row.kind === 'error' ? row.text : row.short;
      li.append(i, w);
      if (row.kind === 'error') li.dataset.tone = 'red';
    } else if (M && (row.kind === 'assistant' || row.kind === 'user')) {
      M.render(li, row.text, {
        openUrl: url => (invoke ? invoke('open_chat_url', { payload: { url } }) : Promise.reject(new Error('no ipc')))
          .catch(() => { setLive('No se pudo abrir el enlace.'); }),
        copyCode: text => {
          if (!navigator.clipboard || !navigator.clipboard.writeText) {
            setLive('No se pudo copiar el código.'); return Promise.reject(new Error('clipboard unavailable'));
          }
          return navigator.clipboard.writeText(text).then(() => { setLive('Código copiado.'); }, () => {
            setLive('No se pudo copiar el código.'); throw new Error('clipboard refused');
          });
        },
      });
    } else li.textContent = row.text;
  }
  function renderLog() {
    const pinned = V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight);
    const before = log.scrollHeight;
    const turns = V.mergeHistory(olderTurns, (view && Array.isArray(view.turns)) ? view.turns : []);
    const rows = [];
    for (const turn of turns) for (const row of V.turnRows(turn)) rows.push(row);
    const placeholder = log.querySelector('li.empty');
    const g = turns.length ? null : V.emptyGreeting(view);
    if (!turns.length) {
      // §2.3: lock «local» + eye-off, centred; the whole sentence is aria.
      // F027: an explicit display name adds «Hola, <nombre>.» as visible text. The
      // name arrives with a later state push, so the row is redrawn whenever the
      // sentence it must announce changed — never emptied while turns exist. The
      // name is text: textContent only, never into HTML.
      if (!placeholder || placeholder.getAttribute('aria-label') !== g.aria) {
        if (placeholder) placeholder.remove();
        log.textContent = '';
        const li = document.createElement('li');
        li.className = 'empty';
        li.setAttribute('role', 'img');
        li.setAttribute('aria-label', g.aria);
        const icons = document.createElement('span');
        icons.className = 'empty-icons';
        for (const name of g.icons) {
          const i = document.createElement('span');
          i.className = 'ico';
          const node = iconNode(name);
          if (node) i.append(node);
          icons.append(i);
        }
        li.append(icons);
        if (g.greeting) {
          const word = document.createElement('p');
          word.className = 'empty-greeting';
          word.textContent = g.greeting;
          li.append(word);
        }
        log.appendChild(li);
      }
      drawn = [];
    } else {
      if (placeholder) { placeholder.remove(); drawn = []; }
      const plan = V.reconcileRows(drawn, rows);
      const hadRows = drawn.length > 0;
      for (const { index, row } of plan.patch) paintRow(log.children[index], row);
      for (let k = 0; k < plan.remove; k += 1) log.lastElementChild.remove();
      for (const row of plan.append) {
        const li = document.createElement('li');
        paintRow(li, row);
        if (hadRows) li.classList.add('enter'); // only NEW rows animate
        log.appendChild(li);
      }
      drawn = rows;
    }
    if (!turns.length) {
      newer.hidden = true; // nothing left to scroll to (conversation reset)
    } else if (pinned) {
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
    const historyProblem = view && view.history_problem;
    problem.textContent = localProblem || historyProblem || draftIssue || '';
    if (createButton) createButton.disabled = active !== null || inFlight;
    if (conversationsButton) conversationsButton.disabled = active !== null || inFlight;
    if ($('chat-history-warning')) {
      const warning = historyProblem || (view && view.history_skipped ? `Se omitieron ${view.history_skipped} registros dañados.` : '');
      $('chat-history-warning').hidden = !warning;
      $('chat-history-warning').textContent = warning;
    }
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    capsule.dataset.chatAvailability = availability;
    status.textContent = localProblem || V.statusLine(view);
    const sv = V.statusView(view);
    stateChip.dataset.tone = sv.tone;
    stateChip.dataset.kind = sv.kind;
    stateChip.setAttribute('aria-label', localProblem || sv.aria);
    const stateIcon = sv.icon ? iconNode(sv.icon) : document.createElement('span');
    if (!sv.icon) stateIcon.className = `dot ${sv.kind === 'ready' ? 'go' : ''}`;
    $('chat-state-icon').replaceChildren(...(stateIcon ? [stateIcon] : []));
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

  function resetHistory(next) {
    olderTurns = []; historyBefore = next.history_before || null; historyGeneration += 1; paging = false;
    log.textContent = ''; drawn = [];
  }
  function apply(next) {
    if (!next || typeof next !== 'object') return;
    const changed = !view || view.conversation_id !== next.conversation_id;
    const said = changed ? null : V.announcement(view, next);
    if (changed) {
      resetHistory(next);
      if (view) { input.value = ''; pendingId = null; localProblem = ''; autosize(); }
    }
    view = next;
    renderTarget();
    renderLog();
    renderControls();
    renderModelRow();
    if (capsule.dataset.view === 'chat') setLive(said);
    // #313: turns and the model going down become cues by TRANSITION (history and the first snapshot are baselines)
    try { const w = window.AbitoSoundWiringInstance; if (w) w.observeChat(next); } catch { /* sound never breaks the chat */ }
  }

  // ---- #341: local conversations -----------------------------------------
  function closeConversations() {
    if (!conversationsPanel) return;
    conversationsPanel.hidden = true;
    conversationsPanel.inert = true;
    conversationsButton.setAttribute('aria-expanded', 'false');
    log.inert = false; form.inert = false;
  }
  function createConversation() {
    if (inFlight || V.activeTurn(view)) return;
    inFlight = true; renderControls();
    action({ action: 'new' }).then(next => {
      closeConversations(); apply(next); input.value = ''; pendingId = null; autosize(); input.focus();
    }, error => { localProblem = error.message || 'No se pudo crear la conversación.'; setLive(localProblem); })
      .finally(() => { inFlight = false; renderControls(); });
  }
  if (createButton) createButton.addEventListener('click', createConversation);
  if (conversationsButton) conversationsButton.addEventListener('click', () => {
    if (inFlight || V.activeTurn(view)) return;
    action({ action: 'list' }).then(listing => {
      conversationsList.replaceChildren();
      for (const row of V.conversationRows(listing)) {
        const li = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = row.text; button.setAttribute('aria-label', row.aria);
        button.setAttribute('aria-current', row.id === (view && view.conversation_id) ? 'true' : 'false');
        button.addEventListener('click', () => {
          if (inFlight) return;
          inFlight = true; renderControls();
          action({ action: 'restore', conversation_id: row.id }).then(next => {
            closeConversations(); resetHistory(next); input.value = ''; pendingId = null; localProblem = ''; autosize(); apply(next); log.focus();
          }, error => { $('conversations-note').textContent = error.message || 'No se pudo abrir la conversación.'; })
            .finally(() => { inFlight = false; renderControls(); });
        });
        li.append(button); conversationsList.append(li);
      }
      let note = listing.conversations.length ? '' : 'Todavía no hay conversaciones guardadas.';
      if (listing.skipped) note = `Se omitieron ${listing.skipped} registros o archivos dañados.`;
      $('conversations-note').textContent = note;
      conversationsPanel.hidden = false; conversationsPanel.inert = false;
      conversationsButton.setAttribute('aria-expanded', 'true'); log.inert = true; form.inert = true;
      $('conversations-close').focus();
    }, error => { localProblem = error.message || 'No se pudo leer el historial.'; renderControls(); setLive(localProblem); });
  });
  if ($('conversations-close')) $('conversations-close').addEventListener('click', () => { closeConversations(); conversationsButton.focus(); });
  function loadOlder() {
    if (!view || !historyBefore || paging || log.scrollTop > 8 || log.inert) return;
    paging = true;
    const id = view.conversation_id, generation = historyGeneration;
    const height = log.scrollHeight, top = log.scrollTop;
    action({ action: 'history', conversation_id: id, before: historyBefore }).then(page => {
      if (!view || view.conversation_id !== id || generation !== historyGeneration) return;
      olderTurns = V.mergeHistory(page.turns, olderTurns);
      historyBefore = page.before || null;
      if (page.skipped) view.history_skipped = page.skipped;
      renderLog(); renderControls();
      log.scrollTop = top + log.scrollHeight - height; // keep the same message under the reader's eye
      newer.hidden = true;
    }, error => {
      if (generation !== historyGeneration) return;
      localProblem = error.message || 'No se pudo cargar el historial anterior.'; renderControls(); setLive(localProblem);
    }).finally(() => { if (generation === historyGeneration) paging = false; });
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
  let inertTimer = 0;
  document.addEventListener('island:view', event => {
    // NOT `hidden` (display:none would kill the enter/exit transition): the
    // view is hidden by CSS (visibility/opacity, with the §9.2 motion) and
    // `inert` takes it out of focus order and accessibility.
    clearTimeout(inertTimer);
    if (event.detail === 'chat') chat.inert = false;
    else inertTimer = setTimeout(() => { if (capsule.dataset.view !== 'chat') chat.inert = true; }, 220); // after the 160ms exit
    if (event.detail !== 'chat' && pickerOpen) setPicker(false); // F024: the row belongs to the chat view
    if (event.detail === 'chat') {
      renderLog();
      renderControls();
      if (openedByKeyboard) input.focus(); // deliberate keyboard intent to type
      setLive('Conversación abierta. ' + V.statusLine(view));
    }
    openedByKeyboard = false;
  });

  // ---- composer ---------------------------------------------------------------
  // #309: the composer grows with what is typed (a few lines, then it scrolls), like a column chat.
  const MIN_INPUT = 44, MAX_INPUT = 120;
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.max(MIN_INPUT, Math.min(MAX_INPUT, input.scrollHeight)) + 'px';
  }
  input.addEventListener('input', () => { localProblem = ''; autosize(); renderControls(); });
  input.addEventListener('keydown', event => {
    // IME owns the key: `isComposing` while it composes, and the legacy 229 sentinel for
    // the keydown that confirms a candidate where the engine delivers it after
    // `compositionend` (WebKit bug 165004; 229 is what that keydown carries on Safari 26).
    // Where such a keydown arrives with a plain 13 there is NO signal that tells it apart
    // from an intentional Enter, so it sends: Enter always sends, and the README records
    // that gap rather than papering over it with a time window, which swallows real
    // Enters (TaskView #372, parent decision 2026-10-13).
    if (event.isComposing || event.keyCode === 229) return; // IME owns the key
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!V.canSend(view, input.value, inFlight)) { renderControls(); return; }
    if (pickerOpen) setPicker(false); // upstream parity: choosing ends the row's job
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
        if (input.value === text) { input.value = ''; autosize(); } // accepted: the draft became a turn
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
    loadOlder();
    if (V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight)) newer.hidden = true;
  });

  // ---- keyboard: Enter opens from the overview, Escape steps out -----------
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    const expanded = capsule.dataset.phase === 'expanded';
    const inChat = capsule.dataset.view === 'chat';
    const typing = document.activeElement === input;
    if (expanded && inChat && event.ctrlKey && !event.altKey && !event.metaKey && String(event.key).toLowerCase() === 'n') {
      event.preventDefault(); if (!event.repeat) createConversation(); return;
    }
    if (event.key === 'Escape') {
      if (conversationsPanel && !conversationsPanel.hidden) { event.preventDefault(); closeConversations(); conversationsButton.focus(); return; }
      if (pickerOpen) { event.preventDefault(); setPicker(false); modelBtn.focus(); return; } // F024: first Escape leaves the picker
      // #408: the model picker is a tab of Ajustes; settings.js closes Ajustes on Escape (capture phase) before this runs.
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
    listen('specialists:state', event => applySpecialists(event && event.payload)).catch(() => {});
    listen('models:state', event => {
      const next = event && event.payload;
      if (next && typeof next === 'object') { modelListing = next; if (pickerOpen) renderPicker(); }
    }).catch(() => {});
  }
  action({ action: 'view' }).then(apply, () => {});
  // R4 needs to know whether the ACTIVE role fixes a model: one read-only
  // `view` (the section issues the same one); the page never writes a role.
  specialistsAction({ action: 'view' }).then(applySpecialists, () => {});
})();
