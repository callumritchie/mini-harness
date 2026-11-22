"""One conversation, and the saved log behind it."""
import threading
from pathlib import Path

import context
import pricing
import sessionlog
import tools
from tools import Interrupted  # noqa: F401  (re-exported: the Stop button's exception)


class UserError(Exception):
    """A problem to show the user as a plain message, not a traceback."""


class NotFinished(Exception):
    """The run stopped before the work was done: a turn or spending limit, a cut-off or refused reply, a goal not met.
    Headless runs exit with code 3 so scripts can tell."""


class Limits:
    """A turn limit (model calls) and a spending limit (US dollars) for one run. Counted from when the run started, and
    including everything the run paid for: the judge, compaction and subagents too."""

    def __init__(self, session, max_turns=None, max_cost=None):
        self.max_turns, self.max_cost = max_turns, max_cost
        self.calls0, self.cost0 = session.totals["calls"], session.totals["cost_usd"]

    def turns(self, session):
        return session.totals["calls"] - self.calls0

    def spent(self, session):
        return session.totals["cost_usd"] - self.cost0

    def before_call(self, session):
        if self.max_turns and self.turns(session) >= self.max_turns:
            raise NotFinished(f"Stopped at the turn limit ({self.max_turns} model calls) before finishing. Raise it with --max-turns.")

    def after_call(self, session):
        if self.max_cost and self.spent(session) >= self.max_cost:
            raise NotFinished(f"Stopped at the spending limit (${self.max_cost:,.2f}; spent ${self.spent(session):,.4f}). Raise it with --max-cost.")


class Session:
    """One conversation. The system prompt is written here once and never touched again. The history only ever grows
    at the end (a failed task is cut off whole), so what was already sent stays byte-for-byte the same.
    With a log, every change is also appended to the session log the moment it happens."""

    def __init__(self, model, log=None, restored=None, kind="agent", parent=None):
        self.log, self.model, self.kind = log, model, kind
        self.reads = {}  # path -> (mtime, size) at the time the model last read or wrote it
        self.notes = []  # news for the model (e.g. a model switch); goes at the end of the next user message
        self.resume_report = None
        self.compactions = 0
        self.compact_disabled = False  # set when compacting cannot help (limit below the fixed cost)
        self.compact_retry_after = 0  # after a failed compaction, wait until the history has this many messages
        self.fresh_compaction = False  # the next call is the first since a compaction
        self.task_start, self.task_reads, self.task_notes = 0, {}, []  # where the task in progress began
        self.ask_human = lambda question, choices: None  # set by the front end; None answer = nobody can answer
        self.run_subagent = None  # set per task by the agent loop
        self.cancel = None  # a threading.Event set by a UI's Stop button; long tools poll it
        self.on_change = None  # called with (path, before, after) when write_file or edit_file changes a file
        self.last_cost = None
        self.unpriced_models = set()
        self.lock = threading.RLock()  # subagents running side by side each add their cost here
        if restored:  # rebuilt from a log: keep the logged instructions byte for byte
            self.system, self.system_parts, self.messages = restored["system"], restored["system_parts"], restored["messages"]
            self.last_usage, self.totals, self.model = restored["last_usage"], restored["totals"], restored["model"] or model
            self.user_messages = restored["user_messages"]
            self.compactions = self.totals["compactions"]
        else:
            self.system, self.system_parts = context.build_system(model, kind=kind)
            self.messages, self.user_messages, self.last_usage = [], [], None
            self.totals = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "calls": 0, "compactions": 0,
                           "searches": 0, "cost_usd": 0.0, "unpriced_calls": 0}
            self.emit({"type": "session", "version": sessionlog.VERSION, "id": log.id if log else None, "kind": kind, "parent": parent,
                       "cwd": str(Path.cwd()), "model": model, "system": self.system, "system_parts": self.system_parts})

    @property
    def id(self):
        return self.log.id if self.log else None

    @classmethod
    def start(cls, model, kind="agent", parent=None):
        """A new session that saves a log (subagents' logs are kept apart)."""
        return cls(model, sessionlog.Log.create(Path.cwd(), subagent=kind != "agent"), kind=kind, parent=parent)

    @classmethod
    def resume(cls, path=None):
        """Rebuild a session in this folder from its log (the latest one unless a path is given). Tool calls that never
        finished are marked not run."""
        path = Path(path) if path else sessionlog.latest_path(Path.cwd())
        if path is None:
            raise UserError("There is no earlier session for this folder to continue. Start one without -c.")
        events, skipped = sessionlog.load(path)
        if not any(e.get("type") == "session" for e in events):
            raise UserError(f"The session log {path} has no start record, so it cannot be continued. Start a new session without -c.")
        log = sessionlog.Log(path)
        state = sessionlog.replay(events)
        missing = sessionlog.unfinished(state["messages"])
        for tool_id, _, _ in missing:  # saved before anything else, so a crash during resume is also recoverable
            log.append({"type": "tool_result", "tool_use_id": tool_id, "content": sessionlog.NOT_RUN, "is_error": True, "not_run": True})
        if missing:
            state = sessionlog.replay(events + [{"type": "tool_result", "tool_use_id": i, "content": sessionlog.NOT_RUN, "is_error": True} for i, _, _ in missing])
        log.append({"type": "resume"})
        session = cls(state["model"], log, restored=state)
        session.resume_report = {"id": path.stem, "skipped": skipped, "not_run": [tools.describe_call(n, a) for _, n, a in missing]}
        return session

    def emit(self, event):
        if self.log:
            self.log.append(event)

    def add_user(self, content, human=None):
        """Add a user message. `human` is the text the person actually typed (what the permission judge may read)."""
        self.messages.append({"role": "user", "content": content})
        if human is not None:
            self.user_messages.append(human)
        self.emit({"type": "user", "content": content})

    def add_assistant(self, blocks, usage, model, stop_reason):
        self.messages.append({"role": "assistant", "content": blocks})  # in memory: exactly the objects returned
        self.emit({"type": "assistant", "model": model, "stop_reason": stop_reason, "usage": usage, "cost": {"usd": self.last_cost, "model": model},
                   "content": [sessionlog.block_to_json(b) for b in blocks]})

    def log_tool_result(self, result, sources=None):
        """Saved the moment the tool finishes, one event each, so a crash mid-batch keeps the finished ones. `sources` (search_docs)
        is kept in the log for front ends; replay never puts it back into what the model is sent."""
        self.emit({"type": "tool_result", **result, **({"sources": sources} if sources else {})})

    def add_tool_results(self, results):
        self.messages.append({"role": "user", "content": results})  # all results of one reply travel in one message

    def rollback(self, count):
        """Cut the conversation back to `count` messages. The log keeps everything and records the cut."""
        del self.messages[count:]
        self.emit({"type": "rollback", "messages": count})

    def begin_task(self):
        """Remember where this task starts, so a failure can cut back to it."""
        self.task_start, self.task_reads, self.task_notes = len(self.messages), dict(self.reads), list(self.notes)

    def abort_task(self):
        self.rollback(self.task_start)
        self.reads, self.notes = self.task_reads, self.task_notes

    def has_compaction_block(self):
        """True if the history starts with an Anthropic compaction block: every request that carries it needs the beta header."""
        if not self.messages or self.messages[0]["role"] != "assistant" or isinstance(self.messages[0]["content"], str):
            return False
        first = self.messages[0]["content"][0]
        return (first.get("type") if isinstance(first, dict) else getattr(first, "type", None)) == "compaction"

    def _count_cost(self, model, usd):
        if usd is None:
            self.totals["unpriced_calls"] += 1
            self.unpriced_models.add(model)
        else:
            self.totals["cost_usd"] += usd

    def apply_compaction(self, kind, messages, summary_len, reason, limit, replaced, usage, usd=None):
        """Swap the whole history for the summary messages. The log keeps everything before it; the event records the swap.
        Work that was in progress starts again from just after the summary."""
        self.messages[:] = messages
        self.reads.clear()  # the model no longer has those file contents in front of it
        self.last_usage, self.fresh_compaction = None, True
        self.compactions += 1
        self.totals["compactions"] += 1
        for k, v in usage.items():
            self.totals[k] += v
        self._count_cost(self.model, usd)
        self.task_start, self.task_reads = summary_len, {}
        self.emit({"type": "compact", "kind": kind, "reason": reason, "limit": limit, "replaced": replaced, "usage": usage,
                   "cost": {"usd": usd, "model": self.model},
                   "messages": [{"role": m["role"], "content": m["content"]} for m in messages]})

    def add_aux(self, label, model, usage, usd, **extra):
        """A call made on this session's behalf that is not part of the conversation (the judge, a subagent). It counts toward
        cost and tokens, not toward the turn limit, and is saved in the log."""
        with self.lock:
            for k, v in usage.items():
                self.totals[k] = self.totals.get(k, 0) + v
            self._count_cost(model, usd)
        self.emit({"type": "aux", "label": label, "model": model, "usage": usage, "cost": {"usd": usd, "model": model}, **extra})

    def record(self, usage, model=None):
        """Remember the token counts the API reported for one call, and what it cost. Returns the counts as a plain dict."""
        g = lambda name: getattr(usage, name, None) or 0
        searches = getattr(getattr(usage, "server_tool_use", None), "web_search_requests", 0) or 0
        self.last_usage = {"input": g("input_tokens"), "cache_read": g("cache_read_input_tokens"),
                           "cache_write": g("cache_creation_input_tokens"), "output": g("output_tokens"), "searches": searches}
        for k, v in self.last_usage.items():
            self.totals[k] += v
        self.totals["calls"] += 1
        self.last_cost = pricing.cost(model or self.model, self.last_usage)
        self._count_cost(model or self.model, self.last_cost)
        return self.last_usage

    def cost_summary(self):
        """(usd, complete, note): what the session has cost. usd is None if nothing could be priced; complete is False if some
        calls had no price."""
        t = self.totals
        if t["unpriced_calls"]:
            note = "; ".join(pricing.missing_note(m) for m in sorted(self.unpriced_models)) or f"{t['unpriced_calls']} call(s) had no price"
            return (t["cost_usd"] if t["cost_usd"] else None), False, note
        return t["cost_usd"], True, None
