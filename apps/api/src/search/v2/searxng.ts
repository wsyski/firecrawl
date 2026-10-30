import axios from "axios";
import { config } from "../../config";
import { SearchResultType, SearchV2Response } from "../../lib/entities";
import { logger } from "../../lib/logger";
import {
  dedupeUnresponsiveEngines,
  normalizeEngineData,
  normalizeUnknownCategories,
  normalizeUnknownEngines,
  normalizeUnresponsiveEngines,
  SearchProviderOutcome,
  UnresponsiveEngine,
} from "./provenance";

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
  /**
   * A SearXNG category chosen per request (`finance`, `science`, ...). It
   * overrides the category every requested source would otherwise map to, and
   * clears the SEARXNG_ENGINES pin for the same reason categoryOf does.
   */
  searxngCategory?: string;
}

/**
 * What the SearXNG attempt actually did, so the caller can tell an empty
 * instance from an unreachable one. `unresponsiveEngines` is SearXNG's own
 * report of upstream engines that failed this query.
 */
export interface SearxngSearchResult {
  results: SearchV2Response;
  outcome: SearchProviderOutcome;
  detail?: string;
  unresponsiveEngines: UnresponsiveEngine[];
  /** Engine pins the instance did not recognise and ignored. */
  unknownEngines: string[];
  /** Category names the instance did not recognise and ignored. */
  unknownCategories: string[];
  /** Per-engine self-reports from SearXNG's `engine_data`. */
  engineData: Record<string, Record<string, string>>;
  categories: Partial<Record<SearchResultType, string>>;
}

// SEARXNG_ENGINES/SEARXNG_CATEGORIES pin the web search only: an engine pin like
// "yahoo,mwmbl" would leave the news and images categories with no engine to run.
const categoryOf = (
  type: SearchResultType,
  override?: string,
): string | undefined =>
  override ||
  (type === "news"
    ? config.SEARXNG_NEWS_CATEGORIES || "news"
    : type === "images"
      ? "images"
      : undefined);

/**
 * The names from a request's `searxngCategory` that the instance reported as
 * unknown, and only when EVERY pinned name is one of them.
 *
 * SearXNG runs its default search when the category list ends up empty, so
 * `finance,finance-polnd` still runs the `finance` engines and those rows are
 * the caller's own: refusing them would throw away a real answer over a typo
 * in a second name. Only a pin where nothing survived produces rows from
 * engines nobody asked for. A name that came from `SEARXNG_CATEGORIES` or the
 * news default is an operator misconfiguration, reported in provenance but
 * never a reason to fail a search.
 */
export function ignoredPinnedCategories(
  requested: string | undefined,
  unknown: string[],
): string[] {
  if (!requested || unknown.length === 0) return [];
  const reported = new Set(unknown);
  const pinned = [
    ...new Set(
      requested
        .split(",")
        .map(c => c.trim())
        .filter(c => c.length > 0),
    ),
  ];
  if (pinned.length === 0) return [];
  return pinned.every(c => reported.has(c)) ? pinned : [];
}

// SearXNG's time_range has no hour bucket; qdr:h is deliberately dropped rather
// than sent as an unsupported value.
const TIME_RANGES: Record<string, string> = {
  "qdr:d": "day",
  "qdr:w": "week",
  "qdr:m": "month",
  "qdr:y": "year",
};

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
): Promise<SearxngSearchResult> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const unresponsiveEngines: UnresponsiveEngine[] = [];
  const unknownEngines: string[] = [];
  const unknownCategories: string[] = [];
  const engineData: Record<string, Record<string, string>> = {};
  const categories: Partial<Record<SearchResultType, string>> = {};

  const fetchPage = async (
    type: SearchResultType,
    page: number,
  ): Promise<any[]> => {
    const category = categoryOf(type, options.searxngCategory);
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
      ...(TIME_RANGES[options.tbs ?? ""]
        ? { time_range: TIME_RANGES[options.tbs ?? ""] }
        : {}),
      // 2 = strict; omitted otherwise so the instance default applies
      ...(options.safe ? { safesearch: 2 } : {}),
    };
    categories[type] = params.categories;

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;

    // Reported per page: an engine that fails only on page 2 still failed.
    unresponsiveEngines.push(
      ...normalizeUnresponsiveEngines(data?.unresponsive_engines),
    );
    unknownEngines.push(...normalizeUnknownEngines(data?.unknown_engines));
    unknownCategories.push(
      ...normalizeUnknownCategories(data?.unknown_categories),
    );
    // Last page wins per engine: a later page's cursor or count supersedes an
    // earlier one, and the keys are the engine's own.
    Object.assign(engineData, normalizeEngineData(data?.engine_data));

    if (data && Array.isArray(data.results)) {
      return data.results.map(mappers[type]);
    }

    return [];
  };

  const empty = (
    outcome: SearchProviderOutcome,
    detail?: string,
  ): SearxngSearchResult => ({
    results: {},
    outcome,
    ...(detail ? { detail } : {}),
    unresponsiveEngines: dedupeUnresponsiveEngines(unresponsiveEngines),
    unknownEngines: [...new Set(unknownEngines)],
    unknownCategories: [...new Set(unknownCategories)],
    engineData,
    categories,
  });

  try {
    if (requestedResults === 0) {
      return empty("skipped", "limit resolved to 0 results");
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

    // A pin where NO name survived selects no engine, so SearXNG ran its
    // DEFAULT search and these rows belong to engines the caller never asked
    // for. Returning them as the pinned category's results is the same
    // wrong-category answer the DuckDuckGo fallback already refuses to give,
    // so refuse here too rather than pass substituted rows off as the answer.
    const refused = ignoredPinnedCategories(
      options.searxngCategory,
      unknownCategories,
    );
    if (refused.length > 0) {
      return empty(
        "error",
        `SearXNG has no category ${refused.map(c => `"${c}"`).join(", ")}; ` +
          "it ran its default search instead",
      );
    }

    const found = types.some(type => (response[type]?.length ?? 0) > 0);
    return {
      results: response,
      outcome: found ? "results" : "empty",
      unresponsiveEngines: dedupeUnresponsiveEngines(unresponsiveEngines),
      unknownEngines: [...new Set(unknownEngines)],
      unknownCategories: [...new Set(unknownCategories)],
      engineData,
      categories,
    };
  } catch (error) {
    logger.error(`There was an error searching for content`, { error });
    // An error used to be indistinguishable from an empty instance; it is now
    // reported as its own outcome so the caller can tell them apart.
    return empty("error", (error as Error)?.message ?? String(error));
  }
}
