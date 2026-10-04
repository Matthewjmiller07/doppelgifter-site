import { createClient } from "jsr:@supabase/supabase-js@2";

const PRICES: Record<string, { cents: number; name: string }> = {
  mug: { cents: 2999, name: "The Ceremonial Mug" },
  tee: { cents: 3499, name: "The Monument Tee" },
  blanket: { cents: 6499, name: "The Heirloom Blanket" },
  poster: { cents: 4499, name: "The Gallery Poster" },
  deck: { cents: 3999, name: "The Parlour Deck (54 cards)" },
  cards: { cents: 3999, name: "The Parlour Deck (54 cards)" }, // homepage alias for deck
  // Wall art + cases, offered in both flows. mg_framed is fulfilled by Prodigi
  // (dg-prodigi-order); mg_print and mg_case by Printify (dg-webhook).
  mg_print: { cents: 4400, name: "The Collector's Print (12×16 fine art)" },
  mg_framed: { cents: 11900, name: "The Gallery Frame (12×16, matted)" },
  mg_case: { cents: 3900, name: "The Pocket Shrine (tough phone case)" },
};
// Names used when the art is micrography (scripture.html / The Scribe style)
const SCRIPTURE_NAMES: Record<string, string> = {
  mg_print: "The Scribe's Print (12×16 fine art)",
  mg_framed: "The Illuminated Frame (12×16, matted)",
  mg_case: "The Pocket Psalter (tough phone case)",
};
// Allowed variants per micrography product; must match MG_PRODUCTS in dg-prodigi-order.
const MG_VARIANTS: Record<string, string[]> = {
  mg_print: ["standard"],
  mg_framed: ["black", "natural", "white", "gold"],
  mg_case: ["ip15", "ip16", "ip17", "s24"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Products whose fulfillment renders a full personalized deck after purchase (see dg-webhook).
const DECK_PRODUCTS = new Set(["deck", "cards"]);
const DIGITAL_CENTS = 999;
const SHIPPING_CENTS = 499;
const SITE = "https://doppelgifter.com";
const MAX_PHOTO_B64 = 2_500_000; // matches dg-render's cap

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

// Stores a client-supplied "photo" data URL (data:image/...;base64,....) in the dg-art
// bucket so the webhook can render the full personalized deck after payment clears.
// Returns a public https URL, or null if the input isn't a well-formed small data URL.
async function persistDataUrl(supabase: any, dataUrl: string, orderId: string): Promise<string | null> {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1] === "jpg" ? "jpeg" : m[1];
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const path = `${orderId}/source-photo.${ext}`;
  const { error } = await supabase.storage
    .from("dg-art")
    .upload(path, bytes, { contentType: `image/${ext}`, upsert: true });
  if (error) return null;
  return supabase.storage.from("dg-art").getPublicUrl(path).data.publicUrl;
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

  // Order id is an unguessable UUID handed back only to the buyer's own browser
  // (checkout response / confirmation email), so this is safe without a login,
  // same trust model as the stripe_session_id lookup above.
  if (typeof body.lookup_order_id === "string") {
    const { data: order } = await supabase
      .from("dg_orders")
      .select("product, style, preview_url, status, deck_status, deck_art, created_at")
      .eq("id", body.lookup_order_id.slice(0, 64))
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

  const { style, product, art_url, preview_url, email, session_key, utm, photo } = body;
  const digital = body.digital === true;
  const artStyle = typeof body.art_style === "string" && /^[a-z]{1,20}$/.test(body.art_style)
    ? body.art_style
    : "renaissance";
  const aboutText = typeof body.about === "string" ? body.about.trim().slice(0, 500) : null;
  if (!PRICES[product]) return json({ error: "Unknown product" }, 400);
  if (!validUrl(art_url)) {
    return json({ error: "Missing or invalid art_url - render a preview first" }, 400);
  }
  const isMg = product in MG_VARIANTS;
  const variant = isMg && MG_VARIANTS[product].includes(body.variant) ? String(body.variant) : null;
  const draftId = typeof body.draft_id === "string" && UUID.test(body.draft_id) ? body.draft_id : null;
  if (isMg) {
    // The print file must be art we stored (dg-render / dg-mg-draft), not an arbitrary URL.
    const artPrefix = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/dg-art/`;
    if (!variant) return json({ error: "Pick a size / model first" }, 400);
    if (!art_url.startsWith(artPrefix)) return json({ error: "Invalid artwork" }, 400);
  }
  if (DECK_PRODUCTS.has(product) && typeof photo === "string" && photo.length > MAX_PHOTO_B64) {
    return json({ error: "Photo too large - resize to 1024px first" }, 400);
  }

  const code = cleanCode(body.promo);
  let promo: Awaited<ReturnType<typeof lookupPromo>> = null;
  if (code) {
    promo = await lookupPromo(sk, code);
    if (!promo) return json({ error: "That code means nothing to the atelier." }, 400);
  }

  const baseCents = PRICES[product].cents + (digital ? DIGITAL_CENTS : 0);
  const discountedCents = promo
    ? promo.percentOff
      ? Math.round(baseCents * (1 - promo.percentOff / 100))
      : Math.max(0, baseCents - promo.amountOff)
    : baseCents;

  const { data: order, error: orderErr } = await supabase
    .from("dg_orders")
    .insert({
      style: String(style ?? "unknown"),
      art_style: artStyle,
      about_text: aboutText,
      product,
      price_cents: discountedCents,
      promo_code: promo?.code ?? null,
      status: "pending",
      preview_url: validUrl(preview_url) ? preview_url : art_url,
      print_url: art_url,
      email: email ?? null,
      variant,
    })
    .select()
    .single();
  if (orderErr) return json({ error: "Could not create order" }, 500);

  // Full-deck rendering (see dg-webhook) needs the buyer's actual face photo, not
  // just the one preview render. Stash it now; the webhook picks it up after payment.
  if (DECK_PRODUCTS.has(product) && typeof photo === "string" && photo.startsWith("data:image/")) {
    const sourceUrl = await persistDataUrl(supabase, photo, order.id);
    if (sourceUrl) {
      await supabase.from("dg_orders").update({ source_photo_url: sourceUrl }).eq("id", order.id);
    }
  }

  const displayImage = validUrl(preview_url) ? preview_url : art_url;
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("client_reference_id", order.id);
  const returnPage = isMg && draftId ? `/scripture.html?d=${draftId}&` : "/?";
  const productName = (artStyle === "micrography" || String(style ?? "").startsWith("Scripture")) && SCRIPTURE_NAMES[product]
    ? SCRIPTURE_NAMES[product]
    : PRICES[product].name;
  p.set(
    "success_url",
    SITE + returnPage + "order=success&sid={CHECKOUT_SESSION_ID}&oid=" + encodeURIComponent(order.id),
  );
  p.set("cancel_url", SITE + returnPage + "order=cancelled");
  p.set("line_items[0][quantity]", "1");
  p.set("line_items[0][price_data][currency]", "usd");
  p.set("line_items[0][price_data][unit_amount]", String(PRICES[product].cents));
  p.set(
    "line_items[0][price_data][product_data][name]",
    productName + " — " + String(style ?? "Custom"),
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
  // TGC's Address API requires phone_number; Stripe doesn't collect it by default.
  p.set("phone_number_collection[enabled]", "true");
  p.set("shipping_options[0][shipping_rate_data][display_name]", "Standard shipping");
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(SHIPPING_CENTS));
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
  p.set("metadata[order_id]", order.id);
  p.set("metadata[product]", product);
  p.set("metadata[style]", String(style ?? ""));
  p.set("metadata[art_style]", artStyle);
  p.set("metadata[art_url]", art_url);
  if (variant) p.set("metadata[variant]", variant);
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
