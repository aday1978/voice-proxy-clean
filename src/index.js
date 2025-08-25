// src/index.js
import express from "express";
import timeout from "connect-timeout";
import { unifiedLookup } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("8s"));

app.get("/healthz", (_req, res) => {
  res.send({ ok: true, service: "voice-proxy", env: process.env.NODE_ENV || "production" });
});

// Smart route: fast-first sales (1.2s), then full parallel sales+lettings (2.5s),
// fuzzy town/street + price narrow, town-only fallback.
// Returns { ok:false, transient:true } on timeout so Lee fills instead of failing.
app.post("/tools/route_call", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", price = "" } = req.body || {};
    if (!street || !town) return res.status(400).send({ ok: false, error: "need street and town" });

    const out = await unifiedLookup({ street, town, postcode, price });

    const properties = out.candidates.map(p => ({
      refId: p.refId,
      address: p.address,
      street: p.street,
      town: p.town,
      postcode: p.postcode,
      propertyTypeText: p.propertyTypeText,
      price: p.price,
      market: p.market,
      teamEmail: p.teamEmail,
      teamPhone: p.teamPhone,
      responsibleAgentName: p.responsibleAgentName
    }));

    if (properties.length === 0 && out.transient) {
      return res.send({ ok: false, transient: true, matched: 0 });
    }

    const need_market_choice = properties.some(p => p.market === "sales") && properties.some(p => p.market === "lettings");
    const price_options = Array.from(new Set(properties.map(p => p.price).filter(Boolean)))
      .sort((a, b) => a - b)
      .slice(0, 4);

    res.send({
      ok: true,
      matched: properties.length,
      properties: properties.slice(0, 10),
      markets_present: out.markets_present,
      need_market_choice,
      price_options
    });
  } catch {
    res.status(200).send({ ok: false, transient: false, error: "lookup_failed" });
  }
});

// Strict-by-market route (optional if you still use it)
app.post("/tools/lookup_property", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", price = "", market = "sales" } = req.body || {};
    const out = await unifiedLookup({ street, town, postcode, price });
    const filtered = out.candidates
      .filter(p => p.market === market)
      .map(p => ({
        refId: p.refId,
        address: p.address,
        street: p.street,
        town: p.town,
        postcode: p.postcode,
        propertyTypeText: p.propertyTypeText,
        price: p.price,
        market: p.market,
        teamEmail: p.teamEmail,
        teamPhone: p.teamPhone,
        responsibleAgentName: p.responsibleAgentName
      }));

    if (filtered.length === 0 && out.transient) {
      return res.send({ ok: false, transient: true, matched: 0 });
    }

    res.send({ ok: true, matched: filtered.length, properties: filtered.slice(0, 10) });
  } catch {
    res.status(200).send({ ok: false, transient: false, error: "lookup_failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
