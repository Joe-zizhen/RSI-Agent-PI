/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { t } from "../plugins/i18n-shim.js";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: t("Dangerous command blocked (no UI available for confirmation)", "危险命令已被拦截（无 UI 可供确认）") };
			}

			const choice = await ctx.ui.select(t(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow it?`, `⚠️ 危险命令：\n\n  ${command}\n\n是否允许？`), [t("Yes", "是"), t("No", "否")]);

			if (choice !== t("Yes", "是")) {
				return { block: true, reason: t("Blocked by the user", "已被用户拦截") };
			}
		}

		return undefined;
	});
}
