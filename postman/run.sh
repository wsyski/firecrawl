#!/usr/bin/env bash
# Run the Firecrawl integration collection against the local Docker stack.
#
# Two environment files live here, and they are not interchangeable:
#   firecrawl-integration-test.postman_environment.json        committed, keys blank
#   firecrawl-integration-test.postman_environment.prod.json   untracked, carries the keys
# The .prod one is the version deployed to the Postman workspace and the default here, so a
# local run exercises the same values the app sees. To create it from the committed one,
# copy it and fill bullAuthKey, openApiKey and typesafeApiKey:
#   cp firecrawl-integration-test.postman_environment.json \
#      firecrawl-integration-test.postman_environment.prod.json
# Point FIRECRAWL_POSTMAN_ENV at the committed file to run keyless instead (the Jev
# requests skip themselves, Bull Board and the Open API model listing will fail).
#
# Credentials are resolved in order: a shell export, then .env.prod, then the Postman
# environment file itself, and are injected at run time as an override of whatever the
# environment file carries. Endpoints come from .env (OPENAI_BASE_URL, TYPESAFE_*).
#
#   ./postman/run.sh                      # everything
#   ./postman/run.sh --folder "Queue Admin (optional)"
#
# Override with FIRECRAWL_ENV / FIRECRAWL_SECRETS / FIRECRAWL_POSTMAN_ENV, or export the
# values yourself; anything already exported wins over the files.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${FIRECRAWL_ENV:-$here/../.env}"
secrets_file="${FIRECRAWL_SECRETS:-$here/../.env.prod}"

# Default to the untracked copy that holds the keys, so local runs match what is deployed.
# An explicitly named file is taken at its word: silently substituting a different one would
# run against credentials the caller did not ask for.
if [[ -n "${FIRECRAWL_POSTMAN_ENV:-}" ]]; then
  postman_env="$FIRECRAWL_POSTMAN_ENV"
  if [[ ! -f "$postman_env" ]]; then
    echo "run.sh: FIRECRAWL_POSTMAN_ENV=$postman_env does not exist" >&2
    exit 1
  fi
else
  postman_env="$here/firecrawl-integration-test.postman_environment.prod.json"
  [[ -f "$postman_env" ]] || postman_env="$here/firecrawl-integration-test.postman_environment.json"
fi

# Read one key from a file without sourcing it, stripping optional quotes.
# Missing file or missing key yields empty, which is checked below.
from_file() {
  local file="$1" key="$2" v
  [[ -f "$file" ]] || return 0
  v="$(sed -n "s/^$key=//p" "$file" | head -n1)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

# Read one variable out of the Postman environment file, so a credential can come
# from it rather than only from .env.prod. A missing python3 degrades to "no value",
# which the preflight below then reports by name.
if ! command -v python3 >/dev/null 2>&1; then
  echo "run.sh: warning: no python3, so credentials cannot be read from the Postman environment file; the .env.prod and shell-export sources still apply." >&2
fi

from_postman_env() {
  python3 - "$postman_env" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    env = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for v in env.get("values", []):
    if v.get("key") == sys.argv[2]:
        print(v.get("value", ""))
PY
}

# Credential precedence: a shell export, then .env.prod, then the environment file.
# Guarded rather than ${VAR:-$(...)} so python3 runs only when the value is still unset.
[[ -n "${OPENAI_API_KEY:-}" ]] || OPENAI_API_KEY="$(from_file "$secrets_file" OPENAI_API_KEY)"
[[ -n "${OPENAI_API_KEY:-}" ]] || OPENAI_API_KEY="$(from_postman_env openApiKey)"
[[ -n "${BULL_AUTH_KEY:-}" ]] || BULL_AUTH_KEY="$(from_file "$secrets_file" BULL_AUTH_KEY)"
[[ -n "${BULL_AUTH_KEY:-}" ]] || BULL_AUTH_KEY="$(from_postman_env bullAuthKey)"
[[ -n "${TYPESAFE_API_KEY:-}" ]] || TYPESAFE_API_KEY="$(from_file "$secrets_file" TYPESAFE_API_KEY)"
[[ -n "${TYPESAFE_API_KEY:-}" ]] || TYPESAFE_API_KEY="$(from_postman_env typesafeApiKey)"
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
  echo "       looked in $secrets_file and in $postman_env, endpoint in $env_file." >&2
  echo "       Note a shell export of the same name overrides both." >&2
  exit 1
fi

# Jev is a fork addition and Firecrawl runs without it, so a missing key is a
# warning rather than a hard stop - but say so, since the failure otherwise is a
# bare 401 from Zen.
[[ -n "$TYPESAFE_API_KEY" ]] || echo "run.sh: warning: no TYPESAFE_API_KEY in $secrets_file or $postman_env; the Jev requests will fail with 401." >&2

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