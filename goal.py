"""Goal mode: keep working, unattended, until the model claims it is done with evidence; then the user's check runs; then a fresh,
read-only reviewer who trusts nothing gives a verdict. Any failure goes back as the reason to continue. A turn or spending limit
ends it as 'not done'. See DESIGN.md, 'Goal mode'.

The logic is here; the pieces that need the model are passed in (work, review), so it can be tested without one.
"""
import os
import re
import subprocess
from dataclasses import dataclass

import safety
from session import NotFinished

CHECK_SECONDS = 600
OUTPUT_TAIL = 3000
MIN_EVIDENCE = 20  # characters of evidence after DONE:

START = """\
GOAL: {goal}
{check}
Work on this until it is fully done. Nobody is available to answer questions, so decide sensibly and note your assumptions.
When, and only when, you believe the goal is met, end your final message with a line that starts with `DONE:` followed by \
your evidence: what you changed (file paths) and how you checked it (the commands you ran and what they showed; if you could \
not run something, say so). If you are truly stuck, end with a line starting `BLOCKED:` and say why. Do not claim DONE without \
evidence."""
NUDGE = ("You stopped without saying whether the goal is met. Keep working until it is done, then end with a line starting "
         "`DONE:` and your evidence. If you are stuck, end with `BLOCKED:` and why.")
NEED_EVIDENCE = "Your DONE had no evidence. Say what you changed (file paths) and how you checked it, then end again with `DONE:` and the evidence."
CHECK_FAILED = ("Your claim of DONE was rejected: the user's check `{verify}` failed (exit code {code}). Its output (last part):\n"
                "{output}\n\nFind the cause and fix it, then end with `DONE:` and new evidence.")
REVIEW_FAILED = ("Your claim of DONE was rejected: a reviewer who checked the work independently says it is not done:\n{review}\n\n"
                 "Address this, then end with `DONE:` and new evidence.")
REVIEW_PROMPT = """\
Review whether this goal has been met.

GOAL: {goal}

The worker says it is finished and gives this account. It is unverified, so do not trust it:
<<<
{claim}
>>>
{check}
Check for yourself by reading the actual files under {cwd}. Report what you checked and what you found, then end with the verdict line."""

CLAIM = re.compile(r"^[ \t>*_`#-]*(DONE|BLOCKED)\s*:\s*", re.I | re.M)


@dataclass
class GoalResult:
    done: bool
    reason: str  # why it stopped, or the reviewer's summary when it succeeded
    rounds: int = 0
    claim: str = ""


def parse_claim(text):
    """(kind, body) where kind is 'done', 'blocked' or None. The last DONE:/BLOCKED: line wins; body is everything from there on."""
    last = None
    for m in CLAIM.finditer(text or ""):
        last = m
    if not last:
        return None, ""
    return last.group(1).lower(), text[last.end():].strip()


def parse_verdict(text):
    """True for 'VERDICT: DONE', False for 'VERDICT: NOT DONE', None if there is no clear verdict on the last line."""
    lines = [l.strip().strip("*`_ ") for l in (text or "").strip().splitlines() if l.strip()]
    if not lines:
        return None
    m = re.fullmatch(r"VERDICT\s*:\s*(NOT\s+DONE|DONE)", lines[-1], re.I)
    return None if not m else not m.group(1).upper().startswith("NOT")


def run_check(command, cwd=None):
    """Run the user's check. Returns (passed, exit code, output tail). Our own API keys are removed from its environment."""
    env = {k: v for k, v in os.environ.items() if k not in safety.OWN_SECRET_VARS}
    try:
        r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=CHECK_SECONDS, stdin=subprocess.DEVNULL, env=env, cwd=cwd)
    except subprocess.TimeoutExpired:
        return False, -1, f"(the check ran longer than {CHECK_SECONDS}s and was killed)"
    out = (r.stdout + r.stderr).strip()
    return r.returncode == 0, r.returncode, out[-OUTPUT_TAIL:]


def run(goal, verify, work, review, say, check=run_check, cwd=None, event=None):
    """work(prompt, first) -> the worker's final text (raises NotFinished at a limit); review(claim) -> (done, text);
    check(command) -> (passed, code, output). Returns a GoalResult; never raises NotFinished. Progress goes to `event(kind, data,
    text)` when given (the web UI shows it as structured steps), otherwise to `say(text)`; the text is the same either way."""
    def tell(kind, data, text):
        if event is not None:
            event(kind, data, text)
        else:
            say(text)

    prompt = START.format(goal=goal, check=f"When you finish, the user's check `{verify}` will be run, and it must pass." if verify else "")
    rounds = 0
    try:
        while True:
            tell("goal_round", {"n": rounds + 1}, f"goal round {rounds + 1}: working...")
            text = work(prompt, rounds == 0)
            rounds += 1  # counted once the model has actually worked, not when a limit stopped it first
            kind, body = parse_claim(text)
            if kind is None:
                tell("goal_status", {"status": "no_claim"}, "  no claim of done; asking it to continue")
                prompt = NUDGE
                continue
            if kind == "blocked":
                return GoalResult(False, f"blocked: {body or 'no reason given'}", rounds, text)
            if len(body) < MIN_EVIDENCE:
                tell("goal_status", {"status": "no_evidence"}, "  claimed done without evidence; sending it back")
                prompt = NEED_EVIDENCE
                continue
            tell("goal_status", {"status": "claimed"}, "  claims it is done")
            if verify:
                passed, code, output = check(verify)
                tell("check_result", {"cmd": verify, "passed": passed, "exit_code": code}, f"  check `{verify}`: {'passed' if passed else f'FAILED (exit {code})'}")
                if not passed:
                    prompt = CHECK_FAILED.format(verify=verify, code=code, output=output or "(no output)")
                    continue
            tell("goal_status", {"status": "reviewing"}, "  reviewer (fresh, read-only, trusts nothing) is checking...")
            verdict, review_text = review(body)
            tell("reviewer_verdict", {"verdict": verdict}, f"  reviewer verdict: {'DONE' if verdict else 'NOT DONE' if verdict is False else 'unclear'}")
            if verdict:
                return GoalResult(True, review_text.strip(), rounds, text)
            prompt = REVIEW_FAILED.format(review=review_text.strip() or "(the reviewer gave no clear verdict)")
    except NotFinished as e:
        return GoalResult(False, str(e), rounds, "")
