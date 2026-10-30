import { describe, it, expect } from "vitest";
import {
  dedupeUnresponsiveEngines,
  normalizeUnknownEngines,
  normalizeUnresponsiveEngines,
} from "./provenance";

describe("normalizeUnresponsiveEngines", () => {
  it("reads the documented [engine, reason] pairs", () => {
    expect(
      normalizeUnresponsiveEngines([
        ["google", "timeout"],
        ["bing", "CAPTCHA"],
      ]),
    ).toEqual([
      { engine: "google", reason: "timeout" },
      { engine: "bing", reason: "CAPTCHA" },
    ]);
  });

  it("reads a pair with no reason", () => {
    expect(normalizeUnresponsiveEngines([["google"]])).toEqual([
      { engine: "google" },
    ]);
  });

  it("reads a bare engine name", () => {
    expect(normalizeUnresponsiveEngines(["google"])).toEqual([
      { engine: "google" },
    ]);
  });

  it("reads an object, under any of the known reason keys", () => {
    expect(
      normalizeUnresponsiveEngines([
        { engine: "google", reason: "timeout" },
        { name: "bing", error: "HTTP 429" },
        { engine: "ddg", message: "no results" },
      ]),
    ).toEqual([
      { engine: "google", reason: "timeout" },
      { engine: "bing", reason: "HTTP 429" },
      { engine: "ddg", reason: "no results" },
    ]);
  });

  it("drops entries with no engine name instead of failing", () => {
    expect(
      normalizeUnresponsiveEngines([
        null,
        undefined,
        "",
        [],
        [42],
        {},
        { reason: "orphan" },
        ["google", "timeout"],
      ]),
    ).toEqual([{ engine: "google", reason: "timeout" }]);
  });

  it("returns nothing for a non-array, so a changed shape is not fatal", () => {
    expect(normalizeUnresponsiveEngines(undefined)).toEqual([]);
    expect(normalizeUnresponsiveEngines({ google: "timeout" })).toEqual([]);
    expect(normalizeUnresponsiveEngines("google")).toEqual([]);
  });

  it("ignores extra fields a fork may add", () => {
    expect(
      normalizeUnresponsiveEngines([
        { engine: "google", reason: "timeout", ignoredPin: true },
      ]),
    ).toEqual([{ engine: "google", reason: "timeout" }]);
  });

  it("dedupes repeats within one response", () => {
    expect(
      normalizeUnresponsiveEngines([
        ["google", "timeout"],
        ["google", "timeout"],
      ]),
    ).toEqual([{ engine: "google", reason: "timeout" }]);
  });
});

describe("dedupeUnresponsiveEngines", () => {
  it("keeps the same engine when the reason differs", () => {
    expect(
      dedupeUnresponsiveEngines([
        { engine: "google", reason: "timeout" },
        { engine: "google", reason: "HTTP 429" },
        { engine: "google", reason: "timeout" },
      ]),
    ).toEqual([
      { engine: "google", reason: "timeout" },
      { engine: "google", reason: "HTTP 429" },
    ]);
  });
});

describe("normalizeUnknownEngines", () => {
  it("reads the instance's list of ignored engine pins", () => {
    // Observed live: ?engines=bing news,no such engine
    expect(normalizeUnknownEngines(["no such engine"])).toEqual([
      "no such engine",
    ]);
  });

  it("dedupes and drops anything that is not a name", () => {
    expect(
      normalizeUnknownEngines(["a", "a", "", null, 42, { engine: "b" }]),
    ).toEqual(["a"]);
  });

  it("returns nothing when the instance omits the field", () => {
    expect(normalizeUnknownEngines(undefined)).toEqual([]);
    expect(normalizeUnknownEngines("a")).toEqual([]);
  });
});
