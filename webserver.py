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
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

import safety
import sessionlog
import tools
from controller import Controller, UI

MAX_FILE_BYTES = 400_000
MAX_TREE_ENTRIES = 5000
MAX_STRING = 4000  # long strings in tool input are cut for display (the whole content is in the file change)
DIST = Path(__file__).resolve().parent / "ui" / "dist"
HIDDEN_DIRS = {".git"} | tools.SKIP_DIRS


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

    # --- connection ---

    def attach(self, loop, queue):
        with self.lock:
            self.loop, self.queue = loop, queue

    def detach(self):
        with self.lock:
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

    def tool_call(self, call_id, name, args, display):
        self.emit("tool_call", id=call_id, name=name, input=clean(args), display=safety.visible(display, limit=300))

    def tool_result(self, call_id, name, text, is_error):
        self.emit("tool_result", id=call_id, name=name, text=clean(text, tools.MAX_TOOL_OUTPUT), is_error=bool(is_error))

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
        request = {"type": "permission_request", "id": secrets.token_hex(6), "title": assessment.title,
                   "display": [safety.printable(l) for l in assessment.display.split("\n")],
                   "findings": [f.text for f in assessment.findings], "reasons": [text for _, text in assessment.reasons],
                   "note": note, "kind": assessment.kind}
        return self._ask(request) is True  # only an explicit true allows

    def ask_user(self, question, choices):
        answer = self._ask({"type": "ask_user", "id": secrets.token_hex(6), "question": safety.printable(question),
                            "choices": [safety.printable(c) for c in choices]})
        return answer if isinstance(answer, str) else None

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


def build_tree(root):
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
            if p.is_dir():
                out.append({"name": p.name, "path": rel, "type": "dir", "children": walk(p, depth + 1) if depth < 8 else []})
            else:
                out.append({"name": p.name, "path": rel, "type": "file", "secret": safety.is_secret(p), "size": p.stat().st_size})
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
        if session_id == controller.session.id:
            messages = controller.session.messages
        else:
            events, _ = sessionlog.load(path)
            messages = sessionlog.replay(events)["messages"]
        return clean(sessionlog.render_messages(messages), 20000)

    @app.get("/api/session/{session_id}")
    def session_transcript(session_id: str):
        return {"id": session_id, "items": transcript_for(session_id)}

    @app.get("/api/files")
    def files():
        root = Path.cwd().resolve()
        return {"root": str(root), "name": root.name, "tree": build_tree(root)}

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

    def do_send(text):
        finish(controller.send(text))

    def do_goal(text, verify, max_turns):
        finish(controller.goal(text, verify, max_turns))

    def do_compact(focus):
        try:
            controller.compact(focus)
        except Exception as e:  # noqa: BLE001
            webui.emit("error", message=str(e))
        webui.emit("info", info=controller.info())

    def load_session():
        webui.changes.clear()
        webui.emit("session_loaded", items=transcript_for(controller.session.id) if controller.session.messages else [], info=controller.info())

    def handle(msg):
        """One message from the browser. Returns nothing; results go back as events."""
        kind = msg.get("type")
        busy = webui.running
        if kind == "send":
            text = msg.get("text")
            if not isinstance(text, str) or not text.strip():
                return webui.emit("error", message="Type something to send.")
            if busy:
                return webui.emit("error", message="A task is already running. Stop it first.")
            run_in_thread(do_send, text)
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
        elif kind in ("set_model", "set_permissions", "set_effort", "set_limit"):
            try:
                if kind == "set_model":
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
            webui.detach()  # a running task carries on; unanswered questions wait for a reconnect or Stop

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
