#!/usr/bin/env python3
"""
DJJOhAL.Com Scraper
Scrapes 4 sections from djjohal.com:
  1. New Punjabi Single Songs
  2. New Punjabi Full Album/EP
  3. Top 50 Punjabi Single Songs
  4. Top 50 Punjabi Album Songs

For each track/album, also fetches the detail page to extract:
  music, lyrics, label, release date, playtime, mp3 URLs, cover image.

Outputs a single data/songs.json file consumed by the static site.
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, quote

import requests
from bs4 import BeautifulSoup

BASE = "https://www.djjohal.com"

SECTIONS = [
    {
        "id": "new_singles",
        "title": "New Punjabi Single Songs",
        "url": f"{BASE}/category.php?cat=Single%20Track",
        "kind": "single",
    },
    {
        "id": "new_albums",
        "title": "New Punjabi Full Album/EP",
        "url": f"{BASE}/category.php?cat=Punjabi",
        "kind": "album",
    },
    {
        "id": "top_singles",
        "title": "Top 50 Punjabi Single Songs",
        "url": f"{BASE}/topTracks.php?cat=Single%20Track",
        "kind": "single",
    },
    {
        "id": "top_albums",
        "title": "Top 50 Punjabi Album Songs",
        "url": f"{BASE}/topTracks.php?cat=Punjabi",
        "kind": "album",
    },
]

# Cap items per section to keep payload sane and scrape time reasonable.
MAX_ITEMS_PER_SECTION = 50
# Cap detail-page fetches per run to stay polite (existing cached details are reused).
MAX_DETAIL_FETCHES_PER_RUN = 80
# Delay between detail fetches.
DETAIL_DELAY_SECONDS = 0.4

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def fetch(url: str, timeout: int = 25) -> str:
    """GET a URL and return text, with retries."""
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            r.raise_for_status()
            return r.text
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def extract_listing(html: str, kind: str) -> list[dict]:
    """
    Pull track/album entries from a category or topTracks page.

    djjohal listing pages use links of the form:
      /single/{id}/{slug}.html       (singles)
      /album/{id}/{slug}.html        (albums/EPs)
    each wrapping an <img> with the cover.
    """
    soup = BeautifulSoup(html, "html.parser")

    if kind == "single":
        link_pattern = re.compile(r"^/single/(\d+)/([^/]+)\.html$")
    else:
        link_pattern = re.compile(r"^/album/(\d+)/([^/]+)\.html$")

    items: list[dict] = []
    seen_ids: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Normalize: some links may be absolute.
        if href.startswith(BASE):
            path = href[len(BASE):]
        else:
            path = href
        m = link_pattern.match(path)
        if not m:
            continue
        item_id, slug = m.group(1), m.group(2)
        if item_id in seen_ids:
            continue

        img = a.find("img")
        cover = img["src"] if img and img.has_attr("src") else ""
        alt = img.get("alt", "") if img else ""

        # Title guess from slug if alt is missing.
        title_guess = alt or slug.replace("-", " ").title()

        items.append({
            "id": item_id,
            "slug": slug,
            "kind": kind,
            "detail_url": urljoin(BASE + "/", path.lstrip("/")),
            "cover": cover,
            "title_hint": title_guess,
        })
        seen_ids.add(item_id)

        if len(items) >= MAX_ITEMS_PER_SECTION:
            break

    return items


def text_after_label(soup_text: str, label: str) -> str:
    """Find a 'Label: value' style line inside the description block."""
    pattern = re.compile(
        rf"{re.escape(label)}\s*:?\s*(.+)",
        re.IGNORECASE,
    )
    m = pattern.search(soup_text)
    if not m:
        return ""
    value = m.group(1).strip()
    # Cut at next newline.
    value = value.splitlines()[0].strip()
    # Strip trailing "Released" leftovers etc.
    return value


def parse_detail(html: str, kind: str) -> dict:
    """Pull description + download links from a /single/ or /album/ page."""
    soup = BeautifulSoup(html, "html.parser")

    # Title from <h1>.
    h1 = soup.find("h1")
    title = h1.get_text(strip=True) if h1 else ""
    # Clean trailing " MP3 Song Download" etc.
    title = re.sub(r"\s*MP3\s+(Song\s+)?Download.*$", "", title, flags=re.IGNORECASE).strip()

    # Cover.
    cover = ""
    og = soup.find("meta", attrs={"property": "og:image"})
    if og and og.get("content"):
        cover = og["content"]
    if not cover:
        img = soup.find("img", src=re.compile(r"/covers/"))
        if img:
            cover = img.get("src", "")

    # Description block.
    desc = soup.find("div", class_="description")
    desc_text = desc.get_text("\n", strip=True) if desc else ""

    artist = ""
    song = ""
    music = text_after_label(desc_text, "Music")
    lyrics = text_after_label(desc_text, "Lyrics")
    label = text_after_label(desc_text, "Label")
    released = text_after_label(desc_text, "Released")
    playtime = text_after_label(desc_text, "Playtime")
    plays = text_after_label(desc_text, "Play")

    # "Song: Jaane 2 - Jassi Sohal"
    song_line = text_after_label(desc_text, "Song")
    if song_line:
        if " - " in song_line:
            song, artist = [s.strip() for s in song_line.split(" - ", 1)]
        else:
            song = song_line

    # Album detail pages use "Album: ..." and a separate "Artist:" line.
    album_line = text_after_label(desc_text, "Album")
    if album_line and not song:
        song = album_line
    if not artist:
        artist = text_after_label(desc_text, "Artist") or text_after_label(desc_text, "Singer")

    # Strip stray junk from numeric fields.
    plays = re.sub(r"[^\d,]", "", plays)

    # Audio sources / mp3 download links.
    mp3 = {"stream": "", "kbps320": "", "kbps128": "", "kbps48": "", "zip320": "", "zip128": ""}

    audio = soup.find("audio")
    if audio:
        src = audio.find("source")
        if src and src.get("src"):
            mp3["stream"] = src["src"]

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.lower().endswith(".mp3") and ".zip" not in href.lower():
            continue
        low = href.lower()
        if "/320/" in low and href.endswith(".mp3"):
            mp3["kbps320"] = href
        elif "/128/" in low and href.endswith(".mp3"):
            mp3["kbps128"] = href
        elif "/48/" in low and href.endswith(".mp3"):
            mp3["kbps48"] = href
        elif "/320/" in low and href.endswith(".zip"):
            mp3["zip320"] = href
        elif "/128/" in low and href.endswith(".zip"):
            mp3["zip128"] = href

    # Prefer 128kbps for in-browser streaming if no <audio> source.
    if not mp3["stream"]:
        mp3["stream"] = mp3["kbps128"] or mp3["kbps320"] or mp3["kbps48"]

    # Fallback title.
    if not song and title:
        song = title

    return {
        "title": song or title,
        "artist": artist,
        "music": music,
        "lyrics": lyrics,
        "label": label,
        "released": released,
        "playtime": playtime,
        "plays": plays,
        "cover": cover,
        "mp3": mp3,
        "kind": kind,
    }


def load_previous(path: Path) -> dict:
    """Load previous run output, if any, so we can reuse detail-page data."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    cache: dict = {}
    for section in data.get("sections", []):
        for item in section.get("items", []):
            key = f"{item.get('kind')}:{item.get('id')}"
            cache[key] = item
    return cache


def main() -> int:
    out_path = Path(__file__).resolve().parent.parent / "data" / "songs.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    prev_cache = load_previous(out_path)

    sections_out: list[dict] = []
    detail_fetches = 0

    for section in SECTIONS:
        print(f"[section] {section['title']}  ->  {section['url']}", flush=True)
        try:
            html = fetch(section["url"])
        except Exception as e:
            print(f"  ! failed to fetch listing: {e}", file=sys.stderr)
            # Reuse previous section data if listing fetch fails.
            sections_out.append({
                "id": section["id"],
                "title": section["title"],
                "kind": section["kind"],
                "items": [
                    v for k, v in prev_cache.items()
                    if v.get("section_id") == section["id"]
                ][:MAX_ITEMS_PER_SECTION],
                "error": str(e),
            })
            continue

        listing = extract_listing(html, section["kind"])
        print(f"  found {len(listing)} listing entries", flush=True)

        items: list[dict] = []
        for entry in listing:
            cache_key = f"{section['kind']}:{entry['id']}"
            cached = prev_cache.get(cache_key)

            need_fetch = cached is None
            # Refresh details opportunistically until we hit the per-run budget.
            if cached and detail_fetches < MAX_DETAIL_FETCHES_PER_RUN // 4:
                need_fetch = False  # keep cache; below logic handles fresh fetches first

            if need_fetch and detail_fetches < MAX_DETAIL_FETCHES_PER_RUN:
                try:
                    print(f"    fetch detail: {entry['detail_url']}", flush=True)
                    dhtml = fetch(entry["detail_url"])
                    detail = parse_detail(dhtml, section["kind"])
                    detail_fetches += 1
                    time.sleep(DETAIL_DELAY_SECONDS)
                except Exception as e:
                    print(f"    ! detail fetch failed: {e}", file=sys.stderr)
                    detail = {
                        "title": entry["title_hint"],
                        "artist": "",
                        "music": "",
                        "lyrics": "",
                        "label": "",
                        "released": "",
                        "playtime": "",
                        "plays": "",
                        "cover": entry["cover"],
                        "mp3": {"stream": "", "kbps320": "", "kbps128": "",
                                "kbps48": "", "zip320": "", "zip128": ""},
                        "kind": section["kind"],
                    }
            elif cached:
                detail = {
                    "title": cached.get("title", entry["title_hint"]),
                    "artist": cached.get("artist", ""),
                    "music": cached.get("music", ""),
                    "lyrics": cached.get("lyrics", ""),
                    "label": cached.get("label", ""),
                    "released": cached.get("released", ""),
                    "playtime": cached.get("playtime", ""),
                    "plays": cached.get("plays", ""),
                    "cover": cached.get("cover", entry["cover"]),
                    "mp3": cached.get("mp3", {}),
                    "kind": section["kind"],
                }
            else:
                # Detail budget exhausted; fall back to listing-only data.
                detail = {
                    "title": entry["title_hint"],
                    "artist": "",
                    "music": "",
                    "lyrics": "",
                    "label": "",
                    "released": "",
                    "playtime": "",
                    "plays": "",
                    "cover": entry["cover"],
                    "mp3": {"stream": "", "kbps320": "", "kbps128": "",
                            "kbps48": "", "zip320": "", "zip128": ""},
                    "kind": section["kind"],
                }

            # Prefer the listing's cover if detail page missed it.
            if not detail.get("cover"):
                detail["cover"] = entry["cover"]

            items.append({
                "id": entry["id"],
                "slug": entry["slug"],
                "kind": section["kind"],
                "section_id": section["id"],
                "detail_url": entry["detail_url"],
                **detail,
            })

        sections_out.append({
            "id": section["id"],
            "title": section["title"],
            "kind": section["kind"],
            "items": items,
        })

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": BASE,
        "sections": sections_out,
    }

    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {out_path}  (sections: {len(sections_out)}, "
          f"items total: {sum(len(s['items']) for s in sections_out)}, "
          f"detail fetches this run: {detail_fetches})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
