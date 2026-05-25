#!/usr/bin/env python3
"""
Scraper v7 — SQLite-backed Punjabi music harvester.

Two complementary modes
-----------------------
  fast (every 4h) — Walks the first 50 pages of each paginated section, plus
                    the Top 50 chart. Fetches detail pages for any new items.
                    Designed to keep the homepage fresh in under 2 minutes.

  deep (every 6h, background) — Walks a sliding window of unseen page ranges.
                    Each invocation handles up to PAGES_PER_SESSION pages
                    (default 200). State is checkpointed in the DB so the next
                    session resumes from the next batch. After the full
                    catalogue is walked, deep mode short-circuits to a no-op
                    until reset.

Both write to the same SQLite store (data/library.db) and the same export
files (data/songs.json, data/search.json, data/items/*.json).

Album track lists
-----------------
Album detail pages are zip-only — there's no streamable audio. So when we
fetch an album page we ALSO capture the list of `/get/` track links it
contains. The site renders these as a playable track list when the album
sheet opens.

Entry points
------------
Run as:
  MODE=fast  python scraper/scrape.py
  MODE=deep  python scraper/scrape.py

Env vars
--------
  MODE                fast | deep                       (required)
  FAST_PAGES          pages per section in fast mode    (default 50)
  PAGES_PER_SESSION   pages per section in deep mode    (default 200)
  MAX_DETAIL_FETCHES  detail-page budget per run        (default 800)
  RESET_DEEP          'yes' to restart deep crawl       (default no)
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

# ===========================================================================
# Config
# ===========================================================================

SOURCE = "https://www.djjohal.com"

SECTIONS = [
    {
        "id": "new_singles",
        "title": "New Punjabi Single Songs",
        "url": f"{SOURCE}/category.php?cat=Single%20Track",
        "kind": "single",
        "paginate": True,
        "feed_cap": 100,
    },
    {
        "id": "new_albums",
        "title": "New Punjabi Full Album/EP",
        "url": f"{SOURCE}/category.php?cat=Punjabi",
        "kind": "album",
        "paginate": True,
        "feed_cap": 100,
    },
    {
        "id": "top_singles",
        "title": "Top 50 Single Songs",
        "url": f"{SOURCE}/topTracks.php?cat=Single%20Track",
        "kind": "single",
        "paginate": False,
        "feed_cap": 50,
    },
    {
        "id": "top_punjabi",
        "title": "Top 50 Album Songs",
        "url": f"{SOURCE}/topTracks.php?cat=Punjabi",
        "kind": "single",
        "paginate": False,
        "feed_cap": 50,
    },
]

# Paginated sections that the deep scraper walks. These are the ones with
# thousands of pages and need a sessioned backfill.
DEEP_SECTIONS = [s for s in SECTIONS if s["paginate"]]

MODE = os.environ.get("MODE", "fast").lower()

FAST_PAGES         = int(os.environ.get("FAST_PAGES", "50"))
PAGES_PER_SESSION  = int(os.environ.get("PAGES_PER_SESSION", "200"))
MAX_DETAIL_FETCHES = int(os.environ.get("MAX_DETAIL_FETCHES", "1500"))
RESET_DEEP         = os.environ.get("RESET_DEEP", "no").lower() == "yes"
DETAIL_WORKERS     = int(os.environ.get("DETAIL_WORKERS", "6"))   # concurrent HTTP fetches

DETAIL_DELAY_SECONDS  = 0.25
LISTING_DELAY_SECONDS = 0.30
REQUEST_TIMEOUT       = 25

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

DETAIL_PATH_RE = re.compile(r"^/(single|get|album)/(\d+)/([^/]+)\.html$")

ROOT      = Path(__file__).resolve().parent.parent
DATA_DIR  = ROOT / "data"
ITEMS_DIR = DATA_DIR / "items"
DB_PATH   = DATA_DIR / "library.db"


# ===========================================================================
# Schema
# ===========================================================================

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    kind            TEXT NOT NULL,
    id              TEXT NOT NULL,
    slug            TEXT NOT NULL,
    url_kind        TEXT NOT NULL,
    detail_url      TEXT NOT NULL,
    title           TEXT,
    artist          TEXT,
    music           TEXT,
    lyrics          TEXT,
    label           TEXT,
    released        TEXT,
    playtime        TEXT,
    plays           TEXT,
    cover           TEXT,
    stream_url      TEXT,
    mp3_320         TEXT,
    mp3_128         TEXT,
    mp3_48          TEXT,
    zip_320         TEXT,
    zip_128         TEXT,
    album_tracks    TEXT,         -- JSON array of {id, slug, title} for albums
    has_detail      INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    detail_fetched_at TEXT,
    listing_text    TEXT,
    discovery_rank  INTEGER,      -- legacy, kept for back-compat
    priority_queue  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_items_kind_seen   ON items(kind, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_has_detail  ON items(has_detail, kind);
-- idx_items_discovery is created in _ensure_columns after the column exists.

CREATE TABLE IF NOT EXISTS section_items (
    section_id  TEXT NOT NULL,
    position    INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    PRIMARY KEY (section_id, position)
);

-- Deep-scraper bookkeeping: how far have we walked each section?
CREATE TABLE IF NOT EXISTS crawl_state (
    section_id      TEXT PRIMARY KEY,
    next_page       INTEGER NOT NULL DEFAULT 1,
    last_session_at TEXT,
    pages_walked    INTEGER NOT NULL DEFAULT 0,
    is_complete     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

def db_open() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fresh = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _ensure_columns(conn)
    if fresh:
        _migrate_legacy_songs_json(conn)
    return conn


def _ensure_columns(conn):
    """Add any columns that may be missing on an older DB.

    SQLite's CREATE TABLE IF NOT EXISTS does NOT add columns to a table
    that already exists. So when we upgrade from an older schema, we need
    to ALTER TABLE for each new column.
    """
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
    additions = [
        ("album_tracks",   "TEXT"),
        ("discovery_rank", "INTEGER"),   # legacy, kept for back-compat
        ("priority_queue", "INTEGER NOT NULL DEFAULT 0"),
        # Resolved YouTube watch URL for this item, populated lazily during
        # detail fetch for homepage-priority items. Lets the site link the
        # YouTube button directly to the song's video instead of a search
        # results page. Empty string when we couldn't resolve.
        ("youtube_url",    "TEXT NOT NULL DEFAULT ''"),
    ]
    for col, col_type in additions:
        if col not in existing:
            print(f"[migrate] adding items.{col} {col_type}")
            conn.execute(f"ALTER TABLE items ADD COLUMN {col} {col_type}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_items_discovery "
        "ON items(kind, discovery_rank DESC)"
    )
    # Back-fill discovery_rank for existing rows so the homepage ordering
    # works on the first run after the upgrade. We use the rowid (insertion
    # order) as a proxy — rows inserted earliest get lower ranks, latest
    # get higher ranks, which matches "newest first" because the scraper
    # walks djjohal page 1 (newest) first.
    needs_backfill = conn.execute(
        "SELECT COUNT(*) n FROM items WHERE discovery_rank IS NULL"
    ).fetchone()["n"]
    if needs_backfill:
        print(f"[migrate] back-filling discovery_rank for {needs_backfill} rows")
        # Use rowid as the seed: lower rowid = earlier insertion = newer on djjohal page 1.
        # Invert so higher discovery_rank = newer.
        max_rowid = conn.execute("SELECT MAX(rowid) m FROM items").fetchone()["m"] or 0
        conn.execute(
            "UPDATE items SET discovery_rank = ? - rowid WHERE discovery_rank IS NULL",
            (max_rowid + 1,),
        )
    # Always sync the counter to the current max, so new inserts continue
    # the sequence without gaps or collisions.
    _seed_max_rank_from_table(conn)

    # ---- v7.12 healing: detect title/artist that are stored backwards.
    #
    # Context: djjohal's listing_text field is inconsistent (sometimes
    # "Artist - Title", sometimes "Title - Artist"), so listing-based
    # detection is unreliable. But the SLUG (URL component) is
    # consistently "artist-title" lowercased with hyphens. We use the
    # slug to determine which is which:
    #   1. Normalize stored title and artist to slug form.
    #   2. Check if slug STARTS with the title's normalized form. If yes,
    #      then the slug's first half is the current title — which means
    #      the slug-order is "title-artist", contradicting djjohal's
    #      convention of "artist-title". The stored values are swapped:
    #      heal them.
    #   3. Otherwise the assignment is correct (slug starts with artist).
    _heal_swapped_title_artist(conn)

    conn.commit()


def _normalize_slug(s: str) -> str:
    """Approximate djjohal's slug normalization."""
    if not s:
        return ""
    s = s.lower().strip()
    # Strip parentheticals like "(feat. ...)" since djjohal often drops them.
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    # Non-alphanumerics → hyphens, collapse runs, trim ends.
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def _heal_swapped_title_artist(conn):
    """For singles, use slug + id to detect rows where title and artist
    are stored backwards (the v7.11 parser bug), and swap them.

    djjohal's slug convention varies by era:
      - id ≥ 600000: slug = 'artist-title'
      - id <  600000: slug = 'title-artist'
    The expected orientation determines whether the current assignment
    is correct or swapped.
    """
    rows = conn.execute(
        "SELECT kind, id, title, artist, slug FROM items "
        "WHERE kind='single' AND slug != '' "
        "  AND title != '' AND artist != ''"
    ).fetchall()
    if not rows:
        return

    to_swap: list[tuple[str, str]] = []
    for r in rows:
        slug = (r["slug"] or "").lower()
        t_norm = _normalize_slug(r["title"])
        a_norm = _normalize_slug(r["artist"])
        if not t_norm or not a_norm:
            continue
        if t_norm not in slug or a_norm not in slug:
            continue
        title_pos  = slug.find(t_norm)
        artist_pos = slug.find(a_norm)

        orient = _slug_orientation(r["id"])
        if orient == "artist-title":
            # Slug starts with artist. Current is correct iff artist_pos < title_pos.
            correct = artist_pos < title_pos
        else:
            # Slug starts with title. Current is correct iff title_pos < artist_pos.
            correct = title_pos < artist_pos

        if not correct:
            to_swap.append((r["kind"], r["id"]))

    if not to_swap:
        return

    print(f"[migrate] healing {len(to_swap)} singles with swapped title/artist")
    conn.executemany(
        "UPDATE items SET title = artist, artist = title "
        "WHERE kind=? AND id=?",
        to_swap,
    )


def _migrate_legacy_songs_json(conn):
    legacy = DATA_DIR / "songs.json"
    if not legacy.exists():
        return
    try:
        data = json.loads(legacy.read_text(encoding="utf-8"))
    except Exception:
        return
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    imported = 0
    seen = set()
    pools = [data.get("items", []) or [], data.get("archive", []) or []]
    for s in (data.get("sections", []) or []):
        pools.append(s.get("items", []) or [])

    for pool in pools:
        for item in pool:
            kind = item.get("kind")
            iid  = item.get("id")
            if not kind or not iid:
                continue
            key = f"{kind}:{iid}"
            if key in seen:
                continue
            seen.add(key)
            mp3 = item.get("mp3", {}) or {}
            has_detail = 1 if (item.get("cover") and item.get("title")) else 0
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO items (kind, id, slug, url_kind, detail_url, "
                    "title, artist, music, lyrics, label, released, playtime, plays, "
                    "cover, stream_url, mp3_320, mp3_128, mp3_48, zip_320, zip_128, "
                    "has_detail, first_seen_at, last_seen_at, detail_fetched_at, listing_text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        kind, iid,
                        item.get("slug", ""), item.get("url_kind", "get"),
                        item.get("detail_url", ""),
                        item.get("title", ""), item.get("artist", ""),
                        item.get("music", ""), item.get("lyrics", ""), item.get("label", ""),
                        item.get("released", ""), item.get("playtime", ""), item.get("plays", ""),
                        item.get("cover", ""),
                        mp3.get("stream", ""),
                        mp3.get("kbps320", ""), mp3.get("kbps128", ""), mp3.get("kbps48", ""),
                        mp3.get("zip320", ""), mp3.get("zip128", ""),
                        has_detail,
                        item.get("first_seen_at", now_iso),
                        item.get("last_seen_at", now_iso),
                        now_iso if has_detail else None,
                        "",
                    ),
                )
                imported += 1
            except Exception:
                pass
    conn.commit()
    if imported:
        print(f"[migrate] imported {imported} legacy items from songs.json")


def db_counts(conn) -> tuple[int, int]:
    s = conn.execute("SELECT COUNT(*) n FROM items WHERE kind='single'").fetchone()["n"]
    a = conn.execute("SELECT COUNT(*) n FROM items WHERE kind='album'").fetchone()["n"]
    return s, a


# ===========================================================================
# HTTP
# ===========================================================================

def fetch(url: str) -> str:
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return r.text
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


# Match a YouTube videoId in the search results HTML. The first occurrence
# is the top-ranked search result. Pattern looks for the JSON field that
# YouTube embeds in ytInitialData: "videoId":"XXXXXXXXXXX".
_YT_VIDEO_ID_RE = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')


def resolve_youtube_url(title: str, artist: str, *, is_album: bool = False) -> str:
    """Search YouTube for "{artist} {title}" and return the first video's URL.

    Returns "" on any failure. The scraper continues without the YT URL —
    the site falls back to a search-results link in that case.

    Why this exists: users want the YouTube button to take them straight to
    the song's video, not a search results page. We resolve it once at
    harvest time and cache it in the DB.

    Costs ~500-1000ms per call, so we only invoke this for items in the
    homepage feed (top 100 by ID per kind + the two Top 50 charts ≈ 300
    items). Re-resolves on each detail fetch even if cached — YouTube
    sometimes removes videos, and we want to keep the link valid.
    """
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title:
        return ""

    parts = [artist, title]
    if is_album:
        parts.append("full album")
    query = " ".join(p for p in parts if p)
    url = f"https://www.youtube.com/results?search_query={requests.utils.quote(query)}"

    try:
        r = requests.get(url, headers={
            **HEADERS,
            # YouTube serves different HTML to different UA strings. The
            # desktop UA gives us ytInitialData embedded in the page, which
            # is what our regex matches against.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }, timeout=15)
        if r.status_code != 200:
            return ""
        m = _YT_VIDEO_ID_RE.search(r.text)
        if not m:
            return ""
        return f"https://www.youtube.com/watch?v={m.group(1)}"
    except Exception:
        return ""


def build_page_url(section_url: str, page: int) -> str:
    """djjohal pagination: append &page=N (page=1 is the bare URL)."""
    if page <= 1:
        return section_url
    sep = "&" if "?" in section_url else "?"
    return f"{section_url}{sep}page={page}"


# ===========================================================================
# Parsing
# ===========================================================================

def extract_listing(html: str, expected_kind: str) -> tuple[list[dict], str | None]:
    soup = BeautifulSoup(html, "html.parser")
    items: list[dict] = []
    seen_ids: set[str] = set()
    next_url: str | None = None

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("http"):
            if href.startswith(SOURCE):
                path = href[len(SOURCE):]
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
                "id": item_id, "slug": slug, "url_kind": url_kind,
                "detail_url": urljoin(SOURCE + "/", path.lstrip("/")),
                "listing_text": text,
            })
            continue

        link_text = a.get_text(" ", strip=True).lower()
        if "next page" in link_text or link_text == "next":
            if path.startswith("/"):
                next_url = urljoin(SOURCE + "/", path.lstrip("/"))

    return items, next_url


def _field_after(text: str, label: str) -> str:
    pat = re.compile(rf"\b{re.escape(label)}\s*:\s*(.+)", re.IGNORECASE)
    m = pat.search(text)
    return m.group(1).splitlines()[0].strip() if m else ""


def _slug_orientation(item_id: str) -> str:
    """Determine whether djjohal's slug for this item is 'artist-title' or
    'title-artist'. Their convention changed around id=600000:
      - newer items (id ≥ 600000): slug = 'artist-title'
      - older items: slug = 'title-artist'
    """
    try:
        n = int(item_id)
    except (ValueError, TypeError):
        return "title-artist"  # safer default for legacy
    return "artist-title" if n >= 600000 else "title-artist"


def parse_listing_text(text: str, kind: str, slug: str = "", item_id: str = "") -> tuple[str, str]:
    """Split djjohal listing text into (title, artist).

    listing_text and song-line formats are inconsistent across djjohal's
    catalog. The slug is the reliable signal, BUT djjohal's slug
    convention also changed:
      - new items: 'artist-title'
      - old items: 'title-artist'

    When we have both a slug and an item_id, we use the id to pick the
    expected orientation, then verify against the slug. Falls back to
    "Title - Artist" reading when we can't determine.
    """
    if not text or " - " not in text:
        return text.strip(), ""
    left, right = [s.strip() for s in text.split(" - ", 1)]

    if slug and item_id:
        slug_lower = slug.lower()
        left_norm  = _normalize_slug(left)
        right_norm = _normalize_slug(right)
        if left_norm and right_norm:
            left_pos  = slug_lower.find(left_norm)
            right_pos = slug_lower.find(right_norm)
            if left_pos >= 0 and right_pos >= 0:
                orient = _slug_orientation(item_id)
                if orient == "artist-title":
                    # First in slug = artist
                    if left_pos < right_pos:
                        return right, left  # left=artist, right=title
                    else:
                        return left, right  # right=artist, left=title
                else:  # title-artist
                    if left_pos < right_pos:
                        return left, right  # left=title, right=artist
                    else:
                        return right, left  # right=title, left=artist

    # No slug or slug doesn't help — default to "Title - Artist".
    return left, right


def extract_album_tracks(html: str) -> list[dict]:
    """From an album detail page, extract the list of child tracks.

    Each track entry: {id, slug, title}
    """
    soup = BeautifulSoup(html, "html.parser")
    tracks: list[dict] = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Album pages reference tracks as /get/{id}/{slug}.html
        if not href:
            continue
        path = href if not href.startswith("http") else href[len(SOURCE):] if href.startswith(SOURCE) else ""
        if not path.startswith("/"):
            continue
        m = re.match(r"^/get/(\d+)/([^/?]+)\.html", path.split("?")[0])
        if not m:
            continue
        tid, tslug = m.group(1), m.group(2)
        if tid in seen:
            continue
        seen.add(tid)
        # Title: prefer the link's title attribute or its text
        title = a.get("title") or a.get_text(" ", strip=True) or tslug.replace("-", " ")
        # Strip any trailing " - Artist" tail to get just the track name
        if " - " in title:
            title = title.split(" - ")[0].strip()
        tracks.append({"id": tid, "slug": tslug, "title": title})
    return tracks


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
    plays    = re.sub(r"[^\d,]", "", _field_after(desc_text, "Play"))

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
                # The Song: line is inconsistent across djjohal pages
                # (sometimes "Title - Artist", sometimes "Artist - Title").
                # Pick the more common reading here; the caller in
                # _process_detail_result verifies orientation against
                # the slug and swaps if needed.
                title, artist = [s.strip() for s in song_line.split(" - ", 1)]
            else:
                title = song_line.strip()

    if not title:
        h1 = soup.find("h1")
        if h1:
            t = h1.get_text(" ", strip=True)
            t = re.sub(r"\s*MP3\s+(Song\s+)?Download.*$", "", t, flags=re.IGNORECASE).strip()
            title = t

    stream = ""
    mp3_320 = mp3_128 = mp3_48 = zip_320 = zip_128 = ""

    audio = soup.find("audio")
    if audio:
        src = audio.find("source")
        if src and src.get("src"):
            stream = src["src"].strip()

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        low = href.lower()
        if low.endswith(".mp3"):
            if   "/320/" in low: mp3_320 = href
            elif "/128/" in low: mp3_128 = href
            elif "/48/"  in low: mp3_48  = href
        elif low.endswith(".zip"):
            if   "/320/" in low: zip_320 = href
            elif "/128/" in low: zip_128 = href

    if not stream:
        stream = mp3_128 or mp3_320 or mp3_48

    album_tracks: list[dict] = []
    if kind == "album":
        album_tracks = extract_album_tracks(html)

    return {
        "title": title.strip(), "artist": artist.strip(),
        "music": music, "lyrics": lyrics, "label": label,
        "released": released, "playtime": playtime, "plays": plays,
        "cover": cover, "stream_url": stream,
        "mp3_320": mp3_320, "mp3_128": mp3_128, "mp3_48": mp3_48,
        "zip_320": zip_320, "zip_128": zip_128,
        "album_tracks": album_tracks,
    }


# ===========================================================================
# DB writes
# ===========================================================================

def _next_discovery_rank(conn) -> int:
    """Atomic counter for discovery_rank. Higher = newer."""
    row = conn.execute("SELECT value FROM meta WHERE key='max_rank'").fetchone()
    cur = int(row["value"]) if row else 0
    nxt = cur + 1
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('max_rank', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(nxt),),
    )
    return nxt


def _seed_max_rank_from_table(conn):
    """Initialize the max_rank counter from whatever is already in items."""
    row = conn.execute(
        "SELECT COALESCE(MAX(discovery_rank), 0) m FROM items"
    ).fetchone()
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('max_rank', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(row["m"]),),
    )


def upsert_listing_entry(conn, entry: dict, kind: str, now_iso: str) -> bool:
    """Insert if new. Returns True if newly inserted."""
    if conn.execute(
        "SELECT 1 FROM items WHERE kind=? AND id=?", (kind, entry["id"]),
    ).fetchone():
        conn.execute(
            "UPDATE items SET last_seen_at=?, listing_text=? WHERE kind=? AND id=?",
            (now_iso, entry["listing_text"], kind, entry["id"]),
        )
        return False
    lt_title, lt_artist = parse_listing_text(entry["listing_text"], kind, entry.get("slug", ""), entry.get("id", ""))
    rank = _next_discovery_rank(conn)
    conn.execute(
        "INSERT INTO items (kind, id, slug, url_kind, detail_url, title, artist, "
        "has_detail, first_seen_at, last_seen_at, listing_text, discovery_rank) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        (kind, entry["id"], entry["slug"], entry["url_kind"], entry["detail_url"],
         lt_title, lt_artist, now_iso, now_iso, entry["listing_text"], rank),
    )
    return True


# ===========================================================================
# Walkers
# ===========================================================================

def walk_pages(conn, section: dict, page_start: int, page_count: int,
               now_iso: str) -> tuple[int, int, bool]:
    """
    Walk `page_count` pages of `section` starting from page `page_start`.
    Returns (pages_actually_walked, new_items, hit_end).
    hit_end == True if djjohal returned no entries (we've reached the catalogue end).
    """
    pages_walked = 0
    new_items = 0
    hit_end = False
    seen_in_this_run: set[str] = set()

    for p in range(page_start, page_start + page_count):
        url = build_page_url(section["url"], p)
        if p == page_start or p % 25 == 0:
            print(f"  page {p}: {url}", flush=True)
        try:
            html = fetch(url)
        except Exception as e:
            print(f"    ! fetch failed for page {p}: {e}", file=sys.stderr)
            break

        entries, _ = extract_listing(html, section["kind"])
        pages_walked += 1

        if not entries:
            print(f"    page {p}: empty -> reached end of catalogue")
            hit_end = True
            break

        new_on_page = []
        for e in entries:
            if e["id"] in seen_in_this_run:
                continue
            seen_in_this_run.add(e["id"])
            new_on_page.append(e)

        if not new_on_page:
            print(f"    page {p}: only repeats; stopping")
            break

        page_new = 0
        for e in new_on_page:
            if upsert_listing_entry(conn, e, section["kind"], now_iso):
                page_new += 1
        new_items += page_new
        if page_new and (p == page_start or p % 25 == 0):
            print(f"    page {p}: +{page_new} new (run total: {new_items})")

        time.sleep(LISTING_DELAY_SECONDS)

    conn.commit()
    return pages_walked, new_items, hit_end


def capture_top_chart(conn, section: dict, now_iso: str):
    """Refresh section_items table for the Top 50 chart."""
    try:
        html = fetch(section["url"])
    except Exception as e:
        print(f"  ! chart fetch failed: {e}", file=sys.stderr)
        return
    entries, _ = extract_listing(html, section["kind"])
    conn.execute("DELETE FROM section_items WHERE section_id=?", (section["id"],))
    for pos, e in enumerate(entries[:section["feed_cap"]]):
        upsert_listing_entry(conn, e, section["kind"], now_iso)
        conn.execute(
            "INSERT INTO section_items(section_id, position, kind, item_id) "
            "VALUES (?, ?, ?, ?)",
            (section["id"], pos, section["kind"], e["id"]),
        )
    conn.commit()


# ===========================================================================
# Detail-page fetching (budgeted, priority queue)
# ===========================================================================

def _iso_timestamp(s: str | None) -> float:
    if not s: return 0.0
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _process_detail_result(conn, row, html, kind, now_iso):
    """Parse a fetched detail page and write the result to the DB.

    Returns a list of (kind, id) tuples for any album child tracks queued.
    Must be called from the main thread — sqlite3 connections aren't
    thread-safe.
    """
    d = parse_detail(html, kind)

    slug = row["slug"] or ""
    lt_title, lt_artist = parse_listing_text(row["listing_text"] or "", kind, slug, row["id"])
    title  = d["title"]  or row["title"]  or lt_title  or ""
    artist = d["artist"] or row["artist"] or lt_artist or ""
    if lt_title and lt_artist:
        title, artist = lt_title, lt_artist

    # Slug-verify orientation for singles. djjohal's Song-line and listing
    # text are both inconsistent across the catalog. The slug is reliable
    # when combined with the id-based orientation (new ids = 'artist-title',
    # old ids = 'title-artist').
    if kind == "single" and slug and title and artist:
        slug_lower = slug.lower()
        t_norm = _normalize_slug(title)
        a_norm = _normalize_slug(artist)
        if t_norm and a_norm and t_norm in slug_lower and a_norm in slug_lower:
            t_pos = slug_lower.find(t_norm)
            a_pos = slug_lower.find(a_norm)
            orient = _slug_orientation(row["id"])
            if orient == "artist-title":
                correct = a_pos < t_pos
            else:
                correct = t_pos < a_pos
            if not correct:
                title, artist = artist, title

    album_tracks_json = json.dumps(d["album_tracks"], ensure_ascii=False) if d["album_tracks"] else ""

    conn.execute(
        "UPDATE items SET "
        "title=?, artist=?, music=?, lyrics=?, label=?, released=?, "
        "playtime=?, plays=?, cover=?, "
        "stream_url=?, mp3_320=?, mp3_128=?, mp3_48=?, zip_320=?, zip_128=?, "
        "album_tracks=?, "
        "has_detail=1, priority_queue=0, detail_fetched_at=?, last_seen_at=? "
        "WHERE kind=? AND id=?",
        (
            title, artist, d["music"], d["lyrics"], d["label"], d["released"],
            d["playtime"], d["plays"], d["cover"],
            d["stream_url"], d["mp3_320"], d["mp3_128"], d["mp3_48"],
            d["zip_320"], d["zip_128"],
            album_tracks_json,
            now_iso, now_iso,
            kind, row["id"],
        ),
    )

    queued: list[tuple[str, str]] = []
    if kind == "album" and d["album_tracks"]:
        for t in d["album_tracks"]:
            track_url = f"{SOURCE}/get/{t['id']}/{t['slug']}.html"
            upsert_listing_entry(conn, {
                "id": t["id"], "slug": t["slug"], "url_kind": "get",
                "detail_url": track_url,
                "listing_text": f"{t['title']} - {artist}" if artist else t["title"],
            }, "single", now_iso)
            conn.execute(
                "UPDATE items SET priority_queue=1 "
                "WHERE kind='single' AND id=? AND has_detail=0",
                (t["id"],),
            )
            queued.append(("single", t["id"]))
    return title, queued


def _concurrent_fetch_batch(rows, budget_remaining, label, conn, now_iso, workers):
    """Run a batch of detail-page fetches in parallel.

    HTTP fetches happen in worker threads; HTML parsing + DB writes happen on
    the main thread (sqlite isn't thread-safe across connections, and the
    parser is fine on the main thread). Returns (fetched_count, newly_queued).
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    rows = rows[:budget_remaining]  # cap upfront
    if not rows:
        return 0, []

    fetched = 0
    newly_queued: list[tuple[str, str]] = []
    failures = 0

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_row = {pool.submit(fetch, row["detail_url"]): row for row in rows}
        for fut in as_completed(future_to_row):
            row = future_to_row[fut]
            try:
                html = fut.result()
                title, queued = _process_detail_result(conn, row, html, row["kind"], now_iso)
                newly_queued.extend(queued)
                fetched += 1
                if fetched % 50 == 0:
                    conn.commit()
                    print(f"  [{label}] {fetched}/{len(rows)}  last: {row['kind']}:{row['id']}  {title[:50]}",
                          flush=True)
            except Exception as e:
                failures += 1
                print(f"  ! detail failed {row['kind']}:{row['id']}: {e}", file=sys.stderr)

    conn.commit()
    if failures:
        print(f"  [{label}] {failures} failures (will retry next run)")
    return fetched, newly_queued


def fetch_details_budgeted(conn, budget: int, now_iso: str) -> int:
    """Fetch detail pages for items lacking them, up to `budget`.

    Priority:
      1. Items in the live homepage feeds (top 100 by ID per kind).
      2. Album child tracks queued during this run (so albums "just work"
         after a single scrape run instead of needing multiple passes).
      3. Everything else, newest first by item ID.

    Fetches are parallelized via a thread pool (default 8 workers). This is
    far below what djjohal can handle and an order of magnitude faster than
    sequential.
    """
    priority = set()
    for r in conn.execute("SELECT kind, item_id FROM section_items"):
        priority.add((r["kind"], r["item_id"]))
    for kind in ("single", "album"):
        for r in conn.execute(
            "SELECT kind, id FROM items WHERE kind=? "
            "ORDER BY CAST(id AS INTEGER) DESC LIMIT 100",
            (kind,),
        ):
            priority.add((r["kind"], r["id"]))
    for r in conn.execute(
        "SELECT kind, id FROM items WHERE has_detail=0 AND priority_queue=1"
    ):
        priority.add((r["kind"], r["id"]))

    rows = conn.execute(
        "SELECT * FROM items WHERE has_detail=0 "
        "ORDER BY CAST(id AS INTEGER) DESC"
    ).fetchall()
    rows = sorted(
        rows,
        key=lambda r: (0 if (r["kind"], r["id"]) in priority else 1,
                       -int(r["id"]) if r["id"].isdigit() else 0)
    )

    print(f"\n[detail] {len(rows)} items pending. budget={budget} workers={DETAIL_WORKERS}")
    fetched, newly_queued = _concurrent_fetch_batch(
        rows, budget, "main", conn, now_iso, DETAIL_WORKERS
    )

    # Second sub-pass: album child tracks queued during pass 1.
    if newly_queued and fetched < budget:
        ids = list({iid for _, iid in newly_queued})
        placeholders = ",".join("?" for _ in ids)
        child_rows = conn.execute(
            f"SELECT * FROM items WHERE kind='single' AND has_detail=0 AND id IN ({placeholders})",
            ids,
        ).fetchall()
        if child_rows:
            print(f"\n[detail/children] {len(child_rows)} album-track details "
                  f"(remaining budget: {budget - fetched})")
            ch_fetched, _ = _concurrent_fetch_batch(
                child_rows, budget - fetched, "children", conn, now_iso, DETAIL_WORKERS
            )
            fetched += ch_fetched

    print(f"[detail] done. fetched {fetched} pages this run.")

    # ---- YouTube URL resolution phase --------------------------------------
    # For homepage-priority items that have detail but no YouTube URL yet,
    # search YouTube and store the top result. This makes the YouTube
    # button on the site link directly to the song's video instead of a
    # search results page.
    #
    # Budget intentionally small: this is the homepage feed only (top 100
    # per kind by ID + the two Top 50 charts ≈ ~300 items total). We don't
    # do this for every item in the catalog — it would take too long and
    # YouTube might rate-limit a GH Actions IP.
    yt_resolved = _resolve_youtube_for_priority(conn, priority, now_iso)
    if yt_resolved:
        print(f"[youtube] resolved {yt_resolved} watch URLs")

    return fetched


def _resolve_youtube_for_priority(conn, priority_set, now_iso) -> int:
    """Resolve YouTube watch URLs for priority items that lack one.

    Returns the number newly resolved.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not priority_set:
        return 0
    # Walk the priority set and pick rows that have detail but no youtube_url.
    rows = []
    for (kind, item_id) in priority_set:
        r = conn.execute(
            "SELECT kind, id, title, artist, youtube_url, has_detail "
            "FROM items WHERE kind=? AND id=?",
            (kind, item_id),
        ).fetchone()
        if r and r["has_detail"] and not (r["youtube_url"] or "").strip() and (r["title"] or "").strip():
            rows.append(r)
    if not rows:
        return 0

    print(f"\n[youtube] resolving watch URLs for {len(rows)} priority items "
          f"(workers={DETAIL_WORKERS})")

    resolved_count = 0
    # Use fewer workers than the djjohal pool — YouTube is more rate-limit
    # sensitive than djjohal.
    yt_workers = max(1, min(DETAIL_WORKERS, 4))
    with ThreadPoolExecutor(max_workers=yt_workers) as pool:
        future_to_row = {
            pool.submit(
                resolve_youtube_url,
                r["title"], r["artist"],
                is_album=(r["kind"] == "album"),
            ): r
            for r in rows
        }
        for fut in as_completed(future_to_row):
            r = future_to_row[fut]
            try:
                yt_url = fut.result() or ""
            except Exception:
                yt_url = ""
            # Always update — even an empty string acts as a "we tried, give up"
            # marker for now. Next run can retry by clearing this field.
            if yt_url:
                conn.execute(
                    "UPDATE items SET youtube_url=? WHERE kind=? AND id=?",
                    (yt_url, r["kind"], r["id"]),
                )
                resolved_count += 1
                if resolved_count % 25 == 0:
                    conn.commit()
                    print(f"  [youtube] {resolved_count}/{len(rows)}")
    conn.commit()
    return resolved_count


# ===========================================================================
# Exporters
# ===========================================================================

def row_to_item_dict(row: sqlite3.Row, slim: bool = False) -> dict:
    base = {
        "id": row["id"], "kind": row["kind"],
        "title": row["title"] or "", "artist": row["artist"] or "",
    }
    if slim:
        return base
    try:
        album_tracks = json.loads(row["album_tracks"]) if row["album_tracks"] else []
    except Exception:
        album_tracks = []
    base.update({
        "music": row["music"] or "", "lyrics": row["lyrics"] or "",
        "label": row["label"] or "", "released": row["released"] or "",
        "playtime": row["playtime"] or "", "plays": row["plays"] or "",
        "cover": row["cover"] or "",
        "detail_url": row["detail_url"],
        "slug": row["slug"], "url_kind": row["url_kind"],
        "mp3": {
            "stream":  row["stream_url"] or "",
            "kbps320": row["mp3_320"]   or "",
            "kbps128": row["mp3_128"]   or "",
            "kbps48":  row["mp3_48"]    or "",
            "zip320":  row["zip_320"]   or "",
            "zip128":  row["zip_128"]   or "",
        },
        "album_tracks": album_tracks,
        # Pre-resolved YouTube watch URL when we have one; empty string
        # means "we don't know yet — use a search fallback in the site".
        "youtube_url": _safe_col(row, "youtube_url"),
        "first_seen_at": row["first_seen_at"],
        "last_seen_at":  row["last_seen_at"],
    })
    return base


def _safe_col(row, name):
    """sqlite3.Row throws KeyError if column doesn't exist. Defensive get
    for newly-added columns when reading from older row instances."""
    try:
        return (row[name] or "") if name in row.keys() else ""
    except (IndexError, KeyError):
        return ""


def export_homepage(conn, now_iso: str):
    sections_out = []
    for section in SECTIONS:
        if section["paginate"]:
            # Newest-first by djjohal's own item ID. Higher numeric ID = newer
            # release on djjohal. This matches what their site shows on page 1
            # and is stable across runs regardless of discovery order.
            rows = conn.execute(
                "SELECT * FROM items WHERE kind=? "
                "ORDER BY CAST(id AS INTEGER) DESC LIMIT ?",
                (section["kind"], section["feed_cap"]),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT i.* FROM items i "
                "JOIN section_items si ON si.kind=i.kind AND si.item_id=i.id "
                "WHERE si.section_id=? ORDER BY si.position",
                (section["id"],),
            ).fetchall()
        items = []
        for idx, r in enumerate(rows):
            d = row_to_item_dict(r, slim=False)
            d["section_id"] = section["id"]
            if not section["paginate"]:
                d["rank"] = idx + 1
            items.append(d)

        # Total available for this section's kind (for UI's "showing X of Y").
        total = conn.execute(
            "SELECT COUNT(*) n FROM items WHERE kind=?", (section["kind"],)
        ).fetchone()["n"] if section["paginate"] else len(items)

        sections_out.append({
            "id": section["id"], "title": section["title"],
            "kind": section["kind"], "items": items,
            "total_available": total,
        })

    singles, albums = db_counts(conn)
    crawl = {}
    for r in conn.execute("SELECT * FROM crawl_state"):
        crawl[r["section_id"]] = {
            "next_page": r["next_page"],
            "pages_walked": r["pages_walked"],
            "is_complete": bool(r["is_complete"]),
            "last_session_at": r["last_session_at"],
        }
    output = {
        "generated_at": now_iso,
        "stats": {
            "total_singles": singles, "total_albums": albums,
            "mode": MODE,
            "crawl": crawl,
        },
        "sections": sections_out,
    }
    (DATA_DIR / "songs.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def export_search_index(conn, now_iso: str):
    rows = conn.execute(
        "SELECT kind, id, title, artist, music, label, released FROM items "
        "WHERE title != '' ORDER BY first_seen_at DESC"
    ).fetchall()
    items = [
        {
            "k": r["kind"][0], "i": r["id"],
            "t": r["title"] or "", "a": r["artist"] or "",
            "m": r["music"] or "", "l": r["label"] or "",
            "r": r["released"] or "",
        }
        for r in rows
    ]
    (DATA_DIR / "search.json").write_text(
        json.dumps({"generated_at": now_iso, "count": len(items), "items": items},
                   ensure_ascii=False), encoding="utf-8"
    )
    print(f"[export] search.json: {len(items)} items")


def export_item_files(conn):
    ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    rows = conn.execute("SELECT * FROM items WHERE has_detail=1").fetchall()
    written = 0
    for r in rows:
        path = ITEMS_DIR / f"{r['kind']}-{r['id']}.json"
        if path.exists():
            try:
                file_mtime = path.stat().st_mtime
                fetched_ts = _iso_timestamp(r["detail_fetched_at"])
                if fetched_ts <= file_mtime:
                    continue
            except Exception:
                pass
        d = row_to_item_dict(r, slim=False)
        path.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        written += 1
    print(f"[export] item files: {written} written, {len(rows)} total")


# ===========================================================================
# Crawl-state helpers (for deep mode)
# ===========================================================================

def get_crawl_state(conn, section_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM crawl_state WHERE section_id=?", (section_id,)
    ).fetchone()


def update_crawl_state(conn, section_id: str, next_page: int,
                       pages_walked_delta: int, is_complete: bool,
                       now_iso: str):
    row = get_crawl_state(conn, section_id)
    if row:
        conn.execute(
            "UPDATE crawl_state SET next_page=?, pages_walked=pages_walked+?, "
            "is_complete=?, last_session_at=? WHERE section_id=?",
            (next_page, pages_walked_delta, 1 if is_complete else 0, now_iso, section_id),
        )
    else:
        conn.execute(
            "INSERT INTO crawl_state (section_id, next_page, pages_walked, "
            "is_complete, last_session_at) VALUES (?, ?, ?, ?, ?)",
            (section_id, next_page, pages_walked_delta, 1 if is_complete else 0, now_iso),
        )


def reset_crawl_state(conn):
    conn.execute("UPDATE crawl_state SET next_page=1, is_complete=0")
    conn.execute("UPDATE crawl_state SET pages_walked=0")
    print("[deep] crawl_state reset to page 1, is_complete=0")


# ===========================================================================
# Modes
# ===========================================================================

def run_fast(conn, now_iso: str):
    """Fast pass: first FAST_PAGES of paginated sections + the chart."""
    print(f"[fast] walking first {FAST_PAGES} pages per paginated section")
    for section in SECTIONS:
        print(f"\n[section] {section['title']}  ({section['id']})")
        if section["paginate"]:
            walked, new, _ = walk_pages(conn, section, 1, FAST_PAGES, now_iso)
            print(f"  walked {walked} pages, +{new} new items")
        else:
            capture_top_chart(conn, section, now_iso)
            print(f"  chart refreshed")


def run_deep(conn, now_iso: str):
    """Deep pass: continue walking unseen pages of paginated sections."""
    print(f"[deep] session size: {PAGES_PER_SESSION} pages per section")

    if RESET_DEEP:
        reset_crawl_state(conn)
        conn.commit()

    any_work = False

    for section in DEEP_SECTIONS:
        print(f"\n[section] {section['title']}  ({section['id']})")
        state = get_crawl_state(conn, section["id"])
        if state and state["is_complete"]:
            print(f"  already complete (walked {state['pages_walked']} pages). "
                  f"Skipping. Set RESET_DEEP=yes to redo.")
            continue

        start_page = state["next_page"] if state else 1
        # The fast scraper handles pages 1..FAST_PAGES. Deep scraper picks up
        # from page FAST_PAGES+1 the first time, then continues from wherever
        # last session left off.
        if start_page <= FAST_PAGES:
            start_page = FAST_PAGES + 1
            print(f"  bumping start to {start_page} (fast scraper handles 1..{FAST_PAGES})")

        end_page = start_page + PAGES_PER_SESSION
        print(f"  walking pages {start_page}..{end_page - 1}")

        walked, new, hit_end = walk_pages(conn, section, start_page,
                                          PAGES_PER_SESSION, now_iso)
        any_work = True
        next_p = start_page + walked
        complete = hit_end or walked == 0

        update_crawl_state(conn, section["id"], next_p, walked, complete, now_iso)
        conn.commit()

        print(f"  walked {walked} pages, +{new} new items. "
              f"next session resumes at page {next_p}. "
              f"complete={complete}")

    if not any_work:
        print("\n[deep] nothing to do — all sections marked complete.")


# ===========================================================================
# Main
# ===========================================================================

def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = db_open()
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print(f"[start] MODE={MODE!r}")
    singles_before, albums_before = db_counts(conn)
    print(f"        library: singles={singles_before} albums={albums_before}")

    if MODE == "fast":
        run_fast(conn, now_iso)
    elif MODE == "deep":
        run_deep(conn, now_iso)
    else:
        print(f"!! unknown MODE {MODE!r}; must be 'fast' or 'deep'", file=sys.stderr)
        return 2

    # Both modes do detail fetching and export.
    fetch_details_budgeted(conn, MAX_DETAIL_FETCHES, now_iso)

    print(f"\n[export]")
    export_homepage(conn, now_iso)
    export_search_index(conn, now_iso)
    export_item_files(conn)

    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('last_run_at', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (now_iso,),
    )
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('last_mode', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (MODE,),
    )
    conn.commit()

    singles_after, albums_after = db_counts(conn)
    pending = conn.execute(
        "SELECT COUNT(*) n FROM items WHERE has_detail=0"
    ).fetchone()["n"]
    print(f"\n[done] singles {singles_before} -> {singles_after}  "
          f"(+{singles_after - singles_before})")
    print(f"       albums  {albums_before} -> {albums_after}  "
          f"(+{albums_after - albums_before})")
    print(f"       items pending detail fetch: {pending}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
