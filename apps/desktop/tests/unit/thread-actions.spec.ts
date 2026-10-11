import { expect, test } from "@playwright/test";
import type { SessionRecord } from "../../contracts/desktop-state";
import {
  buildThreadActions,
  type ThreadActionHandlers,
} from "../../src/features/threads/thread-actions";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    title: "Thread",
    updatedAt: "2026-09-23T00:00:00.000Z",
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...overrides,
  };
}

function handlers(
  platform: NodeJS.Platform,
  scheduled = false,
): ThreadActionHandlers & { readonly calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    platform,
    hasScheduledTask: () => scheduled,
    startRename: record("rename"),
    setPinned: (_subject, pinned) => calls.push(`pin:${pinned}`),
    archive: record("archive"),
    restore: record("restore"),
    markRead: record("mark-read"),
    openScheduledTask: record("scheduled"),
    copySessionId: record("copy"),
  };
}

function titles(actions: readonly { readonly title: string }[]): string[] {
  return actions.map((action) => action.title);
}

test("an open thread lists rename, pin, archive, scheduled task and copy with shortcut hints", () => {
  const actions = buildThreadActions({ workspaceId: "ws", session: session() }, handlers("darwin"));
  expect(titles(actions)).toEqual([
    "重命名会话",
    "置顶会话",
    "归档会话",
    "添加计划任务…",
    "复制会话记录 ID",
  ]);
  expect(actions.find((action) => action.id === "rename-thread")?.hint).toBe("⇧⌘R");
  expect(actions.find((action) => action.id === "archive-thread")?.hint).toBe("⇧⌘A");
  const linux = buildThreadActions({ workspaceId: "ws", session: session() }, handlers("linux"));
  expect(linux.find((action) => action.id === "archive-thread")?.hint).toBe("Ctrl+Shift+A");
});

test("state changes the list: pinned, unseen, scheduled and archived threads", () => {
  const recorder = handlers("linux", true);
  const actions = buildThreadActions(
    { workspaceId: "ws", session: session({ pinnedAt: "x", hasUnseenUpdate: true }) },
    recorder,
  );
  expect(titles(actions)).toEqual([
    "重命名会话",
    "取消置顶会话",
    "归档会话",
    "标为已读",
    "编辑计划任务…",
    "复制会话记录 ID",
  ]);
  actions.find((action) => action.id === "pin-thread")?.run();
  expect(recorder.calls).toEqual(["pin:false"]);

  const archived = buildThreadActions(
    { workspaceId: "ws", session: session({ archivedAt: "x" }) },
    handlers("linux"),
  );
  expect(titles(archived)).toEqual(["重命名会话", "恢复会话", "添加计划任务…", "复制会话记录 ID"]);
  expect(archived.some((action) => action.id === "archive-thread")).toBe(false);
});
