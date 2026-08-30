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

**Gating.** Snips run under several configurations, so a test that needs an external service is gated with `describeIf`/`itIf`/`concurrentIf` and the constants from `src/__tests__/snips/lib.ts` (`TEST_PRODUCTION`, `HAS_AI`, `HAS_FIRE_ENGINE`, `HAS_MODEL_SWAP`, ...). Reading `process.env` directly in a test bypasses that and is wrong.

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

`src/lib/local-model.ts` exports `localModelFetch`, installed as the OpenAI provider's `fetch` option whenever `OPENAI_BASE_URL` is set. It rewrites the outgoing request body's `model` to: the model the server reports as loaded → `MODEL_NAME` → the first model the server lists → the model the caller named.

The point is servers that swap models on demand (llama-swap): only one model is resident and naming another costs a reload from disk, so a scrape must adopt whatever is already loaded. **Resolving this synchronously inside `getModel()` does not work** — a cached id read synchronously is always one request stale, and the stale request is exactly the one that triggers the swap. `getModel()` cannot be `async` (default-parameter positions across ~35 call sites), which is why the resolution lives at the fetch layer where the probe can be awaited. Probe results are cached 30s per process, concurrent callers coalesce onto one in-flight probe, and any failure degrades to `MODEL_NAME` rather than failing the request.

Covered by `src/lib/local-model.test.ts` and the live `src/__tests__/snips/v2/local-model.test.ts`. Background: `docs/superpowers/plans/2026-07-11-local-docker-lmstudio.md`.

## Toolchain and environment quirks

- **Two TypeScript versions pinned.** `pnpm build` resolves `typescript` (aliased to `@typescript/typescript6@6.0.2`); the dev `tsc-watch` scripts use `./node_modules/typescript-7/bin/tsc` (TS 7.0.2). Don't install or reference a global `typescript` — both must resolve to the workspace-pinned versions.
- **Native Rust addon.** `@mendable/firecrawl-rs` builds during `pnpm install` and needs a Rust toolchain. Without it, native scraping features are skipped — and every module importing it fails to typecheck, which is the usual explanation for a burst of `Cannot find module '@mendable/firecrawl-rs'` errors.
- **Go module.** `sharedLibs/go-html-to-md` is rebuilt by the harness on every run (`go mod tidy` + `go build`); a Go toolchain is required.
- **`undici` pinned** to `7.28.0` via `package.json` overrides — don't upgrade it through normal means.
- **pnpm workspace.** No root `package.json`; each app has its own. Install from the repo root.
- **FoundationDB backend.** Optional queue backend (`NUQ_BACKEND=fdb`); Postgres is the default and FDB is ignored.

### When `pnpm exec` fails on install

`pnpm exec` runs a dependency check first and aborts the command if the install fails — currently the case in this checkout, where `foundationdb`'s node-gyp build errors out and leaves the native addon unbuilt. Call the pinned binaries directly to work around it:

```bash
node node_modules/typescript-7/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run <file>
node node_modules/knip/bin/knip.js --cache
```

The Docker image builds fine regardless; the harness and the full snip suite do not run until the install is fixed.
