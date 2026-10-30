import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config", () => ({
  config: {
    FIRE_ENGINE_BETA_URL: undefined as string | undefined,
    SEARXNG_ENDPOINT: "http://sx:3003" as string | undefined,
  },
}));
vi.mock("./fireEngine-v2", () => ({ fire_engine_search_v2: vi.fn() }));
vi.mock("./searxng", () => ({ searxng_search: vi.fn() }));
vi.mock("./ddgsearch", () => ({ ddgSearch: vi.fn() }));

import { search } from "./index";
import { config } from "../../config";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { fire_engine_search_v2 } from "./fireEngine-v2";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
} as any;

const searxng = vi.mocked(searxng_search);
const ddg = vi.mocked(ddgSearch);
const fireEngine = vi.mocked(fire_engine_search_v2);

const webRow = { url: "https://w/1", title: "W1", description: "d" };

const searxngResult = (over: Partial<any> = {}) => ({
  results: {},
  outcome: "empty" as const,
  unresponsiveEngines: [],
  unknownEngines: [],
  unknownCategories: [],
  engineData: {},
  categories: { web: "general" },
  ...over,
});

describe("search provider chain provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.FIRE_ENGINE_BETA_URL = undefined;
    config.SEARXNG_ENDPOINT = "http://sx:3003";
    ddg.mockResolvedValue({});
  });

  it("names the provider that answered and records the skipped ones", async () => {
    searxng.mockResolvedValue(
      searxngResult({ results: { web: [webRow] }, outcome: "results" }),
    );
    const r = await search({ query: "q", logger });
    expect(r.web).toEqual([webRow]);
    expect(r.provenance!.provider).toBe("searxng");
    expect(r.provenance!.attempts).toEqual([
      {
        provider: "fire-engine",
        outcome: "skipped",
        detail: "FIRE_ENGINE_BETA_URL is not set",
      },
      { provider: "searxng", outcome: "results" },
    ]);
    expect(r.provenance!.searxngCategories).toEqual({ web: "general" });
  });

  it("makes the fallthrough to DuckDuckGo visible", async () => {
    searxng.mockResolvedValue(searxngResult());
    ddg.mockResolvedValue({ web: [webRow] });
    const r = await search({ query: "q", logger });
    expect(r.provenance!.provider).toBe("duckduckgo");
    expect(r.provenance!.attempts.map(a => [a.provider, a.outcome])).toEqual([
      ["fire-engine", "skipped"],
      ["searxng", "empty"],
      ["duckduckgo", "results"],
    ]);
  });

  it("distinguishes a failed SearXNG from an empty one", async () => {
    searxng.mockResolvedValue(
      searxngResult({ outcome: "error", detail: "connect ECONNREFUSED" }),
    );
    const r = await search({ query: "q", logger });
    const attempt = r.provenance!.attempts.find(a => a.provider === "searxng")!;
    expect(attempt.outcome).toBe("error");
    expect(attempt.detail).toBe("connect ECONNREFUSED");
  });

  it("carries the unresponsive engines of an empty result", async () => {
    searxng.mockResolvedValue(
      searxngResult({
        unresponsiveEngines: [{ engine: "google", reason: "timeout" }],
      }),
    );
    const r = await search({ query: "q", logger });
    const attempt = r.provenance!.attempts.find(a => a.provider === "searxng")!;
    expect(attempt.unresponsiveEngines).toEqual([
      { engine: "google", reason: "timeout" },
    ]);
    // No results anywhere, but the reason is now in the response.
    expect(r.web).toBeUndefined();
    expect(r.provenance!.provider).toBeUndefined();
  });

  it("reports engine pins the instance ignored", async () => {
    searxng.mockResolvedValue(
      searxngResult({
        results: { web: [webRow] },
        outcome: "results",
        unknownEngines: ["no such engine"],
      }),
    );
    const r = await search({ query: "q", logger });
    expect(
      r.provenance!.attempts.find(a => a.provider === "searxng")!
        .unknownEngines,
    ).toEqual(["no such engine"]);
  });

  it("passes a per-request SearXNG category through", async () => {
    searxng.mockResolvedValue(
      searxngResult({ results: { web: [webRow] }, outcome: "results" }),
    );
    await search({ query: "q", logger, searxngCategory: "finance" });
    expect(searxng.mock.calls[0][1]).toMatchObject({
      searxngCategory: "finance",
    });
  });

  it("does not substitute DuckDuckGo web rows for a pinned category", async () => {
    searxng.mockResolvedValue(searxngResult());
    const r = await search({ query: "q", logger, searxngCategory: "finance" });
    expect(ddg).not.toHaveBeenCalled();
    const attempt = r.provenance!.attempts.find(
      a => a.provider === "duckduckgo",
    )!;
    expect(attempt.outcome).toBe("skipped");
    expect(attempt.detail).toContain("finance");
  });

  it("still skips DuckDuckGo for a news-only request", async () => {
    searxng.mockResolvedValue(searxngResult());
    const r = await search({ query: "q", logger, type: "news" });
    expect(ddg).not.toHaveBeenCalled();
    expect(
      r.provenance!.attempts.find(a => a.provider === "duckduckgo")!.detail,
    ).toBe("request has no web source");
  });

  it("records SearXNG as skipped when no endpoint is configured", async () => {
    config.SEARXNG_ENDPOINT = undefined;
    ddg.mockResolvedValue({ web: [webRow] });
    const r = await search({ query: "q", logger });
    expect(searxng).not.toHaveBeenCalled();
    expect(
      r.provenance!.attempts.find(a => a.provider === "searxng")!.detail,
    ).toBe("SEARXNG_ENDPOINT is not set");
  });

  it("uses fire engine alone when it is configured", async () => {
    config.FIRE_ENGINE_BETA_URL = "http://fe:3002";
    fireEngine.mockResolvedValue({ web: [webRow] });
    const r = await search({ query: "q", logger });
    expect(searxng).not.toHaveBeenCalled();
    expect(r.provenance!.provider).toBe("fire-engine");
    expect(r.provenance!.attempts).toHaveLength(1);
  });

  it("attributes a throw to the provider that was in flight", async () => {
    searxng.mockRejectedValue(new Error("boom"));
    const r = await search({ query: "q", logger });
    expect(r.provenance!.attempts.at(-1)).toEqual({
      provider: "searxng",
      outcome: "error",
      detail: "boom",
    });
    expect(r.web).toBeUndefined();
  });

  it("carries unknownCategories and engineData onto the searxng attempt", async () => {
    searxng.mockResolvedValue(
      searxngResult({
        results: { web: [webRow] },
        outcome: "results",
        unknownCategories: ["finance-polnd"],
        engineData: { sii: { dropped_rows: "7", site_rows: "10" } },
      }),
    );
    const r = await search({ query: "q", logger });
    const attempt = r.provenance!.attempts.find(a => a.provider === "searxng")!;
    expect(attempt.unknownCategories).toEqual(["finance-polnd"]);
    expect(attempt.engineData).toEqual({
      sii: { dropped_rows: "7", site_rows: "10" },
    });
  });

  it("leaves both fields off when the instance reports neither", async () => {
    searxng.mockResolvedValue(
      searxngResult({ results: { web: [webRow] }, outcome: "results" }),
    );
    const r = await search({ query: "q", logger });
    const attempt = r.provenance!.attempts.find(a => a.provider === "searxng")!;
    expect(attempt).not.toHaveProperty("unknownCategories");
    expect(attempt).not.toHaveProperty("engineData");
  });
});
