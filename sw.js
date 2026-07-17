"use strict";

const CACHE = "pourcast-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Never intercept the weather API; the app handles its own data caching.
  if (url.hostname.indexOf("open-meteo.com") !== -1) return;

  // Fonts: stale while revalidate.
  if (url.hostname.indexOf("fonts.googleapis.com") !== -1 || url.hostname.indexOf("fonts.gstatic.com") !== -1) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(e.request).then((cached) => {
          const network = fetch(e.request).then((res) => { c.put(e.request, res.clone()); return res; }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // App shell: cache first, fall back to network, refresh cache in background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const network = fetch(e.request)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
