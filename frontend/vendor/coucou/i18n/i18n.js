// Abito-owned replacement for reference/coucou windows/src/i18n/i18n.ts @434d6a2b.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function N_(key) {
  return key;
}
const messages = {
  Color: "Color",
  Default: "Predeterminado",
  General: "General",
  Sound: "Sonido",
  "Open on hover": "Abrir al pasar el cursor",
  "Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.": "La isla se abre al pasar el cursor y se cierra al salir. Haz clic dentro para mantenerla abierta.",
  "Auto-close": "Cierre automático",
  "seconds after you leave the island": "segundos tras salir de la isla",
  "0 means never": "0 = nunca",
  "Island lives on": "Pantalla de la isla",
  "Main display": "Pantalla principal",
  Back: "Volver",
  "Open in VS Code": "Abrir en VS Code",
  "Diff too large": "Diff demasiado grande",
  "No changes": "Sin cambios",
  "Unavailable features": "No disponible en Abito todavía: carpeta de sonidos; recarga y contador de sonidos; inicio automático; idioma; resumen."
};
function t(key) {
  if (!Object.prototype.hasOwnProperty.call(messages, key)) throw new Error(`Traducción de Abito no disponible: ${key}`);
  return messages[key];
}
class Msg {
  constructor(key) {
    __publicField(this, "key", key);
  }
  toString() {
    return t(this.key);
  }
}
function tl(key) {
  return new Msg(key);
}
function onLanguageChange(_listener) {
  return () => {
  };
}
export {
  Msg,
  N_,
  onLanguageChange,
  t,
  tl
};
