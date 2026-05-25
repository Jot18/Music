/* ============================================================
   Saadi Awaaz · App logic v7
   ============================================================ */

// ---------------- Service worker (PWA install + offline shell) -------------
// Registered early so the SW can intercept fetches for the rest of the
// session. The SW caches the app shell and the data/*.json files; audio
// streams and covers bypass it (always go direct to network).
if ("serviceWorker" in navigator) {
  // Wait until window load so the SW registration doesn't compete with
  // first-paint resources.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

// ---------------- Auth (simple password gate) -------------------------------
// To set the password: pick one, hash it with SHA-256, paste the hex digest
// into ACCESS_HASH. Anyone with the deployed site source can read this hash
// — that's expected. This gate keeps casual visitors out, not motivated ones.
//
// Quick way to generate a hash in your browser console:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_PASSWORD'))
//     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))

// Default = sha256("saadi") — change this BEFORE deploying.
const ACCESS_HASH = "13d3caae1e51084f3deafb8a44c2f39ed52cca586e6f9a16288cf7304019efd1";

const AUTH_KEY = "sa_auth_v1";

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function isAuthenticated() {
  const stored = localStorage.getItem(AUTH_KEY);
  return stored === ACCESS_HASH;
}

function showGate(show) {
  const gate  = document.getElementById("loginGate");
  const shell = document.getElementById("appShell");
  if (gate)  gate.hidden  = !show;     // gate visible when show=true
  if (shell) shell.hidden = show;      // app shell hidden when gate is up
  // Prevent scroll behind the gate.
  document.body.style.overflow = show ? "hidden" : "";
}

async function tryLogin(password) {
  const h = await sha256Hex(password || "");
  if (h === ACCESS_HASH) {
    localStorage.setItem(AUTH_KEY, h);
    return true;
  }
  return false;
}

function logout() {
  localStorage.removeItem(AUTH_KEY);
  // Pause anything playing first.
  try { document.getElementById("audio").pause(); } catch {}
  location.reload();
}

// Wire up the login form.
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("loginInput");
  const err   = document.getElementById("loginError");
  const ok = await tryLogin(input.value);
  if (ok) {
    err.hidden = true;
    showGate(false);
    boot();
  } else {
    err.hidden = false;
    input.value = "";
    input.focus();
  }
});

const logoutHandler = () => {
  if (confirm("Log out of Saadi Awaaz?")) logout();
};
document.getElementById("logoutBtn").addEventListener("click", logoutHandler);
const mobileLogout = document.getElementById("mobileLogout");
if (mobileLogout) mobileLogout.addEventListener("click", logoutHandler);

// On load, decide whether to show the gate or boot the app.
(async () => {
  if (await isAuthenticated()) {
    showGate(false);
    boot();
  } else {
    showGate(true);
    setTimeout(() => document.getElementById("loginInput").focus(), 100);
  }
})();

// ---------------- Touch detection -------------------------------------------

function isTouchDevice() {
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  if (/iPad|iPhone|iPod|Android/i.test(navigator.userAgent)) return true;
  return navigator.maxTouchPoints > 1;
}
if (isTouchDevice()) {
  document.documentElement.classList.add("is-touch");
  document.body.classList.add("is-touch");
}

// ---------------- Helpers ---------------------------------------------------

const STATE = {
  sections: [],
  playlist: [],
  currentIndex: -1,
  currentItem: null,
  searchIndex: null,
  searchLoading: false,
  // When the user plays a track from an album sheet, we remember which album
  // it came from. Clicking the now-playing bar/title re-opens that album's
  // sheet (with this track highlighted) instead of the single's detail.
  albumContext: null,  // the album item (or null when playing a standalone single)
  // Current "view" — one of "home" or "artist:<name>" or "artists" (the list)
  // or "browse:singles" / "browse:albums". Drives what renderAll() shows.
  view: "home",
  // Lazy index built from search.json the first time the Artists view opens.
  artistIndex: null,
  // Per-section page number on the home view (1-indexed).
  pages: { new_singles: 1, new_albums: 1, top_singles: 1, top_punjabi: 1 },
  // Shuffle: when true, playNext picks a random unplayed track from the
  // current playlist instead of i+1. Persisted to localStorage so it
  // survives reloads.
  shuffle: localStorage.getItem("sa_shuffle_v1") === "1",
  // Shuffle history — indices we've already visited in the current
  // shuffle cycle, used to avoid immediately repeating the last few songs.
  shuffleHistory: [],
  // Items currently visible in the active view (artist page, browse view,
  // search results, etc.). When the user plays a song from this list,
  // we rebuild the playlist from these items so auto-advance follows
  // the same context.
  viewItems: null,
};

// How many items per page on the homepage sections.
const PAGE_SIZE_HOME = 50;
const BROWSE_BATCH = 60;

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function fmtTime(secs) {
  if (!Number.isFinite(secs)) return "0:00";
  secs = Math.max(0, Math.floor(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function safeText(v) { return (v == null || v === "") ? "—" : String(v); }

function safeUrl(u) {
  if (!u) return "";
  try { return encodeURI(u); } catch { return u; }
}

function sanitizeFilename(s) {
  if (!s) return "track";
  return s
    .replace(/\(?\s*DJJOhAL[.\s]*Com\s*\)?/gi, "")
    .replace(/\bdjjohal\b/gi, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g, "")
    .slice(0, 120) || "track";
}

/**
 * Best YouTube URL for an item. Prefers the resolved watch URL the scraper
 * captured (item.youtube_url) when available — clicking takes you straight
 * to the song's video. Falls back to a search-results URL when we haven't
 * resolved it yet (item not in homepage priority list, or YouTube returned
 * nothing during scrape).
 */
function youtubeSearchUrl(item) {
  if (!item) return "";
  // Resolved URL from the scraper — exact video, what the user wants.
  if (typeof item.youtube_url === "string" && item.youtube_url.startsWith("https://")) {
    return item.youtube_url;
  }
  // Fallback: search results URL.
  const parts = [item.artist, item.title]
    .map(s => (s || "").trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const q = encodeURIComponent(parts.join(" "));
  return `https://www.youtube.com/results?search_query=${q}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------- Item cache ------------------------------------------------

const ITEM_CACHE = new Map();

async function loadItemDetail(kind, id) {
  const key = `${kind}:${id}`;
  if (ITEM_CACHE.has(key)) return ITEM_CACHE.get(key);
  try {
    const res = await fetch(`data/items/${kind}-${id}.json`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const item = await res.json();
    ITEM_CACHE.set(key, item);
    return item;
  } catch (err) {
    console.warn(`No detail file for ${key}:`, err);
    return null;
  }
}

async function ensureFullItem(item) {
  if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320)) {
    return item;
  }
  const detail = await loadItemDetail(item.kind, item.id);
  return detail || item;
}

// ---------------- Rendering -------------------------------------------------

function renderSection(section) {
  const isChart = section.id.startsWith("top_");

  let titleHtml;
  switch (section.id) {
    case "new_singles":  titleHtml = `New <em>Singles</em>`; break;
    case "new_albums":   titleHtml = `New <em>Albums</em> &amp; EPs`; break;
    case "top_singles":  titleHtml = `Top 50 <em>Single Songs</em>`; break;
    case "top_punjabi":  titleHtml = `Top 50 <em>Album Songs</em>`; break;
    default:             titleHtml = section.title;
  }

  // For new_singles / new_albums: paginate using the search index so the
  // user can advance past the 100 items the homepage JSON ships with.
  // For top charts: keep the original 50-item snapshot (no pagination —
  // those ARE the top 50 by design).
  const paginatable = (section.id === "new_singles" || section.id === "new_albums");

  // Slim helper that ranks the search index newest-first by id.
  const slimSorted = (kindLetter) => {
    if (!STATE.searchIndex) return null;
    return STATE.searchIndex
      .filter(s => s.k === kindLetter)
      .sort((a, b) => parseInt(b.i, 10) - parseInt(a.i, 10));
  };

  let pageItems = section.items;
  let total = section.total_available ?? section.items.length;
  let pageNum = STATE.pages[section.id] || 1;
  let maxPage = 1;

  if (paginatable) {
    const slimAll = slimSorted(section.kind === "album" ? "a" : "s");
    if (slimAll && slimAll.length > section.items.length) {
      // Use the full library as the pagination source.
      total = slimAll.length;
      maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE_HOME));
      pageNum = Math.min(Math.max(pageNum, 1), maxPage);
      const start = (pageNum - 1) * PAGE_SIZE_HOME;
      const slice = slimAll.slice(start, start + PAGE_SIZE_HOME);
      pageItems = slice.map((s) => {
        const cached = ITEM_CACHE.get(`${section.kind}:${s.i}`);
        return cached || expandSlim(s);
      });
    } else {
      // Fallback to whatever songs.json shipped.
      pageItems = section.items.slice(0, PAGE_SIZE_HOME);
      maxPage = Math.max(1, Math.ceil(section.items.length / PAGE_SIZE_HOME));
    }
  }

  // Section header: title on the left, browse link on the right (no
  // "search for more" / library-total verbiage).
  const head = el("div", { class: "section__head" },
    el("h2", { class: "section__title", html: titleHtml }),
  );
  if (paginatable) {
    // Right side: a "Browse all →" link that opens the infinite-scroll
    // view for this kind.
    const browseHref = section.kind === "album" ? "#browse/albums" : "#browse/singles";
    head.append(el("a", {
      class: "section__browse",
      href: browseHref,
      onclick: (e) => {
        e.preventDefault();
        openBrowse(section.kind === "album" ? "albums" : "singles");
      },
    }, `Browse all ${total.toLocaleString()} →`));
  }

  const grid = el("div", { class: "grid" });
  if (pageItems.length === 0) {
    grid.append(el("div", { class: "empty" }, "Waiting for next scrape…"));
  }
  pageItems.forEach((item, idx) => {
    grid.append(buildCard(item, isChart, idx));
  });

  const sectEl = el("section", { class: "section", id: section.id }, head, grid);

  // Pager controls (page numbers and prev/next), only for paginatable sections
  // that have more than one page.
  if (paginatable && maxPage > 1) {
    sectEl.append(renderPager(section.id, pageNum, maxPage));
  }

  return sectEl;
}

function renderPager(sectionId, current, maxPage) {
  const pager = el("nav", { class: "pager", "aria-label": "Pagination" });

  const go = (n) => {
    n = Math.min(Math.max(1, n), maxPage);
    if (n === STATE.pages[sectionId]) return;
    STATE.pages[sectionId] = n;
    // Re-render just this section in place to avoid jumping the whole page.
    const old = document.getElementById(sectionId);
    if (old && _homeData) {
      const sectionData = _homeData.sections.find(s => s.id === sectionId);
      if (sectionData) {
        const fresh = renderSection(sectionData);
        old.replaceWith(fresh);
        // Scroll the section title back into view for context.
        fresh.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  };

  const btnPrev = el("button", {
    class: "pager__btn pager__btn--nav",
    type: "button",
    "aria-label": "Previous page",
    disabled: current === 1 ? "" : null,
    onclick: () => go(current - 1),
  }, "← Prev");
  pager.append(btnPrev);

  // Page numbers — show first, last, current, and immediate neighbors;
  // collapse the rest into "…".
  const numbers = [];
  const add = (n) => { if (!numbers.includes(n) && n >= 1 && n <= maxPage) numbers.push(n); };
  add(1);
  add(current - 1);
  add(current);
  add(current + 1);
  add(maxPage);
  numbers.sort((a, b) => a - b);

  let lastShown = 0;
  for (const n of numbers) {
    if (n > lastShown + 1) {
      pager.append(el("span", { class: "pager__ellipsis", "aria-hidden": "true" }, "…"));
    }
    const btn = el("button", {
      class: "pager__btn" + (n === current ? " is-current" : ""),
      type: "button",
      "aria-label": `Page ${n}`,
      "aria-current": n === current ? "page" : null,
      onclick: () => go(n),
    }, String(n));
    pager.append(btn);
    lastShown = n;
  }

  const btnNext = el("button", {
    class: "pager__btn pager__btn--nav",
    type: "button",
    "aria-label": "Next page",
    disabled: current === maxPage ? "" : null,
    onclick: () => go(current + 1),
  }, "Next →");
  pager.append(btnNext);

  return pager;
}

function buildCard(item, isChart, idx) {
  const cover = safeUrl(item.cover) ||
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='%23251608'/></svg>";
  const isAlbum = item.kind === "album";

  // Build the cover area. Albums get a different play button — it opens the
  // tracklist instead of trying to play the album (album pages have no audio).
  const playBtn = el("button", {
    class: "card__play",
    "aria-label": isAlbum ? `Open ${item.title}` : `Play ${item.title}`,
    onclick: (e) => {
      e.stopPropagation();
      if (isAlbum) {
        // Open the album sheet so the user can pick a track.
        openSheet(item);
        return;
      }
      // Critical: play SYNCHRONOUSLY if we already have a stream URL.
      // On Android Chrome, audio.play() must run inside the same task as
      // the user click; an `await` between click and play() breaks the
      // user-gesture chain and the browser may navigate to the MP3 URL
      // (which then downloads). Items in songs.json all have streams
      // when has_detail=1, so the common case is sync.
      if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320 || item.mp3.kbps48)) {
        STATE.albumContext = null;
        playItem(item);
        return;
      }
      // Slow path: need to fetch detail. Won't autoplay on Android, but
      // works on desktop.
      (async () => {
        const full = await ensureFullItem(item);
        if (full && full.mp3 && (full.mp3.stream || full.mp3.kbps128 || full.mp3.kbps320 || full.mp3.kbps48)) {
          STATE.albumContext = null;
          playItem(full);
        } else {
          alert("This track isn't streamable yet — the next scrape will pick it up.");
        }
      })();
    },
    html: isAlbum
      ? `<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
  });

  const coverWrap = el("div", { class: "card__cover-wrap" },
    isChart ? el("span", { class: "card__rank" }, String(idx + 1)) : null,
    isAlbum ? el("span", { class: "card__badge" }, "Album") : null,
    el("img", {
      class: "card__cover",
      src: cover,
      alt: `${item.title} cover`,
      loading: "lazy",
      onerror: function () { this.style.opacity = ".15"; }
    }),
    playBtn,
  );

  return el("button", {
    class: "card",
    type: "button",
    "data-item": `${item.kind}:${item.id}`,
    onclick: () => openSheet(item),
  },
    coverWrap,
    el("div", { class: "card__meta" },
      el("h3", { class: "card__title" }, item.title || "Untitled"),
      el("p", { class: "card__artist" }, item.artist || (isAlbum ? "Various Artists" : "Unknown"))
    )
  );
}

function renderAll(data) {
  // Stash the data so back-navigation from an artist view can re-render
  // home without re-fetching.
  _homeData = data;
  STATE.view = "home";

  const app = $("#app");
  app.innerHTML = "";

  // ----- Last updated chips (desktop sidebar + mobile topbar)
  if (data.generated_at) {
    const d = new Date(data.generated_at);
    if (!isNaN(d.getTime())) {
      const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
      const total = (data.stats?.total_singles ?? 0) + (data.stats?.total_albums ?? 0);
      const desktopText = `updated ${d.toLocaleString(undefined, opts)} · library: ${total.toLocaleString()}`;
      const mobileText  = `updated ${d.toLocaleString(undefined, opts)}`;
      const dEl = $("#lastUpdated");
      const mEl = $("#lastUpdatedMobile");
      if (dEl) dEl.textContent = desktopText;
      if (mEl) mEl.textContent = mobileText;
    }
  }

  // ----- "Library updated" banner: compares the current snapshot's
  // total item count against whatever this device saw last time, and
  // surfaces the delta. One tap dismisses the banner and records the
  // new high-water mark.
  const curTotal = (data.stats?.total_singles ?? 0) + (data.stats?.total_albums ?? 0);
  const curSingles = data.stats?.total_singles ?? 0;
  const curAlbums  = data.stats?.total_albums  ?? 0;
  const lastSeenRaw = localStorage.getItem("sa_last_seen_v1");
  let lastSeen = null;
  try { lastSeen = lastSeenRaw ? JSON.parse(lastSeenRaw) : null; } catch { lastSeen = null; }
  if (lastSeen && typeof lastSeen.total === "number" && curTotal > lastSeen.total) {
    const newSingles = Math.max(0, curSingles - (lastSeen.singles ?? 0));
    const newAlbums  = Math.max(0, curAlbums  - (lastSeen.albums  ?? 0));
    const parts = [];
    if (newSingles) parts.push(`${newSingles} new single${newSingles === 1 ? "" : "s"}`);
    if (newAlbums)  parts.push(`${newAlbums} new album${newAlbums === 1 ? "" : "s"}`);
    if (parts.length) {
      const banner = el("div", { class: "lib-updated-banner", role: "status" });
      banner.append(
        el("span", { class: "lib-updated-banner__icon", html: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2v6l4-4-4-4zm0 14a4 4 0 1 1 4-4 4 4 0 0 1-4 4zm0-10a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4z"/></svg>` }),
        el("span", { class: "lib-updated-banner__text" }, `${parts.join(" · ")} since last visit`),
        el("button", {
          class: "lib-updated-banner__close",
          "aria-label": "Dismiss",
          type: "button",
          onclick: () => {
            banner.remove();
            localStorage.setItem("sa_last_seen_v1", JSON.stringify({
              total: curTotal, singles: curSingles, albums: curAlbums,
              at: data.generated_at || new Date().toISOString(),
            }));
          },
        }, "×"),
      );
      app.append(banner);
    }
  }
  // First-ever visit: stash the current count so future visits can diff.
  if (!lastSeen) {
    localStorage.setItem("sa_last_seen_v1", JSON.stringify({
      total: curTotal, singles: curSingles, albums: curAlbums,
      at: data.generated_at || new Date().toISOString(),
    }));
  }

  STATE.sections = data.sections || [];

  const seen = new Set();
  STATE.playlist = [];
  for (const section of STATE.sections) {
    for (const item of section.items || []) {
      const k = `${item.kind}:${item.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ITEM_CACHE.set(k, item);
      // Only singles can be auto-played; albums need a track pick.
      if (item.kind === "single" &&
          item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320)) {
        STATE.playlist.push(item);
      }
    }
  }

  app.append(el("section", { class: "section", id: "searchResults", hidden: "" }));
  for (const section of STATE.sections) app.append(renderSection(section));
}

// ---------------- Detail sheet ---------------------------------------------

async function openSheet(item) {
  fillSheet(item);
  const dlg = $("#detailSheet");
  // Use show() not showModal() — non-modal keeps the dialog out of the
  // browser's "top layer" so the mini-player and now-playing overlay
  // can sit above it via z-index when audio is playing.
  if (!dlg.open) dlg.show();
  const bd = $("#sheetBackdrop");
  if (bd) bd.hidden = false;
  document.body.classList.add("has-sheet");

  // For albums, ALWAYS hydrate from item file (we need the track list).
  // For singles, hydrate only if mp3 URLs are missing.
  const needHydrate = item.kind === "album" ||
                      !item.mp3 || !(item.mp3.stream || item.mp3.kbps128);
  if (needHydrate) {
    const full = await loadItemDetail(item.kind, item.id);
    if (full && $("#detailSheet").open) fillSheet(full);
  }
}

function fillSheet(item) {
  const isAlbum = item.kind === "album";
  $("#sheetCover").src = safeUrl(item.cover) || "";
  $("#sheetCover").alt = `${item.title} cover`;
  $("#sheetKicker").textContent = isAlbum ? "Album / EP" : "Single Track";
  $("#sheetTitle").textContent = item.title || "Untitled";
  // Make the artist name a clickable link to the artist page.
  const artistEl = $("#sheetArtist");
  const artistName = (item.artist || "").trim();
  artistEl.innerHTML = "";
  if (artistName) {
    const link = el("a", {
      href: `#artist/${encodeURIComponent(artistName)}`,
      class: "sheet__artist-link",
      onclick: (e) => {
        e.preventDefault();
        closeSheet();
        openArtist(artistName);
      },
    }, artistName);
    artistEl.append(link);
  } else {
    artistEl.textContent = isAlbum ? "Various Artists" : "—";
  }

  const facts = $("#sheetFacts");
  facts.innerHTML = "";

  // Helper: parse a "MM:SS" or "HH:MM:SS" string into seconds.
  // Returns 0 for unparseable input.
  const parsePlaytimeSec = (s) => {
    if (!s) return 0;
    const m = String(s).trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return 0;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = m[3] ? parseInt(m[3], 10) : null;
    return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  };
  const formatPlaytimeSec = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Compute the album's total playtime.
  //
  // djjohal's per-track detail page lists a "Playtime" field. Empirically,
  // even when this value is identical across all tracks in an album, it
  // represents the PER-TRACK length, not the album total (e.g. a 13-track
  // "full album" with 02:45 on every child would otherwise be under 3
  // minutes total, which is nonsense). So we always sum the populated
  // child playtimes. If the album row itself stores a playtime, that
  // wins — it's the most authoritative value.
  const computeAlbumPlaytime = () => {
    if (item.playtime) return item.playtime;
    if (!Array.isArray(item.album_tracks) || !item.album_tracks.length) return "";
    let totalSec = 0;
    let counted = 0;
    for (const t of item.album_tracks) {
      const cached = ITEM_CACHE.get(`single:${t.id}`);
      if (cached && cached.playtime) {
        const sec = parsePlaytimeSec(cached.playtime);
        if (sec > 0) {
          totalSec += sec;
          counted++;
        }
      }
    }
    if (!counted) return "";
    return formatPlaytimeSec(totalSec);
  };

  let displayPlaytime = isAlbum ? computeAlbumPlaytime() : (item.playtime || "");

  // Albums don't have a per-track play count — that field is meaningful
  // only for singles, so hide it on the album sheet.
  const rows = isAlbum
    ? [
        ["Music",    item.music],
        ["Lyrics",   item.lyrics],
        ["Label",    item.label],
        ["Released", item.released],
        ["Playtime", displayPlaytime],
      ]
    : [
        ["Music",    item.music],
        ["Lyrics",   item.lyrics],
        ["Label",    item.label],
        ["Released", item.released],
        ["Playtime", item.playtime],
        ["Plays",    item.plays],
      ];
  for (const [k, v] of rows) {
    const dd = el("dd", { "data-fact": k.toLowerCase() }, safeText(v));
    facts.append(el("dt", {}, k));
    facts.append(dd);
  }

  // For albums where we don't yet have any child playtimes, fetch detail
  // for ALL children (parallel) and recompute the playtime once they
  // arrive. Updates the DOM cell in place.
  if (isAlbum && Array.isArray(item.album_tracks) && item.album_tracks.length) {
    const allCached = item.album_tracks.every(t => {
      const c = ITEM_CACHE.get(`single:${t.id}`);
      return c && c.playtime;
    });
    if (!allCached) {
      (async () => {
        // Fetch all children in parallel; loadItemDetail caches into ITEM_CACHE.
        await Promise.all(
          item.album_tracks.map(t => loadItemDetail("single", t.id).catch(() => null))
        );
        if (!$("#detailSheet").open) return;
        const fresh = computeAlbumPlaytime();
        if (fresh) {
          const cell = $('#sheetFacts dd[data-fact="playtime"]');
          if (cell) cell.textContent = fresh;
        }
      })();
    }
  }

  const playBtn = $("#sheetPlayBtn");
  const ytBtn   = $("#sheetYtBtn");
  const tracksHost = $("#sheetTracks");

  // YouTube button — always populated. Both singles and albums use the
  // resolved watch URL when the scraper has captured one (item.youtube_url),
  // and fall back to a search URL otherwise. The fallback adds "full album"
  // for album searches so YouTube's first result is more likely to be the
  // full album rather than a single track.
  const ytUrl = isAlbum
    ? (item.youtube_url && item.youtube_url.startsWith("https://")
        ? item.youtube_url
        : (() => {
            const parts = [item.artist, item.title].map(s => (s || "").trim()).filter(Boolean);
            const q = encodeURIComponent([...parts, "full album"].join(" "));
            return parts.length ? `https://www.youtube.com/results?search_query=${q}` : "";
          })())
    : youtubeSearchUrl(item);

  if (ytUrl) {
    ytBtn.href = ytUrl;
    ytBtn.style.display = "";
  } else {
    ytBtn.style.display = "none";
  }

  if (isAlbum) {
    // Albums: hide the Play button, show track list (if we have it).
    playBtn.style.display = "none";
    renderAlbumTracks(item, tracksHost);
  } else {
    // Singles: show Play button, no track list.
    playBtn.style.display = "";
    playBtn.onclick = (e) => {
      e.preventDefault();
      // Synchronous fast path — see card playback for why this matters
      // (Android user-gesture chain breaks across awaits, causing the
      // browser to navigate to the MP3 URL and download instead of stream).
      if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320 || item.mp3.kbps48)) {
        STATE.albumContext = null;
        playItem(item);
        closeSheet();
        return;
      }
      (async () => {
        const full = await ensureFullItem(item);
        if (full && full.mp3 && (full.mp3.stream || full.mp3.kbps128 || full.mp3.kbps320 || full.mp3.kbps48)) {
          STATE.albumContext = null;
          playItem(full);
        }
        closeSheet();
      })();
    };
    const hasStream = item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320 || item.mp3.kbps48);
    playBtn.disabled = !hasStream;
    playBtn.style.opacity = hasStream ? "1" : ".4";
    tracksHost.hidden = true;
    tracksHost.innerHTML = "";
  }

  // Downloads
  const dl = $("#sheetDownloads");
  dl.innerHTML = "";
  const cleanName = sanitizeFilename(`${item.artist || ""} - ${item.title || "track"}`.trim());
  const links = [
    ["MP3 · 320 kbps (HD)",  item.mp3?.kbps320, "320", `${cleanName}.mp3`],
    ["MP3 · 128 kbps",       item.mp3?.kbps128, "128", `${cleanName}.mp3`],
    ["MP3 · 48 kbps (low)",  item.mp3?.kbps48,  "48",  `${cleanName}.mp3`],
    ["ZIP · 320 kbps",       item.mp3?.zip320,  "ZIP", `${cleanName}.zip`],
    ["ZIP · 128 kbps",       item.mp3?.zip128,  "ZIP", `${cleanName}.zip`],
  ].filter(([, u]) => !!u);

  if (links.length) {
    dl.append(el("h3", {}, "Download"));
    for (const [label, url, tag, filename] of links) {
      dl.append(el("a", {
        class: "dl-row",
        href: safeUrl(url),
        download: filename,
        target: "_blank",
        rel: "noopener",
      }, el("span", {}, label), el("span", {}, tag)));
    }
  }
}

function renderAlbumTracks(album, host) {
  host.innerHTML = "";
  const tracks = album.album_tracks || [];
  if (tracks.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.append(el("h3", {}, "Tracks"));

  const list = el("div", { class: "tracklist" });
  // If the currently playing track is one of these, mark it.
  const playingTrackId = (STATE.currentItem && STATE.albumContext &&
                          STATE.albumContext.id === album.id) ? STATE.currentItem.id : null;

  // Helper that actually plays a track once we have its full detail.
  // Builds the album's playlist context too.
  const playAlbumTrack = (full, btn) => {
    STATE.playlist = [];
    for (const tr of tracks) {
      const cached = ITEM_CACHE.get(`single:${tr.id}`);
      if (cached && cached.mp3 && (cached.mp3.stream || cached.mp3.kbps128 || cached.mp3.kbps320)) {
        STATE.playlist.push(cached);
      }
    }
    if (!STATE.playlist.find(p => p.id === full.id && p.kind === "single")) {
      STATE.playlist.push(full);
    }
    STATE.albumContext = album;
    playItem(full);
    $$(".track.is-playing", host).forEach(e => e.classList.remove("is-playing"));
    btn.classList.add("is-playing");
  };

  tracks.forEach((t, idx) => {
    const btn = el("button", {
      class: "track" + (playingTrackId === t.id ? " is-playing" : ""),
      type: "button",
      "data-track-id": t.id,
      onclick: (e) => {
        e.preventDefault();
        // Synchronous fast path: if this track's detail is already cached
        // with a streamable URL, play it right now. Same Android-autoplay
        // concern as on the homepage cards — an `await` here would break
        // the user-gesture chain and the OS would download instead.
        const cached = ITEM_CACHE.get(`single:${t.id}`);
        if (cached && cached.mp3 && (cached.mp3.stream || cached.mp3.kbps128 || cached.mp3.kbps320)) {
          playAlbumTrack(cached, btn);
          return;
        }
        // Slow path: fetch detail then play. On Android this may not auto-
        // start; that's OK because the audio element still loads and the
        // user can tap Play.
        (async () => {
          const full = await loadItemDetail("single", t.id);
          if (full && full.mp3 && (full.mp3.stream || full.mp3.kbps128 || full.mp3.kbps320)) {
            playAlbumTrack(full, btn);
            return;
          }
          // Track not yet harvested.
          const zipUrl = album.mp3?.zip320 || album.mp3?.zip128;
          if (zipUrl) {
            if (confirm(
              "This track isn't streamable yet — the scraper will pick it up on a later run.\n\n" +
              "Download the whole album zip in the meantime?"
            )) {
              window.open(safeUrl(zipUrl), "_blank", "noopener");
            }
          } else {
            alert("Track details not yet harvested. The next scrape will pick it up.");
          }
        })();
      },
    },
      el("span", { class: "track__num" }, String(idx + 1).padStart(2, "0")),
      el("span", { class: "track__title" }, t.title || "Untitled"),
      el("span", { class: "track__play", html: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>` }),
    );
    list.append(btn);
  });
  host.append(list);
}

function closeSheet() {
  const dlg = $("#detailSheet");
  if (dlg.open) dlg.close();
  const bd = $("#sheetBackdrop");
  if (bd) bd.hidden = true;
  document.body.classList.remove("has-sheet");
}

// Swipe-to-dismiss on the detail sheet (mobile/touch only).
//
// The dialog itself is the mobile scroll container (see styles.css mobile
// rules — overflow-y: auto is on .sheet, not .sheet__inner). So a downward
// finger drag should normally scroll the content. Only when the dialog is
// already at scrollTop=0 do we treat a downward drag as a dismiss gesture.
// Rightward swipes (the close button is in the top-right corner) always
// trigger dismissal — there's no horizontal scroll to conflict with.
(function setupSheetSwipeDismiss() {
  const sheet = $("#detailSheet");
  if (!sheet) return;
  const THRESHOLD = 10;
  const DISMISS_DISTANCE = 110;
  let startX = null, startY = null, startScrollTop = 0;
  let dragging = false, direction = null, startedOnControl = false;

  const isOnControl = (target) => {
    if (!target || !target.closest) return false;
    return !!target.closest(
      "button, a, input, .track, .dl-row, .sheet__close, .tracklist, .sheet__downloads"
    );
  };

  const reset = () => {
    sheet.style.transform = "";
    sheet.style.transition = "";
    startX = null; startY = null;
    dragging = false; direction = null;
  };

  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    startY = t.clientY;
    startScrollTop = sheet.scrollTop;
    dragging = false;
    direction = null;
    startedOnControl = isOnControl(e.target);
  };

  const onMove = (e) => {
    if (startX == null) return;
    if (startedOnControl) return;  // don't hijack taps on tracks/downloads

    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!dragging) {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < THRESHOLD && absY < THRESHOLD) return;
      // Down only counts when we started at the top of the sheet.
      // Otherwise the user is just scrolling.
      if (absY >= absX && dy > 0 && startScrollTop <= 0) {
        direction = "down";
      } else if (absX > absY && dx > 0) {
        // Right swipe always allowed.
        direction = "right";
      } else {
        startX = null; startY = null;
        return;
      }
      dragging = true;
      sheet.style.transition = "";
    }

    if (direction === "down" && dy > 0) {
      sheet.style.transform = `translateY(${dy}px)`;
    } else if (direction === "right" && dx > 0) {
      sheet.style.transform = `translateX(${dx}px)`;
    }
  };

  const onEnd = (e) => {
    if (startX == null) return;
    if (!dragging) { reset(); return; }
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    sheet.style.transition = "transform .2s cubic-bezier(.2,.7,.2,1)";

    const shouldClose =
      (direction === "down"  && dy >  DISMISS_DISTANCE) ||
      (direction === "right" && dx >  DISMISS_DISTANCE);

    if (shouldClose) {
      sheet.style.transform = direction === "down"
        ? "translateY(100%)"
        : "translateX(100%)";
      setTimeout(() => {
        sheet.style.transform = "";
        sheet.style.transition = "";
        closeSheet();
      }, 200);
      startX = null; startY = null;
      dragging = false; direction = null;
    } else {
      sheet.style.transform = "";
      setTimeout(() => {
        sheet.style.transition = "";
        startX = null; startY = null;
        dragging = false; direction = null;
      }, 220);
    }
  };

  sheet.addEventListener("touchstart", onStart, { passive: true });
  sheet.addEventListener("touchmove",  onMove,  { passive: true });
  sheet.addEventListener("touchend",   onEnd,   { passive: true });
  sheet.addEventListener("touchcancel", onEnd,  { passive: true });
})();

// ---------------- Player ---------------------------------------------------

const audio = $("#audio");

function playItem(item) {
  const stream = item.mp3?.stream || item.mp3?.kbps128 || item.mp3?.kbps320 || item.mp3?.kbps48;
  if (!stream) {
    alert("No playable audio for this track.");
    return;
  }

  STATE.currentIndex = STATE.playlist.findIndex(p => p.id === item.id && p.kind === item.kind);
  STATE.currentItem = item;

  // If an album sheet is open AND the playing track belongs to that album,
  // move the .is-playing highlight onto the right row. Lets the user
  // visually track auto-advance through prev/next without re-opening the
  // sheet.
  if ($("#detailSheet").open) {
    const tracksHost = $("#sheetTracks");
    if (tracksHost) {
      $$(".track.is-playing", tracksHost).forEach(e => e.classList.remove("is-playing"));
      const match = tracksHost.querySelector(`.track[data-track-id="${item.id}"]`);
      if (match) match.classList.add("is-playing");
    }
  }

  $("#player").hidden = false;
  document.body.classList.add("has-player");

  const cover = safeUrl(item.cover) || "";
  $("#playerCover").src = cover;
  $("#playerTitle").textContent = item.title || "Untitled";
  $("#playerArtist").textContent = item.artist || "";
  $("#playerArtist").dataset.artist = item.artist || "";

  $("#npCover").src = cover;
  $("#npTitle").textContent = item.title || "Untitled";
  $("#npArtist").textContent = item.artist || "";
  $("#npArtist").dataset.artist = item.artist || "";

  // If now-playing overlay is open, refresh its YouTube link too.
  const npYt = $("#npYtBtn");
  if (npYt) {
    const ytUrl = youtubeSearchUrl(item);
    if (ytUrl) { npYt.href = ytUrl; npYt.style.display = ""; }
    else npYt.style.display = "none";
  }

  audio.preload = "auto";
  audio.src = safeUrl(stream);
  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(err => {
      // Common cause on Android: NotAllowedError if play() was deferred
      // past the user-gesture window. Don't navigate to the URL (that
      // would download); leave audio element loaded so user can tap
      // the play button manually.
      console.warn("Playback failed:", err && err.name, err && err.message);
    });
  }

  // Tell the OS (car infotainment, lock screen, BT widgets) what's playing.
  updateMediaSession(item);
  // Push position state with a few staggered delays. Android's BT/AVRCP
  // bridge sometimes drops the first one if it fires before the BT
  // connection has caught up to the track change. The loadedmetadata
  // event handler will push again once duration is known.
  setTimeout(updateMediaSessionPosition, 300);
  setTimeout(updateMediaSessionPosition, 1500);
}

// ---------------- MediaSession (for Bluetooth / car / lock screen) ---------
// The MediaSession API publishes "what's playing" to the OS so external
// surfaces — your Tesla's media widget, Android Auto, iOS lock screen,
// Chromecast, etc. — show the right title/artist/cover and route their
// transport buttons (prev/next/play/pause/seek) back here.

const ORIGINAL_TITLE = document.title;

/**
 * Build a CORS-friendly artwork URL for MediaSession.
 *
 * Problem: djjohal's image host (lq.djjohal.com) doesn't send
 * Access-Control-Allow-Origin headers. Chrome on Android silently rejects
 * cross-origin MediaSession artwork without CORS, so the Tesla / Android
 * Auto / lock-screen widget shows a music-note placeholder instead of the
 * cover.
 *
 * Fix: route through images.weserv.nl — a free public image proxy with
 * CORS enabled.
 *
 * Why no resize: djjohal already serves from lq.djjohal.com (their LOW-
 * quality CDN), so covers are already a few hundred pixels. Each ?w=N
 * value is a different cache key on weserv — passing 5 sizes meant 5
 * separate fetches that didn't benefit from each other. A single URL
 * with no transform = one fast cached fetch.
 */
function corsArtworkUrl(rawUrl) {
  if (!rawUrl) return "";
  const stripped = rawUrl.replace(/^https?:\/\//, "");
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}`;
}

function updateMediaSession(item) {
  if (!("mediaSession" in navigator)) return;

  const title  = item.title  || "Untitled";
  const artist = item.artist || "";
  // If this track is part of an album we're playing through, surface the
  // album name as "album" for the OS UI.
  const albumName = (STATE.albumContext && STATE.albumContext.title) || "";

  // Replace the page title while playing. Tesla and many other surfaces
  // fall back to the page title if MediaSession isn't honored — this way
  // they at least show the song name instead of "Saadi Awaaz · Punjabi Music".
  document.title = artist ? `${title} — ${artist}` : title;

  try {
    const cover = item.cover || "";
    // ONE artwork entry — Android picks it regardless of declared size.
    // Declaring multiple sizes meant multiple fetches that competed and
    // sometimes none completed in time for the BT bridge to relay.
    const artwork = cover ? [
      { src: corsArtworkUrl(cover), sizes: "512x512", type: "image/jpeg" },
    ] : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: albumName,
      artwork,
    });
  } catch (e) {
    console.warn("MediaSession metadata failed:", e);
  }
}

function clearMediaSession() {
  document.title = ORIGINAL_TITLE;
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    } catch {}
  }
}

function updateMediaSessionPosition() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  const dur = audio.duration;
  const cur = audio.currentTime;
  // Skip if duration isn't known yet (Infinity, NaN, or 0). Without a
  // valid duration, Tesla/Android Auto can't render a scrub bar at all.
  if (!Number.isFinite(dur) || dur <= 0) return;
  const position = Math.max(0, Math.min(Number.isFinite(cur) ? cur : 0, dur));
  const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
    ? audio.playbackRate
    : 1;
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      position,
      playbackRate: rate,
    });
  } catch (e) {
    // Some browsers throw if duration is Infinity or position > duration.
    // Silently ignore — non-critical.
  }
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;

  // Helper that swallows errors for handlers the browser doesn't support
  // (e.g. older Safari doesn't have "seekto").
  const setHandler = (action, fn) => {
    try { ms.setActionHandler(action, fn); }
    catch (e) { /* unsupported on this platform */ }
  };

  setHandler("play",  () => { if (audio.src) audio.play().catch(() => {}); });
  setHandler("pause", () => { if (audio.src) audio.pause(); });
  setHandler("previoustrack", () => { playPrev(); });
  setHandler("nexttrack",     () => { playNext(); });

  // Small skip handlers — Tesla and most car surfaces show 10/30s skip
  // buttons. These give them something to do.
  setHandler("seekbackward", (d) => {
    if (!audio.src) return;
    const off = (d && d.seekOffset) || 10;
    audio.currentTime = Math.max(0, audio.currentTime - off);
    updateMediaSessionPosition();
  });
  setHandler("seekforward", (d) => {
    if (!audio.src) return;
    const off = (d && d.seekOffset) || 10;
    audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + off);
    updateMediaSessionPosition();
  });

  // The big one — lets the car's progress bar tap work. Without this,
  // dragging the Tesla scrub bar does nothing.
  setHandler("seekto", (d) => {
    if (!audio.src || !d || typeof d.seekTime !== "number") return;
    if (d.fastSeek && "fastSeek" in audio) {
      audio.fastSeek(d.seekTime);
    } else {
      audio.currentTime = d.seekTime;
    }
    updateMediaSessionPosition();
  });

  setHandler("stop", () => {
    audio.pause();
    audio.currentTime = 0;
  });
}

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) audio.play();
  else audio.pause();
}

function playPrev() {
  if (STATE.playlist.length === 0) return;
  let i = STATE.currentIndex - 1;
  if (i < 0) i = STATE.playlist.length - 1;
  const candidate = STATE.playlist[i];
  // Sync fast path: playlists are built from items that already have
  // streams, so this is the typical case.
  if (candidate && candidate.mp3 && (candidate.mp3.stream || candidate.mp3.kbps128 || candidate.mp3.kbps320)) {
    playItem(candidate);
    return;
  }
  // Slow path
  (async () => {
    const full = await ensureFullItem(candidate);
    if (full) playItem(full);
  })();
}

function playNext() {
  if (STATE.playlist.length === 0) return;
  let i;
  if (STATE.shuffle && STATE.playlist.length > 1) {
    // Pick a random index that isn't the current one and ideally isn't
    // in the recent shuffle history (last 30% of playlist or last 8
    // tracks, whichever is smaller).
    const avoid = new Set(STATE.shuffleHistory);
    avoid.add(STATE.currentIndex);
    const candidates = [];
    for (let k = 0; k < STATE.playlist.length; k++) {
      if (!avoid.has(k)) candidates.push(k);
    }
    // If history has consumed all candidates, reset.
    if (!candidates.length) {
      STATE.shuffleHistory = [];
      i = (STATE.currentIndex + 1) % STATE.playlist.length;
    } else {
      i = candidates[Math.floor(Math.random() * candidates.length)];
    }
    const histCap = Math.min(8, Math.max(1, Math.floor(STATE.playlist.length * 0.3)));
    STATE.shuffleHistory.push(i);
    if (STATE.shuffleHistory.length > histCap) STATE.shuffleHistory.shift();
  } else {
    i = STATE.currentIndex + 1;
    if (i >= STATE.playlist.length) i = 0;
  }
  const candidate = STATE.playlist[i];
  if (candidate && candidate.mp3 && (candidate.mp3.stream || candidate.mp3.kbps128 || candidate.mp3.kbps320)) {
    playItem(candidate);
    return;
  }
  (async () => {
    const full = await ensureFullItem(candidate);
    if (full) playItem(full);
  })();
}

// When the user navigates to a context that has a different playable
// list (artist page, search results, browse view), call this to make
// auto-advance follow THAT list instead of the homepage list.
//
// Items can be slim (from search.json) or full — both shapes are fine.
// We just need `kind`, `id`, and either an mp3 URL or some way to
// fetch one when this track plays.
function setPlaylistContext(items, albumCtx = null) {
  if (!Array.isArray(items)) return;
  STATE.playlist = items.filter(it => it && it.kind === "single");
  STATE.currentIndex = STATE.currentItem
    ? STATE.playlist.findIndex(p => p.id === STATE.currentItem.id && p.kind === STATE.currentItem.kind)
    : -1;
  STATE.albumContext = albumCtx;
  STATE.shuffleHistory = [];
}

function setShuffle(on) {
  STATE.shuffle = !!on;
  STATE.shuffleHistory = [];
  localStorage.setItem("sa_shuffle_v1", on ? "1" : "0");
  // Reflect in UI
  for (const btn of $$(".shuffle-toggle")) {
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function setPlayingUI(isPlaying) {
  $("#iconPlay").style.display    = isPlaying ? "none" : "";
  $("#iconPause").style.display   = isPlaying ? "" : "none";
  $("#npIconPlay").style.display  = isPlaying ? "none" : "";
  $("#npIconPause").style.display = isPlaying ? "" : "none";
}

audio.addEventListener("play",  () => {
  setPlayingUI(true);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  updateMediaSessionPosition();
});
audio.addEventListener("pause", () => {
  setPlayingUI(false);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  updateMediaSessionPosition();
});
audio.addEventListener("ended", playNext);
// `loadedmetadata` fires when duration becomes known — push position state so
// the car widget gets the right total length right after a track change.
audio.addEventListener("loadedmetadata", updateMediaSessionPosition);
audio.addEventListener("durationchange", updateMediaSessionPosition);
audio.addEventListener("seeked", updateMediaSessionPosition);

audio.addEventListener("timeupdate", () => {
  const cur = audio.currentTime || 0;
  const tot = audio.duration || 0;
  const curStr = fmtTime(cur);
  const totStr = fmtTime(tot);
  $("#curTime").textContent   = curStr;
  $("#totTime").textContent   = totStr;
  $("#npCurTime").textContent = curStr;
  $("#npTotTime").textContent = totStr;
  const pct = tot > 0 ? (cur / tot) * 100 : 0;
  $("#scrubFill").style.width   = `${pct}%`;
  $("#npScrubFill").style.width = `${pct}%`;
  // Throttle: only push position to MediaSession every ~1s, since timeupdate
  // fires ~4x/sec and the OS will smooth-interpolate between updates.
  if (!updateMediaSessionPosition._last ||
      Date.now() - updateMediaSessionPosition._last > 900) {
    updateMediaSessionPosition._last = Date.now();
    updateMediaSessionPosition();
  }
});

$("#btnPlay").addEventListener("click", togglePlay);
$("#btnPrev").addEventListener("click", playPrev);
$("#btnNext").addEventListener("click", playNext);
$("#btnClose").addEventListener("click", () => {
  audio.pause();
  audio.src = "";
  $("#player").hidden = true;
  document.body.classList.remove("has-player");
  closeNowPlaying();
  clearMediaSession();
});

/**
 * Open the appropriate detail sheet for whatever is currently playing.
 * If we're playing a track from an album, re-open the album sheet (with
 * the current track highlighted). Otherwise open the single's detail.
 */
function openCurrentContext() {
  if (STATE.albumContext) {
    openSheet(STATE.albumContext);
  } else if (STATE.currentItem) {
    openSheet(STATE.currentItem);
  }
}

$("#npPlay").addEventListener("click", togglePlay);
$("#npPrev").addEventListener("click", playPrev);
$("#npNext").addEventListener("click", playNext);
const _npShuffleBtn = $("#npShuffle");
if (_npShuffleBtn) {
  _npShuffleBtn.addEventListener("click", () => setShuffle(!STATE.shuffle));
  // Initialize button state from persisted localStorage value.
  setShuffle(STATE.shuffle);
}
$("#npSource").addEventListener("click", () => {
  closeNowPlaying();
  openCurrentContext();
});

// Desktop: clicking the player's title/meta opens the album sheet (or the
// single's detail). The cover-area `btnExpand` still opens the now-playing
// overlay on touch devices.
$("#playerTitle").addEventListener("click", (e) => {
  e.stopPropagation();
  openCurrentContext();
});
$("#playerArtist").addEventListener("click", (e) => {
  e.stopPropagation();
  const name = e.currentTarget.dataset.artist;
  if (name) openArtist(name);
  else openCurrentContext();
});
$("#npArtist").addEventListener("click", (e) => {
  e.stopPropagation();
  const name = e.currentTarget.dataset.artist;
  if (name) {
    closeNowPlaying();
    openArtist(name);
  }
});

function seekFromEvent(e, scrubEl) {
  if (!audio.duration) return;
  const r = scrubEl.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX);
  const pct = (x - r.left) / r.width;
  audio.currentTime = Math.max(0, Math.min(audio.duration, pct * audio.duration));
}
$("#scrub").addEventListener("click",   (e) => seekFromEvent(e, e.currentTarget));
$("#npScrub").addEventListener("click", (e) => seekFromEvent(e, e.currentTarget));

// ---------------- Now-playing overlay --------------------------------------

const nowPlaying = $("#nowPlaying");

function openNowPlaying() {
  if (!STATE.currentItem) return;
  $("#npCover").src    = safeUrl(STATE.currentItem.cover) || "";
  $("#npTitle").textContent  = STATE.currentItem.title || "Untitled";
  $("#npArtist").textContent = STATE.currentItem.artist || "";
  const npYt = $("#npYtBtn");
  const ytUrl = youtubeSearchUrl(STATE.currentItem);
  if (npYt) {
    if (ytUrl) {
      npYt.href = ytUrl;
      npYt.style.display = "";
    } else {
      npYt.style.display = "none";
    }
  }
  nowPlaying.hidden = false;
  nowPlaying.setAttribute("aria-hidden", "false");
  nowPlaying.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeNowPlaying() {
  nowPlaying.classList.remove("is-open");
  nowPlaying.setAttribute("aria-hidden", "true");
  setTimeout(() => { nowPlaying.hidden = true; }, 320);
  document.body.style.overflow = "";
}

$("#btnExpand").addEventListener("click", () => {
  if (document.body.classList.contains("is-touch")) {
    openNowPlaying();
  } else {
    openCurrentContext();
  }
});
$("#btnCollapse").addEventListener("click", closeNowPlaying);

(function setupSwipeDismiss() {
  // Track raw touch state.
  let startX = null;
  let startY = null;
  let dragging = false;        // committed to a drag (past the threshold)
  let direction = null;        // 'down' | 'left'
  let startedOnControl = false;

  const THRESHOLD = 10;        // px to move before committing to a drag
  const DISMISS_DISTANCE = 100;  // px to actually close the overlay

  const isOnControl = (target) => {
    // Don't start a drag if the touch began on something interactive:
    // play/prev/next buttons, the progress bar (scrubbing), close chevron,
    // details button, YouTube link. Without this, scrubbing would also
    // drag the overlay away.
    if (!target || !target.closest) return false;
    return !!target.closest(
      "button, a, input, .scrub, .np__btn, .np__chev, .np__details, .np__yt, .np__source"
    );
  };

  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    startY = t.clientY;
    dragging = false;
    direction = null;
    startedOnControl = isOnControl(e.target);
  };

  const onMove = (e) => {
    if (startX == null) return;
    if (startedOnControl) return;  // never hijack a scrub/button touch

    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!dragging) {
      // Decide whether this is actually a drag, and which way.
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < THRESHOLD && absY < THRESHOLD) return;
      // Direction = the dominant axis. Down or left only — swipes
      // up/right don't dismiss.
      if (absY >= absX && dy > 0)       direction = "down";
      else if (absX > absY && dx < 0)   direction = "left";
      else { startX = null; startY = null; return; }  // wrong way, ignore
      dragging = true;
    }

    if (direction === "down" && dy > 0) {
      nowPlaying.style.transform = `translateY(${dy}px)`;
    } else if (direction === "left" && dx < 0) {
      nowPlaying.style.transform = `translateX(${dx}px)`;
    }
  };

  const onEnd = (e) => {
    if (startX == null) { return; }
    if (!dragging) {  // never moved past threshold — let it be a tap
      startX = null; startY = null;
      return;
    }
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    nowPlaying.style.transition = "transform .2s cubic-bezier(.2,.7,.2,1)";

    const shouldClose =
      (direction === "down" && dy > DISMISS_DISTANCE) ||
      (direction === "left" && dx < -DISMISS_DISTANCE);

    if (shouldClose) {
      // Animate the overlay out in the direction the user pushed it.
      nowPlaying.style.transform = direction === "down"
        ? "translateY(100%)"
        : "translateX(-100%)";
      setTimeout(() => {
        nowPlaying.style.transform = "";
        nowPlaying.style.transition = "";
        closeNowPlaying();
      }, 200);
    } else {
      // Snap back.
      nowPlaying.style.transform = "";
      setTimeout(() => { nowPlaying.style.transition = ""; }, 220);
    }

    startX = null;
    startY = null;
    dragging = false;
    direction = null;
  };

  nowPlaying.addEventListener("touchstart", onStart, { passive: true });
  nowPlaying.addEventListener("touchmove",  onMove,  { passive: true });
  nowPlaying.addEventListener("touchend",   onEnd,   { passive: true });
  nowPlaying.addEventListener("touchcancel", onEnd,  { passive: true });
})();

// ---------------- Search ---------------------------------------------------

async function ensureSearchIndex() {
  if (STATE.searchIndex) return STATE.searchIndex;
  if (STATE.searchLoading) return null;
  STATE.searchLoading = true;
  try {
    const res = await fetch(`data/search.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    STATE.searchIndex = data.items || [];
  } catch (e) {
    console.warn("Search index unavailable:", e);
    STATE.searchIndex = [];
  } finally {
    STATE.searchLoading = false;
  }
  return STATE.searchIndex;
}

function expandSlim(slim) {
  return {
    kind:  slim.k === "a" ? "album" : "single",
    id:    slim.i,
    title: slim.t || "",
    artist:slim.a || "",
    music: slim.m || "",
    label: slim.l || "",
    released: slim.r || "",
    cover: "",
    mp3:   { stream: "", kbps320: "", kbps128: "", kbps48: "", zip320: "", zip128: "" },
  };
}

// ---------------- Artist pages ---------------------------------------------
//
// Tap an artist's name anywhere (album sheet, now-playing overlay, mini-player)
// to open that artist's page: all their singles + albums, newest first.
//
// Data: built lazily from search.json the first time the Artists view is
// requested. We group the 5,595 items by lowercase artist name to be
// resilient to djjohal's casing inconsistencies, but display the most
// common-case form so e.g. "Diljit Dosanjh" doesn't become "DILJIT DOSANJH"
// just because one row had it caps-lock'd.

function normalizeArtistKey(name) {
  return (name || "").trim().toLowerCase();
}

async function ensureArtistIndex() {
  if (STATE.artistIndex) return STATE.artistIndex;
  const items = await ensureSearchIndex();
  if (!items) return null;

  // Placeholders djjohal uses when no real artist is credited — these
  // aren't real artists, so excluding them from the browser keeps the
  // list useful. Includes common spellings/abbreviations.
  const PLACEHOLDER = new Set([
    "various", "various artists", "v.a.", "v/a", "va",
    "unknown", "unknown artist", "n/a",
  ]);

  /** @type {Map<string, { displayName: string, items: any[] }>} */
  const idx = new Map();
  for (const s of items) {
    const raw = (s.a || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (PLACEHOLDER.has(key)) continue;
    let entry = idx.get(key);
    if (!entry) {
      entry = { displayName: raw, items: [] };
      idx.set(key, entry);
    } else {
      // Prefer the casing that appears most "naturally" — pick the one
      // with mixed case over all-caps or all-lowercase.
      const cur = entry.displayName;
      const looksTitleCase = (s) => s === s.replace(/\b\w/g, c => c.toUpperCase());
      if (looksTitleCase(raw) && !looksTitleCase(cur)) entry.displayName = raw;
    }
    entry.items.push(s);
  }
  STATE.artistIndex = idx;
  return idx;
}

/** Numeric desc by id — newer djjohal items have higher numeric IDs. */
function sortNewestFirst(arr) {
  return arr.slice().sort((a, b) => {
    const ai = parseInt(a.i || a.id || "0", 10);
    const bi = parseInt(b.i || b.id || "0", 10);
    return bi - ai;
  });
}

async function openArtist(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  // Update the URL so back/forward, copy/paste, and bookmarks work.
  const hash = `#artist/${encodeURIComponent(trimmed)}`;
  if (location.hash !== hash) {
    history.pushState(null, "", hash);
  }
  await renderArtistView(trimmed);
}

async function renderArtistView(name) {
  STATE.view = `artist:${name}`;
  const app = $("#app");
  // Build the page skeleton immediately so it feels responsive.
  app.innerHTML = "";
  const back = el("button", {
    class: "artist__back",
    type: "button",
    "aria-label": "Back",
    onclick: () => {
      // Send the user to the homepage instead of bouncing through
      // hash history (which can land us back in this same view).
      goHome();
    },
  },
    el("span", { html: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>` }),
    "Back",
  );
  const header = el("section", { class: "artist__header" },
    back,
    el("p", { class: "artist__kicker" }, "Artist"),
    el("h1", { class: "artist__name" }, name),
    el("p", { class: "artist__count", id: "artistCount" }, "Loading…"),
  );
  app.append(header);

  const singlesHost = el("section", { class: "section", id: "artist_singles", hidden: "" });
  const albumsHost  = el("section", { class: "section", id: "artist_albums",  hidden: "" });
  app.append(singlesHost, albumsHost);

  // Scroll to top in case we were deep in another section.
  window.scrollTo({ top: 0, behavior: "auto" });

  const idx = await ensureArtistIndex();
  if (!idx) {
    $("#artistCount").textContent = "Couldn't load library";
    return;
  }
  const entry = idx.get(normalizeArtistKey(name));
  if (!entry) {
    $("#artistCount").textContent = "No songs found for this artist";
    return;
  }

  // Use the canonical display name we picked when building the index.
  $(".artist__name", header).textContent = entry.displayName;

  // Keep the raw slim items here; sort selection re-derives the
  // singles/albums arrays from this list.
  const rawItems = entry.items.slice();

  // ----- Sort dropdown
  const sortOptions = [
    { value: "newest",  label: "Newest first" },
    { value: "oldest",  label: "Oldest first" },
    { value: "title",   label: "Title A → Z"   },
    { value: "plays",   label: "Most played"   },  // best-effort
  ];
  // Persist user's last sort choice for the artist page.
  let currentSort = localStorage.getItem("sa_artist_sort_v1") || "newest";
  if (!sortOptions.find(s => s.value === currentSort)) currentSort = "newest";

  const sortBar = el("div", { class: "artist__sortbar" });
  const sortLabel = el("label", { class: "artist__sortlabel", for: "artistSortSel" }, "Sort:");
  const sortSel = el("select", { class: "artist__sortsel", id: "artistSortSel" });
  for (const opt of sortOptions) {
    const o = el("option", { value: opt.value }, opt.label);
    if (opt.value === currentSort) o.setAttribute("selected", "");
    sortSel.append(o);
  }
  sortBar.append(sortLabel, sortSel);
  header.append(sortBar);

  const sortItems = (items, mode) => {
    const arr = items.slice();
    if (mode === "oldest") {
      arr.sort((a, b) => parseInt(a.i, 10) - parseInt(b.i, 10));
    } else if (mode === "title") {
      arr.sort((a, b) => (a.t || "").localeCompare(b.t || ""));
    } else if (mode === "plays") {
      // search.json has no plays field today; fall back to ITEM_CACHE
      // if details have been fetched. Items without a play count sort
      // to the end. Once a future scrape adds plays to search.json,
      // this will rank by global popularity for free.
      const playCount = (s) => {
        const direct = parseInt(String(s.p || "").replace(/,/g, ""), 10);
        if (!isNaN(direct)) return direct;
        const cached = ITEM_CACHE.get(`${s.k === "a" ? "album" : "single"}:${s.i}`);
        const p = cached ? parseInt(String(cached.plays || "").replace(/,/g, ""), 10) : NaN;
        return isNaN(p) ? -1 : p;
      };
      arr.sort((a, b) => playCount(b) - playCount(a));
    } else {
      // newest
      arr.sort((a, b) => parseInt(b.i, 10) - parseInt(a.i, 10));
    }
    return arr;
  };

  // Hydrate from the homepage / per-item caches if available, so cards
  // show real covers without an extra fetch.
  const hydrate = (it) => ITEM_CACHE.get(`${it.kind}:${it.id}`) || it;

  const renderGrids = () => {
    const all = sortItems(rawItems, currentSort);
    const singles = all.filter(s => s.k === "s").map(expandSlim);
    const albums  = all.filter(s => s.k === "a").map(expandSlim);

    // Update count line.
    const sortLabelText = sortOptions.find(s => s.value === currentSort)?.label.toLowerCase() ?? "newest first";
    $("#artistCount").textContent =
      `${singles.length} song${singles.length === 1 ? "" : "s"}, ` +
      `${albums.length} album${albums.length === 1 ? "" : "s"} · ${sortLabelText}`;

    // Replace grids in place.
    singlesHost.innerHTML = "";
    albumsHost.innerHTML  = "";
    if (singles.length) {
      singlesHost.hidden = false;
      singlesHost.append(
        el("div", { class: "section__head" },
          el("h2", { class: "section__title", html: `Songs by <em>${entry.displayName}</em>` }),
          el("span", { class: "section__count" }, `${singles.length} track${singles.length === 1 ? "" : "s"}`),
        ),
      );
      const grid = el("div", { class: "grid" });
      singles.forEach((s, i) => grid.append(buildCard(hydrate(s), false, i)));
      singlesHost.append(grid);
    } else {
      singlesHost.hidden = true;
    }
    if (albums.length) {
      albumsHost.hidden = false;
      albumsHost.append(
        el("div", { class: "section__head" },
          el("h2", { class: "section__title", html: `Albums &amp; EPs by <em>${entry.displayName}</em>` }),
          el("span", { class: "section__count" }, `${albums.length} release${albums.length === 1 ? "" : "s"}`),
        ),
      );
      const grid = el("div", { class: "grid" });
      albums.forEach((a, i) => grid.append(buildCard(hydrate(a), false, i)));
      albumsHost.append(grid);
    } else {
      albumsHost.hidden = true;
    }

    // Stash this artist's singles as the playlist context so
    // continuous play / next / shuffle stay within this artist.
    setPlaylistContext(singles.map(hydrate));

    // Lazy-hydrate covers for items not already in the cache.
    const allItems = [...singles, ...albums];
    const cardsByKey = new Map();
    for (const it of allItems) {
      const k = `${it.kind}:${it.id}`;
      if (ITEM_CACHE.has(k) && ITEM_CACHE.get(k).cover) continue;
      const sel = `[data-item="${k}"]`;
      const cardEl = document.querySelector(sel);
      if (cardEl) cardsByKey.set(k, { item: it, el: cardEl, loaded: false });
    }
    if (cardsByKey.size) {
      const coverIo = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const k = e.target.getAttribute("data-item");
          const entry2 = cardsByKey.get(k);
          if (!entry2 || entry2.loaded) continue;
          entry2.loaded = true;
          coverIo.unobserve(e.target);
          loadItemDetail(entry2.item.kind, entry2.item.id).then((full) => {
            if (!full || !full.cover) return;
            const img = e.target.querySelector("img");
            if (img) img.src = safeUrl(full.cover);
          }).catch(() => {});
        }
      }, { rootMargin: "300px 0px" });
      for (const { el } of cardsByKey.values()) coverIo.observe(el);
    }
  };

  sortSel.addEventListener("change", () => {
    currentSort = sortSel.value;
    localStorage.setItem("sa_artist_sort_v1", currentSort);
    renderGrids();
  });

  renderGrids();
}

async function renderArtistsList() {
  STATE.view = "artists";
  const app = $("#app");
  app.innerHTML = "";

  const header = el("section", { class: "artist__header" },
    el("p", { class: "artist__kicker" }, "Browse"),
    el("h1", { class: "artist__name" }, "All artists"),
    el("p", { class: "artist__count", id: "artistsListCount" }, "Loading…"),
  );

  // Letter-filter chips + search.
  const filterBar = el("div", { class: "artists-filter" });
  const filterInput = el("input", {
    type: "search",
    class: "artists-filter__input",
    placeholder: "Filter artists…",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  filterBar.append(filterInput);

  const listHost = el("div", { class: "artists-list" });
  app.append(header, filterBar, listHost);
  window.scrollTo({ top: 0, behavior: "auto" });

  const idx = await ensureArtistIndex();
  if (!idx) {
    $("#artistsListCount").textContent = "Couldn't load library";
    return;
  }

  // Sort by track count desc so prolific artists float to the top.
  const all = [...idx.entries()]
    .map(([key, v]) => ({ key, name: v.displayName, count: v.items.length }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

  $("#artistsListCount").textContent =
    `${all.length.toLocaleString()} artists across ${idx.size === 1 ? "1 artist" : "the library"}`;

  const renderList = (filter) => {
    const q = (filter || "").trim().toLowerCase();
    listHost.innerHTML = "";
    let shown = 0;
    for (const a of all) {
      if (q && !a.key.includes(q)) continue;
      const row = el("a", {
        href: `#artist/${encodeURIComponent(a.name)}`,
        class: "artist-row",
        onclick: (e) => {
          e.preventDefault();
          openArtist(a.name);
        },
      },
        el("span", { class: "artist-row__name" }, a.name),
        el("span", { class: "artist-row__count" }, `${a.count} track${a.count === 1 ? "" : "s"}`),
      );
      listHost.append(row);
      shown++;
      // Cap to 500 displayed at once so the DOM stays light. The filter
      // will reveal more from the long tail as the user types.
      if (shown >= 500) break;
    }
    if (shown === 0) {
      listHost.append(el("p", { class: "empty" }, q ? "No matching artists" : "No artists in the library"));
    }
  };
  renderList("");
  filterInput.addEventListener("input", () => renderList(filterInput.value));
}

function goHome() {
  STATE.view = "home";
  if (location.hash && location.hash !== "#new_singles") {
    history.pushState(null, "", "#new_singles");
  }
  // Re-render the homepage from cached data so the back-from-artist
  // returns are instant.
  rerenderHome();
}

let _homeData = null;
function rerenderHome() {
  if (_homeData) renderAll(_homeData);
  else boot();  // first time only
}

// ---------------- Browse view (infinite scroll) ----------------------------
//
// Opened from the Singles / Albums tabs (mobile bottom bar) or the
// "Browse all →" link in each homepage section. Pulls from the full
// search index so the user can scroll through the entire library.
async function openBrowse(kind /* "singles" | "albums" */) {
  const hash = `#browse/${kind}`;
  if (location.hash !== hash) {
    history.pushState(null, "", hash);
  }
  await renderBrowseView(kind);
}

async function renderBrowseView(kind) {
  STATE.view = `browse:${kind}`;
  const app = $("#app");
  app.innerHTML = "";

  const isAlbum = kind === "albums";
  const title = isAlbum ? "All Albums &amp; EPs" : "All Singles";
  const kicker = "Browse · newest first";

  const back = el("button", {
    class: "artist__back",
    type: "button",
    "aria-label": "Back",
    onclick: () => goHome(),
  },
    el("span", { html: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>` }),
    "Back",
  );
  const header = el("section", { class: "artist__header" },
    back,
    el("p", { class: "artist__kicker" }, kicker),
    el("h1", { class: "artist__name", html: title }),
    el("p", { class: "artist__count", id: "browseCount" }, "Loading…"),
  );

  const gridHost = el("section", { class: "section" });
  const grid = el("div", { class: "grid" });
  gridHost.append(grid);

  const sentinel = el("div", { class: "browse-sentinel", "aria-hidden": "true" });

  app.append(header, gridHost, sentinel);
  window.scrollTo({ top: 0, behavior: "auto" });

  const items = await ensureSearchIndex();
  if (!items) {
    $("#browseCount").textContent = "Couldn't load library";
    return;
  }

  const kindLetter = isAlbum ? "a" : "s";
  const all = items
    .filter(s => s.k === kindLetter)
    .sort((a, b) => parseInt(b.i, 10) - parseInt(a.i, 10));

  $("#browseCount").textContent =
    `${all.length.toLocaleString()} ${isAlbum ? "releases" : "tracks"} · scroll to load more`;

  // Stash the full browse list as the playlist context. Even though
  // cards lazy-load in batches, the user expects continuous play /
  // shuffle to cycle through every item in the view, not just the
  // first 60. Singles only — albums need a track pick to play.
  if (!isAlbum) {
    const playable = all.map(s => {
      const cached = ITEM_CACHE.get(`single:${s.i}`);
      return cached || expandSlim(s);
    });
    setPlaylistContext(playable);
  }

  let cursor = 0;
  const loadMore = () => {
    if (STATE.view !== `browse:${kind}`) return;  // navigated away
    const end = Math.min(cursor + BROWSE_BATCH, all.length);
    for (let i = cursor; i < end; i++) {
      const s = all[i];
      const cached = ITEM_CACHE.get(`${isAlbum ? "album" : "single"}:${s.i}`);
      const item = cached || expandSlim(s);
      grid.append(buildCard(item, false, i));
    }
    cursor = end;
    if (cursor >= all.length) {
      io.disconnect();
      sentinel.remove();
    }
  };

  // IntersectionObserver loads more when the sentinel scrolls into view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) loadMore();
    }
  }, { rootMargin: "400px 0px" });
  io.observe(sentinel);

  // Always render the first batch up front.
  loadMore();
}

// Hash routing: #artist/Name, #artists, #browse/singles, #browse/albums.
window.addEventListener("hashchange", () => routeFromHash());
function routeFromHash() {
  const h = (location.hash || "").slice(1);  // drop the '#'
  if (h.startsWith("artist/")) {
    const name = decodeURIComponent(h.slice("artist/".length));
    if (name) {
      renderArtistView(name);
      return;
    }
  }
  if (h === "artists") {
    renderArtistsList();
    return;
  }
  if (h.startsWith("browse/")) {
    const kind = h.slice("browse/".length);
    if (kind === "singles" || kind === "albums") {
      renderBrowseView(kind);
      return;
    }
  }
  // Any other hash (#new_singles etc.) means we're on the home view.
  if (STATE.view !== "home") {
    STATE.view = "home";
    rerenderHome();
  }
}

const searchInput = $("#searchInput");
const searchClear = $("#searchClear");
const resultsHost = () => $("#searchResults");

function setSearchUI(active) {
  document.body.classList.toggle("is-searching", active);
  searchClear.hidden = !active;
}

async function doSearch(q) {
  q = (q || "").trim().toLowerCase();
  const host = resultsHost();
  if (!host) return;
  if (!q) {
    setSearchUI(false);
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  setSearchUI(true);
  host.hidden = false;
  host.innerHTML = "";

  const head = el("div", { class: "section__head" },
    el("h2", { class: "section__title", html: `Search · <em>“${escapeHtml(q)}”</em>` }),
    el("span", { class: "section__count" }, "Searching…"),
  );
  host.append(head);

  const idx = await ensureSearchIndex();
  if (!idx) return;

  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = [];
  for (const s of idx) {
    const hay = `${s.t} ${s.a} ${s.m} ${s.l} ${s.r}`.toLowerCase();
    if (tokens.every(t => hay.includes(t))) {
      matches.push(s);
      if (matches.length >= 200) break;
    }
  }

  head.querySelector(".section__count").textContent =
    `${matches.length}${matches.length >= 200 ? "+" : ""} match${matches.length === 1 ? "" : "es"}`;

  const grid = el("div", { class: "grid" });
  if (matches.length === 0) {
    grid.append(el("div", { class: "empty" }, "No matches in the library."));
  } else {
    for (const s of matches) grid.append(buildCard(expandSlim(s), false, null));
    // Stash matched singles as the playlist context so playing one
    // continues through the rest of the search results.
    const matchedSingles = matches
      .filter(s => s.k === "s")
      .map(s => ITEM_CACHE.get(`single:${s.i}`) || expandSlim(s));
    setPlaylistContext(matchedSingles);
  }
  host.append(grid);
  host.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Search-as-you-type: 50ms is short enough to feel instant while still
// coalescing rapid keystrokes (typing "punjabi" doesn't fire 7 searches).
const doSearchDebounced = debounce(doSearch, 50);

searchInput.addEventListener("focus", ensureSearchIndex);
searchInput.addEventListener("input", (e) => doSearchDebounced(e.target.value));
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  doSearch("");
  searchInput.focus();
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space" && audio.src) {
    e.preventDefault();
    togglePlay();
  } else if (e.code === "Escape") {
    if (nowPlaying.classList.contains("is-open")) closeNowPlaying();
    else closeSheet();
  } else if (e.code === "ArrowRight" && e.altKey) {
    playNext();
  } else if (e.code === "ArrowLeft" && e.altKey) {
    playPrev();
  }
});

$$('[data-close]').forEach(b => b.addEventListener("click", closeSheet));
// Backdrop click closes (mirrors the old showModal click-outside behavior,
// which doesn't fire on non-modal dialogs).
const _sheetBackdrop = $("#sheetBackdrop");
if (_sheetBackdrop) _sheetBackdrop.addEventListener("click", closeSheet);
// ESC closes (browsers handle this automatically for modal dialogs but
// not for ones opened with show()).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#detailSheet").open) {
    e.preventDefault();
    closeSheet();
  }
});

// ---------------- Section scrollspy ----------------------------------------

function setupScrollSpy() {
  // Tracks both desktop .navlink and mobile .tab — they share href="#section_id"
  const links = [...$$(".navlink"), ...$$(".tab")];
  if (!links.length) return;

  const setActive = (sectionId) => {
    for (const a of links) {
      const isMatch = a.getAttribute("href") === `#${sectionId}`;
      a.classList.toggle("is-active", isMatch);
    }
  };

  // Smooth scroll on link click.
  for (const a of links) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href")?.slice(1);
      // #artists, #artist/..., #browse/... aren't sections to scroll to —
      // they're view routes. Let the link's default fire the hash change
      // and routeFromHash() take over.
      if (!id ||
          id === "artists" ||
          id.startsWith("artist/") ||
          id.startsWith("browse/")) return;
      const sect = document.getElementById(id);
      if (sect) {
        e.preventDefault();
        // If we're in a non-home view, switch home first then scroll.
        if (STATE.view !== "home") {
          goHome();
          // Defer scrollIntoView until the home DOM is back.
          setTimeout(() => {
            const s = document.getElementById(id);
            if (s) s.scrollIntoView({ behavior: "smooth", block: "start" });
            setActive(id);
          }, 0);
        } else {
          sect.scrollIntoView({ behavior: "smooth", block: "start" });
          setActive(id);  // immediate feedback
        }
      }
    });
  }

  const sectionIds = new Set();
  for (const a of links) {
    const id = a.getAttribute("href")?.slice(1);
    if (id) sectionIds.add(id);
  }

  const observer = new IntersectionObserver((entries) => {
    // Pick the entry most in view among intersecting ones.
    let best = null;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
    }
    if (best) setActive(best.target.id);
  }, { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] });

  // Observe sections that exist NOW; renderAll happens before setupScrollSpy
  // so the section <section> elements are already in the DOM.
  for (const id of sectionIds) {
    const sect = document.getElementById(id);
    if (sect) observer.observe(sect);
  }
}

// ---------------- Boot -----------------------------------------------------

async function boot() {
  // Register MediaSession action handlers once, ahead of any playback.
  // These connect the OS (car infotainment, lock screen, BT remotes) to
  // this page's transport controls. Doing it here means the handlers exist
  // before the first track plays.
  setupMediaSessionHandlers();

  try {
    const res = await fetch(`data/songs.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAll(data);
    setupScrollSpy();
    // Eager-load the search index so pagination on the home sections
    // can show the library-wide page count immediately. Once loaded,
    // re-render the home view to refresh the page numbers.
    ensureSearchIndex().then(() => {
      if (STATE.view === "home") rerenderHome();
    });
    // If the page was opened with a deep-link route, handle it now.
    if (location.hash.startsWith("#artist") || location.hash.startsWith("#browse/")) {
      routeFromHash();
    }
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `
      <div class="empty" style="margin-top:60px">
        Couldn't load data — ${err.message}.
      </div>`;
  }
}
