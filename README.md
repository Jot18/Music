# Saadi Awaaz

A self-updating, password-gated Punjabi music library.

## What you get

Three live feeds on the homepage — New Singles, New Albums & EPs, and the
Top 50 Singles chart — plus a search bar over the full library of tens of
thousands of cached tracks.

Tap a single to play it. Tap an album to see its track listing — each
track is independently playable (the source serves albums as zip
downloads only, so the player works through the individual tracks).

The mini-player at the bottom streams without leaving the page; on phones
it expands into a Spotify-style full-screen now-playing view with
swipe-to-dismiss. The player stays out of sight until you actually play
something.

## Access

The site is gated by a single password. On first load you enter the code;
after that, your browser remembers it until you log out. This is a casual
privacy gate, not real auth — anyone with the public site URL can read
the JavaScript source. If you need actual multi-user logins, that
requires a backend (Cloudflare Workers, Firebase, Supabase, etc.) and is
a separate project.

**To set the password**: edit `site/app.js`, find `ACCESS_HASH`, replace
its value with the SHA-256 hex digest of your chosen password. In your
browser's devtools console:

```
crypto.subtle.digest('SHA-256', new TextEncoder().encode('your_password'))
  .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
```

The default password is `saadi`. Change it before deploying anything you
care about.

## How it stays current

Two scrapers run on separate schedules:

**Fast scraper** runs every 4 hours. Walks the first 50 pages of singles
and albums, refreshes the Top 50 chart, and fetches detail pages for up
to 800 new items. Finishes in 1–3 minutes. This is what keeps the
homepage fresh.

**Deep scraper** runs every 6 hours in the background, offset from the
fast schedule. Each session walks a sliding window of unseen page ranges
(default 200 pages per section). Session state is checkpointed in the
SQLite store, so the next session resumes where the last left off. After
a few weeks of sessions, the full catalogue (~26,000 singles, ~7,500
albums) is harvested. Once everything is walked, the deep scraper goes
to sleep until you reset it.

The persistent store is `data/library.db` (SQLite). Each run exports
slim browser-friendly artifacts:

- `data/songs.json` — homepage feeds
- `data/search.json` — slim search index of every cached song
- `data/items/{kind}-{id}.json` — per-song details, loaded on demand

The homepage loads instantly because the browser never sees the whole DB.

## Sections

**New Singles** — newest single releases.
**New Albums & EPs** — newest albums and EPs. Tap one to see and play
its tracks.
**Top 50 Singles** — the live ranked chart.

## Setup

1. Push the repo to GitHub.
2. **Settings → Pages**, source = *GitHub Actions*.
3. **Settings → Actions → General**, workflow permissions = *Read and write*.
4. Edit `site/app.js` and change `ACCESS_HASH` to a hash of your password.
   Commit and push.
5. Open the **Actions** tab and run the **Scrape (fast) & Deploy** workflow
   once to populate the homepage.
6. Run the **Scrape (deep, background)** workflow to start the backfill.
   You can kick it off repeatedly to walk through the catalogue faster,
   or just let the 6-hour schedule do its work over a few weeks.

The site goes live at `https://<your-username>.github.io/<your-repo>/`.

## Manual controls

**Fast workflow** has two knobs: pages per section (default 50) and the
detail-fetch budget (default 800).

**Deep workflow** has three: pages per session (default 200), detail
budget, and a reset switch. Set reset to `yes` to start the deep walk
over from page 1.

## A note on download filenames

Browsers ignore the `download` attribute on cross-origin links. The MP3
and ZIP files are served from the source CDN, so the saved filename comes
from the URL and may contain the source's branding. There's no way to
rewrite this from a static site — it would require routing downloads
through a proxy service. If that matters to you, ping me and I'll wire up
a Cloudflare Worker that strips the suffix.

## Layout

```
.github/workflows/fast.yml    fast scraper + deploy (every 4h)
.github/workflows/deep.yml    background deep scraper (every 6h)
scraper/scrape.py             entry point for both modes (MODE env var)
data/library.db               SQLite source of truth
data/songs.json               homepage feeds
data/search.json              search index
data/items/                   per-song detail files
site/                         static frontend
```
