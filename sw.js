// Max Gainz — Service Worker
//
// Strategy:
//   - Navigations (HTML page load): network-first with cache fallback.
//     Fresh deploys reach users on next online launch; offline still works.
//   - Bundled static assets (vendor/: Inter font, Lottie player): cache-first.
//     They are versioned with the shell and we want a fast offline launch.
//   - Supabase API: never intercepted — let it fail naturally when offline.
//
// Versioning:
//   Bump CACHE_NAME whenever the SHELL list changes (e.g. you add a new
//   pinned URL to pre-cache). Within the same version, network-first
//   auto-refreshes HTML and cache-first auto-fills new static URLs the
//   first time they're fetched.
//
// Update prompts:
//   skipWaiting() is intentionally NOT called on install — the new SW
//   sits in 'waiting' until the page sends {type:'SKIP_WAITING'}, which
//   happens when the user accepts the "Update available" banner. This
//   avoids changing the running page out from under a user mid-workout.

const CACHE_NAME = 'maxgainz-v4';

const SHELL = [
  '/',
  '/index.html',
  // window.MGNative, loaded by a <script> tag in index.html's <head>.
  '/native-bridge.js',
  // Bundled Inter variable font and the Lottie player (no third-party CDNs).
  '/vendor/inter-latin-wght-normal.woff2',
  '/vendor/lottie_light.min.js'
];

// Same-origin paths cached lazily (cache-first) on first successful fetch.
const STATIC_PREFIX = '/vendor/';

// ── INSTALL: pre-cache the app shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c =>
      // Fetch each entry independently — addAll fails atomically if even
      // one URL 404s, which would brick the cache for transient failures.
      Promise.all(SHELL.map(u =>
        fetch(u, { mode: u.startsWith('http') ? 'no-cors' : 'same-origin' })
          .then(r => c.put(u, r))
          .catch(err => console.warn('[SW] shell fetch failed:', u, err))
      ))
    )
  );
});

// ── ACTIVATE: delete old caches, take control ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── MESSAGE: page taps "Update available" → activate the new SW ──
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Supabase — let calls fail naturally offline.
  if (url.hostname.includes('supabase.co')) return;

  // Never intercept the ExerciseDB proxy — media URLs rotate weekly and the
  // plan forbids caching, so these must always hit the network fresh.
  if (url.pathname.startsWith('/api/')) return;

  // Native bridge script: network-first, cache fallback (same as the HTML),
  // so a fresh deploy is picked up online and the page still gets it offline.
  if (url.origin === self.location.origin && url.pathname === '/native-bridge.js') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put('/native-bridge.js', clone));
          }
          return res;
        })
        .catch(() => caches.match('/native-bridge.js'))
    );
    return;
  }

  // Navigation requests (HTML): network-first, cache fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          // Offline — serve last cached HTML, prefer the requested URL,
          // then fall back to /index.html (the canonical shell).
          caches.match(e.request).then(r => r || caches.match('/index.html'))
        )
    );
    return;
  }

  // Bundled static assets (font, Lottie player): cache-first.
  if (url.origin === self.location.origin && url.pathname.startsWith(STATIC_PREFIX)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Default: pass through, no caching.
});
