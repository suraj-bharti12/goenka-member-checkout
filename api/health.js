// Vercel Function: GET /api/health  → {"ok":true}
import { handleRequest } from "../lib/core.js";

export function GET(request) {
  return handleRequest(request, process.env);
}
