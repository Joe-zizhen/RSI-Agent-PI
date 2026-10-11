import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  isValidHttpBaseUrl,
} from "@rsi-agent-pi/pi-sdk-driver/custom-provider-types";
import { trapDialogFocus } from "../../ui/dialog-focus";
import type { CustomProviderConfig, CustomProviderModelConfig } from "../../../contracts/ipc";
import { SettingsGroup } from "./settings-utils";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode =
  { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderConfig };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  const [entries, setEntries] = useState<readonly CustomProviderConfig[]>([]);
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
        title="自定义端点"
        description="添加 OpenAI 兼容端点（Ollama、vLLM 或你自己的服务器）。保存在 ~/.pi/agent/models.json。"
      >
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">暂无自定义端点。</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {entry.baseUrl} · {entry.models.length} 个模型
                </div>
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  编辑
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
                  移除
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">添加端点</div>
            <div className="settings-row__description">注册本地或自定义的 OpenAI 兼容服务器。</div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              添加端点
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
  const titleId = useId();
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...initial.models] : [],
  );
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
      setProbeError("桌面桥接不可用。");
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setProbeError("Base URL 必须以 http:// 或 https:// 开头。");
      return;
    }
    restoreProbeFocusRef.current = document.activeElement === probeButtonRef.current;
    setProbePending(true);
    setProbeError(undefined);
    const result = await api.probeCustomProviderModels({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
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
    setModels((current) => {
      const existing = current.find((model) => model.id === id);
      if (existing) {
        return current.filter((model) => model.id !== id);
      }
      return [...current, contextWindow !== undefined ? { id, contextWindow } : { id }];
    });
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
      setFormError("Base URL 必须以 http:// 或 https:// 开头。");
      return;
    }
    if (models.length === 0) {
      setFormError("请至少选择一个模型。");
      return;
    }
    setSavePending(true);
    setFormError(undefined);
    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
            {isEdit ? "编辑自定义端点" : "添加自定义端点"}
          </div>
          <p className="extension-dialog__body">
            配置 OpenAI 兼容服务器。端点与 API key 以明文保存在
            <code> ~/.pi/agent/models.json</code>。
          </p>
          <label className="settings-field">
            <span>提供商 ID</span>
            <input
              aria-label="提供商 ID"
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
                仅限小写字母、数字和短横线。创建后不可更改。
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
              需包含 <code>/v1</code> 后缀。Ollama：<code>http://localhost:11434/v1</code>。 vLLM：
              <code>http://localhost:8000/v1</code>。
            </span>
          </label>
          <label className="settings-field">
            <span>API key</span>
            <input
              aria-label="API key"
              className="settings-search"
              disabled={savePending}
              placeholder="vLLM：透传；Ollama：留空"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="settings-row__description">
              存储格式要求填写此项。若 vLLM 使用 <code>--api-key</code> 启动，请输入该密钥。若为
              Ollama 或其他无认证服务器，请留空，系统会保存占位值。
            </span>
          </label>

          <div className="settings-field">
            <div className="settings-field__header">
              <span>模型</span>
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
                {probePending ? "检测中…" : "检测模型"}
              </button>
            </div>
            {probeError ? (
              <p className="settings-row__description settings-warning">{probeError}</p>
            ) : null}
            <ModelChecklist
              probed={probeCandidates}
              selected={models}
              onToggle={toggleModel}
              onManualAdd={handleManualAdd}
              disabled={savePending}
            />
            <p className="settings-row__description">
              必须支持工具调用。较小的模型（&lt; 7B）往往无法正确输出 OpenAI 风格的函数调用。
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
              取消
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
              {isEdit ? "保存更改" : "添加端点"}
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
  readonly onToggle: (id: string, contextWindow?: number) => void;
  readonly onManualAdd: (id: string) => void;
  readonly disabled: boolean;
}

function ModelChecklist({
  probed,
  selected,
  onToggle,
  onManualAdd,
  disabled,
}: ModelChecklistProps) {
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
          点击“检测模型”，或在下方输入模型 ID 以手动添加。
        </p>
      ) : (
        <ul className="settings-list custom-endpoint-model-list">
          {[...knownIds]
            .sort((a, b) => a.localeCompare(b))
            .map((id) => (
              <li key={id} className="settings-row">
                <label className="custom-endpoint-model-list__item">
                  <input
                    aria-label={`启用 ${id}`}
                    type="checkbox"
                    checked={selectedIds.has(id)}
                    disabled={disabled}
                    onChange={() => onToggle(id)}
                  />
                  <span className="settings-row__title">{id}</span>
                </label>
              </li>
            ))}
        </ul>
      )}
      <div className="settings-row">
        <input
          aria-label="手动添加模型 ID"
          className="settings-search"
          disabled={disabled}
          placeholder="手动添加模型 ID"
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
          添加
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
    return "提供商 ID 为必填项。";
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return "仅限小写字母、数字和短横线（最多 64 个字符）。";
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return `提供商 ID "${trimmed}" 已被占用。`;
  }
  return undefined;
}
