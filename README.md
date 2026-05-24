# Saadi Awaaz — djjohal.com Music Tracker

An auto-updating Punjabi music tracker. A GitHub Action scrapes
[djjohal.com](https://www.djjohal.com) every 4 hours and publishes a static
site to GitHub Pages.

The site shows **four sections only** (the ones outlined in the original
request):

1. **New Punjabi Single Songs**
2. **New Punjabi Full Album/EP**
3. **Top 50 Punjabi Single Songs**
4. **Top 50 Punjabi Album Songs**

Click any cover to see music, lyrics, label, release date, plays, playtime,
and download links. A persistent player at the bottom streams the track and
supports prev/next/scrub.

---

## Layout

```
.
├── .github/workflows/scrape.yml   # GH Action: scrape every 4h + deploy
├── scraper/
│   ├── scrape.py                  # Python scraper (requests + bs4)
│   └── requirements.txt
├── data/
│   └── songs.json                 # scraper output, served to the site
└── site/
    ├── index.html
    ├── styles.css
    └── app.js
```

## How the scrape works

`scraper/scrape.py` fetches these four listing pages:

| Section            | URL                                                 |
|--------------------|-----------------------------------------------------|
| New Singles        | `/category.php?cat=Single%20Track`                  |
| New Albums/EPs     | `/category.php?cat=Punjabi`                         |
| Top 50 Singles     | `/topTracks.php?cat=Single%20Track`                 |
| Top 50 Albums      | `/topTracks.php?cat=Punjabi`                        |

From each listing it extracts every `/single/{id}/...` or `/album/{id}/...`
card (capped at 50/section). For each card it visits the detail page and
pulls song/artist, music, lyrics, label, release date, playtime, plays,
cover, and the 320 / 128 / 48 kbps mp3 + zip URLs.

Detail-page results are **cached across runs** by re-using the previous
`songs.json`, so subsequent scrapes only refresh listings — fast and polite.

Output → `data/songs.json`. That file is the single source of truth for
the website.

## One-time setup

1. **Push this repo to GitHub.**
2. In the repo, go to **Settings → Pages** and set
   *Source* = **GitHub Actions**.
3. Go to **Settings → Actions → General**, scroll to *Workflow permissions*,
   and select **Read and write permissions**.
4. Go to the **Actions** tab and run `Scrape & Deploy` manually once
   (the *Run workflow* button on the right). After ~1 minute your site is
   live at `https://<your-username>.github.io/<your-repo>/`.

From then on it scrapes every 4 hours automatically. You can also force a
refresh anytime via *Run workflow*.

## Running locally

```bash
# scrape
pip install -r scraper/requirements.txt
python scraper/scrape.py

# preview the site
cd site
cp ../data/songs.json data/songs.json  # the site fetches data/songs.json
python -m http.server 8000
# open http://localhost:8000
```

## Tuning

In `scraper/scrape.py`:

- `MAX_ITEMS_PER_SECTION` — default 50.
- `MAX_DETAIL_FETCHES_PER_RUN` — default 80. Raising this means longer
  scrapes but fresher metadata.
- `DETAIL_DELAY_SECONDS` — politeness delay between detail-page hits.

In `.github/workflows/scrape.yml`, the cron is `'0 */4 * * *'` (every 4
hours on the hour, UTC). Change to taste — note GitHub free runners have
monthly minute quotas.

## A note on copyright

The site links and streams audio hosted on djjohal.com. djjohal itself
distributes under CC BY-NC-SA. This project does **not** rehost any audio;
it only displays metadata and links to djjohal's CDN. Treat it as a personal
tracker, not a redistribution platform.
