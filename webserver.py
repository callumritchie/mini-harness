"""The local web UI: a small server that puts the agent in a browser. See DESIGN.md, 'Web UI'.

The server can run commands as you, so it is locked down: it listens on 127.0.0.1 only, every request needs a random token, and the
Host and Origin headers are checked (other web pages and DNS rebinding cannot talk to it). Secret-looking files are never served.
"""
import asyncio
import concurrent.futures
import json
import os
import secrets
import tempfile
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

import attachments
import graph
import rag
import safety
import sessionlog
import tools
from controller import Controller, UI
from session import UserError

MAX_FILE_BYTES = 400_000
MAX_TREE_ENTRIES = 5000
MAX_STRING = 4000  # long strings in tool input are cut for display (the whole content is in the file change)
MAX_UPLOAD_BYTES = max(attachments.MAX_IMAGE_BYTES, attachments.MAX_PDF_BYTES, attachments.MAX_TEXT_CHARS * 4)
MAX_PENDING_UPLOAD_BYTES = 60_000_000  # uploaded files waiting to be sent, in all
DIST = Path(__file__).resolve().parent / "ui" / "dist"
HIDDEN_DIRS = {".git"} | tools.SKIP_DIRS
INDEX_WATCH_IDLE, INDEX_WATCH_BUSY = 2.0, 0.5  # seconds between looks at the index's status (watch_index)


# ---------- making things safe to show ----------

def clean(value, limit=MAX_STRING):
    """Strings made printable (control and invisible characters become visible markers) and cut; recursively for lists and dicts."""
    if isinstance(value, str):
        text = safety.printable(value)
        return text if len(text) <= limit else text[:limit] + f"… [{len(text) - limit} more characters]"
    if isinstance(value, list):
        return [clean(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: clean(v, limit) for k, v in value.items()}
    return value


def file_text(text):
    """File contents for the viewer and diffs: invisible and control characters shown as markers, CRLF treated as newlines."""
    return None if text is None else safety.printable(text.replace("\r\n", "\n"))[:MAX_FILE_BYTES]


# ---------- the UI the controller talks to ----------

HIDDEN_EXPLANATION = ("This action contains characters you can't normally see. They are shown as markers like ⟨U+202E⟩; "
                      "they can make text look different from what actually runs.")


def ui_title(title):
    """The policy's title ("run a command") as the dialog's question ("Run a command?")."""
    title = title.strip()
    if not title:
        return title
    title = title[0].upper() + title[1:]
    return title if title[-1] in "?.!" else title + "?"


class WebUI(UI):
    """Turns what the agent does into JSON events for the browser, and the browser's answers back into return values.
    The agent runs in a worker thread; events are handed to the asyncio loop thread-safely."""

    def __init__(self):
        self.lock = threading.Lock()
        self.loop = None
        self.queue = None
        self.pending = {}  # question id -> (concurrent Future, the request event)
        self.changes = {}  # path -> {"before": first before, "after": latest after}
        self.running = False
        self.controller = None
        self.calls = {}  # call id -> (name, args): what a result needs to describe itself
        self.groups = {}  # call id -> the parallel group it belongs to (the first call's id)
        self.uploads = {}  # attachment id -> attachments.Attachment, uploaded and waiting to be sent with a message
        self.index_watch = False  # the page asked for index_status events (watch_index)
        self.index_thread = None
        self.index_sent = None  # the last status sent, so only changes are sent

    def upload(self, item):
        """Keep an uploaded file until a message takes it. Returns its id, or raises UserError when too much is waiting."""
        with self.lock:
            if sum(a.size for a in self.uploads.values()) + item.size > MAX_PENDING_UPLOAD_BYTES:
                raise UserError("Too many files are waiting to be sent. Send or remove some first.")
            uid = secrets.token_hex(8)
            self.uploads[uid] = item
        return uid

    def take_uploads(self, ids):
        """The files for a message, in order; they are forgotten once taken. Raises UserError for an id that is not waiting."""
        with self.lock:
            missing = [i for i in ids if i not in self.uploads]
            if missing:
                raise UserError("An attached file is no longer on the server (it may have been sent already). Attach it again.")
            return [self.uploads.pop(i) for i in ids]

    # --- connection ---

    def attach(self, loop, queue):
        with self.lock:
            self.loop, self.queue = loop, queue
            self.index_sent = None  # a new page has seen nothing yet

    def watch_index(self, on):
        """While the page asks for it, send `index_status` whenever the index's status changes: background syncs, writes, vectors
        being made, the graph being built. Polled (it is a few counts) rather than hooked into every place that changes it.
        Off unless asked, so the event stream of a page (or a test) that does not watch stays as it was."""
        with self.lock:
            self.index_watch = on
            self.index_sent = None
            start = on and self.index_thread is None
            if start:
                self.index_thread = threading.Thread(target=self._watch_loop, daemon=True)
        if start:
            self.index_thread.start()
        if on and self.controller is not None:  # the current status at once, then only changes
            self.index_sent = self.controller.index_status()
            self.emit("index_status", status=clean(self.index_sent, 1000))

    def _watch_loop(self):
        busy = False
        while True:  # one thread for the server's life; it only looks while a page is watching
            time.sleep(INDEX_WATCH_BUSY if busy else INDEX_WATCH_IDLE)
            if not self.index_watch or self.loop is None or self.controller is None:
                continue
            try:
                status = self.controller.index_status()
            except Exception:  # noqa: BLE001 - rag.status never raises; anything else must not end the watch
                continue
            busy = bool(status.get("building") or status.get("embedding") or status.get("graph_building"))
            if status != self.index_sent:
                self.index_sent = status
                self.emit("index_status", status=clean(status, 1000))

    def detach(self, queue):
        """Stop sending to this page, unless a newer one has taken over (a refresh opens the new socket before the old one closes)."""
        with self.lock:
            if self.queue is queue:
                self.loop = self.queue = None

    def emit(self, type_, **data):
        event = {"type": type_, **data}
        with self.lock:
            loop, queue = self.loop, self.queue
        if loop is not None:
            loop.call_soon_threadsafe(queue.put_nowait, event)

    # --- the UI interface ---

    def text(self, delta):
        self.emit("text_delta", text=safety.printable(delta))

    def thinking(self, delta):
        self.emit("thinking_delta", text=safety.printable(delta))

    def parallel(self, call_ids):
        with self.lock:
            for cid in call_ids:
                self.groups[cid] = call_ids[0]

    def tool_call(self, call_id, name, args, display):
        with self.lock:
            self.calls[call_id] = (name, args)
            group = self.groups.get(call_id)
        self.emit("tool_call", id=call_id, name=name, input=clean(args), display=safety.visible(display, limit=300), parallel_group=group)

    def tool_result(self, call_id, name, text, is_error, meta=None):
        with self.lock:
            _, args = self.calls.pop(call_id, (name, {}))
            self.groups.pop(call_id, None)
        ctl = self.controller
        approval = ctl.permissions.approvals.pop(call_id, None) if ctl is not None and getattr(ctl, "permissions", None) else None
        mcp = bool(ctl is not None and ctl.mcp is not None and ctl.mcp.owns(name))
        self.emit("tool_result", id=call_id, name=name, text=clean(text, tools.MAX_TOOL_OUTPUT), is_error=bool(is_error),
                  outcome=tools.outcome(name, args, text, is_error), approval=approval, mcp=mcp,
                  **{k: clean(v, MAX_STRING) for k, v in (meta or {}).items() if k in tools.META_KEYS})

    def event(self, kind, data, text):
        """Goal and subagent progress as structured events (the browser builds its cards from them); the text is not sent."""
        self.emit(kind, **{k: clean(v, 1000) if isinstance(v, str) else v for k, v in data.items()})

    def usage(self, usage, cost, summary):
        usd, complete, note = summary
        self.emit("usage", usage=usage, cost=cost, total={"usd": usd, "complete": complete, "note": note})

    def notice(self, text):
        self.emit("notice", text=clean(text.strip(), 1000))

    def change(self, path, before, after):
        with self.lock:
            entry = self.changes.setdefault(path, {"before": before, "after": None})
            entry["after"] = after
        self.emit("file_change", path=path, before=file_text(before), after=file_text(after))

    def status(self, running):
        self.running = running
        self.emit("status", running=running)

    def _ask(self, request):
        """Send a question and block this worker thread until the browser answers (or Stop is pressed). Returns the answer."""
        fut = concurrent.futures.Future()
        with self.lock:
            self.pending[request["id"]] = (fut, request)
        self.emit(request["type"], **{k: v for k, v in request.items() if k != "type"})
        try:
            while True:
                try:
                    return fut.result(timeout=0.2)
                except concurrent.futures.TimeoutError:
                    if self.controller is not None and self.controller.cancel.is_set():
                        raise tools.Interrupted()
        finally:
            with self.lock:
                self.pending.pop(request["id"], None)
            self.emit("question_closed", id=request["id"])

    def ask_permission(self, assessment, note):
        request = {"type": "permission_request", "id": secrets.token_hex(6), "title": ui_title(assessment.title),
                   "display": [safety.printable(l) for l in assessment.display.split("\n")],
                   "findings": [f.text for f in assessment.findings], "reasons": [text for _, text in assessment.reasons],
                   "note": note, "kind": assessment.kind, "tool_id": getattr(assessment, "call_id", None),
                   "hidden_explanation": HIDDEN_EXPLANATION if assessment.findings else None}
        return self._ask(request) is True  # only an explicit true allows

    def ask_user(self, question, choices):
        answer = self._ask({"type": "ask_user", "id": secrets.token_hex(6), "question": safety.printable(question),
                            "choices": [safety.printable(c) for c in choices]})
        return answer if isinstance(answer, str) else None

    def approve_plan(self, plan):
        answer = self._ask({"type": "plan_request", "id": secrets.token_hex(6), "plan": clean(plan, 20000)})
        if not isinstance(answer, dict):
            return None
        if answer.get("approve") is True:  # only an explicit true approves
            return "approve", None
        feedback = answer.get("feedback")
        return "revise", feedback if isinstance(feedback, str) else ""

    def answer(self, qid, value):
        with self.lock:
            entry = self.pending.get(qid)
        if entry and not entry[0].done():
            entry[0].set_result(value)
            return True
        return False

    def pending_events(self):
        with self.lock:
            return [req for _, req in self.pending.values()]


# ---------- the app ----------

def project_path(controller, raw):
    """Resolve a path the browser asked for. Returns (absolute path, error message or None). Refuses anything outside the project,
    inside .git, or secret-looking (the same rules as the agent's own safety policy)."""
    root = Path.cwd().resolve()
    p = (root / raw).resolve()
    if p != root and root not in p.parents:
        return p, "that path is outside the project folder"
    rel_parts = p.relative_to(root).parts
    if any(part == ".git" for part in rel_parts):
        return p, "the inside of the git repository is not shown"
    if safety.is_secret(p):
        return p, "this file looks like it holds secrets (keys, passwords or credentials), so it is never shown"
    return p, None


def index_coverage(root):
    """What the document index holds, for marking the Files tree; None when there is no index to ask."""
    if not rag.available():
        return None
    try:
        return rag.get(root).coverage()
    except Exception:  # noqa: BLE001 - the tree must show even when the index cannot be read
        return None


def index_state(rel, coverage):
    """How the agent's search sees one file: "in", a rag.SKIP_REASONS key, "capped" (past the file limit) or "pending" (not
    looked at yet: new since the last update)."""
    if rel in coverage["files"]:
        return "in"
    skipped = coverage["skipped"]
    if rel in skipped:
        return skipped[rel]
    if "" in skipped:  # the whole project (search is off)
        return skipped[""]
    parts = rel.split("/")
    for depth in range(len(parts) - 1, 0, -1):  # a folder left out is recorded once, as "folder/"
        reason = skipped.get("/".join(parts[:depth]) + "/")
        if reason:
            return reason
    return "capped" if coverage["capped"] else "pending"


def build_tree(root, coverage=None, ignored=None):
    """The project's files and folders. With `coverage`, each file says how the agent's search sees it (idx); with `ignored` (a
    function of (relative path, is folder)), what .gitignore leaves out is marked gi, so the Files tab can show it before anything
    is indexed (choosing what to search)."""
    entries = []

    def walk(folder, depth):
        try:
            names = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return []
        out = []
        for p in names:
            if len(entries) >= MAX_TREE_ENTRIES:
                break
            if p.name in HIDDEN_DIRS or p.is_symlink() and p.resolve() != root and root not in p.resolve().parents:
                continue
            entries.append(1)
            rel = str(p.relative_to(root))
            gi = ignored is not None and ignored(Path(rel).as_posix(), p.is_dir())
            if p.is_dir():
                node = {"name": p.name, "path": rel, "type": "dir", "children": walk(p, depth + 1) if depth < 8 else []}
            else:
                node = {"name": p.name, "path": rel, "type": "file", "secret": safety.is_secret(p), "size": p.stat().st_size}
                if coverage is not None:
                    node["idx"] = "secret" if node["secret"] else index_state(Path(rel).as_posix(), coverage)
            if gi:
                node["gi"] = True
            out.append(node)
        return out

    return walk(root, 0)


def create_app(controller, webui, token, port, dev_origins=()):
    app = FastAPI(title="mini-harness", docs_url=None, redoc_url=None, openapi_url=None)
    webui.controller = controller
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    allowed_origins = {f"http://{h}" for h in allowed_hosts} | set(dev_origins)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.headers.get("host", "") not in allowed_hosts and request.headers.get("host", "") not in {o.split("://", 1)[1] for o in dev_origins}:
            return JSONResponse({"error": "unexpected Host header"}, status_code=403)
        if request.url.path.startswith("/api/"):
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip() or request.query_params.get("token", "")
            if not supplied or not secrets.compare_digest(supplied, token):
                return JSONResponse({"error": "missing or wrong token"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:"
        return response

    # ---------- REST ----------

    @app.get("/api/info")
    def info():
        return controller.info()

    @app.get("/api/sessions")
    def sessions():
        return [{"id": s["id"], "when": s["when"].isoformat(), "title": clean(s["title"], 200), "prompts": s["prompts"], "calls": s["calls"],
                 "cost": s["cost"], "current": s["id"] == controller.session.id} for s in controller.list_sessions()]

    def transcript_for(session_id):
        path = next((s["path"] for s in sessionlog.list_sessions(Path.cwd(), limit=500, include=controller.include_path()) if s["id"] == session_id), None)
        if path is None:
            raise HTTPException(404, "no such session")
        events, _ = sessionlog.load(path)  # also for the current session: the sources a search found are only in the log
        messages = controller.session.messages if session_id == controller.session.id else sessionlog.replay(events)["messages"]
        meta = sessionlog.tool_meta(events)
        items = sessionlog.render_messages(messages)
        for item in items:  # the same short outcome and sources/graph a live tool row gets, so a reloaded page reads the same
            if item.get("kind") == "tool" and item.get("result") is not None:
                item["outcome"] = tools.outcome(item.get("name"), item.get("input") or {}, item["result"], item.get("is_error"))
            if item.get("kind") == "tool" and item.get("id") in meta:
                item.update(meta[item["id"]])
        return clean(items, 20000)

    @app.get("/api/session/{session_id}")
    def session_transcript(session_id: str):
        return {"id": session_id, "items": transcript_for(session_id)}

    @app.get("/api/files")
    def files():
        root = Path.cwd().resolve()
        coverage, ignored = index_coverage(root), None
        if coverage is not None:
            index = rag.get(root)
            sel = index.selection()
            ignored = index.ignore.ignored if (sel or {}).get("gitignore", True) else None
            if not index.allowed():  # nobody has chosen yet: no marks; "not now": nothing is searched
                coverage = {"files": {}, "skipped": {"": "not_chosen"}, "capped": False} if sel else None
        return {"root": str(root), "name": root.name, "tree": build_tree(root, coverage, ignored)}

    @app.get("/api/file")
    def file(path: str = Query(...)):
        p, error = project_path(controller, path)
        if error:
            raise HTTPException(403, error)
        if not p.is_file():
            raise HTTPException(404, "not a file")
        data = p.read_bytes()[: MAX_FILE_BYTES + 1]
        truncated = len(data) > MAX_FILE_BYTES
        try:
            text = data[:MAX_FILE_BYTES].decode("utf-8")
        except UnicodeDecodeError:
            return {"path": path, "binary": True, "size": p.stat().st_size}
        return {"path": path, "binary": False, "size": p.stat().st_size, "truncated": truncated, "content": file_text(text)}

    @app.get("/api/changes")
    def changes():
        with webui.lock:
            return [{"path": k, "before": file_text(v["before"]), "after": file_text(v["after"])} for k, v in webui.changes.items()]

    @app.get("/api/context")
    def context_data():
        return controller.context_data()

    @app.post("/api/attachments")
    async def upload(request: Request):
        """One file, as the raw request body; its name in X-Filename (URI-encoded) and its type in Content-Type. It waits on the
        server until a message is sent with its id."""
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"That file is too large (at most {MAX_UPLOAD_BYTES // 1_000_000} MB).")
        data = await request.body()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"That file is too large (at most {MAX_UPLOAD_BYTES // 1_000_000} MB).")
        name = urllib.parse.unquote(request.headers.get("x-filename", "file"))
        try:
            item = attachments.classify(name, request.headers.get("content-type", ""), data)
            uid = webui.upload(item)
        except UserError as e:
            raise HTTPException(400, str(e))
        return {"id": uid, "name": clean(item.name, 200), "kind": item.kind, "size": item.size}
    @app.get("/api/index")
    def index_status():
        return controller.index_status()

    def searchable_index():
        """The project's index, if the person has chosen to search it (else 409, with why)."""
        if not rag.available():
            raise HTTPException(503, "the index needs SQLite with FTS5")
        index = rag.get(Path.cwd())
        if not index.allowed():
            raise HTTPException(409, "Search is off for this folder: choose what to search first.")
        return index

    @app.get("/api/index/plan")
    def index_plan():
        """What searching this folder would take, by top-level folder, for the first-open question. Names and sizes only."""
        if not rag.available():
            raise HTTPException(503, "the index needs SQLite with FTS5")
        return clean(controller.index_plan(), 1000)

    @app.get("/api/index/chunks")
    def index_chunks(path: str = Query(..., max_length=1000)):
        """How one file is cut: its chunks (lines, heading, whether search by meaning can find it, the names on the map it holds)."""
        p, error = project_path(controller, path)
        if error:
            raise HTTPException(403, error)
        if not rag.available():
            raise HTTPException(503, "the index needs SQLite with FTS5")
        import embed
        rel = p.relative_to(Path.cwd().resolve()).as_posix()
        return clean(rag.get(Path.cwd()).file_chunks(rel, embed.loaded()), MAX_STRING)

    @app.get("/api/graph")
    def graph_view(name: str = Query(..., min_length=1, max_length=200), depth: int = Query(1, ge=1, le=graph.MAX_DEPTH),
                   relation: str = Query(None, max_length=40)):
        """The same lookup as the explore_graph tool, for the Knowledge tab. Read-only; the graph only ever covers the project."""
        index = searchable_index()
        graph.ensure(index)
        return {"graph": clean(graph.explore(index, name, depth, relation or None), MAX_STRING)}

    @app.get("/api/graph/names")
    def graph_names(q: str = Query(..., min_length=1, max_length=200)):
        """Names in the graph that match what is typed so far, for the lookup box."""
        return {"names": clean(graph.suggest(searchable_index(), q), 300)}

    @app.get("/api/search")
    def search(q: str = Query(..., min_length=1, max_length=500), mode: str = Query("hybrid"),
               path_prefix: str = Query(None, max_length=1000), top_k: int = Query(8, ge=1, le=tools.MAX_SEARCH_RESULTS)):
        """The agent's search_docs, run by the person: the same ranking, over the same files, with nothing sent anywhere."""
        searchable_index()
        if mode not in rag.MODES:
            raise HTTPException(422, f"mode must be one of {', '.join(rag.MODES)}")
        prefix = None
        if path_prefix and path_prefix.strip() not in ("", ".", "./"):
            p, error = project_path(controller, path_prefix)
            if error:
                raise HTTPException(403, error)
            prefix = p.relative_to(Path.cwd().resolve()).as_posix()
            prefix = None if prefix == "." else prefix
        import embed
        index = rag.get(Path.cwd())
        trace = {}
        hits, used = index.query(q, top_k, prefix, mode, embed.loaded(), trace=trace)
        files = index.counts()["files"]
        trace.update(query=q, files=files, building=index.building, shown=len(hits))
        return {"sources": clean(hits, MAX_STRING), "mode": used, "asked": mode, "files": files, "search": clean(trace, 1000)}

    @app.get("/api/index/file")
    def index_file(path: str = Query(..., max_length=1000)):
        """How the agent's search sees one file: indexed (snippets, connections, its name on the map) or why it is left out."""
        p, error = project_path(controller, path)
        if error and not safety.is_secret(p):
            raise HTTPException(403, error)
        rel = p.relative_to(Path.cwd().resolve()).as_posix() if Path.cwd().resolve() in p.parents else path
        coverage = index_coverage(Path.cwd().resolve())
        if coverage is None:
            return {"path": rel, "state": "unavailable"}
        state = "secret" if safety.is_secret(p) else index_state(rel, coverage)
        out = {"path": rel, "state": state}
        if state == "in":
            out["snippets"], out["connections"] = coverage["files"][rel]
            out["entity"] = graph.file_entity(rag.get(Path.cwd()), rel)
        return clean(out, 1000)

    # ---------- WebSocket ----------

    def run_in_thread(fn, *args):
        def go():
            try:
                fn(*args)
            except Exception as e:  # noqa: BLE001 - a bug must reach the person, not kill the thread silently
                webui.emit("error", message=f"{type(e).__name__}: {e}")
        threading.Thread(target=go, daemon=True).start()

    def finish(result):
        webui.emit("done", text=result.text, stop_reason=result.stop_reason, cut_off=result.cut_off, interrupted=result.interrupted,
                   stopped=result.stopped, error=result.error, info=controller.info())

    def do_send(text, files):
        finish(controller.send(text, files))

    def do_goal(text, verify, max_turns):
        finish(controller.goal(text, verify, max_turns))

    def do_compact(focus):
        try:
            controller.compact(focus)
        except Exception as e:  # noqa: BLE001
            webui.emit("error", message=str(e))
        webui.emit("info", info=controller.info())

    def do_index(rebuild, embed_now):
        try:
            webui.emit("notice", text=controller.reindex(rebuild, embed_now))
        except Exception as e:  # noqa: BLE001
            webui.emit("error", message=str(e))
        webui.emit("info", info=controller.info())

    def do_choose(off, excluded, included, gitignore):
        try:
            controller.choose_search(off, excluded, included, gitignore)  # no chat notice: the card goes, the top bar shows the indexing
        except Exception as e:  # noqa: BLE001
            webui.emit("error", message=str(e))
        webui.emit("info", info=controller.info())

    def do_graph_estimate(prose_only, model):
        try:
            webui.emit("graph_estimate", **controller.graph_estimate(prose_only, model), prose_only=prose_only)
        except Exception as e:  # noqa: BLE001
            webui.emit("error", message=str(e))

    def do_graph_build(prose_only, model):
        finish(controller.graph_build(prose_only, model))

    def load_session():
        webui.changes.clear()
        with webui.lock:
            webui.uploads.clear()
        webui.emit("session_loaded", items=transcript_for(controller.session.id) if controller.session.messages else [], info=controller.info())

    def handle(msg):
        """One message from the browser. Returns nothing; results go back as events."""
        kind = msg.get("type")
        busy = webui.running
        if kind == "send":
            text = msg.get("text")
            ids = msg.get("attachments") or []
            if not isinstance(text, str) or not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
                return webui.emit("error", message="Type something to send.")
            if not text.strip() and not ids:
                return webui.emit("error", message="Type something to send.")
            if busy:
                return webui.emit("error", message="A task is already running. Stop it first.")
            try:
                files = webui.take_uploads(ids)
            except UserError as e:
                return webui.emit("error", message=str(e))
            run_in_thread(do_send, text, files)
        elif kind == "goal":
            if busy:
                return webui.emit("error", message="A task is already running. Stop it first.")
            run_in_thread(do_goal, str(msg.get("text", "")), msg.get("verify") or None, msg.get("max_turns") if isinstance(msg.get("max_turns"), int) else None)
        elif kind == "cancel":
            controller.stop()
        elif kind == "answer_permission":
            webui.answer(msg.get("id"), msg.get("allow") is True)
        elif kind == "answer_ask":
            webui.answer(msg.get("id"), msg.get("answer") if isinstance(msg.get("answer"), str) else None)
        elif kind == "answer_plan":
            webui.answer(msg.get("id"), {"approve": msg.get("approve") is True, "feedback": msg.get("feedback") if isinstance(msg.get("feedback"), str) else ""})
        elif kind in ("set_model", "set_permissions", "set_effort", "set_limit", "set_plan"):
            try:
                if kind == "set_plan":
                    webui.emit("notice", text=controller.set_plan(msg.get("on") is True))
                elif kind == "set_model":
                    note = controller.set_model(str(msg.get("model", "")))
                    if note:
                        webui.emit("notice", text=note)
                elif kind == "set_permissions":
                    controller.set_permissions(str(msg.get("mode", "")))
                elif kind == "set_effort":
                    controller.set_effort(msg.get("effort"))
                else:
                    controller.set_limit(msg.get("limit"))
            except Exception as e:  # noqa: BLE001
                webui.emit("error", message=str(e))
            webui.emit("info", info=controller.info())
        elif kind in ("new_session", "resume"):
            if busy:
                return webui.emit("error", message="A task is running. Stop it first.")
            try:
                controller.new_session() if kind == "new_session" else controller.resume(msg.get("ref"))
                load_session()
            except Exception as e:  # noqa: BLE001
                webui.emit("error", message=str(e))
        elif kind == "compact":
            if busy:
                return webui.emit("error", message="A task is running. Stop it first.")
            run_in_thread(do_compact, msg.get("focus") if isinstance(msg.get("focus"), str) else None)
        elif kind == "watch_index":
            webui.watch_index(msg.get("on") is True)
        elif kind == "choose_search":  # the first-open answer, or a change made later in Files
            strs = lambda v: [x for x in v if isinstance(x, str)][:2000] if isinstance(v, list) else []  # noqa: E731
            run_in_thread(do_choose, msg.get("off") is True, strs(msg.get("excluded")), strs(msg.get("included")), msg.get("gitignore") is not False)
        elif kind == "index":  # allowed while a task runs: the index has its own lock, and searches never wait for a sync
            run_in_thread(do_index, msg.get("rebuild") is True, msg.get("embed") is True)
        elif kind in ("graph_estimate", "graph_build"):
            model = msg.get("model") if isinstance(msg.get("model"), str) and msg.get("model") else None
            if kind == "graph_build" and busy:
                return webui.emit("error", message="A task is already running. Stop it first.")
            run_in_thread(do_graph_estimate if kind == "graph_estimate" else do_graph_build, msg.get("prose_only") is not False, model)
        else:
            webui.emit("error", message=f"Unknown request '{kind}'.")

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        origin = websocket.headers.get("origin")
        host = websocket.headers.get("host", "")
        supplied = websocket.query_params.get("token", "")
        bad_host = host not in allowed_hosts and host not in {o.split("://", 1)[1] for o in dev_origins}
        if bad_host or (origin is not None and origin not in allowed_origins) or not supplied or not secrets.compare_digest(supplied, token):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        loop, queue = asyncio.get_running_loop(), asyncio.Queue()
        webui.attach(loop, queue)
        await websocket.send_json({"type": "hello", "info": controller.info(), "running": webui.running, "demo": bool(getattr(controller.args, "demo", False))})
        for req in webui.pending_events():
            await websocket.send_json(req)

        async def sender():
            while True:
                await websocket.send_json(await queue.get())

        send_task = asyncio.create_task(sender())
        try:
            while True:
                raw = await websocket.receive_text()
                if len(raw) > 200_000:
                    webui.emit("error", message="That message is too large.")
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    webui.emit("error", message="That was not valid JSON.")
                    continue
                if isinstance(msg, dict):
                    handle(msg)
        except WebSocketDisconnect:
            pass
        finally:
            send_task.cancel()
            webui.detach(queue)  # a running task carries on; unanswered questions wait for a reconnect or Stop

    # ---------- the built UI ----------

    @app.get("/{path:path}")
    def static(path: str):
        if DIST.is_dir():
            target = (DIST / path).resolve()
            if path and DIST.resolve() in target.parents and target.is_file():
                return FileResponse(target)
            return FileResponse(DIST / "index.html")
        return HTMLResponse(
            "<h1>Mini Harness</h1><p>The web UI has not been built yet. Run <code>cd ui &amp;&amp; npm install &amp;&amp; npm run build</code>, "
            "then restart. (For development: <code>npm run dev</code> in <code>ui/</code>.)</p>", status_code=200)

    return app


# ---------- starting it ----------

def serve(args):
    """Start the server (blocks). Returns an exit code."""
    import uvicorn

    # A fresh random token each launch. MINI_HARNESS_TOKEN pins it for development and the browser tests (never use it for real work).
    token = os.environ.get("MINI_HARNESS_TOKEN") or os.environ.get("MINI_CLAUDE_TOKEN") or secrets.token_urlsafe(24)  # MINI_CLAUDE_* = the old names
    ui = WebUI()
    factory = None
    if getattr(args, "demo", False):
        import demo
        sandbox = Path(tempfile.mkdtemp(prefix="mini-harness-demo-")) / "demo-project"  # the demo works in its own folder, never in yours
        sandbox.mkdir()
        os.chdir(sandbox)
        Path(".env").write_text("DEMO_KEY=not-a-real-secret\n")
        Path("README.md").write_text("# Demo folder\n\nThis is a throwaway folder for `--demo`.\n")
        import agent
        args.model = args.model or agent.DEFAULT_MODELS["anthropic"]
        factory = lambda provider: demo.DemoClient()  # noqa: E731
    controller = Controller(args, ui, client_factory=factory)
    controller.start()
    dev = tuple(o for o in (os.environ.get("MINI_HARNESS_DEV_ORIGINS") or os.environ.get("MINI_CLAUDE_DEV_ORIGINS") or "").split(",") if o)
    app = create_app(controller, ui, token, args.port, dev_origins=dev)
    url = f"http://127.0.0.1:{args.port}/?token={token}"
    print(f"mini-harness web UI for {Path.cwd()}" + ("  [DEMO: scripted model, nothing is real]" if getattr(args, "demo", False) else ""))
    print(f"Open: {url}")
    print("(Only this computer can reach it. Press Ctrl-C to stop.)")
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    except KeyboardInterrupt:
        pass
    return 0
