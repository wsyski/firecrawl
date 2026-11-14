#!/usr/bin/env bash
# unit-tests.sh — run the unit layer of the test suite: every colocated *.test.ts, i.e. the
# ones that need no API stack. The other layer, the snips in src/__tests__/snips/, drives a
# live API and belongs to `pnpm harness pnpm test:snips`, so it is out of scope here.
#
#   bin/unit-tests.sh                 the whole unit suite
#   bin/unit-tests.sh <vitest args>   the same, passed through (a file path, -t <name>, ...)
#
# What is excluded, and why it is not a unit test:
#   src/__tests__/snips/**            live API + workers, via src/harness.ts
#   src/__tests__/e2e*/**             legacy route tests, need the running stack (engines, queue)
#   src/__tests__/nuq-fdb/**          only when the FoundationDB client library cannot load —
#                                     the files import the binding, so they error at import
#                                     instead of self-skipping on config.FDB_CLUSTER_FILE.
#                                     See FDB_CLIENT_DIR below.
#
# Two services the suite does touch, both from CI's own environment (test-server.yml gives the
# job a redis service and dpkgs the FoundationDB client), neither from the Compose stack:
#
#   redis            if REDIS_URL is unset and nothing listens on 127.0.0.1:6379, a throwaway
#                    redis:alpine container is started for the run and removed on exit. The
#                    Compose redis publishes no host port, so the stack is not an alternative.
#   libfdb_c.so      the client library is system-installed in CI. Rootless: download the same
#                    .deb and `dpkg-deb -x` it somewhere, then point FDB_CLIENT_DIR at its
#                    usr/lib — the binding dlopens libfdb_c.so from there and the nuq-fdb
#                    suites self-skip (no FDB_CLUSTER_FILE) instead of erroring. Without it,
#                    anything importing the nuq-fdb client fails to load, which is most of
#                    src/scraper/scrapeURL/**.
#
# The repo-root .env is deliberately NOT sourced: the service-gated suites (nuq-postgres, the
# monitoring ones) skip themselves when their config is unset, which is what keeps this run
# independent of the Compose stack.
#
# Vitest is called through its pinned binary, not `pnpm exec`: pnpm re-checks dependencies on
# every exec and aborts that check on the foundationdb install script (see DESIGN.md).
#
# Exit: vitest's, 1 if a prerequisite is missing, 2 usage.
set -euo pipefail

usage() { sed -n '2,37p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then usage; exit 0; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
API="$REPO/apps/api"
VITEST="$API/node_modules/vitest/vitest.mjs"
FDB_CLIENT_DIR="${FDB_CLIENT_DIR:-/opt/ext/fdb-clients/usr/lib}"
REDIS_CONTAINER=firecrawl-unit-redis

if [ ! -f "$VITEST" ]; then
  echo "bin/unit-tests.sh: no vitest at $VITEST — run: cd apps/api && corepack pnpm install" >&2
  exit 1
fi

if [ -e "$FDB_CLIENT_DIR/libfdb_c.so" ]; then
  export LD_LIBRARY_PATH="$FDB_CLIENT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

started_redis=0
redis_up() { (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null && exec 3>&-; }
cleanup() {
  if [ "$started_redis" = 1 ]; then
    docker stop "$REDIS_CONTAINER" >/dev/null 2>&1 || true
    echo "unit tests: $REDIS_CONTAINER removed"
  fi
}
trap cleanup EXIT

if [ -z "${REDIS_URL:-}" ] && ! redis_up; then
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  if ! docker run -d --rm --name "$REDIS_CONTAINER" -p 127.0.0.1:6379:6379 redis:alpine >/dev/null; then
    echo "bin/unit-tests.sh: no redis on 127.0.0.1:6379 and none could be started — the" >&2
    echo "  redis-backed suites fail. Start one, or set REDIS_URL for a reachable one." >&2
    exit 1
  fi
  started_redis=1
  for _ in {1..20}; do redis_up && break; sleep 0.5; done
  echo "unit tests: started $REDIS_CONTAINER (redis:alpine, 127.0.0.1:6379), removed on exit"
fi

EXCLUDES=(
  --exclude='src/__tests__/snips/**'
  --exclude='src/__tests__/e2e*/**'
)
if ! (cd "$API" && node -e "import('foundationdb').catch(() => process.exit(1))") >/dev/null 2>&1; then
  echo "unit tests: libfdb_c.so not loadable (FDB_CLIENT_DIR=$FDB_CLIENT_DIR) — excluding nuq-fdb"
  EXCLUDES+=(--exclude='src/__tests__/nuq-fdb/**')
fi

echo "unit tests: $API/src — excluding ${EXCLUDES[*]#--exclude=}"
cd "$API"
exec node "$VITEST" run "${EXCLUDES[@]}" "$@"
