import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export interface DraggableDialogApi {
  dialogRef: RefObject<HTMLDivElement | null>;
  pos: { left: number; top: number } | null;
  dialogStyle: CSSProperties | undefined;
  onDragPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDragPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDragPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/** Pointer-drag positioning for fixed dialogs, clamped to the viewport. */
export function useDraggableDialog(): DraggableDialogApi {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);

  const clampToViewport = useCallback((left: number, top: number) => {
    const el = dialogRef.current;
    const margin = 8;
    const w = el?.offsetWidth ?? 640;
    const h = el?.offsetHeight ?? 480;
    const maxL = Math.max(margin, window.innerWidth - w - margin);
    const maxT = Math.max(margin, window.innerHeight - h - margin);
    return {
      left: Math.min(Math.max(margin, left), maxL),
      top: Math.min(Math.max(margin, top), maxT),
    };
  }, []);

  useEffect(() => {
    function onResize() {
      setPos((prev) => {
        if (!prev) return prev;
        return clampToViewport(prev.left, prev.top);
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampToViewport]);

  function onDragPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, label")) return;

    const el = dialogRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const originLeft = pos?.left ?? rect.left;
    const originTop = pos?.top ?? rect.top;

    if (!pos) {
      setPos({ left: originLeft, top: originTop });
    }

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft,
      originTop,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPos(
      clampToViewport(
        drag.originLeft + (e.clientX - drag.startX),
        drag.originTop + (e.clientY - drag.startY),
      ),
    );
  }

  function onDragPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
  }

  const dialogStyle: CSSProperties | undefined =
    pos != null
      ? {
          left: pos.left,
          top: pos.top,
          transform: "none",
        }
      : undefined;

  return {
    dialogRef,
    pos,
    dialogStyle,
    onDragPointerDown,
    onDragPointerMove,
    onDragPointerUp,
  };
}
