// Abito-owned unavailable Flow adapter. No IPC or upstream runtime dependencies.
const FlowBridge = Object.freeze({
  status: async () => null,
  setPrefs: async (_prefs) => {
    throw new Error("Próximamente");
  }
});
export {
  FlowBridge
};
