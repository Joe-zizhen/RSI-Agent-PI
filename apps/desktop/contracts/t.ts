import type { AppLocale } from "./desktop-state";

/**
 * Locale for copy defined in shared contracts (renderer-reachable helpers).
 * The main process applies the persisted locale through `electron/t.ts`, which
 * delegates here. The renderer keeps its own reactive store in `src/t.ts` and
 * should forward its changes here so contract strings follow the interface
 * language.
 */
let locale: AppLocale = "zh";

export function t(en: string, zh: string): string {
  return locale === "en" ? en : zh;
}

export function getLocale(): AppLocale {
  return locale;
}

export function setLocale(next: AppLocale): void {
  locale = next;
}
