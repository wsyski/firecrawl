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
- **Agent skill:** `skills/firecrawl/` is the source of truth for the `/firecrawl` skill in the user
  hub (`~/.agents/skills/firecrawl`). It documents only what this instance does. After editing it, run
  `skills/sync.sh sync`; `skills/sync.sh check` fails on drift. Upstream's build skills were removed
  from `skills/`. If an upstream merge touches them, resolve the modify/delete conflict with `git rm`.
  Rationale: [DESIGN.md](DESIGN.md#agent-skill).
- **Skill validation:** every `SKILL.md` is linted by agnix (`.agnix.toml` + the `node:test` case in
  `.github/scripts/skill-validate.test.mjs`, run by the CI Scripts Check workflow). `.agnix.toml` names
  the `claude-code` runtime rather than disabling AS-016 — the skill's nested `metadata.hermes` is valid
  there and not under the generic target — and excludes `apps/**`, which is product code with no agent
  config. Run it with `node --test .github/scripts/skill-validate.test.mjs`; without `uvx` it skips, and
  CI turns that skip into a failure. Upstream has no `.agnix.toml`, so it is fork-only and merge-safe.
- `CLAUDE.md` is a one-line `@AGENTS.md` pointer — this file is the single source; don't fork it.
- **Env:** root `.env` is **tracked** (shared config); `.env.prod` is gitignored (credentials) and wins.
  The API process reads `apps/api/.env`, which doesn't exist — source the root `.env` yourself outside
  Compose. Rationale: [DESIGN.md](DESIGN.md#configuration-and-environment-files).
  Local model env: `MODEL_NAME`, `OPENAI_BASE_URL`, `LLM_DISABLE_THINKING`, `LLM_SLOT_ID`, `LLM_LOCK_FILE`.

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
  `redis:alpine` and RabbitMQ is `rabbitmq:3-management`. Runtime LLM kill switch:
  `touch /opt/llm/lock/llm.lock` / `rm` it (no restart needed).
- **No `searxng` service here** — SearXNG is a separate Compose project at `/opt/playground/searxng`,
  reached over the LAN via `SEARXNG_ENDPOINT` in `.env`. `/v2/search` falls back silently through
  fire-engine → SearXNG → DuckDuckGo, so a broken SearXNG just returns no results. CI starts its own
  SearXNG on `localhost:3434`; CI is not the local stack. ([DESIGN.md](DESIGN.md#search-provider-chain))

## Toolchain gotchas

All commands run from `apps/api/`. `pnpm` is not on `PATH` — use `corepack pnpm …` (pins pnpm@11.4.0).

- If `pnpm exec` aborts on a dependency re-check, call the pinned binaries directly instead:
  ```bash
  node node_modules/typescript-7/bin/tsc --noEmit
  node node_modules/vitest/vitest.mjs run src/lib/<file>.test.ts
  node node_modules/knip/bin/knip.js --cache
  ```
  Don't "fix" this by bumping pnpm — see [DESIGN.md](DESIGN.md#toolchain-and-environment-quirks).
- Two TypeScript versions: `pnpm build` resolves `typescript` (= `@typescript/typescript6@6.0.2`), the
  `tsc-watch` scripts use `node_modules/typescript-7` (7.0.2). Never reference a global `tsc`.
- `@mendable/firecrawl-rs` (Rust) builds during install; without it every importing module fails to
  typecheck. The harness rebuilds `sharedLibs/go-html-to-md`, so Go is required too.

## API test-driven workflow

1. Write or update end-to-end tests (called `snips`) that assert your win conditions. Snips live in
   `apps/api/src/__tests__/snips/v2/` (v1 also exists).
   - 1 happy path (more per distinct code path); 1+ failure path(s).
   - Helpers (`scrape`, `crawl`, `search`, `idmux`, `Identity`, ...) and `scrapeTimeout` (90s) come from
     `./lib` (v2) or `../lib`.
   - Gate external-service tests with `describeIf`/`itIf`/`concurrentIf` and the constants from `lib.ts`:
     `describeIf(TEST_PRODUCTION)` for fire-engine, `describeIf(HAS_AI)` for AI features,
     `itIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)` for self-host-only. Never read `process.env` in a test.

2. Write the implementation.

3. Run it (`pnpm` → `corepack pnpm`):
   - Single snip: `corepack pnpm harness pnpm exec vitest run src/__tests__/snips/v2/<file>.test.ts`
   - All snips: `corepack pnpm harness pnpm test:snips`
   - Unit tests (colocated `*.test.ts`) need no harness:
     `corepack pnpm exec vitest run src/lib/<file>.test.ts`
   - Don't start the server yourself for tests — the harness owns the stack. To run one snip against an
     already-running stack, see [DESIGN.md](DESIGN.md#running-one-snip-against-an-already-running-stack).
   - The full suite is slow; run only relevant tests locally and let CI run everything.

4. Push to a branch, open a PR, let CI verify.

## Postman integration suite (against the running Compose stack)

Black-box smoke suite hitting the live API on `localhost:3002` — rebuild Compose first, it does not use
the working tree.

```bash
./postman/run.sh                              # everything
./postman/run.sh --folder "Queue Admin (optional)"
```

- Defaults to the untracked `firecrawl-integration-test.postman_environment.prod.json` (the one deployed
  to Postman, carrying the keys). `FIRECRAWL_POSTMAN_ENV` forces the committed keyless copy, in which the
  Jev requests skip themselves and Bull Board / Open API model listing fail.
- Credentials resolve shell export → `.env.prod` → the environment file; endpoints come from `.env`.
  Paths overridable via `FIRECRAWL_ENV` / `FIRECRAWL_SECRETS` / `FIRECRAWL_POSTMAN_ENV`.
- Missing `TYPESAFE_API_KEY` warns rather than aborts and surfaces as a bare 401 from Zen.
- Secrets go on the `newman` command line; never echo that command back with values.

Details: [DESIGN.md](DESIGN.md#postman-integration-suite).

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
| Search providers + fallback chain | `apps/api/src/search/v2/index.ts` |
| Fork LLM transport / Jev safe filter | `apps/api/src/lib/{local-model,generic-ai}.ts`, `src/search/safe-search.ts` |
| Postman suite | `postman/run.sh`, `postman/firecrawl-integration-test.postman_collection.json` |
| Vitest / Knip / Prettier / TS config | `apps/api/{vitest.config.ts,knip.config.ts,.prettierrc,tsconfig.json}` |
| Design notes / self-host docs | `DESIGN.md`, `SELF_HOST.md` |

`firecrawl-cli/`, `firecrawl-skills/`, `firecrawl-workflows/`, `firecrawl-cli-skills/` are upstream
README-only pointers to separate catalogs — no code. `skills/` holds the fork's local skill (see above);
`sync-skills-catalog.yml` is guarded to run only in `firecrawl/firecrawl`.

## Style conventions

- No docstrings or comment blocks by default; comments only where the *why* is non-obvious.
- TS: `strictNullChecks` on, `strict`/`noImplicitAny` off, `moduleResolution: "NodeNext"` (target ES2022).
- Import shared response types from `../../lib/entities`, not from controllers. Prettier: 2-space,
  semicolons, double quotes, printWidth 80; run `corepack pnpm format` if unsure.

## Obsidian vault

This project has no per-project vault (no `.claude-obsidian.json` at the root), so `/wiki-*` does not
apply. Reference notes live in the general `KnowledgeBase` vault at `~/Documents/Obsidian/KnowledgeBase`
— the local stack runbook is `docs/infrastructure/firecrawl-local-setup.md`; SearXNG (a separate
project, `/opt/playground/searxng`) is `docs/infrastructure/searxng-local-setup.md`.
