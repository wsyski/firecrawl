# Upstream Merge + Dynamic Local-Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the in-flight merge with `upstream/main`, then stop pinning the local LLM to a hardcoded `MODEL_NAME` by asking llama-swap which model is already resident and using that one.

**Architecture:** llama-swap (`http://192.168.1.100:8081`) fronts three llama.cpp slots and keeps exactly one resident; a swap costs a full model reload from disk. `GET ${OPENAI_BASE_URL}/models` already reports `status.value: "loaded" | "unloaded"` per model, so a single request answers "what is loaded right now". A new module `apps/api/src/lib/local-model.ts` keeps that answer in a TTL cache refreshed in the background and exposes one synchronous accessor; `getModel()` in `generic-ai.ts` consults it instead of reading `config.MODEL_NAME` directly. `config.MODEL_NAME` stays as the fallback default for "nothing loaded" — that is what removes `ornith-35b` from the code without inventing a new config knob.

**Tech Stack:** TypeScript (NodeNext, ES2022), Vitest (`globals: true`), Zod-validated env in `apps/api/src/config.ts`, `@ai-sdk/openai` via `apps/api/src/lib/generic-ai.ts`.

**Spec:** No separate spec doc. The serving contract this plan depends on is the llama-swap section of `~/Documents/Obsidian/KnowledgeBase/docs/large-language-models/llama-server-configuration.md` (KnowledgeBase vault); the local-stack history is `docs/superpowers/plans/2026-07-11-local-docker-lmstudio.md`.

## Global Constraints

- **Do not edit `.env` or `.env.example`.** A PreToolUse hook blocks it, deliberately. Any env change is handed to the user as a one-line instruction.
- `config.MODEL_NAME` keeps its current meaning for every non-llama-swap deployment: when set it wins over the caller-supplied model name. The new behaviour activates only when `config.OPENAI_BASE_URL` is set.
- No new env variables. No allowlist of permitted models.
- `getModel()` must stay **synchronous** — it is used in default parameter positions (`apps/api/src/scraper/scrapeURL/transformers/llmExtract.ts:319`, `:322`, `apps/api/src/lib/extract/fire-0/llmExtract-f0.ts:182`) across 35 call sites, so an `async` signature is not available.
- A failed or slow probe must never fail or delay a scrape: short timeout, fall back to `config.MODEL_NAME`, warn — never throw, never cache an empty value, never retry per request.
- Never bypass the husky hook (`knip` then `lint-staged`). Prettier: 2-space, semi, double quotes, printWidth 80.
- Commit the index explicitly (`git add <paths>` then `git commit`). Never `git commit -a` — `AGENTS.md` carries an unrelated local edit that must stay out of the merge commit.

---

### Task 1: Finish the in-flight upstream merge

The repo is mid-merge: `.git/MERGE_HEAD` holds `9bf1242b9`, which is the current `upstream/main` tip (50 commits ahead of `HEAD`). 617 paths are already staged; exactly one path was unmerged — `apps/api/src/lib/extract/usage/llm-cost.ts`, state `UD` (we modified, upstream deleted). Base and our blobs are byte-identical (`git show :1: == :2:`), i.e. there is no local change to preserve; upstream moved the file to `apps/api/src/lib/extract/fire-0/usage/llm-cost-f0.ts` with `_F0`-suffixed symbols. **The resolution `git rm apps/api/src/lib/extract/usage/llm-cost.ts` has already been staged in this session** — Step 1 verifies it rather than repeating it.

**Files:**
- Delete: `apps/api/src/lib/extract/usage/llm-cost.ts` (accept upstream deletion)
- Test: none — the compiler and `knip` are the gate here

**Interfaces:**
- Consumes: nothing
- Produces: a clean, merged working tree at `upstream/main`; every later task assumes it

- [ ] **Step 1: Verify no unmerged paths remain and nothing references the deleted symbols**

```bash
git diff --diff-filter=U --name-only
grep -rn "estimateTotalCost\b\|estimateCost\b\|calculateFinalResultCost\b" --include="*.ts" apps/api/src | grep -v "_F0"
```

Expected: both commands print nothing. A hit from the second command means a caller still needs the old module — stop and report it instead of deleting.

- [ ] **Step 2: Typecheck the merged tree**

```bash
cd apps/api && pnpm exec tsc --noEmit
```

Expected: no errors mentioning `llm-cost`. Pre-existing upstream errors unrelated to this path are not this task's problem — report them, do not fix them here.

- [ ] **Step 3: Run knip before committing, so a failure can be attributed**

```bash
cd apps/api && pnpm knip --cache
```

Expected: clean. If it reports unused exports/files, note whether the path is one of the 617 upstream files or one of ours, then fix it — never `--no-verify`.

- [ ] **Step 4: Commit the merge, index only**

```bash
git commit -m "Merge upstream/main into main"
```

`AGENTS.md` must remain modified-but-unstaged afterwards — verify with `git status --porcelain AGENTS.md` (expect ` M`).

- [ ] **Step 5: Confirm the merge landed**

```bash
git log --oneline -1 && git log --oneline HEAD..upstream/main | wc -l
```

Expected: a merge commit at HEAD and `0` commits behind upstream.

---

### Task 2: Resolve the local model from llama-swap instead of `MODEL_NAME`

**Files:**
- Create: `apps/api/src/lib/local-model.ts`
- Create: `apps/api/src/lib/local-model.test.ts`
- Modify: `apps/api/src/lib/generic-ai.ts:60` (the `const modelName = config.MODEL_NAME || name;` line)

**Interfaces:**
- Consumes: `config.OPENAI_BASE_URL`, `config.MODEL_NAME` from `apps/api/src/config.ts`; `logger` from `apps/api/src/lib/logger.ts`
- Produces:
  - `export function resolveLocalModelName(): string | undefined` — synchronous. Returns the id of the model llama-swap currently reports as loaded; falls back to `config.MODEL_NAME`; returns `config.MODEL_NAME` unchanged when `OPENAI_BASE_URL` is unset.
  - `export function __resetLocalModelCacheForTests(): void` — used only by `local-model.test.ts`. Exported so knip does not flag it; the `__`/`ForTests` naming marks it.

The probe response shape, confirmed live against `http://192.168.1.100:8081/v1/models`:

```json
{"data":[{"id":"muse-glimmer-30b","status":{"value":"unloaded"}},
         {"id":"ornith-35b","status":{"value":"unloaded"}},
         {"id":"qwen38-27b","status":{"value":"loaded"}}],"object":"list"}
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/local-model.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    OPENAI_BASE_URL: "http://llama-swap.test:8081/v1",
    MODEL_NAME: "ornith-35b",
  },
}));

import {
  __resetLocalModelCacheForTests,
  resolveLocalModelName,
} from "./local-model";

function modelsResponse(loaded: string | null) {
  return {
    ok: true,
    json: async () => ({
      data: [
        { id: "ornith-35b", status: { value: "unloaded" } },
        {
          id: "qwen38-27b",
          status: { value: loaded === "qwen38-27b" ? "loaded" : "unloaded" },
        },
      ],
    }),
  };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("resolveLocalModelName", () => {
  beforeEach(() => {
    __resetLocalModelCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns MODEL_NAME before the first probe resolves", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsResponse("qwen38-27b")),
    );
    expect(resolveLocalModelName()).toBe("ornith-35b");
  });

  it("returns the loaded model once the probe has resolved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsResponse("qwen38-27b")),
    );
    resolveLocalModelName();
    await settle();
    expect(resolveLocalModelName()).toBe("qwen38-27b");
  });

  it("falls back to MODEL_NAME when nothing is loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsResponse(null)),
    );
    resolveLocalModelName();
    await settle();
    expect(resolveLocalModelName()).toBe("ornith-35b");
  });

  it("falls back to MODEL_NAME when the probe throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    resolveLocalModelName();
    await settle();
    expect(resolveLocalModelName()).toBe("ornith-35b");
  });

  it("probes once per TTL window, not once per call", async () => {
    const fetchMock = vi.fn(async () => modelsResponse("qwen38-27b"));
    vi.stubGlobal("fetch", fetchMock);
    resolveLocalModelName();
    await settle();
    resolveLocalModelName();
    resolveLocalModelName();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && pnpm exec vitest run src/lib/local-model.test.ts
```

Expected: FAIL — `Failed to resolve import "./local-model"`. No harness; these are unit tests.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/local-model.ts`:

```typescript
import { config } from "../config";
import { logger } from "./logger";

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

let loadedModel: string | undefined;
let lastProbeAt = 0;
let warned = false;

async function probe(): Promise<void> {
  try {
    const res = await fetch(`${config.OPENAI_BASE_URL}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { id?: string; status?: { value?: string } }[];
    };
    loadedModel = body.data?.find(m => m.status?.value === "loaded")?.id;
    warned = false;
  } catch (error) {
    loadedModel = undefined;
    if (!warned) {
      warned = true;
      logger.warn("Could not read loaded model from OPENAI_BASE_URL", {
        error,
      });
    }
  }
}

export function resolveLocalModelName(): string | undefined {
  if (!config.OPENAI_BASE_URL) return config.MODEL_NAME;
  const now = Date.now();
  if (now - lastProbeAt >= PROBE_TTL_MS) {
    lastProbeAt = now;
    void probe();
  }
  return loadedModel ?? config.MODEL_NAME;
}

export function __resetLocalModelCacheForTests(): void {
  loadedModel = undefined;
  lastProbeAt = 0;
  warned = false;
}
```

Why a background refresh and not `await`: `getModel()` cannot become `async` (see Global Constraints). The cost of the resulting cold-start window is one stale answer on the first LLM call after boot; the alternative — blocking every call site on a network round trip — is worse.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && pnpm exec vitest run src/lib/local-model.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Wire it into `getModel`**

In `apps/api/src/lib/generic-ai.ts`, add the import beside the existing `config` import:

```typescript
import { resolveLocalModelName } from "./local-model";
```

and replace line 60:

```typescript
  const modelName = config.MODEL_NAME || name;
```

with:

```typescript
  const modelName = resolveLocalModelName() || name;
```

Nothing else in the file changes. `getEmbeddingModel` keeps using `config.MODEL_EMBEDDING_NAME` — embeddings are not part of the llama-swap roster.

- [ ] **Step 6: Typecheck and re-run the unit tests**

```bash
cd apps/api && pnpm exec tsc --noEmit && pnpm exec vitest run src/lib/local-model.test.ts
```

Expected: no new type errors, 5 passed.

- [ ] **Step 7: Verify against the live server**

With llama-swap up and `qwen38-27b` resident (`curl -s http://192.168.1.100:8081/v1/models`), run a scrape with `formats: ["json"]` through the local stack and confirm in `curl -s http://192.168.1.100:8081/running` that the resident model did **not** change. Then `curl -X POST http://192.168.1.100:8081/api/models/unload`, repeat the scrape, and confirm the model named by `MODEL_NAME` is what gets loaded.

- [ ] **Step 8: Commit**

```bash
cd apps/api && pnpm knip --cache && pnpm lint-staged
git add apps/api/src/lib/local-model.ts apps/api/src/lib/local-model.test.ts apps/api/src/lib/generic-ai.ts
git commit -m "feat(api): use the model llama-swap already has loaded"
```

---

### Task 3: Record the behaviour where the next reader will look

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-local-docker-lmstudio.md` (append a dated note)
- Hand to user (blocked by hook): a comment line above `MODEL_NAME=` in `.env` and `apps/api/.env.example`

**Interfaces:**
- Consumes: the behaviour shipped in Task 2
- Produces: nothing code-level

- [ ] **Step 1: Append the note to the local-stack plan**

Append to `docs/superpowers/plans/2026-07-11-local-docker-lmstudio.md`:

```markdown
## 2026-08-30 — `MODEL_NAME` is now a fallback, not a pin

`getModel()` asks `${OPENAI_BASE_URL}/models` which model llama-swap currently
reports as `loaded` and uses that one, so a scrape never evicts the model
another client is already using. `MODEL_NAME` is consulted only when nothing is
loaded, when the probe fails, or when `OPENAI_BASE_URL` is unset — i.e. it is
the cold-start default. Cached for 30s; the probe never blocks a request.
See `apps/api/src/lib/local-model.ts`.
```

- [ ] **Step 2: Give the user the `.env` line to paste themselves**

Report verbatim (do not edit the files — the hook blocks it, correctly):

```
# Cold-start default only. When llama-swap already has a model resident,
# that one is used instead (apps/api/src/lib/local-model.ts).
MODEL_NAME=ornith-35b
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-11-local-docker-lmstudio.md
git commit -m "docs: note dynamic local model selection"
```
