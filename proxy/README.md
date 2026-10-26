# Medulla AI proxy

A tiny Cloudflare Worker that lets everyone use Medulla's smart chat without entering their own
Groq key. Your one Groq key is stored as a secret on Cloudflare, never in `index.html`.

## One-time setup (about 5 minutes)

You need a free Cloudflare account (https://dash.cloudflare.com/sign-up) and a free Groq key
(https://console.groq.com/keys).

From this `proxy` folder in a terminal:

```bash
npx wrangler login                    # opens the browser to sign in to Cloudflare
npx wrangler secret put GROQ_API_KEY  # paste your Groq key when asked
npx wrangler deploy                   # prints your Worker URL
```

The deploy prints a URL like `https://medulla-ai.<your-subdomain>.workers.dev`.
Put it in `index.html`:

```js
const MEDULLA_AI_PROXY_URL = "https://medulla-ai.<your-subdomain>.workers.dev";
```

Commit and push, and everyone's Medulla chat uses the proxy.

## Stock movers for the Market "Trending" card (optional, one time)

The Market window's Trending list shows today's most active US stocks, top gainers and top
losers from Alpha Vantage. Get a free key at https://www.alphavantage.co/support/#api-key, then
from this folder:

```bash
npx wrangler secret put ALPHAVANTAGE_API_KEY   # paste the Alpha Vantage key
npx wrangler deploy
```

The Worker caches the list for an hour, which keeps it inside the free tier's ~25 requests a day.

## Settings you might change

- `ALLOWED_ORIGINS` in `wrangler.toml`: the sites allowed to use the proxy. If your site's
  address changes (for example a custom domain), add it here and run `npx wrangler deploy` again.
- `limit` / `period` under `[ratelimits.simple]`: requests allowed per visitor
  (`period` must be 10 or 60 seconds).
- To swap the key later: `npx wrangler secret put GROQ_API_KEY` again.

## Limits

Everyone shares your Groq free-tier quota. If it runs out, Medulla says it couldn't reach its
thinking service until the quota resets. Anyone who adds their own key in Settings uses that
instead and isn't affected.
