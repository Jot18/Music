/* ============================================================
   Saadi Awaaz · App logic v7
   ============================================================ */

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
};

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
 * Build a YouTube search URL for an item. We can't get the exact video ID
 * without YouTube's API, but linking to a search query for "{artist} {title}"
 * works well — YouTube's first result is almost always the song. On mobile,
 * Chrome/Safari prompt to open in the YouTube app if it's installed.
 */
function youtubeSearchUrl(item) {
  if (!item) return "";
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

  const showing = section.items.length;
  const total = section.total_available ?? showing;
  let countText;
  if (total > showing) {
    countText = `${showing} shown · ${total.toLocaleString()} in library · search for more`;
  } else {
    countText = `${showing} ${section.kind === "album" ? "releases" : "tracks"}`;
  }
  const head = el("div", { class: "section__head" },
    el("h2", { class: "section__title", html: titleHtml }),
    el("span", { class: "section__count" }, countText)
  );

  const grid = el("div", { class: "grid" });
  if (section.items.length === 0) {
    grid.append(el("div", { class: "empty" }, "Waiting for next scrape…"));
  }
  section.items.forEach((item, idx) => {
    grid.append(buildCard(item, isChart, idx));
  });

  return el("section", { class: "section", id: section.id }, head, grid);
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
  const app = $("#app");
  app.innerHTML = "";

  if (data.generated_at) {
    const d = new Date(data.generated_at);
    if (!isNaN(d.getTime())) {
      const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
      const total = (data.stats?.total_singles ?? 0) + (data.stats?.total_albums ?? 0);
      $("#lastUpdated").textContent =
        `updated ${d.toLocaleString(undefined, opts)} · library: ${total.toLocaleString()}`;
    }
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
  $("#detailSheet").showModal();

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
  $("#sheetArtist").textContent = item.artist || (isAlbum ? "Various Artists" : "—");

  const facts = $("#sheetFacts");
  facts.innerHTML = "";
  const rows = [
    ["Music",     item.music],
    ["Lyrics",    item.lyrics],
    ["Label",     item.label],
    ["Released",  item.released],
    ["Playtime",  item.playtime],
    ["Plays",     item.plays],
  ];
  for (const [k, v] of rows) {
    facts.append(el("dt", {}, k));
    facts.append(el("dd", {}, safeText(v)));
  }

  const playBtn = $("#sheetPlayBtn");
  const ytBtn   = $("#sheetYtBtn");
  const tracksHost = $("#sheetTracks");

  // YouTube button — always populated. For singles links to the song; for
  // albums links to a "{artist} {title} full album" search.
  const ytUrl = isAlbum
    ? (() => {
        const parts = [item.artist, item.title].map(s => (s || "").trim()).filter(Boolean);
        const q = encodeURIComponent([...parts, "full album"].join(" "));
        return parts.length ? `https://www.youtube.com/results?search_query=${q}` : "";
      })()
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
}

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

  $("#player").hidden = false;
  document.body.classList.add("has-player");

  const cover = safeUrl(item.cover) || "";
  $("#playerCover").src = cover;
  $("#playerTitle").textContent = item.title || "Untitled";
  $("#playerArtist").textContent = item.artist || "";

  $("#npCover").src = cover;
  $("#npTitle").textContent = item.title || "Untitled";
  $("#npArtist").textContent = item.artist || "";

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
}

// ---------------- MediaSession (for Bluetooth / car / lock screen) ---------
// The MediaSession API publishes "what's playing" to the OS so external
// surfaces — your Tesla's media widget, Android Auto, iOS lock screen,
// Chromecast, etc. — show the right title/artist/cover and route their
// transport buttons (prev/next/play/pause/seek) back here.

const ORIGINAL_TITLE = document.title;

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
    const artworkUrl = safeUrl(item.cover) || "";
    const artwork = artworkUrl ? [
      // Several sizes hint to the OS; same URL is fine since djjohal
      // doesn't serve responsive variants.
      { src: artworkUrl, sizes: "96x96",   type: "image/jpeg" },
      { src: artworkUrl, sizes: "192x192", type: "image/jpeg" },
      { src: artworkUrl, sizes: "256x256", type: "image/jpeg" },
      { src: artworkUrl, sizes: "384x384", type: "image/jpeg" },
      { src: artworkUrl, sizes: "512x512", type: "image/jpeg" },
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
  if (!("mediaSession" in navigator) || !audio.duration || !isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1,
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
  let i = STATE.currentIndex + 1;
  if (i >= STATE.playlist.length) i = 0;
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
  openCurrentContext();
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
  }
  host.append(grid);
  host.scrollIntoView({ behavior: "smooth", block: "start" });
}

const doSearchDebounced = debounce(doSearch, 180);

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
$("#detailSheet").addEventListener("click", (e) => {
  const rect = $("#detailSheet").getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                 e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) closeSheet();
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
      const sect = id && document.getElementById(id);
      if (sect) {
        e.preventDefault();
        sect.scrollIntoView({ behavior: "smooth", block: "start" });
        setActive(id);  // immediate feedback
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
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `
      <div class="empty" style="margin-top:60px">
        Couldn't load data — ${err.message}.
      </div>`;
  }
}
