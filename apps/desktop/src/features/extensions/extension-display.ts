import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@rsi-agent-pi/session-driver/runtime-types";
import { t } from "../../t";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export function piGuiToolsLabel(): string {
  return t("RSI-Agent-PI tools", "RSI-Agent-PI 工具");
}
export function piAddonsLabel(): string {
  return t("Built into pi", "pi 内置");
}

/** Extensions pi-gui itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    extension.sourceInfo.source === "builtin" &&
    extension.sourceInfo.origin === "top-level" &&
    extension.sourceInfo.scope === "temporary"
  );
}

/**
 * pi's own add-ons (MCP, code mode, tool search), named `builtin:<name>`. Their switch writes
 * pi's `extensions` setting, so terminal pi follows it too.
 */
export function isPiAddonExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.path.startsWith("builtin:");
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  if (isPiGuiBuiltinExtension(extension)) return piGuiToolsLabel();
  if (isPiAddonExtension(extension)) return piAddonsLabel();
  return extension.sourceInfo.scope;
}

/** Group heading for where a skill or extension was discovered. */
export function sourceScopeGroupLabel(scope: RuntimeSourceScope): string {
  switch (scope) {
    case "project":
      return t("Project", "项目");
    case "user":
      return t("User", "用户");
    case "temporary":
      return t("This session", "本次会话");
  }
}

export function extensionGroupLabel(extension: RuntimeExtensionRecord): string {
  if (isPiGuiBuiltinExtension(extension)) return piGuiToolsLabel();
  if (isPiAddonExtension(extension)) return piAddonsLabel();
  return sourceScopeGroupLabel(extension.sourceInfo.scope);
}
