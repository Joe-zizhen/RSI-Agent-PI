import type { ReactNode } from "react";
import type { SessionRecord } from "../../../contracts/desktop-state";
import { formatShortcut } from "../../../contracts/ipc";
import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  RestoreIcon,
} from "../../ui/icons";
import { t } from "../../t";

/**
 * The one list of things a thread can do. The thread header menu, the sidebar
 * row's right-click menu and the command palette all render this list, so they
 * cannot drift apart.
 */
export type ThreadActionId =
  | "rename-thread"
  | "pin-thread"
  | "archive-thread"
  | "restore-thread"
  | "mark-read"
  | "scheduled-task"
  | "copy-session-id";

export interface ThreadAction {
  readonly id: ThreadActionId;
  readonly title: string;
  readonly icon: ReactNode;
  readonly hint?: string;
  readonly run: () => void;
}

/** The thread an action applies to. Sidebar entries and the open thread both fit. */
export interface ThreadActionSubject {
  readonly workspaceId: string;
  readonly session: SessionRecord;
}

export interface ThreadActionHandlers {
  readonly platform: NodeJS.Platform;
  readonly hasScheduledTask: (subject: ThreadActionSubject) => boolean;
  readonly startRename: (subject: ThreadActionSubject) => void;
  readonly setPinned: (subject: ThreadActionSubject, pinned: boolean) => void;
  readonly archive: (subject: ThreadActionSubject) => void;
  readonly restore: (subject: ThreadActionSubject) => void;
  readonly markRead: (subject: ThreadActionSubject) => void;
  readonly openScheduledTask: (subject: ThreadActionSubject) => void;
  readonly copySessionId: (subject: ThreadActionSubject) => void;
}

export function renameThreadShortcut(platform: NodeJS.Platform): string {
  return formatShortcut(platform, "R", { shift: true });
}

export function archiveThreadShortcut(platform: NodeJS.Platform): string {
  return formatShortcut(platform, "A", { shift: true });
}

export function buildThreadActions(
  subject: ThreadActionSubject,
  handlers: ThreadActionHandlers,
): readonly ThreadAction[] {
  const { session } = subject;
  const archived = Boolean(session.archivedAt);
  const pinned = Boolean(session.pinnedAt);
  const actions: ThreadAction[] = [
    {
      id: "rename-thread",
      title: t("Rename thread", "重命名会话"),
      icon: <PencilIcon />,
      hint: renameThreadShortcut(handlers.platform),
      run: () => handlers.startRename(subject),
    },
  ];
  if (archived) {
    actions.push({
      id: "restore-thread",
      title: t("Restore thread", "恢复会话"),
      icon: <RestoreIcon />,
      run: () => handlers.restore(subject),
    });
  } else {
    actions.push(
      {
        id: "pin-thread",
        title: pinned ? t("Unpin thread", "取消置顶会话") : t("Pin thread", "置顶会话"),
        icon: <PinIcon filled={pinned} />,
        run: () => handlers.setPinned(subject, !pinned),
      },
      {
        id: "archive-thread",
        title: t("Archive thread", "归档会话"),
        icon: <ArchiveIcon />,
        hint: archiveThreadShortcut(handlers.platform),
        run: () => handlers.archive(subject),
      },
    );
  }
  if (session.hasUnseenUpdate) {
    actions.push({
      id: "mark-read",
      title: t("Mark as read", "标为已读"),
      icon: <CheckIcon />,
      run: () => handlers.markRead(subject),
    });
  }
  actions.push(
    {
      id: "scheduled-task",
      title: handlers.hasScheduledTask(subject)
        ? t("Edit scheduled task…", "编辑计划任务…")
        : t("Add scheduled task…", "添加计划任务…"),
      icon: <ClockIcon />,
      run: () => handlers.openScheduledTask(subject),
    },
    {
      id: "copy-session-id",
      title: t("Copy session ID", "复制会话记录 ID"),
      icon: <CopyIcon />,
      run: () => handlers.copySessionId(subject),
    },
  );
  return actions;
}

interface ThreadActionsMenuProps {
  readonly actions: readonly ThreadAction[];
  readonly className: string;
}

export function ThreadActionsMenu({ actions, className }: ThreadActionsMenuProps) {
  return (
    <div className={`workspace-menu ${className}`} role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          className="workspace-menu__item"
          data-thread-action={action.id}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            action.run();
          }}
        >
          <span>{action.title}</span>
          {action.hint ? (
            <span className="workspace-menu__shortcut" aria-hidden="true">
              {action.hint}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
