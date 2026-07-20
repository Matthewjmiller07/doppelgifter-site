import { createClient } from "jsr:@supabase/supabase-js@2";

const PRICES: Record<string, { cents: number; name: string }> = {
  mug: { cents: 2999, name: "The Ceremonial Mug" },
  tee: { cents: 3499, name: "The Monument Tee" },
  blanket: { cents: 6499, name: "The Heirloom Blanket" },
  poster: { cents: 4499, name: "The Gallery Poster" },
  deck: { cents: 2499, name: "The Parlour Deck (54 cards)" },
  cards: { cents: 2499, name: "The Parlour Deck (54 cards)" }, // homepage alias for deck
};
const DIGITAL_CENTS = 999;
const SHIPPING_CENTS = 499;
const SITE = "https://doppelgifter.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function validUrl(u: unknown): u is string {
  return typeof u === "string" && u.startsWith("https://") && u.length <= 450;
}

function cleanCode(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const s = c.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 3 && s.length <= 32 ? s : null;
}

// Looks up an active promotion code and returns {id, amount_off_cents}
async function lookupPromo(sk: string, code: string) {
  const res = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&active=true&limit=1`,
    { headers: { Authorization: `Bearer ${sk}` } },
  );
  const out = await res.json();
  const pc = out?.data?.[0];
  if (!pc) return null;
  const amountOff = pc.coupon?.amount_off ?? 0;
  const percentOff = pc.coupon?.percent_off ?? null;
  return { id: pc.id, code: pc.code, amountOff, percentOff };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (typeof body.lookup_session_id === "string" && body.lookup_session_id.startsWith("cs_")) {
    const { data: order } = await supabase
      .from("dg_orders")
      .select("product, style, preview_url, status")
      .eq("stripe_session_id", body.lookup_session_id.slice(0, 120))
      .single();
    if (!order) return json({ error: "Unknown order" }, 404);
    return json(order);
  }

  const { data: sk, error: skErr } = await supabase.rpc("dg_get_secret", {
    secret_name: "STRIPE_SECRET_KEY",
  });
  if (skErr || !sk) return json({ error: "Server configuration error" }, 500);

  // ---- validate a promo code without starting checkout ----
  if (body.action === "check_promo") {
    const code = cleanCode(body.promo);
    if (!code) return json({ valid: false, error: "Enter a code" }, 200);
    const promo = await lookupPromo(sk, code);
    if (!promo) {
      return json({ valid: false, error: "That code means nothing to the atelier." }, 200);
    }
    return json({
      valid: true,
      code: promo.code,
      amount_off: promo.amountOff / 100,
      percent_off: promo.percentOff,
    });
  }

  const { style, product, art_url, preview_url, email, session_key, utm } = body;
  const digital = body.digital === true;
  if (!PRICES[product]) return json({ error: "Unknown product" }, 400);
  if (!validUrl(art_url)) {
    return json({ error: "Missing or invalid art_url - render a preview first" }, 400);
  }

  const code = cleanCode(body.promo);
  let promo: Awaited<ReturnType<typeof lookupPromo>> = null;
  if (code) {
    promo = await lookupPromo(sk, code);
    if (!promo) return json({ error: "That code means nothing to the atelier." }, 400);
  }

  const { data: order, error: orderErr } = await supabase
    .from("dg_orders")
    .insert({
      style: String(style ?? "unknown"),
      product,
      price_cents: PRICES[product].cents + (digital ? DIGITAL_CENTS : 0) -
        (promo?.amountOff ?? 0),
      status: "pending",
      preview_url: validUrl(preview_url) ? preview_url : art_url,
      print_url: art_url,
      email: email ?? null,
    })
    .select()
    .single();
  if (orderErr) return json({ error: "Could not create order" }, 500);

  const displayImage = validUrl(preview_url) ? preview_url : art_url;
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("client_reference_id", order.id);
  p.set("success_url", SITE + "/?order=success&sid={CHECKOUT_SESSION_ID}");
  p.set("cancel_url", SITE + "/?order=cancelled");
  p.set("line_items[0][quantity]", "1");
  p.set("line_items[0][price_data][currency]", "usd");
  p.set("line_items[0][price_data][unit_amount]", String(PRICES[product].cents));
  p.set(
    "line_items[0][price_data][product_data][name]",
    PRICES[product].name + " — " + String(style ?? "Custom"),
  );
  p.set("line_items[0][price_data][product_data][images][0]", displayImage);
  if (digital) {
    p.set("line_items[1][quantity]", "1");
    p.set("line_items[1][price_data][currency]", "usd");
    p.set("line_items[1][price_data][unit_amount]", String(DIGITAL_CENTS));
    p.set("line_items[1][price_data][product_data][name]", "Digital Masterpiece Download (full resolution)");
  }
  // A pre-applied code and Stripe's own promo field are mutually exclusive.
  if (promo) {
    p.set("discounts[0][promotion_code]", promo.id);
    p.set("metadata[promo]", promo.code);
  } else {
    p.set("allow_promotion_codes", "true");
  }
  p.set("shipping_address_collection[allowed_countries][0]", "US");
  p.set("shipping_options[0][shipping_rate_data][display_name]", "Standard shipping");
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(SHIPPING_CENTS));
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
  p.set("metadata[order_id]", order.id);
  p.set("metadata[product]", product);
  p.set("metadata[style]", String(style ?? ""));
  p.set("metadata[art_url]", art_url);
  if (digital) p.set("metadata[digital]", "1");
  if (validUrl(preview_url)) p.set("metadata[preview_url]", preview_url);
  if (typeof session_key === "string" && session_key.length <= 64) {
    p.set("metadata[session_key]", session_key);
  }
  if (typeof utm === "string" && utm.length > 0) {
    p.set("metadata[utm]", utm.slice(0, 450));
  }
  if (email) p.set("customer_email", email);

  const encoded = p.toString().replace(/%7BCHECKOUT_SESSION_ID%7D/g, "{CHECKOUT_SESSION_ID}");

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sk}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encoded,
  });
  const session = await res.json();
  if (!res.ok) {
    await supabase.from("dg_orders").update({ status: "failed" }).eq("id", order.id);
    return json({ error: session.error?.message ?? "Stripe error" }, 500);
  }
  await supabase
    .from("dg_orders")
    .update({ stripe_session_id: session.id })
    .eq("id", order.id);
  return json({ url: session.url, order_id: order.id });
});
