# Saadi Awaaz

A self-updating Punjabi music wall, backed by a SQLite library.

## What you get

Three live feeds on the homepage — New Singles, New Albums & EPs, and the
Top 50 Singles chart. A search bar at the top searches the full library
of tens of thousands of cached tracks by title, artist, album, music
director, lyricist, or label. Tap any cover for the details — music
director, lyricist, label, release date, runtime, and download links in
three bitrates. A mini-player at the bottom streams the track without
leaving the page; on phones it expands into a Spotify-style full-screen
now-playing view with swipe-to-dismiss. The player stays out of sight
until you actually play something.

## How it stays current

A scheduled job runs every four hours. The first several runs do the
heavy backfill, walking every paginated category page and harvesting
detail data in batches that fit GitHub Actions' time limit. Once the
backfill is complete (about 26,000 singles and 7,500 albums) every run
just checks the most recent few pages and fetches details for any new
releases — usually finishing in a couple of minutes.

The persistent store is a SQLite database (`data/library.db`) that the
scraper reuses across runs. The website never reads the DB directly;
instead the scraper exports three slim, browser-friendly artifacts each
run:

- `songs.json` — the homepage feeds.
- `search.json` — a slim search index of every cached song.
- `data/items/{kind}-{id}.json` — one file per fully detailed song,
  loaded on demand when you open a card.

This keeps the homepage instantaneous even with a library of tens of
thousands of songs.

## Sections

**New Singles** — every new single, ordered by first-seen date.

**New Albums & EPs** — every album and EP release, same ordering.

**Top 50 Singles** — the live ranked chart of trending singles.

## Setup

1. Push the repo to GitHub.
2. **Settings → Pages**, set the source to *GitHub Actions*.
3. **Settings → Actions → General**, switch workflow permissions to
   *Read and write*.
4. Open the **Actions** tab, pick *Scrape & Deploy*, click *Run workflow*,
   leave the mode on *auto*. The first run takes around 30 minutes; if
   the library isn't fully harvested in one run, just kick off another
   run — each one picks up where the last left off.

The site goes live at `https://<your-username>.github.io/<your-repo>/`.

## Manual controls

The *Run workflow* dialog has three knobs:

- **mode** — `auto` (default), `full` (force a deep walk), or `recent`
  (skip the deep walk and just check the first few pages).
- **recent_pages** — how many pages per section in `recent` mode. Default 5.
- **max_details** — cap on detail-page fetches per run. Default 800.

## Layout

```
.github/workflows/   automation
scraper/             the scraper
data/library.db      the SQLite cache (the source of truth)
data/songs.json      homepage feeds
data/search.json     search index
data/items/          per-song detail files (on-demand)
site/                the static frontend
```
