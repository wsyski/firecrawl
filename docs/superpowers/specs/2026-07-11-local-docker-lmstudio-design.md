# Run Firecrawl locally via Docker with LM Studio as LLM backend

## Goal

Run the full Firecrawl stack via `docker compose`, using a local LM Studio server (on the host machine) as the LLM backend for extraction/completion features, instead of a cloud provider (OpenAI, etc).

## Context

Firecrawl already supports pointing at any OpenAI-compatible API via three env vars — `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `MODEL_NAME` — which are read directly by the scraper/extraction code (`apps/api/src/scraper/scrapeURL/transformers/llmExtract.ts` and friends) through the OpenAI SDK. `docker-compose.yaml`'s `x-common-env` block passes these straight into the `api` container, and every service already gets `host.docker.internal:host-gateway` via `extra_hosts`, so the containerized API can reach a server running on the host. No application code changes are required — this is purely `.env` configuration plus the standard compose lifecycle.

LM Studio exposes an OpenAI-compatible server (default port 1234) once its local server is started, with `/v1/chat/completions`, `/v1/models`, etc.

## Configuration

Set in `.env` (repo root):

```
OPENAI_BASE_URL=http://192.168.1.100:1234/v1
OPENAI_API_KEY=lm-studio
MODEL_NAME=ornith-1.0-35b-frankenstein-mtp
```

Notes:
- `OPENAI_API_KEY` is a dummy value — LM Studio does not validate it, but the OpenAI SDK requires a non-empty string.
- `MODEL_NAME` must exactly match the identifier LM Studio reports for the loaded model (confirmed: `ornith-1.0-35b-frankenstein-mtp`).
- `MODEL_EMBEDDING_NAME` is left unset. No dedicated embedding model is loaded in LM Studio; embedding-dependent features (e.g. semantic link ranking) will be unavailable or fall back to non-embedding behavior. This can be revisited later by loading an embedding-capable model (e.g. `nomic-embed-text-v1.5`) in LM Studio and setting `MODEL_EMBEDDING_NAME`.
- `OLLAMA_BASE_URL` stays commented out — not used.
- All other settings (Supabase auth, proxies, SearXNG, FoundationDB queue backend) stay at their defaults (disabled/commented out).

### `OPENAI_BASE_URL` uses the host's LAN IP, not `host.docker.internal`

`host.docker.internal` (backed by compose's `extra_hosts: host-gateway`) turned out to be unreachable on this machine: it resolves to the default bridge network's gateway address (`172.17.0.1`), but that bridge (`docker0`) has never been created here — this host's Docker networking has no classic bridge devices at all (checked via `ip addr`/`ip link show type bridge`, both empty), which points to a non-standard Docker setup (e.g. rootless Docker). The container's own network gateway (`172.23.0.1` for the `firecrawl_backend` network) was also tried and found unreachable for the same reason.

The working fallback is the host's real LAN IP (`192.168.1.100`, interface `enp3s0`, MAC `e8:9c:25:43:21:d5`), which LM Studio is reachable on once its server binds to `0.0.0.0` (see below) instead of `127.0.0.1`.

**This IP is DHCP-assigned and not guaranteed stable across reboots or lease renewals.** Durable fix: add a static DHCP reservation for this MAC address on the router, so this IP never changes. Until that's done, if `docker compose exec api curl http://<IP>:1234/v1/models` stops working after a reboot, re-check the current IP with `ip addr show enp3s0` and update `OPENAI_BASE_URL` accordingly.

### LM Studio must bind to `0.0.0.0`, not just `127.0.0.1`

LM Studio runs as a systemd user service (`~/.config/systemd/user/lmstudio.service`, launching `~/.lmstudio/lms-server.sh`). By default its server binds to loopback only, which containers can't reach regardless of the gateway/IP used above. Fixed by adding `--bind 0.0.0.0` to the `lms server start` invocation in `lms-server.sh`. This exposes the server to the whole LAN, not just Docker — accepted deliberately since this is a local dev machine.

### Pre-existing script bug fixed: `model_already_loaded()` false negative

`lms-server.sh`'s `model_already_loaded()` grepped for `"${MODEL}"` (an exact quoted match), but `MODEL` was set to `ornith-1.0-35b` while the actual model id is `ornith-1.0-35b-frankenstein-mtp` — so the check never matched, and every service restart tried to load a second copy of the model on top of the already-resident one, exhausting the 12GB GPU (`cudaMalloc failed: out of memory`). Fixed by matching on the id prefix instead of requiring an exact trailing quote (and `MODEL` was separately updated to the full id). Symptom if this regresses: `journalctl --user -u lmstudio.service` shows repeated `Model load attempt N/3 failed` before the unit hits systemd's start-rate-limit.

## Verification

1. Start LM Studio's local server (already running per user, port 1234) with `ornith-1.0-35b-frankenstein-mtp` loaded.
2. `docker compose up -d --build` from the repo root.
3. Confirm the `api` container reaches a healthy/running state (`docker compose ps`).
4. Issue a scrape/extract request that exercises the LLM path (e.g. `POST /v1/scrape` with `formats: ["extract"]` and an extraction prompt, or `POST /v1/extract`) against a test URL.
5. Confirm the request succeeds and returns extracted data, and cross-check LM Studio's own console/request log shows an incoming request — proving the container reached the host LLM.

## Out of scope

- Embeddings wiring (see note above — deferred).
- DB authentication / Supabase.
- Proxy configuration.
- SearXNG search backend.
- FoundationDB queue backend (stays on default nuq-postgres).
