// src/index.js
import express from "express";
import timeout from "connect-timeout";
import { estateConfig, buildLoopUrl, fetchLoop, filterResults } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("10s"));

// Health
app.get("/healthz", (_req, res) => {
  res.send({ ok: true, service: "voice-proxy", env: process.env.NODE_ENV || "production" });
});

// Debug: show effective estate config (without leaking the key)
app.get("/debug/estate-config", (_req, res) => {
  const cfg = estateConfig();
  res.send({
    baseUrl: cfg.baseUrl,
    keyHeader: cfg.keyHeader,
    timeout_ms: cfg.timeout_ms,
    has_key: cfg.has_key
  });
});

// Debug: call Loop directly with your inputs (no filtering)
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

// Tool used by your AI agent
app.post("/tools/lookup_property", async (req, res) => {
  const started = Date.now();
  try {
    const { street = "", town = "", postcode = "", market = "sales", pageSize = 50 } = req.body || {};
    const url = buildLoopUrl({ street, town, postcode, market, pageSize });

    const r = await fetchLoop(url);
    const properties = filterResults(r.results, { street, town });

    res.send({
      ok: true,
      matched: properties.length,
      properties,
      tool_success: true,
      source_url: r.url,
      took_ms: Date.now() - started
    });
  } catch (e) {
    res.status(500).send({
      ok: false,
      matched: 0,
      properties: [],
      tool_success: false,
      error: "lookup_property_failed",
      took_ms: Date.now() - started
    });
  }
});

// Version/debug info to confirm deployed code version
app.get("/debug/version", (_req, res) => {
  res.send({
    env: process.env.NODE_ENV || "production",
    commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || "unknown"
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
