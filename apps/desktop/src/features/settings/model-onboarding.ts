import type { RuntimeSnapshot } from "@rsi-agent-pi/session-driver/runtime-types";
import { buildModelOptions } from "../conversation/composer-commands";

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
      unselectedModelLabel: "无可用模型",
      emptyModelTitle: "无可用模型",
      emptyModelDescription:
        connectedProviderCount > 0
          ? "打开“设置 > 模型”以启用模型。"
          : "打开“设置 > 提供商”以连接提供商并获得可用模型。",
      notice:
        connectedProviderCount > 0
          ? {
              title: "无可用模型",
              description: "当前所有可用模型都已禁用。打开“设置 > 模型”以启用模型。",
              actionLabel: "打开“设置 > 模型”",
              actionSection: "models",
            }
          : {
              title: "无可用模型",
              description: "请先在“设置 > 提供商”中连接提供商，然后再选择模型或设置默认模型。",
              actionLabel: "打开“设置 > 提供商”",
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: "选择模型",
      emptyModelTitle: "无可用模型",
      emptyModelDescription: "请选择模型。",
      notice: {
        title: "所选模型不可用",
        description: hasDefaultModel
          ? "为本会话选择的模型已不可用。请另选一个模型，然后打开“设置 > 模型”更新默认模型。"
          : "为本会话选择的模型已不可用。请另选一个模型，然后打开“设置 > 模型”选择应用默认模型。",
        actionLabel: "打开“设置 > 模型”",
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: "选择模型",
      emptyModelTitle: "未设置默认模型",
      emptyModelDescription: "请选择模型。",
      notice: currentSelectionUsable
        ? undefined
        : {
            title: "未设置默认模型",
            description: "请在“设置 > 模型”中设置默认模型。",
            actionLabel: "打开“设置 > 模型”",
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: "选择模型",
      emptyModelTitle: "默认模型不可用",
      emptyModelDescription: "请选择模型。",
      notice: {
        title: "默认模型不可用",
        description: currentSelectionUsable
          ? `你保存的默认模型（${defaultLabel}）已不可用。打开“设置 > 模型”以更新。`
          : `你保存的默认模型（${defaultLabel}）已不可用。请为本会话选择一个模型，然后打开“设置 > 模型”以更新。`,
        actionLabel: "打开“设置 > 模型”",
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: "选择模型",
    emptyModelTitle: "无可用模型",
    emptyModelDescription: "请选择模型。",
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
