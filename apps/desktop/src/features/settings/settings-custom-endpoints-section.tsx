import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
} from "@rsi-agent-pi/pi-sdk-driver/custom-provider-types";
import { trapDialogFocus } from "../../ui/dialog-focus";
import type {
  CustomProviderConfig,
  CustomProviderListEntry,
  CustomProviderModelConfig,
} from "../../../contracts/ipc";
import { SettingsGroup } from "./settings-utils";
import { t, useLocale } from "../../t";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly modelsLoadError?: string;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode =
  { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderListEntry };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  modelsLoadError,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  useLocale();
  const [entries, setEntries] = useState<readonly CustomProviderListEntry[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .listCustomProviders()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleSave = useCallback(
    async (config: CustomProviderConfig): Promise<string | undefined> => {
      const error = await onSaveCustomProvider(config);
      if (!error) {
        reload();
      }
      return error;
    },
    [onSaveCustomProvider, reload],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const error = await onDeleteCustomProvider(providerId);
      if (error) {
        setLoadError(error);
        return;
      }
      reload();
    },
    [onDeleteCustomProvider, reload],
  );

  return (
    <>
      <SettingsGroup
        title={t("Custom endpoints", "自定义端点")}
        description={t(
          "Add OpenAI-compatible endpoints (Ollama, vLLM, or your own server). Stored in ~/.pi/agent/models.json.",
          "添加 OpenAI 兼容端点（Ollama、vLLM 或你自己的服务器）。保存在 ~/.pi/agent/models.json。",
        )}
      >
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {modelsLoadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">
              {t("pi could not load models.json:", "pi 无法加载 models.json：")} {modelsLoadError}
            </span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">
              {t("No custom endpoints yet.", "暂无自定义端点。")}
            </span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {entry.baseUrl} · {entry.models.length} {t("models", "个模型")}
                </div>
                {entry.warnings?.map((warning) => (
                  <div key={warning} className="settings-row__description settings-warning">
                    {warning}
                  </div>
                ))}
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  {t("Edit", "编辑")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    void handleDelete(entry.providerId).catch((error: unknown) => {
                      setLoadError(error instanceof Error ? error.message : String(error));
                    })
                  }
                >
                  {t("Remove", "移除")}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{t("Add endpoint", "添加端点")}</div>
            <div className="settings-row__description">
              {t(
                "Register a local or custom OpenAI-compatible server.",
                "注册本地或自定义的 OpenAI 兼容服务器。",
              )}
            </div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              {t("Add endpoint", "添加端点")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind !== "closed" ? (
        <CustomEndpointDialog
          mode={dialog}
          existingProviderIds={existingProviderIds}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

interface CustomEndpointDialogProps {
  readonly mode: Exclude<DialogMode, { kind: "closed" }>;
  readonly existingProviderIds: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (config: CustomProviderConfig) => Promise<string | undefined>;
}

function CustomEndpointDialog({
  mode,
  existingProviderIds,
  onClose,
  onSave,
}: CustomEndpointDialogProps) {
  useLocale();
  const titleId = useId();
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  // The stored key never renders into the input: the field only takes a
  // replacement. An empty save keeps the stored key, so the DOM cannot leak it.
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...initial.models] : [],
  );
  /** Raw context-window text per model id, so invalid input keeps its original text. */
  const [contextWindowDrafts, setContextWindowDrafts] = useState<Record<string, string>>({});
  const [probeCandidates, setProbeCandidates] = useState<readonly string[]>([]);
  const [probeError, setProbeError] = useState<string | undefined>();
  const [probePending, setProbePending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [savePending, setSavePending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const probeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreProbeFocusRef = useRef(false);

  const selectedModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const isEdit = mode.kind === "edit";

  const idValidationError = useMemo(
    () => validateProviderId(providerId, existingProviderIds, initial?.providerId),
    [providerId, existingProviderIds, initial?.providerId],
  );

  useEffect(() => {
    if (!probePending && restoreProbeFocusRef.current) {
      restoreProbeFocusRef.current = false;
      if (
        document.activeElement === document.body ||
        document.activeElement === probeButtonRef.current
      ) {
        probeButtonRef.current?.focus();
      }
    }
  }, [probePending]);

  const handleProbe = async () => {
    const api = window.piApp;
    if (!api) {
      setProbeError(t("Desktop bridge is not available.", "桌面桥接不可用。"));
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setProbeError(
        t(
          "Base URL must start with http:// or https://.",
          "Base URL 必须以 http:// 或 https:// 开头。",
        ),
      );
      return;
    }
    restoreProbeFocusRef.current = document.activeElement === probeButtonRef.current;
    setProbePending(true);
    setProbeError(undefined);
    // The probe sends only a key typed here. The stored key never reaches the
    // renderer (list reports hasApiKey), so it cannot ride a probe request;
    // blank probes without auth, and a cleared key never probes as a credential.
    const typedKey = apiKey.trim();
    const probeApiKey = clearApiKey || !typedKey ? undefined : typedKey;
    const result = await api.probeCustomProviderModels({
      baseUrl: baseUrl.trim(),
      apiKey: probeApiKey,
    });
    setProbePending(false);
    if (!result.ok) {
      setProbeError(result.error);
      setProbeCandidates([]);
      return;
    }
    setProbeCandidates(result.models);
  };

  const toggleModel = (id: string, contextWindow?: number) => {
    if (models.some((model) => model.id === id)) {
      setContextWindowDrafts((drafts) => {
        if (!(id in drafts)) {
          return drafts;
        }
        const next = { ...drafts };
        delete next[id];
        return next;
      });
    }
    setModels((current) => {
      const existing = current.find((model) => model.id === id);
      if (existing) {
        return current.filter((model) => model.id !== id);
      }
      return [...current, contextWindow !== undefined ? { id, contextWindow } : { id }];
    });
  };

  const updateContextWindow = (id: string, raw: string) => {
    setContextWindowDrafts((current) => ({ ...current, [id]: raw }));
    const parsed = raw.trim() === "" ? undefined : Number(raw);
    updateModel(id, {
      contextWindow:
        parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined,
    });
  };

  const updateModel = (id: string, patch: Partial<CustomProviderModelConfig>) => {
    setModels((current) =>
      current.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    );
  };

  const handleManualAdd = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    if (selectedModelIds.has(trimmed)) {
      return;
    }
    setModels((current) => [...current, { id: trimmed }]);
  };

  const handleSave = async () => {
    if (idValidationError) {
      setFormError(idValidationError);
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setFormError(
        t(
          "Base URL must start with http:// or https://.",
          "Base URL 必须以 http:// 或 https:// 开头。",
        ),
      );
      return;
    }
    if (models.length === 0) {
      setFormError(t("Select at least one model.", "请至少选择一个模型。"));
      return;
    }
    for (const model of models) {
      const raw = (contextWindowDrafts[model.id] ?? "").trim();
      if (raw === "") {
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        setFormError(
          t(
            `Context window for ${model.id} must be a positive integer.`,
            `${model.id} 的上下文窗口必须为正整数。`,
          ),
        );
        return;
      }
    }
    setSavePending(true);
    setFormError(undefined);
    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      ...(clearApiKey
        ? { apiKey: CUSTOM_PROVIDER_PLACEHOLDER_API_KEY }
        : apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
      models,
    });
    if (error) {
      setSavePending(false);
      setFormError(error);
      return;
    }
    onClose();
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="extension-dialog custom-endpoint-dialog"
        data-testid="custom-endpoint-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savePending) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            trapDialogFocus(event, dialogRef.current);
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <div
          className="custom-endpoint-dialog__content"
          data-testid="custom-endpoint-dialog-content"
        >
          <div className="extension-dialog__title" id={titleId}>
            {isEdit
              ? t("Edit custom endpoint", "编辑自定义端点")
              : t("Add custom endpoint", "添加自定义端点")}
          </div>
          <p className="extension-dialog__body">
            {t(
              "Configure an OpenAI-compatible server. The endpoint and API key are stored in plaintext at",
              "配置 OpenAI 兼容服务器。端点与 API key 以明文保存在",
            )}
            <code> ~/.pi/agent/models.json</code>。
          </p>
          <label className="settings-field">
            <span>{t("Provider ID", "提供商 ID")}</span>
            <input
              aria-label={t("Provider ID", "提供商 ID")}
              autoFocus={!isEdit}
              className="settings-search"
              disabled={isEdit || savePending}
              placeholder="ollama-local"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value.trim().toLowerCase())}
            />
            {idValidationError ? (
              <span className="settings-row__description settings-warning">
                {idValidationError}
              </span>
            ) : (
              <span className="settings-row__description">
                {t(
                  "Lowercase letters, digits, and dashes. Cannot be changed later.",
                  "仅限小写字母、数字和短横线。创建后不可更改。",
                )}
              </span>
            )}
          </label>
          <label className="settings-field">
            <span>Base URL</span>
            <input
              aria-label="Base URL"
              className="settings-search"
              disabled={savePending}
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <span className="settings-row__description">
              {t("Include the", "需包含")}
              <code>/v1</code> {t("suffix. Ollama:", " 后缀。Ollama：")}
              <code>http://localhost:11434/v1</code>。 vLLM：
              <code>http://localhost:8000/v1</code>。
            </span>
          </label>
          <label className="settings-field">
            <span>API key</span>
            <input
              aria-label="API key"
              className="settings-search"
              disabled={savePending || clearApiKey}
              placeholder={t("Leave blank to keep the original key", "留空保留原 key")}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="settings-row__description">
              {t(
                "Required by the storage format. For vLLM started with",
                "存储格式要求填写此项。若 vLLM 使用",
              )}
              <code>--api-key</code>{" "}
              {t(
                ", enter that key. Leave blank to keep the original key. A new endpoint, or a cleared key, stores a placeholder.",
                "启动，请输入该密钥。留空则保留原 key。新端点或清除 key 后保存占位值。",
              )}
            </span>
          </label>
          {isEdit && initial?.hasApiKey ? (
            <label className="custom-endpoint-model-caps__item">
              <input
                checked={clearApiKey}
                disabled={savePending}
                type="checkbox"
                onChange={(event) => {
                  setClearApiKey(event.target.checked);
                  if (event.target.checked) {
                    setApiKey("");
                  }
                }}
              />
              <span>{t("Clear the saved API key", "清除已保存的 API key")}</span>
            </label>
          ) : null}

          <div className="settings-field">
            <div className="settings-field__header">
              <span>{t("Models", "模型")}</span>
              <button
                className="button button--secondary"
                disabled={probePending || savePending}
                ref={probeButtonRef}
                type="button"
                onClick={() =>
                  void handleProbe().catch((error: unknown) => {
                    setProbePending(false);
                    setProbeError(error instanceof Error ? error.message : String(error));
                  })
                }
              >
                {probePending ? t("Detecting…", "检测中…") : t("Detect models", "检测模型")}
              </button>
            </div>
            {probeError ? (
              <p className="settings-row__description settings-warning">{probeError}</p>
            ) : null}
            <ModelChecklist
              probed={probeCandidates}
              selected={models}
              contextWindowDrafts={contextWindowDrafts}
              onContextWindowChange={updateContextWindow}
              onToggle={toggleModel}
              onUpdateModel={updateModel}
              onManualAdd={handleManualAdd}
              disabled={savePending}
            />
            <p className="settings-row__description">
              {t(
                "Must support tool calling. Smaller models (< 7B) often cannot output OpenAI-style function calls correctly.",
                "必须支持工具调用。较小的模型（< 7B）往往无法正确输出 OpenAI 风格的函数调用。",
              )}
            </p>
            <p className="settings-row__description">
              {t(
                "Video/audio input is not in the pi 1.0.0 model schema (input is text|image only). Tool calling is always on and needs no setting.",
                "视频/音频输入不在 pi 1.0.0 模型 schema（input 仅 text|image）；工具调用恒开无需配置。",
              )}
            </p>
          </div>
        </div>

        <div className="custom-endpoint-dialog__footer" data-testid="custom-endpoint-dialog-footer">
          {formError ? (
            <p className="extension-dialog__body settings-warning">{formError}</p>
          ) : null}
          <div className="extension-dialog__actions">
            <button
              className="button button--secondary"
              disabled={savePending}
              type="button"
              onClick={onClose}
            >
              {t("Cancel", "取消")}
            </button>
            <button
              className="button"
              disabled={
                savePending || Boolean(idValidationError) || models.length === 0 || !baseUrl.trim()
              }
              type="button"
              onClick={() =>
                void handleSave().catch((error: unknown) => {
                  setSavePending(false);
                  setFormError(error instanceof Error ? error.message : String(error));
                })
              }
            >
              {isEdit ? t("Save changes", "保存更改") : t("Add endpoint", "添加端点")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ModelChecklistProps {
  readonly probed: readonly string[];
  readonly selected: readonly CustomProviderModelConfig[];
  readonly contextWindowDrafts: Readonly<Record<string, string>>;
  readonly onContextWindowChange: (id: string, raw: string) => void;
  readonly onToggle: (id: string, contextWindow?: number) => void;
  readonly onUpdateModel: (id: string, patch: Partial<CustomProviderModelConfig>) => void;
  readonly onManualAdd: (id: string) => void;
  readonly disabled: boolean;
}

function ModelChecklist({
  probed,
  selected,
  contextWindowDrafts,
  onContextWindowChange,
  onToggle,
  onUpdateModel,
  onManualAdd,
  disabled,
}: ModelChecklistProps) {
  useLocale();
  const [manualDraft, setManualDraft] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((model) => model.id)), [selected]);
  const knownIds = useMemo(
    () => new Set([...probed, ...selected.map((model) => model.id)]),
    [probed, selected],
  );

  const submitManual = () => {
    onManualAdd(manualDraft);
    setManualDraft("");
  };

  return (
    <div className="settings-disclosure__body">
      {knownIds.size === 0 ? (
        <p className="settings-row__description">
          {t(
            "Click &ldquo;Detect models&rdquo; or type a model ID below to add one manually.",
            "点击“检测模型”，或在下方输入模型 ID 以手动添加。",
          )}
        </p>
      ) : (
        <ul className="settings-list custom-endpoint-model-list">
          {[...knownIds]
            .sort((a, b) => a.localeCompare(b))
            .map((id) => {
              const model = selected.find((entry) => entry.id === id);
              return (
                <li key={id} className="settings-row">
                  <label className="custom-endpoint-model-list__item">
                    <input
                      aria-label={t(`Enable ${id}`, `启用 ${id}`)}
                      type="checkbox"
                      checked={selectedIds.has(id)}
                      disabled={disabled}
                      onChange={() => onToggle(id)}
                    />
                    <span className="settings-row__title">{id}</span>
                  </label>
                  {model ? (
                    <div className="custom-endpoint-model-caps">
                      <label className="custom-endpoint-model-caps__item">
                        <span>{t("Context window", "上下文窗口")}</span>
                        <input
                          aria-label={t(`Context window for ${id}`, `${id} 的上下文窗口`)}
                          className="settings-text-input"
                          disabled={disabled}
                          min={1}
                          placeholder="128000"
                          type="number"
                          value={
                            contextWindowDrafts[id] ??
                            (model.contextWindow !== undefined ? String(model.contextWindow) : "")
                          }
                          onChange={(event) => onContextWindowChange(id, event.target.value)}
                        />
                      </label>
                      <label className="custom-endpoint-model-caps__item">
                        <span>{t("Image input", "图片输入")}</span>
                        <input
                          aria-label={t(`Image input for ${id}`, `${id} 的图片输入`)}
                          checked={model.input?.includes("image") ?? false}
                          disabled={disabled}
                          type="checkbox"
                          onChange={(event) => {
                            const withImage = event.target.checked;
                            const kinds = (model.input ?? ["text"]).filter(
                              (kind) => kind !== "image",
                            );
                            onUpdateModel(id, {
                              input: withImage ? [...kinds, "image"] : kinds,
                            });
                          }}
                        />
                      </label>
                      <label className="custom-endpoint-model-caps__item">
                        <span>{t("Reasoning", "思考")}</span>
                        <input
                          aria-label={t(`Reasoning for ${id}`, `${id} 的思考`)}
                          checked={model.reasoning ?? false}
                          disabled={disabled}
                          type="checkbox"
                          onChange={(event) => {
                            onUpdateModel(id, { reasoning: event.target.checked });
                          }}
                        />
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
      <div className="settings-row">
        <input
          aria-label={t("Add model ID manually", "手动添加模型 ID")}
          className="settings-search"
          disabled={disabled}
          placeholder={t("Add model ID manually", "手动添加模型 ID")}
          value={manualDraft}
          onChange={(event) => setManualDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitManual();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={disabled || manualDraft.trim().length === 0}
          type="button"
          onClick={submitManual}
        >
          {t("Add", "添加")}
        </button>
      </div>
    </div>
  );
}

function validateProviderId(
  candidate: string,
  existing: readonly string[],
  editing?: string,
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return t("Provider ID is required.", "提供商 ID 为必填项。");
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return t(
      "Use lowercase letters, digits, and dashes (max 64 chars).",
      "仅限小写字母、数字和短横线（最多 64 个字符）。",
    );
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return t(`Provider ID "${trimmed}" is already in use.`, `提供商 ID "${trimmed}" 已被占用。`);
  }
  return undefined;
}
