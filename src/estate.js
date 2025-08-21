// src/estate.js
import fetch from "node-fetch";

export function estateConfig() {
  const baseUrl = process.env.ESTATE_BASE_URL || "https://apiv3.loop.software/api";
  const keyHeader = process.env.ESTATE_KEY_HEADER || "x-api-key";
  const timeout_ms = Number(process.env.ESTATE_TIMEOUT_MS || 1500);
  const apiKey = (process.env.ESTATE_API_KEY || "").trim();
  return {
    baseUrl,
    keyHeader,
    timeout_ms,
    has_key: apiKey.length > 0,
    apiKey
  };
}

export function buildLoopUrl({ market = "sales", street = "", town = "", postcode = "", pageSize = 50 } = {}) {
  const cfg = estateConfig();
  const path = market === "lettings" ? "lettings-properties" : "sales-properties";
  const u = new URL(`${cfg.baseUrl.replace(/\/$/, "")}/${path}`);

  // Always filter OnMarket only
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));

  if (market === "lettings") {
    // Lettings: stricter API, use fielded params
    if (street)   u.searchParams.set("propertyStreet", street);
    if (town)     u.searchParams.set("propertyTown", town);
    if (postcode) u.searchParams.set("propertyPostcode", postcode);
  } else {
    // Sales: use searchText for fuzzier match
    const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
    if (bits) u.searchParams.set("searchText", bits);
  }

  return u.toString();
}

export async function fetchLoop(url) {
  const cfg = estateConfig();
  const headers = {};
  if (cfg.has_key) headers[cfg.keyHeader] = cfg.apiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms);

  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { ok: r.ok, status: r.status, url: r.url || url, size: text.length, sample: json };
  } finally {
    clearTimeout(timeout);
  }
}

export function filterResults(json, { street = "", town = "" } = {}) {
  const s = (street || "").toLowerCase();
  const t = (town || "").toLowerCase();
  const rows = Array.isArray(json?.results) ? json.results : [];
  const filtered = rows.filter(r => {
    const addr = [
      r.propertyStreet || "",
      r.propertyTown || "",
      r.propertyPostcode || ""
    ].join(" ").toLowerCase();
    return (!s || addr.includes(s)) && (!t || addr.includes(t));
  });

  return filtered.map(r => ({
    refId: r.refId,
    address: r.address || [r.propertyStreet, r.propertyTown, r.propertyPostcode].filter(Boolean).join(", "),
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
