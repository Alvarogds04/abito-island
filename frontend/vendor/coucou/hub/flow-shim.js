// Abito-owned closed Flow adapter. Only dictation_action crosses the injected boundary.
let invoke;
let hasStatus = false;
function setInvoke(fn) {
  invoke = fn;
  hasStatus = false;
}
const call = (payload) => invoke ? invoke("dictation_action", { payload }) : Promise.reject(new Error("No disponible todavía"));
async function mutation(payload) {
  const reply = await call(payload);
  if (reply?.ok !== true) throw new Error("No se pudo completar");
  return reply;
}
const FlowBridge = Object.freeze({
  status: async () => {
    try {
      const status = await call({ action: "status" });
      hasStatus = !!status;
      return status;
    } catch {
      hasStatus = false;
      return null;
    }
  },
  setPrefs: async (p) => {
    if (!hasStatus) throw new Error("No disponible todavía");
    return call({ action: "set_prefs", prefs: {
      enabled: p.enabled,
      key: p.key,
      edge: p.edge,
      mic: p.mic,
      keepDays: p.keepDays,
      cleanup: p.cleanup === true,
      defaultStyle: p.defaultStyle
    } });
  },
  history: () => call({ action: "history" }),
  deleteEntry: (id) => mutation({ action: "delete_entry", id }),
  clear: (everything) => mutation({ action: "clear_history", everything }),
  stats: () => call({ action: "stats" }),
  words: () => call({ action: "words" }),
  setWords: (words) => mutation({ action: "set_words", words }),
  snippets: () => call({ action: "snippets" }),
  setSnippets: (snippets) => mutation({ action: "set_snippets", snippets }),
  styles: () => call({ action: "styles" }),
  setStyles: (styles) => mutation({ action: "set_styles", styles }),
  runningApps: () => call({ action: "running_apps" }),
  download: () => call({ action: "download_model" }),
  removeModels: () => call({ action: "remove_model" })
});
export {
  FlowBridge,
  setInvoke
};
