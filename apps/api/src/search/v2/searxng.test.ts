import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("axios");
vi.mock("../../config", () => ({
  config: {
    SEARXNG_ENDPOINT: "http://sx:3003",
    SEARXNG_ENGINES: "yahoo,mwmbl",
    SEARXNG_CATEGORIES: "general",
    SEARXNG_NEWS_CATEGORIES: undefined as string | undefined,
  },
}));
vi.mock("../../lib/logger", () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn() }),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { searxng_search } from "./searxng";
import { config } from "../../config";

const get = vi.mocked(axios.get);

function respondByCategory() {
  get.mockImplementation(async (_url: string, opts: any) => {
    const c = opts.params.categories;
    if (c === "news") {
      return {
        data: {
          results: [
            {
              url: "https://n/1",
              title: "N1",
              content: "news snippet",
              publishedDate: "2026-10-10T12:00:00",
            },
          ],
        },
      };
    }
    if (c === "images") {
      return {
        data: {
          results: [
            { url: "https://p/1", title: "I1", img_src: "https://i/1.png" },
          ],
        },
      };
    }
    return {
      data: {
        results: [{ url: "https://w/1", title: "W1", content: "web snippet" }],
      },
    };
  });
}

describe("searxng_search source types", () => {
  beforeEach(() => {
    get.mockReset();
    respondByCategory();
  });

  it("without a type searches the web with the configured engines and categories", async () => {
    const r = await searxng_search("q", { num_results: 5 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      engines: "yahoo,mwmbl",
      categories: "general",
    });
    expect(r.results).toEqual({
      web: [{ url: "https://w/1", title: "W1", description: "web snippet" }],
    });
    expect(r.outcome).toBe("results");
  });

  it("news queries the news category, without the web engine pin", async () => {
    const r = await searxng_search("q", { num_results: 5, type: "news" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      engines: "",
      categories: "news",
    });
    expect(r.results).toEqual({
      news: [
        {
          url: "https://n/1",
          title: "N1",
          snippet: "news snippet",
          date: "2026-10-10T12:00:00",
        },
      ],
    });
  });

  it("forwards qdr tbs as SearXNG time_range", async () => {
    await searxng_search("q", { num_results: 5, type: "news", tbs: "qdr:d" });
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      categories: "news",
      time_range: "day",
    });
  });

  it("does not invent a time_range for qdr:h", async () => {
    await searxng_search("q", { num_results: 5, type: "news", tbs: "qdr:h" });
    const params = get.mock.calls[0][1]!.params as Record<string, unknown>;
    expect(params.time_range).toBeUndefined();
  });

  it("SEARXNG_NEWS_CATEGORIES replaces the news category", async () => {
    config.SEARXNG_NEWS_CATEGORIES = "news,science";
    try {
      await searxng_search("q", { num_results: 5, type: "news" });
      expect(get.mock.calls[0][1]!.params).toMatchObject({
        engines: "",
        categories: "news,science",
      });
    } finally {
      config.SEARXNG_NEWS_CATEGORIES = undefined;
    }
  });

  it("images map img_src to imageUrl", async () => {
    const r = await searxng_search("q", { num_results: 5, type: ["images"] });
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      engines: "",
      categories: "images",
    });
    expect(r.results).toEqual({
      images: [
        { url: "https://p/1", title: "I1", imageUrl: "https://i/1.png" },
      ],
    });
  });

  it("several types query each category and fill each array", async () => {
    const r = await searxng_search("q", {
      num_results: 5,
      type: ["web", "news"],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.results.web).toHaveLength(1);
    expect(r.results.news).toHaveLength(1);
    expect(r.results.images).toBeUndefined();
  });
});

describe("searxng_search per-request category", () => {
  beforeEach(() => {
    get.mockReset();
    respondByCategory();
  });

  it("overrides the web category and clears the engine pin", async () => {
    const r = await searxng_search("q", {
      num_results: 5,
      searxngCategory: "finance",
    });
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      engines: "",
      categories: "finance",
    });
    expect(r.categories).toEqual({ web: "finance" });
  });

  it("overrides the news category too", async () => {
    await searxng_search("q", {
      num_results: 5,
      type: "news",
      searxngCategory: "finance-poland",
    });
    expect(get.mock.calls[0][1]!.params).toMatchObject({
      engines: "",
      categories: "finance-poland",
    });
  });

  it("falls back to the configured categories when none is given", async () => {
    const r = await searxng_search("q", { num_results: 5 });
    expect(r.categories).toEqual({ web: "general" });
  });
});

describe("searxng_search provenance", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("distinguishes an empty instance from an error", async () => {
    get.mockResolvedValue({ data: { results: [] } });
    const empty = await searxng_search("q", { num_results: 5 });
    expect(empty.outcome).toBe("empty");
    expect(empty.detail).toBeUndefined();

    get.mockReset();
    get.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const failed = await searxng_search("q", { num_results: 5 });
    expect(failed.outcome).toBe("error");
    expect(failed.detail).toContain("ECONNREFUSED");
    expect(failed.results).toEqual({});
  });

  it("reports a limit of 0 as skipped rather than empty", async () => {
    const r = await searxng_search("q", { num_results: 0 });
    expect(r.outcome).toBe("skipped");
    expect(get).not.toHaveBeenCalled();
  });

  it("passes SearXNG's unresponsive engines through", async () => {
    get.mockResolvedValue({
      data: {
        results: [{ url: "https://w/1", title: "W1", content: "c" }],
        unresponsive_engines: [["google", "timeout"], ["bing"]],
      },
    });
    const r = await searxng_search("q", { num_results: 5 });
    expect(r.outcome).toBe("results");
    expect(r.unresponsiveEngines).toEqual([
      { engine: "google", reason: "timeout" },
      { engine: "bing" },
    ]);
  });

  it("passes the instance's ignored engine pins through", async () => {
    get.mockResolvedValue({
      data: {
        results: [{ url: "https://w/1", title: "W1", content: "c" }],
        unknown_engines: ["no such engine"],
      },
    });
    const r = await searxng_search("q", { num_results: 5 });
    expect(r.unknownEngines).toEqual(["no such engine"]);
  });

  it("reports no unknown engines when the instance omits the field", async () => {
    get.mockResolvedValue({ data: { results: [] } });
    const r = await searxng_search("q", { num_results: 5 });
    expect(r.unknownEngines).toEqual([]);
  });

  it("dedupes an engine that failed on several categories", async () => {
    get.mockResolvedValue({
      data: {
        results: [],
        unresponsive_engines: [["google", "timeout"]],
      },
    });
    const r = await searxng_search("q", {
      num_results: 5,
      type: ["web", "news"],
    });
    expect(r.unresponsiveEngines).toEqual([
      { engine: "google", reason: "timeout" },
    ]);
  });
});
