// src/index.js
import express from "express";
import timeout from "connect-timeout";
import { estateConfig, buildLoopUrl, fetchLoop, filterResults, lookupProperty, lookupWithFallback } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("10s"));

app.get("/healthz", (req, res) => {
  res.send({ ok: true, service: "voice-proxy", env: process.env.NODE_ENV || "production" });
});

// Debug: show config (key redacted)
app.get("/debug/estate-config", (req, res) => {
  const cfg = estateConfig();
  res.send({
    baseUrl: cfg.baseUrl,
    keyHeader: cfg.keyHeader,
    timeout_ms: cfg.timeout_ms,
    has_key: cfg.has_key
  });
});

// Debug: call Loop raw using current env + args
app.post("/debug/loop/raw", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", market = "sales", pageSize = 50 } = req.body || {};
    const url = buildLoopUrl({ street, town, postcode, market, pageSize });
    const r = await fetchLoop(url);
    res.send({ ok: r.ok, status: r.status, url: r.url, size: r.size, sample: r.sample });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e) });
  }
});

// Tool: strict lookup (no fallback)
app.post("/tools/lookup_property", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "", market = "sales", pageSize = 50 } = req.body || {};
    const { url, filtered } = await lookupProperty({ street, town, postcode, market, pageSize });
    res.send({ ok: true, matched: filtered.length, properties: filtered, tool_success: true, source_url: url, took_ms: 0 });
  } catch (e) {
    res.status(500).send({ ok: false, matched: 0, properties: [], tool_success: false, error: "lookup_property_failed" });
  }
});

// Tool: “smart” route for Lee — tries lettings then sales
app.post("/tools/route_call", async (req, res) => {
  try {
    const { street = "", town = "", postcode = "" } = req.body || {};
    const out = await lookupWithFallback({ street, town, postcode });
    const response = {
      ok: true,
      market_used: out.market,
      matched: out.properties.length,
      properties: out.properties,
      note: out.note,
      tool_success: true,
      source_url: out.source_url
    };

    // For voice agent: if 0, ask the caller to clarify sales vs lettings
    if (out.properties.length === 0) {
      response.next_action = "ask_clarify_market";
      response.ask = `I couldn't find a lettings listing at ${street}, ${town}${postcode ? " " + postcode : ""}. Is this for sales or lettings?`;
    }

    res.send(response);
  } catch (e) {
    res.status(500).send({ ok: false, matched: 0, properties: [], tool_success: false, error: "route_call_failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
