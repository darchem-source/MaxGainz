// Max Gainz — Service Worker
//
// Strategy:
//   - Navigations (HTML page load): network-first with cache fallback.
//     Fresh deploys reach users on next online launch; offline still works.
//   - Static external assets (Google Fonts CSS+woff2, Lottie CDN):
//     cache-first. They rarely change and we want fast offline launch.
//   - Supabase API: never intercepted — let it fail naturally when offline.
//   - Self-hosted exercise-media/: served from the user's offline download
//     (MEDIA_CACHE) when present, else network; never cached implicitly.
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
// Offline exercise media (Phase 3). A SEPARATE, long-lived cache the page fills
// on request ("Download for offline"). Entries are keyed
// exercise-media/{id}/{file}?v={hash8}; the page deletes entries whose hash no
// longer matches EX_MEDIA_FILES, so a shell update never re-downloads media.
// Bump the suffix only if the key SCHEMA changes — older media caches are then
// deleted on activate. Must equal MEDIA_CACHE_NAME in index.html (gate 19).
const MEDIA_CACHE = 'maxgainz-media-v1';
const MEDIA_PREFIX = 'maxgainz-media-';

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

// Which caches an activating worker may delete: older app-shell caches and
// older media-cache SCHEMAS only. The current media cache (the user's offline
// download) and any cache this app does not own are never touched.
function _swStaleCache(k){
  if(k === CACHE_NAME || k === MEDIA_CACHE) return false;
  if(k.startsWith(MEDIA_PREFIX)) return true;
  return /^maxgainz-v\d+$/.test(k);
}

// ── ACTIVATE: delete old caches, take control ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(_swStaleCache).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// A video element asks for byte ranges; iOS Safari will not play a clip that
// answers a Range request with a full 200. Build the 206 from the cached body.
function _swParseRange(h, size){
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if(!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if(m[1] === ''){ const n = +m[2]; if(!(n > 0)) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if(!(start >= 0) || start > end || start >= size) return null;
  return { start, end };
}
async function _swMediaResponse(req){
  const cache = await caches.open(MEDIA_CACHE);
  // Keys carry ?v=hash; the page requests the bare path. The page removes
  // entries whose hash is stale, so at most one version of a file is present.
  const hit = await cache.match(req.url.split('?')[0], { ignoreSearch: true, ignoreVary: true });
  if(!hit) return fetch(req);          // not downloaded: plain network, never cached here
  const range = req.headers.get('range');
  if(!range) return hit;
  const buf = await hit.arrayBuffer();
  const r = _swParseRange(range, buf.byteLength);
  const type = hit.headers.get('content-type') || 'application/octet-stream';
  if(!r) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + buf.byteLength } });
  return new Response(buf.slice(r.start, r.end + 1), { status: 206, headers: {
    'Content-Type': type,
    'Content-Range': 'bytes ' + r.start + '-' + r.end + '/' + buf.byteLength,
    'Content-Length': String(r.end - r.start + 1),
    'Accept-Ranges': 'bytes'
  }});
}

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

  // Self-hosted exercise media: served from the offline download when present,
  // otherwise straight from the network (nothing is cached lazily — the media
  // cache only ever holds what the user chose to download). Same origin only:
  // ExerciseDB GIFs/V2 clips never reach this branch.
  if (url.origin === self.location.origin && url.pathname.includes('/exercise-media/') && e.request.method === 'GET') {
    e.respondWith(_swMediaResponse(e.request).catch(() => fetch(e.request)));
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
