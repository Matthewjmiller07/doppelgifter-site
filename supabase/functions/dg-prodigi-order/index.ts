// Places a paid micrography order (mg_* products) with Prodigi.
// Called by dg-webhook after Stripe confirms payment, with the service-role key —
// verify_jwt alone would also admit the public anon key, so the bearer is checked
// against the service key explicitly.
//   { order_id, ship: { name, email, phone, address{line1,line2,city,state,postal_code,country} }, dry_run? }
// dry_run quotes the exact order instead of placing it, so the payload can be
// verified end to end without spending money.
import { createClient } from "jsr:@supabase/supabase-js@2";

const PRODIGI = "https://api.prodigi.com/v4.0";

// Verified against the live catalogue 2026-10-04 (GET /products/{sku}).
const MG_PRODUCTS: Record<string, {
  shipping: string;
  variants: Record<string, { sku: string; attributes?: Record<string, string> }>;
}> = {
  mg_print: {
    shipping: "Budget",
    variants: { standard: { sku: "GLOBAL-FAP-12X16" } },
  },
  mg_framed: {
    shipping: "Standard",
    variants: {
      black: { sku: "GLOBAL-CFPM-12X16", attributes: { color: "black" } },
      natural: { sku: "GLOBAL-CFPM-12X16", attributes: { color: "natural" } },
      white: { sku: "GLOBAL-CFPM-12X16", attributes: { color: "white" } },
      gold: { sku: "GLOBAL-CFPM-12X16", attributes: { color: "gold" } },
    },
  },
  mg_case: {
    shipping: "Budget",
    variants: {
      ip15: { sku: "GLOBAL-TECH-IP15-TCB-CS-G" },
      ip16: { sku: "GLOBAL-TECH-IP16-TCB-CS-G" },
      ip17: { sku: "GLOBAL-TECH-IP17-TCB-CS-G" },
      s24: { sku: "GLOBAL-TECH-SGS24-TCB-CS-G" },
    },
  },
};

// A paid order that didn't reach Prodigi needs a human — email Matthew the details.
async function alertOwner(supabase: any, orderId: string, detail: string) {
  try {
    const { data: brevoKey } = await supabase.rpc("dg_get_secret", { secret_name: "BREVO_API_KEY" });
    if (!brevoKey) return;
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevoKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "DoppelGifter Alerts", email: "matthew@doppelgifter.com" },
        to: [{ email: "matthew@doppelgifter.com" }],
        subject: `⚠️ Prodigi order failed — ${orderId.slice(0, 8)}`,
        textContent: `A paid micrography order could not be placed with Prodigi.\n\nOrder: ${orderId}\n\n${detail}\n\nRetry by POSTing {order_id} to dg-prodigi-order with the service key after fixing, or place it by hand in the Prodigi dashboard.`,
      }),
    });
  } catch (_) {
    // alerting is best-effort
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.headers.get("authorization") !== `Bearer ${svcKey}`) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, svcKey);

  const { data: order } = await supabase
    .from("dg_orders")
    .select("id, product, variant, status, print_url, email, prodigi_order_id")
    .eq("id", String(body.order_id ?? "").slice(0, 64))
    .single();
  if (!order) return json({ error: "unknown order" }, 404);
  const product = MG_PRODUCTS[order.product];
  const variant = product?.variants[order.variant ?? ""];
  if (!product || !variant) return json({ error: "not a Prodigi product" }, 400);
  if (!body.dry_run && (order.status !== "paid" || order.prodigi_order_id)) {
    return json({ ok: true, skipped: "already placed or not paid" });
  }

  const [{ data: key }, { data: cbToken }] = await Promise.all([
    supabase.rpc("dg_get_secret", { secret_name: "PRODIGI_API_KEY" }),
    supabase.rpc("dg_get_secret", { secret_name: "PRODIGI_CALLBACK_TOKEN" }),
  ]);
  if (!key) return json({ error: "PRODIGI_API_KEY missing" }, 500);

  const ship = body.ship ?? {};
  const a = ship.address ?? {};
  const item = {
    merchantReference: order.id,
    sku: variant.sku,
    copies: 1,
    sizing: "fillPrintArea",
    attributes: variant.attributes ?? {},
    assets: [{ printArea: "default", url: order.print_url }],
  };
  const H = { "X-API-Key": key, "Content-Type": "application/json" };

  if (body.dry_run) {
    const res = await fetch(`${PRODIGI}/quotes`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        shippingMethod: product.shipping,
        destinationCountryCode: a.country || "US",
        currencyCode: "USD",
        items: [{ sku: item.sku, copies: 1, attributes: item.attributes, assets: [{ printArea: "default" }] }],
      }),
    });
    return json({ dry_run: true, status: res.status, quote: await res.json(), would_send: item });
  }

  const payload = {
    merchantReference: order.id,
    idempotencyKey: order.id,
    shippingMethod: product.shipping,
    callbackUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/dg-prodigi-webhook?t=${cbToken ?? ""}`,
    recipient: {
      name: String(ship.name || "DoppelGifter Customer").slice(0, 100),
      email: ship.email || order.email || undefined,
      phoneNumber: ship.phone || undefined,
      address: {
        line1: a.line1 ?? "",
        line2: a.line2 ?? undefined,
        postalOrZipCode: a.postal_code ?? "",
        countryCode: a.country ?? "US",
        townOrCity: a.city ?? "",
        stateOrCounty: a.state ?? undefined,
      },
    },
    items: [item],
  };

  try {
    const res = await fetch(`${PRODIGI}/orders`, { method: "POST", headers: H, body: JSON.stringify(payload) });
    const out = await res.json();
    const prodigiId = out?.order?.id;
    if (!res.ok || !prodigiId) throw new Error(`${res.status} ${JSON.stringify(out).slice(0, 400)}`);
    await supabase
      .from("dg_orders")
      .update({ status: "submitted", prodigi_order_id: prodigiId })
      .eq("id", order.id);
    return json({ ok: true, prodigi_order_id: prodigiId, outcome: out.outcome });
  } catch (e) {
    await supabase.from("dg_orders").update({ status: "failed" }).eq("id", order.id);
    console.error("prodigi order failed", order.id, String((e as Error)?.message ?? e));
    await alertOwner(supabase, order.id, String((e as Error)?.message ?? e));
    return json({ error: "prodigi order failed", detail: String((e as Error)?.message ?? e) }, 502);
  }
});
