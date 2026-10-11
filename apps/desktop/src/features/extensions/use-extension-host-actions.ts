import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRef } from "@rsi-agent-pi/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { useWorkbench } from "../workbench/use-workbench";
import { t, useLocale } from "../../t";

/**
 * Host actions an extension view asks of the task it is shown for: open a
 * workspace file, or save the composer draft before creating a task draft.
 */
export function useExtensionHostActions({
  api,
  target,
  workbench,
  flushComposerDraftAsync,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
  readonly workbench: ReturnType<typeof useWorkbench>;
  readonly flushComposerDraftAsync: (target: SessionRef) => Promise<void>;
}) {
  useLocale();
  const [fileError, setFileError] = useState<{
    readonly target: SessionRef;
    readonly message: string;
  } | null>(null);
  const [preparingDrafts, setPreparingDrafts] = useState<ReadonlyMap<string, SessionRef>>(
    () => new Map(),
  );
  const targetRef = useRef(target);
  targetRef.current = target;
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  const fileRequestRef = useRef(0);

  const beforePrepareTaskDraft = useCallback(async () => {
    const draftTarget = target;
    if (!draftTarget || targetRef.current !== draftTarget)
      throw new Error(
        t(
          "Return to the extension's task to create a task draft.",
          "请返回扩展的任务以创建任务草稿。",
        ),
      );
    await flushComposerDraftAsync(draftTarget);
    if (targetRef.current !== draftTarget)
      throw new Error(
        t("The task changed before its draft could be saved.", "任务已更改，草稿未能保存。"),
      );
  }, [flushComposerDraftAsync, target]);
  const handlePrepareTaskDraftPendingChange = useCallback(
    (pending: boolean, requestKey: string) => {
      setPreparingDrafts((current) => {
        if (pending && !target) return current;
        if (!pending && !current.has(requestKey)) return current;
        const next = new Map(current);
        if (pending && target) next.set(requestKey, target);
        else next.delete(requestKey);
        return next;
      });
    },
    [target],
  );
  useEffect(() => {
    setFileError(null);
  }, [target, workbench.view.selection]);
  useEffect(
    () =>
      api?.onExtensionViewOpenFile((event) => {
        const current = targetRef.current;
        if (
          current?.workspaceId !== event.target.workspaceId ||
          current.sessionId !== event.target.sessionId
        )
          return;
        const request = ++fileRequestRef.current;
        setFileError(null);
        void workbenchRef.current
          .openFile({ workspaceId: event.target.workspaceId, path: event.path, line: event.line })
          .catch((error: unknown) => {
            if (targetRef.current !== current || fileRequestRef.current !== request) return;
            setFileError({
              target: current,
              message: t(
                `Couldn't open ${event.path}. ${error instanceof Error ? error.message : "Try opening the file again."}`,
                `无法打开 ${event.path}。${error instanceof Error ? error.message : "请重试打开该文件。"}`,
              ),
            });
          });
      }),
    [api],
  );

  return {
    /** Why the last file an extension view asked to open for this task could not open. */
    fileError: fileError && fileError.target === target ? fileError.message : undefined,
    /** An extension view is creating a task draft from this task's composer. */
    preparingTaskDraft: [...preparingDrafts.values()].some(
      (draftTarget) =>
        draftTarget.workspaceId === target?.workspaceId &&
        draftTarget.sessionId === target.sessionId,
    ),
    beforePrepareTaskDraft,
    handlePrepareTaskDraftPendingChange,
  };
}
