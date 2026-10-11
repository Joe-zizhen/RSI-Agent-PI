import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { WorkspaceRecord, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { sessionLastInteractedAt } from "../../../contracts/thread-recency";
import { formatRelativeTime } from "../../lib/string-utils";
import { ChatIcon, FileIcon, FolderIcon, ModelIcon } from "../../ui/icons";
import type { ComposerModelOption } from "../conversation/composer-commands";
import type { ThreadListEntry } from "../threads/thread-groups";
import { CommandPalette, type PaletteSection } from "./command-palette";
import { rankPaths } from "./fuzzy-match";
import type { PaletteAction, PaletteMode } from "./palette-actions";
import {
  buildCommandSections,
  buildFileSections,
  buildListSection,
  COMMAND_FILTERS,
  FILE_RESULT_LIMIT,
  splitPath,
  type CommandFilter,
  type PaletteCandidate,
} from "./palette-sections";

export interface PaletteFileScope {
  readonly workspaceId: string;
  readonly label: string;
  readonly openTabs: readonly string[];
}

export interface PaletteModelScope {
  readonly options: readonly ComposerModelOption[];
  readonly currentProvider?: string;
  readonly currentModelId?: string;
}

/** Mount one per mode (key it by mode) so each list starts with an empty query. */
interface CommandPaletteSurfaceProps {
  readonly api: PiDesktopApi;
  readonly mode: PaletteMode;
  readonly onModeChange: (mode: PaletteMode) => void;
  readonly onClose: () => void;
  /** Unarchived threads across every workspace, most recently used first. */
  readonly threads: readonly ThreadListEntry[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly currentThread?: WorkspaceSessionTarget;
  readonly actions: readonly PaletteAction[];
  /** Present when a thread is open; Cmd-P searches its workspace. */
  readonly fileScope?: PaletteFileScope;
  readonly modelScope?: PaletteModelScope;
  readonly onOpenThread: (target: WorkspaceSessionTarget) => void;
  readonly onOpenWorkspace: (workspaceId: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onSelectModel: (provider: string, modelId: string) => void;
}

type FileListing =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly files: readonly string[] }
  | { readonly status: "error" };

export function CommandPaletteSurface({
  api,
  mode,
  onModeChange,
  onClose,
  threads,
  workspaces,
  currentThread,
  actions,
  fileScope,
  modelScope,
  onOpenThread,
  onOpenWorkspace,
  onOpenFile,
  onSelectModel,
}: CommandPaletteSurfaceProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CommandFilter>("all");
  const [listing, setListing] = useState<FileListing>({ status: "loading" });
  const fileWorkspaceId = fileScope?.workspaceId;
  const files = listing.status === "ready" ? listing.files : undefined;
  // Ranking a large tree can take tens of milliseconds; keep typing responsive.
  const fileQuery = useDeferredValue(query);
  const rankedFiles = useMemo(
    () => (mode === "files" && files ? rankPaths(files, fileQuery, FILE_RESULT_LIMIT) : []),
    [fileQuery, files, mode],
  );

  useEffect(() => {
    if (mode !== "files" || !fileWorkspaceId) {
      return undefined;
    }
    let current = true;
    setListing({ status: "loading" });
    void api
      .listWorkspaceFiles(fileWorkspaceId)
      .then((files) => {
        if (current) setListing({ status: "ready", files });
      })
      .catch((error: unknown) => {
        console.error("[renderer] listWorkspaceFiles failed", error);
        if (current) setListing({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [api, fileWorkspaceId, mode]);

  // Cheap for hundreds of threads; only the file ranking is memoized.
  const chatCandidates: readonly PaletteCandidate[] = threads.map((thread) => {
    const target = { workspaceId: thread.workspaceId, sessionId: thread.session.id };
    const isCurrent =
      currentThread?.workspaceId === target.workspaceId &&
      currentThread.sessionId === target.sessionId;
    return {
      id: `chat:${target.workspaceId}:${target.sessionId}`,
      title: thread.session.title,
      detail: [thread.contextLabel, formatRelativeTime(sessionLastInteractedAt(thread.session))]
        .filter(Boolean)
        .join(" · "),
      icon: <ChatIcon />,
      hint: isCurrent ? "当前" : thread.session.status === "running" ? "运行中" : undefined,
      run: () => {
        onClose();
        onOpenThread(target);
      },
    };
  });

  const workspaceCandidates: readonly PaletteCandidate[] = workspaces.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    title: workspace.name,
    detail: workspace.path,
    icon: <FolderIcon />,
    run: () => {
      onClose();
      onOpenWorkspace(workspace.id);
    },
  }));

  const actionCandidates: readonly PaletteCandidate[] = actions.map((action) => ({
    id: `action:${action.id}`,
    title: action.title,
    icon: action.icon,
    hint: action.hint,
    run: () => {
      if (!action.keepsOpen) onClose();
      action.run();
    },
  }));

  let label: string;
  let placeholder: string;
  let sections: readonly PaletteSection[];
  let emptyText: string;
  if (mode === "files") {
    label = "转到文件";
    placeholder = fileScope ? `在 ${fileScope.label} 中搜索文件` : "搜索文件";
    sections =
      fileScope && files
        ? buildFileSections({
            query: fileQuery,
            ranked: rankedFiles,
            openTabs: fileScope.openTabs,
            toCandidate: (path) => {
              const { name, directory } = splitPath(path);
              return {
                id: `file:${path}`,
                title: name,
                detail: directory || undefined,
                icon: <FileIcon />,
                run: () => {
                  onClose();
                  onOpenFile(path);
                },
              };
            },
          })
        : [];
    emptyText = !fileScope
      ? "打开一个会话以搜索其文件。"
      : listing.status === "loading"
        ? "正在加载文件…"
        : listing.status === "error"
          ? "无法加载文件。"
          : query !== fileQuery
            ? "正在搜索…"
            : query.trim()
              ? "没有匹配的文件。"
              : `输入内容以搜索 ${(files?.length ?? 0).toLocaleString()} 个文件。`;
  } else if (mode === "models") {
    label = "切换模型";
    placeholder = "切换模型";
    sections = buildListSection({
      id: "models",
      label: "模型",
      query,
      candidates: (modelScope?.options ?? []).map((option) => ({
        id: `model:${option.providerId}/${option.modelId}`,
        title: option.label,
        icon: <ModelIcon />,
        hint:
          option.providerId === modelScope?.currentProvider &&
          option.modelId === modelScope.currentModelId
            ? "当前"
            : undefined,
        run: () => {
          onClose();
          onSelectModel(option.providerId, option.modelId);
        },
      })),
    });
    emptyText = modelScope?.options.length ? "没有匹配的模型。" : "没有可用的模型。";
  } else {
    label = "命令面板";
    placeholder = "搜索会话、项目和操作";
    sections = buildCommandSections({
      query,
      filter,
      chats: chatCandidates,
      workspaces: workspaceCandidates,
      actions: actionCandidates,
    });
    emptyText = query.trim() ? "没有匹配项。" : "这里还没有内容。";
  }

  return (
    <CommandPalette
      activeFilter={mode === "commands" ? filter : undefined}
      emptyText={emptyText}
      filters={mode === "commands" ? COMMAND_FILTERS : undefined}
      label={label}
      placeholder={placeholder}
      query={query}
      sections={sections}
      settling={mode === "files" && query !== fileQuery}
      onBack={mode === "models" ? () => onModeChange("commands") : undefined}
      onClose={onClose}
      onFilterChange={setFilter}
      onQueryChange={setQuery}
    />
  );
}
