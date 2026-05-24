#!/usr/bin/env python3
"""
Scraper v6 — SQLite-backed Punjabi music harvester.

Architecture
------------
- Persistent store: data/library.db (SQLite). Survives between runs.
- The scraper walks djjohal's paginated listings, queues unknown items into
  the DB, then fetches detail pages up to a per-run budget. Detail fetches
  are checkpointed: if a run is cut short, the next one resumes from where
  it left off.

Modes (set via DEEP_SCRAPE env var)
-----
  full       walk every page of every section (no early stop). Use this for
             the initial backfill. Spread across multiple runs because of
             GitHub Actions' 6-hour single-job limit.
  recent     walk only the first N pages of each section. Use this once
             the full backfill is complete. Default N=5.
  auto       full if the library is small (singles < 1000 or albums < 500),
             otherwise recent.

Output written every run
------------------------
  data/library.db                 the SQLite store
  data/songs.json                 small homepage payload (live feeds only)
  data/search.json                slim search index (every song, lite fields)
  data/items/{kind}-{id}.json     one file per fully-detailed song

This lets the website load the homepage in milliseconds even with tens of
thousands of cached songs, and pull full records on demand when a user opens
a detail sheet.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

SOURCE = "https://www.djjohal.com"

SECTIONS = [
    {
        "id": "new_singles",
        "title": "New Punjabi Single Songs",
        "url": f"{SOURCE}/category.php?cat=Single%20Track",
        "kind": "single",
        "paginate": True,
        "feed_cap": 60,      # how many items show in the live homepage feed
    },
    {
        "id": "new_albums",
        "title": "New Punjabi Full Album/EP",
        "url": f"{SOURCE}/category.php?cat=Punjabi",
        "kind": "album",
        "paginate": True,
        "feed_cap": 60,
    },
    {
        "id": "top_singles",
        "title": "Top 50 Punjabi Single Songs",
        "url": f"{SOURCE}/topTracks.php?cat=Single%20Track",
        "kind": "single",
        "paginate": False,
        "feed_cap": 50,
    },
]

MODE = os.environ.get("DEEP_SCRAPE", "auto").lower()

# Per-run budgets.
MAX_PAGES_PER_SECTION_FULL   = 2000   # safety ceiling; djjohal singles peak around 1660
MAX_PAGES_PER_SECTION_RECENT = int(os.environ.get("RECENT_PAGES", "5"))
MAX_DETAIL_FETCHES_PER_RUN   = int(os.environ.get("MAX_DETAIL_FETCHES", "800"))

DETAIL_DELAY_SECONDS  = 0.25
LISTING_DELAY_SECONDS = 0.30
REQUEST_TIMEOUT       = 25

# Auto-mode thresholds.
AUTO_FULL_IF_SINGLES_BELOW = 1000
AUTO_FULL_IF_ALBUMS_BELOW  = 500

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

DETAIL_PATH_RE = re.compile(r"^/(single|get|album)/(\d+)/([^/]+)\.html$")


# ===========================================================================
# Persistence (SQLite)
# ===========================================================================

ROOT      = Path(__file__).resolve().parent.parent
DATA_DIR  = ROOT / "data"
ITEMS_DIR = DATA_DIR / "items"
DB_PATH   = DATA_DIR / "library.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    kind            TEXT NOT NULL,            -- 'single' | 'album'
    id              TEXT NOT NULL,            -- djjohal item id
    slug            TEXT NOT NULL,
    url_kind        TEXT NOT NULL,            -- 'get' | 'single' | 'album' (the URL path used)
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
    has_detail      INTEGER NOT NULL DEFAULT 0,  -- 1 once detail page fetched
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    detail_fetched_at TEXT,
    listing_text    TEXT,                     -- cached anchor text for fallback parsing
    PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_items_kind_seen
    ON items(kind, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_has_detail
    ON items(has_detail, kind);

CREATE TABLE IF NOT EXISTS section_items (
    section_id  TEXT NOT NULL,
    position    INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    PRIMARY KEY (section_id, position)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

def db_open() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fresh = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if fresh:
        _migrate_legacy_songs_json(conn)
    return conn


def _migrate_legacy_songs_json(conn):
    """If a legacy songs.json from v1-v5 exists, import any cached items
    into the new SQLite store so we don't have to re-fetch them."""
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

    # Three possible legacy shapes: items[], archive[], sections[].items[]
    pools = []
    pools.append(data.get("items", []) or [])
    pools.append(data.get("archive", []) or [])
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
        print(f"[migrate] imported {imported} legacy items from songs.json into library.db")


def db_set_meta(conn, key: str, value: str):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def db_get_meta(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def db_counts(conn) -> tuple[int, int]:
    singles = conn.execute(
        "SELECT COUNT(*) AS n FROM items WHERE kind='single'"
    ).fetchone()["n"]
    albums = conn.execute(
        "SELECT COUNT(*) AS n FROM items WHERE kind='album'"
    ).fetchone()["n"]
    return singles, albums


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


# ===========================================================================
# Listing parsing
# ===========================================================================

def extract_listing(html: str, expected_kind: str) -> tuple[list[dict], str | None]:
    """Return (entries, next_page_url_or_None)."""
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
                "id": item_id,
                "slug": slug,
                "url_kind": url_kind,
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

    return {
        "title": title.strip(), "artist": artist.strip(),
        "music": music, "lyrics": lyrics, "label": label,
        "released": released, "playtime": playtime, "plays": plays,
        "cover": cover, "stream_url": stream,
        "mp3_320": mp3_320, "mp3_128": mp3_128, "mp3_48": mp3_48,
        "zip_320": zip_320, "zip_128": zip_128,
    }


# ===========================================================================
# Walker
# ===========================================================================

def upsert_listing_entry(conn, entry: dict, kind: str, now_iso: str) -> bool:
    """Insert if new. Returns True if newly inserted, False if existing."""
    cur = conn.execute(
        "SELECT 1 FROM items WHERE kind=? AND id=?",
        (kind, entry["id"]),
    )
    if cur.fetchone():
        conn.execute(
            "UPDATE items SET last_seen_at=?, listing_text=? "
            "WHERE kind=? AND id=?",
            (now_iso, entry["listing_text"], kind, entry["id"]),
        )
        return False

    lt_title, lt_artist = parse_listing_text(entry["listing_text"], kind)
    conn.execute(
        "INSERT INTO items (kind, id, slug, url_kind, detail_url, "
        "title, artist, has_detail, first_seen_at, last_seen_at, listing_text) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        (kind, entry["id"], entry["slug"], entry["url_kind"], entry["detail_url"],
         lt_title, lt_artist, now_iso, now_iso, entry["listing_text"]),
    )
    return True


def walk_section(conn, section: dict, mode: str, now_iso: str) -> tuple[int, int]:
    """
    Walk listings for this section. Inserts new rows into items.
    Returns (pages_walked, new_items_added).
    """
    if mode == "full":
        max_pages = MAX_PAGES_PER_SECTION_FULL
    else:
        max_pages = MAX_PAGES_PER_SECTION_RECENT

    print(f"  mode={mode}  max_pages={max_pages}")

    pages_walked = 0
    new_items = 0
    seen_ids_this_run: set[str] = set()
    page_url = section["url"]
    page_num = 1

    while page_url and page_num <= max_pages:
        if page_num % 20 == 1 or page_num <= 3:
            print(f"  page {page_num}: {page_url}", flush=True)
        try:
            html = fetch(page_url)
        except Exception as e:
            print(f"    ! page fetch failed: {e}", file=sys.stderr)
            break

        entries, next_url = extract_listing(html, section["kind"])
        pages_walked += 1

        if not entries:
            print(f"    page {page_num}: no entries, stopping")
            break

        # Dedupe vs earlier pages this run.
        new_on_page = []
        for e in entries:
            if e["id"] in seen_ids_this_run:
                continue
            seen_ids_this_run.add(e["id"])
            new_on_page.append(e)
        if not new_on_page:
            print(f"    page {page_num}: repeated earlier content, stopping")
            break

        # Upsert. Track which section position each item lives at, but only
        # for page 1 — that's the homepage feed ordering.
        page_new = 0
        for e in new_on_page:
            was_new = upsert_listing_entry(conn, e, section["kind"], now_iso)
            if was_new:
                page_new += 1
        new_items += page_new

        if page_num <= 3 or page_num % 20 == 0:
            print(f"    page {page_num}: +{page_new} new (total new this section: {new_items})")

        if not section["paginate"]:
            break
        if not next_url:
            print(f"    no next-page link; stopping")
            break

        page_url = next_url
        page_num += 1
        time.sleep(LISTING_DELAY_SECONDS)

    # Record the live-feed ordering: first feed_cap items from page 1 area.
    # We'll re-query in priority order: first_seen_at desc for category pages,
    # listing order for topTracks (we keep an ordered list by capturing as we go).
    return pages_walked, new_items


def record_top_chart_order(conn, section: dict, now_iso: str):
    """Special-case: topTracks pages have an explicit ranking. Capture
    the rank ordering separately so we can render it on the site."""
    if section["paginate"]:
        # Non-chart sections use chronological ordering (first_seen_at DESC).
        # No explicit ranking needed.
        return

    try:
        html = fetch(section["url"])
    except Exception as e:
        print(f"  ! chart fetch failed: {e}", file=sys.stderr)
        return

    entries, _ = extract_listing(html, section["kind"])
    conn.execute("DELETE FROM section_items WHERE section_id=?", (section["id"],))
    for pos, e in enumerate(entries[:section["feed_cap"]]):
        # Make sure the item is upserted.
        upsert_listing_entry(conn, e, section["kind"], now_iso)
        conn.execute(
            "INSERT INTO section_items(section_id, position, kind, item_id) "
            "VALUES (?, ?, ?, ?)",
            (section["id"], pos, section["kind"], e["id"]),
        )


# ===========================================================================
# Detail-page fetching (budgeted)
# ===========================================================================

def needs_detail_refetch(row: sqlite3.Row) -> bool:
    """Detect old/buggy entries that should get a fresh detail fetch."""
    if not row["has_detail"]:
        return True
    title = (row["title"] or "").lower()
    if not title or title.startswith("s latest") or "latest music from" in title:
        return True
    if not row["cover"]:
        return True
    return False


def fetch_details_budgeted(conn, budget: int, now_iso: str) -> int:
    """Fetch detail pages for items lacking them, up to `budget`.

    Priority order:
      1. items in any live-feed section (section_items table)
      2. newest-first by first_seen_at
    Returns number of pages fetched.
    """
    fetched = 0

    # Build a single queue: top-priority items first, then chronological.
    priority_ids = set()
    for row in conn.execute(
        "SELECT kind, item_id FROM section_items"
    ):
        priority_ids.add((row["kind"], row["item_id"]))

    # Pull all items missing details.
    rows = conn.execute(
        "SELECT * FROM items WHERE has_detail=0 ORDER BY first_seen_at DESC"
    ).fetchall()

    # Re-order: priority items first.
    def sort_key(r):
        in_prio = (r["kind"], r["id"]) in priority_ids
        return (0 if in_prio else 1, r["first_seen_at"])
    # Sorting tuple: priority bucket asc, then first_seen_at DESC (newer first).
    rows = sorted(rows, key=lambda r: (0 if (r["kind"], r["id"]) in priority_ids else 1,
                                       -_iso_timestamp(r["first_seen_at"])))

    print(f"\n[detail] {len(rows)} items lack details. budget={budget}")

    for row in rows:
        if fetched >= budget:
            print(f"    budget exhausted at {fetched}; remaining will be picked up next run.")
            break

        try:
            html = fetch(row["detail_url"])
            d = parse_detail(html, row["kind"])

            # If detail-page extraction missed title/artist, fall back to
            # the listing-text version we cached when we discovered the row.
            lt_title, lt_artist = parse_listing_text(row["listing_text"] or "", row["kind"])
            title  = d["title"]  or row["title"]  or lt_title  or ""
            artist = d["artist"] or row["artist"] or lt_artist or ""
            # Prefer the clean listing-text split when it has both parts.
            if lt_title and lt_artist:
                title, artist = lt_title, lt_artist

            conn.execute(
                "UPDATE items SET "
                "title=?, artist=?, music=?, lyrics=?, label=?, released=?, "
                "playtime=?, plays=?, cover=?, "
                "stream_url=?, mp3_320=?, mp3_128=?, mp3_48=?, zip_320=?, zip_128=?, "
                "has_detail=1, detail_fetched_at=?, last_seen_at=? "
                "WHERE kind=? AND id=?",
                (
                    title, artist, d["music"], d["lyrics"], d["label"], d["released"],
                    d["playtime"], d["plays"], d["cover"],
                    d["stream_url"], d["mp3_320"], d["mp3_128"], d["mp3_48"],
                    d["zip_320"], d["zip_128"],
                    now_iso, now_iso,
                    row["kind"], row["id"],
                ),
            )
            fetched += 1
            if fetched % 25 == 0:
                conn.commit()
                print(f"    [{fetched}/{budget}]  {row['kind']}:{row['id']}  {title[:60]}", flush=True)
            time.sleep(DETAIL_DELAY_SECONDS)
        except Exception as e:
            print(f"    ! detail failed for {row['kind']}:{row['id']}: {e}", file=sys.stderr)

    conn.commit()
    print(f"[detail] done. {fetched} pages fetched this run.")
    return fetched


def _iso_timestamp(s: str | None) -> float:
    """Parse ISO string to unix timestamp for sorting. Empty -> 0."""
    if not s:
        return 0.0
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


# ===========================================================================
# Exporters — produce site-ready JSON
# ===========================================================================

def row_to_item_dict(row: sqlite3.Row, slim: bool = False) -> dict:
    base = {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"] or "",
        "artist": row["artist"] or "",
    }
    if slim:
        return base
    base.update({
        "music":    row["music"] or "",
        "lyrics":   row["lyrics"] or "",
        "label":    row["label"] or "",
        "released": row["released"] or "",
        "playtime": row["playtime"] or "",
        "plays":    row["plays"] or "",
        "cover":    row["cover"] or "",
        "detail_url": row["detail_url"],
        "slug":     row["slug"],
        "url_kind": row["url_kind"],
        "mp3": {
            "stream":  row["stream_url"] or "",
            "kbps320": row["mp3_320"]   or "",
            "kbps128": row["mp3_128"]   or "",
            "kbps48":  row["mp3_48"]    or "",
            "zip320":  row["zip_320"]   or "",
            "zip128":  row["zip_128"]   or "",
        },
        "first_seen_at": row["first_seen_at"],
        "last_seen_at":  row["last_seen_at"],
    })
    return base


def export_homepage(conn, now_iso: str):
    """Write data/songs.json — only the live feeds, no full catalog."""
    sections_out = []
    for section in SECTIONS:
        if section["paginate"]:
            # Chronological feed: newest first.
            rows = conn.execute(
                "SELECT * FROM items WHERE kind=? ORDER BY first_seen_at DESC LIMIT ?",
                (section["kind"], section["feed_cap"]),
            ).fetchall()
        else:
            # Ranked chart: pull in section_items order.
            rows = conn.execute(
                "SELECT i.*, si.position FROM items i "
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

        sections_out.append({
            "id": section["id"],
            "title": section["title"],
            "kind": section["kind"],
            "items": items,
        })

    singles, albums = db_counts(conn)
    output = {
        "generated_at": now_iso,
        "stats": {
            "total_singles": singles,
            "total_albums": albums,
            "mode": MODE,
        },
        "sections": sections_out,
    }

    (DATA_DIR / "songs.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def export_search_index(conn, now_iso: str):
    """Write data/search.json — slim per-item entries for client-side search."""
    rows = conn.execute(
        "SELECT kind, id, title, artist, music, label, released "
        "FROM items "
        "WHERE has_detail=1 OR title != '' "
        "ORDER BY first_seen_at DESC"
    ).fetchall()

    items = []
    for r in rows:
        items.append({
            "k": r["kind"][0],     # 's' or 'a' to keep payload tiny
            "i": r["id"],
            "t": r["title"]  or "",
            "a": r["artist"] or "",
            "m": r["music"]  or "",
            "l": r["label"]  or "",
            "r": r["released"] or "",
        })

    output = {
        "generated_at": now_iso,
        "count": len(items),
        "items": items,
    }
    (DATA_DIR / "search.json").write_text(
        json.dumps(output, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[export] search.json: {len(items)} items")


def export_item_files(conn):
    """Write data/items/{kind}-{id}.json for every detailed item.

    Skip files that already exist and whose item hasn't been re-fetched
    since (using detail_fetched_at as a marker). This keeps the rewrite
    set small per run.
    """
    ITEMS_DIR.mkdir(parents=True, exist_ok=True)

    rows = conn.execute(
        "SELECT * FROM items WHERE has_detail=1"
    ).fetchall()

    written = 0
    for r in rows:
        path = ITEMS_DIR / f"{r['kind']}-{r['id']}.json"
        if path.exists():
            # Only rewrite if the detail was re-fetched more recently than
            # the file was written.
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

    print(f"[export] item files: {written} written, {len(rows)} total exist on disk")


# ===========================================================================
# Mode selection
# ===========================================================================

def resolve_mode(conn) -> str:
    if MODE in ("full", "yes"):
        return "full"
    if MODE in ("recent", "no"):
        return "recent"
    # auto
    singles, albums = db_counts(conn)
    if singles < AUTO_FULL_IF_SINGLES_BELOW or albums < AUTO_FULL_IF_ALBUMS_BELOW:
        print(f"[mode] auto -> full  (singles={singles}/{AUTO_FULL_IF_SINGLES_BELOW}, "
              f"albums={albums}/{AUTO_FULL_IF_ALBUMS_BELOW})")
        return "full"
    print(f"[mode] auto -> recent  (singles={singles}, albums={albums})")
    return "recent"


# ===========================================================================
# Main
# ===========================================================================

def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = db_open()

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    mode = resolve_mode(conn)

    print(f"[start] DEEP_SCRAPE={MODE!r} resolved -> {mode}")
    singles_before, albums_before = db_counts(conn)
    print(f"        library size: singles={singles_before}  albums={albums_before}")

    # 1) Walk listings, discovering new items.
    for section in SECTIONS:
        print(f"\n[section] {section['title']}")
        pages, new = walk_section(conn, section, mode, now_iso)
        conn.commit()
        print(f"  walked {pages} pages, added {new} new items")

        # For ranked charts, also capture the position list.
        if not section["paginate"]:
            record_top_chart_order(conn, section, now_iso)
            conn.commit()

    # 2) Fetch detail pages up to budget.
    fetched = fetch_details_budgeted(conn, MAX_DETAIL_FETCHES_PER_RUN, now_iso)

    # 3) Export site artifacts.
    print(f"\n[export]")
    export_homepage(conn, now_iso)
    export_search_index(conn, now_iso)
    export_item_files(conn)

    # 4) Update meta.
    db_set_meta(conn, "last_run_at", now_iso)
    db_set_meta(conn, "last_mode", mode)
    conn.commit()

    singles_after, albums_after = db_counts(conn)
    pending = conn.execute(
        "SELECT COUNT(*) AS n FROM items WHERE has_detail=0"
    ).fetchone()["n"]

    print(f"\n[done]")
    print(f"  singles: {singles_before} -> {singles_after}  (+{singles_after - singles_before})")
    print(f"  albums:  {albums_before} -> {albums_after}  (+{albums_after - albums_before})")
    print(f"  detail-fetches this run: {fetched}")
    print(f"  items still pending detail-fetch: {pending}")
    if pending > 0:
        print(f"  -> next run will continue fetching {pending} pending detail pages.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
