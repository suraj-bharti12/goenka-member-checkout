// Goenka Jewellers — Diamond Member Checkout (shared core for Cloudflare Workers and Vercel)
//
// POST .../member-checkout   { cid, ts, sig, mode: "preview" | "create", items: [{ variant_id, quantity, properties }] }
//   preview → returns the member savings for the cart (nothing is created)
//   create  → creates a draft order with 20%-of-diamond-value discounts and returns its checkout (invoice) URL
//
// Security:
//   * Customer identity comes from a signature made by the theme (Liquid, server-side) with SIGNING_SECRET.
//   * Prices, diamond data and membership status are read from Shopify on the server — never trusted from the browser.

import { memberDiscountPerUnit, MEMBER_DIAMOND_PERCENT } from "./discount.js";
import { handleInstall, handleCallback } from "./oauth.js";

const API_VERSION = "2026-07";
const SIGNATURE_MAX_AGE_SECONDS = 6 * 60 * 60; // a cart page stays valid for 6 hours
const MEMBER_TAG = "diamond-member";
const MAX_LINES = 25;

let cachedToken = null; // { token, expiresAt }

export async function handleRequest(request, env) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/health")) return json({ ok: true, tokenMode: env.SHOPIFY_ACCESS_TOKEN ? "oauth" : "client_credentials" }, 200, cors);
  if (path.endsWith("/install") && request.method === "GET") return handleInstall(request, env);
  if (path.endsWith("/callback") && request.method === "GET") return handleCallback(request, env);
  if (!path.endsWith("/member-checkout") || request.method !== "POST") {
    return json({ error: "Not found" }, 404, cors);
  }

  try {
    const body = await request.json();
    const result = await handleCheckout(body, env);
    return json(result, 200, cors);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return json({ error: err.publicMessage || "Kuch gadbad ho gayi. Thodi der baad try karein." }, status, cors);
  }
}

async function handleCheckout(body, env) {
  const { cid, ts, sig, mode = "preview", items } = body || {};

  // 1. Who is the customer? (signed by the theme)
  await verifySignature(String(cid), String(ts), String(sig), env.SIGNING_SECRET);

  if (!Array.isArray(items) || items.length === 0) fail(400, "Cart khaali hai.");
  if (items.length > MAX_LINES) fail(400, "Cart mein bahut zyada items hain.");

  const customerGid = `gid://shopify/Customer/${cid}`;
  const variantGids = [...new Set(items.map((i) => `gid://shopify/ProductVariant/${Number(i.variant_id)}`))];

  // 2. Read customer, GPE stone rates and variants from Shopify
  const data = await adminGraphQL(env, LOOKUP_QUERY, { customerId: customerGid, variantIds: variantGids });

  const customer = data.customer;
  if (!customer) fail(403, "Customer nahi mila. Login karke dobara try karein.");
  if (!isActiveMember(customer)) fail(403, "Ye offer sirf active Diamond Members ke liye hai.");

  const stonePricing = data.shop?.stonePricing?.value;
  const variants = new Map();
  for (const n of data.nodes || []) if (n && n.id) variants.set(n.id, n);

  // 3. Build lines (one line per unit so each discount is exact)
  const lines = [];
  let totalSavings = 0;
  let subtotal = 0;
  for (const item of items) {
    const gid = `gid://shopify/ProductVariant/${Number(item.variant_id)}`;
    const v = variants.get(gid);
    if (!v) fail(400, "Cart ka ek product ab available nahi hai. Cart refresh karein.");
    const qty = Math.max(1, Math.min(10, Number(item.quantity) || 1));
    const unitPrice = Number(v.price);
    const calc = memberDiscountPerUnit(unitPrice, v.config?.value, stonePricing);
    const properties = cleanProperties(item.properties);

    for (let i = 0; i < qty; i++) {
      lines.push({ variant: v, unitPrice, calc, properties });
      totalSavings += calc.discount;
      subtotal += unitPrice;
    }
  }
  totalSavings = round2(totalSavings);
  subtotal = round2(subtotal);

  const summary = {
    member: true,
    percent: MEMBER_DIAMOND_PERCENT,
    subtotal,
    savings: totalSavings,
    total: round2(subtotal - totalSavings),
    lines: lines.map((l) => ({
      title: `${l.variant.product.title}${l.variant.title && l.variant.title !== "Default Title" ? " – " + l.variant.title : ""}`,
      price: l.unitPrice,
      diamondValue: l.calc.diamondValue,
      discount: l.calc.discount,
    })),
  };

  if (mode !== "create") return summary;
  if (totalSavings <= 0) fail(400, "Is cart ke products par member discount nahi banta.");

  // 4. Create the draft order
  const note = lines
    .map((l) => `${l.variant.product.title}: diamond ₹${l.calc.diamondValue} → member discount ₹${l.calc.discount}`)
    .join("\n");

  const input = {
    purchasingEntity: { customerId: customerGid },
    useCustomerDefaultAddress: true,
    tags: ["diamond-member-checkout"],
    note: `Diamond Member checkout (${MEMBER_DIAMOND_PERCENT}% on diamond value)\n${note}`,
    lineItems: lines.map((l) => ({
      variantId: l.variant.id,
      quantity: 1,
      customAttributes: l.properties,
      ...(l.calc.discount > 0
        ? {
            appliedDiscount: {
              valueType: "FIXED_AMOUNT",
              value: l.calc.discount,
              title: `Diamond Member ${MEMBER_DIAMOND_PERCENT}% on diamond`,
              description: `Diamond value ₹${l.calc.diamondValue}`,
            },
          }
        : {}),
    })),
  };

  const created = await adminGraphQL(env, DRAFT_ORDER_CREATE, { input });
  const res = created.draftOrderCreate;
  if (res.userErrors && res.userErrors.length) {
    console.error("draftOrderCreate userErrors", JSON.stringify(res.userErrors));
    fail(500, "Order banane mein dikkat aayi. Store se sampark karein.");
  }
  return { ...summary, checkoutUrl: res.draftOrder.invoiceUrl };
}

// ---------- membership ----------

function isActiveMember(customer) {
  const tags = (customer.tags || []).map((t) => String(t).toLowerCase());
  if (!tags.includes(MEMBER_TAG)) return false;
  const expiry = customer.expiry?.value; // "YYYY-MM-DD"
  if (!expiry) return true; // tag present but no date yet → treat as active
  return expiry >= todayInIndia();
}

function todayInIndia() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// ---------- signature ----------

async function verifySignature(cid, ts, sig, secret) {
  if (!secret) fail(500, "Server setup adhoora hai.");
  if (!/^\d+$/.test(cid) || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) {
    fail(401, "Please login karke dobara try karein.");
  }
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (age > SIGNATURE_MAX_AGE_SECONDS || age < -300) {
    fail(401, "Page purana ho gaya hai. Page refresh karke dobara try karein.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${cid}.${ts}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqual(expected, sig.toLowerCase())) fail(401, "Please login karke dobara try karein.");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Shopify Admin API ----------

async function getAccessToken(env) {
  // Permanent (offline) token from the one-time OAuth install (/api/install). Preferred.
  if (env.SHOPIFY_ACCESS_TOKEN) return String(env.SHOPIFY_ACCESS_TOKEN).trim();
  // Otherwise: client credentials grant (only works when app and store are in the same organization).
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) return cachedToken.token;
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    console.error("token error", res.status, await res.text());
    fail(500, "Store se connect nahi ho paya.");
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}

async function adminGraphQL(env, query, variables) {
  const token = await getAccessToken(env);
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) cachedToken = null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) {
    console.error("graphql error", res.status, JSON.stringify(data.errors || data));
    fail(500, "Store se data nahi mila.");
  }
  return data.data;
}

const LOOKUP_QUERY = /* GraphQL */ `
  query MemberLookup($customerId: ID!, $variantIds: [ID!]!) {
    customer(id: $customerId) {
      id
      tags
      expiry: metafield(namespace: "custom", key: "membership_expiry") { value }
    }
    shop {
      stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value }
    }
    nodes(ids: $variantIds) {
      ... on ProductVariant {
        id
        title
        price
        product { title }
        config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
      }
    }
  }
`;

const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation CreateMemberDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl }
      userErrors { field message }
    }
  }
`;

// ---------- helpers ----------

function cleanProperties(props) {
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([k, v]) => v != null && String(v).trim() !== "")
    .slice(0, 20)
    .map(([k, v]) => ({ key: String(k).slice(0, 100), value: String(v).slice(0, 500) }));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.publicMessage = message;
  throw e;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
