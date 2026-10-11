import type { ReactNode } from "react";
import type {
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@rsi-agent-pi/session-driver/runtime-types";
import { t } from "../../t";

export const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function labelForThinking(
  level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
): string {
  if (level === "xhigh") {
    return "Extra High";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function filterProviders(
  providers: readonly RuntimeSnapshot["providers"][number][],
  query: string,
): readonly RuntimeSnapshot["providers"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return providers;
  }
  return providers.filter((provider) =>
    [provider.id, provider.name, provider.authType].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function filterModels(
  models: readonly RuntimeSnapshot["models"][number][],
  query: string,
): readonly RuntimeSnapshot["models"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }
  return models.filter((model) =>
    [model.providerId, model.providerName, model.modelId, model.label].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

/* ── Layout components ────────────────────────────────── */

export function SettingsGroup({
  title,
  description,
  plain = false,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  /** Lay children out without the rounded card, for tiles and other custom content. */
  readonly plain?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-section">
      {title ? <h3 className="settings-section__title">{title}</h3> : null}
      {description ? <p className="settings-section__description">{description}</p> : null}
      {plain ? children : <div className="settings-group">{children}</div>}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{title}</div>
        {description ? <div className="settings-row__description">{description}</div> : null}
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

export function ProviderRow({
  provider,
  onLoginProvider,
  onLogoutProvider,
  onConfigureApiKey,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void;
}) {
  const actions = resolveProviderActions(
    provider,
    onLoginProvider,
    onLogoutProvider,
    onConfigureApiKey,
  );
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{provider.name}</div>
        <div className="settings-row__description">{describeProviderStatus(provider)}</div>
      </div>
      {actions.length > 0 ? (
        <div className="settings-row__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className="button button--secondary"
              disabled={action.disabled}
              type="button"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function describeProviderStatus(provider: RuntimeSnapshot["providers"][number]): string {
  switch (provider.authSource) {
    case "oauth":
      return t("OAuth · connected", "OAuth · 已连接");
    case "auth_file":
      return t("API key · connected", "API key · 已连接");
    case "env":
      return t("Environment variable · connected", "环境变量 · 已连接");
    case "external":
      return provider.hasAuth
        ? t("Configured externally · connected", "外部配置 · 已连接")
        : t("Configure externally", "在外部配置");
    default:
      if (provider.oauthSupported) {
        return provider.apiKeySetupSupported ? t("OAuth or API key", "OAuth 或 API key") : "OAuth";
      }
      if (provider.apiKeySetupSupported) {
        return "API key";
      }
      return provider.authType === "api_key" ? "API key" : t("Built in", "内置");
  }
}

interface ProviderAction {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick?: () => void;
}

/** A provider with both sign-in and API keys (OpenAI, OpenRouter, xAI) offers both until connected. */
function resolveProviderActions(
  provider: RuntimeSnapshot["providers"][number],
  onLoginProvider: (providerId: string) => void,
  onLogoutProvider: (providerId: string) => void,
  onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void,
): readonly ProviderAction[] {
  if (provider.authSource === "oauth") {
    return [
      {
        disabled: false,
        label: t("Logout", "退出登录"),
        onClick: () => onLogoutProvider(provider.id),
      },
    ];
  }

  const actions: ProviderAction[] = [];
  if (provider.oauthSupported && provider.authSource === "none") {
    actions.push({
      disabled: false,
      label: t("Login", "登录"),
      onClick: () => onLoginProvider(provider.id),
    });
  }
  if (
    provider.apiKeySetupSupported &&
    (provider.authSource === "none" || provider.authSource === "auth_file")
  ) {
    actions.push({
      disabled: false,
      label:
        provider.authSource === "auth_file"
          ? t("Manage", "管理")
          : t("Set an API key", "设置 API key"),
      onClick: () => onConfigureApiKey(provider),
    });
  }
  if (actions.length > 0 || provider.authSource === "env" || provider.authSource === "external") {
    return actions;
  }

  return [{ disabled: true, label: t("Configure externally", "在外部配置") }];
}
