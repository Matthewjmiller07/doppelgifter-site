import { createClient } from "jsr:@supabase/supabase-js@2";

const REPLICATE_URL = "https://api.replicate.com/v1/models/openai/gpt-image-2/predictions";
const RATE_LIMIT_PER_HOUR = 12;
const FREE_TASTER_RENDERS = 2;
const EST_COST_CENTS = 1.6;
const PRINTIFY_SHOP = 22195433;

const STYLES: Record<string, string> = {
  renaissance:
    "Repaint the person in image 1 as a 16th-century Renaissance oil painting portrait: ornate white ruff collar, gold-embroidered doublet, dark museum background, dramatic chiaroscuro lighting, subtle cracked-varnish texture. Preserve their facial likeness, expression, glasses and hair exactly. Flat square artwork, no frame.",
  cartoon:
    "Redraw the person in image 1 as a 1990s Saturday-morning cartoon character: bold black outlines, flat cel shading, bright saturated colors, exaggerated cheerful expression, halftone dot background. Preserve their recognizable facial features, glasses and hair. Flat square artwork.",
  glamour:
    "Rephotograph the person in image 1 as a 1980s department-store glamour shot: dramatic soft focus, laser-beam grid background in teal and magenta, feathered lighting, slight vaseline lens glow. Preserve their facial likeness exactly. Flat square artwork.",
  marble:
    "Resculpt the person in image 1 as a classical white marble bust in the style of ancient Greek statuary, heroic noble expression, realistic marble veining, dark charcoal background, soft gallery lighting. Preserve their recognizable facial features, glasses and hair rendered in carved marble. Flat square artwork.",
};

// One scene-prompt builder per style, mirroring the STYLES dict's visual language
// above so a staged scene looks like it belongs to the same painted/rendered world
// as the plain portrait in that style.
const SCENE_PROMPTS: Record<string, (scene: string) => string> = {
  renaissance: (scene) =>
    `Repaint the person in image 1 as the subject of a 16th-century Renaissance oil painting: a theatrical three-quarter-length scene in which they are ${scene}. Comedic but painterly period staging with simple props, dark museum background, dramatic chiaroscuro lighting, subtle cracked-varnish texture. Preserve their facial likeness, expression, glasses and hair exactly. Portrait-orientation flat artwork, no frame, no text.`,
  cartoon: (scene) =>
    `Redraw the person in image 1 as a 1990s Saturday-morning cartoon character: a theatrical three-quarter-length scene in which they are ${scene}. Bold black outlines, flat cel shading, bright saturated colors, halftone dot background, exaggerated comedic expression. Preserve their recognizable facial features, glasses and hair. Portrait-orientation flat artwork, no frame, no text.`,
  glamour: (scene) =>
    `Rephotograph the person in image 1 as an 1980s department-store glamour shot: a theatrical three-quarter-length scene in which they are ${scene}. Dramatic soft focus, laser-beam grid background in teal and magenta, feathered lighting, slight vaseline lens glow. Preserve their facial likeness exactly. Portrait-orientation flat artwork, no frame, no text.`,
  marble: (scene) =>
    `Resculpt the person in image 1 as a classical white marble statue in the style of ancient Greek statuary: a theatrical three-quarter-length scene in which they are ${scene}. Realistic marble veining, heroic yet comedic staging, dark charcoal gallery background, soft dramatic lighting. Preserve their recognizable facial features, glasses and hair rendered in carved marble. Portrait-orientation flat artwork, no frame, no text.`,
};

const AI_MOCKUPS: Record<string, string> = {
  mug: "Professional e-commerce product photograph of an 11oz glossy white ceramic mug on a clean light-gray studio background with soft shadows. The artwork in image 1 is printed on the side of the mug. Preserve any caption text in the artwork exactly. Sharp focus, no added text or watermarks.",
  tee: "Professional e-commerce product photograph of a white unisex t-shirt on an invisible mannequin against a clean light studio background. The artwork in image 1 is printed large on the chest. Preserve any caption text exactly. Sharp focus, no added text.",
  poster: "Professional interior photograph of an 18x24 inch matte poster on a warm neutral wall showing the artwork from image 1, preserving any caption text exactly. Sharp focus, no added text.",
  blanket: "Professional lifestyle product photograph of a soft plush blanket draped over a sofa, printed with the artwork from image 1, preserving any caption text exactly. Sharp focus, no added text.",
  cards: "Professional product photography of a custom playing card deck on a neutral background, showing both the tuck box and several spread cards featuring the portrait from image 1 on their backs. Sharp focus, clean studio lighting.",
};

const PRINTIFY_CFG: Record<string, { blueprint: number; provider: number; variant: number; scale: number; price: number }> = {
  mug: { blueprint: 68, provider: 1, variant: 33719, scale: 0.415, price: 2499 },
  tee: { blueprint: 6, provider: 29, variant: 12100, scale: 1.0, price: 3499 },
  blanket: { blueprint: 522, provider: 1, variant: 68323, scale: 1.0, price: 6499 },
  poster: { blueprint: 282, provider: 99, variant: 43144, scale: 1.0, price: 4499 },
  cards: { blueprint: 1138, provider: 28, variant: 87236, scale: 1.0, price: 2499 },
};

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { photo, style, art_url, products, session_key = "anon" } = body;
  const email = typeof body.email === "string" && EMAIL_RE.test(body.email.trim())
    ? body.email.trim().toLowerCase()
    : null;
  const caption = typeof body.caption === "string"
    ? body.caption.replace(/["\\<>]/g, "").trim().slice(0, 40)
    : "";
  const scene = typeof body.scene === "string"
    ? body.scene.replace(/["\\<>{}]/g, "").trim().slice(0, 110)
    : "";
  const sceneStyle = typeof body.style === "string" && SCENE_PROMPTS[body.style] ? body.style : "renaissance";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let knownLead = false;
  if (email) {
    await supabase.from("dg_leads").upsert(
      { email, session_key, source: "render_gate", last_seen_at: new Date().toISOString() },
      { onConflict: "email" },
    );
    knownLead = true;
  } else {
    const { count: leadCount } = await supabase
      .from("dg_leads")
      .select("*", { count: "exact", head: true })
      .eq("session_key", session_key);
    knownLead = (leadCount ?? 0) > 0;
  }

  const { count: totalRenders } = await supabase
    .from("dg_renders")
    .select("*", { count: "exact", head: true })
    .eq("session_key", session_key);

  if (!knownLead && (totalRenders ?? 0) >= FREE_TASTER_RENDERS) {
    return json(
      {
        error: "The first masterpiece was on the house. The atelier requires an email for more.",
        code: "email_required",
      },
      402,
    );
  }

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count: hourly } = await supabase
    .from("dg_renders")
    .select("*", { count: "exact", head: true })
    .eq("session_key", session_key)
    .gte("created_at", hourAgo);
  if ((hourly ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json({ error: "Easy there, Rembrandt. Try again in an hour." }, 429);
  }

  async function logRender(stage: string, quality: string, cost: number, status: string, url: string | null) {
    await supabase.from("dg_renders").insert({
      session_key,
      stage,
      quality,
      est_cost_cents: cost,
      status,
      output_url: url,
    });
  }

  async function predict(
    token: string,
    prompt: string,
    images: string[],
    stage: string,
    outputFormat: string,
    aspectRatio = "1:1",
  ): Promise<string> {
    const res = await fetch(REPLICATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        input: {
          prompt,
          quality: "low",
          aspect_ratio: aspectRatio,
          output_format: outputFormat,
          number_of_images: 1,
          input_images: images,
        },
      }),
    });
    let pred = await res.json();
    while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await fetch(pred.urls.get, {
        headers: { Authorization: `Bearer ${token}` },
      });
      pred = await poll.json();
    }
    const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    await logRender(stage, "low", EST_COST_CENTS, pred.status, output ?? null);
    if (pred.status !== "succeeded") {
      throw new Error(pred.error ?? `render ${stage} failed`);
    }
    return output;
  }

  async function persistToStorage(url: string, ext: string, contentType: string): Promise<string> {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const path = `${session_key}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("dg-art")
      .upload(path, bytes, { contentType });
    if (upErr) throw new Error("storage: " + upErr.message);
    return supabase.storage.from("dg-art").getPublicUrl(path).data.publicUrl;
  }

  async function printifyMockup(pkey: string, artUrl: string, productKey: string): Promise<string> {
    const cfg = PRINTIFY_CFG[productKey];
    const H = {
      Authorization: `Bearer ${pkey}`,
      "Content-Type": "application/json",
      "User-Agent": "DoppelGifter/0.1 (+https://doppelgifter.com)",
    };
    const up = await (
      await fetch("https://api.printify.com/v1/uploads/images.json", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ file_name: `preview-${crypto.randomUUID()}.png`, url: artUrl }),
      })
    ).json();
    if (!up?.id) throw new Error("printify upload failed");

    const prod = await (
      await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP}/products.json`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          title: `preview — auto-deleted`,
          description: "Temporary preview product",
          blueprint_id: cfg.blueprint,
          print_provider_id: cfg.provider,
          variants: [{ id: cfg.variant, price: cfg.price, is_enabled: true }],
          print_areas: [
            {
              variant_ids: [cfg.variant],
              placeholders: [
                {
                  position: "front",
                  images: [{ id: up.id, x: 0.5, y: 0.5, scale: cfg.scale, angle: 0 }],
                },
              ],
            },
          ],
        }),
      })
    ).json();
    if (!prod?.id) throw new Error("printify product failed: " + JSON.stringify(prod).slice(0, 150));

    try {
      const imgs = prod.images ?? [];
      const pickImg = imgs.find((i: any) => i.is_default) ?? imgs[0];
      if (!pickImg?.src) throw new Error("no mockup images");
      return await persistToStorage(pickImg.src, "jpg", "image/jpeg");
    } finally {
      await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP}/products/${prod.id}.json`, {
        method: "DELETE",
        headers: H,
      }).catch(() => {});
    }
  }

  try {
    if (photo && scene) {
      if (typeof photo !== "string" || photo.length > 2_500_000) {
        return json({ error: "Photo too large - resize to 1024px first" }, 400);
      }
      const { data: token, error: secretError } = await supabase.rpc("dg_get_secret", {
        secret_name: "REPLICATE_API_TOKEN",
      });
      if (secretError || !token) return json({ error: "Server configuration error" }, 500);
      const replicateUrl = await predict(token, SCENE_PROMPTS[sceneStyle](scene), [photo], `scene:${sceneStyle}`, "webp", "2:3");
      let art = replicateUrl;
      try {
        art = await persistToStorage(replicateUrl, "webp", "image/webp");
      } catch (_) { /* fall back to the replicate URL */ }
      return json({ art });
    }

    if (photo && style) {
      if (!STYLES[style]) return json({ error: "Unknown style" }, 400);
      if (typeof photo !== "string" || photo.length > 2_500_000) {
        return json({ error: "Photo too large - resize to 1024px first" }, 400);
      }
      const { data: token, error: secretError } = await supabase.rpc("dg_get_secret", {
        secret_name: "REPLICATE_API_TOKEN",
      });
      if (secretError || !token) return json({ error: "Server configuration error" }, 500);
      let prompt = STYLES[style];
      if (caption) {
        prompt += ` At the bottom of the artwork, include a small, elegant hand-lettered caption that reads exactly \"${caption}\" — spelled precisely, matching the artwork's era and style.`;
      } else {
        prompt += " No text in the artwork.";
      }
      const replicateUrl = await predict(token, prompt, [photo], `style:${style}`, "png");
      let art = replicateUrl;
      try {
        art = await persistToStorage(replicateUrl, "png", "image/png");
      } catch (_) { /* fall back to the replicate URL */ }
      return json({ art });
    }

    if (art_url && Array.isArray(products) && products.length) {
      const wanted = products.filter((p: string) => PRINTIFY_CFG[p]).slice(0, 2);
      if (!wanted.length) return json({ error: "Unknown products" }, 400);
      const { data: pkey } = await supabase.rpc("dg_get_secret", {
        secret_name: "PRINTIFY_API_KEY",
      });
      const mockups: Record<string, string> = {};
      for (const p of wanted) {
        try {
          if (!pkey) throw new Error("no printify key");
          mockups[p] = await printifyMockup(pkey, art_url, p);
          await logRender(`mockup:${p}`, "printify", 0, "succeeded", mockups[p]);
        } catch (_e) {
          const { data: token } = await supabase.rpc("dg_get_secret", {
            secret_name: "REPLICATE_API_TOKEN",
          });
          if (!token) throw new Error("mockup failed and no fallback available");
          mockups[p] = await predict(token, AI_MOCKUPS[p], [art_url], `mockup:${p}`, "webp");
        }
      }
      return json({ mockups });
    }
    return json({ error: "Send {photo, scene}, {photo, style} or {art_url, products}" }, 400);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
