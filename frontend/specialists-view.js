'use strict';
/* #327 — the specialists section's PURE view-model (no DOM, no IPC, no network, no colour).
   A specialist is a named role the human creates and chooses MANUALLY: a display name, the
   instructions that specialise it, and optionally which of the verified LOCAL models it uses.
   It never delegates, spawns, or widens anything.

   Identity contract (#384 avatar-colors owns the colour side):
   - the id is opaque, lowercase ASCII, `^[a-z0-9][a-z0-9._-]{0,31}$`, created once and stable
     across renames: it is NEVER derived from the name, the provider or a CLI id;
   - the reserved identities (`abito` the principal, the engine CLIs, the prototype keys) are
     refused, so a specialist can never impersonate the principal;
   - this module carries NO colour logic: the avatar panel resolves the colour for the SAME id.

   Loaded as a classic script (window.AbitoSpecialists) and by
   test-node/specialists-view-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSpecialists = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_SPECIALISTS = 24;
  const MAX_NAME = 40;
  const MAX_INSTRUCTIONS = 2000;
  const ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  // Never a specialist id: the principal of the island and the engine CLIs the connectors
  // screen already talks to (#306), plus the prototype keys no plain object should ever take.
  const FORBIDDEN_IDS = Object.freeze(['abito', 'pi', 'claude-code', 'codex', 'opencode', '__proto__', 'prototype', 'constructor']);
  const ID_PREFIX = 'esp-';
  const ID_BYTES = 8;

  const isStr = v => typeof v === 'string';
  // Instructions may keep normal line breaks (\n) and tabs (\t); every other control in C0/C1 and
  // DEL is refused: it would travel into a system message and a JSON store, where it buys nothing
  // and hides. The name refuses all of them, line breaks included.
  const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  const INSTRUCTIONS_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  const chars = s => Array.from(s).length;

  function validId(id) {
    return isStr(id) && ID_RE.test(id) && !FORBIDDEN_IDS.includes(id);
  }

  function hex(bytes) {
    let out = '';
    for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, '0');
    return out;
  }

  // The id is generated ONCE, when the specialist is created, from `bytes` (8 random bytes in the
  // page; the checks inject them, so the generator is deterministic and testable). It is never
  // recomputed on render and never changes when the human renames the specialist.
  function newId(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== ID_BYTES) return '';
    return ID_PREFIX + hex(bytes);
  }

  function randomId() {
    const bytes = new Uint8Array(ID_BYTES);
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || typeof c.getRandomValues !== 'function') return '';
    c.getRandomValues(bytes);
    return newId(bytes);
  }

  const cleanName = name => (isStr(name) ? name.trim() : '');
  const cleanInstructions = text => (isStr(text) ? text.trim() : '');

  // The controls are looked for in the RAW text, before trimming: a control character that trim()
  // would swallow is still refused, so nothing is silently mangled on the way to the store.
  function nameProblem(name) {
    if (!isStr(name)) return 'Poné un nombre.';
    if (NAME_CONTROL.test(name)) return 'El nombre tiene caracteres que no se pueden mostrar.';
    const n = cleanName(name);
    if (!n) return 'Poné un nombre.';
    if (chars(n) > MAX_NAME) return `El nombre no puede pasar de ${MAX_NAME} caracteres.`;
    return '';
  }

  function instructionsProblem(text) {
    if (!isStr(text)) return 'Escribí la especialidad: qué hace distinto este especialista.';
    if (INSTRUCTIONS_CONTROL.test(text)) return 'La especialidad tiene caracteres de control que no se aceptan.';
    const t = cleanInstructions(text);
    if (!t) return 'Escribí la especialidad: qué hace distinto este especialista.';
    if (chars(t) > MAX_INSTRUCTIONS) return `La especialidad no puede pasar de ${MAX_INSTRUCTIONS} caracteres.`;
    return '';
  }

  // The draft the page is about to send. `models` = the profile ids the registry verified as
  // selectable; a model outside that list is refused here (Rust refuses it again).
  function validateDraft(draft, models) {
    const fail = (field, word) => ({ ok: false, field, word });
    if (!draft || typeof draft !== 'object') return fail('name', 'Falta el especialista.');
    const name = nameProblem(draft.name);
    if (name) return fail('name', name);
    const instructions = instructionsProblem(draft.instructions);
    if (instructions) return fail('instructions', instructions);
    const m = draft.model;
    if (m === null || m === undefined || m === '') return { ok: true, word: '' };
    if (!isStr(m) || !Array.isArray(models) || !models.includes(m)) return fail('model', 'Ese modelo local no está verificado.');
    return { ok: true, word: '' };
  }

  const idTaken = (store, id) => records(store).some(r => r.id === id);

  // ---- the section view ---------------------------------------------------------------------
  function record(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!validId(raw.id)) return null;
    const name = cleanName(raw.name);
    if (nameProblem(name) || instructionsProblem(raw.instructions)) return null;
    const model = isStr(raw.model) && raw.model ? raw.model : null;
    return { id: raw.id, name, instructions: cleanInstructions(raw.instructions), model };
  }

  function records(store) {
    const list = store && Array.isArray(store.specialists) ? store.specialists : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const r = record(raw);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length === MAX_SPECIALISTS) break;
    }
    return out;
  }

  const selectableModels = listing => ((listing && listing.profiles) || []).filter(p => p && p.selectable === true && isStr(p.profile_id));

  function modelLabel(listing, model) {
    if (!model) return 'El modelo elegido en «Modelo»';
    const p = selectableModels(listing).find(x => x.profile_id === model);
    if (!p) return `${model} (no está en el registro local)`;
    return isStr(p.alias) && p.alias ? p.alias : p.profile_id;
  }

  function countWord(n) {
    if (n === 0) return 'Sin especialistas';
    return n === 1 ? '1 especialista' : `${n} especialistas`;
  }

  // The whole section, from the Rust state (`specialists:state`) plus the model listing.
  function storeView(store, listing) {
    if (store === null || store === undefined || typeof store !== 'object') return { kind: 'loading', rows: [], active: null, principal: false, count: 0, countWord: '', principalNote: '', persistenceNote: '' };
    if (store.load_error === true) return {
      kind: 'unavailable', rows: [], active: null, principal: false, count: 0,
      countWord: '', principalNote: '',
      persistenceNote: 'No se pudieron cargar los especialistas. Tus datos no se reemplazaron; no se pueden hacer cambios.',
    };
    const rows = records(store);
    const byId = rows.find(r => r.id === store.active);
    const active = byId || null;
    const persisted = store.persisted !== false;
    return {
      kind: 'ready',
      rows: rows.map(r => ({
        id: r.id, name: r.name, instructions: r.instructions, model: r.model,
        modelLabel: modelLabel(listing, r.model),
        modelReady: !r.model || !!selectableModels(listing).find(x => x.profile_id === r.model),
        active: !!active && active.id === r.id,
        aria: `${r.name}: ${r.model ? `usa ${modelLabel(listing, r.model)}` : 'usa el modelo elegido en «Modelo»'}${active && active.id === r.id ? ', en uso' : ''}`,
      })),
      active,
      principal: !active,
      count: rows.length,
      countWord: countWord(rows.length),
      principalNote: active ? '' : 'Ahora responde Abito, el principal. Elegí un especialista para cambiar de rol.',
      persistenceNote: persisted ? '' : 'Los cambios no se guardan en este equipo.',
    };
  }

  // Read-only identity projection. Role instructions/model never leave this owner seam.
  function identityView(store) {
    const view = storeView(store, null);
    return Object.freeze({ kind: view.kind, identities: Object.freeze(view.rows.map(({ id, name }) => Object.freeze({ id, name }))) });
  }

  // The chat header chip: only a real, currently-active specialist is a role. `active` naming a
  // record that is not there (or a reserved id) is NOT a role — the island says nothing.
  function roleChip(store) {
    if (!store || typeof store !== 'object' || store.load_error === true) return null;
    const r = records(store).find(x => x.id === store.active);
    return r ? { word: r.name, aria: `Rol activo: ${r.name}. Abrí Ajustes para cambiarlo o volver al principal.` } : null;
  }

  // «El modelo elegido en «Modelo»» first, then every verified selectable local profile.
  function modelOptions(listing, selected) {
    const rows = [{ id: null, label: 'El modelo elegido en «Modelo»', selected: !selected }];
    for (const p of selectableModels(listing)) {
      rows.push({ id: p.profile_id, label: isStr(p.alias) && p.alias ? p.alias : p.profile_id, selected: p.profile_id === selected });
    }
    return rows;
  }

  // The honest note about what can be chosen today: exactly one verified local model means every
  // specialist uses it. No cloud route, no invented model, nothing to download.
  function catalogNote(listing) {
    const n = selectableModels(listing).length;
    if (n === 0) return 'No hay ningún modelo local verificado: el especialista va a usar el que elijas en «Modelo». No hay nube ni claves.';
    if (n === 1) return 'Hoy hay un solo modelo local verificado en esta máquina, así que todos los especialistas lo usan. Abito no carga ni descarga modelos: para tener otro, cargalo vos en tu servicio local.';
    return 'Elegí, para cada especialista, uno de los modelos locales verificados de esta máquina.';
  }


  // ---- the create/edit form as a state machine ------------------------------------------------
  // The page keeps NO form logic of its own: it forwards input here and paints `status()`. The draft
  // survives until the backend CONFIRMS (`settle(true)`); a refusal keeps the form open with every
  // character the human typed, so a failed save never costs an edit. `canSave` is recomputed from
  // the draft on every call, which is what lets the page flip the button on each keystroke without
  // rebuilding the DOM (a rebuild loses focus and the caret).
  const emptyDraft = () => ({ name: '', instructions: '', model: null });
  function makeForm() {
    const state = { open: false, editing: null, draft: emptyDraft(), pending: false, error: '', touched: false };
    const reset = () => { state.open = false; state.editing = null; state.draft = emptyDraft(); state.pending = false; state.error = ''; state.touched = false; };
    const normalised = () => ({ name: state.draft.name, instructions: state.draft.instructions, model: state.draft.model || null });
    return {
      state,
      openNew() { reset(); state.open = true; },
      openEdit(row) {
        reset();
        state.open = true; state.editing = row.id;
        state.draft = { name: row.name, instructions: row.instructions, model: row.model || null };
      },
      cancel() { reset(); },
      input(field, value) {
        if (field !== 'name' && field !== 'instructions' && field !== 'model') return;
        state.draft[field] = field === 'model' ? (value || null) : String(value);
        state.touched = true;
      },
      status(models) {
        const v = validateDraft(state.draft, models);
        return { canSave: v.ok && !state.pending, ok: v.ok, field: v.field || '', word: v.word || '', showProblem: state.touched && !v.ok };
      },
      // Sends nothing itself: returns what the page must send, or {ok:false}. Marks the form pending.
      submit(models) {
        if (!state.open || state.pending || !validateDraft(state.draft, models).ok) return { ok: false };
        state.pending = true; state.error = '';
        return { ok: true, editing: state.editing, draft: normalised() };
      },
      settle(ok, error) {
        if (ok) { reset(); return; }
        state.pending = false;
        state.error = isStr(error) && error ? error : 'No se pudo completar; no se cambió nada.';
      },
    };
  }

  // The explicit role choice: Abito (the principal, `active: null`) first, then every valid specialist.
  // Exactly one is checked; the page paints a radiogroup from this.
  function roleKeyIndex(key, at, length) {
    if (!length || at < 0 || at >= length) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return length - 1;
    if (key === 'ArrowDown' || key === 'ArrowRight') return (at + 1) % length;
    if (key === 'ArrowUp' || key === 'ArrowLeft') return (at + length - 1) % length;
    return -1;
  }

  function roleChoices(view) {
    if (view.kind !== 'ready') return [];
    const out = [{ id: null, label: 'Abito', principal: true, checked: !view.active, aria: 'Abito, el principal' + (!view.active ? ', en uso' : '') }];
    for (const r of view.rows) out.push({ id: r.id, label: r.name, principal: false, checked: r.active, aria: r.aria });
    return out;
  }

  return {
    makeForm, roleChoices, roleKeyIndex, MAX_SPECIALISTS, MAX_NAME, MAX_INSTRUCTIONS, ID_RE, FORBIDDEN_IDS,
    newId, randomId, validId, validateDraft, idTaken, storeView, identityView, roleChip, modelOptions, catalogNote, modelLabel, countWord,
  };
});
