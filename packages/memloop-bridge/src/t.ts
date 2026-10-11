/**
 * Shared bilingual string helper for the memloop bridge.
 *
 * Mirrors vendor/plugins/i18n-shim.js (same semantics): `t(en, zh)` returns the
 * English string when `process.env.RSI_LOCALE` is `"en"`, and the Chinese string
 * otherwise (default `"zh"`). The desktop app writes `RSI_LOCALE` before it
 * spawns the memloop sidecar host.
 *
 * Kept as a local copy so the package stays self-contained (no cross-package
 * import into vendor/).
 */
export function t(en: string, zh: string): string {
  return process.env.RSI_LOCALE === "en" ? en : zh;
}
