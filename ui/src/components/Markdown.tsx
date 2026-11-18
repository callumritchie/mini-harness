import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

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
          img: ({ alt }) => <span className="blocked-image">[image: {alt || "not loaded"}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
