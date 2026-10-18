// Abito-owned migration of settings.js/runIntent and pill-settings.js, using literal MIT hub controls.
import { h, clear } from "../views/dom.js";
import { row, card, select, toggle, segmented } from "./ui.js";
import { action, field, note, section, trusted, session, preserveFocus } from "./runtime.js";
function preview() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "28");
  svg.setAttribute("aria-hidden", "true");
  const clay = typeof AbitoClay === "undefined" ? null : AbitoClay.create(svg, { state: "idle", live: false, viewBox: "0 0 200 200", shadow: false });
  return row("Vista previa", "Sólo presentación; no inicia tareas.", svg, trusted(segmented([["idle", "Reposo"], ["working", "Trabaja"]], "idle", (state) => clay?.setState(state))));
}
function colors(V, A, prefs, identities, save) {
  const sec = section("Colores de identidad");
  for (const r of V.colorRows(prefs, identities, A)) {
    const options = h("div", { class: "palette", role: "group", "aria-label": `Color de ${r.name}` });
    options.className = "hub-segmented";
    for (const hex of A.HEX_PALETTE) {
      const o = { color: hex, label: A.label(hex), aria: `${r.name}: ${A.label(hex)}`, selected: A.normalizeChosenColor(r.color) === hex };
      const b = action(o.label, () => save({ action: "set_avatar_color", identity: r.id, color: o.color }));
      b.className = o.selected ? "swatch on" : "swatch";
      b.textContent = "";
      b.title = o.label;
      b.setAttribute("id", `identity-${r.id}-${o.color}`);
      b.setAttribute("aria-label", o.aria);
      b.setAttribute("aria-pressed", String(o.selected));
      b.style.setProperty("background", hex);
      options.append(b);
    }
    sec.append(row(r.name, r.label, options));
  }
  return sec;
}
async function renderAppearance({ invoke, listen, V, S, A }) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  let prefs = {}, store = null;
  let queue = Promise.resolve();
  const save = (p) => work(() => {
    queue = queue.catch(() => {
    }).then(() => call("prefs_action", p));
    return queue;
  }, (next) => {
    prefs = next;
    message.textContent = "Guardado.";
    paint();
  });
  function paint() {
    const restore = preserveFocus(root);
    clear(root);
    const theme = V.themeView(prefs), pick = trusted(select(theme.options.map((o) => [o.id, o.label]), theme.mode, (value) => save({ action: "set_theme", theme: value })));
    pick.setAttribute("id", "appearance-theme");
    pick.setAttribute("aria-label", "Tema");
    root.append(section("Tema", row("Tema", null, pick)), colors(V, A, prefs, [{ id: A.PRINCIPAL_ID, name: "Abito" }, ...S.identityView(store).identities], save), section("Movimiento", row("Animación reducida", "No disponible en esta ventana")), message);
    if (S.identityView(store).kind !== "ready") root.append(note("Colores de especialistas no disponibles: no se pudieron cargar sus identidades."));
    restore();
  }
  paint();
  watch("prefs:state", (p) => {
    prefs = p;
    paint();
  });
  watch("specialists:state", (p) => {
    store = p;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (p) => {
    prefs = p;
    paint();
  });
  work(() => call("specialists_action", { action: "view" }), (p) => {
    store = p;
    paint();
  });
  return s.finish();
}
async function renderPills({ invoke, listen, V, S, A, P, C }) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  let prefs = {}, store = null, listing = null, saving = false;
  let editor = null, deleting = "", editorId = "", lastKey = "", editorRevision = 0;
  const owned = () => S.storeView(store, listing);
  const agents = () => S.agentsView(store, prefs, A);
  const shownIds = () => agents().agents.map((a) => a.id);
  const storedIds = () => (store?.specialists || []).map((a) => a.id);
  const record = (id) => (store?.specialists || []).find((a) => a.id === id);
  const prefsCall = async (p) => {
    const next = await call("prefs_action", p);
    if (s.alive()) prefs = next;
  };
  const specCall = async (p) => {
    const next = await call("specialists_action", p);
    if (s.alive()) store = next;
  };
  const setIsland = (order) => prefsCall({ action: "set_island_agents", order });
  async function createAgent(draft) {
    const id = S.randomId();
    if (!S.validId(id) || S.idTaken(store, id)) throw Error("id");
    if (draft.fromCatalog) {
      const cur = P.normalize(prefs);
      if (!cur.declaredPills.includes(draft.fromCatalog) && P.toggle(cur, draft.fromCatalog)) await prefsCall({ action: "toggle_declared_pill", id: draft.fromCatalog });
    }
    await specCall({ action: "create", id, name: draft.name, instructions: draft.instructions, model: draft.model || null });
    if (draft.color) await prefsCall({ action: "set_avatar_color", identity: id, color: draft.color });
    const shown = shownIds();
    if (!shown.includes(id) && shown.length < S.MAX_ISLAND) await setIsland([...shown, id]);
  }
  function run(i) {
    if (saving || owned().kind !== "ready") return;
    let plan = null;
    switch (i.type) {
      case "update_agent": {
        const r = record(i.id);
        if (!r) return;
        plan = () => specCall({ action: "update", id: i.id, name: i.name, instructions: i.instructions, model: i.model || null, space: r.space, spaces: r.spaces || [], permissions: r.permissions });
        break;
      }
      case "set_color":
        plan = () => prefsCall({ action: "set_avatar_color", identity: i.id, color: i.color });
        break;
      case "set_active":
      case "move": {
        const order = S.islandOrderAfter(shownIds(), storedIds(), i.type === "set_active" ? { toggle: i.id } : { move: i.id, by: i.by });
        if (!order) return;
        plan = () => setIsland(order);
        break;
      }
      case "reorder": {
        const cur = shownIds();
        if (!Array.isArray(i.order) || new Set(i.order).size !== cur.length || i.order.length !== cur.length || !i.order.every((id) => cur.includes(id))) return;
        plan = () => setIsland(i.order);
        break;
      }
      case "delete_agent": {
        const r = record(i.id);
        if (!r) return;
        const cur = P.normalize(prefs), def = cur.declaredPills.map(C.definition).find((d) => d && d.name.toLowerCase() === r.name.toLowerCase());
        plan = async () => {
          await specCall({ action: "delete", id: i.id });
          if (def && P.toggle(P.normalize(prefs), def.id)) await prefsCall({ action: "toggle_declared_pill", id: def.id });
        };
        break;
      }
      case "create_agent":
        plan = () => createAgent(i);
        break;
      case "convert_saved": {
        const item = S.savedBefore(store, prefs, C, A).find((x) => x.key === i.key);
        if (!item) return;
        plan = () => createAgent({ name: item.name, instructions: item.instructions, model: null, color: item.color });
        break;
      }
      case "set_abito_instructions":
        plan = () => prefsCall({ action: "set_abito_instructions", text: String(i.text) });
        break;
      case "set_abito_model":
        plan = () => call("models_action", { action: "select", profile_id: i.profile_id }).then((p) => {
          listing = p;
        });
        break;
      case "prefs":
        plan = () => prefsCall(i.payload);
        break;
      default:
        return;
    }
    saving = true;
    for (const b of root.querySelectorAll("button")) b.disabled = true;
    work(plan, () => {
      editor = null;
      deleting = "";
      message.textContent = "Guardado.";
    }).finally(() => {
      saving = false;
      lastKey = "";
      if (s.alive()) paint();
    });
  }
  function makeEditor(saved) {
    editorId = saved?.id || "";
    editorRevision++;
    const form = h("div", {}), name = field("specialist-name", "Nombre del agente", "text", saved?.name || "");
    name.maxLength = S.MAX_NAME;
    const instructions = h("textarea", { id: "specialist-instructions", class: "hub-input", "aria-label": "Especialidad" });
    instructions.value = saved?.instructions || "";
    instructions.maxLength = S.MAX_INSTRUCTIONS;
    const models = [["", "Usar el modelo principal"], ...(listing?.profiles || []).filter((p) => p.selectable).map((p) => [p.profile_id, p.alias || p.profile_id])];
    const model = trusted(select(models, saved?.model || "", () => {
    }));
    model.setAttribute("aria-label", "Modelo del agente");
    let fromCatalog = "", color = "";
    const colorPick = trusted(select([["", "Elegir color"], ...A.HEX_PALETTE.map((v) => [v, A.label(v)])], "", (v) => {
      color = v;
    }));
    colorPick.setAttribute("aria-label", "Color del nuevo agente");
    if (!saved) {
      const search = field("catalog-search", "Buscar en el catálogo", "search"), results = h("div", {});
      let category = "all";
      const refresh = () => {
        clear(results);
        for (const d of C.available().filter((d2) => (category === "all" || d2.category === category) && d2.name.toLowerCase().includes(search.value.toLowerCase()))) results.append(action(d.name, () => {
          const pre = S.catalogPrefill(C, d.id, prefs, A);
          if (!pre) return;
          name.value = pre.name;
          instructions.value = pre.instructions;
          fromCatalog = d.id;
          color = A.normalizeChosenColor(pre.color) || A.normalizeChosenColor(A.PRINCIPAL_COLOR);
          colorPick.value = color;
        }));
      };
      search.addEventListener("input", (e) => {
        if (e.isTrusted) refresh();
      });
      const cats = trusted(select([["all", "Todas"], ...C.CATEGORIES.map((c) => [c.id, c.label || c.name])], category, (v) => {
        category = v;
        refresh();
      }));
      form.append(row("Catálogo o agente propio", null, search, cats), results, row("Color del nuevo agente", null, colorPick));
      refresh();
    }
    form.append(preview(), row("Nombre", null, name), row("Especialidad", null, instructions), row("Modelo", null, model));
    const issue = note("");
    form.append(row("Agente", null, action("Guardar agente", () => {
      if (!saved && !color) {
        issue.textContent = "Elige un color para el nuevo agente.";
        return;
      }
      const draft = { name: name.value.trim(), instructions: instructions.value.trim() || (!saved ? `Ayuda con ${name.value.trim()}.` : ""), model: model.value || null };
      const valid = S.validateDraft(draft, (listing?.profiles || []).filter((p) => p.selectable).map((p) => p.profile_id));
      if (!valid.ok) {
        issue.textContent = valid.word;
        return;
      }
      run(saved ? { type: "update_agent", id: saved.id, ...draft } : { type: "create_agent", ...draft, fromCatalog, color });
    }), action("Cancelar", () => {
      editor = null;
      paint();
    })), issue);
    return form;
  }
  const principalInstructions = h("textarea", { id: "abito-instructions", class: "hub-input", "aria-label": "Instrucciones de Abito" });
  let instructionsDraft = false;
  principalInstructions.addEventListener("input", (e) => {
    if (e.isTrusted) instructionsDraft = true;
  });
  function paint() {
    const key = JSON.stringify([prefs.avatarColors, prefs.pillColors, prefs.declaredPills, prefs.mainPill, prefs.customBlobs, prefs.islandAgents, prefs.abitoInstructions, store, listing, saving, !!editor, editorRevision, deleting]);
    if (key === lastKey) return;
    lastKey = key;
    const restore = preserveFocus(root);
    clear(root);
    const cur = P.normalize(prefs), choices = C.mainChoices();
    const main = trusted(select(choices.map((d) => [d.id, d.name]), cur.mainPill, (id) => {
      if (P.chooseMain(cur, id)) run({ type: "prefs", payload: { action: "set_main_pill", id } });
    }));
    main.setAttribute("aria-label", "Píldora principal");
    const active = section("Píldoras activas", row("Principal", null, main));
    for (const d of C.available()) {
      const on = cur.declaredPills.includes(d.id), sw = trusted(toggle(on, () => {
        if (P.toggle(P.normalize(prefs), d.id)) run({ type: "prefs", payload: { action: "toggle_declared_pill", id: d.id } });
      }));
      sw.disabled = saving || !P.toggle(cur, d.id);
      sw.setAttribute("aria-label", d.name);
      const color = trusted(select([["", "Predeterminado"], ...A.HEX_PALETTE.map((v2) => [v2, A.label(v2)])], cur.pillColors[d.id] || "", (v2) => run({ type: "prefs", payload: v2 ? { action: "set_pill_color", id: d.id, color: v2 } : { action: "clear_pill_color", id: d.id } })));
      color.setAttribute("aria-label", `Color de ${d.name}`);
      active.append(row(d.name, d.description || null, sw, color));
    }
    root.append(active);
    if (!instructionsDraft) principalInstructions.value = prefs.abitoInstructions || "";
    const principal = section("Abito", row("Instrucciones", "Declarativo: todavía no se aplica", principalInstructions, action("Guardar instrucciones", () => {
      run({ type: "set_abito_instructions", text: principalInstructions.value });
    })));
    principalInstructions.maxLength = S.MAX_INSTRUCTIONS;
    const models = (listing?.profiles || []).filter((p) => p.selectable);
    if (models.length) principal.append(row("Modelo principal", null, trusted(select(models.map((p) => [p.profile_id, p.alias || p.profile_id]), listing?.selected || "", (id) => run({ type: "set_abito_model", profile_id: id })))));
    const v = agents(), base = owned(), spec = section("Especialistas");
    if (base.kind !== "ready") spec.append(note(base.persistenceNote || "Leyendo especialistas…"));
    else {
      if (base.persistenceNote) spec.append(note(base.persistenceNote));
      spec.append(row("En la isla", `${v.count}/${v.max}`));
      let dragged = "";
      for (const a of [...v.agents, ...v.stored]) {
        const r = row(
          a.name,
          [a.role, a.stateWord, a.modelLabel].filter(Boolean).join(" · "),
          action(a.active ? "Pausar" : "Activar", () => run({ type: "set_active", id: a.id }), saving || !a.active && v.full),
          action("Editar", () => {
            editor = makeEditor(a);
            paint();
          }, saving),
          action("Eliminar", () => {
            deleting = a.id;
            paint();
          }, saving),
          a.active ? action("Subir", () => run({ type: "move", id: a.id, by: -1 }), shownIds().indexOf(a.id) === 0) : null,
          a.active ? action("Bajar", () => run({ type: "move", id: a.id, by: 1 }), shownIds().at(-1) === a.id) : null
        );
        r.addEventListener("pointerdown", (e) => {
          if (e.isTrusted && a.active) dragged = a.id;
        });
        r.addEventListener("pointerup", (e) => {
          if (!e.isTrusted || !a.active || !dragged || dragged === a.id) return;
          const order = shownIds().filter((id) => id !== dragged);
          order.splice(order.indexOf(a.id), 0, dragged);
          dragged = "";
          run({ type: "reorder", order });
        });
        r.addEventListener("pointercancel", () => {
          dragged = "";
        });
        spec.append(r);
      }
      spec.append(action("Nuevo agente", () => {
        editor = makeEditor(null);
        paint();
      }, base.count >= S.MAX_SPECIALISTS || v.full || saving));
      for (const item of S.savedBefore(store, prefs, C, A)) spec.append(row(item.name, "Guardado de antes", action("Convertir en agente", () => run({ type: "convert_saved", key: item.key }), saving || v.full)));
    }
    if (deleting) spec.append(row("¿Eliminar agente?", "Se quita del almacén de Abito.", action("Confirmar eliminación", () => run({ type: "delete_agent", id: deleting })), action("Cancelar eliminación", () => {
      deleting = "";
      paint();
    })));
    if (editorId && !record(editorId)) editor = null;
    if (editor) spec.append(card(editor));
    principal.append(preview());
    root.append(principal, spec, colors(V, A, prefs, [{ id: A.PRINCIPAL_ID, name: "Abito" }, ...S.identityView(store).identities], (p) => run({ type: "prefs", payload: p })), message);
    restore();
  }
  paint();
  watch("prefs:state", (p) => {
    prefs = p;
    paint();
  });
  watch("specialists:state", (p) => {
    store = p;
    paint();
  });
  watch("models:state", (p) => {
    listing = p;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (p) => {
    prefs = p;
    paint();
  });
  work(() => call("specialists_action", { action: "view" }), (p) => {
    store = p;
    paint();
  });
  work(() => call("models_action", { action: "list" }), (p) => {
    listing = p;
    paint();
  });
  return s.finish();
}
export {
  renderAppearance,
  renderPills
};
