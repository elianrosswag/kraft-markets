#!/usr/bin/env python3
"""
KRAFT Markets — data collector.

Runs on a schedule in GitHub Actions (see .github/workflows/collect.yml).
Each run:
  1. calls a set of free, keyless market-data APIs ("sources")
  2. keeps the last good result of any source that fails ("carry forward")
  3. derives cross-source metrics (average funding, correlations, ...)
  4. writes three files the frontend and the desk display read:
       data/latest.json   full snapshot for the dashboard
       data/history.json  our own hourly time series (grows over time)
       data/cyd.json      tiny payload for the ESP32 "Cheap Yellow Display"

Standard library only: no pip install, nothing third-party to trust or update.
Run locally with:  python3 collector/collect.py
"""

import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
USER_AGENT = "kraft-markets/1.0 (+https://markets.elian.ink)"

HISTORY_DAYS = 90            # how much of our own history to keep
HISTORY_STEP_S = 55 * 60     # add at most one history row per ~hour

ASSETS = [  # CoinGecko id, ticker, display name
    ("bitcoin", "BTC", "Bitcoin"),
    ("ethereum", "ETH", "Ether"),
    ("solana", "SOL", "Solana"),
    ("ripple", "XRP", "XRP"),
]
PERPS = ["BTC", "ETH", "SOL"]
MACRO = [  # Yahoo symbol, key, label
    ("^GSPC", "SPX", "S&P 500"),
    ("^NDX", "NDX", "Nasdaq 100"),
    ("DX-Y.NYB", "DXY", "US Dollar Index"),
    ("^TNX", "US10Y", "US 10Y yield"),
    ("GC=F", "GOLD", "Gold"),
    ("^VIX", "VIX", "VIX"),
]


# ───────────────────────────── HTTP helpers ─────────────────────────────

def http(url, method="GET", body=None, retries=3, timeout=25, as_json=True):
    """GET/POST with retries and polite back-off. Raises RuntimeError on failure."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    last = "unknown error"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8")
                return json.loads(raw) if as_json else raw
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 429 or e.code >= 500:
                time.sleep((attempt + 1) * (6 if e.code == 429 else 2))
                continue
            raise RuntimeError(last)
        except Exception as e:  # timeouts, DNS, bad JSON
            last = f"{type(e).__name__}: {e}"
            time.sleep((attempt + 1) * 2)
    raise RuntimeError(last)


def num(x):
    """Parse API numbers that may arrive as strings or nulls."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def pct(a, b):
    """Percent change from b to a."""
    if a is None or b in (None, 0):
        return None
    return (a / b - 1) * 100


def thin(points, n):
    """Keep at most n evenly spaced points (always keeps the last one)."""
    if len(points) <= n:
        return points
    step = len(points) / n
    out = [points[int(i * step)] for i in range(n - 1)]
    out.append(points[-1])
    return out


def r(x, d=2):
    return None if x is None else round(x, d)


# ─────────────────────────────── Sources ────────────────────────────────
# Each source returns a JSON-serialisable dict, or raises on failure.

def src_coingecko():
    ids = ",".join(a[0] for a in ASSETS)
    url = ("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd"
           f"&ids={ids}&sparkline=true&price_change_percentage=24h,7d,30d")
    rows = http(url)
    by_id = {row["id"]: row for row in rows}
    assets = {}
    for cg_id, sym, name in ASSETS:
        row = by_id.get(cg_id)
        if not row:
            continue
        spark = (row.get("sparkline_in_7d") or {}).get("price") or []
        assets[sym] = {
            "name": name,
            "price": num(row.get("current_price")),
            "chg24": r(num(row.get("price_change_percentage_24h_in_currency"))),
            "chg7d": r(num(row.get("price_change_percentage_7d_in_currency"))),
            "chg30d": r(num(row.get("price_change_percentage_30d_in_currency"))),
            "mcap": num(row.get("market_cap")),
            "vol24": num(row.get("total_volume")),
            "spark7d": [r(p, 6) for p in thin(spark, 84)],  # hourly → ~2-hourly
        }
    if not assets:
        raise RuntimeError("no assets in response")
    return {"assets": assets}


def src_coingecko_global():
    g = http("https://api.coingecko.com/api/v3/global")["data"]
    return {
        "total_mcap": num(g["total_market_cap"]["usd"]),
        "total_vol": num(g["total_volume"]["usd"]),
        "mcap_chg24": r(num(g.get("market_cap_change_percentage_24h_usd"))),
        "btc_dom": r(num(g["market_cap_percentage"].get("btc"))),
        "eth_dom": r(num(g["market_cap_percentage"].get("eth"))),
    }


DERIBIT = "https://www.deribit.com/api/v2/public/"
FUTURE_RE = re.compile(r"^[A-Z]+-(\d{1,2}[A-Z]{3}\d{2})$")


def src_deribit():
    now = time.time()
    out = {}
    for cur in ("BTC", "ETH"):
        t = http(f"{DERIBIT}ticker?instrument_name={cur}-PERPETUAL")["result"]
        index = num(t.get("index_price"))
        f8 = num(t.get("funding_8h"))

        # Futures term structure: annualised premium of each dated future over spot index
        futs = http(f"{DERIBIT}get_book_summary_by_currency?currency={cur}&kind=future")["result"]
        curve = []
        for f in futs:
            m = FUTURE_RE.match(f.get("instrument_name", ""))
            mark = num(f.get("mark_price"))
            if not m or not mark or not index:
                continue
            expiry = dt.datetime.strptime(m.group(1), "%d%b%y").replace(
                hour=8, tzinfo=dt.timezone.utc)
            days = (expiry.timestamp() - now) / 86400
            if days < 2:  # too close to expiry: annualising amplifies noise
                continue
            curve.append({
                "instrument": f["instrument_name"],
                "expiry": expiry.date().isoformat(),
                "days": round(days, 1),
                "basis": r((mark / index - 1) * 365 / days * 100),
                "oi_usd": num(f.get("open_interest")),
            })
        curve.sort(key=lambda c: c["days"])

        # DVOL: Deribit's 30-day implied volatility index, hourly for 30 days
        end_ms = int(now * 1000)
        start_ms = end_ms - 30 * 86400 * 1000
        dv = http(f"{DERIBIT}get_volatility_index_data?currency={cur}"
                  f"&start_timestamp={start_ms}&end_timestamp={end_ms}&resolution=3600")["result"]
        candles = sorted(dv.get("data") or [], key=lambda c: c[0])
        series = [[int(c[0] / 1000), r(num(c[4]))] for c in candles if num(c[4]) is not None]
        dvol_now = series[-1][1] if series else None
        day_ago = next((v for ts, v in reversed(series) if ts <= now - 86400), None)

        # Options positioning: put/call open-interest ratio
        opts = http(f"{DERIBIT}get_book_summary_by_currency?currency={cur}&kind=option")["result"]
        puts = sum(num(o.get("open_interest")) or 0 for o in opts if o["instrument_name"].endswith("-P"))
        calls = sum(num(o.get("open_interest")) or 0 for o in opts if o["instrument_name"].endswith("-C"))

        out[cur] = {
            "index": index,
            "funding_ann": r(f8 * 3 * 365 * 100) if f8 is not None else None,
            "perp_oi_usd": num(t.get("open_interest")),  # inverse perp: OI is in USD
            "futures_oi_usd": sum(c["oi_usd"] or 0 for c in curve) or None,
            "curve": curve,
            "dvol": dvol_now,
            "dvol_chg24": r(dvol_now - day_ago) if dvol_now is not None and day_ago is not None else None,
            "dvol_series": thin(series, 180),
            "pcr_oi": r(puts / calls, 3) if calls else None,
            "options_oi": r((puts + calls) * (index or 0)) if index else None,
        }
        time.sleep(0.3)
    return out


def src_hyperliquid():
    meta, ctxs = http("https://api.hyperliquid.xyz/info", method="POST",
                      body={"type": "metaAndAssetCtxs"})
    out = {}
    for asset, ctx in zip(meta["universe"], ctxs):
        name = asset.get("name")
        if name not in PERPS:
            continue
        mark = num(ctx.get("markPx"))
        f1h = num(ctx.get("funding"))  # Hyperliquid funds hourly
        oi = num(ctx.get("openInterest"))
        out[name] = {
            "mark": mark,
            "funding_ann": r(f1h * 24 * 365 * 100) if f1h is not None else None,
            "oi_usd": r(oi * mark) if oi is not None and mark else None,
            "vol24_usd": num(ctx.get("dayNtlVlm")),
        }
    if not out:
        raise RuntimeError("no perps found")
    return out


def src_okx():
    out = {}
    for sym in PERPS:
        inst = f"{sym}-USDT-SWAP"
        fr = http(f"https://www.okx.com/api/v5/public/funding-rate?instId={inst}")["data"][0]
        rate = num(fr.get("fundingRate"))
        a, b = num(fr.get("fundingTime")), num(fr.get("nextFundingTime"))
        hours = (b - a) / 3.6e6 if a and b and b > a else 8.0
        oi = http(f"https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId={inst}")["data"][0]
        out[sym] = {
            "funding_ann": r(rate * (24 / hours) * 365 * 100) if rate is not None else None,
            "interval_h": r(hours, 1),
            "oi_usd": num(oi.get("oiUsd")),
        }
        time.sleep(0.2)
    return out


def src_stablecoins():
    data = http("https://stablecoins.llama.fi/stablecoins?includePrices=false")
    usd = [a for a in data["peggedAssets"] if a.get("pegType") == "peggedUSD"]

    def circ(a, key):
        return num((a.get(key) or {}).get("peggedUSD")) or 0

    total = sum(circ(a, "circulating") for a in usd)
    prev_w = sum(circ(a, "circulatingPrevWeek") for a in usd)
    prev_m = sum(circ(a, "circulatingPrevMonth") for a in usd)
    usd.sort(key=lambda a: circ(a, "circulating"), reverse=True)
    top = [{
        "symbol": a.get("symbol"),
        "supply": circ(a, "circulating"),
        "chg7d": r(pct(circ(a, "circulating"), circ(a, "circulatingPrevWeek"))),
        "share": r(circ(a, "circulating") / total * 100) if total else None,
    } for a in usd[:5]]

    chart = http("https://stablecoins.llama.fi/stablecoincharts/all")
    series = [[int(p["date"]), r(num((p.get("totalCirculatingUSD") or {}).get("peggedUSD")), 0)]
              for p in chart[-91:]]
    return {
        "total": total,
        "chg7d": r(pct(total, prev_w)),
        "chg30d": r(pct(total, prev_m)),
        "abs7d": total - prev_w if prev_w else None,
        "top": top,
        "series": series,
    }


def src_tvl():
    pts = http("https://api.llama.fi/v2/historicalChainTvl")
    series = [[int(p["date"]), r(num(p["tvl"]), 0)] for p in pts[-91:]]
    now_v = series[-1][1]
    return {
        "total": now_v,
        "chg7d": r(pct(now_v, series[-8][1])) if len(series) > 8 else None,
        "chg30d": r(pct(now_v, series[-31][1])) if len(series) > 31 else None,
        "series": series,
    }


def src_mempool():
    base = "https://mempool.space/api/"
    hr = http(base + "v1/mining/hashrate/1m")
    fees = http(base + "v1/fees/recommended")
    diff = http(base + "v1/difficulty-adjustment")
    height = int(http(base + "blocks/tip/height", as_json=False).strip())
    series = [[int(p["timestamp"]), r(num(p["avgHashrate"]) / 1e18, 1)] for p in hr.get("hashrates", [])]
    return {
        "height": height,
        "hashrate_eh": r(num(hr.get("currentHashrate")) / 1e18, 1) if hr.get("currentHashrate") else None,
        "hash_series": series,
        "fees": {k: fees.get(k) for k in ("fastestFee", "halfHourFee", "hourFee", "economyFee")},
        "retarget_progress": r(num(diff.get("progressPercent")), 1),
        "retarget_change": r(num(diff.get("difficultyChange"))),
        "retarget_blocks": diff.get("remainingBlocks"),
        "retarget_eta": diff.get("estimatedRetargetDate"),
    }


def src_feargreed():
    d = http("https://api.alternative.me/fng/?limit=30")["data"]
    series = sorted([[int(p["timestamp"]), int(p["value"])] for p in d])
    return {
        "value": int(d[0]["value"]),
        "label": d[0]["value_classification"],
        "series": series,
    }


def yahoo_chart(symbol):
    q = urllib.parse.quote(symbol, safe="")
    for host in ("query1", "query2"):
        try:
            res = http(f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?range=6mo&interval=1d")
            return res["chart"]["result"][0]
        except Exception as e:
            err = e
    raise err


def daily_closes(chart):
    ts = chart.get("timestamp") or []
    closes = chart["indicators"]["quote"][0].get("close") or []
    out = {}
    for t, c in zip(ts, closes):
        if c is not None:
            out[dt.datetime.fromtimestamp(t, dt.timezone.utc).date().isoformat()] = c
    return out  # {YYYY-MM-DD: close}


def src_macro():
    out, closes = {}, {}
    errors = []
    for sym, key, label in MACRO + [("BTC-USD", "BTCUSD", "Bitcoin")]:
        try:
            ch = yahoo_chart(sym)
        except Exception as e:
            errors.append(f"{key}: {e}")
            continue
        dc = daily_closes(ch)
        closes[key] = dc
        vals = list(dc.values())
        price = num(ch["meta"].get("regularMarketPrice")) or (vals[-1] if vals else None)
        scale = 0.1 if key == "US10Y" and price and price > 20 else 1  # old ^TNX quoted ×10
        mkt_day = dt.datetime.fromtimestamp(ch["meta"].get("regularMarketTime", 0), dt.timezone.utc).date().isoformat()
        prev = vals[-2] if list(dc.keys())[-1:] == [mkt_day] and len(vals) > 1 else (vals[-1] if vals else None)
        month_ago = vals[-22] if len(vals) > 22 else None
        if key != "BTCUSD":
            out[key] = {
                "label": label,
                "price": r(price * scale, 4),
                "chg1d": r(pct(price, prev)),
                "chg1m": r(pct(price, month_ago)),
                "abs1d": r((price - prev) * scale, 4) if price is not None and prev else None,
                "spark": [[int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp()), r(v * scale, 4)]
                          for d, v in list(dc.items())[-66:]],
            }
        time.sleep(0.3)
    if not out:
        raise RuntimeError("; ".join(errors) or "no data")

    # Rolling correlation of daily log returns: BTC vs each macro asset
    corr = {}
    btc = closes.get("BTCUSD")
    if btc:
        for key in ("SPX", "NDX", "GOLD", "DXY"):
            other = closes.get(key)
            if not other:
                continue
            days = sorted(set(btc) & set(other))
            rets = [(math.log(btc[b] / btc[a]), math.log(other[b] / other[a]))
                    for a, b in zip(days, days[1:])]
            corr[key] = {"30d": r(pearson(rets[-30:]), 2), "90d": r(pearson(rets[-90:]), 2)}
    return {"assets": out, "corr": corr, "partial_errors": errors}


def pearson(pairs):
    n = len(pairs)
    if n < 10:
        return None
    xs, ys = zip(*pairs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in pairs)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else None


SOURCES = [
    ("coingecko", "CoinGecko · spot prices", src_coingecko),
    ("coingecko_global", "CoinGecko · global market", src_coingecko_global),
    ("deribit", "Deribit · funding, basis, DVOL, options", src_deribit),
    ("hyperliquid", "Hyperliquid · perp funding & OI", src_hyperliquid),
    ("okx", "OKX · perp funding & OI", src_okx),
    ("stablecoins", "DefiLlama · stablecoin supply", src_stablecoins),
    ("tvl", "DefiLlama · DeFi TVL", src_tvl),
    ("mempool", "mempool.space · Bitcoin network", src_mempool),
    ("feargreed", "alternative.me · Fear & Greed", src_feargreed),
    ("macro", "Yahoo Finance · macro & correlation", src_macro),
]


# ─────────────────────────── Derived metrics ────────────────────────────

def derive(blocks):
    d = {}
    cg = (blocks.get("coingecko") or {}).get("assets", {})
    if cg.get("ETH", {}).get("price") and cg.get("BTC", {}).get("price"):
        d["ethbtc"] = r(cg["ETH"]["price"] / cg["BTC"]["price"], 5)

    funding, oi = {}, {}
    for sym in PERPS:
        venues = {}
        oiv = {}
        der = (blocks.get("deribit") or {}).get(sym)
        if der:
            venues["deribit"] = der.get("funding_ann")
            oiv["deribit"] = der.get("perp_oi_usd")
        for v in ("hyperliquid", "okx"):
            x = (blocks.get(v) or {}).get(sym)
            if x:
                venues[v] = x.get("funding_ann")
                oiv[v] = x.get("oi_usd")
        vals = [x for x in venues.values() if x is not None]
        venues["avg"] = r(sum(vals) / len(vals)) if vals else None
        funding[sym] = venues
        oiv["total"] = sum(x for x in oiv.values() if x) or None
        oi[sym] = oiv
    d["funding"] = funding
    d["perp_oi"] = oi

    # Front quarterly basis (first dated future more than 20 days out)
    for cur in ("BTC", "ETH"):
        curve = ((blocks.get("deribit") or {}).get(cur) or {}).get("curve") or []
        front = next((c for c in curve if c["days"] > 20), curve[0] if curve else None)
        d[f"basis_front_{cur.lower()}"] = front
    return d


# ─────────────────────────── Output writers ─────────────────────────────

def read_json(name, default):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(name, obj, pretty=False):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, name)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1 if pretty else None, separators=None if pretty else (",", ":"))
    os.replace(tmp, path)  # atomic: readers never see a half-written file


HISTORY_FIELDS = ["btc", "eth", "sol", "total_mcap", "btc_dom", "stables",
                  "funding_btc", "funding_eth", "basis_btc", "dvol_btc", "dvol_eth",
                  "oi_btc", "fng"]


def history_row(now, blocks, derived):
    cg = (blocks.get("coingecko") or {}).get("assets", {})
    g = blocks.get("coingecko_global") or {}
    der = blocks.get("deribit") or {}
    vals = {
        "btc": cg.get("BTC", {}).get("price"),
        "eth": cg.get("ETH", {}).get("price"),
        "sol": cg.get("SOL", {}).get("price"),
        "total_mcap": g.get("total_mcap"),
        "btc_dom": g.get("btc_dom"),
        "stables": (blocks.get("stablecoins") or {}).get("total"),
        "funding_btc": derived["funding"]["BTC"].get("avg"),
        "funding_eth": derived["funding"]["ETH"].get("avg"),
        "basis_btc": (derived.get("basis_front_btc") or {}).get("basis"),
        "dvol_btc": (der.get("BTC") or {}).get("dvol"),
        "dvol_eth": (der.get("ETH") or {}).get("dvol"),
        "oi_btc": derived["perp_oi"]["BTC"].get("total"),
        "fng": (blocks.get("feargreed") or {}).get("value"),
    }
    return [int(now)] + [r(vals[f], 4) if isinstance(vals[f], float) else vals[f] for f in HISTORY_FIELDS]


def cyd_payload(now, blocks, derived, sources):
    """Small, flat JSON for the ESP32 desk display (keep it under ~2 KB)."""
    cg = (blocks.get("coingecko") or {}).get("assets", {})
    g = blocks.get("coingecko_global") or {}
    der = blocks.get("deribit") or {}
    st = blocks.get("stablecoins") or {}
    fg = blocks.get("feargreed") or {}
    mac = (blocks.get("macro") or {}).get("assets", {})

    def a(sym, k):
        return cg.get(sym, {}).get(k)

    btc_spark = a("BTC", "spark7d") or []
    return {
        "t": int(now),
        "btc": r(a("BTC", "price"), 0), "btc24": a("BTC", "chg24"),
        "eth": r(a("ETH", "price"), 2), "eth24": a("ETH", "chg24"),
        "sol": r(a("SOL", "price"), 2), "sol24": a("SOL", "chg24"),
        "ethbtc": derived.get("ethbtc"),
        "mcap": r((g.get("total_mcap") or 0) / 1e12, 3), "dom": g.get("btc_dom"),
        "fund": derived["funding"]["BTC"].get("avg"),
        "basis": (derived.get("basis_front_btc") or {}).get("basis"),
        "dvol": (der.get("BTC") or {}).get("dvol"),
        "stbl": r((st.get("total") or 0) / 1e9, 1), "stbl7d": st.get("chg7d"),
        "fng": fg.get("value"), "fngl": fg.get("label"),
        "spx": r((mac.get("SPX") or {}).get("price"), 1), "spx1d": (mac.get("SPX") or {}).get("chg1d"),
        "dxy": r((mac.get("DXY") or {}).get("price"), 2),
        "us10y": r((mac.get("US10Y") or {}).get("price"), 3),
        "ok": sum(1 for s in sources.values() if s["ok"]), "n": len(sources),
        "spark": [r(p, 0) for p in thin(btc_spark, 48)],
    }


# ─────────────────────────────── Main ───────────────────────────────────

def main():
    now = time.time()
    iso_now = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="seconds")
    prev = read_json("latest.json", {})
    blocks = dict(prev.get("blocks") or {})
    prev_sources = prev.get("sources") or {}
    sources = {}

    for key, label, fn in SOURCES:
        t0 = time.time()
        try:
            blocks[key] = fn()
            sources[key] = {"label": label, "ok": True, "at": iso_now, "error": None,
                            "ms": int((time.time() - t0) * 1000)}
            print(f"  ok   {key:18s} {sources[key]['ms']:>6d} ms")
        except Exception as e:
            last_ok = (prev_sources.get(key) or {}).get("at")
            sources[key] = {"label": label, "ok": False, "at": last_ok, "error": str(e)[:200],
                            "ms": int((time.time() - t0) * 1000)}
            print(f"  FAIL {key:18s} {e}", file=sys.stderr)
        if key.startswith("coingecko"):
            time.sleep(3)  # CoinGecko's keyless tier is strict about bursts

    derived = derive(blocks)
    latest = {"updated": iso_now, "updated_ts": int(now), "sources": sources,
              "blocks": blocks, "derived": derived}
    write_json("latest.json", latest)

    fields = ["ts"] + HISTORY_FIELDS  # each row: [unix time, value, value, ...]
    hist = read_json("history.json", {"fields": fields, "rows": []})
    if hist.get("fields") != fields:  # schema changed: start a fresh series
        hist = {"fields": fields, "rows": []}
    rows = hist["rows"]
    if not rows or now - rows[-1][0] >= HISTORY_STEP_S:
        rows.append(history_row(now, blocks, derived))
    cutoff = now - HISTORY_DAYS * 86400
    hist["rows"] = [row for row in rows if row[0] >= cutoff]
    write_json("history.json", hist)

    write_json("cyd.json", cyd_payload(now, blocks, derived, sources))

    ok = sum(1 for s in sources.values() if s["ok"])
    print(f"done: {ok}/{len(sources)} sources ok, {len(hist['rows'])} history rows")
    # Only fail the job if *everything* failed — partial outages are normal.
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
