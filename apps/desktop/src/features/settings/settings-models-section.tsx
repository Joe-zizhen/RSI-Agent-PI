import { useState, type ReactNode } from "react";
import type {
  RuntimeModelRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@rsi-agent-pi/session-driver/runtime-types";
import { SearchIcon } from "../../ui/icons";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import {
  filterModels,
  labelForThinking,
  SettingsGroup,
  SettingsRow,
  THINKING_LEVELS,
} from "./settings-utils";

interface SettingsModelsSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onOpenProviders: () => void;
}

const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({
  value: level,
  label: labelForThinking(level),
}));

function modelPattern(model: RuntimeModelRecord): string {
  return `${model.providerId}/${model.modelId}`;
}

/** Cursor's Models page: defaults on top, then one searchable list with a switch per model. */
export function SettingsModelsSection({
  runtime,
  onSetDefaultModel,
  onSetThinkingLevel,
  onSetScopedModelPatterns,
  onOpenProviders,
}: SettingsModelsSectionProps) {
  const [query, setQuery] = useState("");
  const [showUnconnected, setShowUnconnected] = useState(false);

  const models = runtime?.models ?? [];
  const availableModels = models.filter((model) => model.available);
  const unconnectedModels = models.filter((model) => !model.available);

  // No saved patterns means pi enables every available model.
  const savedPatterns = runtime?.settings.enabledModelPatterns ?? [];
  const activePatterns =
    savedPatterns.length === 0 ? availableModels.map(modelPattern) : savedPatterns;
  const activeSet = new Set(activePatterns);
  const enabledModels = availableModels.filter((model) => activeSet.has(modelPattern(model)));

  const defaultProvider = runtime?.settings.defaultProvider;
  const defaultModelId = runtime?.settings.defaultModelId;
  const defaultValue =
    defaultProvider && defaultModelId ? `${defaultProvider}:${defaultModelId}` : undefined;
  const defaultIsEnabled = enabledModels.some(
    (model) => model.providerId === defaultProvider && model.modelId === defaultModelId,
  );

  const searching = query.trim().length > 0;
  const visibleAvailable = filterModels(availableModels, query);
  const visibleUnconnected = filterModels(unconnectedModels, query);

  const setEnabled = (pattern: string, enabled: boolean) => {
    const next = enabled
      ? [...activePatterns, pattern]
      : activePatterns.filter((entry) => entry !== pattern);
    if (next.length > 0) onSetScopedModelPatterns(next);
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow title="默认模型" description="用于新建会话。">
          <SettingsSelect
            label="默认模型"
            options={enabledModels.map((model) => ({
              value: `${model.providerId}:${model.modelId}`,
              label: `${model.providerName} · ${model.label}`,
            }))}
            value={defaultIsEnabled ? defaultValue : undefined}
            onChange={(value) => {
              const [provider = "", ...modelParts] = value.split(":");
              onSetDefaultModel(provider, modelParts.join(":"));
            }}
          />
        </SettingsRow>
        <SettingsRow title="推理" description="新建会话的默认思考力度。">
          <SettingsSelect
            label="推理"
            options={THINKING_OPTIONS}
            value={runtime?.settings.defaultThinkingLevel ?? undefined}
            onChange={onSetThinkingLevel}
          />
        </SettingsRow>
        {defaultValue && !defaultIsEnabled ? (
          <div className="settings-row">
            <span className="settings-warning">
              你的默认模型（{defaultProvider}/{defaultModelId}
              ）已关闭，或其提供商未连接。请选择新的默认模型。
            </span>
          </div>
        ) : null}
      </SettingsGroup>

      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">
            启用的模型{" "}
            <span className="resource-list__count">
              {enabledModels.length} / {availableModels.length}
            </span>
          </h3>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label="搜索模型"
              placeholder="搜索模型"
              spellCheck={false}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="settings-section__description">只有启用的模型会出现在模型选择器中。</p>
        <div className="settings-group" data-testid="settings-model-list">
          {visibleAvailable.length === 0 ? (
            <div className="settings-row">
              <span className="settings-row__description">
                {availableModels.length === 0
                  ? "暂无已连接的可用模型。请连接提供商以添加模型。"
                  : `没有已连接的模型匹配“${query.trim()}”。`}
              </span>
            </div>
          ) : (
            visibleAvailable.map((model) => {
              const pattern = modelPattern(model);
              const enabled = activeSet.has(pattern);
              return (
                <ModelRow
                  isDefault={
                    model.providerId === defaultProvider && model.modelId === defaultModelId
                  }
                  key={pattern}
                  model={model}
                >
                  <SettingsSwitch
                    checked={enabled}
                    disabled={enabled && activePatterns.length <= 1}
                    label={`启用 ${pattern}`}
                    onChange={(next) => setEnabled(pattern, next)}
                  />
                </ModelRow>
              );
            })
          )}
        </div>
      </section>

      {unconnectedModels.length > 0 && (!searching || visibleUnconnected.length > 0) ? (
        <section className="settings-section">
          <div className="settings-section__header">
            <h3 className="settings-section__title">
              未连接 <span className="resource-list__count">{visibleUnconnected.length}</span>
            </h3>
            <button className="button button--secondary" type="button" onClick={onOpenProviders}>
              连接提供商
            </button>
          </div>
          <p className="settings-section__description">来自你尚未登录的提供商的模型。</p>
          {searching || showUnconnected ? (
            <div className="settings-group" data-testid="settings-unconnected-model-list">
              {visibleUnconnected.map((model) => (
                <ModelRow isDefault={false} key={modelPattern(model)} model={model} />
              ))}
            </div>
          ) : (
            <button
              className="resource-list__more"
              type="button"
              onClick={() => setShowUnconnected(true)}
            >
              显示 {unconnectedModels.length} 个模型
            </button>
          )}
        </section>
      ) : null}
    </>
  );
}

function ModelRow({
  model,
  isDefault,
  children,
}: {
  readonly model: RuntimeModelRecord;
  readonly isDefault: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row model-row">
      <div className="settings-row__label">
        <div className="settings-row__title">
          {model.label}
          {isDefault ? <span className="model-row__badge">默认</span> : null}
        </div>
        <div className="settings-row__description">
          {model.providerName} · {modelPattern(model)}
          {model.reasoning ? <span className="model-row__tag">推理</span> : null}
          {model.supportsImages ? <span className="model-row__tag">图像</span> : null}
        </div>
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}
