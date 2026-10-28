// Vercel Function: POST /api/member-checkout
import { handleRequest } from "../lib/core.js";

export function POST(request) {
  return handleRequest(request, process.env);
}

export function OPTIONS(request) {
  return handleRequest(request, process.env);
}
