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
  - Retries with backoff on transient failures (timeout / empty / 5xx-ish).
  - Optional disk cache via `--max-age` (local to cwd's .firecrawl/).
  - `health_check()` for a cheap pre-flight before batch scraping.

Usage (importable - preferred for scripts):
    from firecrawl_runner import (
        scrape_url, search_query, crawl_url, map_url, parse_file,
        health_check, FirecrawlError,
    )
    md = scrape_url("https://...", timeout=90)
    res = search_query("GPW news today", limit=5)
    ok = health_check()

Usage (CLI - transparent forward to the real binary):
    python3 firecrawl_runner.py scrape <url> --only-main-content [...]
    python3 firecrawl_runner.py search "query" --limit 5 [...]
    python3 firecrawl_runner.py crawl <url> [...]
    python3 firecrawl_runner.py map <url> [...]
    python3 firecrawl_runner.py parse <file> [...]
"""
import argparse
import os
import subprocess
import sys
import time

REAL_FIRECRAWL = os.environ.get("FIRECRAWL_BIN", "/home/wos/.local/bin/firecrawl")

DEFAULT_TIMEOUT = 120
DEFAULT_RETRIES = 1          # one retry on transient failure (cron-friendly)
DEFAULT_BACKOFF = 2.0        # seconds, scaled by attempt (2, 4, ...)

LIVENESS_URL = os.environ.get(
    "FIRECRAWL_LIVENESS", "http://localhost:3002/v0/health/liveness"
)


class FirecrawlError(RuntimeError):
    """Raised when the underlying firecrawl CLI fails or is unavailable."""


def _run(args, *, timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES,
         backoff=DEFAULT_BACKOFF):
    """Run the firecrawl CLI once-or-more with retry/backoff on transient errors.

    Retries on: timeout, nonzero return / empty stdout. Does NOT retry on a
    missing binary (fatal). Raises FirecrawlError after exhausting retries.
    """
    last_err = None
    for attempt in range(retries + 1):
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
            last_err = FirecrawlError(f"firecrawl timed out after {timeout}s")
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
                continue
            raise last_err
        if r.returncode != 0 or not r.stdout.strip():
            msg = (r.stderr or r.stdout).strip() or "no output"
            last_err = FirecrawlError(msg[:300])
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
                continue
            raise last_err
        return r.stdout.strip()
    raise last_err or FirecrawlError("unknown firecrawl failure")


def scrape_url(url, *, only_main_content=True, extra_args=None,
               timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES,
               backoff=DEFAULT_BACKOFF, max_age_ms=None):
    """Scrape ONE url. Returns markdown str. Raises FirecrawlError on failure."""
    if not url:
        raise FirecrawlError("empty url")
    args = ["scrape", url]
    if only_main_content:
        args.append("--only-main-content")
    if max_age_ms is not None:
        args += ["--max-age", str(int(max_age_ms))]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout, retries=retries, backoff=backoff)


def search_query(query, *, limit=5, extra_args=None,
                 timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES,
                 backoff=DEFAULT_BACKOFF):
    """Web search (uses Firecrawl cloud, NOT local LLM). Returns raw result str."""
    if not query:
        raise FirecrawlError("empty query")
    args = ["search", query, "--limit", str(limit)]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout, retries=retries, backoff=backoff)


def crawl_url(url, *, extra_args=None, timeout=DEFAULT_TIMEOUT,
              retries=DEFAULT_RETRIES, backoff=DEFAULT_BACKOFF):
    """Crawl a site (may use LLM for depth). Returns raw result str."""
    if not url:
        raise FirecrawlError("empty url")
    args = ["crawl", url]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout, retries=retries, backoff=backoff)


def map_url(url, *, extra_args=None, timeout=DEFAULT_TIMEOUT,
            retries=DEFAULT_RETRIES, backoff=DEFAULT_BACKOFF):
    """Map a site to its URL list. Returns raw result str."""
    if not url:
        raise FirecrawlError("empty url")
    args = ["map", url]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout, retries=retries, backoff=backoff)


def parse_file(path, *, extra_args=None, timeout=DEFAULT_TIMEOUT,
               retries=DEFAULT_RETRIES, backoff=DEFAULT_BACKOFF):
    """Parse a local file (PDF/DOCX/...). Returns raw result str."""
    if not path:
        raise FirecrawlError("empty path")
    args = ["parse", path]
    if extra_args:
        args.extend(extra_args)
    return _run(args, timeout=timeout, retries=retries, backoff=backoff)


def health_check(liveness_url=LIVENESS_URL, *, timeout=10):
    """Cheap liveness probe of the local Firecrawl API. Returns bool.

    Use before a batch scrape so a dead stack fails fast instead of burning
    N x timeout seconds on sequential requests.
    """
    import urllib.request
    try:
        req = urllib.request.Request(liveness_url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


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
        if cmd == "scrape":
            out = scrape_url(argv[1] if len(argv) > 1 else "", extra_args=argv[2:])
        elif cmd == "search":
            out = _run(argv, timeout=DEFAULT_TIMEOUT)
        else:
            out = _run(argv, timeout=DEFAULT_TIMEOUT)
    except FirecrawlError as e:
        print(f"__ERROR__:{e}", file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
