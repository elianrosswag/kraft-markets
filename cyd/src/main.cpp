/*
 * KRAFT desk display: firmware for the ESP32 "Cheap Yellow Display" (2-USB / ST7789 version).
 *
 * What it does
 *   - Joins any Wi-Fi network it has been taught (home, work...), strongest first.
 *     New networks are added through a setup hotspot "KRAFT-CYD" with a QR code on screen.
 *     Work networks that need a username (WPA2-Enterprise / PEAP) are supported.
 *   - Every 5 min:  GET https://markets.elian.ink/data/cyd.json   (written by the collector)
 *   - Every 30 s:   GET Coinbase 24h stats for BTC / ETH / SOL     (live prices)
 *   - Draws four pages: Spot, State of the market, Wire, Macro. Tap to change page;
 *     pages also rotate on their own every 20 s.
 *
 * Flicker-free drawing: each frame is rendered into a 320x40 off-screen buffer, one horizontal
 * band at a time, and each finished band is pushed to the panel in one go. The screen never
 * shows a half-drawn frame.
 *
 * Controls
 *   Tap ............................ next page
 *   Hold 4 s ....................... open the setup hotspot (add / forget networks)
 *   Hold BOOT while powering on .... open the setup hotspot
 *
 * Updates: every 6 h (and at boot) it reads cyd/install/version.json from the site. If a newer
 * build exists it downloads firmware.bin and restarts into it. A failed download changes nothing.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <qrcode.h>
#include <esp_task_wdt.h>
#include <time.h>

// ───────────────────────── configuration ─────────────────────────
static const char* DATA_URLS[] = {
  "https://markets.elian.ink/data/cyd.json",
  "https://raw.githubusercontent.com/elianrosswag/kraft-markets/main/data/cyd.json",  // fallback
};
static const char* AP_NAME = "KRAFT-CYD";
static const char* TZ_LONDON = "GMT0BST,M3.5.0/1,M10.5.0";
static const uint32_t DATA_EVERY_MS = 5UL * 60 * 1000;
static const uint32_t LIVE_EVERY_MS = 30UL * 1000;
static const uint32_t PAGE_EVERY_MS = 20UL * 1000;
static const int MAX_NETS = 5;
static const int PAGES = 4;
static const char* VERSION_URL = "https://markets.elian.ink/cyd/install/version.json";
static const char* FIRMWARE_URL = "https://markets.elian.ink/cyd/install/firmware.bin";
static const uint32_t UPDATE_EVERY_MS = 6UL * 3600 * 1000;
#ifndef FW_BUILD
#define FW_BUILD 0      // set by the build workflow (UTC timestamp of the build)
#endif

// CYD pins (fixed by the board)
#define PIN_BOOT 0
#define LED_R 4
#define LED_G 16
#define LED_B 17
#define T_IRQ 36
#define T_MOSI 32
#define T_MISO 39
#define T_CLK 25
#define T_CS 33

// KRAFT palette
#define C_BG    TFT_BLACK
#define C_GREEN tft.color565(57, 255, 20)
#define C_S100  tft.color565(223, 226, 229)
#define C_S300  tft.color565(167, 172, 178)
#define C_S500  tft.color565(128, 133, 139)
#define C_S700  tft.color565(59, 62, 66)
#define C_S800  tft.color565(34, 36, 39)

// ───────────────────────── globals ─────────────────────────
TFT_eSPI tft;
TFT_eSprite spr(&tft);
SPIClass touchSpi(VSPI);
XPT2046_Touchscreen ts(T_CS, T_IRQ);
Preferences prefs;
WebServer server(80);
DNSServer dns;

static const int BAND_H = 40;   // 320x40x2 bytes = 25.6 KB off-screen buffer
static int bandY = 0;           // y offset of the band being drawn

struct Live { double last = NAN, open = NAN, hi = NAN, lo = NAN; uint32_t at = 0; };
Live live[3];                   // BTC, ETH, SOL
static const char* LIVE_SYM[3] = {"BTC-USD", "ETH-USD", "SOL-USD"};

JsonDocument snap;              // last cyd.json
bool haveSnap = false;
uint32_t snapFetchedAt = 0;
int page = 0;
bool portalMode = false;
bool invertColours = false;
uint32_t lastData = 0, lastLive = 0, lastPage = 0, lastDraw = 0, lastWifiTry = 0, lastUpdateCheck = 0;

// ───────────────────────── drawing helpers (band-aware) ─────────────────────────
// Every primitive takes screen coordinates; we shift by the current band's offset.
inline int Y(int y) { return y - bandY; }
inline bool inBand(int y0, int h) { return y0 + h >= bandY && y0 <= bandY + BAND_H; }

void text(const String& s, int x, int y, int font, uint16_t col, uint8_t datum = TL_DATUM) {
  if (!inBand(y - 50, 110)) return;
  spr.setTextDatum(datum);
  spr.setTextColor(col);
  spr.drawString(s, x, Y(y), font);
}
void hline(int x, int y, int w, uint16_t c) { if (inBand(y, 1)) spr.drawFastHLine(x, Y(y), w, c); }
void rect(int x, int y, int w, int h, uint16_t c) { if (inBand(y, h)) spr.fillRect(x, Y(y), w, h, c); }
void frame(int x, int y, int w, int h, uint16_t c) { if (inBand(y, h)) spr.drawRect(x, Y(y), w, h, c); }
void line(int x0, int y0, int x1, int y1, uint16_t c) { spr.drawLine(x0, Y(y0), x1, Y(y1), c); }
void tri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) { spr.fillTriangle(x0, Y(y0), x1, Y(y1), x2, Y(y2), c); }

String fmtNum(double v, int dp, bool commas = true) {
  if (isnan(v)) return "-";
  char buf[32];
  dtostrf(fabs(v), 0, dp, buf);
  String s(buf);
  if (commas) {
    int dot = s.indexOf('.');
    int end = dot < 0 ? s.length() : dot;
    for (int i = end - 3; i > 0; i -= 3) s = s.substring(0, i) + "," + s.substring(i);
  }
  return (v < 0 ? "-" : "") + s;
}
String fmtPrice(double v, bool commas = true) {
  if (isnan(v)) return "-";
  return fmtNum(v, v >= 1000 ? 0 : v >= 1 ? 2 : 4, commas);
}
String fmtPct(double v, int dp = 2) {
  if (isnan(v)) return "-";
  return String(v > 0 ? "+" : "") + fmtNum(v, dp, false) + "%";
}
String fmtBig(double v) {  // 2.54T / 294B
  if (isnan(v)) return "-";
  if (fabs(v) >= 1e12) return "$" + fmtNum(v / 1e12, 2, false) + "T";
  if (fabs(v) >= 1e9) return "$" + fmtNum(v / 1e9, 0, false) + "B";
  return "$" + fmtNum(v / 1e6, 0, false) + "M";
}

// Arrow + coloured change: green ▲ up, light grey ▼ down (shape carries meaning, not just colour)
int change(double v, int x, int y, int font, int dp = 2, const char* unit = "%") {
  if (isnan(v)) { text("-", x, y, font, C_S500); return x + 8; }
  bool up = v >= 0;
  uint16_t c = up ? C_GREEN : C_S100;
  int h = font == 4 ? 9 : 6, w = font == 4 ? 10 : 7, cy = y + (font == 4 ? 12 : 8);
  if (inBand(y, 26)) {
    if (up) tri(x, cy + h / 2, x + w, cy + h / 2, x + w / 2, cy - h / 2, c);
    else    tri(x, cy - h / 2, x + w, cy - h / 2, x + w / 2, cy + h / 2, c);
  }
  String s = String(up ? "+" : "-") + fmtNum(fabs(v), dp, false) + unit;
  text(s, x + w + 4, y, font, c);
  spr.setTextFont(font);
  return x + w + 4 + spr.textWidth(s);
}

double num(JsonVariantConst v) { return v.is<double>() || v.is<long>() ? v.as<double>() : NAN; }
double S(const char* k) { return haveSnap ? num(snap[k]) : NAN; }

// ───────────────────────── page chrome ─────────────────────────
void drawHeader() {
  text("KRAFT", 10, 6, 2, C_S100);
  spr.setTextFont(2);
  int w = spr.textWidth("KRAFT");
  rect(10 + w + 2, 17, 3, 3, C_GREEN);
  text("MARKETS", 10 + w + 12, 6, 2, C_S500);

  struct tm t;
  if (getLocalTime(&t, 0)) {
    char b[8]; strftime(b, sizeof b, "%H:%M", &t);
    text(b, 296, 6, 2, C_S100, TR_DATUM);
  }
  // Wi-Fi status square: solid green = online, outline = offline
  if (WiFi.status() == WL_CONNECTED) rect(304, 11, 6, 6, C_GREEN);
  else frame(304, 11, 6, 6, C_S300);
  hline(0, 26, 320, C_S800);
}

void drawFooter(const char* title) {
  hline(0, 222, 320, C_S800);
  text(title, 10, 225, 2, C_S500);
  for (int i = 0; i < PAGES; i++) rect(160 - PAGES * 6 + i * 12, 231, 6, 3, i == page ? C_GREEN : C_S700);
  String age = "no data";
  if (haveSnap) {
    time_t now; time(&now);
    long a = (long)(now - (long)num(snap["t"]));
    age = now > 1700000000 && a >= 0 ? (a < 3600 ? String(a / 60) + "m ago" : String(a / 3600) + "h ago") : "synced";
  }
  text(age, 310, 225, 2, C_S500, TR_DATUM);
}

// Coinbase live if fresh (<2 min), otherwise the snapshot
double livePrice(int i, const char* snapKey) {
  if (!isnan(live[i].last) && millis() - live[i].at < 120000) return live[i].last;
  return S(snapKey);
}
double liveChg(int i, const char* snapKey) {
  if (!isnan(live[i].last) && !isnan(live[i].open) && live[i].open > 0 && millis() - live[i].at < 120000)
    return (live[i].last / live[i].open - 1) * 100;
  return S(snapKey);
}

// ───────────────────────── pages ─────────────────────────
void pageSpot() {
  double btc = livePrice(0, "btc");
  text("BTC / USD", 10, 34, 2, C_S500);
  text(live[0].at && millis() - live[0].at < 120000 ? "LIVE" : "SNAPSHOT", 310, 34, 2, live[0].at ? C_GREEN : C_S500, TR_DATUM);
  text(fmtPrice(btc, false), 8, 54, 7, C_S100);   // 7-segment font, digits only
  change(liveChg(0, "btc24"), 214, 70, 4);

  // 24h range bar (live low/high)
  if (!isnan(live[0].lo) && !isnan(live[0].hi) && live[0].hi > live[0].lo) {
    int x0 = 10, w = 300, y = 112;
    rect(x0, y, w, 2, C_S800);
    int mx = x0 + (int)((btc - live[0].lo) / (live[0].hi - live[0].lo) * w);
    rect(constrain(mx, x0, x0 + w) - 1, y - 4, 3, 10, C_GREEN);
    text("24h " + fmtPrice(live[0].lo), x0, y + 7, 2, C_S500);
    text(fmtPrice(live[0].hi), x0 + w, y + 7, 2, C_S500, TR_DATUM);
  }

  // 7-day sparkline from the snapshot
  JsonArrayConst sp = snap["spark"].as<JsonArrayConst>();
  if (haveSnap && sp.size() > 2) {
    double mn = 1e18, mx = -1e18;
    for (JsonVariantConst v : sp) { double d = v.as<double>(); mn = min(mn, d); mx = max(mx, d); }
    int x0 = 10, y0 = 138, w = 300, h = 40, n = sp.size();
    double r = mx - mn > 0 ? mx - mn : 1;
    if (inBand(y0 - 2, h + 4)) {
      int px = -1, py = -1;
      for (int i = 0; i < n; i++) {
        int x = x0 + i * w / (n - 1), y = y0 + h - (int)((sp[i].as<double>() - mn) / r * h);
        if (px >= 0) { line(px, py, x, y, C_GREEN); line(px, py + 1, x, y + 1, C_GREEN); }
        px = x; py = y;
      }
    }
    text("7D", 310, 136, 2, C_S700, TR_DATUM);
  }

  // ETH and SOL
  const char* sy[2] = {"ETH", "SOL"};
  const char* pk[2] = {"eth", "sol"};
  const char* ck[2] = {"eth24", "sol24"};
  for (int i = 0; i < 2; i++) {
    int x = 10 + i * 160;
    text(sy[i], x, 186, 2, C_S500);
    text(fmtPrice(livePrice(i + 1, pk[i])), x + 34, 182, 4, C_S100);
    change(liveChg(i + 1, ck[i]), x + 34, 204, 2);
  }
  drawFooter("SPOT");
}

struct Sig { const char* label; double v; double mn, mx; String state; bool hot; String detail; };

String zone(double v, const double* cuts, const char* const* names, int n) {
  for (int i = 0; i < n - 1; i++) if (v < cuts[i]) return names[i];
  return names[n - 1];
}

void pageState() {
  text("STATE OF THE MARKET", 10, 32, 2, C_S500);
  Sig sigs[6];
  {
    double v = S("fund"); static const double c[] = {0, 8, 20}; static const char* const n[] = {"SHORTS PAY", "NEUTRAL", "ELEVATED", "OVERHEATED"};
    String st = isnan(v) ? "-" : zone(v, c, n, 4);
    sigs[0] = {"LEVERAGE", v, -10, 30, st, st != "NEUTRAL", fmtPct(v, 1)};
  }
  {
    double v = S("dvol"); static const double c[] = {35, 55, 75}; static const char* const n[] = {"COMPRESSED", "NORMAL", "ELEVATED", "STRESSED"};
    String st = isnan(v) ? "-" : zone(v, c, n, 4);
    sigs[1] = {"VOLATILITY", v, 20, 100, st, st != "NORMAL", fmtNum(v, 1)};
  }
  {
    double v = S("basis"); static const double c[] = {0, 5, 12}; static const char* const n[] = {"BACKWARDATION", "THIN", "NORMAL", "RICH"};
    String st = isnan(v) ? "-" : zone(v, c, n, 4);
    sigs[2] = {"CARRY", v, -5, 20, st, st != "NORMAL", fmtPct(v, 1)};
  }
  {
    double v = S("stbl30"); static const double c[] = {-2, 2}; static const char* const n[] = {"CONTRACTING", "FLAT", "EXPANDING"};
    String st = isnan(v) ? "-" : zone(v, c, n, 3);
    sigs[3] = {"LIQUIDITY", v, -8, 8, st, st != "FLAT", fmtPct(v, 1)};
  }
  {
    double v = S("fng"); static const double c[] = {25, 45, 55, 75}; static const char* const n[] = {"EXTREME FEAR", "FEAR", "NEUTRAL", "GREED", "EXTREME GREED"};
    String st = isnan(v) ? "-" : zone(v, c, n, 5);
    sigs[4] = {"SENTIMENT", v, 0, 100, st, st != "NEUTRAL", fmtNum(v, 0)};
  }
  {
    double v = S("corr"); static const double c[] = {-0.2, 0.2, 0.5}; static const char* const n[] = {"INVERSE", "DECOUPLED", "LOOSE", "RISK ASSET"};
    String st = isnan(v) ? "-" : zone(v, c, n, 4);
    sigs[5] = {"MACRO LINK", v, -1, 1, st, st == "RISK ASSET" || st == "INVERSE", fmtNum(v, 2)};
  }
  for (int i = 0; i < 6; i++) {
    int y = 52 + i * 28;
    text(sigs[i].label, 10, y, 2, C_S500);
    text(sigs[i].state, 104, y, 2, sigs[i].hot ? C_GREEN : C_S100);
    text(sigs[i].detail, 310, y, 2, C_S300, TR_DATUM);
    int bx = 104, bw = 206, by = y + 19;
    rect(bx, by, bw, 2, C_S800);
    if (!isnan(sigs[i].v)) {
      double p = constrain((sigs[i].v - sigs[i].mn) / (sigs[i].mx - sigs[i].mn), 0.0, 1.0);
      rect(bx + (int)(p * bw) - 1, by - 3, 3, 8, C_GREEN);
    }
  }
  drawFooter("STATE");
}

// Word-wrap into at most maxLines lines of width w (font 2)
int wrap(const String& s, int x, int y, int w, int maxLines, uint16_t col) {
  spr.setTextFont(2);
  String lineBuf, word;
  int lines = 0;
  for (unsigned i = 0; i <= s.length() && lines < maxLines; i++) {
    char ch = i < s.length() ? s[i] : ' ';
    if (ch == ' ') {
      String trial = lineBuf.length() ? lineBuf + " " + word : word;
      if (spr.textWidth(trial) > w && lineBuf.length()) {
        if (lines == maxLines - 1) { text(lineBuf + "...", x, y + lines * 16, 2, col); return lines + 1; }
        text(lineBuf, x, y + lines * 16, 2, col); lines++; lineBuf = word;
      } else lineBuf = trial;
      word = "";
    } else word += ch;
  }
  if (lines < maxLines && lineBuf.length()) { text(lineBuf, x, y + lines * 16, 2, col); lines++; }
  return lines;
}

void pageWire() {
  text("WIRE / INSTITUTIONAL", 10, 32, 2, C_S500);
  JsonArrayConst news = snap["news"].as<JsonArrayConst>();
  if (!haveSnap || news.size() == 0) { text("No headlines yet", 10, 60, 2, C_S500); drawFooter("WIRE"); return; }
  time_t now; time(&now);
  int y = 54;
  for (JsonVariantConst n : news) {
    if (y > 196) break;
    long ago = now > 1700000000 && n["ts"].is<long>() ? (long)(now - n["ts"].as<long>()) : -1;
    String meta = String((const char*)(n["s"] | "")) ;
    meta.toUpperCase();
    if (ago >= 0) meta += ago < 3600 ? "  " + String(ago / 60) + "m" : "  " + String(ago / 3600) + "h";
    rect(10, y + 3, 2, 10, C_GREEN);
    text(meta, 18, y, 2, C_S500);
    int l = wrap(String((const char*)(n["t"] | "")), 18, y + 17, 292, 3, C_S100);
    y += 17 + l * 16 + 8;
  }
  drawFooter("WIRE");
}

void tile(int x, int y, const char* label, const String& value, double chg, int dp = 2, const char* unit = "%") {
  text(label, x, y, 2, C_S500);
  text(value, x, y + 16, 4, C_S100);
  change(chg, x, y + 42, 2, dp, unit);
}

void pageMacro() {
  text("CROSS-ASSET", 10, 32, 2, C_S500);
  tile(10, 52, "S&P 500", fmtNum(S("spx"), 0), S("spx1d"));
  tile(115, 52, "NASDAQ 100", fmtNum(S("ndx"), 0), S("ndx1d"));
  tile(220, 52, "DOLLAR", fmtNum(S("dxy"), 2), S("dxy1d"));
  tile(10, 134, "US 10Y", fmtNum(S("us10y"), 2) + "%", S("us10ybp"), 0, "bp");
  tile(115, 134, "GOLD", fmtNum(S("gold"), 0), S("gold1d"));
  tile(220, 134, "CRYPTO MCAP", "$" + fmtNum(S("mcap"), 2, false) + "T", S("mcap24"));
  for (int i = 1; i < 3; i++) rect(i * 105 + 2, 52, 1, 158, C_S800);
  hline(10, 126, 300, C_S800);
  drawFooter("MACRO");
}

void render() {
  for (bandY = 0; bandY < 240; bandY += BAND_H) {
    spr.fillSprite(C_BG);
    drawHeader();
    switch (page) {
      case 0: pageSpot(); break;
      case 1: pageState(); break;
      case 2: pageWire(); break;
      default: pageMacro(); break;
    }
    spr.pushSprite(0, bandY);
  }
}

// Simple full-screen message (boot, connecting, errors)
void message(const String& a, const String& b = "", const String& c = "") {
  for (bandY = 0; bandY < 240; bandY += BAND_H) {
    spr.fillSprite(C_BG);
    text("KRAFT", 10, 6, 2, C_S100);
    rect(10 + 44, 17, 3, 3, C_GREEN);
    hline(0, 26, 320, C_S800);
    text(a, 10, 90, 4, C_S100);
    text(b, 10, 124, 2, C_S300);
    text(c, 10, 144, 2, C_S500);
    spr.pushSprite(0, bandY);
  }
}

// ───────────────────────── Wi-Fi: saved networks ─────────────────────────
struct Net { String ssid, pass, user; };

int loadNets(Net* out) {
  prefs.begin("kraft", true);
  int n = prefs.getInt("n", 0);
  for (int i = 0; i < n && i < MAX_NETS; i++) {
    out[i].ssid = prefs.getString(("s" + String(i)).c_str(), "");
    out[i].pass = prefs.getString(("p" + String(i)).c_str(), "");
    out[i].user = prefs.getString(("u" + String(i)).c_str(), "");
  }
  prefs.end();
  return min(n, MAX_NETS);
}
void saveNets(Net* nets, int n) {
  prefs.begin("kraft", false);
  prefs.putInt("n", n);
  for (int i = 0; i < n; i++) {
    prefs.putString(("s" + String(i)).c_str(), nets[i].ssid);
    prefs.putString(("p" + String(i)).c_str(), nets[i].pass);
    prefs.putString(("u" + String(i)).c_str(), nets[i].user);
  }
  prefs.end();
}

bool connectKnown() {
  Net nets[MAX_NETS];
  int n = loadNets(nets);
  if (!n) return false;
  WiFi.mode(WIFI_STA);
  int found = WiFi.scanNetworks();
  // Try saved networks that are in range, strongest signal first (scan results are sorted by RSSI)
  for (int f = 0; f < found; f++) {
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(f) != nets[i].ssid) continue;
      message("Connecting", nets[i].ssid, nets[i].user.length() ? "Work network (username login)" : "");
      if (nets[i].user.length())
        WiFi.begin(nets[i].ssid.c_str(), WPA2_AUTH_PEAP, nets[i].user.c_str(), nets[i].user.c_str(), nets[i].pass.c_str());
      else
        WiFi.begin(nets[i].ssid.c_str(), nets[i].pass.c_str());
      uint32_t t0 = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(250); esp_task_wdt_reset(); }
      if (WiFi.status() == WL_CONNECTED) { WiFi.scanDelete(); return true; }
      WiFi.disconnect(true);
      delay(200);
    }
  }
  WiFi.scanDelete();
  return false;
}

// ───────────────────────── setup hotspot (captive portal) ─────────────────────────
String esc(const String& s) {
  String o; for (char c : s) { if (c == '<') o += "&lt;"; else if (c == '&') o += "&amp;"; else if (c == '"') o += "&quot;"; else o += c; } return o;
}
String portalPage(const String& note = "") {
  Net nets[MAX_NETS]; int n = loadNets(nets);
  int found = WiFi.scanComplete();
  String opts;
  for (int i = 0; i < max(found, 0); i++) opts += "<option value=\"" + esc(WiFi.SSID(i)) + "\">" + esc(WiFi.SSID(i)) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  String h = F("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>KRAFT desk display</title>"
    "<style>body{background:#000;color:#a7acb2;font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;max-width:520px}"
    "h1{font:600 15px monospace;letter-spacing:.3em;color:#dfe2e5}h1 b{color:#39FF14}h2{font:12px monospace;text-transform:uppercase;letter-spacing:.1em;color:#80858b;margin-top:28px}"
    "label{display:block;margin:12px 0 4px;font:12px monospace;text-transform:uppercase;letter-spacing:.06em}"
    "input,select{width:100%;box-sizing:border-box;background:#000;color:#dfe2e5;border:1px solid #3b3e42;padding:10px;font-size:16px}"
    "button,.b{background:none;border:1px solid #39FF14;color:#39FF14;padding:10px 16px;font:12px monospace;letter-spacing:.1em;text-transform:uppercase;margin-top:16px;cursor:pointer;text-decoration:none;display:inline-block}"
    "small{color:#80858b}li{margin:6px 0;color:#dfe2e5}li a{color:#80858b;margin-left:8px}.n{border:1px solid #3b3e42;padding:10px;color:#dfe2e5}</style>"
    "<h1>KRAFT<b>.</b> DESK DISPLAY</h1>");
  if (note.length()) h += "<p class=n>" + note + "</p>";
  h += F("<h2>Add a network</h2><form method=post action=/save><label>Network</label><select name=pick><option value=''>Choose...</option>");
  h += opts;
  h += F("</select><label>...or type its name</label><input name=ssid autocapitalize=none>"
         "<label>Password</label><input name=pass type=password>"
         "<label>Username <small>(only for work networks that ask for one)</small></label><input name=user autocapitalize=none autocomplete=off>"
         "<button>Save network</button></form><h2>Saved networks</h2><ul>");
  if (!n) h += F("<li><small>None yet</small></li>");
  for (int i = 0; i < n; i++) h += "<li>" + esc(nets[i].ssid) + (nets[i].user.length() ? " <small>(work login)</small>" : "") + "<a href='/forget?i=" + String(i) + "'>forget</a></li>";
  h += F("</ul><h2>Screen</h2><p><small>If the screen background looks white instead of black:</small></p><a class=b href=/invert>Flip screen colours</a>"
         "<h2>Finish</h2><a class=b href=/done>Done, restart display</a><p><small>Saved networks stay on the device. It joins whichever one is in range, so you only set each network up once.</small></p>");
  h += "<h2>Firmware</h2><p><small>Build " + String((long)FW_BUILD) + ". Updates install themselves over Wi-Fi.</small></p>";
  return h;
}

void drawQR(const char* payload, int x, int y, int scale) {
  QRCode qr; uint8_t buf[qrcode_getBufferSize(3)];
  qrcode_initText(&qr, buf, 3, ECC_LOW, payload);
  for (bandY = 0; bandY < 240; bandY += BAND_H) {
    spr.fillSprite(C_BG);
    text("KRAFT", 10, 6, 2, C_S100); rect(54, 17, 3, 3, C_GREEN);
    text("SETUP", 310, 6, 2, C_GREEN, TR_DATUM);
    hline(0, 26, 320, C_S800);
    rect(x - 6, y - 6, qr.size * scale + 12, qr.size * scale + 12, TFT_WHITE);
    for (int r = 0; r < qr.size; r++)
      for (int c = 0; c < qr.size; c++)
        if (qrcode_getModule(&qr, c, r)) rect(x + c * scale, y + r * scale, scale, scale, TFT_BLACK);
    int tx = x + qr.size * scale + 18;
    text("1. Scan, or join", tx, 44, 2, C_S300);
    text("Wi-Fi " + String(AP_NAME), tx, 62, 2, C_S100);
    text("2. A setup page", tx, 92, 2, C_S300);
    text("opens. If not, go to", tx, 110, 2, C_S300);
    text("192.168.4.1", tx, 128, 2, C_GREEN);
    text("3. Add your network", tx, 158, 2, C_S300);
    text("and tap Done", tx, 176, 2, C_S300);
    spr.pushSprite(0, bandY);
  }
}

void startPortal() {
  portalMode = true;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_NAME);
  WiFi.scanNetworks(true);  // async scan for the network list
  dns.start(53, "*", WiFi.softAPIP());
  server.on("/", HTTP_GET, [] { server.send(200, "text/html", portalPage()); });
  server.on("/save", HTTP_POST, [] {
    String ssid = server.arg("ssid").length() ? server.arg("ssid") : server.arg("pick");
    ssid.trim();
    if (!ssid.length()) { server.send(200, "text/html", portalPage("Pick or type a network name.")); return; }
    Net nets[MAX_NETS]; int n = loadNets(nets);
    int slot = -1;
    for (int i = 0; i < n; i++) if (nets[i].ssid == ssid) slot = i;
    if (slot < 0) { if (n == MAX_NETS) { for (int i = 1; i < n; i++) nets[i - 1] = nets[i]; n--; } slot = n++; }
    nets[slot] = {ssid, server.arg("pass"), server.arg("user")};
    saveNets(nets, n);
    server.send(200, "text/html", portalPage("Saved <b>" + esc(ssid) + "</b>. Add another, or tap Done."));
  });
  server.on("/forget", HTTP_GET, [] {
    Net nets[MAX_NETS]; int n = loadNets(nets); int i = server.arg("i").toInt();
    if (i >= 0 && i < n) { for (int k = i + 1; k < n; k++) nets[k - 1] = nets[k]; saveNets(nets, n - 1); }
    server.sendHeader("Location", "/"); server.send(302);
  });
  server.on("/invert", HTTP_GET, [] {
    invertColours = !invertColours; tft.invertDisplay(invertColours);
    prefs.begin("kraft", false); prefs.putBool("inv", invertColours); prefs.end();
    server.sendHeader("Location", "/"); server.send(302);
  });
  server.on("/done", HTTP_GET, [] {
    server.send(200, "text/html", "<body style='background:#000;color:#dfe2e5;font:16px system-ui;padding:20px'>Restarting the display...</body>");
    delay(800); ESP.restart();
  });
  server.onNotFound([] { server.sendHeader("Location", "http://192.168.4.1/"); server.send(302); });  // captive portal
  server.begin();
  drawQR("WIFI:T:nopass;S:KRAFT-CYD;;", 14, 44, 4);
}

// ───────────────────────── data ─────────────────────────
bool httpGet(const char* url, String& out) {
  WiFiClientSecure client;
  client.setInsecure();  // public, read-only data; skips certificate checks to save memory
  HTTPClient http;
  http.setTimeout(9000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (!http.begin(client, url)) return false;
  http.addHeader("User-Agent", "KRAFT-CYD/1.0");
  int code = http.GET();
  bool ok = code == 200;
  if (ok) out = http.getString();
  http.end();
  return ok;
}

void fetchSnapshot() {
  for (const char* url : DATA_URLS) {
    String body;
    esp_task_wdt_reset();
    if (!httpGet(url, body)) continue;
    JsonDocument doc;
    if (deserializeJson(doc, body)) continue;
    snap = doc; haveSnap = true; snapFetchedAt = millis();
    return;
  }
}

void fetchLive() {
  for (int i = 0; i < 3; i++) {
    String body;
    esp_task_wdt_reset();
    if (!httpGet((String("https://api.exchange.coinbase.com/products/") + LIVE_SYM[i] + "/stats").c_str(), body)) continue;
    JsonDocument doc;
    if (deserializeJson(doc, body)) continue;
    live[i].last = atof(doc["last"] | "nan");
    live[i].open = atof(doc["open"] | "nan");
    live[i].hi = atof(doc["high"] | "nan");
    live[i].lo = atof(doc["low"] | "nan");
    live[i].at = millis();
  }
}

// ───────────────────────── over-the-air updates ─────────────────────────
void checkForUpdate() {
  String body;
  if (!httpGet(VERSION_URL, body)) return;
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  long latest = doc["build"] | 0L;
  if (latest <= (long)FW_BUILD) return;
  message("Updating", "New firmware " + String((const char*)(doc["version"] | "")), "Don't unplug. Takes about a minute.");
  esp_task_wdt_delete(NULL);              // downloading can take longer than the watchdog allows
  WiFiClientSecure client;
  client.setInsecure();
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = httpUpdate.update(client, FIRMWARE_URL);
  esp_task_wdt_add(NULL);
  if (r != HTTP_UPDATE_OK) message("Update failed", "Keeping the current version", httpUpdate.getLastErrorString());
  delay(1500);
}

// ───────────────────────── backlight ─────────────────────────
void backlight(uint8_t level) { ledcWrite(0, level); }
void autoDim() {
  struct tm t;
  if (!getLocalTime(&t, 0)) return;
  backlight(t.tm_hour >= 22 || t.tm_hour < 7 ? 40 : 255);  // softer at night
}

// ───────────────────────── touch ─────────────────────────
uint32_t touchStart = 0;
bool touchHeld = false;
void handleTouch() {
  bool down = ts.tirqTouched() && ts.touched();
  if (down && !touchStart) touchStart = millis();
  if (down && touchStart && !touchHeld && millis() - touchStart > 4000) {  // long hold: setup hotspot
    touchHeld = true;
    startPortal();
    return;
  }
  if (!down && touchStart) {
    if (!touchHeld && millis() - touchStart > 40) { page = (page + 1) % PAGES; lastPage = millis(); render(); }
    touchStart = 0; touchHeld = false;
  }
}

// ───────────────────────── setup & loop ─────────────────────────
void setup() {
  Serial.begin(115200);
  // RGB LED is active-low: keep it off
  pinMode(LED_R, OUTPUT); pinMode(LED_G, OUTPUT); pinMode(LED_B, OUTPUT);
  digitalWrite(LED_R, HIGH); digitalWrite(LED_G, HIGH); digitalWrite(LED_B, HIGH);
  pinMode(PIN_BOOT, INPUT_PULLUP);

  esp_task_wdt_init(60, true);  // reboot if anything hangs for a minute
  esp_task_wdt_add(NULL);

  tft.init();
  tft.setRotation(1);           // landscape, USB on the left
  prefs.begin("kraft", true);
  invertColours = prefs.getBool("inv", false);
  bool firstBoot = !prefs.isKey("inv");
  prefs.end();
  tft.invertDisplay(invertColours);
  tft.fillScreen(TFT_BLACK);
  // Steady backlight: 5 kHz PWM is far above visible flicker
  ledcSetup(0, 5000, 8); ledcAttachPin(TFT_BL, 0); backlight(255);

  spr.setColorDepth(16);
  spr.createSprite(320, BAND_H);

  touchSpi.begin(T_CLK, T_MISO, T_MOSI, T_CS);
  ts.begin(touchSpi);
  ts.setRotation(1);

  if (firstBoot) {
    // One-time colour check: this screen should be black. If it shows white, the panel needs inverting.
    message("Is this screen black?", "If the background is WHITE, tap the screen now.", "Otherwise just wait a few seconds.");
    uint32_t t0 = millis(); bool tapped = false;
    while (millis() - t0 < 8000) { if (ts.tirqTouched() && ts.touched()) { tapped = true; break; } delay(20); }
    if (tapped) { invertColours = !invertColours; tft.invertDisplay(invertColours); }
    prefs.begin("kraft", false); prefs.putBool("inv", invertColours); prefs.end();
    delay(400);
  }

  message("KRAFT Markets", "Starting up");
  bool forcePortal = digitalRead(PIN_BOOT) == LOW;
  if (forcePortal || !connectKnown()) { startPortal(); return; }

  configTzTime(TZ_LONDON, "pool.ntp.org", "time.google.com");
  message("Online", WiFi.SSID(), "Fetching market data");
  checkForUpdate();
  fetchSnapshot();
  fetchLive();
  lastData = lastLive = lastPage = lastUpdateCheck = millis();
  render();
}

void loop() {
  esp_task_wdt_reset();

  if (portalMode) {
    dns.processNextRequest();
    server.handleClient();
    delay(5);
    return;
  }

  handleTouch();
  if (portalMode) return;

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiTry > 30000) {
      lastWifiTry = millis();
      if (!connectKnown()) { render(); return; }
      configTzTime(TZ_LONDON, "pool.ntp.org", "time.google.com");
    }
  }

  uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (now - lastData > DATA_EVERY_MS || !haveSnap && now - lastData > 30000) { lastData = now; fetchSnapshot(); }
    if (now - lastLive > LIVE_EVERY_MS) { lastLive = now; fetchLive(); if (page == 0) render(); }
    if (now - lastUpdateCheck > UPDATE_EVERY_MS) { lastUpdateCheck = now; checkForUpdate(); render(); }
  }
  if (now - lastPage > PAGE_EVERY_MS) { lastPage = now; page = (page + 1) % PAGES; render(); }
  if (now - lastDraw > 15000) { lastDraw = now; autoDim(); render(); }  // keeps the clock current
  delay(15);
}
