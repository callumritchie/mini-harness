"""Embedders for the document index: text in, unit-length vectors out. See DESIGN.md, 'Document index'.

The real one runs a small ONNX model on this computer (fastembed, installed with `pip install -e ".[rag]"`): no key, no per-call
cost, and nothing leaves the machine. Its model is downloaded once, only when the person asks for it (`/index --embed`), into
the same home as the session logs. HashEmbedder is the offline stand-in the tests use: deterministic, standard library only.

Every embedder has a `version`; vectors are stored by (chunk content, version), so a passage is embedded once per model and a
new model never mixes with an old one.
"""
import array
import hashlib
import math
import os
import re

import sessionlog

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
MODEL_ENV = "MINI_HARNESS_EMBED_MODEL"
MODEL_SIZE_NOTE = "about 130 MB"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "  # what the bge models expect in front of a query


def model_id():
    return os.environ.get(MODEL_ENV) or DEFAULT_MODEL


def cache_dir():
    return sessionlog.home() / "models"


def available():
    """Is the local model's library installed (the [rag] extra)?"""
    try:
        import fastembed  # noqa: F401
        import numpy  # noqa: F401
        return True
    except ImportError:
        return False


def downloaded(model=None):
    """Has the model already been downloaded? (Embedding never starts a download by itself.)"""
    folder = cache_dir()
    slug = (model or model_id()).split("/")[-1].lower()
    return folder.is_dir() and any(slug in p.name.lower() for p in folder.iterdir())


class LocalEmbedder:
    """fastembed's ONNX runtime with a small sentence model, on the CPU."""

    def __init__(self, model=None):
        from fastembed import TextEmbedding

        self.model_id = model or model_id()
        cache_dir().mkdir(parents=True, exist_ok=True, mode=0o700)
        self.model = TextEmbedding(model_name=self.model_id, cache_dir=str(cache_dir()))
        self.dim = len(next(iter(self.model.embed(["dimension probe"]))))
        self.version = f"{self.model_id}@{self.dim}"
        self.min_similarity = 0.5  # bge-small puts unrelated English text around 0.3-0.5: below this a "meaning" match is noise

    def embed(self, texts, query=False):
        texts = [QUERY_PREFIX + t for t in texts] if query else list(texts)
        return [normalise([float(x) for x in v]) for v in self.model.embed(texts, batch_size=64)]


class HashEmbedder:
    """A deterministic bag-of-words vector (words hashed into `dim` buckets). It only matches shared words, so it is no better than
    keyword search; it exists so the vector path can be tested offline. `synonyms` maps words onto one bucket, so tests can show a
    passage found by meaning that keyword search misses."""

    def __init__(self, dim=256, synonyms=None):
        self.dim, self.synonyms = dim, dict(synonyms or {})
        self.model_id = "hash-bow"
        self.version = f"{self.model_id}@{dim}"
        self.min_similarity = 0.05
        self.calls = 0  # texts embedded, so tests can see what was (not) embedded again

    def embed(self, texts, query=False):
        out = []
        for text in texts:
            self.calls += 1
            v = [0.0] * self.dim
            for word in re.findall(r"[a-z0-9]+", text.lower()):
                word = self.synonyms.get(word, word)
                v[int(hashlib.sha256(word.encode()).hexdigest()[:8], 16) % self.dim] += 1.0
            out.append(normalise(v))
        return out


_local = None


def get(allow_download=False):
    """The embedder to use, or None: the local model if its library is installed and the model is downloaded (or a download is
    allowed now). Built once per process; loading it takes a second or two."""
    global _local
    if _local is not None:
        return _local
    if not available() or not (allow_download or downloaded()):
        return None
    _local = LocalEmbedder()
    return _local


# ---------- vectors ----------

def normalise(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n else v


def pack(v):
    return array.array("f", v).tobytes()


def unpack(blob):
    a = array.array("f")
    a.frombytes(blob)
    return a


def top_k_cosine(query, vectors, k):
    """[(index, cosine)] of the k vectors closest to `query`, best first. All vectors are unit length, so cosine is the dot
    product. numpy when it is installed, plain Python otherwise (the tests run both)."""
    if len(vectors) == 0:
        return []
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        m = vectors if isinstance(vectors, np.ndarray) else np.vstack([np.frombuffer(v, dtype=np.float32) if isinstance(v, bytes) else np.asarray(v, dtype=np.float32) for v in vectors])
        sims = m @ np.asarray(query, dtype=np.float32)
        k = min(k, len(sims))
        best = np.argpartition(-sims, k - 1)[:k]
        return sorted(((int(i), float(sims[i])) for i in best), key=lambda p: -p[1])
    sims = [(i, sum(a * b for a, b in zip(query, unpack(v) if isinstance(v, bytes) else v))) for i, v in enumerate(vectors)]
    return sorted(sims, key=lambda p: -p[1])[:k]
