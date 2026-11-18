# mini-claude

A small coding agent in Python, following Claude Code's conventions. Chat by default; headless with `-p`; unattended
with `--goal`. Works with Anthropic's API (Claude) or DeepSeek's Anthropic-compatible endpoint.

## Run it

```sh
pip install -r requirements.txt
export ANTHROPIC_API_KEY="..."   # put this line in ~/.zshrc, not in this folder (or DEEPSEEK_API_KEY)

python3 agent.py                          # chat
python3 agent.py -p "say hi"              # one task, answer on stdout
python3 agent.py -c                       # continue this folder's last session
python3 agent.py --model claude-sonnet-5-5 --effort low
python3 agent.py --json -p "say hi"       # one JSON line: result, tokens, cost
python3 agent.py --goal "add add() with a test" --verify "python3 -m unittest -q" --allow "python3 -m unittest"
```

Run it from the folder you want it to work in. Keys are read from the environment only and never printed or saved.

## What it does

- **Tools:** read, write and edit files (edits replace exact text, in a file it has read), run commands, search the
  project, web search (the provider's), ask you a question, and run read-only subagents.
- **Safety:** harmless things run; anything risky is shown exactly and asked yes/no, with hidden characters made visible.
  Headless it denies and tells you how to pre-approve (`--allow "pytest"`). `/permissions` switches between asking,
  an AI judge (never shown file contents or tool output; secrets always come to you), and allowing everything.
  Searching is free inside the project and never shows secret files.
- **Long work:** the conversation is replaced by a summary near a limit you set (`--context-limit`, `/compact`). Every
  message is saved to an append-only log the moment it happens, so `-c` survives a crash. `--goal` keeps going until the
  work is done with evidence, your `--verify` check passes, and a fresh read-only reviewer agrees.
- **Cost:** every call is priced from a price list and shown; `--max-turns` and `--max-cost` stop a run. A model missing
  from the list is reported as unpriced, never as $0.
- **Extending:** skills (`skills/`, `.claude/skills/`, `.agents/skills/`) and MCP servers (`.mcp.json`) in Claude Code's
  formats; `AGENTS.md` is loaded as instructions.

## Chat commands

`/new` `/sessions` `/resume [n]` `/model` `/permissions` `/effort` `/context` `/compact` `/limit` `/goal` `/help` `/exit`.
Ctrl-C stops the current turn, not the program.

## Exit codes (headless)

`0` done, `1` error (no key, bad model, API error), `3` did not finish (turn or spending limit, goal not met), `130` Ctrl-C.

## More

- `DESIGN.md`: how it works and every decision.
- `python3 tests/test_loop.py`: offline tests, no key needed.
- Not done: DeepSeek is untested live; MCP supports stdio servers and tools only.
