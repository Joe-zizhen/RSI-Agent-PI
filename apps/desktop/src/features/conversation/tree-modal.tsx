import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  NavigateSessionTreeOptions,
  SessionTreeNodeKind,
  SessionTreeNodeSnapshot,
  SessionTreeSnapshot,
} from "@rsi-agent-pi/session-driver/types";
import { trapDialogFocus } from "../../ui/dialog-focus";
import { ChevronDownIcon, ChevronRightIcon } from "../../ui/icons";

interface TreeModalProps {
  readonly tree?: SessionTreeSnapshot;
  readonly loading: boolean;
  readonly submitting: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onNavigate: (targetId: string, options?: NavigateSessionTreeOptions) => void;
}

interface GutterInfo {
  readonly position: number;
  readonly show: boolean;
}

/** The modal's nested view of the flat snapshot; it never crosses the preload bridge. */
interface TreeNode extends SessionTreeNodeSnapshot {
  readonly children: readonly TreeNode[];
}

interface TreeRow {
  readonly node: TreeNode;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly displayIndent: number;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly isVirtualRootChild: boolean;
  readonly gutters: readonly GutterInfo[];
  readonly isOnActivePath: boolean;
}

type TreeSummaryMode = "none" | "summary" | "custom";

const DEFAULT_HIDDEN_KINDS: ReadonlySet<SessionTreeNodeKind> = new Set([
  "label",
  "custom",
  "model_change",
  "thinking_level_change",
  "session_info",
  "usage",
  "context_edit",
]);

export function TreeModal({
  tree,
  loading,
  submitting,
  error,
  onClose,
  onNavigate,
}: TreeModalProps) {
  const [step, setStep] = useState<"select" | "summary">("select");
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [summaryMode, setSummaryMode] = useState<TreeSummaryMode>("none");
  const [customInstructions, setCustomInstructions] = useState("");
  const [autoScrollRequest, setAutoScrollRequest] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const customInstructionsRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!tree) {
      return;
    }
    setStep("select");
    setSearch("");
    setExpandedIds(createInitialExpandedState(tree.nodes));
    setSelectedId(tree.leafId ?? tree.nodes[0]?.id ?? "");
    setSummaryMode("none");
    setCustomInstructions("");
    setAutoScrollRequest((value) => value + 1);
  }, [tree]);

  useLayoutEffect(() => {
    if (step === "select") {
      if (loading || !tree) {
        return;
      }
      searchRef.current?.focus();
      return;
    }
    if (summaryMode === "custom") {
      customInstructionsRef.current?.focus();
      return;
    }
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-tree-summary-confirm='true']")
      ?.focus();
  }, [loading, step, summaryMode, tree]);

  useLayoutEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      const target = event.target;
      if (!dialog || !(target instanceof Node) || dialog.contains(target)) {
        return;
      }

      // Tab handling keeps keyboard navigation inside; this also contains delayed programmatic focus.
      if (step === "select" && !loading && tree && searchRef.current) {
        searchRef.current.focus();
        return;
      }
      if (step === "summary" && summaryMode === "custom" && customInstructionsRef.current) {
        customInstructionsRef.current.focus();
        return;
      }
      dialog.querySelector<HTMLButtonElement>("[data-tree-summary-confirm='true']")?.focus();
      if (!dialog.contains(document.activeElement)) {
        dialog.focus();
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [loading, step, summaryMode, tree]);

  const displayRows = useMemo(
    () => (tree ? buildVisibleRows(tree.nodes, expandedIds, search, tree.leafId) : []),
    [expandedIds, search, tree],
  );
  const selectedRow = displayRows.find((row) => row.node.id === selectedId);
  const currentLeafId = tree?.leafId ?? null;
  const currentLeafSelected = selectedId !== "" && selectedId === currentLeafId;
  const searching = search.trim().length > 0;

  const cancelAutoScroll = () => {
    if (autoScrollRequest !== 0) {
      setAutoScrollRequest(0);
    }
  };

  useEffect(() => {
    if (displayRows.length === 0) {
      setSelectedId("");
      return;
    }
    if (!displayRows.some((row) => row.node.id === selectedId)) {
      setSelectedId(displayRows[0]?.node.id ?? "");
    }
  }, [displayRows, selectedId]);

  useLayoutEffect(() => {
    if (autoScrollRequest === 0 || step !== "select") {
      return;
    }
    const scrollToBottom = () => {
      const listElement = listRef.current;
      if (!listElement) {
        return;
      }
      const lastRow = listElement.lastElementChild;
      if (lastRow instanceof HTMLElement) {
        lastRow.scrollIntoView({ block: "end" });
      }
      listElement.scrollTop = Math.max(0, listElement.scrollHeight - listElement.clientHeight);
    };
    scrollToBottom();
    let attempts = 0;
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom();
    });
    const interval = window.setInterval(() => {
      scrollToBottom();
      attempts += 1;
      if (attempts >= 8) {
        window.clearInterval(interval);
      }
    }, 30);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, [autoScrollRequest, displayRows, step]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (submitting) {
        return;
      }
      if (step === "summary") {
        setStep("select");
        return;
      }
      onClose();
      return;
    }

    if (step !== "select" || displayRows.length === 0) {
      return;
    }

    const currentIndex = Math.max(
      0,
      displayRows.findIndex((row) => row.node.id === selectedId),
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cancelAutoScroll();
      setSelectedId(
        displayRows[Math.min(displayRows.length - 1, currentIndex + 1)]?.node.id ?? selectedId,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cancelAutoScroll();
      setSelectedId(displayRows[Math.max(0, currentIndex - 1)]?.node.id ?? selectedId);
      return;
    }
    if (
      event.key === "ArrowLeft" &&
      !searching &&
      selectedRow?.hasChildren &&
      selectedRow.expanded
    ) {
      event.preventDefault();
      cancelAutoScroll();
      setExpandedIds((current) => ({ ...current, [selectedRow.node.id]: false }));
      return;
    }
    if (
      event.key === "ArrowRight" &&
      !searching &&
      selectedRow?.hasChildren &&
      !selectedRow.expanded
    ) {
      event.preventDefault();
      cancelAutoScroll();
      setExpandedIds((current) => ({ ...current, [selectedRow.node.id]: true }));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!currentLeafSelected && selectedId) {
        setStep("summary");
      }
    }
  };

  const handleToggleExpanded = (nodeId: string) => {
    cancelAutoScroll();
    setExpandedIds((current) => ({ ...current, [nodeId]: !current[nodeId] }));
  };

  const handleSubmit = () => {
    if (!selectedId || submitting) {
      return;
    }
    if (summaryMode === "custom" && customInstructions.trim().length === 0) {
      return;
    }

    onNavigate(selectedId, {
      summarize: summaryMode !== "none",
      ...(summaryMode === "custom" ? { customInstructions: customInstructions.trim() } : {}),
    });
  };

  const setListElement = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (!node || autoScrollRequest === 0 || step !== "select") {
      return;
    }
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || step !== "select" || submitting) {
          return;
        }
        onClose();
      }}
    >
      <div
        aria-modal="true"
        className="tree-modal"
        data-testid="tree-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">会话树</div>
            <h2 className="tree-modal__title">{step === "summary" ? "切换分支" : "浏览分支"}</h2>
          </div>
          <button
            aria-label="关闭会话树对话框"
            className="tree-modal__close"
            disabled={submitting}
            type="button"
            onClick={() => {
              if (step === "summary") {
                setStep("select");
                return;
              }
              onClose();
            }}
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="tree-modal__error error-banner" data-testid="tree-modal-error">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="tree-modal__loading" data-testid="tree-modal-loading">
            正在加载会话树…
          </div>
        ) : null}

        {!loading && tree && step === "select" ? (
          <>
            <div className="tree-modal__search-row">
              <input
                autoFocus
                aria-label="搜索会话树"
                className="tree-modal__search"
                data-testid="tree-modal-search"
                placeholder="搜索可见的树节点"
                ref={searchRef}
                value={search}
                onChange={(event) => {
                  cancelAutoScroll();
                  setSearch(event.target.value);
                }}
              />
              <div className="tree-modal__meta">
                {searching
                  ? "搜索会展开匹配的分支。"
                  : currentLeafId
                    ? "树将在最近的节点处打开。"
                    : "选择一个节点，从该节点新建分支。"}
              </div>
            </div>

            <div className="tree-modal__list" data-testid="tree-modal-list" ref={setListElement}>
              {displayRows.length === 0 ? (
                <div className="tree-modal__empty">没有匹配的节点。</div>
              ) : (
                displayRows.map((row) => {
                  const isSelected = row.node.id === selectedId;
                  const isCurrentLeaf = row.node.id === currentLeafId;
                  return (
                    <div
                      className={`tree-row ${isSelected ? "tree-row--selected" : ""} ${isCurrentLeaf ? "tree-row--active" : ""}`}
                      key={row.node.id}
                    >
                      <button
                        aria-label={row.expanded ? "收起分支" : "展开分支"}
                        className={`tree-row__toggle ${row.hasChildren ? "" : "tree-row__toggle--hidden"}`}
                        disabled={searching || !row.hasChildren}
                        tabIndex={-1}
                        type="button"
                        onClick={() => handleToggleExpanded(row.node.id)}
                      >
                        {row.hasChildren ? (
                          row.expanded ? (
                            <ChevronDownIcon />
                          ) : (
                            <ChevronRightIcon />
                          )
                        ) : null}
                      </button>
                      <button
                        className="tree-row__content"
                        data-tree-selected={isSelected ? "true" : undefined}
                        data-testid={`tree-row-${row.node.id}`}
                        title={buildTreeRowLine(row, currentLeafId)}
                        type="button"
                        onClick={() => {
                          cancelAutoScroll();
                          setSelectedId(row.node.id);
                        }}
                        onDoubleClick={() => {
                          cancelAutoScroll();
                          setSelectedId(row.node.id);
                          if (row.node.id !== currentLeafId) {
                            setStep("summary");
                          }
                        }}
                      >
                        <span className="tree-row__line">
                          {buildTreeRowLine(row, currentLeafId)}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="tree-modal__footer">
              <div className="tree-modal__hint">
                选择用户提示会在输入框中重新打开它。选择其他节点会直接跳转到那里。
              </div>
              <div className="tree-modal__actions">
                <button className="button button--secondary" type="button" onClick={onClose}>
                  取消
                </button>
                <button
                  className="button button--primary"
                  disabled={!selectedId || currentLeafSelected}
                  type="button"
                  onClick={() => setStep("summary")}
                >
                  {currentLeafSelected ? "已在此处" : "继续"}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {!loading && tree && step === "summary" ? (
          <div className="tree-modal__summary-step" data-testid="tree-summary-step">
            <div className="tree-modal__summary-copy">
              你正在离开当前分支。请选择 pi 是否在切换前总结被放弃的路径。
            </div>
            <div className="tree-summary-options">
              <button
                className={`tree-summary-option ${summaryMode === "none" ? "tree-summary-option--selected" : ""}`}
                type="button"
                onClick={() => setSummaryMode("none")}
              >
                <span className="tree-summary-option__title">不总结</span>
                <span className="tree-summary-option__description">立即跳转，不生成分支总结。</span>
              </button>
              <button
                className={`tree-summary-option ${summaryMode === "summary" ? "tree-summary-option--selected" : ""}`}
                type="button"
                onClick={() => setSummaryMode("summary")}
              >
                <span className="tree-summary-option__title">总结</span>
                <span className="tree-summary-option__description">在切换前生成分支总结。</span>
              </button>
              <button
                className={`tree-summary-option ${summaryMode === "custom" ? "tree-summary-option--selected" : ""}`}
                type="button"
                onClick={() => setSummaryMode("custom")}
              >
                <span className="tree-summary-option__title">使用自定义提示总结</span>
                <span className="tree-summary-option__description">为总结提供额外说明。</span>
              </button>
            </div>

            {summaryMode === "custom" ? (
              <textarea
                autoFocus
                aria-label="自定义总结说明"
                className="tree-modal__custom-instructions"
                placeholder="总结应聚焦于决策、变更的文件和未解决的风险。"
                ref={customInstructionsRef}
                value={customInstructions}
                onChange={(event) => setCustomInstructions(event.target.value)}
              />
            ) : null}

            <div className="tree-modal__footer">
              <div className="tree-modal__hint">
                {submitting
                  ? "正在切换分支…"
                  : summaryMode === "none"
                    ? "当前分支将保持原样。"
                    : "总结将附加到你切换到的分支。"}
              </div>
              <div className="tree-modal__actions">
                <button
                  className="button button--secondary"
                  disabled={submitting}
                  type="button"
                  onClick={() => setStep("select")}
                >
                  返回
                </button>
                <button
                  className="button button--primary"
                  data-tree-summary-confirm="true"
                  disabled={
                    submitting ||
                    !selectedId ||
                    (summaryMode === "custom" && customInstructions.trim().length === 0)
                  }
                  type="button"
                  onClick={handleSubmit}
                >
                  {submitting ? "正在切换…" : "切换分支"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function createInitialExpandedState(
  nodes: readonly SessionTreeNodeSnapshot[],
): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.parentId !== null) {
      expanded[node.parentId] = true;
    }
  }
  return expanded;
}

function buildVisibleRows(
  nodes: readonly SessionTreeNodeSnapshot[],
  expandedIds: Readonly<Record<string, boolean>>,
  search: string,
  currentLeafId: string | null,
): readonly TreeRow[] {
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { roots, activePathIds } = buildDisplayTree(nodes, currentLeafId, tokens);
  return flattenTreeRows(roots, currentLeafId, activePathIds, expandedIds, tokens.length > 0);
}

/**
 * Builds the nested tree the modal shows: hidden and non-matching nodes are dropped (their
 * shown descendants move up to the nearest shown ancestor), and siblings leading to the
 * current leaf sort first. Loops rather than recursion, since one path can be thousands of
 * entries deep.
 */
function buildDisplayTree(
  nodes: readonly SessionTreeNodeSnapshot[],
  currentLeafId: string | null,
  searchTokens: readonly string[],
): { readonly roots: readonly TreeNode[]; readonly activePathIds: ReadonlySet<string> } {
  const ids = new Set(nodes.map((node) => node.id));
  const shownChildren = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  const activePathIds = new Set<string>();
  const leadsToLeaf = (node: TreeNode) => activePathIds.has(node.id);

  // Children follow their parent in the snapshot, so walking it backwards finishes every
  // child before its parent. Lists fill in reverse and flip once their owner is reached.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    const children = (shownChildren.get(node.id) ?? []).reverse();
    children.sort((left, right) => Number(leadsToLeaf(right)) - Number(leadsToLeaf(left)));

    let shown: readonly TreeNode[] = children;
    const matches = searchTokens.length === 0 || matchesTreeSearch(node, searchTokens);
    if (shouldShowNodeInView(node) && (matches || children.length > 0)) {
      if (node.id === currentLeafId || children.some(leadsToLeaf)) {
        activePathIds.add(node.id);
      }
      shown = [{ ...node, children }];
    }

    const parentId = node.parentId;
    let siblings = roots;
    if (parentId !== null && parentId !== node.id && ids.has(parentId)) {
      siblings = shownChildren.get(parentId) ?? [];
      shownChildren.set(parentId, siblings);
    }
    for (let shownIndex = shown.length - 1; shownIndex >= 0; shownIndex -= 1) {
      siblings.push(shown[shownIndex]!);
    }
  }

  roots.reverse();
  roots.sort((left, right) => Number(leadsToLeaf(right)) - Number(leadsToLeaf(left)));
  return { roots, activePathIds };
}

function shouldShowNodeInView(node: SessionTreeNodeSnapshot): boolean {
  if (DEFAULT_HIDDEN_KINDS.has(node.kind)) {
    return false;
  }
  if (node.kind === "message" && node.role === "assistant" && !hasVisiblePreview(node.preview)) {
    return false;
  }
  return true;
}

function hasVisiblePreview(preview: string | undefined): boolean {
  return typeof preview === "string" && preview.trim().length > 0;
}

function matchesTreeSearch(node: SessionTreeNodeSnapshot, tokens: readonly string[]): boolean {
  const text = nodeSearchText(node);
  return tokens.every((token) => text.includes(token));
}

function flattenTreeRows(
  roots: readonly TreeNode[],
  currentLeafId: string | null,
  activePathIds: ReadonlySet<string>,
  expandedIds: Readonly<Record<string, boolean>>,
  expandAll: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const multipleRoots = roots.length > 1;
  type StackItem = readonly [
    node: TreeNode,
    indent: number,
    justBranched: boolean,
    showConnector: boolean,
    isLast: boolean,
    gutters: readonly GutterInfo[],
    isVirtualRootChild: boolean,
  ];
  const stack: StackItem[] = [];

  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const isLast = index === roots.length - 1;
    const root = roots[index];
    if (!root) {
      continue;
    }
    stack.push([
      root,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      isLast,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;
    const children = node.children;
    const multipleChildren = children.length > 1;
    const expanded = expandAll || children.length === 0 || expandedIds[node.id] !== false;
    const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;

    rows.push({
      node,
      hasChildren: children.length > 0,
      expanded,
      displayIndent,
      showConnector,
      isLast,
      isVirtualRootChild,
      gutters,
      isOnActivePath: activePathIds.has(node.id),
    });

    if (!expanded || children.length === 0) {
      continue;
    }

    let childIndent: number;
    if (multipleChildren) {
      childIndent = indent + 1;
    } else if (justBranched && indent > 0) {
      childIndent = indent + 1;
    } else {
      childIndent = indent;
    }

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const connectorPosition = Math.max(0, displayIndent - 1);
    const childGutters: readonly GutterInfo[] = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childIsLast = index === children.length - 1;
      const child = children[index];
      if (!child) {
        continue;
      }
      stack.push([
        child,
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }

  return rows;
}

function buildTreeRowLine(row: TreeRow, currentLeafId: string | null): string {
  const prefix = buildTreePrefix(row);
  const pathMarker = row.node.id === currentLeafId ? "• " : row.isOnActivePath ? "· " : "  ";
  const label = row.node.label ? `[${row.node.label}] ` : "";
  const current = row.node.id === currentLeafId ? "  ← 当前" : "";
  return `${prefix}${pathMarker}${label}${formatTreeNodeDisplayText(row.node)}${current}`;
}

function buildTreePrefix(row: TreeRow): string {
  const chars: string[] = [];
  const connector =
    row.showConnector && !row.isVirtualRootChild ? (row.isLast ? "└─ " : "├─ ") : "";
  const connectorPosition = connector ? row.displayIndent - 1 : -1;
  const totalChars = row.displayIndent * 3;

  for (let index = 0; index < totalChars; index += 1) {
    const level = Math.floor(index / 3);
    const positionInLevel = index % 3;
    const gutter = row.gutters.find((entry) => entry.position === level);
    if (gutter) {
      chars.push(positionInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
      continue;
    }
    if (connector && level === connectorPosition) {
      if (positionInLevel === 0) {
        chars.push(row.isLast ? "└" : "├");
      } else if (positionInLevel === 1) {
        chars.push(row.expanded ? "─" : "⊞");
      } else {
        chars.push(" ");
      }
      continue;
    }
    chars.push(" ");
  }

  return chars.join("");
}

function formatTreeNodeDisplayText(node: SessionTreeNodeSnapshot): string {
  switch (node.kind) {
    case "message":
      switch (node.role) {
        case "user":
          return `用户: ${node.preview ?? "(空)"}`;
        case "assistant":
          return `助手: ${node.preview ?? "(无内容)"}`;
        case "toolResult":
          return node.preview ?? "[工具]";
        case "bashExecution":
          return `[bash]: ${node.preview ?? "(无命令)"}`;
        case "branchSummary":
          return `[分支总结]: ${node.preview ?? "(空)"}`;
        case "compactionSummary":
          return `[上下文压缩]: ${node.preview ?? "(空)"}`;
        default:
          return `[${node.role ?? "消息"}]${node.preview ? ` ${node.preview}` : ""}`;
      }
    case "custom_message":
      return `[${node.customType ?? "自定义"}]: ${node.preview ?? "(空)"}`;
    case "compaction":
      return `[上下文压缩: ${node.preview ?? "总结"}]`;
    case "branch_summary":
      return `[分支总结]: ${node.preview ?? "(空)"}`;
    default:
      return node.preview ? `${node.title}: ${node.preview}` : node.title;
  }
}

function nodeSearchText(node: SessionTreeNodeSnapshot): string {
  return [
    node.title,
    node.preview,
    node.label,
    node.role,
    node.customType,
    formatTreeNodeDisplayText(node),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
