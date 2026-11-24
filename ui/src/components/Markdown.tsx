import { memo, useRef, useState, type ReactNode } from "react";
import { splitBlocks } from "../lib/stream";
import ReactMarkdown, { type Options } from "react-markdown";
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

const COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  // a wide table scrolls on its own instead of pushing the whole chat sideways; numbers in it never wrap
  table: ({ children }: { children?: ReactNode }) => <div className="table-wrap" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
  img: ({ alt }: { alt?: string }) => <span className="blocked-image">[image: {alt || "not loaded"}]</span>,
};
const REMARK: Options["remarkPlugins"] = [remarkGfm];
const REHYPE: Options["rehypePlugins"] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

/** One run of markdown. Memoised on its text, so a streaming message's finished blocks are not parsed or highlighted again. */
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/** Markdown from a model. No raw HTML is rendered (react-markdown's default), links open in a new tab, and images are not loaded
 *  (a remote image URL can leak data), they show their alt text instead. While `streaming`, the text is rendered block by block so
 *  each new word re-renders only the last block; a finished message is rendered whole. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      {streaming ? splitBlocks(text).map((b, i) => <Block key={i} text={b} />) : <Block text={text} />}
    </div>
  );
}
