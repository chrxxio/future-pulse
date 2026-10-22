#!/usr/bin/env python3
"""Test helper: a local stand-in for Yahoo's chart endpoint, serving sample fixtures.
The first request for each path answers 429 to exercise the retry logic.
Usage: python3 scripts/mock_yahoo.py FIXTURE_DIR PORT"""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl, urlencode

FIX = Path(sys.argv[1])
seen = set()


def fixture_name(url):
    return re.sub(r"[^a-zA-Z0-9._=-]+", "_", re.sub(r"^https?://", "", url))[:180]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/v1/test/getcrumb":
            return self.send(200, b"testcrumb", "text/plain")
        if not u.path.startswith("/v8/finance/chart/"):
            return self.send(404, b"not found", "text/plain")
        q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k != "crumb"]
        # rebuild the URL exactly as scripts/lib/market.mjs writes it
        url = "https://query1.finance.yahoo.com" + u.path + "?" + urlencode(q)
        if os.environ.get("MOCK_ALWAYS_429"):
            return self.send(429, b"Too Many Requests", "text/plain")
        if self.path not in seen:
            seen.add(self.path)
            return self.send(429, b"Too Many Requests", "text/plain")
        f = FIX / fixture_name(url)
        if not f.exists():
            return self.send(404, b'{"chart":{"result":null,"error":{"description":"No data found"}}}', "application/json")
        return self.send(200, f.read_bytes(), "application/json")

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
