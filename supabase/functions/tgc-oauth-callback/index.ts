// One-time OAuth-style bootstrap for The Game Crafter's API.
// TGC's SSO flow requires a human to visit an authorization URL once (their
// account owner logging into TGC and granting scopes); TGC then redirects here
// with an sso_id, which we exchange for a long-lived session id and store in
// the vault. After this one-time step, all future deck/card/order calls are
// fully automated server-to-server — no further human involvement.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://doppelgifter.com";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const ssoId = url.searchParams.get("sso_id");
  if (!ssoId) {
    return new Response("Missing sso_id — did you land here directly instead of via the TGC authorization redirect?", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: privateKey } = await supabase.rpc("dg_get_secret", { secret_name: "TGC_PRIVATE_KEY" });
  if (!privateKey) {
    return new Response("Server configuration error: TGC_PRIVATE_KEY not found", { status: 500 });
  }

  const res = await fetch(`https://www.thegamecrafter.com/api/session/sso/${encodeURIComponent(ssoId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ private_key: privateKey }).toString(),
  });
  const body = await res.json();
  // TGC's Wing API wraps successful payloads as {"result": {...}}.
  const session = body?.result ?? body;
  if (!res.ok || !session?.id) {
    return new Response(
      `Session exchange failed: ${JSON.stringify(body).slice(0, 500)}`,
      { status: 502 },
    );
  }

  // Store the session for reuse by future automated calls (deck/card/cart/order).
  await supabase.rpc("dg_set_secret", { secret_name: "TGC_SESSION_ID", secret_value: session.id });
  await supabase.rpc("dg_set_secret", { secret_name: "TGC_USER_ID", secret_value: String(session.user_id ?? "") });

  return Response.redirect(`${SITE}/tgc-connected.html?ok=1`, 302);
});
