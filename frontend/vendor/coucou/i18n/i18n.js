// Abito-owned replacement for reference/coucou windows/src/i18n/i18n.ts @434d6a2b.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function N_(key) {
  return key;
}
const messages = { Color: "Color", Default: "Predeterminado" };
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
function onLanguageChange(_listener) {
  return () => {
  };
}
export {
  Msg,
  N_,
  onLanguageChange,
  t
};
