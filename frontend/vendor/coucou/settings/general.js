// Source: reference/coucou windows/src/settings/main.ts:884-982 @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { h } from "../views/dom.js";
import { t } from "../i18n/i18n.js";
import { toggle } from "./toggle.js";
function renderGeneral({ settings, save }) {
  let current = { ...settings };
  const update = (delta) => {
    current = { ...current, ...delta };
    void save({ ...current });
  };
  const volume = h("input", {
    type: "range",
    min: "0",
    max: "0.2",
    step: "0.005",
    value: String(settings.soundVolume)
  });
  volume.addEventListener("change", () => {
    update({ soundVolume: Number(volume.value) });
  });
  const autoClose = h("input", {
    type: "number",
    min: "0",
    max: "120",
    step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px"
  });
  autoClose.addEventListener("change", () => {
    const text = autoClose.value.trim();
    const raw = text === "" ? NaN : Number(text);
    const n = Number.isFinite(raw) ? raw : 15;
    const value = n === 0 ? 0 : Math.max(5, Math.min(120, Math.round(n)));
    autoClose.value = String(value);
    update({ autoCloseInterval: value });
  });
  const screen = h("select", { disabled: true, "aria-label": t("Island lives on") });
  screen.append(h("option", { value: "primary", text: t("Main display") }));
  if (settings.screen !== "primary") screen.append(h("option", { value: settings.screen, text: settings.screen }));
  screen.value = settings.screen;
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("General") })),
    h(
      "div",
      { class: "row" },
      h("label", { text: t("Sound") }),
      toggle(settings.soundEnabled, (v) => update({ soundEnabled: v })),
      volume
    ),
    h(
      "div",
      { class: "row" },
      h("label", { text: t("Open on hover") }),
      toggle(settings.openOnHover, (v) => update({ openOnHover: v }))
    ),
    h("div", { class: "hint", text: t("Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.") }),
    h(
      "div",
      { class: "row" },
      h("label", { text: t("Auto-close") }),
      autoClose,
      h("span", { class: "hint", text: t("seconds after you leave the island") })
    ),
    h("div", { class: "hint", text: t("0 means never") }),
    h(
      "div",
      { class: "row", "aria-disabled": "true" },
      h("label", { text: t("Island lives on") }),
      screen
    ),
    // Adapted for Abito: unsupported features are one neutral note, never commands.
    h("div", { class: "hint", text: t("Unavailable features") })
  );
}
export {
  renderGeneral
};
