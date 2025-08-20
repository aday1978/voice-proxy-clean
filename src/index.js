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

// SMART LOOKUP for Lee (query both markets; fuzzy; price-aware)
app.post("/tools/route_call", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", price = "" } = req.body || {};
    if (!street || !town) return res.status(400).send({ ok: false, error: "need street and town" });

    const out = await unifiedLookup({ street, town, postcode, price });
    const props = out.candidates.map(p => ({
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

    // Hints for Lee
    const need_market_choice = out.sales_count > 0 && out.lettings_count > 0;
    const prices = Array.from(new Set(props.map(p => p.price).filter(Boolean))).sort((a,b) => a - b);

    res.send({
      ok: true,
      matched: props.length,
      properties: props.slice(0, 10),
      markets_present: out.markets_present,
      need_market_choice,
      price_options: prices.slice(0, 4)
    });
  } catch (e) {
    res.status(500).send({ ok: false, error: "lookup_failed" });
  }
});

// STRICT lookup when Lee knows the market
app.post("/tools/lookup_property", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", market = "sales", price = "" } = req.body || {};
    // constrain by market after unified
    const out = await unifiedLookup({ street, town, postcode, price });
    const props = out.candidates.filter(p => p.market === market).map(p => ({
      refId: p.refId, address: p.address, street: p.street, town: p.town, postcode: p.postcode,
      propertyTypeText: p.propertyTypeText, price: p.price, market: p.market,
      teamEmail: p.teamEmail, teamPhone: p.teamPhone, responsibleAgentName: p.responsibleAgentName
    }));
    res.send({ ok: true, matched: props.length, properties: props.slice(0, 10) });
  } catch {
    res.status(500).send({ ok: false, error: "lookup_failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
