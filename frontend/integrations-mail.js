'use strict';
/* #370 F103 — the Mail service card: a read-list, an open message and a compose
   form inside the island. ONE file, the house pattern (integrations-view.js):
   pure view-model, textContent-only renderer, a FAKE provider, browser-only
   mount at the tail.

   FAKE DATA ONLY: nothing here talks to a network, opens an account, holds a
   token or touches a real service. Every rendered view carries the visible
   «datos de ejemplo» marker while the frame is fake.

   SENDING IS NOT WIRED: compose is a pure form model (bounded fields +
   validation). `send` validates and then ALWAYS refuses with a closed
   «no conectado» result — it never reports success, never stores the draft and
   never leaves the page.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. one container inside the Ajustes body:  <section id="integrations-mail" hidden></section>
   2. one script tag after integrations-view.js:  <script src="integrations-mail.js" defer></script>
   With the container absent the module costs nothing. Styling: the append-only
   `.ml-*` block in style.css uses theme tokens only (light + dark).

   Loaded as a classic script (window.AbitoMail) and by
   test-node/integrations-mail-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoMail = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-mail/view/1';
  const MAX_MESSAGES = 20;
  const MAX_FROM = 40;
  const MAX_SUBJECT = 120;
  const MAX_BODY = 4000;
  const MAX_PREVIEW = 90;
  const MAX_TO = 254;
  const MAX_AGO = 60 * 24 * 365; // minutes
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const NOT_CONNECTED = 'No conectado: el envío todavía no está disponible.';
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
  const FIELDS = Object.freeze(['to', 'subject', 'body']);
  const FIELD_MAX = Object.freeze({ to: MAX_TO, subject: MAX_SUBJECT, body: MAX_BODY });
  // One plain address: no whitespace, one @, a dotted domain. Not a deliverability check.
  const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>.]+(\.[^\s@,;<>.]+)+$/;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // refuses line breaks too
  const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/; // keeps \n and \t

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const chars = s => Array.from(s).length;
  const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));

  function agoLabel(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return null;
    if (minutes === 0) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    if (minutes < 60 * 24) return `hace ${Math.floor(minutes / 60)} h`;
    return `hace ${Math.floor(minutes / (60 * 24))} d`;
  }

  // ---- store ------------------------------------------------------------------
  /** A closed `mail` frame to a frozen store; anything off-shape is null. */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'mail' || frame.schema !== SCHEMA) return null;
    if (!onlyKeys(frame, ['type', 'schema', 'fake', 'messages'])) return null;
    if (typeof frame.fake !== 'boolean' || !Array.isArray(frame.messages) || frame.messages.length > MAX_MESSAGES) return null;
    const seen = new Set();
    const messages = [];
    for (const m of frame.messages) {
      if (!isObject(m) || Object.keys(m).length !== 6 || !onlyKeys(m, ['id', 'from', 'subject', 'body', 'minutesAgo', 'read'])) return null;
      if (!isStr(m.id) || !ID_RE.test(m.id) || seen.has(m.id)) return null;
      if (!isStr(m.from) || !m.from.trim() || chars(m.from) > MAX_FROM || CONTROL.test(m.from)) return null;
      if (!isStr(m.subject) || !m.subject.trim() || chars(m.subject) > MAX_SUBJECT || CONTROL.test(m.subject)) return null;
      if (!isStr(m.body) || chars(m.body) > MAX_BODY || BODY_CONTROL.test(m.body)) return null;
      if (!Number.isInteger(m.minutesAgo) || m.minutesAgo < 0 || m.minutesAgo > MAX_AGO) return null;
      if (typeof m.read !== 'boolean') return null;
      seen.add(m.id);
      messages.push(Object.freeze({ id: m.id, from: m.from, subject: m.subject, body: m.body, minutesAgo: m.minutesAgo, read: m.read }));
    }
    return Object.freeze({ fake: frame.fake, messages: Object.freeze(messages), openId: null });
  }

  const isStore = s => isObject(s) && typeof s.fake === 'boolean' && Array.isArray(s.messages) &&
    (s.openId === null || isStr(s.openId));

  /** Opens one message (and marks it read). Unknown ids change nothing (null). */
  function openMessage(store, id) {
    if (!isStore(store) || !isStr(id)) return null;
    const at = store.messages.findIndex(m => m.id === id);
    if (at < 0) return null;
    const messages = store.messages.map((m, i) => (i === at ? Object.freeze({ ...m, read: true }) : m));
    return Object.freeze({ fake: store.fake, messages: Object.freeze(messages), openId: id });
  }

  /** Back to the list; the read state stays. */
  function closeMessage(store) {
    if (!isStore(store)) return null;
    return Object.freeze({ fake: store.fake, messages: store.messages, openId: null });
  }

  const previewOf = body => {
    const flat = body.replace(/\s+/g, ' ').trim();
    const cps = Array.from(flat);
    return cps.length > MAX_PREVIEW ? `${cps.slice(0, MAX_PREVIEW - 1).join('')}…` : flat;
  };

  /** The closed projection for the renderer; null for anything that is not a store. */
  function view(store) {
    if (!isStore(store)) return null;
    const rows = store.messages.map(m => Object.freeze({
      id: m.id, from: m.from, subject: m.subject, preview: previewOf(m.body),
      ago: agoLabel(m.minutesAgo), read: m.read, open: m.id === store.openId }));
    const opened = store.messages.find(m => m.id === store.openId);
    return Object.freeze({
      fake: store.fake, banner: store.fake ? FAKE_BANNER : null,
      unread: rows.filter(r => !r.read).length, rows: Object.freeze(rows),
      open: opened ? Object.freeze({ id: opened.id, from: opened.from, subject: opened.subject,
        body: opened.body, ago: agoLabel(opened.minutesAgo) }) : null,
    });
  }

  // ---- compose: a pure form model --------------------------------------------------
  const isDraft = d => isObject(d) && FIELDS.every(f => isStr(d[f])) && Object.keys(d).length === FIELDS.length;
  function createDraft() { return Object.freeze({ to: '', subject: '', body: '' }); }

  /** One field, immutably. Unknown fields, non-strings and over-long text are refused (null). */
  function setField(draft, field, value) {
    if (!isDraft(draft) || !FIELDS.includes(field) || !isStr(value) || chars(value) > FIELD_MAX[field]) return null;
    return Object.freeze({ ...draft, [field]: value });
  }

  /** `{ ok, errors }` with one Spanish message per failing field. */
  function validateDraft(draft) {
    const errors = {};
    if (!isDraft(draft)) return Object.freeze({ ok: false, errors: Object.freeze({ to: 'El borrador no es válido.' }) });
    const to = draft.to.replace(/^ +| +$/g, ''); // only plain spaces are forgiven; a pasted line break is an error
    if (!to.trim()) errors.to = 'Falta el destinatario.';
    else if (to.length > MAX_TO || CONTROL.test(to) || !ADDRESS_RE.test(to)) errors.to = 'El destinatario no es una dirección válida.';
    if (!draft.subject.trim()) errors.subject = 'Falta el asunto.';
    else if (CONTROL.test(draft.subject)) errors.subject = 'El asunto no admite saltos de línea ni caracteres de control.';
    if (!draft.body.trim()) errors.body = 'Falta el mensaje.';
    else if (BODY_CONTROL.test(draft.body)) errors.body = 'El mensaje contiene caracteres de control.';
    return Object.freeze({ ok: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
  }

  /**
   * Sending is NOT wired. An invalid draft reports its validation errors; a valid
   * one is refused «no conectado». Never ok, never stored, never sent.
   */
  function send(draft) {
    const v = validateDraft(draft);
    if (!v.ok) return Object.freeze({ ok: false, reason: 'invalid', errors: v.errors });
    return Object.freeze({ ok: false, reason: 'not_connected', message: NOT_CONNECTED });
  }

  // ---- fake provider (LOUD, deterministic, no network) ------------------------
  const FAKE_MESSAGES = Object.freeze([
    ['m1', 'Lucía Fernández', 'Reunión del jueves', 'Hola, te confirmo la reunión del jueves a las 10. Llevá el resumen del trimestre así lo repasamos juntos.', 6, false],
    ['m2', 'Equipo de Facturación', 'Tu factura de ejemplo está lista', 'Adjuntamos la factura de ejemplo del mes. Este mensaje es de muestra y no corresponde a ninguna cuenta real.', 52, false],
    ['m3', 'Martín Gómez', 'Re: presupuesto', 'Gracias por la propuesta. Lo charlamos con el equipo y te respondo mañana.', 190, true],
    ['m4', 'Soporte Ejemplo', 'Tu consulta fue recibida', 'Recibimos tu consulta y la estamos revisando. Mensaje de muestra.', 1500, true],
  ]);
  function fakeFrame() {
    return { type: 'mail', schema: SCHEMA, fake: true,
      messages: FAKE_MESSAGES.map(([id, from, subject, body, minutesAgo, read]) => ({ id, from, subject, body, minutesAgo, read })) };
  }

  // ---- renderer (textContent only; events live in mount) -----------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const button = (cls, action, label, id) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.dataset.action = action;
    if (id) b.dataset.id = id;
    return b;
  };
  const field = (name, label, control, error) => {
    const wrap = el('div', 'ml-field');
    const lab = el('label', 'ml-label', label);
    control.id = `ml-${name}`;
    control.name = name;
    control.dataset.field = name;
    lab.htmlFor = control.id;
    wrap.append(lab, control);
    if (error) {
      const err = el('p', 'ml-error', error);
      err.id = `ml-${name}-error`;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', err.id);
      wrap.append(err);
    }
    return wrap;
  };

  /** `result` is the last send() outcome (or null); the draft re-fills the form. */
  function render(host, v, draft, result) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.rows)) { host.hidden = true; return; }
    host.hidden = false;
    const d = isDraft(draft) ? draft : createDraft();
    const errors = result && result.reason === 'invalid' ? result.errors : {};
    const head = el('div', 'ml-head');
    head.append(el('span', 'ml-title', 'Mail'), el('span', 'ml-unread', `${v.unread} sin leer`));
    host.append(head);
    if (v.banner) host.append(el('p', 'ml-fake', v.banner));
    if (v.open) {
      const art = el('article', 'ml-open');
      art.append(el('h3', 'ml-open-subject', v.open.subject),
        el('p', 'ml-open-meta', `${v.open.from} · ${v.open.ago}`),
        el('p', 'ml-open-body', v.open.body));
      art.append(button('ml-back', 'close', 'Volver a la lista'));
      host.append(art);
    } else {
      const list = el('ul', 'ml-list');
      for (const r of v.rows) {
        const li = el('li', 'ml-item');
        const b = button(`ml-row${r.read ? '' : ' ml-row--unread'}`, 'open', null, r.id);
        b.append(el('span', 'ml-row-from', r.from), el('span', 'ml-row-ago', r.ago),
          el('span', 'ml-row-subject', r.subject), el('span', 'ml-row-preview', r.preview));
        li.append(b);
        list.append(li);
      }
      host.append(list);
    }
    const form = el('form', 'ml-compose');
    form.noValidate = true;
    form.setAttribute('aria-label', 'Redactar mensaje');
    form.append(el('h3', 'ml-compose-title', 'Redactar'));
    const to = el('input'); to.type = 'text'; to.value = d.to; to.maxLength = MAX_TO; to.autocomplete = 'off';
    const subject = el('input'); subject.type = 'text'; subject.value = d.subject; subject.maxLength = MAX_SUBJECT;
    const body = el('textarea'); body.value = d.body; body.maxLength = MAX_BODY; body.rows = 4;
    form.append(field('to', 'Para', to, errors.to), field('subject', 'Asunto', subject, errors.subject),
      field('body', 'Mensaje', body, errors.body));
    const send = el('button', 'ml-send', 'Enviar');
    send.type = 'submit';
    form.append(send);
    if (result && result.reason === 'not_connected') {
      const note = el('p', 'ml-refusal', result.message);
      note.setAttribute('role', 'status');
      form.append(note);
    }
    host.append(form);
  }

  return { SCHEMA, MAX_MESSAGES, MAX_FROM, MAX_SUBJECT, MAX_BODY, MAX_PREVIEW, MAX_TO,
    storeFromFrame, openMessage, closeMessage, view, createDraft, setField, validateDraft, send, fakeFrame, render };
});

// ---- browser-only wiring: self-mount into #integrations-mail, FAKE provider only ----
function mount(V) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-mail');
  if (!host) return; // inert until index.html carries the container (mount contract)
  let store = V.storeFromFrame(V.fakeFrame());
  let draft = V.createDraft();
  let result = null;
  const paint = () => V.render(host, V.view(store), draft, result);

  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action]') : null;
    if (!t || !host.contains(t)) return;
    const next = t.dataset.action === 'open' ? V.openMessage(store, t.dataset.id)
      : t.dataset.action === 'close' ? V.closeMessage(store) : null;
    if (next) { store = next; paint(); }
  });
  host.addEventListener('input', e => {
    if (!e || e.isTrusted !== true || !e.target || !e.target.dataset) return;
    const next = V.setField(draft, e.target.dataset.field, e.target.value);
    if (next) draft = next;
  });
  host.addEventListener('submit', e => {
    if (e) e.preventDefault(); // never a navigation, never a network request
    if (!e || e.isTrusted !== true) return;
    result = V.send(draft); // closed refusal: «no conectado»
    paint();
  });
  paint();
}
