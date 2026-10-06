const CACHE = __CACHE_VERSION__;
const PRECACHE = __PRECACHE_URLS__;
const STATIC_PATHS = new Set(PRECACHE);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    PRECACHE.map(url => new Request(url, { cache: "reload" })),
  )));
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("kantengyen-pwa-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  // Auth, live room state and voice signaling always go directly to the server.
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(request, { signal: controller.signal });
        if (!response.ok) throw new Error("Navigation unavailable");
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return await cache.match("/index.html") || Response.error();
      } finally { clearTimeout(timer); }
    })());
  } else if (STATIC_PATHS.has(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match(request) || fetch(request),
    ));
  }
});
