// Max Gainz — Service Worker
// Strategy: network-first with cache fallback for app shell.
// Supabase API calls are never intercepted — they fail naturally when offline.

const CACHE = 'maxgainz-v1';
const SHELL  = ['/gymtracker.html', '/'];

// ── INSTALL: cache the app shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {
      // If root '/' 404s (not a redirect), just cache gymtracker.html
      return caches.open(CACHE).then(c => c.add('/gymtracker.html'));
    })
  );
  self.skipWaiting(); // activate immediately, don't wait for old SW to retire
});

// ── ACTIVATE: delete old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control of all open tabs immediately
});

// ── FETCH: network-first, cache fallback ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Supabase API or auth calls — let them fail naturally offline
  if (url.hostname.includes('supabase.co')) return;

  // Only handle same-origin navigation requests (loading the app HTML)
  if (e.request.mode !== 'navigate') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Network succeeded — update cache in background then return response
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        // Network failed — serve from cache
        caches.match(e.request)
          .then(r => r || caches.match('/gymtracker.html'))
      )
  );
});
