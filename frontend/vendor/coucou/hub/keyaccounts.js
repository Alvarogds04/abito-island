// Abito-owned. A provider key saved in Chat also becomes a provider account of the closed `abito_account_*`
const KEY_ACCOUNTS = {
  "anthropic-api-key": {
    provider: "anthropic",
    nombre: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    defaultModel: "claude-opus-5"
  },
  "google-api-key": {
    provider: "google",
    nombre: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    models: ["gemini-2.0-flash"],
    defaultModel: "gemini-2.0-flash"
  },
  "openai-api-key": {
    provider: "openai",
    nombre: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: ["gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-4o"
  },
  "openrouter-api-key": {
    provider: "openrouter",
    nombre: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models: ["openrouter/auto"],
    defaultModel: "openrouter/auto"
  }
};
const keyAccountId = (keyId) => KEY_ACCOUNTS[keyId] ? `key-${KEY_ACCOUNTS[keyId].provider}` : null;
function keyAccountCommand(keyId, action, value, owned) {
  const preset = KEY_ACCOUNTS[keyId], accountId = keyAccountId(keyId);
  if (!preset || !accountId) return null;
  const exists = owned.some((a) => a.accountId === accountId);
  if (action === "clear") return exists ? { action: "abito_account_remove", accountId } : null;
  if (!value) return null;
  const { provider, nombre, baseUrl, api, models, defaultModel } = preset;
  return {
    action: exists ? "abito_account_save" : "abito_account_create",
    accountId,
    provider,
    // secret_action owns the shared key; the account stores only its reference.
    config: { nombre, baseUrl, api, compat: {}, models: [...models], defaultModel }
  };
}
export {
  KEY_ACCOUNTS,
  keyAccountCommand,
  keyAccountId
};
