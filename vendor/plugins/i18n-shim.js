"use strict";

/**
 * Shared bilingual string helper for bundled pi plugins.
 *
 * `t(en, zh)` returns the English string when `process.env.RSI_LOCALE` is
 * `"en"`, and the Chinese string otherwise (default `"zh"`). The RSI-Agent-PI
 * desktop app writes `RSI_LOCALE` from the persisted interface language before
 * it spawns plugin hosts and the memloop sidecar.
 *
 * Written as CommonJS so both `require` and ESM `import` can load it; every
 * bundled plugin package is ESM (`"type": "module"`) and imports it through
 * Node's CJS interop: `import { t } from ".../i18n-shim.js"`.
 */
function t(en, zh) {
  return process.env.RSI_LOCALE === "en" ? en : zh;
}

module.exports = { t };
