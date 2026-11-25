// Cloudflare Pages Function: forwards the app's AI requests to the Anthropic API.
// The model, token limit and effort are fixed here so callers can't run up the bill
// by asking for a pricier model or huge outputs.

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;      // room for adaptive thinking plus the JSON answer
const EFFORT = "low";          // food scans and short coaching replies don't need deep reasoning
const MAX_BODY_BYTES = 8_000_000;
const MAX_MESSAGES = 20;
const MAX_SYSTEM_CHARS = 4000;

// The Android app (Capacitor) serves its pages from https://localhost on the device.
const APP_ORIGINS = ["https://localhost"];

// Only accept calls from this site, the Android app, or origins listed in the
// ALLOWED_ORIGINS env var (comma-separated, e.g. "http://localhost:3000" for local development).
function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    if (new URL(origin).host === new URL(request.url).host) return true;
  } catch {
    return false;
  }
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return APP_ORIGINS.includes(origin) || extra.includes(origin);
}

// Cross-origin callers (the app) need CORS headers naming their exact origin
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !originAllowed(request, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export async function onRequestOptions({ request, env }) {
  if (!originAllowed(request, env)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(request, env);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
  const fail = (status, message) => json({ error: { message } }, status);

  if (!originAllowed(request, env)) return fail(403, "Requests from this origin are not allowed.");
  if (!env.ANTHROPIC_API_KEY) return fail(500, "ANTHROPIC_API_KEY is not configured on the server.");

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return fail(413, "Request too large. Try a smaller photo.");

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "Request too large. Try a smaller photo.");
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid JSON body.");
  }

  const { messages, system } = body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return fail(400, "Invalid messages.");
  }
  if (system !== undefined && (typeof system !== "string" || system.length > MAX_SYSTEM_CHARS)) {
    return fail(400, "Invalid system prompt.");
  }

  try {
    const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // If the model declines a request, let the API retry it on a suitable fallback model
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        fallbacks: "default",
        ...(system ? { system } : {}),
        messages,
      }),
    });
    const text = await apiResp.text();
    return new Response(text, {
      status: apiResp.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
    return fail(502, `Couldn't reach the AI service: ${String(err)}`);
  }
}
