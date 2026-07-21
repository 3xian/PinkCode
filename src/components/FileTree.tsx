import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { listProjectDir, openProjectPath } from "../api";
import { useKeyedSilentRefresh } from "../hooks/useKeyedSilentRefresh";
import type { DirEntry } from "../types";
import { projectName, shortPath } from "../utils/format";

interface Props {
  root: string | null;
  /** Bump to re-read the tree (FS events / turn complete). */
  refreshKey?: number;
}

interface TreeNode {
  entry: DirEntry;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
  loading?: boolean;
}

interface CtxMenu {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export function FileTree({ root, refreshKey = 0 }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const rootRef = useRef(root);
  rootRef.current = root;
  const loadSeqRef = useRef(0);
  /** Paths the user has expanded — preserved + re-fetched on silent refresh. */
  const expandedPathsRef = useRef<Set<string>>(new Set());
  /** Ignore the opening right-click when wiring global dismiss listeners. */
  const ignoreDismissUntilRef = useRef(0);
  /**
   * Build a tree level. When `refreshExpanded` is true, every path in
   * `expandedPathsRef` is re-listed so agent-created files appear without a
   * manual collapse/expand.
   */
  const buildLevel = useCallback(
    async (
      projectRoot: string,
      dirPath: string | null,
      prevNodes: TreeNode[],
      refreshExpanded: boolean,
    ): Promise<TreeNode[]> => {
      const entries = await listProjectDir(projectRoot, dirPath);
      const prevByPath = new Map(prevNodes.map((n) => [n.entry.path, n]));
      const expanded = expandedPathsRef.current;
      const out: TreeNode[] = [];

      for (const entry of entries) {
        const old = prevByPath.get(entry.path);
        const wantExpand =
          entry.isDir &&
          (expanded.has(entry.path) || Boolean(old?.expanded));

        if (wantExpand) {
          expanded.add(entry.path);
          const prevChildren = old?.children ?? [];
          // Always re-fetch children when refreshing expanded dirs; on first
          // expand without refreshExpanded we still need a fetch if not loaded.
          const needFetch = refreshExpanded || !old?.loaded || !old.children;
          let children: TreeNode[];
          if (needFetch) {
            children = await buildLevel(
              projectRoot,
              entry.path,
              prevChildren,
              refreshExpanded,
            );
          } else {
            children = prevChildren;
          }
          out.push({
            entry,
            expanded: true,
            loaded: true,
            loading: false,
            children,
          });
        } else {
          out.push({
            entry,
            expanded: false,
            // Drop cached children when collapsed so a later expand re-fetches.
            loaded: false,
            children: undefined,
          });
        }
      }
      return out;
    },
    [],
  );

  const loadRoot = useCallback(
    async (cwd: string, silent = false) => {
      const seq = ++loadSeqRef.current;
      if (!silent) setLoadingRoot(true);
      setError(null);
      try {
        const next = await buildLevel(
          cwd,
          null,
          nodesRef.current,
          /* refreshExpanded */ silent,
        );
        if (seq !== loadSeqRef.current || rootRef.current !== cwd) return;
        setNodes(next);
      } catch (e) {
        if (seq !== loadSeqRef.current || rootRef.current !== cwd) return;
        setNodes([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === loadSeqRef.current && rootRef.current === cwd) {
          setLoadingRoot(false);
        }
      }
    },
    [buildLevel],
  );

  const prevRootRef = useRef<string | null>(null);

  useKeyedSilentRefresh({
    identity: root,
    refreshKey,
    onIdentityChange: (id) => {
      loadSeqRef.current += 1;
      setCtx(null);
      if (!id) {
        setNodes([]);
        setError(null);
        expandedPathsRef.current = new Set();
        prevRootRef.current = null;
        return;
      }
      // New project path → drop expand state from the previous tree.
      if (prevRootRef.current !== id) {
        expandedPathsRef.current = new Set();
        prevRootRef.current = id;
      }
      void loadRoot(id, false);
    },
    onSilentRefresh: (id) => {
      void loadRoot(id, true);
    },
  });

  // Dismiss menu: next click / Esc / scroll / blur (portal lives on body)
  useEffect(() => {
    if (!ctx) return;
    const close = () => {
      if (Date.now() < ignoreDismissUntilRef.current) return;
      setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", close);
      window.addEventListener("blur", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctx]);

  async function toggle(path: string) {
    if (!root) return;
    const current = findNode(nodesRef.current, path);
    if (!current || !current.entry.isDir) return;

    if (current.expanded) {
      expandedPathsRef.current.delete(path);
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({
          ...n,
          expanded: false,
          loading: false,
          // Keep loaded children for fast re-expand; silent refresh will
          // re-fetch when refreshExpanded walks this path again.
        })),
      );
      return;
    }

    if (current.loaded && current.children) {
      expandedPathsRef.current.add(path);
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({
          ...n,
          expanded: true,
          loading: false,
        })),
      );
      return;
    }

    setNodes((prev) =>
      updateNode(prev, path, (n) => ({ ...n, loading: true })),
    );
    try {
      const children = await listProjectDir(root, path);
      if (rootRef.current !== root) return;
      expandedPathsRef.current.add(path);
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({
          ...n,
          expanded: true,
          loaded: true,
          loading: false,
          children: children.map((entry) => ({
            entry,
            expanded: false,
            loaded: false,
          })),
        })),
      );
    } catch (e) {
      if (rootRef.current !== root) return;
      setError(e instanceof Error ? e.message : String(e));
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({ ...n, loading: false })),
      );
    }
  }

  async function openInSystem(path: string) {
    if (!root) return;
    try {
      await openProjectPath(root, path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copyFullPath(path: string) {
    try {
      await writeClipboard(path);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Copy failed: ${e.message}`
          : "Copy failed: clipboard unavailable",
      );
    }
  }

  function openContextMenu(
    e: React.MouseEvent,
    path: string,
    isDir: boolean,
  ) {
    e.preventDefault();
    e.stopPropagation();
    ignoreDismissUntilRef.current = Date.now() + 250;
    setCtx({ x: e.clientX, y: e.clientY, path, isDir });
  }

  if (!root) {
    return (
      <div className="workspace-section file-tree-section">
        <div className="panel-header">
          <h2>Files</h2>
        </div>
        <div className="empty-hint small">
          Select a session to browse its project.
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-section file-tree-section">
      <div className="panel-header">
        <h2>Files</h2>
      </div>
      <div
        className="file-tree-root mono"
        title={`${root}\nRight-click for actions`}
        onContextMenu={(e) => openContextMenu(e, root, true)}
      >
        {projectName(root)}
        <span className="muted"> · {shortPath(root, 24)}</span>
      </div>
      {error && <div className="empty-hint error-text small">{error}</div>}
      {loadingRoot && nodes.length === 0 ? (
        <div className="empty-hint small">Loading…</div>
      ) : nodes.length === 0 ? (
        <div className="empty-hint small">Empty directory</div>
      ) : (
        <div className="file-tree" role="tree">
          {nodes.map((n) => (
            <TreeRow
              key={n.entry.path}
              node={n}
              depth={0}
              onToggle={toggle}
              onOpenFile={openInSystem}
              onContextMenu={openContextMenu}
            />
          ))}
        </div>
      )}

      {ctx &&
        createPortal(
          <FileContextMenu
            x={ctx.x}
            y={ctx.y}
            isDir={ctx.isDir}
            onCopy={() => {
              void copyFullPath(ctx.path);
              setCtx(null);
            }}
            onOpen={() => {
              void openInSystem(ctx.path);
              setCtx(null);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function FileContextMenu({
  x,
  y,
  isDir,
  onCopy,
  onOpen,
}: {
  x: number;
  y: number;
  isDir: boolean;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="file-ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="file-ctx-item"
        onClick={onCopy}
      >
        Copy full path
      </button>
      {isDir && (
        <button
          type="button"
          role="menuitem"
          className="file-ctx-item"
          onClick={onOpen}
        >
          Open in system
        </button>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  onToggle,
  onOpenFile,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
}) {
  const { entry } = node;
  return (
    <>
      <div
        className={`file-tree-row ${entry.isDir ? "is-dir" : "is-file"}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        role="treeitem"
        aria-expanded={entry.isDir ? Boolean(node.expanded) : undefined}
        title={
          entry.isDir
            ? `${entry.path}\nRight-click: copy path · open in system`
            : `${entry.path}\nDouble-click to open · right-click to copy path`
        }
        onClick={() => {
          if (entry.isDir) onToggle(entry.path);
        }}
        onDoubleClick={() => {
          if (!entry.isDir) onOpenFile(entry.path);
        }}
        onContextMenu={(e) => onContextMenu(e, entry.path, entry.isDir)}
      >
        <span className="file-tree-chevron" aria-hidden>
          {entry.isDir ? (node.loading ? "…" : node.expanded ? "▾" : "▸") : "·"}
        </span>
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {entry.isDir &&
        node.expanded &&
        node.children?.map((c) => (
          <TreeRow
            key={c.entry.path}
            node={c}
            depth={depth + 1}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

/** Prefer async clipboard API; fall back to a hidden textarea for Tauri/WebView. */
async function writeClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("clipboard write rejected");
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.entry.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

function updateNode(
  nodes: TreeNode[],
  path: string,
  fn: (n: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((n) => {
    if (n.entry.path === path) return fn(n);
    if (n.children) {
      return { ...n, children: updateNode(n.children, path, fn) };
    }
    return n;
  });
}
