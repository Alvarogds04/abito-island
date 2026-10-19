// Adapted from Coucou src/settings/main.ts shortcutsSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { SHORTCUTS, SHORTCUT_TEXT, ISLAND_SHORTCUTS, displayKeys, duplicates } from "../core/shortcuts.js";
import { toggle } from "./ui.js";
import { notchSection as section, notchHint as hint } from "./notch.js";
import { session, trusted } from "./runtime.js";
import { renderRecapRows } from "./recap.js";
import { t } from "./i18n-es.js";
async function renderShortcuts({ invoke, V, listen, timers }) {
  const s = session(invoke, listen, timers), { root, call, work } = s;
  root.style.setProperty("display", "contents");
  const views = Object.fromEntries(SHORTCUTS.filter((d) => d.ported).map((d) => [d.id, null]));
  let recording = null, busy = false;
  const resume = () => call("hotkey_action", { action: "resume" });
  function stopRecording() {
    recording = null;
    work(resume).finally(() => {
      if (s.alive()) draw();
    });
    draw();
  }
  function startRecording(id) {
    if (recording === id) {
      stopRecording();
      return;
    }
    busy = true;
    draw();
    work(() => call("hotkey_action", { action: "suspend" }), () => {
      recording = id;
    }, () => {
      recording = null;
    }).finally(() => {
      busy = false;
      if (s.alive()) {
        draw();
        list.querySelector(".recording")?.focus();
      } else invoke("hotkey_action", { payload: { action: "resume" } }).catch(() => {
      });
    });
  }
  const payloadFor = (id, payload) => id === "toggleIsland" ? payload : { ...payload, id };
  const list = h("div", { id: "global-shortcuts", class: "shortcut-list" }), feedback = hint("");
  function save(id, payload) {
    if (busy || !views[id] || !s.alive()) return;
    const wasRecording = recording !== null;
    busy = true;
    recording = null;
    draw();
    work(() => call("hotkey_action", payloadFor(id, payload)), (next) => {
      views[id] = next;
    }, (error) => {
      if (error?.code === "combo_in_use") s.message.textContent = "Esa combinación ya está asignada a otro atajo. El anterior sigue guardado.";
    }).finally(async () => {
      if (wasRecording) await resume().catch(() => {
      });
      busy = false;
      if (s.alive()) draw();
    });
  }
  function draw() {
    clear(list);
    const dups = duplicates(Object.entries(views).filter(([, v]) => v?.enabled).map(([id, v]) => [id, v.combo]));
    for (const d of SHORTCUTS.filter((d2) => d2.ported)) {
      const supported = Object.hasOwn(views, d.id), hotkey = views[d.id], known = supported && !!hotkey;
      const enabled = supported ? hotkey?.enabled === true : d.enabledByDefault;
      const keys = hotkey ? hotkey.combo : d.defaultKeys;
      const sw = trusted(toggle(enabled, (on) => {
        if (known && !busy) save(d.id, { action: on ? "enable" : "disable" });
      }));
      sw.disabled = !known || busy || !keys;
      sw.setAttribute("aria-label", t(SHORTCUT_TEXT[d.id]));
      if (known && !keys) sw.title = "Graba una combinación antes de activar este atajo.";
      const isRecording = recording === d.id;
      const keycap = trusted(h("button", { class: isRecording ? "keycap recording" : "keycap", text: isRecording ? t("Press keys…") : displayKeys(keys) }));
      keycap.disabled = !known || busy;
      if (supported) keycap.title = "Esc: cancelar · Backspace: borrar";
      keycap.addEventListener("click", (e) => {
        if (!e.isTrusted || keycap.disabled) return;
        startRecording(d.id);
      });
      keycap.addEventListener("keydown", (e) => {
        if (!e.isTrusted || recording !== d.id || !known || busy) return;
        e.preventDefault();
        const result = e.key === "Backspace" && !e.repeat && !e.isComposing ? { kind: "clear" } : V.captureCombo(e);
        if (result.kind === "cancel") stopRecording();
        else if (result.kind === "clear") save(d.id, { action: "clear" });
        else if (result.kind === "combo") save(d.id, { action: "set", combo: result.text });
      });
      keycap.addEventListener("blur", () => {
        if (recording === d.id) stopRecording();
      });
      const r = h("div", { id: `shortcut-${d.id}`, class: enabled ? "row shortcut" : "row shortcut off" }, sw, h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }));
      if (known && enabled) {
        if (dups.has(d.id)) r.append(h("span", { class: "tag err", text: t("Used twice") }));
        else if (hotkey.status === "taken") r.append(h("span", { class: "tag warn", text: t("In use by another app") }));
        else if (hotkey.status === "invalid") r.append(h("span", { class: "tag err", text: t("Not a valid shortcut") }));
        else if (hotkey.status === "unsupported") r.append(h("span", { class: "tag", text: t("Not available") }));
        else if (hotkey.status === "permission_denied") r.append(h("span", { class: "tag warn", text: t("Not set by your desktop") }));
      }
      if (!supported) {
        sw.title = keycap.title = "No disponible todavía";
      }
      r.append(keycap);
      list.append(r);
    }
    feedback.textContent = Object.values(views).some((v) => v?.status === "permission_pending") ? t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.") : [...new Set(Object.values(views).map((hotkey) => V.generalView({ hotkey }).hotkey).flatMap((view) => [view?.backendLabel, view?.note]).filter(Boolean))].join(" — ");
    reset.disabled = Object.values(views).some((v) => !v) || busy;
  }
  const reset = trusted(h("button", { id: "shortcut-reset", text: t("Reset to defaults") }));
  reset.addEventListener("click", (e) => {
    if (!e.isTrusted || reset.disabled) return;
    busy = true;
    recording = null;
    draw();
    work(async () => {
      for (const action of ["clear", "reset"]) for (const id of Object.keys(views)) {
        try {
          views[id] = await call("hotkey_action", payloadFor(id, { action }));
        } catch {
          s.message.textContent = "No se pudieron restablecer todos los atajos. Revisa las filas e inténtalo otra vez.";
        }
      }
    }, () => {
    }, () => {
    }).finally(() => {
      busy = false;
      if (s.alive()) draw();
    });
  });
  const island = h("div", { id: "island-shortcuts", class: "shortcut-list" });
  for (const r of ISLAND_SHORTCUTS) island.append(h("div", { class: "row shortcut" }, h("span", { class: "shortcut-name", text: t(r.description) }), h("span", { class: "keycap static", text: r.keys })));
  const recap = await renderRecapRows({ invoke, listen, timers });
  root.append(section(
    t("Shortcuts"),
    hint(t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it.")),
    h("div", { class: "subhead", text: t("From anywhere") }),
    list,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: t("In the open island") }),
    island
  ), recap, s.message);
  draw();
  for (const id of Object.keys(views)) {
    work(() => call("hotkey_action", payloadFor(id, { action: "view" })), (next) => {
      views[id] = next;
      draw();
    });
    s.watch(id === "toggleIsland" ? "hotkey:state" : id === "desktopToggle" ? "hotkey-desktop:state" : `hotkey-${id}:state`, (next) => {
      views[id] = next;
      if (!recording) draw();
    });
  }
  const mounted = s.finish(), dispose = mounted.dispose, settled = mounted.settled;
  mounted.dispose = () => {
    if (recording) invoke("hotkey_action", { payload: { action: "resume" } }).catch(() => {
    });
    recording = null;
    recap.dispose();
    dispose();
  };
  mounted.settled = async () => {
    await settled();
    await recap.settled();
  };
  return mounted;
}
export {
  renderShortcuts
};
