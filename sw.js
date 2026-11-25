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
//   - App modules (/app/*.js, Priority 7 slice 6): precached on install,
//     network-first, cached copy as the offline fallback (see MODULE_FILES).
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

const CACHE_NAME = 'maxgainz-v4';   // v4: app modules precached (SHELL changed)
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
  // Lottie player used for completion celebrations (self-hosted copy).
  '/vendor/lottie_light-5.12.2.min.js'
];

// App modules (Priority 7 slice 6). Today the page still has every module
// inlined; a LATER release may load some of them as files (step B in
// docs/architecture.md). That release is only safe once this worker is live
// and activated, so it precaches every module now: a page that needs them can
// then start offline. Must equal tools/bundle.py MODULES (gate 38).
const MODULE_FILES = [
  '/app/rollout.js', '/app/sync.js', '/app/session.js', '/app/ai-validators.js',
  '/app/ai.js', '/app/rules.js', '/app/media.js', '/app/profile-icons.js'
];
SHELL.push(...MODULE_FILES);

// Hosts whose responses we cache lazily on first successful fetch.
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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
  // The page requests exercise-media/{id}/{file}?v={hash8} — the same string
  // as the cache key — so only the CURRENT version of a file can ever match;
  // a stale copy left in the cache is simply never served.
  let hit = null;
  try {
    const cache = await caches.open(MEDIA_CACHE);
    hit = await cache.match(req.url, { ignoreVary: true });
  } catch(e){ hit = null; }
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

// App module request: network-first. The page adds ?v=<APP_VERSION> so HTTP
// caches never serve a stale file; each fetched version is cached under its
// own URL and older versions of that file are dropped. Offline: the exact
// version if cached, else the copy precached at install (any version), else
// a 504 the page can handle.
async function _swModuleResponse(req, url){
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if(res && res.ok){
      const copy = res.clone();
      try {
        const keys = cache.keys ? await cache.keys() : [];
        await Promise.all(keys.filter(k => {
          const u = new URL(typeof k === 'string' ? k : k.url);
          return u.pathname === url.pathname && u.search !== url.search && u.search !== '';
        }).map(k => cache.delete(k)));
        await cache.put(url.pathname + url.search, copy);
      } catch(e){}
      return res;
    }
    const hit = await cache.match(url.pathname + url.search) || await cache.match(url.pathname);
    return hit || res;
  } catch(e){
    const hit = await cache.match(url.pathname + url.search) || await cache.match(url.pathname);
    return hit || new Response('', { status: 504, headers: { 'Content-Type': 'text/plain' } });
  }
}

// ── MESSAGE: page taps "Update available" → activate the new SW ──
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // The page asks which media cache this worker serves before it promises
  // "available offline" (an older worker would silently ignore the download).
  if (e.data && e.data.type === 'MEDIA_CAPS' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ media: MEDIA_CACHE });
  }
  // Before a release loads modules as files, the page can ask whether the
  // controlling worker precaches them (an older one would not).
  if (e.data && e.data.type === 'MODULE_CAPS' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ modules: MODULE_FILES.slice(), cache: CACHE_NAME });
  }
  // Same idea for training-day reminders: the page only subscribes once the
  // controlling worker can actually show them (an older one would not).
  if (e.data && e.data.type === 'PUSH_CAPS' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ push: 1, meta: PUSH_META_CACHE });
  }
});

// ── PUSH: training-day reminders (Phase 4) ──
// The payload is {v:1, kind:'train'|'test', label, date}. Nothing in it is
// shown as-is: the text comes from PUSH_LABEL_TEXT below (must equal the copy
// in index.html), unknown values fall back to the generic line, and a tap
// always opens this app's own Today screen.
const PUSH_META_CACHE = 'maxgainz-push-v1';
const PUSH_METRICS_PATH = '/__mg_push_metrics';
const PUSH_LABEL_TEXT = { upper:'Upper day today', lower:'Lower day today', full:'Full-body day today', push:'Push day today', pull:'Pull day today', legs:'Leg day today', hiit:'HIIT day today', cardio:'Cardio day today', train:"Today's a planned training day" };

function _swPushNote(d) {
  const ok = d && typeof d === 'object' && d.v === 1;
  const kind = ok && d.kind === 'test' ? 'test' : 'train';
  const label = ok && typeof d.label === 'string' && Object.prototype.hasOwnProperty.call(PUSH_LABEL_TEXT, d.label) ? d.label : 'train';
  const date = ok && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : '';
  return {
    title: kind === 'test' ? 'Test reminder' : 'Time to train',
    options: {
      body: kind === 'test' ? 'Reminders are working on this device.' : PUSH_LABEL_TEXT[label],
      tag: 'mg-' + kind + (date ? '-' + date : ''),
      icon: '/icon.png',
      badge: '/icon.png',
      data: { go: 'today' }
    }
  };
}
function _swLocalDay() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Per-device counts (last 60 days kept). Never sent anywhere. Updates run one
// at a time so two events close together can't overwrite each other.
let _swCountQ = Promise.resolve();
function _swPushCount(what) {
  _swCountQ = _swCountQ.then(() => _swPushCountNow(what), () => _swPushCountNow(what));
  return _swCountQ;
}
async function _swPushCountNow(what) {
  try {
    const c = await caches.open(PUSH_META_CACHE);
    const r = await c.match(PUSH_METRICS_PATH);
    let m = null;
    try { m = r ? await r.json() : null; } catch (e) { m = null; }
    if (!m || typeof m !== 'object' || !m.days || typeof m.days !== 'object') m = { v: 1, days: {} };
    const k = _swLocalDay();
    const day = m.days[k] && typeof m.days[k] === 'object' ? m.days[k] : { shown: 0, opened: 0 };
    day[what] = (Number.isFinite(day[what]) ? day[what] : 0) + 1;
    m.days[k] = day;
    Object.keys(m.days).sort().slice(0, -60).forEach(x => { delete m.days[x]; });
    await c.put(PUSH_METRICS_PATH, new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {}
}

self.addEventListener('push', e => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch (err) { d = null; }
  const n = _swPushNote(d);
  e.waitUntil(Promise.all([
    self.registration.showNotification(n.title, n.options),
    _swPushCount('shown')
  ]));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(Promise.all([
    _swPushCount('opened'),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Only an app window (never the separate /share viewer or another page).
      const own = list.filter(c => {
        try { const u = new URL(c.url); return u.origin === self.location.origin && (u.pathname === '/' || u.pathname === '/index.html'); }
        catch (err) { return false; }
      });
      if (own.length) {
        const c = own[0];
        try { c.postMessage({ type: 'OPEN_TODAY' }); } catch (err) {}
        return c.focus ? c.focus() : undefined;
      }
      return self.clients.openWindow ? self.clients.openWindow('/?go=today') : undefined;
    })
  ]));
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Supabase — let calls fail naturally offline.
  if (url.hostname.includes('supabase.co')) return;

  // Never intercept the ExerciseDB proxy — media URLs rotate weekly and the
  // plan forbids caching, so these must always hit the network fresh.
  if (url.pathname.startsWith('/api/')) return;

  // The private-share viewer is independent of the app: never cached here and
  // never answered with the app shell (it needs the network anyway).
  if (url.origin === self.location.origin && (url.pathname === '/share' || url.pathname === '/share.html' || url.pathname === '/share.js')) return;

  // Self-hosted exercise media: served from the offline download when present,
  // otherwise straight from the network (nothing is cached lazily — the media
  // cache only ever holds what the user chose to download). Same origin only:
  // ExerciseDB GIFs/V2 clips never reach this branch.
  if (url.origin === self.location.origin && url.pathname.includes('/exercise-media/') && e.request.method === 'GET') {
    e.respondWith(_swMediaResponse(e.request));
    return;
  }

  // App modules: network-first with the precached copy as the offline fallback.
  if (url.origin === self.location.origin && url.pathname.startsWith('/app/') && url.pathname.endsWith('.js') && e.request.method === 'GET') {
    e.respondWith(_swModuleResponse(e.request, url));
    return;
  }

  // Self-hosted vendor scripts (Lottie): cache-first from the precached shell,
  // so celebrations work offline; refreshed into the cache on a miss.
  if (url.origin === self.location.origin && url.pathname.startsWith('/vendor/') && e.request.method === 'GET') {
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }

  // Navigation requests (HTML): network-first, cache fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            // Keyed by path: '/?go=today' (a reminder tap) and '/' share one copy.
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(url.origin + url.pathname, clone));
          }
          return res;
        })
        .catch(() =>
          // Offline — serve last cached HTML for this path (query ignored),
          // then fall back to /index.html (the canonical shell).
          caches.match(url.origin + url.pathname).then(r => r || caches.match('/index.html'))
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
