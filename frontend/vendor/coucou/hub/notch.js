// Adapted from Coucou src/settings/main.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h } from "../views/dom.js";
const notchSection = (title, ...children) => h("section", {}, h("h2", {}, h("span", { text: title })), ...children);
const notchRow = (title, ...controls) => h("div", { class: "row" }, h("label", { text: title }), ...controls);
const notchHint = (text) => h("div", { class: "hint", text });
export {
  notchHint,
  notchRow,
  notchSection
};
