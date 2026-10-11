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

## Search provider chain

`/v2/search` tries fire-engine → SearXNG → DuckDuckGo (`src/search/v2/index.ts`). Each provider returns
early only when it yields results, and the whole function catches and returns `{}`, so **every failure mode
presents as "search returns nothing"** rather than an error. Debug by reading the `logger.info` line for the
provider it actually took, not by looking for a thrown exception.

SearXNG is not a service in this repo's `docker-compose.yaml`. It runs as a separate Compose project at
`/opt/playground/searxng`, published on the LAN, and Firecrawl reaches it via `SEARXNG_ENDPOINT` in `.env`.
CI (`.github/workflows/test-server.yml`) is upstream's self-host matrix and starts its *own* SearXNG
container on `localhost:3434`, so a green CI run says nothing about the local `.env`.

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

## Toolchain and environment quirks

- **Two TypeScript versions pinned.** `pnpm build` resolves `typescript` (aliased to `@typescript/typescript6@6.0.2`); the dev `tsc-watch` scripts use `./node_modules/typescript-7/bin/tsc` (TS 7.0.2). Don't install or reference a global `typescript` — both must resolve to the workspace-pinned versions.
- **Native Rust addon.** `@mendable/firecrawl-rs` builds during `pnpm install` and needs a Rust toolchain. Without it, native scraping features are skipped — and every module importing it fails to typecheck, which is the usual explanation for a burst of `Cannot find module '@mendable/firecrawl-rs'` errors.
- **Go module.** `sharedLibs/go-html-to-md` is rebuilt by the harness on every run (`go mod tidy` + `go build`); a Go toolchain is required.
- **`undici` pinned** to `7.30.0` — as a direct dependency in `apps/api/package.json` *and* re-pinned in the `overrides` block of `apps/api/pnpm-workspace.yaml`. Don't upgrade it through normal means.
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
