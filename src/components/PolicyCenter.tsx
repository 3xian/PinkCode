import type { PolicyConfig, PolicyPreset, ProjectBinding, ResolvedPolicy } from "../types";
import { projectName, shortPath } from "../utils/format";

const PRESET_LABELS: Record<PolicyPreset, string> = {
  research: "Research",
  code: "Code",
  balanced: "Balanced",
  trusted: "Trusted",
};

interface Props {
  resolved: ResolvedPolicy | null;
  presets: PolicyConfig[];
  bindings: ProjectBinding[];
  /** Current project cwd (selected session), if any */
  projectCwd: string | null;
  busy: boolean;
  recentActions: { action: string; title: string; ts: number }[];
  onBindProject: (preset: PolicyPreset) => void;
  onSetDefault: (preset: PolicyPreset) => void;
  onUnbindProject: () => void;
}

export function PolicyCenter({
  resolved,
  presets,
  bindings,
  projectCwd,
  busy,
  recentActions,
  onBindProject,
  onSetDefault,
  onUnbindProject,
}: Props) {
  const effective = resolved?.config.preset;
  const cwd = projectCwd;
  const hasProject = cwd != null && cwd.length > 0;

  return (
    <div className="policy-center">
      <div className="panel-header">
        <h2>Risk policy</h2>
      </div>

      <div className="policy-context">
        {hasProject && cwd ? (
          <>
            <div className="policy-context-label muted">Selected project</div>
            <div className="policy-context-path mono" title={cwd}>
              {projectName(cwd)}
              <span className="muted"> · {shortPath(cwd, 28)}</span>
            </div>
            <div className="policy-context-source">
              Effective:{" "}
              <strong>{PRESET_LABELS[effective ?? "balanced"]}</strong>
              <span className={`source-pill source-${resolved?.source ?? "default"}`}>
                {sourceLabel(resolved?.source)}
              </span>
            </div>
          </>
        ) : (
          <p className="muted small side-blurb" style={{ padding: 0, margin: 0 }}>
            Select a session to bind policy to its project. Cards below set the
            global default when no project is selected.
          </p>
        )}
      </div>

      <p className="muted small side-blurb">
        Ask → permission UI. Deny → blocked. Trusted → yolo on new agents.
        Project bindings persist in <code>~/.marsbuild/policies.json</code>.
      </p>

      <div className="policy-presets">
        {(presets.length
          ? presets
          : (["research", "code", "balanced", "trusted"] as PolicyPreset[]).map(
              (preset) => ({
                preset,
                description: "",
                denyBashSubstrings: [],
                sensitivePathSubstrings: [],
                autoAllowWritePrefixes: [],
              }),
            )
        ).map((p) => {
          const active = effective === p.preset;
          return (
            <div
              key={p.preset}
              className={`policy-card ${active ? "active" : ""}`}
            >
              <div className="policy-name">
                {PRESET_LABELS[p.preset] ?? p.preset}
                {active && <span className="policy-on">ACTIVE</span>}
              </div>
              <div className="policy-desc muted">
                {p.description || fallbackDesc(p.preset)}
              </div>
              <div className="policy-card-actions">
                {hasProject ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() => onBindProject(p.preset)}
                  >
                    Bind to project
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => onSetDefault(p.preset)}
                >
                  Set default
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {hasProject && resolved?.isProjectBound && (
        <div className="policy-unbind">
          <button
            type="button"
            className="btn danger-btn"
            disabled={busy}
            onClick={onUnbindProject}
          >
            Clear project binding
          </button>
          {resolved.boundPath && (
            <div className="muted small" title={resolved.boundPath}>
              Bound at {shortPath(resolved.boundPath, 36)}
            </div>
          )}
        </div>
      )}

      {bindings.length > 0 && (
        <div className="policy-bindings">
          <div className="section-title">Project bindings</div>
          {bindings.map((b) => (
            <div key={b.cwd} className="binding-row">
              <span className="binding-name" title={b.cwd}>
                {b.projectName}
              </span>
              <span className="binding-preset">
                {PRESET_LABELS[b.preset] ?? b.preset}
              </span>
            </div>
          ))}
        </div>
      )}

      {resolved && (
        <div className="policy-details">
          <div className="section-title">Rules snapshot</div>
          <ul className="policy-rules">
            <li>
              Global default:{" "}
              <strong>
                {PRESET_LABELS[resolved.defaultPreset] ?? resolved.defaultPreset}
              </strong>
            </li>
            <li>
              Deny bash patterns:{" "}
              <strong>{resolved.config.denyBashSubstrings.length}</strong>
            </li>
            <li>
              Auto-allow writes:{" "}
              <code>
                {resolved.config.autoAllowWritePrefixes.slice(0, 2).join(", ") ||
                  "—"}
              </code>
            </li>
          </ul>
        </div>
      )}

      {recentActions.length > 0 && (
        <div className="policy-actions-log">
          <div className="section-title">Recent auto-decisions</div>
          {recentActions.slice(0, 8).map((a, i) => (
            <div key={`${a.ts}-${i}`} className={`policy-log-row ${a.action}`}>
              <span className="policy-log-action">{a.action}</span>
              <span className="muted">{a.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sourceLabel(source?: string | null): string {
  switch (source) {
    case "project":
      return "project";
    case "inherited":
      return "inherited";
    default:
      return "default";
  }
}

function fallbackDesc(preset: PolicyPreset): string {
  switch (preset) {
    case "research":
      return "Deny writes & risky shell";
    case "code":
      return "Review edits; block force-push";
    case "balanced":
      return "Auto low-risk; ask on edits/shell";
    case "trusted":
      return "Auto-approve everything";
  }
}
