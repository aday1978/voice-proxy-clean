// src/estate.js
import fetch from "node-fetch";

const BASE        = process.env.ESTATE_BASE_URL   || "https://apiv3.loop.software/api";
const KEY         = (process.env.ESTATE_API_KEY   || "").trim();
const KEY_HEADER  = process.env.ESTATE_KEY_HEADER || "x-api-key";
const TIMEOUT_MS  = Number(process.env.ESTATE_TIMEOUT_MS || 2500);  // full search timeout
const FAST_MS     = 1200;                                           // fast-first timeout
const PAGE_SIZE   = 100;
const FAST_PAGE   = 30;

// ---------- simple in-memory cache (60s) ----------
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { at:number, data:any }
function getCache(key){ const v=cache.get(key); if(!v) return null; if(Date.now()-v.at > CACHE_TTL_MS){ cache.delete(key); return null; } return v.data; }
function setCache(key,data){ cache.set(key,{ at:Date.now(), data }); }

// ---------- utils ----------
const norm = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const lev = (a, b) => {
  a = norm(a); b = norm(b);
  const m = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return m[a.length][b.length];
};

// Soundex for “tilehouse” vs “tiehouse”
const soundex = (s) => {
  s = (s || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  const f = s[0];
  const map = {B:1,F:1,P:1,V:1,C:2,G:2,J:2,K:2,Q:2,S:2,X:2,Z:2,D:3,T:3,L:4,M:5,N:5,R:6};
  let out = f;
  let prev = map[f] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const code = map[s[i]] || 0;
    if (code !== 0 && code !== prev) out += code;
    prev = code;
  }
  while (out.length < 4) out += "0";
  return out;
};

const closeTown = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  if (g.includes(w) || w.includes(g)) return true;
  return lev(w, g) <= 2; // colville -> coalville
};

const streetFuzzyHit = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  if (g.includes(w)) return true;
  if (lev(w, g) <= 2) return true;
  if (soundex(w) === soundex(g)) return true;
  return false;
};

// price within ±12% or ±£15k
const priceClose = (want, got) => {
  if (!want || !got) return true;
  const w = +String(want).replace(/[^\d]/g, "") || 0;
  const g = +String(got).replace(/[^\d]/g, "") || 0;
  if (!w || !g) return true;
  const band = Math.max(w * 0.12, 15000);
  return Math.abs(w - g) <= band;
};

const simplify = (r, market) => ({
  refId: String(r.refId ?? r.salesLifecycleId ?? r.lettingsLifecycleId ?? ""),
  address: r.address || [r.propertyStreet, r.propertyLocality, r.propertyTown, r.propertyPostcode].filter(Boolean).join(", "),
  street: r.propertyStreet || "",
  town: r.propertyTown || "",
  postcode: r.propertyPostcode || "",
  propertyTypeText: r.propertyTypeText || "",
  price: r.price ?? null,
  market,
  teamEmail: r.teamEmail || "",
  teamPhone: r.teamPhone || "",
  responsibleAgentName: r.responsibleAgentName || ""
});

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { headers: { [KEY_HEADER]: KEY }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { ok: true, results: Array.isArray(data?.results) ? data.results : [] };
  } catch (e) {
    if (String(e?.name||"").includes("Abort") || String(e?.message||"").includes("Abort") || String(e?.message||"").includes("timeout")) {
      return { ok: false, transient: true, results: [] };
    }
    return { ok: false, transient: false, results: [] };
  } finally {
    clearTimeout(t);
  }
}

// ---------- URLs ----------
const salesURL = ({ street, town, postcode, pageSize }) => {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/sales-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));
  return u.toString();
};
const lettingsFieldedURL = ({ street, town, postcode, pageSize }) => {
  const u = new URL(`${BASE}/lettings-properties`);
  if (street)   u.searchParams.set("propertyStreet", street);
  if (town)     u.searchParams.set("propertyTown", town);
  if (postcode) u.searchParams.set("propertyPostcode", postcode);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));
  return u.toString();
};
const lettingsSearchURL = ({ street, town, postcode, pageSize }) => {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/lettings-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));
  return u.toString();
};

// ---------- filtering helpers ----------
function filterCandidates(list, { street, town, price }) {
  const wantT = norm(town), wantS = norm(street);
  let candidates = list.filter(p =>
    (wantT ? (closeTown(wantT, p.town) || closeTown(wantT, p.address)) : true) &&
    (wantS ? (streetFuzzyHit(wantS, p.street) || streetFuzzyHit(wantS, p.address)) : true)
  );
  candidates = candidates.filter(p => priceClose(price, p.price));
  return candidates;
}

// ---------- unified lookup with fast-first + fallback ----------
export async function unifiedLookup({ street = "", town = "", postcode = "", price = "" } = {}) {
  if (!KEY) throw new Error("ESTATE_API_KEY missing");

  // cache
  const cacheKey = JSON.stringify({ street: norm(street), town: norm(town), postcode: norm(postcode), price: norm(price) });
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // 0) FAST-FIRST: sales searchText small page, 1.2s cap
  const fastSales = await fetchWithTimeout(
    salesURL({ street, town, postcode, pageSize: FAST_PAGE }),
    FAST_MS
  );
  let list = [];
  if (fastSales.ok && fastSales.results.length) {
    list = fastSales.results.map(r => simplify(r, "sales"));
    // dedupe + filter immediately
    const seen = new Set(); const de = [];
    for (const p of list) { const k = p.refId || p.address; if (!seen.has(k)) { seen.add(k); de.push(p); } }
    let candidates = filterCandidates(de, { street, town, price });
    if (candidates.length) {
      const out = pack(candidates);
      setCache(cacheKey, out);
      return out; // early success: instant response
    }
  }

  // 1) FULL: parallel sales + lettings with 2.5s cap
  const [s, lf, ls] = await Promise.all([
    fetchWithTimeout(salesURL({ street, town, postcode, pageSize: PAGE_SIZE }), TIMEOUT_MS),
    fetchWithTimeout(lettingsFieldedURL({ street, town, postcode, pageSize: PAGE_SIZE }), TIMEOUT_MS),
    fetchWithTimeout(lettingsSearchURL({ street, town, postcode, pageSize: PAGE_SIZE }), TIMEOUT_MS),
  ]);
  const anyTransient = [s, lf, ls].some(r => r.ok === false && r.transient === true);

  const S  = s.ok  ? s.results.map(r => simplify(r, "sales"))     : [];
  const L1 = lf.ok ? lf.results.map(r => simplify(r, "lettings")) : [];
  const L2 = ls.ok ? ls.results.map(r => simplify(r, "lettings")) : [];
  const all = [...S, ...L1, ...L2];

  // dedupe
  const seen = new Set(); const de = [];
  for (const p of all) { const k = p.refId || p.address; if (!seen.has(k)) { seen.add(k); de.push(p); } }

  // primary filter
  let candidates = filterCandidates(de, { street, town, price });

  // 2) town-only fallback if nothing
  if (candidates.length === 0 && norm(town)) {
    const townOnly = de.filter(p => closeTown(norm(town), p.town) || closeTown(norm(town), p.address));
    const score = (w, g) => {
      const a = lev(w, g);
      const bonus = soundex(w) === soundex(g) ? -1 : 0;
      return a + bonus;
    };
    const w = norm(street);
    candidates = townOnly
      .map(p => ({ p, s: Math.min(score(w, norm(p.street||"")), score(w, norm(p.address||""))) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 12)
      .map(x => x.p)
      .filter(p => !w || streetFuzzyHit(w, p.street) || streetFuzzyHit(w, p.address))
      .filter(p => priceClose(price, p.price));
  }

  const out = pack(candidates, anyTransient);
  setCache(cacheKey, out);
  return out;
}

function pack(candidates, transient=false){
  const sales_count     = candidates.filter(c => c.market === "sales").length;
  const lettings_count  = candidates.filter(c => c.market === "lettings").length;
  const markets_present = Array.from(new Set(candidates.map(c => c.market)));
  return { candidates, markets_present, sales_count, lettings_count, transient };
}
