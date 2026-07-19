import type { HunkRecord } from "../types";
import { formatRelative, shortPath } from "../utils/format";

interface Props {
  hunks: HunkRecord[];
}

export function DiffPanel({ hunks }: Props) {
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
        <strong>{files.length}</strong> files · <strong>{hunks.length}</strong>{" "}
        hunks
      </div>

      <div className="file-list">
        {files.map(([path, agg]) => (
          <div key={path} className="file-row">
            <div className="file-path" title={path}>
              {shortPath(path, 72)}
            </div>
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
            <div className="hunk-path" title={h.filePath}>
              {shortPath(h.filePath, 60)}
              {h.hunkStart != null && (
                <span className="muted">
                  :{h.hunkStart}
                  {h.hunkEnd != null ? `–${h.hunkEnd}` : ""}
                </span>
              )}
            </div>
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
