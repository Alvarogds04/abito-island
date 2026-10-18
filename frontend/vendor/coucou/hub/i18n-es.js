// Abito-owned Spanish hub lookup; separate from the fail-closed vendor i18n shim.
const es = {
  "Dictation": "Dictado",
  "Notetaker": "Notas",
  "Statistics": "Estadísticas",
  "Dictionary": "Diccionario",
  "Snippets": "Fragmentos",
  "Styles": "Estilos",
  "Settings": "Ajustes",
  "General": "General",
  "Active pills": "Píldoras activas",
  "Agents": "Agentes",
  "Chat": "Chat",
  "Integrations": "Integraciones",
  "Android phone": "Teléfono Android",
  "Shortcuts": "Atajos",
  "Notch": "Isla",
  "The character, its sounds and how the island behaves.": "El personaje, sus sonidos y el comportamiento de la isla.",
  "The pills shown in the island, their order and their colours.": "Las píldoras de la isla, su orden y sus colores.",
  "Claude Code, Codex and the other agents Abito follows.": "Claude Code, Codex y los demás agentes que sigue Abito.",
  "The AI of the island's chat, with your own keys.": "La IA del chat de la isla, con tus propias claves.",
  "Stripe, GitHub, Vercel, n8n, Notion and the rest.": "Stripe, GitHub, Vercel, n8n, Notion y el resto.",
  "Your agents and their approvals on your Android phone, over your Wi-Fi.": "Tus agentes y sus aprobaciones en tu teléfono Android, por Wi-Fi.",
  "The keys that open the island and its actions.": "Las teclas que abren la isla y sus acciones.",
  "Dictation is off": "Dictado desactivado",
  "Downloading the voice model…": "Descargando el modelo de voz…",
  "Download the voice model to dictate": "Descarga el modelo de voz para dictar",
  "Use the pill's microphone to dictate": "Usa el micrófono de la píldora para dictar",
  "Ready · hold {0}": "Listo · mantén {0}",
  "Right {0}": "{0} derecho",
  "Sound": "Sonido",
  "Volume": "Volumen",
  "Open on hover": "Abrir al pasar el cursor",
  "Auto-close": "Cierre automático",
  "Theme": "Tema",
  "Motion": "Movimiento"
};
const N_ = (key) => key;
function t(key, values = {}) {
  const text = es[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}
export {
  N_,
  t
};
