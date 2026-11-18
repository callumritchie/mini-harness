"""Skills, in Claude Code's format: a folder with a SKILL.md whose frontmatter has a name and a description.
Only the frontmatter goes into the instructions; the model reads the rest with read_file when a task matches.
"""
import re
from pathlib import Path

SKILL_DIRS = ["skills", ".claude/skills", ".agents/skills"]  # relative to the project folder, searched in this order
MAX_SKILLS = 50
MAX_DESCRIPTION = 400

HEADER = ("Skills: each is a folder with a SKILL.md that explains how to do one kind of task. Only the name and description are "
          "listed here. When the user's task matches a skill's description, read its SKILL.md with read_file and follow it. "
          "Do not read a skill that does not match the task.")


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_frontmatter(text):
    """The `key: value` pairs between the leading `---` lines (a small subset of YAML: plain, quoted, and > or | block
    values, with indented continuation lines). Returns {} if there is no frontmatter."""
    lines = text.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return {}
    data, i = {}, 1
    while i < end:
        m = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", lines[i])
        i += 1
        if not m:
            continue
        key, rest = m.group(1), m.group(2).strip()
        block = []
        while i < end and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
            block.append(lines[i].strip())
            i += 1
        if re.fullmatch(r"[>|][+-]?", rest):
            joiner = " " if rest.startswith(">") else "\n"
            data[key] = joiner.join(l for l in block if l).strip()
        else:
            data[key] = " ".join([_unquote(rest)] + [l for l in block if l and not l.startswith(("-", "#"))]).strip()
    return data


def discover(project):
    """Find skills under the project folder. Returns (skills, warnings); skills are dicts with name, description, path (relative)."""
    project = Path(project).resolve()
    skills, warnings, seen = [], [], set()
    for d in SKILL_DIRS:
        base = project / d
        if not base.is_dir():
            continue
        for folder in sorted(p for p in base.iterdir() if p.is_dir()):
            md = folder / "SKILL.md"
            if not md.is_file():
                continue
            rel = md.relative_to(project)
            if project not in md.resolve().parents:
                warnings.append(f"skipped {rel}: it points outside the project folder")
                continue
            try:
                meta = parse_frontmatter(md.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError) as e:
                warnings.append(f"skipped {rel}: {e}")
                continue
            name = meta.get("name") or folder.name
            if not meta.get("description"):
                warnings.append(f"skipped {rel}: its frontmatter has no description")
                continue
            if name in seen:
                continue  # an earlier folder in the search order wins
            if len(skills) >= MAX_SKILLS:
                warnings.append(f"skipped {rel}: more than {MAX_SKILLS} skills")
                continue
            seen.add(name)
            desc = " ".join(meta["description"].split())
            skills.append({"name": name, "description": desc[:MAX_DESCRIPTION] + ("…" if len(desc) > MAX_DESCRIPTION else ""), "path": str(rel)})
    return skills, warnings


def instructions(skills):
    """The text that goes into the system prompt: frontmatter only."""
    if not skills:
        return ""
    return HEADER + "\n" + "\n".join(f"- {s['name']}: {s['description']} ({s['path']})" for s in skills)
