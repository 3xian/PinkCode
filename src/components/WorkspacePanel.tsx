import { useState } from "react";
import { FilePreview } from "./FilePreview";
import { FileTree } from "./FileTree";
import { GitChanges } from "./GitChanges";

interface Props {
  /** Project root when workspace is armed; null shows empty browser. */
  cwd: string | null;
  refreshKey: number;
  /** Absolute path under project root currently previewed. */
  previewPath: string | null;
  onPreviewPath: (path: string | null) => void;
  /** Active session — session-scoped assets (generated images) for preview. */
  sessionId?: string | null;
}

/**
 * Right-rail workspace: Files / Git tabs + preview pane.
 * Owns tab chrome so FileTree / GitChanges stay content-only.
 */
export function WorkspacePanel({
  cwd,
  refreshKey,
  previewPath,
  onPreviewPath,
  sessionId = null,
}: Props) {
  const [tab, setTab] = useState<"files" | "git">("files");
  const [gitChangeCount, setGitChangeCount] = useState(0);

  return (
    <>
      <div className="workspace-half workspace-upper">
        <div className="workspace-tabs" role="tablist" aria-label="Workspace">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={"workspace-tab" + (tab === "files" ? " active" : "")}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "git"}
            className={"workspace-tab" + (tab === "git" ? " active" : "")}
            onClick={() => setTab("git")}
          >
            Git changes
            {gitChangeCount > 0 && (
              <span className="tab-count">{gitChangeCount}</span>
            )}
          </button>
        </div>
        <div className="workspace-browser">
          <div
            className={
              "workspace-tab-panel" + (tab === "files" ? " is-active" : "")
            }
            role="tabpanel"
            hidden={tab !== "files"}
          >
            <FileTree
              root={cwd}
              refreshKey={refreshKey}
              selectedPath={previewPath}
              onSelectFile={onPreviewPath}
            />
          </div>
          <div
            className={
              "workspace-tab-panel" + (tab === "git" ? " is-active" : "")
            }
            role="tabpanel"
            hidden={tab !== "git"}
          >
            <GitChanges
              cwd={cwd}
              refreshKey={refreshKey}
              selectedPath={previewPath}
              onSelectFile={onPreviewPath}
              onCountChange={setGitChangeCount}
            />
          </div>
        </div>
      </div>
      <div className="workspace-split" />
      <div className="workspace-half workspace-lower">
        <FilePreview
          root={cwd}
          path={previewPath}
          sessionId={sessionId}
          onClose={() => onPreviewPath(null)}
          onResolvedPath={onPreviewPath}
        />
      </div>
    </>
  );
}
