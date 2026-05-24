#!/usr/bin/env python3
"""
DJJOhAL.Com Scraper v3
======================

Goals:
  - First run: deep scrape every paginated listing page (full history).
  - Subsequent runs: walk listings only until we hit pages where every ID is
    already known, then stop. Never re-fetch detail pages for known IDs.
  - Track first_seen_at / last_seen_at per item.
  - Output songs.json with two layers:
      * sections[] : the four visible feeds (live ordering from djjohal)
      * archive[]  : all items ever seen, with timestamps (history)

The same `data/songs.json` file is the database. It's loaded at startup,
mutated, and rewritten. No SQLite needed — the JSON IS the persistent store,
and the website can read it directly.

Sections scraped (each follows pagination):
  1. New Punjabi Single Songs  category.php?cat=Single Track    -> /get/{id}/
  2. New Punjabi Full Album/EP category.php?cat=Punjabi          -> /album/{id}/
  3. Top 50 Punjabi Singles    topTracks.php?cat=Single Track    -> /get/{id}/ (no pages)
  4. Top 50 Punjabi Chart      topTracks.php?cat=Punjabi         -> /get/{id}/ (no pages)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://www.djjohal.com"

SECTIONS = [
    {
        "id": "new_singles",
        "title": "New Punjabi Single Songs",
        "url": f"{BASE}/category.php?cat=Single%20Track",
        "kind": "single",
        "paginate": True,
        "live_cap": 60,
    },
    {
        "id": "new_albums",
        "title": "New Punjabi Full Album/EP",
        "url": f"{BASE}/category.php?cat=Punjabi",
        "kind": "album",
        "paginate": True,
        "live_cap": 60,
    },
    {
        "id": "top_singles",
        "title": "Top 50 Punjabi Single Songs",
        "url": f"{BASE}/topTracks.php?cat=Single%20Track",
        "kind": "single",
        "paginate": False,
        "live_cap": 50,
    },
    {
        "id": "top_albums",
        "title": "Top 50 Punjabi Songs (Chart)",
        "url": f"{BASE}/topTracks.php?cat=Punjabi",
        "kind": "single",
        "paginate": False,
        "live_cap": 50,
    },
]

# Set DEEP_SCRAPE=yes to force a full re-walk of all pages.
# 'auto' (default) = deep when archive is empty; incremental otherwise.
DEEP_SCRAPE = os.environ.get("DEEP_SCRAPE", "auto").lower()

MAX_PAGES_PER_SECTION = 200
MAX_DETAIL_FETCHES_PER_RUN = 500
DETAIL_DELAY_SECONDS = 0.30
LISTING_DELAY_SECONDS = 0.40
STOP_AFTER_N_KNOWN_PAGES = 2

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

DETAIL_PATH_RE = re.compile(r"^/(single|get|album)/(\d+)/([^/]+)\.html$")


def fetch(url: str, timeout: int = 25) -> str:
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            r.raise_for_status()
            return r.text
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def extract_listing(html: str, expected_kind: str) -> tuple[list[dict], str | None]:
    """Return (entries, next_page_url_or_None)."""
    soup = BeautifulSoup(html, "html.parser")

    items: list[dict] = []
    seen_ids: set[str] = set()
    next_url: str | None = None

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("http"):
            if href.startswith(BASE):
                path = href[len(BASE):]
            else:
                continue
        else:
            path = href
        if not path.startswith("/"):
            path = "/" + path

        m = DETAIL_PATH_RE.match(path.split("?")[0])
        if m:
            url_kind, item_id, slug = m.group(1), m.group(2), m.group(3)
            if expected_kind == "album" and url_kind != "album":
                continue
            if expected_kind == "single" and url_kind not in ("get", "single"):
                continue
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)

            text = a.get_text(" ", strip=True)
            text = re.sub(r"^\s*\d+\.\s*", "", text)
            items.append({
                "id": item_id,
                "slug": slug,
                "url_kind": url_kind,
                "detail_url": urljoin(BASE + "/", path.lstrip("/")),
                "listing_text": text,
            })
            continue

        link_text = a.get_text(" ", strip=True).lower()
        if "next page" in link_text or link_text == "next":
            if path.startswith("/"):
                next_url = urljoin(BASE + "/", path.lstrip("/"))

    return items, next_url


def walk_section_listings(section: dict, known_ids: set[str]) -> list[dict]:
    """
    Walk paginated listings for one section. Stops early on incremental runs
    once a page has all-known IDs (for STOP_AFTER_N_KNOWN_PAGES in a row).
    """
    deep = (DEEP_SCRAPE == "yes") or (DEEP_SCRAPE == "auto" and not known_ids)
    if deep:
        print(f"  [deep mode] walking ALL pages")
    else:
        print(f"  [incremental] will stop after {STOP_AFTER_N_KNOWN_PAGES} fully-known pages")

    all_entries: list[dict] = []
    seen_global: set[str] = set()
    consecutive_known_pages = 0
    page_url = section["url"]
    page_num = 1

    while page_url and page_num <= MAX_PAGES_PER_SECTION:
        print(f"  page {page_num}: {page_url}", flush=True)
        try:
            html = fetch(page_url)
        except Exception as e:
            print(f"    ! page fetch failed: {e}", file=sys.stderr)
            break

        entries, next_url = extract_listing(html, section["kind"])
        if not entries:
            print(f"    no entries, stopping pagination")
            break

        new_on_page = []
        for e in entries:
            if e["id"] in seen_global:
                continue
            seen_global.add(e["id"])
            new_on_page.append(e)

        if not new_on_page:
            print(f"    page repeated earlier content; stopping")
            break

        all_entries.extend(new_on_page)
        print(f"    +{len(new_on_page)} entries (total {len(all_entries)})")

        if not deep:
            all_known = all(e["id"] in known_ids for e in new_on_page)
            if all_known:
                consecutive_known_pages += 1
                print(f"    all {len(new_on_page)} already known "
                      f"({consecutive_known_pages}/{STOP_AFTER_N_KNOWN_PAGES})")
                if consecutive_known_pages >= STOP_AFTER_N_KNOWN_PAGES:
                    print(f"    -> stopping incremental walk")
                    break
            else:
                consecutive_known_pages = 0

        if not section["paginate"]:
            break
        if not next_url:
            print(f"    no next-page link; stopping")
            break

        page_url = next_url
        page_num += 1
        time.sleep(LISTING_DELAY_SECONDS)

    return all_entries


def _field_after(text: str, label: str) -> str:
    pat = re.compile(rf"\b{re.escape(label)}\s*:\s*(.+)", re.IGNORECASE)
    m = pat.search(text)
    if not m:
        return ""
    return m.group(1).splitlines()[0].strip()


def parse_listing_text(text: str, kind: str) -> tuple[str, str]:
    if not text or " - " not in text:
        return text.strip(), ""
    if kind == "album":
        artist, title = text.split(" - ", 1)
        return title.strip(), artist.strip()
    title, artist = text.rsplit(" - ", 1)
    return title.strip(), artist.strip()


def parse_detail(html: str, kind: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    cover = ""
    og = soup.find("meta", attrs={"property": "og:image"})
    if og and og.get("content"):
        cover = og["content"].strip()
    if not cover:
        img = soup.find("img", src=re.compile(r"/covers/"))
        if img and img.get("src"):
            cover = img["src"].strip()

    body_text = soup.get_text("\n", strip=True)
    desc_text = ""
    desc_div = soup.find("div", class_="description")
    if desc_div:
        desc_text = desc_div.get_text("\n", strip=True)
    else:
        m = re.search(
            r"Description:(.+?)(?:MP3 Song Download|Share On Whatsapp|Mp3 Download \[)",
            body_text, flags=re.DOTALL | re.IGNORECASE,
        )
        desc_text = m.group(1) if m else body_text

    music    = _field_after(desc_text, "Music")
    lyrics   = _field_after(desc_text, "Lyrics")
    label    = _field_after(desc_text, "Label")
    released = _field_after(desc_text, "Released")
    playtime = _field_after(desc_text, "Playtime")
    plays    = _field_after(desc_text, "Play")
    plays    = re.sub(r"[^\d,]", "", plays)

    song_line  = _field_after(desc_text, "Song")
    album_line = _field_after(desc_text, "Album")

    title = ""
    artist = ""
    if kind == "album":
        if album_line:
            title = album_line
    else:
        if song_line:
            if " - " in song_line:
                title, artist = song_line.split(" - ", 1)
                title, artist = title.strip(), artist.strip()
            else:
                title = song_line.strip()

    if not title:
        h1 = soup.find("h1")
        if h1:
            t = h1.get_text(" ", strip=True)
            t = re.sub(r"\s*MP3\s+(Song\s+)?Download.*$", "", t, flags=re.IGNORECASE).strip()
            title = t

    mp3 = {"stream": "", "kbps320": "", "kbps128": "", "kbps48": "",
           "zip320": "", "zip128": ""}
    audio = soup.find("audio")
    if audio:
        src = audio.find("source")
        if src and src.get("src"):
            mp3["stream"] = src["src"].strip()

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        low = href.lower()
        if low.endswith(".mp3"):
            if   "/320/" in low: mp3["kbps320"] = href
            elif "/128/" in low: mp3["kbps128"] = href
            elif "/48/"  in low: mp3["kbps48"]  = href
        elif low.endswith(".zip"):
            if   "/320/" in low: mp3["zip320"]  = href
            elif "/128/" in low: mp3["zip128"]  = href

    if not mp3["stream"]:
        mp3["stream"] = mp3["kbps128"] or mp3["kbps320"] or mp3["kbps48"]

    return {
        "title": title.strip(),
        "artist": artist.strip(),
        "music": music, "lyrics": lyrics, "label": label,
        "released": released, "playtime": playtime, "plays": plays,
        "cover": cover, "mp3": mp3, "kind": kind,
    }


def load_archive(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    archive: dict[str, dict] = {}
    for item in data.get("archive", []) or []:
        key = f"{item.get('kind')}:{item.get('id')}"
        archive[key] = item
    # Backfill from legacy sections[].items[] shape.
    for section in data.get("sections", []) or []:
        for item in section.get("items", []) or []:
            key = f"{item.get('kind')}:{item.get('id')}"
            if key not in archive:
                archive[key] = item
    return archive


def is_bad_cache(item: dict) -> bool:
    t = (item.get("title") or "").lower()
    return (
        not t
        or t.startswith("s latest music")
        or t.endswith("djjohal.com")
        or "latest music from" in t
    )


def _empty_detail(kind: str) -> dict:
    return {
        "title": "", "artist": "", "music": "", "lyrics": "",
        "label": "", "released": "", "playtime": "", "plays": "",
        "cover": "",
        "mp3": {"stream": "", "kbps320": "", "kbps128": "",
                "kbps48": "", "zip320": "", "zip128": ""},
        "kind": kind,
    }


def main() -> int:
    out_path = Path(__file__).resolve().parent.parent / "data" / "songs.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    archive = load_archive(out_path)
    print(f"[start] archive size: {len(archive)}  deep={DEEP_SCRAPE}")

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    detail_fetches = 0
    sections_out: list[dict] = []

    known_by_kind: dict[str, set[str]] = {"single": set(), "album": set()}
    for item in archive.values():
        k = item.get("kind")
        if k in known_by_kind:
            known_by_kind[k].add(item.get("id"))

    for section in SECTIONS:
        print(f"\n[section] {section['title']}")
        try:
            entries = walk_section_listings(section, known_by_kind[section["kind"]])
        except Exception as e:
            print(f"  ! listing walk failed: {e}", file=sys.stderr)
            entries = []
        print(f"  total listing entries: {len(entries)}")

        live_items: list[dict] = []

        for entry in entries:
            key = f"{section['kind']}:{entry['id']}"
            cached = archive.get(key)

            need_fetch = (not cached) or is_bad_cache(cached)

            if need_fetch and detail_fetches < MAX_DETAIL_FETCHES_PER_RUN:
                try:
                    print(f"    fetch: {entry['detail_url']}", flush=True)
                    dhtml = fetch(entry["detail_url"])
                    detail = parse_detail(dhtml, section["kind"])
                    detail_fetches += 1
                    time.sleep(DETAIL_DELAY_SECONDS)
                except Exception as e:
                    print(f"    ! detail fetch failed: {e}", file=sys.stderr)
                    detail = _empty_detail(section["kind"])
                detail["first_seen_at"] = (
                    cached.get("first_seen_at", now_iso) if cached else now_iso
                )
            elif cached:
                detail = {k: v for k, v in cached.items()
                          if k not in ("section_id", "rank", "last_seen_at")}
            else:
                detail = _empty_detail(section["kind"])
                detail["first_seen_at"] = now_iso

            lt_title, lt_artist = parse_listing_text(entry["listing_text"], section["kind"])
            if lt_title and lt_artist:
                detail["title"] = lt_title
                detail["artist"] = lt_artist
            else:
                if not detail.get("title"):
                    detail["title"] = lt_title or entry["listing_text"]
                if not detail.get("artist"):
                    detail["artist"] = lt_artist

            detail["id"] = entry["id"]
            detail["slug"] = entry["slug"]
            detail["kind"] = section["kind"]
            detail["url_kind"] = entry["url_kind"]
            detail["detail_url"] = entry["detail_url"]
            detail["last_seen_at"] = now_iso
            detail.setdefault("first_seen_at", now_iso)

            archive[key] = detail

            live = dict(detail)
            live["section_id"] = section["id"]
            if section["id"].startswith("top_"):
                live["rank"] = len(live_items) + 1
            live_items.append(live)

            if len(live_items) >= section["live_cap"]:
                break

        sections_out.append({
            "id": section["id"],
            "title": section["title"],
            "kind": section["kind"],
            "items": live_items,
        })

    archive_list = sorted(
        archive.values(),
        key=lambda x: (x.get("first_seen_at", ""), x.get("id", "")),
        reverse=True,
    )

    output = {
        "generated_at": now_iso,
        "source": BASE,
        "stats": {
            "archive_size": len(archive_list),
            "detail_fetches_this_run": detail_fetches,
            "deep_scrape": DEEP_SCRAPE,
        },
        "sections": sections_out,
        "archive": archive_list,
    }

    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    print(f"\n[done] wrote {out_path}")
    print(f"       archive: {len(archive_list)}  "
          f"section items: {sum(len(s['items']) for s in sections_out)}  "
          f"detail fetches: {detail_fetches}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
