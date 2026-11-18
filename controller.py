"""The state and the actions behind every front end (the terminal chat and the web UI).

A front end supplies a `UI` (how to show things and how to ask the person); the Controller holds the session, model, permissions
and settings, and has one method per action. The terminal's slash commands and the web UI's buttons call the same methods.
"""
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import anthropic

import agent
import compaction
import context
import pricing
import sessionlog
import skills
import tools
from permissions import MODE_HELP, MODES
from session import Limits, NotFinished, Session, UserError


class UI:
    """What a front end provides. Every method has a harmless default, so a front end implements only what it shows."""

    def text(self, delta): pass  # a piece of the model's reply, as it streams
    def tool_call(self, call_id, name, args, display): pass  # a tool is about to run
    def tool_result(self, call_id, name, text, is_error): pass
    def usage(self, usage, cost, summary): pass  # tokens and cost of one call; summary = (total usd, complete, note)
    def notice(self, text): pass  # compaction, the judge, subagent activity, goal progress...
    def change(self, path, before, after): pass  # a file was written or edited (before is None for a new file)
    def status(self, running): pass
    def ask_permission(self, assessment, note): return False  # the yes/no question; must return True only for an explicit yes
    def ask_user(self, question, choices): return None  # the ask_user tool; None means nobody can answer


@dataclass
class TaskResult:
    """How a task ended. Exactly one of the fields describes it."""
    text: str = ""  # the model's final answer
    stop_reason: Optional[str] = None
    cut_off: bool = False  # the reply hit the maximum length
    interrupted: bool = False  # Ctrl-C or the Stop button
    stopped: Optional[str] = None  # a limit was reached, or the reply was refused: the message
    error: Optional[str] = None  # something could not run: the message


class Controller:
    def __init__(self, args, ui, client_factory=None):
        self.args, self.ui = args, ui
        self.client_factory = client_factory or agent.make_client
        self.cancel = threading.Event()
        self.lock = threading.Lock()  # one task at a time
        self.listing = []
        self.client = self.client_error = self.mcp = None

    # ---------- start ----------

    def start(self):
        """Open or resume the session, create the client (a missing key is reported, not fatal), start MCP servers."""
        self.session, self.model = agent.open_session(self.args)
        self.provider = agent.provider_for(self.model)
        try:
            self.client = self.client_factory(self.provider)
        except UserError as e:
            self.client_error = str(e)
        self.permissions = agent.make_permissions(self.args, interactive=True)
        self.permissions.ask = self.ui.ask_permission
        self.permissions.say = self.ui.notice
        self.mcp = agent.start_mcp_and_skills()
        self.session.ask_human = self.ui.ask_user
        return self.info()

    @property
    def limit(self):
        return self.args.context_limit or agent.DEFAULT_LIMIT

    def info(self):
        s = self.session
        usd, complete, note = s.cost_summary()
        return {
            "project": str(Path.cwd()), "model": self.model, "provider": self.provider, "permissions": self.permissions.mode,
            "effort": self.args.effort, "limit": self.limit, "session_id": s.id, "client_ready": self.client is not None,
            "client_error": self.client_error, "efforts": list(agent.EFFORTS), "modes": list(MODES), "mode_help": MODE_HELP,
            "agents_md": context.AGENTS_FILE in s.system_parts, "skills": [x["name"] for x in skills.discover(Path.cwd())[0]],
            "mcp_tools": sorted(self.mcp.tools) if self.mcp else [], "price_known": pricing.prices(self.model) is not None,
            "cost": {"usd": usd, "complete": complete, "note": note}, "turns": s.totals["calls"], "compactions": s.compactions,
        }

    def _bind(self, session):
        self.session = session
        session.ask_human = self.ui.ask_user

    # ---------- running a task ----------

    def make_run(self, **overrides):
        s = self.session
        settings = dict(
            on_text=self.ui.text, on_tool=lambda name, args: None,
            on_call=lambda cid, name, args: self.ui.tool_call(cid, name, args, tools.describe_call(name, args)),
            on_result=self.ui.tool_result, on_change=self.ui.change, cancel=self.cancel, say=self.ui.notice,
            on_usage=lambda u, usd: self.ui.usage(u, usd, s.cost_summary()),
            limits=Limits(s, max_turns=self.args.max_turns or agent.MAX_STEPS, max_cost=self.args.max_cost),
        )
        settings.update(overrides)
        return agent.make_run(self.client, self.provider, self.model, self.args, self.permissions, self.mcp, s, **settings)

    def _guard(self, fn):
        """Run `fn` (which returns a TaskResult) and turn every way it can end into a TaskResult. Only one at a time."""
        if self.client is None:
            return TaskResult(error=self.client_error or "No API key yet. Set one and restart, or switch to a model you have a key for.")
        if not self.lock.acquire(blocking=False):
            return TaskResult(error="A task is already running. Stop it first.")
        self.cancel.clear()
        self.ui.status(True)
        try:
            return fn()
        except KeyboardInterrupt:  # Ctrl-C, or the Stop button (Interrupted)
            return TaskResult(interrupted=True)
        except NotFinished as e:
            return TaskResult(stopped=str(e))
        except UserError as e:
            return TaskResult(error=str(e))
        except anthropic.APIError as e:
            return TaskResult(error=agent.explain(e, self.provider, self.model))
        finally:
            self.ui.status(False)
            self.lock.release()

    def send(self, text):
        def go():
            reply = agent.run_task(self.make_run(), self.session, text)
            return TaskResult(text=agent.final_text(reply), stop_reason=reply.stop_reason, cut_off=reply.stop_reason == "max_tokens")
        return self._guard(go)

    def goal(self, text, verify=None, max_turns=None):
        """Goal mode on this session. Returns a TaskResult whose text is the outcome ('GOAL DONE ...' or 'GOAL NOT DONE ...')."""
        def go():
            limits = Limits(self.session, max_turns=max_turns or self.args.max_turns or agent.GOAL_STEPS, max_cost=self.args.max_cost)
            run = self.make_run(limits=limits)
            ok, out, _ = agent.do_goal(run, self.session, text, verify, say=self.ui.notice)
            return TaskResult(text=out, stopped=None if ok else out)
        return self._guard(go)

    def stop(self):
        """The Stop button: ask the running task to end the way Ctrl-C does."""
        self.cancel.set()

    # ---------- settings ----------

    def set_model(self, name):
        """Switch model (and provider). Raises UserError if there is no key for it. Returns a note (or '')."""
        client = self.client_factory(agent.provider_for(name))
        self.session.notes.append(f"The model was switched from {self.model} to {name}. Earlier replies in this conversation came from {self.model}.")
        self.model, self.provider, self.client, self.client_error = name, agent.provider_for(name), client, None
        return "" if pricing.prices(name) is not None else f"Note: {pricing.missing_note(name)}."

    def set_permissions(self, mode):
        if mode not in MODES:
            raise UserError(f"Unknown mode '{mode}'. Choose one of: {', '.join(MODES)}.")
        self.permissions.mode = mode
        return f"Permissions: {mode} - {MODE_HELP[mode]}."

    def set_effort(self, level):
        """level: one of agent.EFFORTS, or None/'default' to clear."""
        if level in (None, "default"):
            self.args.effort = None
        elif level in agent.EFFORTS:
            self.args.effort = level
        else:
            raise UserError(f"Unknown effort '{level}'. Choices: {', '.join(agent.EFFORTS)}, default.")
        return self.args.effort

    def set_limit(self, tokens):
        if not isinstance(tokens, int) or tokens < 1:
            raise UserError("The limit must be a whole number of tokens above 0.")
        self.args.context_limit, self.session.compact_disabled = tokens, False
        return tokens

    # ---------- sessions ----------

    def include_path(self):
        return self.session.log.path if self.session.log else None

    def list_sessions(self):
        self.listing = sessionlog.list_sessions(Path.cwd(), include=self.include_path())
        return self.listing

    def new_session(self):
        self._bind(Session.start(self.model))

    def resume(self, ref=None):
        """Continue a session: by number from the last listing, by id prefix, or (None) the most recent other one. Returns the
        resume report; raises UserError if there is no such session or no key for its model."""
        listing = self.listing or self.list_sessions()
        if not ref:
            path = sessionlog.latest_path(Path.cwd(), exclude=self.include_path())
        elif str(ref).isdigit() and 1 <= int(ref) <= len(listing):
            path = listing[int(ref) - 1]["path"]
        else:
            path = next((s["path"] for s in listing if s["id"].startswith(str(ref))), None)
        if path is None:
            raise UserError("No such session. Use /sessions to see the list.")
        session = Session.resume(path)
        model = session.model or self.model
        try:
            client = self.client_factory(agent.provider_for(model))
        except UserError:
            session.log.f.close()
            raise
        self._bind(session)
        self.model, self.provider, self.client, self.client_error = model, agent.provider_for(model), client, None
        return session.resume_report

    # ---------- context and compaction ----------

    def tool_defs(self):
        return agent.tool_list(self.provider, self.model, not self.args.no_web_search, self.mcp)

    def window(self):
        return agent.context_window(self.client, self.provider, self.model) if self.client else None

    def context_text(self):
        usd, complete, note = self.session.cost_summary()
        cost = f"Cost so far: {pricing.money(usd) if usd is not None else 'unknown'}" + ("" if complete else f" (incomplete: {note})")
        return context.report(self.session, self.tool_defs(), self.model, self.window(), self.limit, self.args.compaction,
                              extra=[cost, f"Permissions: {self.permissions.mode}. Effort: {self.args.effort or 'default'}."])

    def context_data(self):
        rows, total = context.breakdown(self.session, self.tool_defs())
        return {"rows": rows, "total": total, "window": self.window(), "limit": self.limit, "last_usage": self.session.last_usage,
                "totals": self.session.totals, "compactions": self.session.compactions, "compact_disabled": self.session.compact_disabled}

    def compact(self, focus=None):
        """Replace the conversation with a summary now. Raises UserError if it cannot."""
        if self.client is None:
            raise UserError("No API key yet, so there is no model to write the summary.")
        if len(self.session.messages) < 2:
            raise UserError("Nothing to compact yet.")
        c = agent.make_compactor(self.client, self.provider, self.model, self.args, self.limit, self.mcp, say=self.ui.notice)
        try:
            c.run(self.session, mid_task=False, reason="manual", focus=focus or None)
        except compaction.CompactionFailed as e:
            raise UserError(f"Could not compact: {e}.")
        except anthropic.APIError as e:
            raise UserError(f"Could not compact: {agent.explain(e, self.provider, self.model)}")
