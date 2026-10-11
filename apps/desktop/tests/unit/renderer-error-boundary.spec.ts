import { expect, test } from "@playwright/test";
import {
  RendererErrorBoundary,
  rendererBoundaryCopy,
  startupSurfaceCopy,
} from "../../src/app/desktop-recovery";

const SENTINEL = "secret-token=/private/path";

test("startup copy switches on failure codes and never interpolates error text", () => {
  expect(startupSurfaceCopy({ kind: "loading" })).toEqual({
    title: "正在加载会话记录",
    body: "桌面外壳正在从主进程恢复文件夹和会话状态。",
    status: "loading",
  });
  expect(
    startupSurfaceCopy({
      kind: "failed",
      failure: { code: "state-request-failed" },
      retrying: false,
    }),
  ).toEqual({
    title: "无法恢复会话记录",
    body: "桌面外壳无法读取文件夹和会话状态。请重试，或重新启动应用。",
    status: "failed",
  });
  expect(
    startupSurfaceCopy({
      kind: "failed",
      failure: { code: "bridge-unavailable" },
      retrying: true,
    }).body,
  ).toContain("请退出 RSI-Agent-PI 并重新打开");
  expect(JSON.stringify(startupSurfaceCopy({ kind: "crashed" }))).not.toContain(SENTINEL);
});

test("error boundary derived state stores no thrown details", () => {
  const next = RendererErrorBoundary.getDerivedStateFromError(new Error(SENTINEL));
  expect(next).toEqual({ hasError: true });
  expect(JSON.stringify(next)).not.toContain("secret");
  expect(JSON.stringify(next)).not.toContain("/private/path");
});

test("crash fallback copy stays generic", () => {
  const copy = rendererBoundaryCopy();
  expect(copy.title).toBe("出现问题");
  expect(copy.status).toBe("crashed");
  expect(JSON.stringify(copy)).not.toContain(SENTINEL);
});
