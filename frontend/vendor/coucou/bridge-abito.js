// Abito-owned adapter; does not copy the upstream core/bridge.ts.
// The palette takes synchronous colors()/pick(next) callbacks, not IPC itself.
export function createColorBridge(invoke) {
  let current = {};
  const unsupported = () => { throw new Error('Abito no admite esta paleta hexadecimal: prefs_action usa nombres de su catálogo; no se guardó ningún cambio.'); };
  return Object.freeze({
    async refresh() {
      if (typeof invoke !== 'function') throw new Error('Abito: IPC prefs_action no disponible.');
      const prefs = await invoke('prefs_action', { payload: { action: 'view' } });
      if (!prefs || typeof prefs.pillColors !== 'object' || prefs.pillColors === null || Array.isArray(prefs.pillColors)) throw new Error('Abito: respuesta prefs_action inválida.');
      // Never silently discard or reinterpret named colors as hexadecimal values.
      if (Object.keys(prefs.pillColors).length) unsupported();
      current = {};
    },
    colors: () => ({ ...current }),
    // Even an empty next value cannot identify which named override to clear.
    pick: unsupported,
  });
}
