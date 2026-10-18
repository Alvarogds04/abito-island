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
  Back: "Volver", "Open in VS Code": "Abrir en VS Code", "Diff too large": "Diff demasiado grande", "No changes": "Sin cambios",
  // S10 (L30): plan usage (views/usage.ts, core/plan.ts)
  "Claude plan": "Plan de Claude", "Codex plan": "Plan de Codex", "Claude plan usage": "Uso del plan de Claude", "Codex plan usage": "Uso del plan de Codex",
  "Waiting for a response from Claude Code": "Esperando una respuesta de Claude Code", "Asking Codex…": "Consultando a Codex…",
  "just now": "ahora mismo", "{n} min ago": "hace {n} min", "{n} h ago": "hace {n} h", "5 hours": "5 horas", Week: "Semana",
  Resets: "Reinicios", "Resetting…": "Reiniciando…", "in {h} h {m}": "en {h} h {m}", "in {m} min": "en {m} min",
  "{n} available": "{n} disponibles", " · until {date}": " · hasta {date}",
  "Unavailable features": "No disponible en Abito todavía: carpeta de sonidos; recarga y contador de sonidos; inicio automático; idioma; resumen.",
} as const;
/** `{name}` placeholders, filled from `vars` (Coucou's interpolate). A missing variable stays as written. */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
}
export function t(key: string, vars?: Record<string, string | number>): string {
  if (!Object.prototype.hasOwnProperty.call(messages, key)) throw new Error(`Traducción de Abito no disponible: ${key}`);
  return interpolate(messages[key as keyof typeof messages], vars);
}
/** The fixed interface language (Abito ships Spanish only here). */
export function language(): string { return "es"; }
const ES_WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "lun" for Monday (0 = Sunday). */
export function weekdayShort(day: number): string { return ES_WEEKDAYS[day] ?? ""; }
/** "9 oct" (months from 0). */
export function dayMonth(month: number, day: number): string { return `${day} ${ES_MONTHS[month] ?? ""}`; }
// Compatibility for the unmodified DOM helper's instanceof and subscription.
// This subset has no language switching: there is nothing to subscribe to.
export class Msg {
  constructor(readonly key: string) {}
  toString(): string { return t(this.key); }
}
// Coucou's tl(): a message that follows the language (here: the fixed Spanish subset).
export function tl(key: string): Msg { return new Msg(key); }
export function onLanguageChange(_listener: () => void): () => void {
  return () => {};
}
