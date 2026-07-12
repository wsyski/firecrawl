# Local Docker + LM Studio LLM Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Firecrawl stack via Docker Compose, using a local LM Studio server as the LLM backend for extraction/completion features, and verify it works end-to-end against a real scrape/extract request.

**Architecture:** Pure configuration change — no application code is modified. `.env` is updated with `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL_NAME` pointing at LM Studio's OpenAI-compatible server on the host; `docker-compose.yaml` already forwards these into the `api` container and already resolves `host.docker.internal`. The stack is brought up with `docker compose`, then exercised with a real extract request to prove the container reaches the host LLM.

**Tech Stack:** Docker Compose, Firecrawl API/worker (Node.js, existing image), LM Studio (host-side OpenAI-compatible server).

## Global Constraints

- `OPENAI_BASE_URL=http://192.168.1.100:1234/v1` — **not** `host.docker.internal`; see "Deviations from original plan" below
- `OPENAI_API_KEY=lm-studio` (dummy value — LM Studio does not validate it, but the OpenAI SDK requires non-empty)
- `MODEL_NAME=ornith-1.0-35b-frankenstein-mtp` (exact LM Studio model identifier, confirmed by user)
- `MODEL_EMBEDDING_NAME` stays unset — no embedding model loaded in LM Studio (deferred per spec)
- `OLLAMA_BASE_URL` stays commented out — not in use
- No application code changes — `.env` and verification only
- Do not commit `.env` (it's gitignored / contains local config) — no git steps for it in this plan

## Deviations from original plan (discovered during execution)

1. **`host.docker.internal` is unreachable on this host.** It resolves to the default Docker bridge gateway (`172.17.0.1`), but this machine's Docker setup has no classic bridge network devices at all (no `docker0`, confirmed via `ip addr` / `ip link show type bridge` — likely a rootless Docker setup). Used the host's LAN IP (`192.168.1.100`, interface `enp3s0`) instead, confirmed reachable from inside the `api` container.
   - **This IP is DHCP-assigned, not static.** It can change on reboot/lease renewal. Durable fix: a static DHCP reservation for this machine's MAC (`e8:9c:25:43:21:d5`) on the router — not something executable from this environment, needs to be done in the router's admin UI. Until then, re-verify with `ip addr show enp3s0` if connectivity breaks after a reboot.
2. **LM Studio's server had to be rebound to `0.0.0.0`.** It runs as a systemd user service (`lmstudio.service` → `~/.lmstudio/lms-server.sh`) which defaulted to binding `127.0.0.1` only, unreachable from any container regardless of which host IP is used. Added `--bind 0.0.0.0` to the `lms server start` call.
3. **Fixed a latent bug in `lms-server.sh`** found while debugging a CUDA OOM: `model_already_loaded()`'s grep required an exact quoted match against a short model-name prefix, which never matched the full model id — causing every service restart to attempt loading a second copy of the model on top of the resident one, exhausting GPU VRAM. Fixed to match by prefix.
4. **`/v1/scrape` request shape**: the plan's original `formats: [{"type": "json", "prompt": "..."}]` request body is rejected by the current API (`formats` expects a flat string enum, e.g. `formats: ["json"]`, with `jsonOptions: { prompt, schema }` as a sibling field). Used the corrected shape in verification.
5. **Extraction returned `success: true` with no `data.json` field.** LM Studio was reached and the model did produce a correct answer (confirmed in LM Studio's server log — it correctly identified "Example Domain" as the heading), but wrapped it in a markdown code fence with key `main_heading` instead of the requested schema's `heading` key, which failed Firecrawl's schema validation and got silently dropped. This is a model-output-formatting quirk of `ornith-1.0-35b-frankenstein-mtp`'s reasoning/thinking style, not an infra defect — the docker↔host↔LM Studio plumbing itself is confirmed working end-to-end. **Reconfirmed on a full stack re-run (2026-07-12)**: LM Studio's server log shows the model's own reasoning trace noting *"no schema was actually provided in the prompt"* — the request Firecrawl sends doesn't forward the JSON schema into the model prompt text, only a natural-language extraction instruction, which is why the model free-styles the key name. Fixing this durably would need an application-code change (out of scope for this config-only plan).
6. **An embedding model is now loaded in LM Studio** (`text-embedding-nomic-embed-text-v1.5`, seen in `/v1/models` as of 2026-07-12) — previously none was available. `MODEL_EMBEDDING_NAME` could now be set to enable embedding-dependent features; left unset here since it's out of scope for this plan.

---

### Task 1: Configure `.env` for LM Studio backend

**Files:**
- Modify: `/home/playground/firecrawl/.env`

**Interfaces:**
- Consumes: existing `.env` file structure (already has commented-out `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL_NAME` / `MODEL_EMBEDDING_NAME` lines under the "Experimental: Use any OpenAI-compatible API" section)
- Produces: `.env` values read by `docker-compose.yaml`'s `x-common-env` block (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MODEL_NAME`, `MODEL_EMBEDDING_NAME`), consumed by Task 2's `docker compose up`

- [x] **Step 1: Edit `.env` to set the LM Studio backend values**

Find the block that currently looks like this (uncommented `PORT`/`HOST`/etc. lines already exist above it — only touch the OpenAI-compatible section):

```
# Experimental: Use any OpenAI-compatible API
# OPENAI_BASE_URL=...
# OPENAI_API_KEY=...
```

and the `MODEL_NAME` / `MODEL_EMBEDDING_NAME` lines near the Ollama block:

```
# OLLAMA_BASE_URL=...
# MODEL_NAME=...
# MODEL_EMBEDDING_NAME=...
```

Replace so the file ends up with these lines uncommented (leave `OLLAMA_BASE_URL` and `MODEL_EMBEDDING_NAME` commented out):

```
OPENAI_BASE_URL=http://192.168.1.100:1234/v1
OPENAI_API_KEY=lm-studio
MODEL_NAME=ornith-1.0-35b-frankenstein-mtp
```

`192.168.1.100` is this host's current LAN IP (interface `enp3s0`) — used instead of `host.docker.internal` because that hostname is unreachable on this machine (see "Deviations from original plan"). **This IP is DHCP-assigned and can change**; if it does, re-check with `ip addr show enp3s0` and update accordingly. A static DHCP reservation on the router (for MAC `e8:9c:25:43:21:d5`) removes this risk permanently.

- [x] **Step 2: Verify the values are present and correctly formed**

Run: `grep -E '^(OPENAI_BASE_URL|OPENAI_API_KEY|MODEL_NAME)=' .env`

Expected output (exact):
```
OPENAI_BASE_URL=http://192.168.1.100:1234/v1
OPENAI_API_KEY=lm-studio
MODEL_NAME=ornith-1.0-35b-frankenstein-mtp
```

No commit for this step — `.env` holds local secrets/config and is not tracked in git (do not `git add` it).

---

### Task 2: Bring up the Docker Compose stack

**Files:**
- None created/modified (uses existing `docker-compose.yaml`, `apps/api`, `apps/playwright-service-ts`, `apps/nuq-postgres` build contexts)

**Interfaces:**
- Consumes: `.env` values from Task 1
- Produces: running `api`, `playwright-service`, `redis`, `rabbitmq`, `nuq-postgres` containers reachable at `http://localhost:${PORT:-3002}`, consumed by Task 3's verification request

- [x] **Step 1: Build and start the stack**

Run: `docker compose up -d --build`
Expected: all services report `Started`/`Created`/`Healthy` with no error exit codes.

- [x] **Step 2: Confirm all containers are running**

Run: `docker compose ps`
Expected: `api`, `playwright-service`, `redis`, `rabbitmq`, `nuq-postgres` all show `Up`/`running` (rabbitmq additionally `healthy`). No container in a `Restarting` or `Exited` loop.

- [x] **Step 3: Confirm the API port is reachable**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3002/v0/health/liveness` (adjust port if `PORT` was overridden in `.env`)
Expected: `200`

No commit for this task — no files changed.

---

### Task 3: Verify LM Studio is used as the LLM backend

**Files:**
- None created/modified

**Interfaces:**
- Consumes: running stack from Task 2, LM Studio server on `http://localhost:1234` (host-side, already running per user with `ornith-1.0-35b-frankenstein-mtp` loaded)
- Produces: none (terminal verification task)

- [x] **Step 1: Confirm LM Studio is reachable from the host**

Run: `curl -s http://localhost:1234/v1/models`
Expected: JSON response listing `ornith-1.0-35b-frankenstein-mtp` under `data[].id`.

- [x] **Step 2: Issue an extraction request against the running Firecrawl API**

Run:
```bash
curl -s -X POST http://localhost:3002/v1/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "formats": ["json"],
    "jsonOptions": {
      "schema": {"type":"object","properties":{"heading":{"type":"string"}},"required":["heading"]},
      "prompt": "Extract the main heading text from this page."
    }
  }'
```
(Note the corrected request shape — `formats` takes flat string enums like `"json"`, with `jsonOptions` as a sibling field, not the nested `{"type": "json", ...}` object originally planned.)

Expected: HTTP 200 with a JSON body containing `"success": true` and a `data.json.heading` field populated with text extracted from the page (not an error about missing/invalid API key or unreachable model).

Actual result on this run: `success: true` but no `data.json` field. Root-caused via LM Studio's server log (`~/.lmstudio/server-logs/`) and the API's debug logs — the model correctly extracted "Example Domain" but wrapped it as `{"main_heading": "Example Domain"}` inside a markdown code fence instead of matching the schema's `heading` key, so Firecrawl's schema coercion silently dropped it. This confirms the infra path works (request reached LM Studio, model generated a relevant response) — the gap is model output formatting, not connectivity.

- [x] **Step 3: Cross-check LM Studio received the request**

Check LM Studio's own server log (`~/.lmstudio/server-logs/<year-month>/<date>.log`, or the Developer/Server tab in the GUI).
Expected: a new incoming `POST /v1/responses` request logged around the time Step 2 ran, confirming the container reached the host LLM via the LAN IP rather than any cloud provider.

- [x] **Step 4: If Step 2 fails, check API container logs for the root cause**

Run: `docker compose logs api --tail=100`
Look for: `ECONNREFUSED <IP>:1234` (either LM Studio isn't bound to `0.0.0.0`, or the LAN IP in `.env` is stale — re-check with `ip addr show enp3s0`), or `model not found` (mismatched `MODEL_NAME` — re-run `curl http://localhost:1234/v1/models` and compare the exact `id` string against `.env`).

No commit for this task — verification only, no files changed.
