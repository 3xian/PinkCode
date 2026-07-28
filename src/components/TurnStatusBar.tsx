import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagedAgentInfo, TimelineItem } from "../types";
import {
  formatPhaseTimer,
  resolveTurnActivity,
  resolveTurnStartedAt,
  type TurnIndicatorMode,
} from "../utils/turnActivity";

interface Props {
  managed: ManagedAgentInfo | null;
  timelineItems: TimelineItem[];
  /**
   * Session process is open (Grok `active_sessions` / card.isActive).
   * Shows an ambient status when PinkCode is not mid-turn on this session.
   */
  sessionIsActive?: boolean;
}

/** Phase / turn timer tick. */
const CLOCK_MS = 100;

/**
 * Live turn status above the prompt.
 * Managed mid-turn → rich activity; external open session → ambient cue.
 */
export function TurnStatusBar({
  managed,
  timelineItems,
  sessionIsActive = false,
}: Props) {
  const activity = useMemo(
    () =>
      resolveTurnActivity(managed, timelineItems, {
        sessionIsActive,
      }),
    [managed, timelineItems, sessionIsActive],
  );

  const [now, setNow] = useState(() => Date.now());
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [turnAnchor, setTurnAnchor] = useState<number | null>(null);
  const lastPhaseKey = useRef<string | null>(null);

  // Reset phase / turn anchors when activity phase changes (Grok-style).
  useEffect(() => {
    if (!activity) {
      lastPhaseKey.current = null;
      setTurnAnchor(null);
      return;
    }
    if (lastPhaseKey.current !== activity.phaseKey) {
      lastPhaseKey.current = activity.phaseKey;
      setPhaseStartedAt(Date.now());
    }
    if (turnAnchor == null && activity.showTurnTimer) {
      setTurnAnchor(resolveTurnStartedAt(timelineItems, Date.now()));
    }
  }, [activity, timelineItems, turnAnchor]);

  useEffect(() => {
    if (!activity) return;
    if (!activity.showPhaseTimer && !activity.showTurnTimer) return;
    const clockId = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clockId);
  }, [activity?.phaseKey, activity?.showPhaseTimer, activity?.showTurnTimer]);

  if (!activity) return null;

  const phaseMs = Math.max(0, now - phaseStartedAt);
  const turnStart = turnAnchor ?? phaseStartedAt;
  const turnMs = Math.max(0, now - turnStart);
  const phaseLabel = formatPhaseTimer(phaseMs);
  const showPhase =
    activity.showPhaseTimer && activity.indicator !== "wait";
  // Hide turn timer when it would duplicate a short phase (same second window).
  const showTurn =
    activity.showTurnTimer && turnMs >= 1000 && turnMs - phaseMs >= 500;
  const mode = activity.indicator;

  return (
    <div
      className={`turn-status tone-${activity.tone} mode-${mode} source-${activity.source}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="turn-status-left">
        <ActivityIndicator mode={mode} />
        <div className="turn-status-copy">
          <span className="turn-status-label">
            <span className="turn-status-label-main">{activity.label}</span>
            {activity.detail ? (
              <span className="turn-status-label-detail" title={activity.detail}>
                {activity.detail}
              </span>
            ) : null}
          </span>
          {activity.hint ? (
            <span className="turn-status-hint">{activity.hint}</span>
          ) : null}
        </div>
        {showPhase && (
          <span className="turn-status-phase" aria-hidden>
            {phaseLabel}
          </span>
        )}
      </div>
      {showTurn && (
        <span className="turn-status-turn" title="Turn elapsed">
          {formatPhaseTimer(turnMs)}
        </span>
      )}
    </div>
  );
}

/** Minimal modern mark: thin arc spinner or soft pulse (wait). */
function ActivityIndicator({ mode }: { mode: TurnIndicatorMode }) {
  return (
    <span className={`turn-mark mode-${mode}`} aria-hidden>
      <span className="turn-mark-ring" />
      <span className="turn-mark-dot" />
    </span>
  );
}
