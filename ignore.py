"""A small .gitignore reader, so the document index leaves out what the project's git leaves out (build output, copies, data).

Covers what real .gitignore files use: comments, blank lines, `!` to re-include, a trailing `/` for folders only, a leading or
middle `/` to anchor a pattern to its .gitignore's folder, `*`, `?`, `[abc]` and `**`. Every .gitignore in the project counts,
each for the folder it sits in, and a later or deeper rule wins over an earlier one, as in git. Not read: .git/info/exclude and
the global excludes file (they are personal, not the project's)."""

import re
from pathlib import Path


def _glob(pattern):
    """The regex for one glob, matching a whole relative path (posix)."""
    out, i, n = [], 0, len(pattern)
    while i < n:
        ch = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("/**", i) and i + 3 == n:
            out.append("(?:/.*)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif ch == "*":
            out.append("[^/]*")
            i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        elif ch == "[":
            end = pattern.find("]", i + 1)
            if end < 0:
                out.append(re.escape(ch))
                i += 1
            else:
                body = pattern[i + 1:end]
                out.append("[" + ("^" + body[1:] if body.startswith("!") else body).replace("\\", "\\\\") + "]")
                i = end + 1
        elif ch == "\\" and i + 1 < n:
            out.append(re.escape(pattern[i + 1]))
            i += 2
        else:
            out.append(re.escape(ch))
            i += 1
    return "".join(out)


def parse(text):
    """[(regex, negate, folders_only)] for the lines of one .gitignore."""
    rules = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        if negate:
            line = line[1:]
        elif line.startswith("\\"):
            line = line[1:]
        folders_only = line.endswith("/")
        line = line.rstrip("/")
        if not line:
            continue
        anchored = "/" in line
        line = line.lstrip("/")
        regex = _glob(line) if anchored else "(?:.*/)?" + _glob(line)
        rules.append((re.compile(regex + r"\Z"), negate, folders_only))
    return rules


class Ignore:
    """Which paths of a project its .gitignore files leave out. Paths are relative and posix."""

    def __init__(self, root):
        self.root = Path(root)
        self._rules = {}  # folder (relative, "" for the root) -> its rules

    def _rules_in(self, folder):
        if folder not in self._rules:
            f = self.root / folder / ".gitignore" if folder else self.root / ".gitignore"
            try:
                self._rules[folder] = parse(f.read_text(encoding="utf-8", errors="replace")) if f.is_file() else []
            except OSError:
                self._rules[folder] = []
        return self._rules[folder]

    def _matches(self, rel, is_dir):
        """True, False or None (no rule says) for this one path, without looking at its parents."""
        parts = rel.split("/")
        verdict = None
        for depth in range(len(parts)):  # each .gitignore from the root down to the path's own folder
            folder = "/".join(parts[:depth])
            rest = "/".join(parts[depth:])
            for regex, negate, folders_only in self._rules_in(folder):
                if folders_only and not is_dir:
                    continue
                if regex.match(rest):
                    verdict = not negate
        return verdict

    def ignored(self, rel, is_dir=False):
        """Is this path left out, by a rule for it or for a folder it is in? (A folder left out keeps everything in it out, as
        in git: a `!` rule cannot bring back a file from inside it.)"""
        parts = rel.strip("/").split("/")
        for depth in range(1, len(parts)):
            if self._matches("/".join(parts[:depth]), True):
                return True
        return bool(self._matches("/".join(parts), is_dir))
