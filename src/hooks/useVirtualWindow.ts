import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

const DEFAULT_ESTIMATE = 96;
const DEFAULT_OVERSCAN = 12;
/** Below this count, render everything — virtualization overhead is not worth it. */
export const VIRTUAL_WINDOW_MIN_COUNT = 48;

export interface VirtualWindowRange {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export interface VirtualScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** List top relative to the scroll parent's content origin. */
  listTop: number;
}

export interface VirtualWindow extends VirtualWindowRange {
  active: boolean;
  estimateHeight: number;
  /** Measured height for a stable item key, or the estimate when unknown. */
  heightOf: (key: string) => number;
  measureKey: (key: string, el: HTMLElement | null) => void;
}

function rangesEqual(a: VirtualWindowRange, b: VirtualWindowRange): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.offsetTop === b.offsetTop &&
    a.totalHeight === b.totalHeight
  );
}

/**
 * Pure index window over a prefix-sum height table.
 * Exported for unit tests.
 */
export function computeVirtualRange(
  offsets: readonly number[],
  count: number,
  scrollLocal: number,
  viewportH: number,
  overscan: number,
): VirtualWindowRange {
  if (count === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  }
  const viewStart = Math.max(0, scrollLocal);
  const viewEnd = viewStart + viewportH;

  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= viewStart) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = Math.max(0, lo - overscan);

  lo = startIdx;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < viewEnd) lo = mid + 1;
    else hi = mid;
  }
  const endIdx = Math.min(count, lo + overscan);

  return {
    start: startIdx,
    end: endIdx,
    offsetTop: offsets[startIdx] ?? 0,
    totalHeight: offsets[count] ?? 0,
  };
}

/**
 * Variable-height window for a list inside an ancestor scroll parent.
 * Heights are keyed by stable item ids so prepend (load-older) does not
 * scramble measurements. Scroll is rAF-batched; optional onScrollMetrics
 * lets the panel drive stick-to-bottom without a second listener.
 */
export function useVirtualWindow(
  itemKeys: readonly string[],
  listRef: RefObject<HTMLElement | null>,
  scrollParent: HTMLElement | null,
  options?: {
    estimateHeight?: number;
    overscan?: number;
    minCount?: number;
    onScrollMetrics?: (metrics: VirtualScrollMetrics) => void;
  },
): VirtualWindow {
  const estimateHeight = options?.estimateHeight ?? DEFAULT_ESTIMATE;
  const overscan = options?.overscan ?? DEFAULT_OVERSCAN;
  const minCount = options?.minCount ?? VIRTUAL_WINDOW_MIN_COUNT;
  const onScrollMetrics = options?.onScrollMetrics;
  const count = itemKeys.length;
  const active = count >= minCount && scrollParent != null;

  const heightsRef = useRef(new Map<string, number>());
  const rowObserversRef = useRef(new Map<string, ResizeObserver>());
  const onScrollMetricsRef = useRef(onScrollMetrics);
  onScrollMetricsRef.current = onScrollMetrics;

  const [heightVersion, setHeightVersion] = useState(0);
  const [range, setRange] = useState<VirtualWindowRange>({
    start: 0,
    end: 0,
    offsetTop: 0,
    totalHeight: 0,
  });

  // Drop measurements and observers for keys that left the list.
  useLayoutEffect(() => {
    const live = new Set(itemKeys);
    const heights = heightsRef.current;
    for (const key of heights.keys()) {
      if (!live.has(key)) heights.delete(key);
    }
    const observers = rowObserversRef.current;
    for (const [key, ro] of observers) {
      if (!live.has(key)) {
        ro.disconnect();
        observers.delete(key);
      }
    }
  }, [itemKeys]);

  useLayoutEffect(() => {
    return () => {
      for (const ro of rowObserversRef.current.values()) ro.disconnect();
      rowObserversRef.current.clear();
    };
  }, []);

  const offsets = useMemo(() => {
    void heightVersion;
    const keys = itemKeys;
    const offs = new Array<number>(keys.length + 1);
    offs[0] = 0;
    const heights = heightsRef.current;
    for (let i = 0; i < keys.length; i++) {
      offs[i + 1] =
        offs[i] + (heights.get(keys[i]) ?? estimateHeight);
    }
    return offs;
  }, [itemKeys, estimateHeight, heightVersion]);

  const totalHeight = active ? (offsets[count] ?? 0) : 0;

  // One scroll/RO owner: always report metrics for stick-to-bottom; range only when virtualized.
  useLayoutEffect(() => {
    if (!scrollParent) {
      const next = { start: 0, end: count, offsetTop: 0, totalHeight: 0 };
      setRange((prev) => (rangesEqual(prev, next) ? prev : next));
      return;
    }
    const list = listRef.current;
    if (!list) return;

    let raf = 0;
    const readMetrics = (): VirtualScrollMetrics => {
      const listTop =
        list.getBoundingClientRect().top -
        scrollParent.getBoundingClientRect().top +
        scrollParent.scrollTop;
      return {
        scrollTop: scrollParent.scrollTop,
        clientHeight: scrollParent.clientHeight || 600,
        scrollHeight: scrollParent.scrollHeight,
        listTop,
      };
    };

    const commit = () => {
      raf = 0;
      const metrics = readMetrics();
      onScrollMetricsRef.current?.(metrics);
      if (!active) {
        const full = { start: 0, end: count, offsetTop: 0, totalHeight: 0 };
        setRange((prev) => (rangesEqual(prev, full) ? prev : full));
        return;
      }
      const scrollLocal = Math.max(0, metrics.scrollTop - metrics.listTop);
      const next = computeVirtualRange(
        offsets,
        count,
        scrollLocal,
        metrics.clientHeight,
        overscan,
      );
      setRange((prev) => (rangesEqual(prev, next) ? prev : next));
    };

    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(commit);
    };

    commit();
    scrollParent.addEventListener("scroll", schedule, { passive: true });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    ro?.observe(scrollParent);
    ro?.observe(list);
    return () => {
      scrollParent.removeEventListener("scroll", schedule);
      ro?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [active, count, listRef, offsets, overscan, scrollParent]);

  const measureKey = useCallback((key: string, el: HTMLElement | null) => {
    const observers = rowObserversRef.current;
    const existing = observers.get(key);
    if (existing) {
      existing.disconnect();
      observers.delete(key);
    }
    if (!el || !key) return;

    const apply = () => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      if (heightsRef.current.get(key) === h) return;
      heightsRef.current.set(key, h);
      setHeightVersion((v) => v + 1);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    observers.set(key, ro);
  }, []);

  const heightOf = useCallback(
    (key: string) => heightsRef.current.get(key) ?? estimateHeight,
    [estimateHeight],
  );

  return {
    start: active ? range.start : 0,
    end: active ? range.end : count,
    offsetTop: active ? range.offsetTop : 0,
    totalHeight,
    active,
    estimateHeight,
    heightOf,
    measureKey,
  };
}

/**
 * How many pixels were inserted above `anchorKey` when `nextKeys` prepended
 * items relative to `prevKeys`. Used to keep scroll position stable on load-older.
 */
export function prependHeightDelta(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
  heightOf: (key: string) => number,
): number {
  if (prevKeys.length === 0 || nextKeys.length <= prevKeys.length) return 0;
  const anchor = prevKeys[0];
  const idx = nextKeys.indexOf(anchor);
  if (idx <= 0) return 0;
  // Confirm the previous head still aligns (same suffix), not a full replace.
  for (let i = 0; i < Math.min(prevKeys.length, 8); i++) {
    if (nextKeys[idx + i] !== prevKeys[i]) return 0;
  }
  let delta = 0;
  for (let i = 0; i < idx; i++) delta += heightOf(nextKeys[i]);
  return delta;
}
