// Abito-owned type-only shim; NOT a copy of upstream core/state.ts.
import type { ProviderId } from "./providers.js";

export type AgentSource = "claudeCode" | "n8n" | "agent";

// Only the fields read by core/providers.ts. No runtime state or integrations.
export interface Settings {
  chatProvider: ProviderId;
  model: string;
  chatModels: Record<string, string>;
  ollamaUrl: string;
  lmstudioUrl: string;
  customUrl: string;
}
