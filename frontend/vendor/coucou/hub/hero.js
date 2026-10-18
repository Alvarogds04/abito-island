// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
import { h } from "../views/dom.js";
function glowCard(_color, ...content) {
  return h("div", { class: "hub-glow", style: "--glow-line:rgba(251,146,60,0.18)" }, h("canvas", {}), h("div", { class: "inner" }, ...content));
}
function emptyState(text) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  liveMochi(svg, "#F5F6F8", "sleeping");
  return h("div", { class: "hub-empty" }, svg, h("div", { text }));
}
function liveMochi(svg, _color = "#F5F6F8", state = "idle") {
  if (typeof AbitoClay === "undefined") return null;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "xMaxYMid meet");
  return AbitoClay.create(svg, { state, live: false, viewBox: "0 0 200 200", shadow: false });
}
function hero(_page, title, subtitle, actions = [], compact = false) {
  const el = document.createElement("div");
  el.className = compact ? "hub-hero compact" : "hub-hero";
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const character = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  character.setAttribute("class", "troupe");
  liveMochi(character);
  const copy = document.createElement("div");
  copy.className = "copy";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement("p");
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, character, copy);
  return el;
}
export {
  emptyState,
  glowCard,
  hero,
  liveMochi
};
