import { TypeSafeClient } from "@typesafe-ai/sdk";
import { config } from "../config";

let client: TypeSafeClient | undefined;

// The SDK appends "/v1/systemone" to baseURL itself, so the configured value
// must stop at the host root. A trailing "/v1" (or "/") is dropped rather than
// left to 404 on "/v1/v1/systemone", which fails the same way as a typo'd host.
const typesafeBaseUrl = config.TYPESAFE_BASE_URL?.replace(/\/+$/, "").replace(
  /\/v1$/,
  "",
);

/**
 * The shared TypeSafe (Jev) client, or null when no API key is configured.
 * Callers pass their own timeout and retry policy per call.
 */
export function getTypeSafeClient(): TypeSafeClient | null {
  if (!config.TYPESAFE_API_KEY) return null;
  client ??= new TypeSafeClient({
    apiKey: config.TYPESAFE_API_KEY,
    // A host root, not the endpoint: the SDK appends /v1/systemone itself.
    ...(typesafeBaseUrl ? { baseURL: typesafeBaseUrl } : {}),
    // Client-level default; calls that omit `model` inherit it.
    ...(config.TYPESAFE_MODEL ? { defaultModel: config.TYPESAFE_MODEL } : {}),
    logLevel: "off",
  });
  return client;
}
