import { useCallback, useEffect, useRef, useState } from "react";
import { listProjectDir, openProjectPath } from "../api";
import type { DirEntry } from "../types";
import { projectName, shortPath } from "../utils/format";

interface Props {
  root: string | null;
}

interface TreeNode {
  entry: DirEntry;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
  loading?: boolean;
}

export function FileTree({ root }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const loadRoot = useCallback(async (cwd: string) => {
    setLoadingRoot(true);
    setError(null);
    try {
      const entries = await listProjectDir(cwd);
      setNodes(
        entries.map((entry) => ({
          entry,
          expanded: false,
          loaded: false,
        })),
      );
    } catch (e) {
      setNodes([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRoot(false);
    }
  }, []);

  useEffect(() => {
    if (!root) {
      setNodes([]);
      setError(null);
      return;
    }
    void loadRoot(root);
  }, [root, loadRoot]);

  async function toggle(path: string) {
    if (!root) return;
    const current = findNode(nodesRef.current, path);
    if (!current || !current.entry.isDir) return;

    if (current.expanded) {
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({
          ...n,
          expanded: false,
          loading: false,
        })),
      );
      return;
    }

    if (current.loaded && current.children) {
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
      setError(e instanceof Error ? e.message : String(e));
      setNodes((prev) =>
        updateNode(prev, path, (n) => ({ ...n, loading: false })),
      );
    }
  }

  async function openFile(path: string) {
    if (!root) return;
    try {
      await openProjectPath(root, path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!root) {
    return (
      <div className="workspace-section file-tree-section">
        <div className="panel-header">
          <h2>Files</h2>
        </div>
        <div className="empty-hint small">Select a session to browse its project.</div>
      </div>
    );
  }

  return (
    <div className="workspace-section file-tree-section">
      <div className="panel-header">
        <h2>Files</h2>
        <button
          type="button"
          className="btn ghost tiny"
          title="Refresh"
          onClick={() => void loadRoot(root)}
          disabled={loadingRoot}
        >
          ↻
        </button>
      </div>
      <div className="file-tree-root mono" title={root}>
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
              onOpenFile={openFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
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
            ? entry.path
            : `${entry.path}\nDouble-click to open`
        }
        onClick={() => {
          if (entry.isDir) onToggle(entry.path);
        }}
        onDoubleClick={() => {
          if (!entry.isDir) onOpenFile(entry.path);
        }}
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
          />
        ))}
    </>
  );
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
