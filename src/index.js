// src/index.js — complete replacement

import Fastify from "fastify";
import {
  estateConfig,
  buildLoopUrl,
  fetchLoopRaw,
  lookupProperty,
} from "./estate.js";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({
  ok: true,
  service: "voice-proxy",
  env: process.env.NODE_ENV || "dev",
}));

app.get("/debug/estate-config", async () => estateConfig);

app.post("/debug/loop/raw", async (req) => {
  const body = (req.body || {});
  const res = await fetchLoopRaw({
    market: body.market || "sales",
    street: body.street || "",
    town: body.town || "",
    postcode: body.postcode || "",
    marketingStatus: body.marketingStatus || "OnMarket",
  });
  return res;
});

app.post("/tools/lookup_property", async (req) => {
  const body = (req.body || {});
  const res = await lookupProperty({
    market: body.market || "sales",
    street: body.street || "",
    town: body.town || "",
    postcode: body.postcode || "",
    marketingStatus: body.marketingStatus || "OnMarket",
  });
  return res;
});

const port = Number(process.env.PORT || 8080);
const host = "0.0.0.0";

app.listen({ port, host })
  .then(() => {
    app.log.info(`listening on :${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
