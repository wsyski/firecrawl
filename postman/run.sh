#!/usr/bin/env bash
# Run the Firecrawl integration collection against the local Docker stack.
#
# Neither Postman file carries a credential: the collection and the environment
# are committed, so openApiKey and bullAuthKey are injected at run time from the
# same files Compose uses - .env.prod for the secrets, .env for the endpoint.
#
#   ./postman/run.sh                      # everything
#   ./postman/run.sh --folder "Queue Admin (optional)"
#
# Override with FIRECRAWL_ENV / FIRECRAWL_SECRETS, or export the values
# yourself; anything already exported wins over the files.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${FIRECRAWL_ENV:-$here/../.env}"
secrets_file="${FIRECRAWL_SECRETS:-$here/../.env.prod}"

# Read one key from a file without sourcing it, stripping optional quotes.
# Missing file or missing key yields empty, which is checked below.
from_file() {
  local file="$1" key="$2" v
  [[ -f "$file" ]] || return 0
  v="$(sed -n "s/^$key=//p" "$file" | head -n1)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

OPENAI_API_KEY="${OPENAI_API_KEY:-$(from_file "$secrets_file" OPENAI_API_KEY)}"
BULL_AUTH_KEY="${BULL_AUTH_KEY:-$(from_file "$secrets_file" BULL_AUTH_KEY)}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(from_file "$env_file" OPENAI_BASE_URL)}"

# llama-swap is reachable directly, so drop the /v1 the OpenAI SDK appends.
openApiUrl="${openApiUrl:-${OPENAI_BASE_URL%/v1}}"

missing=()
[[ -n "$OPENAI_API_KEY" ]] || missing+=(OPENAI_API_KEY)
[[ -n "$BULL_AUTH_KEY"  ]] || missing+=(BULL_AUTH_KEY)
[[ -n "$openApiUrl"     ]] || missing+=(OPENAI_BASE_URL)
if (( ${#missing[@]} )); then
  echo "run.sh: empty -> ${missing[*]}" >&2
  echo "       secrets come from $secrets_file, the endpoint from $env_file." >&2
  echo "       Note a shell export of the same name overrides both." >&2
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