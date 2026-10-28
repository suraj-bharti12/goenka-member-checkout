// Vercel Function: GET /api/install → one-time OAuth install (gets a permanent Admin API token)
import { handleRequest } from "../lib/core.js";

export function GET(request) {
  return handleRequest(request, process.env);
}
