// One-time OAuth install → permanent (offline) Admin API token.
// Needed when the Dev Dashboard app and the store are in different organizations
// (client credentials then fail with "shop_not_permitted").
//
//   GET /api/install    → redirects the store admin to Shopify's permission screen
//   GET /api/callback   → Shopify sends the admin back here; we verify it and show the token once
//
// After copying the token into the SHOPIFY_ACCESS_TOKEN environment variable you can
// leave these routes as they are: without a valid Shopify signature they do nothing.

export const SCOPES = "read_products,read_customers,read_draft_orders,write_draft_orders";

export async function handleInstall(request, env) {
  const url = new URL(request.url);
  const shop = env.SHOP_DOMAIN;
  if (!shop || !env.SHOPIFY_CLIENT_ID) return html(500, "Setup adhoora hai: SHOP_DOMAIN / SHOPIFY_CLIENT_ID missing.");

  const state = randomHex(16);
  const redirectUri = `${url.origin}${url.pathname.replace(/\/install\/?$/, "/callback")}`;
  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", env.SHOPIFY_CLIENT_ID);
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `gj_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const shop = q.get("shop");
  const code = q.get("code");
  const state = q.get("state");

  if (!shop || shop !== env.SHOP_DOMAIN) return html(400, "Galat store. SHOP_DOMAIN check karein.");
  if (!code || !state) return html(400, "Adhoori request. /api/install se dobara shuru karein.");

  const cookieState = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)gj_oauth_state=([0-9a-f]+)/);
  if (!cookieState || cookieState[1] !== state) {
    return html(400, "Session expire ho gaya. /api/install dobara kholein (usi browser mein).");
  }
  if (!(await validShopifyHmac(q, env.SHOPIFY_CLIENT_SECRET))) {
    return html(400, "Shopify signature match nahi hua. SHOPIFY_CLIENT_SECRET check karein.");
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code }),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data.access_token) {
    const reason = (text.match(/Oauth error[^<]*/) || [text.slice(0, 200)])[0];
    console.error("oauth exchange failed", res.status, reason);
    return html(500, `Token nahi mila: ${escapeHtml(reason)}`);
  }

  const body = `
    <h1>Token mil gaya ✅</h1>
    <p>Ye <b>permanent token</b> hai. Ise abhi copy karke Vercel mein daalo. Ye page dobara nahi dikhega.</p>
    <ol>
      <li>Neeche ka token copy karo.</li>
      <li>Vercel → Project → <b>Environment Variables</b> → <b>Add</b>:<br>
          Key: <code>SHOPIFY_ACCESS_TOKEN</code> &nbsp; Value: token</li>
      <li><b>Deployments → ⋯ → Redeploy</b>.</li>
    </ol>
    <textarea readonly rows="3" style="width:100%;font:14px monospace;padding:8px" onclick="this.select()">${escapeHtml(data.access_token)}</textarea>
    <p style="color:#555">Scopes: ${escapeHtml(data.scope || "")}</p>
    <p style="color:#a00"><b>Is token ko kisi ke saath share mat karna</b>, chat mein bhi nahi.</p>`;
  return html(200, body, { "Set-Cookie": "gj_oauth_state=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax" });
}

// Shopify signs the callback query: HMAC-SHA256(secret, sorted "k=v" pairs without hmac, joined by "&")
async function validShopifyHmac(params, secret) {
  const hmac = params.get("hmac");
  if (!hmac || !secret) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== hmac.length) return false;
  let r = 0;
  for (let i = 0; i < expected.length; i++) r |= expected.charCodeAt(i) ^ hmac.toLowerCase().charCodeAt(i);
  return r === 0;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function html(status, body, extraHeaders = {}) {
  const page = `<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Goenka Member Checkout</title></head>
  <body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">${body.startsWith("<") ? body : `<p>${escapeHtml(body)}</p>`}</body></html>`;
  return new Response(page, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
