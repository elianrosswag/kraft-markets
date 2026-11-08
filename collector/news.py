#!/usr/bin/env python3
"""
KRAFT Markets: news collector ("the Wire").

The same pipeline Blockstories appears to use, built from free parts:
  1. INGEST    publisher + regulator RSS/Atom feeds, plus Surf's news API (keyless, hourly)
  2. DISCOVER  if a feed URL breaks, find the new one from the site's <link rel="alternate">
  3. CLUSTER   merge the same story from several outlets into one item
  4. CLASSIFY  category (tokenisation & stablecoins / markets / regulation) + tags
  5. SCORE     institutional relevance, with the reasons kept so you can see why
  6. PUBLISH   data/news.json for the site, top headlines into data/cyd.json

Only headline, link, source, time and tags are stored, never article text.
Standard library only.  Run locally:  python3 collector/news.py
"""

import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (compatible; KRAFT-Markets/1.0; +https://markets.elian.ink)"
KEEP_DAYS = 7
MAX_ITEMS = 400
STALE_AFTER_S = 4 * 86400      # a feed whose newest item is older than this is treated as broken
SURF_EVERY_S = 55 * 60          # 1 credit per call; 30 free credits/day per IP without a key

# kind: "crypto" = everything is relevant
#       "filter" = general/noisy feed, keep only items that mention digital assets
# priority: whose headline wins when several outlets cover the same story (lower = preferred)
FEEDS = [
    # Primary sources: regulators and central banks
    {"key": "sec", "name": "SEC", "url": "https://www.sec.gov/news/pressreleases.rss", "home": "https://www.sec.gov/newsroom/press-releases", "kind": "filter", "priority": 1, "primary": True},
    {"key": "cftc", "name": "CFTC", "url": "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", "home": "https://www.cftc.gov/PressRoom/PressReleases", "kind": "filter", "priority": 1, "primary": True},
    {"key": "fed", "name": "Federal Reserve", "url": "https://www.federalreserve.gov/feeds/press_all.xml", "home": "https://www.federalreserve.gov/newsevents.htm", "kind": "filter", "priority": 1, "primary": True},
    {"key": "ecb", "name": "ECB", "url": "https://www.ecb.europa.eu/rss/press.html", "home": "https://www.ecb.europa.eu/press/html/index.en.html", "kind": "filter", "priority": 1, "primary": True},
    {"key": "fca", "name": "FCA", "url": "https://www.fca.org.uk/news/rss.xml", "home": "https://www.fca.org.uk/news", "kind": "filter", "priority": 1, "primary": True},
    # Institutional-leaning press
    {"key": "ledgerinsights", "name": "Ledger Insights", "url": "https://www.ledgerinsights.com/feed/", "home": "https://www.ledgerinsights.com/", "kind": "crypto", "priority": 2},
    {"key": "theblock", "name": "The Block", "url": "https://www.theblock.co/rss.xml", "home": "https://www.theblock.co/", "kind": "crypto", "priority": 3},
    {"key": "coindesk", "name": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/", "home": "https://www.coindesk.com/", "kind": "crypto", "priority": 3},
    {"key": "dlnews", "name": "DL News", "url": "https://www.dlnews.com/arc/outboundfeeds/rss/", "home": "https://www.dlnews.com/", "kind": "crypto", "priority": 3},
    {"key": "unchained", "name": "Unchained", "url": "https://unchainedcrypto.com/feed/", "home": "https://unchainedcrypto.com/", "kind": "crypto", "priority": 4},
    {"key": "blockworks", "name": "Blockworks", "url": "https://blockworks.com/feed", "home": "https://blockworks.com/", "kind": "crypto", "priority": 4},
    {"key": "cointelegraph", "name": "Cointelegraph", "url": "https://cointelegraph.com/rss", "home": "https://cointelegraph.com/", "kind": "crypto", "priority": 5},
    {"key": "decrypt", "name": "Decrypt", "url": "https://decrypt.co/feed", "home": "https://decrypt.co/", "kind": "crypto", "priority": 5},
    {"key": "finextra", "name": "Finextra", "url": "https://www.finextra.com/rss/headlines.aspx", "home": "https://www.finextra.com/", "kind": "filter", "priority": 4},
    {"key": "prnewswire", "name": "PR Newswire", "url": "https://www.prnewswire.com/rss/financial-services-latest-news/cryptocurrency-list.rss", "home": "https://www.prnewswire.com/rss/", "kind": "crypto", "priority": 6, "press_release": True},
]

# Surf brings reach: it also carries smaller, often machine-translated aggregators.
# Stories only from outlets outside this list are kept, but scored lower and never featured
# unless another outlet corroborates them.
TRUSTED_OUTLETS = {"coindesk", "theblock", "decrypt", "dlnews", "cointelegraph", "blockworks", "unchained",
                   "ledgerinsights", "bloomberg", "reuters", "financialtimes", "wsj", "tradingview"}

# ───────────────────────────── vocabulary ─────────────────────────────
# Each rule: (regex, weight). Tweak freely; the site shows which ones matched.

DIGITAL_ASSET = re.compile(
    r"\b(crypto\w*|bitcoin|btc|ether(eum)?|eth|stablecoin\w*|tokeni[sz]\w*|blockchain|digital asset\w*|"
    r"distributed ledger|dlt|cbdc|digital (euro|pound|dollar)|defi|web3|onchain|on-chain|solana|xrp|usdc|usdt|tether)\b", re.I)

CATEGORIES = {
    "tokstable": [r"tokeni[sz]", r"\brwa\b", r"real[- ]world asset", r"stablecoin", r"\busd[ct]\b", r"tether", r"\bcircle\b",
                  r"pyusd", r"money[- ]market fund", r"deposit token", r"\bcbdc\b", r"digital (euro|pound|dollar)",
                  r"on-?chain (fund|treasur)", r"tokenized (fund|treasur|bond|equit|stock)", r"\bbuidl\b", r"securitize",
                  r"\bondo\b", r"canton", r"\bgenius act\b", r"settlement"],
    "regulation": [r"\bsec\b", r"\bcftc\b", r"\bocc\b", r"\bfca\b", r"\besma\b", r"\bmica\b", r"regulat", r"legislat",
                   r"\bbill\b", r"\bact\b", r"lawsuit", r"\bcourt\b", r"\bjudge\b", r"sanction", r"enforcement",
                   r"licen[cs]e", r"congress", r"senate", r"lawmaker", r"\bpolicy\b", r"\btax", r"\baml\b",
                   r"travel rule", r"compliance", r"\bban(s|ned)?\b", r"treasury department", r"white house"],
    "markets": [r"\betfs?\b", r"inflow", r"outflow", r"\bprice", r"rall(y|ies)", r"sell-?off", r"futures", r"options",
                r"funding rate", r"liquidat", r"volume", r"market maker", r"\bipo\b", r"earnings", r"raises?\b",
                r"acqui", r"treasury (company|firm|strategy)", r"\bmstr\b", r"strategy inc", r"valuation", r"\brecord high\b"],
}
TAGS = {
    "Security & risk": [r"\bhack", r"exploit", r"breach", r"drain", r"stolen", r"laundr", r"\bscam", r"outage", r"attack"],
    "ETFs": [r"\betfs?\b", r"\betps?\b"],
    "Banks": [r"\bbanks?\b", r"banking"],
    "Central banks": [r"central bank", r"\bfed\b", r"federal reserve", r"\becb\b", r"bank of england", r"\bbis\b", r"\bcbdc\b"],
    "Deals": [r"raises?\b", r"funding round", r"acqui", r"merger", r"series [abc]\b", r"\bipo\b"],
    "Stablecoins": [r"stablecoin", r"\busd[ct]\b", r"tether", r"pyusd"],
    "Tokenisation": [r"tokeni[sz]", r"\brwa\b", r"real[- ]world asset"],
}

INSTITUTIONS = [
    "BlackRock", "Fidelity", "JPMorgan", "J.P. Morgan", "Goldman Sachs", "Morgan Stanley", "Citi", "Citigroup", "BNY", "State Street",
    "HSBC", "UBS", "Deutsche Bank", "Société Générale", "Societe Generale", "SocGen", "BNP Paribas", "Santander", "Barclays",
    "Standard Chartered", "Commerzbank", "DZ Bank", "ING", "Nomura", "SBI", "Visa", "Mastercard", "PayPal", "Stripe",
    "Nasdaq", "NYSE", "ICE", "CME", "Cboe", "DTCC", "Euroclear", "Clearstream", "SWIFT", "Broadridge",
    "Franklin Templeton", "Apollo", "KKR", "Invesco", "WisdomTree", "VanEck", "Grayscale", "ARK Invest", "Bitwise", "Hamilton Lane",
    "Coinbase", "Anchorage", "BitGo", "Fireblocks", "Ripple", "Circle", "Paxos", "Tether", "Ondo", "Securitize", "Kraken",
    "Canton","Chainlink", "Copper", "Zodia", "Taurus", "Galaxy",
    "SEC", "CFTC", "OCC", "FDIC", "Treasury", "Federal Reserve", "ECB", "Bank of England", "BIS", "IMF", "FCA", "ESMA",
    "MAS", "HKMA", "SFC", "FINMA", "BaFin",
]
INST_KEYWORDS = [
    (r"institution", 1), (r"custod", 1), (r"asset manag", 1), (r"\bbanks?\b", 1), (r"\bfunds?\b", 1), (r"tokeni[sz]", 1),
    (r"stablecoin", 1), (r"settlement", 1), (r"clearing", 1), (r"prime brok", 1), (r"\betfs?\b", 1), (r"regulat", 1),
    (r"treasur(y|ies)", 1), (r"payments?", 1), (r"collateral", 1), (r"capital markets", 1), (r"securities", 1),
    (r"market structure", 1), (r"senate|congress|lawmaker|legislat", 1), (r"\bhack|exploit|breach", 1), (r"\bexchanges?\b", 1),
]
NOISE = [r"memecoin", r"\bmeme\b", r"airdrop", r"price prediction", r"could (hit|reach|soar)", r"\bto the moon\b",
         r"\bshib", r"\bdoge", r"\bpepe\b", r"\bbonk\b", r"\bpump\b", r"top \d+ (coins|altcoins)", r"analyst (says|predicts)",
         r"\bwhale (buys|dumps)\b", r"presale"]

INST_RE = [(re.compile(r"(?<![\w.])" + re.escape(n) + r"(?![\w])", 0 if n.isupper() else re.I), n) for n in INSTITUTIONS]
STOP = set("a an the and or of to in on for with by at from as is are was were be after over amid into its it this that new says said us u.s. will".split())


# ───────────────────────────── fetching ─────────────────────────────

def fetch(url, timeout=20, accept="application/rss+xml, application/atom+xml, application/xml, text/xml, */*", headers=None):
    h = {"User-Agent": UA, "Accept": accept}
    h.update(headers or {})
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode(r.headers.get_content_charset() or "utf-8", errors="replace"), r.geturl()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (403, 404, 410):
                break
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(2)
    raise RuntimeError(last)


def discover(home):
    """Find a site's feed from <link rel="alternate" type="application/rss+xml"> in its HTML."""
    page, base = fetch(home, accept="text/html")
    for tag in re.findall(r"<link\b[^>]*>", page, re.I):
        if re.search(r"rel=[\"']?alternate", tag, re.I) and re.search(r"(rss|atom)\+xml", tag, re.I):
            m = re.search(r"href=[\"']([^\"']+)", tag, re.I)
            if m:
                return urllib.parse.urljoin(base, html.unescape(m.group(1)))
    for guess in ("/feed/", "/rss", "/rss.xml", "/feed.xml", "/arc/outboundfeeds/rss/"):
        return_url = urllib.parse.urljoin(base, guess)
        try:
            body, _ = fetch(return_url)
            if "<rss" in body[:2000] or "<feed" in body[:2000] or "<rdf" in body[:2000].lower():
                return return_url
        except Exception:
            pass
    raise RuntimeError("no feed found on " + home)


# ───────────────────────────── parsing ─────────────────────────────

def localname(tag):
    return tag.rsplit("}", 1)[-1].lower()


def child(el, *names):
    for c in el:
        if localname(c.tag) in names:
            return c
    return None


def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        return int(email.utils.parsedate_to_datetime(s).timestamp())
    except Exception:
        pass
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def parse_feed(xml_text):
    """RSS 2.0, RSS 1.0 (RDF) and Atom → [{title, url, ts, cats}]"""
    xml_text = xml_text.lstrip("﻿ \n\r\t")
    root = ET.fromstring(xml_text.encode("utf-8"))
    entries = [e for e in root.iter() if localname(e.tag) in ("item", "entry")]
    out = []
    for e in entries:
        title = clean((child(e, "title") is not None and child(e, "title").text) or "")
        link_el = child(e, "link")
        url = ""
        if link_el is not None:
            url = (link_el.text or "").strip() or link_el.get("href", "")
        if not url:
            for c in e:
                if localname(c.tag) == "link" and c.get("rel", "alternate") == "alternate" and c.get("href"):
                    url = c.get("href")
                    break
        if not url:
            g = child(e, "guid")
            if g is not None and (g.text or "").startswith("http"):
                url = g.text.strip()
        date_el = child(e, "pubdate", "published", "updated", "date", "issued")
        cats = [clean(c.text or c.get("term", "")) for c in e if localname(c.tag) in ("category", "subject")]
        if title and url:
            out.append({"title": title, "url": url.strip(), "ts": parse_date(date_el.text if date_el is not None else None),
                        "cats": [c for c in cats if c][:6]})
    return out


def canonical(url):
    """Strip tracking params so the same article from two routes matches."""
    p = urllib.parse.urlsplit(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not k.lower().startswith(("utm_", "ref", "mc_", "fbclid", "gclid"))]
    return urllib.parse.urlunsplit((p.scheme, p.netloc.lower().replace("www.", ""), p.path.rstrip("/"), urllib.parse.urlencode(q), ""))


# ───────────────────────────── sources ─────────────────────────────

def collect_feed(cfg, prev_health):
    url = (prev_health or {}).get("discovered") or cfg["url"]
    discovered, items = None, []
    try:
        body, _ = fetch(url)
        items = parse_feed(body)
        newest = max([i["ts"] for i in items if i["ts"]] or [0])
        if time.time() - newest > STALE_AFTER_S:
            raise RuntimeError(f"stale: newest item {int((time.time() - newest) / 86400)} days old")
    except Exception as first_err:
        try:  # the URL moved, broke or went stale: look for the site's current feed
            discovered = discover(cfg["home"])
            if discovered.rstrip("/") == url.rstrip("/"):
                raise RuntimeError("site still advertises the same feed")
            body, _ = fetch(discovered)
            items = parse_feed(body)
        except Exception as e:
            if str(first_err).startswith("stale") and items:
                return items, None, str(first_err)  # keep the (old) items, report the warning
            raise RuntimeError(f"{first_err}; discovery: {e}")
    return items, discovered, None


def collect_surf(prev):
    """Surf news feed. Keyless = 30 free credits/day per IP; this call costs 1. Hourly is plenty."""
    last = (prev.get("surf") or {}).get("fetched_ts") or 0
    if time.time() - last < SURF_EVERY_S:
        return None  # not due: keep previous items
    headers = {"Accept": "application/json"}
    key = os.environ.get("SURF_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body, _ = fetch("https://api.asksurf.ai/gateway/v1/news/feed?limit=50&sort_by=recency", accept="application/json", headers=headers)
    data = json.loads(body).get("data") or []
    return [{"title": clean(a.get("title")), "url": a.get("url"), "ts": a.get("published_at"),
             "cats": [a["project_name"]] if a.get("project_name") else [],
             "via": (a.get("source") or "").title().replace("Theblock", "The Block").replace("Coindesk", "CoinDesk").replace("Dlnews", "DL News")}
            for a in data if a.get("title") and a.get("url")]


# ───────────────────────────── classify ─────────────────────────────

def compile_rules(d):
    return {k: [re.compile(p, re.I) for p in v] for k, v in d.items()}


CAT_RE = compile_rules(CATEGORIES)
TAG_RE = compile_rules(TAGS)
NOISE_RE = [re.compile(p, re.I) for p in NOISE]
INST_KW_RE = [(re.compile(p, re.I), w) for p, w in INST_KEYWORDS]


def classify(title, extra=""):
    text = f"{title} {extra}"
    scores = {k: sum(1 for r in rs if r.search(text)) for k, rs in CAT_RE.items()}
    # highest score wins; ties go to the more specific category (order below)
    order = ["tokstable", "regulation", "markets"]
    cat = max(order, key=lambda k: (scores[k], -order.index(k)))
    if not scores[cat]:
        cat = "other"
    tags = [k for k, rs in TAG_RE.items() if any(r.search(text) for r in rs)]

    entities = []
    for rx, name in INST_RE:
        if rx.search(title) and name not in entities:
            entities.append(name)
    why = list(entities)
    score = 2 * len(entities)
    for rx, w in INST_KW_RE:
        m = rx.search(title)
        if m:  # show the whole word that matched ("tokenized", not "tokeniz")
            score += w
            s0, e0 = m.span()
            while s0 > 0 and title[s0 - 1].isalnum():
                s0 -= 1
            while e0 < len(title) and (title[e0].isalnum() or title[e0] == "-"):
                e0 += 1
            word = title[s0:e0].lower()
            if word not in why:
                why.append(word)
    noise = [r.pattern for r in NOISE_RE if r.search(title)]
    score -= 3 * len(noise)
    return cat, tags, entities, score, why[:5]


def tokens(title):
    words = re.findall(r"[a-z0-9$€£.%]+", title.lower())
    return {w.strip(".") for w in words if w not in STOP and len(w) > 1}


def similar(a, b):
    if not a or not b:
        return 0
    return len(a & b) / min(len(a), len(b))


# ───────────────────────────── main ─────────────────────────────

def read_json(name, default):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(name, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, name)
    with open(path + ".tmp", "w") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(path + ".tmp", path)


def main():
    now = int(time.time())
    iso_now = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="seconds")
    prev = read_json("news.json", {})
    prev_health = prev.get("feeds") or {}
    health, raw = {}, []

    for cfg in FEEDS:
        t0 = time.time()
        try:
            items, discovered, warning = collect_feed(cfg, prev_health.get(cfg["key"]))
            kept = 0
            for it in items:
                if cfg["kind"] == "filter" and not DIGITAL_ASSET.search(it["title"] + " " + " ".join(it["cats"])):
                    continue
                it.update(source=cfg["name"], key=cfg["key"], priority=cfg["priority"],
                          primary=cfg.get("primary", False), pr=cfg.get("press_release", False))
                raw.append(it)
                kept += 1
            health[cfg["key"]] = {"name": cfg["name"], "ok": True, "at": iso_now, "items": len(items), "kept": kept,
                                  "discovered": discovered or (prev_health.get(cfg["key"]) or {}).get("discovered"),
                                  "error": None, "warning": warning, "ms": int((time.time() - t0) * 1000)}
            print(f"  ok   {cfg['key']:15s} {len(items):3d} items, {kept:3d} kept" + (f"  (found new feed: {discovered})" if discovered else "") + (f"  [{warning}]" if warning else ""))
        except Exception as e:
            p = prev_health.get(cfg["key"]) or {}
            health[cfg["key"]] = {"name": cfg["name"], "ok": False, "at": p.get("at"), "items": 0, "kept": 0,
                                  "discovered": p.get("discovered"), "error": str(e)[:200], "ms": int((time.time() - t0) * 1000)}
            print(f"  FAIL {cfg['key']:15s} {e}", file=sys.stderr)

    surf_state = prev.get("surf") or {}
    t0 = time.time()
    try:
        s_items = collect_surf(prev)
        if s_items is not None:
            surf_state = {"fetched_ts": now, "items": s_items}
            health["surf"] = {"name": "Surf", "ok": True, "at": iso_now, "items": len(s_items), "kept": len(s_items),
                              "error": None, "ms": int((time.time() - t0) * 1000)}
            print(f"  ok   surf            {len(s_items):3d} items")
        else:
            health["surf"] = dict(prev_health.get("surf") or {"name": "Surf", "ok": True, "at": None, "items": 0, "kept": 0, "error": None},
                                  note="hourly; not due this run")
    except Exception as e:
        p = prev_health.get("surf") or {}
        health["surf"] = {"name": "Surf", "ok": False, "at": p.get("at"), "items": 0, "kept": 0, "error": str(e)[:200],
                          "ms": int((time.time() - t0) * 1000)}
        print(f"  FAIL surf            {e}", file=sys.stderr)
    for it in surf_state.get("items") or []:
        via = it.get("via") or "Surf"
        reach = via.lower().replace(" ", "") not in TRUSTED_OUTLETS
        raw.append(dict(it, source=via, key="surf", priority=8 if reach else 7, primary=False, pr=False, reach=reach))

    # Merge with what we already had, so stories persist after they drop out of a feed
    stories = prev.get("items") or []
    by_url = {}
    for s in stories:
        for u in s["urls"]:
            by_url[canonical(u)] = s
    cutoff = now - KEEP_DAYS * 86400

    for it in sorted(raw, key=lambda x: x["priority"]):
        ts = it["ts"] or now
        if ts < cutoff or ts > now + 3600:
            continue
        cu = canonical(it["url"])
        story = by_url.get(cu)
        if story is None:  # same story from another outlet? compare headlines within 36h
            tk = tokens(it["title"])
            for s in stories:
                if abs(s["ts"] - ts) < 36 * 3600 and similar(tk, set(s["tk"])) >= 0.6:
                    story = s
                    break
        if story is None:
            story = {"title": it["title"], "url": it["url"], "ts": ts, "lead": it["source"], "lead_priority": it["priority"], "reach": True,
                     "sources": [], "urls": [], "tk": sorted(tokens(it["title"])), "primary": False, "pr": it["pr"], "cats_src": []}
            stories.append(story)
        if it["source"] not in story["sources"]:
            story["sources"].append(it["source"])
            story["urls"].append(it["url"])
        if it["priority"] < story["lead_priority"]:  # better source: take its headline and link
            story.update(title=it["title"], url=it["url"], lead=it["source"], lead_priority=it["priority"])
        story["ts"] = min(story["ts"], ts)
        story["primary"] = story["primary"] or it["primary"]
        story["reach"] = story.get("reach", True) and it.get("reach", False)  # True only if every source is reach-tier
        story["pr"] = story["pr"] and it["pr"]
        story["cats_src"] = sorted(set(story["cats_src"]) | set(it["cats"]))[:8]
        by_url[cu] = story

    stories = [s for s in stories if s["ts"] >= cutoff]
    for s in stories:
        cat, tags, ents, score, why = classify(s["title"], " ".join(s["cats_src"]))
        if cat == "other" and s["primary"]:
            cat = "regulation"  # a regulator speaking is regulatory news by default
        coverage = len(s["sources"])
        score += 2 if s["primary"] else 0
        score += min(coverage - 1, 3)
        score -= 1 if s["pr"] else 0
        score -= 1 if s.get("reach") else 0  # uncorroborated reach-tier aggregator
        s.update(cat=cat, tags=tags, entities=ents, score=score, why=why, inst=score >= 2)

    stories.sort(key=lambda s: s["ts"], reverse=True)
    stories = stories[:MAX_ITEMS]

    day = [s for s in stories if s["ts"] >= now - 86400 and not s.get("reach")]
    featured = sorted(day, key=lambda s: (s["score"] + 2 * len(s["sources"]), s["ts"]), reverse=True)[:3]
    feat_ids = {id(s) for s in featured}
    for s in stories:
        s["featured"] = id(s) in feat_ids

    out = {"updated": iso_now, "updated_ts": now, "feeds": health, "surf": surf_state, "items": stories}
    write_json("news.json", out)

    # Top three institutional headlines for the desk display
    cyd = read_json("cyd.json", None)
    if cyd is not None:
        top = [s for s in stories if s["inst"] and not s.get("reach")][:3]
        cyd["news"] = [{"t": s["title"][:90], "s": s["lead"][:16], "a": now - s["ts"]} for s in top]
        write_json("cyd.json", cyd)

    ok = sum(1 for h in health.values() if h.get("ok"))
    print(f"done: {ok}/{len(health)} feeds ok, {len(stories)} stories ({sum(s['inst'] for s in stories)} institutional)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
