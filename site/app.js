/* ============================================================
   Saadi Awaaz · App logic
   - Fetches data/songs.json
   - Renders the four sections + searchable archive
   - Detail sheet on cover click
   - Persistent mini-player + full-screen now-playing overlay (mobile)
   ============================================================ */

const STATE = {
  sections: [],
  playlist: [],
  currentIndex: -1,
  currentItem: null,
};

// ------- Touch / mobile detection ---------------------------------------

/** Returns true on touch-first devices (phones, tablets). */
function isTouchDevice() {
  // Coarse pointer is the most reliable signal.
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  // Fallback: UA sniff for iPad-on-desktop-mode quirks.
  if (/iPad|iPhone|iPod|Android/i.test(navigator.userAgent)) return true;
  // navigator.maxTouchPoints catches iPadOS reporting as Mac.
  return navigator.maxTouchPoints > 1;
}

if (isTouchDevice()) {
  document.documentElement.classList.add("is-touch");
  document.body.classList.add("is-touch");
}

// ------- Helpers --------------------------------------------------------

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function fmtTime(secs) {
  if (!Number.isFinite(secs)) return "0:00";
  secs = Math.max(0, Math.floor(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function safeText(v) {
  return (v == null || v === "") ? "—" : String(v);
}

// Some source URLs have raw spaces — encode them so browsers fetch correctly.
function safeUrl(u) {
  if (!u) return "";
  try { return encodeURI(u); } catch { return u; }
}

// Build a clean download filename, stripping any source-identifying tokens
// and characters that are illegal on most filesystems.
function sanitizeFilename(s) {
  if (!s) return "track";
  return s
    .replace(/\(?\s*DJJOhAL[.\s]*Com\s*\)?/gi, "")  // strip "(DJJOhAL.Com)" / "DJJOhAL.Com"
    .replace(/\bdjjohal\b/gi, "")                    // any remaining mention
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")          // illegal FS chars
    .replace(/\s+/g, " ")                            // collapse whitespace
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g, "")           // trim weird boundary chars
    .slice(0, 120)                                   // sane length
    || "track";
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

// ------- Render -----------------------------------------------------------

function renderSection(section) {
  const isChart = section.id.startsWith("top_");
  const isAlbum = section.kind === "album";

  // Stylized title with marigold accent on key word.
  let titleHtml;
  switch (section.id) {
    case "new_singles":  titleHtml = `New <em>Singles</em>`; break;
    case "new_albums":   titleHtml = `New <em>Albums</em> &amp; EPs`; break;
    case "top_singles":  titleHtml = `Top 50 <em>Singles</em>`; break;
    default:             titleHtml = section.title;
  }

  const head = el("div", { class: "section__head" },
    el("h2", { class: "section__title", html: titleHtml }),
    el("span", { class: "section__count" }, `${section.items.length} ${isAlbum ? "releases" : "tracks"}`)
  );

  const grid = el("div", { class: "grid" });

  if (section.items.length === 0) {
    grid.append(el("div", { class: "empty" },
      "Waiting for the next scrape… check back soon."));
  }

  section.items.forEach((item, idx) => {
    grid.append(buildCard(item, isChart, idx));
  });

  return el("section", { class: "section", id: section.id }, head, grid);
}

function renderAll(data) {
  const app = $("#app");
  app.innerHTML = "";

  if (data.generated_at) {
    const d = new Date(data.generated_at);
    if (!isNaN(d.getTime())) {
      const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
      $("#lastUpdated").textContent = `updated ${d.toLocaleString(undefined, opts)}`;
    }
  }

  // Build flat playlist from the three sections only.
  const seen = new Set();
  STATE.playlist = [];
  for (const section of data.sections || []) {
    for (const item of section.items || []) {
      const k = `${item.kind}:${item.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320)) {
        STATE.playlist.push(item);
      }
    }
  }

  for (const section of data.sections) {
    app.append(renderSection(section));
  }
}

// Extracted from renderSection so it can be reused by the archive.
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
      onclick: (e) => { e.stopPropagation(); playItem(item); },
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

// ------- Detail sheet -----------------------------------------------------

function openSheet(item) {
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

  // Play button
  $("#sheetPlayBtn").onclick = () => {
    playItem(item);
    closeSheet();
  };
  const hasStream = item.mp3 && (item.mp3.stream || item.mp3.kbps128 || item.mp3.kbps320 || item.mp3.kbps48);
  $("#sheetPlayBtn").disabled = !hasStream;
  $("#sheetPlayBtn").style.opacity = hasStream ? "1" : ".4";

  // Downloads — with sanitized filenames (strip any source-identifying
  // text from what the browser saves).
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

  $("#detailSheet").showModal();
}

function closeSheet() {
  const dlg = $("#detailSheet");
  if (dlg.open) dlg.close();
}

// ------- Player -----------------------------------------------------------

const audio = $("#audio");

function playItem(item) {
  const stream = item.mp3?.stream || item.mp3?.kbps128 || item.mp3?.kbps320 || item.mp3?.kbps48;
  if (!stream) {
    alert("No playable audio for this track.");
    return;
  }

  STATE.currentIndex = STATE.playlist.findIndex(p => p.id === item.id && p.kind === item.kind);
  STATE.currentItem = item;

  // First play: reveal the player and reserve space at the bottom of the page.
  $("#player").hidden = false;
  document.body.classList.add("has-player");

  const cover = safeUrl(item.cover) || "";
  $("#playerCover").src = cover;
  $("#playerTitle").textContent = item.title || "Untitled";
  $("#playerArtist").textContent = item.artist || "";

  // Sync now-playing overlay too (so if it's already open, it updates).
  $("#npCover").src = cover;
  $("#npTitle").textContent = item.title || "Untitled";
  $("#npArtist").textContent = item.artist || "";

  audio.src = safeUrl(stream);
  audio.play().catch(err => {
    console.warn("Playback failed:", err);
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
  playItem(STATE.playlist[i]);
}

function playNext() {
  if (STATE.playlist.length === 0) return;
  let i = STATE.currentIndex + 1;
  if (i >= STATE.playlist.length) i = 0;
  playItem(STATE.playlist[i]);
}

// Player event wiring — sync both the mini-bar and the now-playing overlay.
function setPlayingUI(isPlaying) {
  $("#iconPlay").style.display   = isPlaying ? "none" : "";
  $("#iconPause").style.display  = isPlaying ? "" : "none";
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
  $("#curTime").textContent = curStr;
  $("#totTime").textContent = totStr;
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

// Now-playing controls mirror the mini-bar
$("#npPlay").addEventListener("click", togglePlay);
$("#npPrev").addEventListener("click", playPrev);
$("#npNext").addEventListener("click", playNext);
$("#npSource").addEventListener("click", () => {
  if (STATE.currentItem) {
    closeNowPlaying();
    openSheet(STATE.currentItem);
  }
});

// Click on scrub bar to seek (works on both bars)
function seekFromEvent(e, scrubEl) {
  if (!audio.duration) return;
  const r = scrubEl.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX);
  const pct = (x - r.left) / r.width;
  audio.currentTime = Math.max(0, Math.min(audio.duration, pct * audio.duration));
}
$("#scrub").addEventListener("click",   (e) => seekFromEvent(e, e.currentTarget));
$("#npScrub").addEventListener("click", (e) => seekFromEvent(e, e.currentTarget));

// ------- Now-playing overlay (mobile expanded view) ---------------------

const nowPlaying = $("#nowPlaying");

function openNowPlaying() {
  if (!STATE.currentItem) return;
  // Refresh content in case the track changed while collapsed.
  $("#npCover").src    = safeUrl(STATE.currentItem.cover) || "";
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
  // Wait for the animation to end before fully hiding.
  setTimeout(() => { nowPlaying.hidden = true; }, 320);
  document.body.style.overflow = "";
}

$("#btnExpand").addEventListener("click", () => {
  // Desktop: clicking the title area in the mini-bar shouldn't open the
  // full-screen overlay. The overlay is purely a mobile/tablet pattern.
  if (!document.body.classList.contains("is-touch")) return;
  openNowPlaying();
});
$("#btnCollapse").addEventListener("click", closeNowPlaying);

// Swipe-down to dismiss the now-playing overlay (touch only).
(function setupSwipeDismiss() {
  let startY = null;
  let dragging = false;

  const onStart = (e) => {
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    // Only initiate drag from the top portion (handle + first 120px),
    // so users can still interact with controls below.
    const rect = nowPlaying.getBoundingClientRect();
    if (y - rect.top > 140) return;
    startY = y;
    dragging = true;
  };
  const onMove = (e) => {
    if (!dragging || startY == null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - startY;
    if (dy > 0) {
      nowPlaying.style.transform = `translateY(${dy}px)`;
    }
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

// Detail sheet close handlers
$$('[data-close]').forEach(b => b.addEventListener("click", closeSheet));
$("#detailSheet").addEventListener("click", (e) => {
  // click on backdrop closes
  const rect = $("#detailSheet").getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                 e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) closeSheet();
});

// Keyboard: space toggles play
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space" && audio.src) {
    e.preventDefault();
    togglePlay();
  } else if (e.code === "Escape") {
    if (nowPlaying.classList.contains("is-open")) {
      closeNowPlaying();
    } else {
      closeSheet();
    }
  } else if (e.code === "ArrowRight" && e.altKey) {
    playNext();
  } else if (e.code === "ArrowLeft" && e.altKey) {
    playPrev();
  }
});

// ------- Boot -------------------------------------------------------------

async function boot() {
  try {
    // cache-bust so GH Pages serves the latest after each scrape
    const res = await fetch(`data/songs.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAll(data);
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `
      <div class="empty" style="margin-top:60px">
        Couldn't load data/songs.json — ${err.message}.<br/>
        If this is the first deploy, wait for the scheduled scrape (or run the workflow manually).
      </div>`;
  }
}

boot();
