import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    OPENAI_BASE_URL: "http://llama-swap.test:8081/v1",
    MODEL_NAME: "default",
  },
}));

import { config } from "../config";
import { isLocalLlmUrl, localModelFetch } from "./local-model";

const CHAT_URL = "http://llama-swap.test:8081/v1/chat/completions";
const EMBEDDINGS_URL = "http://llama-swap.test:8081/v1/embeddings";

function stubFetch() {
  const fetchMock = vi.fn(async (input: any, init?: any) => ({
    ok: true,
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: any) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

async function chat(body: unknown) {
  await localModelFetch(CHAT_URL, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("localModelFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.MODEL_NAME = "default";
    config.LLM_DISABLE_THINKING = undefined;
    config.LLM_SLOT_ID = undefined;
    config.LLM_LOCK_FILE = undefined;
    config.OPENAI_API_KEY = undefined;
  });

  // llama-swap's `warm` selector picks the model, so Firecrawl never asks
  // what is loaded and never renames the model.
  it("sends the request unchanged, with no extra request", async () => {
    const fetchMock = stubFetch();
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "default", messages: [] }),
    };
    await localModelFetch(CHAT_URL, init);
    expect(fetchMock.mock.calls).toEqual([[CHAT_URL, init]]);
  });

  it("keeps the model and the rest of the body when adding fields", async () => {
    config.LLM_SLOT_ID = 1;
    config.LLM_DISABLE_THINKING = true;
    const fetchMock = stubFetch();
    await chat({ model: "default", messages: [{ role: "user" }] });
    const sent = sentBody(fetchMock);
    expect(sent.model).toBe("default");
    expect(sent.messages).toEqual([{ role: "user" }]);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("passes through non-chat bodies", async () => {
    const fetchMock = stubFetch();
    await localModelFetch(EMBEDDINGS_URL, {
      method: "POST",
      body: JSON.stringify({ input: "x" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes through requests whose body is not a string", async () => {
    const fetchMock = stubFetch();
    await localModelFetch(CHAT_URL, { method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("injects enable_thinking=false on chat bodies when LLM_DISABLE_THINKING", async () => {
    config.LLM_DISABLE_THINKING = true;
    const fetchMock = stubFetch();
    await chat({ model: "default", messages: [{ role: "user" }] });
    const sent = sentBody(fetchMock);
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.model).toBe("default");
  });

  it("lets a caller-provided enable_thinking win", async () => {
    config.LLM_DISABLE_THINKING = true;
    const fetchMock = stubFetch();
    await chat({
      model: "default",
      messages: [{ role: "user" }],
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(sentBody(fetchMock).chat_template_kwargs).toEqual({
      enable_thinking: true,
    });
  });

  it("does not touch non-chat bodies even when LLM_DISABLE_THINKING", async () => {
    config.LLM_DISABLE_THINKING = true;
    const fetchMock = stubFetch();
    await localModelFetch(EMBEDDINGS_URL, {
      method: "POST",
      body: JSON.stringify({ input: "x" }),
    });
    expect(sentBody(fetchMock).chat_template_kwargs).toBeUndefined();
  });

  it("leaves chat bodies untouched when LLM_DISABLE_THINKING is unset", async () => {
    const fetchMock = stubFetch();
    await chat({ model: "default", messages: [{ role: "user" }] });
    expect(sentBody(fetchMock).chat_template_kwargs).toBeUndefined();
  });

  it("pins chat bodies to LLM_SLOT_ID", async () => {
    config.LLM_SLOT_ID = 2;
    const fetchMock = stubFetch();
    await chat({ model: "default", messages: [{ role: "user" }] });
    expect(sentBody(fetchMock).id_slot).toBe(2);
  });

  it("lets a caller-provided id_slot win", async () => {
    config.LLM_SLOT_ID = 2;
    const fetchMock = stubFetch();
    await chat({ model: "default", messages: [{ role: "user" }], id_slot: 0 });
    expect(sentBody(fetchMock).id_slot).toBe(0);
  });

  it("does not pin non-chat bodies", async () => {
    config.LLM_SLOT_ID = 2;
    const fetchMock = stubFetch();
    await localModelFetch(EMBEDDINGS_URL, {
      method: "POST",
      body: JSON.stringify({ input: "x" }),
    });
    expect(sentBody(fetchMock).id_slot).toBeUndefined();
  });

  describe("LLM_LOCK_FILE", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "llm-lock-"));
      return () => rmSync(dir, { recursive: true, force: true });
    });

    it("fails like an unreachable server while the lock file exists", async () => {
      config.LLM_LOCK_FILE = join(dir, "llm.lock");
      writeFileSync(config.LLM_LOCK_FILE, "");
      const fetchMock = stubFetch();
      const err = await chat({ model: "default", messages: [] }).catch(e => e);
      expect(err).toBeInstanceOf(TypeError);
      expect(err.message).toBe("fetch failed");
      expect(err.cause.code).toBe("ECONNREFUSED");
      expect(err.cause.message).toContain(config.LLM_LOCK_FILE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks non-chat bodies too, as an outage would", async () => {
      config.LLM_LOCK_FILE = join(dir, "llm.lock");
      writeFileSync(config.LLM_LOCK_FILE, "");
      const fetchMock = stubFetch();
      await expect(
        localModelFetch(EMBEDDINGS_URL, {
          method: "POST",
          body: JSON.stringify({ input: "x" }),
        }),
      ).rejects.toThrow("fetch failed");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passes through when the lock file is absent", async () => {
      config.LLM_LOCK_FILE = join(dir, "llm.lock");
      const fetchMock = stubFetch();
      await chat({ model: "default", messages: [] });
      expect(sentBody(fetchMock).model).toBe("default");
    });
  });
});

describe("isLocalLlmUrl", () => {
  it.each([
    "http://192.168.1.100:8081/v1",
    "http://10.0.0.5:8080/v1",
    "http://172.20.0.3:8080/v1",
    "http://127.0.0.1:8081/v1",
    "http://100.101.102.103:8081/v1",
    "http://localhost:8081/v1",
    "http://host.docker.internal:8081/v1",
    "http://llama-swap:8080/v1",
    "http://zeus.local:8081/v1",
    "http://zeus.lan:8081/v1",
    "http://[::1]:8081/v1",
    "http://[fd12:3456::1]:8081/v1",
  ])("treats %s as local", url => {
    expect(isLocalLlmUrl(url)).toBe(true);
  });

  it.each([
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://api.deepseek.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "not a url",
    "",
    undefined,
  ])("treats %s as cloud", url => {
    expect(isLocalLlmUrl(url)).toBe(false);
  });
});
