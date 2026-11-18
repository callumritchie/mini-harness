"""Replacing a long conversation with a summary. See DESIGN.md, 'Compaction'.

Claude models: Anthropic's own on-demand compaction (beta compact-2026-09-04): we send the conversation with
`compaction: {type: summarize}` and the API returns a signed `compaction` block that stands in for the messages.
Other models: we ask the model for the summary in an ordinary request and keep it as a plain message.
Either way it only ever happens where no tool call is waiting for its result.
"""
import sys

import anthropic

import context
import pricing
import sessionlog

BETA = "compact-2026-09-04"
SUMMARY_MARK = context.SUMMARY_MARK
ACK = "Understood. I have the summary and will continue from it."
CONTINUE_NOTE = "[Note: the conversation was compacted into the summary above to save space. Continue the task from where you left off.]"
MIN_MESSAGES = 4  # less than this and there is nothing worth summarizing
SUMMARY_TOKENS = 8192
TRANSCRIPT_RESULT_CHARS = 2000  # tool results are shortened in the transcript the client-side summarizer reads
TRANSCRIPT_INPUT_CHARS = 1000

INSTRUCTIONS = """\
Write a summary of this conversation. The summary will replace the conversation, so someone reading only the summary \
must be able to carry on the work. Keep everything the next steps need:
- The user's goal and their latest request, in their own words where the wording matters.
- Decisions made, and why.
- Files that were created, read or changed (with paths), and the facts learned from them that still matter: names, \
numbers, codes, line numbers, error messages.
- Commands that were run and what they showed; problems hit and how they were solved.
- What is done, what is in progress, and the exact next step.
Be specific, not general. Do not call any tools. Reply with the summary text only, inside <summary></summary> tags."""


class CompactionFailed(Exception):
    """No summary was made. The conversation is left exactly as it was."""


def estimate_next_tokens(session):
    """Size of the next request: the real count from the last call, plus its reply, plus anything added since."""
    u = session.last_usage
    if not u:
        return None
    last = next((i for i in range(len(session.messages) - 1, -1, -1) if session.messages[i]["role"] == "assistant"), None)
    added = sum(context.message_chars(session.messages[last + 1:]).values()) if last is not None else 0
    return u["input"] + u["cache_read"] + u["cache_write"] + u["output"] + added // 4


def transcript(messages):
    """The conversation as plain text for a summarizer that gets no tools."""
    out = []
    for m in messages:
        blocks = [{"type": "text", "text": m["content"]}] if isinstance(m["content"], str) else m["content"]
        for b in blocks:
            b = sessionlog.block_to_json(b)
            kind = b.get("type")
            if kind == "text":
                out.append(f"{'User' if m['role'] == 'user' else 'Assistant'}: {b['text']}")
            elif kind == "tool_use":
                out.append(f"Assistant called {b['name']}({str(b.get('input'))[:TRANSCRIPT_INPUT_CHARS]})")
            elif kind == "tool_result":
                content = b["content"] if isinstance(b["content"], str) else str(b["content"])
                cut = f" [... {len(content) - TRANSCRIPT_RESULT_CHARS} more characters]" if len(content) > TRANSCRIPT_RESULT_CHARS else ""
                out.append(f"Tool result{' (error)' if b.get('is_error') else ''}: {content[:TRANSCRIPT_RESULT_CHARS]}{cut}")
            elif kind == "compaction":
                out.append(f"Earlier summary: {b.get('content')}")
            # thinking and server-side search blocks add nothing a summary needs
    return "\n\n".join(out)


class Compactor:
    """Decides when to compact, and does it. One per task, built from the current client, model and settings."""

    def __init__(self, client, provider, model, tool_defs, limit, mode="auto", say=None):
        self.client, self.provider, self.model, self.tool_defs = client, provider, model, tool_defs
        self.limit, self.mode = limit, mode
        self.say = say or (lambda msg: print(msg, file=sys.stderr))

    # --- when ---

    def maybe(self, session, mid_task):
        """Compact if the next request would reach the limit. Called only where the history is complete."""
        if not self.limit or session.compact_disabled or len(session.messages) < MIN_MESSAGES:
            return
        if session.compact_retry_after and len(session.messages) < session.compact_retry_after:
            return
        est = estimate_next_tokens(session)
        if est is None or est < self.limit:
            return
        if mid_task and session.messages[-1]["role"] != "user":
            return  # paused part-way through a reply: not a safe point
        try:
            self.run(session, mid_task, "auto", est=est)
        except (CompactionFailed, anthropic.APIError) as e:
            session.compact_retry_after = len(session.messages) + 4  # do not retry on every call
            self.say(f"  could not compact ({e}); carrying on with the full conversation")

    def after_call(self, session, usage):
        """Right after the first call following a compaction: if that alone already exceeds the limit, compacting can
        never help (the instructions and tools are bigger than the limit), so stop trying."""
        if session.fresh_compaction:
            session.fresh_compaction = False
            total = usage["input"] + usage["cache_read"] + usage["cache_write"]
            if self.limit and total >= self.limit:
                session.compact_disabled = True
                self.say(f"  the context limit ({self.limit:,}) is below the fixed cost of the instructions and tools "
                         f"({total:,} tokens), so compacting cannot get under it. Automatic compaction is off for this session; "
                         "raise the limit with /limit.")

    # --- how ---

    def run(self, session, mid_task, reason, focus=None, est=None):
        """Replace the conversation with a summary. Raises CompactionFailed and changes nothing if no summary comes back."""
        waiting = sessionlog.unfinished(session.messages)
        if waiting:  # never between a tool call and its result
            raise CompactionFailed(f"{len(waiting)} tool call(s) are still waiting for their result")
        if not session.messages or session.messages[-1]["role"] not in ("user", "assistant"):
            raise CompactionFailed("nothing to compact")
        instructions = INSTRUCTIONS + (f"\n\nPay particular attention to: {focus}" if focus else "")
        before, tokens = len(session.messages), est
        self.say(f"● compacting {before} messages" + (f" (~{tokens:,} tokens, limit {self.limit:,})" if tokens else "") + "...")
        kind, new, usage = self._summarize(session, instructions)
        base_len = len(new)
        if mid_task:
            new.append({"role": "user", "content": CONTINUE_NOTE})
        session.apply_compaction(kind, new, base_len, reason, self.limit, before, usage, pricing.cost(self.model, usage))
        summary = context.summary_chars(new)
        self.say(f"  compacted into a summary of about {summary // 4:,} tokens ({kind}-side)")

    def _summarize(self, session, instructions):
        if self.provider == "anthropic" and self.mode != "client":
            try:
                return self._server(session, instructions)
            except anthropic.BadRequestError as e:
                if self.mode == "server":
                    raise
                self.say(f"  server-side compaction was refused ({e.message}); using a client-side summary instead")
        return self._client(session, instructions)

    def _server(self, session, instructions):
        resp = self.client.beta.messages.create(
            model=self.model, max_tokens=SUMMARY_TOKENS, system=session.system, tools=self.tool_defs,
            messages=session.messages, betas=[BETA],
            extra_body={"compaction": {"type": "summarize", "instructions": instructions}},
        )
        blocks = [sessionlog.block_to_json(b) for b in resp.content if b.type == "compaction"]
        if resp.stop_reason != "compaction" or len(blocks) != 1 or not blocks[0].get("content"):
            raise CompactionFailed(f"the API wrote no summary (stop reason '{resp.stop_reason}')")
        usage = {"input": 0, "output": 0}
        for it in getattr(resp.usage, "iterations", None) or []:  # the summary call is reported here, not at the top
            usage["input"] += getattr(it, "input_tokens", 0) or 0
            usage["output"] += getattr(it, "output_tokens", 0) or 0
        return "server", [{"role": "assistant", "content": blocks}], usage

    def _client(self, session, instructions):
        prompt = f"{instructions}\n\n<conversation>\n{transcript(session.messages)}\n</conversation>"
        resp = self.client.messages.create(
            model=self.model, max_tokens=min(SUMMARY_TOKENS, 8192),
            system="You write summaries of conversations between a user and a coding agent.",
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        if not text:
            raise CompactionFailed(f"the model wrote no summary (stop reason '{resp.stop_reason}')")
        usage = {"input": getattr(resp.usage, "input_tokens", 0) or 0, "output": getattr(resp.usage, "output_tokens", 0) or 0}
        return "client", [{"role": "user", "content": f"{SUMMARY_MARK} Summary of everything before this point:\n\n{text}"},
                          {"role": "assistant", "content": ACK}], usage
