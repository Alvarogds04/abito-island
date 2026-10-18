// Abito-owned closed Flow adapter. Only dictation_action crosses the injected boundary.
let invoke;
let hasStatus = false;
function setInvoke(fn) {
  invoke = fn;
  hasStatus = false;
}
const call = (payload) => invoke ? invoke("dictation_action", { payload }) : Promise.reject(new Error("No disponible todavía"));
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
      cleanup: false,
      defaultStyle: p.defaultStyle
    } });
  },
  download: () => call({ action: "download_model" }),
  removeModels: () => call({ action: "remove_model" })
});
export {
  FlowBridge,
  setInvoke
};
