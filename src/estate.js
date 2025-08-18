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

  // Always constrain to “OnMarket” and page size
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));

  if (market === "lettings") {
    // Lettings: fielded params only (Loop is strict here)
    if (street)   u.searchParams.set("propertyStreet", street);
    if (town)     u.searchParams.set("propertyTown", town);
    if (postcode) u.searchParams.set("propertyPostcode", postcode);
  } else {
    // Sales: searchText works best (and can still include postcode)
    const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
    if (bits) u.searchParams.set("searchText", bits);
  }
  return u.toString();
}

export async function fetchLoop(url) {
  const cfg = estateConfig();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), cfg.timeout_ms);

  const res = await fetch(url, {
    headers: { [cfg.keyHeader]: cfg.apiKey },
    signal: controller.signal
  }).catch(err => ({ ok: false, status: 500, err }));

  clearTimeout(id);

  if (!res || !res.ok) {
    const status = res?.status ?? 500;
    const text = res?.statusText ?? "Fetch failed";
    throw new Error(`Loop error ${status}: ${text}`);
  }

  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];
  return {
    ok: true,
    status: res.status,
    url,
    size: results.length,
    sample: results.slice(0, 2),
    results
  };
}

export function filterResults(results = [], { street = "", town = "" } = {}) {
  const s = street.toLowerCase();
  const t = town.toLowerCase();

  return results
    .filter(r =>
      (!s || (r.propertyStreet || "").toLowerCase().includes(s)) &&
      (!t || (r.propertyTown || "").toLowerCase().includes(t))
    )
    .map(r => ({
      refId: r.refId,
      address: r.address,
      street: r.propertyStreet,
      town: r.propertyTown,
      postcode: r.propertyPostcode,
      propertyTypeText: r.propertyTypeText,
      price: r.price,
      teamEmail: r.teamEmail,
      teamPhone: r.teamPhone,
      responsibleAgentName: r.responsibleAgentName
    }));
}
