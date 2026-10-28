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

## Real 3D models in the Garage (optional, one time — recommended)

The Garage finds a 3D model of each vehicle automatically on Sketchfab. That works with no setup,
but then the model is shown in Sketchfab's own embedded viewer (with its background, faded out at
the edges). With a free Sketchfab API token, the Worker downloads Creative Commons models as
`.glb` files instead, and Medulla renders them itself: transparent, studio-lit, sitting right on
the pedestal like 3DTuning.

1. Make a free account at https://sketchfab.com/signup
2. Copy your API token from https://sketchfab.com/settings/password (bottom of the page, "API token")
3. From this folder:

```bash
npx wrangler secret put SKETCHFAB_API_TOKEN   # paste the token
npx wrangler deploy
```

Each vehicle's model is chosen by the Worker: it searches Sketchfab, then the Groq chat model
judges the results (right make/model, a generation actually sold in that year, stock, a whole
vehicle) and a Groq vision model checks the preview images. That uses your GROQ_API_KEY — about two
small requests per new vehicle, cached for a week. Search results are cached for a day and model
files for 30 days at Cloudflare's edge.

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

## Bank accounts (SimpleFIN) — Assets page

1. Sign up at https://bridge.simplefin.org, connect your banks/cards/brokerages, and create a **Setup Token**.
2. Claim it once (turns it into your private access URL) and store that in the Worker:
   ```bash
   curl -s -X POST "$(echo 'PASTE_SETUP_TOKEN_HERE' | base64 --decode)"
   npx wrangler secret put SIMPLEFIN_ACCESS_URL      # paste the https://...@... URL the first command printed
   npx wrangler secret put SIMPLEFIN_OWNER_EMAIL     # the email you sign in to Medulla with
   npx wrangler deploy
   ```
Only a request signed in as SIMPLEFIN_OWNER_EMAIL gets balances back. Never commit the access URL anywhere.
