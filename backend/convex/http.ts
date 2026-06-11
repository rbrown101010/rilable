import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { requireAiProxyAccess } from "./auth";

// AI proxy for generated apps: forwards /ai/* to the Vercel AI Gateway with
// the key injected server-side, so no generated app ever contains the key.
// Generated web apps call it from the browser (hence CORS *); generated iOS
// apps call it via URLSession.

const GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const http = httpRouter();

http.route({
  pathPrefix: "/ai/",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }),
});

http.route({
  pathPrefix: "/ai/",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    try {
      requireAiProxyAccess(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const key = process.env.VERCEL_AI_GATEWAY_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: "AI gateway key not configured" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const url = new URL(request.url);
    const suffix = url.pathname.replace(/^\/ai\//, "");
    if (!/^[a-z0-9/_-]+$/i.test(suffix)) {
      return new Response(JSON.stringify({ error: "bad path" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const body = await request.text();
    if (body.length > 1_000_000) {
      return new Response(JSON.stringify({ error: "request too large" }), {
        status: 413,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const upstream = await fetch(`${GATEWAY_BASE}/${suffix}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  }),
});

export default http;
