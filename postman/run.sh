#!/usr/bin/env bash
# Run the Firecrawl integration collection against the local Docker stack.
#
# Neither Postman file carries a credential you need to keep out of git: the
# collection is committed clean, the environment is untracked, and openApiKey,
# bullAuthKey and typesafeApiKey are injected at run time from the same files
# Compose uses - .env.prod for the secrets, .env for the endpoints.
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

# The Postman environment is untracked because it holds real endpoints and keys.
# A fresh clone has only the .example.json, which is enough: every credential is
# injected below rather than read from here.
postman_env="${FIRECRAWL_POSTMAN_ENV:-$here/firecrawl-integration-test.postman_environment.json}"
[[ -f "$postman_env" ]] || postman_env="$here/firecrawl-integration-test.postman_environment.example.json"

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
TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-$(from_file "$secrets_file" TYPESAFE_API_KEY)}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(from_file "$env_file" OPENAI_BASE_URL)}"
TYPESAFE_BASE_URL="${TYPESAFE_BASE_URL:-$(from_file "$env_file" TYPESAFE_BASE_URL)}"
TYPESAFE_MODEL="${TYPESAFE_MODEL:-$(from_file "$env_file" TYPESAFE_MODEL)}"

# llama-swap is reachable directly, so drop the /v1 the OpenAI SDK appends.
openApiUrl="${openApiUrl:-${OPENAI_BASE_URL%/v1}}"
# The SDK does the same to TYPESAFE_BASE_URL before appending /v1/systemone.
typesafeUrl="${typesafeUrl:-${TYPESAFE_BASE_URL%/}}"
typesafeUrl="${typesafeUrl%/v1}"
jevModel="${jevModel:-$TYPESAFE_MODEL}"

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

# Jev is a fork addition and Firecrawl runs without it, so a missing key is a
# warning rather than a hard stop - but say so, since the failure otherwise is a
# bare 401 from Zen.
[[ -n "$TYPESAFE_API_KEY" ]] || echo "run.sh: warning: no TYPESAFE_API_KEY in $secrets_file; the Jev requests will fail with 401." >&2

# Secrets go on the command line, so keep them out of any printed output.
exec newman run \
  "$here/firecrawl-integration-test.postman_collection.json" \
  -e "$postman_env" \
  --env-var "openApiUrl=$openApiUrl" \
  --env-var "openApiKey=$OPENAI_API_KEY" \
  --env-var "bullAuthKey=$BULL_AUTH_KEY" \
  --env-var "typesafeUrl=$typesafeUrl" \
  --env-var "typesafeApiKey=$TYPESAFE_API_KEY" \
  --env-var "jevModel=$jevModel" \
  "$@"