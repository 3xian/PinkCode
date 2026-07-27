import type { HunkRecord } from "../types";
import { formatRelative, shortPath } from "../utils/format";
import { FilePathLink } from "./FilePathLink";

interface Props {
  hunks: HunkRecord[];
  /** Full-session count from Grok's signals, not limited to the recent tail. */
  totalFilesTouched: number;
  /** Whether `hunks` contains only the latest records. */
  hasMore: boolean;
  /** Open a file path in the workspace preview pane. */
  onOpenFile?: (path: string) => void;
}

export function DiffPanel({
  hunks,
  totalFilesTouched,
  hasMore,
  onOpenFile,
}: Props) {
  if (hunks.length === 0) {
    return (
      <div className="empty-hint">
        No hunk records for this session. File edits will appear here once the
        agent writes via search_replace / write.
      </div>
    );
  }

  // Aggregate by file (immutable fold — never mutate a map value in place)
  const byFile = new Map<
    string,
    { added: number; removed: number; count: number; lastTs?: string | null }
  >();
  for (const h of hunks) {
    const prev = byFile.get(h.filePath);
    const lastTs =
      h.timestamp && (!prev?.lastTs || h.timestamp > prev.lastTs)
        ? h.timestamp
        : prev?.lastTs ?? h.timestamp;
    byFile.set(h.filePath, {
      added: (prev?.added ?? 0) + h.linesAdded,
      removed: (prev?.removed ?? 0) + h.linesRemoved,
      count: (prev?.count ?? 0) + 1,
      lastTs,
    });
  }

  const files = [...byFile.entries()].sort((a, b) => {
    const ta = a[1].lastTs ?? "";
    const tb = b[1].lastTs ?? "";
    return tb.localeCompare(ta);
  });

  return (
    <div className="diff-panel">
      <div className="diff-summary">
        {hasMore ? (
          <>
            <strong>{totalFilesTouched}</strong> files touched · latest{" "}
            <strong>{hunks.length}</strong> hunks cover{" "}
            <strong>{files.length}</strong> files
          </>
        ) : (
          <>
            <strong>{files.length}</strong> files ·{" "}
            <strong>{hunks.length}</strong> hunks
          </>
        )}
      </div>

      <div className="file-list">
        {files.map(([path, agg]) => (
          <div key={path} className="file-row">
            <FilePathLink path={path} onOpen={onOpenFile} className="file-path">
              {shortPath(path, 72)}
            </FilePathLink>
            <div className="file-meta">
              <span className="add">+{agg.added}</span>
              <span className="del">−{agg.removed}</span>
              <span className="muted">{agg.count} hunks</span>
              <span className="muted">{formatRelative(agg.lastTs)}</span>
            </div>
          </div>
        ))}
      </div>

      <h3 className="section-title">Recent hunks</h3>
      <div className="hunk-list">
        {hunks.slice(0, 40).map((h, i) => (
          <div key={h.hunkId ?? i} className="hunk-row">
            <FilePathLink
              path={h.filePath}
              onOpen={onOpenFile}
              className="hunk-path"
            >
              {shortPath(h.filePath, 60)}
              {h.hunkStart != null && (
                <span className="muted">
                  :{h.hunkStart}
                  {h.hunkEnd != null ? `–${h.hunkEnd}` : ""}
                </span>
              )}
            </FilePathLink>
            <div className="file-meta">
              <span className="add">+{h.linesAdded}</span>
              <span className="del">−{h.linesRemoved}</span>
              {h.authorType && <span className="tag">{h.authorType}</span>}
              <span className="muted">{formatRelative(h.timestamp)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
