import { config } from "../../../config";
import { describeIf, HAS_MODEL_SWAP, itIf } from "../lib";
import { idmux, Identity, scrape } from "./lib";

// llama-swap keeps one model resident and reloads from disk on a swap, so
// Firecrawl must use whatever is already loaded instead of pinning MODEL_NAME.
// See docs/superpowers/plans/2026-08-30-dynamic-local-model.md.

const swapBase = (config.OPENAI_BASE_URL ?? "").replace(/\/v1\/?$/, "");
const timeout = 300000;

let identity: Identity;

async function listModels(): Promise<{ id: string; loaded: boolean }[]> {
  const res = await fetch(`${swapBase}/v1/models`);
  const body = (await res.json()) as {
    data?: { id?: string; status?: { value?: string } }[];
  };
  return (body.data ?? []).map(m => ({
    id: m.id!,
    loaded: m.status?.value === "loaded",
  }));
}

async function residentModel(): Promise<string | undefined> {
  return (await listModels()).find(m => m.loaded)?.id;
}

async function unloadAll() {
  await fetch(`${swapBase}/api/models/unload`, { method: "POST" });
}

async function load(model: string) {
  await fetch(`${swapBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    }),
  });
}

async function scrapeJson() {
  return await scrape(
    {
      url: "https://example.com",
      formats: [{ type: "json", schema: { type: "object" } }],
    },
    identity,
  );
}

describeIf(HAS_MODEL_SWAP)("local model selection", () => {
  beforeAll(async () => {
    identity = await idmux({ name: "local-model", concurrency: 1, credits: 100 });
  });

  itIf(!!config.MODEL_NAME)(
    "loads MODEL_NAME when the server has nothing resident",
    async () => {
      await unloadAll();
      expect(await residentModel()).toBeUndefined();

      const doc = await scrapeJson();
      expect(doc.json).toBeDefined();
      expect(await residentModel()).toBe(config.MODEL_NAME);
    },
    timeout,
  );

  it(
    "uses the resident model instead of evicting it",
    async () => {
      const other = (await listModels()).find(m => m.id !== config.MODEL_NAME);
      expect(other, "swapper must serve a second model").toBeDefined();

      await load(other!.id);
      expect(await residentModel()).toBe(other!.id);

      const doc = await scrapeJson();
      expect(doc.json).toBeDefined();
      expect(await residentModel()).toBe(other!.id);
    },
    timeout,
  );
});
