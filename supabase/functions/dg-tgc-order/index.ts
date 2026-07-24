// Places (or previews) the real TGC Cart/checkout for an order whose Game was
// already built by dg-tgc-fulfill. Two modes, controlled by body.confirm:
//   confirm: false/absent -> "dry run": builds the TGC Address, creates a Cart,
//     attaches the address + this game's sku, and reports the cart total plus
//     the current TGC shop-credit balance. Nothing is charged.
//   confirm: true -> does all of the above AND calls the real headless
//     payment endpoint (POST /cart/xxx/payment/shopcredit). This is the one
//     call in this whole pipeline that spends real shop credit and creates a
//     real print/ship order at The Game Crafter — only ever invoke it with
//     confirm:true deliberately, per order.
//
// Why shopcredit and not creditcard: TGC's creditcard endpoint takes raw
// card_number/cvv2 as POST fields — a PCI-DSS liability we're not taking on.
// Shop credit has to be funded by hand in TGC's own web UI first (no API to
// fund it); until that balance is > 0, confirm:true will fail cleanly with
// TGC's own "insufficient funds" error, which is expected and safe.
//
// Shipping address comes from the ORIGINAL Stripe Checkout Session (via
// order.stripe_session_id), not a duplicated column — dg-checkout already
// collects it, and phone_number_collection was added there specifically so
// this function can satisfy TGC Address's required phone_number field.
//
// Auth: same x-admin-secret pattern as dg-tgc-fulfill (verify_jwt alone isn't
// enough since the anon key is public client-side).
import { createClient } from "jsr:@supabase/supabase-js@2";

const TGC_API = "https://www.thegamecrafter.com/api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function tgc(sessionId: string, path: string, method = "GET", form?: Record<string, string>) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${TGC_API}${path}${sep}session_id=${encodeURIComponent(sessionId)}`;
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) params.set(k, v);
    init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
    init.body = params.toString();
  }
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`TGC ${method} ${path}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  return data.result;
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
  const orderId = body.order_id;
  const confirm = body.confirm === true;
  if (typeof orderId !== "string") return json({ error: "order_id required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: adminSecret } = await supabase.rpc("dg_get_secret", { secret_name: "DG_ADMIN_SECRET" });
  if (!adminSecret || req.headers.get("x-admin-secret") !== adminSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: order } = await supabase.from("dg_orders").select("*").eq("id", orderId).single();
  if (!order) return json({ error: "unknown order" }, 404);
  if (!order.tgc_game_id) return json({ error: "no tgc_game_id — run dg-tgc-fulfill first" }, 400);
  if (order.tgc_order_id) return json({ error: `already ordered: ${order.tgc_order_id}` }, 400);

  const { data: sessionId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_SESSION_ID" });
  const { data: userId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_USER_ID" });
  const { data: apiKeyId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_PUBLIC_KEY" });
  const { data: stripeKey } = await supabase.rpc("dg_get_secret", { secret_name: "STRIPE_SECRET_KEY" });
  if (!sessionId || !userId || !apiKeyId) return json({ error: "TGC not configured" }, 500);
  if (!order.stripe_session_id || !stripeKey) return json({ error: "no stripe session to pull shipping from" }, 400);

  try {
    // ---- Shipping details, straight from the original Checkout Session ----
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.stripe_session_id)}`,
      { headers: { Authorization: `Bearer ${stripeKey}` } },
    );
    const s = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(`stripe session fetch: ${s?.error?.message ?? stripeRes.status}`);
    const shipAddr = s.shipping_details?.address ?? s.customer_details?.address ?? {};
    const fullName = s.shipping_details?.name ?? s.customer_details?.name ?? "DoppelGifter Customer";
    const phone = s.customer_details?.phone ?? null;
    const phoneMissing = !phone;
    if (!shipAddr.line1 || !shipAddr.city || !shipAddr.postal_code) {
      throw new Error("stripe session has no usable shipping address");
    }

    // ---- TGC Address ----
    const address = await tgc(sessionId, "/address", "POST", {
      user_id: String(userId),
      name: String(fullName),
      address1: String(shipAddr.line1 ?? ""),
      address2: String(shipAddr.line2 ?? ""),
      city: String(shipAddr.city ?? ""),
      state: String(shipAddr.state ?? (shipAddr.country === "US" ? "" : "N/A")),
      postal_code: String(shipAddr.postal_code ?? ""),
      country: String(shipAddr.country ?? "US"),
      phone_number: phone ?? "000-000-0000",
    });

    // ---- Game's sku_id ----
    const game = await tgc(sessionId, `/game/${order.tgc_game_id}`);
    if (!game?.sku_id) throw new Error("game has no sku_id yet");

    // ---- Cart: create, attach address, add this game's sku ----
    const cart = await tgc(sessionId, "/cart", "POST", {
      api_key_id: String(apiKeyId),
      name: `DoppelGifter order ${orderId.slice(0, 8)}`,
      shipping_address_id: address.id,
    });
    await tgc(sessionId, `/cart/${cart.id}/sku/${game.sku_id}`, "POST", { quantity: "1" });
    const cartAfterAdd = await tgc(sessionId, `/cart/${cart.id}`);

    const user = await tgc(sessionId, `/user/${userId}`);
    const shopCredit = Number(user.shop_credit ?? 0);
    const cartTotal = Number(cartAfterAdd.total ?? cartAfterAdd.grand_total ?? NaN);

    const preview = {
      ok: true,
      cart_id: cart.id,
      address_id: address.id,
      sku_id: game.sku_id,
      shop_credit: shopCredit,
      cart_total: Number.isFinite(cartTotal) ? cartTotal : null,
      phone_missing: phoneMissing,
      note: phoneMissing
        ? "Stripe session had no phone number — used a placeholder. Verify/replace before this ships for real."
        : undefined,
    };

    if (!confirm) {
      return json({ ...preview, dry_run: true, note2: "Nothing charged. Call again with confirm:true to place the real order." });
    }

    // ---- The one real-money call in this whole pipeline ----
    const receipt = await tgc(sessionId, `/cart/${cart.id}/payment/shopcredit`, "POST");
    await supabase.from("dg_orders").update({ tgc_order_id: receipt?.id ?? cart.id }).eq("id", orderId);

    return json({ ...preview, dry_run: false, receipt });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
