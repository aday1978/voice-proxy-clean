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

  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(pageSize));

  if (market === "lettings") {
    if (street)   u.searchParams.set("propertyStreet", street);
    if (town)     u.searchParams.set("propertyTown", town);
    if (postcode) u.searchParams.set("propertyPostcode", postcode);
  } else {
    const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
    if (bits) u.searchParams.set("searchText", bits);
  }

  return u.toString();
}

export async function fetchLoop(url, { signal } = {}) {
  const cfg = estateConfig();
  const headers = { [cfg.keyHeader]: cfg.apiKey };
  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  const size = text.length;
  const ok = res.ok;
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok, status: res.status, size, json, sample: json?.results?.slice?.(0, 2) ?? json, url };
}

export function filterResults({ json, street = "", town = "" }) {
  const s = (street || "").trim().toLowerCase();
  const t = (town || "").trim().toLowerCase();
  const rows = Array.isArray(json?.results) ? json.results : [];

  const out = rows
    .map(r => ({
      refId: String(r.refId ?? r.salesLifecycleId ?? r.lettingsLifecycleId ?? ""),
      address: r.address || [r.propertyStreet, r.propertyLocality, r.propertyTown, r.propertyPostcode].filter(Boolean).join(", "),
      street: String(r.propertyStreet || "").trim(),
      town: String(r.propertyTown || "").trim(),
      postcode: String(r.propertyPostcode || "").trim(),
      propertyTypeText: r.propertyTypeText,
      price: r.price,
      teamEmail: r.teamEmail,
      teamPhone: r.teamPhone,
      responsibleAgentName: r.responsibleAgentName
    }))
    .filter(r =>
      r.street.toLowerCase().includes(s) &&
      r.town.toLowerCase().includes(t)
    );

  return out;
}
