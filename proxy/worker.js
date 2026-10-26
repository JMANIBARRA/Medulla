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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

/* ---- US stock movers for Medulla's Market "Trending" card ----
   Alpha Vantage's free TOP_GAINERS_LOSERS endpoint (most actively traded, top gainers, top
   losers), with the key stored as the ALPHAVANTAGE_API_KEY secret. The free tier allows ~25
   requests a day, so the result is cached for an hour at Cloudflare's edge (plus in memory),
   which keeps a single location well under that no matter how often Medulla asks. */
const MOVERS_TTL_SECONDS = 3600;
let moversMemory = null; /* {time, body} */
function trimMovers(list){
  return (Array.isArray(list) ? list : []).slice(0, 10).map(r=>({
    ticker: String(r.ticker||""),
    price: Number(r.price),
    change: Number(r.change_amount),
    changePct: Number(String(r.change_percentage||"").replace("%","")),
    volume: Number(r.volume),
  })).filter(r=>r.ticker);
}
async function stockMovers(env, cors, ctx){
  if(!env.ALPHAVANTAGE_API_KEY) return json({error:"stocks_not_configured"}, 503, cors);
  if(moversMemory && Date.now() - moversMemory.time < MOVERS_TTL_SECONDS*1000){
    return new Response(moversMemory.body, {status:200, headers:{...cors, "Content-Type":"application/json"}});
  }
  const cache = caches.default;
  const cacheKey = new Request("https://medulla-cache.internal/stocks/movers");
  const hit = await cache.match(cacheKey);
  if(hit){
    const body = await hit.text();
    moversMemory = {time: Date.now(), body};
    return new Response(body, {status:200, headers:{...cors, "Content-Type":"application/json"}});
  }
  let data;
  try{
    const res = await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${encodeURIComponent(env.ALPHAVANTAGE_API_KEY)}`);
    data = await res.json();
  }catch(e){
    return json({error:"upstream_unreachable"}, 502, cors);
  }
  /* Alpha Vantage answers 200 with an "Information"/"Note" message when the key is bad or the
     daily limit is used up — pass that on instead of caching an empty list */
  if(!data || !Array.isArray(data.most_actively_traded)){
    const msg = (data && (data.Information || data.Note || data["Error Message"])) || "unexpected response";
    return json({error:"upstream_error", message:String(msg).slice(0,200)}, 502, cors);
  }
  const body = JSON.stringify({
    updated: data.last_updated || null,
    mostActive: trimMovers(data.most_actively_traded),
    gainers: trimMovers(data.top_gainers),
    losers: trimMovers(data.top_losers),
  });
  moversMemory = {time: Date.now(), body};
  const toCache = new Response(body, {headers:{"Content-Type":"application/json", "Cache-Control":`public, max-age=${MOVERS_TTL_SECONDS}`}});
  if(ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toCache)); else await cache.put(cacheKey, toCache);
  return new Response(body, {status:200, headers:{...cors, "Content-Type":"application/json"}});
}

/* ---- Garage: real 3D models of the user's vehicles, from Sketchfab ----
   GET /garage/find?q=ford+ranger+2000  -> candidate models (search is public, no key needed)
   GET /garage/glb/<uid>.glb             -> that model as a .glb file (needs SKETCHFAB_API_TOKEN)
   With the token set, downloadable (Creative Commons) models come back with a "glb" link, which
   Medulla shows in its own studio-lit viewer with a transparent background, right on the
   pedestal. Without it, Medulla falls back to Sketchfab's embedded viewer. Search results are
   cached for a day and model files for 30 days at Cloudflare's edge. */
const SF_API = "https://api.sketchfab.com/v3";
const SF_FIND_TTL = 86400;
const SF_GLB_TTL = 30 * 86400;
const SF_MAX_GLB_BYTES = 45 * 1024 * 1024;
function sfLicense(l){
  if(!l) return "";
  if(typeof l === "string") return l;
  return l.label || l.slug || "";
}
function sfThumb(t){
  const imgs = (t && Array.isArray(t.images)) ? t.images.slice().sort((a,b)=>a.width-b.width) : [];
  const pick = imgs.find(i=>i.width >= 480) || imgs[imgs.length-1];
  return pick ? pick.url : "";
}
function sfNormalize(r, glbOk, base){
  const glb = r.archives && r.archives.glb;
  const canGlb = glbOk && r.isDownloadable && glb && (!glb.size || glb.size <= SF_MAX_GLB_BYTES);
  return {
    uid: r.uid, name: String(r.name||"").slice(0,140),
    author: (r.user && (r.user.displayName || r.user.username)) || "",
    authorUrl: (r.user && r.user.profileUrl) || "",
    license: sfLicense(r.license),
    likes: r.likeCount || 0, views: r.viewCount || 0, faces: r.faceCount || 0,
    staff: !!r.staffpickedAt, downloadable: !!r.isDownloadable,
    tags: (r.tags||[]).map(t=>t && (t.slug || t.name)).filter(Boolean).slice(0,20),
    description: String(r.description||"").replace(/\s+/g, " ").slice(0, 220),
    thumb: sfThumb(r.thumbnails),
    glb: canGlb ? `${base}/garage/glb/${r.uid}.glb` : null,
    glbSize: canGlb && glb.size ? glb.size : null,
  };
}
async function sfSearch(params){
  const res = await fetch(`${SF_API}/search?${params}`, {headers:{"Accept":"application/json"}});
  if(!res.ok) throw new Error("search " + res.status);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}
async function garageFind(request, env, cors, ctx){
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if(q.length < 2) return json({error:"bad_query"}, 400, cors);
  const glbOk = !!env.SKETCHFAB_API_TOKEN;
  const cache = caches.default;
  const cacheKey = new Request(`https://medulla-cache.internal/garage/find?v=2&glb=${glbOk?1:0}&q=${encodeURIComponent(q.toLowerCase())}`);
  const hit = await cache.match(cacheKey);
  if(hit) return new Response(await hit.text(), {status:200, headers:{...cors, "Content-Type":"application/json"}});
  const common = `type=models&categories=cars-vehicles&count=24&q=${encodeURIComponent(q)}`;
  let lists;
  try{
    lists = await Promise.all([
      sfSearch(common),
      glbOk ? sfSearch(`${common}&downloadable=true`) : Promise.resolve([]),
    ]);
  }catch(e){
    return json({error:"upstream_unreachable"}, 502, cors);
  }
  const seen = new Set(), results = [];
  const base = url.origin;
  for(const r of [...lists[1], ...lists[0]]){
    if(!r || !r.uid || seen.has(r.uid)) continue;
    seen.add(r.uid);
    results.push(sfNormalize(r, glbOk, base));
  }
  const body = JSON.stringify({glb: glbOk, results});
  const toCache = new Response(body, {headers:{"Content-Type":"application/json", "Cache-Control":`public, max-age=${SF_FIND_TTL}`}});
  if(ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toCache)); else await cache.put(cacheKey, toCache);
  return new Response(body, {status:200, headers:{...cors, "Content-Type":"application/json"}});
}
async function garageGlb(uid, env, cors, ctx){
  if(!/^[0-9a-f]{32}$/i.test(uid)) return json({error:"bad_uid"}, 400, cors);
  if(!env.SKETCHFAB_API_TOKEN) return json({error:"glb_not_configured"}, 503, cors);
  const cache = caches.default;
  const cacheKey = new Request(`https://medulla-cache.internal/garage/glb/${uid}.glb`);
  const hit = await cache.match(cacheKey);
  const glbHeaders = {...cors, "Content-Type":"model/gltf-binary", "Cache-Control":"public, max-age=604800"};
  if(hit) return new Response(hit.body, {status:200, headers:glbHeaders});
  let dl;
  try{
    const res = await fetch(`${SF_API}/models/${uid}/download`, {headers:{"Authorization":`Token ${env.SKETCHFAB_API_TOKEN}`}});
    if(!res.ok) return json({error:"download_refused", status:res.status}, res.status === 401 ? 502 : 404, cors);
    dl = await res.json();
  }catch(e){
    return json({error:"upstream_unreachable"}, 502, cors);
  }
  if(!dl || !dl.glb || !dl.glb.url) return json({error:"no_glb"}, 404, cors);
  if(dl.glb.size && dl.glb.size > SF_MAX_GLB_BYTES) return json({error:"too_large"}, 413, cors);
  let file;
  try{ file = await fetch(dl.glb.url); }catch(e){ return json({error:"upstream_unreachable"}, 502, cors); }
  if(!file.ok) return json({error:"upstream_error"}, 502, cors);
  const buf = await file.arrayBuffer();
  const toCache = new Response(buf, {headers:{"Content-Type":"model/gltf-binary", "Cache-Control":`public, max-age=${SF_GLB_TTL}`}});
  if(ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toCache)); else await cache.put(cacheKey, toCache);
  return new Response(buf, {status:200, headers:glbHeaders});
}

/* ---- /garage/pick: search + an AI judge ----
   Keyword rules can't tell "Ford Mustang 2011" from a 1999 Mustang, or a bike's licence-plate
   bracket from the bike. So the candidates are judged by the chat model (which knows model
   generations and trims), then the shortlist's preview images are checked by a vision model.
   GET /garage/pick?vehicle=Ford%20Mustang&year=1999&kind=car&standin=ford%20muscle%20car|muscle%20car
   -> {judged:true, glb:bool, pick:{...candidate, standIn, reason}|null} */
const PICK_TTL = 7 * 86400;
const JUNK = /\b(low ?poly|lowpoly|toy|lego|minecraft|roblox|voxel|papercraft|keychain|hot ?wheels)\b/i;
async function groqJSON(env, model, messages, maxTokens){
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST",
    headers:{"Content-Type":"application/json", "Authorization":`Bearer ${env.GROQ_API_KEY}`},
    body: JSON.stringify({model, messages, temperature:0, max_tokens:maxTokens || 700, response_format:{type:"json_object"}}),
  });
  if(!res.ok) throw new Error("groq " + res.status);
  const data = await res.json();
  let txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  txt = txt.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = txt.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : txt);
}
async function searchMany(queries, glbOk, base){
  const seen = new Set(), out = [];
  const lists = await Promise.all(queries.flatMap(q=>{
    const common = `type=models&categories=cars-vehicles&count=24&q=${encodeURIComponent(q)}`;
    return [sfSearch(common).catch(()=>[]), glbOk ? sfSearch(`${common}&downloadable=true`).catch(()=>[]) : Promise.resolve([])];
  }));
  /* downloadable lists first so their entries carry the archive info */
  for(let i = 1; i < lists.length; i += 2) for(const r of lists[i]) if(r && r.uid && !seen.has(r.uid)){ seen.add(r.uid); out.push(sfNormalize(r, glbOk, base)); }
  for(let i = 0; i < lists.length; i += 2) for(const r of lists[i]) if(r && r.uid && !seen.has(r.uid)){ seen.add(r.uid); out.push(sfNormalize(r, glbOk, base)); }
  return out.filter(c=>!(c.faces && c.faces < 5000) && !JUNK.test(c.name));
}
async function judgeText(env, want, cands, standIn){
  const list = cands.map((c, i)=>({i, name:c.name, tags:c.tags.slice(0,12), description:c.description, downloadable:!!c.glb, likes:c.likes, polygons:c.faces}));
  const rules = standIn
    ? `No model of this exact vehicle exists. Choose stand-ins: complete, realistic, STOCK vehicles of the same kind (${want.kind || "vehicle"}${want.make ? `, ideally made by ${want.make}` : ""}) from roughly the same era as ${want.year || "the vehicle"}.`
    : `Choose models that ARE this exact vehicle: same make and model, and a generation that was actually sold in ${want.year || "that year"}. Use your knowledge of model generations: e.g. a 1999 Ford Mustang is the SN95 generation (1994-2004), so a "2011 Mustang" or "Mustang GT 2018" is WRONG; a 2000 Ford Ranger is the 1998-2011 generation, so a 2019+ Ranger or a T6 Ranger is WRONG. If a name gives no year, judge by generation hints (codes like SN95, E46, C5; styling words) and accept only if it plausibly matches. Kawasaki "Z400" means the motorcycle.`;
  const prompt = `Vehicle: ${JSON.stringify(want.vehicle)}${want.year ? `, model year ${want.year}` : ""}${want.kind ? `, kind: ${want.kind}` : ""}.
${rules}
Reject anything that is: a part or accessory (frames, brackets, plates, wheels, engines, racks, interiors), a scene/diorama/scan, a toy/cartoon/low-poly model, a wreck/rusty/abandoned/sunken vehicle, or a modified build (lifted, off-road kit, roll bar, race/rally, drift, stance, police/taxi/military, widebody, custom) unless the vehicle name asks for it. Prefer "downloadable": true when two are equally good.
Candidates: ${JSON.stringify(list)}
Answer with JSON only: {"ranked":[candidate i values, best first, ONLY acceptable ones, at most 5], "reason":"one short sentence"}`;
  const out = await groqJSON(env, DEFAULT_MODEL, [
    {role:"system", content:"You are a meticulous automotive expert selecting 3D models for a car-collection app. You answer with strict JSON."},
    {role:"user", content:prompt},
  ], 400);
  const ranked = (Array.isArray(out.ranked) ? out.ranked : []).map(Number).filter(i=>Number.isInteger(i) && i >= 0 && i < cands.length);
  return {ranked:[...new Set(ranked)], reason:String(out.reason||"").slice(0,200)};
}
async function judgeImages(env, want, shortlist, standIn){
  const withImg = shortlist.filter(c=>c.thumb).slice(0, 3);
  if(!withImg.length) return null;
  const content = [{type:"text", text:
    `These are preview images of 3D models (numbered 0-${withImg.length-1} in order). ${standIn
      ? `Which ones show a complete, stock, realistic ${want.kind || "vehicle"} (a stand-in for a ${want.year||""} ${want.vehicle})?`
      : `Which ones show a complete, stock (unmodified: not lifted, no roll bar or off-road kit, not a race car) ${want.year||""} ${want.vehicle} of the correct generation?`}
Reject parts/accessories, scenes, wrecks, toys, and the wrong generation. Answer with JSON only: {"ok":[image numbers that pass, best first]}`}];
  withImg.forEach(c=>content.push({type:"image_url", image_url:{url:c.thumb}}));
  const out = await groqJSON(env, env.GARAGE_VISION_MODEL || "qwen/qwen3.8-27b", [{role:"user", content}], 600);
  const ok = (Array.isArray(out.ok) ? out.ok : []).map(Number).filter(i=>Number.isInteger(i) && i >= 0 && i < withImg.length);
  return {checked: withImg.map(c=>c.uid), ok: ok.map(i=>withImg[i].uid)};
}
async function pickFrom(env, want, cands, standIn){
  if(!cands.length) return null;
  cands = cands.slice(0, 40);
  const {ranked, reason} = await judgeText(env, want, cands, standIn);
  if(!ranked.length) return null;
  let shortlist = ranked.map(i=>cands[i]);
  /* clean .glb files sit on the pedestal; keep the text ranking otherwise */
  try{
    const vis = await judgeImages(env, want, shortlist, standIn);
    if(vis){
      const failed = new Set(vis.checked.filter(u=>!vis.ok.includes(u)));
      shortlist = shortlist.filter(c=>!failed.has(c.uid));
      const okOrder = vis.ok;
      shortlist.sort((a,b)=>{ const ia = okOrder.indexOf(a.uid), ib = okOrder.indexOf(b.uid); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    }
  }catch(e){ /* vision model unavailable: the text judgement stands */ }
  if(!shortlist.length) return null;
  const top = shortlist[0];
  const glbAlt = shortlist.slice(0, 3).find(c=>c.glb);
  const pick = (!top.glb && glbAlt) ? glbAlt : top;
  return {...pick, standIn, reason};
}
async function garagePick(request, env, cors, ctx){
  const url = new URL(request.url);
  const clean = s=>String(s||"").replace(/\s+/g, " ").trim().slice(0, 80);
  const want = {
    vehicle: clean(url.searchParams.get("vehicle")),
    year: Number(url.searchParams.get("year")) || 0,
    kind: clean(url.searchParams.get("kind")),
    make: clean(url.searchParams.get("make")),
  };
  const standinQs = clean(url.searchParams.get("standin")).split("|").map(clean).filter(Boolean).slice(0, 3);
  const extraQs = clean(url.searchParams.get("also")).split("|").map(clean).filter(Boolean).slice(0, 3);
  if(want.vehicle.length < 2) return json({error:"bad_query"}, 400, cors);
  if(!env.GROQ_API_KEY) return json({error:"judge_not_configured"}, 503, cors);
  const glbOk = !!env.SKETCHFAB_API_TOKEN;
  const cache = caches.default;
  const cacheKey = new Request(`https://medulla-cache.internal/garage/pick?v=1&glb=${glbOk?1:0}&` + new URLSearchParams({vehicle:want.vehicle.toLowerCase(), year:want.year, kind:want.kind, s:standinQs.join("|"), a:extraQs.join("|")}));
  const hit = await cache.match(cacheKey);
  if(hit) return new Response(await hit.text(), {status:200, headers:{...cors, "Content-Type":"application/json"}});
  const base = url.origin;
  let pick = null;
  try{
    const qs = [want.year ? `${want.vehicle} ${want.year}` : null, want.vehicle, ...extraQs].filter(Boolean);
    pick = await pickFrom(env, want, await searchMany(qs, glbOk, base), false);
    if(!pick && standinQs.length) pick = await pickFrom(env, want, await searchMany(standinQs, glbOk, base), true);
  }catch(e){
    return json({error:"judge_failed", message:String(e && e.message || e).slice(0,120)}, 502, cors);
  }
  const body = JSON.stringify({judged:true, glb:glbOk, pick});
  const toCache = new Response(body, {headers:{"Content-Type":"application/json", "Cache-Control":`public, max-age=${PICK_TTL}`}});
  if(ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toCache)); else await cache.put(cacheKey, toCache);
  return new Response(body, {status:200, headers:{...cors, "Content-Type":"application/json"}});
}

export default {
  async fetch(request, env, ctx){
    const origin = request.headers.get("Origin") || "";
    if(!originAllowed(origin, env)) return new Response("Forbidden", {status:403});
    const cors = corsHeaders(origin);

    if(request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if(path === "/stocks/movers"){
      if(request.method !== "GET") return json({error:"method_not_allowed"}, 405, cors);
      return stockMovers(env, cors, ctx);
    }
    if(path === "/garage/find" || path === "/garage/pick" || path.startsWith("/garage/glb/")){
      if(request.method !== "GET") return json({error:"method_not_allowed"}, 405, cors);
      if(env.RATE_LIMITER){
        const who = "garage:" + (request.headers.get("CF-Connecting-IP") || "unknown");
        const { success } = await env.RATE_LIMITER.limit({ key: who });
        if(!success) return json({error:"rate_limited"}, 429, cors);
      }
      if(path === "/garage/find") return garageFind(request, env, cors, ctx);
      if(path === "/garage/pick") return garagePick(request, env, cors, ctx);
      return garageGlb(path.slice("/garage/glb/".length).replace(/\.glb$/i, ""), env, cors, ctx);
    }
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
