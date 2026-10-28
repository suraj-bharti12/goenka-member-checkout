// Vercel Function: GET /api/callback → Shopify returns here after the admin approves the app
import { handleRequest } from "../lib/core.js";

export function GET(request) {
  return handleRequest(request, process.env);
}
