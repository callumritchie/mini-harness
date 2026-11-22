"""The terminal chat: a UI for the Controller, and the loop that reads what you type."""
import os
import readline  # noqa: F401  (importing it gives input() line editing and history)
import select
import shlex
import sys

import agent
import context
import pricing
import safety
from controller import Controller, UI
from permissions import MODE_HELP, MODES, discard_pending_input, terminal_ask
from session import UserError


def read_message(prompt):
    """input(), but a multi-line paste comes back as one message instead of one message per line:
    after the first line, take whatever else is already waiting on the terminal."""
    first = input(prompt)
    if not sys.stdin.isatty():
        return first
    lines = [first]
    while select.select([sys.stdin], [], [], 0.05)[0]:
        chunk = os.read(sys.stdin.fileno(), 65536).decode("utf-8", "replace")
        if not chunk:
            break
        lines.extend(chunk.rstrip("\n").split("\n"))
    return "\n".join(lines)


def ask_in_chat(question, choices):
    """Put a question to the person: a numbered list if there are choices. Returns their answer ('' if they gave none)."""
    discard_pending_input()
    print(f"\n  ? {safety.printable(question)}")
    for i, c in enumerate(choices, 1):
        print(f"    {i}) {safety.printable(c)}")
    prompt = "  Enter a number, or type your own answer: " if choices else "  Your answer: "
    try:
        answer = input(prompt).strip()
    except EOFError:
        return ""
    if choices and answer.isdigit() and 1 <= int(answer) <= len(choices):
        return choices[int(answer) - 1]
    return answer


class TerminalUI(UI):
    def __init__(self):
        self.streamed = False

    def text(self, delta):
        self.streamed = True
        print(safety.printable(delta), end="", flush=True)

    def tool_call(self, call_id, name, args, display):
        if self.streamed:
            print()
            self.streamed = False
        agent.show_call(name, args)

    def usage(self, usage, cost, summary):
        agent.show_usage(usage, cost)

    def notice(self, text):
        agent.terminal_say(text)

    def ask_permission(self, assessment, note):
        return terminal_ask(assessment, note)

    def ask_user(self, question, choices):
        return ask_in_chat(question, choices)


class Chat:
    """The interactive mode: the loop, and one method per slash command (each a few lines over the Controller)."""

    def __init__(self, args):
        self.args = args
        self.ui = TerminalUI()
        self.ctl = Controller(args, self.ui)
        self.ctl.start()
        if self.ctl.client_error:
            print(self.ctl.client_error, file=sys.stderr)  # still let them start and use /model

    def banner(self):
        c, s = self.ctl, self.ctl.session
        print(f"Mini Harness  model: {c.model}  permissions: {c.permissions.mode}  (/help for commands, Ctrl-C stops a turn, Ctrl-D exits)")
        if context.AGENTS_FILE in s.system_parts:
            print(f"Loaded {context.AGENTS_FILE} ({s.system_parts[context.AGENTS_FILE]:,} characters) into the instructions.")
        if "Skills (names only)" in s.system_parts:
            print(f"Skills available: {len(c.info()['skills'])} (names and descriptions only; the model reads one when a task matches).")
        if c.mcp:
            print(f"MCP tools available: {len(c.mcp.tools)} (every call goes through the permission gate).")

    def loop(self):
        self.banner()
        while True:
            try:
                line = read_message("\n> ").strip()
            except EOFError:
                print()
                return
            except KeyboardInterrupt:
                print("\n(Ctrl-C stops a running turn. Use /exit or Ctrl-D to quit.)")
                continue
            if not line:
                continue
            if line.startswith("/") and "\n" not in line:
                cmd, _, arg = line.partition(" ")
                if cmd in ("/exit", "/quit"):
                    return
                handler = getattr(self, "cmd_" + cmd[1:].replace("-", "_"), None)
                if handler is None:
                    print(f"Unknown command {cmd}. Try /help.")
                else:
                    self.guarded(handler, arg.strip())
                continue
            if self.ctl.client is None:
                print("No API key yet; set one (see above) and restart, or use /model with a model you have a key for.", file=sys.stderr)
                continue
            self.guarded(self.task, line)

    def guarded(self, fn, arg):
        """Run a command. Ctrl-C and errors end it, not the program."""
        try:
            fn(arg)
        except KeyboardInterrupt:
            print("\n[interrupted - that turn was dropped from the conversation]")
        except UserError as e:
            print(f"\nError: {e}", file=sys.stderr)

    def report(self, result):
        """Say how a task ended."""
        if result.interrupted:
            print("\n[interrupted - that turn was dropped from the conversation]")
        elif result.error:
            print(f"\nError: {result.error}", file=sys.stderr)
        elif result.stopped and not result.text.startswith("GOAL"):
            print(f"\nNot finished: {result.stopped}", file=sys.stderr)
        elif result.cut_off:
            print("\n[reply cut off at the max token limit]", file=sys.stderr)

    def task(self, line):
        self.ui.streamed = False
        result = self.ctl.send(line)
        if not (result.interrupted or result.error or result.stopped):
            print()
        self.report(result)

    # --- commands ---

    def cmd_help(self, arg):
        print("\n".join([
            "/new                 start a new session (a new log; AGENTS.md and skills are read fresh)",
            "/sessions            list this folder's sessions, newest first, titled by their first prompt",
            "/resume [n|id]       continue a session (no argument: the most recent other one)",
            "/model [n|name]     list the models, or switch (a number from the list, or any model id)",
            "/permissions [mode]  ask (default), judge, or allow: who decides about risky actions",
            "/effort [level]      reasoning effort: low, medium, high, xhigh, max (or 'default')",
            "/context             what fills the context window, and what the session has cost",
            "/compact [focus]     replace the conversation with a summary now",
            "/limit [tokens]      show or set where automatic compaction starts",
            "/index [--rebuild] [--embed]   update the document index and graph now; --embed turns on search by meaning",
            "/graph [status|build]  the knowledge graph; build has a model read the prose (shows the cost first)",
            "/goal [--verify CMD] [--max-turns N] TEXT   work unattended until done, with evidence, your check and a review",
            "/help                this list",
            "/exit                quit (Ctrl-D too)"]))

    def cmd_new(self, arg):
        self.ctl.new_session()
        print("Started a new session.")
        self.banner()

    cmd_clear = cmd_new

    def cmd_sessions(self, arg):
        listing = self.ctl.list_sessions()
        if not listing:
            print("No sessions in this folder yet.")
            return
        print("Sessions in this folder, newest first:")
        for i, s in enumerate(listing, 1):
            here = "  <- this one" if s["id"] == self.ctl.session.id else ""
            print(f"  {i:>2}. {s['when']:%Y-%m-%d %H:%M}  {s['prompts']} prompt(s)  {pricing.money(s['cost']) if s['cost'] else '':>8}  {safety.printable(s['title'])}{here}")
        print("Use /resume N to continue one.")

    def cmd_resume(self, arg):
        try:
            self.ctl.resume(arg or None)
        except UserError as e:
            print(e, file=sys.stderr)
            return
        agent.describe_resume(self.ctl.session)
        print(f"Model: {self.ctl.model}")

    def cmd_model(self, arg):
        if not arg:
            print(f"Current model: {self.ctl.model}")
            for i, (name, note) in enumerate(agent.MODEL_CHOICES, 1):
                print(f"  {i}) {'*' if name == self.ctl.model else ' '} {name}: {note}")
            print("Switch with /model N or /model <any model id>.")
            return
        if arg.isdigit() and 1 <= int(arg) <= len(agent.MODEL_CHOICES):
            arg = agent.MODEL_CHOICES[int(arg) - 1][0]
        note = self.ctl.set_model(arg)
        print(f"Model set to {self.ctl.model}")
        if note:
            print(note)

    def cmd_permissions(self, arg):
        mode = self.ctl.permissions.mode
        if not arg:
            print(f"Permissions: {mode}")
            for m in MODES:
                print(f"  {'*' if m == mode else ' '} {m}: {MODE_HELP[m]}")
            print("Switch with /permissions ask | judge | allow.")
            return
        if arg not in MODES:
            print(f"Unknown mode '{arg}'. Choose one of: {', '.join(MODES)}.")
            return
        print(self.ctl.set_permissions(arg))
        if arg == "allow":
            print("Warning: nothing will be asked any more. Switch back with /permissions ask.")

    def cmd_effort(self, arg):
        if not arg:
            print(f"Effort: {self.args.effort or 'default (the model decides)'}. Choices: {', '.join(agent.EFFORTS)}, default.")
            return
        if arg not in agent.EFFORTS and arg != "default":
            print(f"Unknown effort '{arg}'. Choices: {', '.join(agent.EFFORTS)}, default.")
            return
        self.ctl.set_effort(arg)
        print(f"Effort set to {arg}. (Changing it once means the next call is a cache miss.)")
        if self.ctl.provider != "anthropic" and arg != "default":
            print(f"Note: {self.ctl.provider} has no effort setting, so it will be ignored.")

    def cmd_context(self, arg):
        print(self.ctl.context_text())

    def cmd_limit(self, arg):
        if not arg:
            print(f"Compaction limit: {self.ctl.limit:,} tokens{'' if self.args.context_limit else ' (default)'}")
        elif arg.isdigit() and int(arg) > 0:
            print(f"Compaction limit set to {self.ctl.set_limit(int(arg)):,} tokens.")
        else:
            print("Usage: /limit <tokens>, a whole number above 0.")

    def cmd_compact(self, arg):
        self.ctl.compact(arg)

    def cmd_index(self, arg):
        words = arg.split()
        if any(w not in ("--rebuild", "--embed") for w in words):
            print("Usage: /index [--rebuild] [--embed]. --rebuild starts over; --embed turns on search by meaning (downloads the local model once).")
            return
        print(self.ctl.reindex(rebuild="--rebuild" in words, embed_now="--embed" in words))

    def cmd_graph(self, arg):
        words = shlex.split(arg)
        if not words or words == ["status"]:
            s = self.ctl.index_status()
            if not s.get("available"):
                print("The index is not available here (this Python's SQLite has no FTS5).")
                return
            print(f"Graph: {s.get('entities', 0):,} things and {s.get('edges', 0):,} links from {s.get('files', 0):,} files. "
                  "/graph build lets a model read the prose and add concepts (it shows the cost first).")
            return
        if words[0] != "build":
            print("Usage: /graph [status] | /graph build [--all] [--model MODEL] [--yes]")
            return
        model = words[words.index("--model") + 1] if "--model" in words and words.index("--model") + 1 < len(words) else None
        est = self.ctl.graph_estimate(prose_only="--all" not in words, model=model)
        if not est["passages"]:
            print(f"Nothing new to read ({est['cached']} passage(s) already read).")
            if est["cached"]:
                self.report(self.ctl.graph_build(prose_only="--all" not in words, model=model))
            return
        print(f"{est['model']} would read {est['passages']:,} passage(s): about {est['input_tokens']:,} tokens in and {est['output_tokens']:,} out, "
              f"roughly {pricing.money(est['cost'])}. Passages are sent to the provider.")
        if "--yes" not in words and input("Go ahead? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Not built.")
            return
        result = self.ctl.graph_build(prose_only="--all" not in words, model=model)
        if result.interrupted:
            print("\n[stopped: what was read so far is kept]")
        else:
            self.report(result)

    def cmd_goal(self, arg):
        try:
            words = shlex.split(arg)
        except ValueError as e:
            print(f"Could not read that: {e}")
            return
        verify, max_turns, text = None, None, []
        while words:
            w = words.pop(0)
            if w == "--verify" and words:
                verify = words.pop(0)
            elif w == "--max-turns" and words and words[0].isdigit():
                max_turns = int(words.pop(0))
            else:
                text.append(w)
        if not text:
            print('Usage: /goal [--verify "pytest -q"] [--max-turns N] what to achieve')
            return
        print("Goal mode: unattended. It will not ask you questions; use /permissions judge or --allow rules so it is not stopped by approvals.")
        result = self.ctl.goal(" ".join(text), verify, max_turns)
        if result.interrupted or result.error:
            self.report(result)
        else:
            print(result.text)
