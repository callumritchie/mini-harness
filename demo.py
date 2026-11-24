"""A scripted fake model for `--ui --demo`: lets you try the interface (streaming, tool cards, approvals, questions, diffs, Stop)
with no API key and no cost. It reads keywords in your last message and answers with canned replies.

  hello / hi        a short markdown reply, streamed
  list / files      a glob call, then a summary
  create / write    writes demo.py (shows a diff), then says so
  delete / remove   `rm demo.py` (shows the approval dialog)
  ask / choose      asks you Python or Go with ask_user
  secret / .env     tries to read .env (always asks)
  long              a slow, long reply (try the Stop button)

Keywords for reviewing every state (used by the screenshot test; they are not in the starter prompts):

  hidden            a command with an invisible character in it (the approval dialog with a warning)
  helpers           three subagent calls in one reply
  fail              edit_file on a file that was not read first (an error with advice)
  cut               a reply that stops at the maximum length
  edit              reads README.md, then edits a line of it (a diff with a removal, additions and context)
  worst case …      worst-case data for stress-testing the layout: deep paths, 1,200 files, long lines, CJK, RTL, emoji (dev toggle)
  one               exactly one of everything, so every count reads 1 (dev toggle)
  anything else     echoes your message
"""
import itertools
import time
from types import SimpleNamespace as NS

import sessionlog
import tools

_ids = itertools.count(1)

HELLO = """Hello! I'm the **demo model**. I answer from a script, so this costs nothing.

Try one of these:

- `create a file` — I write `demo.py` (watch the **Changes** tab)
- `delete it` — I run `rm demo.py` and you get the approval dialog
- `ask me to choose` — I ask you a question with choices
- `list the files` — I call a tool
- `long` — a slow reply, so you can press **Stop**

```python
print("hello from the demo")
```
"""

CUT = ("This reply keeps going until it reaches the maximum length, and then it stops in the middle of a sentence, which is what the "
       "interface should show when that happens. Here is more text so that there is something to cut off, and a little more, and a lit")

LONG = ("This is a deliberately slow reply so you can try the Stop button. " * 40).strip()


def _text(t):
    return NS(type="text", text=t)


def _think(t):
    return NS(type="thinking", thinking=t, signature="demo")


PLAN = """**Plan: add a greeting module**

1. Create `demo.py` with a `greet(name)` function.
2. Print a greeting when it runs as a script.
3. Check it by reading the file back.

Nothing else in the folder changes."""


def _tool(name, **args):
    return NS(type="tool_use", id=f"toolu_demo{next(_ids)}", name=name, input=args)


def _last_user_text(messages):
    """The latest thing the person typed (not tool results), and whether the last message is tool results."""
    last = messages[-1]
    if isinstance(last["content"], list) and last["content"] and isinstance(last["content"][0], dict) and last["content"][0].get("type") == "tool_result":
        return None, last["content"]
    content = last["content"]
    if isinstance(content, list):
        content = sessionlog._text_of([b if isinstance(b, dict) else vars(b) for b in content])
    return content, None


def _attached(messages):
    """Names of the files attached to the last message."""
    content = messages[-1]["content"]
    if not isinstance(content, list):
        return []
    return [b["text"][len(sessionlog.ATTACH_LABEL):-1] for b in content if isinstance(b, dict) and b.get("type") == "text"
            and sessionlog.is_attach_label(b["text"])]


def _plan_on(messages):
    """Whether the latest note about plan mode (in the person's messages) says it is on."""
    for m in reversed(messages):
        if m["role"] == "user" and isinstance(m["content"], list):
            for b in reversed(m["content"]):
                text = b.get("text", "") if isinstance(b, dict) else ""
                if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("content") == tools.PLAN_APPROVED:
                    return False
                if text.startswith("[Note: Plan mode is on"):
                    return True
                if text.startswith("[Note: Plan mode is off"):
                    return False
    return False


def _last_typed(messages):
    """The latest thing the person typed, looking past tool results."""
    for m in reversed(messages):
        if m["role"] != "user":
            continue
        text, results = _last_user_text([m])
        if results is None:
            return text or ""
    return ""


def _rounds(messages):
    """How many rounds of tool results have come back since the person last typed."""
    n = 0
    for m in reversed(messages):
        if m["role"] != "user":
            continue
        if _last_user_text([m])[1] is None:
            return n
        n += 1
    return n


# Worst-case data for the break-ui review ("worst" keyword; the dev-only data toggle sends WORST_PROMPT). Every value is something a
# real project produces: deep monorepo paths, a person's name with diacritics in a folder, an email-shaped file name, 1,200 files in
# one folder, a minified one-line JSON file, CJK and emoji file names, a secret-looking file, a one-letter file name.
WORST_PROMPT = ("worst case: migrate every customer record under src/integrations/northwind-industries-holdings to the 2027 schema "
                "and tell Aleksandra Wiśniewska-Kowalczyk when it's done")
WORST_DIR = "src/integrations/northwind-industries-holdings/customer-records/2026-Q3/eu-west/Aleksandra-Wiśniewska-Kowalczyk"
WORST_CJK = "docs/Ünïcödé プロジェクト"
WORST_CMD = (f'mkdir -p "{WORST_DIR}" "{WORST_CJK}" && for i in $(seq -w 1 1200); do touch "{WORST_DIR}/customer-record-$i.json"; done'
             f' && touch "{WORST_CJK}/会議メモ 2026-11-24 (final) v12 🚀.md" .env.production.local a')
WORST_FILE = f"{WORST_DIR}/bartholomew.fitzgerald@northwind-industries-holdings.example.com.config.json"
WORST_BODY = ('{"id":"cus_01JD4Z8XQ7M3N5P9R2T6V8W0YB","name":"Bartholomew Fitzgerald","email":"bartholomew.fitzgerald@northwind-industries-holdings.example.com",'
              '"company":"Northwind Industries Holdings (EMEA) GmbH & Co. KG","seats":1284,"mrr_cents":129999900,"tags":["enterprise","eu-west","sso",'
              '"priority-support","annual-contract","legacy-2019-pricing"],"notes":"Migrated from the 2019 CRM export; see https://wiki.northwind-industries-holdings.example.com/display/CRM/Customer+Record+Migration+2027+Schema+Rollout+Plan"}\n'
              "// اسم العميل: بارثولوميو فيتزجيرالد — ملاحظات الترحيل\n"
              "// ชื่อลูกค้า: บาร์โธโลมิว ฟิตซ์เจอรัลด์\n"
              "// 🚀🔥✅ owner: Jo\n")
WORST_HELPERS = [
    "Check each customer record JSON under src/integrations/northwind-industries-holdings/customer-records/2026-Q3/eu-west for fields that "
    "don't match the 2027 schema, and report them grouped by field name",
    "Summarise README.md",
    "Count the records",
    "Find every place in docs/Ünïcödé プロジェクト that mentions Aleksandra Wiśniewska-Kowalczyk or bartholomew.fitzgerald@northwind-industries-holdings.example.com",
]
WORST_REPLY = """Done. I migrated **1,200** records. Here is what changed:

| File | Owner | Seats | Monthly revenue | Status |
|---|---|---|---|---|
| `bartholomew.fitzgerald@northwind-industries-holdings.example.com.config.json` | Aleksandra Wiśniewska-Kowalczyk | 1,284 | $1,299,999.00 | migrated, with 3 warnings about legacy pricing fields |
| `a` | Jo | 1 | $0.00 | skipped |

The rollout plan is at https://wiki.northwind-industries-holdings.example.com/display/CRM/Customer+Record+Migration+2027+Schema+Rollout+Plan?focusedCommentId=1284&src=contextnavpagetreemode

بارثولوميو فيتزجيرالد · บาร์โธโลมิว ฟิตซ์เจอรัลด์ · 会議メモ 🚀"""

# One of everything, so every count reads 1 ("1 step", "+1", "1 line", "1 prompt").
ONE_PROMPT = "one"


def _worst(messages):
    """The worst-case conversation: four tool calls, then four helpers, then a reply with a wide table and long URLs."""
    rounds = _rounds(messages)
    if rounds == 0:
        return [_think("A big migration. I'll set up the folders, write one record, try an edit, then look at what's there."),
                _text("I'll create the folders and records first."),
                _tool("bash", command=WORST_CMD),
                _tool("write_file", path=WORST_FILE, content=WORST_BODY),
                _tool("edit_file", path=f"{WORST_DIR}/README.md", old_string="2026 schema", new_string="2027 schema"),
                _tool("glob", pattern="src/**/*.json")], "tool_use"
    if rounds == 1:
        return [_text("Now I'll ask four helpers to check the records."), *[_tool("subagent", task=t) for t in WORST_HELPERS]], "tool_use"
    return [_text(WORST_REPLY)], "end_turn"


EDIT_OLD = "This is a throwaway folder for `--demo`."
EDIT_NEW = "This is a scratch folder for the `--demo` mode, made fresh each time.\nNothing in it is kept."


def script(messages):
    """The blocks the demo model replies with, and the stop reason."""
    text, results = _last_user_text(messages)
    body = 'def greet(name):\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("demo"))\n'
    typed = (text if results is None else _last_typed(messages)).lower()
    if typed.startswith("worst case"):
        return _worst(messages)
    if typed == ONE_PROMPT:
        if results is None:  # a new name each time: write_file refuses to overwrite a file it has not read
            return [_tool("write_file", path=f"one-{next(_ids)}.txt", content="1\n")], "tool_use"
        return [_text("1 file written." if not results[0].get("is_error") else "That didn't work (see the card).")], "end_turn"
    if results is not None:  # we just got tool results: wrap up
        first = results[0]
        content = str(first.get("content", ""))
        if content == tools.PLAN_APPROVED:
            return [_think("Approved, so I can write the file now."), _text("Plan approved. Carrying it out."),
                    _tool("write_file", path="demo.py", content=body)], "tool_use"
        if content.startswith(tools.PLAN_CHANGES):
            asked = content[len(tools.PLAN_CHANGES):].split("\n")[0].strip()
            return [_text(f"Understood. You asked for changes:\n\n> {asked}\n\nHere is the plan again (the demo cannot really revise it)."),
                    _tool("exit_plan_mode", plan=PLAN)], "tool_use"
        if "plan" in _last_typed(messages).lower() and _plan_on(messages) and not first.get("is_error") and "demo.py" not in content:
            return [_think("The folder only has a README, so a small new file is enough. I'll propose that."),
                    _tool("exit_plan_mode", plan=PLAN)], "tool_use"
        if not first.get("is_error") and "Demo folder" in content and "edit" in _last_typed(messages).lower():
            return [_text("Now I'll change that line."), _tool("edit_file", path="README.md", old_string=EDIT_OLD, new_string=EDIT_NEW)], "tool_use"
        if first.get("is_error"):
            return [_text(f"That didn't run:\n\n> {content[:300]}\n\nNothing was changed.")], "end_turn"
        if "Created" in content or "Overwrote" in content:
            return [_text("I wrote `demo.py`. Open the **Changes** tab to see the diff. Say `delete it` to try the approval dialog.")], "end_turn"
        if "answered" in content:
            choice = content.split("answered:", 1)[-1].strip()
            return [_text(f"You picked **{choice}**. I'd write hello world in {choice} next (the demo stops here).")], "end_turn"
        return [_text("Done. (The result is in the card above.)")], "end_turn"
    t = (text or "").lower()
    files = _attached(messages)
    if files:
        names = ", ".join(f"`{n}`" for n in files)
        return [_think("The person attached files; the demo can only see their names."),
                _text(f"I can see you attached {names}. (I'm the scripted demo model, so I can't really read them; a Claude model would.)")], "end_turn"
    if "plan" in t:
        if _plan_on(messages):
            return [_think("Plan mode is on, so I may only look. I'll list the folder first."), _text("I'll look around before proposing anything."),
                    _tool("glob", pattern="*")], "tool_use"
        return [_text("Turn on **plan mode** first (the Plan button, Shift+Tab, or `/plan`), then ask me to plan again.")], "end_turn"
    # the review keywords come first: "hidden" contains "hi", "helpers" contains "help"
    if "hidden" in t:
        return [_text("I'll run a command that has an invisible character in it."), _tool("bash", command="echo safe\u202e evil")], "tool_use"
    if "helpers" in t:
        return [_text("I'll ask three helpers at once."), _tool("subagent", task="Summarise README.md"),
                _tool("subagent", task="Describe the project folder"), _tool("subagent", task="Name the main file")], "tool_use"
    if "fail" in t:
        return [_text("I'll edit a file I have not read."), _tool("edit_file", path="README.md", old_string="Demo", new_string="Example")], "tool_use"
    if "cut" in t:
        return [_text(CUT)], "max_tokens"
    if "edit" in t:
        return [_text("I'll read the README first, then edit it."), _tool("read_file", path="README.md")], "tool_use"
    if any(w in t for w in ("delete", "remove", "rm ")):
        return [_text("I'll delete it with a shell command, which needs your approval."), _tool("bash", command="rm demo.py")], "tool_use"
    if any(w in t for w in ("create", "write", "make a file")):
        return [_text("I'll create a small file."), _tool("write_file", path="demo.py", content=body)], "tool_use"
    if any(w in t for w in ("ask", "choose", "pick")):
        return [_tool("ask_user", question="Python or Go?", choices=["Python", "Go"])], "tool_use"
    if "secret" in t or ".env" in t:
        return [_text("I'll look at the .env file."), _tool("read_file", path=".env")], "tool_use"
    if any(w in t for w in ("list", "files")):
        return [_text("Let me look."), _tool("glob", pattern="*")], "tool_use"
    if "long" in t:
        return [_text(LONG)], "end_turn"
    if any(w in t for w in ("hello", "hi", "hey")) or len(t) < 3:
        return [_think("A greeting. I'll say hello and list what the demo can do."), _text(HELLO)], "end_turn"
    return [_text(f"You said: *{text}*\n\n(I'm the scripted demo model, so I only know a few words: try `hello`.)")], "end_turn"


class _Stream:
    def __init__(self, messages, delay):
        self.blocks, self.stop_reason = script(messages)
        self.delay = delay
        n_in = sum(len(str(m["content"])) for m in messages) // 4 + 900
        self.usage = NS(input_tokens=n_in, output_tokens=sum(len(b.text) for b in self.blocks if b.type == "text") // 4 + 8,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0, server_tool_use=None)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        """The stream's events, as the SDK yields them: text and thinking arrive word by word."""
        for b in self.blocks:
            if b.type not in ("text", "thinking"):
                continue
            words = (b.text if b.type == "text" else b.thinking).split(" ")
            for i, w in enumerate(words):
                piece = w + (" " if i < len(words) - 1 else "")
                delta = NS(type="text_delta", text=piece) if b.type == "text" else NS(type="thinking_delta", thinking=piece)
                yield NS(type="content_block_delta", delta=delta)
                time.sleep(self.delay)

    def get_final_message(self):
        return NS(content=self.blocks, stop_reason=self.stop_reason, usage=self.usage, stop_details=None)


class DemoClient:
    """Looks enough like anthropic.Anthropic for the agent loop: messages.stream(...) and nothing else it needs."""

    def __init__(self, delay=0.015):
        self.delay = delay
        self.messages = NS(stream=lambda **kw: _Stream(kw["messages"], self.delay))
        self.beta = NS(messages=self.messages)

    def with_options(self, **kw):
        return self
