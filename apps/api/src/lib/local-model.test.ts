import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    OPENAI_BASE_URL: "http://llama-swap.test:8081/v1",
    MODEL_NAME: "fallback-model",
  },
}));

import { config } from "../config";
import {
  __resetLocalModelCacheForTests,
  localModelFetch,
} from "./local-model";

const CHAT_URL = "http://llama-swap.test:8081/v1/chat/completions";

function modelsBody(loaded: string | null) {
  return {
    data: [
      { id: "model-a", status: { value: "unloaded" } },
      {
        id: "model-b",
        status: { value: loaded === "model-b" ? "loaded" : "unloaded" },
      },
    ],
  };
}

function stubFetch(loaded: string | null) {
  const fetchMock = vi.fn(async (input: any, init?: any) => ({
    ok: true,
    json: async () =>
      String(input).endsWith("/models") ? modelsBody(loaded) : {},
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentModel(fetchMock: any) {
  return JSON.parse(chatCall(fetchMock)[1].body).model;
}

function chatCall(fetchMock: any): any[] {
  return fetchMock.mock.calls.find(
    ([input]: any[]) => !String(input).endsWith("/models"),
  );
}

async function chat(body: unknown) {
  await localModelFetch(CHAT_URL, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("localModelFetch", () => {
  beforeEach(() => {
    __resetLocalModelCacheForTests();
    vi.restoreAllMocks();
    config.MODEL_NAME = "fallback-model";
  });

  it("rewrites the request to the model the server has loaded", async () => {
    const fetchMock = stubFetch("model-b");
    await chat({ model: "gpt-4o-mini", messages: [] });
    expect(sentModel(fetchMock)).toBe("model-b");
  });

  it("keeps the rest of the body intact when rewriting", async () => {
    const fetchMock = stubFetch("model-b");
    await chat({ model: "gpt-4o-mini", messages: [{ role: "user" }] });
    const call = chatCall(fetchMock);
    expect(JSON.parse(call[1].body).messages).toEqual([{ role: "user" }]);
    expect(call[1].method).toBe("POST");
  });

  it("falls back to MODEL_NAME when nothing is loaded", async () => {
    const fetchMock = stubFetch(null);
    await chat({ model: "gpt-4o-mini", messages: [] });
    expect(sentModel(fetchMock)).toBe("fallback-model");
  });

  it("falls back to the first model listed when MODEL_NAME is unset", async () => {
    config.MODEL_NAME = undefined;
    const fetchMock = stubFetch(null);
    await chat({ model: "gpt-4o-mini", messages: [] });
    expect(sentModel(fetchMock)).toBe("model-a");
  });

  it("leaves the request untouched when the probe fails", async () => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      if (String(input).endsWith("/models")) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    config.MODEL_NAME = undefined;
    await chat({ model: "gpt-4o-mini", messages: [] });
    expect(sentModel(fetchMock)).toBe("gpt-4o-mini");
  });

  it("probes once per TTL window across concurrent requests", async () => {
    const fetchMock = stubFetch("model-b");
    await Promise.all([
      chat({ model: "gpt-4o-mini", messages: [] }),
      chat({ model: "gpt-4o-mini", messages: [] }),
      chat({ model: "gpt-4o-mini", messages: [] }),
    ]);
    const probes = fetchMock.mock.calls.filter(([input]: any[]) =>
      String(input).endsWith("/models"),
    );
    expect(probes).toHaveLength(1);
  });

  it("passes through requests that carry no model field", async () => {
    const fetchMock = stubFetch("model-b");
    await localModelFetch("http://llama-swap.test:8081/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ input: "x" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes through requests whose body is not a string", async () => {
    const fetchMock = stubFetch("model-b");
    await localModelFetch(CHAT_URL, { method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
