// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
function liveMochi(_canvas, _color = "#F5F6F8", _state = "idle") {
  return null;
}
function hero(_page, title, subtitle, actions = [], compact = false) {
  const el = document.createElement("div");
  el.className = compact ? "hub-hero compact" : "hub-hero";
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const character = document.createElement("canvas");
  character.className = "troupe";
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
  hero,
  liveMochi
};
