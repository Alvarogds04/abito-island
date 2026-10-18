// Abito-owned replacement for reference/coucou windows/src/i18n/i18n.ts @434d6a2b.
// Fixed Spanish subset: no upstream translation tables or branded copy.
// Extraction marker only: this does not bypass t()'s fail-closed lookup.
export function N_(key: string): string { return key; }
// Adapted for Abito: only General's used keys added, short neutral Spanish copy.
const messages = {
  Color: "Color", Default: "Predeterminado",
  General: "General", Sound: "Sonido", "Open on hover": "Abrir al pasar el cursor",
  "Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.": "La isla se abre al pasar el cursor y se cierra al salir. Haz clic dentro para mantenerla abierta.",
  "Auto-close": "Cierre automático", "seconds after you leave the island": "segundos tras salir de la isla",
  "0 means never": "0 = nunca", "Island lives on": "Pantalla de la isla", "Main display": "Pantalla principal",
  "Unavailable features": "No disponible en Abito todavía: carpeta de sonidos; recarga y contador de sonidos; inicio automático; idioma; resumen.",
} as const;
export function t(key: string): string {
  if (!Object.prototype.hasOwnProperty.call(messages, key)) throw new Error(`Traducción de Abito no disponible: ${key}`);
  return messages[key as keyof typeof messages];
}
// Compatibility for the unmodified DOM helper's instanceof and subscription.
// This subset has no language switching: there is nothing to subscribe to.
export class Msg {
  constructor(readonly key: string) {}
  toString(): string { return t(this.key); }
}
export function onLanguageChange(_listener: () => void): () => void {
  return () => {};
}
