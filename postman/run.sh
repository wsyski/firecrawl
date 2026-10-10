#!/usr/bin/env bash
# Run the Firecrawl integration collection against the local Docker stack.
#
# The committed Postman environment deliberately holds no secrets: every value
# that also exists in .env is read from there and passed with --env-var, so .env
# stays the single source of truth and nothing sensitive is ever committed.
#
#   ./postman/run.sh                      # everything
#   ./postman/run.sh --folder "Queue Admin (optional)"
#
# Override the env file with FIRECRAWL_ENV=/path/to/.env, or export the three
# variables yourself; anything already exported wins.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${FIRECRAWL_ENV:-$here/../.env}"

if [[ ! -f "$env_file" ]]; then
  echo "run.sh: no .env at $env_file (set FIRECRAWL_ENV)" >&2
  exit 1
fi

# Read one key from .env without sourcing the file, and strip optional quotes.
from_env() {
  local v
  v="$(sed -n "s/^$1=//p" "$env_file" | head -n1)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

OPENAI_API_KEY="${OPENAI_API_KEY:-$(from_env OPENAI_API_KEY)}"
BULL_AUTH_KEY="${BULL_AUTH_KEY:-$(from_env BULL_AUTH_KEY)}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(from_env OPENAI_BASE_URL)}"

# llama-swap is reachable directly, so strip the /v1 that the OpenAI SDK expects.
openApiUrl="${openApiUrl:-${OPENAI_BASE_URL%/v1}}"

missing=()
[[ -n "$OPENAI_API_KEY" ]] || missing+=(OPENAI_API_KEY)
[[ -n "$BULL_AUTH_KEY"  ]] || missing+=(BULL_AUTH_KEY)
[[ -n "$openApiUrl"     ]] || missing+=(OPENAI_BASE_URL)
if (( ${#missing[@]} )); then
  echo "run.sh: empty in $env_file -> ${missing[*]}" >&2
  echo "       only the Queue Admin and Open APi folders need them." >&2
  exit 1
fi

# Secrets go on the command line, so keep them out of any printed output.
exec newman run \
  "$here/firecrawl-integration-test.postman_collection.json" \
  -e "$here/firecrawl-integration-test.postman_environment.json" \
  --env-var "openApiUrl=$openApiUrl" \
  --env-var "openApiKey=$OPENAI_API_KEY" \
  --env-var "bullAuthKey=$BULL_AUTH_KEY" \
  "$@"