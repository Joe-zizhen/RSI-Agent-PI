import type { RuntimeSnapshot } from "@rsi-agent-pi/session-driver/runtime-types";
import { buildModelOptions } from "../conversation/composer-commands";
import { t } from "../../t";

export type ModelOnboardingSettingsSection = "models" | "providers";

export interface ModelOnboardingNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionSection: ModelOnboardingSettingsSection;
}

export interface ModelOnboardingState {
  readonly hasSelectableModels: boolean;
  readonly requiresModelSelection: boolean;
  readonly unselectedModelLabel: string;
  readonly emptyModelTitle: string;
  readonly emptyModelDescription: string;
  readonly notice?: ModelOnboardingNotice;
}

interface ModelSelectionInput {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
}

export function deriveModelOnboardingState(
  runtime: RuntimeSnapshot | undefined,
  currentSelection: ModelSelectionInput,
): ModelOnboardingState {
  const selectableModels = buildModelOptions(runtime);
  const selectableSet = new Set(
    selectableModels.map((model) => `${model.providerId}:${model.modelId}`),
  );
  const hasSelectableModels = selectableModels.length > 0;
  const connectedProviderCount =
    runtime?.providers.filter((provider) => provider.hasAuth).length ?? 0;
  const settingsDefault = {
    provider: runtime?.settings.defaultProvider,
    modelId: runtime?.settings.defaultModelId,
  };
  const hasDefaultModel = Boolean(settingsDefault.provider && settingsDefault.modelId);
  const defaultModelUsable = isUsableSelection(settingsDefault, selectableSet);
  const hasCurrentSelection = Boolean(currentSelection.provider && currentSelection.modelId);
  const currentSelectionUsable = isUsableSelection(currentSelection, selectableSet);

  if (!hasSelectableModels) {
    return {
      hasSelectableModels: false,
      requiresModelSelection: true,
      unselectedModelLabel: t("No models available", "无可用模型"),
      emptyModelTitle: t("No models available", "无可用模型"),
      emptyModelDescription:
        connectedProviderCount > 0
          ? t("Open Settings > Models to enable models.", "打开“设置 > 模型”以启用模型。")
          : t(
              "Open Settings > Providers to connect a provider and make models available.",
              "打开“设置 > 提供商”以连接提供商并获得可用模型。",
            ),
      notice:
        connectedProviderCount > 0
          ? {
              title: t("No models available", "无可用模型"),
              description: t(
                "All available models are currently disabled. Open Settings > Models to enable models.",
                "当前所有可用模型都已禁用。打开“设置 > 模型”以启用模型。",
              ),
              actionLabel: t("Open Settings > Models", "打开“设置 > 模型”"),
              actionSection: "models",
            }
          : {
              title: t("No models available", "无可用模型"),
              description: t(
                "Connect a provider in Settings > Providers before choosing a model or setting a default.",
                "请先在“设置 > 提供商”中连接提供商，然后再选择模型或设置默认模型。",
              ),
              actionLabel: t("Open Settings > Providers", "打开“设置 > 提供商”"),
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: t("Choose model", "选择模型"),
      emptyModelTitle: t("No models available", "无可用模型"),
      emptyModelDescription: t("Choose a model.", "请选择模型。"),
      notice: {
        title: t("Selected model unavailable", "所选模型不可用"),
        description: hasDefaultModel
          ? t(
              "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to update the default.",
              "为本会话选择的模型已不可用。请另选一个模型，然后打开“设置 > 模型”更新默认模型。",
            )
          : t(
              "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to choose the app default.",
              "为本会话选择的模型已不可用。请另选一个模型，然后打开“设置 > 模型”选择应用默认模型。",
            ),
        actionLabel: t("Open Settings > Models", "打开“设置 > 模型”"),
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("Choose model", "选择模型"),
      emptyModelTitle: t("No default model set", "未设置默认模型"),
      emptyModelDescription: t("Choose a model.", "请选择模型。"),
      notice: currentSelectionUsable
        ? undefined
        : {
            title: t("No default model set", "未设置默认模型"),
            description: t(
              "Set a default model in Settings > Models.",
              "请在“设置 > 模型”中设置默认模型。",
            ),
            actionLabel: t("Open Settings > Models", "打开“设置 > 模型”"),
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("Choose model", "选择模型"),
      emptyModelTitle: t("Default model unavailable", "默认模型不可用"),
      emptyModelDescription: t("Choose a model.", "请选择模型。"),
      notice: {
        title: t("Default model unavailable", "默认模型不可用"),
        description: currentSelectionUsable
          ? t(
              `Your saved default (${defaultLabel}) is no longer available. Open Settings > Models to update it.`,
              `你保存的默认模型（${defaultLabel}）已不可用。打开“设置 > 模型”以更新。`,
            )
          : t(
              `Your saved default (${defaultLabel}) is no longer available. Choose a model for this thread, then open Settings > Models to update it.`,
              `你保存的默认模型（${defaultLabel}）已不可用。请为本会话选择一个模型，然后打开“设置 > 模型”以更新。`,
            ),
        actionLabel: t("Open Settings > Models", "打开“设置 > 模型”"),
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: t("Choose model", "选择模型"),
    emptyModelTitle: t("No models available", "无可用模型"),
    emptyModelDescription: t("Choose a model.", "请选择模型。"),
  };
}

function isUsableSelection(
  selection: ModelSelectionInput,
  selectableSet: ReadonlySet<string>,
): boolean {
  return Boolean(
    selection.provider &&
    selection.modelId &&
    selectableSet.has(`${selection.provider}:${selection.modelId}`),
  );
}
