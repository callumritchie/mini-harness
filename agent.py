#!/usr/bin/env python3
"""mini-harness: a small coding agent. See README.md for how to run it and DESIGN.md for why it is built this way."""
import argparse
import atexit
import dataclasses
import itertools
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import anthropic

import compaction
import goal as goalmode
import mcp as mcplib
import pricing
import safety
import skills
import tools
from permissions import MODES, Permissions
from session import Limits, NotFinished, Session, UserError

DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic")
DEFAULT_MODELS = {"anthropic": "claude-sonnet-5-5", "deepseek": "deepseek-flash"}
# The models offered in the picker (any other model id still works: type it after /model, or choose "Other" in the web UI).
MODEL_CHOICES = [
    ("claude-sonnet-5-5", "Sonnet 5.5: the default; fast and capable for most work"),
    ("claude-opus-5-5", "Opus 5.5: strongest reasoning, for hard problems"),
    ("claude-haiku-5-5", "Haiku 5.5: cheapest and fastest, for simple tasks"),
    ("claude-fable-5-1", "Fable 5.1: Anthropic's top tier, the most expensive"),
    ("deepseek-flash", "DeepSeek Flash: low cost (needs DEEPSEEK_API_KEY)"),
    ("deepseek-v4-pro", "DeepSeek V4 Pro (needs DEEPSEEK_API_KEY)"),
]
KEY_VARS = {"anthropic": "ANTHROPIC_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}
MAX_TOKENS = {"anthropic": 32000, "deepseek": 8192}
DEFAULT_LIMIT = 150_000  # tokens in one request before the conversation is compacted
KNOWN_WINDOWS = {"deepseek-flash": 1_000_000, "deepseek-v4-pro": 1_000_000}  # from DeepSeek's pricing page
MAX_STEPS = 50  # model calls in one task when no limit is set (--max-turns and goal mode set their own)
GOAL_STEPS = 100  # model calls in a whole goal unless --max-turns says otherwise
SUBAGENT_STEPS = 30
PARALLEL_SUBAGENTS = 4  # subagent calls from one reply that run at the same time
EFFORTS = ("low", "medium", "high", "xhigh", "max")
EXIT_OK, EXIT_ERROR, EXIT_NOT_FINISHED, EXIT_RETRYABLE, EXIT_INTERRUPTED = 0, 1, 3, 4, 130  # 4: the provider was busy or unreachable; try again
RETRIES = 3  # times one model call is repeated after a dropped connection, a rate limit or an overloaded provider
RETRY_BASE = 1.0  # seconds; the wait doubles each time (tests set it to 0)
RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
# Claude models that get the newer web search (dynamic filtering). Everything else gets the basic version.
MODERN_WEB_SEARCH = ("claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
                     "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable")

_windows = {}  # model -> context window size (None if unknown)


# ---------- client ----------

def provider_for(model):
    return "deepseek" if model.lower().startswith("deepseek") else "anthropic"


def default_model():
    if not os.environ.get(KEY_VARS["anthropic"]) and os.environ.get(KEY_VARS["deepseek"]):
        return DEFAULT_MODELS["deepseek"]
    return DEFAULT_MODELS["anthropic"]


def make_client(provider):
    key = os.environ.get(KEY_VARS[provider])
    if not key:
        raise UserError(missing_key_help(provider))
    if provider == "deepseek":
        return anthropic.Anthropic(api_key=key, base_url=DEEPSEEK_BASE_URL, max_retries=3)
    return anthropic.Anthropic(api_key=key, max_retries=3)  # the SDK retries a request that has not started; agent_loop retries one that broke mid-reply


def retryable(err):
    """Might the same request work a moment later? A dropped connection or timeout, a rate limit, or the provider being busy or down.
    (A wrong key, a bad request or an unknown model will not get better by waiting.)"""
    if isinstance(err, anthropic.APIConnectionError):  # includes timeouts
        return True
    if isinstance(err, anthropic.APIStatusError):
        body = getattr(err, "body", None)  # an error event in the middle of a stream has status 200 and the real kind in the body
        kind = ((body.get("error") or {}).get("type") if isinstance(body, dict) and isinstance(body.get("error"), dict) else None)
        return err.status_code in RETRY_STATUS or kind in ("overloaded_error", "api_error", "rate_limit_error")
    return False


def missing_key_help(provider):
    var = KEY_VARS[provider]
    where = "https://console.anthropic.com/settings/keys" if provider == "anthropic" else "https://platform.deepseek.com/api_keys"
    other = "deepseek" if provider == "anthropic" else "anthropic"
    return (
        f"No {provider} API key found (environment variable {var} is not set).\n"
        f"  1. Create a key at {where}\n"
        f"  2. Open ~/.zshrc in an editor and add the line:  export {var}=\"<your key>\"\n"
        "     (edit the file rather than typing the key into a command, so it stays out of your shell history;\n"
        "     keep it out of this project folder)\n"
        "  3. Run:  source ~/.zshrc\n"
        f"Using {other} instead? Set {KEY_VARS[other]} and pass --model {DEFAULT_MODELS[other]}."
    )


def explain(err, provider, model):
    """Turn an API error into one clear sentence. Most specific classes first."""
    message = _explain(err, provider, model)
    if getattr(err, "progress_kept", False):
        message += " The work done so far is kept (files changed stay changed): say 'continue' to carry on."
    return message


def _explain(err, provider, model):
    if isinstance(err, anthropic.AuthenticationError):
        return f"The {provider} API key was rejected. Check that {KEY_VARS[provider]} holds a valid, active key."
    if isinstance(err, anthropic.PermissionDeniedError):
        return f"Your {provider} key is not allowed to do that: {err.message}"
    if isinstance(err, anthropic.NotFoundError):
        return f"Model '{model}' was not found on {provider}. Check the spelling (--model, or /model in chat)."
    if isinstance(err, anthropic.BadRequestError):
        hint = " Web search may not be available to your account; try again with --no-web-search." if "web_search" in str(err.message) else ""
        if "effort" in str(err.message):
            hint += " This model may not support --effort; try without it."
        return f"{provider} rejected the request: {err.message}{hint}"
    if isinstance(err, anthropic.RateLimitError):
        return f"{provider} rate limit hit. Wait a moment and try again."
    if isinstance(err, anthropic.APIConnectionError):
        return f"Could not reach {provider} ({err}). Check your network connection."
    if isinstance(err, anthropic.APIStatusError):
        return f"{provider} returned an error (HTTP {err.status_code}): {err.message}"
    return str(err)


def tool_list(provider, model, web_search, mcp=None, names=None):
    """Our tools, the provider's own web search (it runs on their servers), and any MCP tools, in a fixed order. `names`
    limits it to those of our tools (a subagent gets read-only ones and nothing else)."""
    defs = [t for t in tools.TOOLS if names is None or t["name"] in names]
    if names is not None:
        return defs
    if web_search:
        kind = "web_search_20260209" if provider == "anthropic" and model.startswith(MODERN_WEB_SEARCH) else "web_search_20250305"
        defs.append({"type": kind, "name": "web_search", "max_uses": 5})
    if mcp:
        defs += mcp.tool_defs()
    return defs


# ---------- the loop ----------

@dataclass
class Run:
    """Everything one task needs, so a subagent can be the same loop with a few things changed."""
    client: object
    provider: str
    model: str
    permissions: Permissions
    on_text: Callable = lambda text: None
    on_tool: Callable = lambda name, args: None
    on_usage: Optional[Callable] = None  # called with (usage dict, cost in dollars or None)
    web_search: bool = True
    effort: Optional[str] = None
    compactor: Optional[compaction.Compactor] = None
    limits: Optional[Limits] = None
    mcp: Optional[object] = None
    tool_names: Optional[list] = None  # None: all tools. A list: only those (and everything else is refused)
    say: Callable = lambda msg: None
    # Hooks for richer front ends (the web UI). All optional.
    on_call: Optional[Callable] = None  # (id, name, args) when a tool is about to run
    on_result: Optional[Callable] = None  # (id, name, text, is_error) when it finished
    on_change: Optional[Callable] = None  # (path, before, after) when write_file or edit_file changed a file
    cancel: Optional[object] = None  # a threading.Event: when set (the Stop button) the task stops like Ctrl-C
    event: Optional[Callable] = None  # (kind, data, text): a structured progress event; without it the text is said as a notice
    on_parallel: Optional[Callable] = None  # (ids) before several calls from one reply start together


def notify(run, kind, data, text):
    """Report progress. A front end that understands `kind` gets the data; every other one gets the same line of text as before."""
    if run.event is not None:
        run.event(kind, data, text)
    else:
        run.say(text)


def request_body(run):
    """Anthropic-only request extras: cache the conversation, and the reasoning effort. (The installed SDK has no argument for
    either, so they go in the request body.) DeepSeek caches on its own and has no effort setting."""
    if run.provider != "anthropic":
        return {}
    body = {"cache_control": {"type": "ephemeral"}}
    if run.effort:
        body["output_config"] = {"effort": run.effort}
    return {"extra_body": body}


def prepare(run, use):
    """Everything that comes before a tool runs: is it allowed here, is the input valid, may it run (this is where the person is
    asked). Returns (text, is_error) if the call is answered right here (refused, invalid, denied), or None: go ahead and run it."""
    if run.tool_names is not None and use.name not in run.tool_names:
        return (f"Refused: {use.name} is not available here. This helper is read-only and can only use {', '.join(run.tool_names)}. "
                "Say in your answer that you cannot do it; do not look for another way.", True)
    mcp_tool = run.mcp is not None and run.mcp.owns(use.name)
    problem = run.mcp.check(use.name, use.input) if mcp_tool else tools.check_input(use.name, use.input)
    if problem is not None:
        return problem, True
    decision = run.permissions.decide(use.name, use.input, call_id=use.id)
    if not decision.allowed:
        return decision.message, True
    return None


def execute(run, session, use):
    """One tool call to its result. Always returns (text, is_error): refused, invalid, denied, failed or done."""
    early = prepare(run, use)
    if early is not None:
        return early
    if run.mcp is not None and run.mcp.owns(use.name):
        return run.mcp.call(use.name, use.input)
    return tools.run(use.name, use.input, session)


class AnyEvent:
    """Looks like a threading.Event that is set when any of the given events is (None is ignored)."""

    def __init__(self, *events):
        self.events = [e for e in events if e is not None]

    def is_set(self):
        return any(e.is_set() for e in self.events)


_worker = threading.local()  # set on a pool thread: which parallel subagent it is running (tag) and what stops it (cancel)


def run_parallel(run, session, uses, finish):
    """Several subagent calls from one reply, run at the same time (at most PARALLEL_SUBAGENTS). Checking and asking permission
    happen here, one call after another; only the runs are concurrent. `finish(use, text, is_error)` is called in the order of
    `uses`, on this thread, so results are logged and sent in the order the model asked. If anything goes wrong or the run is
    stopped, the others are told to stop and waited for before the problem is raised, so nothing keeps running behind a rolled-back task."""
    batch = threading.Event()
    cancel = AnyEvent(run.cancel, batch)

    def work(tag, use):
        _worker.tag, _worker.cancel, _worker.share, _worker.call_id = tag, cancel, len(uses), use.id
        return tools.run(use.name, use.input, session)

    pool = ThreadPoolExecutor(max_workers=PARALLEL_SUBAGENTS)
    try:
        answers = []  # per call: a ready (text, is_error), or a future
        for n, use in enumerate(uses, 1):
            check_cancel(run)
            early = prepare(run, use)
            answers.append(early if early is not None else pool.submit(work, n, use))
        for use, answer in zip(uses, answers):
            text, is_error = answer if isinstance(answer, tuple) else answer.result()
            finish(use, text, is_error)
    except BaseException:
        batch.set()
        raise
    finally:
        pool.shutdown(wait=True)


def check_cancel(run):
    if run.cancel is not None and run.cancel.is_set():
        raise tools.Interrupted()


def _server_tool_summary(block):
    """One line for what a provider-run tool returned (web search results), for front ends."""
    content = getattr(block, "content", None)
    if isinstance(content, list):
        titles = [getattr(c, "title", None) or (c.get("title") if isinstance(c, dict) else None) for c in content]
        titles = [t for t in titles if t]
        return f"{len(content)} result(s)" + (": " + "; ".join(titles[:5]) if titles else "")
    return "the search returned an error" if content is not None else "no result"


def tool_groups(uses, may_run):
    """Split a reply's tool calls into groups, in order: every run of consecutive `subagent` calls (if the calls may run at all)
    is one group, and every other call is a group of one. Everything inside a group of one runs alone; a group of several runs together."""
    groups = []
    for use in uses:
        if may_run and use.name == "subagent" and groups and groups[-1][0].name == "subagent":
            groups[-1].append(use)
        else:
            groups.append([use])
    return groups


def agent_loop(run, session):
    """Send messages, run the tools the model asks for, send the results back, repeat until it stops asking.
    The model's reply blocks go into the history exactly as they came back. Every tool_use gets a tool_result."""
    tool_defs = tool_list(run.provider, run.model, run.web_search, run.mcp, run.tool_names)
    extra = request_body(run)
    # with a turn limit, Limits.before_call ends the task (with its own message); the fixed bound only applies when there is none
    for step in itertools.count() if run.limits and run.limits.max_turns else range(MAX_STEPS):
        check_cancel(run)
        if run.limits:
            run.limits.before_call(session)
        if step and run.compactor:  # between rounds, when every tool call has its result
            run.compactor.maybe(session, mid_task=True)
        beta = {"betas": [compaction.BETA]} if session.has_compaction_block() else {}  # a compaction block needs the beta header
        open_stream = run.client.beta.messages.stream if beta else run.client.messages.stream
        attempt = 0
        while True:
            try:
                with open_stream(
                    model=run.model, max_tokens=MAX_TOKENS[run.provider], system=session.system, tools=tool_defs,
                    messages=session.messages, **extra, **beta,
                ) as stream:
                    for text in stream.text_stream:
                        check_cancel(run)
                        run.on_text(text)
                    reply = stream.get_final_message()
                break
            except anthropic.APIError as e:  # a reply that broke off is thrown away and asked for again: nothing of it is in the history
                attempt += 1
                if attempt > RETRIES or not retryable(e):
                    raise
                wait = RETRY_BASE * 2 ** attempt * (0.5 + random.random() / 2)
                run.say(f"  {explain(e, run.provider, run.model)} Trying again in {wait:.0f}s ({attempt}/{RETRIES}).")
                for _ in range(int(wait * 10)):
                    check_cancel(run)
                    time.sleep(0.1)
        usage = session.record(getattr(reply, "usage", None), run.model)
        session.add_assistant(reply.content, usage, run.model, reply.stop_reason)
        if run.on_usage:
            run.on_usage(usage, session.last_cost)
        if run.compactor:
            run.compactor.after_call(session, usage)
        if run.limits:
            run.limits.after_call(session)

        for block in reply.content:  # searches the provider ran for us
            if block.type == "server_tool_use":
                run.on_tool(block.name, block.input)
                if run.on_call:
                    run.on_call(block.id, block.name, block.input)
            elif block.type == "web_search_tool_result" and run.on_result:
                run.on_result(block.tool_use_id, "web_search", _server_tool_summary(block), False)
        tool_uses = [b for b in reply.content if b.type == "tool_use"]
        if reply.stop_reason == "refusal":
            raise NotFinished(f"The model declined to continue ({getattr(reply.stop_details, 'category', None) or 'refusal'}).")
        if not tool_uses:
            if reply.stop_reason == "pause_turn":  # the server paused a long search turn: send it back to continue
                continue
            return reply

        results = []

        def announce(use):
            run.on_tool(use.name, use.input)
            if run.on_call:
                run.on_call(use.id, use.name, use.input)

        def finish(use, out, is_error, meta=None):
            result = {"type": "tool_result", "tool_use_id": use.id, "content": out, "is_error": is_error}
            session.log_tool_result(result, meta=meta)  # saved now, not after the whole batch
            if run.on_result:  # meta (search_docs' sources, explore_graph's graph) goes to front ends only; the model gets the text
                run.on_result(use.id, use.name, out, is_error, **({"meta": meta} if meta else {}))
            results.append(result)

        for group in tool_groups(tool_uses, reply.stop_reason != "max_tokens"):
            if len(group) > 1:  # several subagent calls in a row: run them side by side, answer in order
                check_cancel(run)
                if run.on_parallel:
                    run.on_parallel([use.id for use in group])
                for use in group:
                    announce(use)
                run_parallel(run, session, group, finish)
                continue
            use = group[0]
            check_cancel(run)
            announce(use)
            meta = None
            if reply.stop_reason == "max_tokens":  # the tool input may be cut off, so do not run it
                out, is_error = "Your reply hit the token limit, so this call was not run. Try a smaller step.", True
            else:
                _worker.call_id = use.id  # a subagent started by this call reports its steps against it
                try:
                    out, is_error = execute(run, session, use)
                    meta = tools.take_meta()
                finally:
                    _worker.call_id = None
            finish(use, out, is_error, meta)
        session.add_tool_results(results)
    raise NotFinished(f"Stopped after {MAX_STEPS} model calls in one task without finishing.")


_UNSET = object()


def keeps_progress(err, run, session):
    """After the provider failed for good (not our error, not a Stop) with at least one finished round, the history is consistent
    (it ends with tool results, never with a half reply), so the work done is kept and the person can say 'continue'.
    Only on Claude: consecutive user messages are valid there (they are combined). Elsewhere the task is cut back as before."""
    return (isinstance(err, anthropic.APIError) and retryable(err) and run.provider == "anthropic" and run.tool_names is None
            and len(session.messages) > session.task_start + 1)


def run_task(run, session, task, human=_UNSET):
    """Run one user task. If anything goes wrong (error, limit or Ctrl-C) the conversation and the read-record are rolled
    back to where the task started (or, if it was compacted meanwhile, to just after the summary), so history never
    holds a tool call without its result. `human` is the text the person typed (default: the task); the permission judge
    reads only that, so text we generate ourselves (a goal's feedback) passes human=None."""
    if run.compactor:
        run.compactor.maybe(session, mid_task=False)  # before the task: the conversation is complete
    session.begin_task()
    content = task
    if session.notes:  # new information goes at the END, after the user's own words
        content = [{"type": "text", "text": task}] + [{"type": "text", "text": f"[Note: {n}]"} for n in session.notes]
        session.notes.clear()
    session.add_user(content, human=task if human is _UNSET else human)
    session.cancel, session.on_change = run.cancel, run.on_change
    if run.tool_names is None:
        session.run_subagent = lambda subtask: run_subagent(run, session, subtask, tag=getattr(_worker, "tag", None), cancel=getattr(_worker, "cancel", None),
                                                            share=getattr(_worker, "share", 1), parent_id=getattr(_worker, "call_id", None))
    try:
        return agent_loop(run, session)
    except BaseException as e:
        if keeps_progress(e, run, session):  # the files already changed, and the history ends cleanly with tool results: keep it
            e.progress_kept = True
            raise
        session.abort_task()
        raise


def final_text(reply):
    return "".join(b.text for b in reply.content if b.type == "text").strip()


# ---------- subagents ----------

def run_subagent(run, parent, task, kind="subagent", steps=SUBAGENT_STEPS, tag=None, cancel=None, share=1, parent_id=None):
    """The same loop in a fresh, empty conversation with read-only tools and its own log. Returns only the final answer.
    Failures come back as a ToolError, so the caller sees them as an error result. When several run at once, `tag` labels their
    activity lines ([2] ...) and `cancel` is the batch's stop event, so one failure can stop the others."""
    pre = f"[{tag}] " if tag else ""

    def step(name, args):
        line = f"  {pre}↳ {tools.describe_call(name, args)}"
        if parent_id is None:
            run.say(line)
        else:
            notify(run, "subagent_step", {"parent_id": parent_id, "index": tag, "display": tools.describe_call(name, args)}, line)

    budget = None
    if run.limits and run.limits.max_cost:  # helpers running side by side split what is left, so together they cannot pass the cap
        budget = max((run.limits.max_cost - run.limits.spent(parent)) / (share or 1), 1e-9)
    sub = Session.start(run.model, kind=kind, parent=parent.id)
    perms = Permissions(False, mode="allow" if run.permissions.mode == "allow" else "ask", rules=run.permissions.rules,
                        say=lambda m: run.say(f"    {pre}{m.strip()}"))
    sub_run = dataclasses.replace(
        run, permissions=perms, tool_names=list(tools.SUBAGENT_TOOLS), web_search=False, mcp=None, compactor=None,
        limits=Limits(sub, max_turns=steps, max_cost=budget), on_text=lambda t: None, on_usage=None,
        on_tool=lambda name, args: step(name, args),
        cancel=cancel if cancel is not None else run.cancel,
    )
    try:
        text = final_text(run_task(sub_run, sub, task))
    except NotFinished as e:
        raise tools.ToolError(f"The subagent did not finish: {e} Give it a narrower task, or do the work yourself.")
    except anthropic.APIError as e:
        raise tools.ToolError(f"The subagent failed: {explain(e, run.provider, run.model)}")
    finally:
        usage = {k: sub.totals[k] for k in ("input", "cache_read", "cache_write", "output", "searches")}
        parent.add_aux(kind, run.model, usage, sub.totals["cost_usd"] if not sub.totals["unpriced_calls"] else None, log=sub.id)
        cost = sub.totals["cost_usd"] if not sub.totals["unpriced_calls"] else None
        line = f"  {pre}↳ {kind} finished: {sub.totals['calls']} model calls, {pricing.money(cost) if cost is not None else 'cost unknown'}"
        if parent_id is None:
            run.say(line)
        else:
            notify(run, "subagent_finish", {"parent_id": parent_id, "index": tag, "calls": sub.totals["calls"], "cost": cost}, line)
    return text or "(the subagent gave no answer)"


def review_work(run, session, goal_text, verify, claim):
    """A fresh read-only reviewer that trusts nothing. Returns (verdict, its text): verdict is True, False, or None if unclear."""
    check = f"The user's check `{verify}` was run and passed (exit code 0). A passing check does not prove the goal is met." if verify else ""
    prompt = goalmode.REVIEW_PROMPT.format(goal=goal_text, claim=claim, check=check, cwd=Path.cwd())
    try:
        text = run_subagent(run, session, prompt, kind="reviewer")
    except tools.ToolError as e:
        return None, str(e)
    return goalmode.parse_verdict(text), text


# ---------- what the person sees ----------

def dim(s):
    return f"\033[2m{s}\033[0m" if sys.stderr.isatty() else s


def show_call(name, args):
    print(dim(f"● {tools.describe_call(name, args)}"), file=sys.stderr)


def show_usage(u, usd=None):
    total = u["input"] + u["cache_read"] + u["cache_write"]
    cost = pricing.money(usd) if usd is not None else "cost unknown (no price for this model)"
    print(dim(f"  tokens  in {total:,} (new {u['input']:,} · cache read {u['cache_read']:,} · cache write {u['cache_write']:,})  out {u['output']:,}  {cost}"), file=sys.stderr)


def context_window(client, provider, model):
    """The model's context window in tokens, or None if the provider will not say."""
    if model not in _windows:
        try:
            _windows[model] = client.models.retrieve(model).max_input_tokens if provider == "anthropic" else KNOWN_WINDOWS.get(model)
        except Exception:
            _windows[model] = None
    return _windows[model]


def terminal_say(message):
    print(dim(message), file=sys.stderr)


def make_compactor(client, provider, model, args, limit, mcp=None, say=terminal_say):
    return compaction.Compactor(client, provider, model, tool_list(provider, model, not args.no_web_search, mcp), limit,
                                args.compaction, say=say)


def make_permissions(args, interactive):
    mode = args.permissions or ("allow" if args.dangerously_skip_permissions else "ask")
    return Permissions(interactive, mode=mode, rules=args.rules, judge_model=args.judge_model)


def effort_for(provider, effort):
    """The effort to send, or None (and a note) when the provider has no such setting."""
    if effort and provider != "anthropic":
        print(dim(f"  (--effort is ignored for {provider}: it has no effort setting)"), file=sys.stderr)
        return None
    return effort


def make_run(client, provider, model, args, permissions, mcp, session, **overrides):
    limit = args.context_limit or DEFAULT_LIMIT
    settings = {"on_tool": show_call, "on_usage": show_usage, "say": terminal_say, **overrides}
    run = Run(client, provider, model, permissions, web_search=not args.no_web_search, effort=effort_for(provider, args.effort),
              compactor=make_compactor(client, provider, model, args, limit, mcp, say=settings["say"]), mcp=mcp, **settings)
    permissions.bind(client, model, session)
    return run


def start_mcp_and_skills(args=None):
    """Start the MCP servers from .mcp.json and report what was found. Returns the MCP manager (None if there are none).
    A .mcp.json starts programs, so it only runs if you approved this exact file: pass --trust-mcp once (it is remembered until
    the file changes)."""
    found, warnings = skills.discover(Path.cwd())
    if (Path.cwd() / ".mcp.json").is_file() and not mcplib.is_trusted(Path.cwd()):
        if args is not None and getattr(args, "trust_mcp", False):
            mcplib.trust(Path.cwd())
        else:
            manager = mcplib.Manager()
            manager.warnings.append(".mcp.json was not used: it starts programs, and you have not approved this file. Read it, then run once with "
                                    "--trust-mcp (it is remembered until the file changes).")
            for w in manager.warnings + warnings:
                print(dim(f"  warning: {w}"), file=sys.stderr)
            return None
    manager = mcplib.Manager.load(Path.cwd())
    atexit.register(manager.close)
    for w in manager.warnings + warnings:
        print(dim(f"  warning: {w}"), file=sys.stderr)
    return manager if manager.tools else None


def open_session(args):
    """A new session, or with -c the last one in this folder rebuilt from its log. Returns (session, model)."""
    if not args.cont:
        model = args.model or default_model()
        return Session.start(model), model
    session = Session.resume()
    model = args.model or session.model or default_model()
    if model != session.model:
        session.notes.append(f"The model was switched from {session.model} to {model}. Earlier replies in this conversation came from {session.model}.")
    describe_resume(session)
    return session, model


def describe_resume(session):
    r = session.resume_report
    print(f"Continuing session {r['id']} ({len(session.messages)} messages, {session.totals['calls']} model calls so far).", file=sys.stderr)
    if r["skipped"]:
        print(f"Skipped {r['skipped']} unreadable line(s) in the log (probably cut off by a crash).", file=sys.stderr)
    for call in r["not_run"]:
        print(f"Marked as not run (the last session stopped before it finished): {call}", file=sys.stderr)


# ---------- headless ----------

def run_summary(session, model, **extra):
    """The machine-readable result of a run."""
    usd, complete, note = session.cost_summary() if session else (None, True, None)
    t = session.totals if session else {}
    return {"model": model, "session_id": session.id if session else None, "turns": t.get("calls", 0),
            "usage": {k: t.get(k, 0) for k in ("input", "cache_read", "cache_write", "output", "searches")},
            "cost_usd": None if usd is None else round(usd, 6), "cost_complete": complete, "cost_note": note, **extra}


def print_json(fields):
    print(json.dumps(fields, ensure_ascii=False))


def headless(args):
    """One task (-p) or one goal (--goal) with nobody watching. Returns the exit code: 0 done, 3 not finished."""
    hint = args.model or default_model()
    client = make_client(provider_for(hint))  # fails first if there is no key, before any log is created
    session, model = open_session(args)
    provider = provider_for(model)
    if provider_for(hint) != provider:
        client = make_client(provider)
    if args.max_cost and pricing.prices(model) is None:
        raise UserError(f"--max-cost needs a price for the model, and there is none for '{model}' ({pricing.missing_note(model)}). Use --max-turns instead.")
    mcp = start_mcp_and_skills(args)
    permissions = make_permissions(args, interactive=False)
    session.ask_human = lambda question, choices: None  # nobody can answer
    limits = Limits(session, max_turns=args.max_turns or (GOAL_STEPS if args.goal else MAX_STEPS), max_cost=args.max_cost)
    run = make_run(client, provider, model, args, permissions, mcp, session, on_text=lambda t: None, limits=limits,
                   on_usage=None if args.json else show_usage)
    result, stopped, ok, goal_result = "", None, True, None
    try:
        if args.goal:
            ok, result, goal_result = do_goal(run, session, args.goal, args.verify, say=lambda m: print(dim(m), file=sys.stderr))
            stopped = None if ok else goal_result.reason
        else:
            reply = run_task(run, session, args.print)
            result = final_text(reply)
            if reply.stop_reason == "max_tokens":
                ok, stopped = False, "the reply was cut off at the maximum length"
    except NotFinished as e:
        ok, stopped = False, str(e)
    except anthropic.APIError as e:  # the session exists, so say which one and what it cost: the run can be continued with -c
        message = explain(e, provider, model)
        code = EXIT_RETRYABLE if retryable(e) else EXIT_ERROR
        print(f"Error: {message}", file=sys.stderr)
        print(dim(f"  session {session.id} ({pricing.money(session.totals['cost_usd'])} so far): continue it with -c"), file=sys.stderr)
        if args.json:
            print_json(run_summary(session, model, ok=False, result="", stopped=None, error=message, exit_code=code))
        return code
    usd, complete, note = session.cost_summary()
    if args.json:
        print_json(run_summary(session, model, ok=ok, result=result, stopped=stopped, error=None, **({"goal": {"done": goal_result.done, "rounds": goal_result.rounds, "reason": goal_result.reason}} if goal_result else {})))
    else:
        print(safety.printable(result) if sys.stdout.isatty() else result)
        if stopped:
            print(f"Not finished: {stopped}", file=sys.stderr)
        print(dim(f"  cost: {pricing.money(usd) if complete or usd is not None else 'unknown'}{'' if complete else ' (incomplete: ' + (note or 'some calls had no price') + ')'}  ·  {session.totals['calls']} model calls  ·  log {session.log.path}"), file=sys.stderr)
    return EXIT_OK if ok else EXIT_NOT_FINISHED


def do_goal(run, session, goal_text, verify, say, event=None, max_turns=None):
    """Goal mode on a session. Returns (done, text for the user, GoalResult). With `event`, progress is reported as structured
    events (the web UI); otherwise as the same lines of text as always."""
    saved_ask, session.ask_human = session.ask_human, (lambda question, choices: None)  # unattended: nobody can answer
    if event is not None:
        event("goal_start", {"text": goal_text, "verify": verify, "max_turns": max_turns}, f"goal: {goal_text}\n  check: {verify}" if verify else "")
    elif verify:
        say(f"goal: {goal_text}\n  check: {verify}")
    try:
        result = goalmode.run(
            goal_text, verify,
            work=lambda prompt, first: final_text(run_task(run, session, prompt, human=goal_text if first else None)),
            review=lambda claim: review_work(run, session, goal_text, verify, claim),
            say=say, event=event,
        )
    finally:
        session.ask_human = saved_ask
    if result.done:
        text = f"GOAL DONE after {result.rounds} round(s).\n\nReviewer: {result.reason}"
    else:
        text = f"GOAL NOT DONE after {result.rounds} round(s): {result.reason}"
    return result.done, text, result


# ---------- main ----------

def positive_int(text):
    if not text.isdigit() or int(text) < 1:
        raise argparse.ArgumentTypeError(f"'{text}' is not a whole number above 0")
    return int(text)


def positive_float(text):
    try:
        value = float(text)
    except ValueError:
        value = 0
    if value <= 0:
        raise argparse.ArgumentTypeError(f"'{text}' is not an amount of dollars above 0")
    return value


def rule(text):
    try:
        return safety.parse_rule(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e))


def build_parser():
    ap = argparse.ArgumentParser(
        description="A small coding agent. Chat by default; -p runs one task and exits; --goal works unattended until done.",
        epilog="Exit codes (headless): 0 done, 1 error, 3 did not finish (turn or spending limit, cut-off or refused reply, goal not met), 130 interrupted.")
    ap.add_argument("-p", "--print", metavar="TASK", help="headless: run TASK, print the answer, exit")
    ap.add_argument("--goal", metavar="TEXT", help="headless goal mode: keep working until done with evidence, then run --verify, then a reviewer")
    ap.add_argument("--verify", metavar="CMD", help='with --goal: your check, run when the work claims to be done, e.g. "pytest -q"')
    ap.add_argument("--model", help="model id; names starting with 'deepseek' use DeepSeek (default is claude-sonnet-5-5, or deepseek-flash if only a DeepSeek key is set)")
    ap.add_argument("--effort", choices=EFFORTS, help="reasoning effort for the run (Claude models)")
    ap.add_argument("--json", action="store_true", help="headless: print one machine-readable JSON line (result, usage, cost) and nothing else on stdout")
    ap.add_argument("--max-turns", type=positive_int, metavar="N", help="stop after N model calls (default 50; 100 for a goal)")
    ap.add_argument("--max-cost", type=positive_float, metavar="USD", help="stop when the run has cost this many dollars")
    ap.add_argument("--permissions", choices=MODES, help="ask (default), judge (a separate model call decides what it can), or allow (everything)")
    ap.add_argument("--judge-model", metavar="MODEL", help="model for the permission judge (default: the session's model)")
    ap.add_argument("--allow", action="append", type=rule, default=[], dest="rules", metavar="RULE",
                    help="pre-approve: 'pytest' (commands starting with it), 'write:PATH', 'read:PATH', 'mcp__server__tool'. Repeatable")
    ap.add_argument("--dangerously-skip-permissions", action="store_true", help="same as --permissions allow")
    ap.add_argument("-c", "--continue", dest="cont", action="store_true", help="continue the last session in this folder, rebuilt from its log")
    ap.add_argument("--context-limit", type=positive_int, metavar="TOKENS", help="compact the conversation when a request would reach this many tokens (default 150000)")
    ap.add_argument("--compaction", choices=["auto", "server", "client"], default="auto",
                    help="auto: Anthropic's server-side compaction on Claude, a model-written summary elsewhere; or force one")
    ap.add_argument("--trust-mcp", action="store_true", help="approve this folder's .mcp.json (it starts programs); remembered until the file changes")
    ap.add_argument("--pass-env", action="append", default=[], metavar="NAME",
                    help="pass this environment variable to commands and MCP servers even though its name looks like a secret. Repeatable")
    ap.add_argument("--no-web-search", action="store_true", help="do not offer the provider's web search tool")
    ap.add_argument("--no-index", action="store_true",
                    help="do not index the folder in the background (search_docs and explore_graph still index it when used)")
    ap.add_argument("--ui", action="store_true", help="start the local web UI and open it in your browser (needs: pip install 'mini-harness[ui]')")
    ap.add_argument("--port", type=int, default=8765, metavar="N", help="with --ui: the port to listen on (default 8765; 127.0.0.1 only)")
    ap.add_argument("--no-open", action="store_true", help="with --ui: do not open a browser; just print the address")
    ap.add_argument("--demo", action="store_true", help="with --ui: use a scripted fake model, no API key or cost (for trying the interface)")
    return ap


def error_json(args, message, code):
    print_json({"ok": False, "result": "", "stopped": None, "error": message, "exit_code": code, "model": args.model, "cost_usd": None,
                "cost_complete": True, "cost_note": None, "session_id": None, "turns": 0, "usage": {}})


def main():
    args = build_parser().parse_args()
    safety.PASS_ENV.update(args.pass_env)
    headless_mode = args.print is not None or args.goal is not None
    try:
        if args.print is not None and args.goal is not None:
            raise UserError("Use -p for one task or --goal for goal mode, not both.")
        if args.verify and not args.goal:
            raise UserError("--verify needs --goal. (In chat: /goal --verify \"pytest -q\" what to achieve.)")
        if args.json and not headless_mode:
            raise UserError("--json is for headless runs: use it with -p or --goal.")
        if args.ui and headless_mode:
            raise UserError("--ui is the interactive web interface; do not combine it with -p or --goal.")
        if args.ui:
            import webserver  # imported here so the terminal modes never need the web libraries
            code = webserver.serve(args) or EXIT_OK
        elif headless_mode:
            code = headless(args)
        else:
            import terminal
            code = terminal.Chat(args).loop() or EXIT_OK
    except KeyboardInterrupt:
        code = EXIT_INTERRUPTED
    except UserError as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.json:
            error_json(args, str(e), EXIT_ERROR)
        code = EXIT_ERROR
    except NotFinished as e:
        print(f"Not finished: {e}", file=sys.stderr)
        code = EXIT_NOT_FINISHED
    except anthropic.APIError as e:
        model = args.model or default_model()
        message = explain(e, provider_for(model), model)
        print(f"Error: {message}", file=sys.stderr)
        code = EXIT_RETRYABLE if retryable(e) else EXIT_ERROR
        if args.json:
            error_json(args, message, code)
    sys.exit(code)


if __name__ == "__main__":
    main()
