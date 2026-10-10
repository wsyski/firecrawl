import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import { getModel } from "../../../lib/generic-ai";
import { config } from "../../../config";

// Vertex billing labels so every LLM call is traceable at the billing level by
// function, team, monitor, and monitor check (mirrors the Extract code). The
// GenAI provider ignores labels it doesn't understand.
export type LlmUsageLabels = {
  teamId: string;
  monitorId: string;
  monitorCheckId: string;
};

// AI SDK span metadata for a monitor LLM call: the check is the job, so the LLM
// spend dashboard attributes each provider call to its team, monitor and check.
export function monitorTelemetryMetadata(
  feature: string,
  labels?: LlmUsageLabels,
): Record<string, string> {
  return {
    ...(labels
      ? {
          teamId: labels.teamId,
          monitorId: labels.monitorId,
          jobId: labels.monitorCheckId,
        }
      : {}),
    jobKind: "monitor",
    feature,
  };
}

function geminiApiKey(): string | undefined {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
}

// Vertex is the preferred provider so usage is traceable via Vertex billing
// labels; the GenAI (Gemini) API is only a fallback when Vertex credentials
// aren't configured (e.g. self-hosted).
function hasVertex(): boolean {
  return Boolean(config.VERTEX_CREDENTIALS);
}

// With neither Google nor Vertex configured, fall back to the default provider
// (config.MODEL_NAME + OPENAI_BASE_URL / OLLAMA_BASE_URL), which is how every
// other LLM call in a self-hosted deployment is routed. Without this the
// monitor judge could not run at all once Google's key was dropped.
function defaultProviderAvailable(): boolean {
  return Boolean(
    config.MODEL_NAME || config.OLLAMA_BASE_URL || config.OPENAI_API_KEY,
  );
}

export function hasLlmProvider(): boolean {
  return hasVertex() || Boolean(geminiApiKey()) || defaultProviderAvailable();
}

export function googleModel(modelId: string) {
  if (hasVertex()) return getModel(modelId, "vertex");
  if (geminiApiKey()) return getModel(modelId, "google");
  return getModel(modelId);
}

export function googleProviderOptions(
  functionId: string,
  labels?: LlmUsageLabels,
) {
  const provider = hasVertex() ? "vertex" : "google";

  // thinkingConfig and labels are Google-shaped; the fallback provider would
  // ignore or reject them, so send nothing.
  if (provider === "google" && !geminiApiKey()) return {};

  const options: GoogleLanguageModelOptions = {
    thinkingConfig: { thinkingLevel: "minimal" },
  };
  // Billing labels are Vertex-only; the GenAI provider ignores them.
  if (provider === "vertex" && labels) {
    options.labels = { functionId, ...labels };
  }

  return { providerOptions: { [provider]: options } };
}
