import ReactMarkdown from "react-markdown";
import { hrefToFsPath, isFileLinkHref, looksLikePath } from "../utils/paths";

interface Props {
  children: string;
  className?: string;
  /** Intercept local file links into the workspace preview pane. */
  onOpenFile?: (path: string) => void;
}

/** Render markdown text (agent/user stream content). No raw HTML. */
export function Markdown({ children, className, onOpenFile }: Props) {
  if (!children) return null;
  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown
        components={{
          // Explicit author links: allow single-segment names (README.md).
          a: ({ href, children: linkChildren }) => {
            if (onOpenFile && isFileLinkHref(href)) {
              const path = hrefToFsPath(href ?? "");
              return (
                <a
                  href={href}
                  className="md-file-link"
                  title={`${path}\nClick to preview`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFile(path);
                  }}
                >
                  {linkChildren}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {linkChildren}
              </a>
            );
          },
          // Keep code blocks scrollable; avoid layout blow-ups
          pre: ({ children: preChildren }) => (
            <pre className="md-pre">{preChildren}</pre>
          ),
          code: ({ className: codeClass, children: codeChildren, ...props }) => {
            const isBlock = Boolean(codeClass);
            if (isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {codeChildren}
                </code>
              );
            }
            const text = String(codeChildren ?? "").trim();
            // Inferred paths only: separator or absolute — not console.log / foo.bar.
            if (onOpenFile && looksLikePath(text)) {
              return (
                <code
                  {...props}
                  className="md-inline-code md-file-link"
                  title={`${text}\nClick to preview`}
                  role="link"
                  tabIndex={0}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFile(text);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenFile(text);
                    }
                  }}
                >
                  {codeChildren}
                </code>
              );
            }
            return (
              <code className="md-inline-code" {...props}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
