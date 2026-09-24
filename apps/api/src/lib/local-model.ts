import { existsSync } from "node:fs";
import { config } from "../config";
import { logger } from "./logger";

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

let loadedModel: string | undefined;
let firstConfiguredModel: string | undefined;
let probedAt = 0;
let inFlight: Promise<void> | undefined;
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
    const models = body.data ?? [];
    loadedModel = models.find(m => m.status?.value === "loaded")?.id;
    firstConfiguredModel = models[0]?.id;
    warned = false;
  } catch (error) {
    loadedModel = undefined;
    firstConfiguredModel = undefined;
    if (!warned) {
      warned = true;
      logger.warn("Could not read loaded model from OPENAI_BASE_URL", {
        error,
      });
    }
  } finally {
    probedAt = Date.now();
  }
}

async function currentModelId(): Promise<string | undefined> {
  if (Date.now() - probedAt >= PROBE_TTL_MS) {
    inFlight ??= probe().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  }
  return loadedModel ?? firstConfiguredModel ?? config.MODEL_NAME;
}

// Servers that swap models on demand (llama-swap) keep one model resident, and
// naming a different one costs a full reload from disk — so the model is picked
// here, at request time, where the answer can be awaited. A cached answer read
// synchronously at getModel() time is always one request stale, which is
// exactly when the swap happens.
export const localModelFetch: typeof fetch = async (input, init) => {
  // Manual kill switch: while the lock file exists (bind-mounted from the
  // host), fail exactly like an unreachable server so the existing outage
  // handling applies unchanged.
  if (config.LLM_LOCK_FILE && existsSync(config.LLM_LOCK_FILE)) {
    throw new TypeError("fetch failed", {
      cause: Object.assign(
        new Error(`connect ECONNREFUSED (local LLM locked: ${config.LLM_LOCK_FILE})`),
        { code: "ECONNREFUSED" },
      ),
    });
  }
  if (typeof init?.body !== "string") return fetch(input, init);
  let body: {
    model?: unknown;
    messages?: unknown;
    chat_template_kwargs?: Record<string, unknown>;
    id_slot?: unknown;
  };
  try {
    body = JSON.parse(init.body);
  } catch {
    return fetch(input, init);
  }
  const isChat = Array.isArray(body.messages);
  const disableThinking = isChat && config.LLM_DISABLE_THINKING === true;
  // llama-server: keep every Firecrawl call on its own slot, so a run of
  // different pages never evicts another client's cached conversation. A busy
  // slot queues the request instead of taking another one.
  const pinSlot =
    isChat && config.LLM_SLOT_ID !== undefined && body.id_slot === undefined;
  if (typeof body.model !== "string" && !disableThinking && !pinSlot)
    return fetch(input, init);
  const model = (await currentModelId()) ?? body.model;
  const next: Record<string, unknown> = { ...body };
  if (typeof model === "string" && model !== body.model) next.model = model;
  // Thinking models (e.g. Nex-N2.5 templates) can spend the whole
  // budget on reasoning_content, leaving `content` empty. Only chat bodies;
  // a caller-provided value wins.
  if (disableThinking) {
    next.chat_template_kwargs = {
      ...body.chat_template_kwargs,
      enable_thinking: body.chat_template_kwargs?.enable_thinking ?? false,
    };
  }
  if (pinSlot) next.id_slot = config.LLM_SLOT_ID;
  if (
    next.model === body.model &&
    next.chat_template_kwargs === body.chat_template_kwargs &&
    next.id_slot === body.id_slot
  )
    return fetch(input, init);
  return fetch(input, { ...init, body: JSON.stringify(next) });
};

export function __resetLocalModelCacheForTests(): void {
  loadedModel = undefined;
  firstConfiguredModel = undefined;
  probedAt = 0;
  inFlight = undefined;
  warned = false;
}
