// src/estate.js
import fetch from "node-fetch";

const BASE        = process.env.ESTATE_BASE_URL   || "https://apiv3.loop.software/api";
const KEY         = (process.env.ESTATE_API_KEY   || "").trim();
const KEY_HEADER  = process.env.ESTATE_KEY_HEADER || "x-api-key";
const TIMEOUT_MS  = Number(process.env.ESTATE_TIMEOUT_MS || 3000);
const PAGE_SIZE   = 100;

// ---------- utils ----------
const norm = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Levenshtein edit distance
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

// simple Soundex (English-ish) to catch “tilehouse” vs “tiehouse”
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

// fuzzy town: contains OR small edit distance (“colville”→“coalville”)
const closeTown = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  if (g.includes(w) || w.includes(g)) return true;
  return lev(w, g) <= 2;
};

// strong street hit: contains OR small edit distance OR phonetic match
const streetFuzzyHit = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  if (g.includes(w)) return true;
  if (lev(w, g) <= 2) return true;
  if (soundex(w) === soundex(g)) return true;
  return false;
};

// price within ±12% or ±£15k (whichever wider)
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

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { [KEY_HEADER]: KEY }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { ok: true, results: Array.isArray(data?.results) ? data.results : [] };
  } catch (e) {
    // tell the agent this is a temporary delay (fill, don't fail)
    if (String(e?.name||"").includes("Abort") || String(e?.message||"").includes("Abort") || String(e?.message||"").includes("timeout")) {
      return { ok: false, transient: true, results: [] };
    }
    return { ok: false, transient: false, results: [] };
  } finally {
    clearTimeout(t);
  }
}

// ---------- URLs ----------
const salesURL = ({ street, town, postcode }) => {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/sales-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
};
const lettingsFieldedURL = ({ street, town, postcode }) => {
  const u = new URL(`${BASE}/lettings-properties`);
  if (street)   u.searchParams.set("propertyStreet", street);
  if (town)     u.searchParams.set("propertyTown", town);
  if (postcode) u.searchParams.set("propertyPostcode", postcode);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
};
const lettingsSearchURL = ({ street, town, postcode }) => {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/lettings-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
};

// ---------- unified lookup (parallel markets, fuzzy, price-aware, town-only fallback) ----------
export async function unifiedLookup({ street = "", town = "", postcode = "", price = "" } = {}) {
  if (!KEY) throw new Error("ESTATE_API_KEY missing");

  // parallel: sales searchText + lettings (fielded + searchText)
  const [s, lf, ls] = await Promise.all([
    fetchWithTimeout(salesURL({ street, town, postcode })),
    fetchWithTimeout(lettingsFieldedURL({ street, town, postcode })),
    fetchWithTimeout(lettingsSearchURL({ street, town, postcode }))
  ]);

  const anyTransient = [s, lf, ls].some(r => r.ok === false && r.transient === true);

  const S  = s.ok  ? s.results.map(r => simplify(r, "sales"))     : [];
  const L1 = lf.ok ? lf.results.map(r => simplify(r, "lettings")) : [];
  const L2 = ls.ok ? ls.results.map(r => simplify(r, "lettings")) : [];
  const all = [...S, ...L1, ...L2];

  // dedupe by refId/address
  const seen = new Set(); const list = [];
  for (const p of all) { const k = p.refId || p.address; if (!seen.has(k)) { seen.add(k); list.push(p); } }

  // primary fuzzy: town + street + price
  const wantT = norm(town), wantS = norm(street);
  let candidates = list.filter(p =>
    (wantT ? (closeTown(wantT, p.town) || closeTown(wantT, p.address)) : true) &&
    (wantS ? (streetFuzzyHit(wantS, p.street) || streetFuzzyHit(wantS, p.address)) : true)
  );
  candidates = candidates.filter(p => priceClose(price, p.price));

  // town-only fallback ranking if nothing matched
  if (candidates.length === 0 && wantT) {
    const townOnly = list.filter(p =>
      closeTown(wantT, p.town) || closeTown(wantT, p.address)
    );
    const score = (w, g) => {
      const a = lev(w, g);
      const bonus = soundex(w) === soundex(g) ? -1 : 0; // phonetic helps
      return a + bonus;
    };
    const w = norm(street);
    candidates = townOnly
      .map(p => ({
        p,
        s: Math.min(
          score(w, norm(p.street || "")),
          score(w, norm(p.address || ""))
        )
      }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 12)
      .map(x => x.p)
      .filter(p => !w || streetFuzzyHit(w, p.street) || streetFuzzyHit(w, p.address));
    candidates = candidates.filter(p => priceClose(price, p.price));
  }

  const sales_count     = candidates.filter(c => c.market === "sales").length;
  const lettings_count  = candidates.filter(c => c.market === "lettings").length;
  const markets_present = Array.from(new Set(candidates.map(c => c.market)));

  return { candidates, markets_present, sales_count, lettings_count, transient: anyTransient };
}
