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
  return loadedModel ?? config.MODEL_NAME ?? firstConfiguredModel;
}

// Servers that swap models on demand (llama-swap) keep one model resident, and
// naming a different one costs a full reload from disk — so the model is picked
// here, at request time, where the answer can be awaited. A cached answer read
// synchronously at getModel() time is always one request stale, which is
// exactly when the swap happens.
export const localModelFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== "string") return fetch(input, init);
  let body: { model?: unknown };
  try {
    body = JSON.parse(init.body);
  } catch {
    return fetch(input, init);
  }
  if (typeof body.model !== "string") return fetch(input, init);
  const model = (await currentModelId()) ?? body.model;
  if (model === body.model) return fetch(input, init);
  return fetch(input, { ...init, body: JSON.stringify({ ...body, model }) });
};

export function __resetLocalModelCacheForTests(): void {
  loadedModel = undefined;
  firstConfiguredModel = undefined;
  probedAt = 0;
  inFlight = undefined;
  warned = false;
}
