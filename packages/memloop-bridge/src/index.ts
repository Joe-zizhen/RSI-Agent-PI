/**
 * memloop long-term memory for RSI-Agent-PI.
 *
 * The extension factory hooks the agent lifecycle to the memloop Python
 * sidecar: memory injection, guard hits, event capture, and episode verdicts.
 * Register it as a `BuiltinExtension` so Settings → 记忆 can switch it off.
 */

export { default as memloopExtensionFactory } from "./memloop.ts";
export type {
  ClaimRegistry,
  GuardResult,
  MemloopSidecarOptions,
  RetrievedClaim,
  RunDreamResult,
  UsedClaim,
} from "./sidecar.ts";
export { MemloopSidecar, createClaimRegistry, discoverPython } from "./sidecar.ts";
