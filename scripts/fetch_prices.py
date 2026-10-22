#!/usr/bin/env python3
"""Fetch Yahoo Finance chart data the way a browser does.

Yahoo answers many plain server-side requests (including GitHub's) with HTTP 429.
curl_cffi connects with Chrome's TLS fingerprint and keeps Yahoo's cookies, which is
what Yahoo expects from a real visitor. Results are saved as one JSON file per
(symbol, range, interval); scripts/lib/market.mjs reads them (PRICE_CACHE_DIR).

Usage: python3 scripts/fetch_prices.py plan.json out_dir
"""
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

HOSTS = os.environ.get("YF_HOSTS", "https://query1.finance.yahoo.com,https://query2.finance.yahoo.com").split(",")
COOKIE_URL = os.environ.get("YF_COOKIE_URL", "https://fc.yahoo.com")
GAP = float(os.environ.get("YF_GAP_SECONDS", "0.6"))  # pause between requests

try:
    from curl_cffi import requests as http  # browser TLS fingerprint
    SESSION = http.Session(impersonate="chrome")
    MODE = "curl_cffi chrome"
except Exception:  # still works from a home connection without it
    import requests as http  # type: ignore
    SESSION = http.Session()
    SESSION.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    MODE = "requests"


def key(symbol, rng, interval):
    return re.sub(r"[^A-Za-z0-9._=-]+", "_", f"{symbol}_{rng}_{interval}") + ".json"


def warm_up():
    """Visit Yahoo first so the session carries the cookies a browser would have."""
    try:
        SESSION.get(COOKIE_URL, timeout=10, allow_redirects=True)
    except Exception:
        pass
    for host in HOSTS:
        try:
            r = SESSION.get(f"{host}/v1/test/getcrumb", timeout=10)
            if r.status_code == 200 and r.text and "<" not in r.text and len(r.text) < 40:
                return r.text.strip()
        except Exception:
            pass
    return ""


def fetch_chart(symbol, rng, interval, crumb, report):
    last_err = ""
    for host in HOSTS:
        url = f"{host}/v8/finance/chart/{quote(symbol)}?range={rng}&interval={interval}&includePrePost=true&events=div%2Csplits"
        if crumb:
            url += f"&crumb={quote(crumb)}"
        for attempt in range(2):
            try:
                r = SESSION.get(url, timeout=20, headers={"Accept": "application/json,text/plain,*/*"})
                status = r.status_code
                if status == 200:
                    data = r.json()
                    if data.get("chart", {}).get("result"):
                        return r.text
                    last_err = (data.get("chart", {}).get("error") or {}).get("description", "empty chart")
                    break
                last_err = f"HTTP {status}"
                if status == 429:
                    time.sleep(2.5 + random.random() * 2.5)
                    continue
                break
            except Exception as e:  # network error, bad JSON
                last_err = str(e)[:120]
                break
    report["lastError"] = last_err
    return None


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    report = {"mode": MODE, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ok": 0, "cached": 0, "failed": 0, "items": []}
    crumb = warm_up()
    report["crumb"] = bool(crumb)
    now = time.time()
    for item in plan["instruments"] + plan["macro"]:
        for symbol in item["symbols"]:
            all_ok = True
            for rng, interval, keep_min in item["series"]:
                f = out / key(symbol, rng, interval)
                if keep_min and f.exists() and now - f.stat().st_mtime < keep_min * 60:
                    report["cached"] += 1
                    continue
                text = fetch_chart(symbol, rng, interval, crumb, report)
                time.sleep(GAP + random.random() * GAP)
                if text is None:
                    report["failed"] += 1
                    report["items"].append({"id": item["id"], "symbol": symbol, "series": f"{rng}/{interval}", "ok": False, "error": report.get("lastError", "")})
                    all_ok = False
                    break
                f.write_text(text)
                report["ok"] += 1
            if all_ok:
                break
    (out / "_report.json").write_text(json.dumps(report, indent=1))
    print(f"[prices] mode={MODE} crumb={'yes' if crumb else 'no'} fetched={report['ok']} cached={report['cached']} failed={report['failed']}"
          + (f" last_error={report.get('lastError')}" if report["failed"] else ""))


if __name__ == "__main__":
    main()
