const mocks = vi.hoisted(() => ({
  getModel: vi.fn(() => ({ modelId: "stub" })),
  config: {
    VERTEX_CREDENTIALS: undefined as string | undefined,
    MODEL_NAME: undefined as string | undefined,
    OLLAMA_BASE_URL: undefined as string | undefined,
    OPENAI_API_KEY: undefined as string | undefined,
  },
}));

vi.mock("../../../config", () => ({ config: mocks.config }));
vi.mock("../../../lib/generic-ai", () => ({ getModel: mocks.getModel }));

import { googleModel, googleProviderOptions, hasLlmProvider } from "./tuning";

const savedEnv = {
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  mocks.config.VERTEX_CREDENTIALS = undefined;
  mocks.config.MODEL_NAME = undefined;
  mocks.config.OLLAMA_BASE_URL = undefined;
  mocks.config.OPENAI_API_KEY = undefined;
});

afterEach(() => {
  if (savedEnv.GOOGLE_GENERATIVE_AI_API_KEY === undefined) {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  } else {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY =
      savedEnv.GOOGLE_GENERATIVE_AI_API_KEY;
  }
  if (savedEnv.GEMINI_API_KEY === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = savedEnv.GEMINI_API_KEY;
  }
});

describe("hasLlmProvider", () => {
  it("is true on Vertex credentials", () => {
    mocks.config.VERTEX_CREDENTIALS = "{}";
    expect(hasLlmProvider()).toBe(true);
  });

  it("is true on a Gemini key", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-key";
    expect(hasLlmProvider()).toBe(true);
  });

  it("falls back to the default provider when no Google key is configured", () => {
    mocks.config.MODEL_NAME = "default";
    expect(hasLlmProvider()).toBe(true);
  });

  it("is true on an Ollama base URL alone", () => {
    mocks.config.OLLAMA_BASE_URL = "http://localhost:11434/api";
    expect(hasLlmProvider()).toBe(true);
  });

  it("is true on an OpenAI key alone", () => {
    mocks.config.OPENAI_API_KEY = "sk-test";
    expect(hasLlmProvider()).toBe(true);
  });

  it("is false when nothing is configured", () => {
    expect(hasLlmProvider()).toBe(false);
  });

  it("treats an empty Gemini key as unset", () => {
    // Compose forwards unset .env values as "", which must not count as a key.
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";
    expect(hasLlmProvider()).toBe(false);
  });
});

describe("googleModel", () => {
  it("uses Vertex when its credentials are configured", () => {
    mocks.config.VERTEX_CREDENTIALS = "{}";
    googleModel("gemini-3.5-flash");
    expect(mocks.getModel).toHaveBeenCalledWith("gemini-3.5-flash", "vertex");
  });

  it("uses the GenAI provider when only a Gemini key is configured", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-key";
    googleModel("gemini-3.5-flash");
    expect(mocks.getModel).toHaveBeenCalledWith("gemini-3.5-flash", "google");
  });

  it("falls back to the default provider when neither is configured", () => {
    mocks.config.MODEL_NAME = "default";
    googleModel("gemini-3.5-flash");
    // No second argument: getModel then honours MODEL_NAME + OPENAI_BASE_URL,
    // which is how a self-hosted deployment routes every other LLM call.
    expect(mocks.getModel).toHaveBeenCalledWith("gemini-3.5-flash");
  });

  it("prefers Vertex over a Gemini key", () => {
    mocks.config.VERTEX_CREDENTIALS = "{}";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-key";
    googleModel("gemini-3.5-flash");
    expect(mocks.getModel).toHaveBeenCalledWith("gemini-3.5-flash", "vertex");
  });
});

describe("googleProviderOptions", () => {
  it("sends Vertex billing labels when Vertex is configured", () => {
    mocks.config.VERTEX_CREDENTIALS = "{}";
    const options = googleProviderOptions("judgeChange", {
      teamId: "t1",
      monitorId: "m1",
      monitorCheckId: "c1",
    });
    expect(options.providerOptions?.vertex).toMatchObject({
      thinkingConfig: { thinkingLevel: "minimal" },
      labels: {
        functionId: "judgeChange",
        teamId: "t1",
        monitorId: "m1",
        monitorCheckId: "c1",
      },
    });
  });

  it("sends GenAI options without labels on the Gemini path", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-key";
    const options = googleProviderOptions("judgeChange");
    expect(options.providerOptions?.google).toEqual({
      thinkingConfig: { thinkingLevel: "minimal" },
    });
    expect(options.providerOptions?.vertex).toBeUndefined();
  });

  it("sends nothing on the fallback path", () => {
    // thinkingConfig and labels are Google-shaped; the default provider would
    // ignore or reject them, so a configured local LLM must get no
    // providerOptions at all rather than Google ones.
    mocks.config.MODEL_NAME = "default";
    expect(googleProviderOptions("judgeChange")).toEqual({});
  });

  it("sends nothing when an empty Gemini key falls back", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";
    mocks.config.MODEL_NAME = "default";
    expect(googleProviderOptions("judgeChange")).toEqual({});
  });

  it("is spreadable into generateText options", () => {
    mocks.config.MODEL_NAME = "default";
    expect({ model: "m", ...googleProviderOptions("judgeChange") }).toEqual({
      model: "m",
    });
  });
});
