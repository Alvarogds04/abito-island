// Abito-owned replacement for reference/coucou windows/src/i18n/i18n.ts @434d6a2b.
// Fixed Spanish subset: no upstream translation tables or branded copy.
// Extraction marker only: this does not bypass t()'s fail-closed lookup.
export function N_(key: string): string { return key; }
const messages = { Color: "Color", Default: "Predeterminado" } as const;
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
