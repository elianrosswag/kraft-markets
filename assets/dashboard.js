/* KRAFT Markets: terminal frontend.
 * Reads data/latest.json, history.json and news.json (written by the collector),
 * streams live prices from Coinbase, and draws everything with plain SVG/HTML.
 * No framework, no chart library, no build step.
 */
(function () {
  "use strict";

  var GREEN = "#39FF14", STEEL = "#dfe2e5", STEEL5 = "#80858b";
  var REFRESH_MS = 5 * 60 * 1000;
  var state = { latest: null, history: null, news: null, live: {}, hide: {} };
  var SPOT = [["BTC", "Bitcoin"], ["ETH", "Ether"], ["SOL", "Solana"], ["XRP", "XRP"]];

  // ───────────────────────── helpers ─────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  var NA = '<span class="na">—</span>';
  function fixed(v, d) { return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function compact(v, p) {
    if (!isNum(v)) return NA;
    var a = Math.abs(v); p = p || "";
    if (a >= 1e12) return p + fixed(v / 1e12, 2) + "T";
    if (a >= 1e9) return p + fixed(v / 1e9, a >= 1e11 ? 0 : 1) + "B";
    if (a >= 1e6) return p + fixed(v / 1e6, 1) + "M";
    if (a >= 1e3) return p + fixed(v / 1e3, 1) + "K";
    return p + fixed(v, 0);
  }
  function usd(v) { return compact(v, "$"); }
  function price(v) { return !isNum(v) ? NA : v >= 1000 ? fixed(v, 0) : v >= 1 ? fixed(v, 2) : fixed(v, 4); }
  function signed(v, d, u) {
    if (!isNum(v)) return NA;
    return (v > 0 ? "+" : v < 0 ? "−" : "±") + fixed(Math.abs(v), d) + (u || "");
  }
  function chg(v, d, u) {
    if (!isNum(v)) return NA;
    var c = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
    return '<b class="' + c + '">' + (c === "up" ? "▲" : c === "down" ? "▼" : "") + signed(v, d === undefined ? 2 : d, u === undefined ? "%" : u) + "</b>";
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ago(iso) {
    if (!iso) return "never";
    var s = (Date.now() - (typeof iso === "number" ? iso * 1000 : new Date(iso).getTime())) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 172800) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayLabel(ts) { var d = new Date(ts * 1000); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  function hhmm(d, utc) {
    var h = utc ? d.getUTCHours() : d.getHours(), m = utc ? d.getUTCMinutes() : d.getMinutes();
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  function timeLabel(ts) { return dayLabel(ts) + " " + hhmm(new Date(ts * 1000), true) + " UTC"; }
  function percentile(series, v) {
    var vals = series.map(function (p) { return p[1]; }).filter(isNum);
    if (!vals.length || !isNum(v)) return null;
    return Math.round(vals.filter(function (x) { return x <= v; }).length / vals.length * 100);
  }
  function ord(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  var store = {
    get: function (k) { try { return localStorage.getItem("kraft." + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem("kraft." + k, v); } catch (e) {} }
  };

  // ───────────────────────── tooltip ─────────────────────────
  var tip = $("tip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - w - 8)) + "px";
    tip.style.top = (y - h - 12 < 8 ? y + 16 : y - h - 12) + "px";
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener("pointerover", function (e) {
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (t) showTip(t.getAttribute("data-tip"), e.clientX, e.clientY);
  });
  document.addEventListener("pointermove", function (e) {
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (t) showTip(t.getAttribute("data-tip"), e.clientX, e.clientY);
  });
  document.addEventListener("pointerout", function (e) {
    if (e.target.closest && e.target.closest("[data-tip]")) hideTip();
  });

  // ───────────────────────── SVG line chart ─────────────────────────
  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  var observed = new WeakMap();
  var ro = "ResizeObserver" in window ? new ResizeObserver(function (es) {
    es.forEach(function (e) { var o = observed.get(e.target); if (o) draw(e.target, o); });
  }) : null;
  function chart(host, opts) {
    if (!host) return;
    if (!observed.has(host) && ro) ro.observe(host);
    observed.set(host, opts); draw(host, opts);
  }
  function draw(host, o) {
    var W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    host.innerHTML = "";
    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H }, host);
    var series = (o.series || []).filter(function (s) { return !s.hidden; }).map(function (s) {
      return Object.assign({}, s, { points: (s.points || []).filter(function (p) { return isNum(p[0]) && isNum(p[1]); }) });
    }).filter(function (s) { return s.points.length; });
    if (!series.length || (series.every(function (s) { return s.points.length < 2; }) && !o.dots)) {
      el("text", { x: o.axes ? 48 : 0, y: H / 2, class: "empty" }, svg).textContent = o.empty || "No data yet";
      return;
    }
    var all = [].concat.apply([], series.map(function (s) { return s.points; }));
    var xs = all.map(function (p) { return p[0]; }), ys = all.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (o.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    var pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    var L = o.axes ? 46 : 0, R = o.axes ? 6 : 0, T = o.axes ? 6 : 2, B = o.axes ? 20 : 2;
    var sx = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - R); };
    var sy = function (y) { return T + (1 - (y - y0) / (y1 - y0)) * (H - T - B); };
    var yFmt = o.yFmt || function (v) { return fixed(v, 0); };
    if (o.axes) {
      for (var i = 0; i <= 3; i++) {
        var yv = y0 + (y1 - y0) * (i / 3), yy = Math.round(sy(yv)) + 0.5;
        el("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "grid-l" }, svg);
        el("text", { x: L - 7, y: yy + 3, "text-anchor": "end", class: "axis-t" }, svg).textContent = yFmt(yv);
      }
      var xt = o.xTicks || 4;
      for (var j = 0; j < xt; j++) {
        var xv = x0 + (x1 - x0) * (j / (xt - 1));
        el("text", { x: sx(xv), y: H - 4, "text-anchor": j === 0 ? "start" : j === xt - 1 ? "end" : "middle", class: "axis-t" }, svg)
          .textContent = (o.xFmt || (o.x === "time" ? dayLabel : function (v) { return fixed(v, 0); }))(xv);
      }
    }
    if (o.zero && y0 < 0 && y1 > 0) { var zy = Math.round(sy(0)) + 0.5; el("line", { x1: L, x2: W - R, y1: zy, y2: zy, class: "zero-l" }, svg); }
    series.forEach(function (s) {
      var d = s.points.map(function (p, k) { return (k ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1); }).join("");
      if (o.area && series.length === 1) {
        var base = sy(Math.max(y0, Math.min(0, y1)) === 0 && o.zero ? 0 : y0);
        el("path", { d: d + "L" + sx(s.points[s.points.length - 1][0]).toFixed(1) + " " + base + "L" + sx(s.points[0][0]).toFixed(1) + " " + base + "Z", fill: s.color, "fill-opacity": 0.07, stroke: "none" }, svg);
      }
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": o.axes ? 1.75 : 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (o.dots) s.points.forEach(function (p) { el("circle", { cx: sx(p[0]), cy: sy(p[1]), r: 3.5, fill: s.color, stroke: "#000", "stroke-width": 2 }, svg); });
      if (o.endDot) { var lp = s.points[s.points.length - 1]; el("circle", { cx: sx(lp[0]), cy: sy(lp[1]), r: 3, fill: s.color }, svg); }
    });
    var cross = el("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" }, svg);
    var marks = series.map(function (s) { return el("circle", { r: 4, fill: s.color, stroke: "#000", "stroke-width": 2, visibility: "hidden" }, svg); });
    var hit = el("rect", { x: L, y: 0, width: Math.max(0, W - L - R), height: H, fill: "transparent" }, svg);
    function move(ev) {
      var rect = svg.getBoundingClientRect(), mx = x0 + (ev.clientX - rect.left - L) / (W - L - R) * (x1 - x0), rows = [], cx = null;
      series.forEach(function (s, k) {
        var best = s.points[0];
        s.points.forEach(function (p) { if (Math.abs(p[0] - mx) < Math.abs(best[0] - mx)) best = p; });
        if (cx === null) cx = best[0];
        marks[k].setAttribute("cx", sx(best[0])); marks[k].setAttribute("cy", sy(best[1])); marks[k].setAttribute("visibility", "visible");
        rows.push((series.length > 1 ? esc(s.name) + " " : "") + "<b>" + (o.tipY || yFmt)(best[1]) + "</b>" + (s.meta ? " · " + esc(s.meta(best)) : ""));
      });
      cross.setAttribute("x1", sx(cx)); cross.setAttribute("x2", sx(cx)); cross.setAttribute("visibility", "visible");
      showTip((o.tipX || (o.x === "time" ? timeLabel : function (v) { return fixed(v, 0); }))(cx) + "<br>" + rows.join("<br>"), ev.clientX, ev.clientY);
    }
    function leave() { cross.setAttribute("visibility", "hidden"); marks.forEach(function (m) { m.setAttribute("visibility", "hidden"); }); hideTip(); }
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerleave", leave); hit.addEventListener("pointerdown", move);
    svg.setAttribute("role", "img"); if (o.label) svg.setAttribute("aria-label", o.label);
  }
  // Static inline sparkline (for table cells)
  function spark(vals, w, h) {
    vals = (vals || []).filter(isNum);
    if (vals.length < 2) return "";
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), r = mx - mn || 1;
    var d = vals.map(function (v, i) { return (i ? "L" : "M") + (i / (vals.length - 1) * w).toFixed(1) + " " + (h - 2 - (v - mn) / r * (h - 4)).toFixed(1); }).join("");
    var up = vals[vals.length - 1] >= vals[0];
    return '<svg class="spark" width="' + w + '" height="' + h + '" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + (up ? GREEN : STEEL) + '" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }
  function stack(parts, cls) {
    var tot = parts.reduce(function (a, p) { return a + (p.v || 0); }, 0) || 1;
    return '<div class="stack ' + (cls || "") + '">' + parts.filter(function (p) { return p.v > 0; }).map(function (p) {
      var w = p.v / tot * 100;
      return '<i class="' + p.cls + '" style="width:' + w + '%" data-tip="' + esc(p.tip || p.label) + '">' + (w > 16 && p.label ? "<span>" + esc(p.label) + "</span>" : "") + "</i>";
    }).join("") + "</div>";
  }

  // ───────────────────────── drawers & keys ─────────────────────────
  var drawers = { wire: $("wire"), guide: $("guide") };
  var pinned = { wire: store.get("pin.wire") === "1", guide: store.get("pin.guide") === "1" };
  var wide = function () { return window.innerWidth >= 1280; };
  function setDrawer(name, open) {
    var d = drawers[name];
    d.classList.toggle("open", open);
    $("open-" + name).setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("pin-" + name, open && pinned[name] && wide());
    var anyOverlay = Object.keys(drawers).some(function (k) { return drawers[k].classList.contains("open") && !(pinned[k] && wide()); });
    $("scrim").hidden = !anyOverlay;
    if (open && name === "wire") markSeen();
    if (open) setTimeout(function () { d.focus({ preventScroll: true }); }, 50);
    setTimeout(redrawAll, 320);
  }
  function toggle(name) { setDrawer(name, !drawers[name].classList.contains("open")); }
  function openGuide(id) {
    setDrawer("guide", true);
    var t = document.getElementById(id);
    if (t) {
      document.querySelectorAll(".gl dt.hl").forEach(function (x) { x.classList.remove("hl"); });
      if (t.tagName === "DT") t.classList.add("hl");
      setTimeout(function () { t.scrollIntoView({ block: "start", behavior: "smooth" }); }, 120);
    }
  }
  $("open-wire").addEventListener("click", function () { toggle("wire"); });
  $("open-guide").addEventListener("click", function () { toggle("guide"); });
  $("scrim").addEventListener("click", function () {
    Object.keys(drawers).forEach(function (k) { if (!(pinned[k] && wide())) setDrawer(k, false); });
  });
  document.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { setDrawer(b.getAttribute("data-close"), false); }); });
  document.querySelectorAll("[data-pin]").forEach(function (b) {
    var n = b.getAttribute("data-pin");
    b.setAttribute("aria-pressed", pinned[n] ? "true" : "false");
    b.addEventListener("click", function () {
      pinned[n] = !pinned[n]; store.set("pin." + n, pinned[n] ? "1" : "0");
      b.setAttribute("aria-pressed", pinned[n] ? "true" : "false"); setDrawer(n, true);
    });
  });
  document.addEventListener("click", function (e) {
    var g = e.target.closest && e.target.closest("[data-guide]");
    if (g) { e.preventDefault(); openGuide(g.getAttribute("data-guide")); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") { if (e.key === "Escape") e.target.blur(); return; }
    var k = e.key.toLowerCase();
    if (k === "w") toggle("wire");
    else if (k === "g" || k === "?") toggle("guide");
    else if (k === "escape") { setDrawer("wire", false); setDrawer("guide", false); }
    else if (/^[0-5]$/.test(k)) {
      var ids = ["s-state", "s-spot", "s-derivs", "s-liq", "s-macro", "s-net"], s = $(ids[+k]);
      if (s) s.scrollIntoView({ behavior: "smooth" });
    }
  });
  window.addEventListener("resize", function () {
    document.documentElement.style.setProperty("--top-h", $("top").offsetHeight + "px");
    Object.keys(drawers).forEach(function (k) { document.body.classList.toggle("pin-" + k, drawers[k].classList.contains("open") && pinned[k] && wide()); });
  });
  document.documentElement.style.setProperty("--top-h", $("top").offsetHeight + "px");
  if (wide()) Object.keys(pinned).forEach(function (k) { if (pinned[k]) setDrawer(k, true); });

  function redrawAll() {
    document.querySelectorAll(".chart").forEach(function (h) { var o = observed.get(h); if (o) draw(h, o); });
  }

  // ───────────────────────── clock ─────────────────────────
  function tick() {
    var d = new Date();
    $("clock").textContent = hhmm(d, true) + ":" + String(d.getUTCSeconds()).padStart(2, "0") + " UTC";
  }
  tick(); setInterval(tick, 1000);

  // ───────────────────────── data accessors ─────────────────────────
  function B(n) { return ((state.latest || {}).blocks || {})[n] || {}; }
  function D() { return (state.latest || {}).derived || {}; }
  function asset(sym) {
    var a = (B("coingecko").assets || {})[sym] || {}, l = state.live[sym] || {};
    var spark24 = (a.spark7d || []).slice(-13);
    return {
      name: a.name, price: isNum(l.price) ? l.price : a.price, chg24: isNum(l.chg24) ? l.chg24 : a.chg24,
      lo: isNum(l.lo) ? l.lo : (spark24.length ? Math.min.apply(null, spark24) : null),
      hi: isNum(l.hi) ? l.hi : (spark24.length ? Math.max.apply(null, spark24) : null),
      chg7d: a.chg7d, chg30d: a.chg30d, mcap: a.mcap, vol24: a.vol24, spark: a.spark7d || [], live: !!l.price
    };
  }

  // ───────────────────────── ticker tape ─────────────────────────
  function renderTape() {
    var g = B("coingecko_global"), mac = B("macro").assets || {}, fg = B("feargreed"), st = B("stablecoins");
    var items = SPOT.map(function (s) {
      var a = asset(s[0]);
      return { id: "tk-" + s[0], s: s[0], v: price(a.price), c: chg(a.chg24) };
    }).concat([["SPX", "S&P"], ["NDX", "NDX"], ["DXY", "DXY"], ["US10Y", "US10Y"], ["GOLD", "GOLD"], ["VIX", "VIX"]].map(function (m) {
      var x = mac[m[0]] || {};
      return { s: m[1], v: m[0] === "US10Y" ? (isNum(x.price) ? fixed(x.price, 2) + "%" : NA) : price(x.price), c: m[0] === "US10Y" ? chg(isNum(x.abs1d) ? x.abs1d * 100 : null, 0, "bp") : chg(x.chg1d) };
    })).concat([
      { s: "MCAP", v: usd(g.total_mcap), c: chg(g.mcap_chg24) },
      { s: "BTC.D", v: isNum(g.btc_dom) ? fixed(g.btc_dom, 1) + "%" : NA, c: "" },
      { s: "STABLES", v: usd(st.total), c: chg(st.chg7d) },
      { s: "F&G", v: isNum(fg.value) ? fg.value : NA, c: '<span class="dim">' + esc(fg.label || "") + "</span>" }
    ]);
    var html = items.map(function (t) {
      return '<span class="tk"' + (t.id ? ' data-sym="' + t.s + '"' : "") + '><span class="s">' + t.s + '</span><span class="v">' + t.v + '</span><span class="c">' + t.c + "</span></span>";
    }).join("");
    $("tape").innerHTML = html + html; // doubled for a seamless loop
  }

  // ───────────────────────── signals ─────────────────────────
  function zoneOf(v, zones) { for (var i = 0; i < zones.length; i++) if (v < zones[i][0]) return zones[i][1]; return zones[zones.length - 1][1]; }
  function signal(o) {
    var v = o.value, has = isNum(v);
    var st = has ? zoneOf(v, o.zones) : "NO DATA";
    var hot = has && o.calm.indexOf(st) < 0;
    var pos = has ? clamp((v - o.min) / (o.max - o.min), 0, 1) * 100 : 50;
    var ticks = o.zones.slice(0, -1).map(function (z) { var p = (z[0] - o.min) / (o.max - o.min) * 100; return p > 0 && p < 100 ? '<i class="zone" style="left:' + p + '%"></i>' : ""; }).join("");
    return '<div class="sig c2' + (hot ? " hot" : "") + '" data-guide="' + o.guide + '" role="button" tabindex="0" aria-label="' + esc(o.label + ": " + st) + '">' +
      '<div class="lab"><span>' + o.label + "</span><span>" + (o.sub || "") + "</span></div>" +
      '<div class="state">' + st + "</div>" +
      '<div class="val">' + (has ? o.text : "Waiting for data") + "</div>" +
      '<div class="scale" data-tip="' + esc(o.tip) + '"><i class="trk"></i>' + ticks + (has ? '<i class="mk" style="left:' + pos + '%"></i>' : "") +
      '<div class="ends"><span>' + o.minL + "</span><span>" + o.maxL + "</span></div></div></div>";
  }
  function renderSignals() {
    var d = D(), der = B("deribit"), st = B("stablecoins"), fg = B("feargreed"), corr = (B("macro").corr || {}).NDX || {};
    var fund = ((d.funding || {}).BTC || {}).avg, dv = (der.BTC || {}).dvol, fb = d.basis_front_btc || {};
    var dvp = percentile((der.BTC || {}).dvol_series || [], dv);
    $("signals").innerHTML = [
      signal({ label: "Leverage", sub: "BTC perps", guide: "g-sig-leverage", value: fund, min: -10, max: 30, minL: "−10%", maxL: "30%",
        zones: [[0, "SHORTS PAY"], [8, "NEUTRAL"], [20, "ELEVATED"], [Infinity, "OVERHEATED"]], calm: ["NEUTRAL"],
        text: "Funding <b>" + signed(fund, 1, "%") + "</b> ann. · 3 venues", tip: "Average annualised BTC funding. Zones at 0%, 8%, 20%." }),
      signal({ label: "Volatility", sub: "BTC DVOL", guide: "g-sig-vol", value: dv, min: 20, max: 100, minL: "20", maxL: "100",
        zones: [[35, "COMPRESSED"], [55, "NORMAL"], [75, "ELEVATED"], [Infinity, "STRESSED"]], calm: ["NORMAL"],
        text: "DVOL <b>" + (isNum(dv) ? fixed(dv, 1) : "—") + "</b>" + (dvp !== null ? " · " + ord(dvp) + " pct 30d" : ""), tip: "BTC 30-day implied volatility. Zones at 35, 55, 75." }),
      signal({ label: "Carry", sub: "BTC basis", guide: "g-sig-carry", value: fb.basis, min: -5, max: 20, minL: "−5%", maxL: "20%",
        zones: [[0, "BACKWARDATION"], [5, "THIN"], [12, "NORMAL"], [Infinity, "RICH"]], calm: ["NORMAL"],
        text: "Front future <b>" + signed(fb.basis, 2, "%") + "</b>" + (fb.days ? " · " + fixed(fb.days, 0) + "d" : ""), tip: "Annualised premium of the front quarterly future over spot. Zones at 0%, 5%, 12%." }),
      signal({ label: "Liquidity", sub: "Stablecoins", guide: "g-sig-liq", value: st.chg30d, min: -8, max: 8, minL: "−8%", maxL: "+8%",
        zones: [[-2, "CONTRACTING"], [2, "FLAT"], [Infinity, "EXPANDING"]], calm: ["FLAT"],
        text: "Supply <b>" + signed(st.chg30d, 2, "%") + "</b> 30d · " + usd(st.total), tip: "30-day change in USD stablecoin supply. Zones at −2%, +2%." }),
      signal({ label: "Sentiment", sub: "Fear & Greed", guide: "g-sig-sent", value: fg.value, min: 0, max: 100, minL: "0", maxL: "100",
        zones: [[25, "EXTREME FEAR"], [45, "FEAR"], [55, "NEUTRAL"], [75, "GREED"], [Infinity, "EXTREME GREED"]], calm: ["NEUTRAL"],
        text: "Index <b>" + (isNum(fg.value) ? fg.value : "—") + "</b> / 100", tip: "Crypto Fear & Greed. Zones at 25, 45, 55, 75." }),
      signal({ label: "Macro link", sub: "BTC × NDX", guide: "g-sig-macro", value: corr["30d"], min: -1, max: 1, minL: "−1", maxL: "+1",
        zones: [[-0.2, "INVERSE"], [0.2, "DECOUPLED"], [0.5, "LOOSE"], [Infinity, "RISK ASSET"]], calm: ["LOOSE", "DECOUPLED"],
        text: "30d corr <b>" + signed(corr["30d"], 2) + "</b> · 90d " + signed(corr["90d"], 2), tip: "Correlation of daily BTC and Nasdaq 100 returns. Zones at −0.2, 0.2, 0.5." })
    ].join("");
    $("state-asof").textContent = state.latest ? "as of " + timeLabel(state.latest.updated_ts) : "";
  }

  // ───────────────────────── spot & structure ─────────────────────────
  function rangeCell(a) {
    if (!isNum(a.lo) || !isNum(a.hi) || a.hi <= a.lo) return NA;
    var p = clamp((a.price - a.lo) / (a.hi - a.lo), 0, 1) * 100;
    return '<span class="rng" data-tip="24h low ' + price(a.lo) + " · high " + price(a.hi) + '"><span>' + price(a.lo) + '</span><span class="bar"><i style="left:' + p + '%"></i></span><span>' + price(a.hi) + "</span></span>";
  }
  function renderSpot() {
    $("spot-table").innerHTML = '<thead><tr><th>Asset</th><th>Last (USD)</th><th>24h</th><th class="h-sm">24h range</th><th class="h-md">7d</th><th class="h-md">7d %</th><th class="h-md">30d %</th><th class="h-sm">Mcap</th></tr></thead><tbody>' +
      SPOT.map(function (s) {
        var a = asset(s[0]);
        return '<tr><td><span class="sym">' + s[0] + "<small>" + s[1] + '</small></span></td><td><span class="px" id="px-' + s[0] + '">' + price(a.price) + '</span></td><td class="chg" id="c24-' + s[0] + '">' + chg(a.chg24) +
          '</td><td class="h-sm" id="rng-' + s[0] + '">' + rangeCell(a) + '</td><td class="h-md">' + spark(a.spark, 110, 30) + '</td><td class="chg h-md">' + chg(a.chg7d) + '</td><td class="chg h-md">' + chg(a.chg30d) +
          '</td><td class="h-sm"><span class="mono">' + usd(a.mcap) + "</span></td></tr>";
      }).join("") + "</tbody>";

    var g = B("coingecko_global"), d = D(), st = B("stablecoins");
    var btc = g.btc_dom || 0, eth = g.eth_dom || 0, ss = isNum(st.total) && isNum(g.total_mcap) ? st.total / g.total_mcap * 100 : null;
    $("structure").innerHTML =
      '<div class="hero">' + usd(g.total_mcap) + '</div><div class="chips"><span>24h ' + chg(g.mcap_chg24) + "</span><span>Vol " + usd(g.total_vol) + "</span></div>" +
      '<div class="mono" style="margin-top:16px">Dominance</div>' +
      stack([{ v: btc, cls: "s1", label: "BTC " + fixed(btc, 1) + "%" }, { v: eth, cls: "s2", label: "ETH " + fixed(eth, 1) + "%" }, { v: Math.max(0, 100 - btc - eth), cls: "s4", label: "Rest " + fixed(Math.max(0, 100 - btc - eth), 1) + "%" }]) +
      '<div class="lg"><span><i style="background:' + GREEN + '"></i>BTC</span><span><i style="background:' + STEEL + '"></i>ETH</span><span><i style="background:#3b3e42"></i>Rest</span></div>' +
      '<div class="kv" style="margin-top:8px"><span class="k">ETH / BTC</span><span class="v">' + (isNum(d.ethbtc) ? fixed(d.ethbtc, 5) : NA) + "</span></div>" +
      '<div class="kv"><span class="k">Stablecoin share</span><span class="v">' + (isNum(ss) ? fixed(ss, 1) + "%" : NA) + '</span><span class="s">of total crypto market cap</span></div>';
  }

  // ───────────────────────── derivatives ─────────────────────────
  var VENUES = [["deribit", "Deribit"], ["hyperliquid", "Hyperliq."], ["okx", "OKX"], ["avg", "Avg"]];
  function heat(v) {
    if (!isNum(v)) return "background:#111214;color:#3b3e42";
    if (v >= 0) { var a = 0.1 + clamp(v / 25, 0, 1) * 0.75; return "background:rgba(57,255,20," + a.toFixed(2) + ");color:" + (a > 0.5 ? "#000" : "#dfe2e5"); }
    var b = 0.1 + clamp(-v / 15, 0, 1) * 0.5; return "background:rgba(223,226,229," + b.toFixed(2) + ");color:" + (b > 0.4 ? "#000" : "#dfe2e5");
  }
  function renderDerivs() {
    var d = D(), f = d.funding || {}, oi = d.perp_oi || {}, der = B("deribit");
    // heatmap
    var h = '<div class="hm"><span></span>' + VENUES.map(function (v) { return '<span class="hd">' + v[1] + "</span>"; }).join("");
    ["BTC", "ETH", "SOL"].forEach(function (s) {
      h += '<span class="rl">' + s + "</span>";
      VENUES.forEach(function (v) {
        var x = (f[s] || {})[v[0]];
        h += '<span class="cell' + (v[0] === "avg" ? " avg" : "") + '" style="' + heat(x) + '" data-tip="' + s + " · " + v[1] + "<br><b>" + (isNum(x) ? signed(x, 2, "%") + " annualised" : "not listed") + '</b>">' + (isNum(x) ? signed(x, 1, "%") : "—") + "</span>";
      });
    });
    $("heatmap").innerHTML = h + '</div><div class="hm-scale"><span>−15%</span><i></i><span>+25%</span></div><p class="fine">Green: longs pay shorts. Grey: shorts pay longs. Hyperliquid and OKX have a ~10.95% baseline.</p>';

    // basis curve
    var colors = { BTC: GREEN, ETH: STEEL };
    var series = ["BTC", "ETH"].map(function (c) {
      return { name: c, color: colors[c], hidden: state.hide["b" + c], points: ((der[c] || {}).curve || []).map(function (p) { return [p.days, p.basis, p.instrument, p.expiry]; }),
        meta: function (p) { return p[2] + " · exp " + p[3]; } };
    });
    chart($("basis-chart"), { series: series, x: "num", axes: true, dots: true, zero: true,
      yFmt: function (v) { return fixed(v, 1) + "%"; }, tipY: function (v) { return signed(v, 2, "%"); },
      xFmt: function (v) { return fixed(v, 0) + "d"; }, tipX: function (v) { return fixed(v, 0) + " days to expiry"; }, label: "Futures basis by days to expiry" });
    $("basis-legend").innerHTML = series.map(function (s) {
      return '<button type="button" data-hide="b' + s.name + '" aria-pressed="' + (!s.hidden) + '"><i style="background:' + s.color + '"></i>' + s.name + "</button>";
    }).join("");

    // vol
    $("vol").innerHTML = ["BTC", "ETH"].map(function (c) {
      var x = der[c] || {}, ser = x.dvol_series || [], vals = ser.map(function (p) { return p[1]; }).filter(isNum);
      var mn = vals.length ? Math.min.apply(null, vals) : null, mx = vals.length ? Math.max.apply(null, vals) : null;
      var p = isNum(x.dvol) && mx > mn ? (x.dvol - mn) / (mx - mn) * 100 : null, pc = percentile(ser, x.dvol);
      return '<div class="vrow"><div class="top-l"><span class="nm">' + c + ' DVOL</span><span class="chg">' + chg(x.dvol_chg24, 1, " pts") + "</span></div>" +
        '<div class="big">' + (isNum(x.dvol) ? fixed(x.dvol, 1) : NA) + "</div>" +
        (p !== null ? '<div class="pctbar" data-tip="30d range ' + fixed(mn, 1) + "–" + fixed(mx, 1) + '"><i style="left:' + p + '%"></i></div><div class="pctlbl"><span>' + fixed(mn, 1) + "</span><span>" + ord(pc) + " pct 30d</span><span>" + fixed(mx, 1) + "</span></div>" : "") + "</div>";
    }).join("") + '<div class="chart short" id="dvol-chart"></div><div class="lg" style="margin-top:6px"><span><i style="background:' + GREEN + '"></i>BTC</span><span><i style="background:' + STEEL + '"></i>ETH</span><span>30 days</span></div>';
    chart($("dvol-chart"), { series: ["BTC", "ETH"].map(function (c) { return { name: c, color: colors[c], points: (der[c] || {}).dvol_series || [] }; }),
      x: "time", yFmt: function (v) { return fixed(v, 1); }, label: "DVOL 30 days" });

    // OI by venue
    var vcls = { deribit: "s2", hyperliquid: "s1", okx: "s3" };
    $("oi").innerHTML = ["BTC", "ETH", "SOL"].map(function (s) {
      var o = oi[s] || {};
      return '<div class="oibar"><div class="t"><b>' + s + "</b><span>" + usd(o.total) + "</span></div>" +
        stack(["deribit", "hyperliquid", "okx"].map(function (v) {
          var share = o.total ? (o[v] || 0) / o.total * 100 : 0;
          return { v: o[v] || 0, cls: vcls[v], label: fixed(share, 0) + "%", tip: s + " · " + v.charAt(0).toUpperCase() + v.slice(1) + "<br><b>" + usd(o[v]) + "</b> · " + fixed(share, 0) + "% of total" };
        })) + "</div>";
    }).join("") + '<div class="lg"><span><i style="background:' + STEEL + '"></i>Deribit</span><span><i style="background:' + GREEN + '"></i>Hyperliquid</span><span><i style="background:' + STEEL5 + '"></i>OKX</span></div>';

    // funding history
    var hh = state.history, pts = [];
    if (hh && hh.rows) { var fi = hh.fields.indexOf("funding_btc"); pts = hh.rows.map(function (r) { return [r[0], r[fi]]; }).filter(function (p) { return isNum(p[1]); }); }
    chart($("funding-hist"), { series: [{ name: "BTC funding", color: GREEN, points: pts }], x: "time", axes: true, zero: true, area: true, endDot: true,
      yFmt: function (v) { return fixed(v, 1) + "%"; }, tipY: function (v) { return signed(v, 2, "%"); }, empty: "Collecting, one point per hour", label: "BTC funding history" });
    $("funding-hist-note").textContent = pts.length ? pts.length + " hourly point" + (pts.length > 1 ? "s" : "") + " since " + dayLabel(pts[0][0]) + " · grows by one every hour" : "Fills in as the collector runs";

    // options
    $("options").innerHTML = ["BTC", "ETH"].map(function (c) {
      var x = der[c] || {}, fb = d["basis_front_" + c.toLowerCase()] || {}, r = x.pcr_oi;
      var p = isNum(r) ? clamp((r - 0.25) / 1.5, 0, 1) * 100 : 50, mid = (1 - 0.25) / 1.5 * 100;
      return '<div class="vrow"><div class="top-l"><span class="nm">' + c + ' put / call OI</span><span class="mono">' + usd(x.options_oi) + ' OI</span></div>' +
        '<div class="big">' + (isNum(r) ? fixed(r, 2) : NA) + "</div>" +
        '<div class="gauge2" data-tip="Below 1: calls dominate · above 1: puts dominate"><i class="trk"></i><i class="mid" style="left:' + mid + '%"></i>' +
        (isNum(r) ? '<i class="fill" style="left:' + Math.min(p, mid) + "%;width:" + Math.abs(p - mid) + '%"></i><i class="mk" style="left:' + p + '%"></i>' : "") + "</div>" +
        '<div class="pctlbl"><span>calls</span><span>1.0</span><span>puts</span></div>' +
        '<div class="kv"><span class="k">Front basis</span><span class="v">' + signed(fb.basis, 2, "%") + '</span><span class="s">' + (fb.instrument || "") + "</span></div></div>";
    }).join("");
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-hide]");
    if (!b) return;
    var k = b.getAttribute("data-hide"); state.hide[k] = !state.hide[k]; renderDerivs();
  });

  // ───────────────────────── liquidity ─────────────────────────
  function renderLiquidity() {
    var st = B("stablecoins"), tv = B("tvl");
    $("stables-head").innerHTML = '<div class="hero">' + usd(st.total) + '</div><div class="chips"><span>7d ' + chg(st.chg7d) + "</span><span>30d " + chg(st.chg30d) +
      "</span><span>7d net " + (isNum(st.abs7d) ? '<b class="' + (st.abs7d >= 0 ? "up" : "down") + '">' + (st.abs7d >= 0 ? "+" : "−") + usd(Math.abs(st.abs7d)) + "</b>" : NA) + "</span></div>";
    chart($("stables-chart"), { series: [{ name: "Supply", color: GREEN, points: st.series || [] }], x: "time", axes: true, area: true, endDot: true, yFmt: usd, tipX: dayLabel, label: "USD stablecoin supply, 90 days" });
    var top = st.top || [], other = Math.max(0, (st.total || 0) - top.slice(0, 3).reduce(function (a, t) { return a + (t.supply || 0); }, 0));
    var cls = ["s1", "s2", "s3"];
    $("stables-mix").innerHTML = '<div class="mono" style="margin-top:14px">Composition</div>' +
      stack(top.slice(0, 3).map(function (t, i) { return { v: t.supply, cls: cls[i], label: t.symbol + " " + fixed(t.share || 0, 0) + "%", tip: t.symbol + "<br><b>" + usd(t.supply) + "</b> · 7d " + signed(t.chg7d, 2, "%") }; })
        .concat([{ v: other, cls: "s4", label: "Other", tip: "Others<br><b>" + usd(other) + "</b>" }])) +
      '<div class="lg">' + top.slice(0, 3).map(function (t, i) { return '<span><i style="background:' + [GREEN, STEEL, STEEL5][i] + '"></i>' + esc(t.symbol) + " " + chg(t.chg7d) + "</span>"; }).join("") + '<span><i style="background:#3b3e42"></i>Other</span></div>';
    $("tvl-head").innerHTML = '<div class="hero">' + usd(tv.total) + '</div><div class="chips"><span>7d ' + chg(tv.chg7d) + "</span><span>30d " + chg(tv.chg30d) + "</span></div>";
    chart($("tvl-chart"), { series: [{ name: "TVL", color: STEEL, points: tv.series || [] }], x: "time", axes: true, area: true, endDot: true, yFmt: usd, tipX: dayLabel, label: "DeFi TVL, 90 days" });
  }

  // ───────────────────────── macro ─────────────────────────
  var MACRO = [["SPX", "S&P 500"], ["NDX", "Nasdaq 100"], ["DXY", "Dollar index"], ["US10Y", "US 10Y"], ["GOLD", "Gold"], ["VIX", "VIX"]];
  function mfmt(k, v) {
    if (!isNum(v)) return NA;
    if (k === "US10Y") return fixed(v, 2) + "%";
    if (k === "GOLD") return "$" + fixed(v, 0);
    if (k === "DXY" || k === "VIX") return fixed(v, 2);
    return fixed(v, 0);
  }
  function renderMacro() {
    var m = B("macro"), a = m.assets || {};
    $("macro").innerHTML = MACRO.map(function (k) {
      var x = a[k[0]] || {};
      var c1 = k[0] === "US10Y" ? chg(isNum(x.abs1d) ? x.abs1d * 100 : null, 0, " bp") : chg(x.chg1d);
      return '<div class="mt"><div class="top-l"><span>' + k[1] + "</span><span>" + c1 + '</span></div><div class="v">' + mfmt(k[0], x.price) +
        '</div><div class="chips"><span>1m ' + chg(x.chg1m) + '</span></div><div class="chart" id="m-' + k[0] + '"></div></div>';
    }).join("");
    MACRO.forEach(function (k) {
      var x = a[k[0]] || {}, s = x.spark || [], up = s.length > 1 && s[s.length - 1][1] >= s[0][1];
      chart($("m-" + k[0]), { series: [{ name: k[0], color: up ? GREEN : STEEL, points: s }], x: "time", yFmt: function (v) { return mfmt(k[0], v); }, tipX: dayLabel, label: k[1] + ", 3 months" });
    });
    var c = m.corr || {}, names = { SPX: "S&P 500", NDX: "Nasdaq", GOLD: "Gold", DXY: "Dollar" };
    function bar(v, lbl, cls) {
      var w = isNum(v) ? Math.min(50, Math.abs(v) * 50) : 0;
      return '<div class="dbar ' + cls + '"><span>' + lbl + '</span><span class="t">' + (isNum(v) ? '<i class="' + (v >= 0 ? "pos" : "neg") + '" style="width:' + w + '%"></i>' : "") + '</span><span class="n">' + (isNum(v) ? signed(v, 2) : "—") + "</span></div>";
    }
    $("corr").innerHTML = ["NDX", "SPX", "GOLD", "DXY"].map(function (k) {
      var r = c[k] || {};
      return '<div class="corr-row"><span class="k">' + names[k] + "</span><div>" + bar(r["30d"], "30d", "d30") + bar(r["90d"], "90d", "d90") + "</div></div>";
    }).join("") + '<div class="pctlbl" style="margin-top:8px;padding-left:94px"><span>−1 inverse</span><span>0</span><span>+1 together</span></div>';
  }

  // ───────────────────────── network & sentiment ─────────────────────────
  function fngGauge(v, label) {
    var cx = 120, cy = 112, r = 92, segs = [[0, 25], [25, 45], [45, 55], [55, 75], [75, 100]];
    function pt(x, rr) { var a = Math.PI * (1 - x / 100); return [cx + (rr || r) * Math.cos(a), cy - (rr || r) * Math.sin(a)]; }
    var s = '<svg class="fng-svg" viewBox="0 0 240 132" width="100%" style="max-width:300px;display:block;margin:0 auto" role="img" aria-label="Fear and Greed ' + v + '">';
    segs.forEach(function (g) {
      var a = pt(g[0] + 0.8), b = pt(g[1] - 0.8), on = isNum(v) && v >= g[0] && (v < g[1] || g[1] === 100);
      s += '<path d="M' + a[0].toFixed(1) + " " + a[1].toFixed(1) + " A" + r + " " + r + " 0 0 1 " + b[0].toFixed(1) + " " + b[1].toFixed(1) + '" fill="none" stroke="' + (on ? STEEL5 : "#222427") + '" stroke-width="12"/>';
    });
    if (isNum(v)) {
      var i = pt(v, r - 22), o = pt(v, r + 10);
      s += '<line x1="' + i[0].toFixed(1) + '" y1="' + i[1].toFixed(1) + '" x2="' + o[0].toFixed(1) + '" y2="' + o[1].toFixed(1) + '" stroke="' + GREEN + '" stroke-width="3"/>';
    }
    s += '<text x="' + cx + '" y="' + (cy - 14) + '" text-anchor="middle" fill="#dfe2e5" font-size="34" font-weight="500">' + (isNum(v) ? v : "—") + "</text>";
    s += '<text x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle" fill="#80858b" font-size="10" letter-spacing="1.5">' + esc((label || "").toUpperCase()) + "</text>";
    s += '<text x="18" y="128" fill="#3b3e42" font-size="9">0 FEAR</text><text x="222" y="128" text-anchor="end" fill="#3b3e42" font-size="9">GREED 100</text></svg>';
    return s;
  }
  function renderNetwork() {
    var fg = B("feargreed"), mp = B("mempool"), f = mp.fees || {};
    $("fng").innerHTML = '<div class="fng-wrap">' + fngGauge(fg.value, fg.label) + '<div class="chart short" id="fng-chart"></div></div>';
    chart($("fng-chart"), { series: [{ name: "F&G", color: GREEN, points: fg.series || [] }], x: "time", endDot: true, yFmt: function (v) { return fixed(v, 0); }, tipX: dayLabel, label: "Fear and Greed, 30 days" });
    var hs = mp.hash_series || [], first = hs.length ? hs[0][1] : null;
    $("hash-head").innerHTML = '<div class="hero">' + (isNum(mp.hashrate_eh) ? fixed(mp.hashrate_eh, 0) + ' <span class="mono">EH/s</span>' : NA) + '</div><div class="chips"><span>1m ' + chg(isNum(first) && isNum(mp.hashrate_eh) ? (mp.hashrate_eh / first - 1) * 100 : null) + "</span></div>";
    chart($("hash-chart"), { series: [{ name: "Hashrate", color: GREEN, points: hs }], x: "time", axes: true, area: true, endDot: true, yFmt: function (v) { return fixed(v, 0); }, tipY: function (v) { return fixed(v, 0) + " EH/s"; }, tipX: dayLabel, label: "Bitcoin hashrate" });
    var prog = isNum(mp.retarget_progress) ? mp.retarget_progress : 0;
    $("blockspace").innerHTML = '<div class="hero">' + (isNum(f.halfHourFee) ? f.halfHourFee + ' <span class="mono">sat/vB · 30 min</span>' : NA) + '</div>' +
      '<div class="ladder" style="margin-top:8px">' + [["Next block", f.fastestFee], ["1 hour", f.hourFee], ["Economy", f.economyFee]].map(function (r) {
        return '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + (isNum(r[1]) ? r[1] + " sat/vB" : NA) + "</span></div>";
      }).join("") + "</div>" +
      '<div class="mono" style="margin-top:14px">Difficulty retarget · block ' + (mp.height ? fixed(mp.height, 0) : "—") + "</div>" +
      '<div class="prog" data-tip="' + fixed(prog, 1) + '% of the 2,016-block epoch"><i style="width:' + prog + '%"></i></div>' +
      '<div class="chips"><span>' + fixed(prog, 1) + "% done</span><span>est. " + chg(mp.retarget_change) + "</span><span>" + (mp.retarget_blocks != null ? fixed(mp.retarget_blocks, 0) : "—") + " blocks left</span></div>";
  }

  // ───────────────────────── sources (guide) ─────────────────────────
  function renderSources() {
    var s = (state.latest || {}).sources || {}, keys = Object.keys(s), ok = keys.filter(function (k) { return s[k].ok; }).length;
    $("st-src").innerHTML = '<i class="dot ' + (ok === keys.length ? "on" : "warn") + '"></i>' + ok + "/" + keys.length + " sources";
    $("src-table").innerHTML = "<thead><tr><th>Source</th><th>Status</th><th>Last ok</th></tr></thead><tbody>" + keys.map(function (k) {
      var x = s[k];
      return "<tr><td>" + esc(x.label || k) + (x.error ? '<br><span class="mono dim">' + esc(x.error) + "</span>" : "") + "</td><td>" + (x.ok ? '<span class="up">● OK</span>' : '<span class="down">○ Stale</span>') + "</td><td>" + ago(x.at) + "</td></tr>";
    }).join("") + "</tbody>";
    var n = (state.news || {}).feeds || {};
    $("news-src-table").innerHTML = "<thead><tr><th>Feed</th><th>Status</th><th>Items</th></tr></thead><tbody>" + Object.keys(n).map(function (k) {
      var x = n[k], note = x.error || x.warning || (x.discovered ? "Moved, now " + x.discovered : "") || x.note || "";
      return "<tr><td>" + esc(x.name || k) + (note ? '<br><span class="mono dim">' + esc(note) + "</span>" : "") + "</td><td>" + (x.ok ? '<span class="up">● OK</span>' : '<span class="down">○ Stale</span>') + "</td><td>" + (isNum(x.kept) ? x.kept : "—") + "</td></tr>";
    }).join("") + "</tbody>";
  }
  function renderStatus() {
    var L = state.latest;
    $("st-snap").textContent = L ? "Snapshot " + ago(L.updated) : "Awaiting data";
  }

  // ───────────────────────── wire ─────────────────────────
  var CAT = { tokstable: "Tokenisation", markets: "Markets", regulation: "Regulation", other: "General" };
  var wire = { cat: "all", inst: true, q: "", shown: 30 };
  function seenTs() { return +(store.get("wire.seen") || 0); }
  function markSeen() {
    var n = state.news; if (!n || !n.items || !n.items.length) return;
    store.set("wire.seen", String(n.items[0].ts)); $("wire-badge").hidden = true;
  }
  function when(ts) {
    var s = Date.now() / 1000 - ts, d = new Date(ts * 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h · " + hhmm(d);
    if (s < 172800) return "Yday " + hhmm(d);
    return d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function srcLine(it) { return esc(it.lead) + (it.sources.length > 1 ? " +" + (it.sources.length - 1) : ""); }
  function match(it) {
    if (wire.inst && !it.inst) return false;
    if (wire.cat === "security") { if (it.tags.indexOf("Security & risk") < 0) return false; }
    else if (wire.cat === "primary") { if (!it.primary) return false; }
    else if (wire.cat !== "all" && it.cat !== wire.cat) return false;
    if (wire.q && (it.title + " " + it.sources.join(" ") + " " + (it.entities || []).join(" ")).toLowerCase().indexOf(wire.q) < 0) return false;
    return true;
  }
  function renderWire() {
    var n = state.news;
    if (!n) { $("wire-list").innerHTML = '<li><span class="empty">No news yet</span></li>'; return; }
    var items = n.items || [], seen = seenTs();
    var fresh = seen ? items.filter(function (i) { return i.ts > seen && i.inst; }).length : 0;
    $("wire-badge").hidden = !fresh || drawers.wire.classList.contains("open"); $("wire-badge").textContent = fresh > 99 ? "99+" : fresh;
    $("wire-featured").innerHTML = items.filter(function (i) { return i.featured; }).map(function (it) {
      return '<div class="feat"><div class="m"><span>' + srcLine(it) + "</span><span>" + when(it.ts) + '</span></div><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + "</a></div>";
    }).join("");
    var list = items.filter(function (it) { return match(it) && !(it.featured && wire.cat === "all" && !wire.q); });
    $("wire-list").innerHTML = list.slice(0, wire.shown).map(function (it) {
      var tags = ["<span>" + esc(CAT[it.cat] || it.cat) + "</span>"].concat(it.tags.slice(0, 2).map(function (t) { return "<span>" + esc(t) + "</span>"; }));
      if (it.primary) tags.unshift('<span class="reg">Regulator</span>');
      if (it.inst && it.why && it.why.length) tags.push('<span class="inst">' + esc(it.why.slice(0, 3).join(" · ")) + "</span>");
      return '<li><div class="w1"><span>' + when(it.ts) + '</span><span class="src" title="' + esc(it.sources.join(", ")) + '">' + srcLine(it) + "</span>" + (seen && it.ts > seen ? '<span class="new">New</span>' : "") +
        '</div><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a><div class="w2">' + tags.join("") + "</div></li>";
    }).join("") || '<li><span class="empty">No stories match these filters</span></li>';
    $("wire-more").hidden = list.length <= wire.shown;
    $("wire-count").textContent = "· " + list.length;
    var f = n.feeds || {}, k = Object.keys(f);
    $("wire-meta").textContent = items.length + " stories · 7 days · updated " + ago(n.updated) + " · " + k.filter(function (x) { return f[x].ok; }).length + "/" + k.length + " feeds";
    if (!seen && items.length) store.set("wire.seen", String(items[0].ts));
  }
  document.querySelectorAll("#wire-cats button").forEach(function (b) {
    b.addEventListener("click", function () {
      wire.cat = b.getAttribute("data-cat"); wire.shown = 30;
      document.querySelectorAll("#wire-cats button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      renderWire();
    });
  });
  $("wire-inst").addEventListener("change", function (e) { wire.inst = e.target.checked; wire.shown = 30; renderWire(); });
  var qT; $("wire-q").addEventListener("input", function (e) { clearTimeout(qT); qT = setTimeout(function () { wire.q = e.target.value.trim().toLowerCase(); wire.shown = 30; renderWire(); }, 150); });
  $("wire-more").addEventListener("click", function () { wire.shown += 30; renderWire(); });

  // ───────────────────────── loading ─────────────────────────
  function renderAll() {
    [renderTape, renderSignals, renderSpot, renderDerivs, renderLiquidity, renderMacro, renderNetwork, renderSources, renderStatus].forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
  }
  function getJSON(p) { return fetch(p + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }); }
  function load() {
    getJSON("data/news.json").then(function (n) { state.news = n; renderWire(); renderSources(); }).catch(function () { renderWire(); });
    Promise.all([getJSON("data/latest.json"), getJSON("data/history.json").catch(function () { return null; })])
      .then(function (r) { state.latest = r[0]; state.history = r[1]; renderAll(); })
      .catch(function () { $("st-snap").textContent = state.latest ? "Refresh failed" : "No data yet"; });
  }

  // ───────────────────────── live (Coinbase) ─────────────────────────
  var PRODUCTS = { "BTC-USD": "BTC", "ETH-USD": "ETH", "SOL-USD": "SOL", "XRP-USD": "XRP" };
  var pending = {}, raf = 0, retry = 1000, lastPx = {};
  function setLive(on, text) { $("st-live").innerHTML = '<i class="dot ' + (on ? "on" : "") + '"></i><span>' + text + "</span>"; }
  function flush() {
    raf = 0;
    Object.keys(pending).forEach(function (sym) {
      var a = asset(sym), pe = $("px-" + sym), prev = lastPx[sym];
      if (pe) {
        pe.innerHTML = price(a.price);
        if (isNum(prev) && a.price !== prev) {
          pe.classList.remove("t-up", "t-down"); void pe.offsetWidth;
          pe.classList.add(a.price > prev ? "t-up" : "t-down");
          clearTimeout(pe._t); pe._t = setTimeout(function () { pe.classList.remove("t-up", "t-down"); }, 120);
        }
      }
      lastPx[sym] = a.price;
      var c = $("c24-" + sym); if (c) c.innerHTML = chg(a.chg24);
      var rg = $("rng-" + sym); if (rg) rg.innerHTML = rangeCell(a);
      document.querySelectorAll('.tk[data-sym="' + sym + '"]').forEach(function (t) {
        t.querySelector(".v").innerHTML = price(a.price); t.querySelector(".c").innerHTML = chg(a.chg24);
      });
    });
    pending = {};
  }
  function connect() {
    if (!("WebSocket" in window)) return setLive(false, "Snapshot only");
    var ws; try { ws = new WebSocket("wss://ws-feed.exchange.coinbase.com"); } catch (e) { return setLive(false, "Snapshot only"); }
    ws.onopen = function () { retry = 1000; ws.send(JSON.stringify({ type: "subscribe", product_ids: Object.keys(PRODUCTS), channels: ["ticker"] })); setLive(true, "Live"); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== "ticker" || !PRODUCTS[m.product_id]) return;
      var sym = PRODUCTS[m.product_id], p = parseFloat(m.price), o = parseFloat(m.open_24h);
      state.live[sym] = { price: p, chg24: o ? (p / o - 1) * 100 : null, hi: parseFloat(m.high_24h), lo: parseFloat(m.low_24h) };
      pending[sym] = 1; if (!raf) raf = requestAnimationFrame(flush);
    };
    ws.onclose = function () { setLive(false, "Reconnecting"); setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // section highlight in the top bar
  if ("IntersectionObserver" in window) {
    var links = {}; document.querySelectorAll(".jump a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (es) { es.forEach(function (en) { var a = links[en.target.id]; if (a) a.setAttribute("aria-current", en.isIntersecting ? "true" : "false"); }); }, { rootMargin: "-35% 0px -60% 0px" });
    Object.keys(links).forEach(function (id) { var s = $(id); if (s) io.observe(s); });
  }
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("sig")) { e.preventDefault(); openGuide(e.target.getAttribute("data-guide")); }
  });

  load(); connect();
  setInterval(load, REFRESH_MS);
  setInterval(function () { renderStatus(); }, 30000);
  window.addEventListener("scroll", hideTip, { passive: true });
})();
