"""The permission gate: every tool call goes through Permissions.decide before it runs. The policy (what is safe) is in
safety.py, the optional judge in judge.py; both are documented in DESIGN.md ('Safety')."""
import os
import shlex
import sys

try:
    import termios  # Unix only; without it typed-ahead text just is not flushed
except ImportError:  # pragma: no cover
    termios = None
from dataclasses import dataclass

import judge
import pricing
import safety

MODES = ("ask", "judge", "allow")
MODE_HELP = {
    "ask": "ask you about anything risky",
    "judge": "a separate model call decides what it can; secrets, hidden tricks, files that run later and protected files always come to you, and so does anything it is unsure about",
    "allow": "allow everything without asking (including deleting files, secrets and the network)",
}


def discard_pending_input():
    """Throw away typed-ahead or pasted text, so it can never answer a question by accident."""
    if termios is not None and sys.stdin.isatty():
        termios.tcflush(sys.stdin.fileno(), termios.TCIFLUSH)


@dataclass
class Decision:
    allowed: bool
    message: str = ""  # what the model is told when it is denied
    by: str = ""  # who decided a risky call: "rule", "judge" or "user" ("" when nothing was asked, or nobody could answer)


def terminal_ask(a, note):
    """The yes/no question on a terminal: the exact action, hidden characters shown, why you are asked. Only y or yes allows."""
    print()
    print(f"  ┌─ Permission needed: {a.title}")
    for line in a.display.split("\n"):
        print(f"  │ {line}")
    for f in a.findings:
        print(f"  │ ⚠ hidden: {f.text}")
    for _, text in a.reasons:
        print(f"  │ why you are asked: {text}")
    if note:
        print(f"  │ note: {note}")
    discard_pending_input()
    try:
        answer = input("  └─ Allow this? [y/N] ").strip().lower()
    except EOFError:
        answer = ""
    return answer in ("y", "yes")


class Permissions:
    def __init__(self, interactive, mode="ask", rules=(), project=None, say=None, judge_model=None, ask=None):
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.interactive, self.mode, self.judge_model = interactive, mode, judge_model
        self.policy = safety.Policy(project or os.getcwd(), rules)
        self.say = say or (lambda msg: print(msg, file=sys.stderr))
        self.client = self.model = self.session = None
        self.judge_calls = 0
        self.approvals = {}  # call id -> {"by": "rule"|"judge"|"user", "allowed": bool}, for front ends that show who decided
        self.ask = ask or terminal_ask  # how a question reaches the human: a terminal by default, a browser dialog in the web UI

    @property
    def rules(self):
        return self.policy.rules

    def bind(self, client, model, session):
        """What the judge needs: the client, the model, and the session whose user messages it may read."""
        self.client, self.model, self.session = client, model, session

    # --- the decision ---

    def decide(self, name, args, call_id=None):
        a = self.policy.assess(name, args)
        a.call_id = call_id  # so the question can say which tool call it is about
        if not a.risky or self.mode == "allow":
            return Decision(True)
        decision = self._decide(a)
        if call_id is not None and decision.by:
            self.approvals[call_id] = {"by": decision.by, "allowed": decision.allowed}
        return decision

    def _decide(self, a):
        rule = self.policy.matching_rule(a)
        if rule:
            self.say(f"  allowed by --allow {shlex.quote(rule.text)}: {a.title}")
            return Decision(True, by="rule")
        note = None
        if self.mode == "judge":
            if all(code in judge.ELIGIBLE for code, _ in a.reasons):
                verdict = self._judge(a)
                self.say(f"  judge: {verdict.decision} - {verdict.reason}")
                if verdict.decision == "allow":
                    return Decision(True, by="judge")
                if verdict.decision == "deny":
                    return Decision(False, f"Not run: the permission judge denied this ({verdict.reason}). Do not look for another way to do the same thing: tell the user what you wanted to do and why.", by="judge")
                if verdict.decision == "error":  # an error means deny
                    return Decision(False, f"Not run: the permission judge could not decide ({verdict.reason}), and an error counts as a refusal. Tell the user, or try a different approach.", by="judge")
                note = f"the judge was unsure: {verdict.reason}"
            else:
                why = next(text for code, text in a.reasons if code not in judge.ELIGIBLE)
                note = f"this kind of action always comes to you, whatever the judge would say ({why})"
        return self._ask_human(a, note) if self.interactive else self._deny_headless(a, note)

    def _judge(self, a):
        self.judge_calls += 1
        v = judge.ask(self.client, self.judge_model or self.model, list(self.session.user_messages), a)
        if v.usage and self.session:
            self.session.add_aux("judge", self.judge_model or self.model, v.usage, pricing.cost(self.judge_model or self.model, v.usage), action=a.summary[:200])
        return v

    # --- asking the human ---

    def _ask_human(self, a, note):
        if self.ask(a, note):
            return Decision(True, by="user")
        return Decision(False, "The user declined this. Do not repeat it or look for another way to do the same thing: ask the user what they would prefer.", by="user")

    def _deny_headless(self, a, note):
        """Nobody can answer: refuse, say why, and say exactly how to pre-approve."""
        suggestion = self.policy.suggest(a)
        why = "; ".join(text for _, text in a.reasons)
        if suggestion:
            how = f"To pre-approve it, rerun with {suggestion}"
            if a.kind == "bash":
                how += f"   (or a shorter prefix, such as --allow {shlex.quote(shlex.split(a.targets[0])[0]) if a.targets[0].split() else 'cmd'})"
        elif any(code in ("secret", "hidden") for code, _ in a.reasons):
            how = "An --allow rule cannot approve this (it involves secrets or hidden characters)."
        else:
            how = ("An --allow rule cannot match this command because it chains commands, redirects, pipes or substitutes. "
                   "Ask for one simple command at a time.")
        self.say(f"  ✗ denied (nobody to ask): {a.summary[:200]}\n    why: {why}\n    {how}")
        extra = f" ({note})" if note else ""
        return Decision(False, f"Not run: {a.title} needs the user's approval ({why}) and a headless run has nobody to ask{extra}. Do not look for another way to do the same thing: tell the user what you wanted to do. {how}.")
