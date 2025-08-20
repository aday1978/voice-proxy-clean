// src/estate.js
import fetch from "node-fetch";

const BASE = process.env.ESTATE_BASE_URL || "https://apiv3.loop.software/api";
const KEY  = (process.env.ESTATE_API_KEY || "").trim();
const KEY_HEADER = process.env.ESTATE_KEY_HEADER || "x-api-key";
const TIMEOUT_MS = Number(process.env.ESTATE_TIMEOUT_MS || 3000);
const PAGE_SIZE  = 100;

// ---------- helpers ----------
function withTimeout(promise, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return {
    run: (url, opts = {}) =>
      fetch(url, { ...opts, signal: ctrl.signal })
        .finally(() => clearTimeout(t)),
    ctrl
  };
}

function norm(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// tiny Levenshtein for single-word fuzz
function lev(a, b) {
  a = norm(a); b = norm(b);
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
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
}
const closeTown = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  if (g.includes(w) || w.includes(g)) return true;
  return lev(w, g) <= 2; // handles colville -> coalville
};
const streetMatch = (want, got) => {
  const w = norm(want), g = norm(got);
  if (!w || !g) return false;
  return g.includes(w); // “station road” in “station road”
};

// price within ±12% or ±£15k (whichever wider)
const priceClose = (want, got) => {
  if (!want || !got) return true;
  const w = Number(String(want).replace(/[^\d]/g, "")) || 0;
  const g = Number(String(got).replace(/[^\d]/g, "")) || 0;
  if (!w || !g) return true;
  const band = Math.max(w * 0.12, 15000);
  return Math.abs(w - g) <= band;
};

function simplify(r, market) {
  return {
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
  };
}

async function fetchJSON(url) {
  const { run } = withTimeout();
  const res = await run(url, { headers: { [KEY_HEADER]: KEY } });
  if (!res.ok) throw new Error(`Loop ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.results) ? data.results : [];
}

// ---------- build URLs ----------
function salesURL({ street, town, postcode }) {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/sales-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}
function lettingsFieldedURL({ street, town, postcode }) {
  const u = new URL(`${BASE}/lettings-properties`);
  if (street)   u.searchParams.set("propertyStreet", street);
  if (town)     u.searchParams.set("propertyTown", town);
  if (postcode) u.searchParams.set("propertyPostcode", postcode);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}
function lettingsSearchURL({ street, town, postcode }) {
  const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/lettings-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}

// ---------- unified lookup ----------
export async function unifiedLookup({ street = "", town = "", postcode = "", price = "" } = {}) {
  if (!KEY) throw new Error("ESTATE_API_KEY missing");

  // parallel: sales (searchText), lettings (fielded + searchText)
  const [sales, letsFielded, letsText] = await Promise.allSettled([
    fetchJSON(salesURL({ street, town, postcode })),
    fetchJSON(lettingsFieldedURL({ street, town, postcode })),
    fetchJSON(lettingsSearchURL({ street, town, postcode })),
  ]);

  const S = sales.status === "fulfilled" ? sales.value.map(r => simplify(r, "sales")) : [];
  const L1 = letsFielded.status === "fulfilled" ? letsFielded.value.map(r => simplify(r, "lettings")) : [];
  const L2 = letsText.status === "fulfilled" ? letsText.value.map(r => simplify(r, "lettings")) : [];
  const L = [...L1, ...L2];

  // normalize + dedupe
  const seen = new Set();
  const all = [...S, ...L].filter(x => {
    const k = x.refId || x.address;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // fuzzy filter by town + street
  const townWanted = norm(town);
  const streetWanted = norm(street);
  let candidates = all.filter(r =>
    (townWanted ? (closeTown(townWanted, r.town) || closeTown(townWanted, r.address)) : true) &&
    (streetWanted ? (streetMatch(streetWanted, r.street) || streetMatch(streetWanted, r.address)) : true)
  );

  // narrow by price if provided
  candidates = candidates.filter(r => priceClose(price, r.price));

  const markets = Array.from(new Set(candidates.map(c => c.market)));
  return {
    candidates,
    markets_present: markets,
    sales_count: candidates.filter(c => c.market === "sales").length,
    lettings_count: candidates.filter(c => c.market === "lettings").length
  };
}
