import { SearchResultType } from "../../lib/entities";

export type SearchProviderName = "fire-engine" | "searxng" | "duckduckgo";

export type SearchProviderOutcome =
  /** The provider answered with at least one result. */
  | "results"
  /** The provider answered, with nothing for this query. */
  | "empty"
  /** The provider could not be reached, or refused the request. */
  | "error"
  /** The provider was not tried. */
  | "skipped";

/** An upstream engine SearXNG itself reports as having failed the query. */
export interface UnresponsiveEngine {
  engine: string;
  reason?: string;
}

export interface SearchProviderAttempt {
  provider: SearchProviderName;
  outcome: SearchProviderOutcome;
  /** Why a provider was skipped, or how it failed. */
  detail?: string;
  /** Only SearXNG reports these, and only for the attempts it made. */
  unresponsiveEngines?: UnresponsiveEngine[];
  /**
   * Engine pins SearXNG did not recognise and silently ignored, from its
   * `unknown_engines` field. An ignored pin means the query ran against the
   * category's whole engine set instead, which is otherwise invisible.
   */
  unknownEngines?: string[];
}

export interface SearchProvenance {
  /** The provider whose results were returned, absent when none had any. */
  provider?: SearchProviderName;
  /** Every provider in chain order, so a silent fallthrough is visible. */
  attempts: SearchProviderAttempt[];
  /** The SearXNG category actually used, per requested source. */
  searxngCategories?: Partial<Record<SearchResultType, string>>;
}

/**
 * SearXNG's `unresponsive_engines` is documented as a list of
 * `[engine, reason]` pairs, but the shape has changed between releases and a
 * fork may add fields, so every element is read defensively rather than cast.
 * Anything unreadable is dropped instead of failing the search.
 */
export function normalizeUnresponsiveEngines(
  raw: unknown,
): UnresponsiveEngine[] {
  if (!Array.isArray(raw)) return [];
  const out: UnresponsiveEngine[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry) out.push({ engine: entry });
      continue;
    }
    if (Array.isArray(entry)) {
      const [engine, reason] = entry;
      if (typeof engine === "string" && engine) {
        out.push({
          engine,
          ...(typeof reason === "string" && reason ? { reason } : {}),
        });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const engine = [e.engine, e.name].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (!engine) continue;
      const reason = [e.reason, e.error, e.message].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      out.push({ engine, ...(reason ? { reason } : {}) });
    }
  }
  return dedupeUnresponsiveEngines(out);
}

/** The same engine can fail on several pages or several categories. */
export function dedupeUnresponsiveEngines(
  engines: UnresponsiveEngine[],
): UnresponsiveEngine[] {
  const byKey = new Map<string, UnresponsiveEngine>();
  for (const engine of engines) {
    const key = `${engine.engine}\u0000${engine.reason ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, engine);
  }
  return [...byKey.values()];
}

/**
 * SearXNG's `unknown_engines` is a list of the engine names it did not
 * recognise. Read with the same tolerance as the unresponsive list: this fork
 * of the instance added the field, so an older or different instance simply
 * omits it.
 */
export function normalizeUnknownEngines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
}
