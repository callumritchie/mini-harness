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
  search            search_docs over the demo folder (ranked passages that open in the Files tab)
  anything else     echoes your message
"""
import itertools
import time
from types import SimpleNamespace as NS

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


def _tool(name, **args):
    return NS(type="tool_use", id=f"toolu_demo{next(_ids)}", name=name, input=args)


def _last_user_text(messages):
    """The latest thing the person typed (not tool results), and whether the last message is tool results."""
    last = messages[-1]
    if isinstance(last["content"], list) and last["content"] and isinstance(last["content"][0], dict) and last["content"][0].get("type") == "tool_result":
        return None, last["content"]
    content = last["content"]
    if isinstance(content, list):
        content = next((b["text"] if isinstance(b, dict) else b.text for b in content if (b.get("type") if isinstance(b, dict) else b.type) == "text"), "")
    return content, None


def _last_typed(messages):
    """The latest thing the person typed, looking past tool results."""
    for m in reversed(messages):
        if m["role"] != "user":
            continue
        text, results = _last_user_text([m])
        if results is None:
            return text or ""
    return ""


EDIT_OLD = "This is a throwaway folder for `--demo`."
EDIT_NEW = "This is a scratch folder for the `--demo` mode, made fresh each time.\nNothing in it is kept."


def script(messages):
    """The blocks the demo model replies with, and the stop reason."""
    text, results = _last_user_text(messages)
    if results is not None:  # we just got tool results: wrap up
        first = results[0]
        content = str(first.get("content", ""))
        if not first.get("is_error") and "Demo folder" in content and "edit" in _last_typed(messages).lower():
            return [_text("Now I'll change that line."), _tool("edit_file", path="README.md", old_string=EDIT_OLD, new_string=EDIT_NEW)], "tool_use"
        if first.get("is_error"):
            return [_text(f"That didn't run:\n\n> {content[:300]}\n\nNothing was changed.")], "end_turn"
        if "Created" in content or "Overwrote" in content:
            return [_text("I wrote `demo.py`. Open the **Changes** tab to see the diff. Say `delete it` to try the approval dialog.")], "end_turn"
        if " passage" in content.split("\n", 1)[0] and "search" in _last_typed(messages).lower():
            return [_text("I found those passages in the index. Open one from the card to see it in the **Files** tab.")], "end_turn"
        if "answered" in content:
            choice = content.split("answered:", 1)[-1].strip()
            return [_text(f"You picked **{choice}**. I'd write hello world in {choice} next (the demo stops here).")], "end_turn"
        return [_text("Done. (The result is in the card above.)")], "end_turn"
    t = (text or "").lower()
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
    if "search" in t:
        return [_text("I'll search the project's index."), _tool("search_docs", query="demo folder throwaway")], "tool_use"
    if any(w in t for w in ("delete", "remove", "rm ")):
        return [_text("I'll delete it with a shell command, which needs your approval."), _tool("bash", command="rm demo.py")], "tool_use"
    if any(w in t for w in ("create", "write", "make a file")):
        body = 'def greet(name):\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("demo"))\n'
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
        return [_text(HELLO)], "end_turn"
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

    @property
    def text_stream(self):
        for b in self.blocks:
            if b.type == "text":
                words = b.text.split(" ")
                for i, w in enumerate(words):
                    yield w + (" " if i < len(words) - 1 else "")
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
