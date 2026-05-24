# Saadi Awaaz

A self-updating Punjabi music wall.

The site mirrors four feeds from djjohal — new singles, new albums and EPs,
the Top 50 singles, and the Top 50 Punjabi chart — and quietly keeps a
growing archive of everything it has ever seen. Tap any cover for the
artist, music director, lyricist, label, release date and download links.
A persistent player streams the track without leaving the page.

## What you get

A four-section wall of album covers on the homepage. A searchable archive
underneath that holds every track from every previous scrape — so songs
that fall off djjohal's front page stay findable. A small dock at the
bottom plays whatever you tap, with prev / next / scrub controls and
keyboard shortcuts on desktop. On phones and tablets the dock collapses to
a compact bar that expands into a full-height now-playing sheet, the way
Spotify and Apple Music behave on mobile.

## How it stays current

A GitHub Action runs every four hours. On the first run it walks every
page of every category, building the archive from scratch (this part takes
several minutes). On every subsequent run it stops as soon as it hits two
consecutive listing pages where everything is already known — so the
hourly cost stays tiny. Songs are never re-fetched once they're in the
archive.

## Sections

**New Singles** — every new single track release, paginated from
djjohal's Single Track category.

**New Albums & EPs** — every album and EP release, paginated from
djjohal's Punjabi category.

**Top 50 Singles** — djjohal's ranked chart of trending singles.

**Top 50 Chart** — djjohal's ranked Punjabi chart. Despite the homepage
labelling it "Top 50 Albums", djjohal actually serves this as a top-songs
chart, so it's labelled honestly here.

**Archive** — every track ever scraped, newest first. Search by title,
artist, music director, lyricist, label or release date.

## Setup

1. Push the repo to GitHub.
2. **Settings → Pages**, set the source to *GitHub Actions*.
3. **Settings → Actions → General**, switch workflow permissions to
   *Read and write*.
4. Open the **Actions** tab, pick *Scrape & Deploy*, click *Run workflow*,
   leave the deep-scrape option on *auto*. The first run takes 5–15
   minutes; every run after that is under a minute.

The site goes live at `https://<your-username>.github.io/<your-repo>/`.

## Manual controls

The *Run workflow* dialog has a deep-scrape selector:

- **auto** — deep walk only if the archive is empty (the default).
- **yes** — force a full deep re-walk. Use occasionally if you want to
  backfill old pages or after djjohal restructures a category.
- **no** — force incremental even on an empty archive. Only fetches page
  one of each section.

## Layout

```
.github/workflows/   the scrape-and-deploy automation
scraper/             the Python scraper
data/songs.json      the live archive (the site reads this directly)
site/                the static frontend
```
