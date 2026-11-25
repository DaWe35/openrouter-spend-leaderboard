# OpenRouter Spend Leaderboard

A version of the **Top Models** chart and **LLM Leaderboard** from
[openrouter.ai/rankings](https://openrouter.ai/rankings) that ranks models by **estimated USD
spent** instead of tokens.

No dependencies. Needs Node 20+.

```sh
npm run fetch          # fetch usage + prices, update data/history.json and public/data.js (~1 min)
open public/index.html # or xdg-open; works straight from file://, no server needed
npm test               # unit tests for the spend math
```

Or run everything in Docker with `docker compose up -d`. This starts two containers:

- `web`: a busybox `httpd` serving `public/` at http://localhost:8080.
- `fetcher`: Node, which runs the fetch on startup and then daily at 03:00 UTC. It writes
  `data/` and `public/` as UID/GID 1000 by default. Logs: `docker compose logs -f fetcher`.

To change the port, copy `.env.example` to `.env` and edit it:

```sh
cp .env.example .env   # then edit PORT
docker compose up -d   # re-run after changing .env to apply it
```

`npm run fetch -- --limit 40` fetches only the 40 largest models, for a quick dev run. It does not save history.

## Growing the history

OpenRouter publishes about 30 days of per-model daily data. Each run merges the newest days into
`data/history.json` and keeps the older ones, so running the fetch daily grows the chart towards a
full year. Once there are more than about 10 weeks of history, the chart switches from daily to
weekly bars.

The `fetcher` container does this for you. Without Docker, use cron:

```cron
0 3 * * * cd /path/to/openrouter-spend-leaderboard && npm run fetch >> fetch.log 2>&1
```

`data/history.json` is git-ignored by default. Remove it from `.gitignore` if you want to version it.

## How spend is calculated

For each model variant and each complete UTC day:

```
spend = prompt tokens     × effective input price
      + completion tokens × effective output price
```

- **Effective prices** are OpenRouter's measured average input and output $/token for the model
  over the last month (`/stats/effective-pricing`). The input price blends cached and uncached
  prompt tokens, so cache-read discounts, cache-write premiums and the mix of providers that
  actually served the traffic are already included. Cache hits matter a lot here: Claude Opus 5.5
  traffic is about 89% cached, and pricing every prompt token at the list price would overstate
  total spend by about 3×.
- **Fallback:** when a model has no effective price, the itemized list price is used:
  `uncached prompt × input price + cached prompt × cache-read price + completion × output price`.
- **BYOK is included by default**, at the same prices. Those users pay their provider directly,
  so this is what the usage costs, not what OpenRouter bills. The BYOK part is shown in the
  leaderboard tooltips. The "Include BYOK usage" checkbox switches every chart and the
  leaderboard to billed traffic only; `public/data.js` holds both views (`byok`, `noByok`). Days saved before BYOK was included (older than OpenRouter's ~30-day window) keep
  their BYOK-excluded values.
- **Free variants** cost $0 and are skipped. Today's partial UTC day is never included.

Each fetch checks itself against OpenRouter's own internal spend *share* per model (shares only,
no dollar amounts, BYOK excluded on both sides since OpenRouter's shares cover billed traffic only). It prints the total-variation distance between those shares and ours; 0 means
identical. Expect about 0.03–0.05.

### 1-year estimate (second chart)

OpenRouter only publishes a year of **weekly token totals** for each week's top 9 models by
tokens, plus "Others". These totals include BYOK. The estimate turns them into dollars:

- **Named models:** tokens × that model's own $/token. Where the model was used in the last
  30 days, the rate is its measured spend ÷ its tokens, which captures its cache use and
  input/output mix. Retired models use OpenRouter's 1-year effective price, or
  list prices. Free and unpriced models count as $0.
- **"Others":** tokens × one $/token rate, calibrated on the weeks where we have measured spend.
  The fetch log prints a leave-one-out error for each of those weeks; currently it is about ±8%.
- **Measured weekly totals** are drawn as dots on the chart for comparison.

Older weeks are rough. Today's rates are applied to the whole year, and when an expensive model
falls out of a week's top 9 by tokens, its tokens are priced at the average "Others" rate. That
is why most of the estimate sits in "Others".

### Data sources

These are the public, unauthenticated endpoints that openrouter.ai's own frontend uses, all under
`https://openrouter.ai/api/frontend/v1/public`:

| Endpoint | Used for |
|---|---|
| `/stats/rankings/models?view=month` | List of every model variant with 30-day traffic |
| `/stats/model-activity?permaslug=&variant=` | Daily prompt, completion, cached and BYOK tokens (31 days) |
| `/stats/effective-pricing?permaslug=&variant=&range=1m` | Measured $/M input and output, cache-hit rate |
| `/catalog/catalog/models` | Names, authors, list prices (fallback) |
| `/stats/rankings/model-rankings-chart` | Weekly token totals for each week's top 9 models + Others, 1 year (estimate) |
| `/stats/rankings/models?view=month&metric=spend` | OpenRouter's spend shares (sanity check only) |

## Caveats

- These are **undocumented internal APIs**. They may change or break without notice. The fetcher
  makes about 1,300 requests per run, 4 at a time, with backoff on errors.
- One effective price (the last month's average) is applied to every day in the current window.
  Days that have dropped out of the window keep the price they were computed with.
- Models billed per request, image, document or second (rerank, speech-to-text, video) are only
  partly covered. Retired models with no published price, about 0.1% of spend, are counted as $0.
- These are estimates from public statistics, not official figures.

## Layout

```
scripts/spend.mjs        pure spend math (tested)
scripts/fetch-data.mjs   fetch → compute → merge history → write public/data.js
public/                  static page (index.html, app.js, style.css, generated data.js)
data/history.json        accumulated daily spend per model
```

## Social previews / SEO

`public/index.html` carries Open Graph, Twitter card and JSON-LD tags pointing at
`https://llmspend.myqa.cc/`. If the site moves, update those URLs plus `public/robots.txt` and
`public/sitemap.xml`. The preview image `public/og-image.png` (1200×630) is generated by
`scripts/og-image.mjs`; see the comment at its top to rebuild it.
