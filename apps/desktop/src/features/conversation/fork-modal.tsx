import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NewThreadEnvironment } from "../../../contracts/desktop-state";
import { trapDialogFocus } from "../../ui/dialog-focus";

interface ForkModalProps {
  readonly submitting: boolean;
  readonly error?: string;
  /** Preview of the assistant response the fork will branch after. */
  readonly messagePreview?: string;
  /** Whether forking into a new worktree is available for the source workspace. */
  readonly canUseWorktree: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (environment: NewThreadEnvironment) => void;
}

export function ForkModal({
  submitting,
  error,
  messagePreview,
  canUseWorktree,
  onClose,
  onSubmit,
}: ForkModalProps) {
  const [environment, setEnvironment] = useState<NewThreadEnvironment>("local");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-fork-confirm='true']")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }

    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || submitting) {
          return;
        }
        onClose();
      }}
    >
      <div
        aria-modal="true"
        className="tree-modal tree-modal--compact"
        data-testid="fork-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">分叉对话</div>
            <h2 className="tree-modal__title">开始新会话</h2>
          </div>
          <button
            aria-label="关闭分叉对话框"
            className="tree-modal__close"
            disabled={submitting}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="tree-modal__error error-banner" data-testid="fork-modal-error">
            {error}
          </div>
        ) : null}

        <div className="tree-modal__summary-step">
          <div className="tree-modal__summary-copy">
            把对话截至并包含本条回复的内容分叉为侧边栏中的新会话，输入框为空，你可以朝不同方向继续。原会话保持不变。
          </div>

          {messagePreview ? (
            <div className="fork-modal__preview" data-testid="fork-modal-preview">
              {messagePreview}
            </div>
          ) : null}

          <div className="new-thread__environment-group" role="radiogroup" aria-label="分叉环境">
            <button
              aria-pressed={environment === "local"}
              className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
              data-testid="fork-environment-local"
              type="button"
              onClick={() => setEnvironment("local")}
            >
              <span>同一工作树</span>
            </button>
            <button
              aria-pressed={environment === "worktree"}
              className={`new-thread__environment ${environment === "worktree" ? "new-thread__environment--active" : ""}`}
              data-testid="fork-environment-worktree"
              disabled={!canUseWorktree}
              title={canUseWorktree ? undefined : "此项目无法创建工作树。"}
              type="button"
              onClick={() => setEnvironment("worktree")}
            >
              <span>新建工作树</span>
            </button>
          </div>

          <div className="tree-modal__footer">
            <div className="tree-modal__hint">
              {environment === "worktree"
                ? "将创建一个全新工作树，分叉出的会话在其中打开。"
                : "分叉出的会话在与原会话相同的文件夹中打开。"}
            </div>
            <div className="tree-modal__actions">
              <button
                className="button button--secondary"
                disabled={submitting}
                type="button"
                onClick={onClose}
              >
                取消
              </button>
              <button
                className="button button--primary"
                data-fork-confirm="true"
                data-testid="fork-modal-confirm"
                disabled={submitting}
                type="button"
                onClick={() => onSubmit(environment)}
              >
                {submitting ? "分叉中…" : "分叉会话"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
