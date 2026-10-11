import { useSyncExternalStore } from "react";
import type { AppLocale } from "../contracts/desktop-state";
import { setLocale as setContractsLocale } from "../contracts/t";

/**
 * Renderer locale store. Main pushes the persisted locale on every app-state
 * snapshot (see `useDesktopAppState`); `t` reads the store so a language switch
 * shows up as soon as the tree re-renders.
 */
let locale: AppLocale = "zh";
const listeners = new Set<() => void>();

export function getLocale(): AppLocale {
  return locale;
}

export function setLocale(next: AppLocale): void {
  setContractsLocale(next);
  if (locale === next) {
    return;
  }
  locale = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the calling component whenever the locale changes. */
export function useLocale(): AppLocale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "zh" as AppLocale);
}

export function t(en: string, zh: string): string {
  return locale === "en" ? en : zh;
}
