// Adapted from Coucou src/settings/main.ts generalSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { renderRecapRows } from "./recap.js";
import { createBridge } from "../bridge-abito.js";
import { toggle, select, button } from "./ui.js";
import { t, LANGUAGES } from "./i18n-es.js";
import { notchSection, notchRow as row, notchHint as hint } from "./notch.js";
function trusted(el) {
  for (const node of [el, ...el.querySelectorAll("button")]) {
    for (const type of ["click", "change", "input"]) node.addEventListener(type, (e) => {
      if (!e.isTrusted) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }
  return el;
}
const identify = (el, id) => {
  el.setAttribute("id", id);
  return el;
};
async function renderGeneral({ invoke, V }) {
  const bridge = createBridge(invoke);
  let settings = await bridge.boot();
  let monitors = [];
  const listMonitors = async () => {
    try {
      monitors = ((await invoke("monitor_action", { payload: { action: "list" } }))?.monitors ?? []).map((m) => String(m.key));
    } catch {
      monitors = [];
    }
  };
  await listMonitors();
  const namedScreens = () => [.../* @__PURE__ */ new Set([...settings.screen !== "primary" && settings.screen !== "cursor" ? [settings.screen] : [], ...monitors])];
  let customCount = 0;
  const countCustom = async () => {
    try {
      customCount = ((await invoke("sound_action", { payload: { action: "list" } }))?.names ?? []).length;
    } catch {
      customCount = 0;
    }
  };
  await countCustom();
  let prefs = await invoke("prefs_action", { payload: { action: "view" } });
  let hotkey = await invoke("hotkey_action", { payload: { action: "view" } });
  const recap = await renderRecapRows({ invoke });
  let queue = Promise.resolve(), issue = "", nameDraft = null, capturing = false;
  const root = h("div", {});
  const send = (cmd, payload) => invoke(cmd, { payload });
  const run = (work) => {
    queue = queue.then(async () => {
      try {
        await work();
        issue = "";
      } catch {
        issue = "No se pudo guardar. Revisa el valor e inténtalo de nuevo.";
        try {
          settings = await bridge.boot();
          prefs = await send("prefs_action", { action: "view" });
          hotkey = await send("hotkey_action", { action: "view" });
        } catch {
        }
      }
      paint();
    });
  };
  const patch = (change) => run(async () => {
    settings = await bridge.saveSettings({ ...settings, ...change });
  });
  const directPrefs = (payload) => run(async () => {
    prefs = await send("prefs_action", payload);
  });
  const shortcut = (payload) => run(async () => {
    hotkey = await send("hotkey_action", payload);
  });
  function paint() {
    clear(root);
    const g = V.generalView({ sound: settings.soundEnabled, gain: settings.soundVolume, hotkey });
    const name = h("input", { class: "hub-input", type: "text", value: nameDraft ?? prefs.displayName ?? "", "aria-label": "Nombre visible" });
    const nameIssue = h("p", { class: "hub-note", role: "status" });
    const save = trusted(button("Guardar nombre", () => {
      if (V.displayNameProblem(name.value)) return;
      const typed = name.value;
      run(async () => {
        prefs = await send("prefs_action", { action: "set_display_name", display_name: typed });
        if (nameDraft === typed) nameDraft = null;
      });
    }));
    name.addEventListener("input", (e) => {
      if (!e.isTrusted) return;
      nameDraft = name.value;
      nameIssue.textContent = V.displayNameProblem(name.value);
      save.disabled = !!nameIssue.textContent;
    });
    nameIssue.textContent = V.displayNameProblem(name.value);
    save.disabled = !!nameIssue.textContent;
    const sound = identify(trusted(toggle(g.sound.on, (value) => patch({ soundEnabled: value }))), "hub-sound");
    sound.setAttribute("aria-label", t("Sound"));
    const volume = identify(h("input", { type: "range", min: "0", max: "0.2", step: "0.005", value: String(g.sound.gain), "aria-label": t("Volume") }), "hub-volume");
    volume.addEventListener("change", (e) => {
      if (!e.isTrusted || V.soundGainProblem(volume.value)) return;
      patch({ soundVolume: Number(volume.value) });
    });
    const hover = identify(trusted(toggle(settings.openOnHover, (value) => patch({ openOnHover: value }))), "hub-hover");
    hover.setAttribute("aria-label", t("Open on hover"));
    const seconds = h("input", { type: "number", min: "0", max: "120", step: "1", style: "width:72px", value: String(settings.autoCloseInterval), "aria-label": "Cierre automático en segundos" });
    seconds.addEventListener("change", (e) => {
      if (!e.isTrusted) return;
      const value = Number(seconds.value);
      if (!seconds.value.trim() || !Number.isInteger(value) || value !== 0 && (value < 5 || value > 120)) {
        issue = "Usa 0 o un entero entre 5 y 120 segundos.";
        paint();
        return;
      }
      patch({ autoCloseInterval: value });
    });
    const theme = V.themeView(prefs);
    const themeSelect = trusted(select(theme.options.map((o) => [o.id, o.label]), theme.mode, (value) => directPrefs({ action: "set_theme", theme: value })));
    themeSelect.setAttribute("aria-label", t("Theme"));
    const motion = identify(trusted(toggle(false, () => {
    })), "hub-motion");
    motion.disabled = true;
    motion.setAttribute("aria-label", t("Motion"));
    const change = trusted(button(capturing ? "Cancelar" : "Cambiar", () => {
      capturing = !capturing;
      paint();
    }));
    const capture = h("input", { class: "hub-input", type: "text", value: capturing ? "" : hotkey.combo, "aria-label": "Atajo global", readonly: true });
    capture.addEventListener("keydown", (e) => {
      if (!capturing || !e.isTrusted) return;
      e.preventDefault();
      const combo = V.captureCombo(e);
      if (combo.kind === "cancel") {
        capturing = false;
        paint();
      } else if (combo.kind === "combo") {
        capturing = false;
        shortcut({ action: "set", combo: combo.text });
      }
    });
    const enabled = trusted(toggle(hotkey.enabled !== false, (value) => shortcut({ action: value ? "enable" : "disable" })));
    enabled.setAttribute("aria-label", "Atajo activo");
    const unavailable = (el, id) => {
      el.disabled = true;
      el.setAttribute("title", "No disponible todavía");
      return identify(el, id);
    };
    const screen = trusted(select([
      ["primary", t("Main display")],
      ["cursor", t("Display under the cursor")],
      ...namedScreens().map((name2) => [name2, name2])
    ], settings.screen, (value) => {
      if (value !== "cursor") patch({ screen: value });
    }));
    screen.className = "";
    screen.setAttribute("aria-label", t("Island lives on"));
    screen.setAttribute("id", "hub-screen");
    const cursor = screen.children[1];
    cursor.disabled = true;
    cursor.title = "No disponible todavía";
    const soundsFolder = identify(trusted(h("button", { text: t("Open sounds folder"), onclick: () => {
      run(async () => {
        await send("sound_action", { action: "reveal" });
      });
    } })), "hub-sounds-folder");
    const soundsReload = identify(trusted(h("button", { text: t("Reload sounds"), onclick: () => {
      run(async () => {
        await send("sound_action", { action: "reload" });
        await countCustom();
      });
    } })), "hub-sounds-reload");
    const language = unavailable(select([["", t("System")], ...LANGUAGES], "", () => {
    }), "hub-language");
    language.className = "";
    root.append(notchSection(
      t("General"),
      row(t("Sound"), sound, volume),
      h("div", { class: "row" }, soundsFolder, soundsReload, h("span", { class: "hint", text: customCount > 0 ? t("{0} custom", { 0: customCount }) : "" })),
      hint(t("Drop a file named like one of el personaje's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload.")),
      row(t("Open on hover"), hover),
      hint(t("Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.")),
      row(t("Auto-close"), seconds, h("span", { class: "hint", text: t("seconds after you leave the island") })),
      hint(t("0 means never")),
      row(t("Island lives on"), screen),
      row(t("Theme"), themeSelect),
      row(t("Launch at startup"), unavailable(toggle(false, () => {
      }), "hub-autostart"), h("span", { class: "hint", text: "No disponible todavía" })),
      recap,
      row(t("Language"), language, h("span", { class: "hint", text: "No disponible todavía" })),
      row("Nombre visible", name, save),
      nameIssue,
      row(t("Motion"), motion, h("span", { class: "hint", text: "No disponible en esta ventana" })),
      row("Atajo global", capture, change, trusted(button("Original", () => shortcut({ action: "reset" }))), enabled),
      hint(g.hotkey?.note || g.hotkey?.backendLabel || ""),
      h("p", { class: "hub-note", role: "status", text: issue })
    ));
    themeSelect.className = "";
    if (capturing) {
      capture.focus?.();
    }
  }
  paint();
  return Object.assign(root, { dispose: () => recap.dispose(), settled: async () => {
    await queue;
    await recap.settled();
  } });
}
export {
  renderGeneral
};
