// src/estate.js
import fetch from "node-fetch";

export function estateConfig() {
  const baseUrl = process.env.ESTATE_BASE_URL || "https://apiv3.loop.software/api";
  const keyHeader = process.env.ESTATE_KEY_HEADER || "x-api-key";
  const timeout_ms = Number(process.env.ESTATE_TIMEOUT_MS || 1500);
  const apiKey = (process.env.ESTATE_API_KEY || "").trim();
  return { baseUrl, keyHeader, timeout_ms, has_key: apiKey.length > 0, apiKey };
}

export function buildLoopUrl({ market = "sales", street = "", town = "", postcode = "", pageSize = 50 } = {}) {
  const cfg = estateConfig();
  const path = market === "lettings" ? "lettings-properties" : "sales-properties";
  const u = new URL(`${cfg.baseUrl.replace(/\/$/, "")}/${path}`);

  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));

  if (market === "lettings") {
    // Lettings works best with fielded params
    if (street)   u.searchParams.set("propertyStreet", street);
    if (town)     u.searchParams.set("propertyTown", town);
    if (postcode) u.searchParams.set("propertyPostcode", postcode);
  } else {
    // Sales works great with searchText
    const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
    if (bits) u.searchParams.set("searchText", bits);
  }
  return u.toString();
}

export async function fetchLoop(url) {
  const cfg = estateConfig();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), cfg.timeout_ms);

  const r = await fetch(url, {
    method: "GET",
    headers: { [cfg.keyHeader]: cfg.apiKey },
    signal: ctrl.signal
  }).catch((e) => {
    throw new Error(`Loop fetch failed: ${e.message || e}`);
  });
  clearTimeout(to);

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Loop error ${r.status}: ${t || r.statusText}`);
  }

  const json = await r.json();
  const results = Array.isArray(json.results) ? json.results : [];
  return {
    ok: true,
    status: r.status,
    url,
    size: results.length,
    sample: results.slice(0, 2),
    results
  };
}

// strict filter by what the caller said
export function filterResults(results, { street = "", town = "", postcode = "" } = {}) {
  const s = (street || "").trim().toLowerCase();
  const t = (town || "").trim().toLowerCase();
  const p = (postcode || "").trim().toLowerCase();

  return results.filter((r) => {
    const streetOk  = s ? (r.propertyStreet || "").toLowerCase().includes(s) : true;
    const townOk    = t ? (r.propertyTown   || "").toLowerCase().includes(t) : true;
    const postOk    = p ? (r.propertyPostcode || "").toLowerCase().includes(p) : true;
    return streetOk && townOk && postOk;
  }).map((r) => ({
    refId: r.refId,
    address: r.address ||
      [r.propertyStreet, r.propertyLocality, r.propertyTown, r.propertyPostcode].filter(Boolean).join(", "),
    street: r.propertyStreet || "",
    town: r.propertyTown || "",
    postcode: r.propertyPostcode || "",
    propertyTypeText: r.propertyTypeText,
    price: r.price,
    teamEmail: r.teamEmail,
    teamPhone: r.teamPhone,
    responsibleAgentName: r.responsibleAgentName,
  }));
}

// One-shot lookup
export async function lookupProperty({ street = "", town = "", postcode = "", market = "sales", pageSize = 50 } = {}) {
  const url = buildLoopUrl({ street, town, postcode, market, pageSize });
  const res = await fetchLoop(url);
  const filtered = filterResults(res.results, { street, town, postcode });
  return { url, filtered };
}

// Try lettings, then fall back to sales if nothing found
export async function lookupWithFallback({ street = "", town = "", postcode = "" } = {}) {
  // 1) lettings strict
  const lett = await lookupProperty({ street, town, postcode, market: "lettings" });
  if (lett.filtered.length > 0) {
    return { market: "lettings", source_url: lett.url, properties: lett.filtered, note: "lettings_strict" };
  }

  // 2) sales text search
  const sales = await lookupProperty({ street, town, postcode, market: "sales" });
  if (sales.filtered.length > 0) {
    return { market: "sales", source_url: sales.url, properties: sales.filtered, note: "fallback_to_sales" };
  }

  return { market: "lettings", source_url: lett.url, properties: [], note: "no_matches" };
}
