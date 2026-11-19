"""The session log: every message is appended to a file the moment it happens, and -c rebuilds a session from it.
The file format is documented in DESIGN.md ('The session log').
"""
import datetime
import json
import os
import sys
import uuid
from pathlib import Path

VERSION = 1
NOT_RUN = ("Not run: the session stopped (a crash or an exit) before this tool call finished, so its outcome is "
           "unknown. Check the current state of the files before relying on it or repeating it.")


def home():
    """Where logs live. A project called mini-claude before it was renamed: if only the old folder exists, keep using it, so history is not lost."""
    env = os.environ.get("MINI_HARNESS_HOME") or os.environ.get("MINI_CLAUDE_HOME")
    if env:
        return Path(env)
    new, old = Path.home() / ".mini-harness", Path.home() / ".mini-claude"
    return old if old.is_dir() and not new.exists() else new


def project_dir(cwd):
    return home() / "sessions" / str(Path(cwd).resolve()).replace("/", "-")


def _has_prompt(path):
    """Whether anyone said anything in this session. A chat that was opened and closed leaves an empty log; it is never worth resuming."""
    return b'"type": "user"' in Path(path).read_bytes()


def latest_path(cwd, exclude=None):
    """The most recently written session log for this folder that has a prompt in it (subagent logs are kept apart), or None."""
    logs = [p for p in project_dir(cwd).glob("*.jsonl") if p != exclude and _has_prompt(p)] if project_dir(cwd).is_dir() else []
    return max(logs, key=lambda p: p.stat().st_mtime_ns) if logs else None


def _text_of(content):
    if isinstance(content, str):
        return content
    return next((b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"), "")


def list_sessions(cwd, limit=20, include=None):
    """Sessions in this folder, newest first, each titled by its first prompt: [{path, id, when, title, prompts, calls, cost}].
    Sessions nobody has said anything in are left out, except `include` (the current one)."""
    d = project_dir(cwd)
    if not d.is_dir():
        return []
    out = []
    for path in sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime_ns, reverse=True)[:limit]:
        events, _ = load(path)
        users = [_text_of(e["content"]) for e in events if e.get("type") == "user"]
        if not users and path != include:
            continue
        title = " ".join((users[0] if users else "(no prompt yet)").split())
        cost = sum((e.get("cost") or {}).get("usd") or 0 for e in events)
        out.append({"path": path, "id": path.stem, "when": datetime.datetime.fromtimestamp(path.stat().st_mtime),
                    "title": title[:70] + ("…" if len(title) > 70 else ""), "prompts": len(users),
                    "calls": sum(1 for e in events if e.get("type") == "assistant"), "cost": cost})
    return out


def block_to_json(block):
    """A reply block as the API returned it, as plain JSON. Fields that were never set or are null are left out: the
    SDK adds null placeholders to block types it does not know yet (e.g. `text: null` on a code execution result),
    and the API rejects those when they are sent back."""
    if isinstance(block, dict):
        return block
    if hasattr(block, "model_dump"):
        return block.model_dump(exclude_unset=True, exclude_none=True, mode="json")
    return {k: v for k, v in json.loads(json.dumps(vars(block), default=vars)).items() if v is not None}  # simple stand-ins used in tests


class Log:
    """Append-only: one JSON object per line, flushed and synced to disk before append() returns.
    Nothing already written is ever modified."""

    def __init__(self, path):
        self.path, self.id, self.failed = Path(path), Path(path).stem, False
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fresh = not self.path.exists()
        self.f = open(self.path, "ab")
        if fresh:
            os.chmod(self.path, 0o600)  # conversations can hold private things
        elif self.path.stat().st_size and not self.path.read_bytes().endswith(b"\n"):
            self.f.write(b"\n")  # a crash cut the last line short; start the next event on a fresh line
            self.f.flush()

    @classmethod
    def create(cls, cwd, subagent=False):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
        folder = project_dir(cwd) / "subagents" if subagent else project_dir(cwd)  # kept apart from the sessions you list and resume
        return cls(folder / f"{stamp}-{uuid.uuid4().hex[:8]}.jsonl")

    def append(self, event):
        if self.failed:
            return
        event = {"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"), **event}
        try:
            self.f.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
            self.f.flush()
            os.fsync(self.f.fileno())
        except OSError as e:  # a full disk must not kill the session
            self.failed = True
            print(f"Warning: could not write the session log ({e}). Carrying on without saving.", file=sys.stderr)


def load(path):
    """Read a log. Returns (events, skipped): lines that are not valid JSON (a cut-off last line) are skipped."""
    events, skipped = [], 0
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            skipped += 1
    return events, skipped


def replay(events):
    """Rebuild a session's state from its events."""
    s = {"id": None, "cwd": None, "model": None, "system": "", "system_parts": {}, "messages": [], "last_usage": None,
         "totals": {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "calls": 0, "compactions": 0,
                    "searches": 0, "cost_usd": 0.0, "unpriced_calls": 0}, "user_messages": []}
    messages, pending = s["messages"], []  # pending: tool results waiting to become one user message
    for ev in events:
        kind = ev.get("type")
        if kind == "tool_result":
            pending.append({"type": "tool_result", "tool_use_id": ev["tool_use_id"], "content": ev["content"],
                            "is_error": ev.get("is_error", False)})
            continue
        if pending:
            messages.append({"role": "user", "content": pending})
            pending = []
        if kind == "session":
            s.update(id=ev.get("id"), cwd=ev.get("cwd"), model=ev.get("model"), system=ev["system"],
                     system_parts=ev.get("system_parts", {}))
        elif kind == "user":
            messages.append({"role": "user", "content": ev["content"]})
            s["user_messages"].append(_text_of(ev["content"]))  # what the human typed (the judge reads these)
        elif kind == "assistant":
            messages.append({"role": "assistant", "content": ev["content"]})
            s["model"] = ev.get("model") or s["model"]
            if ev.get("usage"):
                s["last_usage"] = ev["usage"]
                for k, v in ev["usage"].items():
                    s["totals"][k] = s["totals"].get(k, 0) + v
                s["totals"]["calls"] += 1
            _add_cost(s["totals"], ev)
        elif kind == "rollback":
            del messages[ev["messages"]:]
        elif kind == "aux":  # a call made for the session but not part of the conversation: judge, subagent
            for k, v in (ev.get("usage") or {}).items():
                s["totals"][k] = s["totals"].get(k, 0) + v
            _add_cost(s["totals"], ev)
        elif kind == "compact":  # the conversation up to here is replaced by the summary
            messages[:] = ev["messages"]
            s["last_usage"] = None
            s["totals"]["compactions"] += 1
            for k, v in (ev.get("usage") or {}).items():
                s["totals"][k] = s["totals"].get(k, 0) + v
            _add_cost(s["totals"], ev)
        # "resume" markers and event types from a newer version are ignored
    if pending:
        messages.append({"role": "user", "content": pending})
    return s


def _add_cost(totals, event):
    """Add one event's saved cost to the totals. A call with no price counts as unpriced, never as $0."""
    c = event.get("cost")
    if c is None:
        return
    if c.get("usd") is None:
        totals["unpriced_calls"] += 1
    else:
        totals["cost_usd"] += c["usd"]


def unfinished(messages):
    """tool_use blocks in the last assistant message that never got a result: [(id, name, input)]."""
    last = next((i for i in range(len(messages) - 1, -1, -1) if messages[i]["role"] == "assistant"), None)
    if last is None or isinstance(messages[last]["content"], str):
        return []
    answered = set()
    for m in messages[last + 1:]:
        if m["role"] == "user" and isinstance(m["content"], list):
            answered |= {b.get("tool_use_id") for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result"}
    calls = [block_to_json(b) for b in messages[last]["content"]]  # in memory these are SDK objects, from a log they are dicts
    return [(b["id"], b["name"], b.get("input", {})) for b in calls if b.get("type") == "tool_use" and b["id"] not in answered]


def render_messages(messages):
    """The conversation as a list of items for a UI to draw: {kind: user|assistant|tool|summary, ...}. Works on messages rebuilt
    from a log (dicts) and on live ones (SDK objects). Notes we added to a user message are left out."""
    items, tools_by_id = [], {}
    for m in messages:
        role, content = m["role"], m["content"]
        if isinstance(content, str):
            blocks = [{"type": "text", "text": content}]
        else:
            blocks = [block_to_json(b) for b in content]
        for i, b in enumerate(blocks):
            kind = b.get("type")
            if kind == "text":
                text = b.get("text", "")
                if role == "user":
                    if i > 0 and text.startswith("[Note:"):
                        continue
                    kind_name = "summary" if text.startswith("This conversation was compacted.") else "user"
                    if text == "[Note: the conversation was compacted into the summary above to save space. Continue the task from where you left off.]":
                        continue
                    items.append({"kind": kind_name, "text": text})
                elif text.strip():
                    items.append({"kind": "assistant", "text": text})
            elif kind in ("tool_use", "server_tool_use"):
                item = {"kind": "tool", "id": b.get("id"), "name": b.get("name"), "input": b.get("input", {}), "result": None, "is_error": False}
                tools_by_id[b.get("id")] = item
                items.append(item)
            elif kind in ("tool_result", "web_search_tool_result"):
                item = tools_by_id.get(b.get("tool_use_id"))
                if item is not None:
                    content_ = b.get("content")
                    item["result"] = content_ if isinstance(content_, str) else f"{len(content_) if isinstance(content_, list) else 0} result(s)"
                    item["is_error"] = bool(b.get("is_error"))
            elif kind == "compaction":
                items.append({"kind": "summary", "text": b.get("content") or ""})
    return items
