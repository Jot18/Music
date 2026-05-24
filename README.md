# Saadi Awaaz — djjohal.com Music Tracker (v3)

An auto-updating Punjabi music tracker with a growing archive. A GitHub
Action scrapes [djjohal.com](https://www.djjohal.com) every 4 hours and
publishes a static site to GitHub Pages.

## What v3 does differently

**First run = deep scrape.** When the archive is empty, the scraper follows
djjohal's own pagination ("Next Page" links) and walks every page in each
category, populating a full archive. This typically takes 5–15 minutes and
fetches a few hundred detail pages.

**Every later run = incremental + append-only.** It walks listings only until
it finds two consecutive pages where every ID is already in the archive,
then stops. It **never re-fetches detail pages** for songs it already knows
about. Each run typically takes well under a minute and fetches only the
handful of new tracks added since the previous scrape.

**Songs are accumulated forever.** Once a track is in `data/songs.json`, it
stays there with `first_seen_at` and `last_seen_at` timestamps. Songs that
fall off page 1 of djjohal stay in your archive. The archive is rendered as
a searchable section at the bottom of the site.

### Why not SQLite?

A separate DB file would need to be exported to JSON anyway so the static
site can read it (GitHub Pages has no backend). The JSON file already
behaves like a key/value store keyed by `{kind}:{id}`. Adding SQLite would
just mean writing the same data twice. The current design is simpler and
gives you everything a small DB would.

## Sections shown on the site

1. **New Punjabi Single Songs** — `category.php?cat=Single Track` (paginated)
2. **New Punjabi Full Album/EP** — `category.php?cat=Punjabi` (paginated)
3. **Top 50 Punjabi Single Songs** — `topTracks.php?cat=Single Track`
4. **Top 50 Punjabi Songs (Chart)** — `topTracks.php?cat=Punjabi`
5. **Full Archive** — everything ever seen, with search by title / artist /
   music director / lyricist / label.

> ⓘ djjohal does not publish a separate "Top 50 Albums" chart. The fourth
> homepage link is actually a top-songs chart for the Punjabi category, so
> the site labels it "Top 50 Chart" instead.

## Layout

```
.
├── .github/workflows/scrape.yml   # scrape every 4h + deploy
├── scraper/
│   ├── scrape.py                  # paginating, incremental Python scraper
│   └── requirements.txt
├── data/
│   └── songs.json                 # archive + live feeds (the "DB")
└── site/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Data file shape

```jsonc
{
  "generated_at": "2026-05-24T22:00:00+00:00",
  "stats": { "archive_size": 412, "detail_fetches_this_run": 8, "deep_scrape": "auto" },
  "sections": [
    {
      "id": "new_singles",
      "title": "New Punjabi Single Songs",
      "kind": "single",
      "items": [ /* live-ordered items, capped at section.live_cap */ ]
    },
    // … 3 more
  ],
  "archive": [
    {
      "id": "526452",
      "kind": "single",
      "title": "CEO",
      "artist": "Cheema Y",
      "music": "Gur Sidhu",
      "lyrics": "Cheema Y",
      "label": "Brown Town Music",
      "released": "21-05-2026",
      "playtime": "02:18",
      "plays": "22246",
      "cover": "https://lq.djjohal.com/covers/...",
      "mp3": {
        "stream": "...", "kbps320": "...", "kbps128": "...",
        "kbps48": "...", "zip320": "", "zip128": ""
      },
      "detail_url": "https://www.djjohal.com/get/526452/ceo-cheema-y.html",
      "first_seen_at": "2026-05-21T18:14:02+00:00",
      "last_seen_at":  "2026-05-24T22:00:00+00:00"
    }
    // … N more, newest-first by first_seen_at
  ]
}
```

## One-time setup

1. Push this repo to GitHub.
2. **Settings → Pages**: set *Source* to **GitHub Actions**.
3. **Settings → Actions → General**: under *Workflow permissions*,
   select **Read and write permissions**, then **Save**.
4. **Actions tab → Scrape & Deploy → Run workflow**.
   - Leave `deep_scrape` on `auto`. Because the archive starts empty, the
     scraper will do a full deep walk automatically. Expect 5–15 minutes.

After that, scrapes happen every 4 hours and just append new tracks.

## Manual controls

The **Run workflow** dialog has a `deep_scrape` dropdown:

- **auto** *(default)* — deep walk only if the archive is empty.
- **yes** — force a full deep re-walk. Useful if you want to backfill old
  pages or if djjohal updates an entire category at once.
- **no** — force incremental even on an empty archive (only fetches page 1
  of each section).

## Running locally

```bash
pip install -r scraper/requirements.txt
python scraper/scrape.py            # incremental
DEEP_SCRAPE=yes python scraper/scrape.py   # force full walk

# Preview the site
cd site
mkdir -p data && cp ../data/songs.json data/songs.json
python -m http.server 8000
# open http://localhost:8000
```

## Tuning

In `scraper/scrape.py`:

- `MAX_PAGES_PER_SECTION` (200) — safety cap on pagination.
- `MAX_DETAIL_FETCHES_PER_RUN` (500) — hard ceiling on detail-page fetches
  per run. Each run normally fetches far less than this; the cap is for
  pathological cases.
- `STOP_AFTER_N_KNOWN_PAGES` (2) — how many consecutive all-known pages
  before incremental stops.
- `DETAIL_DELAY_SECONDS` / `LISTING_DELAY_SECONDS` — politeness delays.

## Copyright note

The site links and streams audio hosted on djjohal.com. djjohal itself
distributes under CC BY-NC-SA. This project does **not** rehost any audio;
it only displays metadata and links to djjohal's CDN. Treat it as a personal
tracker, not a redistribution platform.
