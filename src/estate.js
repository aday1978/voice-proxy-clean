cat > src/estate.js <<'EOF'
// src/estate.js
import fetch from "node-fetch";

const BASE = process.env.ESTATE_BASE_URL || "https://apiv3.loop.software/api";
const KEY  = (process.env.ESTATE_API_KEY || "").trim();
const KEY_HEADER = process.env.ESTATE_KEY_HEADER || "x-api-key";
const TIMEOUT_MS = Number(process.env.ESTATE_TIMEOUT_MS || 3000);
const PAGE_SIZE  = 100;

// ---------- utils ----------
function norm(s){ return (s||"").toString().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim(); }
function lev(a,b){ a=norm(a); b=norm(b); const m=Array.from({length:a.length+1},(_,i)=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) m[i][0]=i; for(let j=0;j<=b.length;j++) m[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    m[i][j]=Math.min(m[i-1][j]+1,m[i][j-1]+1,m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return m[a.length][b.length];
}
const closeTown = (want, got)=>{ const w=norm(want), g=norm(got); if(!w||!g) return false; if(g.includes(w)||w.includes(g)) return true; return lev(w,g)<=2; };
const streetMatch = (want, got)=>{ const w=norm(want), g=norm(got); return !!w && !!g && g.includes(w); };
const priceClose = (want, got)=>{ if(!want||!got) return true; const w=+String(want).replace(/[^\d]/g,"")||0; const g=+String(got).replace(/[^\d]/g,"")||0; if(!w||!g) return true; const band=Math.max(w*0.12,15000); return Math.abs(w-g)<=band; };

function simplify(r, market){
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

async function fetchWithTimeout(url){
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try{
    const res = await fetch(url, { headers: { [KEY_HEADER]: KEY }, signal: controller.signal });
    if(!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json().catch(()=>({}));
    const results = Array.isArray(data?.results) ? data.results : [];
    return { ok:true, results };
  } catch (e){
    // On timeout or fetch error we mark as transient so the agent DOESN'T count it as a failure
    if (String(e?.name||"").includes("Abort") || String(e?.message||"").includes("Abort") || String(e?.message||"").includes("timeout")) {
      return { ok:false, transient:true, results:[] };
    }
    // non-transient error (e.g., 401/400)
    return { ok:false, transient:false, results:[] };
  } finally { clearTimeout(t); }
}

function salesURL({street,town,postcode}){
  const bits = [street,town,postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/sales-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}
function lettingsFieldedURL({street,town,postcode}){
  const u = new URL(`${BASE}/lettings-properties`);
  if (street)   u.searchParams.set("propertyStreet", street);
  if (town)     u.searchParams.set("propertyTown", town);
  if (postcode) u.searchParams.set("propertyPostcode", postcode);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}
function lettingsSearchURL({street,town,postcode}){
  const bits = [street,town,postcode].filter(Boolean).join(" ").trim();
  const u = new URL(`${BASE}/lettings-properties`);
  if (bits) u.searchParams.set("searchText", bits);
  u.searchParams.set("marketingStatus", "OnMarket");
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  return u.toString();
}

export async function unifiedLookup({ street="", town="", postcode="", price="" } = {}){
  if (!KEY) throw new Error("ESTATE_API_KEY missing");

  const [ s, lf, ls ] = await Promise.all([
    fetchWithTimeout(salesURL({street,town,postcode})),
    fetchWithTimeout(lettingsFieldedURL({street,town,postcode})),
    fetchWithTimeout(lettingsSearchURL({street,town,postcode}))
  ]);

  const anyTransient = [s,lf,ls].some(r => r.ok===false && r.transient===true);

  const S  = s.ok  ? s.results.map(r=>simplify(r,"sales"))     : [];
  const L1 = lf.ok ? lf.results.map(r=>simplify(r,"lettings")) : [];
  const L2 = ls.ok ? ls.results.map(r=>simplify(r,"lettings")) : [];
  const all = [...S, ...L1, ...L2];

  // dedupe by refId/address
  const out=[]; const seen=new Set();
  for(const p of all){ const k = p.refId || p.address; if(!seen.has(k)){ seen.add(k); out.push(p); } }

  // fuzzy street/town + price narrow
  const wantT = norm(town), wantS = norm(street);
  let candidates = out.filter(p =>
    (wantT ? (closeTown(wantT, p.town) || closeTown(wantT, p.address)) : true) &&
    (wantS ? (streetMatch(wantS, p.street) || streetMatch(wantS, p.address)) : true)
  );
  candidates = candidates.filter(p => priceClose(price, p.price));

  const sales_count    = candidates.filter(c=>c.market==="sales").length;
  const lettings_count = candidates.filter(c=>c.market==="lettings").length;
  const markets_present = Array.from(new Set(candidates.map(c=>c.market)));

  return { candidates, markets_present, sales_count, lettings_count, transient:anyTransient };
}
EOF
