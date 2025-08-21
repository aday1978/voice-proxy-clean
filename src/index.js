// src/index.js
import express from "express";
import timeout from "connect-timeout";
import { estateConfig, buildLoopUrl, fetchLoop, filterResults } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("10s"));

app.get("/healthz", (req, res) => {
  res.send({ ok: true, service: "voice-proxy", env: process.env.NODE_ENV || "production" });
});

// DEBUG: show effective config
app.get("/debug/estate-config", (req, res) => {
  const cfg = estateConfig();
  res.send({
    baseUrl: cfg.baseUrl,
    keyHeader: cfg.keyHeader,
    timeout_ms: cfg.timeout_ms,
    has_key: cfg.has_key
  });
});

// DEBUG: raw Loop call
app.post("/debug/loop/raw", async (req, res) => {
  const { street = "", town = "", postcode = "", market = "sales", pageSize = 50 } = req.body || {};
  const url = buildLoopUrl({ street, town, postcode, market, pageSize });
  try {
    const r = await fetchLoop(url);
    res.send({ ok: r.ok, status: r.status, url: r.url, size: r.size, sample: r.sample });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e) });
  }
});

// TOOL: lookup property
app.post("/tools/lookup_property", async (req, res) => {
  const { street = "", town = "", postcode = "", market = "sales" } = req.body || {};
  const url = buildLoopUrl({ street, town, postcode, market });
  try {
    const r = await fetchLoop(url);
    if (!r.ok) {
      return res.status(500).send({ ok: false, tool_success: false, source_url: r.url, http_status: r.status });
    }
    const filtered = filterResults(r.sample, { street, town });
    res.send({ ok: true, matched: filtered.length, properties: filtered, tool_success: true, source_url: r.url, took_ms: 0 });
  } catch (e) {
    res.status(500).send({ ok: false, tool_success: false, error: "lookup_property_failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
