// src/estate.js  — complete replacement

export const estateConfig = {
  baseUrl: "https://apiv3.loop.software/api",
  keyHeader: "x-api-key",
  timeout_ms: 1500,
  has_key: Boolean(process.env.ESTATE_API_KEY),
};

/**
 * Build the Loop URL for sales/lettings.
 * Sales: use searchText "<street> <town> <postcode>"
 * Lettings: use fielded filters (street/town/postcode) to avoid noisy results.
 */
export function buildLoopUrl(args = {}) {
  const {
    market = "sales",         // "sales" | "lettings"
    street = "",
    town = "",
    postcode = "",
    marketingStatus = "OnMarket",
    pageSize = 50,
  } = args;

  const path = market === "lettings" ? "lettings-properties" : "sales-properties";
  const u = new URL(`${estateConfig.baseUrl}/${path}`);

  // Preferred approach from your testing:
  if (market === "lettings") {
    // Fielded params keep results tight for lettings
    if (street)   u.searchParams.set("propertyStreet", street);
    if (town)     u.searchParams.set("propertyTown", town);
    if (postcode) u.searchParams.set("propertyPostcode", postcode);
  } else {
    // Sales: searchText works best (you already saw the perfect 2 matches)
    const bits = [street, town, postcode].filter(Boolean).join(" ").trim();
    if (bits) u.searchParams.set("searchText", bits);
  }

  if (marketingStatus) u.searchParams.set("marketingStatus", marketingStatus);
  u.searchParams.set("pageSize", String(pageSize));

  return u.toString();
}

async function doFetch(url) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), estateConfig.timeout_ms);

  const headers = {};
  if (process.env.ESTATE_API_KEY) {
    headers[estateConfig.keyHeader] = process.env.ESTATE_API_KEY;
  }

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const status = res.status;
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // non-JSON response
    }
    return { status, data };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Fetch Loop raw for debugging (shows status, sample)
 */
export async function fetchLoopRaw(args = {}) {
  const url = buildLoopUrl(args);
  const { status, data } = await doFetch(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    size: results.length,
    sample: results.slice(0, 2),
  };
}

/**
 * Normalize a loop property record down to what you need
 */
function shapeProperty(p) {
  return {
    refId: p.refId,
    address: p.address,
    street: p.propertyStreet ?? "",
    town: p.propertyTown ?? "",
    postcode: p.propertyPostcode ?? "",
    propertyTypeText: p.propertyTypeText,
    price: p.price,
    teamEmail: p.teamEmail,
    teamPhone: p.teamPhone,
    responsibleAgentName: p.responsibleAgentName,
  };
}

/**
 * Extra local filtering to keep only real matches
 */
function strictMatch(list, { street = "", town = "", postcode = "" }) {
  const s = street.trim().toLowerCase();
  const t = town.trim().toLowerCase();
  const pc = postcode.trim().toLowerCase();

  return list.filter((p) => {
    const ps = (p.propertyStreet ?? "").trim().toLowerCase();
    const pt = (p.propertyTown ?? "").trim().toLowerCase();
    const ppc = (p.propertyPostcode ?? "").trim().toLowerCase();

    const streetOk = s ? ps.includes(s) : true;
    const townOk   = t ? pt.includes(t) : true;
    const pcOk     = pc ? ppc.startsWith(pc) : true;

    return streetOk && townOk && pcOk;
  });
}

/**
 * Tool: lookup_property
 */
export async function lookupProperty(args = {}) {
  const url = buildLoopUrl(args);
  const { status, data } = await doFetch(url);

  if (!(status >= 200 && status < 300)) {
    return {
      ok: false,
      matched: 0,
      tool_success: false,
      source_url: url,
      http_status: status,
    };
  }

  let results = Array.isArray(data?.results) ? data.results : [];
  // Final tightening — especially useful for lettings
  results = strictMatch(results, args);

  return {
    ok: true,
    matched: results.length,
    properties: results.slice(0, 50).map(shapeProperty),
    tool_success: true,
    source_url: url,
  };
}
