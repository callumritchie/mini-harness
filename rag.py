"""The project's document index: text files cut into ranges of lines, kept in SQLite with full-text search (FTS5), and searched
by the search_docs tool. Standard library only. See DESIGN.md, 'Document index'.

The index lives outside the project (next to the session logs), is brought up to date incrementally (a file whose stamp and
content are unchanged is never cut again), and never holds a file that looks like it has secrets in it. Every chunk is
content-addressed (`content_sha`), so what is built on top of it later (embeddings, an entity graph) can be cached by chunk
content and version, and a version change here rebuilds the index rather than mixing two ways of cutting.
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from collections import deque
from pathlib import Path, PurePosixPath

import embed
import ignore
import safety
import sessionlog
import tools

SCHEMA_VERSION = "4"  # 2: embeddings and the knowledge graph (graph.py) in the same file; 3: each passage's section heading; 4: stemmed words (skip finds skipped)
CHUNKER_VERSION = "sections-v2"  # bump when the cutting changes: the index is rebuilt (the content-keyed caches are kept)
PROSE = {".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"}
MARKDOWN = {".md", ".mdx", ".markdown"}  # cut at headings, so a section starts its own passage
CHUNK_DEFAULTS = {"code": (60, 10), "prose": (40, 8)}  # (lines per chunk, lines shared with the next one)
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")  # an ATX heading: `## Title`
MAX_MERGED_LINES = 120  # overlapping or touching passages of one file are shown as one, up to this many lines
TEST_WEIGHT = 0.6  # a passage from a test file counts this much in the ranking, unless the search is about tests
TEST_DIRS = {"tests", "test", "__tests__", "e2e", "spec"}
TEST_FILE = re.compile(r"^(test_.+\.py|.+_test\.(py|go)|conftest\.py|.+\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs))$")
TEST_WORDS = {"test", "tests", "spec", "specs", "fixture", "fixtures", "e2e"}
SKIP_DIRS = tools.SKIP_DIRS | {".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".cache", "dist", "build", "coverage"}
MAX_FILE_BYTES = tools.MAX_GREP_FILE_BYTES
MAX_FILES = tools.MAX_SEARCH_FILES
MAX_AVERAGE_LINE = 500  # characters; a file with longer lines on average is minified or generated, not something to read
MAX_SNIPPET_CHARS = 4000  # of a chunk, in the structured sources a front end gets
MAX_TERMS = 32
RESYNC_SECONDS = 2.0  # a search re-checks the files at most this often (parallel helpers searching at once share one check)
BATCH = 200  # files per write transaction
EMBED_BATCH = 16  # passages embedded per step (short steps: progress moves, and nothing waits long behind one)
KEYWORD_WEIGHT = 0.5  # hybrid: a candidate's score is this much its keyword score and the rest its meaning score, each 0-1
MODES = ("hybrid", "keyword", "meaning")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                                 indexed_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
                                  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, content_sha TEXT NOT NULL,
                                  heading TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS chunks_content_sha ON chunks(content_sha);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, path, heading, content='chunks', content_rowid='id',
                                                         tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, path, heading) VALUES (new.id, new.content, new.path, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, path, heading) VALUES ('delete', old.id, old.content, old.path, old.heading);
END;
CREATE TABLE IF NOT EXISTS embeddings(content_sha TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL,
                                      PRIMARY KEY (content_sha, model));
CREATE TABLE IF NOT EXISTS entities(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(name, content='entities', content_rowid='id',
                                                           tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;
CREATE TABLE IF NOT EXISTS extractions(content_sha TEXT NOT NULL, extractor TEXT NOT NULL, payload TEXT NOT NULL,
                                       PRIMARY KEY (content_sha, extractor));
CREATE TABLE IF NOT EXISTS mentions(entity_id INTEGER NOT NULL, chunk_id TEXT NOT NULL, extractor TEXT NOT NULL,
                                    PRIMARY KEY (entity_id, chunk_id, extractor));
CREATE INDEX IF NOT EXISTS mentions_chunk ON mentions(chunk_id);
CREATE TABLE IF NOT EXISTS edges(src INTEGER NOT NULL, dst INTEGER NOT NULL, relation TEXT NOT NULL, chunk_id TEXT NOT NULL,
                                 extractor TEXT NOT NULL, PRIMARY KEY (src, dst, relation, chunk_id, extractor));
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS edges_chunk ON edges(chunk_id);
CREATE TABLE IF NOT EXISTS skipped(path TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_chunks(chunk_id TEXT NOT NULL, extractor TEXT NOT NULL, PRIMARY KEY (chunk_id, extractor));
CREATE TRIGGER IF NOT EXISTS chunks_ad_graph AFTER DELETE ON chunks BEGIN
  DELETE FROM mentions WHERE chunk_id = old.chunk_id;
  DELETE FROM edges WHERE chunk_id = old.chunk_id;
  DELETE FROM graph_chunks WHERE chunk_id = old.chunk_id;
END;
"""
# What a new version throws away: everything derived from how files are cut. Not `embeddings` and `extractions`: they are keyed by
# content (a passage's text, a file's bytes), so they stay right whatever the cutting, and they are the expensive part (minutes of
# embedding; model reads that cost money).
DROP_DERIVED = ("DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files; "
                "DROP TABLE IF EXISTS entities_fts; DROP TABLE IF EXISTS entities; DROP TABLE IF EXISTS mentions; "
                "DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS graph_chunks; DROP TABLE IF EXISTS skipped; "
                "DELETE FROM meta WHERE key IN ('synced_at', 'capped');")

# Why a file in the project is not in the index, in words a person reads (the Files and Knowledge tabs show these).
SKIP_REASONS = {
    "secret": "Looks like it holds secrets",
    "ignored_folder": "In a folder that is never searched (build output, caches)",
    "outside": "A link to somewhere outside the project",
    "too_large": "Over 2 MB",
    "binary": "Not a text file",
    "not_utf8": "Not UTF-8 text",
    "minified": "Minified or generated (very long lines)",
    "unreadable": "Could not be read",
    "not_chosen": "In a folder or file you chose not to search",
    "gitignored": "Left out by the project's .gitignore",
}
# Should an index with no choice saved index on its own? True for the library and headless runs (they index on first use); the
# terminal and the web UI set it False, so a folder is only indexed once the person has chosen what to search (Index.choose).
AUTO = True
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tiff", ".pdf", ".zip", ".gz", ".tgz", ".tar",
                   ".bz2", ".xz", ".7z", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg",
                   ".sqlite", ".db", ".pyc", ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".jar", ".psd", ".sketch", ".fig"}
BYTES_PER_CHUNK = 2800  # roughly, for estimates before anything is cut (60 lines of code, 40 of prose)
MAPPED = {".py"} | MARKDOWN  # what the structure graph reads (graph.py); other files are searchable but not on the map

_fts5 = None


def available():
    """Does this Python's SQLite have FTS5? (Almost every build does; the tool says what to use instead if not.)"""
    global _fts5
    if _fts5 is None:
        try:
            sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")
            _fts5 = True
        except sqlite3.OperationalError:
            _fts5 = False
    return _fts5


def sha256(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def index_path(root):
    """Where a project's index lives: under the same home as the session logs, named the way sessionlog names a project's folder."""
    return sessionlog.home() / "index" / str(Path(root).resolve()).replace("/", "-") / "rag.sqlite"


# ---------- cutting files into chunks ----------

def chunk_lines(text, size, overlap):
    """Windows of `size` lines, each starting `size - overlap` after the last, as (start_line, end_line, text) with 1-based,
    inclusive line numbers. The last window ends at the last line and is never repeated; blank windows are left out."""
    if size < 1 or not 0 <= overlap < size:
        raise ValueError("size must be at least 1 and overlap between 0 and size - 1")
    lines = text.splitlines()
    out, start = [], 0
    while start < len(lines):
        end = min(start + size, len(lines))
        body = "\n".join(lines[start:end])
        if body.strip():
            out.append((start + 1, end, body))
        if end == len(lines):
            break
        start += size - overlap
    return out


def markdown_scan(text):
    """The headings of a Markdown text and the lines that are not prose: ([(line, level, title)], {line numbers in code fences or
    front matter}). Only ATX headings (`## Title`) count; a `#` inside a ``` or ~~~ fence, or in leading YAML front matter, is not
    one. Setext headings (a line underlined with === or ---) are not recognised."""
    lines = text.splitlines()
    headings, code, fenced = [], set(), False
    front = bool(lines) and lines[0].strip() == "---"
    for n, line in enumerate(lines, 1):
        if front:
            code.add(n)
            if n > 1 and line.strip() in ("---", "..."):
                front = False
            continue
        if line.lstrip().startswith(("```", "~~~")):
            code.add(n)
            fenced = not fenced
            continue
        if fenced:
            code.add(n)
            continue
        m = HEADING.match(line)
        if m:
            headings.append((n, len(m.group(1)), m.group(2).strip()))
    return headings, code


def markdown_sections(text):
    """The text as consecutive sections [(start_line, end_line, breadcrumb)], each starting at a heading (and one before the first
    heading if there is text there). The breadcrumb names the section and the ones it sits in: `Web UI › Protocol`."""
    lines = text.splitlines()
    headings, _ = markdown_scan(text)
    if not headings:
        return [(1, len(lines), "")] if lines else []
    out, stack = ([(1, headings[0][0] - 1, "")] if headings[0][0] > 1 else []), []
    for i, (n, level, title) in enumerate(headings):
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        end = headings[i + 1][0] - 1 if i + 1 < len(headings) else len(lines)
        out.append((n, end, " › ".join(t for _, t in stack)))
    return out


def chunk_markdown(text, size, overlap):
    """Passages that start at headings: (start_line, end_line, text, breadcrumb). Whole sections are packed together while the
    passage stays within `size` lines; a longer section is cut into overlapping windows inside itself, never across a heading.
    So a heading always arrives with the text under it."""
    lines = text.splitlines()
    out, pack = [], None  # pack: [start, end, breadcrumb] of sections waiting to become one passage

    def flush():
        if pack:
            body = "\n".join(lines[pack[0] - 1:pack[1]])
            if body.strip():
                out.append((pack[0], pack[1], body, pack[2]))

    for start, end, crumb in markdown_sections(text):
        if end - start + 1 > size:
            flush()
            pack = None
            out += [(start + s - 1, start + e - 1, body, crumb) for s, e, body in chunk_lines("\n".join(lines[start - 1:end]), size, overlap)]
        elif pack and end - pack[0] + 1 <= size:
            pack[1] = end
        else:
            flush()
            pack = [start, end, crumb]
    flush()
    return out


def chunks_for(path, text):
    """A file's passages: (start_line, end_line, text, heading). Markdown is cut at its headings; everything else into windows."""
    suffix = Path(path).suffix.lower()
    size, overlap = CHUNK_DEFAULTS["prose" if suffix in PROSE else "code"]
    if suffix in MARKDOWN:
        return chunk_markdown(text, size, overlap)
    return [(s, e, body, "") for s, e, body in chunk_lines(text, size, overlap)]


def is_test_path(path):
    """Is this a test file (in a tests/ folder, or named like test_x.py, x_test.go, x.test.ts, x.spec.tsx, conftest.py)?"""
    p = PurePosixPath(path)
    return any(part.lower() in TEST_DIRS for part in p.parts[:-1]) or bool(TEST_FILE.match(p.name.lower()))


def query_terms(query):
    """The words of a query, lower-cased, without repeats. Only words are kept, so nothing typed can be FTS5 syntax."""
    seen = []
    for word in "".join(ch if ch.isalnum() or ch == "_" else " " for ch in query.lower()).split():
        if word not in seen:
            seen.append(word)
    return seen[:MAX_TERMS]


def describe(stats):
    """One line about a sync, for the person."""
    if stats is None:
        return "The index is being updated by another task right now; try again in a moment."
    changed = f"{stats['added']} added, {stats['updated']} updated, {stats['removed']} removed, {stats['unchanged']} unchanged"
    extra = "" if not stats.get("capped") else f" Stopped at {MAX_FILES:,} files: the rest of the folder is not indexed."
    if stats.get("stopped"):
        extra += " Stopped before the end, so some files may be out of date."
    left_out = f", {stats['skipped']:,} left out (the Files tab says why)" if stats.get("skipped") else ""
    return (f"Index updated: {stats['files']:,} files ({changed}{left_out}), {stats['chunks']:,} chunks, in "
            f"{stats['seconds']:.1f}s.{extra}")


# ---------- the index ----------

class Index:
    """One project's index. Reads use a connection per thread (parallel subagents search at the same time); writes are
    serialised by a lock, and WAL mode lets reads carry on while one happens."""

    def __init__(self, root, db=None):
        self.root = Path(root).resolve()
        self.db = Path(db) if db else index_path(self.root)
        self.write_lock = threading.Lock()
        self.local = threading.local()
        self.schema_lock = threading.Lock()
        self.schema_ready = False
        self.last_sync = None  # time.time() of the last complete sync
        self.building = False
        self.generation = 0  # goes up whenever chunks or vectors change: the vector cache is rebuilt after that
        self.vectors = None  # (embedder version, generation, chunk ids, paths, matrix) for vector search
        self.embed_lock = threading.Lock()  # one embedding job at a time
        self.embedding = None  # while a job runs: {"done": n, "total": n}
        self.graph_building = False
        self.ignore = ignore.Ignore(self.root)
        self.recent = deque(maxlen=10)  # the last updates: {trigger, at, added, updated, removed, embedded}, newest last

    def conn(self):
        c = getattr(self.local, "conn", None)
        if c is None:
            self.db.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            c = sqlite3.connect(self.db, timeout=5, isolation_level=None)  # transactions are opened explicitly
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=5000")
            c.execute("PRAGMA synchronous=NORMAL")
            self.local.conn = c
        self._ensure_schema(c)
        return c

    def _ensure_schema(self, c):
        if self.schema_ready:
            return
        with self.schema_lock:
            if self.schema_ready:
                return
            # read the versions before creating anything: an older file's tables have older shapes
            has_meta = c.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").fetchone()
            meta = dict(c.execute("SELECT key, value FROM meta")) if has_meta else {}
            if meta and (meta.get("schema") != SCHEMA_VERSION or meta.get("chunker") != CHUNKER_VERSION):
                c.executescript(DROP_DERIVED)  # made by another version: cut again rather than mix the two (caches kept)
                meta = {}
            c.executescript(SCHEMA)
            if not meta:
                c.executemany("INSERT OR REPLACE INTO meta VALUES (?, ?)", [("schema", SCHEMA_VERSION), ("chunker", CHUNKER_VERSION)])
            self.schema_ready = True

    # --- which files ---

    def _classify(self, f):
        """(path inside the project, None) for a file to index, or (path or None, reason) for one that must not be: secret-looking,
        in a skipped folder, a symlink that leads out of the project, or the index itself (no path: nothing to show it under)."""
        try:
            real = f.resolve()
            rel = f.relative_to(self.root) if f.is_absolute() else f
        except (OSError, ValueError):
            return None, "outside"
        if safety.is_secret(f) or safety.is_secret(real):
            return rel.as_posix(), "secret"
        if any(part in SKIP_DIRS for part in rel.parts[:-1]):
            return rel.as_posix(), "ignored_folder"
        chosen = self._chosen_reason(rel.as_posix(), False)
        if chosen:
            return rel.as_posix(), chosen
        if self.db.parent == real.parent or self.db.parent in real.parents:
            return None, "outside"
        if self.root not in real.parents:
            return rel.as_posix(), "outside"
        return rel.as_posix(), None

    def _relative(self, f):
        """The path inside the project to index `f` under, or None if it must not be indexed (see _classify)."""
        rel, reason = self._classify(f)
        return None if reason else rel

    # --- what the person chose ---

    def selection(self):
        """The saved choice of what to search, or None if nobody has chosen yet: {"off": bool, "excluded": [folder or file],
        "included": [folders or files to search even though .gitignore leaves them out], "gitignore": bool}."""
        row = self.conn().execute("SELECT value FROM meta WHERE key = 'selection'").fetchone()
        try:
            return json.loads(row[0]) if row else None
        except ValueError:
            return None

    def choose(self, off=False, excluded=(), included=(), gitignore=True):
        """Save what the person chose to search (the next sync follows it). Paths are relative to the project."""
        norm = lambda paths: sorted({p.strip().strip("/") for p in paths if p.strip().strip("/")})  # noqa: E731
        sel = {"off": bool(off), "excluded": norm(excluded), "included": norm(included), "gitignore": bool(gitignore)}
        with self.write_lock:
            self.conn().execute("INSERT OR REPLACE INTO meta VALUES ('selection', ?)", (json.dumps(sel),))
        self.last_sync = None  # the next search syncs to the new choice
        return sel

    def allowed(self):
        """May the index be built and searched? Once the person has chosen (and not chosen "not now"), or with no choice when
        AUTO is on."""
        sel = self.selection()
        return (not sel["off"]) if sel else AUTO

    def not_allowed_reason(self):
        """Why search is off here, in words for the model (None if it is on)."""
        if self.allowed():
            return None
        if self.selection() is None:
            return ("This folder is not indexed yet: the user has not chosen what the agent may search. Use grep, glob and read_file "
                    "instead; do not ask the user about it.")
        return "The user chose not to index this folder for search. Use grep, glob and read_file instead."

    def _chosen_reason(self, rel, is_dir):
        """"not_chosen" or "gitignored" if the saved choice (or the .gitignore, when it counts) leaves this path out; else None."""
        sel = self.selection() or {}
        under = lambda paths: any(rel == p or rel.startswith(p + "/") for p in paths)  # noqa: E731
        if sel.get("off") or under(sel.get("excluded", ())):
            return "not_chosen"
        if sel.get("gitignore", True) and self.ignore.ignored(rel, is_dir) and not under(sel.get("included", ())):
            return "gitignored"
        return None

    def _walk(self, skipped=None):
        """The project's files, without going into folders that are never searched, left out by choice or by .gitignore (a
        folder left out is recorded once, as "folder/", not file by file)."""
        for here, dirs, names in os.walk(self.root):  # symlinked folders are not followed
            base = Path(here)
            keep = []
            for d in sorted(dirs):
                if d in tools.SKIP_DIRS:  # never opened: .git, node_modules, virtualenvs
                    continue
                rel = (base / d).relative_to(self.root).as_posix()
                reason = "ignored_folder" if d in SKIP_DIRS else self._chosen_reason(rel, True)
                if reason:
                    if skipped is not None:
                        skipped[rel + "/"] = reason
                    continue
                keep.append(d)
            dirs[:] = keep
            for n in sorted(names):
                yield base / n

    def plan(self, limit=MAX_FILES):
        """What searching this folder would take, before anything is indexed, for the first-open question: the files by top-level
        folder ("" for the files at the top), which .gitignore leaves out, and rough totals. Reads names and sizes only."""
        folders, scanned, capped = {}, 0, False
        for here, dirs, names in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            rel_here = Path(here).relative_to(self.root).as_posix()
            rel_here = "" if rel_here == "." else rel_here
            for n in names:
                if scanned >= limit:
                    capped = True
                    break
                scanned += 1
                rel = f"{rel_here}/{n}" if rel_here else n
                top = rel.split("/")[0] if "/" in rel else ""
                row = folders.setdefault(top, {"path": top, "files": 0, "bytes": 0, "gitignored_files": 0, "left_out": 0,
                                               "gitignored": bool(top) and self.ignore.ignored(top, True)})
                f = Path(here) / n
                try:
                    size = f.stat().st_size
                except OSError:
                    continue
                if safety.is_secret(f) or n == ".DS_Store" or f.suffix.lower() in BINARY_SUFFIXES or size > MAX_FILE_BYTES:
                    row["left_out"] += 1
                elif self.ignore.ignored(rel, False):
                    row["gitignored_files"] += 1
                else:
                    row["files"] += 1
                    row["bytes"] += size
            if capped:
                break
        rows = sorted(folders.values(), key=lambda r: (r["path"] == "", -(r["files"] + r["gitignored_files"])))
        files = sum(r["files"] for r in rows if not r["gitignored"])
        size = sum(r["bytes"] for r in rows if not r["gitignored"])
        return {"folders": rows, "files": files, "bytes": size, "chunks": max(files, round(size / BYTES_PER_CHUNK)) if files else 0,
                "left_out": sum(r["left_out"] for r in rows), "gitignored": sum(r["gitignored_files"] + (r["files"] if r["gitignored"] else 0) for r in rows),
                "capped": capped, "empty": scanned == 0 or not any(r["files"] or r["gitignored_files"] for r in rows),
                "chosen": self.selection()}

    def _candidates(self, stats, skipped=None):
        for f in self._walk(skipped):
            rel, reason = self._classify(f)
            if reason:
                if rel is not None and skipped is not None:
                    skipped[rel] = reason
                continue
            if stats["scanned"] >= MAX_FILES:
                stats["capped"] = True
                return
            stats["scanned"] += 1
            yield f, rel

    @staticmethod
    def _text(f):
        """(text, bytes, None), or (None, bytes, reason) if it is not worth indexing (too big, binary, not UTF-8, minified)."""
        data = f.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            return None, data, "too_large"
        if b"\0" in data:
            return None, data, "binary"
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return None, data, "not_utf8"
        if len(text) / (text.count("\n") + 1) > MAX_AVERAGE_LINE:
            return None, data, "minified"
        return text, data, None

    # --- writing ---

    def _drop(self, c, rel):
        c.execute("DELETE FROM chunks WHERE path = ?", (rel,))
        return c.execute("DELETE FROM files WHERE path = ?", (rel,)).rowcount

    def _index_file(self, c, f, rel, old, stats):
        """Bring one file's chunks up to date. `old` is its row in files (mtime_ns, size, sha256) or None."""
        try:
            st = f.stat()
        except OSError:
            stats["removed"] += self._drop(c, rel) if old else 0
            return
        if old and (old[0], old[1]) == (st.st_mtime_ns, st.st_size):
            stats["unchanged"] += 1
            return
        if st.st_size > MAX_FILE_BYTES:
            text, data, reason = None, b"", "too_large"
        else:
            try:
                text, data, reason = self._text(f)
            except OSError:
                text, data, reason = None, b"", "unreadable"
        if text is None:
            if old:
                self._drop(c, rel)
            stats["skipped"] += 1
            stats.setdefault("skipped_paths", {})[rel] = reason
            return
        digest = sha256(data)
        if old and old[2] == digest:  # touched but not changed: only the stamp is new
            c.execute("UPDATE files SET mtime_ns = ?, size = ? WHERE path = ?", (st.st_mtime_ns, st.st_size, rel))
            stats["unchanged"] += 1
            return
        c.execute("DELETE FROM chunks WHERE path = ?", (rel,))
        c.executemany("INSERT INTO chunks(chunk_id, path, start_line, end_line, content, content_sha, heading) VALUES (?, ?, ?, ?, ?, ?, ?)",
                      [(sha256(f"{rel}\n{start}\n{body}")[:16], rel, start, end, body, sha256(body), heading)
                       for start, end, body, heading in chunks_for(rel, text)])
        c.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)", (rel, st.st_mtime_ns, st.st_size, digest, time.time()))
        stats["updated" if old else "added"] += 1

    def note(self, trigger, **counts):
        """Remember one update for the Knowledge tab's timeline: what started it and what it changed."""
        self.recent.append({"trigger": trigger, "at": time.time(), **counts})

    def sync(self, rebuild=False, cancel=None, blocking=True, trigger=None):
        """Bring the index up to date with the files: new and changed files are cut again, unchanged ones skipped (same stamp, or
        same content), deleted ones purged. Returns stats, or None if `blocking` is False and another sync is running."""
        if not self.write_lock.acquire(blocking=blocking):
            return None
        self.building, t0 = True, time.monotonic()
        stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "removed": 0, "skipped": 0, "capped": False, "stopped": False}
        skipped = stats["skipped_paths"] = {}  # path -> reason, for every file left out (the Files tab says why)
        try:
            c = self.conn()
            if rebuild:
                c.executescript("DELETE FROM chunks; DELETE FROM files;")
            known = {row[0]: row[1:] for row in c.execute("SELECT path, mtime_ns, size, sha256 FROM files")}
            seen = set()
            c.execute("BEGIN")
            try:
                for n, (f, rel) in enumerate(self._candidates(stats, skipped), 1):
                    if cancel is not None and cancel.is_set():
                        stats["stopped"] = True
                        break
                    seen.add(rel)
                    self._index_file(c, f, rel, known.get(rel), stats)
                    if n % BATCH == 0:
                        c.execute("COMMIT")
                        c.execute("BEGIN")
                if not stats["stopped"]:
                    for rel in known.keys() - seen:
                        stats["removed"] += self._drop(c, rel)
                    self._purge_orphans(c)
                    c.execute("DELETE FROM skipped")
                    c.executemany("INSERT OR REPLACE INTO skipped VALUES (?, ?)", list(skipped.items()))
                    self._stamp(c, capped=stats["capped"])
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise
            if not stats["stopped"]:
                self.last_sync = time.time()
            if stats["added"] or stats["updated"] or stats["removed"] or rebuild:
                self.generation += 1
            stats.update(self.counts(c))
            stats["seconds"] = time.monotonic() - t0
            stats["skipped"] = len(stats.pop("skipped_paths"))
            if trigger and (trigger != "before search" or stats["added"] or stats["updated"] or stats["removed"]):
                self.note(trigger, added=stats["added"], updated=stats["updated"], removed=stats["removed"], seconds=round(stats["seconds"], 2))
            return stats
        finally:
            self.building = False
            self.write_lock.release()

    def update_paths(self, paths, blocking=False):
        """Re-index just these files (paths inside the project, relative or absolute), e.g. right after the agent wrote them. If a
        sync is running this does nothing (unless blocking): that sync, or the next search's, sees the change."""
        if not self.write_lock.acquire(blocking=blocking):
            return False
        try:
            c = self.conn()
            stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "removed": 0, "skipped": 0}
            c.execute("BEGIN")
            try:
                for raw in paths:
                    f = Path(raw) if Path(raw).is_absolute() else self.root / raw
                    rel, reason = self._classify(f)
                    if rel is None:
                        continue
                    c.execute("DELETE FROM skipped WHERE path = ?", (rel,))
                    if reason:
                        if f.is_file():
                            c.execute("INSERT OR REPLACE INTO skipped VALUES (?, ?)", (rel, reason))
                        continue
                    old = c.execute("SELECT mtime_ns, size, sha256 FROM files WHERE path = ?", (rel,)).fetchone()
                    if f.is_file():
                        self._index_file(c, f, rel, old, stats)
                    elif old:
                        self._drop(c, rel)
                        stats["removed"] += 1
                c.executemany("INSERT OR REPLACE INTO skipped VALUES (?, ?)", list(stats.pop("skipped_paths", {}).items()))
                self._stamp(c)
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise
            if stats["added"] or stats["updated"] or stats["removed"] or stats["skipped"]:
                self.generation += 1
            if stats["added"] or stats["updated"] or stats["removed"]:
                self.note("agent wrote", paths=[str(x) for x in list(paths)[:3]], added=stats["added"], updated=stats["updated"], removed=stats["removed"])
            return True
        finally:
            self.write_lock.release()

    def _stamp(self, c, capped=None):
        """Remember when the index was last brought up to date (kept in the file, so a restart still knows)."""
        rows = [("synced_at", repr(time.time()))]
        if capped is not None:
            rows.append(("capped", "1" if capped else ""))
        c.executemany("INSERT OR REPLACE INTO meta VALUES (?, ?)", rows)

    def _purge_orphans(self, c):
        """Derived data whose passage is gone. Vectors and structure facts are cheap to make again; facts a model extracted cost
        money, so those are kept (a file that comes back, say on switching git branches, is not paid for twice)."""
        c.execute("DELETE FROM embeddings WHERE content_sha NOT IN (SELECT content_sha FROM chunks)")
        c.execute("DELETE FROM extractions WHERE extractor LIKE 'structure-%' AND content_sha NOT IN (SELECT sha256 FROM files)")  # by whole file
        c.execute("DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM mentions) AND id NOT IN (SELECT src FROM edges) "
                  "AND id NOT IN (SELECT dst FROM edges)")

    # --- embeddings ---

    def embed_pending(self, embedder, cancel=None, batch=EMBED_BATCH):
        """Embed every passage that has no vector for this embedder yet, a batch at a time. The model runs without any lock held,
        so searches and syncs carry on meanwhile. Returns {"embedded", "total", "stopped"}, or None if a job is already running."""
        if not self.embed_lock.acquire(blocking=False):
            return None
        try:
            c = self.conn()
            missing = ("SELECT DISTINCT c.content_sha, c.content FROM chunks c LEFT JOIN embeddings e ON e.content_sha = c.content_sha "
                       "AND e.model = ? WHERE e.content_sha IS NULL")
            total = c.execute(f"SELECT count(*) FROM ({missing})", (embedder.version,)).fetchone()[0]
            self.embedding = {"done": 0, "total": total}
            done, stopped = 0, False
            while True:
                if cancel is not None and cancel.is_set():
                    stopped = True
                    break
                rows = c.execute(missing + " LIMIT ?", (embedder.version, batch)).fetchall()
                if not rows:
                    break
                vectors = embedder.embed([text for _, text in rows])
                with self.write_lock:
                    c.execute("BEGIN")
                    c.executemany("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?, ?)",
                                  [(sha, embedder.version, len(v), embed.pack(v)) for (sha, _), v in zip(rows, vectors)])
                    c.execute("COMMIT")
                    self.generation += 1
                done += len(rows)
                self.embedding = {"done": done, "total": max(total, done)}
            return {"embedded": done, "total": total, "stopped": stopped}
        finally:
            self.embedding = None
            self.embed_lock.release()

    def _vector_table(self, embedder):
        """(chunk rowids, paths, matrix) of every passage with a vector from this embedder, cached until something changes."""
        cached = self.vectors
        if cached and cached[0] == embedder.version and cached[1] == self.generation:
            return cached[2:]
        generation = self.generation
        rows = self.conn().execute("SELECT c.id, c.path, e.vector FROM chunks c JOIN embeddings e ON e.content_sha = c.content_sha "
                                   "AND e.model = ? ORDER BY c.id", (embedder.version,)).fetchall()
        ids, paths, blobs = [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows]
        try:
            import numpy as np
            matrix = np.vstack([np.frombuffer(b, dtype=np.float32) for b in blobs]) if blobs else np.zeros((0, 1), dtype=np.float32)
        except ImportError:
            matrix = blobs
        self.vectors = (embedder.version, generation, ids, paths, matrix)
        return ids, paths, matrix

    # --- reading ---

    def counts(self, c=None):
        c = c or self.conn()
        one = lambda sql: c.execute(sql).fetchone()[0]  # noqa: E731
        return {"files": one("SELECT count(*) FROM files"), "chunks": one("SELECT count(*) FROM chunks"),
                "entities": one("SELECT count(*) FROM entities"), "edges": one("SELECT count(*) FROM edges")}

    def embedded(self, embedder):
        """How many passages have a vector from this embedder."""
        return self.conn().execute("SELECT count(*) FROM chunks c JOIN embeddings e ON e.content_sha = c.content_sha AND e.model = ?",
                                   (embedder.version,)).fetchone()[0]

    def coverage(self):
        """Which files the index holds and which it left out, for front ends: {"files": {path: [snippets, connections]},
        "skipped": {path: reason}, "capped": bool}. A file's connections are the graph's links that cite one of its passages."""
        c = self.conn()
        files = {p: [0, 0] for (p,) in c.execute("SELECT path FROM files")}  # an empty file is indexed too, with no snippets
        for p, n in c.execute("SELECT path, count(*) FROM chunks GROUP BY path"):
            if p in files:
                files[p][0] = n
        for p, n in c.execute("SELECT ch.path, count(*) FROM edges e JOIN chunks ch ON ch.chunk_id = e.chunk_id GROUP BY ch.path"):
            if p in files:
                files[p][1] = n
        capped = c.execute("SELECT value FROM meta WHERE key = 'capped'").fetchone()
        return {"files": files, "skipped": dict(c.execute("SELECT path, reason FROM skipped")), "capped": bool(capped and capped[0])}

    def file_chunks(self, rel, embedder=None):
        """How one file is cut, for the Files viewer: {path, lines, kind ("markdown", "prose" or "code"), size, overlap, chunks:
        [{start, end, heading, embedded, names}]}. No chunks if the file is not in the index."""
        c = self.conn()
        suffix = PurePosixPath(rel).suffix.lower()
        kind = "markdown" if suffix in MARKDOWN else "prose" if suffix in PROSE else "code"
        size, overlap = CHUNK_DEFAULTS["prose" if kind != "code" else "code"]
        rows = c.execute("SELECT chunk_id, start_line, end_line, heading, content_sha FROM chunks WHERE path = ? ORDER BY start_line", (rel,)).fetchall()
        vectors = set()
        if embedder is not None and rows:
            vectors = {sha for (sha,) in c.execute(f"SELECT content_sha FROM embeddings WHERE model = ? AND content_sha IN "
                                                    f"({','.join('?' * len(rows))})", [embedder.version, *[r[4] for r in rows]])}
        chunks = []
        for chunk_id, start, end, heading, sha in rows:
            names = [n for (n,) in c.execute("SELECT DISTINCT e.name FROM mentions m JOIN entities e ON e.id = m.entity_id "
                                               "WHERE m.chunk_id = ? ORDER BY e.name LIMIT 12", (chunk_id,))]
            chunks.append({"start": start, "end": end, "heading": heading, "embedded": sha in vectors if embedder else None, "names": names})
        return {"path": rel, "lines": max((ch["end"] for ch in chunks), default=0), "kind": kind, "size": size, "overlap": overlap,
                "chunks": chunks}

    def status(self, embedder=None):
        c = self.conn()
        meta = dict(c.execute("SELECT key, value FROM meta"))
        other = {}  # searchable files the structure graph does not read, by extension
        for (path,) in c.execute("SELECT path FROM files"):
            suffix = PurePosixPath(path).suffix.lower() or "(none)"
            if suffix not in MAPPED:
                other[suffix] = other.get(suffix, 0) + 1
        out = {"available": True, **self.counts(c), "building": self.building, "embedding": self.embedding,
               "graph_building": self.graph_building,
               "last_sync": self.last_sync or (float(meta["synced_at"]) if meta.get("synced_at") else None),
               "skipped": dict(c.execute("SELECT reason, count(*) FROM skipped WHERE path NOT LIKE '%/' GROUP BY reason")),
               "capped": bool(meta.get("capped")), "max_files": MAX_FILES, "location": str(self.db),
               "not_mapped": sorted(other.items(), key=lambda kv: -kv[1])[:6], "not_mapped_files": sum(other.values()),
               "skipped_folders": dict(c.execute("SELECT reason, count(*) FROM skipped WHERE path LIKE '%/' GROUP BY reason")),
               "selection": self.selection(), "allowed": self.allowed(), "recent": list(self.recent)}
        if embedder is not None:
            out.update(embedder=embedder.model_id, embedded=self.embedded(embedder))
        return out

    def search(self, query, top_k=5, path_prefix=None, mode="hybrid", embedder=None):
        """The best passages, best first (see query())."""
        return self.query(query, top_k, path_prefix, mode, embedder)[0]

    def query(self, query, top_k=5, path_prefix=None, mode="hybrid", embedder=None, trace=None):
        """The best passages for a query, best first, and the mode actually used. Each hit is {chunk_id, chunk_ids, path, start_line,
        end_line, heading, score, match, bm25, cosine, is_test, snippet}:
        - keyword: BM25 over the words (FTS5); meaning: cosine between the query's and the passages' vectors (needs `embedder`
          and passages it has embedded); hybrid: each list's best candidates, every one then scored both ways (so a passage one
          list ranked first and the other missed keeps its real score from the other), each score scaled 0-1 within this search
          (keyword: BM25 / the best BM25; meaning: how far above the noise floor, / the best) and averaged.
        - score is that combined score, 0-1 (1: best both ways); match says which ways found it at all (keyword: it has the
          words; meaning: above the floor); bm25 and cosine are the raw scores (None: no words in common / no vector).
          keyword_rank and meaning_rank are its places in each list (None: not in that list's top `pool`); file_lines is how
          long its file is. Without vectors, hybrid and meaning fall back to keyword.
        - A heading match counts double (the heading column); a test file's passage counts TEST_WEIGHT unless the search is about
          tests; passages of one file that overlap or touch are merged into one (up to MAX_MERGED_LINES lines), so a heading never
          arrives without its text. `path_prefix` is a path inside the project ('' or '.' for all).
        - `trace`, a dict if given, is filled with how the search went, for front ends to explain it: {asked, used, searched
          (snippets in scope), embedded (of those, with a vector), keyword_found, meaning_found, floor, fused, kept, prefix,
          tests_down, candidates: {keyword: [...], meaning: [...]}, each {chunk_id, path, start_line, end_line, rank, score}}.
          Found counts are capped at the pool each list is asked for (4 x top_k)."""
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if self.last_sync is None or time.time() - self.last_sync > RESYNC_SECONDS:
            self.sync(blocking=self.last_sync is None, trigger="before search")  # the first search waits for a whole index; later ones never wait for a sync
        prefix = (path_prefix or "").strip("/")
        prefix = "" if prefix == "." else prefix
        c = self.conn()
        c.execute("BEGIN")  # one snapshot: the ranked ids and the rows they name must come from the same moment (WAL)
        try:
            return self._query(c, query, top_k, prefix, mode, embedder, trace)
        finally:
            c.execute("COMMIT")

    def _query(self, c, query, top_k, prefix, mode, embedder, trace=None):
        pool = top_k * 4
        vectors = embedder is not None and mode != "keyword" and self.embedded(embedder) > 0
        used = mode if vectors else "keyword"
        lists = []
        q = embedder.embed([query], query=True)[0] if vectors and query.strip() else None
        if used != "meaning":
            lists.append(("keyword", self._keyword(query, prefix, pool)))
        if vectors:
            lists.append(("meaning", self._meaning(query, prefix, pool, embedder, q)))
        if trace is not None:
            scope, params = "1", []
            if prefix:
                like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                scope, params = "(c.path = ? OR c.path LIKE ? ESCAPE '\\')", [prefix, like + "/%"]
            embedded = 0
            if embedder is not None:
                embedded = c.execute(f"SELECT count(*) FROM chunks c JOIN embeddings e ON e.content_sha = c.content_sha AND e.model = ? "
                                     f"WHERE {scope}", [embedder.version, *params]).fetchone()[0]
            found = dict(lists)
            trace.update(asked=mode, used=used, prefix=prefix or None, pool=pool, embedded=embedded,
                         searched=c.execute(f"SELECT count(*) FROM chunks c WHERE {scope}", params).fetchone()[0],
                         keyword_found=len(found["keyword"]) if "keyword" in found else None,
                         meaning_found=len(found["meaning"]) if "meaning" in found else None,
                         floor=getattr(embedder, "min_similarity", None) if vectors else None)
        ranked = dict(lists)
        kw = dict(ranked.get("keyword", []))
        mn = dict(ranked.get("meaning", []))
        ranks = {name: {r: i for i, (r, _) in enumerate(lst, 1)} for name, lst in lists}
        ids = list(dict.fromkeys(r for _, lst in lists for r, _ in lst))
        if len(lists) == 2 and ids:  # score every candidate both ways, not only the ones each list happened to keep
            kw.update(self._keyword_scores(query, [r for r in ids if r not in kw]))
            if q is not None:
                mn.update(self._cosines(q, embedder, [r for r in ids if r not in mn]))
        floor = getattr(embedder, "min_similarity", 0.0) if vectors else 0.0
        kmax, mtop = max(kw.values(), default=0.0), max(mn.values(), default=floor)
        weight = {"keyword": (1.0, 0.0), "meaning": (0.0, 1.0)}.get(used, (KEYWORD_WEIGHT, 1 - KEYWORD_WEIGHT))
        fused = {}  # chunk rowid -> hit
        for r in ids:
            k = kw.get(r, 0.0) / kmax if kmax > 0 else 0.0
            m = max(0.0, (mn[r] - floor) / (mtop - floor)) if r in mn and mtop > floor else 0.0
            fused[r] = {"score": weight[0] * k + weight[1] * m, "bm25": float(f"{kw[r]:.4g}") if r in kw else None,
                        "cosine": float(f"{mn[r]:.4g}") if r in mn else None,
                        "found": [n for n, ok in (("keyword", r in kw), ("meaning", r in mn and mn[r] >= floor)) if ok],
                        "keyword_rank": ranks.get("keyword", {}).get(r), "meaning_rank": ranks.get("meaning", {}).get(r)}
        rows = {r[0]: r[1:] for r in c.execute(
            f"SELECT id, chunk_id, path, start_line, end_line, content, heading FROM chunks WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
        # a test file's passage counts less, so sample text in tests does not crowd out the docs and code, unless the search is
        # about tests (the words, or a test folder as the prefix)
        about_tests = bool(TEST_WORDS & set(query_terms(query))) or bool(prefix and is_test_path(prefix + "/x"))
        for rowid, f in fused.items():
            f["test"] = rowid in rows and is_test_path(rows[rowid][1])
            f["weighted"] = f["score"] * (TEST_WEIGHT if f["test"] and not about_tests else 1.0)
        order = sorted((r for r in fused if r in rows), key=lambda r: (-fused[r]["weighted"], r))  # gone since: a sync ran
        hits = []
        for rowid in order:
            chunk_id, path, start, end, content, heading = rows[rowid]
            f = fused[rowid]
            near = next((h for h in hits if h["path"] == path and start <= h["end_line"] + 1 and h["start_line"] <= end + 1), None)
            if near is not None:  # overlaps or touches a better passage of the same file: one longer passage, not a lost one
                if max(end, near["end_line"]) - min(start, near["start_line"]) + 1 <= MAX_MERGED_LINES:
                    _merge(near, start, content, chunk_id, f)
                continue
            hits.append({"chunk_id": chunk_id, "chunk_ids": [chunk_id], "path": path, "start_line": start, "end_line": end,
                         "heading": heading, "score": round(f["weighted"], 3), "match": None, "found": set(f["found"]),
                         "bm25": f["bm25"], "cosine": f["cosine"], "is_test": f["test"],
                         "keyword_rank": f["keyword_rank"], "meaning_rank": f["meaning_rank"],
                         "_lines": dict(enumerate(content.split("\n"), start))})
            if len(hits) == top_k:
                break
        for h in hits:
            lines = h.pop("_lines")
            h["snippet"] = "\n".join(lines[n] for n in range(h["start_line"], h["end_line"] + 1) if n in lines)[:MAX_SNIPPET_CHARS]
            found = h.pop("found")
            h["match"] = "both" if len(found) == 2 else next(iter(found), "keyword")
            h["file_lines"] = c.execute("SELECT max(end_line) FROM chunks WHERE path = ?", (h["path"],)).fetchone()[0]
        if trace is not None:
            trace.update(fused=len(fused), kept=len(hits), tests_down=not about_tests and any(f["test"] for f in fused.values()),
                         candidates={name: [{"chunk_id": rows[r][0], "path": rows[r][1], "start_line": rows[r][2], "end_line": rows[r][3],
                                             "rank": i, "score": float(f"{v:.4g}")} for i, (r, v) in enumerate(lst, 1) if r in rows]
                                     for name, lst in lists})
        return hits, used

    def _keyword(self, query, prefix, limit):
        """[(chunk rowid, BM25 turned positive)], best first."""
        terms = query_terms(query)
        if not terms:
            return []
        match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
        sql = ("SELECT c.id, bm25(chunks_fts, 1.0, 0.5, 2.0) AS rank FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid "
               "WHERE chunks_fts MATCH ?")
        params = [match]
        if prefix:
            like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " AND (c.path = ? OR c.path LIKE ? ESCAPE '\\')"
            params += [prefix, like + "/%"]
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)
        return [(rowid, -rank) for rowid, rank in self.conn().execute(sql, params)]

    def _keyword_scores(self, query, rowids):
        """{chunk rowid: BM25 turned positive} for these passages; one with none of the words is left out."""
        terms = query_terms(query)
        if not terms or not rowids:
            return {}
        match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
        sql = (f"SELECT rowid, bm25(chunks_fts, 1.0, 0.5, 2.0) FROM chunks_fts WHERE chunks_fts MATCH ? "
               f"AND rowid IN ({','.join('?' * len(rowids))})")
        return {rowid: -rank for rowid, rank in self.conn().execute(sql, [match, *rowids])}

    def _cosines(self, q, embedder, rowids):
        """{chunk rowid: cosine with the query} for these passages (any that have a vector), floor or not."""
        if not rowids:
            return {}
        ids, _, matrix = self._vector_table(embedder)
        at = {r: i for i, r in enumerate(ids)}
        return {r: _dot(matrix[at[r]], q) for r in rowids if r in at}

    def _meaning(self, query, prefix, limit, embedder, q=None):
        """[(chunk rowid, cosine)], best first, above the embedder's noise floor. `q`: the query's vector, if already made."""
        if not query.strip():
            return []
        ids, paths, matrix = self._vector_table(embedder)
        keep = [i for i, p in enumerate(paths) if not prefix or p == prefix or p.startswith(prefix + "/")]
        if not keep:
            return []
        if len(keep) < len(ids):
            matrix = matrix[keep] if hasattr(matrix, "shape") else [matrix[i] for i in keep]
        q = q if q is not None else embedder.embed([query], query=True)[0]
        floor = getattr(embedder, "min_similarity", 0.0)
        return [(ids[keep[i]], sim) for i, sim in embed.top_k_cosine(q, matrix, limit) if sim >= floor]


def _dot(row, q):
    """Cosine of a stored unit vector (a numpy row, bytes, or a list) and the query's."""
    if hasattr(row, "dot"):
        import numpy as np
        return float(row.dot(np.asarray(q, dtype=np.float32)))
    return sum(a * b for a, b in zip(embed.unpack(row) if isinstance(row, bytes) else row, q))


def _merge(hit, start, content, chunk_id, f):
    """Fold a lower-ranked passage into a hit it overlaps or touches: the range grows to cover both, the lines are the union (both
    are windows of the same file version), and it keeps the better score and every ranking that found either."""
    for n, line in enumerate(content.split("\n"), start):
        hit["_lines"].setdefault(n, line)
    hit["start_line"], hit["end_line"] = min(hit["_lines"]), max(hit["_lines"])
    hit["chunk_ids"].append(chunk_id)
    hit["found"] |= set(f["found"])
    for key in ("bm25", "cosine"):
        if f[key] is not None and (hit[key] is None or f[key] > hit[key]):
            hit[key] = f[key]


_indexes = {}
_indexes_lock = threading.Lock()


def get(root=None):
    """The Index for a project folder (the working directory by default), one per folder and index file per process."""
    root = Path(root or Path.cwd()).resolve()
    key = (root, index_path(root))
    with _indexes_lock:
        if key not in _indexes:
            _indexes[key] = Index(root, key[1])
        return _indexes[key]


def status(root=None, embedder=None):
    """What a front end shows about the index. Never raises."""
    if not available():
        return {"available": False}
    try:
        out = get(root).status(embedder)
    except (sqlite3.Error, OSError) as e:
        return {"available": True, "error": str(e)}
    out.update(embed_installed=embed.available(), embed_downloaded=embed.available() and embed.downloaded(),
               embed_model=embed.model_id(), embed_size=embed.MODEL_SIZE_NOTE, embed_install=embed.install_command())
    return out
