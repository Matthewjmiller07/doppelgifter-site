// Builds a private Game+Deck+Cards+TuckBox+Document on The Game Crafter for a
// completed Parlour Deck order, ready to review in the TGC dashboard. Does NOT
// add anything to a cart or place an order — that stays a manual, explicitly-
// approved step until this pipeline has been proven out on real orders.
//
// Field shapes below were confirmed against TGC's live API (not just docs) on
// 2026-07-21: Game defaults to private (public:0); Deck identity "PokerDeck";
// Card face/back images must be exactly 825x1125px PNG/JPEG; bulk-cards takes a
// JSON-string `cards` form field, max 100/call; Document needs `identity`
// despite docs not mentioning it ("SmallBooklet" confirmed working) and a
// `pdf_id` File for its actual content.
//
// TuckBox outside art (2325x1950px) panel layout was reverse-engineered from
// TGC's own downloadable template/proofing-overlay PNGs (thegamecrafter.com/
// make/products/PokerTuckBox54 → "Templates" section) by detecting the blue
// dashed "safe zone" rectangles programmatically. See BOX_PANELS below.
//
// Box/PDF visual identity is chosen per order via STYLE_THEMES, keyed on the
// order's art_style (renaissance/cartoon/glamour/marble) — same four styles
// used for the card art itself, so the printed box/booklet matches the deck.
//
// Auth: verify_jwt is on (blocks fully anonymous requests) AND the caller must send
// header x-admin-secret matching DG_ADMIN_SECRET — verify_jwt alone isn't enough
// since the public anon key is valid client-side and would otherwise let anyone
// trigger real TGC object creation. Server-side callers (dg-deck-batch's
// auto-trigger once a deck finishes rendering, and this function chaining to
// itself below) fetch the secret themselves and send the same header.
//
// 2026-07-24: rewritten to chain across invocations, one small card-upload batch
// (or the finalize step) per invocation, resuming from `dg_orders.tgc_fulfill_state`
// rather than trusting the caller's start index. Exists because the original
// single-shot version hit a platform WORKER_RESOURCE_LIMIT above ~8 cards in one
// invocation (confirmed live: 2 of 8 succeeded before the second internal chunk
// of UPLOAD_CONCURRENCY crashed the same worker) — the first chunk of 6 alone
// did NOT crash, so giving every batch a fresh invocation (same pattern
// dg-deck-batch already uses for rendering, for the same 150s/memory ceiling)
// should hold for all 48 cards of a real order.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Image, TextLayout } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

const TGC_API = "https://www.thegamecrafter.com/api";
const CARD_W = 825;
const CARD_H = 1125;
const UPLOAD_CONCURRENCY = 6;
const SELF_URL = "https://knbyyykfwwlgnizutqyb.supabase.co/functions/v1/dg-tgc-fulfill";
const TGC_ORDER_URL = "https://knbyyykfwwlgnizutqyb.supabase.co/functions/v1/dg-tgc-order";

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

async function fetchAndCover(url: string, w: number, h: number) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const img = await Image.decode(bytes);
  return img.cover(w, h);
}

// The card art alone doesn't tell the actor what to act out — a charades card
// is useless without the prompt printed on it. Composites a caption band across
// the bottom of the cropped card face: the scene category (small, accent) and
// the actual phrase to act out (large, wrapped), on a solid panel so it stays
// readable over any art.
const CAPTION_H = 220;
async function composeCardFace(
  fontBytes: Uint8Array,
  theme: (typeof STYLE_THEMES)[string],
  img: InstanceType<typeof Image>,
  category: string,
  phrase: string,
): Promise<Uint8Array> {
  const band = new Image(CARD_W, CAPTION_H);
  band.fill(theme.panelBg);
  img.composite(band, 0, CARD_H - CAPTION_H);

  const catImg = Image.renderText(
    fontBytes,
    24,
    category.toUpperCase(),
    theme.accent,
    new TextLayout({ maxWidth: CARD_W - 60, maxHeight: 36, wrapStyle: "word", verticalAlign: "center" }),
  );
  img.composite(catImg, 30, CARD_H - CAPTION_H + 14);

  const phraseImg = Image.renderText(
    fontBytes,
    38,
    phrase,
    theme.text,
    new TextLayout({ maxWidth: CARD_W - 60, maxHeight: CAPTION_H - 60, wrapStyle: "word", verticalAlign: "center" }),
  );
  img.composite(phraseImg, 30, CARD_H - CAPTION_H + 56);

  return await img.encode();
}

// ---------------- Per-style visual identity ----------------
// Colors are 0xRRGGBBAA. Fonts are real TTFs hosted on Google Fonts' public,
// long-lived GitHub repo — same four styles as the card art itself, so the box
// and booklet always match whatever style the buyer picked.
const STYLE_THEMES: Record<
  string,
  { bg: number; panelBg: number; accent: number; text: number; fontUrl: string; tagline: string }
> = {
  renaissance: {
    bg: 0x142720ff,
    panelBg: 0x1c332aff,
    accent: 0xc8a028ff,
    text: 0xede6d3ff,
    fontUrl: "https://raw.githubusercontent.com/google/fonts/main/ofl/cinzeldecorative/CinzelDecorative-Bold.ttf",
    tagline: "Every card, their face.",
  },
  cartoon: {
    bg: 0xffb703ff,
    panelBg: 0xfb8500ff,
    accent: 0x1e3329ff,
    text: 0x1e1e1eff,
    fontUrl: "https://raw.githubusercontent.com/google/fonts/main/ofl/bangers/Bangers-Regular.ttf",
    tagline: "Every card, their face!",
  },
  glamour: {
    bg: 0x1a0b2eff,
    panelBg: 0x2d1b4eff,
    accent: 0xff2fb0ff,
    text: 0x2fe6d8ff,
    fontUrl: "https://raw.githubusercontent.com/google/fonts/main/ofl/righteous/Righteous-Regular.ttf",
    tagline: "Every card, their face.",
  },
  marble: {
    bg: 0xe8e6e1ff,
    panelBg: 0xd7d3caff,
    accent: 0x6b5b3dff,
    text: 0x2b2b2bff,
    fontUrl: "https://raw.githubusercontent.com/google/fonts/main/ofl/marcellus/Marcellus-Regular.ttf",
    tagline: "Every card, their face.",
  },
};

// ---------------- TuckBox outside-art panel geometry ----------------
// Measured empirically from thegamecrafter.com's own 54-card-tuck-box.png
// template (2325x1950) by detecting the blue dashed "safe zone" rectangles.
// FRONT/BACK naming is a best-effort read of the layout (the panel under the
// flap with the thumb-notch cutout is treated as FRONT); getting this backwards
// has no functional consequence, it would just show the tagline-panel instead
// of the hero-art panel facing outward on the shelf.
const BOX_W = 2325;
const BOX_H = 1950;
const PAD = 20;
const FRONT = { x: 1303, y: 444, w: 717, h: 1028 };
const BACK = { x: 293, y: 444, w: 728, h: 1028 };
const TOPFLAP = { x: 293, y: 205, w: 728, h: 206 };
const BOTFLAP = { x: 293, y: 1506, w: 728, h: 198 };
const SIDE_PANELS = [
  { x: 57, y: 444, w: 76, h: 1028 },
  { x: 184, y: 444, w: 75, h: 1028 },
  { x: 1061, y: 444, w: 73, h: 1028 },
  { x: 1181, y: 444, w: 73, h: 1028 },
];

async function buildTuckBoxOutside(
  theme: (typeof STYLE_THEMES)[string],
  frontArtImg: InstanceType<typeof Image>,
  subjectName: string,
  aboutText: string | null,
): Promise<Uint8Array> {
  const canvas = new Image(BOX_W, BOX_H);
  canvas.fill(theme.bg);

  const fillPanel = (rect: { x: number; y: number; w: number; h: number }) => {
    const p = new Image(rect.w, rect.h);
    p.fill(theme.panelBg);
    canvas.composite(p, rect.x, rect.y);
  };
  fillPanel(BACK);
  fillPanel(TOPFLAP);
  fillPanel(BOTFLAP);
  SIDE_PANELS.forEach(fillPanel);

  // Front panel: the actual rendered card art, cover-cropped to fit.
  canvas.composite(frontArtImg.clone().cover(FRONT.w, FRONT.h), FRONT.x, FRONT.y);

  const fontBytes = new Uint8Array(await (await fetch(theme.fontUrl)).arrayBuffer());
  const centered = (img: InstanceType<typeof Image>, rect: { x: number; y: number; w: number }, yOff: number) =>
    canvas.composite(img, rect.x + Math.round((rect.w - img.width) / 2), yOff);

  const title = Image.renderText(
    fontBytes,
    58,
    "THE PARLOUR DECK",
    theme.text,
    new TextLayout({ maxWidth: BACK.w - PAD * 2, maxHeight: 150, wrapStyle: "word", verticalAlign: "center" }),
  );
  centered(title, BACK, BACK.y + PAD);

  const nameImg = Image.renderText(
    fontBytes,
    42,
    `starring ${subjectName}`,
    theme.accent,
    new TextLayout({ maxWidth: BACK.w - PAD * 2, maxHeight: 100, wrapStyle: "word", verticalAlign: "center" }),
  );
  centered(nameImg, BACK, BACK.y + PAD + title.height + 20);

  // Short flavor line: prefer a compact clip of the oracle text (what the buyer
  // told us about the subject) so the box itself reflects it, not just the
  // printed booklet; fall back to the style's generic tagline.
  const short = (aboutText ?? "").trim();
  const flavor = short && short.length <= 70 ? short : short ? short.slice(0, 67).trimEnd() + "…" : theme.tagline;
  const tagImg = Image.renderText(
    fontBytes,
    30,
    flavor,
    theme.text,
    new TextLayout({
      maxWidth: BACK.w - PAD * 2,
      maxHeight: BACK.h - (PAD * 3 + title.height + nameImg.height),
      wrapStyle: "word",
      verticalAlign: "center",
    }),
  );
  centered(tagImg, BACK, BACK.y + PAD * 2 + title.height + nameImg.height);

  const brand = Image.renderText(
    fontBytes,
    24,
    "DOPPELGIFTER",
    theme.accent,
    new TextLayout({ maxWidth: TOPFLAP.w - PAD * 2, maxHeight: TOPFLAP.h - PAD * 2, wrapStyle: "word", verticalAlign: "center" }),
  );
  canvas.composite(
    brand,
    TOPFLAP.x + Math.round((TOPFLAP.w - brand.width) / 2),
    TOPFLAP.y + Math.round((TOPFLAP.h - brand.height) / 2),
  );

  return await canvas.encode();
}

// ---------------- Instructions PDF ----------------
function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    lines.push("");
  }
  return lines;
}

// A "SmallBooklet" Document's pages must match the deck's own card footprint
// (confirmed live: TGC rejected a US-Letter PDF with "pdf_id must be 825x1125
// or 1125x825") — i.e. 2.75x3.75in at 300dpi, or 198x270pt. That's tiny, so the
// house rules paginate across several small pages like a real mini rulebook
// rather than one dense sheet.
const BOOKLET_W = 198;
const BOOKLET_H = 270;

async function buildInstructionsPdf(
  theme: (typeof STYLE_THEMES)[string],
  subjectName: string,
  houseRules: string,
  coverPng: Uint8Array,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const displayFontBytes = await (await fetch(theme.fontUrl)).arrayBuffer();
  const displayFont = await pdf.embedFont(displayFontBytes);
  const bodyFont = await pdf.embedFont(StandardFonts.TimesRoman);
  const rgbOf = (color: number) => {
    const r = (color >>> 24) & 0xff, g = (color >>> 16) & 0xff, b = (color >>> 8) & 0xff;
    return rgb(r / 255, g / 255, b / 255);
  };
  const newPage = () => {
    const p = pdf.addPage([BOOKLET_W, BOOKLET_H]);
    p.drawRectangle({ x: 0, y: 0, width: BOOKLET_W, height: BOOKLET_H, color: rgbOf(theme.bg) });
    return p;
  };

  // Cover page
  const cover = newPage();
  const coverImg = await pdf.embedPng(coverPng);
  const coverW = BOOKLET_W - 40;
  const coverH = coverW * (coverImg.height / coverImg.width);
  const coverY = BOOKLET_H - 24 - coverH;
  cover.drawImage(coverImg, { x: (BOOKLET_W - coverW) / 2, y: coverY, width: coverW, height: coverH });

  const title = "THE PARLOUR DECK";
  const titleSize = 12;
  cover.drawText(title, {
    x: (BOOKLET_W - displayFont.widthOfTextAtSize(title, titleSize)) / 2,
    y: coverY - 16,
    size: titleSize,
    font: displayFont,
    color: rgbOf(theme.text),
  });

  const sub = `starring ${subjectName}`;
  const subSize = 8;
  cover.drawText(sub, {
    x: (BOOKLET_W - displayFont.widthOfTextAtSize(sub, subSize)) / 2,
    y: coverY - 30,
    size: subSize,
    font: displayFont,
    color: rgbOf(theme.accent),
  });

  // Body pages: paginate the house-rules text across as many small pages as needed.
  const margin = 16;
  const bodySize = 7.5;
  const lineHeight = bodySize * 1.4;
  const maxWidth = BOOKLET_W - margin * 2;
  const lines = wrapText(houseRules, bodyFont, bodySize, maxWidth);

  let page = newPage();
  let y = BOOKLET_H - margin - 4;
  const heading = "HOUSE RULES";
  const headingSize = 9;
  page.drawText(heading, { x: margin, y, size: headingSize, font: displayFont, color: rgbOf(theme.accent) });
  y -= headingSize + 10;

  for (const line of lines) {
    if (y < margin) {
      page = newPage();
      y = BOOKLET_H - margin - 4;
    }
    if (line) {
      page.drawText(line, { x: margin, y, size: bodySize, font: bodyFont, color: rgbOf(theme.text) });
    }
    y -= lineHeight;
  }

  // TGC's own PDF parser (their backend is Perl) fails on pdf-lib's default
  // PDF 1.5+ compressed cross-reference streams with a bare "Error reading PDF" —
  // confirmed by isolating it against a minimal repro. Forcing the classic
  // plain-text xref table keeps it readable by older/stricter parsers.
  return await pdf.save({ useObjectStreams: false });
}

type FulfillState = {
  game_id: string;
  game_edit_uri?: string;
  deck_id: string;
  folder_id: string;
  subject_name: string;
  next_index: number;
  uploaded: { name: string; face_id: string }[];
  failures: { idx: number; error: string }[];
  tuckbox_id?: string;
  document_id?: string;
  box_file_id?: string | null;
  pdf_file_id?: string | null;
  completed?: boolean;
};

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
  // making it callable only by whoever is manually triggering fulfillment, or by
  // trusted server-side callers (dg-deck-batch, and this function chaining itself)
  // that fetch the same secret from the vault before calling.
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

  const entries = order.deck_art as { category: string; prompt: string; art_url: string }[];
  // Resume from persisted state rather than trusting a caller-supplied index —
  // makes retries/duplicate triggers safe instead of creating a second Game.
  let state: FulfillState | null = (order.tgc_fulfill_state as FulfillState | null) ?? null;
  if (state?.completed) {
    return json({ ok: true, already_done: true, game_id: state.game_id, note: "dg-tgc-fulfill already completed for this order." });
  }

  const artStyle = STYLE_THEMES[order.art_style] ? order.art_style : "renaissance";
  const theme = STYLE_THEMES[artStyle];

  try {
    const { data: sessionId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_SESSION_ID" });
    const { data: designerId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_DESIGNER_ID" });
    const { data: userId } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_USER_ID" });
    if (!sessionId || !designerId || !userId) return json({ error: "TGC not configured" }, 500);

    // ---- First hop only: create the Game + Deck once, init resumable state ----
    if (!state) {
      const user = await tgc(sessionId, `/user/${userId}`);
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
      state = {
        game_id: game.id,
        game_edit_uri: game.edit_uri,
        deck_id: deck.id,
        folder_id: user.root_folder_id,
        subject_name: subjectName,
        next_index: 0,
        uploaded: [],
        failures: [],
      };
      await supabase.from("dg_orders").update({ tgc_fulfill_state: state }).eq("id", orderId);
    }

    // ---- Card uploads: one small batch per invocation, then chain to a fresh
    // invocation for the next one (see file header for why UPLOAD_CONCURRENCY
    // per invocation, never more, is the safe boundary).
    if (state.next_index < entries.length) {
      const cardFontBytes = new Uint8Array(await (await fetch(theme.fontUrl)).arrayBuffer());
      const startIdx = state.next_index;
      const batch = entries.slice(startIdx, startIdx + UPLOAD_CONCURRENCY);
      const folderId = state.folder_id;

      async function uploadOne(idx: number, entry: { category: string; prompt: string; art_url: string }) {
        const cropped = await fetchAndCover(entry.art_url, CARD_W, CARD_H);
        const captioned = await composeCardFace(cardFontBytes, theme, cropped, entry.category, entry.prompt);
        const file = await tgcUploadFile(sessionId, folderId, `card-${String(idx).padStart(2, "0")}.png`, captioned, "image/png");
        return { name: entry.prompt.slice(0, 60), face_id: file.id };
      }

      const settled = await Promise.allSettled(batch.map((e, j) => uploadOne(startIdx + j, e)));
      settled.forEach((r, j) => {
        if (r.status === "fulfilled") state!.uploaded.push(r.value);
        else {
          const reason = (r as PromiseRejectedResult).reason;
          state!.failures.push({ idx: startIdx + j, error: String(reason?.message ?? reason) });
        }
      });
      state.next_index = startIdx + batch.length;
      await supabase.from("dg_orders").update({ tgc_fulfill_state: state }).eq("id", orderId);

      // Chain forward to a fresh invocation — including the finalize-only hop
      // once every card is uploaded, so finalize never shares a worker with a
      // card-upload batch. Awaited (not fire-and-forget) so the request actually
      // goes out before this invocation's response ends its lifecycle.
      const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      await fetch(SELF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}`, "x-admin-secret": adminSecret },
        body: JSON.stringify({ order_id: orderId }),
      }).catch(() => {});

      return json({
        ok: true,
        batch_done: true,
        uploaded_so_far: state.uploaded.length,
        failed_so_far: state.failures.length,
        next_index: state.next_index,
        total: entries.length,
      });
    }

    // ---- Finalize: bulk-create Cards, TuckBox + Document, box art + PDF ----
    let bulkResult: any = null;
    for (let i = 0; i < state.uploaded.length; i += 100) {
      const chunk = state.uploaded.slice(i, i + 100);
      bulkResult = await tgc(sessionId, `/deck/${state.deck_id}/bulk-cards`, "POST", { cards: JSON.stringify(chunk) });
    }

    const tuckbox = await tgc(sessionId, "/tuckbox", "POST", {
      name: "Parlour Deck Box",
      game_id: state.game_id,
      identity: "PokerTuckBox54",
    });
    const document = await tgc(sessionId, "/document", "POST", {
      name: "House Rules",
      game_id: state.game_id,
      identity: "SmallBooklet",
    });

    // Box + booklet art: styled per art_style, personalized with the subject's
    // actual rendered card art and (for the box tagline) the oracle "about them"
    // text captured at checkout.
    let boxFileId: string | null = null;
    let pdfFileId: string | null = null;
    try {
      const frontArtImg = await Image.decode(
        new Uint8Array(await (await fetch(entries[0].art_url)).arrayBuffer()),
      );
      const boxPng = await buildTuckBoxOutside(theme, frontArtImg, state.subject_name, order.about_text ?? null);
      const boxFile = await tgcUploadFile(sessionId, state.folder_id, "tuckbox-outside.png", boxPng, "image/png");
      boxFileId = boxFile.id;
      await tgc(sessionId, `/tuckbox/${tuckbox.id}`, "PUT", { outside_id: boxFileId });

      const cardCoverPng = await (await fetchAndCover(entries[0].art_url, CARD_W, CARD_H)).encode();
      const pdfBytes = await buildInstructionsPdf(
        theme,
        state.subject_name,
        order.instructions_copy || `The Parlour Deck. ${theme.tagline}`,
        cardCoverPng,
      );
      const pdfFile = await tgcUploadFile(sessionId, state.folder_id, "house-rules.pdf", pdfBytes, "application/pdf");
      pdfFileId = pdfFile.id;
      await tgc(sessionId, `/document/${document.id}`, "PUT", { pdf_id: pdfFileId });
    } catch (e) {
      state.failures.push({ idx: -1, error: `box/pdf: ${String((e as Error)?.message ?? e)}` });
    }

    state.tuckbox_id = tuckbox.id;
    state.document_id = document.id;
    state.box_file_id = boxFileId;
    state.pdf_file_id = pdfFileId;
    state.completed = true;
    await supabase.from("dg_orders").update({ tgc_fulfill_state: state, tgc_game_id: state.game_id }).eq("id", orderId);

    // ---- Auto-chain a dry-run cart preview via dg-tgc-order — strictly
    // read-only against TGC (reports cart total vs current shop-credit balance).
    // NEVER passes confirm:true here: placing the real paid order stays a
    // deliberate, separate, human-triggered action, gated on shop credit being
    // funded by hand (no TGC API exists to fund it).
    let orderPreview: any = null;
    try {
      const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const res = await fetch(TGC_ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}`, "x-admin-secret": adminSecret },
        body: JSON.stringify({ order_id: orderId }),
      });
      orderPreview = await res.json();
      await supabase.from("dg_orders").update({ tgc_order_preview: orderPreview }).eq("id", orderId);
    } catch (e) {
      orderPreview = { error: String((e as Error)?.message ?? e) };
    }

    return json({
      ok: true,
      finalized: true,
      game_id: state.game_id,
      game_edit_uri: state.game_edit_uri,
      deck_id: state.deck_id,
      tuckbox_id: tuckbox.id,
      document_id: document.id,
      box_file_id: boxFileId,
      pdf_file_id: pdfFileId,
      art_style: artStyle,
      cards_uploaded: state.uploaded.length,
      cards_failed: state.failures.length,
      failures: state.failures,
      bulk_result: bulkResult,
      order_preview: orderPreview,
      note: "Game/Deck/Cards/Box/Document built; cart preview run in dry-run mode (see order_preview) — nothing charged. Call dg-tgc-order with confirm:true to place the real paid order once shop credit is funded.",
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
