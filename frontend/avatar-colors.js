'use strict';
/* #384 — the Dot's avatar-colour contract (pure: no DOM, no IPC, no network, no secrets).
   Human decision, verbatim: «colores en ajustes por si alguien lo quiere cambiar, pero fijo
   el verde y los sub abitos especializados de difrentes colores».

   The rules this module owns:
   1. The PRINCIPAL Abito — the compact Dot that holds the frozen R6 character — is GREEN by
      DEFAULT and stays green whatever happens on screen: no pose, activity, host condition,
      connected agent, notice or card is an input here (extra arguments are ignored on
      purpose). Only an explicit human choice made in Ajustes changes it: an explicit
      preference is not an identity and not an active agent, so refusing it would be inventing
      a prohibition nobody asked for. The default green actually painted is the engine's own
      skin gradient (clay-engine.js); this file never touches the engine, the island, CSS
      geometry or transparency.
   2. A specialised SUB-ABITO uses ITS OWN identity, over blue/mint/orange/purple
      by default. defaultColor(identity) is set-independent: entering or leaving another
      specialist never repaints it. Repeated defaults and human choices are valid; names
      distinguish identities. There is no four-specialist cap and no duplicate warning.
   3. The Ajustes overrides are a validated closed schema: only a customizable identity (the
      principal or a real sub-Abito) may be keyed, and only the five palette colours may be
      values. Everything else — a wrong type, an unknown colour name, a provider/CLI slug,
      `__proto__`/`constructor`, a malformed identity — is dropped: never applied, never
      thrown.

   Provider/CLI identities (pi, claude-code, codex, opencode) are NOT sub-Abitos: they are the
   connectors the island already names (settings-view.js `AGENT_IDS`, notify-view.js
   `KNOWN_AGENTS`).

   No specialist list is invented here: with no real sub-Abito there are no specialist rows.
   Loaded as a classic script (window.AbitoAvatarColors) and by
   test-node/avatar-colors-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoAvatarColors = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // The declared assistant identity (src/desktop.rs BRANDING.assistant = "Abito"). Everything
  // that is not a customizable identity reads as the principal.
  const PRINCIPAL_ID = 'abito';
  // The DEFAULT of the principal — not a prohibition: Ajustes may change it (see PALETTE).
  const PRINCIPAL_COLOR = 'green';
  // What a real set of sub-Abitos is assigned by default, in a FIXED order: reordering or
  // rehashing is a decision, because it would repaint every existing sub-Abito. Green is
  // absent so specialist defaults exclude principal green; a human may still choose
  // green for one in Ajustes (rule 3).
  const SPECIALIST_COLORS = Object.freeze(['blue', 'mint', 'orange', 'purple']);
  // What a human may choose in Ajustes, for the principal and for any real sub-Abito.
  const PALETTE = Object.freeze(['green', ...SPECIALIST_COLORS]);
  const COLOR_LABELS = Object.freeze({ green: 'Verde', blue: 'Azul', mint: 'Menta', orange: 'Naranja', purple: 'Púrpura' });
  // Connectors/providers the repo already names — never sub-Abito identities.
  const PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode', 'pi']);
  // The same closed slug shape the notice view enforces for a wire identity (notify-view.js).
  const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  // Keys that must never travel from a preferences file into a plain object's prototype.
  const RESERVED = Object.freeze(['__proto__', 'prototype', 'constructor']);

  // FNV-1a/32 over the identity's own bytes. Identities are validated ASCII slugs, so code
  // units are the bytes. Deterministic everywhere: no Date, no Math.random, no locale.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // The principal is the declared assistant identity, however the host spells its case; an
  // empty, missing or foreign value is not the principal (it is simply not customizable).
  const isPrincipal = identity =>
    typeof identity === 'string' && identity !== '' && identity.trim().toLowerCase() === PRINCIPAL_ID;

  // A real sub-Abito identity: shaped like an identity, not the principal, not a provider/CLI,
  // not a prototype key. Anything else is not a specialist and never gets a specialist colour.
  const isSpecialist = identity =>
    typeof identity === 'string' && IDENTITY.test(identity) && !isPrincipal(identity) &&
    !PROVIDERS.includes(identity) && !RESERVED.includes(identity);

  // What Ajustes may key: the principal (its own colour is the human's choice) or a real
  // sub-Abito. Exactly ONE canonical key per identity — the host may spell the branding
  // `Abito`, but an override keyed `Abito` would never match the identity this contract
  // resolves, so it is dropped instead of silently doing nothing. A provider/CLI slug is never
  // customizable here.
  const isCustomizable = identity => identity === PRINCIPAL_ID || isSpecialist(identity);

  // The DEFAULT colour of one identity, from the identity alone: green for the principal, a
  // hash colour for a sub-Abito, green for anything unusable (fail closed to Abito's own).
  function defaultColor(identity) {
    if (!isSpecialist(identity)) return PRINCIPAL_COLOR;
    return SPECIALIST_COLORS[hash(identity) % SPECIALIST_COLORS.length];
  }

  // The Ajustes overrides, as read back from a preferences file: untrusted until validated.
  // Only a palette colour, only for a customizable identity, everything else out.
  function sanitizeOverrides(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const identity of Object.keys(raw)) {
      if (!isCustomizable(identity)) continue;
      const value = raw[identity];
      if (typeof value !== 'string' || !PALETTE.includes(value)) continue;
      out[identity] = value;
    }
    return out;
  }

  // What one identity wears. Two inputs — the identity and the validated overrides — and
  // nothing else: no pose, no activity, no host condition can reach this decision (extra
  // arguments are ignored on purpose). Without an explicit human choice the default stands.
  // The lookup is an OWN-property test: `clean['__proto__']` is the prototype, not a colour.
  function resolveColor(identity, overrides) {
    const clean = sanitizeOverrides(overrides);
    const chosen = Object.prototype.hasOwnProperty.call(clean, identity) ? clean[identity] : '';
    return chosen || defaultColor(identity);
  }

  const label = color =>
    Object.prototype.hasOwnProperty.call(COLOR_LABELS, color) ? COLOR_LABELS[color] : '';

  // The principal descriptor the island can show/announce: its EFFECTIVE colour, which is the
  // default green unless the human chose another one. It takes the overrides and no host
  // state: no snapshot, pose, activity, agent or notice can name or repaint the principal.
  function principalFrom(overrides) {
    const color = resolveColor(PRINCIPAL_ID, overrides);
    return { id: PRINCIPAL_ID, color, label: label(color) };
  }

  // Render only identities present in the view. Orphan preference keys are retained by
  // validation, but neither rendered nor removed. Membership never changes a default.
  function settingsRows(identities, overrides) {
    const list = Array.isArray(identities) ? identities.filter(isCustomizable) : [];
    const unique = Array.from(new Set(list));
    const clean = sanitizeOverrides(overrides);
    return unique.map(id => {
      const override = Object.prototype.hasOwnProperty.call(clean, id);
      const color = override ? clean[id] : defaultColor(id);
      return { id, color, label: label(color), override,
        aria: `Color de ${id}: ${label(color)}` };
    });
  }

  return { PRINCIPAL_ID, PRINCIPAL_COLOR, SPECIALIST_COLORS, PALETTE, COLOR_LABELS, PROVIDERS,
    isPrincipal, isSpecialist, isCustomizable, defaultColor, sanitizeOverrides,
    resolveColor, label, principalFrom, settingsRows };
});
