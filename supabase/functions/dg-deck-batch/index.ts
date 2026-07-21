// Renders ONE batch of Parlour Deck scenes, then chains to a fresh invocation of
// itself for the next batch. Exists because Supabase Edge Function background
// tasks (EdgeRuntime.waitUntil) have a hard wall-clock ceiling on this project
// (150s) — a single invocation trying to render all 48 scenes gets silently
// killed partway through with no error, which is exactly what happened twice
// before this file existed. Each chained invocation gets its own fresh budget.
//
// Auth: verify_jwt is on; only server-side callers holding the service-role key
// (dg-webhook, and this function calling itself) can invoke it.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://doppelgifter.com";
const SELF_URL = "https://knbyyykfwwlgnizutqyb.supabase.co/functions/v1/dg-deck-batch";
const CONCURRENCY = 6;
const PER_SCENE_TIMEOUT_MS = 100_000; // leaves headroom inside the 150s invocation budget

const SCENES: [string, string, string][] = [
  ["Acts of Nobility", "Posing for a royal portrait that is taking hours", "posing stiffly for a royal portrait, visibly exhausted"],
  ["Acts of Nobility", "{name} knighting a confused pigeon", "solemnly knighting a confused pigeon with a sword"],
  ["Acts of Nobility", "Fencing an invisible rival, poorly", "fencing against an invisible rival, poorly, mid-lunge"],
  ["Acts of Nobility", "Waving at peasants from a slow carriage", "waving regally from a gilded carriage window"],
  ["Acts of Nobility", "Trying on a crown that is far too big", "wearing a golden crown far too big, slipping over their eyes"],
  ["Acts of Nobility", "A dramatic royal faint onto a convenient couch", "fainting dramatically backwards onto a velvet couch, hand on forehead"],
  ["Acts of Nobility", "Sipping tea with a fully extended pinky", "sipping tea from a tiny cup with a fully extended pinky"],
  ["Acts of Nobility", "Reading a decree nobody asked for", "proclaiming loudly from an unfurled scroll to an empty square"],
  ["Acts of Nobility", "Being carried by invisible servants", "reclining midair as if carried by invisible servants"],
  ["Acts of Nobility", "A duel at dawn ({name} overslept)", "arriving late to a duel at dawn in a nightcap, holding a pillow"],
  ["Acts of Nobility", "Blessing the harvest. The harvest is a sandwich", "solemnly blessing a sandwich presented on a golden platter"],
  ["Acts of Nobility", "{name} unveiling a statue of {name}", "proudly unveiling a marble statue of themselves"],
  ["Modern Peasantry", "Untangling headphones for all eternity", "untangling a hopeless knot of headphone wires, despairing"],
  ["Modern Peasantry", "{name} roaming the house hunting wifi signal", "wandering with a phone raised high overhead, hunting for signal"],
  ["Modern Peasantry", "Forgetting why you walked into the room", "standing puzzled in a doorway, having forgotten why they came"],
  ["Modern Peasantry", "Parallel parking under public observation", "parallel parking a tiny carriage while a crowd watches, sweating"],
  ["Modern Peasantry", "A pickle jar that will not open. Rising panic", "straining red-faced to open a stubborn pickle jar"],
  ["Modern Peasantry", "Pretending to understand the group chat", "squinting at a phone, utterly baffled"],
  ["Modern Peasantry", "{name} discovering the milk is empty mid-pour", "pouring from an empty milk jug over cereal, betrayed expression"],
  ["Modern Peasantry", "Taking 47 selfies, keeping none", "taking a selfie with pursed lips, phone held aloft"],
  ["Modern Peasantry", "Silencing the alarm without waking up", "slapping a ringing alarm clock while still fully asleep"],
  ["Modern Peasantry", "Flat-pack furniture, no manual, much hubris", "sitting defeated among flat-pack furniture parts, holding one tiny tool"],
  ["Modern Peasantry", "Realizing you've been on mute the whole meeting", "gesturing passionately into a headset that is on mute"],
  ["Modern Peasantry", "Chasing a receipt in the wind", "chasing a windblown paper receipt down the street"],
  ["Beasts of the Realm", "A pigeon with somewhere important to be", "strutting exactly like a pigeon with somewhere important to be"],
  ["Beasts of the Realm", "A cat ignoring its own name", "sitting like a cat, pointedly ignoring everyone calling them"],
  ["Beasts of the Realm", "A dog hearing the treat drawer open", "perking up ecstatically like a dog hearing the treat drawer"],
  ["Beasts of the Realm", "A giraffe using a water fountain", "bending awkwardly like a giraffe over a tiny water fountain"],
  ["Beasts of the Realm", "A crab late for work", "scuttling sideways like a crab, clutching a small briefcase"],
  ["Beasts of the Realm", "A peacock at a job interview", "posing like a displaying peacock while seated at an interview desk"],
  ["Beasts of the Realm", "A T-rex making the bed", "trying to make a bed with tiny T-rex arms held close"],
  ["Beasts of the Realm", "A goose holding a grudge", "glowering like a furious goose, neck extended"],
  ["Beasts of the Realm", "A sloth in a genuine hurry", "running in extremely slow motion like a sloth late for something"],
  ["Beasts of the Realm", "An octopus folding laundry", "folding laundry with far too many arms at once"],
  ["Beasts of the Realm", "A llama judging you silently", "staring with silent llama-like judgment, chin raised"],
  ["Beasts of the Realm", "A penguin on an escalator", "standing proudly like a penguin riding an escalator"],
  ["The Family Archive", "{name} dancing at a wedding", "dancing exuberantly at a wedding, arms flailing"],
  ["The Family Archive", "{name}'s driving-test face", "gripping a steering wheel with a terrified driving-test face"],
  ["The Family Archive", "{name} tasting something they claim to love", "tasting food they claim to love, barely hiding disgust"],
  ["The Family Archive", "{name} answering an unknown number", "answering a telephone call from an unknown number with deep suspicion"],
  ["The Family Archive", "{name} pretending the gift is exactly what they wanted", "holding up an unwanted gift with a fixed, unconvincing smile"],
  ["The Family Archive", "{name} on a rollercoaster", "screaming on a plunging rollercoaster, hair blown back"],
  ["The Family Archive", "{name} at the buffet, hour three", "surveying a banquet table at hour three, plate stacked absurdly high"],
  ["The Family Archive", "{name} losing a board game gracefully (badly)", "flipping a board game table in gracious defeat"],
  ["The Family Archive", "{name} explaining their fantasy league strategy", "explaining an elaborate strategy chart to a visibly bored audience"],
  ["The Family Archive", "{name} sneaking a midnight snack", "sneaking a midnight snack from the pantry by candlelight"],
  ["The Family Archive", "{name}'s signature photo smile", "striking their signature photo smile, slightly too wide"],
  ["The Family Archive", "{name} watching a scary movie through their fingers", "peeking at something terrifying through their fingers"],
];

// Kept in sync with dg-render's SCENE_PROMPTS — same four styles, same visual language,
// so the free pre-purchase preview scenes and the post-purchase full deck match.
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

// Calls Claude to write the printed deck's "House Rules" blurb, grounded in the
// oracle "about them" text the buyer gave at checkout. Kept explicitly easy/guessable
// per product direction — the personalization is the joke, not the difficulty.
async function generateInstructionsCopy(
  supabase: any,
  subjectName: string,
  artStyle: string,
  aboutText: string | null,
): Promise<string | null> {
  try {
    const { data: key } = await supabase.rpc("dg_get_secret", { secret_name: "ANTHROPIC_API_KEY" });
    if (!key) return null;
    const categories = Array.from(new Set(SCENES.map((s) => s[0])));
    const about = (aboutText ?? "").trim().slice(0, 500);
    const prompt = `Write the "House Rules" card for a personalized charades deck called The Parlour Deck.
Subject: ${subjectName}. Art style: ${artStyle}. Card categories: ${categories.join(", ")}.
${about ? `Something true about ${subjectName}, from the person who ordered this deck (use one or two specific, affectionate details from this if usable — never mocking, never anything embarrassing): "${about}"` : ""}

Voice: mock-heraldic parlour-game humor, like a slightly self-important 18th-century games manual crossed with a warm family roast. Dry, a little pompous, affectionate. House copy for reference: "Fifty-four charades cards. One recurring subject. Currently screaming WEDDING! DANCING! IT'S DAVE AT THE WEDDING!"

Hard requirements:
- 100-160 words, plain prose paragraphs, no markdown headers or bullet lists, no emoji.
- Cover: how a turn works (one actor, no talking, teammates shout guesses, pass if stuck), that it's pass-and-play, and a one-line nod to the categories.
- Explicitly keep the game EASY and fast to guess — the joke is the personalization, not the difficulty. Do not propose harder rules, obscure prompts, or added penalties.
- End with one short, warm line about ${subjectName}.
Return only the finished house-rules text, nothing else.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 1200) : null;
  } catch (_e) {
    return null;
  }
}

async function sendDeckReadyEmail(
  supabase: any,
  to: string,
  orderId: string,
  rendered: number,
  failed: number,
  instructionsCopy: string | null,
) {
  try {
    const { data: brevoKey } = await supabase.rpc("dg_get_secret", { secret_name: "BREVO_API_KEY" });
    if (!brevoKey) return;
    const link = `${SITE}/deck-ready.html?order=${orderId}`;
    const note = failed
      ? `${rendered} of ${rendered + failed} scenes came out perfectly; the atelier's easel jammed on the rest, which is either art or a bug.`
      : `All ${rendered} scenes came out. The atelier is, for once, quite pleased with itself.`;
    const rulesSection = instructionsCopy
      ? `<div style="background:#F5F1E6;border:1px solid #D8D0BC;border-radius:6px;padding:20px 22px;margin:0 0 20px;">
      <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#A87F1F;margin:0 0 8px;">House Rules</p>
      <p style="font-size:14px;line-height:1.7;margin:0;">${instructionsCopy.replace(/\n+/g, "</p><p style=\"font-size:14px;line-height:1.7;margin:10px 0 0;\">")}</p>
    </div>`
      : "";
    const html = `
<div style="background:#F5F1E6;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#1E3329;">
  <div style="max-width:560px;margin:0 auto;background:#FDFBF4;border:1px solid #D8D0BC;border-radius:6px;padding:32px;">
    <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#A87F1F;margin:0 0 12px;">DoppelGifter · Fine Commemorative Goods</p>
    <h1 style="font-size:28px;margin:0 0 16px;font-weight:normal;">Their full deck is ready.</h1>
    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">${note}</p>
    <p style="text-align:center;margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#B03A2E;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:bold;">View the full deck →</a></p>
    ${rulesSection}
    <p style="font-size:14px;line-height:1.6;color:#52655B;margin:0 0 8px;"><b>Worth knowing:</b> playing-card printing puts one design on the back of every card — that's how the physical deck's presses work, not a DoppelGifter limit. The printed deck carries your favorite scene from this gallery; the gallery itself is the full digital keepsake, all their faces, every scene.</p>
    <p style="font-size:13px;color:#52655B;line-height:1.6;margin:16px 0 0;">Order reference: ${orderId.slice(0, 8).toUpperCase()}. Questions? Just reply.</p>
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
        subject: `Their full deck is ready — ${rendered} scenes, one face 🎴`,
        htmlContent: html,
      }),
    });
  } catch (_) {
    // email failure must never block the render pipeline
  }
}

async function processBatch(
  supabase: any,
  orderId: string,
  photoUrl: string,
  subjectName: string,
  buyerEmail: string | null,
  startIndex: number,
  artStyle: string,
  aboutText: string | null,
) {
  try {
    const { data: token } = await supabase.rpc("dg_get_secret", { secret_name: "REPLICATE_API_TOKEN" });
    if (!token) throw new Error("no replicate token");
    const scenePrompt = SCENE_PROMPTS[artStyle] ?? SCENE_PROMPTS.renaissance;

    const { data: existing } = await supabase.from("dg_orders").select("deck_art").eq("id", orderId).single();
    const results: { category: string; prompt: string; art_url: string }[] = Array.isArray(existing?.deck_art)
      ? existing.deck_art.slice()
      : [];

    async function renderOne(idx: number, entry: [string, string, string]) {
      const [category, display, key] = entry;
      const res = await fetch("https://api.replicate.com/v1/models/openai/gpt-image-2/predictions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=60" },
        body: JSON.stringify({
          input: {
            prompt: scenePrompt(key),
            quality: "low",
            aspect_ratio: "2:3",
            output_format: "webp",
            number_of_images: 1,
            input_images: [photoUrl],
          },
        }),
      });
      let pred = await res.json();
      let polls = 0;
      const MAX_POLLS = 30; // 30 * 2.5s = 75s of polling beyond the initial 60s wait
      while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
        if (++polls > MAX_POLLS) throw new Error(`scene ${idx} stuck in ${pred.status ?? "unknown"} past poll budget`);
        await new Promise((r) => setTimeout(r, 2500));
        const poll = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } });
        pred = await poll.json();
      }
      await supabase.from("dg_renders").insert({
        session_key: `order:${orderId}`,
        stage: `deck:${idx}`,
        quality: "low",
        est_cost_cents: 1.6,
        status: pred.status,
        output_url: Array.isArray(pred.output) ? pred.output[0] ?? null : pred.output ?? null,
      });
      if (pred.status !== "succeeded") throw new Error(pred.error ?? `scene ${idx} failed`);
      const replicateUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      const bytes = new Uint8Array(await (await fetch(replicateUrl)).arrayBuffer());
      const path = `${orderId}/card-${String(idx).padStart(2, "0")}.webp`;
      const { error: upErr } = await supabase.storage
        .from("dg-art")
        .upload(path, bytes, { contentType: "image/webp", upsert: true });
      const artUrl = upErr ? replicateUrl : supabase.storage.from("dg-art").getPublicUrl(path).data.publicUrl;
      return { category, prompt: display.replace(/\{name\}/g, subjectName), art_url: artUrl };
    }

    const batch = SCENES.slice(startIndex, startIndex + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((entry, j) => withTimeout(renderOne(startIndex + j, entry), PER_SCENE_TIMEOUT_MS, `scene ${startIndex + j}`)),
    );
    for (const r of settled) if (r.status === "fulfilled") results.push(r.value);

    await supabase.from("dg_orders").update({ deck_art: results, deck_status: "rendering" }).eq("id", orderId);

    const nextIndex = startIndex + CONCURRENCY;
    if (nextIndex < SCENES.length) {
      // Chain to a FRESH invocation for the next batch — its own execution budget,
      // independent of this one. Retry once in case of a transient network blip.
      const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const trigger = () =>
        fetch(SELF_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}` },
          body: JSON.stringify({
            order_id: orderId,
            photo_url: photoUrl,
            subject_name: subjectName,
            buyer_email: buyerEmail,
            start_index: nextIndex,
            art_style: artStyle,
            about_text: aboutText,
          }),
        });
      try {
        await trigger();
      } catch (_) {
        await trigger().catch(async () => {
          await supabase.from("dg_orders").update({ deck_status: "failed" }).eq("id", orderId);
        });
      }
    } else {
      const totalFailed = SCENES.length - results.length;
      const instructionsCopy = await generateInstructionsCopy(supabase, subjectName, artStyle, aboutText);
      await supabase
        .from("dg_orders")
        .update({
          deck_art: results,
          deck_status: totalFailed ? "partial" : "ready",
          ...(instructionsCopy ? { instructions_copy: instructionsCopy } : {}),
        })
        .eq("id", orderId);
      if (buyerEmail) {
        await sendDeckReadyEmail(supabase, buyerEmail, orderId, results.length, totalFailed, instructionsCopy);
      }
    }
  } catch (_e) {
    await supabase.from("dg_orders").update({ deck_status: "failed" }).eq("id", orderId);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { order_id, photo_url, subject_name, buyer_email, start_index, art_style, about_text } = body;
  if (typeof order_id !== "string" || typeof photo_url !== "string" || typeof start_index !== "number") {
    return new Response("missing fields", { status: 400 });
  }
  const artStyle = typeof art_style === "string" && SCENE_PROMPTS[art_style] ? art_style : "renaissance";
  const aboutText = typeof about_text === "string" ? about_text.slice(0, 500) : null;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const bg = processBatch(
    supabase,
    order_id,
    photo_url,
    subject_name || "Dave",
    buyer_email ?? null,
    start_index,
    artStyle,
    aboutText,
  );
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(bg);
  else await bg;
  return new Response("ok", { status: 200 });
});
