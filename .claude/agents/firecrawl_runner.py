#!/usr/bin/env python3
"""firecrawl_runner.py - SINGLE chokepoint for ALL Firecrawl access in this profile.

Lives inside the `firecrawl-helper` skill so the skill is a self-contained,
reusable unit: documentation (SKILL.md) + executable Python (this file). Any
other skill or script can reuse firecrawl-helper by importing this wrapper:

    import importlib.util, os
    _p = os.path.expanduser(
        "~/.hermes/profiles/trader/skills/autonomous-ai-agents/"
        "firecrawl-helper/firecrawl_runner.py"
    )
    spec = importlib.util.spec_from_file_location("firecrawl_runner", _p)
    fr = importlib.util.module_from_spec(spec); spec.loader.exec_module(fr)
    md = fr.scrape_url("https://...", timeout=90)

Why this exists
---------------
The investments-daily-portfolio-summary skill (and anything else in this
profile) must NOT call the `firecrawl` CLI binary directly. Every scrape /
search goes through this wrapper so the firecrawl-helper skill's rules are
enforced in ONE place:

  - Sequential only. The local Firecrawl stack shares the same LM Studio
    instance as the cron job. This module never fans out to parallel requests;
    callers scrape one URL at a time.
  - Plain `--only-main-content` scrape does NOT touch the local LLM
    (browser render + HTML-to-markdown only). Safe.
  - `--schema` / `-Q` DO use the LLM. Allowed, but the caller must invoke
    them explicitly and one at a time.
  - Multi-URL scrape (fan-out) is refused outright.

Usage (CLI - transparent forward to the real binary):
    python3 firecrawl_runner.py scrape <url> --only-main-content [...]
    python3 firecrawl_runner.py search "query" --limit 5 [...]
    python3 firecrawl_runner.py crawl <url> [...]
    python3 firecrawl_runner.py map <url> [...]
    python3 firecrawl_runner.py parse <file> [...]

Usage (importable - preferred for scripts):
    from firecrawl_runner import scrape_url, search_query, FirecrawlError
    md = scrape_url("https://...", timeout=90)
    res = search_query("GPW news today", limit=5)
"""
import argparse
import os
import subprocess
import sys

REAL_FIRECRAWL = os.environ.get("FIRECRAWL_BIN", "/home/wos/.local/bin/firecrawl")


class FirecrawlError(RuntimeError):
    """Raised when the underlying firecrawl CLI fails or is unavailable."""


def _run(args, timeout=120):
    try:
        r = subprocess.run(
            [REAL_FIRECRAWL, *args],
            capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as e:
        raise FirecrawlError(
            f"firecrawl binary not found at {REAL_FIRECRAWL}"
        ) from e
    except subprocess.TimeoutExpired as e:
        raise FirecrawlError(f"firecrawl timed out after {timeout}s") from e
    if r.returncode != 0 or not r.stdout.strip():
        msg = (r.stderr or r.stdout).strip() or "no output"
        raise FirecrawlError(msg[:300])
    return r.stdout.strip()


def scrape_url(url, *, only_main_content=True, extra_args=None, timeout=120):
    """Scrape ONE url. Returns markdown str. Raises FirecrawlError on failure."""
    if not url:
        raise FirecrawlError("empty url")
    args = ["scrape", url]
    if only_main_content:
        args.append("--only-main-content")
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout)


def search_query(query, *, limit=5, extra_args=None, timeout=120):
    """Web search (uses Firecrawl cloud, NOT local LLM). Returns raw result str."""
    if not query:
        raise FirecrawlError("empty query")
    args = ["search", query, "--limit", str(limit)]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(
            "usage: firecrawl_runner.py <scrape|search|crawl|map|parse> [args...]",
            file=sys.stderr,
        )
        return 2

    cmd = argv[0]

    # Safety rule: never fan out to multiple URLs in one scrape call.
    if cmd == "scrape":
        urls = [a for a in argv[1:] if a.startswith("http")]
        if len(urls) > 1:
            print(
                "__ERROR__: firecrawl_runner refuses multi-URL scrape; "
                "scrape one URL at a time",
                file=sys.stderr,
            )
            return 1

    try:
        out = _run(argv, timeout=120)
    except FirecrawlError as e:
        print(f"__ERROR__:{e}", file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
