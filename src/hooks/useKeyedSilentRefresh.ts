import { useEffect, useRef } from "react";

/**
 * Split identity-change load vs silent refreshKey bumps (FileTree / GitChanges).
 *
 * - When `identity` changes (including null): call `onIdentityChange`.
 * - When `refreshKey` bumps for the **same** identity: call `onSilentRefresh`
 *   (skipped on the identity-change turn so we never double-fetch).
 *
 * Debounce FS events in the parent that owns `refreshKey` — not here.
 */
export function useKeyedSilentRefresh(opts: {
  identity: string | null;
  refreshKey: number;
  onIdentityChange: (identity: string | null) => void;
  onSilentRefresh: (identity: string) => void;
}): void {
  const { identity, refreshKey, onIdentityChange, onSilentRefresh } = opts;
  const lastRef = useRef<{ identity: string | null; key: number }>({
    identity: null,
    key: -1,
  });
  const onIdentityRef = useRef(onIdentityChange);
  const onSilentRef = useRef(onSilentRefresh);
  onIdentityRef.current = onIdentityChange;
  onSilentRef.current = onSilentRefresh;

  // Identity (project root / cwd) change or clear.
  useEffect(() => {
    lastRef.current = { identity, key: refreshKey };
    onIdentityRef.current(identity);
    // refreshKey is snapshotted so silent effect does not re-fire for this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only identity drives this effect
  }, [identity]);

  // Silent refresh when parent bumps refreshKey for the same identity.
  useEffect(() => {
    if (!identity) return;
    const last = lastRef.current;
    if (last.identity !== identity) {
      lastRef.current = { identity, key: refreshKey };
      return;
    }
    if (last.key === refreshKey) return;
    lastRef.current = { identity, key: refreshKey };
    onSilentRef.current(identity);
  }, [refreshKey, identity]);
}
