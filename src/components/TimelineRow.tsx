import type { ReactNode } from "react";
import { formatClockTime } from "../utils/format";

const KIND_LABELS: Record<string, string> = {
  user: "User",
  agent: "Agent",
  thought: "Thought",
  tool: "Tool",
  shell: "Shell",
  plan: "Plan",
  event: "Event",
  unknown: "Other",
};

/** Same-kind runs: one visual group (see detail.css). */
export function timelineStackClass(
  prevKind: string | undefined,
  kind: string,
  nextKind: string | undefined,
): string {
  const parts: string[] = [];
  if (prevKind === kind) parts.push("tl-stack-continue");
  if (nextKind === kind) parts.push("tl-stack-has-next");
  return parts.join(" ");
}

function isStackContinue(stackClass: string): boolean {
  return stackClass.includes("tl-stack-continue");
}

/** Compact 16×16 glyph for the timeline kind column. */
function KindIcon({ kind }: { kind: string }) {
  const label = KIND_LABELS[kind] ?? kind;
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  let glyph: ReactNode;
  switch (kind) {
    case "user":
      glyph = (
        <svg {...common}>
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
        </svg>
      );
      break;
    case "agent":
      glyph = (
        <svg {...common}>
          <rect x="3" y="4" width="10" height="8" rx="2" />
          <path d="M6 2.5v1.5M10 2.5v1.5M6.5 8h3" />
          <circle cx="6.2" cy="7" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="9.8" cy="7" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      );
      break;
    case "thought":
      glyph = (
        <svg {...common}>
          <path d="M8 2.5a4 4 0 0 0-2.8 6.9c.4.4.8 1 .8 1.6v.5h4v-.5c0-.6.4-1.2.8-1.6A4 4 0 0 0 8 2.5z" />
          <path d="M6.5 13.5h3M7 14.5h2" />
        </svg>
      );
      break;
    case "tool":
      glyph = (
        <svg {...common}>
          <path d="M10.5 2.5a2.5 2.5 0 0 0-3.4 3.4L3 10l3 3 4.1-4.1a2.5 2.5 0 0 0 3.4-3.4L11 8 8 5l2.5-2.5z" />
        </svg>
      );
      break;
    case "shell":
      glyph = (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M5 6.5 7 8l-2 1.5M8.5 10.5H11" />
        </svg>
      );
      break;
    case "plan":
      glyph = (
        <svg {...common}>
          <path d="M4 3.5h8v10H4z" />
          <path d="M6 6h4M6 8.5h4M6 11h2.5" />
        </svg>
      );
      break;
    case "event":
      glyph = (
        <svg {...common}>
          <path d="M9 2 4 9h3.5L7 14l5-7H8.5L9 2z" />
        </svg>
      );
      break;
    default:
      glyph = (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 5.5v3l2 1.2" />
        </svg>
      );
  }

  return (
    <div className="tl-kind" title={label} aria-label={label}>
      {glyph}
    </div>
  );
}

/** Empty gutter so continue rows align with the first row's body. */
function KindGutter({
  kind,
  showIcon,
}: {
  kind: string;
  showIcon: boolean;
}) {
  if (showIcon) return <KindIcon kind={kind} />;
  return (
    <div
      className="tl-kind tl-kind-spacer"
      aria-hidden
      title={KIND_LABELS[kind] ?? kind}
    />
  );
}

/**
 * Shared chrome for Live + History timeline rows: clock, kind icon, body slot.
 */
export function TimelineRowChrome({
  kind,
  ts,
  stackClass,
  children,
}: {
  kind: string;
  ts?: number | null;
  stackClass: string;
  children: ReactNode;
}) {
  const showIcon = !isStackContinue(stackClass);
  const clock = formatClockTime(ts);

  return (
    <div className={`tl-item kind-${kind} ${stackClass}`.trim()}>
      {clock && ts != null && (
        <time className="tl-time" dateTime={new Date(ts).toISOString()}>
          {clock}
        </time>
      )}
      <KindGutter kind={kind} showIcon={showIcon} />
      <div className="tl-body">{children}</div>
    </div>
  );
}
