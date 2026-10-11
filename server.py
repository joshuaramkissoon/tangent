"""Tangent server: fetches pages for extraction and proxies model calls. Stateless: the browser holds the document."""
import asyncio
import ipaddress
import json
import os
import re
import socket
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

import httpx
import trafilatura
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

ROOT = Path(__file__).parent

PROVIDERS = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "key_env": "GEMINI_API_KEY",
        "quick": "gemini-3.5-flash-lite",
        "deep": "gemini-3.8-flash",
        "quick_effort": "low",
        "deep_effort": "low",
        "quick_extra": {},
        "deep_extra": {},
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "key_env": "TOGETHER_API_KEY",
        "quick": "deepseek-ai/DeepSeek-V4.1-Flash",
        "deep": "deepseek-ai/DeepSeek-V4.1-Flash",  # same model with thinking on; V4-Pro-0813 is the heavier option
        "quick_effort": "",
        "deep_effort": "",
        # V4.1 Flash thinks by default (~6s on a cascade); off, it answers in ~0.5s.
        "quick_extra": {"reasoning": {"enabled": False}},
        "deep_extra": {},
    },
}


def load_dotenv_files():
    for p in [ROOT / ".env"]:
        if p.exists():
            for line in p.read_text().splitlines():
                m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)", line)
                if m and m.group(1) not in os.environ:
                    os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


load_dotenv_files()
PROVIDER = os.environ.get("TANGENT_PROVIDER", "together" if os.environ.get("TOGETHER_API_KEY") else "gemini")
cfg = PROVIDERS[PROVIDER]
QUICK_MODEL = os.environ.get("TANGENT_QUICK_MODEL", cfg["quick"])
DEEP_MODEL = os.environ.get("TANGENT_DEEP_MODEL", cfg["deep"])
client = AsyncOpenAI(base_url=cfg["base_url"], api_key=os.environ.get(cfg["key_env"], "missing"),
                     timeout=httpx.Timeout(25, connect=6), max_retries=1)

CASCADE_CACHE: dict[str, list] = {}

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def headers(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate the page and its scripts
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return resp


# ---------- abuse limits ----------
# Per-IP sliding windows, in memory. On a serverless host each instance keeps its own counts, so treat
# this as a speed bump and set spend limits with your model providers too. TANGENT_RATE_LIMIT=off disables it.

LIMITS = {"compose": (20, 3600), "ask": (150, 3600), "fetch": (60, 3600), "spine": (1500, 3600),
          "brief": (40, 3600), "voice": (60, 3600), "doc": (120, 3600)}
_hits: dict[tuple[str, str], deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    # Behind Vercel (or another proxy you trust) the client address is in X-Forwarded-For.
    if os.environ.get("VERCEL") or os.environ.get("TANGENT_TRUST_PROXY"):
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return ip_key(fwd.split(",")[0].strip())
    return ip_key(request.client.host) if request.client else "?"


def ip_key(addr: str) -> str:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return addr
    return str(ipaddress.ip_network(f"{ip}/64", strict=False)) if ip.version == 6 else addr


def limit(kind: str):
    async def check(request: Request):
        if os.environ.get("TANGENT_RATE_LIMIT", "on") == "off":
            return
        n, window = LIMITS[kind]
        now, q = time.monotonic(), _hits[(kind, client_ip(request))]
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= n:
            raise HTTPException(429, "You've hit this demo's hourly limit. Try again later, or run Tangent yourself.")
        q.append(now)
        if len(_hits) > 50_000:  # forget only addresses that have gone quiet, never active ones
            for key in [k for k, v in _hits.items() if not v or v[-1] < now - LIMITS[k[0]][1]]:
                del _hits[key]
    return Depends(check)


# ---------- fetching untrusted URLs ----------
# Links come from readers, so only fetch public http(s) addresses (no localhost, private ranges or cloud
# metadata endpoints), re-check every redirect, and cap the size.

MAX_FETCH_BYTES = 20_000_000


class FetchError(Exception):
    pass


def host_of(url: str) -> str:
    """The URL's host as ASCII (punycode). httpx's .host decodes IDNA and raises on invalid names."""
    try:
        return httpx.URL(url).raw_host.decode("ascii")
    except Exception:
        return ""


NAT64 = ipaddress.ip_network("64:ff9b::/96")


async def check_public(url: httpx.URL) -> str:
    """Returns a vetted IP to connect to, so a second DNS lookup can't swap in a private one."""
    if url.scheme not in ("http", "https") or not url.raw_host:
        raise FetchError("Only http and https links can be read.")
    if url.port not in (None, 80, 443, 8080, 8443):
        raise FetchError("That port isn't allowed.")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(url.raw_host.decode("ascii"), url.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise FetchError("Couldn't find that site.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip.version == 6 and (ip in NAT64 or int(ip) >> 32 == 0):  # NAT64 and IPv4-compatible forms
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if not ip.is_global or ip.is_multicast:
            raise FetchError("That address isn't on the public internet.")
    return infos[0][4][0].split("%")[0]


async def safe_get(h: httpx.AsyncClient, url: str, timeout: float | None = None, max_bytes: int = MAX_FETCH_BYTES) -> httpx.Response:
    try:
        target = httpx.URL(url)
    except Exception:
        raise FetchError("That doesn't look like a valid link.")
    for _ in range(6):
        ip = await check_public(target)
        # Connect to the vetted IP; Host and TLS SNI (and so certificate checks) still use the real name.
        req = h.build_request("GET", target.copy_with(host=ip), headers={"Host": target.netloc.decode("ascii")},
                              extensions={"sni_hostname": target.raw_host.decode("ascii")}, **({"timeout": timeout} if timeout else {}))
        r = await h.send(req, stream=True, follow_redirects=False)
        try:
            if r.is_redirect and "location" in r.headers:
                target = target.join(r.headers["location"])
                continue
            size = r.headers.get("content-length", "")
            if size.isdigit() and int(size) > max_bytes:
                raise FetchError("That file is too large to read here.")
            body = bytearray()
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > max_bytes:
                    raise FetchError("That file is too large to read here.")
            kept = [(k, v) for k, v in r.headers.multi_items() if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
            return httpx.Response(r.status_code, headers=kept, content=bytes(body), request=httpx.Request("GET", target))
        finally:
            await r.aclose()
    raise FetchError("Too many redirects.")


def fetch_client(**kw) -> httpx.AsyncClient:
    # No pooled connections: two sites on one IP must not share a connection made with the other's SNI.
    return httpx.AsyncClient(headers=UA, limits=httpx.Limits(max_keepalive_connections=0), **kw)


def model_for(mode: str) -> tuple[str, str, dict]:
    if mode == "deep":
        return DEEP_MODEL, cfg["deep_effort"], cfg["deep_extra"]
    return QUICK_MODEL, cfg["quick_effort"], cfg["quick_extra"]


async def complete(messages, mode="quick", stream=False, json_mode=False):
    model, effort, extra = model_for(mode)
    kwargs = {"model": model, "messages": messages, "stream": stream}
    if extra:
        kwargs["extra_body"] = extra
    if effort:
        kwargs["reasoning_effort"] = effort
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    return await client.chat.completions.create(**kwargs)


def numbered(doc) -> str:
    blocks = doc.get("blocks")
    if not blocks:
        return "\n\n".join(f"¶{i + 1} {p}" for i, p in enumerate(doc["paragraphs"]))
    out = []
    for i, b in enumerate(blocks):
        body = b.get("md") or ""
        if b["t"] == "code":
            body = f"```{b.get('lang', '')}\n{body}\n```"
        elif b["t"] == "h":
            lv = b.get("lv")
            body = "#" * (lv if isinstance(lv, int) and 1 <= lv <= 6 else 2) + " " + body
        elif b["t"] == "li":
            body = "- " + body
        elif b["t"] == "img":
            body = f"[Image: {b.get('md') or b.get('alt') or 'no caption'}]"
        out.append(f"¶{i + 1} {body}")
    notes = doc.get("footnotes") or {}
    if notes:
        out.append("FOOTNOTES:\n" + "\n".join(f"[^{k}] {plain(v)}" for k, v in notes.items()))
    return "\n\n".join(out)


# ---------- markdown -> blocks ----------
# Every block is one numbered unit (¶) the reader can select and ask about.
# "md" keeps inline markdown for rendering; the plain text (for the model and Spine) is derived from it.

FENCE = re.compile(r"^\s*+(```|~~~)\s*+([\w+#.-]*+)\s*+$")  # possessive: no backtracking on long lines
HEADING = re.compile(r"^(#{1,6})\s++(.*)$")
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")


def unescape_md(s: str) -> str:
    return re.sub(r"\\([\\`*_{}\[\]()#+\-.!<>|~])", r"\1", s)


def plain(md: str) -> str:
    s = re.sub(r"\[\^[\w-]+\]", "", md)  # footnote markers
    # Bounded spans keep these linear on unclosed markers.
    s = re.sub(r"!\[[^\]]{0,500}\]\([^)]{0,2000}\)", "", s)
    s = re.sub(r"\[([^\]]{1,500})\]\([^)]{0,2000}\)", r"\1", s)
    s = re.sub(r"(\*\*|__|==)(.{1,500}?)\1", r"\2", s)
    s = re.sub(r"(?<![\w*])[*_](\S.{0,500}?\S|\S)[*_](?![\w*])", r"\1", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\\([\\`*_\[\]=~|#])", r"\1", s)  # backslash escapes
    return norm(s)


def md_to_blocks(md: str) -> list[dict]:
    blocks: list[dict] = []
    lines = md.replace("\r\n", "\n").split("\n")
    para: list[str] = []

    def flush():
        if para:
            text = unescape_md(norm(" ".join(para)))
            if len(text) > 1:
                blocks.append({"t": "p", "md": text})
            para.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        fence = FENCE.match(line)
        if fence:
            flush()
            code, i = [], i + 1
            while i < len(lines) and not re.match(r"^\s*(```|~~~)\s*$", lines[i]):
                code.append(lines[i]); i += 1
            blocks.append({"t": "code", "md": "\n".join(code).rstrip("\n"), "lang": fence.group(2).lower()})
            i += 1
            continue
        if not line.strip():
            flush(); i += 1; continue
        h = HEADING.match(line)
        if h:
            flush()
            blocks.append({"t": "h", "md": unescape_md(h.group(2).rstrip().rstrip("#").rstrip()), "lv": len(h.group(1))})
        elif line.lstrip().startswith("|") and line.rstrip().endswith("|"):
            flush()
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(lines[i].strip()); i += 1
            blocks.append({"t": "table", "md": "\n".join(rows)})
            continue
        elif line.lstrip().startswith(">"):
            flush()
            quote = []
            while i < len(lines) and lines[i].lstrip().startswith(">"):
                quote.append(lines[i].lstrip()[1:].strip()); i += 1
            blocks.append({"t": "quote", "md": unescape_md(norm(" ".join(quote)))})
            continue
        else:
            li = LIST_ITEM.match(line)
            if li:
                flush()
                item = [li.group(3)]
                while i + 1 < len(lines) and lines[i + 1].strip() and not LIST_ITEM.match(lines[i + 1]) \
                        and not FENCE.match(lines[i + 1]) and not HEADING.match(lines[i + 1]):
                    i += 1; item.append(lines[i].strip())
                blocks.append({"t": "li", "md": unescape_md(norm(" ".join(item))),
                               "ord": li.group(2)[0].isdigit(), "lv": min(2, len(li.group(1)) // 2)})
            else:
                para.append(line.strip())
        i += 1
    flush()
    return merge_key_values(blocks)


def merge_key_values(blocks: list[dict]) -> list[dict]:
    """'- Author:' followed by '- Sam Gross' (common in metadata lists) becomes one item."""
    out = []
    for b in blocks:
        prev = out[-1] if out else None
        if prev and prev["t"] == "li" == b["t"] and prev["md"].endswith(":") and not b["md"].endswith(":") \
                and len(prev["md"]) < 40 and not prev.get("merged"):
            prev["md"] = f"**{prev['md']}** {b['md']}"
            prev["merged"] = True
            continue
        out.append(b)
    for b in out:
        b.pop("merged", None)
    return out


BLOCK_TYPES = {"p", "h", "li", "code", "quote", "table", "img"}


def paragraphs_of(blocks: list[dict]) -> list[str]:
    def one(b):
        if b["t"] == "code":
            return b["md"]
        if b["t"] == "img":
            return f"[Image: {plain(b.get('md') or b.get('alt') or '')}]"
        return plain(b["md"])
    return [one(b) for b in blocks]


def split_paragraphs(text: str) -> list[str]:
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n|\n", text)]
    return [p for p in paras if len(p) > 1]


# ---------- documents ----------

class TextIn(BaseModel):
    title: str = Field("Untitled", max_length=300)
    text: str = Field(max_length=1_000_000)


def store(title, byline, paragraphs, source=None, blocks=None):
    """Builds a document. Nothing is kept server-side: the browser sends it back with each question."""
    return {"id": uuid.uuid4().hex[:10], "title": title, "byline": byline, "paragraphs": paragraphs, "source": source,
            "blocks": blocks}


def store_md(title, byline, md, source=None):
    blocks = md_to_blocks(md)
    # Drop a leading block that just repeats the title.
    if blocks and norm(plain(blocks[0]["md"])).lower() == norm(title).lower():
        blocks = blocks[1:]
    return store(title, byline, paragraphs_of(blocks), source, blocks)


@app.get("/api/extract", dependencies=[limit("fetch")])
async def extract(url: str):
    async with fetch_client(timeout=20) as h:
        try:
            r = await safe_get(h, url)
            r.raise_for_status()
        except FetchError as e:
            raise HTTPException(400, str(e))
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Couldn't fetch that page: {e}")
    md = trafilatura.extract(r.text, output_format="markdown", include_formatting=True, include_links=False,
                             include_tables=True, include_comments=False, favor_recall=True)
    if not md:
        raise HTTPException(422, "Couldn't find an article on that page.")
    meta = trafilatura.extract_metadata(r.text)
    host = re.sub(r"^www\.", "", host_of(str(r.url)))
    title = clean_title(meta.title, str(r.url), host) if meta and meta.title else url
    return store_md(title, meta.author if meta else None, md, str(r.url))


# Extraction happens in the browser (Mozilla Readability, the Reader View engine): the server only
# fetches the page so the browser isn't blocked by CORS, then stores the blocks the browser built.

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"}


def pdf_to_doc(data: bytes, url: str) -> dict:
    import pymupdf
    import pymupdf4llm
    pdf = pymupdf.open(stream=data, filetype="pdf")
    md = pymupdf4llm.to_markdown(pdf, show_progress=False, ignore_images=True, ignore_graphics=True)
    # Drop text lifted out of figures, and html line breaks the converter leaves behind.
    md = re.sub(r"<!--\s*Start of picture text\s*-->[\s\S]*?<!--\s*End of picture text\s*-->", "", md)
    md = re.sub(r"<!--[\s\S]*?-->", "", md)
    md = re.sub(r"<br\s*/?>", " ", md)
    meta_title = (pdf.metadata or {}).get("title") or ""
    md = re.sub(r"^\s*\*\*(.+?)\*\*\s*$", r"## \1", md, flags=re.M)  # bold-only lines are usually headings
    blocks = md_to_blocks(md)
    title = meta_title.strip()
    if blocks and (len(title) < 6 or title.lower().startswith(("microsoft word", "untitled"))):
        first = next((b for b in blocks[:5] if b["t"] in ("h", "p") and 6 < len(plain(b["md"])) < 200), None)
        title = plain(first["md"]) if first else url.rsplit("/", 1)[-1]
    host = re.sub(r"^www\.", "", host_of(url))
    doc = store_md(title, f"PDF · {host}", md, url)
    return doc


# Some sources have a cleaner form than their web page. Returns a better URL (or raw markdown) to read.
def special_source(url: str):
    try:
        u = httpx.URL(url)
    except Exception:
        return None
    host, path = host_of(url).lower(), u.path
    m = re.match(r"^/(abs|pdf|html)/([\w.\-/]+?)(\.pdf)?/?$", path)
    if host.endswith("arxiv.org") and m:
        return {"kind": "arxiv", "id": m.group(2)}
    if host == "github.com":
        parts = [p for p in path.split("/") if p]
        if len(parts) == 2:
            return {"kind": "md", "urls": [f"https://raw.githubusercontent.com/{parts[0]}/{parts[1]}/HEAD/{n}" for n in ("README.md", "readme.md", "README.rst")],
                    "title": f"{parts[0]}/{parts[1]}"}
        if len(parts) > 4 and parts[2] == "blob" and parts[-1].lower().endswith((".md", ".markdown")):
            return {"kind": "md", "urls": [f"https://raw.githubusercontent.com/{parts[0]}/{parts[1]}/{'/'.join(parts[3:])}"], "title": parts[-1]}
    return None


@app.get("/api/fetch", dependencies=[limit("fetch")])
async def fetch_page(url: str):
    """Returns {"html", "url"} for the browser to extract, or {"doc"} when the server handled it (PDF, markdown)."""
    special = special_source(url)
    async with fetch_client(timeout=30) as h:
        try:
            if special and special["kind"] == "arxiv":
                # arXiv's HTML rendering has real structure and LaTeX alt-text for maths; fall back to the PDF.
                r = await safe_get(h, f"https://arxiv.org/html/{special['id']}")
                if r.status_code != 200 or "ltx_document" not in r.text[:400_000]:
                    r = await safe_get(h, f"https://arxiv.org/pdf/{special['id']}")
            elif special and special["kind"] == "md":
                for raw in special["urls"]:
                    r = await safe_get(h, raw)
                    if r.status_code == 200:
                        return {"doc": store_md(special["title"], f"GitHub · {special['title']}", r.text, url)}
                r = await safe_get(h, url)
            else:
                r = await safe_get(h, url)
            r.raise_for_status()
        except FetchError as e:
            raise HTTPException(400, str(e))
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Couldn't fetch that page: {e}")
    ctype = r.headers.get("content-type", "").lower()
    if "pdf" in ctype or r.content[:5] == b"%PDF-":
        try:
            return {"doc": await asyncio.to_thread(pdf_to_doc, r.content, str(r.url))}
        except ImportError:
            raise HTTPException(415, "PDF support isn't installed on this server.")
        except Exception as e:
            raise HTTPException(422, f"Couldn't read that PDF: {e}")
    if "html" not in ctype and "xml" not in ctype:
        if ctype.startswith("text/"):
            return {"doc": store_md(str(r.url).rsplit("/", 1)[-1], None, r.text, str(r.url))}
        raise HTTPException(415, f"That link isn't a web page ({ctype.split(';')[0] or 'unknown type'}).")
    return {"url": str(r.url), "html": r.text[:2_000_000]}  # stays under serverless response limits (4.5 MB)


@app.post("/api/pdf", dependencies=[limit("fetch")])
async def read_pdf(file: UploadFile = File(...)):
    """A PDF the reader opened from their computer."""
    data = await file.read(4_000_001)
    if len(data) > 4_000_000:
        raise HTTPException(413, "That PDF is over 4 MB. Try a link to it instead, or run Tangent yourself.")
    if data[:5] != b"%PDF-":
        raise HTTPException(415, "That file isn't a PDF.")
    try:
        doc = await asyncio.to_thread(pdf_to_doc, data, file.filename or "document.pdf")
    except ImportError:
        raise HTTPException(415, "PDF support isn't installed on this server.")
    except Exception as e:
        raise HTTPException(422, f"Couldn't read that PDF: {e}")
    doc.update(byline=file.filename, source=None)
    return doc


class DocIn(BaseModel):
    title: str = Field(max_length=500)
    subtitle: str | None = Field(None, max_length=1000)
    byline: str | None = Field(None, max_length=500)
    source: str | None = Field(None, max_length=2000)
    blocks: list[dict] = Field(max_length=5000)
    footnotes: dict[str, str] = {}


@app.post("/api/doc", dependencies=[limit("doc")])
async def save_doc(body: DocIn):
    blocks = [b for b in body.blocks if b.get("t") in BLOCK_TYPES and isinstance(b.get("md"), str)]
    doc = store(body.title, body.byline, paragraphs_of(blocks), body.source, blocks)
    doc["footnotes"] = body.footnotes
    doc["subtitle"] = body.subtitle
    return doc


@app.post("/api/text", dependencies=[limit("doc")])
async def from_text(body: TextIn):
    return store_md(body.title, None, body.text)


# ---------- asking ----------

ASK_SYSTEM = """You are a reading companion writing short notes in the margin of a text the reader is reading.
The full text is below, with paragraphs numbered ¶1, ¶2, ...

Rules:
- Start with one plain sentence that directly answers. Then a blank line, then at most 3 short sentences of useful context.
- Use short sentences and everyday words. No headings. Short lists only when they genuinely help.
- Markdown is rendered: use `inline code` for identifiers and fenced code blocks (```lang) for any code. Keep code examples short.
- Highlight what matters: wrap the 1-3 most important phrases (a few words each, never whole paragraphs) in ==double equals==, e.g. ==only one thread at a time==. The first should be the heart of the direct answer. Never inside code.
- Cite paragraphs like ¶3 when you rely on them.
- If the answer needs knowledge from outside the text, say so briefly ("Outside the text, ...").
- The reader may have misspelled things or used speech-to-text; interpret generously.

TEXT: {title}

{text}"""

KIND_PROMPTS = {
    "explain": 'Explain "{sel}" as used in ¶{p}. What does it mean here, and why does the author say it?',
    "define": 'Define "{sel}" in plain words, as used in ¶{p}. One sentence definition, then one sentence on how it is used here.',
    "simplify": "Rewrite ¶{p} in plain, simple English for a reader who finds dense text hard. Keep every idea; shorter sentences. Output only the rewrite.",
    "ask": 'About ¶{p}{selpart}: {q}',
    "ask_doc": "{q}",
}


class DocBody(BaseModel):
    """The document as the browser holds it, sent back with each request that needs it."""
    title: str = Field("Untitled", max_length=500)
    paragraphs: list[str] = Field([], max_length=5000)  # only sent when there are no blocks
    blocks: list[dict] | None = Field(None, max_length=5000)
    footnotes: dict[str, str] | None = None


MAX_CONTEXT_CHARS = 200_000  # roughly 50k tokens; caps the cost of one question
MAX_HISTORY_CHARS = 40_000


def doc_context(d: DocBody) -> dict:
    # Malformed blocks are dropped rather than failing the question.
    blocks = [b for b in d.blocks or [] if b.get("t") in BLOCK_TYPES and isinstance(b.get("md", ""), str)] or None
    doc = {"title": d.title, "paragraphs": d.paragraphs, "blocks": blocks, "footnotes": d.footnotes or {}}
    text = numbered(doc)
    if len(text) > MAX_CONTEXT_CHARS:
        text = text[:MAX_CONTEXT_CHARS] + "\n\n[The rest of the text is cut off here.]"
    return {"title": d.title[:500], "text": text}


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=20_000)


class AskIn(BaseModel):
    doc: DocBody
    kind: str = Field("ask", pattern="^(explain|define|simplify|ask|ask_doc)$")
    para: int | None = None
    selection: str | None = Field(None, max_length=4000)
    question: str | None = Field(None, max_length=2000)
    mode: str = Field("quick", pattern="^(quick|deep)$")
    history: list[Turn] = Field([], max_length=40)


@app.post("/api/ask", dependencies=[limit("ask")])
async def ask(body: AskIn):
    ctx = doc_context(body.doc)
    sel = (body.selection or "").strip()
    user = KIND_PROMPTS[body.kind].format(
        sel=sel, p=body.para, q=body.question or "",
        selpart=f', the passage "{sel}"' if sel else "")
    messages = [{"role": "system", "content": ASK_SYSTEM.format(**ctx)}]
    history, total = [], 0
    for t in reversed(body.history):  # newest turns first, within a budget
        total += len(t.content)
        if total > MAX_HISTORY_CHARS:
            break
        history.insert(0, t.model_dump())
    messages += history + [{"role": "user", "content": user}]
    model = model_for(body.mode)[0]

    async def gen():
        try:
            stream = await complete(messages, body.mode, stream=True)
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            # \x00 marks an error so the client can render it as a retryable state, not as answer text.
            yield f"\x00{type(e).__name__}: {e}"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8",
                             headers={"X-Model": model, "Cache-Control": "no-cache"})


# ---------- cascaded text ----------

CASCADE_SYSTEM = """You split prose into clauses to make it easier to read for people with dyslexia.
Split the paragraph into chunks that each carry one idea: usually a clause, typically 5-14 words.
Never break a short phrase apart; never make a chunk under 4 words unless the sentence itself is that short. Fewer, fuller chunks beat many tiny ones.
For each chunk give:
- "i": 0 if it starts a sentence or carries the sentence forward; 1 if it is a subordinate or continuing piece (a "which/that/when/because..." clause, an aside, an example). Only 0 or 1.
- "r": "main" if it carries the sentence's core claim (who does what), otherwise "detail" (conditions, examples, asides, elaboration). Every sentence has at least one "main" chunk.
Return JSON: {"units": [{"t": "text", "i": 0, "r": "main"}, ...]}.
The chunks' text, joined with single spaces, MUST reproduce the paragraph exactly, word for word, including punctuation. Never change, add or drop words."""


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


class CascadeIn(BaseModel):
    text: str = Field(max_length=6000)


@app.post("/api/cascade", dependencies=[limit("spine")])
async def cascade(body: CascadeIn):
    key = norm(body.text)
    if key in CASCADE_CACHE:
        return {"units": CASCADE_CACHE[key]}
    resp = await complete([{"role": "system", "content": CASCADE_SYSTEM},
                           {"role": "user", "content": body.text}], "quick", json_mode=True)
    raw = resp.choices[0].message.content or ""
    try:
        units = json.loads(re.sub(r"^```(json)?|```$", "", raw.strip()))["units"]
        units = [{"t": str(u["t"]), "i": max(0, min(1, int(u.get("i", 0)))),
                  "r": "detail" if u.get("r") == "detail" else "main"} for u in units]
    except (ValueError, KeyError, TypeError):
        units = None
    # Faithfulness check: the model must not alter the author's words.
    if not units or norm(" ".join(u["t"] for u in units)) != key:
        units = heuristic_cascade(body.text)
    if len(CASCADE_CACHE) > 5000:
        CASCADE_CACHE.clear()
    CASCADE_CACHE[key] = units
    return {"units": units}


def heuristic_cascade(text: str) -> list[dict]:
    parts = re.split(r"(?<=[;:.!?—])\s+", norm(text))
    return [{"t": p, "i": 0, "r": "main"} for p in parts]


# ---------- pre-reading scaffold ----------

SCAFFOLD_SYSTEM = """You prepare a reader before they read a text, to lower the effort of reading it.
Return JSON: {"gist": "one sentence on what this text is about and what it argues",
 "points": ["3 short bullets: the main moves of the text, in order, each with the ¶ range, e.g. '¶1-3: ...'"],
 "terms": [{"term": "...", "meaning": "plain-words meaning in under 12 words"}]}
Pick 3-6 terms a general reader might stumble on (jargon, acronyms, names). Plain, short words throughout."""


class ScaffoldIn(BaseModel):
    doc: DocBody


@app.post("/api/scaffold", dependencies=[limit("brief")])
async def scaffold(body: ScaffoldIn):
    ctx = doc_context(body.doc)
    resp = await complete([{"role": "system", "content": SCAFFOLD_SYSTEM},
                           {"role": "user", "content": f"TEXT: {ctx['title']}\n\n{ctx['text']}"}],
                          "quick", json_mode=True)
    raw = (resp.choices[0].message.content or "").strip()
    try:
        return json.loads(re.sub(r"^```(json)?|```$", "", raw).strip())
    except ValueError:
        raise HTTPException(502, "The model returned something unreadable. Try again.")


# ---------- compose a reading ----------
# A question becomes a short grounded reading. The "find sources + write" step is pluggable;
# for now Gemini with Google Search grounding does both. Self-hosters could swap in Exa/Brave/SearXNG + any model.

# Primer favours speed: Flash-Lite reliably starts writing in ~2s, while 3.5 Flash's search step
# varied 2-9s in testing. Deep dive favours depth (3.8 Flash, ~4s+).
COMPOSE_MODELS = {"primer": os.environ.get("TANGENT_PRIMER_MODEL", "gemini-3.5-flash-lite"),
                  "deep": os.environ.get("TANGENT_DEEP_DIVE_MODEL", "gemini-3.8-flash")}

LENGTHS = {"primer": "5-6 paragraphs, about 450 words in total",
           "deep": "9-12 paragraphs, about 1000 words in total, with a few '## ' subheadings"}
LEVELS = {
    "plain": "Write for someone who finds reading effortful: short sentences, everyday words, one idea per sentence. Explain any technical term in plain words the first time it appears.",
    "standard": "Write for a curious, intelligent non-specialist. Clear and concrete; define jargon briefly.",
    "expert": "Write for someone who already knows the field. Be precise and dense; skip basics.",
}

COMPOSE_SYSTEM = """You write short, well-sourced readings that answer a question, like a great magazine explainer.
Use web search to ground every factual claim. Prefer specific facts: names, dates, numbers, mechanisms. Where experts disagree, say so.
{level}
Length: {length}.

Output format, exactly:
Line 1: "# " followed by a title of at most 9 words (not the question itself).
Then the body: paragraphs separated by blank lines, mostly prose. For programming topics, include short fenced code examples (```lang) where they make an idea concrete, and use `inline code` for identifiers. For mathematical or physics topics, write formulas in LaTeX: $inline$ and $$display$$ (never code blocks for maths). Only use '## ' subheadings if the length asks for them. No bold, no links, no bullet lists.
After the last paragraph, one final line: "NEXT: " then three short follow-up questions a curious reader might ask next, separated by " | ".
Never mention searching, sources or search results in the text."""


class ComposeIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    length: str = Field("primer", pattern="^(primer|deep)$")
    level: str = Field("standard", pattern="^(plain|standard|expert)$")


def ndjson(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


async def resolve_source(h: httpx.AsyncClient, uri: str, fallback_title: str, with_text: bool = False) -> dict:
    """Grounding links are Google redirects; follow them to the real page and grab its <title>."""
    text = ""
    try:
        r = await safe_get(h, uri, timeout=6, max_bytes=5_000_000)
        url = str(r.url)
        if with_text:
            text = (await asyncio.to_thread(trafilatura.extract, r.text, favor_precision=True) or "")[:2500]
        m = re.search(r"<title[^>]*>(.*?)</title>", r.text[:200_000], re.S | re.I)
        title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
        import html as _html
        title = _html.unescape(title)[:140]
    except (httpx.HTTPError, FetchError):
        url, title = uri, ""
    host = re.sub(r"^www\.", "", host_of(url) or fallback_title)
    out = {"url": url, "title": clean_title(title, url, host), "site": host}
    if with_text:
        out["text"] = text
    return out


JUNK_TITLES = re.compile(r"just a moment|attention required|access denied|403|404|not found|homepage|^home\b|log ?in|sign ?in", re.I)


def clean_title(title: str, url: str, host: str) -> str:
    # Peel trailing " | Site" / " - Site" segments, keep the article's own title intact.
    t = norm(title)
    site_word = host.split(".")[0].lower() if host else ""
    while True:
        m = re.match(r"^(.*\S)\s+[|–—-]\s+([^|–—]{1,40})$", t)
        if not m or not (len(m.group(2)) <= 30 or (site_word and site_word in m.group(2).lower())):
            break
        t = m.group(1)
    if len(t) < 12 or JUNK_TITLES.search(t) or t.lower().replace("www.", "") == host:
        slug = [seg for seg in httpx.URL(url).path.split("/") if seg][-1:] or [""]
        words = re.sub(r"\.\w+$", "", slug[0])
        words = re.sub(r"[-_][0-9a-f]{8,}$", "", words).replace("-", " ").replace("_", " ").strip()  # drop trailing post ids
        t = words[:1].upper() + words[1:] if len(words) > 8 and not words.isdigit() else host
    return t[:140]


def cite_paragraphs(paragraphs: list[str], supports: list[dict]) -> dict[int, list[int]]:
    """Map Gemini's grounding supports (sentence -> chunk indices) onto our paragraphs."""
    cites: dict[int, dict[int, int]] = {}
    for sup in supports:
        seg = plain(sup.get("segment", {}).get("text", ""))
        if not seg:
            continue
        probe = seg[:80]
        for i, p in enumerate(paragraphs):
            if probe in norm(p):
                weight = cites.setdefault(i, {})
                for c in sup.get("groundingChunkIndices", []):
                    weight[c] = weight.get(c, 0) + 1
                break
    # Strongest sources per paragraph first (most supported sentences).
    return {i: sorted(w, key=lambda c: -w[c]) for i, w in cites.items()}


# ---------- write first, sources after ----------
# Evergreen questions don't need a search before writing. OpenAI's Decisions API decides (~130ms;
# 16/16 on a labelled set), Claude writes immediately, a source search runs in parallel, and a cheap
# model then attaches each paragraph's supporting sources and flags anything a source contradicts.

WRITER_MODEL = os.environ.get("TANGENT_WRITER_MODEL", "claude-sonnet-5-5")
SEARCH_INSTRUCTIONS = (
    "Today is {today}. The user wants a short explanatory reading on this topic. Answer yes if writing an accurate reading "
    "needs a fresh web search: recent or ongoing events, anything after 2024, prices, live data, specific products or releases, "
    "or niche people/companies a well-read expert wouldn't know. Answer no for evergreen knowledge (science, history, concepts, how things work).")

ATTRIBUTE_SYSTEM = """You check a written reading against web sources.
For each paragraph, list the sources (by number) that support its main claims: at most 3, strongest first, [] if none do.
Then list claims that a source EXPLICITLY CONTRADICTS (a different number, date, name or conclusion): at most 3.
A claim the sources simply don't mention is NOT a problem: never flag missing support. If nothing is contradicted, return "checks": [].
Return JSON: {"cites": {"1": [2, 4], "2": []}, "checks": [{"p": 3, "claim": "short quote from the paragraph", "note": "what the source says, one sentence"}]}"""


async def needs_search(question: str) -> bool:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return True
    import datetime
    try:
        async with httpx.AsyncClient(timeout=2.5) as h:
            r = await h.post("https://api.openai.com/v1/decisions", headers={"Authorization": f"Bearer {key}"}, json={
                "model": "gpt-6-luna", "input": question,
                "questions": [{"name": "needs_search", "type": "predicate",
                               "instructions": SEARCH_INSTRUCTIONS.format(today=datetime.date.today().isoformat())}]})
            r.raise_for_status()
            return r.json()["answers"][0]["probability"] >= 0.5
    except Exception:
        return True  # when unsure, search first


_anthropic = None


async def writer_stream(system: str, question: str):
    """Text deltas from Claude (no search, thinking off), or DeepSeek when there's no Anthropic key."""
    global _anthropic
    if os.environ.get("ANTHROPIC_API_KEY"):
        from anthropic import AsyncAnthropic
        _anthropic = _anthropic or AsyncAnthropic()
        # between_tools turns thinking off on Sonnet 5.5; a refusal falls back to the search-first path.
        async with _anthropic.messages.stream(
                model=WRITER_MODEL, max_tokens=8000, system=system, messages=[{"role": "user", "content": question}],
                thinking={"type": "between_tools"}, output_config={"effort": "low"}) as stream:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                raise RuntimeError("writer declined")
    else:
        resp = await client.chat.completions.create(
            model=QUICK_MODEL, stream=True, extra_body=cfg["quick_extra"] or None,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": question}])
        async for chunk in resp:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


async def find_sources(question: str, limit: int = 6) -> list[dict]:
    """A quick grounded Gemini call, used only for the sources it finds; returns pages with text."""
    key = os.environ.get("GEMINI_API_KEY")
    req = {"contents": [{"role": "user", "parts": [{"text": f"Give a brief, well-sourced overview of: {question}"}]}],
           "tools": [{"google_search": {}}], "generationConfig": {"thinkingConfig": {"thinkingLevel": "low"}}}
    async with httpx.AsyncClient(timeout=httpx.Timeout(40, connect=8)) as h:
        r = await h.post(f"https://generativelanguage.googleapis.com/v1beta/models/{COMPOSE_MODELS['primer']}:generateContent",
                         headers={"x-goog-api-key": key}, json=req)
        r.raise_for_status()
        cand = (r.json().get("candidates") or [{}])[0]
    chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks", [])[:limit]
    async with fetch_client() as h:
        found = await asyncio.gather(*[resolve_source(h, c["web"]["uri"], c["web"].get("title", "source"), with_text=True) for c in chunks])
    seen, out = set(), []
    for f in found:
        if f["url"] not in seen:
            seen.add(f["url"]); out.append(f)
    return out


async def really_conflicts(claim: str, note: str) -> bool:
    """Second opinion from the Decisions API: is this a genuine contradiction, or just extra detail?"""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return True
    try:
        async with httpx.AsyncClient(timeout=3) as h:
            r = await h.post("https://api.openai.com/v1/decisions", headers={"Authorization": f"Bearer {key}"}, json={
                "model": "gpt-6-luna", "input": f"Claim in the reading: {claim}\nWhat a source says: {note}",
                "questions": [{"name": "conflict", "type": "predicate", "instructions":
                               "Answer yes only if the claim and the source genuinely conflict, i.e. they cannot both be true "
                               "(a different number, date, name or conclusion about the same thing). Answer no if the source "
                               "merely adds detail, is about something slightly different, or is silent on the claim."}]})
            r.raise_for_status()
            return r.json()["answers"][0]["probability"] >= 0.7
    except Exception:
        return False  # don't show a flag we couldn't confirm


async def attribute(paragraphs: list[str], sources: list[dict], blocks: list[dict] | None = None) -> tuple[dict, list]:
    # Only prose is attributed: headings and code don't make claims to cite.
    prose = [i for i in range(len(paragraphs)) if not blocks or blocks[i].get("t") in ("p", "li", "quote")]
    numbered_paras = "\n\n".join(f"¶{i + 1} {paragraphs[i]}" for i in prose)
    numbered_srcs = "\n\n".join(f"[{n + 1}] {s['title']} ({s['site']})\n{s.get('text') or '(no text available)'}" for n, s in enumerate(sources))
    resp = await complete([{"role": "system", "content": ATTRIBUTE_SYSTEM},
                           {"role": "user", "content": f"PARAGRAPHS\n{numbered_paras}\n\nSOURCES\n{numbered_srcs}"}], "quick", json_mode=True)
    try:
        data = json.loads(re.sub(r"^```(json)?|```$", "", (resp.choices[0].message.content or "").strip()).strip())
    except ValueError:
        return {}, []
    n = len(sources)
    cites = {int(k) - 1: [c for c in v if isinstance(c, int) and 1 <= c <= n][:3]
             for k, v in (data.get("cites") or {}).items() if str(k).isdigit() and 0 < int(k) <= len(paragraphs)}
    checks = [{"p": int(c["p"]) - 1, "claim": str(c.get("claim", ""))[:200], "note": str(c.get("note", ""))[:300]}
              for c in (data.get("checks") or [])[:3] if str(c.get("p", "")).isdigit() and int(c["p"]) - 1 in prose]
    verdicts = await asyncio.gather(*[really_conflicts(c["claim"], c["note"]) for c in checks])
    checks = [c for c, ok in zip(checks, verdicts) if ok]
    return {k: v for k, v in cites.items() if v and k in prose}, checks


@app.post("/api/compose", dependencies=[limit("compose")])
async def compose(body: ComposeIn):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise HTTPException(501, "Composing needs GEMINI_API_KEY in .env")
    doc = store(body.question, None, [], blocks=[])
    doc.update(composed=True, question=body.question, length=body.length, level=body.level)
    model = COMPOSE_MODELS.get(body.length, COMPOSE_MODELS["primer"])
    system = COMPOSE_SYSTEM.format(level=LEVELS.get(body.level, LEVELS["standard"]), length=LENGTHS.get(body.length, LENGTHS["primer"]))
    req = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": body.question}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "low"}},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    writer_system = system.replace("Use web search to ground every factual claim.",
                                   "Write from what you know. Be accurate; prefer facts you are confident of.")

    async def grounded_stream(holder: dict):
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=8)) as h:
            async with h.stream("POST", url, headers={"x-goog-api-key": key}, json=req) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"compose failed ({r.status_code}): {(await r.aread())[:200]!r}")
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    cand = (json.loads(line[6:]).get("candidates") or [{}])[0]
                    if cand.get("groundingMetadata"):
                        holder["meta"] = cand["groundingMetadata"]
                    for part in cand.get("content", {}).get("parts", []):
                        if part.get("text") and not part.get("thought"):
                            yield part["text"]

    async def gen():
        yield ndjson({"type": "start", "doc_id": doc["id"]})
        buf, title_done, nxt = "", False, []
        paragraphs = doc["paragraphs"]

        def boundary(text: str) -> int:
            """Index of the first blank line that isn't inside an open ``` fence, or -1."""
            pos = 0
            while (k := text.find("\n\n", pos)) >= 0:
                if len(re.findall(r"^\s*```", text[:k], re.M)) % 2 == 0:
                    return k
                pos = k + 2
            return -1

        def emit_block(text: str, out: list):
            for b in md_to_blocks(text):
                doc["blocks"].append(b)
                paragraphs.append(paragraphs_of([b])[0])
                out.append({"type": "para", "text": paragraphs[-1], "block": b})

        def take_blocks(final=False):
            nonlocal buf, title_done, nxt
            out = []
            while True:
                if not title_done:
                    k = buf.find("\n")
                    if k < 0 and not final:
                        break
                    line, buf = (buf[:k], buf[k + 1:]) if k >= 0 else (buf, "")
                    if line.strip():
                        doc["title"] = line.lstrip("# ").strip()
                        out.append({"type": "title", "title": doc["title"]})
                        title_done = True
                    elif k < 0:
                        break
                    continue
                k = boundary(buf)
                if k < 0:
                    if not final:
                        break
                    block, buf = buf, ""
                else:
                    block, buf = buf[:k], buf[k + 2:]
                block = block.strip()
                if "NEXT:" in block and not block.lstrip().startswith("```"):
                    body_, _, rest = block.partition("NEXT:")
                    nxt = [q.strip() for q in rest.split("|") if q.strip()][:3]
                    block = body_.strip()
                if block:
                    emit_block(block, out)
                if k < 0:
                    break
            return out

        last_partial = ""
        holder: dict = {}

        # Deep dives on evergreen topics are written first; everything else searches first.
        write_first = body.length == "deep" and not await needs_search(body.question)
        yield ndjson({"type": "route", "search": not write_first})
        sources_task = asyncio.create_task(find_sources(body.question)) if write_first else None

        try:
            stream = writer_stream(writer_system, body.question) if write_first else grounded_stream(holder)
            try:
                async for text in stream:
                    buf += text
                    for ev in take_blocks():
                        yield ndjson(ev)
                    # Stream the paragraph being written so the reader sees words as they arrive.
                    pending = buf.strip()
                    if title_done and pending != last_partial and not pending.startswith("NEXT"):
                        last_partial = pending
                        yield ndjson({"type": "partial", "md": pending.split("NEXT:")[0]})
            except Exception:
                if not write_first or paragraphs:
                    raise
                # The writer failed before writing anything: fall back to searching first.
                write_first = False
                sources_task.cancel()
                yield ndjson({"type": "route", "search": True})
                async for text in grounded_stream(holder):
                    buf += text
                    for ev in take_blocks():
                        yield ndjson(ev)
            for ev in take_blocks(final=True):
                yield ndjson(ev)

            checks = []
            if write_first:
                yield ndjson({"type": "phase", "phase": "sourcing"})
                try:
                    found = await sources_task
                    raw, checks = await attribute(paragraphs, found, doc["blocks"]) if found else ({}, [])
                except Exception:
                    found, raw = [], {}
                # Cited sources first (in order of first citation), then the rest as further reading.
                order = []
                for i in sorted(raw):
                    for c in raw[i]:
                        if c - 1 not in order:
                            order.append(c - 1)
                order += [k for k in range(len(found)) if k not in order]
                sources = [{k: v for k, v in found[k].items() if k != "text"} for k in order]
                cites = {i: sorted(order.index(c - 1) + 1 for c in cs) for i, cs in raw.items()}
            else:
                meta = holder.get("meta") or {}
                chunks = meta.get("groundingChunks", [])
                raw = cite_paragraphs(paragraphs, meta.get("groundingSupports", []))
                # Number sources in order of first citation, keep at most 8.
                order = []
                for i in sorted(raw):
                    for c in raw[i]:
                        if c not in order and c < len(chunks):
                            order.append(c)
                order = order[:8]
                async with fetch_client() as h:
                    sources = await asyncio.gather(*[
                        resolve_source(h, chunks[c]["web"]["uri"], chunks[c]["web"].get("title", "source")) for c in order])
                # Up to three markers per paragraph: its strongest sources, shown in number order.
                cites = {i: sorted([order.index(c) + 1 for c in cs if c in order][:3]) for i, cs in raw.items()}
            doc.update(sources=sources, cites=cites, next=nxt, checks=checks, written_first=write_first)
            yield ndjson({"type": "sources", "sources": sources, "cites": cites})
            if checks:
                yield ndjson({"type": "checks", "checks": checks})
            yield ndjson({"type": "next", "questions": nxt})
            yield ndjson({"type": "done", "doc": {k: doc[k] for k in ("id", "title", "paragraphs", "blocks")}})
        except Exception as e:
            if sources_task:
                sources_task.cancel()
            yield ndjson({"type": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache"})


# ---------- voice ----------

TRANSCRIBE_MODEL = os.environ.get("TANGENT_TRANSCRIBE_MODEL", "openai/whisper-large-v3")


@app.post("/api/transcribe", dependencies=[limit("voice")])
async def transcribe(request: Request, file: UploadFile = File(...), prompt: str = Form("")):
    # Multipart posts skip CORS preflight, so refuse ones sent from other sites.
    origin = request.headers.get("origin")
    if origin and host_of(origin) != (request.headers.get("host") or "").split(":")[0]:
        raise HTTPException(403, "Cross-site requests aren't allowed.")
    key = os.environ.get("TOGETHER_API_KEY")
    if not key:
        raise HTTPException(501, "Voice needs TOGETHER_API_KEY in .env")
    audio = await file.read(4_000_001)
    if len(audio) > 4_000_000:
        raise HTTPException(413, "That recording is too long.")
    async with httpx.AsyncClient(timeout=30) as h:
        r = await h.post("https://api.together.xyz/v1/audio/transcriptions",
                         headers={"Authorization": f"Bearer {key}"},
                         data={"model": TRANSCRIBE_MODEL, "prompt": prompt[:800]},
                         files={"file": (file.filename or "question.webm", audio, file.content_type or "audio/webm")})
    if r.status_code != 200:
        raise HTTPException(502, f"Transcription failed: {r.text[:200]}")
    return {"text": r.json().get("text", "").strip()}


@app.get("/api/config")
async def config():
    return {"provider": PROVIDER, "quick": QUICK_MODEL, "deep": DEEP_MODEL}


# Locally the server also serves the page. On Vercel, public/ is served by the CDN instead (and must not be mounted).
if (ROOT / "public").is_dir() and not os.environ.get("VERCEL"):
    app.mount("/", StaticFiles(directory=ROOT / "public", html=True), name="public")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 4317)))
