#!/usr/bin/env bash
# deploy-docker.sh — redeploy this fork's local Firecrawl to Docker: rebuild the services
# this compose file builds, then recreate them.
#
# Three services are BUILT from this working tree — api (apps/api), playwright-service
# (apps/playwright-service-ts) and nuq-postgres (apps/nuq-postgres) — and the rest are
# pulled images. A rebuild is what makes "the latest version" true: a container keeps the
# image it started with, so `docker compose up -d` alone would leave the old code running
# and say nothing.
#
#   bin/deploy-docker.sh             print the plan: the built services, their contexts, the running set
#   bin/deploy-docker.sh --apply     docker compose build + up -d
#
# NO FLAG IS THE DRY RUN, like the sibling deploy-skills.sh. There is no --check: Docker
# reports its own state (`docker compose ps`) and there is no file tree to diff.
#
# Exit: 0 dry run printed or deployed, 1 a docker failure, 2 usage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
COMPOSE_FILE="$REPO/docker-compose.yaml"
PROJECT=firecrawl
# service:build-context, the only ones compose builds from this tree.
CONTEXTS=("api:apps/api" "playwright-service:apps/playwright-service-ts"
          "nuq-postgres:apps/nuq-postgres")
APPLY=0

usage() {
cat <<'USAGE'
bin/deploy-docker.sh [--apply] [--no-cache]

  (no flag)    the dry run: the built services and their contexts, the running set,
               nothing built or restarted
  --apply      rebuild the built services from this working tree, then recreate
  --no-cache   with --apply: build without the layer cache
  -h, --help   this text

Built here: api (apps/api), playwright-service (apps/playwright-service-ts) and
nuq-postgres (apps/nuq-postgres). redis, rabbitmq and the other pulled images are not
rebuilt. Env: ./.env (and ./.env.prod when present).

Run it after a change under apps/api (or the other two contexts). A running container keeps
the image it started with, so a code change is invisible until the image is rebuilt and the
container recreated.

Exit: 0 dry run printed or deployed, 1 a docker failure, 2 usage.
USAGE
}

NO_CACHE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --dry-run) shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy-docker.sh: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "deploy-docker.sh: no 'docker' on PATH" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "deploy-docker.sh: no $COMPOSE_FILE" >&2; exit 1; }

compose() { docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"; }

# The config must parse before anything is printed as a plan: a refused manifest looks
# exactly like a plan followed by a deploy that rebuilt nothing.
if ! config="$(compose config 2>&1)"; then
  echo "deploy-docker.sh: docker-compose.yaml does not resolve:" >&2
  printf '%s\n' "$config" >&2
  exit 1
fi

echo "deploy plan"
echo "  repo     $REPO"
echo "  compose  $COMPOSE_FILE"
echo "  project  $PROJECT"
echo "  build    $(printf '%s ' "${CONTEXTS[@]%%:*}")"
[ "$NO_CACHE" = 1 ] && cache=" --no-cache" || cache=""
echo "  command  docker compose build$cache && docker compose up -d --remove-orphans"
echo ""
echo "built here (service <- context)"
for pair in "${CONTEXTS[@]}"; do echo "  ${pair%%:*} <- ${pair#*:}"; done
echo ""
echo "now running"
docker ps --filter "label=com.docker.compose.project=$PROJECT" \
          --format '  {{.Label "com.docker.compose.service"}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true

if [ "$APPLY" = 0 ]; then
  echo ""
  echo "dry run — nothing built or restarted. Re-run with --apply."
  exit 0
fi

flags=()
[ "$NO_CACHE" = 1 ] && flags+=(--no-cache)
echo ""
echo "building $(printf '%s ' "${CONTEXTS[@]%%:*}")"
services=()
for pair in "${CONTEXTS[@]}"; do services+=("${pair%%:*}"); done
compose build "${flags[@]}" "${services[@]}" \
  || { echo "deploy-docker.sh: build failed" >&2; exit 1; }

echo ""
echo "recreating"
compose up -d --remove-orphans \
  || { echo "deploy-docker.sh: up failed" >&2; exit 1; }

echo ""
echo "deployed:"
compose ps
echo ""
echo "check: curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:${PORT:-3002}/v0/health/liveness"
