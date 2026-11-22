"""The project's document index: text files cut into ranges of lines, kept in SQLite with full-text search (FTS5), and searched
by the search_docs tool. Standard library only. See DESIGN.md, 'Document index'.

The index lives outside the project (next to the session logs), is brought up to date incrementally (a file whose stamp and
content are unchanged is never cut again), and never holds a file that looks like it has secrets in it. Every chunk is
content-addressed (`content_sha`), so what is built on top of it later (embeddings, an entity graph) can be cached by chunk
content and version, and a version change here rebuilds the index rather than mixing two ways of cutting.
"""
import hashlib
import sqlite3
import threading
import time
from pathlib import Path

import safety
import sessionlog
import tools

SCHEMA_VERSION = "1"
CHUNKER_VERSION = "lines-v1"  # bump when chunk_lines or CHUNK_DEFAULTS change: the index is rebuilt
PROSE = {".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"}
CHUNK_DEFAULTS = {"code": (60, 10), "prose": (40, 8)}  # (lines per chunk, lines shared with the next one)
SKIP_DIRS = tools.SKIP_DIRS | {".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".cache", "dist", "build", "coverage"}
MAX_FILE_BYTES = tools.MAX_GREP_FILE_BYTES
MAX_FILES = tools.MAX_SEARCH_FILES
MAX_AVERAGE_LINE = 500  # characters; a file with longer lines on average is minified or generated, not something to read
MAX_SNIPPET_CHARS = 4000  # of a chunk, in the structured sources a front end gets
MAX_TERMS = 32
RESYNC_SECONDS = 2.0  # a search re-checks the files at most this often (parallel helpers searching at once share one check)
BATCH = 200  # files per write transaction

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                                 indexed_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
                                  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, content_sha TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS chunks_content_sha ON chunks(content_sha);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, path, content='chunks', content_rowid='id',
                                                         tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, path) VALUES (new.id, new.content, new.path);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, path) VALUES ('delete', old.id, old.content, old.path);
END;
"""
DROP = "DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS meta;"

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


def chunks_for(path, text):
    size, overlap = CHUNK_DEFAULTS["prose" if Path(path).suffix.lower() in PROSE else "code"]
    return chunk_lines(text, size, overlap)


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
    return f"Index updated: {stats['files']:,} files ({changed}), {stats['chunks']:,} passages, in {stats['seconds']:.1f}s.{extra}"


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
            c.executescript(SCHEMA)
            meta = dict(c.execute("SELECT key, value FROM meta"))
            if meta and (meta.get("schema") != SCHEMA_VERSION or meta.get("chunker") != CHUNKER_VERSION):
                c.executescript(DROP + SCHEMA)  # made by another version: start again rather than mix the two
                meta = {}
            if not meta:
                c.executemany("INSERT OR REPLACE INTO meta VALUES (?, ?)", [("schema", SCHEMA_VERSION), ("chunker", CHUNKER_VERSION)])
            self.schema_ready = True

    # --- which files ---

    def _relative(self, f):
        """The path inside the project to index `f` under, or None if it must not be indexed (secret-looking, in a skipped folder,
        a symlink that leads out of the project, or the index itself)."""
        try:
            real = f.resolve()
            rel = f.relative_to(self.root) if f.is_absolute() else f
        except (OSError, ValueError):
            return None
        if safety.is_secret(f) or safety.is_secret(real) or any(part in SKIP_DIRS for part in rel.parts[:-1]):
            return None
        if self.root not in real.parents or self.db.parent == real.parent or self.db.parent in real.parents:
            return None
        return rel.as_posix()

    def _candidates(self, stats):
        for f in tools._walk_files(self.root):
            rel = self._relative(f)
            if rel is None:
                continue
            if stats["scanned"] >= MAX_FILES:
                stats["capped"] = True
                return
            stats["scanned"] += 1
            yield f, rel

    @staticmethod
    def _text(f):
        """The file as text, or None if it is not worth indexing (too big, binary, not UTF-8, minified)."""
        data = f.read_bytes()
        if len(data) > MAX_FILE_BYTES or b"\0" in data:
            return None, data
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return None, data
        if len(text) / (text.count("\n") + 1) > MAX_AVERAGE_LINE:
            return None, data
        return text, data

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
            text, data = None, b""
        else:
            try:
                text, data = self._text(f)
            except OSError:
                text, data = None, b""
        if text is None:
            if old:
                self._drop(c, rel)
            stats["skipped"] += 1
            return
        digest = sha256(data)
        if old and old[2] == digest:  # touched but not changed: only the stamp is new
            c.execute("UPDATE files SET mtime_ns = ?, size = ? WHERE path = ?", (st.st_mtime_ns, st.st_size, rel))
            stats["unchanged"] += 1
            return
        c.execute("DELETE FROM chunks WHERE path = ?", (rel,))
        c.executemany("INSERT INTO chunks(chunk_id, path, start_line, end_line, content, content_sha) VALUES (?, ?, ?, ?, ?, ?)",
                      [(sha256(f"{rel}\n{start}\n{body}")[:16], rel, start, end, body, sha256(body)) for start, end, body in chunks_for(rel, text)])
        c.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)", (rel, st.st_mtime_ns, st.st_size, digest, time.time()))
        stats["updated" if old else "added"] += 1

    def sync(self, rebuild=False, cancel=None, blocking=True):
        """Bring the index up to date with the files: new and changed files are cut again, unchanged ones skipped (same stamp, or
        same content), deleted ones purged. Returns stats, or None if `blocking` is False and another sync is running."""
        if not self.write_lock.acquire(blocking=blocking):
            return None
        self.building, t0 = True, time.monotonic()
        stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "removed": 0, "skipped": 0, "capped": False, "stopped": False}
        try:
            c = self.conn()
            if rebuild:
                c.executescript("DELETE FROM chunks; DELETE FROM files;")
            known = {row[0]: row[1:] for row in c.execute("SELECT path, mtime_ns, size, sha256 FROM files")}
            seen = set()
            c.execute("BEGIN")
            try:
                for n, (f, rel) in enumerate(self._candidates(stats), 1):
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
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise
            if not stats["stopped"]:
                self.last_sync = time.time()
            stats.update(self.counts(c))
            stats["seconds"] = time.monotonic() - t0
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
                    rel = self._relative(f)
                    if rel is None:
                        continue
                    old = c.execute("SELECT mtime_ns, size, sha256 FROM files WHERE path = ?", (rel,)).fetchone()
                    if f.is_file():
                        self._index_file(c, f, rel, old, stats)
                    elif old:
                        self._drop(c, rel)
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise
            return True
        finally:
            self.write_lock.release()

    # --- reading ---

    def counts(self, c=None):
        c = c or self.conn()
        return {"files": c.execute("SELECT count(*) FROM files").fetchone()[0], "chunks": c.execute("SELECT count(*) FROM chunks").fetchone()[0]}

    def status(self):
        return {"available": True, **self.counts(), "last_sync": self.last_sync, "building": self.building}

    def search(self, query, top_k=5, path_prefix=None):
        """The best-matching chunks, best first: [{chunk_id, path, start_line, end_line, score, snippet}]. score is BM25 turned
        positive (higher is better; only comparable within one search). Overlapping chunks of the same file are shown once.
        `path_prefix` is a path inside the project ('' or '.' for all of it)."""
        if self.last_sync is None or time.time() - self.last_sync > RESYNC_SECONDS:
            self.sync(blocking=self.last_sync is None)  # the first search waits for a whole index; later ones never wait for a sync
        terms = query_terms(query)
        if not terms:
            return []
        match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
        sql = ("SELECT c.chunk_id, c.path, c.start_line, c.end_line, c.content, bm25(chunks_fts, 1.0, 0.5) AS rank "
               "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?")
        params = [match]
        prefix = (path_prefix or "").strip("/")
        if prefix and prefix != ".":
            like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " AND (c.path = ? OR c.path LIKE ? ESCAPE '\\')"
            params += [prefix, like + "/%"]
        sql += " ORDER BY rank LIMIT ?"
        params.append(top_k * 4)
        hits, taken = [], {}
        for chunk_id, path, start, end, content, rank in self.conn().execute(sql, params):
            if any(start <= e and s <= end for s, e in taken.get(path, [])):
                continue  # overlaps a better chunk of the same file
            taken.setdefault(path, []).append((start, end))
            hits.append({"chunk_id": chunk_id, "path": path, "start_line": start, "end_line": end, "score": float(f"{-rank:.4g}"),
                         "snippet": content[:MAX_SNIPPET_CHARS]})
            if len(hits) == top_k:
                break
        return hits


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


def status(root=None):
    """What a front end shows about the index. Never raises."""
    if not available():
        return {"available": False}
    try:
        return get(root).status()
    except (sqlite3.Error, OSError) as e:
        return {"available": True, "error": str(e)}
