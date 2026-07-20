import ReactMarkdown from "react-markdown";

interface Props {
  children: string;
  className?: string;
}

/** Render markdown text (agent/user stream content). No raw HTML. */
export function Markdown({ children, className }: Props) {
  if (!children) return null;
  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
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
