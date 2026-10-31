/* Breakout Desk service worker (browser/PWA only; the Android app bundles these files itself).
   App files: stale-while-revalidate, so the app opens instantly and quietly updates itself.
   Screener data is cached by the page itself (network first), so it is never touched here. */
const CACHE = "bd-shell-v1";
const SHELL = ["./", "index.html", "app.css", "config.js", "paper-core.js", "screener-core.js", "charts.js", "store.js", "ui.js",
  "v-home.js", "v-scan.js", "v-trade.js", "v-port.js", "v-more.js", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("bd-shell-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.includes("/app/")) return;   // data + Firebase go straight to the network
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
