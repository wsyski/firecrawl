# Design

## Repo layout

Firecrawl is a web scraper API. The directory is a monorepo:

- `apps/api` — the API and worker code (everything below concerns this app unless stated)
- `apps/*-sdk` — the language SDKs
- `sharedLibs/go-html-to-md` — Go HTML→Markdown converter, built by the harness
- `apps/api/native/` — `@mendable/firecrawl-rs`, a Rust addon exposed as a workspace package

## Test infrastructure

**Two layers.** Colocated `*.test.ts` unit tests run against nothing external. End-to-end tests (`snips`, in `src/__tests__/snips/`) drive a live API and are the preferred form for API behaviour.

**`src/harness.ts`** starts and stops the API, the workers and the infra containers (Postgres, RabbitMQ) as child processes. `pnpm harness <command...>` installs deps, builds TS and Go, brings that stack up, runs the command, and tears it down. It is the only supported way to run anything against a live stack — do not spawn the server yourself in a test. Redis is the one service it does not start.

**`vitest.config.ts`** sets `globals: true` (no `describe`/`it`/`expect` imports), the `forks` pool, `isolate: true` and a 120s per-test timeout. The suite talks to real services and manages mock state by hand, so these are load-bearing defaults rather than preferences.

**Gating.** Snips run under several configurations, so a test that needs an external service is gated with `describeIf`/`itIf`/`concurrentIf` and the constants from `src/__tests__/snips/lib.ts` (`TEST_PRODUCTION`, `HAS_AI`, `HAS_FIRE_ENGINE`, ...). Reading `process.env` directly in a test bypasses that and is wrong.

### Running one snip against an already-running stack

Useful against the Docker Compose deployment, and the fallback when the harness cannot run. `apps/api` does not read the repo-root `.env`, so the environment has to be sourced explicitly:

```bash
cd apps/api && set -a && . ../../.env && set +a && \
  TEST_SUITE_SELF_HOSTED=true TEST_API_KEY=test TEST_TEAM_ID=test \
  pnpm exec vitest run src/__tests__/snips/v2/<file>.test.ts
```

- `TEST_API_KEY`/`TEST_TEAM_ID` are consumed by `idmux`'s fallback identity when `IDMUX_URL` is unset; any value works while `USE_DB_AUTHENTICATION=false`.
- `TEST_SUITE_SELF_HOSTED` must be set, or `lib.ts` refuses to run against the default local `TEST_SUITE_WEBSITE`.
- The API container runs compiled code — rebuild it (`docker compose up -d --build api`) before testing a source change against it.

## Local LLM model selection

Firecrawl does not pick the local model; llama-swap does. `MODEL_NAME=default` names a llama-swap selector with the `warm` strategy (llama-swap v241+, declared in llama-swap's `config.yaml`): per request it serves a `ready` target, else a `starting` one, else loads `targets[0]` (`swift15-27b`). So a scrape adopts whatever model another client already has loaded, and the choice is made atomically inside llama-swap rather than by a Firecrawl-side probe that can go stale between the check and the request.

`src/lib/local-model.ts` exports `localModelFetch`, installed as the OpenAI provider's `fetch` option only when `isLocalLlmUrl(OPENAI_BASE_URL)` (loopback, private/Tailscale IP, single-label or `*.local`/`*.lan`/`*.internal` host). It never touches `model`; it adds llama.cpp fields to chat bodies (`LLM_DISABLE_THINKING`, `LLM_SLOT_ID`) and enforces the `LLM_LOCK_FILE` kill switch. A cloud `OPENAI_BASE_URL` gets plain `fetch`, so requests go out exactly as the SDK builds them. Covered by `src/lib/local-model.test.ts`.

## Configuration and environment files

Three files, and the split is deliberate:

| File | Tracked | Holds |
|---|---|---|
| `.env` (repo root) | yes | shared, credential-free config for the Compose stack |
| `.env.prod` (repo root) | no | credentials only |
| `apps/api/.env` | no | does not exist in this checkout |

Compose's `env_file` on `x-common-service` lists `.env` then `.env.prod`, so `.env.prod` wins. That ordering
is the *only* override mechanism: an entry in `environment:` (`x-common-env`) beats `env_file`, so putting
a secret there would clobber it with an empty interpolated value. Conversely, because `env_file` passes every
key through, a new `config.ts` variable works without being listed in `x-common-env` — the historical
`TYPESAFE_*`/`MAX_RAM` unset failures predate that.

The API process does **not** read the repo-root `.env`. `config.ts` and `index.ts` import `dotenv/config`,
which reads `apps/api/.env` — a file that does not exist here. Running outside Compose therefore needs the
root env sourced explicitly.

## Dropped formats

A scrape used to return `success: true` with a requested format's field simply
absent: `coerceFieldsToFormats` logged "Request had format X, but there was no X
field in the result" and nothing reached the caller. That is the root of the
"check the field you asked for" gotcha, and the main source of silent failure
for an API consumer — the local LLM being locked or unreachable drops `json` and
`summary` exactly this way, by design (see the `LLM_LOCK_FILE` section of the
README: the scrape still succeeds, just without the LLM formats).

**The response now carries `data.droppedFormats`**, the list of formats the
caller asked for that the document does not contain, and a sentence naming the
same formats is appended to `data.warning`. Both are set at the end of
`coerceFieldsToFormats` from `findDroppedFormats` (`src/lib/dropped-formats.ts`),
which holds the format-to-field map — `json`/`deterministicJson` accept either
`json` or `extract`, `question`/`query` both answer into `answer`, `video`
accepts `video` or `videos`. The field is present **only when something was
dropped**, so its absence means nothing was.

One path needs its own call: a `BrandingNotSupportedError` on a non-HTML page
filters `branding` out of `meta.options.formats` before the transformers run
(`scrapeURL/index.ts`), so `coerceFieldsToFormats` no longer counts it as
requested. That branch calls `addDroppedFormats(document, "branding")` next to
the warning it already set.

**Why a field and not an error.** Returning 4xx/5xx for a format that could not
be produced was the other option, and it would break the callers this change
exists for: a scrape that yields markdown but no `summary` because the local
model was busy is a useful partial result today, and the portfolio project's
cron jobs consume it. An error would also turn the LLM kill switch into a hard
outage rather than graceful degradation. A caller that wants error-on-partial
gets it in one line — `if (data.droppedFormats) throw` — whereas a caller that
wants the partial result cannot recover it from a 4xx. Additive field, existing
callers unchanged.

## Search provider chain

`/v2/search` tries fire-engine → SearXNG → DuckDuckGo (`src/search/v2/index.ts`). Each provider returns
early only when it yields results, and the whole function catches rather than throwing, so **no failure
mode surfaces as an error** — the response is still `success: true` with empty groups. What used to make
that undebuggable was that the choice was invisible; it is now in the response, so read `provenance`
(below) for which provider answered and why the others did not, rather than hunting for a thrown
exception or grepping the `logger.info` line.

SearXNG is not a service in this repo's `docker-compose.yaml`. It runs as a separate Compose project at
`/opt/playground/searxng`, published on the LAN, and Firecrawl reaches it via `SEARXNG_ENDPOINT` in `.env`.
CI (`.github/workflows/test-server.yml`) is upstream's self-host matrix and starts its *own* SearXNG
container on `localhost:3434`, so a green CI run says nothing about the local `.env`.

### Provenance

The chain's silence was the second half of the same problem: each provider
returned early only when it had results, the function caught everything and
returned `{}`, and SearXNG's own `unresponsive_engines` was thrown away. An
empty answer could therefore mean "nothing matched", "SearXNG was unreachable",
"the upstream engines timed out" or "a different provider answered", with the
`logger.info` line as the only way to tell.

`/v2/search` now returns a **`provenance` object beside `data`** — not inside
it, since it describes the request rather than a result group. `executeSearch`
lifts it off the `SearchV2Response` the chain returns, so result counting,
scraping, job logging and `data` itself are untouched:

```json
{ "success": true, "data": { "web": [] },
  "provenance": {
    "attempts": [
      { "provider": "fire-engine", "outcome": "skipped", "detail": "FIRE_ENGINE_BETA_URL is not set" },
      { "provider": "searxng", "outcome": "empty",
        "unresponsiveEngines": [{ "engine": "google", "reason": "timeout" }] },
      { "provider": "duckduckgo", "outcome": "empty" }
    ],
    "searxngCategories": { "web": "general" } } }
```

`unknownEngines` is the instance's `unknown_engines`: engine pins SearXNG did
not recognise and silently ignored, which means the query actually ran against
the category's whole engine set. The field is new in the LAN instance's own fork
(observed live: `?engines=bing news,no such engine` →
`unknown_engines: ["no such engine"]`), read through
`normalizeUnknownEngines` so an instance that omits it simply reports none.

`unknownCategories` is the same report one level up, and the failure it covers
is worse. An unknown `categories=` name selects no engine at all, so the
instance runs its DEFAULT search: `categories=finance-polnd` (one letter off
`finance poland`) answered 36 rows from `mwmbl`, `duckduckgo web` and `yahoo`,
with `unknown_engines` empty because nothing was pinned. **When EVERY name in the caller's own
`searxngCategory` was dropped, the adapter now refuses those rows**
(`outcome: "error"`, the names in `detail`) instead of returning another
category's results as the answer — the same wrong-category rule the
DuckDuckGo guard below already follows. A partly-known pin
still answers: `finance,finance-polnd` leaves `finance` in the list, so its
engines ran and those rows are the caller's own — only a pin where nothing
survived produces somebody else's. A name that came from `SEARXNG_CATEGORIES`
or the news default is an operator misconfiguration, not this request's
problem: it is reported in `unknownCategories` and the search still answers.

`engineData` is SearXNG's `engine_data`, the channel an engine uses to report
something about its own response. The LAN instance's `sii` publishes
`dropped_rows` / `site_rows` there on every response, which is the difference
between "the source has nothing" and "the engine's relevance filter removed
everything". Read through `normalizeEngineData`; an instance that omits the
field reports none, and the attempt carries the key only when something is in
it.

`provider` names whichever attempt returned results and is absent when none
did. `outcome` is one of `results` / `empty` / `error` / `skipped`, so both a
fallthrough and a failure are visible; `searxng_search` returns its outcome
instead of a bare `{}` for exactly this reason. Types live in
`src/search/v2/provenance.ts`.

**One caveat.** `outcome` is derived from `.results`, and SearXNG's answerer
categories (`currency`, `weather`, `define`, `translate`) reply in `.answers`
instead, which Firecrawl discards at the mapper. A `searxngCategory` naming one
of those therefore reports `empty` for a query the instance did answer. The
categories the portfolio needs (`finance`, `finance poland`) return ordinary
`.results` rows and are unaffected; passing `.answers` through is a separate
change.

`unresponsiveEngines` is SearXNG's `unresponsive_engines`, read by
`normalizeUnresponsiveEngines` rather than cast. The live instance returns `[]`
on a healthy query and the documented `[engine, reason]` pairs otherwise —
`[["qwant news", "access denied"]]` on `categories=news`, which arrives here as
`{ "engine": "qwant news", "reason": "Suspended: access denied" }` — but the
shape has moved between SearXNG releases, and the LAN instance is a fork
(`/opt/playground/searxng`) that may add fields of its own. The normalizer accepts a pair, a bare string or an
object (`engine`/`name`, `reason`/`error`/`message`), drops anything it cannot
read and never throws, so a changed upstream shape costs provenance detail
instead of failing the search.

### Per-request SearXNG category

`categories` is Firecrawl's own research/pdf/developer/gov filter (`github` answers 400 since upstream removed it) and has
nothing to do with SearXNG's categories, so there was no way to ask this
instance for `finance` or `finance poland` — the reason the portfolio project
kept a second SearXNG client of its own. `/v2/search` now accepts
**`searxngCategory`**, a comma-separated list of the instance's own category
names, validated by shape rather than against a list because the names are
instance configuration (`/config` here offers 35, `q&a` and `stock images`
included). It overrides the category every requested source would otherwise map
to, and clears the `SEARXNG_ENGINES` pin for the same reason `categoryOf`
already does for news and images: a web engine pin leaves another category with
no engine to run.

Two consequences, both deliberate:
- **No DuckDuckGo fallback for a pinned category.** DDG cannot honour
  `finance`, so serving its generic web rows would be the same wrong-category
  substitution the news/images guard already refuses. The attempt is recorded
  as `skipped`, with the category in `detail`.
- **SearXNG only.** On a fire-engine deployment the field is inert and the
  attempt carries a `detail` saying so. The categories a request actually used
  come back in `provenance.searxngCategories`, so a caller never has to assume.
- **A category this instance does not have is refused, not substituted.** See
  `unknownCategories` above. The instance has to report it for this to work:
  without `unknown_categories` in the response there is nothing to key on, and
  the default search's rows are indistinguishable from the pinned category's.

**Not reachable from the CLI.** `firecrawl search` (the separate `firecrawl-cli`
project; this repo carries only a link) has `--sources` and `--categories` —
Firecrawl's own research/pdf/developer/gov filter — and no `--searxng-category`, so
`searxngCategory` is an API-body field only. That is why the portfolio's
`finance_news.py` still talks to SearXNG directly.

**Source mapping.** `sources` reaches SearXNG as a category: `news` → `SEARXNG_NEWS_CATEGORIES` (here
`news`), `images` → `images`, web → `SEARXNG_CATEGORIES` (`general`, see below). A per-request
`searxngCategory` overrides all three. `tbs` is
forwarded as SearXNG `time_range` for `qdr:d/w/m/y`; `qdr:h` has no SearXNG bucket and is dropped.
DuckDuckGo is a **web** fallback only: a news/images-only request that SearXNG cannot fill returns
empty rather than DDG web rows, which used to appear under the wrong source. The local news + range
path is currently empty because the only enabled range-capable news engine (`bing news`) returns no
day/week results here; the portfolio therefore does not send `tbs` on news searches.

**`SEARXNG_CATEGORIES` is `general`.** It was empty, which sent SearXNG no
`categories` parameter at all and left a `sources: web` search on whatever the
instance happened to default to — undefined from this side, and owned by a
*separate* Compose project (`/opt/playground/searxng`) whose settings can change
without anything here noticing. `general` is what that default resolves to
today: measured on the live instance with one query three ways, no `categories`
and `categories=general` returned the same 49 rows from the same engines
(`mwmbl` 39, `yahoo` 7, `duckduckgo web` 3), so pinning it is
behaviour-preserving and makes the web route explicit instead of inherited.

`general` is **not** the only general-web category there. The same query with
`categories=web` returned 72 rows from a disjoint engine set (`google cse`,
`google cse images`, `naver`, `seznam`, `yahoo`) and 11 unresponsive engines.
`web` is a genuinely different, broader and flakier route, so it is a per-request
choice (`searxngCategory: "web"`) rather than the default. `SEARXNG_ENGINES`
stays empty: an engine pin overrides the category for web searches and would
leave the other categories unservable. News keeps its own key
(`SEARXNG_NEWS_CATEGORIES=news`); a caller that wants anything else passes
`searxngCategory` per request rather than relying on an instance default.

## Postman integration suite

`postman/run.sh` is the fork's black-box smoke suite: `newman` against the collection in `postman/`, hitting
the live API on `localhost:3002`. It therefore exercises whatever Compose last built, not the working tree —
rebuild first. It resolves configuration from three sources:

| What | Sources, in precedence order |
|---|---|
| credentials (`OPENAI_API_KEY`, `BULL_AUTH_KEY`, `TYPESAFE_API_KEY`) | shell export → `.env.prod` → the Postman environment file |
| endpoints (`OPENAI_BASE_URL`, `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`) | shell export → `.env` |

Two environment files exist and are not interchangeable. The committed
`firecrawl-integration-test.postman_environment.json` has every endpoint filled in but blank keys; the
untracked `.prod` copy carries `bullAuthKey`, `openApiKey` and `typesafeApiKey` and is the **default**, so a
local run exercises the same values the Postman workspace sees. `FIRECRAWL_POSTMAN_ENV` forces the keyless
copy, in which the Jev requests skip themselves and Bull Board / Open API model listing fail.

Preflight distinguishes a hard stop (missing `OPENAI_API_KEY`, `BULL_AUTH_KEY` or `OPENAI_BASE_URL`) from a
warning (missing `TYPESAFE_API_KEY`), because the latter surfaces only as a bare 401 from Zen on the Jev
requests. It execs `newman` with secrets on the command line.

## Agent skill

`skills/firecrawl/` is a single listed (`/firecrawl`-only) skill. It uses curl, with no key, against
`192.168.1.100:3002`. It replaces two upstream families:
- the build skills that lived in `skills/` (SDK onboarding, API keys, cloud endpoints);
- the hub's 9-skill `firecrawl/cli` set.

Both described cloud Firecrawl. Here there is no auth and no fire-engine, so screenshots, actions,
browser/interact and agent don't exist. LLM formats run on the local model. Every command in the skill
was run against this instance; the unsupported list comes from the same probe.

The skill describes this deployment, so it lives next to it and is mirrored into `~/.agents/skills/`
by `bin/deploy-skills.sh` (no flag previews the plan and the drift; `--apply` writes; `--check`
is the drift gate). That inverts the hub's "~/.agents is the source of truth" rule, as
`/opt/playground/searxng` does. Without the hub, `--check` skips instead of failing, so CI is unaffected.
The skill has no `routes`/`requires` in `~/.agents/manual-skills.json`. With them, `/skill-sync` would
stamp a generated block into the hub copy and `--check` would report drift permanently.

## Toolchain and environment quirks

- **Two TypeScript versions pinned.** `pnpm build` resolves `typescript` (aliased to `@typescript/typescript6@6.0.2`); the dev `tsc-watch` scripts use `./node_modules/typescript-7/bin/tsc` (TS 7.0.2). Don't install or reference a global `typescript` — both must resolve to the workspace-pinned versions.
- **Native Rust addon.** `@mendable/firecrawl-rs` builds during `pnpm install` and needs a Rust toolchain. Without it, native scraping features are skipped — and every module importing it fails to typecheck, which is the usual explanation for a burst of `Cannot find module '@mendable/firecrawl-rs'` errors.
- **Go module.** `sharedLibs/go-html-to-md` is rebuilt by the harness on every run (`go mod tidy` + `go build`); a Go toolchain is required.
- **`undici` pinned** to `7.30.1` — as a direct dependency in `apps/api/package.json` *and* re-pinned in the `overrides` block of `apps/api/pnpm-workspace.yaml`. Don't upgrade it through normal means.
- **pnpm workspace.** No root `package.json`; each app has its own. Install from the repo root.
- **FoundationDB backend.** Optional queue backend (`NUQ_BACKEND=fdb`); Postgres is the default and FDB is ignored.

### When `pnpm exec` fails on install

`pnpm exec` runs a dependency check first and aborts the command if the install fails — currently the case
in this checkout, where `foundationdb`'s node-gyp build errors out and leaves the native addon unbuilt.
`verifyDepsBeforeRun: false` in `apps/api/pnpm-workspace.yaml` keeps that from recurring once deps are in
place. Call the pinned binaries directly to work around it:

```bash
node node_modules/typescript-7/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run <file>
node node_modules/knip/bin/knip.js --cache
```

Do not "fix" this by bumping pnpm: 11.4.0 (the upstream pin) and 12.10.1 fail identically on the
`foundationdb` build, and a bump rewrites `apps/api/package.json` plus ~158 lines of pnpm-self entries in the
lockfile. Set `NUQ_BACKEND=pg` (the default) so nothing needs the FDB client.

The Docker image builds fine regardless; the harness and the full snip suite do not run until the install is
fixed.
