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
  let hotkey = null, recording = false, busy = false;
  const list = h("div", { id: "global-shortcuts", class: "shortcut-list" }), feedback = hint("");
  function save(payload) {
    if (busy || !hotkey || !s.alive()) return;
    busy = true;
    recording = false;
    draw();
    work(() => call("hotkey_action", payload), (next) => {
      hotkey = next;
    }, () => {
      hotkey = null;
    }).finally(() => {
      busy = false;
      if (s.alive()) draw();
    });
  }
  function draw() {
    clear(list);
    const dups = duplicates(hotkey?.enabled ? [["toggleIsland", hotkey.combo]] : []);
    for (const d of SHORTCUTS.filter((d2) => d2.ported)) {
      const supported = d.id === "toggleIsland", known = supported && !!hotkey;
      const enabled = supported ? hotkey?.enabled === true : d.enabledByDefault;
      const keys = supported && hotkey ? hotkey.combo : d.defaultKeys;
      const sw = trusted(toggle(enabled, (on) => {
        if (known && !busy) save({ action: on ? "enable" : "disable" });
      }));
      sw.disabled = !known || busy;
      sw.setAttribute("aria-label", t(SHORTCUT_TEXT[d.id]));
      const keycap = trusted(h("button", { class: recording && supported ? "keycap recording" : "keycap", text: recording && supported ? t("Press keys…") : displayKeys(keys) }));
      keycap.disabled = !known || !enabled || busy;
      if (supported) keycap.title = "Backspace: No disponible todavía";
      keycap.addEventListener("click", (e) => {
        if (!e.isTrusted || keycap.disabled) return;
        recording = !recording;
        draw();
        list.querySelector(".recording")?.focus();
      });
      keycap.addEventListener("keydown", (e) => {
        if (!e.isTrusted || !recording || !known || busy) return;
        e.preventDefault();
        const result = V.captureCombo(e);
        if (result.kind === "cancel") {
          recording = false;
          draw();
        } else if (result.kind === "combo") save({ action: "set", combo: result.text });
      });
      keycap.addEventListener("blur", () => {
        if (recording) {
          recording = false;
          draw();
        }
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
    const view = V.generalView({ hotkey }).hotkey;
    feedback.textContent = hotkey?.status === "permission_pending" ? t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.") : [view?.backendLabel, view?.note].filter(Boolean).join(" — ");
    reset.disabled = !hotkey || busy;
  }
  const reset = trusted(h("button", { id: "shortcut-reset", text: t("Reset to defaults") }));
  reset.title = t("Open or close the island");
  reset.addEventListener("click", (e) => {
    if (e.isTrusted && !reset.disabled) save({ action: "reset" });
  });
  const island = h("div", { id: "island-shortcuts", class: "shortcut-list" });
  for (const r of ISLAND_SHORTCUTS) island.append(h("div", { class: "row shortcut" }, h("span", { class: "shortcut-name", text: t(r.description) }), h("span", { class: "keycap static", text: r.keys })));
  const recap = await renderRecapRows({ invoke, listen, timers });
  root.append(section(
    t("Shortcuts"),
    hint(t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it.")),
    h("div", { class: "subhead", text: t("From anywhere") }),
    list,
    hint("No disponible todavía"),
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: t("In the open island") }),
    island
  ), recap, s.message);
  draw();
  work(() => call("hotkey_action", { action: "view" }), (next) => {
    hotkey = next;
    draw();
  });
  const mounted = s.finish(), dispose = mounted.dispose, settled = mounted.settled;
  mounted.dispose = () => {
    recording = false;
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
