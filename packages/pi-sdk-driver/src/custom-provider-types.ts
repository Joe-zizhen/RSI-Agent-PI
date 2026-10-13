/**
 * Subset of pi's `ModelDefinition` (`core/model-config.d.ts`) persisted per model
 * in `models.json`. Field names match pi's schema: pi gates image delivery on
 * `input` containing `"image"` and reads `reasoning`, `contextWindow`, `maxTokens`.
 */
export interface CustomProviderModelInput {
  readonly id: string;
  readonly input?: readonly ("text" | "image")[];
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface CustomProviderInput {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

export interface CustomProviderEntry {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
  /** Parse warnings for values read from `models.json`, shown in the settings UI. */
  readonly warnings?: readonly string[];
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPENAI_COMPLETIONS_API = "openai-completions";

/**
 * Placeholder stored as `apiKey` for keyless custom endpoints. pi composes a
 * provider only with an API key or OAuth method, and a request without a
 * resolved key fails as "Provider is not configured", so the placeholder is
 * load-bearing. Its value mirrors pi's dummy client key (`getClientApiKey` in
 * openai-completions). It is not a credential: desktop code must never send it
 * on a request (the probe strips it; `readCustomProviders` reports its absence
 * as `hasApiKey: false`). pi's request path sends any stored models.json key
 * verbatim, so keyless servers see `Authorization: Bearer unused`. That residue
 * cannot be expressed away in models.json: suppressing the header needs
 * `Authorization: null` at stream time, and the schema requires string headers.
 */
export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "unused";
export const PI_GUI_CUSTOM_PROVIDER_MARKER = "piGuiCustomEndpoint";
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}
