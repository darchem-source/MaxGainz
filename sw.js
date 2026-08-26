// Max Gainz — Service Worker
//
// Strategy:
//   - Navigations (HTML page load): network-first with cache fallback.
//     Fresh deploys reach users on next online launch; offline still works.
//   - Static external assets (Google Fonts CSS+woff2, Lottie CDN):
//     cache-first. They rarely change and we want fast offline launch.
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

const CACHE_NAME = 'maxgainz-v2';

const SHELL = [
  '/',
  '/index.html',
  // Inter variable font — CSS resolves to woff2 files cached lazily by
  // the cache-first handler below.
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  // Lottie player used for completion celebrations.
  'https://unpkg.com/lottie-web@5.12.2/build/player/lottie_light.min.js'
];

// Hosts whose responses we cache lazily on first successful fetch.
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'];

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

  // Static external assets (font CSS, woff2, Lottie player): cache-first.
  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          // Cache both regular (CORS) and opaque (no-CORS) responses so
          // cross-origin font/JS assets work offline.
          if (res && (res.ok || res.type === 'opaque')) {
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
