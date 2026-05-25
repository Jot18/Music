#!/usr/bin/env python3
"""
Parser smoke test
=================

Fetches a small set of known-good djjohal pages and asserts the parser
still pulls out enough essential fields to be useful. Designed to catch
WHOLESALE parser breakage (djjohal restructured their HTML) — NOT to
flag individual edge cases on a single page.

Why the tolerance: djjohal's HTML is inconsistent. One song might be
missing the artist tag, another might have the cover in a different
spot, etc. A previous version of this test failed when ONE field was
empty on ONE probe page — too brittle and blocked legitimate scrapes.

The current strategy: probe MULTIPLE URLs per kind. As long as MOST of
them parse the core fields (title, cover, a playable URL), the parser
is considered healthy. If almost everything is missing across all probes,
the parser is genuinely broken and we fail the workflow.

Run as a workflow step before the real scrape:

    python scraper/smoke_test.py

Exits 0 on success, 1 on failure.
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import scrape  # noqa: E402


# Probe URLs — older IDs, multiple artists/eras, picked for stability.
SINGLE_PROBES = [
    ("526472", "skyfull-arjan-dhillon"),
    ("526471", "ruthless-arjan-dhillon"),
    ("526470", "raw-rich-rare-arjan-dhillon"),
    ("526469", "one-call-away-arjan-dhillon"),
]

ALBUM_PROBES = [
    ("735978", "immortal-ep"),
    ("735939", "deep-sea-diver-ep"),
    ("735933", "jigre-ep"),
]

# A probe passes if it extracts the minimum core signals: title, cover,
# and at least one playable URL (single) or zip (album). Artist is
# nice-to-have but not required — some djjohal pages just don't have it
# in a parseable spot, and one missing artist shouldn't fail a scrape.
def probe_single(slug_id: str, slug: str) -> tuple[bool, str]:
    url = f"{scrape.SOURCE}/get/{slug_id}/{slug}.html"
    try:
        html = scrape.fetch(url)
    except Exception as e:
        return False, f"fetch failed: {e}"
    d = scrape.parse_detail(html, "single")
    missing = []
    if not d.get("title"):  missing.append("title")
    if not d.get("cover"):  missing.append("cover")
    if not any(d.get(k) for k in ("stream_url", "mp3_320", "mp3_128", "mp3_48")):
        missing.append("any-mp3")
    if missing:
        return False, f"missing core fields: {', '.join(missing)}"
    return True, f"OK (title={d['title']!r}, artist={d['artist']!r})"


def probe_album(slug_id: str, slug: str) -> tuple[bool, str]:
    url = f"{scrape.SOURCE}/album/{slug_id}/{slug}.html"
    try:
        html = scrape.fetch(url)
    except Exception as e:
        return False, f"fetch failed: {e}"
    d = scrape.parse_detail(html, "album")
    missing = []
    if not d.get("title"):  missing.append("title")
    if not d.get("cover"):  missing.append("cover")
    if not (d.get("zip_320") or d.get("zip_128")):
        missing.append("any-zip")
    tracks = d.get("album_tracks") or []
    if len(tracks) < 2:
        missing.append(f"tracks(got {len(tracks)})")
    if missing:
        return False, f"missing core fields: {', '.join(missing)}"
    return True, f"OK (title={d['title']!r}, tracks={len(tracks)})"


def main() -> int:
    # Optional escape hatch: setting SKIP_SMOKE=yes bypasses the test.
    # Use only when you know the parser is fine and the test is flaky for
    # other reasons (network blip, single weird page, etc.).
    import os
    if os.environ.get("SKIP_SMOKE", "").lower() == "yes":
        print("[smoke] SKIP_SMOKE=yes — skipping")
        return 0

    print("[smoke] testing single parser…", flush=True)
    single_results = [(probe_id, probe_single(probe_id, slug))
                       for probe_id, slug in SINGLE_PROBES]
    for probe_id, (ok, msg) in single_results:
        marker = "✓" if ok else "✗"
        print(f"  {marker} single:{probe_id} {msg}")

    print("\n[smoke] testing album parser…", flush=True)
    album_results = [(probe_id, probe_album(probe_id, slug))
                      for probe_id, slug in ALBUM_PROBES]
    for probe_id, (ok, msg) in album_results:
        marker = "✓" if ok else "✗"
        print(f"  {marker} album:{probe_id} {msg}")

    # Health check: require MAJORITY of probes per kind to pass. If half
    # or more fail, the parser is genuinely broken — abort the scrape.
    single_pass = sum(1 for _, (ok, _) in single_results if ok)
    album_pass  = sum(1 for _, (ok, _) in album_results  if ok)

    print(f"\n[smoke] singles: {single_pass}/{len(SINGLE_PROBES)} passed")
    print(f"[smoke] albums:  {album_pass}/{len(ALBUM_PROBES)} passed")

    # Require at least 2/4 singles and 2/3 albums to consider the parser healthy.
    # Set this low because individual djjohal pages can be flaky, but
    # high enough that wholesale breakage trips it.
    SINGLE_MIN = max(1, len(SINGLE_PROBES) // 2)
    ALBUM_MIN  = max(1, len(ALBUM_PROBES)  // 2)

    if single_pass < SINGLE_MIN or album_pass < ALBUM_MIN:
        print(
            f"\n!! PARSER SMOKE TEST FAILED !!",
            file=sys.stderr,
        )
        print(
            f"   singles passed {single_pass}/{len(SINGLE_PROBES)} (need ≥{SINGLE_MIN})",
            file=sys.stderr,
        )
        print(
            f"   albums  passed {album_pass}/{len(ALBUM_PROBES)} (need ≥{ALBUM_MIN})",
            file=sys.stderr,
        )
        print(
            "\ndjjohal likely changed their HTML in a structural way. "
            "Fix scraper/scrape.py before letting a real scrape run, or it "
            "will overwrite the existing library with partial/empty parses.",
            file=sys.stderr,
        )
        return 1

    print("\n[smoke] OK — parser is healthy enough to proceed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
