// Apex Fit service worker: makes the app installable and lets it open without a connection.
// Network-first, so a new deploy is picked up as soon as the phone is online;
// the cache is only a fallback. AI and Google requests are never cached.
const CACHE = "apex-fit-v1";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/manifest.json", "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Skip the large onboarding photos; they're only needed once
  if (/^\/age-\d+\.jpg$/.test(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Offline navigation to any route: serve the app shell
        if (req.mode === "navigate") return caches.match("/");
        return Response.error();
      })
  );
});
