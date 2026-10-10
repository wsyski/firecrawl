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
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn() }), error: vi.fn(), warn: vi.fn() },
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
            { url: "https://n/1", title: "N1", content: "news snippet", publishedDate: "2026-10-10T12:00:00" },
          ],
        },
      };
    }
    if (c === "images") {
      return {
        data: { results: [{ url: "https://p/1", title: "I1", img_src: "https://i/1.png" }] },
      };
    }
    return { data: { results: [{ url: "https://w/1", title: "W1", content: "web snippet" }] } };
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
    expect(get.mock.calls[0][1]!.params).toMatchObject({ engines: "yahoo,mwmbl", categories: "general" });
    expect(r).toEqual({ web: [{ url: "https://w/1", title: "W1", description: "web snippet" }] });
  });

  it("news queries the news category, without the web engine pin", async () => {
    const r = await searxng_search("q", { num_results: 5, type: "news" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]!.params).toMatchObject({ engines: "", categories: "news" });
    expect(r).toEqual({
      news: [{ url: "https://n/1", title: "N1", snippet: "news snippet", date: "2026-10-10T12:00:00" }],
    });
  });

  it("SEARXNG_NEWS_CATEGORIES replaces the news category", async () => {
    config.SEARXNG_NEWS_CATEGORIES = "news,science";
    try {
      await searxng_search("q", { num_results: 5, type: "news" });
      expect(get.mock.calls[0][1]!.params).toMatchObject({ engines: "", categories: "news,science" });
    } finally {
      config.SEARXNG_NEWS_CATEGORIES = undefined;
    }
  });

  it("images map img_src to imageUrl", async () => {
    const r = await searxng_search("q", { num_results: 5, type: ["images"] });
    expect(get.mock.calls[0][1]!.params).toMatchObject({ engines: "", categories: "images" });
    expect(r).toEqual({ images: [{ url: "https://p/1", title: "I1", imageUrl: "https://i/1.png" }] });
  });

  it("several types query each category and fill each array", async () => {
    const r = await searxng_search("q", { num_results: 5, type: ["web", "news"] });
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.web).toHaveLength(1);
    expect(r.news).toHaveLength(1);
    expect(r.images).toBeUndefined();
  });
});
