import { describeIf, HAS_SEARCH, TEST_SELF_HOST } from "../lib";
import { searchRaw, searchWithFailure, Identity, idmux } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search-provenance",
    concurrency: 10,
    credits: 1000000,
  });
}, 10000);

describeIf(HAS_SEARCH)("search provenance", () => {
  it("reports which provider answered and which were skipped", async () => {
    const raw = await searchRaw({ query: "firecrawl", limit: 3 }, identity);
    expect(raw.statusCode).toBe(200);
    const provenance = raw.body.provenance;
    expect(provenance).toBeDefined();
    expect(Array.isArray(provenance.attempts)).toBe(true);
    expect(provenance.attempts.length).toBeGreaterThan(0);
    for (const attempt of provenance.attempts) {
      expect(["fire-engine", "searxng", "duckduckgo"]).toContain(
        attempt.provider,
      );
      expect(["results", "empty", "error", "skipped"]).toContain(
        attempt.outcome,
      );
    }
    // Whatever answered must be one of the attempts that reported results.
    if (provenance.provider) {
      expect(
        provenance.attempts.find((a: any) => a.provider === provenance.provider)
          .outcome,
      ).toBe("results");
    }
  }, 60000);

  it("reports a provenance even when a query returns nothing", async () => {
    const raw = await searchRaw(
      {
        query: `zzq${Date.now()}xnotathing nonexistentterm${Date.now()}`,
        limit: 3,
      },
      identity,
    );
    expect(raw.statusCode).toBe(200);
    expect(raw.body.success).toBe(true);
    // An empty data is no longer indistinguishable from a failed chain.
    expect(raw.body.provenance.attempts.length).toBeGreaterThan(0);
  }, 60000);
});

describeIf(TEST_SELF_HOST && HAS_SEARCH)("per-request SearXNG category", () => {
  it("reports the category each source was searched under", async () => {
    const raw = await searchRaw({ query: "firecrawl", limit: 3 }, identity);
    expect(raw.statusCode).toBe(200);
    expect(raw.body.provenance.searxngCategories).toMatchObject({
      web: expect.any(String),
    });
  }, 60000);

  it("searches the category the request asked for", async () => {
    const raw = await searchRaw(
      { query: "nasdaq", limit: 3, searxngCategory: "finance" },
      identity,
    );
    expect(raw.statusCode).toBe(200);
    expect(raw.body.provenance.searxngCategories.web).toBe("finance");
    // DuckDuckGo cannot serve a category, so it must never be the provider
    // that answered. When SearXNG has results the chain returns before
    // DuckDuckGo is reached at all, so the attempt may be absent; when it is
    // present it has to be the skip (index.test.ts pins that branch exactly).
    expect(raw.body.provenance.provider).not.toBe("duckduckgo");
    const ddg = raw.body.provenance.attempts.find(
      (a: any) => a.provider === "duckduckgo",
    );
    if (ddg) {
      expect(ddg.outcome).toBe("skipped");
      expect(ddg.detail).toContain("finance");
    }
  }, 60000);

  it("rejects a category name that cannot be a SearXNG category", async () => {
    const body = await searchWithFailure(
      { query: "firecrawl", searxngCategory: "Finance; DROP" } as any,
      identity,
    );
    expect(body.success).toBe(false);
  }, 60000);
});
