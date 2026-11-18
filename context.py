"""What the model sees on every call: the system prompt (built once per session) and the /context report."""
import datetime
import json
import platform
from pathlib import Path

import skills

AGENTS_FILE = "AGENTS.md"
MAX_AGENTS_CHARS = 20_000

RULES = """\
You are mini-claude, a small coding agent running in a terminal.

Rules:
- Look before you answer: use your tools to read the project instead of guessing what is in it.
- Prefer read_file, grep, glob and edit_file over bash for reading, searching and editing files.
- When a tool returns an error, follow its advice instead of repeating the same call.
- Use web search only for current information you cannot get locally.
- If a missing detail really changes the work, use ask_user instead of guessing. If nobody can answer, choose the most \
reasonable option and say in your final answer that you assumed it.
- Some actions need the user's approval. If one is refused, do not look for another way to do the same thing: tell the \
user what you wanted to do.
- Be concise: a few sentences unless the user asks for more."""

SUBAGENT_RULES = """\
You are a read-only research helper started by another agent. You have read_file, glob and grep. You cannot write or edit \
files, run commands, or ask questions. You cannot see the conversation that started you: work only from the task you were \
given, and say so if it lacks something you need. If the task asks you to change anything, refuse in your answer and say \
you are read-only. Look before you answer: use your tools, do not guess. Finish with the final answer only, as the task \
asked for it, with no preamble."""

REVIEWER_RULES = """\
You are a reviewer. Trust nothing: not the claims you are given, not earlier work, not a passing check. Verify by looking at \
the actual files with read_file, glob and grep; you cannot run commands, so judge from what the files really contain. Check \
that the goal is truly met, not just that something exists. Give concise reasons with evidence (file paths and what you saw). \
Your last line must be exactly `VERDICT: DONE` or `VERDICT: NOT DONE`, and nothing after it."""

SUMMARY_MARK = "This conversation was compacted."  # starts the summary message left by client-side compaction

AGENTS_HEADER = "Project instructions (from AGENTS.md in the working directory). Follow them:"


def os_name():
    mac = platform.mac_ver()[0]
    return f"macOS {mac}" if mac else f"{platform.system()} {platform.release()}"


def build_system(model, cwd=None, kind="agent"):
    """The session's system prompt. Built ONCE when the session starts and never changed afterwards: editing it would
    invalidate the prompt cache (see DESIGN.md, 'The frozen-prefix rule'). Anything that changes later goes at the end
    of the conversation instead. Returns (text, parts) where parts maps a label to its length in characters."""
    cwd = Path(cwd or Path.cwd())
    env = f"Environment: {os_name()}; working directory {cwd}; today's date {datetime.date.today().isoformat()}; model {model}."
    rules = {"agent": RULES, "subagent": SUBAGENT_RULES, "reviewer": REVIEWER_RULES}[kind]
    sections = [rules, env]
    parts = {"Rules": len(rules), "Environment line": len(env)}
    found = skills.instructions(skills.discover(cwd)[0]) if kind == "agent" else ""
    if found:  # only each skill's name and description; the model reads the rest when a task matches
        sections.append(found)
        parts["Skills (names only)"] = len(found)
    agents = cwd / AGENTS_FILE
    if agents.is_file():
        try:
            text = agents.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            text = ""
        if len(text) > MAX_AGENTS_CHARS:
            text = text[:MAX_AGENTS_CHARS] + f"\n[AGENTS.md cut after {MAX_AGENTS_CHARS} characters]"
        if text:
            block = f"{AGENTS_HEADER}\n{text}"
            sections.append(block)
            parts[AGENTS_FILE] = len(block)
    return "\n\n".join(sections), parts


# ---------- /context ----------

def _tokens(chars):
    return round(chars / 4)  # rough: about 4 characters per token


def _block_chars(block):
    kind = block["type"] if isinstance(block, dict) else block.type
    if kind == "text":
        return "text", len(block["text"] if isinstance(block, dict) else block.text)
    if kind == "thinking":
        return "text", len((block.get("thinking") if isinstance(block, dict) else getattr(block, "thinking", "")) or "")
    if kind in ("tool_use", "server_tool_use"):
        name, args = (block["name"], block["input"]) if isinstance(block, dict) else (block.name, block.input)
        return "calls", len(name) + len(json.dumps(args, default=str))
    if kind == "compaction":
        return "summary", len(block.get("content") or "" if isinstance(block, dict) else getattr(block, "content", "") or "")
    if kind == "tool_result":
        content = block["content"]
        return "results", len(content if isinstance(content, str) else json.dumps(content, default=str))
    dump = block.model_dump_json() if hasattr(block, "model_dump_json") else json.dumps(block, default=str)
    return "server", len(dump)  # search results and other server-side blocks


def message_chars(messages):
    totals = {"Compaction summary": 0, "Your messages": 0, "Model replies (text)": 0, "Tool calls": 0, "Tool results": 0, "Search & server results": 0}
    labels = {"text": None, "calls": "Tool calls", "results": "Tool results", "server": "Search & server results",
              "summary": "Compaction summary"}
    for m in messages:
        if isinstance(m["content"], str):
            is_summary = m["role"] == "user" and m["content"].startswith(SUMMARY_MARK)
            totals["Compaction summary" if is_summary else "Your messages"] += len(m["content"])
            continue
        for block in m["content"]:
            kind, n = _block_chars(block)
            label = labels[kind] or ("Your messages" if m["role"] == "user" else "Model replies (text)")
            totals[label] += n
    return totals


def summary_chars(messages):
    """Characters of summary text in a list of messages (a compaction block, or the client-side summary message)."""
    return message_chars(messages)["Compaction summary"]


def breakdown(session, tool_defs):
    """What fills the context, as (label -> estimated tokens). The last label is the provider's own overhead (real input tokens minus
    our estimate) when a call has been made. Returns (rows, total)."""
    rows = {label: n for label, n in session.system_parts.items()}
    rows["Tool definitions"] = len(json.dumps(tool_defs))
    rows.update(message_chars(session.messages))
    est = {label: _tokens(n) for label, n in rows.items()}
    u = session.last_usage
    if u:  # what the API counted that we cannot see: the provider's own tool instructions and message framing
        seen_by_api = sum(est.values()) - u["output"]  # the last reply was not part of the last call's input
        hidden = u["input"] + u["cache_read"] + u["cache_write"] - seen_by_api
        if hidden > 0:
            est["Provider overhead *"] = hidden
    return est, sum(est.values())


def report(session, tool_defs, model, window, limit=None, mode=None, extra=None):
    """Text for /context. The breakdown is estimated (~4 characters per token); the 'last call' line is the real
    count the API reported."""
    est, total = breakdown(session, tool_defs)
    u = session.last_usage
    lines = [f"Context  model {model}  window {f'{window:,} tokens' if window else 'unknown'}"]
    if u:
        used = u["input"] + u["cache_read"] + u["cache_write"]
        pct = f" ({used / window:.1%} of the window)" if window else ""
        lines.append(f"Last call used {used:,} input tokens{pct}: {u['input']:,} new, {u['cache_read']:,} read from cache, {u['cache_write']:,} written to cache; {u['output']:,} output.")
    else:
        lines.append("No model call yet since the session started or was last compacted, so there is no real token count; the breakdown below is an estimate.")
    lines.append("What fills it (estimated, ~4 characters per token):")
    width = max(len(label) for label in est)
    for label, n in est.items():
        share = f"{n / total:>5.0%}" if total else "    -"
        lines.append(f"  {label:<{width}}  {n:>8,}  {share}")
    lines.append(f"  {'Total':<{width}}  {total:>8,}")
    if "Provider overhead *" in est:
        lines.append("  * real input tokens minus our estimate: mostly the provider's own web search instructions "
                     "(compare with --no-web-search), plus message framing.")
    if window:
        free = max(window - total, 0)
        filled = min(round(30 * total / window), 30) if total else 0
        lines.append(f"  [{'█' * filled}{'░' * (30 - filled)}] {free:,} tokens free ({free / window:.1%})")
    if limit:
        state = "off for this session" if session.compact_disabled else f"on ({mode})"
        lines.append(f"Compaction: automatic at {limit:,} tokens, {state}; compacted {session.compactions} time(s) this session. /compact does it now.")
    lines += extra or []
    t = session.totals
    lines.append(f"This session so far: {t['input']:,} new input, {t['cache_read']:,} cache read, {t['cache_write']:,} cache write, {t['output']:,} output tokens over {t['calls']} calls.")
    return "\n".join(lines)
