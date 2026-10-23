/* Medulla AI proxy — a Cloudflare Worker that forwards Medulla's chat requests to Groq using ONE
   Groq API key stored as a Worker secret, so people using Medulla never need a key of their own
   and the key never appears in the public index.html.

   Guardrails, since anyone on the internet can reach a Worker URL:
   - Only browsers on the allowed origins (ALLOWED_ORIGINS in wrangler.toml) get a CORS pass.
   - Per-visitor rate limit (the RATE_LIMITER binding in wrangler.toml).
   - The model is forced to an allow-list, and message count/size and max_tokens are capped, so
     the proxy can't be used as a general-purpose free Groq relay.
   Groq's free tier has no billing attached unless you add it, so the worst case of abuse is the
   shared quota running out for a while, not a bill. */

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const ALLOWED_MODELS = new Set([DEFAULT_MODEL]);
const MAX_MESSAGES = 30;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOTAL_CHARS = 40000;
const MAX_TOKENS_CAP = 1024;

function corsHeaders(origin){
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(body, status, headers){
  return new Response(JSON.stringify(body), {status, headers:{...headers, "Content-Type":"application/json"}});
}
function originAllowed(origin, env){
  if(!origin) return false;
  const list = (env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
  if(list.includes(origin)) return true;
  /* local testing: python3 -m http.server, the Launch Medulla.command server, etc. */
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export default {
  async fetch(request, env){
    const origin = request.headers.get("Origin") || "";
    if(!originAllowed(origin, env)) return new Response("Forbidden", {status:403});
    const cors = corsHeaders(origin);

    if(request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
    if(request.method !== "POST") return json({error:"method_not_allowed"}, 405, cors);
    if(!env.GROQ_API_KEY) return json({error:"proxy_not_configured"}, 500, cors);

    if(env.RATE_LIMITER){
      const who = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: who });
      if(!success) return json({error:"rate_limited"}, 429, cors);
    }

    let body;
    try{ body = await request.json(); }catch(e){ return json({error:"bad_json"}, 400, cors); }
    const msgs = Array.isArray(body && body.messages) ? body.messages : null;
    if(!msgs || !msgs.length || msgs.length > MAX_MESSAGES) return json({error:"bad_messages"}, 400, cors);
    let total = 0;
    const messages = [];
    for(const m of msgs){
      if(!m || !["system","user","assistant"].includes(m.role) || typeof m.content !== "string") return json({error:"bad_messages"}, 400, cors);
      if(m.content.length > MAX_CHARS_PER_MESSAGE) return json({error:"message_too_long"}, 413, cors);
      total += m.content.length;
      messages.push({role:m.role, content:m.content});
    }
    if(total > MAX_TOTAL_CHARS) return json({error:"request_too_long"}, 413, cors);

    const payload = {
      model: ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL,
      messages,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
    };
    if(typeof body.temperature === "number") payload.temperature = Math.max(0, Math.min(1.5, body.temperature));

    let upstream;
    try{
      upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST",
        headers:{"Content-Type":"application/json", "Authorization":`Bearer ${env.GROQ_API_KEY}`},
        body: JSON.stringify(payload),
      });
    }catch(e){
      return json({error:"upstream_unreachable"}, 502, cors);
    }
    /* pass Groq's answer (or its error status, e.g. 429 when the shared quota is used up) through as-is */
    return new Response(upstream.body, {status:upstream.status, headers:{...cors, "Content-Type":"application/json"}});
  },
};
