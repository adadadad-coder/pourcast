"use strict";

/* ============================== Config ============================== */

const DEFAULT_SITES = [
  { id: "syd3", name: "AirTrunk SYD3", sub: "Huntingwood 2148", lat: -33.793, lon: 150.889 },
  { id: "newmarket", name: "Newmarket Stg 3", sub: "Randwick 2031", lat: -33.9146, lon: 151.2437 },
  { id: "liverpool", name: "Liverpool Hosp", sub: "Liverpool 2170", lat: -33.9209, lon: 150.928 },
  { id: "scfdc", name: "Woolworths SCFDC", sub: "Eastern Creek 2766", lat: -33.8027, lon: 150.858 },
];

const MODELS = [
  { key: "best", label: "Best match blend" },
  { key: "ecmwf", label: "ECMWF IFS" },
  { key: "bom", label: "BoM ACCESS-G" },
];

const CACHE_MAX_AGE = 45 * 60 * 1000; // refresh if older than 45 min

/* ============================== State ============================== */

const S = {
  sites: load("pc_sites", DEFAULT_SITES.slice()),
  settings: Object.assign({ theme: "auto", ws: 7, we: 15 }, load("pc_settings", {})),
  activeId: "all",
  data: {},        // siteId -> {status, models?, at?, sources?, msg?}
  expanded: null,
  editing: false,
  modal: null,     // null | "settings" | "add"
  geoResults: [],
  geoBusy: false,
  query: "",
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
function saveSites() { save("pc_sites", S.sites); }
function saveSettings() { save("pc_settings", S.settings); }

/* ============================== Theme ============================== */

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = S.settings.theme === "auto" ? (darkMedia.matches ? "dark" : "light") : S.settings.theme;
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "dark" ? "#0C141D" : "#EEF0F2");
}
darkMedia.addEventListener("change", applyTheme);

/* ============================== Helpers ============================== */

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = n => Math.round(n * 10) / 10;
const fmtHour = h => { h %= 24; if (h === 0) return "12am"; if (h < 12) return h + "am"; if (h === 12) return "12pm"; return (h - 12) + "pm"; };
const bandColor = b => b === "green" ? "var(--go)" : b === "amber" ? "var(--caution)" : "var(--nogo)";
const bandLabel = b => b === "green" ? "Pour" : b === "amber" ? "Caution" : "No pour";

function wxIcon(code, rain) {
  if (rain >= 5) return "🌧️";
  if (rain >= 0.5) return "🌦️";
  if (code >= 95) return "⛈️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 45 && code <= 48) return "🌫️";
  if (code >= 2 && code <= 3) return "⛅";
  return "☀️";
}

function rainSegments(hours, th) {
  th = th || 0.2;
  const segs = []; let start = null;
  hours.forEach((h, i) => {
    const wet = (h.r || 0) >= th;
    if (wet && start === null) start = i;
    if (!wet && start !== null) { segs.push([start, i]); start = null; }
  });
  if (start !== null) segs.push([start, 24]);
  return segs.map(p => fmtHour(p[0]) + " to " + fmtHour(p[1]));
}

/* ============================== Forecast maths ============================== */

function windowStats(hours, ws, we) {
  const win = hours.slice(ws, we);
  const temps = win.map(h => h.t).filter(t => t != null);
  return {
    rain: win.reduce((s, h) => s + (h.r || 0), 0),
    wet: win.filter(h => (h.r || 0) >= 0.2).length,
    gust: Math.max(0, ...win.map(h => h.g || 0)),
    windAvg: win.reduce((s, h) => s + (h.w || 0), 0) / Math.max(1, win.length),
    probMax: Math.max(0, ...win.map(h => h.p != null ? h.p : 0)),
    tMax: temps.length ? Math.max(...temps) : 20,
    tMin: temps.length ? Math.min(...temps) : 15,
  };
}

function computeDay(dayIndex, models, primaryKey, ws, we, ensMembers) {
  const hours = models[primaryKey].slice(dayIndex * 24, dayIndex * 24 + 24);
  const st = windowStats(hours, ws, we);

  // Ensemble: fraction of independent model runs showing meaningful rain in the window
  let ens = null;
  if (ensMembers && ensMembers.length) {
    let wet = 0;
    ensMembers.forEach(arr => {
      let r = 0;
      for (let i = ws; i < we; i++) r += arr[dayIndex * 24 + i] || 0;
      if (r >= 0.5) wet++;
    });
    ens = { total: ensMembers.length, wet, prob: Math.round(100 * wet / ensMembers.length) };
  }

  // Rain component (60%): deterministic mm blended with ensemble probability when available
  const mmScore = Math.min(100, st.rain * 18 + st.wet * 7);
  let rainComp;
  if (ens) {
    const ensScore = Math.min(100, Math.max(0, (ens.prob - 8) * 1.25));
    rainComp = Math.min(100, Math.max(mmScore, ensScore) * 0.7 + Math.min(mmScore, ensScore) * 0.3);
  } else {
    const probScore = st.probMax ? Math.min(100, Math.max(0, (st.probMax - 15) * 1.1)) : 0;
    rainComp = Math.min(100, Math.max(mmScore, probScore * 0.75));
  }

  // Wind component (25%)
  const windComp = Math.min(100, Math.max(Math.max(0, (st.gust - 25) * 2.8), Math.max(0, (st.windAvg - 20) * 3)));

  // Temperature component (15%)
  let tempComp = 0;
  if (st.tMax >= 35) tempComp = 100; else if (st.tMax > 32) tempComp = (st.tMax - 32) * 30;
  if (st.tMin < 5) tempComp = 100; else if (st.tMin < 10) tempComp = Math.max(tempComp, (10 - st.tMin) * 16);

  const risk = Math.round(rainComp * 0.6 + windComp * 0.25 + tempComp * 0.15);
  const band = risk < 30 ? "green" : risk <= 60 ? "amber" : "red";

  // Deterministic model cross check
  const perModel = [];
  MODELS.forEach(m => {
    if (!models[m.key]) return;
    const mh = models[m.key].slice(dayIndex * 24, dayIndex * 24 + 24);
    const ms = windowStats(mh, ws, we);
    perModel.push({ key: m.key, label: m.label, rain: ms.rain, gust: ms.gust, tMax: ms.tMax, wet: ms.rain >= 0.5 });
  });
  const wetVotes = perModel.filter(m => m.wet).length;
  const n = perModel.length;

  // Confidence: ensemble is the strongest signal when present
  let conf;
  if (ens) {
    const p = ens.prob;
    const level = (p <= 15 || p >= 85) ? "high" : (p <= 35 || p >= 65) ? "med" : "low";
    conf = { level, text: ens.wet + " of " + ens.total + " ensemble runs show rain in the window (" + p + "%)" };
  } else if (n >= 2 && wetVotes > 0 && wetVotes < n) {
    conf = { level: wetVotes * 2 !== n ? "med" : "low", text: wetVotes + " of " + n + " models forecast rain in the pour window" };
  } else {
    conf = { level: "high", text: n <= 1 ? "Single model" : "Models agree" };
  }

  // Reasons
  const reasons = [];
  if (st.rain >= 0.2) {
    const inWin = rainSegments(hours.map((h, i) => (i >= ws && i < we) ? h : { r: 0 }));
    if (inWin.length) reasons.push(r1(st.rain) + "mm rain in pour window (" + inWin.join(", ") + ")");
  } else if (ens && ens.prob >= 40) {
    reasons.push("Ensemble risk: " + ens.prob + "% of runs show rain despite dry primary forecast");
  } else if (!ens && st.probMax >= 55) {
    reasons.push(st.probMax + "% chance of rain in pour window");
  }
  if (n >= 2 && wetVotes > 0 && wetVotes < n) {
    reasons.push("Models split: " + wetVotes + " of " + n + " show window rain");
  }
  if (st.gust >= 40) reasons.push("Gusts to " + Math.round(st.gust) + " km/h, boom pump caution");
  else if (st.windAvg >= 25) reasons.push("Sustained wind " + Math.round(st.windAvg) + " km/h");
  if (st.tMax >= 35) reasons.push("Hot weather limit " + r1(st.tMax) + "\u00B0C (AS 1379)");
  else if (st.tMax > 32) reasons.push("High temp " + r1(st.tMax) + "\u00B0C, evaporation risk");
  if (st.tMin < 5) reasons.push("Cold " + r1(st.tMin) + "\u00B0C, cure risk");
  else if (st.tMin < 10) reasons.push("Cool morning " + r1(st.tMin) + "\u00B0C");
  if (!reasons.length) reasons.push("Clear pour conditions");

  const tempsAll = hours.map(h => h.t).filter(t => t != null);
  return {
    hours, risk, band, reasons, conf, perModel, ens,
    gustMax: st.gust, probMax: st.probMax,
    daySegs: rainSegments(hours),
    dayRain: hours.reduce((s, h) => s + (h.r || 0), 0),
    tMinDay: tempsAll.length ? Math.min(...tempsAll) : 0,
    tMaxDay: tempsAll.length ? Math.max(...tempsAll) : 0,
  };
}

function buildDays(entry) {
  const primaryKey = entry.primary;
  const times = entry.times;
  const nDays = Math.min(7, Math.floor(times.length / 24));
  const ws = S.settings.ws, we = S.settings.we;
  const days = [];
  for (let d = 0; d < nDays; d++) {
    const day = computeDay(d, entry.models, primaryKey, ws, we, entry.ensemble || null);
    day.date = new Date(times[d * 24]);
    days.push(day);
  }
  return days;
}

/* ============================== Data fetching ============================== */

function normaliseHours(H, len) {
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push({
      t: H.temperature_2m ? H.temperature_2m[i] : null,
      r: (H.precipitation && H.precipitation[i]) || 0,
      p: (H.precipitation_probability && H.precipitation_probability[i] != null) ? H.precipitation_probability[i] : null,
      w: (H.wind_speed_10m && H.wind_speed_10m[i]) || 0,
      g: (H.wind_gusts_10m && H.wind_gusts_10m[i]) || 0,
      c: (H.weather_code && H.weather_code[i]) || 0,
    });
  }
  return out;
}

function hasRealData(json) {
  const H = json && json.hourly;
  if (!H || !H.time || !H.time.length) return false;
  const t = H.temperature_2m;
  return !!(t && t.length && t.some(v => v != null));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.reason || "API error");
  return json;
}

async function fetchSite(site, opts) {
  opts = opts || {};
  const cached = S.data[site.id];
  if (!opts.silent || !cached || cached.status !== "ok") {
    S.data[site.id] = Object.assign({}, cached, { status: cached && cached.status === "ok" ? "refreshing" : "loading" });
    render();
  }

  const coords = "latitude=" + site.lat + "&longitude=" + site.lon + "&timezone=Australia%2FSydney&forecast_days=7";
  const vars = "temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code";

  const urls = {
    best: "https://api.open-meteo.com/v1/forecast?" + coords + "&hourly=" + vars + ",precipitation_probability",
    ecmwf: "https://api.open-meteo.com/v1/forecast?" + coords + "&hourly=" + vars + "&models=ecmwf_ifs025",
    bom: "https://api.open-meteo.com/v1/bom?" + coords + "&hourly=" + vars,
    ens: "https://ensemble-api.open-meteo.com/v1/ensemble?" + coords + "&hourly=precipitation&models=ecmwf_ifs025",
  };

  const results = await Promise.allSettled([fetchJson(urls.best), fetchJson(urls.ecmwf), fetchJson(urls.bom), fetchJson(urls.ens)]);
  const jsons = { best: null, ecmwf: null, bom: null };
  ["best", "ecmwf", "bom"].forEach((k, i) => {
    if (results[i].status === "fulfilled" && hasRealData(results[i].value)) jsons[k] = results[i].value;
  });

  // Ensemble members: every hourly key beginning with "precipitation" is one model run
  // (the control run plus 50 perturbed members for ECMWF ENS).
  let ensemble = null;
  if (results[3].status === "fulfilled") {
    const EH = results[3].value.hourly;
    if (EH && EH.time && EH.time.length) {
      const members = Object.keys(EH)
        .filter(k => k.indexOf("precipitation") === 0)
        .map(k => (EH[k] || []).map(v => v == null ? 0 : Math.round(v * 10) / 10));
      if (members.length >= 10) ensemble = members;
    }
  }

  const primary = jsons.best ? "best" : jsons.ecmwf ? "ecmwf" : jsons.bom ? "bom" : null;
  if (!primary) {
    const reason = results[0].status === "rejected" ? results[0].reason.message : "No forecast data returned";
    if (cached && cached.status === "ok") {
      S.data[site.id] = Object.assign({}, cached, { status: "ok", stale: true });
    } else {
      S.data[site.id] = { status: "error", msg: reason };
    }
    render();
    return;
  }

  const len = jsons[primary].hourly.time.length;
  const models = {};
  ["best", "ecmwf", "bom"].forEach(k => {
    if (jsons[k]) models[k] = normaliseHours(jsons[k].hourly, Math.min(len, jsons[k].hourly.time.length));
  });

  const entry = {
    status: "ok",
    primary,
    times: jsons[primary].hourly.time,
    models,
    ensemble,
    sources: MODELS.filter(m => models[m.key]).map(m => m.label).concat(ensemble ? ["ECMWF ensemble (" + ensemble.length + " runs)"] : []),
    bomLive: !!jsons.bom,
    at: Date.now(),
    stale: false,
  };
  S.data[site.id] = entry;
  persistCache();
  render();
}

function persistCache() {
  const out = {};
  S.sites.forEach(s => {
    const d = S.data[s.id];
    if (d && d.status === "ok") {
      out[s.id] = { primary: d.primary, times: d.times, models: d.models, ensemble: d.ensemble || null, sources: d.sources, bomLive: d.bomLive, at: d.at };
    }
  });
  save("pc_cache", out);
}

function hydrateCache() {
  const c = load("pc_cache", {});
  S.sites.forEach(s => {
    if (c[s.id]) S.data[s.id] = Object.assign({ status: "ok", stale: true }, c[s.id]);
  });
}

function refreshAll(force) {
  S.sites.forEach(s => {
    const d = S.data[s.id];
    const fresh = d && d.status === "ok" && !d.stale && (Date.now() - d.at) < CACHE_MAX_AGE;
    if (force || !fresh) fetchSite(s, { silent: true });
  });
}

/* ============================== Geocoding ============================== */

async function searchGeo() {
  const el = document.getElementById("geoq");
  const q = el ? el.value.trim() : "";
  S.query = q;
  if (!q) return;
  S.geoBusy = true; S.geoResults = []; render();
  try {
    const j = await fetchJson("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q) + "&count=8&language=en&format=json");
    S.geoResults = (j.results || []).filter(r => r.country_code === "AU");
  } catch (e) { S.geoResults = []; }
  S.geoBusy = false; render();
  const el2 = document.getElementById("geoq");
  if (el2) { el2.value = q; }
}

function addGeo(idx) {
  const r = S.geoResults[idx];
  if (!r) return;
  const site = {
    id: "c" + r.id,
    name: r.name,
    sub: [(r.postcodes && r.postcodes[0]), r.admin1].filter(Boolean).join(" "),
    lat: r.latitude, lon: r.longitude,
  };
  if (!S.sites.some(s => s.id === site.id)) S.sites.push(site);
  S.activeId = site.id;
  S.modal = null; S.geoResults = []; S.query = "";
  saveSites();
  fetchSite(site);
}

/* ============================== Actions ============================== */

function setActive(id) { S.activeId = id; S.expanded = null; render(); window.scrollTo({ top: 0 }); }
function toggleEdit() { S.editing = !S.editing; render(); }
function toggleDay(key) { S.expanded = S.expanded === key ? null : key; render(); }
function openModal(m) { S.modal = m; render(); if (m === "add") { const el = document.getElementById("geoq"); if (el) el.focus(); } }
function closeModal(ev) { if (ev && ev.target !== ev.currentTarget) return; S.modal = null; S.geoResults = []; S.query = ""; render(); }
function removeSite(id) {
  S.sites = S.sites.filter(x => x.id !== id);
  delete S.data[id];
  if (S.activeId === id) S.activeId = "all";
  saveSites(); persistCache(); render();
}
function resetSites() {
  S.sites = DEFAULT_SITES.slice();
  S.activeId = "all"; S.editing = false; S.modal = null;
  saveSites();
  render();
  S.sites.forEach(s => fetchSite(s, { silent: true }));
}
function refreshActive() {
  if (S.activeId === "all") { refreshAll(true); return; }
  const s = S.sites.find(x => x.id === S.activeId);
  if (s) fetchSite(s);
}
function setTheme(t) { S.settings.theme = t; saveSettings(); applyTheme(); render(); }
function setWindow(which, val) {
  val = parseInt(val, 10);
  if (which === "ws") S.settings.ws = Math.min(val, S.settings.we - 1);
  else S.settings.we = Math.max(val, S.settings.ws + 1);
  saveSettings(); render();
}

/* ============================== Radar ============================== */

const SYDNEY = { name: "All Sydney", lat: -33.86, lon: 150.95, zoom: 8 };

function setRadarFocus(idx) {
  S.radarFocus = idx < 0 ? null : idx;
  render();
}

function radarView() {
  const focusSite = (S.radarFocus != null && S.sites[S.radarFocus]) ? S.sites[S.radarFocus] : null;
  const f = focusSite ? { name: focusSite.name, lat: focusSite.lat, lon: focusSite.lon, zoom: 10 } : SYDNEY;

  const btns = ['<button class="btn' + (!focusSite ? " primary" : "") + '" onclick="setRadarFocus(-1)">All Sydney</button>']
    .concat(S.sites.map((s, i) =>
      '<button class="btn' + (S.radarFocus === i ? " primary" : "") + '" onclick="setRadarFocus(' + i + ')">' + esc(s.name) + '</button>'
    )).join("");

  const src = "https://embed.windy.com/embed2.html?lat=" + f.lat + "&lon=" + f.lon +
    "&detailLat=" + f.lat + "&detailLon=" + f.lon +
    "&zoom=" + f.zoom + "&level=surface&overlay=radar&product=radar" +
    "&menu=&message=true&marker=true&calendar=now&pressure=&type=map&location=coordinates" +
    "&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1";

  return '<div class="sitehead"><div class="sitetitle">Live radar <span>' + esc(f.name) + '</span></div></div>' +
    '<div class="radarbtns">' + btns + '</div>' +
    '<iframe class="radarframe" src="' + src + '" loading="lazy" title="Live weather radar" allowfullscreen></iframe>' +
    '<div class="foot">Live rain radar via Windy, built on BoM radar stations. Use the play control on the map to run the last hour and see which way cells are tracking. For a marginal morning call, radar movement over the last 30 to 60 minutes beats any model.</div>';
}

/* ============================== Rendering ============================== */

function confColor(level) {
  return level === "high" ? "var(--go)" : level === "med" ? "var(--caution)" : "var(--nogo)";
}

function riskBlock(day) {
  const col = bandColor(day.band);
  return '<div class="riskblock"><div class="pct num" style="color:' + col + '">' + day.risk + '%</div>' +
    '<span class="stamp" style="color:' + col + '">' + bandLabel(day.band) + '</span></div>';
}

function pourStrip(day) {
  const ws = S.settings.ws, we = S.settings.we;
  let cells = "";
  day.hours.slice(ws, we).forEach((h, i) => {
    let bg = "";
    if (h.r >= 1) bg = "background:var(--rain-deep);";
    else if (h.r >= 0.2) bg = "background:var(--rain);opacity:.55;";
    else if (h.r >= 0.05 || (h.p != null && h.p >= 60)) bg = "background:var(--rain);opacity:.22;";
    cells += '<div class="cell' + (h.g >= 40 ? " gusty" : "") + '" style="' + bg + '" title="' + fmtHour(ws + i) + '"></div>';
  });
  return '<div class="strip">' + cells + '</div>' +
    '<div class="striplbl"><span>' + fmtHour(ws).toUpperCase() + '</span><span>POUR WINDOW</span><span>' + fmtHour(we).toUpperCase() + '</span></div>';
}

function hourlyTable(day) {
  const ws = S.settings.ws, we = S.settings.we;
  const showProb = day.hours.some(h => h.p != null);
  const cols = showProb ? "54px 1fr 1fr 1fr 1.25fr" : "54px 1fr 1fr 1.25fr";
  const from = Math.max(0, ws - 2), to = Math.min(24, we + 3);
  let html = '<div class="hourly"><div class="hrow head" style="grid-template-columns:' + cols + '">' +
    '<span>Time</span><span>Temp</span><span>Rain</span>' + (showProb ? '<span>Chance</span>' : '') + '<span>Wind / gust</span></div>';
  for (let i = from; i < to; i++) {
    const h = day.hours[i];
    const inWin = i >= ws && i < we;
    const wet = h.r >= 0.2;
    html += '<div class="hrow num' + (inWin ? " win" : "") + (wet ? " wet" : "") + '" style="grid-template-columns:' + cols + '">' +
      '<span style="' + (inWin ? "font-weight:600" : "color:var(--muted)") + '">' + fmtHour(i) + '</span>' +
      '<span>' + (h.t != null ? r1(h.t) + "\u00B0" : "n/a") + '</span>' +
      '<span style="' + (wet ? "color:var(--rain);font-weight:600" : "color:var(--muted)") + '">' + (h.r >= 0.05 ? r1(h.r) + "mm" : "0") + '</span>' +
      (showProb ? '<span style="color:' + ((h.p || 0) >= 60 ? "var(--rain)" : "var(--muted)") + '">' + (h.p != null ? h.p + "%" : "n/a") + '</span>' : '') +
      '<span style="color:' + (h.g >= 40 ? "var(--accent)" : "var(--muted)") + ';' + (h.g >= 40 ? "font-weight:700" : "") + '">' + Math.round(h.w) + ' / ' + Math.round(h.g) + '</span></div>';
  }
  html += '</div>';
  return html;
}

function modelTable(day, primaryKey) {
  if (day.perModel.length < 2) return "";
  let html = '<div class="models"><div class="mrow head"><span>Model</span><span>Rain (window)</span><span>Peak gust</span><span>Max temp</span></div>';
  day.perModel.forEach(m => {
    html += '<div class="mrow num"><span class="mname">' + esc(m.label) +
      (m.key === primaryKey ? ' <span class="mprimary">PRIMARY</span>' : '') + '</span>' +
      '<span style="color:' + (m.rain >= 0.5 ? "var(--rain)" : "var(--muted)") + '">' + r1(m.rain) + 'mm</span>' +
      '<span style="color:' + (m.gust >= 40 ? "var(--accent)" : "var(--muted)") + '">' + Math.round(m.gust) + ' km/h</span>' +
      '<span style="color:var(--muted)">' + r1(m.tMax) + '\u00B0</span></div>';
  });
  html += '<div class="foot">Rain totals are for your pour window only. The primary model drives the risk score; the others are the cross check.</div></div>';
  return html;
}

function dayCard(day, idx, siteId, primaryKey) {
  const key = siteId + idx;
  const open = S.expanded === key;
  const dayName = idx === 0 ? "Today" : day.date.toLocaleDateString("en-AU", { weekday: "long" });
  const dateStr = day.date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  let rainLine = "";
  if (day.dayRain >= 0.2 && day.daySegs.length) {
    rainLine = '<div class="rainline">Rain: ' + esc(day.daySegs.join(", ")) + '</div>';
  }
  const conf = '<div class="confline"><span class="confpip" style="background:' + confColor(day.conf.level) + '"></span>' + esc(day.conf.text) + '</div>';
  const tags = day.reasons.map(r => '<span class="tag">' + esc(r) + '</span>').join("");

  return '<div class="card tap" onclick="toggleDay(\'' + key + '\')">' +
    '<div class="dayhead"><div style="flex:1;min-width:0">' +
      '<span class="dayname">' + dayName + '</span> <span class="daydate">' + dateStr + '</span> ' +
      '<span style="font-size:16px">' + wxIcon(day.hours[12] ? day.hours[12].c : 0, day.dayRain) + '</span>' +
      '<div class="daymeta num">' + r1(day.tMinDay) + '\u00B0 to ' + r1(day.tMaxDay) + '\u00B0 \u00B7 rain ' + r1(day.dayRain) + 'mm \u00B7 gusts ' + Math.round(day.gustMax) + ' km/h</div>' +
      rainLine + conf +
    '</div>' + riskBlock(day) + '</div>' +
    pourStrip(day) +
    '<div class="tags">' + tags + '</div>' +
    (open ? hourlyTable(day) + modelTable(day, primaryKey) : "") +
    '<div class="expandhint">' + (open ? "HIDE DETAIL" : "TAP FOR HOURLY + MODEL COMPARISON") + '</div>' +
  '</div>';
}

function summaryView() {
  let siteRows = "";
  S.sites.forEach(s => {
    const d = S.data[s.id];
    let grid;
    if (d && (d.status === "ok" || d.status === "refreshing") && d.models) {
      const days = buildDays(d);
      grid = '<div class="minigrid">' + days.map(day => {
        const op = day.band === "green" ? "opacity:.32" : "";
        return '<div class="minicell"><div class="d">' + day.date.toLocaleDateString("en-AU", { weekday: "narrow" }) + '</div>' +
          '<div class="c num" style="background:' + bandColor(day.band) + ';' + op + '">' + (day.band !== "green" ? day.risk : "") + '</div></div>';
      }).join("") + '</div>';
    } else if (d && d.status === "error") {
      grid = '<div style="font-size:11px;color:var(--nogo)">Failed to load</div>';
    } else {
      grid = '<div style="font-size:11px;color:var(--faint)">Loading\u2026</div>';
    }
    siteRows += '<div class="siterow" onclick="setActive(\'' + s.id + '\')">' +
      '<div style="flex:0 0 130px;min-width:0"><div class="sname">' + esc(s.name) + '</div>' +
      '<div class="ssub">' + esc(s.sub) + '</div></div>' + grid + '</div>';
  });

  const flagged = [];
  S.sites.forEach(s => {
    const d = S.data[s.id];
    if (!d || !(d.status === "ok" || d.status === "refreshing") || !d.models) return;
    buildDays(d).forEach((day, i) => {
      if (day.band !== "green") flagged.push({ site: s, day, i });
    });
  });
  flagged.sort((a, b) => b.day.risk - a.day.risk);

  const anyLoading = S.sites.some(s => !S.data[s.id] || S.data[s.id].status === "loading");
  let flagHtml;
  if (!flagged.length) {
    flagHtml = anyLoading
      ? '<div style="font-size:13px;color:var(--muted)">Loading forecasts\u2026</div>'
      : '<div style="font-size:13px;color:var(--go);font-weight:600">All clear. No pour risks flagged across any site this week.</div>';
  } else {
    flagHtml = flagged.map(f => {
      const lbl = (f.i === 0 ? "Today" : f.day.date.toLocaleDateString("en-AU", { weekday: "short" })) + " " +
        f.day.date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
      return '<div class="flagrow" onclick="setActive(\'' + f.site.id + '\')">' +
        '<span class="flagpct num" style="background:' + bandColor(f.day.band) + '">' + f.day.risk + '%</span>' +
        '<div style="flex:1;min-width:0"><div class="flagtitle">' + esc(f.site.name) + ' \u00B7 ' + lbl + '</div>' +
        '<div class="flagsub">' + esc(f.day.reasons.join(" \u00B7 ")) + '</div></div>' +
        '<span style="color:var(--faint)">\u203A</span></div>';
    }).join("");
  }

  return '<div class="card"><div class="eyebrow">Week at a glance \u00B7 All sites</div>' + siteRows +
    '<div class="foot">Coloured cells show pour risk % for flagged days. Tap a site row for detail.</div></div>' +
    '<div class="card"><div class="eyebrow">Flagged pour risks</div>' + flagHtml + '</div>';
}

function siteView(site) {
  const d = S.data[site.id];
  let body;
  if (!d || d.status === "loading") {
    body = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  } else if (d.status === "error") {
    body = '<div class="errbox"><div style="font-weight:600;margin-bottom:4px">Couldn\u2019t load the forecast for this site.</div>' +
      '<div style="color:var(--muted);font-size:12px">' + esc(d.msg || "") + '. Check your connection and tap refresh.</div></div>';
  } else {
    const days = buildDays(d);
    const banner = !d.bomLive
      ? '<div class="banner">BoM\u2019s open-data feed is temporarily offline for system upgrades. Forecast uses the multi-model blend and ECMWF; BoM ACCESS-G rejoins automatically when it returns.</div>'
      : '';
    const stale = d.stale
      ? '<div class="banner">Showing your last saved forecast. Couldn\u2019t reach the weather service just now, tap refresh to retry.</div>'
      : '';
    body = banner + stale + days.map((day, i) => dayCard(day, i, site.id, d.primary)).join("") +
      '<div class="foot">Risk % is calculated on your ' + fmtHour(S.settings.ws) + ' to ' + fmtHour(S.settings.we) +
      ' pour window: rain 60%, wind 25%, temperature 15%. Orange cell edges mark gusts of 40 km/h or more. ' +
      'Sources: ' + esc((d.sources || []).join(", ")) + ' via Open-Meteo. Model guidance only, verify marginal calls against the official BoM forecast. Updated ' +
      new Date(d.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) + '.</div>';
  }
  return '<div class="sitehead"><div class="sitetitle">' + esc(site.name) + ' <span>' + esc(site.sub) + '</span></div>' +
    '<button class="btn ghost" onclick="refreshActive()">\u21BB REFRESH</button></div>' + body;
}

function settingsSheet() {
  const t = S.settings.theme;
  const hoursStart = [4, 5, 6, 7, 8, 9, 10, 11].map(h => '<option value="' + h + '"' + (S.settings.ws === h ? " selected" : "") + '>' + fmtHour(h) + '</option>').join("");
  const hoursEnd = [12, 13, 14, 15, 16, 17, 18, 19].map(h => '<option value="' + h + '"' + (S.settings.we === h ? " selected" : "") + '>' + fmtHour(h) + '</option>').join("");
  return '<div class="sheet-scrim" onclick="closeModal(event)"><div class="sheet">' +
    '<h2>Settings</h2><div class="sub">Saved on this device.</div>' +
    '<div class="setrow"><div class="setlabel">Theme</div><div class="seg">' +
      '<button class="' + (t === "light" ? "on" : "") + '" onclick="setTheme(\'light\')">Light</button>' +
      '<button class="' + (t === "dark" ? "on" : "") + '" onclick="setTheme(\'dark\')">Dark</button>' +
      '<button class="' + (t === "auto" ? "on" : "") + '" onclick="setTheme(\'auto\')">Auto</button>' +
    '</div></div>' +
    '<div class="setrow"><div class="setlabel">Pour window</div><div class="selpair">' +
      '<select onchange="setWindow(\'ws\', this.value)">' + hoursStart + '</select><span>to</span>' +
      '<select onchange="setWindow(\'we\', this.value)">' + hoursEnd + '</select>' +
    '</div><div class="foot">Risk scores and the strip recalculate instantly for the new window.</div></div>' +
    '<div class="setrow"><div class="setlabel">Sites</div>' +
      '<button class="btn danger block" onclick="resetSites()">Reset to default project sites</button></div>' +
    '<div class="setrow"><div class="setlabel">About</div>' +
      '<div class="foot" style="margin-top:0">PourCast pulls four independent signals per site: the multi-model best match (primary), ECMWF IFS, BoM ACCESS-G when its feed is live, and the 51-run ECMWF ensemble that drives the confidence rating. The Radar tab shows live rain over Sydney for day-of calls. Add this page to your Home Screen on iPhone to use it as an app.</div></div>' +
    '<button class="btn block" onclick="closeModal()">Done</button>' +
  '</div></div>';
}

function addSheet() {
  const results = S.geoResults.map((r, i) => {
    const sub = [(r.postcodes && r.postcodes[0]), r.admin1].filter(Boolean).join(", ");
    return '<div class="georesult" onclick="addGeo(' + i + ')">' + esc(r.name) + ' <span class="g2">' + esc(sub) + '</span></div>';
  }).join("");
  const hint = (!S.geoBusy && !S.geoResults.length)
    ? '<div class="foot">Search a postcode or suburb, then tap a result. Sites are saved on this device.</div>' : "";
  return '<div class="sheet-scrim" onclick="closeModal(event)"><div class="sheet">' +
    '<h2>Add a site</h2><div class="sub">Anywhere in Australia by postcode or suburb.</div>' +
    '<div class="addrow"><input type="text" id="geoq" value="' + esc(S.query) + '" placeholder="e.g. 2765 or Marsden Park" ' +
      'onkeydown="if(event.key===\'Enter\')searchGeo()">' +
      '<button class="btn primary" onclick="searchGeo()">' + (S.geoBusy ? "\u2026" : "Search") + '</button></div>' +
    results + hint +
  '</div></div>';
}

function render() {
  const chips = [
    '<div class="chip' + (S.activeId === "all" ? " on" : "") + '" onclick="setActive(\'all\')"><div class="nm">All sites</div><div class="sb">Summary</div></div>',
    '<div class="chip' + (S.activeId === "radar" ? " on" : "") + '" onclick="setActive(\'radar\')"><div class="nm">Radar</div><div class="sb">Live \u00B7 Sydney</div></div>',
  ]
    .concat(S.sites.map(s => {
      const d = S.data[s.id];
      let dot = "";
      if (d && d.models) {
        const today = buildDays(d)[0];
        if (today) dot = '<span class="statusdot" style="background:' + bandColor(today.band) + '"></span>';
      }
      const rm = S.editing ? '<button class="chip-x" onclick="event.stopPropagation();removeSite(\'' + s.id + '\')" aria-label="Remove ' + esc(s.name) + '">\u00D7</button>' : "";
      return '<div class="chip' + (S.activeId === s.id ? " on" : "") + '" onclick="setActive(\'' + s.id + '\')">' +
        '<div class="chip-inner">' + dot + '<div><div class="nm">' + esc(s.name) + '</div><div class="sb">' + esc(s.sub) + '</div></div>' + rm + '</div></div>';
    }))
    .concat(['<button class="chip-add" onclick="openModal(\'add\')">+ Add site</button>']).join("");

  const site = S.sites.find(s => s.id === S.activeId);
  const content = S.activeId === "radar" ? radarView()
    : (S.activeId === "all" || !site) ? summaryView()
    : siteView(site);

  document.getElementById("app").innerHTML =
    '<div class="header"><div><div class="logo">POUR<b>CAST</b></div>' +
      '<div class="tagline">7 day pour risk \u00B7 multi model</div></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="iconbtn" onclick="toggleEdit()" title="Edit sites" aria-label="Edit sites" style="' + (S.editing ? "color:var(--accent);border-color:var(--accent)" : "") + '">\u270E</button>' +
        '<button class="iconbtn" onclick="openModal(\'settings\')" title="Settings" aria-label="Settings">\u2699</button>' +
      '</div></div>' +
    '<div class="chiprow">' + chips + '</div>' +
    '<div>' + content + '</div>' +
    (S.modal === "settings" ? settingsSheet() : "") +
    (S.modal === "add" ? addSheet() : "");
}

/* Expose handlers used in markup */
Object.assign(window, {
  setActive, toggleEdit, toggleDay, openModal, closeModal, removeSite,
  resetSites, refreshActive, setTheme, setWindow, searchGeo, addGeo, setRadarFocus,
});

/* ============================== Boot ============================== */

applyTheme();
hydrateCache();
render();
refreshAll(false);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll(false);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
