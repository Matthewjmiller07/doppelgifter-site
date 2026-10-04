// Prodigi order-status callbacks for micrography orders.
// Prodigi doesn't sign callbacks, so: the callback URL carries a shared token
// (PRODIGI_CALLBACK_TOKEN), and the payload is never trusted — the order is re-read
// from the Prodigi API by id before anything changes. verify_jwt is off because
// Prodigi can't send Supabase JWTs.
import { createClient } from "jsr:@supabase/supabase-js@2";

const PRODIGI = "https://api.prodigi.com/v4.0";

async function sendShippedEmail(supabase: any, to: string, trackingUrl: string, orderId: string) {
  try {
    const { data: brevoKey } = await supabase.rpc("dg_get_secret", { secret_name: "BREVO_API_KEY" });
    if (!brevoKey) return;
    const html = `
<div style="background:#F5F1E6;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#1E3329;">
  <div style="max-width:560px;margin:0 auto;background:#FDFBF4;border:1px solid #D8D0BC;border-radius:6px;padding:32px;">
    <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#A87F1F;margin:0 0 12px;">DoppelGifter · The Scriptorium</p>
    <h1 style="font-size:28px;margin:0 0 16px;font-weight:normal;">It has left the scriptorium.</h1>
    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">Several thousand very small letters have been packed, sealed, and handed to a courier who has no idea what they're carrying. Follow their pilgrimage here:</p>
    <p style="text-align:center;margin:0 0 24px;"><a href="${trackingUrl}" style="display:inline-block;background:#1E3329;color:#EDE6D3;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:16px;">Track the parcel</a></p>
    <p style="font-size:13px;color:#52655B;line-height:1.6;margin:0;">Order reference ${orderId.slice(0, 8).toUpperCase()}. Questions? Reply — a real human named Matthew appears.</p>
  </div>
</div>`;
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevoKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "The Atelier at DoppelGifter", email: "matthew@doppelgifter.com" },
        replyTo: { name: "Matthew at DoppelGifter", email: "hello@doppelgifter.com" },
        to: [{ email: to }],
        subject: "It has left the scriptorium. 📜",
        htmlContent: html,
      }),
    });
  } catch (_) {
    // an email hiccup must never fail the callback
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const token = new URL(req.url).searchParams.get("t") ?? "";
  const { data: expected } = await supabase.rpc("dg_get_secret", { secret_name: "PRODIGI_CALLBACK_TOKEN" });
  if (!expected || token !== expected) return new Response("forbidden", { status: 403 });

  const event = await req.json().catch(() => null);
  const prodigiId = event?.data?.order?.id ?? event?.order?.id ?? event?.subject ?? event?.id;
  if (typeof prodigiId !== "string" || !/^ord_\w+$/.test(prodigiId)) {
    return new Response("ignored", { status: 200 });
  }

  const { data: key } = await supabase.rpc("dg_get_secret", { secret_name: "PRODIGI_API_KEY" });
  const res = await fetch(`${PRODIGI}/orders/${prodigiId}`, { headers: { "X-API-Key": key } });
  if (!res.ok) return new Response("lookup failed", { status: 502 });
  const pOrder = (await res.json())?.order;
  if (!pOrder) return new Response("ignored", { status: 200 });

  const { data: order } = await supabase
    .from("dg_orders")
    .select("id, status, email, tracking_url, prodigi_order_id")
    .eq("prodigi_order_id", pOrder.id)
    .maybeSingle();
  if (!order) return new Response("unknown order", { status: 200 });

  const stage = pOrder.status?.stage;
  const tracking = (pOrder.shipments ?? []).map((s: any) => s?.tracking?.url).find(Boolean);

  if (stage === "Cancelled" && order.status !== "cancelled") {
    await supabase.from("dg_orders").update({ status: "cancelled" }).eq("id", order.id);
  } else if (tracking && !order.tracking_url) {
    await supabase.from("dg_orders").update({ status: "shipped", tracking_url: tracking }).eq("id", order.id);
    if (order.email) await sendShippedEmail(supabase, order.email, tracking, order.id);
  } else if (stage === "Complete" && !["shipped", "complete"].includes(order.status)) {
    await supabase.from("dg_orders").update({ status: "complete" }).eq("id", order.id);
  }
  return new Response("ok", { status: 200 });
});
