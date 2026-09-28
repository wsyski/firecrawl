This is `wsyski/firecrawl`, a fork of `firecrawl/firecrawl` self-hosted with Docker Compose, running
LLM features on a local llama-swap / llama.cpp server. Read the "This fork" section at the top of
[README.md](README.md) before touching LLM code. [DESIGN.md](DESIGN.md) covers repo layout, test
infrastructure, and toolchain quirks.

## Fork-specific (read first)

- Remotes: `origin` = `wsyski/firecrawl`, `upstream` = `firecrawl/firecrawl`. Work on `main`; catch up
  with `git fetch upstream && git merge upstream/main`.
- Fork-only LLM behavior: `apps/api/src/lib/local-model.ts` (`localModelFetch`, `isLocalLlmUrl`, the
  thinking/slot/lock fields) and `apps/api/src/lib/generic-ai.ts` (installs it as the OpenAI provider's
  `fetch` when `OPENAI_BASE_URL` is local). Upstream merges are most likely to conflict in those two,
  plus `config.ts`, `controllers/v1/types.ts`, `docker-compose.yaml`, and the README fork section.
- Config for Docker comes from the **repo-root `.env`** (not committed), not `apps/api/.env`. Local
  model env: `MODEL_NAME`, `OPENAI_BASE_URL`, `LLM_DISABLE_THINKING`, `LLM_SLOT_ID`, `LLM_LOCK_FILE`.
  Running the server directly from `apps/api` instead loads `apps/api/.env` via `dotenv/config`.

## Docker Compose deployment (primary run path)

```bash
mkdir -p /opt/llm/lock                 # host dir bind-mounted at /llm-lock for LLM_LOCK_FILE
docker compose up -d --build           # build + start everything
docker compose up -d --build api       # rebuild/redeploy only the API after a code change
docker compose ps
docker compose logs api --tail=200
curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/v0/health/liveness   # expect 200
```

- The API container runs compiled code — rebuild it before testing a source change against it.
- Compose builds `apps/api`, `apps/playwright-service-ts`, and `apps/nuq-postgres`; Redis is stock
  `redis:alpine`. Runtime LLM kill switch: `touch /opt/llm/lock/llm.lock` / `rm` it (no restart needed).

## Toolchain gotchas

- `pnpm` is not on `PATH`; use `corepack pnpm …`. `pnpm exec` first runs a dependency-status check that
  currently aborts (the native `foundationdb` build fails without its client headers), so call the pinned
  binaries directly:
  ```bash
  cd apps/api
  node node_modules/vitest/vitest.mjs run src/lib/<file>.test.ts
  node node_modules/typescript-7/bin/tsc --noEmit
  node node_modules/knip/bin/knip.js --cache
  ```
- Two TypeScript versions are pinned: `pnpm build` uses `typescript` (= `@typescript/typescript6@6.0.2`);
  the `tsc-watch` dev scripts use `node_modules/typescript-7` (7.0.2). Never reference a global `tsc`.
- `@mendable/firecrawl-rs` (Rust) builds during install; without a Rust toolchain every import fails to
  typecheck. The harness rebuilds `sharedLibs/go-html-to-md` each run, so Go is required.

## API test-driven workflow

When changing the API, follow this order:

1. Write or update end-to-end tests (called `snips`) that assert your win conditions
   - 1 happy path (more if multiple distinct code paths); 1+ failure path(s)
   - Snips live in `apps/api/src/__tests__/snips/v2/` (v1 also exists)
   - Use `scrapeTimeout` (90s) from `../lib` for all scrape timeouts
   - Gate tests that need external services with `describeIf`/`itIf`/`concurrentIf` from `../lib`:
     `describeIf(TEST_PRODUCTION)` for fire-engine, `describeIf(HAS_AI)` for AI features,
     `itIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)` for self-host-only paths. Never read `process.env` in a test.
   - Helpers (`scrape`, `crawl`, `search`, `idmux`, `Identity`, ...) come from `./lib` (v2) or `../lib`.

2. Write the implementation

3. Run tests with the harness (from `apps/api/`, `pnpm` → `corepack pnpm`):
   - Single snip: `corepack pnpm harness pnpm exec vitest run src/__tests__/snips/v2/<file>.test.ts`
   - All snips: `corepack pnpm harness pnpm test:snips`
   - Unit tests (colocated `*.test.ts`) need no harness. On this host `pnpm exec` aborts — use the direct
     `node node_modules/vitest/vitest.mjs run …` form above
   - Don't start the server yourself for tests — the harness owns the stack ([DESIGN.md](DESIGN.md#test-infrastructure))
   - To run one snip against an already-running stack, see [DESIGN.md](DESIGN.md#running-one-snip-against-an-already-running-stack)
   - The full suite is slow; run only relevant tests locally and let CI run everything

4. Push to a branch, open a PR, let CI verify.

## Pre-commit / lint

The husky hook runs `knip` then `lint-staged` (prettier): `cd apps/api && corepack pnpm knip --cache && corepack pnpm lint-staged`.
Never bypass knip with `--no-verify`; fix unused exports/files it reports, even pre-existing ones.

## Key paths

| What | Path |
|------|------|
| API source / controllers / shared lib | `apps/api/src/`, `.../controllers/v2/`, `.../lib/` |
| Snips + shared helpers | `apps/api/src/__tests__/snips/v2/`, `.../snips/lib.ts` |
| Harness (test infra) | `apps/api/src/harness.ts` |
| Env schema | `apps/api/src/config.ts` |
| Vitest / Knip / Prettier / TS config | `apps/api/{vitest.config.ts,knip.config.ts,.prettierrc,tsconfig.json}` |
| Design notes / self-host docs | `DESIGN.md`, `SELF_HOST.md` |

## Style conventions

- No docstrings or comment blocks by default; comments only where the *why* is non-obvious.
- TS: `strictNullChecks` on, `strict`/`noImplicitAny` off, `moduleResolution: "NodeNext"` (target ES2022).
- Import shared response types from `../../lib/entities`, not from controllers. Prettier: 2-space,
  semicolons, double quotes, printWidth 80; run `corepack pnpm format` if unsure.

## Obsidian vault

This project has no per-project vault (no `.claude-obsidian.json` at the root), so `/wiki-*` does not
apply. Reference notes live in the general `KnowledgeBase` vault at `~/Documents/Obsidian/KnowledgeBase`
— the local stack runbook is `docs/infrastructure/firecrawl-local-docker-llama-swap-setup.md`.
