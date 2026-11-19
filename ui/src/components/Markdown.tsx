import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/** A code block with a Copy button (it copies the text as shown). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(ref.current?.textContent ?? "").then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => undefined);
  };
  return (
    <div className="codeblock">
      <pre ref={ref}>{children}</pre>
      <button className="copy" onClick={copy} aria-label="Copy code">{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** Markdown from a model. No raw HTML is rendered (react-markdown's default), links open in a new tab, and images are not loaded
 *  (a remote image URL can leak data), they show their alt text instead. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ alt }) => <span className="blocked-image">[image: {alt || "not loaded"}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
