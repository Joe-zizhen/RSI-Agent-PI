/**
 * Faux model provider for pi session integration tests.
 *
 * Registers a scripted chat model `faux/faux-1` so a real pi session (agent
 * loop, hooks, tools, extension commands) runs with no network and no API
 * key. Responses are replayed from a canned script; every request's
 * transcript is appended to MEMLOOP_FAUX_DUMP for the test driver to assert
 * on (memory block injection, L2 block reasons).
 *
 * Env:
 *   MEMLOOP_FAUX_SCENARIO  "text" (default): one final text reply.
 *                          "tool": bash tool call `pytest`, then text reply.
 *                          "fail-fix": bash X (fails), bash Y (succeeds), text.
 *   MEMLOOP_FAUX_DUMP      file to append request transcripts to.
 *
 * Loaded with: pi --mode rpc -e test/faux-model-ext.ts -e ../memloop.ts ...
 */

import { appendFileSync } from "node:fs";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fauxModelExt(pi: ExtensionAPI): void {
  const faux = registerFauxProvider();
  pi.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://localhost:0",
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning ?? false,
      input: m.input,
      inputLimits: m.inputLimits,
      cost: m.cost,
      contextWindow: m.contextWindow ?? 64000,
      maxTokens: m.maxTokens ?? 4096,
      baseUrl: m.baseUrl,
    })),
  });

  const dumpPath = process.env.MEMLOOP_FAUX_DUMP;
  const dump = (context: TranscriptContext): void => {
    if (dumpPath === undefined || dumpPath === "") return;
    appendFileSync(
      dumpPath,
      `${JSON.stringify(context.messages, null, 1)}\n===FAUX-REQUEST===\n`,
      "utf8",
    );
  };

  const scenario = process.env.MEMLOOP_FAUX_SCENARIO ?? "text";
  if (scenario === "tool") {
    faux.setResponses([
      (context) => {
        dump(context);
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: "pytest" }, { id: "faux-tool-1" }),
        ]);
      },
      (context) => {
        dump(context);
        return fauxAssistantMessage("完成");
      },
    ]);
  } else if (scenario === "fail-fix") {
    // Bash command X fails, then bash command Y succeeds in the same task:
    // memloop.ts's tool_result pairing must cut one card with
    // match_pattern=X and verify_cmd=Y (never X as the verify target).
    faux.setResponses([
      (context) => {
        dump(context);
        return fauxAssistantMessage([
          fauxToolCall(
            "bash",
            { command: "memloop-pairing-missing-cmd" },
            { id: "faux-tool-fail" },
          ),
        ]);
      },
      (context) => {
        dump(context);
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: "echo memloop-pairing-fixed" }, { id: "faux-tool-fix" }),
        ]);
      },
      (context) => {
        dump(context);
        return fauxAssistantMessage("配对完成。");
      },
    ]);
  } else {
    faux.setResponses([
      (context) => {
        dump(context);
        return fauxAssistantMessage("已根据记忆完成任务。");
      },
    ]);
  }
}
