"""Files the person attaches to a message (from the web UI's prompt box, or /attach in the terminal), turned into the content
blocks the model reads: images as images, PDFs as documents, text and code as text. Anything else is refused with a reason.
See DESIGN.md, 'Attachments'."""
import base64
from dataclasses import dataclass
from pathlib import Path

from session import UserError
from sessionlog import ATTACH_LABEL as LABEL

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
EXTENSION_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
                   ".pdf": "application/pdf"}
MAX_IMAGE_BYTES = 5_000_000  # the API's limit for one image
MAX_PDF_BYTES = 20_000_000  # under the API's 32 MB request limit, with room for the conversation
MAX_TEXT_CHARS = 400_000
MAX_FILES = 10  # per message
MAX_TOTAL_BYTES = 30_000_000  # per message
OFFICE_SUFFIXES = {".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".pages", ".numbers", ".key", ".rtf"}
CONVERT ="save it as PDF, or as plain text, and attach that"


@dataclass
class Attachment:
    name: str
    kind: str  # "image" | "pdf" | "text"
    media_type: str
    data: bytes

    @property
    def size(self):
        return len(self.data)


def _mb(n):
    return f"{n / 1_000_000:.0f} MB"


def classify(name, media_type, data):
    """An Attachment, or a UserError that says why the file cannot be attached and what to do instead."""
    name = Path(name or "file").name or "file"
    media_type = (media_type or "").split(";")[0].strip().lower()
    guessed = EXTENSION_TYPES.get(Path(name).suffix.lower())
    if media_type in ("", "application/octet-stream") and guessed:
        media_type = guessed
    if not data:
        raise UserError(f"{name} is empty, so there is nothing to attach.")
    if media_type in IMAGE_TYPES or (guessed in IMAGE_TYPES and media_type.startswith("image/")):
        media_type = media_type if media_type in IMAGE_TYPES else guessed
        if len(data) > MAX_IMAGE_BYTES:
            raise UserError(f"{name} is {_mb(len(data))}; images can be at most {_mb(MAX_IMAGE_BYTES)}. Shrink it or take a smaller screenshot.")
        return Attachment(name, "image", media_type, data)
    if media_type.startswith("image/"):
        raise UserError(f"{name} is a {media_type} image, which the model cannot read. Use PNG, JPEG, GIF or WebP.")
    if media_type == "application/pdf" or guessed == "application/pdf":
        if len(data) > MAX_PDF_BYTES:
            raise UserError(f"{name} is {_mb(len(data))}; PDFs can be at most {_mb(MAX_PDF_BYTES)}. Split it, or attach only the pages you need.")
        return Attachment(name, "pdf", "application/pdf", data)
    refused = f"{name} can't be attached: only images, PDFs and text files can. {CONVERT[0].upper()}{CONVERT[1:]}."
    if Path(name).suffix.lower() in OFFICE_SUFFIXES:
        raise UserError(refused)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise UserError(refused) from None
    if "\x00" in text:
        raise UserError(f"{name} looks like a binary file, so it can't be attached. {CONVERT[0].upper()}{CONVERT[1:]}.")
    if len(text) > MAX_TEXT_CHARS:
        raise UserError(f"{name} has {len(text):,} characters; text files can have at most {MAX_TEXT_CHARS:,}. Attach the part you need.")
    return Attachment(name, "text", "text/plain", data)


def from_path(raw):
    """Read a file from disk (the terminal's /attach) and classify it."""
    p = Path(raw).expanduser()
    if not p.is_file():
        raise UserError(f"There is no file at {raw}.")
    if p.stat().st_size > max(MAX_PDF_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_CHARS * 4):
        raise UserError(f"{p.name} is too large to attach ({_mb(p.stat().st_size)}).")
    return classify(p.name, EXTENSION_TYPES.get(p.suffix.lower(), ""), p.read_bytes())


def check_batch(items):
    if len(items) > MAX_FILES:
        raise UserError(f"At most {MAX_FILES} files can go with one message.")
    if sum(a.size for a in items) > MAX_TOTAL_BYTES:
        raise UserError(f"These files come to more than {_mb(MAX_TOTAL_BYTES)}; send fewer at a time.")


def to_blocks(items, text, provider):
    """The content of a user message: each file (a label with its name, then the file), then the typed text."""
    check_batch(items)
    blocks = []
    for a in items:
        if a.kind in ("image", "pdf") and provider != "anthropic":
            raise UserError(f"{a.name}: {provider} cannot read images or PDFs. Switch to a Claude model, or attach a text file.")
        blocks.append({"type": "text", "text": f"{LABEL}{a.name}]"})
        if a.kind == "image":
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": a.media_type, "data": base64.b64encode(a.data).decode("ascii")}})
        elif a.kind == "pdf":
            blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(a.data).decode("ascii")},
                           "title": a.name})
        else:
            blocks.append({"type": "text", "text": f'<file name="{a.name}">\n{a.data.decode("utf-8")}\n</file>'})
    if text.strip():
        blocks.append({"type": "text", "text": text})
    return blocks
