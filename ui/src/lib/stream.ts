import type { ServerEvent } from "../protocol";

/** Streamed words arrive many times a frame; each one used to re-render the chat. These two events only append to the last item,
 *  so they wait and are applied together once per animation frame. Any other event first applies what is waiting, then itself,
 *  so the order of events (and of their side effects) never changes. */
const DELTAS = new Set<ServerEvent["type"]>(["text_delta", "thinking_delta"]);

export function createBatcher(applyAll: (events: ServerEvent[]) => void, schedule: (flush: () => void) => void = (f) => requestAnimationFrame(f)) {
  let queue: ServerEvent[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    applyAll(events);
  };
  return {
    push(ev: ServerEvent) {
      if (DELTAS.has(ev.type)) {
        queue.push(ev);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
        return;
      }
      flush();
      applyAll([ev]);
    },
    flush,
  };
}

/** Split markdown into top-level blocks at blank lines, so a streaming message can re-render only its last, growing block.
 *  A blank line inside a code fence, or one followed by an indented line (a list item's continuation, indented code), does not
 *  split. Joining the blocks with "\n\n" gives back text that renders the same. Used only while streaming: a finished message
 *  is rendered whole, so anything this approximates (reference-style links across blocks) is exact in the end. */
export function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (fence === null) fence = marker[1];
      // a closing fence is the same character, at least as long, with nothing after it
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") fence = null;
    }
    const next = lines[i + 1];
    if (fence === null && line.trim() === "" && cur.length && next !== undefined && next.trim() !== "" && !/^\s/.test(next)) {
      blocks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}
