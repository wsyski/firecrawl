See [DESIGN.md](DESIGN.md) for repo layout, test infrastructure, and environment quirks.

## API test-driven workflow

When changing the API, follow this order:

1. Write or update end-to-end tests (called `snips`) that assert your win conditions
   - 1 happy path (more if multiple distinct code paths)
   - 1+ failure path(s)
   - Snips live in `apps/api/src/__tests__/snips/v2/` (v1 also exists)
   - Use `scrapeTimeout` from `../lib` for all scrape timeouts (90s default)
   - Gate tests that need external services with `describeIf`/`itIf`/`concurrentIf` from `../lib`, using its constants — e.g. `describeIf(TEST_PRODUCTION)` for fire-engine, `describeIf(HAS_AI)` for AI features, `itIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)` for self-host-only paths. Don't check `process.env` directly.
   - Test helpers (`scrape`, `crawl`, `search`, `idmux`, `Identity`, ...) are imported from `./lib` (v2) or `../lib` (shared).

2. Write the implementation

3. Run tests with the harness (run from `apps/api/`):
   - Single snip: `pnpm harness pnpm exec vitest run src/__tests__/snips/v2/<file>.test.ts`
   - All snips: `pnpm harness pnpm test:snips`
   - Unit tests (colocated `*.test.ts`) do not need the harness: `pnpm exec vitest run src/lib/<file>.test.ts`
   - Don't start the server manually for tests — `pnpm harness` owns the stack ([DESIGN.md](DESIGN.md#test-infrastructure))
   - To run one snip against an already-running stack instead, see [DESIGN.md](DESIGN.md#running-one-snip-against-an-already-running-stack)
   - The full suite is slow; run only relevant tests locally, let CI run everything

4. Push to a branch, open a PR, let CI verify

## Pre-commit / lint

The husky pre-commit hook runs `knip` then `lint-staged` (prettier):

```bash
cd apps/api && pnpm knip --cache && pnpm lint-staged
```

Never bypass knip with `--no-verify`. If it reports unused exports or files, fix them — even pre-existing ones — before committing.

If `pnpm exec` aborts on a failing dependency install, call the pinned binaries directly — see [DESIGN.md](DESIGN.md#when-pnpm-exec-fails-on-install).

## Local dev setup

**Dependencies:** Node 20+, pnpm 9+, Rust (for `native/`), Go (harness builds `sharedLibs/go-html-to-md`), Docker or Podman (harness runs Postgres/RabbitMQ containers), Redis (must be running externally — the harness does not start it).

**Quick start via Docker Compose** (root of repo):
```bash
cp apps/api/.env.example apps/api/.env
docker compose up
```

**Manual setup** (harness manages Postgres + RabbitMQ containers itself):
```bash
cd apps/api
pnpm install  # requires pnpm 9+
redis-server  # terminal 1 — the only external service you must start
# Set .env from .env.example — minimally: REDIS_URL, BULL_AUTH_KEY
pnpm dev      # terminal 2 — harness --start: all services, auto-restart on changes
```

`pnpm start` is the built equivalent (`tsc && node dist/src/harness.js --start-built`).

## Key paths

| What | Path |
|------|------|
| API source | `apps/api/src/` |
| Controllers | `apps/api/src/controllers/v2/` |
| Shared lib | `apps/api/src/lib/` |
| Snips (E2E tests) | `apps/api/src/__tests__/snips/v2/` |
| Snip shared helpers | `apps/api/src/__tests__/snips/lib.ts` |
| Harness (test infra) | `apps/api/src/harness.ts` |
| Config (env schema) | `apps/api/src/config.ts` |
| TypeScript | `apps/api/tsconfig.json` (target ES2022, NodeNext) |
| Vitest config | `apps/api/vitest.config.ts` |
| Knip config | `apps/api/knip.config.ts` |
| Prettier | `apps/api/.prettierrc` (2-space, semi, double quotes, printWidth 80) |
| Design notes | `DESIGN.md` |
| Contributing guide | `CONTRIBUTING.md` |
| Self-host docs | `SELF_HOST.md` |

## Style conventions

- No docstrings or comment blocks by default. Only comments where the *why* is non-obvious.
- TypeScript: strict null checks on, `moduleResolution: "NodeNext"` (see `tsconfig.json`; `strict`/`noImplicitAny` are off).
- Import shared response types from `../../lib/entities`, not from controllers.
- Prettier-formatted; run `pnpm format` before committing if unsure.

## Obsidian vault

This project has no per-project vault (no `.claude-obsidian.json` at the root), so `/wiki-*` does not apply here. Its reference notes live in the general `KnowledgeBase` vault at `~/Documents/Obsidian/KnowledgeBase` — the local stack runbook is `docs/infrastructure/firecrawl-local-docker-llama-swap-setup.md`.
