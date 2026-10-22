#!/usr/bin/env python3
"""Fetch price data from GitHub's servers the way a browser does.

Yahoo (and Stooq) answer many plain server-side requests with HTTP 429 / 403.
curl_cffi connects with Chrome's TLS fingerprint and keeps cookies, which is what
those sites expect from a real visitor. That helps on some days and some server
IPs, not all, so this script gives up quickly once a site is clearly blocking us
(it never stalls the update), and the app falls back to the price relay or to the
last good data.

Saves one file per series into out_dir; scripts/lib/market.mjs reads them.
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
STOOQ = os.environ.get("STOOQ_BASE", "https://stooq.com")
GAP = float(os.environ.get("YF_GAP_SECONDS", "0.6"))   # pause between requests
BLOCK_AFTER = 3                                         # consecutive refusals before giving up on a site

try:
    from curl_cffi import requests as http  # browser TLS fingerprint
    SESSION = http.Session(impersonate="chrome")
    MODE = "curl_cffi chrome"
except Exception:
    import requests as http  # type: ignore
    SESSION = http.Session()
    SESSION.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    MODE = "requests"


def safe(name):
    return re.sub(r"[^A-Za-z0-9._=-]+", "_", name)


def key(symbol, rng, interval):
    return safe(f"{symbol}_{rng}_{interval}") + ".json"


class Site:
    """Tracks refusals so a blocked site is abandoned after a few tries."""
    def __init__(self, name):
        self.name, self.refused, self.blocked, self.last = name, 0, False, ""

    def note(self, ok, msg=""):
        if ok:
            self.refused = 0
        else:
            self.last = msg
            if re.search(r"HTTP (403|429|401)", msg):
                self.refused += 1
                self.blocked = self.refused >= BLOCK_AFTER


def get(url, **kw):
    return SESSION.get(url, timeout=kw.pop("timeout", 20), **kw)


def warm_up():
    try:
        get(COOKIE_URL, timeout=10, allow_redirects=True)
    except Exception:
        pass
    for host in HOSTS:
        try:
            r = get(f"{host}/v1/test/getcrumb", timeout=10)
            if r.status_code == 200 and r.text and "<" not in r.text and len(r.text) < 40:
                return r.text.strip()
        except Exception:
            pass
    return ""


def fetch_chart(site, symbol, rng, interval, crumb):
    for host in HOSTS:
        if site.blocked:
            return None
        url = f"{host}/v8/finance/chart/{quote(symbol)}?range={rng}&interval={interval}&includePrePost=true&events=div%2Csplits"
        if crumb:
            url += f"&crumb={quote(crumb)}"
        for attempt in range(2):
            try:
                r = get(url, headers={"Accept": "application/json,text/plain,*/*"})
                if r.status_code == 200:
                    data = r.json()
                    if data.get("chart", {}).get("result"):
                        site.note(True)
                        return r.text
                    site.note(False, (data.get("chart", {}).get("error") or {}).get("description", "empty chart"))
                    break
                site.note(False, f"HTTP {r.status_code}")
                if r.status_code == 429 and attempt == 0 and not site.blocked:
                    time.sleep(2 + random.random() * 2)
                    continue
                break
            except Exception as e:
                site.note(False, str(e)[:120])
                break
    return None


def fetch_stooq(site, sym, out, now):
    """Daily history + latest quote from Stooq, saved as CSV."""
    jobs = [(f"{STOOQ}/q/d/l/?s={sym}&i=d", out / safe(f"stooq_{sym}_d.csv"), 60, "Date,"),
            (f"{STOOQ}/q/l/?s={sym}&f=sd2t2ohlcv&h&e=csv", out / safe(f"stooq_{sym}_q.csv"), 0, "Symbol,")]
    got = 0
    for url, f, keep_min, head in jobs:
        if keep_min and f.exists() and now - f.stat().st_mtime < keep_min * 60:
            got += 1
            continue
        if site.blocked:
            break
        try:
            r = get(url, headers={"Accept": "text/csv,*/*"})
            if r.status_code == 200 and r.text.lstrip().startswith(head):
                f.write_text(r.text)
                site.note(True)
                got += 1
            else:
                site.note(False, f"HTTP {r.status_code}" if r.status_code != 200 else "not CSV (limit or no data)")
        except Exception as e:
            site.note(False, str(e)[:120])
        time.sleep(GAP)
    return got


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    origin_file = out / "_origin.json"
    try:
        origin = json.loads(origin_file.read_text())
    except Exception:
        origin = {}
    yahoo, stooq = Site("Yahoo"), Site("Stooq")
    report = {"mode": MODE, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ok": 0, "cached": 0, "failed": 0, "items": []}
    crumb = warm_up()
    now = time.time()
    missing = []  # instruments Yahoo could not supply
    for item in plan["instruments"] + plan["macro"]:
        done = False
        # fresh data from the price relay (your computer)? then don't spend requests on it
        relay_ok = any(origin.get(key(sym, *item["series"][-1][:2])) == "relay"
                       and (out / key(sym, *item["series"][-1][:2])).exists()
                       and now - (out / key(sym, *item["series"][-1][:2])).stat().st_mtime < 20 * 60
                       for sym in item["symbols"])
        if relay_ok:
            report["cached"] += 1
            continue
        for symbol in item["symbols"]:
            all_ok = True
            for rng, interval, keep_min in item["series"]:
                f = out / key(symbol, rng, interval)
                if keep_min and f.exists() and now - f.stat().st_mtime < keep_min * 60:
                    report["cached"] += 1
                    continue
                text = fetch_chart(yahoo, symbol, rng, interval, crumb) if not yahoo.blocked else None
                time.sleep(GAP + random.random() * GAP)
                if text is None:
                    report["failed"] += 1
                    all_ok = False
                    break
                f.write_text(text)
                origin[f.name] = "browser-style fetch"
                report["ok"] += 1
            if all_ok:
                done = True
                break
        if not done and item.get("stooq"):
            missing.append(item)
    for item in missing:
        n = fetch_stooq(stooq, item["stooq"], out, now)
        report["items"].append({"id": item["id"], "stooq": n})
    report["yahoo"] = {"blocked": yahoo.blocked, "lastError": yahoo.last}
    report["stooq"] = {"tried": len(missing), "blocked": stooq.blocked, "lastError": stooq.last}
    report["lastError"] = yahoo.last
    origin_file.write_text(json.dumps(origin))
    (out / "_report.json").write_text(json.dumps(report, indent=1))
    print(f"[prices] mode={MODE} crumb={'yes' if crumb else 'no'} fetched={report['ok']} cached={report['cached']} failed={report['failed']}"
          f" yahoo_blocked={yahoo.blocked} ({yahoo.last or 'ok'}) stooq_tried={len(missing)} stooq_blocked={stooq.blocked} ({stooq.last or 'ok'})")


if __name__ == "__main__":
    main()
