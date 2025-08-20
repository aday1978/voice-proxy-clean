cat > src/index.js <<'EOF'
import express from "express";
import timeout from "connect-timeout";
import { unifiedLookup } from "./estate.js";

const app = express();
app.use(express.json());
app.use(timeout("8s"));

app.get("/healthz", (_req,res)=>{
  res.send({ ok:true, service:"voice-proxy", env:process.env.NODE_ENV||"production" });
});

// Smart route: both markets in parallel, fuzzy, price-aware.
// IMPORTANT: returns {ok:false, transient:true} on timeouts so the agent DOES NOT count it as a failure.
app.post("/tools/route_call", async (req,res)=>{
  try{
    const { street="", town="", postcode="", price="" } = req.body || {};
    if (!street || !town) return res.status(400).send({ ok:false, error:"need street and town" });

    const out = await unifiedLookup({ street, town, postcode, price });

    const properties = out.candidates.map(p=>({
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

    // if nothing and transient timeouts happened -> DON'T treat as failure, mark transient
    if (properties.length === 0 && out.transient) {
      return res.send({ ok:false, transient:true, matched:0 });
    }

    const need_market_choice = out.sales_count>0 && out.lettings_count>0;
    const price_options = Array.from(new Set(properties.map(p=>p.price).filter(Boolean))).sort((a,b)=>a-b).slice(0,4);

    res.send({
      ok:true,
      matched: properties.length,
      properties: properties.slice(0,10),
      markets_present: out.markets_present,
      need_market_choice,
      price_options
    });
  } catch(e){
    // non-transient error -> real failure
    res.status(200).send({ ok:false, transient:false, error:"lookup_failed" });
  }
});

// Strict route if you explicitly want a market filter
app.post("/tools/lookup_property", async (req,res)=>{
  try{
    const { street="", town="", postcode="", price="", market="sales" } = req.body || {};
    const out = await unifiedLookup({ street, town, postcode, price });
    const filtered = out.candidates.filter(p=>p.market===market).map(p=>({
      refId:p.refId,address:p.address,street:p.street,town:p.town,postcode:p.postcode,
      propertyTypeText:p.propertyTypeText,price:p.price,market:p.market,
      teamEmail:p.teamEmail,teamPhone:p.teamPhone,responsibleAgentName:p.responsibleAgentName
    }));
    if (filtered.length===0 && out.transient){
      return res.send({ ok:false, transient:true, matched:0 });
    }
    res.send({ ok:true, matched:filtered.length, properties:filtered.slice(0,10) });
  } catch {
    res.status(200).send({ ok:false, transient:false, error:"lookup_failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log(`listening on :${PORT}`));
EOF
