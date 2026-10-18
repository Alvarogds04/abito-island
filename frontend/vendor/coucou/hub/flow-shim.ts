// Abito-owned closed Flow adapter. Only dictation_action crosses the injected boundary.
export type FlowKey = 'right_ctrl' | 'right_alt' | 'right_shift' | 'left_ctrl_super';
export type Edge = 'bottom' | 'left' | 'right';
export interface FlowPrefs {
  enabled: boolean; key: FlowKey; edge: Edge; mic: string; keepDays: number; cleanup: boolean;
  defaultStyle: string; summaryEngine: string; openAtLaunch: boolean; voice: boolean; voiceOutput: string; voiceGender: string;
}
export interface ModelsStatus { parakeet: { state: string; fraction?: number; error?: string }; downloadMb: number }
export interface FlowStatus {
  prefs: FlowPrefs; models: ModelsStatus; keys: string; hasClaudeKey: boolean; mics: {name: string; default: boolean}[];
  platform: 'windows' | 'linux'; autostarted: boolean;
}
let invoke: ((command: string, args: any) => Promise<any>) | undefined;
let hasStatus = false;
export function setInvoke(fn: typeof invoke) { invoke = fn; hasStatus = false; }
const call = (payload: any) => invoke ? invoke('dictation_action', { payload }) : Promise.reject(new Error('No disponible todavía'));
export const FlowBridge = Object.freeze({
  status: async (): Promise<FlowStatus | null> => {
    try { const status = await call({action:'status'}); hasStatus = !!status; return status; }
    catch { hasStatus = false; return null; }
  },
  setPrefs: async (p: FlowPrefs): Promise<Partial<FlowPrefs>> => {
    if (!hasStatus) throw new Error('No disponible todavía'); // Never overwrite unread stored prefs with shell defaults.
    return call({ action:'set_prefs', prefs: {
      enabled:p.enabled, key:p.key, edge:p.edge, mic:p.mic, keepDays:p.keepDays, cleanup:false, defaultStyle:p.defaultStyle,
    } });
  },
  download: (): Promise<ModelsStatus> => call({action:'download_model'}),
  removeModels: (): Promise<ModelsStatus> => call({action:'remove_model'}),
});
