---
name: firecrawl
description: Scrape, search, map, crawl and LLM-extract web pages through the host's self-hosted Firecrawl API over curl — keyless, local LLM. Pages to markdown, web/news search via SearXNG, site URL discovery, local file parsing.
disable-model-invocation: true
metadata:
  hermes:
    requires_tools: [__manual_command_only__]
---

# Firecrawl (local)

Firecrawl runs from `/opt/playground/firecrawl` (Docker Compose) on `192.168.1.100:3002`.
LLM formats go to llama-swap (`192.168.1.100:8081`); search goes to SearXNG (`192.168.1.100:8888`).

- Endpoint: `FC=${FIRECRAWL_ENDPOINT:-${FIRECRAWL_API_URL:-http://192.168.1.100:3002}}` — prefer
  `FIRECRAWL_ENDPOINT`: `FIRECRAWL_API_URL` is in Hermes' provider blocklist, so Hermes strips it
  from a terminal, `execute_code` or cron child and the fallback address is used silently. `fc`
  prints which of the three it used in `--help`, and says so when a call cannot reach the host.
- No API key, no auth header. No credits are enforced.
- Health: `curl -s $FC/v0/health/liveness` → `{"status":"ok"}`.
- `maxConcurrency` is 2 and the GPU is shared: **run requests sequentially**.

Every command below was run against this instance on 2026-10-11.

## `fc` (preferred)

```bash
~/.agents/skills/firecrawl/scripts/fc <command> [options]
```

```bash
fc scrape https://example.com                         # markdown
fc scrape https://example.com -f links,html           # several formats → JSON
fc scrape https://example.com -f summary              # local LLM
fc scrape https://example.com --prompt "title and purpose" \
   --schema '{"type":"object","properties":{"title":{"type":"string"}}}'
fc search "AI regulation" -n 5 --sources web,news --tbs qdr:w [--safe] [--scrape]
fc search "kghm" -n 5 --searxng-category 'finance poland'   # a SearXNG category of this instance
fc map https://docs.firecrawl.dev | grep api-reference
fc crawl https://docs.firecrawl.dev -n 10 --include '^/api-reference/.*'
fc batch https://example.com https://example.org
fc parse document.pdf
```

- `crawl` and `batch` poll until done and follow `next` pages. Progress goes to stderr.
- A dropped format or `.data.warning` is printed to stderr as `!!`. Do not suppress it:
  `droppedFormats` is the server naming what it could not produce (the LLM lock drops `json` and
  `summary` that way, and the scrape still reports success).
- `search` prints what the chain actually did to stderr, `--json` included: an engine SearXNG could
  not reach, a pin or a **category name the instance does not have** (that runs the instance's
  DEFAULT search, so the rows are from engines nobody asked for), and `sii`'s count of the rows its
  relevance filter removed. Silence there means the answer is what you asked for.
- `--searxng-category` is the instance's own category (`finance poland`, `science`, comma-separated
  for several). Not `--categories`, which is Firecrawl's research/pdf/developer/gov filter
  (`github` was removed upstream and now answers HTTP 400; use `developer` or `includeDomains`).
- Other options: `--wait MS`, `--all-content` (keep nav and footer), `--json` (raw response,
  goes before the command), `--timeout S` (a scrape's own limit, sent to the API, and the wait for
  async jobs), and `FIRECRAWL_ENDPOINT` to override the endpoint
  (`FIRECRAWL_API_URL` still works, where it survives the scrub).

## Raw API

Use curl for anything `fc` does not expose.

### Scrape a URL

```bash
curl -s $FC/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown","links"],"onlyMainContent":true}' \
  | jq -r .data.markdown
```

Formats: `markdown` (default), `html`, `rawHtml`, `links`. Options: `onlyMainContent`,
`waitFor` (ms, for JS pages; Liferay Learn search needs `6000`), `timeout` (ms). PDF URLs work and
add `numPages`.
**The API stops a scrape at 60 s unless the request names `"timeout"`.** A page that takes longer
comes back as a timeout error, not markdown. Fetching is rarely the slow part: turning a large page
into markdown is, and on a busy machine (a local LLM holding the CPU, the worker logging "Can't
accept connection due to RAM/CPU load") two 150k-character biznesradar.pl pages took 80 s, 2 s of
it the fetch (2026-11-06). Send `"timeout":150000` or more for large pages; `fc scrape` sends its
`--timeout` (default 300 s). The `firecrawl` npm CLI has no such option, so a script that must not
lose a slow page calls the API.
TLS certificates are verified by default (upstream, 2026-11): a self-signed or untrusted HTTPS
site now fails as an SSL error unless the request sets `"skipTlsVerification":true`.
`onlyMainContent` also drops captcha widgets and embedded player documents.

### Structured data and summaries (local LLM, 5–10 s)

```bash
curl -s $FC/v2/scrape -H 'Content-Type: application/json' -d '{"url":"https://example.com",
  "formats":[{"type":"json","prompt":"Page title and purpose",
    "schema":{"type":"object","properties":{"title":{"type":"string"},"purpose":{"type":"string"}},"required":["title"]}}]}' \
  | jq .data.json

curl -s $FC/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["summary"]}' | jq -r .data.summary
```

v2 takes the json format as an object in `formats`. `jsonOptions` is v1-only and v2 rejects it.
Prefer this to `/extract`, which is deprecated here (v1 took 105 s).

### Search

```bash
curl -s $FC/v2/search -H 'Content-Type: application/json' \
  -d '{"query":"firecrawl self hosted","limit":5,"sources":["web","news"],"tbs":"qdr:w"}' \
  | jq '.data.web[] | {title, url, description}'
```

- `sources`: `web`, `news`, `images` → `.data.web`, `.data.news`, `.data.images`. This is the default
  SearXNG category selector: `news` → `SEARXNG_NEWS_CATEGORIES`, `images` → `images`, web →
  `SEARXNG_CATEGORIES` (`general`). `--categories` is Firecrawl's own research/pdf/developer/gov filter,
  **not** a SearXNG category; `github` answers HTTP 400 since the 2026-11-06 upstream merge.
- `"searxngCategory":"finance"` picks a SearXNG category per request — any name the instance knows
  (`finance`, `finance poland`, `science`, `q&a`, comma-separated for several). It overrides the
  category every requested source maps to, and suppresses the DuckDuckGo fallback, which cannot
  serve a category. The categories a request actually used come back in
  `.provenance.searxngCategories`.
- `tbs`: `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y` map to SearXNG `time_range`; `qdr:h` is dropped. A news-only
  request never falls back to DuckDuckGo web rows. On this instance a ranged news query can be empty
  (no reliable range-capable news engine), so omit `tbs` for the portfolio-style news sweeps.
- `"safe":true` drops explicit hits by asking Jev (an external OpenCode Zen model, about 2–3 s
  extra). The free tier returns 429 once its quota is spent.
- `"scrapeOptions":{"formats":["markdown"]}` adds page markdown to each hit (slower).
- Results come from SearXNG. An empty result usually means SearXNG engines failed, not that
  nothing exists — read `.provenance` to tell the two apart: `.provenance.provider` is whichever
  provider answered, `.provenance.attempts[]` carries each provider's `outcome`
  (`results`/`empty`/`error`/`skipped`), SearXNG's own failed engines in `unresponsiveEngines` and
  ignored engine pins in `unknownEngines`, ignored category names in
  `unknownCategories` (when EVERY name in a pinned `searxngCategory` is one the instance does not
  have, the search fails with `outcome: "error"` rather than answering with the default search's
  rows; a partly-known pin still answers, since the known half ran), and an
  engine's own report — `sii`'s `dropped_rows` / `site_rows` — in `engineData`. `jq '.provenance'` first, `/searxng` only if the engines
  are the problem.

### Map a site (URL discovery)

```bash
curl -s $FC/v2/map -H 'Content-Type: application/json' \
  -d '{"url":"https://docs.firecrawl.dev","limit":200}' | jq -r '.links[].url' | grep api-reference
```

The `search` parameter is accepted but barely changes the result, so filter with grep instead.

### Crawl and batch scrape (async: POST, then poll)

```bash
ID=$(curl -s $FC/v2/crawl -H 'Content-Type: application/json' \
  -d '{"url":"https://docs.firecrawl.dev","limit":10,"includePaths":["^/api-reference/.*"],
       "scrapeOptions":{"formats":["markdown"]}}' | jq -r .id)
curl -s $FC/v2/crawl/$ID | jq '{status, completed, total, next}'

ID=$(curl -s $FC/v2/batch/scrape -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com","https://example.org"],"formats":["markdown"]}' | jq -r .id)
curl -s $FC/v2/batch/scrape/$ID | jq '.data[] | {url: .metadata.sourceURL, markdown}'
```

- Wait for `status == "completed"`. Crawl and batch can show `completed == total` while still `scraping`.
- When `next` is non-null, follow it for the rest of the pages.
- `DELETE /v2/crawl/$ID` cancels a crawl.

### Parse a local file

```bash
curl -s $FC/v2/parse -F file=@document.pdf | jq -r .data.markdown
```

HTML and PDF verified.

## Gotchas

- **`success:true` does not mean the format came back.** A format that could not be produced is
  dropped rather than failing the scrape. `.data.droppedFormats` lists them (absent when nothing was
  dropped) and `.data.warning` names them in prose — branch on `droppedFormats`.
- **LLM kill switch:** while `/opt/llm/lock/llm.lock` exists, `json` and `summary` fail. Plain
  scrape, search, map and crawl still work.
- The first LLM call after llama-swap has unloaded the model is slower.
- `mobile` and `location` each work with a "may be partial" warning. Combining them fails with 500.

## Not available here

These need fire-engine, browser sessions or cloud billing, so plan without them:
`screenshot`, `actions`, `/v2/agent`, browser/interact, `changeTracking`, and team credit-usage.
