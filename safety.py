"""What the agent may do without asking, what it must ask about, and how hidden tricks are made visible.
The policy is documented in DESIGN.md ('Safety'); keep the two in step.
"""
import fnmatch
import glob as globmod
import json
import os
import re
import shlex
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

# ---------- what counts as safe ----------

# Commands that only read, and only when used as plain `cmd args` or in a pipe of such commands.
# grep is deliberately not here: searching is the grep tool's job (free inside the project, never shows secrets, capped).
SAFE_COMMANDS = {"ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "which", "whoami", "uname", "stat", "du", "df",
                 "cut", "tr", "diff", "basename", "dirname", "realpath", "sort", "git"}
# git diff and git show are left out: they print the contents of tracked files, secrets included. log -p likewise (banned below).
SAFE_GIT = {"status", "log", "ls-files", "rev-parse", "shortlog"}
BANNED_OPTIONS = {  # options that make an otherwise read-only command write, run something, or print file contents
    "sort": ("-o", "--output", "--compress-program", "-T", "--temporary-directory", "--files0-from"),
    "git": ("--output", "--ext-diff", "--exec", "--git-dir", "--work-tree", "--open-files", "-c", "-C", "-o", "-O",
            "-p", "-u", "--patch", "--cc", "--textconv", "--word-diff", "--color-words", "-L"),
    "wc": ("--files0-from",),
    "du": ("--files0-from",),
}


def uses_banned_option(name, tok):
    """Is this argument one of the command's banned options, however it is written? `-ofile`, `-ro` (several short options in one),
    `--output=f`, and a long option shortened to a prefix (`--outp`, which GNU tools accept) all count."""
    head = tok.split("=", 1)[0]
    for banned in BANNED_OPTIONS.get(name, ()):
        if banned.startswith("--"):
            if head.startswith("--") and len(head) >= 4 and banned.startswith(head):
                return True
        elif tok.startswith("-") and not tok.startswith("--") and banned[1] in tok[1:]:
            return True
    return False
# Files that run later, on their own or when something else starts: writing one always comes to the human.
RUNS_LATER_NAMES = ["*.sh", "*.bash", "*.zsh", "*.fish", "*.command", "*.bat", "*.cmd", "*.ps1", ".bashrc", ".bash_profile",
                    ".bash_login", ".zshrc", ".zprofile", ".zshenv", ".profile", ".envrc", "Makefile", "makefile", "GNUmakefile",
                    "*.mk", "Rakefile", "Justfile", "justfile", "Dockerfile", "Dockerfile.*", "Jenkinsfile", "Vagrantfile",
                    ".gitlab-ci.yml", ".travis.yml", "package.json", "setup.py", "conftest.py", "sitecustomize.py",
                    "usercustomize.py", "*.pth", "*.plist", "*.service", "*.timer", "crontab", "*.desktop",
                    ".pre-commit-config.yaml", ".mcp.json"]  # .mcp.json: it lists programs started at the next launch
RUNS_LATER_DIRS = [(".git", "hooks"), (".github", "workflows"), (".husky",), ("LaunchAgents",), ("LaunchDaemons",), ("cron.d",)]
SHELL_SYNTAX = set(";&><`$(){}\\\n\r")  # anything here and a command is no longer a plain read-only command
SECRET_NAMES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "*.kdbx", "id_rsa*", "id_dsa*",
                "id_ecdsa*", "id_ed25519*", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd",
                "credentials", "credentials.*", "secrets.*", "secret.*", "*.secret", "*.secrets", "service-account*.json",
                "*.tfvars", "terraform.tfstate"]
SECRET_EXAMPLES = (".example", ".sample", ".template", ".dist")  # .env.example and friends hold no secrets
SECRET_DIRS = {".ssh", ".gnupg", ".aws", ".kube", ".password-store", "Keychains"}
def runs_later(path):
    """Why writing this file is special, or None: it runs later (a script, a shell startup file, build or CI config, a git hook,
    or anything with the execute bit set)."""
    p = Path(path)
    if any(fnmatch.fnmatchcase(p.name, pat) for pat in RUNS_LATER_NAMES):
        return f"{p.name} runs later without being asked (a script, startup file, or build/CI config)"
    for d in RUNS_LATER_DIRS:
        if any(tuple(p.parts[i:i + len(d)]) == d for i in range(len(p.parts))):
            return f"files in {'/'.join(d)} run later without being asked"
    if p.exists() and p.is_file() and os.access(p, os.X_OK):
        return f"{p.name} is executable, so it can run later"
    return None


OWN_SECRET_VARS = ("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY")  # removed from the environment of every command we run
PROTECTED_NAMES = {"AGENTS.md", "SKILL.md"}  # loaded into every future session: changing one changes the agent's instructions
SECRET_ENV_WORDS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL")  # a variable whose name has one of these is not passed on
PASS_ENV = set()  # names the person chose to pass on anyway (--pass-env)


def clean_env(environ=None):
    """The environment for a command or an MCP server: everything except our own API keys and anything named like a secret
    (a token, a key, a password...), unless the person passed that name with --pass-env."""
    return {k: v for k, v in (os.environ if environ is None else environ).items()
            if k in PASS_ENV or not (k in OWN_SECRET_VARS or any(w in k.upper() for w in SECRET_ENV_WORDS))}
RISK_HINTS = {"rm": "deletes files", "rmdir": "deletes folders", "mv": "moves or renames files", "cp": "copies files over others",
              "chmod": "changes permissions", "chown": "changes owners", "sudo": "runs as administrator", "dd": "writes raw data",
              "kill": "stops programs", "pkill": "stops programs", "curl": "uses the network", "wget": "uses the network",
              "ssh": "uses the network", "scp": "uses the network", "pip": "installs software", "pip3": "installs software",
              "npm": "installs software or runs scripts", "brew": "installs software", "sed": "can edit files in place",
              "find": "can delete or run things", "env": "shows environment variables, which can hold secrets",
              "printenv": "shows environment variables, which can hold secrets"}


def is_secret(path):
    """True for a path that looks like it holds credentials or keys. Not exhaustive: anything outside the project asks anyway."""
    p = Path(path)
    if any(part in SECRET_DIRS for part in p.parts):
        return True
    name = p.name.lower()
    if name.endswith(SECRET_EXAMPLES):
        return False
    return any(fnmatch.fnmatch(name, pat) for pat in SECRET_NAMES)


# ---------- making hidden tricks visible ----------

CONTROL_NAMES = {0: "NUL", 7: "BEL", 8: "BS", 9: "TAB", 10: "LF", 11: "VT", 12: "FF", 13: "CR", 27: "ESC", 127: "DEL"}
SPACE_RUN = re.compile(r"(?<=\S) {8,}")  # a long run of spaces after text: pushes what follows off the screen


@dataclass
class Finding:
    text: str  # e.g. "1 ESC control character"
    escalate: bool  # True: the action must be asked about even if it would otherwise be safe


def _kind(ch, mode):
    """(label, escalates) if this character should be made visible, else None."""
    o = ord(ch)
    if ch == "\n":
        return None
    if o < 32 or 127 <= o < 160:
        if mode == "content" and ch == "\t":
            return None  # tabs are ordinary in text being written
        return (CONTROL_NAMES.get(o, f"U+{o:04X}"), True)
    cat = unicodedata.category(ch)
    if cat in ("Cf", "Co", "Cs", "Cn") or 0xFE00 <= o <= 0xFE0F or 0xE0100 <= o <= 0xE01EF:
        return (f"U+{o:04X} {unicodedata.name(ch, 'invisible character')}", True)
    if cat in ("Zs", "Zl", "Zp") and ch != " ":
        if mode == "terminal" and cat == "Zs":
            return None  # a no-break space in prose is not a threat on a terminal
        return (f"U+{o:04X} {unicodedata.name(ch, 'space')}", mode != "content")
    return None


def _lookalikes(text):
    """Positions of non-Latin letters inside words that also contain Latin letters (e.g. a Cyrillic 'а' in 'pаypal')."""
    odd = set()
    for m in re.finditer(r"\w+", text):
        letters = [(i, unicodedata.name(c, "").split(" ")[0]) for i, c in enumerate(m.group(), m.start()) if c.isalpha()]
        scripts = {s for _, s in letters}
        if "LATIN" in scripts and len(scripts) > 1:
            odd.update(i for i, s in letters if s != "LATIN" and ord(text[i]) > 127)
    return odd


def reveal(text, mode="command"):
    """Return (display, findings). The display shows control characters, invisible and lookalike characters, odd spaces and
    long runs of spaces as visible markers. mode 'command' (commands, paths, patterns): everything found escalates to an ask;
    'content' (text being written to a file): tabs, plain CRLF and ordinary spaces are left alone, and only invisible or
    control characters escalate."""
    runs = {m.start(): m.end() - m.start() for m in SPACE_RUN.finditer(text)}
    odd = _lookalikes(text) if mode == "command" else set()
    out, counts, escalate, i = [], {}, {}, 0
    while i < len(text):
        if i in runs:
            n = runs[i]
            out.append(f"[␣×{n}]")
            counts[f"a run of {n} spaces"] = counts.get(f"a run of {n} spaces", 0) + 1
            escalate[f"a run of {n} spaces"] = mode == "command"
            i += n
            continue
        ch = text[i]
        found = _kind(ch, mode)
        if ch == "\r" and mode == "content" and text[i + 1:i + 2] == "\n":
            found = None
        if i in odd:
            found = (f"U+{ord(ch):04X} {unicodedata.name(ch, 'lookalike')}", True)
            label = "a lookalike letter mixed into a Latin word"
        elif found:
            label = "a control character" if ord(ch) < 160 else "an invisible or unusual character"
        if found:
            out.append(f"⟨{found[0]}⟩")
            counts[label] = counts.get(label, 0) + 1
            escalate[label] = escalate.get(label, False) or found[1]
        else:
            out.append(ch)
        i += 1
    findings = [Finding(f"{n} × {label}" if n > 1 else label, escalate[label]) for label, n in counts.items()]
    return "".join(out), findings


def visible(text, limit=300):
    """One line, safe to print on a terminal: hidden characters shown as markers, newlines as ↵, cut at `limit` characters."""
    display, _ = reveal(str(text))
    display = display.replace("\n", "↵")
    return display if len(display) <= limit else display[:limit] + f"… [{len(display) - limit} more characters]"


def printable(text):
    """Text from the model, made safe to print on a terminal: control and invisible characters (including ESC, which starts
    terminal commands) become visible markers. Newlines and tabs stay. Works on partial text, so it can be used per chunk."""
    out = []
    for ch in text:
        found = None if ch in "\n\t" else _kind(ch, "terminal")
        out.append(f"⟨{found[0]}⟩" if found else ch)
    return "".join(out)


# ---------- the policy ----------

@dataclass
class Rule:
    kind: str  # bash | read | write
    pattern: str
    text: str  # as the user typed it, for messages


def parse_rule(text):
    """--allow RULE: `pytest` (commands that start with pytest), `write:PATTERN`, `read:PATTERN`, `mcp__server__tool` (`*` allowed)."""
    t = text.strip()
    if t.startswith("mcp__"):
        return Rule("mcp", t, t)
    for kind in ("bash", "write", "read", "mcp"):
        if t.startswith(kind + ":"):
            t = t[len(kind) + 1:].strip()
            break
    else:
        kind = "bash"
    if not t:
        raise ValueError(f"'{text}' has nothing after the prefix. Examples: --allow pytest   --allow 'write:/tmp/**'   --allow 'read:~/notes/*'")
    return Rule(kind, t, text.strip())


@dataclass
class Assessment:
    kind: str  # bash | read | write | none
    title: str  # what the agent wants to do, in words
    display: str  # the exact action, with hidden characters made visible
    targets: list = field(default_factory=list)  # paths (read/write) or the command (bash)
    reasons: list = field(default_factory=list)  # [(code, text)]: why it needs asking. code: outside|secret|protected|unsafe|hidden
    findings: list = field(default_factory=list)  # hidden tricks found, as Finding
    ruleable: bool = True  # whether an --allow rule could ever approve it
    suggestion: str = ""  # the --allow rule to suggest
    summary: str = ""  # the exact action in one line, WITHOUT any file contents: this is all the judge sees of it

    @property
    def risky(self):
        return bool(self.reasons)


class Policy:
    def __init__(self, project, rules=()):
        self.project = Path(project).resolve()
        self.rules = list(rules)

    # --- paths ---

    def resolve(self, raw):
        p = Path(raw).expanduser()
        return (p if p.is_absolute() else self.project / p).resolve()

    def inside(self, path):
        return path == self.project or self.project in path.parents

    def _path_reasons(self, path, verb):
        reasons = []
        if not self.inside(path):
            reasons.append(("outside", f"{verb} outside the project folder ({self.project})"))
        if is_secret(path):
            reasons.append(("secret", "the path looks like it holds secrets (keys, passwords or credentials)"))
        return reasons

    # --- assessing a tool call ---

    TITLES = {"bash": "run a command", "read_file": "read a file", "glob": "list files", "grep": "search files",
              "search_docs": "search the project index", "write_file": "write a file", "edit_file": "edit a file"}

    def assess(self, name, args):
        if name.startswith("mcp__"):
            return self._assess_mcp(name, args)
        a = getattr(self, f"_assess_{name}", None)
        if a is None:
            return Assessment("none", name, visible(args))
        result = a(args)
        result.title = self.TITLES.get(name, result.title)
        return result

    def _assess_mcp(self, name, args):
        """Every call to a tool from an MCP server goes through the gate: what it does is the server's business, not ours."""
        text = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
        a = Assessment("mcp", "call an MCP tool", "", targets=[name])
        shown = self._hidden(a, text)
        a.reasons.append(("unsafe", f"{name} comes from an external MCP server, so what it does is not known to the agent"))
        a.display = f"{name}\n    arguments: {shown[:1500]}{'…' if len(shown) > 1500 else ''}"
        a.summary = f"{name} with arguments {visible(text, 1500)}"
        return a

    def _hidden(self, a, text, mode="command"):
        display, found = reveal(text, mode)
        a.findings += found
        if any(f.escalate for f in found):
            a.reasons.append(("hidden", "it contains hidden characters or long runs of spaces: " + "; ".join(f.text for f in found if f.escalate)))
            a.ruleable = False
        return display

    def _reads(self, name, raw_paths, extra=""):
        a = Assessment("read", name, "")
        shown = []
        for raw in raw_paths:
            shown.append(self._hidden(a, raw))
            p = self.resolve(raw)
            a.targets.append(p)
            a.reasons += self._path_reasons(p, "reads")
        a.display = f"{name}: " + ", ".join(shown) + (f"   ({extra})" if extra else "")
        a.summary = a.display
        return a

    def _assess_read_file(self, args):
        return self._reads("read_file", [args["path"]])

    def _assess_glob(self, args):
        a = self._reads("glob", [args.get("path", ".")], f"pattern {visible(args['pattern'])}")
        self._hidden(a, args["pattern"])
        a.reasons = [r for r in a.reasons if r[0] != "secret"]  # glob only lists names
        if ".." in Path(args["pattern"]).parts or Path(args["pattern"]).is_absolute():
            a.reasons.append(("outside", "the pattern can leave the folder it searches"))
        return a

    def _assess_grep(self, args):
        a = self._reads("grep", [args.get("path", ".")], f"for {visible(args['pattern'])}")
        self._hidden(a, args["pattern"])
        a.reasons = [r for r in a.reasons if r[0] != "secret"]  # the tool never looks inside secret-looking files
        return a

    def _assess_search_docs(self, args):
        a = self._reads("search_docs", [args.get("path_prefix", ".")], f"for {visible(args['query'])}")
        self._hidden(a, args["query"])
        a.reasons = [r for r in a.reasons if r[0] != "secret"]  # secret-looking files are never in the index
        return a

    def _writes(self, name, args, preview):
        a = Assessment("write", f"{name} {args['path']}", "")
        shown = self._hidden(a, args["path"])
        p = self.resolve(args["path"])
        a.targets = [p]
        if not self.inside(p):
            a.reasons.append(("outside", f"writes outside the project folder ({self.project})"))
        if is_secret(p):
            a.reasons.append(("secret", "the path looks like it holds secrets (keys, passwords or credentials)"))
        if ".git" in p.parts and self.inside(p):
            a.reasons.append(("protected", "it changes the inside of the git repository"))
        if p.name in PROTECTED_NAMES and self.inside(p):
            a.reasons.append(("protected", f"{p.name} is loaded as instructions into every future session"))
        if (why := runs_later(p)):
            a.reasons.append(("runs_later", why))
        a.display = f"{name}: {shown}\n{preview(a)}"
        return a

    def _content_preview(self, label, text, a, limit_lines=30, limit_chars=2000):
        display, found = reveal(text, "content")
        a.findings += found
        if any(f.escalate for f in found):
            a.reasons.append(("hidden", f"the text being written contains hidden characters: " + "; ".join(f.text for f in found if f.escalate)))
            a.ruleable = False
        lines = display.split("\n")
        shown, used = [], 0
        for line in lines[:limit_lines]:
            used += len(line)
            if used > limit_chars:
                break
            shown.append(line)
        more = f"\n    … {len(lines) - len(shown)} more line(s), {len(text)} characters in all" if len(shown) < len(lines) else ""
        return f"  {label} ({len(text)} characters, {len(lines)} line(s)):\n" + "\n".join("    │ " + l for l in shown) + more

    def _assess_write_file(self, args):
        a = self._writes("write_file", args, lambda a: self._content_preview("content", args["content"], a))
        a.summary = f"write_file: {visible(args['path'])} ({len(args['content'])} characters; contents not shown to the judge)"
        return a

    def _assess_edit_file(self, args):
        def preview(a):
            old = self._content_preview("replace", args["old_string"], a)
            new = self._content_preview("with", args["new_string"], a)
            return old + "\n" + new
        a = self._writes("edit_file", args, preview)
        a.summary = (f"edit_file: {visible(args['path'])} (replaces {len(args['old_string'])} characters with "
                     f"{len(args['new_string'])}; text not shown to the judge)")
        return a

    def _assess_bash(self, args):
        cmd = args["command"]
        a = Assessment("bash", "run a command", "", targets=[cmd])
        shown = self._hidden(a, cmd)
        a.summary = "bash: " + visible(cmd, limit=1500)
        lines = shown.split("\n")
        a.display = "bash:\n" + "\n".join(f"    {'│ ' if len(lines) > 1 else '$ '}{l}" for l in lines)
        if len(lines) > 1:
            a.findings.append(Finding(f"the command has {len(lines)} lines", False))
        simple = not (set(cmd) & SHELL_SYNTAX) and "||" not in cmd
        a.ruleable = a.ruleable and simple and "|" not in cmd
        safe_why = self._read_only(cmd, a) if not any(code == "hidden" for code, _ in a.reasons) else None
        if safe_why is not None:
            a.reasons += safe_why
        return a

    def _read_only(self, cmd, a):
        """[] if cmd is a plain read-only command (nothing to ask), else the list of reasons it needs asking."""
        if set(cmd) & SHELL_SYNTAX or "||" in cmd:
            return [("unsafe", self._why_unsafe(cmd))]
        reasons = []
        for segment in cmd.split("|"):
            try:
                tokens = shlex.split(segment)
            except ValueError:
                return [("unsafe", "its quoting could not be understood")]
            if not tokens or tokens[0] not in SAFE_COMMANDS:
                return [("unsafe", self._why_unsafe(segment))]
            name, rest = tokens[0], tokens[1:]
            if name == "git" and (not rest or rest[0] not in SAFE_GIT):
                return [("unsafe", f"git {rest[0] if rest else ''} is not on the read-only list (status, log, diff, show, ls-files, rev-parse, blame, shortlog)".replace("  ", " "))]
            for tok in rest:
                if uses_banned_option(name, tok):
                    return [("unsafe", f"{name} {tok} can write files or run programs")]
                reasons += self._token_reasons(tok)
        return reasons

    def _token_reasons(self, tok):
        """Reasons an argument of a read-only command needs asking about: a path outside the project, or a secret."""
        value = tok
        if tok.startswith("-"):
            if "=" in tok:
                value = tok.split("=", 1)[1]  # --file=/etc/passwd
            elif not tok.startswith("--") and tok[2:3] in ("/", "~"):
                value = tok[2:]  # -f/etc/passwd
            else:
                return []
        if not value:
            return []
        if value.startswith("~") or ".." in value.split("/"):
            return [("outside", f"it names a path outside the project folder ({value})")]
        if any(c in value for c in "*?["):  # a wildcard such as .e* can match a secret file: look at what it matches
            hits = globmod.glob(value, root_dir=str(self.project))[:2000]
            if any(is_secret(h) or is_secret(self.resolve(h)) for h in hits):
                return [("secret", f"{value} matches a file that looks like it holds secrets")]
            if value.startswith("/"):
                return self._path_reasons(self.resolve(value.rstrip("*") or "."), "reads")
            return []
        p = self.resolve(value)
        if "/" in value or value == "." or p.exists():  # a path, or a bare name that exists (it may be a symlink out of the project)
            return self._path_reasons(p, "reads") + ([("secret", f"{value} looks like it holds secrets")] if is_secret(value) and not is_secret(p) else [])
        return [("secret", f"{value} looks like it holds secrets (keys, passwords or credentials)")] if is_secret(value) else []

    @staticmethod
    def _why_unsafe(cmd):
        t = cmd.strip()
        if set(t) & set("><"):
            return "it redirects input or output, which can write to files"
        if set(t) & set(";&"):
            return "it chains several commands (or runs one in the background)"
        if set(t) & set("`$(){}"):
            return "it uses shell expansion or substitution, which can hide what really runs"
        try:
            first = shlex.split(t)[0]
        except (ValueError, IndexError):
            first = t.split(" ")[0]
        hint = RISK_HINTS.get(Path(first).name)
        return f"{Path(first).name} is not on the read-only list" + (f" ({Path(first).name} {hint})" if hint else ", so it could change things")

    # --- rules ---

    def matching_rule(self, a):
        """The --allow rule that approves this, or None. Rules never approve secrets or hidden tricks."""
        if not a.reasons or any(code in ("secret", "hidden") for code, _ in a.reasons):
            return None
        for r in self.rules:
            if r.kind == "bash" and a.kind == "bash" and a.ruleable:
                cmd = a.targets[0].strip()
                if cmd == r.pattern or cmd.startswith(r.pattern + " "):
                    return r
            elif r.kind == "mcp" and a.kind == "mcp" and fnmatch.fnmatchcase(a.targets[0], r.pattern):
                return r
            elif r.kind == a.kind and a.kind in ("read", "write") and all(self._glob(t, r.pattern) for t in a.targets):
                return r
        return None

    def _glob(self, path, pattern):
        """Does `path` match the rule's pattern? `*` matches any characters, slashes included, so `/tmp/**` covers a whole tree."""
        base = pattern.rstrip("*")
        resolved = str(self.resolve(base or "."))
        if pattern.endswith("*"):
            resolved = resolved.rstrip("/") + ("/" if base.endswith("/") or not base else "") + "*"
        return fnmatch.fnmatchcase(str(path), resolved)

    def suggest(self, a):
        """The --allow rule that would approve this, as text to show the user (empty if no rule can)."""
        if any(code in ("secret", "hidden") for code, _ in a.reasons):
            return ""
        if a.kind == "mcp":
            return f"--allow {a.targets[0]}"
        if a.kind == "bash":
            return f"--allow {shlex.quote(a.targets[0].strip())}" if a.ruleable else ""
        if a.kind in ("read", "write"):
            return f"--allow {shlex.quote(f'{a.kind}:' + str(a.targets[0]))}"
        return ""
