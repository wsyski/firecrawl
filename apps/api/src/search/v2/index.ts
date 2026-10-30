import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import {
  SearchProvenance,
  SearchProviderAttempt,
  SearchProviderName,
} from "./provenance";

const hasAnyResult = (r: SearchV2Response): boolean =>
  Boolean(r.web?.length || r.news?.length || r.images?.length);

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  searxngCategory = undefined,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  searxngCategory?: string;
}): Promise<SearchV2Response> {
  // Every provider below used to return early or fall through silently, so an
  // empty response could mean "nothing matched", "the provider errored" or
  // "a different provider answered". Each attempt is recorded instead.
  const attempts: SearchProviderAttempt[] = [];
  let searxngCategories: SearchProvenance["searxngCategories"];
  // The provider whose call is in flight, so a throw is attributed to it
  // rather than to the chain as a whole.
  let inFlight: SearchProviderName | undefined;
  const provenance = (): SearchProvenance => ({
    ...(() => {
      const answered = attempts.find(a => a.outcome === "results");
      return answered ? { provider: answered.provider } : {};
    })(),
    attempts,
    ...(searxngCategories ? { searxngCategories } : {}),
  });

  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      inFlight = "fire-engine";
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
      });

      attempts.push({
        provider: "fire-engine",
        outcome: hasAnyResult(results) ? "results" : "empty",
        // searxngCategory reaches SearXNG only; fire engine has no equivalent.
        ...(searxngCategory
          ? { detail: "searxngCategory does not apply to fire engine" }
          : {}),
      });
      inFlight = undefined;
      return { ...results, provenance: provenance() };
    }
    attempts.push({
      provider: "fire-engine",
      outcome: "skipped",
      detail: "FIRE_ENGINE_BETA_URL is not set",
    });

    // includeDomains/excludeDomains are enforced on returned URLs only on
    // the fire engine path above; the fallback providers below receive them
    // solely as the site: chain baked into the query.
    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      inFlight = "searxng";
      const searxng = await searxng_search(query, {
        num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        searxngCategory,
      });
      inFlight = undefined;
      searxngCategories = searxng.categories;
      attempts.push({
        provider: "searxng",
        outcome: searxng.outcome,
        ...(searxng.detail ? { detail: searxng.detail } : {}),
        ...(searxng.unresponsiveEngines.length
          ? { unresponsiveEngines: searxng.unresponsiveEngines }
          : {}),
        ...(searxng.unknownEngines.length
          ? { unknownEngines: searxng.unknownEngines }
          : {}),
        ...(searxng.unknownCategories.length
          ? { unknownCategories: searxng.unknownCategories }
          : {}),
        ...(Object.keys(searxng.engineData).length
          ? { engineData: searxng.engineData }
          : {}),
      });
      if (hasAnyResult(searxng.results))
        return { ...searxng.results, provenance: provenance() };
    } else {
      attempts.push({
        provider: "searxng",
        outcome: "skipped",
        detail: "SEARXNG_ENDPOINT is not set",
      });
    }

    // DuckDuckGo is a WEB fallback. Returning its web rows for a news/images
    // request would be a wrong-category answer, so only run it when the caller
    // asked for web (or asked for no source at all).
    const requested = type ? (Array.isArray(type) ? type : [type]) : ["web"];
    // A caller who named a SearXNG category asked for that category's results.
    // DuckDuckGo cannot honour it, so substituting generic web rows would be
    // the same wrong-category answer the news/images guard above refuses.
    if (searxngCategory) {
      logger.info(
        "DuckDuckGo fallback skipped: request pinned a SearXNG category",
      );
      attempts.push({
        provider: "duckduckgo",
        outcome: "skipped",
        detail: `cannot serve the requested SearXNG category "${searxngCategory}"`,
      });
    } else if (requested.includes("web")) {
      logger.info("Using DuckDuckGo search");
      inFlight = "duckduckgo";
      const ddgResults = await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      });
      inFlight = undefined;
      attempts.push({
        provider: "duckduckgo",
        outcome: hasAnyResult(ddgResults) ? "results" : "empty",
      });
      if (ddgResults.web && ddgResults.web.length > 0)
        return { ...ddgResults, provenance: provenance() };
    } else {
      logger.info("DuckDuckGo fallback skipped: request has no web source");
      attempts.push({
        provider: "duckduckgo",
        outcome: "skipped",
        detail: "request has no web source",
      });
    }

    // Fallback to empty response. Every provider's outcome is in the
    // provenance, so this is no longer indistinguishable from a failure.
    return { provenance: provenance() };
  } catch (error) {
    logger.error(`Error in search function`, { error });
    if (inFlight) {
      attempts.push({
        provider: inFlight,
        outcome: "error",
        detail: (error as Error)?.message ?? String(error),
      });
    }
    return { provenance: provenance() };
  }
}
