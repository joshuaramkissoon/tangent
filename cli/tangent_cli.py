#!/usr/bin/env python3
"""tangent: open a markdown file in Tangent.

    tangent                   open Tangent in your browser
    tangent NOTES.md          read it locally; the page reloads when the file changes
    tangent --web NOTES.md    open it on the hosted site instead, packed into the link
    tangent https://...       read a web page
    cat NOTES.md | tangent -  read from stdin
    tangent --update          update this command

No API keys needed: questions go to the hosted Tangent (or TANGENT_URL, e.g. your own deployment).
Local mode runs a small server on 127.0.0.1 that serves the file, any images next to it, and passes
everything else through to Tangent. It stops on its own a minute after the tab is closed.
"""
from __future__ import annotations

import argparse
import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from pathlib import Path

VERSION = "0.2.0"
SOURCE = "https://raw.githubusercontent.com/joshuaramkissoon/tangent/main/cli/tangent_cli.py"
UPSTREAM = os.environ.get("TANGENT_URL", "https://tangentially.vercel.app").rstrip("/")
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif"}
MAX_WEB_LINK = 400_000  # characters; longer links get unreliable, so fall back to local mode
IDLE_EXIT = 60  # seconds without an open tab before the local server stops


def web_link(text: str, name: str) -> str:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)  # raw deflate, which the browser's DecompressionStream reads
    packed = base64.urlsafe_b64encode(c.compress(text.encode()) + c.flush()).decode().rstrip("=")
    return f"{UPSTREAM}/#md={packed}&name={urllib.parse.quote(name)}"


class Doc:
    def __init__(self, path: Path | None, text: str | None = None):
        self.path, self.static_text = path, text
        self.version = 0
        self.mtime = self._mtime()

    @property
    def name(self):
        return self.path.name if self.path else "stdin"

    def _mtime(self):
        try:
            return self.path.stat().st_mtime_ns if self.path else 0
        except OSError:
            return 0

    def text(self):
        return self.static_text if self.path is None else self.path.read_text(errors="replace")

    def poll(self):
        m = self._mtime()
        if m and m != self.mtime:
            self.mtime = m
            self.version += 1


def make_handler(doc: Doc, port: int, state: dict):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"  # close after each response, so streamed answers need no framing

        def log_message(self, *a):
            pass

        def allowed(self):
            # Only this machine's browser, by name: blocks DNS-rebinding pages from reading the file.
            if self.headers.get("Host") not in hosts:
                self.send_error(403)
                return False
            return True

        def send_body(self, code, ctype, body: bytes, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed():
                return
            path = urllib.parse.urlsplit(self.path).path
            if path == "/_local/doc":
                return self.send_body(200, "application/json", json.dumps(
                    {"name": doc.name, "text": doc.text(), "version": doc.version, "live": doc.path is not None}).encode())
            if path == "/_local/events":
                return self.events()
            if doc.path and Path(path).suffix.lower() in IMAGE_TYPES and self.local_image(path):
                return
            self.proxy()

        def do_POST(self):
            if self.allowed():
                self.proxy()

        def local_image(self, path: str) -> bool:
            # Relative images in the markdown (![](figs/a.png)) resolve against the page root, so serve
            # image files from the document's folder, and nothing outside it.
            base = doc.path.parent.resolve()
            target = (base / urllib.parse.unquote(path).lstrip("/")).resolve()
            if base not in target.parents or not target.is_file():
                return False
            self.send_body(200, IMAGE_TYPES[target.suffix.lower()], target.read_bytes(),
                           {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})
            return True

        def events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            state["tabs"] += 1
            seen = doc.version
            try:
                while True:
                    if doc.version != seen:
                        seen = doc.version
                        self.wfile.write(f"event: change\ndata: {seen}\n\n".encode())
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    time.sleep(0.4)
            except OSError:
                pass
            finally:
                state["tabs"] -= 1
                state["last_seen"] = time.monotonic()

        def proxy(self):
            body = None
            if self.command == "POST":
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            headers = {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "accept")}
            req = urllib.request.Request(UPSTREAM + self.path, data=body, headers=headers, method=self.command)
            try:
                resp = urllib.request.urlopen(req, timeout=120)
            except urllib.error.HTTPError as e:
                resp = e
            except (urllib.error.URLError, OSError) as e:
                return self.send_body(502, "application/json", json.dumps({"detail": f"Couldn't reach Tangent: {e}"}).encode())
            with resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in ("content-type", "x-model", "cache-control"):
                        self.send_header(k, v)
                self.end_headers()
                try:
                    while chunk := resp.read1(16384):  # pass streamed answers through as they arrive
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except OSError:
                    pass

    return Handler


def serve(doc: Doc, port_out=None, open_browser=True):
    state = {"tabs": 0, "last_seen": time.monotonic()}
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a: None)
    port = srv.server_address[1]
    srv.RequestHandlerClass = make_handler(doc, port, state)
    srv.daemon_threads = True
    url = f"http://127.0.0.1:{port}/?local"
    if port_out:
        port_out(url)
    if open_browser:
        webbrowser.open(url)

    def watch():
        while True:
            time.sleep(0.4)
            doc.poll()
            if state["tabs"] == 0 and time.monotonic() - state["last_seen"] > IDLE_EXIT:
                srv.shutdown()
                return

    threading.Thread(target=watch, daemon=True).start()
    srv.serve_forever()


def update():
    me = Path(__file__).resolve()
    if "site-packages" in me.parts:
        sys.exit("tangent: installed as a package; update it with the tool you installed it with "
                 "(e.g. uv tool upgrade tangent-cli).")
    try:
        new = urllib.request.urlopen(SOURCE, timeout=20).read()
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"tangent: couldn't download the update: {e}")
    if not new.startswith(b"#!/usr/bin/env python3"):
        sys.exit("tangent: the download didn't look right; nothing changed.")
    tmp = me.with_suffix(".new")
    tmp.write_bytes(new)
    tmp.chmod(0o755)
    tmp.replace(me)
    print("tangent is up to date.")


def main():
    ap = argparse.ArgumentParser(prog="tangent", description="Open a markdown file (or a link) in Tangent.")
    ap.add_argument("target", nargs="?", help="a markdown file, a URL, or - for stdin (nothing opens Tangent)")
    ap.add_argument("--web", action="store_true", help="open on the hosted site, with the file packed into the link")
    ap.add_argument("--foreground", action="store_true", help="keep the local server attached to this terminal")
    ap.add_argument("--update", action="store_true", help="update the tangent command to the latest version")
    ap.add_argument("--version", action="version", version=f"tangent {VERSION}")
    ap.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.update:
        return update()
    if not args.target:
        webbrowser.open(UPSTREAM)
        print(f"Opened {UPSTREAM}")
        return

    if args.target.startswith(("http://", "https://")):
        webbrowser.open(f"{UPSTREAM}/?url={urllib.parse.quote(args.target, safe='')}")
        return

    if args.target == "-":
        text, path = sys.stdin.read(), None
        if args.serve:  # the parent passes stdin's text on as JSON
            text = json.loads(text)["text"]
    else:
        path = Path(args.target).expanduser().resolve()
        if not path.is_file():
            sys.exit(f"tangent: no such file: {args.target}")
        text = None

    if args.serve:  # the detached child: report the URL to the parent, then serve until idle
        doc = Doc(path, text)

        def report(url):
            print(url, flush=True)
            sys.stdout = open(os.devnull, "w")
        serve(doc, report)
        return

    name = path.name if path else "stdin"
    if args.web:
        link = web_link(text if path is None else path.read_text(errors="replace"), name)
        if len(link) <= MAX_WEB_LINK:
            webbrowser.open(link)
            print(f"Opened {name} on {urllib.parse.urlsplit(UPSTREAM).netloc}")
            return
        print(f"{name} is too long to pack into a link; reading it locally instead.", file=sys.stderr)

    if args.foreground:
        print(f"Reading {name} in Tangent. Ctrl-C to stop.")
        try:
            serve(Doc(path, text), lambda url: print(url))
        except KeyboardInterrupt:
            pass
        return

    child = subprocess.Popen([sys.executable, os.path.abspath(__file__), str(path or "-"), "--serve"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, text=True)
    if path is None:
        child.stdin.write(json.dumps({"text": text}) + "\n")
        child.stdin.flush()
    child.stdin.close()
    url = child.stdout.readline().strip()
    if not url:
        sys.exit("tangent: couldn't start the local reader")
    live = " (reloads when the file changes)" if path else ""
    print(f"Reading {name} in Tangent{live}: {url}")


if __name__ == "__main__":
    main()
