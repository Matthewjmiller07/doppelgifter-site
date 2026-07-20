// Stripe webhook: payment confirmed -> create Printify product + order (draft) -> funny email.
// Auth: Stripe HMAC signature verification (verify_jwt is off because Stripe
// cannot send Supabase JWTs; every request is validated against STRIPE_WEBHOOK_SECRET).
import { createClient } from "jsr:@supabase/supabase-js@2";

const PRINTIFY = { shop: 22195433, blueprint: 68, provider: 1, variant: 33719 };
const AUTO_PRODUCE = false; // keep false in test mode: orders wait as drafts, no charges

const PRODUCT_NAMES: Record<string, string> = {
  mug: "The Ceremonial Mug",
  tee: "The Monument Tee",
  blanket: "The Heirloom Blanket",
  poster: "The Gallery Poster",
  deck: "The Parlour Deck (54 cards)",
};
const PRODUCT_QUIPS: Record<string, string> = {
  mug: "a machine is now solemnly applying their face to 11 ounces of premium ceramic",
  tee: "their likeness is being screen-printed onto soft cotton at industrial speed",
  blanket: "their face is being woven into 50×60 inches of fleece, edge to edge, no escape",
  poster: "their portrait is being pressed onto museum-grade matte paper, frame-ready",
  deck: "fifty-four linen-finish cards are being dealt their face, one solemn scene at a time",
};

async function verifySignature(payload: string, header: string, secret: string): Promise<boolean> {
  const t = header.split(",").find((p) => p.startsWith("t="))?.slice(2);
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.includes(hex);
}

async function sendConfirmationEmail(supabase: any, s: any, orderId: string) {
  try {
    const to = s.customer_details?.email;
    if (!to) return;
    const { data: brevoKey } = await supabase.rpc("dg_get_secret", {
      secret_name: "BREVO_API_KEY",
    });
    if (!brevoKey) return;
    const product = s.metadata?.product ?? "mug";
    const productName = PRODUCT_NAMES[product] ?? "a fine commemorative good";
    const quip = PRODUCT_QUIPS[product] ?? "their face is being applied to merchandise with great ceremony";
    const style = s.metadata?.style || "a masterpiece style";
    const img = s.metadata?.preview_url || s.metadata?.art_url || "";
    const digital = s.metadata?.digital === "1";
    const artUrl = s.metadata?.art_url || "";
    const firstName = String(s.customer_details?.name ?? "Patron").split(" ")[0];
    const html = `
<div style="background:#F5F1E6;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#1E3329;">
  <div style="max-width:560px;margin:0 auto;background:#FDFBF4;border:1px solid #D8D0BC;border-radius:6px;padding:32px;">
    <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#A87F1F;margin:0 0 12px;">DoppelGifter · Fine Commemorative Goods</p>
    <h1 style="font-size:30px;margin:0 0 16px;font-weight:normal;">Huzzah, ${firstName}. It is done.</h1>
    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">Your payment has cleared, and somewhere in a print facility, ${quip}. There is no way to stop this now. There never was.</p>
    ${img ? `<img src="${img}" alt="Your commissioned piece" width="320" style="display:block;margin:0 auto 20px;border:8px solid #E4C158;outline:4px solid #8A6914;max-width:100%;">` : ""}
    <p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><b>The commission:</b> ${productName} — ${style}</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;"><b>Order reference:</b> ${orderId.slice(0, 8).toUpperCase()}</p>
    ${digital && artUrl ? `<p style="font-size:15px;line-height:1.6;margin:0 0 20px;"><b>Your Digital Masterpiece:</b> <a href="${artUrl}" style="color:#A87F1F;">download the full-resolution file</a> — suitable for framing, phone wallpapers, and tasteful gloating.</p>` : ""}
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">The masters estimate 2–5 business days of production, then shipping to your door. A tracking note will follow. We recommend rehearsing a casual “oh, it’s nothing” for the gifting moment.</p>
    <p style="font-size:13px;color:#52655B;line-height:1.6;margin:0;">Questions? Just reply — a real human named Matthew appears. No refunds on dignity; everything else we can talk about.</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#52655B;margin:16px 0 0;">DoppelGifter · doppelgifter.com · Their face. On stuff.</p>
</div>`;
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevoKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "The Atelier at DoppelGifter", email: "matthew@doppelgifter.com" },
        replyTo: { name: "Matthew at DoppelGifter", email: "hello@doppelgifter.com" },
        to: [{ email: to }],
        subject: `It is done. ${productName} bearing their face is being forged. 🏺`,
        htmlContent: html,
      }),
    });
  } catch (_) {
    // email failure must never block fulfillment
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const payload = await req.text();
  const sigHeader = req.headers.get("stripe-signature") ?? "";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: whsec } = await supabase.rpc("dg_get_secret", {
    secret_name: "STRIPE_WEBHOOK_SECRET",
  });
  if (!whsec || !(await verifySignature(payload, sigHeader, whsec))) {
    return new Response("invalid signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 });
  }
  const s = event.data.object;
  const orderId = s.metadata?.order_id;
  if (!orderId) return new Response("no order_id", { status: 200 });

  const { data: existing } = await supabase
    .from("dg_orders")
    .select("id,status")
    .eq("id", orderId)
    .single();
  if (!existing) return new Response("unknown order", { status: 200 });
  if (existing.status !== "pending") return new Response("already processed", { status: 200 });

  const buyerEmail = s.customer_details?.email ?? null;
  await supabase
    .from("dg_orders")
    .update({ status: "paid", email: buyerEmail })
    .eq("id", orderId);

  if (buyerEmail) {
    const lead: Record<string, unknown> = {
      email: String(buyerEmail).toLowerCase(),
      source: "purchase",
      last_seen_at: new Date().toISOString(),
    };
    if (s.metadata?.session_key) lead.session_key = s.metadata.session_key;
    await supabase.from("dg_leads").upsert(lead, { onConflict: "email" });
  }

  if (s.metadata?.product !== "mug") {
    await sendConfirmationEmail(supabase, s, orderId);
    return new Response("paid; manual fulfillment product", { status: 200 });
  }

  try {
    const { data: pkey } = await supabase.rpc("dg_get_secret", {
      secret_name: "PRINTIFY_API_KEY",
    });
    const H = {
      Authorization: `Bearer ${pkey}`,
      "Content-Type": "application/json",
      "User-Agent": "DoppelGifter/0.1 (+https://doppelgifter.com)",
    };

    const up = await (
      await fetch("https://api.printify.com/v1/uploads/images.json", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          file_name: `order-${orderId}.png`,
          url: s.metadata.art_url,
        }),
      })
    ).json();
    if (!up?.id) throw new Error("printify upload failed: " + JSON.stringify(up).slice(0, 200));

    const prod = await (
      await fetch(`https://api.printify.com/v1/shops/${PRINTIFY.shop}/products.json`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          title: `DoppelGifter order ${orderId.slice(0, 8)} — Ceremonial Mug`,
          description: "Custom DoppelGifter mug",
          blueprint_id: PRINTIFY.blueprint,
          print_provider_id: PRINTIFY.provider,
          variants: [{ id: PRINTIFY.variant, price: 2999, is_enabled: true }],
          print_areas: [
            {
              variant_ids: [PRINTIFY.variant],
              placeholders: [
                {
                  position: "front",
                  images: [{ id: up.id, x: 0.5, y: 0.5, scale: 0.415, angle: 0 }],
                },
              ],
            },
          ],
        }),
      })
    ).json();
    if (!prod?.id) throw new Error("printify product failed: " + JSON.stringify(prod).slice(0, 200));

    const addr = s.shipping_details?.address ?? s.customer_details?.address ?? {};
    const fullName = s.shipping_details?.name ?? s.customer_details?.name ?? "DoppelGifter Customer";
    const nameParts = String(fullName).split(" ");
    const order = await (
      await fetch(`https://api.printify.com/v1/shops/${PRINTIFY.shop}/orders.json`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          external_id: orderId,
          label: `dg-${orderId.slice(0, 8)}`,
          line_items: [
            { product_id: prod.id, variant_id: PRINTIFY.variant, quantity: 1 },
          ],
          shipping_method: 1,
          send_shipping_notification: true,
          address_to: {
            first_name: nameParts[0],
            last_name: nameParts.slice(1).join(" ") || "-",
            email: buyerEmail ?? "",
            phone: "",
            country: addr.country ?? "US",
            region: addr.state ?? "",
            address1: addr.line1 ?? "",
            address2: addr.line2 ?? "",
            city: addr.city ?? "",
            zip: addr.postal_code ?? "",
          },
        }),
      })
    ).json();
    if (!order?.id) throw new Error("printify order failed: " + JSON.stringify(order).slice(0, 200));

    if (AUTO_PRODUCE) {
      await fetch(
        `https://api.printify.com/v1/shops/${PRINTIFY.shop}/orders/${order.id}/send_to_production.json`,
        { method: "POST", headers: H },
      );
    }

    await supabase
      .from("dg_orders")
      .update({
        status: "submitted",
        printify_product_id: String(prod.id),
        printify_order_id: String(order.id),
      })
      .eq("id", orderId);

    await sendConfirmationEmail(supabase, s, orderId);
    return new Response("fulfilled", { status: 200 });
  } catch (e) {
    await supabase.from("dg_orders").update({ status: "failed" }).eq("id", orderId);
    return new Response("fulfillment error: " + String(e?.message ?? e), { status: 500 });
  }
});
