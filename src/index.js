// src/index.js
import express from "express";
import timeout from "connect-timeout";
import nodemailer from "nodemailer";
import { unifiedLookup } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("8s"));

app.get("/healthz", (_req, res) => {
  res.send({ ok: true, service: "voice-proxy", env: process.env.NODE_ENV || "production" });
});

// ---------- SMART LOOKUP (fast-first + full) ----------
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
      // temporary delay; agent should fill the air and retry
      return res.send({ ok: false, transient: true, matched: 0 });
    }

    const need_market_choice =
      properties.some(p => p.market === "sales") && properties.some(p => p.market === "lettings");

    const price_options = Array.from(new Set(properties.map(p => p.price).filter(Boolean)))
      .sort((a, b) => a - b)
      .slice(0, 4);

    res.send({
      ok: true,
      matched: properties.length,
      properties: properties.slice(0, 10),
      markets_present: Array.from(new Set(properties.map(p => p.market))),
      need_market_choice,
      price_options
    });
  } catch {
    res.status(200).send({ ok: false, transient: false, error: "lookup_failed" });
  }
});

// ---------- STRICT LOOKUP (optional if you still need it) ----------
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

// ---------- EMAIL SENDER (SendGrid via Nodemailer) ----------
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;

/**
 * POST /tools/send_lead
 * Body:
 * {
 *   refId, address, responsibleAgentName, teamEmail,
 *   caller_name, caller_phone, caller_email,
 *   preferred_times, notes, summary, transcript
 * }
 * FORCE_LEAD_EMAIL_TO (env) overrides teamEmail during testing.
 */
app.post("/tools/send_lead", async (req, res) => {
  try {
    const b = req.body || {};
    const to = (process.env.FORCE_LEAD_EMAIL_TO || b.teamEmail || "").trim();
    if (!to) return res.status(400).send({ ok: false, error: "missing_team_email" });
    if (!b.refId || !b.address || !b.caller_name || !b.caller_phone) {
      return res.status(400).send({ ok: false, error: "missing_required_fields" });
    }
    if (!mailer) return res.status(500).send({ ok: false, error: "mailer_not_configured" });

    const from = (process.env.LEAD_FROM_EMAIL || process.env.SMTP_USER || "").trim();
    const subject = `[PROPERTY ENQUIRY] ${b.address} (Ref ${b.refId})`;

    const safe = (x) =>
      String(x || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const html = `
      <h2>New property enquiry</h2>
      <p><b>Property:</b> ${safe(b.address)} (Ref ${safe(b.refId)})</p>
      <p><b>Agent:</b> ${safe(b.responsibleAgentName || "")}</p>
      <hr>
      <p><b>Caller:</b> ${safe(b.caller_name)}</p>
      <p><b>Phone:</b> ${safe(b.caller_phone)}</p>
      <p><b>Email:</b> ${safe(b.caller_email || "")}</p>
      ${b.preferred_times ? `<p><b>Preferred time(s):</b> ${safe(b.preferred_times)}</p>` : ""}
      ${b.notes ? `<p><b>Notes:</b><br>${safe(b.notes)}</p>` : ""}
      ${b.summary ? `<p><b>Summary:</b><br>${safe(b.summary)}</p>` : ""}
      ${b.transcript ? `<details><summary>Full transcript</summary><pre style="white-space:pre-wrap">${safe(b.transcript)}</pre></details>` : ""}
      <hr>
      <small>Sent by Lee (voice agent)</small>
    `;

    await mailer.sendMail({ from, to, subject, html });
    res.send({ ok: true, emailed_to: to });
  } catch (e) {
    console.error("send_lead_failed:", e?.message || e);
    res.status(500).send({ ok: false, error: "send_lead_failed", reason: String(e?.message || e) });
  }
});

// ---------- TEMP DEBUG (remove later) ----------
app.get("/debug/email-config", (_req, res) => {
  res.send({
    has_mailer: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT || 0),
    from: process.env.LEAD_FROM_EMAIL || null,
    force_to: process.env.FORCE_LEAD_EMAIL_TO || null
  });
});

app.get("/debug/email-verify", async (_req, res) => {
  try {
    if (!mailer) return res.status(500).send({ ok:false, error:"mailer_not_configured" });
    await mailer.verify();
    res.send({ ok:true });
  } catch (e) {
    res.status(500).send({ ok:false, error:String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
