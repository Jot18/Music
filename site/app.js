/* ============================================================
   Saadi Awaaz · App logic v6
   ============================================================ */

const STATE = {
  sections: [],
  playlist: [],
  currentIndex: -1,
  currentItem: null,
  // Lazy-loaded search index. Loaded on first focus of the search box.
  searchIndex: null,
  searchLoading: false,
};

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

// In-memory cache of fully-detailed items keyed by `${kind}:${id}`.
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

// ---------------- Rendering ------------------------------------------------

function renderSection(section) {
  const isChart = section.id.startsWith("top_");
  const isAlbum = section.kind === "album";

  let titleHtml;
  switch (section.id) {
    case "new_singles":  titleHtml = `New <em>Singles</em>`; break;
    case "new_albums":   titleHtml = `New <em>Albums</em> &amp; EPs`; break;
    case "top_singles":  titleHtml = `Top 50 <em>Singles</em>`; break;
    default:             titleHtml = section.title;
  }

  const head = el("div", { class: "section__head" },
    el("h2", { class: "section__title", html: titleHtml }),
    el("span", { class: "section__count" },
       `${section.items.length} ${isAlbum ? "releases" : "tracks"}`)
  );

  const grid = el("div", { class: "grid" });

  if (section.items.length === 0) {
    grid.append(el("div", { class: "empty" },
      "Waiting for the next scrape…"));
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
    el("button", {
      class: "card__play",
      "aria-label": `Play ${item.title}`,
      onclick: async (e) => {
        e.stopPropagation();
        // Need the full item record to play (need mp3 URLs).
        const full = await ensureFullItem(item);
        if (full) playItem(full);
      },
      html: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`
    })
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

/**
 * Make sure we have a full item (with mp3 URLs, music director, lyrics, etc).
 * Items from the live feeds already have everything. Items from search may be
 * the slim version — those get hydrated on demand from /data/items/{k}-{id}.json.
 */
async function ensureFullItem(item) {
  // If it has mp3 stream URLs, it's already full.
  if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320)) {
    return item;
  }
  const detail = await loadItemDetail(item.kind, item.id);
  return detail || item;
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

  // Build flat playlist from the live feeds for prev/next.
  const seen = new Set();
  STATE.playlist = [];
  for (const section of STATE.sections) {
    for (const item of section.items || []) {
      const k = `${item.kind}:${item.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320)) {
        STATE.playlist.push(item);
        ITEM_CACHE.set(k, item);   // cache the full record
      }
    }
  }

  // Make sure the search-results container exists even before search runs.
  app.append(el("section", { class: "section", id: "searchResults", hidden: "" }));

  for (const section of STATE.sections) {
    app.append(renderSection(section));
  }
}

// ---------------- Detail sheet ---------------------------------------------

async function openSheet(item) {
  // Prefill with whatever the card already has (so the sheet opens instantly),
  // then hydrate from data/items/{kind}-{id}.json if needed.
  fillSheet(item);
  $("#detailSheet").showModal();

  if (!item.mp3 || !(item.mp3.stream || item.mp3.kbps128)) {
    const full = await loadItemDetail(item.kind, item.id);
    if (full && $("#detailSheet").open) {
      fillSheet(full);
    }
  }
}

function fillSheet(item) {
  $("#sheetCover").src = safeUrl(item.cover) || "";
  $("#sheetCover").alt = `${item.title} cover`;
  $("#sheetKicker").textContent = item.kind === "album" ? "Album / EP" : "Single Track";
  $("#sheetTitle").textContent = item.title || "Untitled";
  $("#sheetArtist").textContent = item.artist || (item.kind === "album" ? "Various Artists" : "—");

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

  $("#sheetPlayBtn").onclick = async () => {
    const full = await ensureFullItem(item);
    if (full) playItem(full);
    closeSheet();
  };
  const hasStream = item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320 || item.mp3.kbps48);
  $("#sheetPlayBtn").disabled = !hasStream;
  $("#sheetPlayBtn").style.opacity = hasStream ? "1" : ".4";

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

function closeSheet() {
  const dlg = $("#detailSheet");
  if (dlg.open) dlg.close();
}

// ---------------- Player ----------------------------------------------------

const audio = $("#audio");

function playItem(item) {
  const stream = item.mp3?.stream || item.mp3?.kbps128 || item.mp3?.kbps320 || item.mp3?.kbps48;
  if (!stream) {
    alert("No playable audio for this track.");
    return;
  }

  STATE.currentIndex = STATE.playlist.findIndex(p => p.id === item.id && p.kind === item.kind);
  STATE.currentItem = item;

  // Reveal player + reserve bottom space.
  $("#player").hidden = false;
  document.body.classList.add("has-player");

  const cover = safeUrl(item.cover) || "";
  $("#playerCover").src = cover;
  $("#playerTitle").textContent = item.title || "Untitled";
  $("#playerArtist").textContent = item.artist || "";

  $("#npCover").src = cover;
  $("#npTitle").textContent = item.title || "Untitled";
  $("#npArtist").textContent = item.artist || "";

  audio.src = safeUrl(stream);
  audio.play().catch(err => console.warn("Playback failed:", err));
}

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) audio.play();
  else audio.pause();
}

async function playPrev() {
  if (STATE.playlist.length === 0) return;
  let i = STATE.currentIndex - 1;
  if (i < 0) i = STATE.playlist.length - 1;
  const full = await ensureFullItem(STATE.playlist[i]);
  if (full) playItem(full);
}

async function playNext() {
  if (STATE.playlist.length === 0) return;
  let i = STATE.currentIndex + 1;
  if (i >= STATE.playlist.length) i = 0;
  const full = await ensureFullItem(STATE.playlist[i]);
  if (full) playItem(full);
}

function setPlayingUI(isPlaying) {
  $("#iconPlay").style.display    = isPlaying ? "none" : "";
  $("#iconPause").style.display   = isPlaying ? "" : "none";
  $("#npIconPlay").style.display  = isPlaying ? "none" : "";
  $("#npIconPause").style.display = isPlaying ? "" : "none";
}

audio.addEventListener("play",  () => setPlayingUI(true));
audio.addEventListener("pause", () => setPlayingUI(false));
audio.addEventListener("ended", playNext);

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
});

$("#npPlay").addEventListener("click", togglePlay);
$("#npPrev").addEventListener("click", playPrev);
$("#npNext").addEventListener("click", playNext);
$("#npSource").addEventListener("click", () => {
  if (STATE.currentItem) {
    closeNowPlaying();
    openSheet(STATE.currentItem);
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
  $("#npCover").src   = safeUrl(STATE.currentItem.cover) || "";
  $("#npTitle").textContent  = STATE.currentItem.title || "Untitled";
  $("#npArtist").textContent = STATE.currentItem.artist || "";
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
  if (!document.body.classList.contains("is-touch")) return;
  openNowPlaying();
});
$("#btnCollapse").addEventListener("click", closeNowPlaying);

(function setupSwipeDismiss() {
  let startY = null;
  let dragging = false;
  const onStart = (e) => {
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = nowPlaying.getBoundingClientRect();
    if (y - rect.top > 140) return;
    startY = y;
    dragging = true;
  };
  const onMove = (e) => {
    if (!dragging || startY == null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - startY;
    if (dy > 0) nowPlaying.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = (e) => {
    if (!dragging || startY == null) return;
    const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dy = y - startY;
    nowPlaying.style.transition = "transform .2s ease";
    if (dy > 120) {
      nowPlaying.style.transform = "translateY(100%)";
      setTimeout(() => {
        nowPlaying.style.transform = "";
        nowPlaying.style.transition = "";
        closeNowPlaying();
      }, 200);
    } else {
      nowPlaying.style.transform = "";
      setTimeout(() => { nowPlaying.style.transition = ""; }, 220);
    }
    startY = null;
    dragging = false;
  };
  nowPlaying.addEventListener("touchstart", onStart, { passive: true });
  nowPlaying.addEventListener("touchmove",  onMove,  { passive: true });
  nowPlaying.addEventListener("touchend",   onEnd);
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
  // Convert slim shape {k,i,t,a,m,l,r} -> standard item shape.
  return {
    kind:  slim.k === "a" ? "album" : "single",
    id:    slim.i,
    title: slim.t || "",
    artist:slim.a || "",
    music: slim.m || "",
    label: slim.l || "",
    released: slim.r || "",
    cover: "",   // covers are loaded on demand
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
    for (const s of matches) {
      grid.append(buildCard(expandSlim(s), false, null));
    }
  }
  host.append(grid);

  // Scroll into view.
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

// Cmd/Ctrl+K to focus search.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Other keyboard: space toggles play, Esc closes overlays/sheet.
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

// Detail-sheet close handlers
$$('[data-close]').forEach(b => b.addEventListener("click", closeSheet));
$("#detailSheet").addEventListener("click", (e) => {
  const rect = $("#detailSheet").getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                 e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) closeSheet();
});

// ---------------- Boot -----------------------------------------------------

async function boot() {
  try {
    const res = await fetch(`data/songs.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAll(data);
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `
      <div class="empty" style="margin-top:60px">
        Couldn't load data — ${err.message}.
      </div>`;
  }
}
boot();
