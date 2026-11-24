"""The state and the actions behind every front end (the terminal chat and the web UI).

A front end supplies a `UI` (how to show things and how to ask the person); the Controller holds the session, model, permissions
and settings, and has one method per action. The terminal's slash commands and the web UI's buttons call the same methods.
"""
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import anthropic

import agent
import attachments
import compaction
import context
import embed
import graph
import pricing
import rag
import sessionlog
import skills
import tools
from permissions import MODE_HELP, MODES, PLAN_OFF_NOTE, PLAN_ON_NOTE
from session import Limits, NotFinished, Session, UserError


class UI:
    """What a front end provides. Every method has a harmless default, so a front end implements only what it shows."""

    def text(self, delta): pass  # a piece of the model's reply, as it streams
    def thinking(self, delta): pass  # a piece of the model's reasoning (a summary), as it streams
    def tool_call(self, call_id, name, args, display): pass  # a tool is about to run
    def tool_result(self, call_id, name, text, is_error, meta=None): pass  # meta: {"sources": [...]} or {"graph": {...}}, structured
    def usage(self, usage, cost, summary): pass  # tokens and cost of one call; summary = (total usd, complete, note)
    def notice(self, text): pass  # compaction, the judge, subagent activity, goal progress...
    def change(self, path, before, after): pass  # a file was written or edited (before is None for a new file)
    def status(self, running): pass
    def ask_permission(self, assessment, note): return False  # the yes/no question; must return True only for an explicit yes
    def ask_user(self, question, choices): return None  # the ask_user tool; None means nobody can answer
    def approve_plan(self, plan): return None  # exit_plan_mode: ("approve", None), ("revise", feedback), or None (nobody can answer)
    def parallel(self, call_ids): pass  # these tool calls (from one reply) are about to run at the same time

    def event(self, kind, data, text):
        """Structured progress (goal rounds, checks, subagent steps). A front end that does not know them shows the text as a notice."""
        if text:
            self.notice(text)


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
        self.index_job = threading.Lock()  # one background index job at a time

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
        self.mcp = agent.start_mcp_and_skills(self.args)
        self._bind(self.session)
        if getattr(self.args, "plan", False):
            self.set_plan(True)
        rag.AUTO = False  # interactive: a folder is indexed only once the person has chosen what to search (choose_search)
        self._index_in_background("start")
        return self.info()

    def _may_download(self):
        """Search by meaning is always on: its model is downloaded in the background the first time, unless this is the demo or
        MINI_HARNESS_EMBED_DOWNLOAD=0 (tests, offline machines). Until it is here, searches use keywords alone."""
        return not getattr(self.args, "demo", False) and os.environ.get("MINI_HARNESS_EMBED_DOWNLOAD", "1") != "0"

    def _index_in_background(self, trigger="after task"):
        """Bring the document index, its structure graph and its vectors up to date without holding anything up. Runs at start and
        after every task, once the person has chosen what to search (an empty folder needs no choice: everything, as files come);
        a job already running is not started twice. --no-index skips it (the tools still update the index when they are used)."""
        if not rag.available() or getattr(self.args, "no_index", False):
            return
        try:
            index = rag.get(Path.cwd())
            if index.selection() is None and index.plan(limit=50)["empty"]:
                index.choose()
            if not index.allowed():
                return
        except Exception as e:  # noqa: BLE001
            self.ui.notice(f"The document index could not be read: {e}")
            return
        if not self.index_job.acquire(blocking=False):
            return

        def go():
            try:
                index.sync(trigger=trigger)
                graph.build_structure(index)
                embedder = embed.get(allow_download=self._may_download() and embed.available())
                if embedder is not None:
                    s = index.embed_pending(embedder)
                    if s and s["embedded"] and index.recent:
                        index.recent[-1]["embedded"] = s["embedded"]
            except Exception as e:  # noqa: BLE001 - search_docs tries again on its own; the person should still know
                self.ui.notice(f"The document index could not be updated: {e}")
            finally:
                self.index_job.release()
        threading.Thread(target=go, daemon=True).start()

    def index_plan(self):
        """What searching this folder would take, for the first-open question (Index.plan)."""
        return self._index().plan()

    def choose_search(self, off=False, excluded=(), included=(), gitignore=True):
        """Save what the person chose to search and, unless it was "not now", index it in the background. Returns a line to show."""
        index = self._index()
        sel = index.choose(off, excluded, included, gitignore)
        if sel["off"]:
            return "Search is off for this folder. The agent will use grep and read files directly. Turn it on from the Knowledge tab or /index."
        self._index_in_background("first choice" if not index.recent else "choice changed")
        left = len(sel["excluded"])
        return "Indexing this folder for search" + (f", leaving out {left} folder(s) or file(s) you unticked" if left else "") + "."

    @property
    def limit(self):
        return self.args.context_limit or agent.DEFAULT_LIMIT

    def info(self):
        s = self.session
        usd, complete, note = s.cost_summary()
        return {
            "project": str(Path.cwd()), "model": self.model, "provider": self.provider, "permissions": self.permissions.mode,
            "effort": self.args.effort, "limit": self.limit, "session_id": s.id, "client_ready": self.client is not None,
            "client_error": self.client_error, "efforts": list(agent.EFFORTS), "models": [{"id": i, "note": n} for i, n in agent.MODEL_CHOICES], "modes": list(MODES), "mode_help": MODE_HELP,
            "agents_md": context.AGENTS_FILE in s.system_parts, "skills": [x["name"] for x in skills.discover(Path.cwd())[0]],
            "mcp_tools": sorted(self.mcp.tools) if self.mcp else [], "price_known": pricing.prices(self.model) is not None,
            "cost": {"usd": usd, "complete": complete, "note": note}, "turns": s.totals["calls"], "compactions": s.compactions,
            "plan": self.permissions.plan,
            "index": self.index_status(),
        }

    def index_status(self):
        return rag.status(Path.cwd(), embed.loaded())

    def _bind(self, session):
        self.session = session
        session.ask_human = self.ui.ask_user
        session.approve_plan = self._approve_plan
        session.plan_mode = lambda: self.permissions.plan
        if getattr(self, "permissions", None) is not None and self.permissions.plan:  # a fresh conversation must be told too
            session.notes.append(PLAN_ON_NOTE)

    def _approve_plan(self, plan):
        """exit_plan_mode asks the person; an approval turns plan mode off at once, so the same task can carry the plan out."""
        answer = self.ui.approve_plan(plan)
        if answer is not None and answer[0] == "approve":
            self.permissions.plan = False
            self.ui.event("plan_mode", {"on": False}, "Plan approved: plan mode is off.")
        return answer

    # ---------- running a task ----------

    def make_run(self, **overrides):
        s = self.session
        settings = dict(
            on_text=self.ui.text, on_thinking=self.ui.thinking, on_tool=lambda name, args: None,
            on_call=lambda cid, name, args: self.ui.tool_call(cid, name, args, tools.describe_call(name, args)),
            on_result=self.ui.tool_result, on_change=self._changed, cancel=self.cancel, say=self.ui.notice,
            on_usage=lambda u, usd: self.ui.usage(u, usd, s.cost_summary()), event=self.ui.event, on_parallel=self.ui.parallel,
            limits=Limits(s, max_turns=self.args.max_turns or agent.MAX_STEPS, max_cost=self.args.max_cost),
        )
        settings.update(overrides)
        return agent.make_run(self.client, self.provider, self.model, self.args, self.permissions, self.mcp, s, **settings)

    def _changed(self, path, before, after):
        """The agent wrote a file: show it, and re-index it now (if a sync is running, that sync or the next search sees it)."""
        self.ui.change(path, before, after)
        if rag.available():
            try:
                index = rag.get(Path.cwd())
                if index.allowed():
                    index.update_paths([path])
            except Exception:  # noqa: BLE001 - the index is a convenience; it must never break a write
                pass

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
            self._index_in_background("after task")  # the task may have changed files: catch the graph and vectors up

    def send(self, text, files=()):
        """Run one task. `files` are attachments.Attachment objects; they go to the model before the text."""
        def go():
            task = attachments.to_blocks(list(files), text, self.provider) if files else text
            reply = agent.run_task(self.make_run(), self.session, task, human=text)
            return TaskResult(text=agent.final_text(reply), stop_reason=reply.stop_reason, cut_off=reply.stop_reason == "max_tokens")
        return self._guard(go)

    def goal(self, text, verify=None, max_turns=None):
        """Goal mode on this session. Returns a TaskResult whose text is the outcome ('GOAL DONE ...' or 'GOAL NOT DONE ...')."""
        if self.permissions.plan:
            return TaskResult(error="Plan mode is on. Turn it off first: goal mode needs to change files.")

        def go():
            limits = Limits(self.session, max_turns=max_turns or self.args.max_turns or agent.GOAL_STEPS, max_cost=self.args.max_cost)
            run = self.make_run(limits=limits)
            ok, out, _ = agent.do_goal(run, self.session, text, verify, say=self.ui.notice, event=self.ui.event, max_turns=limits.max_turns)
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

    def set_plan(self, on):
        """Plan mode on or off. The model is told at the end of the next message (the prompt cache is not touched)."""
        on = bool(on)
        if on != self.permissions.plan:
            self.permissions.plan = on
            self.session.notes.append(PLAN_ON_NOTE if on else PLAN_OFF_NOTE)
        return ("Plan mode is on: the agent can only read and search until you approve its plan." if on
                else "Plan mode is off: the agent can make changes again (your permission mode still applies).")

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

    # ---------- the document index ----------

    def _index(self):
        if not rag.available():
            raise UserError("The document index needs SQLite with full-text search (FTS5), and this Python's SQLite does not have it.")
        return rag.get(Path.cwd())

    def reindex(self, rebuild=False, embed_now=False):
        """/index: bring the document index and its structure graph up to date now (rebuild: from nothing). With embed_now, also
        embed every passage for search by meaning, downloading the local model first if it is not here yet. Returns text."""
        index = self._index()
        if not index.allowed():  # asking for /index is the choice: everything (the .gitignore still counts)
            index.choose()
        lines = [rag.describe(index.sync(rebuild=rebuild, trigger="you asked"))]
        g = graph.build_structure(index)
        counts = index.counts()
        lines.append(f"Map: {counts['entities']:,} names and {counts['edges']:,} connections ({g['parsed']} file(s) read, {g['cached']} from cache).")
        if embed_now and not embed.available():
            raise UserError("\n".join(lines + [f"Search by meaning needs the local embedding model: {embed.install_command()} (it brings "
                                               f"fastembed and numpy), restart, then /index --embed again. The model ({embed.MODEL_SIZE_NOTE}) is "
                                               "downloaded once and runs on this computer; nothing is sent anywhere."]))
        embedder = embed.get(allow_download=embed_now)
        if embedder is not None:
            s = index.embed_pending(embedder, cancel=self.cancel)
            if s is None:
                lines.append("Embedding is already running in the background.")
            else:
                lines.append(f"Meaning: {index.embedded(embedder):,} of {counts['chunks']:,} chunks embedded with {embedder.model_id}"
                             f" ({s['embedded']} new{', stopped' if s['stopped'] else ''}).")
        elif embed.available():
            lines.append(f"Search by meaning is off: /index --embed downloads the local model ({embed.MODEL_SIZE_NOTE}) and turns it on.")
        return "\n".join(lines)

    def graph_estimate(self, prose_only=True, model=None):
        """What /graph build would read and roughly cost (nothing is sent)."""
        index = self._index()
        graph.ensure(index)
        return graph.estimate(index, model or graph.LLM_MODEL, prose_only)

    def graph_build(self, prose_only=True, model=None):
        """/graph build: a model reads each new prose passage once and adds the concepts and relations it finds. Costs money:
        every call is counted in the session's cost and stops at --max-cost; Stop ends it. Returns a TaskResult."""
        model = model or graph.LLM_MODEL

        def go():
            index = self._index()
            graph.ensure(index)
            provider = agent.provider_for(model)
            client = self.client if provider == self.provider else self.client_factory(provider)
            limits = Limits(self.session, max_cost=self.args.max_cost)
            before = self.session.totals["cost_usd"]

            def on_cost(usage, usd):
                self.session.add_aux("graph", model, usage, usd)
                limits.after_call(self.session)
            s = graph.build_llm(index, client, model, prose_only, on_cost=on_cost, cancel=self.cancel, say=self.ui.notice)
            if s["stopped"]:
                raise KeyboardInterrupt
            counts = index.counts()
            spent = self.session.totals["cost_usd"] - before
            text = (f"Concepts added: {s['read']} chunk(s) read by {model} ({pricing.money(spent)}), {s['cached']} from earlier reads"
                    + (f", {s['invalid']} unusable answer(s) skipped" if s["invalid"] else "")
                    + f". The map has {counts['entities']:,} names and {counts['edges']:,} connections.")
            self.ui.notice(text)
            return TaskResult(text=text)
        return self._guard(go)

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
