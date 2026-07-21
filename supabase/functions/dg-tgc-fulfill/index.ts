// Builds a private Game+Deck+Cards+TuckBox on The Game Crafter for a completed
// Parlour Deck order, ready to review in the TGC dashboard. Does NOT add anything
// to a cart or place an order — that stays a manual, explicitly-approved step
// until this pipeline has been proven out on real orders.
//
// Field shapes below were confirmed against TGC's live API (not just docs) on
// 2026-07-21: Game defaults to private (public:0); Deck identity "PokerDeck";
// Card face/back images must be exactly 825x1125px PNG/JPEG (TuckBox outside art
// 2325x1950px); bulk-cards takes a JSON-string `cards` form field, max 100/call.
//
// Auth: verify_jwt is on (blocks fully anonymous requests) AND the caller must send
// header x-admin-secret matching DG_ADMIN_SECRET — verify_jwt alone isn't enough
// since the public anon key is valid client-side and would otherwise let anyone
// trigger real TGC object creation. Invoke manually per order once deck_status is
// "ready"; not wired into the automatic post-purchase pipeline yet.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const TGC_API = "https://www.thegamecrafter.com/api";
const CARD_W = 825;
const CARD_H = 1125;
const UPLOAD_CONCURRENCY = 6;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function subjectNameFromStyle(style: unknown): string {
  const m = /starring\s+(.+)$/i.exec(String(style ?? ""));
  const name = m?.[1]?.trim();
  return name && name.length <= 24 ? name : "Dave";
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
  if (!res.ok) throw new Error(`TGC ${method} ${path}: ${data?.error?.message ?? res.status}`);
  return data.result;
}

async function tgcUploadFile(sessionId: string, folderId: string, name: string, bytes: Uint8Array, mime: string) {
  const fd = new FormData();
  fd.set("session_id", sessionId);
  fd.set("folder_id", folderId);
  fd.set("name", name);
  fd.set("file", new Blob([bytes], { type: mime }), name);
  const res = await fetch(`${TGC_API}/file`, { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(`TGC file upload (${name}): ${data?.error?.message ?? res.status}`);
  return data.result;
}

// Cover-crop (not stretch) to TGC's exact required pixel size, since our art's
// 2:3 render ratio doesn't quite match the card's 11:15 print ratio.
async function toCardPng(artUrl: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await fetch(artUrl)).arrayBuffer());
  const img = await Image.decode(bytes);
  const cropped = img.cover(CARD_W, CARD_H);
  return await cropped.encode();
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
  if (typeof orderId !== "string") return json({ error: "order_id required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // verify_jwt only checks that SOME valid Supabase JWT was sent — the public anon
  // key (embedded client-side on every page) satisfies that. This function creates
  // real objects in the TGC account, so it additionally requires the admin secret,
  // making it callable only by whoever is manually triggering fulfillment.
  const { data: adminSecret } = await supabase.rpc("dg_get_secret", { secret_name: "DG_ADMIN_SECRET" });
  if (!adminSecret || req.headers.get("x-admin-secret") !== adminSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: order } = await supabase.from("dg_orders").select("*").eq("id", orderId).single();
  if (!order) return json({ error: "unknown order" }, 404);
  if (!["deck", "cards"].includes(order.product)) return json({ error: "not a deck product" }, 400);
  if (order.deck_status !== "ready" && order.deck_status !== "partial") {
    return json({ error: `deck not ready (status: ${order.deck_status})` }, 400);
  }
  if (!Array.isArray(order.deck_art) || !order.deck_art.length) return json({ error: "no deck art" }, 400);

  const { data: sessionId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_SESSION_ID" });
  const { data: designerId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_DESIGNER_ID" });
  const { data: userId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_USER_ID" });
  if (!sessionId || !designerId || !userId) return json({ error: "TGC not configured" }, 500);

  try {
    const user = await tgc(sessionId, `/user/${userId}`);
    const folderId = user.root_folder_id;
    const subjectName = subjectNameFromStyle(order.style);

    const game = await tgc(sessionId, "/game", "POST", {
      name: `Parlour Deck — ${subjectName} (order ${orderId.slice(0, 8)})`,
      designer_id: designerId,
      description: order.instructions_copy || "",
    });

    const deck = await tgc(sessionId, "/deck", "POST", {
      name: "Parlour Deck",
      game_id: game.id,
      identity: "PokerDeck",
    });

    const entries = order.deck_art as { category: string; prompt: string; art_url: string }[];
    const cardsPayload: { name: string; face_id: string }[] = [];
    const failures: { idx: number; error: string }[] = [];

    async function uploadOne(idx: number, entry: { prompt: string; art_url: string }) {
      const png = await toCardPng(entry.art_url);
      const file = await tgcUploadFile(sessionId, folderId, `card-${String(idx).padStart(2, "0")}.png`, png, "image/png");
      cardsPayload.push({ name: entry.prompt.slice(0, 60), face_id: file.id });
    }

    for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
      const chunk = entries.slice(i, i + UPLOAD_CONCURRENCY);
      const settled = await Promise.allSettled(chunk.map((e, j) => uploadOne(i + j, e)));
      settled.forEach((r, j) => {
        if (r.status === "rejected") failures.push({ idx: i + j, error: String(r.reason?.message ?? r.reason) });
      });
    }

    let bulkResult: any = null;
    // TGC's bulk-cards caps at 100 per call; we're always <=48, but chunk defensively.
    for (let i = 0; i < cardsPayload.length; i += 100) {
      const chunk = cardsPayload.slice(i, i + 100);
      bulkResult = await tgc(sessionId, `/deck/${deck.id}/bulk-cards`, "POST", { cards: JSON.stringify(chunk) });
    }

    const tuckbox = await tgc(sessionId, "/tuckbox", "POST", {
      name: "Parlour Deck Box",
      game_id: game.id,
      identity: "PokerTuckBox54",
    });

    // Instructions component: TGC requires a PDF (pdf_id) for a Document's actual
    // content, which we don't generate yet — this creates the placeholder component
    // so it exists in the game, but it stays un-proofed until a PDF is attached.
    const document = await tgc(sessionId, "/document", "POST", {
      name: "House Rules",
      game_id: game.id,
      identity: "SmallBooklet",
    });

    await supabase.from("dg_orders").update({ tgc_game_id: game.id }).eq("id", orderId);

    return json({
      ok: true,
      game_id: game.id,
      game_edit_uri: game.edit_uri,
      deck_id: deck.id,
      tuckbox_id: tuckbox.id,
      document_id: document.id,
      cards_uploaded: cardsPayload.length,
      cards_failed: failures.length,
      failures,
      bulk_result: bulkResult,
      note:
        "Private draft only — nothing added to cart or ordered. Deck back art, tuck box outside art, and the house-rules PDF are not yet attached (needs real box/back design + PDF generation, follow-up work). Review in TGC dashboard before proceeding.",
    });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
