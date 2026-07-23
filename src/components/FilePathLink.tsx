import type { KeyboardEvent, ReactNode } from "react";

interface Props {
  path: string;
  onOpen?: (path: string) => void;
  className?: string;
  children: ReactNode;
  /** Extra title lines after the path (joined with newline). */
  titleExtra?: string;
}

/**
 * Clickable project path for preview pane. Renders plain content when
 * `onOpen` is absent so Diff/Timeline can stay non-interactive.
 */
export function FilePathLink({
  path,
  onOpen,
  className = "",
  children,
  titleExtra,
}: Props) {
  const title = titleExtra ? `${path}\n${titleExtra}` : path;

  if (!onOpen) {
    return (
      <div className={className} title={title}>
        {children}
      </div>
    );
  }

  const open = onOpen;
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(path);
    }
  }

  return (
    <div
      className={`${className} is-file-link`.trim()}
      title={`${title}\nClick to preview`}
      role="link"
      tabIndex={0}
      onClick={() => open(path)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
