# Saadi Awaaz

A self-updating Punjabi music wall.

## What you get

Three live feeds on the homepage — New Singles, New Albums & EPs, and the
Top 50 Singles chart. Each cover opens a details sheet with music
director, lyricist, label, release date, runtime, and download links in
three bitrates. A mini-player at the bottom streams the track without
leaving the page; on phones it expands into a Spotify-style full-screen
now-playing view with swipe-to-dismiss. The player stays out of sight
until you actually play something.

## How it stays current

A scheduled job runs every four hours. On the first run it walks every
paginated page of every category, builds the cache from scratch, and
fetches detail data for every release. After that, each run stops as soon
as it sees two consecutive listing pages of already-known tracks — so the
ongoing cost is tiny. Detail pages are fetched exactly once per song and
cached forever.

## Sections

**New Singles** — every new single release, paginated. The scraper walks
every page until exhausted.

**New Albums & EPs** — every album and EP release, paginated. Same.

**Top 50 Singles** — the ranked chart of trending singles.

## Setup

1. Push the repo to GitHub.
2. **Settings → Pages**, set the source to *GitHub Actions*.
3. **Settings → Actions → General**, switch workflow permissions to
   *Read and write*.
4. Open the **Actions** tab, pick *Scrape & Deploy*, click *Run workflow*,
   leave the deep-scrape option on *auto*. The first run takes 10–20
   minutes; every run after that is well under a minute.

The site goes live at `https://<your-username>.github.io/<your-repo>/`.

## Manual controls

The *Run workflow* dialog has a deep-scrape selector:

- **auto** — deep walk if a category's cache looks small (the default).
- **yes** — force a full deep re-walk of every section, ignoring caches.
- **no** — force incremental even on an empty cache (one page per
  section).

## Layout

```
.github/workflows/   automation
scraper/             the scraper
data/songs.json      the cache (the site reads this directly)
site/                the static frontend
```
