import type { ReactNode } from "react";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

// Highlighter output is turned into React elements, never into an HTML string, so nothing from a file or a model is ever parsed as HTML.
function toReact(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type === "element") {
    return (
      <span key={key} className={node.properties?.className?.join(" ")}>
        {node.children?.map(toReact)}
      </span>
    );
  }
  return null;
}

/** One line of code, highlighted for `lang` (plain if the language is unknown). */
export function CodeLine({ text, lang }: { text: string; lang?: string }) {
  if (!lang || !lowlight.registered(lang) || text.length > 2000) return <>{text || " "}</>;
  try {
    const tree = lowlight.highlight(lang, text) as unknown as HastNode;
    return <>{tree.children?.map(toReact)}</>;
  } catch {
    return <>{text}</>;
  }
}
