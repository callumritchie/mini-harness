"""Checks on the document index (rag.py) behind search_docs: cutting files into chunks, incremental updates, what is never
indexed, ranking, and searches from several threads at once.
Offline, no API key: python3 tests/test_rag.py   (or: python3 -m pytest tests/test_rag.py)"""
import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["MINI_HARNESS_HOME"] = tempfile.mkdtemp()

import rag
import sessionlog
import tools
from session import Session


def project(files):
    """A fresh project folder with these files, and its (new) index."""
    root = Path(tempfile.mkdtemp()).resolve()
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text) if isinstance(text, bytes) else p.write_text(text)
    return root, rag.Index(root)


def paths(index):
    return sorted(r[0] for r in index.conn().execute("SELECT path FROM files"))


def touch_later(p, text=None):
    """Change a file so its stamp is certainly different (some filesystems keep mtime to the second)."""
    st = p.stat()
    if text is not None:
        p.write_text(text)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))


# ---------- chunking ----------

def test_chunks_keep_exact_line_numbers_and_overlap():
    text = "\n".join(f"line {i}" for i in range(1, 26))
    chunks = rag.chunk_lines(text, 10, 3)
    assert [(s, e) for s, e, _ in chunks] == [(1, 10), (8, 17), (15, 24), (22, 25)]
    for s, e, body in chunks:
        assert body.split("\n")[0] == f"line {s}" and body.split("\n")[-1] == f"line {e}"
    assert rag.chunk_lines("a\nb", 10, 3) == [(1, 2, "a\nb")]  # a short file is one chunk, never repeated
    assert rag.chunk_lines("", 10, 3) == [] and rag.chunk_lines("\n\n\n", 10, 3) == []
    assert [(s, e) for s, e, _ in rag.chunk_lines("\n".join("x" * 20), 10, 0)] == [(1, 10), (11, 20)]
    for bad in [(0, 0), (5, 5), (5, -1)]:
        try:
            rag.chunk_lines("x", *bad)
            raise AssertionError(bad)
        except ValueError:
            pass


def test_prose_and_code_get_their_own_sizes():
    long = "\n".join(f"w{i}" for i in range(200))
    prose, code = rag.chunks_for("notes.md", long), rag.chunks_for("app.py", long)
    assert prose[0][1] == rag.CHUNK_DEFAULTS["prose"][0] and code[0][1] == rag.CHUNK_DEFAULTS["code"][0]


def test_queries_become_plain_words():
    assert rag.query_terms('Frozen "prefix" AND NEAR(x*) -cache: run_task frozen') == ["frozen", "prefix", "and", "near", "x", "cache", "run_task"]
    assert rag.query_terms("!!! ***") == []


# ---------- incremental sync ----------

def test_sync_is_incremental():
    root, index = project({"a.py": "def alpha():\n    return 1\n", "docs/b.md": "# Beta\nbeta notes\n", "c.txt": "gamma\n"})
    s = index.sync()
    assert (s["added"], s["updated"], s["unchanged"], s["removed"]) == (3, 0, 0, 0) and s["files"] == 3 and s["chunks"] == 3
    ids = {r[0] for r in index.conn().execute("SELECT chunk_id FROM chunks")}

    s = index.sync()
    assert (s["added"], s["updated"], s["unchanged"]) == (0, 0, 3)
    touch_later(root / "c.txt")  # new stamp, same content: not cut again
    s = index.sync()
    assert s["unchanged"] == 3 and s["updated"] == 0 and {r[0] for r in index.conn().execute("SELECT chunk_id FROM chunks")} == ids

    touch_later(root / "a.py", "def alpha():\n    return 2\n\ndef delta():\n    pass\n")
    (root / "docs" / "b.md").unlink()
    (root / "e.md").write_text("epsilon\n")
    s = index.sync()
    assert (s["added"], s["updated"], s["removed"], s["unchanged"]) == (1, 1, 1, 1), s
    assert paths(index) == ["a.py", "c.txt", "e.md"]
    assert [h["path"] for h in index.search("delta")] == ["a.py"] and index.search("beta") == []

    s = index.sync(rebuild=True)
    assert s["added"] == 3 and s["files"] == 3


def test_update_paths_reindexes_one_file():
    root, index = project({"a.py": "one\n"})
    index.sync()
    touch_later(root / "a.py", "two words here\n")
    assert index.update_paths(["a.py"]) is True
    assert [h["snippet"] for h in index.search("words")] == ["two words here"]
    (root / "a.py").unlink()
    index.update_paths([str(root / "a.py")])
    assert paths(index) == []
    with index.write_lock:  # a sync is running: the hook does nothing rather than wait
        assert index.update_paths(["a.py"]) is False


def test_a_new_version_rebuilds_the_index():
    root, index = project({"a.py": "hello\n"})
    index.sync()
    with sqlite3.connect(index.db) as c:
        c.execute("UPDATE meta SET value = 'lines-v0' WHERE key = 'chunker'")
    fresh = rag.Index(root, index.db)
    assert fresh.counts()["files"] == 0  # the old chunks were cut another way: dropped, not mixed
    assert dict(fresh.conn().execute("SELECT key, value FROM meta"))["chunker"] == rag.CHUNKER_VERSION
    assert fresh.sync()["added"] == 1


def test_stop_keeps_what_is_done_and_purges_nothing():
    root, index = project({f"f{i}.txt": f"word{i}\n" for i in range(5)})
    index.sync()
    (root / "f0.txt").unlink()
    stop = threading.Event()
    stop.set()
    s = index.sync(cancel=stop)
    assert s["stopped"] and s["removed"] == 0 and "f0.txt" in paths(index)
    assert "Stopped before the end" in rag.describe(s)


# ---------- what is never indexed ----------

def test_secrets_ignored_folders_and_binaries_are_never_indexed():
    root, index = project({
        "ok.py": "needle visible\n", ".env": "needle API_KEY=sk-secret\n", "id_rsa": "needle key\n", "certs/x.pem": "needle\n",
        "node_modules/m/i.js": "needle\n", ".git/config": "needle\n", "dist/app.js": "needle\n", "bin.dat": b"needle\x00\x01",
        "min.js": "needle " + "x" * 5000 + "\n", "latin.txt": "needle caf\xe9\n".encode("latin-1"),
        "big.txt": "needle\n" + "y" * (rag.MAX_FILE_BYTES + 10),
    })
    os.symlink("/etc", root / "etc-link")
    outside = Path(tempfile.mkdtemp()) / "outside.txt"
    outside.write_text("needle outside\n")
    os.symlink(outside, root / "outside-link.txt")
    index.sync()
    assert paths(index) == ["ok.py"], paths(index)
    hits = index.search("needle")
    assert [h["path"] for h in hits] == ["ok.py"] and all("sk-secret" not in h["snippet"] for h in hits)
    (root / ".env").write_text("needle again\n")
    index.update_paths([".env"])  # the write hook never indexes a secret either
    assert paths(index) == ["ok.py"]


def test_the_index_lives_outside_the_project():
    root, index = project({"a.py": "x\n"})
    index.sync()
    assert index.db.is_file() and root not in index.db.parents and sessionlog.home() in index.db.parents
    assert rag.index_path(root) == index.db and not any(p.suffix == ".sqlite" for p in root.rglob("*"))


# ---------- ranking ----------

def test_the_relevant_file_ranks_first():
    root, index = project({
        "docs/cache.md": "# Prompt cache\nThe frozen prefix rule keeps the prompt cache warm: never edit what was sent.\n",
        "docs/other.md": "# Other\nNothing about it here, just the word prompt once.\n",
        "src/app.py": "def frozen():\n    pass\n",
        "README.md": "Intro.\n",
    })
    hits = index.search("frozen prefix cache", top_k=3)
    assert hits[0]["path"] == "docs/cache.md" and hits[0]["start_line"] == 1 and hits[0]["end_line"] == 2
    assert [h["score"] for h in hits] == sorted((h["score"] for h in hits), reverse=True) and all(h["score"] >= 0 for h in hits)
    assert set(hits[0]) == {"chunk_id", "path", "start_line", "end_line", "score", "match", "bm25", "cosine", "snippet"} and len(hits[0]["chunk_id"]) == 16
    assert hits[0]["score"] == 1.0 and hits[0]["match"] == "keyword" and hits[0]["cosine"] is None and hits[0]["bm25"] > 0
    assert len(index.search("frozen prefix cache", top_k=1)) == 1
    assert [h["path"] for h in index.search("frozen", path_prefix="src")] == ["src/app.py"]
    assert [h["path"] for h in index.search("frozen", path_prefix="docs/cache.md")] == ["docs/cache.md"]
    assert index.search("frozen", path_prefix="doc") == []  # a prefix is a folder or file, not the start of a name


def test_overlapping_chunks_of_one_file_are_shown_once():
    text = "\n".join(["filler"] * 55 + ["needle"] + ["filler"] * 10)
    root, index = project({"big.py": text})
    hits = index.search("needle", top_k=5)
    assert len(hits) == 1 and hits[0]["start_line"] <= 56 <= hits[0]["end_line"]


def test_strange_queries_never_fail():
    root, index = project({"a.py": "alpha beta\n"})
    for q in ['"', "*", "alpha*", "NEAR(alpha beta)", "-alpha", "alpha OR", "(((", "a:b", "' OR 1=1 --", "😀", ""]:
        index.search(q)  # no exception
    assert index.search("ALPHA")[0]["path"] == "a.py" and index.search("") == []


def test_a_search_sees_files_changed_by_other_means():
    root, index = project({"a.py": "old\n"})
    index.search("old")
    (root / "b.py").write_text("brand new\n")  # e.g. written by a bash command
    index.last_sync -= rag.RESYNC_SECONDS + 1
    assert [h["path"] for h in index.search("brand")] == ["b.py"]


# ---------- embeddings and hybrid search ----------

# The hash embedder only matches words; these synonyms put "warm"/"hot" and "cache"/"memo" in one bucket, so a passage can be
# found "by meaning" that keyword search cannot find.
SYN = {"hot": "warm", "memo": "cache", "memoise": "cache"}


def test_vectors_are_keyed_by_content_and_never_made_twice():
    import embed
    root, index = project({"a.md": "same words\n", "b.md": "same words\n", "c.md": "other text\n"})
    index.sync()
    e = embed.HashEmbedder()
    s = index.embed_pending(e)
    assert s == {"embedded": 2, "total": 2, "stopped": False} and e.calls == 2  # a.md and b.md share one vector
    assert index.embedded(e) == 3 and index.embed_pending(e)["embedded"] == 0 and e.calls == 2
    touch_later(root / "c.md", "changed text\n")
    index.sync()
    assert index.embed_pending(e)["embedded"] == 1 and e.calls == 3
    (root / "a.md").unlink(); (root / "b.md").unlink()
    index.sync()  # the shared vector's passages are gone: so is the vector
    assert index.conn().execute("SELECT count(*) FROM embeddings").fetchone()[0] == 1
    other = embed.HashEmbedder(dim=64)  # another model never mixes with this one
    assert index.embedded(other) == 0 and index.embed_pending(other)["embedded"] == 1


def test_embedding_can_be_stopped_and_only_one_job_runs():
    import embed
    root, index = project({f"f{i}.md": f"word{i}\n" for i in range(10)})
    index.sync()
    stop = threading.Event(); stop.set()
    assert index.embed_pending(embed.HashEmbedder(), cancel=stop)["stopped"] is True
    with index.embed_lock:
        assert index.embed_pending(embed.HashEmbedder()) is None
    assert index.embed_pending(embed.HashEmbedder(), batch=3)["embedded"] == 10


def test_hybrid_finds_by_words_and_by_meaning():
    import embed
    root, index = project({
        "keep.md": "Keep the memo hot between calls.\n",      # the meaning: only via the synonyms
        "rule.md": "The cache must stay warm: never edit what was sent.\n",  # the words and the meaning
        "other.md": "Unrelated text about deployment.\n",
    })
    index.sync()
    e = embed.HashEmbedder(synonyms=SYN)
    assert [h["path"] for h in index.search("warm cache", embedder=e)] == ["rule.md"]  # nothing embedded yet: keyword only
    index.embed_pending(e)
    hits, used = index.query("warm cache", embedder=e)
    assert used == "hybrid" and [h["path"] for h in hits[:2]] == ["rule.md", "keep.md"]
    assert hits[0]["match"] == "both" and hits[0]["score"] > 0.9 and hits[0]["bm25"] > 0 and hits[0]["cosine"] > 0  # 2nd by meaning
    assert hits[1]["match"] == "meaning" and hits[1]["bm25"] is None and 0 < hits[1]["score"] < 1
    assert "other.md" not in [h["path"] for h in hits]  # below the similarity floor
    assert [h["path"] for h in index.search("warm cache", mode="keyword", embedder=e)] == ["rule.md"]
    meaning, used = index.query("warm cache", mode="meaning", embedder=e)
    assert used == "meaning" and {h["path"] for h in meaning} == {"rule.md", "keep.md"} and all(h["match"] == "meaning" for h in meaning)
    assert index.query("warm cache", mode="meaning")[1] == "keyword"  # no embedder: falls back, and says so
    assert [h["path"] for h in index.search("hot", path_prefix="rule.md", embedder=e)] == ["rule.md"]


def test_vector_math_with_and_without_numpy():
    import embed
    vecs = [embed.normalise([1, 0, 0]), embed.normalise([1, 1, 0]), embed.normalise([0, 0, 1])]
    blobs = [embed.pack(v) for v in vecs]
    q = embed.normalise([1, 0.1, 0])
    with_np = embed.top_k_cosine(q, blobs, 2)
    real = sys.modules.get("numpy")
    sys.modules["numpy"] = None  # import numpy now fails: the pure-Python path
    try:
        without = embed.top_k_cosine(q, blobs, 2)
    finally:
        sys.modules["numpy"] = real
        if real is None:
            del sys.modules["numpy"]
    assert [i for i, _ in with_np] == [i for i, _ in without] == [0, 1]
    assert all(abs(a[1] - b[1]) < 1e-5 for a, b in zip(with_np, without))
    assert embed.top_k_cosine(q, [], 3) == []


def test_searches_while_embedding():
    import embed
    files = {f"doc{i}.md": f"topic words number{i}\n" for i in range(80)}
    root, index = project(files)
    index.sync()
    e = embed.HashEmbedder()
    errors = []

    def searcher():
        try:
            for _ in range(20):
                index.search("topic words", embedder=e)
        except Exception as ex:  # noqa: BLE001
            errors.append(ex)

    threads = [threading.Thread(target=searcher) for _ in range(4)] + [threading.Thread(target=lambda: index.embed_pending(e, batch=5))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors, errors
    assert index.embedded(e) == 80 and index.search("number7", mode="meaning", embedder=e)[0]["path"] == "doc7.md"


def test_real_model_when_asked():
    """Opt-in (MINI_HARNESS_TEST_REAL_EMBED=1 with the [rag] extra installed): the real local model finds a paraphrase."""
    import embed
    if not os.environ.get("MINI_HARNESS_TEST_REAL_EMBED"):
        return
    root, index = project({"cache.md": "Never change what was already sent to the model, so the prompt cache stays valid.\n",
                           "deploy.md": "Run the release script, then tag the commit.\n"})
    index.sync()
    e = embed.LocalEmbedder()
    index.embed_pending(e)
    hits, used = index.query("keeping cached prompts reusable", mode="meaning", embedder=e)
    assert used == "meaning" and hits[0]["path"] == "cache.md", hits


# ---------- threads ----------

def test_parallel_searches_while_syncing():
    files = {f"doc{i}.md": f"# Doc {i}\nshared topic words\nunique{i}\n" for i in range(60)}
    root, index = project(files)
    index.sync()
    errors, results = [], []

    def searcher(n):
        try:
            for _ in range(15):
                hits = index.search(f"unique{n} shared", top_k=3)
                results.append(hits[0]["path"] == f"doc{n}.md")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    def writer():
        try:
            for i in range(10):
                touch_later(root / f"doc{i}.md", f"# Doc {i}\nshared topic words\nunique{i}\nrevised {i}\n")
                index.update_paths([f"doc{i}.md"], blocking=True)
                index.sync()
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=searcher, args=(n,)) for n in range(8)] + [threading.Thread(target=writer)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors, errors
    assert len(results) == 8 * 15 and all(results)
    assert index.counts()["files"] == 60 and index.search("revised 3")[0]["path"] == "doc3.md"


def test_one_index_per_folder():
    root, _ = project({"a.py": "x\n"})
    assert rag.get(root) is rag.get(root) and rag.get(root) is not rag.get(Path(tempfile.mkdtemp()))


# ---------- the tool and the log ----------

def test_search_docs_reports_sources_to_front_ends_only():
    root, _ = project({"notes.md": "The frozen prefix rule.\n"})
    old = os.getcwd()
    os.chdir(root)
    try:
        session = Session.start("claude-opus-5-5")
        out, err = tools.run("search_docs", {"query": "frozen prefix"}, session)
        sources = tools.take_meta()["sources"]
        assert not err and "notes.md:1-1  (score 1.00)" in out and "     1\tThe frozen prefix rule." in out and "ranked by keyword match" in out
        assert sources and sources[0]["path"] == "notes.md" and sources[0]["start_line"] == 1
        out2, _ = tools.run("read_file", {"path": "notes.md"}, session)
        assert tools.take_meta() is None  # another tool leaves nothing behind
        out3, _ = tools.run("search_docs", {"query": "frozen prefix", "mode": "meaning"}, session)
        assert "this was keyword search" in out3 and "/index --embed" in out3  # no model here: it says so
        tools.take_meta()
        session.add_user("find it")
        session.log_tool_result({"type": "tool_result", "tool_use_id": "t1", "content": out, "is_error": False},
                                meta={"sources": sources, "other": "not kept"})
        events, _ = sessionlog.load(session.log.path)
        assert sessionlog.tool_meta(events) == {"t1": {"sources": sources}} and "other" not in events[-1]
        replayed = sessionlog.replay(events)["messages"]
        assert replayed[-1]["content"] == [{"type": "tool_result", "tool_use_id": "t1", "content": out, "is_error": False}]  # no sources for the model
        assert rag.status(root)["files"] == 1 and rag.status(root)["available"] is True
    finally:
        os.chdir(old)


def test_status_and_describe():
    assert "2 added" in rag.describe({"files": 2, "added": 2, "updated": 0, "removed": 0, "unchanged": 0, "chunks": 4, "seconds": 0.1})
    assert "another task" in rag.describe(None)


if __name__ == "__main__":
    if not rag.available():
        print("skipped: this Python's SQLite has no FTS5")
        sys.exit(0)
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            t0 = time.monotonic()
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    print("ok" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)
