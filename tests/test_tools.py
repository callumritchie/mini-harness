"""Checks on the tools themselves: that their names and manuals follow best practice (clear, consistent, complete, true to
the code), that the strict input rules hold for every tool, and that every failure tells the model what to do next.
Offline, no API key: python3 tests/test_tools.py   (or: python3 -m pytest tests/test_tools.py)"""
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["MINI_HARNESS_HOME"] = tempfile.mkdtemp()

import permissions
import tools
from session import Session

NAMES = [t["name"] for t in tools.TOOLS]
SAMPLE = {"string": "x", "integer": 1, "boolean": True, "array": ["a"]}


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+|\n", text) if s.strip()]


# ---------- names ----------

def test_names_are_valid_unique_and_wired_up():
    assert len(NAMES) == len(set(NAMES)), "duplicate tool name"
    for n in NAMES:
        assert re.fullmatch(r"[a-z][a-z0-9_]{1,30}", n), f"{n}: use short lower snake_case (the API allows [a-zA-Z0-9_-]{{1,64}})"
    assert set(NAMES) == set(tools.IMPLEMENTATIONS) == set(tools.SPECS), "every spec needs exactly one implementation"
    assert tools.READ_ONLY_TOOLS <= set(NAMES) and set(tools.SUBAGENT_TOOLS) <= set(NAMES)
    assert not set(tools.SUBAGENT_TOOLS) - tools.READ_ONLY_TOOLS, "a subagent must only get read-only tools"


def test_names_are_distinct_verbs_or_clear_nouns_not_overlapping():
    # no tool name is a prefix of another, and none shadows the provider's own web_search tool
    for a in NAMES:
        assert a != "web_search" and not any(b != a and b.startswith(a + "_") and b.split("_")[0] == a for b in NAMES), a


# ---------- manuals (descriptions) ----------

def test_every_description_is_rich_enough():
    for t in tools.TOOLS:
        d = t["description"]
        assert len(d) >= 250, f"{t['name']}: description too thin ({len(d)} chars); say what, when, when not, limits, failures"
        assert len(sentences(d)) >= 4, f"{t['name']}: needs at least 4 sentences"
        assert len(d) <= 2400, f"{t['name']}: description too long ({len(d)} chars); it is sent on every call"
        plain = re.sub(r"`[^`]*`", "X", d)  # code samples may hold spaces and tabs (the read_file line prefix)
        assert d == d.strip() and "  " not in plain and "\t" not in plain, f"{t['name']}: stray whitespace"
        assert "TODO" not in d and "..." not in d.replace("`...`", ""), t["name"]


def test_every_description_says_when_to_use_it():
    for t in tools.TOOLS:
        assert re.search(r"\b(Use it|Use this)\b", t["description"]), f"{t['name']}: no 'Use it ...' guidance"


def test_tools_that_overlap_point_at_each_other():
    d = {t["name"]: t["description"] for t in tools.TOOLS}
    assert "edit_file" in d["write_file"] and "write_file" in d["edit_file"]
    assert "glob" in d["grep"] and "grep" in d["glob"]
    assert "read_file" in d["grep"] and "glob" in d["read_file"]
    for n in ("read_file", "grep", "glob", "edit_file"):
        assert n in d["bash"], f"bash should send the model to {n} instead of shell equivalents"
    assert "Do not" in d["bash"] and "Do not" in d["subagent"] and "Do not" in d["ask_user"]


def test_tool_names_mentioned_in_manuals_exist():
    known = set(NAMES) | {"cat", "head", "tail", "find", "rg", "ls", "grep", "git", "cd", "web_search"}
    for t in tools.TOOLS:
        for word in re.findall(r"\b([a-z]+_[a-z_]+)\b", t["description"]):
            if word in ("old_string", "new_string", "replace_all", "timeout_seconds", "case_insensitive", "node_modules", "__pycache__", "links_to"):
                continue
            assert word in known, f"{t['name']}: mentions unknown tool-like name '{word}'"
        assert f"do not use {t['name']}" not in t["description"].lower().replace(f"do not use {t['name']}, ", "").replace(f"do not use {t['name']} through", ""), "a tool must not tell the model not to use itself"


def test_numbers_in_manuals_match_the_code():
    d = {t["name"]: t["description"] for t in tools.TOOLS}
    assert str(tools.READ_LIMIT) in d["read_file"] and str(tools.MAX_LINE_CHARS) in d["read_file"]
    assert f"{tools.MAX_TOOL_OUTPUT:,}" in d["bash"]
    p = tools.SPECS["bash"]["input_schema"]["properties"]["timeout_seconds"]
    assert (p["minimum"], p["maximum"]) == (1, tools.MAX_BASH_TIMEOUT) and str(tools.DEFAULT_BASH_TIMEOUT) in p["description"]
    assert str(tools.MAX_MATCHES) in d["grep"] and str(tools.MAX_MATCHES) in d["glob"]
    assert str(tools.SEARCH_SECONDS) in d["grep"] and str(tools.SEARCH_SECONDS) in d["glob"]
    assert str(tools.MAX_SEARCH_FILES) in d["grep"] and str(tools.MAX_GLOB_COLLECT) in d["glob"]
    assert f"{tools.SUBAGENT_RESULT_CHARS:,}" in d["subagent"]
    assert all(n in d["subagent"] for n in tools.SUBAGENT_TOOLS)
    assert tools.SPECS["ask_user"]["input_schema"]["properties"]["choices"]["maxItems"] == 10
    k = tools.SPECS["search_docs"]["input_schema"]["properties"]["top_k"]
    assert k["maximum"] == tools.MAX_SEARCH_RESULTS and str(tools.MAX_SEARCH_RESULTS) in d["search_docs"] and str(tools.DEFAULT_SEARCH_RESULTS) in k["description"]


def test_read_only_tools_are_documented_as_free_and_others_are_not():
    for t in tools.TOOLS:
        free = "no approval needed" in t["description"]
        assert free == (t["name"] in {"glob", "grep", "search_docs", "explore_graph"}) or t["name"] == "read_file", t["name"]


# ---------- input schemas ----------

def test_schemas_are_well_formed():
    for t in tools.TOOLS:
        s = t["input_schema"]
        assert set(t) == {"name", "description", "input_schema"}
        assert s["type"] == "object" and s["additionalProperties"] is False, t["name"]
        assert s["required"] and set(s["required"]) <= set(s["properties"]), t["name"]
        assert len(s["required"]) == len(set(s["required"]))
        for k, p in s["properties"].items():
            assert re.fullmatch(r"[a-z][a-z_]*", k), f"{t['name']}.{k}: use snake_case"
            assert p["type"] in SAMPLE, f"{t['name']}.{k}"
            assert len(p.get("description", "")) >= 20, f"{t['name']}.{k}: every input needs a real description"
            if p["type"] == "array":
                assert p["items"]["type"] == "string" and "maxItems" in p
            if p["type"] == "string" and k not in ("content", "new_string") and "enum" not in p:  # an enum is never blank
                assert p.get("minLength", 0) >= 1, f"{t['name']}.{k}: a blank string is never useful"
            if p["type"] == "integer" and k != "offset":
                assert "minimum" in p and "maximum" in p, f"{t['name']}.{k}: bound every number"
            if k not in s["required"]:
                assert "Default" in p["description"] or "Optional" in p["description"] or "Leave out" in p["description"] or "Only" in p["description"], f"{t['name']}.{k}: say what happens when it is omitted"
        assert tools._signature(t).count("required") == len(s["required"]) + 0


def test_same_input_means_the_same_thing_in_every_tool():
    props = {(t["name"], k): p for t in tools.TOOLS for k, p in t["input_schema"]["properties"].items()}
    for (name, k), p in props.items():
        if k == "path":
            assert "working directory" in p["description"], f"{name}.path should say what a relative path is relative to"
            assert p["type"] == "string"


def test_example_values_in_descriptions_are_valid():
    import fnmatch
    assert re.compile(r"def \w+\(")  # the grep example
    g = tools.SPECS["grep"]["input_schema"]["properties"]["pattern"]["description"]
    assert r"def \w+\(" in g
    assert fnmatch.fnmatch("a.py", "*.py")
    for pat in ("**/*.py", "src/**/test_*.py", "*"):
        assert pat in tools.SPECS["glob"]["input_schema"]["properties"]["pattern"]["description"]
        list(Path(tempfile.mkdtemp()).glob(pat))  # raises if the example is not a valid pattern


def test_check_input_is_strict_for_every_tool():
    for t in tools.TOOLS:
        name, s = t["name"], t["input_schema"]
        ok = {k: SAMPLE[s["properties"][k]["type"]] for k in s["required"]}
        assert tools.check_input(name, ok) is None, (name, tools.check_input(name, ok))
        for k in s["required"]:
            missing = {a: b for a, b in ok.items() if a != k}
            assert f"missing required input '{k}'" in tools.check_input(name, missing)
        assert f"unknown input 'bogus'" in tools.check_input(name, {**ok, "bogus": 1})
        for k, p in s["properties"].items():
            wrong = {"string": 5, "integer": "5", "boolean": "yes", "array": "a"}[p["type"]]
            msg = tools.check_input(name, {**ok, k: wrong})
            assert msg and f"'{k}' must be" in msg, (name, k, msg)
            if p["type"] == "integer":
                assert tools.check_input(name, {**ok, k: True}), f"{name}.{k}: a boolean is not an integer"
            if "minimum" in p:
                assert tools.check_input(name, {**ok, k: p["minimum"] - 1}) and tools.check_input(name, {**ok, k: p["minimum"]}) is None
            if "maximum" in p:
                assert tools.check_input(name, {**ok, k: p["maximum"] + 1}) and tools.check_input(name, {**ok, k: p["maximum"]}) is None
            if p.get("minLength"):
                assert "must not be empty" in tools.check_input(name, {**ok, k: ""})
            if "maxLength" in p:
                assert tools.check_input(name, {**ok, k: "x" * (p["maxLength"] + 1)}) and tools.check_input(name, {**ok, k: "x" * p["maxLength"]}) is None
        assert "must be a JSON object" in tools.check_input(name, "oops") and "must be a JSON object" in tools.check_input(name, None)
        assert _actionable(tools.check_input(name, {})), name


def test_unknown_tool_lists_the_real_ones():
    msg = tools.check_input("read", {})
    assert "Unknown tool 'read'" in msg and all(n in msg for n in NAMES)


# ---------- behaviour: results and failures ----------

def _actionable(msg):
    return bool(re.search(r"\b(retry|try|use|call|set|add|pass|choose|fix|narrow|omit|check|ask|tell|run|put|raise|keep|escape|search|read|do not|ask_user|do|tell)\b", msg, re.I))


class Project:
    def __enter__(self):
        self.old, self.dir = os.getcwd(), Path(tempfile.mkdtemp()).resolve()
        os.chdir(self.dir)
        (self.dir / "a.py").write_text("def one():\n    return 1\n\ndef two():\n    return 1\n")
        (self.dir / "sub").mkdir()
        (self.dir / "sub" / "b.txt").write_text("hello\nHello\n")
        (self.dir / "blob.bin").write_bytes(b"\xff\xfe\x00\x01")
        (self.dir / ".env").write_text("API_KEY=abc\n")
        self.session = Session("claude-opus-5-5")
        return self

    def __exit__(self, *a):
        os.chdir(self.old)

    def run(self, tool, **args):
        bad = tools.check_input(tool, args)
        assert bad is None, bad
        return tools.run(tool, args, self.session)


def test_happy_paths():
    with Project() as p:
        out, err = p.run("read_file", path="a.py"); assert not err and "     1\tdef one():" in out
        out, err = p.run("read_file", path="a.py", offset=4, limit=1); assert out.strip() == "4\tdef two():" or "def two" in out
        out, err = p.run("read_file", path="a.py", limit=2); assert "showing lines 1-2 of 5" in out and "offset=3" in out
        out, err = p.run("write_file", path="new/dir/c.txt", content="x\ny\n"); assert not err and out.startswith("Created") and "2 lines" in out
        out, err = p.run("write_file", path="new/dir/c.txt", content="z"); assert not err and out.startswith("Overwrote")  # tool just wrote it, so it knows it
        out, err = p.run("edit_file", path="a.py", old_string="def one", new_string="def uno"); assert not err and "replaced 1 occurrence." in out
        out, err = p.run("edit_file", path="a.py", old_string="return 1", new_string="return 2", replace_all=True); assert not err and "replaced 2 occurrences" in out
        out, err = p.run("glob", pattern="**/*.txt"); assert not err and "b.txt" in out and "a.py" not in out
        out, err = p.run("glob", pattern="*", path="sub"); assert not err and "b.txt" in out
        out, err = p.run("grep", pattern=r"def \w+\("); assert not err and "a.py:1:" in out and "a.py:4:" in out
        out, err = p.run("grep", pattern="hello", path="sub", case_insensitive=True); assert out.count("b.txt:") == 2
        out, err = p.run("grep", pattern="hello", glob="*.py"); assert "No matches" in out and not err
        out, err = p.run("bash", command="echo hi"); assert not err and "exit code: 0" in out and "hi" in out
        out, err = p.run("ask_user", question="Which?", choices=["a", "b"]); assert not err and "Nobody can answer" in out
        out, err = p.run("search_docs", query="def two"); assert not err and out.startswith("1 passage for") and "a.py:1-5" in out and "     4\tdef two():" in out
        assert tools.take_meta()["sources"][0]["path"] == "a.py" and tools.take_meta() is None  # taken once
        out, err = p.run("explore_graph", name="two"); assert not err and out.startswith("a.two (function): 1 link:") and "<- defines a (module)  [a.py:1-5]" in out
        assert tools.take_meta()["graph"]["center"]["name"] == "a.two"
        out, err = p.run("explore_graph", name="zebra"); assert not err and out.startswith("Nothing in the graph") and "search_docs" in out
        out, err = p.run("search_docs", query="hello", path_prefix="sub"); assert not err and "sub/b.txt" in out and "a.py" not in out
        out, err = p.run("search_docs", query="zebra"); assert not err and out.startswith("No passages") and "grep" in out
        (p.dir / "guide.md").write_text("# Guide\nintro\n## Setup\nrun the installer\n")
        (p.dir / "tests").mkdir()
        (p.dir / "tests" / "test_setup.py").write_text("installer = 'run the installer'\n")
        import rag
        rag.get(p.dir).sync()  # written by the test itself, inside the 2-second re-check window
        out, err = p.run("search_docs", query="run the installer")
        first, rest = out.split("\n\n", 2)[1], out.split("\n\n", 2)[2]
        assert first.startswith("guide.md:1-4  § Guide  (score") and "tests/test_setup.py:1-1  (score" in rest and "[test file]" in rest, out


def test_every_failure_says_what_to_do_next():
    with Project() as p:
        cases = [
            ("read_file", dict(path="nope.py"), "glob"),
            ("read_file", dict(path="sub"), "glob"),
            ("read_file", dict(path="blob.bin"), "bash"),
            ("write_file", dict(path="a.py", content="x"), "read_file"),
            ("write_file", dict(path="sub", content="x"), "file path"),
            ("edit_file", dict(path="nope.py", old_string="a", new_string="b"), "write_file"),
            ("edit_file", dict(path="a.py", old_string="a", new_string="b"), "read_file"),
            ("bash", dict(command="exit 3"), "exit"),
            ("bash", dict(command="sleep 5", timeout_seconds=1), "timeout_seconds"),
            ("glob", dict(pattern="*", path="a.py"), "directory"),
            ("glob", dict(pattern="/abs/*"), "relative"),
            ("grep", dict(pattern="("), "Escape"),
            ("grep", dict(pattern="x", path="missing"), "glob"),
            ("subagent", dict(task="count"), "read_file"),
            ("search_docs", dict(query="x", path_prefix="missing"), "glob"),
            ("search_docs", dict(query="x", path_prefix="/"), "grep"),
        ]
        for name, args, hint in cases:
            out, err = p.run(name, **args)
            assert err, (name, args, out)
            assert hint in out and _actionable(out), (name, args, out)
        p.run("read_file", path="a.py")
        for args, hint in [
            (dict(old_string="return 1", new_string="x"), "replace_all"),
            (dict(old_string="def tw()", new_string="x"), "closest line"),
            (dict(old_string="zzzzzz qqqq", new_string="x"), "tell the user"),
            (dict(old_string="def one", new_string="def one"), "identical"),
        ]:
            out, err = p.run("edit_file", path="a.py", **args)
            assert err and hint in out and _actionable(out), (args, out)
        out, err = p.run("read_file", path="a.py", offset=99); assert err and "1 to 5" in out
        (p.dir / "a.py").write_text("changed")
        out, err = p.run("edit_file", path="a.py", old_string="changed", new_string="x"); assert err and "read_file" in out and "changed on disk" in out


def test_secrets_are_never_searched():
    with Project() as p:
        out, err = p.run("grep", pattern="API_KEY"); assert "abc" not in out and ".env" in out and "tell the user" in out
        out, err = p.run("search_docs", query="API_KEY abc"); assert "API_KEY=abc" not in out and ".env" not in out and out.startswith("No passages")


def test_long_output_is_cut_with_advice():
    with Project() as p:
        out, err = p.run("bash", command=f"python3 -c \"print('x' * {tools.MAX_TOOL_OUTPUT + 500})\"")
        assert not err and len(out) < tools.MAX_TOOL_OUTPUT + 300 and "cut:" in out and "smaller piece" in out


def test_permissions_agree_with_the_manuals():
    with Project() as p:
        pol = permissions.safety.Policy(p.dir, [])
        risky = lambda name, **a: bool(pol.assess(name, a).reasons)
        # the manuals say these run without asking inside the project
        assert not risky("read_file", path="a.py") and not risky("grep", pattern="x") and not risky("glob", pattern="*")
        assert not risky("subagent", task="t") and not risky("ask_user", question="q")
        assert not risky("search_docs", query="x") and not risky("search_docs", query="x", path_prefix="sub")
        graph_risky = lambda **a: bool(pol.assess("explore_graph", a).reasons)  # noqa: E731 (its input is called name)
        assert not graph_risky(name="Store", relation="calls") and graph_risky(name="St‮ore")
        assert risky("search_docs", query="x‮")  # hidden characters still come to the user
        # and these are shown to the user
        assert risky("write_file", path="/etc/hosts", content="x") and risky("write_file", path="run.sh", content="x")
        assert risky("bash", command="rm a.py") and risky("read_file", path=".env")


def test_describe_call_is_one_short_safe_line():
    for name, args in [("bash", {"command": "echo \x1b[2J\nx"}), ("read_file", {"path": "a"}), ("grep", {"pattern": "p"}),
                       ("glob", {"pattern": "*"}), ("ask_user", {"question": "q?"}), ("subagent", {"task": "t"}),
                       ("edit_file", {"path": "a", "old_string": "o" * 500, "new_string": "n"}), ("write_file", {"path": "a", "content": "c"}),
                       ("search_docs", {"query": "frozen\nprefix", "top_k": 3}), ("explore_graph", {"name": "Controller", "depth": 2})]:
        line = tools.describe_call(name, args)
        assert line.startswith(name + "(") and "\x1b" not in line and "\n" not in line and len(line) < 300, line



def test_outcome_says_how_a_call_went_from_our_own_result_text():
    o = tools.outcome
    assert o("bash", {}, "exit code: 0\nok", False) == "exit 0"
    assert o("bash", {}, "Command exited with code 2.\nboom", True) == "exit 2"
    assert o("read_file", {}, "     1\ta\n     2\tb", False) == "2 lines"
    assert o("read_file", {}, "     1\ta\n[showing lines 1-1 of 900; call read_file again with offset=2 for more]", False) == "lines 1–1 of 900"
    assert o("write_file", {}, "Created a.py (3 lines).", False) == "new file"
    assert o("glob", {}, "a.py\nb.py", False) == "2 files" and o("grep", {}, "a.py:1:x", False) == "1 match"
    assert o("grep", {}, "No matches for 'x' in the files that can be searched.", False) == "no matches"
    # a cut list says how many there are, not how many were listed; a stopped search says it is a lower bound
    assert o("glob", {}, "a.py\nb.py\n[1198 more not shown. Narrow it.]", False) == "2 of 1,200 files"
    assert o("glob", {}, "a.py\n[Search stopped after 5000 files: this is only part of what matches. Narrow it.]", False) == "1+ files"
    assert o("grep", {}, "a.py:1:x\nb.py:2:x\n[Search stopped after 200 matches: this is only part of the results.]", False) == "2+ matches"
    assert o("ask_user", {}, "The user answered: Go", False) == "answered: Go"
    assert o("edit_file", {}, "Edited", False) is None and o("read_file", {}, "nope", True) is None
    assert o("search_docs", {}, "5 passages for 'x' (index: 9 files, ranked by keyword match):", False) == "5 passages"
    assert o("search_docs", {}, "1 passage for 'x' (index", False) == "1 passage"
    assert o("search_docs", {}, "No passages match 'x' in the index", False) == "no matches"
    assert o("explore_graph", {}, "pkg.Store (class): 12 links:\n  x", False) == "12 links"
    assert o("explore_graph", {}, "a (module): 1 link within 2 hops:", False) == "1 link"
    assert o("explore_graph", {}, "Nothing in the graph matches 'x'", False) == "no match"


def test_a_front_end_that_does_not_know_an_event_shows_its_text():
    from controller import UI
    seen = []
    ui = UI()
    ui.notice = seen.append
    ui.event("goal_round", {"n": 1}, "goal round 1: working...")
    ui.event("goal_start", {"text": "x"}, "")  # nothing to show
    assert seen == ["goal round 1: working..."]

if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    print("ok" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)
