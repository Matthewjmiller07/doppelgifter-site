// Micrography → DoppelGifter handoff.
// The micrography studio (matthewmiller.com/micrography) renders the artwork in the
// browser and needs somewhere to put it before checkout. This hands out signed upload
// URLs into dg-art/mg/<draft id>/ so multi-megabyte print files go straight to Storage
// instead of through a JSON body.
//   { action: "create", meta }          -> { id, upload_url, plate_url }
//   { action: "print", id, product }    -> { upload_url, print_url }
//   { action: "get", id }               -> { meta, plate_url }
// Anyone can create a draft (same trust model as dg-render previews); drafts are
// unguessable UUIDs and only become orders through dg-checkout + Stripe.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "dg-art";
const PRODUCTS = new Set(["mg_print", "mg_framed", "mg_case"]);
const TECHNIQUES = new Set(["grid", "engrave", "contour", "spiral"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function clip(v: unknown, n: number): string {
  return typeof v === "string" ? v.replace(/[<>]/g, "").trim().slice(0, n) : "";
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
  const store = supabase.storage.from(BUCKET);
  const publicUrl = (path: string) => store.getPublicUrl(path).data.publicUrl;

  if (body.action === "create") {
    const id = crypto.randomUUID();
    const m = body.meta ?? {};
    const meta = {
      source: "micrography",
      created_at: new Date().toISOString(),
      title: clip(m.title, 120),
      text_ref: clip(m.text_ref, 160),
      text_sample: clip(m.text_sample, 200),
      technique: TECHNIQUES.has(m.technique) ? m.technique : "grid",
      ink: clip(m.ink, 30),
      ink_name: clip(m.ink_name, 40),
      paper: /^#[0-9a-f]{6}$/i.test(m.paper ?? "") ? m.paper : "#efe6d2",
      width: Number.isFinite(m.width) ? Math.round(m.width) : null,
      height: Number.isFinite(m.height) ? Math.round(m.height) : null,
    };
    const { error: metaErr } = await store.upload(
      `mg/${id}/meta.json`,
      new Blob([JSON.stringify(meta)], { type: "application/json" }),
      { contentType: "application/json", upsert: false },
    );
    if (metaErr) return json({ error: "Could not open a draft" }, 500);
    const { data: signed, error } = await store.createSignedUploadUrl(`mg/${id}/plate.jpg`);
    if (error || !signed) return json({ error: "Could not sign upload" }, 500);
    return json({ id, upload_url: signed.signedUrl, plate_url: publicUrl(`mg/${id}/plate.jpg`) });
  }

  const id = typeof body.id === "string" ? body.id.toLowerCase() : "";
  if (!UUID.test(id)) return json({ error: "Unknown draft" }, 400);

  if (body.action === "get") {
    const { data, error } = await store.download(`mg/${id}/meta.json`);
    if (error || !data) return json({ error: "Unknown draft" }, 404);
    return json({ meta: JSON.parse(await data.text()), plate_url: publicUrl(`mg/${id}/plate.jpg`) });
  }

  if (body.action === "print") {
    if (!PRODUCTS.has(body.product)) return json({ error: "Unknown product" }, 400);
    const { error: missing } = await store.download(`mg/${id}/meta.json`);
    if (missing) return json({ error: "Unknown draft" }, 404);
    const path = `mg/${id}/print-${body.product}-${Date.now()}.jpg`;
    const { data: signed, error } = await store.createSignedUploadUrl(path);
    if (error || !signed) return json({ error: "Could not sign upload" }, 500);
    return json({ upload_url: signed.signedUrl, print_url: publicUrl(path) });
  }

  return json({ error: "Unknown action" }, 400);
});
