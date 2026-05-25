/**
 * Saadi Awaaz service worker.
 *
 * Goal: launching the installed PWA is instant and works offline (for the
 * shell and recent metadata). Audio streams themselves come from djjohal
 * and aren't cached — too large and they expire.
 *
 * Strategy per request type:
 *   - App shell (HTML/CSS/JS/icons/manifest): cache-first, falling back to
 *     network. Bumps with each CACHE_VERSION change.
 *   - data/songs.json + data/search.json: stale-while-revalidate. Show
 *     cached immediately if present, fetch fresh in the background.
 *   - data/items/*.json: stale-while-revalidate too — these almost never
 *     change once written.
 *   - Everything else (audio, covers, weserv proxy, YouTube, etc.): bypass
 *     the SW and go straight to network.
 */

const CACHE_VERSION = "saadi-v7.14";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE  = `${CACHE_VERSION}-data`;

// Bump CACHE_VERSION above to invalidate old caches on next deploy.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=7.14",
  "./app.js?v=7.14",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isDataRequest(url) {
  return url.pathname.includes("/data/") && url.pathname.endsWith(".json");
}

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.endsWith(".html")) return true;
  if (url.pathname.endsWith(".css"))  return true;
  if (url.pathname.endsWith(".js"))   return true;
  if (url.pathname.endsWith(".webmanifest")) return true;
  if (url.pathname.endsWith(".png"))  return true;
  if (url.pathname === self.registration.scope || url.pathname.endsWith("/")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GETs; everything else (none in this app, but defensive)
  // goes straight to network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Don't touch cross-origin requests (djjohal audio, lq.djjohal covers,
  // weserv proxy, YouTube, etc.). Let the browser fetch directly.
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  // Anything else same-origin: network-first.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    // Offline + uncached. Fall back to the index for navigations.
    if (req.mode === "navigate") {
      const idx = await cache.match("./index.html");
      if (idx) return idx;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fetchPromise = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || fetchPromise || fetch(req);
}
