// Abito-owned unavailable Flow adapter. No IPC or upstream runtime dependencies.
export type FlowKey = 'right_ctrl' | 'right_alt' | 'right_shift' | 'left_ctrl_super';
export interface FlowPrefs {
  enabled: boolean; key: FlowKey; edge: string; mic: string; keepDays: number; cleanup: boolean;
  defaultStyle: string; summaryEngine: string; openAtLaunch: boolean; voice: boolean; voiceOutput: string; voiceGender: string;
}
export interface ModelsStatus { parakeet: { state: string }; downloadMb: number }
export interface FlowStatus {
  prefs: FlowPrefs; models: ModelsStatus; keys: string; hasClaudeKey: boolean; mics: unknown[];
  platform: 'windows' | 'linux'; autostarted: boolean;
}
export const FlowBridge = Object.freeze({
  status: async (): Promise<FlowStatus | null> => null,
  setPrefs: async (_prefs: FlowPrefs): Promise<void> => { throw new Error('Próximamente'); },
});
