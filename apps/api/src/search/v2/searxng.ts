import axios from "axios";
import { config } from "../../config";
import { SearchResultType, SearchV2Response } from "../../lib/entities";
import { logger } from "../../lib/logger";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  num_results: number;
  page?: number;
  type?: SearchResultType | SearchResultType[];
}

// SEARXNG_ENGINES/SEARXNG_CATEGORIES pin the web search only: an engine pin like
// "yahoo,mwmbl" would leave the news and images categories with no engine to run.
const categoryOf = (type: SearchResultType): string | undefined =>
  type === "news"
    ? config.SEARXNG_NEWS_CATEGORIES || "news"
    : type === "images"
      ? "images"
      : undefined;

const mappers: Record<SearchResultType, (a: any) => any> = {
  web: a => ({ url: a.url, title: a.title, description: a.content }),
  news: a => ({
    url: a.url,
    title: a.title,
    snippet: a.content,
    ...(a.publishedDate ? { date: a.publishedDate } : {}),
  }),
  images: a => ({ url: a.url, title: a.title, imageUrl: a.img_src }),
};

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const fetchPage = async (
    type: SearchResultType,
    page: number,
  ): Promise<any[]> => {
    const category = categoryOf(type);
    const params = {
      q: q,
      language: options.lang,
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      engines: category ? "" : (config.SEARXNG_ENGINES ?? ""),
      categories: category ?? config.SEARXNG_CATEGORIES ?? "",
      pageno: page,
      format: "json",
      // 2 = strict; omitted otherwise so the instance default applies
      ...(options.safe ? { safesearch: 2 } : {}),
    };

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;

    if (data && Array.isArray(data.results)) {
      return data.results.map(mappers[type]);
    }

    return [];
  };

  try {
    if (requestedResults === 0) {
      return {};
    }

    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / resultsPerPage),
    );
    const types = options.type
      ? Array.isArray(options.type)
        ? options.type
        : [options.type]
      : (["web"] as SearchResultType[]);
    const response: SearchV2Response = {};

    for (const type of types) {
      let results: any[] = [];
      for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
        const pageResults = await fetchPage(type, startPage + pageOffset);
        if (pageResults.length === 0) {
          break;
        }
        results = results.concat(pageResults);
        if (results.length >= requestedResults) {
          break;
        }
      }
      if (results.length > 0) {
        response[type] = results.slice(0, requestedResults);
      }
    }

    return response;
  } catch (error) {
    logger.error(`There was an error searching for content`, { error });
    return {};
  }
}
