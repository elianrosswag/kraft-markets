# KRAFT Markets · markets.elian.ink

A free, self-updating dashboard of digital-asset market indicators. The same data feeds a desk display (an ESP32 "Cheap Yellow Display").

```
 ┌──────────── every 15 min ────────────┐
 │  GitHub Actions (free Linux machine) │
 │  collector/collect.py                │──► 10 free public APIs
 │    ├─ data/latest.json               │◄── CoinGecko, Deribit, Hyperliquid, OKX,
 │    ├─ data/history.json              │    DefiLlama ×2, mempool.space,
 │    └─ data/cyd.json                  │    alternative.me, Yahoo Finance
 │  commit → deploy to GitHub Pages     │
 └──────────────────────────────────────┘
                 │ static files over HTTPS
      ┌──────────┴───────────┐
      ▼                      ▼
 index.html (browser)    CYD on your desk (ESP32)
 + live prices from      fetches data/cyd.json
   Coinbase WebSocket
```

Running cost: £0. Accounts needed: GitHub only. API keys: none.

## What's in the repo

| Path | What it is |
|---|---|
| `collector/collect.py` | The backend. Python standard library only, so there's nothing to `pip install`. |
| `.github/workflows/collect.yml` | The scheduler. Runs the collector, commits the data, and publishes the site. |
| `data/*.json` | The "database". Written by the collector and read by everything else. |
| `index.html`, `assets/` | The frontend. Plain HTML, CSS and JS with hand-drawn SVG charts and no build step. |

## Six ideas this project teaches

1. **Batch vs live data.** Most indicators change slowly, so a 15-minute batch job is plenty, and it's cheap and robust. Spot prices change every second, so the browser opens its own WebSocket to Coinbase for those. Real trading dashboards mix the two in the same way.

2. **Git as a database ("git scraping").** Every run commits the new JSON, so the repo's history is a complete audit log of every snapshot. You can see this under *Commits*. GitHub calls this pattern [Flat Data](https://github.com/githubocto/flat).

3. **Static hosting as an API.** `https://markets.elian.ink/data/latest.json` is effectively a read-only API endpoint. GitHub Pages serves it from a global CDN, so the browser and the CYD both just do a GET.

4. **Fault tolerance.** Each source is wrapped on its own. If one fails, the collector keeps its last good data in `latest.json → blocks`, marks it stale, and carries on. The *Pipeline health* table on the site shows this. The job only fails if *every* source fails.

5. **Collect your own history.** Free APIs rarely give you history for things like cross-venue funding. `history.json` adds one row per hour and keeps 90 days, so the "BTC funding, our history" chart only exists because you're storing it.

6. **Derived metrics.** Average funding across venues, the annualised futures basis curve and BTC-vs-macro correlations aren't provided by any one API. The collector computes them in `derive()` and `src_macro()`.

## The Wire (news)

`collector/news.py` copies what Blockstories appears to do, using free parts:

| Step | Blockstories (inferred) | KRAFT Wire |
|---|---|---|
| Ingest | Publisher RSS feeds | The same publishers, plus **regulators' own feeds** (SEC, CFTC, Fed, ECB, FCA) and Surf's news API |
| Broken feeds | — | **Auto-discovery:** if a feed URL dies, the collector reads the site's `<link rel="alternate">` and switches to the new feed. The Sources table shows the change. |
| Duplicates | Merges the same story into one item | Matches stories by link, or by headline word overlap within 36 hours. The best source's headline wins. |
| Categories | Tokenisation & stablecoins / Markets / Regulation | The same, plus tags: Security & risk, ETFs, Banks, Central banks, Deals |
| Relevance | Editorial and AI | A transparent score: named institutions (+2 each), institutional terms (+1), regulator source (+2), extra outlets (+1 each), retail/memecoin noise (−3). The matched words appear under every headline. |
| Headlines | Rewritten, probably by an LLM | Originals for now. *Next lesson:* GitHub Models (free in Actions) can rewrite them and pick the category. |

To find a site's feed yourself, view its page source and search for `application/rss+xml`, or try `/feed`, `/rss` or `/rss.xml`.

Surf: `GET https://api.asksurf.ai/gateway/v1/news/feed` costs 1 credit, and every IP gets 30 free credits a day without a key. The collector calls it once an hour. If you add a repo secret named `SURF_API_KEY`, it will use your key instead.

Only headline, link, source, time and tags are stored. Article text never is: every headline links to the publisher.

To tune what counts as "institutional", edit `INSTITUTIONS`, `INST_KEYWORDS` and `NOISE` at the top of `news.py`.

## The indicators, and why an institutional desk watches them

| Indicator | Why it matters |
|---|---|
| **Perp funding (annualised)** | Shows the cost of leverage. High positive funding means crowded longs. Comparing Deribit, Hyperliquid and OKX shows whether that is venue-specific. |
| **Futures basis curve** | The annualised premium of dated futures over spot is the cash-and-carry yield. Its slope shows term demand for leverage. |
| **DVOL** | Deribit's 30-day implied volatility index, the crypto VIX. It's the price of options. |
| **Put/call open interest** | Options positioning skew. |
| **Open interest** | How much leverage is in the system. Rising OI into a move adds fuel. |
| **Stablecoin supply** | Dollars sitting on-chain. Growth usually leads inflows. |
| **BTC dominance, ETH/BTC** | Rotation between majors and the rest of the market. |
| **Macro + 30/90d correlation** | Whether BTC is trading as a risk asset (with Nasdaq), a hedge (with gold), or against the dollar. |
| **Hashrate, fees, difficulty** | Network security and blockspace demand. |
| **Fear & Greed** | A crude sentiment composite, useful mainly at extremes. |

## Changing things

- **Assets:** edit `ASSETS`, `PERPS` and `MACRO` at the top of `collect.py`, and the matching lists in `assets/dashboard.js`.
- **Frequency:** change `cron` in the workflow. Every 15 minutes uses about 3,000 free Actions minutes a month, which is unlimited for public repos. GitHub may start scheduled runs a few minutes late.
- **Run it on your own computer:** `python3 collector/collect.py`, then `python3 -m http.server`, and open http://localhost:8000.

## Known limits (honest list)

- Binance and Bybit block GitHub's US servers, so they aren't included. OKX may also block. The *Sources* table will show it if so.
- Yahoo Finance's chart endpoint is unofficial and could change without notice.
- ETF flows aren't included because there's no free, keyless and reliable source. That's a good next lesson (scrape → validate → store).
- Scheduled workflows pause if a public repo has no activity for 60 days. The collector's own commits count as activity, so this shouldn't happen.

Sources: CoinGecko (attribution required, shown in the footer), Coinbase, Deribit, Hyperliquid, OKX, DefiLlama, mempool.space, alternative.me, Yahoo Finance. For information only, not investment advice.
