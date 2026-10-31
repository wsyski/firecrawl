#!/usr/bin/env bash
# deploy-skills.sh — mirror the skills authored in this repo into the user skill hub, where
# Claude Code, OpenCode and Hermes load them. This repo is the source of truth; the hub copy
# is derived. The same file lives in /opt/playground/firecrawl and /opt/playground/searxng —
# keep them identical.
#
#   bin/deploy-skills.sh           the plan and the drift, nothing written
#   bin/deploy-skills.sh --apply   back up, then mirror skills/<name>/ -> $SKILL_HUB/<name>/
#   bin/deploy-skills.sh --check   exit 1 if a hub copy differs; skip cleanly if no hub
#
# NO FLAG IS THE DRY RUN: a bare invocation prints the plan and the drift and writes
# nothing, so the safe reading is the one that needs no flag. --apply is the only run that
# backs anything up or touches the hub.
#
# --check SKIPS when the hub is absent. CI and other checkouts have no ~/.agents, and a
# check that fails for that reason teaches people to ignore it; .github/workflows/skills.yml
# turns a skip back into a failure where it actually matters.
#
# Exit: 0 dry run printed, deployed, or no drift; 1 drift under --check or a failed copy;
# 2 usage.
set -euo pipefail

SKILL_HUB="${SKILL_HUB:-$HOME/.agents/skills}"
BACKUP_ROOT="${DEPLOY_BACKUP_ROOT:-/opt/backup/agents}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
SKILLS="$REPO/skills"
LABEL="$(basename "$REPO")-skills"
APPLY=0
CHECK=0

usage() {
cat <<'USAGE'
bin/deploy-skills.sh [--apply] [--check] [--dry-run]

  (no flag)    the dry run: the plan and the drift against the hub, nothing written
  --apply      the run that writes: back up every hub copy it replaces, then mirror
  --check      drift only: exit 1 when a hub copy differs, skip cleanly when there is no hub
  --dry-run    the dry run, named explicitly: the same run as no flag
  -h, --help   this text

Every skills/<name>/ that holds a SKILL.md is mirrored, found by glob rather than listed, so
a new skill needs no edit here. The hub is ${SKILL_HUB:-$HOME/.agents/skills}; SKILL_HUB
overrides it (the make targets use that to test against a scratch directory).

A live hub copy is parked under ${DEPLOY_BACKUP_ROOT:-/opt/backup/agents}/<timestamp>-<repo>-skills/
before it is replaced, keeping its relative layout. A first deploy has nothing to back up.

Exit: 0 dry run printed, deployed, or no drift; 1 drift under --check or a failed copy;
2 usage.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --check) CHECK=1; shift ;;
    --dry-run) shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy-skills.sh: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -d "$SKILLS" ] || { echo "deploy-skills.sh: no $SKILLS" >&2; exit 1; }
names=()
for skill in "$SKILLS"/*/SKILL.md; do
  [ -f "$skill" ] || continue                     # the glob, unmatched, stays literal
  names+=("$(basename "$(dirname "$skill")")")
done
[ "${#names[@]}" -gt 0 ] || { echo "deploy-skills.sh: $SKILLS holds no SKILL.md" >&2; exit 1; }

echo "deploy plan"
echo "  repo  $REPO"
echo "  hub   $SKILL_HUB"
echo "  mirror ${names[*]} -> $SKILL_HUB/<name>/ (rsync -a --delete --delete-excluded, __pycache__ excluded)"
echo ""
echo "drift (hub vs repo, before this deploy)"

rc=0
differs=()
findings=0
for name in "${names[@]}"; do
  src="$SKILLS/$name"
  dst="$SKILL_HUB/$name"
  if [ ! -d "$dst" ]; then
    findings=$((findings + 1))
    if [ "$CHECK" = 1 ]; then
      echo "  $name: no hub copy at $dst, skipping"
    else
      echo "  $name: not in the hub yet"
    fi
  elif out="$(diff -r -x __pycache__ "$src" "$dst")"; then
    echo "  $name: in sync"
  else
    printf '%s\n' "$out" | sed 's/^/  /'
    differs+=("$name")
    findings=$((findings + 1))
    rc=1
  fi
done
if [ "${#differs[@]}" -gt 0 ]; then
  echo "drift found — run: bin/deploy-skills.sh --apply" >&2
elif [ "$findings" = 0 ]; then
  echo "  none"
fi

if [ "$CHECK" = 1 ]; then
  exit "$rc"
fi
if [ "$APPLY" = 0 ]; then
  echo ""
  echo "dry run — nothing written. Re-run with --apply."
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup="$BACKUP_ROOT/$stamp-$LABEL"
for name in "${names[@]}"; do
  dst="$SKILL_HUB/$name"
  [ -d "$dst" ] || continue                       # nothing live to park
  mkdir -p "$backup" && cp -a "$dst" "$backup/$name" \
    || { echo "deploy-skills.sh: cannot back up $dst to $backup — nothing was deployed" >&2; exit 1; }
done

for name in "${names[@]}"; do
  dst="$SKILL_HUB/$name"
  mkdir -p "$dst"
  # --delete-excluded: plain --exclude would leave a hub __pycache__ in place forever.
  rsync -a --delete --delete-excluded --exclude=__pycache__ "$SKILLS/$name/" "$dst/" \
    || { echo "deploy-skills.sh: copy of $name to $dst failed" >&2; exit 1; }
  echo "  deployed $name -> $dst"
done
if [ -d "$backup" ]; then
  echo "backed up the live copies to $backup"
else
  echo "nothing to back up: no hub copy existed before this deploy"
fi
