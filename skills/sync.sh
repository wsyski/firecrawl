#!/usr/bin/env bash
# Mirrors each skill under skills/ into the user skill hub, where Claude Code,
# OpenCode and Hermes load it. This repo is the source of truth; the hub copy is
# derived. The same file lives in /opt/playground/firecrawl and
# /opt/playground/searxng - keep them identical.
#
#   skills/sync.sh sync    copy skills/<name>/ -> $SKILL_HUB/<name>/
#   skills/sync.sh check   non-zero if a hub copy differs; skips if no hub
set -euo pipefail

SKILL_HUB="${SKILL_HUB:-$HOME/.agents/skills}"
root="$(cd "$(dirname "$0")" && pwd)"
rc=0

for skill in "$root"/*/SKILL.md; do
  src="$(dirname "$skill")"
  name="$(basename "$src")"
  dst="$SKILL_HUB/$name"
  case "${1:-}" in
    sync)
      mkdir -p "$dst"
      # --delete-excluded: plain --exclude would leave a hub __pycache__ in place forever.
      rsync -a --delete --delete-excluded --exclude=__pycache__ "$src/" "$dst/"
      echo "synced $name -> $dst"
      ;;
    check)
      # CI and other checkouts have no hub; failing there teaches people to ignore the check.
      if [ ! -d "$dst" ]; then
        echo "$name: no hub copy at $dst, skipping"
      elif diff -r -x __pycache__ "$src" "$dst"; then
        echo "$name: hub copy is in sync"
      else
        echo "$name: hub copy differs; run: skills/sync.sh sync" >&2
        rc=1
      fi
      ;;
    *)
      echo "usage: $0 sync|check" >&2
      exit 2
      ;;
  esac
done
exit $rc
