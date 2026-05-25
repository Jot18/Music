#!/usr/bin/env python3
"""
Parser smoke test
=================

Fetches one known-good djjohal page and asserts that the parser still
extracts the essential fields (cover, stream URL, mp3 download, title,
artist). If djjohal changes their HTML structure, this fails LOUDLY in
CI before the main scrape silently degrades the library.

Run as a workflow step before the real scrape:

    python scraper/smoke_test.py

Exits 0 on success, 1 on failure (which fails the job and aborts the
scrape — preserving the existing DB rather than overwriting it with
empty parses).

The probe pages were picked because they're old enough to be stable
(not getting edited) but not so old they'd be removed:

  single — id=526452 "CEO" by Cheema Y (from Top 50 Album Songs chart)
  album  — id=736738 "Bermuda Triangle - Full Album" by Cheema Y
"""

from __future__ import annotations
import sys
from pathlib import Path

# Make scrape.py importable so we reuse the real parser. We do NOT
# import its scraper-loop functions — just the parsers.
sys.path.insert(0, str(Path(__file__).parent))

import scrape  # noqa: E402


SINGLE_URL = f"{scrape.SOURCE}/get/526452/CEO.html"
ALBUM_URL  = f"{scrape.SOURCE}/album/736738/bermuda-triangle-full-album.html"


def check_single() -> list[str]:
    """Return a list of error strings (empty list = success)."""
    errors = []
    try:
        html = scrape.fetch(SINGLE_URL)
    except Exception as e:
        return [f"single fetch failed: {e}"]

    d = scrape.parse_detail(html, "single")
    if not d.get("title"):  errors.append("single: title missing")
    if not d.get("artist"): errors.append("single: artist missing")
    if not d.get("cover"):  errors.append("single: cover missing")
    # At least one playable URL must be present.
    if not any(d.get(k) for k in ("stream_url", "mp3_320", "mp3_128", "mp3_48")):
        errors.append("single: no playable mp3 URLs (stream/320/128/48 all empty)")
    return errors


def check_album() -> list[str]:
    errors = []
    try:
        html = scrape.fetch(ALBUM_URL)
    except Exception as e:
        return [f"album fetch failed: {e}"]

    d = scrape.parse_detail(html, "album")
    if not d.get("title"):  errors.append("album: title missing")
    if not d.get("cover"):  errors.append("album: cover missing")
    # Album zip must exist (this is the file users download).
    if not (d.get("zip_320") or d.get("zip_128")):
        errors.append("album: no zip download URLs")
    # Album track list — this is what makes albums actually playable
    # in the site (each child track is a single).
    tracks = d.get("album_tracks") or []
    if len(tracks) < 3:
        errors.append(f"album: too few child tracks (got {len(tracks)}, expected >=3)")
    return errors


def main() -> int:
    print("[smoke] testing single parser…", flush=True)
    single_errors = check_single()
    print("[smoke] testing album parser…", flush=True)
    album_errors  = check_album()

    all_errors = single_errors + album_errors
    if all_errors:
        print("\n!! PARSER SMOKE TEST FAILED !!", file=sys.stderr)
        for e in all_errors:
            print(f"   - {e}", file=sys.stderr)
        print(
            "\ndjjohal likely changed their HTML. Fix scraper/scrape.py "
            "before letting a real scrape run, or it will overwrite the "
            "existing library with partial/empty parses.",
            file=sys.stderr,
        )
        return 1

    print("[smoke] OK — parsers still work")
    return 0


if __name__ == "__main__":
    sys.exit(main())
