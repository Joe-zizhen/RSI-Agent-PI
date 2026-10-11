import type { AppLocale } from "../contracts/desktop-state";
import { getLocale, setLocale as setSharedLocale, t } from "../contracts/t";

export { getLocale, t };

/**
 * Main-process interface language. The persisted locale is cached here after
 * startup and on every change; `applyLocale` also mirrors it into
 * `process.env.RSI_LOCALE` so spawned children (the memloop sidecar, plugins)
 * see it. Shared contract strings read the same locale through `contracts/t`.
 */
setSharedLocale(normalizeLocale(process.env.RSI_LOCALE));

function normalizeLocale(value: string | undefined): AppLocale {
  return value === "en" ? "en" : "zh";
}

/** Applies a locale to this process and to children spawned from it. */
export function applyLocale(next: AppLocale): void {
  setSharedLocale(next);
  process.env.RSI_LOCALE = next;
}
