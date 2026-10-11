import { useCallback, useEffect, useState } from "react";
import type {
  McpServerRecord,
  McpServerScope,
  McpServersSnapshot,
  NewMcpServerInput,
} from "../../../contracts/ipc";
import { SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { t, useLocale } from "../../t";

/** Each returns the error to show, or undefined when the change was saved. */
export interface McpSettingsActions {
  readonly onAddServer: (server: NewMcpServerInput) => Promise<string | undefined>;
  readonly onRemoveServer: (name: string) => Promise<string | undefined>;
  readonly onSetServerEnabled: (
    scope: McpServerScope,
    name: string,
    enabled: boolean,
  ) => Promise<string | undefined>;
  readonly onSetCodemodeAlwaysOn: (alwaysOn: boolean) => Promise<string | undefined>;
}

interface SettingsMcpSectionProps {
  readonly workspaceId: string;
  readonly actions: McpSettingsActions;
}

export function SettingsMcpSection({ workspaceId, actions }: SettingsMcpSectionProps) {
  useLocale();
  // Tagged with its workspace: after a switch, the old list (whose buttons would act on the new
  // workspace) is gone at once, until the new one loads.
  const [loaded, setLoaded] = useState<
    { readonly workspaceId: string; readonly snapshot: McpServersSnapshot } | undefined
  >();
  const snapshot = loaded?.workspaceId === workspaceId ? loaded.snapshot : undefined;
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setError(undefined), [workspaceId]);

  // pi in the terminal may have edited mcp.json while the app was in the background.
  useEffect(() => window.piApp?.onWindowFocused(() => setReloadKey((key) => key + 1)), []);

  useEffect(() => {
    const api = window.piApp;
    if (!api) return;
    let cancelled = false;
    api
      .listMcpServers(workspaceId)
      .then((next) => {
        if (!cancelled) setLoaded({ workspaceId, snapshot: next });
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorText(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadKey]);

  /** Runs one change, shows its error, and re-reads the files either way. */
  const apply = useCallback(async (change: () => Promise<string | undefined>) => {
    setPending(true);
    try {
      const failure = await change();
      setError(failure);
      return failure;
    } catch (changeError) {
      const failure = errorText(changeError);
      setError(failure);
      return failure;
    } finally {
      setPending(false);
      setReloadKey((key) => key + 1);
    }
  }, []);

  const run = useCallback(
    (change: () => Promise<string | undefined>) => {
      apply(change).catch((changeError: unknown) => setError(errorText(changeError)));
    },
    [apply],
  );

  const servers = snapshot?.servers ?? [];
  const problems = [...(error ? [error] : []), ...(snapshot?.errors ?? [])];
  const globalConfigPath =
    snapshot?.globalConfigPath ?? t("pi's global mcp.json", "pi 的全局 mcp.json");

  return (
    <>
      <SettingsGroup
        title={t("Servers", "服务器")}
        description={t(
          `Shared with pi in the terminal: ${globalConfigPath}, plus this project's .pi/mcp.json.`,
          `与终端里的 pi 共用：${globalConfigPath}，以及本项目的 .pi/mcp.json。`,
        )}
      >
        {problems.map((problem) => (
          <div className="settings-row" key={problem}>
            <span className="settings-row__description settings-warning">{problem}</span>
          </div>
        ))}
        {snapshot && servers.length === 0 ? (
          <div className="settings-row" data-testid="mcp-servers-empty">
            <span className="settings-row__description">
              {t(
                `No MCP servers yet. Servers come from ${globalConfigPath}, and the pi in your terminal uses the same file. Connection status and sign-in are shown in a session: type /mcp.`,
                `暂无 MCP 服务器。服务器来自 ${globalConfigPath}，终端里的 pi 也使用该文件。连接状态与登录情况在会话中查看：输入 /mcp。`,
              )}
            </span>
          </div>
        ) : null}
        {servers.map((server) => (
          <McpServerRow
            disabled={pending}
            key={`${server.scope}:${server.name}`}
            server={server}
            onRemove={() => {
              if (window.confirm(removeServerQuestion(server))) {
                run(() => actions.onRemoveServer(server.name));
              }
            }}
            onToggle={(enabled) =>
              run(() => actions.onSetServerEnabled(server.scope, server.name, enabled))
            }
          />
        ))}
      </SettingsGroup>

      <AddMcpServerForm
        configPath={globalConfigPath}
        disabled={pending}
        onAdd={(server) => apply(() => actions.onAddServer(server))}
      />

      <SettingsGroup title={t("Code mode", "代码模式")}>
        <SettingsRow
          title={t("Always on", "始终开启")}
          description={t(
            "Lets the model run scripts that call tools. Turning it on also applies to open threads; turning it off applies to new threads. Off, pi turns it on when an MCP server needs it.",
            "允许模型运行调用工具的脚本。开启后对已打开的会话同样生效；关闭后仅对新建会话生效。关闭时，pi 会在 MCP 服务器需要时自动开启。",
          )}
        >
          <SettingsSwitch
            checked={snapshot?.codemodeAlwaysOn ?? false}
            disabled={pending || !snapshot}
            label={t("Code mode always on", "始终开启代码模式")}
            onChange={(alwaysOn) => run(() => actions.onSetCodemodeAlwaysOn(alwaysOn))}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function McpServerRow({
  server,
  disabled,
  onToggle,
  onRemove,
}: {
  readonly server: McpServerRecord;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  useLocale();
  const target =
    server.transport === "http"
      ? (server.url ?? "")
      : [server.command ?? "", ...(server.args ?? []).map(quoteArgument)].join(" ");
  return (
    <div className="settings-row" data-testid="mcp-server-row" data-server-name={server.name}>
      <div className="settings-row__label">
        <div className="settings-row__title">{server.name}</div>
        {server.description ? (
          <div className="settings-row__description">{server.description}</div>
        ) : null}
        <div className="settings-row__description">
          {server.scope === "project"
            ? t(`This project · ${target}`, `本项目 · ${target}`)
            : target}
        </div>
      </div>
      <div className="settings-row__actions">
        {server.scope === "global" ? (
          <button
            className="button button--secondary"
            disabled={disabled}
            type="button"
            onClick={onRemove}
          >
            {t("Remove", "移除")}
          </button>
        ) : null}
        <SettingsSwitch
          checked={server.enabled}
          disabled={disabled}
          label={t(`Enable ${server.name}`, `启用 ${server.name}`)}
          onChange={onToggle}
        />
      </div>
    </div>
  );
}

/** Removing deletes the whole entry, including the settings the list never shows. */
export function removeServerQuestion(server: McpServerRecord): string {
  const question = t(
    `Remove the MCP server “${server.name}”? The pi in your terminal stops using it too.`,
    `移除 MCP 服务器“${server.name}”？终端里的 pi 也会停止使用它。`,
  );
  return server.hasHiddenSettings
    ? t(
        `${question} Its hidden settings (environment variables, headers, sign-in config) are deleted too.`,
        `${question} 其隐藏设置（环境变量、请求头、登录配置）也会被删除。`,
      )
    : question;
}

type ServerKind = "command" | "url";

function AddMcpServerForm({
  configPath,
  disabled,
  onAdd,
}: {
  readonly configPath: string;
  readonly disabled: boolean;
  readonly onAdd: (server: NewMcpServerInput) => Promise<string | undefined>;
}) {
  useLocale();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ServerKind>("command");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");

  const ready = name.trim() !== "" && (kind === "command" ? command.trim() : url.trim()) !== "";

  const submit = async () => {
    const named = description.trim()
      ? { name: name.trim(), description: description.trim() }
      : { name: name.trim() };
    const server: NewMcpServerInput =
      kind === "command"
        ? { ...named, command: command.trim(), args: splitArguments(args) }
        : { ...named, url: url.trim() };
    if (!(await onAdd(server))) {
      setName("");
      setDescription("");
      setCommand("");
      setArgs("");
      setUrl("");
    }
  };

  return (
    <SettingsGroup
      title={t("Add server", "添加服务器")}
      description={t(`Saved to ${configPath}.`, `保存到 ${configPath}。`)}
    >
      <SettingsRow title={t("Name", "名称")}>
        <input
          aria-label={t("Server name", "服务器名称")}
          className="settings-text-input"
          disabled={disabled}
          placeholder="docs"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        title={t("What it does", "用途说明")}
        description={t(
          "Optional. pi tells the model about the server with it.",
          "可选。pi 会用它向模型介绍该服务器。",
        )}
      >
        <input
          aria-label={t("Server description", "服务器说明")}
          className="settings-text-input"
          disabled={disabled}
          placeholder={t("Searches the team's docs", "搜索团队文档")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow title={t("Type", "类型")}>
        <SettingsSegmented<ServerKind>
          label={t("Server type", "服务器类型")}
          options={[
            { value: "command", label: t("Command", "命令") },
            { value: "url", label: "URL" },
          ]}
          value={kind}
          onChange={setKind}
        />
      </SettingsRow>
      {kind === "command" ? (
        <>
          <SettingsRow
            title={t("Command", "命令")}
            description={t("Started on this machine for each thread.", "在本机为每个会话启动。")}
          >
            <input
              aria-label={t("Server command", "服务器命令")}
              className="settings-text-input"
              disabled={disabled}
              placeholder="npx"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            title={t("Arguments", "参数")}
            description={t(
              "Separated by spaces; quote an argument that contains spaces.",
              "以空格分隔；含空格的参数请加引号。",
            )}
          >
            <input
              aria-label={t("Server arguments", "服务器参数")}
              className="settings-text-input"
              disabled={disabled}
              placeholder="-y @modelcontextprotocol/server-filesystem ."
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </SettingsRow>
        </>
      ) : (
        <SettingsRow
          title="URL"
          description={t(
            "A streamable HTTP server. If it needs a sign-in, type /mcp login in a thread.",
            "可流式传输的 HTTP 服务器。如需登录，请在会话中输入 /mcp login。",
          )}
        >
          <input
            aria-label={t("Server URL", "服务器 URL")}
            className="settings-text-input"
            disabled={disabled}
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </SettingsRow>
      )}
      <div className="settings-row">
        <span className="settings-row__description">
          {t(
            "Open threads reload to start it. Add env or headers in the file itself.",
            "已打开的会话会重新加载以启动它。环境变量或请求头请在文件中自行添加。",
          )}
        </span>
        <div className="settings-row__control">
          <button
            className="button"
            disabled={disabled || !ready}
            type="button"
            onClick={() => {
              submit().catch(() => undefined);
            }}
          >
            {t("Add server", "添加服务器")}
          </button>
        </div>
      </div>
    </SettingsGroup>
  );
}

/** Splits on spaces, keeping quoted parts ("a b" or 'a b') together. */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function quoteArgument(arg: string): string {
  return arg === "" || /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
