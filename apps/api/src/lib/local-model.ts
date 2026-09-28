import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { config } from "../config";

// OPENAI_BASE_URL on this machine, the LAN or the tailnet is llama-swap;
// anything else is a cloud API, which gets MODEL_NAME as-is and none of the
// llama.cpp-specific handling below.
export function isLocalLlmUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6) {
    return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return (
    !host.includes(".") || // docker service name, e.g. "llama-swap"
    /\.(localhost|local|lan|internal|home\.arpa)$/.test(host)
  );
}

// Model choice is llama-swap's, not Firecrawl's: MODEL_NAME names a `warm`
// selector (e.g. "default") that serves whatever model is already running and
// loads its first target only when none is. The `model` field goes out as-is.
export const localModelFetch: typeof fetch = async (input, init) => {
  // Manual kill switch: while the lock file exists (bind-mounted from the
  // host), fail exactly like an unreachable server so the existing outage
  // handling applies unchanged.
  if (config.LLM_LOCK_FILE && existsSync(config.LLM_LOCK_FILE)) {
    throw new TypeError("fetch failed", {
      cause: Object.assign(
        new Error(`connect ECONNREFUSED (local LLM locked: ${config.LLM_LOCK_FILE})`),
        { code: "ECONNREFUSED" },
      ),
    });
  }
  if (typeof init?.body !== "string") return fetch(input, init);
  let body: {
    messages?: unknown;
    chat_template_kwargs?: Record<string, unknown>;
    id_slot?: unknown;
  };
  try {
    body = JSON.parse(init.body);
  } catch {
    return fetch(input, init);
  }
  const isChat = Array.isArray(body.messages);
  const disableThinking = isChat && config.LLM_DISABLE_THINKING === true;
  // llama-server: keep every Firecrawl call on its own slot, so a run of
  // different pages never evicts another client's cached conversation. A busy
  // slot queues the request instead of taking another one.
  const pinSlot =
    isChat && config.LLM_SLOT_ID !== undefined && body.id_slot === undefined;
  if (!disableThinking && !pinSlot) return fetch(input, init);
  const next: Record<string, unknown> = { ...body };
  // Thinking models (e.g. Nex-N2.5 templates) can spend the whole
  // budget on reasoning_content, leaving `content` empty. Only chat bodies;
  // a caller-provided value wins.
  if (disableThinking) {
    next.chat_template_kwargs = {
      ...body.chat_template_kwargs,
      enable_thinking: body.chat_template_kwargs?.enable_thinking ?? false,
    };
  }
  if (pinSlot) next.id_slot = config.LLM_SLOT_ID;
  return fetch(input, { ...init, body: JSON.stringify(next) });
};
