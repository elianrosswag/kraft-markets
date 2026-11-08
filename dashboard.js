/* KRAFT Markets — frontend.
 * Reads the JSON files the collector publishes (data/latest.json, data/history.json),
 * draws everything with plain SVG, and streams live spot prices from Coinbase.
 * No framework, no chart library, no build step.
 */
(function () {
  "use strict";

  var GREEN = "#39FF14", STEEL = "#dfe2e5";
  var REFRESH_MS = 5 * 60 * 1000;
  var state = { latest: null, history: null, news: null, live: {} };

  // ───────────────────────── formatting ─────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  var NA = '<span class="na">—</span>';

  function fixed(v, d) {
    return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function compact(v, prefix) {
    if (!isNum(v)) return NA;
    var a = Math.abs(v), p = prefix || "";
    if (a >= 1e12) return p + fixed(v / 1e12, 2) + "T";
    if (a >= 1e9) return p + fixed(v / 1e9, a >= 1e11 ? 0 : 1) + "B";
    if (a >= 1e6) return p + fixed(v / 1e6, 1) + "M";
    if (a >= 1e3) return p + fixed(v / 1e3, 1) + "K";
    return p + fixed(v, 0);
  }
  function usd(v) { return compact(v, "$"); }
  function price(v) {
    if (!isNum(v)) return NA;
    if (v >= 1000) return "$" + fixed(v, 0);
    if (v >= 1) return "$" + fixed(v, 2);
    return "$" + fixed(v, 4);
  }
  function signed(v, d, unit) {
    if (!isNum(v)) return NA;
    var s = v > 0 ? "+" : v < 0 ? "−" : "±";
    return s + fixed(Math.abs(v), d) + (unit || "");
  }
  // Direction is carried by arrow + sign, colour only reinforces it.
  function chg(v, d, unit) {
    if (!isNum(v)) return NA;
    var cls = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
    var arrow = cls === "up" ? "▲ " : cls === "down" ? "▼ " : "";
    return '<b class="' + cls + '">' + arrow + signed(v, d === undefined ? 2 : d, unit === undefined ? "%" : unit) + "</b>";
  }
  function ago(iso) {
    if (!iso) return "never";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 172800) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayLabel(ts) { var d = new Date(ts * 1000); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  function timeLabel(ts) {
    var d = new Date(ts * 1000);
    return dayLabel(ts) + " " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " UTC";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ───────────────────────── tooltip ─────────────────────────
  var tip = $("tip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8);
    var top = y - h - 12 < 8 ? y + 16 : y - h - 12;
    tip.style.left = Math.max(8, left) + "px"; tip.style.top = top + "px";
  }
  function hideTip() { tip.hidden = true; }

  // ───────────────────────── SVG line chart ─────────────────────────
  // opts: { series:[{name,color,points:[[x,y]...]}], x:"time"|"num", axes:bool,
  //         dots:bool, zero:bool, yFmt:fn, xFmt:fn, tipX:fn, empty:"text" }
  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  var observed = new WeakMap();
  var ro = "ResizeObserver" in window ? new ResizeObserver(function (entries) {
    entries.forEach(function (e) { var o = observed.get(e.target); if (o) draw(e.target, o); });
  }) : null;

  function chart(host, opts) {
    if (!host) return;
    if (!observed.has(host) && ro) ro.observe(host);
    observed.set(host, opts);
    draw(host, opts);
  }

  function draw(host, o) {
    var W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    host.innerHTML = "";
    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H }, host);
    var series = (o.series || []).map(function (s) {
      return Object.assign({}, s, { points: (s.points || []).filter(function (p) { return isNum(p[0]) && isNum(p[1]); }) });
    }).filter(function (s) { return s.points.length; });

    if (!series.length || series.every(function (s) { return s.points.length < 2; }) && !o.dots) {
      el("text", { x: 0, y: H / 2, class: "empty" }, svg).textContent = o.empty || "No data yet";
      return;
    }

    var all = [].concat.apply([], series.map(function (s) { return s.points; }));
    var xs = all.map(function (p) { return p[0]; }), ys = all.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (o.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    var padY = (y1 - y0) * 0.08; y0 -= padY; y1 += padY;
    if (x0 === x1) { x0 -= 1; x1 += 1; }

    var L = o.axes ? 48 : 0, R = o.axes ? (o.endLabels ? 44 : 8) : 0, T = o.axes ? 8 : 3, B = o.axes ? 22 : 3;
    var sx = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - R); };
    var sy = function (y) { return T + (1 - (y - y0) / (y1 - y0)) * (H - T - B); };
    var yFmt = o.yFmt || function (v) { return fixed(v, 0); };

    if (o.axes) {
      for (var i = 0; i <= 3; i++) {
        var yv = y0 + (y1 - y0) * (i / 3), yy = Math.round(sy(yv)) + 0.5;
        el("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "grid-l" }, svg);
        el("text", { x: L - 8, y: yy + 3, "text-anchor": "end", class: "axis-t" }, svg).textContent = yFmt(yv);
      }
      var xt = o.xTicks || 4;
      for (var j = 0; j < xt; j++) {
        var xv = x0 + (x1 - x0) * (j / (xt - 1));
        el("text", { x: sx(xv), y: H - 5, "text-anchor": j === 0 ? "start" : j === xt - 1 ? "end" : "middle", class: "axis-t" }, svg)
          .textContent = (o.xFmt || (o.x === "time" ? dayLabel : function (v) { return fixed(v, 0); }))(xv);
      }
    }
    if (o.zero && y0 < 0 && y1 > 0) {
      var zy = Math.round(sy(0)) + 0.5;
      el("line", { x1: L, x2: W - R, y1: zy, y2: zy, class: "zero-l" }, svg);
    }

    series.forEach(function (s) {
      var d = s.points.map(function (p, k) { return (k ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1); }).join("");
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": o.axes ? 2 : 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (o.dots) s.points.forEach(function (p) {
        el("circle", { cx: sx(p[0]), cy: sy(p[1]), r: 4, fill: s.color, stroke: "#000", "stroke-width": 2 }, svg);
      });
      if (o.endLabels) {
        var lp = s.points[s.points.length - 1];
        el("text", { x: sx(lp[0]) + 8, y: sy(lp[1]) + 3, class: "axis-t", fill: STEEL }, svg).textContent = s.name;
      }
    });

    // Hover layer: crosshair + nearest point per series
    var cross = el("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" }, svg);
    var marks = series.map(function (s) { return el("circle", { r: 4, fill: s.color, stroke: "#000", "stroke-width": 2, visibility: "hidden" }, svg); });
    var hit = el("rect", { x: L, y: 0, width: Math.max(0, W - L - R), height: H, fill: "transparent" }, svg);
    function move(ev) {
      var rect = svg.getBoundingClientRect();
      var mx = x0 + (ev.clientX - rect.left - L) / (W - L - R) * (x1 - x0);
      var rows = [], cx = null;
      series.forEach(function (s, k) {
        var best = s.points[0];
        s.points.forEach(function (p) { if (Math.abs(p[0] - mx) < Math.abs(best[0] - mx)) best = p; });
        if (cx === null) cx = best[0];
        marks[k].setAttribute("cx", sx(best[0])); marks[k].setAttribute("cy", sy(best[1])); marks[k].setAttribute("visibility", "visible");
        rows.push((series.length > 1 ? esc(s.name) + " " : "") + "<b>" + (o.tipY || yFmt)(best[1], best) + "</b>" + (s.meta ? " · " + esc(s.meta(best)) : ""));
      });
      cross.setAttribute("x1", sx(cx)); cross.setAttribute("x2", sx(cx)); cross.setAttribute("visibility", "visible");
      var head = (o.tipX || (o.x === "time" ? timeLabel : function (v) { return fixed(v, 0); }))(cx);
      showTip(head + "<br>" + rows.join("<br>"), ev.clientX, ev.clientY);
    }
    function leave() { cross.setAttribute("visibility", "hidden"); marks.forEach(function (m) { m.setAttribute("visibility", "hidden"); }); hideTip(); }
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", leave);
    hit.addEventListener("pointerdown", move);
    svg.setAttribute("role", "img");
    if (o.label) svg.setAttribute("aria-label", o.label);
  }

  // ───────────────────────── tiles ─────────────────────────
  function tile(opts) {
    // opts: {code, label, value, chips:[html], meta:[left,right], sparkId}
    return '<div class="tile">' +
      '<div class="tile-top"><span class="tile-label">' + esc(opts.label) + '</span><span class="mono">' + (opts.code || "") + "</span></div>" +
      '<div class="' + (opts.size || "big") + '"' + (opts.valueId ? ' id="' + opts.valueId + '"' : "") + ">" + opts.value + "</div>" +
      (opts.chips ? '<div class="chips"' + (opts.chipsId ? ' id="' + opts.chipsId + '"' : "") + ">" + opts.chips.join("") + "</div>" : "") +
      (opts.extra || "") +
      (opts.sparkId ? '<div class="spark chart" id="' + opts.sparkId + '"></div>' : "") +
      (opts.meta ? '<div class="meta-row"><span>' + opts.meta[0] + "</span><span>" + (opts.meta[1] || "") + "</span></div>" : "") +
      "</div>";
  }
  function chip(label, html) { return "<span>" + label + " " + html + "</span>"; }

  // ───────────────────────── sections ─────────────────────────
  function B(name) { return ((state.latest || {}).blocks || {})[name] || null; }
  function D() { return (state.latest || {}).derived || {}; }

  function renderSpot() {
    var cg = (B("coingecko") || {}).assets || {};
    var syms = ["BTC", "ETH", "SOL", "XRP"];
    $("assets").innerHTML = syms.map(function (s) {
      var a = cg[s] || {}, live = state.live[s];
      return tile({
        label: a.name || s, code: s, valueId: "px-" + s,
        value: price(live ? live.price : a.price),
        chipsId: "chg-" + s,
        chips: [chip("24h", chg(live ? live.chg24 : a.chg24)), chip("7d", chg(a.chg7d)), chip("30d", chg(a.chg30d))],
        sparkId: "spark-" + s,
        meta: ["Mcap " + usd(a.mcap), "Vol " + usd(a.vol24)]
      });
    }).join("");
    syms.forEach(function (s) {
      var a = cg[s]; if (!a || !a.spark7d) return;
      var n = a.spark7d.length, end = (state.latest.blocks && state.latest.updated_ts) || Date.now() / 1000;
      var pts = a.spark7d.map(function (v, i) { return [end - (n - 1 - i) * (7 * 86400 / (n - 1)), v]; });
      chart($("spark-" + s), { series: [{ name: s, color: GREEN, points: pts }], x: "time", yFmt: price, label: s + " price, last 7 days" });
    });

    var g = B("coingecko_global") || {}, d = D();
    $("spot-stats").innerHTML = [
      tile({ label: "Total crypto market cap", value: usd(g.total_mcap), chips: [chip("24h", chg(g.mcap_chg24))], size: "mid" }),
      tile({ label: "BTC dominance", value: isNum(g.btc_dom) ? fixed(g.btc_dom, 1) + "%" : NA, chips: [chip("ETH", isNum(g.eth_dom) ? fixed(g.eth_dom, 1) + "%" : NA)], size: "mid" }),
      tile({ label: "ETH / BTC", value: isNum(d.ethbtc) ? fixed(d.ethbtc, 5) : NA, chips: [chip("ratio of", "spot prices")], size: "mid" }),
      tile({ label: "24h spot volume", value: usd(g.total_vol), chips: [chip("all", "venues")], size: "mid" })
    ].join("");
  }

  var VENUES = [["deribit", "Deribit"], ["hyperliquid", "Hyperliquid"], ["okx", "OKX"]];
  function renderDerivs() {
    var d = D(), f = d.funding || {}, oi = d.perp_oi || {};
    var head = "<thead><tr><th>Asset</th>" + VENUES.map(function (v) { return "<th>" + v[1] + "</th>"; }).join("");
    $("funding-table").innerHTML = "<caption class='mono' hidden>Perpetual funding rates, annualised</caption>" + head + "<th>Average</th></tr></thead><tbody>" +
      ["BTC", "ETH", "SOL"].map(function (s) {
        var r = f[s] || {};
        return "<tr><td>" + s + "</td>" + VENUES.map(function (v) { return "<td>" + signed(r[v[0]], 2, "%") + "</td>"; }).join("") +
          '<td class="em">' + signed(r.avg, 2, "%") + "</td></tr>";
      }).join("") + "</tbody>";
    $("oi-table").innerHTML = head + "<th>Total</th></tr></thead><tbody>" +
      ["BTC", "ETH", "SOL"].map(function (s) {
        var r = oi[s] || {};
        return "<tr><td>" + s + "</td>" + VENUES.map(function (v) { return "<td>" + usd(r[v[0]]) + "</td>"; }).join("") +
          '<td class="em">' + usd(r.total) + "</td></tr>";
      }).join("") + "</tbody>";

    // Basis curve
    var der = B("deribit") || {};
    var colors = { BTC: GREEN, ETH: STEEL };
    var series = ["BTC", "ETH"].map(function (c) {
      var curve = (der[c] || {}).curve || [];
      return { name: c, color: colors[c], points: curve.map(function (p) { return [p.days, p.basis, p]; }),
        meta: function (p) { return p[2] ? p[2].instrument : ""; } };
    });
    chart($("basis-chart"), {
      series: series, x: "num", axes: true, dots: true, zero: true,
      yFmt: function (v) { return fixed(v, 1) + "%"; }, tipY: function (v) { return signed(v, 2, "%"); },
      xFmt: function (v) { return fixed(v, 0) + "d"; }, tipX: function (v) { return fixed(v, 0) + " days to expiry"; },
      label: "Annualised futures basis by days to expiry for BTC and ETH"
    });
    $("basis-legend").innerHTML = series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + s.name + "</span>"; }).join("");

    // Funding history from our own collected history
    var h = state.history, pts = [];
    if (h && h.rows) {
      var fi = h.fields.indexOf("funding_btc");
      pts = h.rows.map(function (r) { return [r[0], r[fi]]; }).filter(function (p) { return isNum(p[1]); });
    }
    chart($("funding-hist"), {
      series: [{ name: "BTC funding", color: GREEN, points: pts }], x: "time", axes: true, zero: true,
      yFmt: function (v) { return fixed(v, 1) + "%"; }, tipY: function (v) { return signed(v, 2, "%"); },
      empty: "Collecting — first line appears after a few hours", label: "BTC average funding history"
    });
    $("funding-hist-note").textContent = pts.length ? pts.length + " hourly points since " + dayLabel(pts[0][0]) + " · this series only exists because the collector stores it" : "This chart fills in as the collector runs";

    // Vol & options tiles
    var vt = ["BTC", "ETH"].map(function (c) {
      var x = der[c] || {};
      return tile({ label: c + " implied vol (DVOL)", code: "30D", value: isNum(x.dvol) ? fixed(x.dvol, 1) : NA,
        chips: [chip("24h", chg(x.dvol_chg24, 1, " pts"))], sparkId: "dvol-" + c, meta: ["Deribit", "30 days"], size: "mid" });
    }).concat(["BTC", "ETH"].map(function (c) {
      var x = der[c] || {}, fb = d["basis_front_" + c.toLowerCase()];
      return tile({ label: c + " put / call OI", code: "Options", value: isNum(x.pcr_oi) ? fixed(x.pcr_oi, 2) : NA,
        chips: [chip("Options OI", usd(x.options_oi))], size: "mid",
        meta: ["Front basis " + (fb ? signed(fb.basis, 2, "%") : "—"), fb ? fb.expiry : ""] });
    }));
    $("vol-stats").innerHTML = vt.join("");
    ["BTC", "ETH"].forEach(function (c) {
      var s = (der[c] || {}).dvol_series || [];
      chart($("dvol-" + c), { series: [{ name: "DVOL", color: GREEN, points: s }], x: "time", yFmt: function (v) { return fixed(v, 1); }, label: c + " DVOL, 30 days" });
    });
  }

  function renderLiquidity() {
    var st = B("stablecoins") || {};
    $("stables-hero").innerHTML = '<div class="tile-top"><span class="tile-label">USD stablecoin supply</span><span class="mono">DefiLlama</span></div>' +
      '<div class="big">' + usd(st.total) + "</div>" +
      '<div class="chips">' + chip("7d", chg(st.chg7d)) + chip("30d", chg(st.chg30d)) + chip("7d net", '<b class="' + ((st.abs7d || 0) >= 0 ? "up" : "down") + '">' + (isNum(st.abs7d) ? (st.abs7d >= 0 ? "+" : "−") + usd(Math.abs(st.abs7d)).replace("$", "$") : "—") + "</b>") + "</div>";
    chart($("stables-chart"), { series: [{ name: "Supply", color: GREEN, points: st.series || [] }], x: "time", axes: true, yFmt: usd, label: "USD stablecoin supply, 90 days" });

    $("stables-table").innerHTML = "<thead><tr><th>Token</th><th>Supply</th><th>Share</th><th>7d</th></tr></thead><tbody>" +
      (st.top || []).map(function (t) {
        return "<tr><td>" + esc(t.symbol) + "</td><td>" + usd(t.supply) + "</td><td>" + (isNum(t.share) ? fixed(t.share, 1) + "%" : NA) +
          '<span class="share" aria-hidden="true"><i style="width:' + Math.min(100, t.share || 0) + '%"></i></span></td><td>' + chg(t.chg7d) + "</td></tr>";
      }).join("") + "</tbody>";

    var tv = B("tvl") || {};
    $("tvl-hero").innerHTML = '<div class="tile-top"><span class="tile-label">DeFi total value locked</span><span class="mono">90 days</span></div>' +
      '<div class="mid">' + usd(tv.total) + '</div><div class="chips">' + chip("7d", chg(tv.chg7d)) + chip("30d", chg(tv.chg30d)) + "</div>";
    chart($("tvl-chart"), { series: [{ name: "TVL", color: STEEL, points: tv.series || [] }], x: "time", yFmt: usd, label: "DeFi TVL, 90 days" });
  }

  var MACRO = ["SPX", "NDX", "DXY", "US10Y", "GOLD", "VIX"];
  function macroFmt(k, v) {
    if (!isNum(v)) return NA;
    if (k === "US10Y") return fixed(v, 2) + "%";
    if (k === "GOLD") return "$" + fixed(v, 0);
    if (k === "DXY" || k === "VIX") return fixed(v, 2);
    return fixed(v, 0);
  }
  function renderMacro() {
    var m = B("macro") || {}, a = m.assets || {};
    $("macro-tiles").innerHTML = MACRO.map(function (k) {
      var x = a[k] || {};
      var c1 = k === "US10Y" ? chg(isNum(x.abs1d) ? x.abs1d * 100 : null, 0, " bp") : chg(x.chg1d);
      return tile({ label: x.label || k, code: k, value: macroFmt(k, x.price), size: "mid",
        chips: [chip("1d", c1), chip("1m", chg(x.chg1m))], sparkId: "mac-" + k });
    }).join("");
    MACRO.forEach(function (k) {
      var x = a[k]; if (!x) return;
      chart($("mac-" + k), { series: [{ name: k, color: GREEN, points: x.spark || [] }], x: "time",
        yFmt: function (v) { return macroFmt(k, v); }, tipX: dayLabel, label: (x.label || k) + ", 3 months" });
    });

    var c = m.corr || {}, names = { SPX: "S&P 500", NDX: "Nasdaq 100", GOLD: "Gold", DXY: "US Dollar Index" };
    function cell(v) {
      if (!isNum(v)) return NA;
      var w = Math.min(50, Math.abs(v) * 50);
      return signed(v, 2) + '<span class="cbar" aria-hidden="true"><i class="' + (v >= 0 ? "pos" : "neg") + '" style="width:' + w + '%"></i></span>';
    }
    $("corr-table").innerHTML = "<thead><tr><th>BTC vs</th><th>30 days</th><th>90 days</th></tr></thead><tbody>" +
      ["SPX", "NDX", "GOLD", "DXY"].map(function (k) {
        var r = c[k] || {};
        return "<tr><td>" + names[k] + "</td><td>" + cell(r["30d"]) + "</td><td>" + cell(r["90d"]) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  function renderNetwork() {
    var mp = B("mempool") || {}, fg = B("feargreed") || {}, f = mp.fees || {};
    var fees = '<table class="data" style="margin-top:6px"><tbody>' +
      [["Next block", f.fastestFee], ["30 min", f.halfHourFee], ["1 hour", f.hourFee], ["Economy", f.economyFee]].map(function (r) {
        return "<tr><td>" + r[0] + "</td><td>" + (isNum(r[1]) ? r[1] + " sat/vB" : NA) + "</td></tr>";
      }).join("") + "</tbody></table>";
    var prog = isNum(mp.retarget_progress) ? mp.retarget_progress : 0;
    var retarget = '<div class="mono" style="margin-top:14px">Difficulty retarget</div>' +
      '<div style="height:6px;background:var(--steel-800);margin:8px 0;position:relative"><i style="position:absolute;left:0;top:0;bottom:0;width:' + prog + '%;background:var(--steel-300)"></i></div>' +
      '<div class="chips">' + chip("progress", "<b>" + fixed(prog, 1) + "%</b>") + chip("est.", chg(mp.retarget_change)) + chip("in", "<b>" + (mp.retarget_blocks != null ? fixed(mp.retarget_blocks, 0) : "—") + " blocks</b>") + "</div>";

    $("net-tiles").innerHTML = [
      tile({ label: "Hashrate", code: "BTC", value: isNum(mp.hashrate_eh) ? fixed(mp.hashrate_eh, 0) + "<small>EH/s</small>" : NA, size: "mid",
        sparkId: "hash", meta: ["mempool.space", "1 month"] }),
      tile({ label: "Fees", code: "Block " + (mp.height ? fixed(mp.height, 0) : "—"), value: isNum(f.halfHourFee) ? f.halfHourFee + "<small>sat/vB · 30 min</small>" : NA,
        size: "mid", extra: fees + retarget }),
      tile({ label: "Fear & Greed", code: "Index", value: isNum(fg.value) ? fg.value + "<small>/ 100 · " + esc(fg.label || "") + "</small>" : NA,
        size: "mid", sparkId: "fng", meta: ["alternative.me", "30 days"] })
    ].join("");
    chart($("hash"), { series: [{ name: "Hashrate", color: GREEN, points: mp.hash_series || [] }], x: "time", yFmt: function (v) { return fixed(v, 0) + " EH/s"; }, label: "Bitcoin hashrate, 1 month" });
    chart($("fng"), { series: [{ name: "Fear & Greed", color: GREEN, points: fg.series || [] }], x: "time", yFmt: function (v) { return fixed(v, 0); }, tipX: dayLabel, label: "Fear and Greed index, 30 days" });
  }

  function renderSources() {
    var s = (state.latest || {}).sources || {};
    var keys = Object.keys(s);
    var ok = keys.filter(function (k) { return s[k].ok; }).length;
    $("st-src").innerHTML = '<i class="dot ' + (ok === keys.length ? "on" : "warn") + '" aria-hidden="true"></i>Sources ' + ok + "/" + keys.length + " ok";
    $("src-table").innerHTML = "<thead><tr><th>Source</th><th>Status</th><th>Last success</th><th>Time</th><th style='text-align:left'>Detail</th></tr></thead><tbody>" +
      keys.map(function (k) {
        var x = s[k];
        return "<tr><td>" + esc(x.label || k) + "</td><td>" + (x.ok ? '<span class="up">● OK</span>' : '<span class="down">○ Stale</span>') +
          "</td><td>" + ago(x.at) + "</td><td>" + (isNum(x.ms) ? fixed(x.ms / 1000, 1) + " s" : NA) + '</td><td class="err">' + esc(x.error || "") + "</td></tr>";
      }).join("") + "</tbody>";
  }

  function renderStatus() {
    var L = state.latest;
    $("st-snap").textContent = L ? "Snapshot " + timeLabel(L.updated_ts) + " · " + ago(L.updated) : "Waiting for first data collection";
  }

  function renderAll() {
    if (!state.latest) return;
    [renderSpot, renderDerivs, renderLiquidity, renderMacro, renderNetwork, renderSources, renderStatus].forEach(function (fn) {
      try { fn(); } catch (e) { console.error(fn.name, e); }
    });
  }


  // ───────────────────────── wire (news) ─────────────────────────
  var CAT_LABEL = { tokstable: "Tokenisation & stablecoins", markets: "Markets", regulation: "Regulation", other: "General" };
  var wire = { cat: "all", inst: true, q: "", shown: 30 };
  function when(ts) {
    var s = Date.now() / 1000 - ts, d = new Date(ts * 1000);
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (s < 3600) return { a: Math.max(1, Math.round(s / 60)) + " min", b: hm };
    if (s < 86400) return { a: Math.round(s / 3600) + " h ago", b: hm };
    if (s < 172800) return { a: "Yesterday", b: hm };
    return { a: d.getDate() + " " + MONTHS[d.getMonth()], b: hm };
  }
  function srcLine(it) {
    var more = it.sources.length - 1;
    return esc(it.lead) + (more > 0 ? " +" + more : "");
  }
  function subLine(it) {
    var parts = ['<span class="src" title="' + esc(it.sources.join(", ")) + '">' + srcLine(it) + "</span>"];
    if (it.primary) parts.push('<span class="reg">Regulator</span>');
    parts.push("<span>" + esc(CAT_LABEL[it.cat] || it.cat) + "</span>");
    it.tags.filter(function (t) { return t !== "Stablecoins" && t !== "Tokenisation" || it.cat !== "tokstable"; })
      .slice(0, 2).forEach(function (t) { parts.push("<span>" + esc(t) + "</span>"); });
    if (it.inst && it.why && it.why.length) parts.push('<span class="inst">Inst · ' + esc(it.why.slice(0, 3).join(", ")) + "</span>");
    return parts.join("");
  }
  function link(it, cls) {
    return '<a class="' + (cls || "") + '" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + "</a>";
  }
  function wireMatches(it) {
    if (wire.inst && !it.inst) return false;
    if (wire.cat === "security") { if (it.tags.indexOf("Security & risk") < 0) return false; }
    else if (wire.cat === "primary") { if (!it.primary) return false; }
    else if (wire.cat !== "all" && it.cat !== wire.cat) return false;
    if (wire.q) {
      var hay = (it.title + " " + it.sources.join(" ") + " " + (it.entities || []).join(" ")).toLowerCase();
      if (hay.indexOf(wire.q) < 0) return false;
    }
    return true;
  }
  function renderWire() {
    var n = state.news;
    if (!n) { $("wire-list").innerHTML = '<li><span class="empty">No news yet: it appears after the next collector run</span></li>'; return; }
    var items = n.items || [];
    $("wire-featured").innerHTML = items.filter(function (i) { return i.featured; }).map(function (it) {
      var w = when(it.ts);
      return '<div class="tile feat"><div class="tile-top"><span class="mono">' + srcLine(it) + '</span><span class="mono">' + w.a + "</span></div>" +
        link(it, "h") + '<div class="by mono">' + esc(CAT_LABEL[it.cat] || "") + (it.sources.length > 1 ? " · covered by " + it.sources.length + " outlets" : "") + "</div></div>";
    }).join("") || '<p class="mono">Nothing in the last 24 hours yet</p>';

    var list = items.filter(wireMatches);
    $("wire-list").innerHTML = list.slice(0, wire.shown).map(function (it) {
      var w = when(it.ts);
      return '<li><span class="when"><b>' + w.a + "</b>" + w.b + "</span><div>" + link(it) + '</div><div class="sub">' + subLine(it) + "</div></li>";
    }).join("") || '<li><span class="empty">No stories match these filters</span></li>';
    $("wire-more").hidden = list.length <= wire.shown;
    var f = n.feeds || {}, keys = Object.keys(f), ok = keys.filter(function (k) { return f[k].ok; }).length;
    $("wire-meta").textContent = list.length + " of " + items.length + " stories · last 7 days · updated " + ago(n.updated) + " · " + ok + "/" + keys.length + " feeds ok";
  }
  function renderNewsSources() {
    var f = (state.news || {}).feeds || {};
    $("news-src-table").innerHTML = "<thead><tr><th>Feed</th><th>Status</th><th>Last success</th><th>Items</th><th style='text-align:left'>Detail</th></tr></thead><tbody>" +
      Object.keys(f).map(function (k) {
        var x = f[k];
        var detail = x.error || (x.discovered ? "Feed moved, now using " + x.discovered : "") || x.note || "";
        return "<tr><td>" + esc(x.name || k) + "</td><td>" + (x.ok ? '<span class="up">● OK</span>' : '<span class="down">○ Stale</span>') +
          "</td><td>" + ago(x.at) + "</td><td>" + (isNum(x.kept) ? x.kept + (x.items !== x.kept ? " / " + x.items : "") : NA) + '</td><td class="err">' + esc(detail) + "</td></tr>";
      }).join("") + "</tbody>";
  }
  document.querySelectorAll("#wire-cats button").forEach(function (b) {
    b.addEventListener("click", function () {
      wire.cat = b.getAttribute("data-cat"); wire.shown = 30;
      document.querySelectorAll("#wire-cats button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      renderWire();
    });
  });
  $("wire-inst").addEventListener("change", function (e) { wire.inst = e.target.checked; wire.shown = 30; renderWire(); });
  var qTimer; $("wire-q").addEventListener("input", function (e) {
    clearTimeout(qTimer); qTimer = setTimeout(function () { wire.q = e.target.value.trim().toLowerCase(); wire.shown = 30; renderWire(); }, 150);
  });
  $("wire-more").addEventListener("click", function () { wire.shown += 30; renderWire(); });

  // ───────────────────────── data loading ─────────────────────────
  function getJSON(path) {
    return fetch(path + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function load() {
    getJSON("data/news.json").then(function (n) { state.news = n; renderWire(); renderNewsSources(); })
      .catch(function () { state.news = state.news || null; renderWire(); });
    Promise.all([getJSON("data/latest.json"), getJSON("data/history.json").catch(function () { return null; })])
      .then(function (res) { state.latest = res[0]; state.history = res[1]; renderAll(); })
      .catch(function (e) {
        console.warn(e);
        $("st-snap").textContent = state.latest ? "Refresh failed, showing previous snapshot" : "No data yet: run the collect workflow once";
      });
  }

  // ───────────────────────── live prices (Coinbase) ─────────────────────────
  var PRODUCTS = { "BTC-USD": "BTC", "ETH-USD": "ETH", "SOL-USD": "SOL", "XRP-USD": "XRP" };
  var pending = {}, raf = 0, retry = 1000;
  function setLive(on, text) {
    $("st-live").innerHTML = '<i class="dot ' + (on ? "on" : "") + '" aria-hidden="true"></i><span>' + text + "</span>";
  }
  function flush() {
    raf = 0;
    Object.keys(pending).forEach(function (sym) {
      var p = pending[sym], pe = $("px-" + sym), ce = $("chg-" + sym);
      if (pe) {
        var txt = price(p.price);
        if (pe.textContent !== txt.replace(/<[^>]+>/g, "")) {
          pe.innerHTML = txt; pe.classList.remove("flash"); void pe.offsetWidth; pe.classList.add("flash");
        }
      }
      if (ce && ce.firstChild) ce.firstChild.innerHTML = "24h " + chg(p.chg24);
    });
    pending = {};
  }
  function connect() {
    if (!("WebSocket" in window)) return setLive(false, "Live prices unavailable");
    var ws;
    try { ws = new WebSocket("wss://ws-feed.exchange.coinbase.com"); } catch (e) { return setLive(false, "Live prices unavailable"); }
    ws.onopen = function () {
      retry = 1000;
      ws.send(JSON.stringify({ type: "subscribe", product_ids: Object.keys(PRODUCTS), channels: ["ticker"] }));
      setLive(true, "Live · Coinbase");
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== "ticker" || !PRODUCTS[m.product_id]) return;
      var sym = PRODUCTS[m.product_id], p = parseFloat(m.price), o = parseFloat(m.open_24h);
      var rec = { price: p, chg24: o ? (p / o - 1) * 100 : null };
      state.live[sym] = rec; pending[sym] = rec;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    ws.onclose = function () {
      setLive(false, "Live prices reconnecting");
      setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // ───────────────────────── nav highlight ─────────────────────────
  if ("IntersectionObserver" in window) {
    var links = {};
    document.querySelectorAll(".nav a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { var a = links[en.target.id]; if (a) a.setAttribute("aria-current", en.isIntersecting ? "true" : "false"); });
    }, { rootMargin: "-40% 0px -55% 0px" });
    Object.keys(links).forEach(function (id) { var s = $(id); if (s) io.observe(s); });
  }

  load();
  connect();
  setInterval(load, REFRESH_MS);
  setInterval(function () { renderStatus(); if (state.latest) renderSources(); }, 30000);
  window.addEventListener("scroll", hideTip, { passive: true });
})();
