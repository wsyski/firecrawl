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

- Endpoint: `FC=${FIRECRAWL_API_URL:-http://192.168.1.100:3002}`
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
fc map https://docs.firecrawl.dev | grep api-reference
fc crawl https://docs.firecrawl.dev -n 10 --include '^/api-reference/.*'
fc batch https://example.com https://example.org
fc parse document.pdf
```

- `crawl` and `batch` poll until done and follow `next` pages. Progress goes to stderr.
- A dropped format or `.data.warning` is printed to stderr as `!!`. Do not suppress it.
- Other options: `--wait MS`, `--all-content` (keep nav and footer), `--json` (raw response,
  goes before the command), `--timeout S`, and `FIRECRAWL_API_URL` to override the endpoint.

## Raw API

Use curl for anything `fc` does not expose.

### Scrape a URL

```bash
curl -s $FC/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown","links"],"onlyMainContent":true}' \
  | jq -r .data.markdown
```

Formats: `markdown` (default), `html`, `rawHtml`, `links`. Options: `onlyMainContent`,
`waitFor` (ms, for JS pages; Liferay Learn search needs `6000`). PDF URLs work and add `numPages`.

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

- `sources`: `web`, `news`, `images` → `.data.web`, `.data.news`, `.data.images`.
- `tbs`: `qdr:d`, `qdr:w`, `qdr:m` (day, week, month).
- `"safe":true` drops explicit hits by asking Jev (an external OpenCode Zen model, about 2–3 s
  extra). The free tier returns 429 once its quota is spent.
- `"scrapeOptions":{"formats":["markdown"]}` adds page markdown to each hit (slower).
- Results come from SearXNG. An empty result usually means SearXNG engines failed, not that
  nothing exists. Diagnose with `/searxng`.

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

- **`success:true` does not mean the format came back.** An unsupported feature is dropped with
  only `.data.warning` set. Check the field you asked for.
- **LLM kill switch:** while `/opt/llm/lock/llm.lock` exists, `json` and `summary` fail. Plain
  scrape, search, map and crawl still work.
- The first LLM call after llama-swap has unloaded the model is slower.
- `mobile` and `location` each work with a "may be partial" warning. Combining them fails with 500.

## Not available here

These need fire-engine, browser sessions or cloud billing, so plan without them:
`screenshot`, `actions`, `/v2/agent`, browser/interact, `changeTracking`, and team credit-usage.
