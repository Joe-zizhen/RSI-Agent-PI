import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "@rsi-agent-pi/catalogs/node/atomic-write";
import {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
  type CustomProviderEntry,
  type CustomProviderInput,
  type CustomProviderModelInput,
} from "./custom-provider-types.js";

export type {
  CustomProviderEntry,
  CustomProviderInput,
  CustomProviderModelInput,
} from "./custom-provider-types.js";
export {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
} from "./custom-provider-types.js";

interface ModelsJson extends Record<string, unknown> {
  providers?: Record<string, unknown>;
}

export class CustomProviderStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelsJsonPath: string) {}

  async list(): Promise<readonly CustomProviderEntry[]> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      return readCustomProviders(data);
    });
  }

  async set(input: CustomProviderInput): Promise<void> {
    validateInput(input);
    await this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = ensureProvidersRecord(data);
      const existing = providers[input.providerId];
      if (
        Object.hasOwn(providers, input.providerId) &&
        (!isRecord(existing) || !isPiGuiCustomProviderConfig(input.providerId, existing))
      ) {
        throw new Error(
          `Provider ID "${input.providerId}" already exists in models.json and is not managed by pi-gui.`,
        );
      }
      providers[input.providerId] = toProviderConfig(
        input,
        isRecord(existing) ? existing : undefined,
      );
      await atomicWriteJson(this.modelsJsonPath, data);
    });
  }

  async delete(providerId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = data.providers;
      if (!providers || !Object.hasOwn(providers, providerId)) {
        return false;
      }
      const existing = providers[providerId];
      if (!isRecord(existing) || !isPiGuiCustomProviderConfig(providerId, existing)) {
        return false;
      }
      delete providers[providerId];
      await atomicWriteJson(this.modelsJsonPath, data);
      return true;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function validateInput(input: CustomProviderInput): void {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(input.providerId)) {
    throw new Error(
      `Provider ID must be lowercase alphanumerics or dashes (max 64 chars): ${JSON.stringify(input.providerId)}`,
    );
  }
  if (!isValidHttpBaseUrl(input.baseUrl)) {
    throw new Error(
      `Base URL must start with http:// or https://: ${JSON.stringify(input.baseUrl)}`,
    );
  }
  if (input.models.length === 0) {
    throw new Error("At least one model is required.");
  }
  for (const model of input.models) {
    if (!model.id || typeof model.id !== "string") {
      throw new Error("Model id is required.");
    }
    if (
      model.contextWindow !== undefined &&
      (typeof model.contextWindow !== "number" ||
        !Number.isSafeInteger(model.contextWindow) ||
        model.contextWindow < 1)
    ) {
      throw new Error(`Model ${model.id} has invalid contextWindow; expected a positive integer.`);
    }
    if (
      model.maxTokens !== undefined &&
      (typeof model.maxTokens !== "number" ||
        !Number.isSafeInteger(model.maxTokens) ||
        model.maxTokens < 1)
    ) {
      throw new Error(`Model ${model.id} has invalid maxTokens; expected a positive integer.`);
    }
    if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
      throw new Error(`Model ${model.id} has non-boolean reasoning.`);
    }
    if (model.input !== undefined) {
      if (!Array.isArray(model.input)) {
        throw new Error(`Model ${model.id} has non-array input.`);
      }
      for (const kind of model.input) {
        if (kind !== "text" && kind !== "image") {
          throw new Error(`Model ${model.id} has unsupported input kind ${JSON.stringify(kind)}.`);
        }
      }
    }
  }
}

function toProviderConfig(
  input: CustomProviderInput,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const trimmedKey = input.apiKey?.trim();
  const existingKey = typeof existing?.apiKey === "string" ? existing.apiKey.trim() : "";
  return {
    baseUrl: input.baseUrl,
    api: OPENAI_COMPLETIONS_API,
    // An empty key input keeps the stored key; only an explicit value replaces it.
    apiKey: trimmedKey || existingKey || CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
    [PI_GUI_CUSTOM_PROVIDER_MARKER]: true,
    models: input.models.map((model) => {
      const entry: Record<string, unknown> = { id: model.id };
      if (model.input !== undefined) {
        entry.input = [...model.input];
      }
      if (model.reasoning !== undefined) {
        entry.reasoning = model.reasoning;
      }
      if (model.contextWindow !== undefined) {
        entry.contextWindow = model.contextWindow;
      }
      if (model.maxTokens !== undefined) {
        entry.maxTokens = model.maxTokens;
      }
      return entry;
    }),
  };
}

function readCustomProviders(data: ModelsJson): readonly CustomProviderEntry[] {
  const providers = data.providers;
  if (!providers) {
    return [];
  }
  const entries: CustomProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    if (!isRecord(rawConfig)) {
      continue;
    }
    const config = rawConfig;
    if (!isPiGuiCustomProviderConfig(providerId, config)) {
      continue;
    }
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
    if (!baseUrl) {
      continue;
    }
    const modelWarnings: string[] = [];
    const models = Array.isArray(config.models)
      ? (config.models as unknown[])
          .map((raw): CustomProviderModelInput | undefined => {
            if (!raw || typeof raw !== "object") {
              return undefined;
            }
            const modelConfig = raw as Record<string, unknown>;
            if (typeof modelConfig.id !== "string" || !modelConfig.id) {
              return undefined;
            }
            const { input, ignored } = readModelInput(modelConfig.input);
            if (ignored && ignored.length > 0) {
              modelWarnings.push(
                `Model "${modelConfig.id}": unsupported input values: ${ignored.join(", ")}. Saving this endpoint removes them.`,
              );
            }
            const entry: CustomProviderModelInput = {
              id: modelConfig.id,
              ...(input !== undefined ? { input } : {}),
              ...(typeof modelConfig.reasoning === "boolean"
                ? { reasoning: modelConfig.reasoning }
                : {}),
              ...(typeof modelConfig.contextWindow === "number"
                ? { contextWindow: modelConfig.contextWindow }
                : {}),
              ...(typeof modelConfig.maxTokens === "number"
                ? { maxTokens: modelConfig.maxTokens }
                : {}),
            };
            return entry;
          })
          .filter((entry): entry is CustomProviderModelInput => entry !== undefined)
      : [];
    // The placeholder is not a credential (see CUSTOM_PROVIDER_PLACEHOLDER_API_KEY):
    // read-back reports it as "no key".
    const rawApiKey = typeof config.apiKey === "string" ? config.apiKey : undefined;
    const apiKey = rawApiKey === CUSTOM_PROVIDER_PLACEHOLDER_API_KEY ? undefined : rawApiKey;
    entries.push({
      providerId,
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      models,
      ...(modelWarnings.length > 0 ? { warnings: modelWarnings } : {}),
    });
  }
  entries.sort((left, right) => left.providerId.localeCompare(right.providerId));
  return entries;
}

function isPiGuiCustomProviderConfig(providerId: string, config: Record<string, unknown>): boolean {
  if (config[PI_GUI_CUSTOM_PROVIDER_MARKER] === true) {
    return true;
  }
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) {
    return false;
  }
  return (
    config.api === OPENAI_COMPLETIONS_API &&
    typeof config.baseUrl === "string" &&
    Array.isArray(config.models) &&
    config.models.length > 0
  );
}

function ensureProvidersRecord(data: ModelsJson): Record<string, unknown> {
  return (data.providers ??= {});
}

/**
 * pi's `input` capability list. Values that are not `text` or `image` cannot be
 * represented in the schema; they come back in `ignored` so the caller can warn
 * instead of dropping them silently.
 */
function readModelInput(value: unknown): {
  input?: readonly ("text" | "image")[];
  ignored?: readonly string[];
} {
  if (!Array.isArray(value)) {
    return {};
  }
  const input = value.filter(
    (kind): kind is "text" | "image" => kind === "text" || kind === "image",
  );
  const ignored = value
    .filter((kind) => kind !== "text" && kind !== "image")
    .map((kind) => String(kind));
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(ignored.length > 0 ? { ignored } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readModelsJson(path: string): Promise<ModelsJson> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON. Fix or remove the file before editing custom endpoints from the app. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object at the top level.`);
  }
  if (Object.hasOwn(parsed, "providers") && !isRecord(parsed.providers)) {
    throw new Error(
      `${path} must contain a JSON object for providers. Existing data was not changed.`,
    );
  }
  return { ...parsed, ...(isRecord(parsed.providers) ? { providers: parsed.providers } : {}) };
}

async function atomicWriteJson(path: string, data: Record<string, unknown>): Promise<void> {
  await writeJsonFileAtomic(path, data);
}
