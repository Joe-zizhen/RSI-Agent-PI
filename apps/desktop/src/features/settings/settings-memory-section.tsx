import { useEffect, useState } from "react";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsMemorySectionProps {
  readonly workspaceId: string;
  /** The built-in memloop extension's gate; on by default. */
  readonly memoryEnabled: boolean;
  readonly onToggleMemory: (enabled: boolean) => void;
}

export function SettingsMemorySection({
  workspaceId,
  memoryEnabled,
  onToggleMemory,
}: SettingsMemorySectionProps) {
  const [loaded, setLoaded] = useState<
    { readonly workspaceId: string; readonly verdictCmd: string } | undefined
  >();
  const verdictCmd = loaded?.workspaceId === workspaceId ? loaded.verdictCmd : "";
  const [verdictDraft, setVerdictDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const api = window.piApp;
    if (!api) return;
    let cancelled = false;
    api
      .getMemloopSettings(workspaceId)
      .then((next) => {
        if (cancelled) return;
        setLoaded({ workspaceId, verdictCmd: next.verdictCmd });
        setVerdictDraft(next.verdictCmd);
        setDraftDirty(false);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(String(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const commitVerdictDraft = () => {
    if (!draftDirty || verdictDraft === verdictCmd) return;
    const api = window.piApp;
    if (!api) return;
    api
      .setMemloopSettings(workspaceId, verdictDraft)
      .then(() => {
        setLoaded({ workspaceId, verdictCmd: verdictDraft.trim() });
        setVerdictDraft(verdictDraft.trim());
        setDraftDirty(false);
        setError(undefined);
      })
      .catch((saveError: unknown) => setError(String(saveError)));
  };

  return (
    <SettingsGroup title="记忆">
      {error ? (
        <div className="settings-row">
          <span className="settings-row__description settings-warning">{error}</span>
        </div>
      ) : null}
      <SettingsRow
        title="启用记忆"
        description="开启后，自动捕获会话经验，在任务开始时注入相关记忆，并对已验证的失败模式发出提醒或拦截。"
      >
        <SettingsSwitch checked={memoryEnabled} label="启用记忆" onChange={onToggleMemory} />
      </SettingsRow>
      <SettingsRow
        title="verdictCmd 世界判决命令"
        description="会话结束时运行的判决命令。退出码 0 记为成功，非 0 记为失败。留空表示不判决。"
      >
        <input
          aria-label="verdictCmd 世界判决命令"
          className="settings-text-input"
          placeholder="npm test"
          spellCheck={false}
          type="text"
          value={verdictDraft}
          onBlur={commitVerdictDraft}
          onChange={(event) => {
            setVerdictDraft(event.target.value);
            setDraftDirty(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
