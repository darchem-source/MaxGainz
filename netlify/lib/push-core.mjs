// Max Gainz training-day reminders (Phase 4) — pure scheduler and send logic.
// No imports and no I/O: everything that touches the network is passed in
// (rpc, send), so gate 23 runs this file in jsc with stubs. Used by
// netlify/functions/push-reminders (hourly) and netlify/functions/push-api.
//
// What a reminder carries: {v:1, kind:'train'|'test', label, date}. The label
// is one word from PUSH_LABELS; sw.js turns it into fixed text. No names,
// weights, notes, counts or user ids are ever in a payload.

export const PUSH_SB_URL = 'https://lxudaetjuefylgjddonm.supabase.co';
export const PUSH_SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4dWRhZXRqdWVmeWxnamRkb25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NTU1MzgsImV4cCI6MjA5MjMzMTUzOH0.Wr-9l63vjBQKu1NQPQsTJFwHwJiE9jhMxvJnR4P9wjg';
export const PUSH_LABELS = ['upper','lower','full','push','pull','legs','hiit','cardio','train'];
// Must equal PUSH_HOST_RE in index.html and push_endpoint_ok() in supabase/push_reminders.sql (gate 23).
export const PUSH_HOST_RE = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
export const PUSH_WINDOW_HOURS = 3;     // due from the chosen hour until 3 hours later (missed runs, retries, DST gaps)
export const PUSH_TTL_SECONDS = 3 * 3600; // a phone that's offline gets it within the window, never hours later
export const PUSH_CONCURRENCY = 8;

const _fmtCache = {};
// The local calendar date, hour and ISO weekday (Mon = 1) of an instant in a time
// zone. null when the zone is unknown.
export function pushLocalInfo(ms, tz){
  let f = _fmtCache[tz];
  if(!f){
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    } catch(e){ return null; }
    _fmtCache[tz] = f;
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday) + 1;
  const hour = parseInt(p.hour, 10) % 24;
  if(!dow || !(hour >= 0)) return null;
  return { date: p.year + '-' + p.month + '-' + p.day, hour, isoDow: dow };
}

// Is this account due a reminder right now? Returns { date, isoDow } or null.
// row: { hour, days (bitmask, Mon = 1 … Sun = 64), tz, last_sent_on }.
export function pushDueNow(row, nowMs){
  if(!row || typeof row !== 'object') return null;
  if(!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23) return null;
  if(!Number.isInteger(row.days) || row.days <= 0 || row.days > 127) return null;
  const li = pushLocalInfo(nowMs, row.tz);
  if(!li) return null;
  if(!(row.days & (1 << (li.isoDow - 1)))) return null;
  const dh = li.hour - row.hour;
  if(dh < 0 || dh >= PUSH_WINDOW_HOURS) return null;
  if(typeof row.last_sent_on === 'string' && row.last_sent_on >= li.date) return null;
  return { date: li.date, isoDow: li.isoDow };
}

// Did the account log a workout on its own local "today"?
export function pushTrainedToday(lastSessionAt, nowMs, tz){
  if(!lastSessionAt) return false;
  const t = Date.parse(lastSessionAt);
  if(!Number.isFinite(t)) return false;
  const a = pushLocalInfo(t, tz), b = pushLocalInfo(nowMs, tz);
  if(!a || !b) return false;
  return a.date >= b.date;   // a session dated later today (or a clock-skewed future one) also counts
}

export function pushLabel(v){ return PUSH_LABELS.indexOf(v) !== -1 ? v : 'train'; }

// The only payload ever sent.
export function pushPayload(kind, label, date){
  return JSON.stringify({ v: 1, kind: kind === 'test' ? 'test' : 'train', label: pushLabel(label), date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : '' });
}

export function pushEndpointOk(e){
  if(typeof e !== 'string' || e.length > 1024) return false;
  const m = /^https:\/\/([^\/?#:@]+)(?::\d{1,5})?\//.exec(e);
  return !!m && PUSH_HOST_RE.test(m[1]);
}

// What a push service's answer means for this device.
//   ok    — delivered to the push service
//   gone  — 404/410: the subscription no longer exists; delete it
//   retry — 429/5xx/network/timeout: try again next run (inside the window)
//   fail  — anything else (4xx: our request or our keys are wrong); keep the device
export function pushClassify(status){
  if(status >= 200 && status < 300) return 'ok';
  if(status === 404 || status === 410) return 'gone';
  if(!status || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

async function _pool(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while(i < items.length){ const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// Send one payload to a list of devices. Returns per-device outcomes.
export async function pushSendAll(subs, payloadFor, send, late, sendTimeout){
  return _pool(subs, PUSH_CONCURRENCY, async (s) => {
    if(!s || !pushEndpointOk(s.endpoint)) return { sid: s && s.sid, pid: s && s.pid, out: 'fail' };
    if(late && late()) return { sid: s.sid, pid: s.pid, out: 'skipped' };   // out of time: released, retried next run
    let status = 0;
    const payload = payloadFor(s);
    const topic = JSON.parse(payload).kind === 'test' ? 'mg-test' : 'mg-train';
    try { const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { ttl: PUSH_TTL_SECONDS, topic, timeout: sendTimeout || 6000 }); status = r && r.status || 0; }
    catch(e){ status = (e && e.statusCode) || 0; }
    return { sid: s.sid, pid: s.pid, out: pushClassify(status) };
  });
}

// One run. deps: { key, scope ('prod' or a preview origin), origins [..], now (ms),
//   rpc(name, body) → parsed JSON or null, send(sub, payload, opts) → {status},
//   deadline (ms, optional: stop starting new sends after it), sendTimeout (ms) }
// At most once: a claim records the reminder BEFORE it is sent. Only an account
// none of whose devices was reached (temporary failure, or out of time) is
// released for the next run. A run killed mid-way can lose a reminder; it can
// never send one twice.
export async function pushRunScheduler(deps){
  const sum = { ok: false, candidates: 0, due: 0, skippedTrained: 0, claimed: 0, sent: 0, devices: 0, gone: 0, retried: 0, failed: 0 };
  if(!deps || !deps.key || !deps.scope || !Array.isArray(deps.origins) || !deps.origins.length) return Object.assign(sum, { reason: 'config' });
  const c = await deps.rpc('push_candidates', { p_key: deps.key, p_scope: deps.scope, p_origins: deps.origins });
  if(!c || c.ok !== true || !Array.isArray(c.rows)) return Object.assign(sum, { reason: 'candidates' });
  sum.candidates = c.rows.length;
  const items = [], labelOf = {};
  c.rows.forEach(r => {
    const due = pushDueNow(r, deps.now);
    if(!due) return;
    sum.due++;
    if(pushTrainedToday(r.last_session_at, deps.now, r.tz)){ sum.skippedTrained++; return; }
    const labels = Array.isArray(r.labels) ? r.labels : [];
    labelOf[r.pid] = { label: pushLabel(labels[due.isoDow - 1]), date: due.date };
    items.push({ pid: r.pid, date: due.date });
  });
  let subs = [];
  for(let i = 0; i < items.length; i += 500){
    const cl = await deps.rpc('push_claim', { p_key: deps.key, p_scope: deps.scope, p_origins: deps.origins, p_items: items.slice(i, i + 500) });
    if(!cl || cl.ok !== true || !Array.isArray(cl.subs)) continue;   // unclaimed accounts are simply tried next run
    subs = subs.concat(cl.subs.filter(s => s && labelOf[s.pid]));
  }
  const claimedPids = [...new Set(subs.map(s => s.pid))];
  sum.claimed = claimedPids.length;
  const late = () => deps.deadline && Date.now() > deps.deadline;
  const res = await pushSendAll(subs, s => pushPayload('train', labelOf[s.pid].label, labelOf[s.pid].date), deps.send, late, deps.sendTimeout);
  const byPid = {};
  claimedPids.forEach(pid => { byPid[pid] = []; });
  res.forEach(r => { byPid[r.pid].push(r.out); });
  const okSids = res.filter(r => r.out === 'ok').map(r => r.sid);
  const goneSids = res.filter(r => r.out === 'gone').map(r => r.sid);
  const failSids = res.filter(r => r.out === 'fail').map(r => r.sid);
  const release = [];
  Object.keys(byPid).forEach(pid => {
    const outs = byPid[pid];
    if(outs.indexOf('ok') !== -1) sum.sent++;
    else if(outs.indexOf('retry') !== -1 || outs.indexOf('skipped') !== -1){ sum.retried++; release.push({ pid, date: labelOf[pid].date }); }
    else if(outs.indexOf('fail') !== -1){ sum.failed++; release.push({ pid, date: labelOf[pid].date }); }
  });
  sum.devices = okSids.length; sum.gone = goneSids.length;
  for(let i = 0; i < release.length; i += 500) await deps.rpc('push_release', { p_key: deps.key, p_scope: deps.scope, p_items: release.slice(i, i + 500) });
  await deps.rpc('push_report', { p_key: deps.key, p_ok: okSids, p_gone: goneSids, p_fail: failSids,
                                  p_sent: sum.sent, p_skipped: sum.skippedTrained, p_failed: sum.failed + sum.retried });
  sum.ok = true;
  return sum;
}

// "Send a test notification": the user's own devices, through their own token.
// deps: { key, rpcUser(name, body) → JSON|null (with the user's JWT), rpc (cron), send }
export async function pushRunTest(deps){
  const t = await deps.rpcUser('push_test_targets', {});
  if(t && t.__http === 401) return { ok: false, reason: 'auth' };
  if(!t || t.ok !== true || !Array.isArray(t.subs)) return { ok: false, reason: (t && t.reason) || 'targets' };
  if(!t.subs.length) return { ok: false, reason: 'none' };
  const res = await pushSendAll(t.subs, () => pushPayload('test', 'train', ''), deps.send, null, 5000);
  const gone = res.filter(r => r.out === 'gone').map(r => r.sid);
  if(gone.length && deps.key) await deps.rpc('push_report', { p_key: deps.key, p_ok: [], p_gone: gone, p_fail: [], p_sent: 0, p_skipped: 0, p_failed: 0 });
  const sent = res.filter(r => r.out === 'ok').length;
  return { ok: sent > 0, sent, gone: gone.length, devices: res.length };
}

// Supabase RPC over fetch. token = a user's JWT, or null for the anon key.
// Returns parsed JSON, or null on any failure (never throws).
export function pushRpcFetch(fetchFn, signal){
  return async (name, body, token) => {
    try {
      const res = await fetchFn(PUSH_SB_URL + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { 'apikey': PUSH_SB_ANON, 'Authorization': 'Bearer ' + (token || PUSH_SB_ANON), 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: signal ? signal() : undefined
      });
      if(!res) return null;
      if(!res.ok) return { ok: false, __http: res.status };   // never ok:true; lets callers tell an expired sign-in from an outage
      return await res.json();
    } catch(e){ return null; }
  };
}

function _sameSecret(a, b){
  a = String(a || ''); b = String(b || '');
  if(a.length < 32 || a.length !== b.length) return false;
  let d = 0;
  for(let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function _vapidReady(env){
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && /^(mailto:|https:\/\/)/.test(String(env.VAPID_SUBJECT || '')));
}

// /api/push/* — req: { method, path, origin, context (Netlify deploy context), auth, cronKey }; deps: { env, now, rpcFetch, send }.
// Fails closed: nothing is sent unless PUSH_ENABLED=1 and the VAPID keys are set.
export async function handlePushApi(req, deps){
  const env = (deps && deps.env) || {};
  const out = (status, body) => ({ status, body });
  if(env.PUSH_ENABLED !== '1') return out(503, { ok: false, reason: 'disabled' });
  const route = String(req.path || '').replace(/\/+$/, '');
  if(route === '/api/push/key'){
    if(req.method !== 'GET') return out(405, { ok: false, reason: 'method' });
    if(!env.VAPID_PUBLIC_KEY) return out(503, { ok: false, reason: 'not_configured' });
    return out(200, { ok: true, key: env.VAPID_PUBLIC_KEY });
  }
  if(route === '/api/push/test'){
    if(req.method !== 'POST') return out(405, { ok: false, reason: 'method' });
    const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(String(req.auth || ''));
    if(!m) return out(401, { ok: false, reason: 'auth' });
    if(!_vapidReady(env)) return out(503, { ok: false, reason: 'not_configured' });
    const r = await pushRunTest({
      key: env.PUSH_CRON_KEY || '',
      rpcUser: (n, b) => deps.rpcFetch(n, b, m[1]),
      rpc: (n, b) => deps.rpcFetch(n, b, null),
      send: deps.send
    });
    return out(r.ok ? 200 : ({ rate: 429, none: 404, auth: 401 }[r.reason] || 502), r);
  }
  if(route === '/api/push/run'){
    if(req.method !== 'POST') return out(405, { ok: false, reason: 'method' });
    if(!_sameSecret(req.cronKey, env.PUSH_CRON_KEY)) return out(403, { ok: false, reason: 'key' });
    if(!_vapidReady(env)) return out(503, { ok: false, reason: 'not_configured' });
    // On the production deploy this is exactly the hourly run (same 'prod' scope,
    // so it can never double-send); on a Deploy Preview / branch deploy it only
    // touches devices that subscribed on that deploy's origin, under its own scope.
    // Unknown context, or a "preview" on a production origin: refuse (fail closed).
    const ctx = String(req.context || '');
    const prodOrigins = pushProdOrigins(env);
    const origin = String(req.origin || '').replace(/\/+$/, '');
    let scope, origins;
    if(ctx === 'production'){ scope = 'prod'; origins = prodOrigins; }
    else if((ctx === 'deploy-preview' || ctx === 'branch-deploy') && /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin) && prodOrigins.indexOf(origin) === -1){ scope = origin; origins = [origin]; }
    else return out(400, { ok: false, reason: 'context' });
    if(!origins.length) return out(400, { ok: false, reason: 'origin' });
    // A synchronous function has ~10 s: stop starting sends after 3 s.
    const r = await pushRunScheduler({ key: env.PUSH_CRON_KEY, scope, origins, now: deps.now, deadline: Date.now() + 3000, sendTimeout: 4000,
                                       rpc: (n, b) => deps.rpcFetch(n, b, null), send: deps.send });
    return out(r.ok ? 200 : 502, r);
  }
  return out(404, { ok: false, reason: 'route' });
}

// The hourly scheduled run: same fail-closed rules as the API.
// deps: { env, now, rpcFetch, send }
export async function pushRunScheduled(deps){
  const env = (deps && deps.env) || {};
  if(env.PUSH_ENABLED !== '1') return { ok: false, reason: 'disabled' };
  if(!_vapidReady(env) || !env.PUSH_CRON_KEY) return { ok: false, reason: 'not_configured' };
  const origins = pushProdOrigins(env);
  if(!origins.length) return { ok: false, reason: 'origin' };
  // Scheduled functions get 30 s: start sends for 10 s, each send ≤ 6 s, then release/report (≤ 5 s each).
  return pushRunScheduler({ key: env.PUSH_CRON_KEY, scope: 'prod', origins, now: deps.now, deadline: Date.now() + 10000, sendTimeout: 6000,
                            rpc: (n, b) => deps.rpcFetch(n, b, null), send: deps.send });
}

// The production origins devices may have subscribed on: the primary URL, the
// site's own *.netlify.app name, and any extra listed in PUSH_ORIGINS.
export function pushProdOrigins(env){
  const list = [env.URL, env.SITE_NAME ? 'https://' + env.SITE_NAME + '.netlify.app' : '']
    .concat(String(env.PUSH_ORIGINS || '').split(','));
  const out = [];
  list.forEach(o => {
    o = String(o || '').trim().replace(/\/+$/, '');
    if(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o) && out.indexOf(o) === -1) out.push(o);
  });
  return out;
}
