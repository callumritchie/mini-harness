"""Tools for mini-harness: the manual the model reads, the strict input rules, and the implementation of each.

Every error raised as ToolError must say what went wrong AND what to try next: the model only sees the message.
"""
import difflib
import fnmatch
import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path

import safety

MAX_TOOL_OUTPUT = 30_000  # characters sent back to the model per tool result
READ_LIMIT = 2000  # lines per read_file call
MAX_LINE_CHARS = 2000
MAX_MATCHES = 200
MAX_GREP_FILE_BYTES = 2_000_000
SEARCH_SECONDS = 10  # wall-clock cap for one grep or glob
MAX_SEARCH_FILES = 20_000  # files one grep will open
MAX_GLOB_COLLECT = 5_000  # files one glob will collect before stopping
SUBAGENT_RESULT_CHARS = 20_000
DEFAULT_BASH_TIMEOUT = 120
MAX_BASH_TIMEOUT = 600
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv"}


class Interrupted(KeyboardInterrupt):
    """The person pressed Stop in a UI. It travels the same road as Ctrl-C, so the task is rolled back the same way."""


class ToolError(Exception):
    """An expected failure. The message goes to the model as-is, so it must say what to do next."""


def _str(description, **extra):
    return {"type": "string", "description": description, **extra}


def _int(description, **extra):
    return {"type": "integer", "description": description, **extra}


def _bool(description):
    return {"type": "boolean", "description": description}


def _list(description, **extra):
    return {"type": "array", "items": {"type": "string", "minLength": 1}, "description": description, **extra}


def _spec(name, manual, properties, required=()):
    return {
        "name": name,
        "description": manual,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": list(required),
            "additionalProperties": False,
        },
    }


# The manuals. Each one says: what it does, when to use it, when not to, the input rules, and what happens on failure.
TOOLS = [
    _spec(
        "read_file",
        "Read a text file. Returns its lines, each prefixed with a line number and a tab "
        "(`    12\\t<text>`). The prefix is not part of the file: leave it out when you copy text into edit_file.\n"
        "Use it to look at a file before changing it. edit_file, and write_file on an existing file, are refused "
        "until you have read the file in this conversation.\n"
        "Do not use it on directories (use glob) or binary files, and do not use bash cat/head/tail to read files.\n"
        "Long files come back in pieces of up to 2000 lines; the result tells you which offset to use for the next piece.\n"
        "On failure (missing file, directory, binary file) the error tells you which tool to use instead.",
        {
            "path": _str("File to read, absolute or relative to the working directory.", minLength=1),
            "offset": _int("First line to read, counting from 1. Default 1.", minimum=1),
            "limit": _int("Number of lines to read, 1-2000. Default 2000.", minimum=1, maximum=READ_LIMIT),
        },
        ["path"],
    ),
    _spec(
        "write_file",
        "Create a new file, or replace an existing file completely, with the given content. Missing parent "
        "directories are created.\n"
        "Use it for new files and full rewrites. For a change to part of an existing file use edit_file instead: it is "
        "safer and sends less text.\n"
        "To overwrite an existing file you must have read it first in this conversation; the error says so if you have not.\n"
        "Inputs: path (required), content (required, the complete new file text; may be empty).",
        {
            "path": _str("File to create or overwrite.", minLength=1),
            "content": _str("The complete new content of the file."),
        },
        ["path", "content"],
    ),
    _spec(
        "edit_file",
        "Replace exact text in an existing file.\n"
        "Rules: the file must have been read with read_file in this conversation, and must not have changed since. "
        "old_string must match the file exactly, including spaces, tabs, indentation and line breaks, and must be unique "
        "in the file: include enough surrounding lines to make it unique, or set replace_all to true to change every "
        "occurrence. old_string and new_string must differ. Never include the read_file line-number prefix.\n"
        "To create a file use write_file. To rename something everywhere in one file use replace_all.\n"
        "On failure the error says which rule was broken and what to do (for a missing old_string it shows the closest "
        "line in the file).",
        {
            "path": _str("File to edit.", minLength=1),
            "old_string": _str("Exact text to replace. Must be non-empty.", minLength=1),
            "new_string": _str("Replacement text. May be empty to delete old_string."),
            "replace_all": _bool("Replace every occurrence instead of requiring a unique match. Default false."),
        },
        ["path", "old_string", "new_string"],
    ),
    _spec(
        "bash",
        "Run a shell command in the working directory and return its exit code, stdout and stderr.\n"
        "Use it to run programs, tests and scripts, and for git or package tools. Do not use it to read, search or edit "
        "files, and do not use grep, find, rg, cat or ls -R through it: read_file, grep, glob and edit_file do that, and "
        "they need no approval inside the project. Commands that could change things are shown to the user for approval; "
        "a refusal comes back as an error, and you must not look for another way to do the same thing.\n"
        "Each call starts a fresh shell: `cd` and environment variables do not carry over, and nothing can read from "
        "stdin. Output over 30,000 characters is cut. A non-zero exit code is reported as an error together with the "
        "output so you can fix the cause.\n"
        f"Inputs: command (required), timeout_seconds (optional, 1-{MAX_BASH_TIMEOUT}, default {DEFAULT_BASH_TIMEOUT}). "
        "A command that runs out of time is killed; the error suggests what to do.",
        {
            "command": _str("The shell command to run.", minLength=1),
            "timeout_seconds": _int(
                f"Kill the command after this many seconds. Default {DEFAULT_BASH_TIMEOUT}.",
                minimum=1, maximum=MAX_BASH_TIMEOUT,
            ),
        },
        ["command"],
    ),
    _spec(
        "glob",
        "Find files by name pattern, e.g. `**/*.py` or `src/**/test_*.py`. Returns up to 200 paths, newest first. "
        "Skips .git, __pycache__, node_modules and virtualenvs. Free inside the project (no approval needed).\n"
        "Use it to find files or list a directory (`*`), not `ls` or `find` through bash. To search inside files use grep.\n"
        "Inputs: pattern (required, relative, no leading /), path (optional directory to search from, default the "
        "working directory). No matches is not an error; the result suggests how to widen the search. A search is "
        f"stopped after {SEARCH_SECONDS} seconds or {MAX_GLOB_COLLECT} files; the result then says so, and you should narrow "
        "the pattern or path and search again.",
        {
            "pattern": _str("Glob pattern, relative to path.", minLength=1),
            "path": _str("Directory to search from. Default: working directory.", minLength=1),
        },
        ["pattern"],
    ),
    _spec(
        "grep",
        "Search file contents with a regular expression (Python `re` syntax). Returns up to 200 matches as "
        "`path:line:text`. Skips .git, __pycache__, node_modules, virtualenvs and binary or very large files. Free "
        "inside the project (no approval needed). It never looks inside files that look like they hold secrets (.env, "
        "keys, credentials): they are skipped and reported by name, so a search can never show their contents.\n"
        "Use it to find where something is defined or used. Search with this tool, not with grep, rg or find through "
        "bash. To find files by name use glob; to see a whole file use read_file.\n"
        f"A search is stopped after {MAX_MATCHES} matches, {SEARCH_SECONDS} seconds or {MAX_SEARCH_FILES} files; the result "
        "then says it is partial and you must narrow it (a more specific pattern, a subfolder as path, or a glob filter) "
        "and search again.\n"
        "Inputs: pattern (required), path (optional file or directory, default the working directory), glob (optional "
        "filename filter such as `*.py`), case_insensitive (optional boolean). Escape regex special characters such as "
        "`(` `.` `[` with a backslash to match them literally. An invalid pattern or no matches comes back with a "
        "suggestion for what to change.",
        {
            "pattern": _str("Regular expression to search for.", minLength=1),
            "path": _str("File or directory to search. Default: working directory.", minLength=1),
            "glob": _str("Only search files whose name matches this pattern, e.g. `*.py`.", minLength=1),
            "case_insensitive": _bool("Ignore case. Default false."),
        },
        ["pattern"],
    ),
]
TOOLS += [
    _spec(
        "ask_user",
        "Ask the user one question and get their answer back. Use it only when a missing detail really changes the work and "
        "you cannot find it yourself or assume it sensibly: a choice between approaches, a name, a preference. One "
        "question per call. When there are a few clear options pass them as `choices` (up to 10): the user sees a numbered "
        "list and may still type their own answer. Do not use it to ask permission for things (the permission system does "
        "that), to ask for things you can look up with your tools, or to chat.\n"
        "If nobody can answer (a headless or unattended run) the result says so: then choose the most reasonable option, "
        "carry on, and say clearly in your final answer that you assumed it and what you assumed.",
        {
            "question": _str("The question, one clear sentence.", minLength=1, maxLength=500),
            "choices": _list("Optional answers to offer, shortest first.", maxItems=10),
        },
        ["question"],
    ),
    _spec(
        "subagent",
        "Run a helper on a task in a fresh, empty conversation and get back only its final answer. The helper has "
        "read_file, glob and grep only: it can look, count, search and report, and it cannot write, edit, run commands or "
        "ask the user. A request to change something is refused.\n"
        "The helper cannot see this conversation, so the task must carry everything it needs: every file path, every "
        "fact, name and number, what to look for, and what form the answer should take (for example 'reply with just the "
        "number'). Vague tasks give vague answers.\n"
        "Use it for research that would fill this conversation with reading (surveying many files, counting, checking a "
        "claim), and for a second opinion. Do not use it for work that changes anything. Several subagent calls in one "
        "reply run one after another.",
        {"task": _str("The complete task, with every path and fact the helper needs.", minLength=1)},
        ["task"],
    ),
]
SPECS = {t["name"]: t for t in TOOLS}
READ_ONLY_TOOLS = {"read_file", "glob", "grep"}  # inside the project these run without asking
SUBAGENT_TOOLS = ["read_file", "glob", "grep"]  # all a subagent is given


# ---------- strict input rules ----------

def _signature(spec):
    props, required = spec["input_schema"]["properties"], spec["input_schema"].get("required", [])
    return ", ".join(f"{k} ({p.get('type', 'any')}, {'required' if k in required else 'optional'})" for k, p in props.items())


def _type_ok(kind, value):
    return {
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
        "null": value is None,
    }.get(kind, True)  # a type we do not know is left to the tool itself


def check_schema(name, spec, args, strict_unknown=True):
    """Return None if args obey the tool's schema, else an error message for the model. Strict: required inputs present,
    (optionally) no unknown inputs, right types, ranges, lengths and allowed values."""
    schema = spec["input_schema"]
    if not isinstance(args, dict):
        return f"Input for {name} must be a JSON object. Expected inputs: {_signature(spec)}. Retry with an object."
    props = schema.get("properties", {})
    problems = [f"missing required input '{k}'" for k in schema.get("required", []) if k not in args]
    for key, value in args.items():
        if key not in props:
            if strict_unknown:
                problems.append(f"unknown input '{key}'")
            continue
        p = props[key]
        kind = p.get("type")
        kinds = kind if isinstance(kind, list) else [kind]
        if kind is not None and not any(_type_ok(k, value) for k in kinds):
            problems.append(f"'{key}' must be a {' or '.join(map(str, kinds))}, got {type(value).__name__}")
            continue
        if "enum" in p and value not in p["enum"]:
            problems.append(f"'{key}' must be one of {p['enum']}, got {value!r}")
        elif isinstance(value, str) and not (p.get("minLength", 0) <= len(value) <= p.get("maxLength", len(value))):
            need = "not be empty" if p.get("minLength", 0) == 1 else f"be at least {p.get('minLength', 0)} characters"
            problems.append(f"'{key}' must {need}" + (f" and at most {p['maxLength']} characters" if "maxLength" in p else ""))
        elif isinstance(value, (int, float)) and not isinstance(value, bool) and not p.get("minimum", value) <= value <= p.get("maximum", value):
            problems.append(f"'{key}' must be between {p.get('minimum', '-inf')} and {p.get('maximum', 'inf')}, got {value}")
        elif isinstance(value, list):
            if len(value) > p.get("maxItems", len(value)):
                problems.append(f"'{key}' can have at most {p['maxItems']} items, got {len(value)}")
            item_kind = p.get("items", {}).get("type")
            for i, item in enumerate(value):
                if item_kind and not _type_ok(item_kind, item):
                    problems.append(f"'{key}'[{i}] must be a {item_kind}, got {type(item).__name__}")
                elif item_kind == "string" and not item:
                    problems.append(f"'{key}'[{i}] must not be empty")
    if problems:
        return f"Invalid input for {name}: {'; '.join(problems)}. Expected inputs: {_signature(spec)}. Fix the call and retry."
    return None


def check_input(name, args):
    """check_schema for our own tools (strict about unknown inputs too)."""
    spec = SPECS.get(name)
    if spec is None:
        return f"Unknown tool '{name}'. Available tools: {', '.join(SPECS)}. Pick one of those."
    return check_schema(name, spec, args)


# ---------- helpers ----------

def _path(raw):
    return Path(raw).expanduser().resolve()


def _stamp(p):
    st = p.stat()
    return (st.st_mtime_ns, st.st_size)


def _read_text(p, raw):
    if not p.exists():
        raise ToolError(f"{raw} does not exist. Use glob (for example pattern '**/{p.name}') to find the right path, then retry.")
    if p.is_dir():
        raise ToolError(f"{raw} is a directory, not a file. Use glob with path='{raw}' to list what is inside it.")
    try:
        return p.read_bytes().decode("utf-8")  # bytes, so line endings are kept exactly as they are
    except UnicodeDecodeError:
        raise ToolError(f"{raw} is not UTF-8 text (probably a binary file), so read_file cannot show it. Use bash (e.g. `file {raw}`) to inspect it.")


def _require_read(session, p, raw, tool):
    if p not in session.reads:
        raise ToolError(f"{tool} is refused: you have not read {raw} in this conversation, so you could be working from a wrong picture of it. Call read_file on it first, then retry.")
    if _stamp(p) != session.reads[p]:
        raise ToolError(f"{raw} changed on disk since you last read it. Call read_file on it again, then retry {tool} with text from the fresh copy.")


def _announce(session, path, before, after):
    """Tell a UI that a file changed (before is None for a new file). Never lets a UI problem break the tool."""
    hook = getattr(session, "on_change", None)
    if hook is not None:
        try:
            hook(_rel(path), before, after)
        except Exception:  # noqa: BLE001
            pass


def _skipped(rel_parts):
    return any(part in SKIP_DIRS for part in rel_parts)


def _rel(p):
    try:
        return str(p.relative_to(Path.cwd()))
    except ValueError:
        return str(p)


# ---------- implementations: f(args, session) -> str ----------

def read_file(a, session):
    p = _path(a["path"])
    lines = _read_text(p, a["path"]).splitlines()
    session.reads[p] = _stamp(p)
    if not lines:
        return "(file is empty)"
    offset, limit = a.get("offset", 1), a.get("limit", READ_LIMIT)
    if offset > len(lines):
        raise ToolError(f"offset {offset} is past the end of the file, which has {len(lines)} lines. Use an offset from 1 to {len(lines)}.")
    chunk = lines[offset - 1: offset - 1 + limit]
    out = "\n".join(f"{i:>6}\t{line[:MAX_LINE_CHARS]}" for i, line in enumerate(chunk, offset))
    last = offset + len(chunk) - 1
    if last < len(lines):
        out += f"\n[showing lines {offset}-{last} of {len(lines)}; call read_file again with offset={last + 1} for more]"
    return out


def write_file(a, session):
    p = _path(a["path"])
    existed = p.exists()
    if p.is_dir():
        raise ToolError(f"{a['path']} is a directory. Choose a file path inside it, for example {a['path'].rstrip('/')}/name.txt.")
    if existed:
        _require_read(session, p, a["path"], "write_file")
    before = p.read_bytes().decode("utf-8", "replace") if existed else None
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(a["content"].encode("utf-8"))
    session.reads[p] = _stamp(p)  # we know exactly what is in it now
    _announce(session, p, before, a["content"])
    return f"{'Overwrote' if existed else 'Created'} {a['path']} ({len(a['content'].splitlines())} lines)."


def edit_file(a, session):
    raw, old, new = a["path"], a["old_string"], a["new_string"]
    p = _path(raw)
    if not p.exists():
        raise ToolError(f"{raw} does not exist. To create it use write_file; to find the right path use glob.")
    _require_read(session, p, raw, "edit_file")
    if old == new:
        raise ToolError("old_string and new_string are identical, so nothing would change. Put the replacement text in new_string.")
    text = _read_text(p, raw)
    count = text.count(old)
    if count == 0:
        first = next((l.strip() for l in old.splitlines() if l.strip()), "")
        file_lines = text.splitlines()
        close = difflib.get_close_matches(first, [l.strip() for l in file_lines], n=1, cutoff=0.6) if first else []
        if close:
            n = next(i for i, l in enumerate(file_lines, 1) if l.strip() == close[0])
            hint = f"The closest line is {n}: {file_lines[n - 1]!r}. If that is the one you meant, retry with its exact text."
        else:
            hint = ("No similar line exists in it. Check your earlier read_file output, or use grep to look in other files. "
                    "If you cannot find it, tell the user the text is not there and ask what they meant.")
        raise ToolError(f"old_string was not found in {raw}. The file is unchanged since you read it, so the text is not in it exactly as written (matching includes whitespace and line breaks). {hint}")
    if count > 1 and not a.get("replace_all"):
        where = [text.count("\n", 0, m.start()) + 1 for m in re.finditer(re.escape(old), text)]
        raise ToolError(f"old_string appears {count} times in {raw} (lines {', '.join(map(str, where[:8]))}). Add surrounding lines to old_string to make it unique, or set replace_all to true to change every occurrence.")
    replaced = count if a.get("replace_all") else 1
    updated = text.replace(old, new, -1 if a.get("replace_all") else 1)
    p.write_bytes(updated.encode("utf-8"))
    session.reads[p] = _stamp(p)
    _announce(session, p, text, updated)
    return f"Edited {raw}: replaced {replaced} occurrence{'s' if replaced != 1 else ''}."


def bash(a, session):
    timeout = a.get("timeout_seconds", DEFAULT_BASH_TIMEOUT)
    env = {k: v for k, v in os.environ.items() if k not in safety.OWN_SECRET_VARS}  # our own API keys never reach a command
    cancel = getattr(session, "cancel", None)
    p = subprocess.Popen(a["command"], shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         stdin=subprocess.DEVNULL, env=env, start_new_session=True)  # its own process group, so Stop can kill all of it

    def kill():
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            p.kill()
        p.wait()

    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                stdout, stderr = p.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if cancel is not None and cancel.is_set():
                    raise Interrupted()
                if time.monotonic() > deadline:
                    kill()
                    raise ToolError(f"Command timed out after {timeout}s and was killed. Run something smaller, or raise timeout_seconds (max {MAX_BASH_TIMEOUT}), or start long jobs in the background with output sent to a file.")
    except BaseException:  # Ctrl-C, Stop, a timeout: never leave the command running
        kill()
        raise
    output = "".join(
        f"--- {label} ---\n{text}" + ("" if text.endswith("\n") else "\n")
        for label, text in (("stdout", stdout), ("stderr", stderr)) if text
    ) or "(no output)\n"
    if p.returncode != 0:
        raise ToolError(f"Command exited with code {p.returncode}.\n{output}Read the output above, fix the cause, and run it again.")
    return f"exit code: 0\n{output}"


NARROW = "Narrow it: use a more specific pattern, point path at a subfolder, or filter files (glob: '*.py'), then search again."


def glob(a, session):
    base = _path(a.get("path", "."))
    if not base.is_dir():
        raise ToolError(f"{a.get('path', '.')} is not a directory. Pass an existing directory as path, or omit path to search the working directory.")
    deadline, found, capped = time.monotonic() + SEARCH_SECONDS, [], None
    try:
        for p in base.glob(a["pattern"]):
            if time.monotonic() > deadline:
                capped = f"{SEARCH_SECONDS} seconds"
                break
            if p.is_file() and not _skipped(p.relative_to(base).parts):
                found.append(p)
                if len(found) >= MAX_GLOB_COLLECT:
                    capped = f"{MAX_GLOB_COLLECT} files"
                    break
    except (NotImplementedError, ValueError):
        raise ToolError(f"Invalid pattern '{a['pattern']}': it must be relative (no leading /) and non-empty. Put the directory in path and keep the pattern like '**/*.py'.")
    if not found:
        if capped:
            return f"No files found before the search stopped after {capped}, so the result may be incomplete. {NARROW}"
        return f"No files matched '{a['pattern']}' in {_rel(base)}. Try a broader pattern such as '**/*', or check the directory with path."
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out = "\n".join(_rel(p) for p in found[:MAX_MATCHES])
    if capped:
        out += f"\n[Search stopped after {capped}: this is only part of what matches. {NARROW}]"
    elif len(found) > MAX_MATCHES:
        out += f"\n[{len(found) - MAX_MATCHES} more not shown. {NARROW}]"
    return out


def _walk_files(base):
    if base.is_file():
        yield base
        return
    for root, dirs, names in os.walk(base):  # symlinked folders are not followed
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for n in sorted(names):
            yield Path(root) / n


def grep(a, session):
    try:
        regex = re.compile(a["pattern"], re.IGNORECASE if a.get("case_insensitive") else 0)
    except re.error as e:
        raise ToolError(f"Invalid regular expression: {e}. Escape special characters such as ( ) [ ] . * with a backslash, or search for a simpler plain string.")
    base = _path(a.get("path", "."))
    if not base.exists():
        raise ToolError(f"{a.get('path')} does not exist. Use glob to find the right path, or omit path to search the working directory.")
    root = base if base.is_dir() else base.parent
    deadline, matches, secrets, scanned, capped = time.monotonic() + SEARCH_SECONDS, [], [], 0, None
    for f in _walk_files(base):
        if time.monotonic() > deadline:
            capped = f"{SEARCH_SECONDS} seconds"
            break
        if a.get("glob") and not fnmatch.fnmatch(f.name, a["glob"]):
            continue
        real = f.resolve()
        if safety.is_secret(f) or safety.is_secret(real):  # never opened, so nothing about them can leak, not even a match count
            secrets.append(_rel(f))
            continue
        if root.resolve() not in real.parents and real != root.resolve():  # a symlink pointing out of the searched folder
            continue
        scanned += 1
        if scanned > MAX_SEARCH_FILES:
            capped = f"{MAX_SEARCH_FILES} files"
            break
        try:
            if f.stat().st_size > MAX_GREP_FILE_BYTES:
                continue
            lines = f.read_bytes().decode("utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(lines, 1):
            if regex.search(line):
                matches.append(f"{_rel(f)}:{n}:{line[:300]}")
            if len(matches) >= MAX_MATCHES:
                capped = f"{MAX_MATCHES} matches"
                break
            if n % 2000 == 0 and time.monotonic() > deadline:
                capped = f"{SEARCH_SECONDS} seconds"
                break
        if capped:
            break
    note = ""
    if secrets:
        shown = ", ".join(secrets[:5]) + (f" and {len(secrets) - 5} more" if len(secrets) > 5 else "")
        note = (f"\n[Skipped {len(secrets)} file(s) that look like they hold secrets: {shown}. Search never looks inside them, so "
                "nothing about their contents can be reported. If the task truly needs one, tell the user; do not try to get around this.]")
    if not matches:
        stopped = f" The search stopped after {capped}, so it may be incomplete. {NARROW}" if capped else ""
        return f"No matches for '{a['pattern']}' in the files that can be searched.{stopped}{note}"
    out = "\n".join(matches)
    if capped:
        out += f"\n[Search stopped after {capped}: this is only part of the results. {NARROW}]"
    return out + note


def ask_user(a, session):
    """Put one question to the human. session.ask_human(question, choices) returns the answer text, or None if nobody can answer."""
    answer = session.ask_human(a["question"], a.get("choices") or [])
    if answer is None:
        return ("Nobody can answer: this is a headless or unattended run. Do not wait. Choose the most reasonable option, carry on, "
                "and say clearly in your final answer that you assumed it, and what you assumed.")
    return f"The user answered: {answer}" if answer.strip() else "The user gave no answer. Choose the most reasonable option and say that you assumed it."


def subagent(a, session):
    """Run a read-only helper in a fresh conversation; only its final answer comes back."""
    if not getattr(session, "run_subagent", None):
        raise ToolError("Subagents are not available in this session. Do the work yourself with read_file, glob and grep.")
    return session.run_subagent(a["task"])[:SUBAGENT_RESULT_CHARS]


IMPLEMENTATIONS = {f.__name__: f for f in (read_file, write_file, edit_file, bash, glob, grep, ask_user, subagent)}


# ---------- running ----------

def clip(text):
    if len(text) <= MAX_TOOL_OUTPUT:
        return text
    return text[:MAX_TOOL_OUTPUT] + f"\n... [cut: {len(text) - MAX_TOOL_OUTPUT} more characters. Ask for a smaller piece (offset/limit, a narrower pattern, or filter the command's output).]"


def run(name, args, session):
    """Run a tool whose input already passed check_input. Returns (text, is_error); never raises."""
    try:
        return clip(IMPLEMENTATIONS[name](args, session)), False
    except ToolError as e:
        return clip(str(e)), True
    except PermissionError as e:
        return f"Permission denied by the operating system: {e}. Choose a different path, or check the file's permissions with bash (ls -l).", True
    except OSError as e:
        return f"{type(e).__name__}: {e}. Check the path and try again, or use a different approach.", True
    except Exception as e:  # a bug in a tool must still produce an answer
        return f"Internal error in {name}: {type(e).__name__}: {e}. Try the call again with different input, or use another tool.", True


def describe_call(name, args):
    """Short one-line description of a call, for the activity line. Hidden characters are shown as markers, never printed raw."""
    if not isinstance(args, dict):
        return name
    if name == "edit_file":
        return f"{name}({safety.visible(args.get('path'))}: replace {safety.visible(str(args.get('old_string', ''))[:50])!r})"
    if name == "write_file":
        return f"{name}({safety.visible(args.get('path'))}, {len(str(args.get('content', '')))} chars)"
    detail = args.get("command") or args.get("path") or args.get("pattern") or args.get("query") or args.get("question") or args.get("task") or ""
    if not detail and args:  # e.g. an MCP tool: show its arguments
        detail = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    return f"{name}({safety.visible(detail, limit=200)})"
