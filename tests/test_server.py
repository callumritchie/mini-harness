"""Tests for the web UI server, with the scripted demo model (no API key needed): python3 tests/test_server.py"""
import faulthandler
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ["MINI_HARNESS_HOME"] = tempfile.mkdtemp()
faulthandler.dump_traceback_later(120, exit=True)  # a hang is a failure, not a stuck test run

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import agent
import demo
import rag
import webserver
from controller import Controller

PORT = 8765
TOKEN = "test-token-123"
project = Path(tempfile.mkdtemp()).resolve()
os.chdir(project)
(project / ".env").write_text("API_KEY=sk-live-should-never-be-served\n")
(project / "app.py").write_text("print('hi')\n")
(project / "sub").mkdir(); (project / "sub" / "notes.txt").write_text("notes\n")
(project / ".git").mkdir(); (project / ".git" / "config").write_text("[remote]\nurl = https://user:pw@example.com/x.git\n")
os.symlink("/etc/hosts", project / "link")


def make(delay=0.0):
    args = agent.build_parser().parse_args(["--demo"])
    args.model = "claude-opus-5-5"
    ui = webserver.WebUI()
    ctl = Controller(args, ui, client_factory=lambda provider: demo.DemoClient(delay))
    ctl.start()
    app = webserver.create_app(ctl, ui, TOKEN, PORT)
    return ctl, ui, TestClient(app, base_url=f"http://127.0.0.1:{PORT}")


def collect(ws, until, limit=400):
    """Read events until one of type `until` arrives; returns all events read."""
    events = []
    for _ in range(limit):
        e = ws.receive_json()
        events.append(e)
        if e["type"] == until:
            return events
    raise AssertionError(f"never saw {until}: {[e['type'] for e in events][-10:]}")


def types(events):
    return [e["type"] for e in events]


H = {"Authorization": f"Bearer {TOKEN}"}
WS = {"Host": f"127.0.0.1:{PORT}"}  # the test client would otherwise send Host: testserver
ctl, ui, client = make()

# ---------- locked down ----------
assert client.get("/api/info").status_code == 401
assert client.get("/api/info", headers={"Authorization": "Bearer nope"}).status_code == 401
assert client.get("/api/info", headers=H).status_code == 200
assert client.get("/api/info", headers={**H, "Host": "evil.example.com"}).status_code == 403  # DNS rebinding
assert client.get("/api/info?token=" + TOKEN).status_code == 200
for url, headers in [("/ws", WS), ("/ws?token=wrong", WS), (f"/ws?token={TOKEN}", {**WS, "Origin": "http://evil.example.com"}), (f"/ws?token={TOKEN}", {})]:
    try:
        with client.websocket_connect(url, headers=headers) as ws:
            ws.receive_json()
        raise AssertionError(f"{url} {headers} was accepted")
    except WebSocketDisconnect:
        pass
r = client.get("/")
assert r.status_code == 200 and r.headers["cache-control"] == "no-store" and "default-src 'self'" in r.headers["content-security-policy"]

# ---------- a chat turn streams events in order ----------
with client.websocket_connect(f"/ws?token={TOKEN}", headers=WS) as ws:
    hello = ws.receive_json()
    assert hello["type"] == "hello" and hello["demo"] is True and hello["info"]["model"] == "claude-opus-5-5" and hello["info"]["permissions"] == "ask"
    ws.send_json({"type": "send", "text": "hello"})
    ev = collect(ws, "done")
    t = types(ev)
    assert t[0] == "status" and ev[0]["running"] is True and t.count("text_delta") > 5 and "usage" in t and t[-2:] == ["status", "done"]
    assert "".join(e["text"] for e in ev if e["type"] == "text_delta").startswith("Hello! I'm the **demo model**")
    u = next(e for e in ev if e["type"] == "usage")
    assert u["cost"] is not None and u["cost"] > 0 and u["total"]["complete"] is True and u["usage"]["input"] > 0
    assert ev[-1]["stop_reason"] == "end_turn" and not ev[-1]["error"] and ev[-1]["info"]["turns"] == 1

    # a write is a card plus a file_change, and it is safe inside the project (no question)
    ws.send_json({"type": "send", "text": "create a file"})
    ev = collect(ws, "done"); t = types(ev)
    assert "permission_request" not in t and t.index("tool_call") < t.index("file_change") < t.index("tool_result")
    call = next(e for e in ev if e["type"] == "tool_call"); assert call["name"] == "write_file" and call["input"]["path"] == "demo.py" and call["display"].startswith("write_file(demo.py")
    fc = next(e for e in ev if e["type"] == "file_change"); assert fc["path"] == "demo.py" and fc["before"] is None and "def greet" in fc["after"]
    assert (project / "demo.py").exists()
    changes = client.get("/api/changes", headers=H).json(); assert changes[0]["path"] == "demo.py" and changes[0]["before"] is None and "def greet" in changes[0]["after"]

    # a search gives the browser structured sources (the file just written is already in the index); a reload keeps them
    ws.send_json({"type": "send", "text": "search"})
    ev = collect(ws, "done"); t = types(ev)
    res = next(e for e in ev if e["type"] == "tool_result")
    assert res["name"] == "search_docs" and not res["is_error"] and res["outcome"].endswith(("passage", "passages")), res
    src = res["sources"][0]; assert src["path"] == "demo.py" and src["start_line"] == 1 and "def greet" in src["snippet"] and src["score"] >= 0
    assert all(s["path"] != ".env" for s in res["sources"]) and "sk-live" not in str(res)
    items = client.get(f"/api/session/{ctl.session.id}", headers=H).json()["items"]
    assert next(i for i in items if i["kind"] == "tool" and i["id"] == res["id"])["sources"] == res["sources"]
    assert all("sources" not in b for m in ctl.session.messages if isinstance(m["content"], list) for b in m["content"] if isinstance(b, dict))
    ws.send_json({"type": "index", "rebuild": True})
    ev = collect(ws, "info")
    notice = next(e for e in ev if e["type"] == "notice")
    assert notice["text"].startswith("Index updated:") and "Graph:" in notice["text"] and ev[-1]["info"]["index"]["files"] >= 2

    # the graph: a demo lookup gives the browser the neighbourhood, the REST lookup is the same, and a reload keeps it
    (project / "notes.md").write_text("# Demo folder\n\nThe `greet` function says hello.\n")  # the demo looks up this heading
    rag.get(project).sync()  # written by the test itself, inside the index's 2-second re-check window
    ws.send_json({"type": "send", "text": "graph"})
    ev = collect(ws, "done")
    res = next(e for e in ev if e["type"] == "tool_result")
    assert res["name"] == "explore_graph" and not res["is_error"] and res["outcome"] == "2 links", res
    assert res["graph"]["center"]["name"] == "Demo folder" and {e["relation"] for e in res["graph"]["edges"]} == {"contains", "mentions"}
    g = client.get("/api/graph", params={"name": "greet"}, headers=H).json()["graph"]
    assert g["center"]["name"] == "demo.greet" and any(e["relation"] == "mentions" and e["path"] == "notes.md" for e in g["edges"])
    assert client.get("/api/graph", params={"name": "zebra"}, headers=H).json()["graph"] is None
    assert client.get("/api/graph", params={"name": "x", "depth": 9}, headers=H).status_code == 422
    assert client.get("/api/graph", params={"name": "greet"}).status_code == 401
    st = client.get("/api/index", headers=H).json(); assert st["available"] and st["entities"] > 0 and "embed_installed" in st
    items = client.get(f"/api/session/{ctl.session.id}", headers=H).json()["items"]
    assert next(i for i in items if i["kind"] == "tool" and i["id"] == res["id"])["graph"] == res["graph"]

    # a model-read graph: first the estimate (nothing sent), then the build, whose cost lands in the session
    ws.send_json({"type": "graph_estimate"})
    est = collect(ws, "graph_estimate")[-1]
    assert est["passages"] >= 1 and est["model"] == "claude-haiku-5-5" and est["cost"] > 0 and est["prose_only"] is True
    cost0 = ctl.session.totals["cost_usd"]
    ws.send_json({"type": "graph_build"})
    ev = collect(ws, "done")
    assert any(e["type"] == "notice" and e["text"].startswith("Graph built:") for e in ev) and not ev[-1]["error"], ev[-1]
    assert ctl.session.totals["cost_usd"] > cost0
    g = client.get("/api/graph", params={"name": "Demo mode"}, headers=H).json()["graph"]
    assert g["center"]["kind"] == "component" and g["edges"][0]["relation"] == "works_in"

    # a delete asks, with the exact command; deny keeps the file, allow removes it
    ws.send_json({"type": "send", "text": "delete it"})
    ev = collect(ws, "permission_request"); req = ev[-1]
    assert req["title"] == "Run a command?" and any("rm demo.py" in l for l in req["display"]) and any("rm is not on the read-only list" in r for r in req["reasons"])
    assert req["hidden_explanation"] is None
    call = next(e for e in reversed(ev) if e["type"] == "tool_call"); assert req["tool_id"] == call["id"]  # the question names its call
    ws.send_json({"type": "answer_permission", "id": req["id"], "allow": False})
    ev = collect(ws, "done")
    assert (project / "demo.py").exists() and any(e["type"] == "tool_result" and e["is_error"] and "declined" in e["text"] for e in ev)
    res = next(e for e in ev if e["type"] == "tool_result"); assert res["id"] == call["id"] and res["approval"] == {"by": "user", "allowed": False}
    ws.send_json({"type": "send", "text": "delete it"})
    req = collect(ws, "permission_request")[-1]
    ws.send_json({"type": "answer_permission", "id": req["id"], "allow": True})
    ev = collect(ws, "done")
    res = next(e for e in ev if e["type"] == "tool_result"); assert res["approval"] == {"by": "user", "allowed": True} and res["outcome"] == "exit 0"
    assert not (project / "demo.py").exists()
    # a garbage answer is not a yes
    ws.send_json({"type": "send", "text": "create a file"}); collect(ws, "done")
    ws.send_json({"type": "send", "text": "delete it"})
    req = collect(ws, "permission_request")[-1]
    ws.send_json({"type": "answer_permission", "id": req["id"], "allow": "yes"})
    collect(ws, "done"); assert (project / "demo.py").exists()

    # secrets always ask, and the dialog says so
    ws.send_json({"type": "send", "text": "show me the secret"})
    req = collect(ws, "permission_request")[-1]; assert any("secrets" in r for r in req["reasons"])
    ws.send_json({"type": "answer_permission", "id": req["id"], "allow": False}); ev = collect(ws, "done")
    assert not any("sk-live" in str(e) for e in ev)

    # ask_user: choices come to the browser and the answer comes back
    ws.send_json({"type": "send", "text": "ask me to choose"})
    ask = collect(ws, "ask_user")[-1]; assert ask["question"] == "Python or Go?" and ask["choices"] == ["Python", "Go"]
    ws.send_json({"type": "answer_ask", "id": ask["id"], "answer": "Go"})
    ev = collect(ws, "done"); assert "**Go**" in "".join(e["text"] for e in ev if e["type"] == "text_delta")

    # parallel subagents: one group id, structured steps instead of [n]↳ notices, and a short outcome on each row
    ws.send_json({"type": "send", "text": "helpers"})
    ev = collect(ws, "done"); calls = [e for e in ev if e["type"] == "tool_call" and e["name"] == "subagent"]
    assert len(calls) == 3 and {c["parallel_group"] for c in calls} == {calls[0]["id"]}
    fins = [e for e in ev if e["type"] == "subagent_finish"]
    assert sorted(f["index"] for f in fins) == [1, 2, 3] and {f["parent_id"] for f in fins} == {c["id"] for c in calls}
    assert not any(e["type"] == "notice" and "subagent finished" in e["text"] for e in ev)
    ws.send_json({"type": "send", "text": "list the files"})
    res = next(e for e in collect(ws, "done") if e["type"] == "tool_result"); assert res["outcome"].endswith("files") and res["approval"] is None and res["mcp"] is False

    # a goal reports its progress as events: start, rounds, statuses (the demo never claims done, so it stops at the limit)
    ws.send_json({"type": "goal", "text": "tidy up", "verify": "true", "max_turns": 2})
    ev = collect(ws, "done"); t = types(ev)
    start = next(e for e in ev if e["type"] == "goal_start"); assert start["text"] == "tidy up" and start["verify"] == "true" and start["max_turns"] == 2
    assert [e["n"] for e in ev if e["type"] == "goal_round"][:2] == [1, 2] and "goal_status" in t
    assert not any(e["type"] == "notice" and e["text"].startswith("goal round") for e in ev) and ev[-1]["text"].startswith("GOAL NOT DONE")

    # settings
    ws.send_json({"type": "set_permissions", "mode": "judge"}); assert collect(ws, "info")[-1]["info"]["permissions"] == "judge"
    ws.send_json({"type": "set_permissions", "mode": "nope"}); assert "Unknown mode" in collect(ws, "error")[-1]["message"]; collect(ws, "info")  # (the info that follows)
    ws.send_json({"type": "set_effort", "effort": "low"}); assert collect(ws, "info")[-1]["info"]["effort"] == "low"
    ws.send_json({"type": "set_limit", "limit": 60000}); assert collect(ws, "info")[-1]["info"]["limit"] == 60000
    ws.send_json({"type": "set_permissions", "mode": "ask"}); collect(ws, "info")
    ws.send_json({"type": "bogus"}); assert "Unknown request" in collect(ws, "error")[-1]["message"]
    ws.send_json({"type": "send", "text": "   "}); assert "Type something" in collect(ws, "error")[-1]["message"]

    # the transcript of this session, as the UI draws it
    sid = ctl.session.id
    items = client.get(f"/api/session/{sid}", headers=H).json()["items"]
    kinds = [i["kind"] for i in items]
    assert kinds[0] == "user" and items[0]["text"] == "hello" and "tool" in kinds and "assistant" in kinds
    tool = next(i for i in items if i["kind"] == "tool" and i["name"] == "write_file"); assert tool["result"].startswith("Created") and tool["outcome"] == "new file"
    assert client.get("/api/session/nope", headers=H).status_code == 404
    listed = client.get("/api/sessions", headers=H).json(); assert listed[0]["current"] and listed[0]["title"] == "hello" and listed[0]["cost"] > 0

    # new session, then resume the first one
    ws.send_json({"type": "new_session"}); loaded = collect(ws, "session_loaded")[-1]
    assert loaded["items"] == [] and loaded["info"]["session_id"] != sid
    ws.send_json({"type": "resume", "ref": sid[:8]}); loaded = collect(ws, "session_loaded")[-1]
    assert loaded["info"]["session_id"] == sid and loaded["items"][0]["text"] == "hello"

# ---------- Stop ----------
ctl2, ui2, client2 = make(delay=0.02)
(project / "demo.py").unlink(missing_ok=True)
with client2.websocket_connect(f"/ws?token={TOKEN}", headers=WS) as ws:
    ws.receive_json()
    ws.send_json({"type": "send", "text": "long"})
    first = collect(ws, "text_delta")
    ws.send_json({"type": "cancel"})
    ev = collect(ws, "done")
    assert ev[-1]["interrupted"] is True and ctl2.session.messages == []  # rolled back like Ctrl-C
    ws.send_json({"type": "send", "text": "hello"}); assert collect(ws, "done")[-1]["interrupted"] is False  # and it works again
    # Stop while a question is open
    ws.send_json({"type": "send", "text": "delete it"})
    ws.send_json({"type": "send", "text": "delete it"})  # (ignored: busy) ...
    (project / "demo.py").write_text("x")
    ws.send_json({"type": "cancel"})
    ev = collect(ws, "done")
    # a second send while busy is refused
    ws.send_json({"type": "send", "text": "long"}); collect(ws, "text_delta")
    ws.send_json({"type": "send", "text": "hello"}); assert "already running" in collect(ws, "error")[-1]["message"]
    ws.send_json({"type": "cancel"}); collect(ws, "done")

# ---------- a refresh mid-run catches up, and a pending question survives it ----------
ctl3, ui3, client3 = make(delay=0.0)
(project / "demo.py").write_text("x")
with client3.websocket_connect(f"/ws?token={TOKEN}", headers=WS) as ws:
    ws.receive_json(); ws.send_json({"type": "send", "text": "delete it"}); req = collect(ws, "permission_request")[-1]
with client3.websocket_connect(f"/ws?token={TOKEN}", headers=WS) as ws2:  # the page was refreshed
    hello = ws2.receive_json(); assert hello["type"] == "hello" and hello["running"] is True
    again = ws2.receive_json(); assert again["type"] == "permission_request" and again["id"] == req["id"]
    ws2.send_json({"type": "answer_permission", "id": req["id"], "allow": False}); collect(ws2, "done")

# ---------- reasoning, plan mode and attachments ----------
ctl4, ui4, client4 = make(delay=0.0)
(project / "demo.py").unlink(missing_ok=True)
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 20
up = lambda data, name, kind, headers=H: client4.post("/api/attachments", content=data, headers={**headers, "X-Filename": name, "Content-Type": kind})
assert up(PNG, "shot.png", "image/png", headers={}).status_code == 401  # the token is needed here too
r = up(b"PK\x03\x04", "report.docx", "application/octet-stream"); assert r.status_code == 400 and "Save it as PDF" in r.json()["detail"]
big = up(b"x" * (webserver.MAX_UPLOAD_BYTES + 1), "big.txt", "text/plain"); assert big.status_code == 413
shot = up(PNG, "my%20shot.png", "image/png").json(); assert shot["name"] == "my shot.png" and shot["kind"] == "image" and shot["size"] == len(PNG)
with client4.websocket_connect(f"/ws?token={TOKEN}", headers=WS) as ws:
    assert ws.receive_json()["info"]["plan"] is False
    # the model's reasoning streams as its own events, before the reply
    ws.send_json({"type": "send", "text": "hello"}); ev = collect(ws, "done"); t = types(ev)
    assert "thinking_delta" in t and t.index("thinking_delta") < t.index("text_delta")
    assert "".join(e["text"] for e in ev if e["type"] == "thinking_delta").startswith("A greeting.")
    # a message with only a file; the file is gone from the server once sent
    ws.send_json({"type": "send", "text": "", "attachments": [shot["id"]]}); ev = collect(ws, "done")
    assert "`my shot.png`" in "".join(e["text"] for e in ev if e["type"] == "text_delta") and ui4.uploads == {}
    ws.send_json({"type": "send", "text": "again", "attachments": [shot["id"]]}); assert "no longer on the server" in collect(ws, "error")[-1]["message"]
    items = client4.get(f"/api/session/{ctl4.session.id}", headers=H).json()["items"]
    sent = [i for i in items if i["kind"] == "user"][1]; assert sent["attachments"] == [{"name": "my shot.png", "kind": "image"}] and "iVBOR" not in str(items)
    assert any(i["kind"] == "thinking" for i in items)
    # plan mode: on, a plan comes to the browser, "keep planning" sends feedback, approval turns it off and the work is done
    ws.send_json({"type": "set_plan", "on": True}); assert "Plan mode is on" in collect(ws, "notice")[-1]["text"]
    assert collect(ws, "info")[-1]["info"]["plan"] is True
    ws.send_json({"type": "goal", "text": "x"}); assert "Plan mode is on" in collect(ws, "done")[-1]["error"]
    ws.send_json({"type": "send", "text": "plan a greeting module"})
    req = collect(ws, "plan_request")[-1]; assert "Plan: add a greeting module" in req["plan"]
    ws.send_json({"type": "answer_plan", "id": req["id"], "approve": False, "feedback": "call it hello.py"})
    req = collect(ws, "plan_request")[-1]; assert not (project / "demo.py").exists()
    ws.send_json({"type": "answer_plan", "id": req["id"], "approve": "yes"})  # a garbage answer is not an approval
    req = collect(ws, "plan_request")[-1]
    ws.send_json({"type": "answer_plan", "id": req["id"], "approve": True})
    ev = collect(ws, "done"); t = types(ev)
    assert {"type": "plan_mode", "on": False} in ev and ev[-1]["info"]["plan"] is False and (project / "demo.py").exists()
    res = [e for e in ev if e["type"] == "tool_result" and e["name"] == "exit_plan_mode"]; assert res[-1]["outcome"] == "approved"
    # /clear is a new session: uploads waiting on the server are dropped too
    waiting = up(b"note\n", "n.txt", "text/plain").json(); assert waiting["kind"] == "text" and len(ui4.uploads) == 1
    ws.send_json({"type": "new_session"}); collect(ws, "session_loaded"); assert ui4.uploads == {}
# a plan mode write in a fresh session is refused, with the reason the model needs
ctl4.set_plan(True)
assert "plan mode is on" in ctl4.permissions.decide("write_file", {"path": "x.txt", "content": "x"}).message
assert ctl4.session.notes[-1].startswith("Plan mode is on")

# ---------- files: tree, viewer, and what is never served ----------
tree = client.get("/api/files", headers=H).json()
names = {e["name"]: e for e in tree["tree"]}
assert ".git" not in names and names[".env"]["secret"] is True and names["app.py"]["secret"] is False and names["sub"]["children"][0]["name"] == "notes.txt"
ok = client.get("/api/file", params={"path": "app.py"}, headers=H).json(); assert ok["content"] == "print('hi')\n" and ok["binary"] is False
assert client.get("/api/file", params={"path": "sub/notes.txt"}, headers=H).json()["content"] == "notes\n"
for bad in [".env", "../etc/passwd", "/etc/hosts", "link", ".git/config", "sub/../.env", "sub"]:
    r = client.get("/api/file", params={"path": bad}, headers=H)
    assert r.status_code in (403, 404), (bad, r.status_code)
    assert "sk-live" not in r.text and "pw@example" not in r.text, bad
(project / "bin.dat").write_bytes(b"\x00\x01\xff\xfe"); assert client.get("/api/file", params={"path": "bin.dat"}, headers=H).json()["binary"] is True
(project / "evil.txt").write_text("a‮b\x1b[2Jc\r\nd"); shown = client.get("/api/file", params={"path": "evil.txt"}, headers=H).json()["content"]
assert "‮" not in shown and "\x1b" not in shown and "⟨U+202E" in shown and "⟨ESC⟩" in shown and "\r" not in shown

# ---------- tool input shown to the browser is made printable ----------
assert webserver.clean({"command": "echo \x1b[2J" + "x" * 5000})["command"].startswith("echo ⟨ESC⟩[2J") and "more characters" in webserver.clean("y" * 5000)
assert webserver.clean(["a​b"]) == ["a⟨U+200B ZERO WIDTH SPACE⟩b"]

# ---------- a refresh whose old socket closes after the new one opens still gets events ----------
ctl5, ui5, client5 = make(delay=0.0)
old = client5.websocket_connect(f"/ws?token={TOKEN}", headers=WS); old.__enter__(); old.receive_json()
new = client5.websocket_connect(f"/ws?token={TOKEN}", headers=WS); new.__enter__(); new.receive_json()
old.__exit__(None, None, None)  # the old page's close arrives late
new.send_json({"type": "send", "text": "hello"}); assert "done" in types(collect(new, "done"))
new.__exit__(None, None, None)

# ---------- context data and the engine hooks ----------
data = client.get("/api/context", headers=H).json()
assert data["total"] > 0 and "Tool definitions" in data["rows"] and data["limit"] == 60000
print("ok")
