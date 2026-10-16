/* Max Gainz: native bridge (window.MGNative)
 *
 * One small, dependency-free file loaded by index.html with a plain <script>
 * tag in <head>, before the main inline script. It gives the page a single
 * API that works in both places the app runs:
 *
 *   - iOS app (Capacitor 8): calls the native plugins through
 *     window.Capacitor.Plugins. Capacitor injects those objects before any
 *     page script runs, so no bundler or import is needed.
 *   - Web (maxgainz.netlify.app): falls back to the web APIs the app uses
 *     today (Notification, navigator.vibrate, Wake Lock, Web Share,
 *     window.open), or does nothing.
 *
 * Rules: every method returns a Promise that always resolves (never rejects)
 * and never throws, so a call site can never break the page.
 *
 *   MGNative.isNative                         true inside the iOS app
 *   MGNative.platform                         'ios' | 'android' | 'web'
 *   MGNative.notify.requestPermission()       -> 'granted' | 'denied' | 'default' | 'unsupported'
 *   MGNative.notify.checkPermission()         same values, never shows a prompt
 *   MGNative.notify.schedule({id, at, title, body})  -> true if scheduled/shown
 *       id: number or string (strings map to a stable integer for iOS).
 *       at: Date | ms timestamp | ISO string; omit (or past) = now.
 *       Never prompts: returns false unless permission is already granted.
 *       Web: shows it now if `at` is now/past (as the app does today);
 *       a future `at` is a no-op that returns false (the web has no scheduler).
 *   MGNative.notify.cancel(id)                -> true if cancelled/closed
 *   MGNative.haptic(kind, webPattern?)        kind: light | medium | heavy |
 *       success | warning | error. webPattern (optional) is the exact
 *       navigator.vibrate() pattern to keep on the web, e.g. [80,60,80].
 *   MGNative.keepAwake(on)                    -> true while the screen is held awake
 *   MGNative.share({title, text, url, files}) -> {shared: true} or
 *       {shared: false, reason: 'cancelled' | 'unsupported' | 'empty' | 'error'}
 *       files: File or Blob objects (for example a canvas.toBlob() PNG).
 *   MGNative.openExternal(url)                http(s) opens in an in-app Safari
 *       sheet on iOS and a new tab on the web; mailto:/tel:/sms: go to the
 *       system app. -> true if handed off.
 *   MGNative.purchases                        RevenueCat (@revenuecat/purchases-
 *       capacitor) in the app; on the web every call resolves to an
 *       "unavailable" result and `available` is false. See the section below.
 *   MGNative.onAppState(cb)                   cb(isActive) on app background/
 *       foreground (Capacitor App plugin); web: visibilitychange.
 */
(function (w) {
  'use strict';
  if (w.MGNative) return; // loaded twice: keep the first instance

  var Cap = w.Capacitor;
  var isNative = false;
  var platform = 'web';
  try {
    isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
    if (isNative && typeof Cap.getPlatform === 'function') platform = String(Cap.getPlatform() || 'web');
  } catch (e) { isNative = false; platform = 'web'; }
  // Lets CSS hide web-only mark-up ([data-web-only]) before the first paint.
  if (isNative) { try { document.documentElement.classList.add('mg-native'); } catch (e) {} }

  // ── helpers ────────────────────────────────────────────────────────────
  // safe(fn, fallback): run fn and resolve with its result, or with the
  // fallback if anything throws or rejects. fn starts synchronously, inside
  // the caller's tap handler: Safari only allows navigator.share(),
  // window.open() and permission prompts during a user gesture.
  function safe(fn, fallback) {
    var fb = function () { return typeof fallback === 'function' ? fallback() : fallback; };
    return function () {
      try {
        return Promise.resolve(fn.apply(null, arguments)).then(undefined, fb);
      } catch (e) {
        return Promise.resolve(fb());
      }
    };
  }
  function plugin(name) {
    var P = isNative && w.Capacitor && w.Capacitor.Plugins;
    return (P && P[name]) || null;
  }
  function has(name, method) {
    var p = plugin(name);
    return !!(p && typeof p[method] === 'function');
  }
  function call(name, method, args) {
    var p = plugin(name);
    if (!p || typeof p[method] !== 'function') return Promise.reject(new Error(name + '.' + method + ' unavailable'));
    return Promise.resolve(p[method](args || {}));
  }

  // ── notifications ──────────────────────────────────────────────────────
  // iOS needs an integer id. Integers (or integer strings) pass through;
  // anything else is hashed (FNV-1a) to a stable positive 31-bit integer.
  function nativeId(id) {
    var n = typeof id === 'number' ? id : (/^-?\d+$/.test(String(id)) ? parseInt(id, 10) : NaN);
    if (isFinite(n) && Math.floor(n) === n && n >= -2147483648 && n <= 2147483647) return n;
    var s = String(id), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 1) || 1;
  }
  function toDate(at) {
    if (at === undefined || at === null || at === '') return new Date();
    var d = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    return isNaN(d.getTime()) ? null : d;
  }
  function mapPermission(p) {
    if (p === 'granted' || p === 'denied') return p;
    return 'default'; // 'prompt', 'prompt-with-rationale', 'default'
  }
  function webPermission() {
    if (!('Notification' in w)) return 'unsupported';
    return mapPermission(w.Notification.permission);
  }
  var webShown = {}; // tag -> Notification shown by schedule() on the web

  var checkPermission = safe(function () {
    if (isNative) {
      if (!has('LocalNotifications', 'checkPermissions')) return 'unsupported';
      return call('LocalNotifications', 'checkPermissions').then(function (r) { return mapPermission(r && r.display); });
    }
    return webPermission();
  }, 'unsupported');

  var requestPermission = safe(function () {
    if (isNative) {
      if (!has('LocalNotifications', 'requestPermissions')) return 'unsupported';
      return checkPermission().then(function (p) {
        if (p !== 'default') return p; // iOS only ever asks once
        return call('LocalNotifications', 'requestPermissions').then(function (r) { return mapPermission(r && r.display); });
      });
    }
    var cur = webPermission();
    if (cur !== 'default') return cur;
    return new Promise(function (resolve) {
      var done = false;
      function finish(p) { if (!done) { done = true; resolve(mapPermission(p || w.Notification.permission)); } }
      try {
        var ret = w.Notification.requestPermission(finish); // old Safari: callback form only
        if (ret && typeof ret.then === 'function') ret.then(finish, function () { finish(); });
      } catch (e) { finish(); }
    });
  }, 'unsupported');

  var schedule = safe(function (opts) {
    opts = opts || {};
    if (opts.id === undefined || opts.id === null) return false;
    var at = toDate(opts.at);
    if (!at) return false;
    var title = String(opts.title == null ? '' : opts.title);
    var body = String(opts.body == null ? '' : opts.body);
    if (isNative) {
      return checkPermission().then(function (p) {
        if (p !== 'granted') return false;
        return call('LocalNotifications', 'schedule', {
          notifications: [{ id: nativeId(opts.id), title: title, body: body, schedule: { at: at } }]
        }).then(function () { return true; });
      });
    }
    // Web: today's behaviour is an immediate OS notification, deduped by tag.
    if (webPermission() !== 'granted') return false;
    if (at.getTime() > Date.now() + 1000) return false;
    var tag = String(opts.id);
    var n = new w.Notification(title, { body: body, tag: tag, silent: false, requireInteraction: false });
    n.onclick = function () { try { w.focus(); n.close(); } catch (e) {} };
    n.onclose = function () { if (webShown[tag] === n) delete webShown[tag]; };
    webShown[tag] = n;
    return true;
  }, false);

  var cancel = safe(function (id) {
    if (id === undefined || id === null) return false;
    if (isNative) {
      return call('LocalNotifications', 'cancel', { notifications: [{ id: nativeId(id) }] })
        .then(function () { return true; });
    }
    var tag = String(id), n = webShown[tag];
    if (!n) return false;
    delete webShown[tag];
    n.close();
    return true;
  }, false);

  // ── haptics ────────────────────────────────────────────────────────────
  var IMPACT = { light: 'LIGHT', medium: 'MEDIUM', heavy: 'HEAVY' };
  var NOTICE = { success: 'SUCCESS', warning: 'WARNING', error: 'ERROR' };
  // Web defaults, in the style of the vibrate() patterns index.html uses.
  var WEB_PATTERN = { light: 15, medium: 20, heavy: 30, success: [18, 24, 18], warning: [80, 60, 80], error: [100, 80, 100, 80, 100] };

  var haptic = safe(function (kind, webPattern) {
    if (typeof kind !== 'string') { webPattern = kind; kind = 'medium'; } // legacy vibrate pattern
    kind = kind.toLowerCase();
    if (isNative) {
      if (NOTICE[kind]) return call('Haptics', 'notification', { type: NOTICE[kind] }).then(function () { return true; });
      return call('Haptics', 'impact', { style: IMPACT[kind] || 'MEDIUM' }).then(function () { return true; });
    }
    var pattern = webPattern != null ? webPattern : (WEB_PATTERN[kind] != null ? WEB_PATTERN[kind] : 20);
    if (!w.navigator || typeof w.navigator.vibrate !== 'function') return false; // e.g. iOS Safari
    return !!w.navigator.vibrate(pattern);
  }, false);

  // ── keep awake ─────────────────────────────────────────────────────────
  var wakeWanted = false, wakeSentinel = null, wakeListening = false;
  function acquireWebWakeLock() {
    return w.navigator.wakeLock.request('screen').then(function (s) { wakeSentinel = s; return true; });
  }
  var keepAwake = safe(function (on) {
    on = !!on;
    if (isNative) {
      return call('KeepAwake', on ? 'keepAwake' : 'allowSleep').then(function () { return on; });
    }
    wakeWanted = on;
    if (!on) {
      var s = wakeSentinel; wakeSentinel = null;
      if (s) { try { Promise.resolve(s.release()).then(undefined, function () {}); } catch (e) {} }
      return false;
    }
    if (!w.navigator || !('wakeLock' in w.navigator)) return false;
    if (!wakeListening) {
      wakeListening = true;
      // The browser drops the lock when the page is hidden; take it back on return.
      document.addEventListener('visibilitychange', function () {
        if (wakeWanted && document.visibilityState === 'visible' && (!wakeSentinel || wakeSentinel.released)) {
          acquireWebWakeLock().then(undefined, function () {});
        }
      });
    }
    if (wakeSentinel && !wakeSentinel.released) return true;
    return acquireWebWakeLock();
  }, false);

  // ── share ──────────────────────────────────────────────────────────────
  var EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv', 'application/pdf': '.pdf' };
  function fileName(f, i) {
    var raw = (f && typeof f.name === 'string' && f.name) || ('share-' + (i + 1) + (EXT[f && f.type] || '.bin'));
    return raw.replace(/[^\w.\-]+/g, '_').slice(-80);
  }
  function toFiles(list) {
    var out = [];
    (Array.isArray(list) ? list : (list ? [list] : [])).forEach(function (f, i) {
      if (typeof Blob === 'undefined' || !(f instanceof Blob)) return;
      if (typeof File === 'undefined' || f instanceof File) { out.push(f); return; }
      out.push(new File([f], fileName(f, i), { type: f.type || 'application/octet-stream' }));
    });
    return out;
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  // Write a Blob to Caches/mg-share/<name> and return its file:// URI.
  // Names are reused, so the folder never grows beyond the last share.
  function writeShareFile(f, i) {
    return blobToBase64(f).then(function (data) {
      return call('Filesystem', 'writeFile', { path: 'mg-share/' + fileName(f, i), data: data, directory: 'CACHE', recursive: true });
    }).then(function (r) { return r && r.uri; });
  }
  function shareFailure(e) {
    var msg = String((e && (e.name + ' ' + e.message)) || e || '');
    return { shared: false, reason: /abort|cancel/i.test(msg) ? 'cancelled' : 'error' };
  }

  var share = safe(function (opts) {
    opts = opts || {};
    var title = opts.title ? String(opts.title) : undefined;
    var text = opts.text ? String(opts.text) : undefined;
    var url = opts.url ? String(opts.url) : undefined;
    var files = toFiles(opts.files);
    if (!title && !text && !url && !files.length) return { shared: false, reason: 'empty' };

    if (isNative && has('Share', 'share')) {
      // The native share sheet takes file URLs, so Blobs are written to the
      // app's cache first. A file that fails to write is left out.
      var uris = files.length && has('Filesystem', 'writeFile')
        ? Promise.all(files.map(function (f, i) { return writeShareFile(f, i).then(undefined, function () { return null; }); }))
        : Promise.resolve([]);
      return uris.then(function (list) {
        list = list.filter(Boolean);
        if (files.length && !list.length && !text && !url) return { shared: false, reason: 'unsupported' };
        var data = {};
        if (title) data.title = title;
        if (text) data.text = text;
        if (url) data.url = url;
        if (list.length) data.files = list;
        return call('Share', 'share', data).then(function () { return { shared: true }; }, shareFailure);
      });
    }

    // Web: the app's existing navigator.share() path.
    var nav = w.navigator;
    if (!nav || typeof nav.share !== 'function') return { shared: false, reason: 'unsupported' };
    var payload = {};
    if (title) payload.title = title;
    if (text) payload.text = text;
    if (url) payload.url = url;
    if (files.length) {
      if (typeof nav.canShare === 'function' && nav.canShare({ files: files })) payload.files = files;
      else if (!text && !url) return { shared: false, reason: 'unsupported' };
    }
    return nav.share(payload).then(function () { return { shared: true }; }, shareFailure);
  }, function () { return { shared: false, reason: 'error' }; });

  // ── external links ─────────────────────────────────────────────────────
  var openExternal = safe(function (url) {
    var u = new URL(String(url)); // absolute URLs only: relative ones throw -> false
    var scheme = u.protocol;
    if (scheme === 'http:' || scheme === 'https:') {
      if (isNative && has('Browser', 'open')) {
        return call('Browser', 'open', { url: u.href }).then(function () { return true; });
      }
      var win = w.open(u.href, '_blank');
      if (!win) return false; // popup blocked
      try { win.opener = null; } catch (e) {}
      return true;
    }
    if (scheme === 'mailto:' || scheme === 'tel:' || scheme === 'sms:') {
      // In the app Capacitor hands non-app URLs to iOS (Mail, Phone, Messages).
      w.location.href = u.href;
      return true;
    }
    return false; // never navigate the app itself away (javascript:, data:, file: ...)
  }, false);

  // ── app state (foreground / background) ────────────────────────────────
  var onAppState = function (cb) {
    if (typeof cb !== 'function') return false;
    if (isNative && has('App', 'addListener')) {
      try { plugin('App').addListener('appStateChange', function (ev) { try { cb(!!(ev && ev.isActive)); } catch (e) {} }); return true; } catch (e) { return false; }
    }
    document.addEventListener('visibilitychange', function () { try { cb(document.visibilityState === 'visible'); } catch (e) {} });
    return true;
  };

  // ── purchases (RevenueCat) ─────────────────────────────────────────────
  // The public SDK key is written into the copy of this file that ships in
  // the app by native/scripts/prepare-www.mjs (from capacitor.config.json
  // plugins.MaxGainzNative.revenueCatApiKey). The web copy keeps the
  // placeholder and never configures RevenueCat.
  var RC_API_KEY = '__MG_RC_API_KEY__';
  var rcAvailable = isNative && !!plugin('Purchases') && /^appl_/.test(RC_API_KEY);
  var rcConfigured = false;
  // Error shape from the Capacitor bridge: {code:'1', message, data:{readableErrorCode,…}}
  function rcError(e) {
    var code = String((e && (e.code || (e.data && e.data.code))) || '');
    var readable = (e && e.data && e.data.readableErrorCode) || '';
    return { code: code, readable: readable, message: String((e && e.message) || e || 'Unknown error'),
      cancelled: code === '1' || /CANCELLED/i.test(readable),
      pending: code === '20' || /PENDING/i.test(readable),
      network: code === '10' || code === '35' || /NETWORK|OFFLINE/i.test(readable) };
  }
  var unavailable = { ok: false, unavailable: true };
  function rc(method, args) {
    if (!rcAvailable) return Promise.resolve(unavailable);
    return call('Purchases', method, args || {})
      .then(function (r) { return { ok: true, value: r }; }, function (e) { return { ok: false, error: rcError(e) }; });
  }
  var purchases = {
    available: rcAvailable,
    configure: safe(function (opts) {
      if (!rcAvailable) return unavailable;
      var args = { apiKey: RC_API_KEY };
      if (opts && opts.appUserID) args.appUserID = String(opts.appUserID);
      return rc('configure', args).then(function (r) { rcConfigured = rcConfigured || r.ok; return r; });
    }, unavailable),
    isConfigured: function () { return rcConfigured; },
    getOfferings: safe(function () { return rc('getOfferings'); }, unavailable),
    getCustomerInfo: safe(function () { return rc('getCustomerInfo').then(function (r) { return r.ok ? { ok: true, value: (r.value && r.value.customerInfo) || r.value } : r; }); }, unavailable),
    purchasePackage: safe(function (pkg) { return rc('purchasePackage', { aPackage: pkg }); }, unavailable),
    restorePurchases: safe(function () { return rc('restorePurchases').then(function (r) { return r.ok ? { ok: true, value: (r.value && r.value.customerInfo) || r.value } : r; }); }, unavailable),
    checkTrialEligibility: safe(function (ids) { return rc('checkTrialOrIntroductoryPriceEligibility', { productIdentifiers: ids || [] }); }, unavailable),
    logIn: safe(function (id) { return rc('logIn', { appUserID: String(id) }); }, unavailable),
    logOut: safe(function () { return rc('logOut'); }, unavailable),
    getAppUserID: safe(function () { return rc('getAppUserID'); }, unavailable),
    // cb(customerInfo) whenever RevenueCat reports a change (renewal, expiry…)
    onCustomerInfo: function (cb) {
      if (!rcAvailable || typeof cb !== 'function' || !has('Purchases', 'addCustomerInfoUpdateListener')) return false;
      try { plugin('Purchases').addCustomerInfoUpdateListener({}, function (info) { try { if (info) cb(info.customerInfo || info); } catch (e) {} }); return true; } catch (e) { return false; }
    }
  };

  // ── native launch splash ───────────────────────────────────────────────
  // capacitor.config.json keeps the launch splash up for at most 3 s; hide it
  // as soon as the page has painted (the page then shows its own splash).
  if (isNative) {
    var splashHidden = false;
    var hideSplash = function () {
      if (splashHidden) return;
      splashHidden = true;
      var raf = w.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { call('SplashScreen', 'hide', {}).then(undefined, function () {}); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideSplash);
    else hideSplash();
  }

  w.MGNative = {
    version: 1,
    isNative: isNative,
    platform: platform,
    notify: { requestPermission: requestPermission, checkPermission: checkPermission, schedule: schedule, cancel: cancel },
    haptic: haptic,
    keepAwake: keepAwake,
    share: share,
    openExternal: openExternal,
    onAppState: onAppState,
    purchases: purchases
  };
})(window);
