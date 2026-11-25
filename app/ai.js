// app/ai.js — Max Gainz AI client: consent, gating, the one network path to
// /api/ai, local audit trail and metrics, controlled-beta enrolment.
// Priority 7, slice 4. Moved verbatim from index.html (no behaviour change).
//
// Edit THIS file, then run `python3 tools/bundle.py` (bundled at the top of
// index.html's script, after app/ai-validators.js). Gate 36 loads it on its own
// in jsc, with app/rollout.js and app/ai-validators.js, and stubs.
// Classic script; load time only runs the const initialisers (literals).
// Nothing here touches the DOM or shows a toast. UI stays in index.html:
// _aiIntroHtml / _aiIntro / aiIntroDone, aiCopyFailures, _aiApplyConsent,
// toggleAiCoach / toggleAiNotes, _renderAiSettings, _aiHealthHtml, the
// DOMContentLoaded and 'online' listeners, and every AI surface (coach card,
// typed sets, recap).
//
// Depends on earlier modules: app/rollout.js (AI_FLAG_KEYS, AI_COHORT_KEY,
// _aiFlagOn, _aiBetaPlan), app/ai-validators.js (_aiValidateFacts,
// _aiCheckOutput).
// RUN-TIME dependencies on index.html (never at load time; the test stubs each):
//   auth / network   isAuthenticated, getCurrentUserId, authToken, refreshAuthToken,
//                    sbFetch, fetch
//   state            userPreferences (.ai), cloudSaveProfile
//   UI refresh       _renderAiSettings, renderToday (both called inside try)
// Browser APIs: localStorage, navigator.onLine, setTimeout/clearTimeout,
// AbortController (optional), Date, Math.random.

// ── Phase 2: AI foundation ────────────────────────────────────────────────
// Rules: (1) every AI surface first renders the app's own deterministic text;
// AI wording replaces it only after validation. (2) _aiCall is the ONLY path
// to /api/ai, and it refuses unless the rollout flag is on, the user has
// consented (Profile → AI coaching), is signed in, online and under the cap.
// (3) Model output is plain text: always esc(), never inside an on*="" handler.
// (4) The audit trail and metrics live on this device only, per account.
const AI_CONSENT_VERSION = 1;
const AI_AUDIT_KEY = 'maxgainz_ai_audit_v1';
const AI_METRICS_KEY = 'maxgainz_ai_metrics_v1';
const AI_CACHE_KEY = 'maxgainz_ai_cache_v1';
const AI_PREFS_KEY = 'maxgainz_ai_prefs';
const AI_CLIENT_DAILY_CALLS = 30;
const AI_TIMEOUT_MS = 12000;            // server: limits RPC ≤2.5 s + model ≤7 s + cold start
const AI_CONSENT_SYNC_KEY = 'maxgainz_ai_consent_sync';
const AI_AUDIT_MAX = 300;
const AI_KEEP_DAYS = 90;

// ── Priority 6: controlled AI beta ─────────────────────────────────────────
// Cohort = accounts listed in the server table ai_beta (supabase/ai_beta.sql);
// ai_reserve refuses everyone else, so the cohort is enforced server-side.
// On sign-in the app asks ai_beta_status and, for members, turns the three
// beta surfaces on for this device (marked maxgainz_ai_cohort='beta' so they
// go away again if the account leaves the beta or signs out). Members still
// have to switch AI coaching on themselves (consent). ?ai=0 stores '0' — this
// device then never re-enrols. ?ai=… still works for testing.
const AI_BETA_SURFACES = ['coach', 'nl', 'recap'];
const AI_INTRO_KEY = 'maxgainz_ai_intro_v1';
const AI_INTRO_TEXT = {
  coach: "Beta: this tip comes from the app's own progression rules. With AI coaching on, AI only rewrites the wording, using this exercise's recent weights and reps and the rule's suggestion — never your name, email or notes (unless you allow notes). Nothing changes until you tap Accept, and you can undo it.",
  nl: "Beta: type a set like “80 kg x 5”. The app reads it itself first; only if it can't, and AI coaching is on, the sentence and your exercise names go to AI to read. You always see a preview — nothing is saved until you confirm.",
  recap: "Beta: AI writes this from the numbers in the briefing below (sessions, best lifts, balance) — not from your notes or profile. The briefing's numbers are the source of truth."
};
function _aiBetaApply(plan){
  try {
    if(plan === 'enrol'){
      Object.keys(AI_FLAG_KEYS).forEach(k => localStorage.setItem(AI_FLAG_KEYS[k], '1'));
      localStorage.setItem(AI_COHORT_KEY, 'beta');
    } else if(plan === 'leave'){
      if(localStorage.getItem(AI_COHORT_KEY) !== 'beta') return;
      Object.keys(AI_FLAG_KEYS).forEach(k => localStorage.removeItem(AI_FLAG_KEYS[k]));
      localStorage.removeItem(AI_COHORT_KEY);
    } else return;
  } catch(e){ return; }
  try { _renderAiSettings(); } catch(e){}
  try { if(typeof renderToday === 'function') renderToday(); } catch(e){}
}
async function _aiBetaSync(){
  if(typeof isAuthenticated !== 'function' || !isAuthenticated() || typeof sbFetch !== 'function') return;
  let member = null;
  try { const r = await sbFetch('rpc/ai_beta_status', { method:'POST', silent:true, body:'{}' }); member = r && r.ok === true ? r.member === true : null; } catch(e){ member = null; }
  let m = null, c = null;
  try { m = localStorage.getItem(AI_FLAG_KEYS.master); c = localStorage.getItem(AI_COHORT_KEY); } catch(e){}
  _aiBetaApply(_aiBetaPlan(member, m, c));
}
// Pure: latency bucket letter (metric names are letters only).
function _aiLatencyBucket(ms, timedOut){
  if(timedOut || !(ms >= 0)) return 'e';
  return ms < 1000 ? 'a' : ms < 2000 ? 'b' : ms < 4000 ? 'c' : ms < 7000 ? 'd' : 'e';
}
const AI_LAT_LABELS = { a:'<1 s', b:'1–2 s', c:'2–4 s', d:'4–7 s', e:'>7 s / timed out' };

// Pure: the beta report — one row per surface over a window of metrics.
function _aiBetaRows(t){
  const g = k => t[k] || 0;
  const lat = s => ['a', 'b', 'c', 'd', 'e'].filter(b => g('lat_' + s + '_' + b)).map(b => AI_LAT_LABELS[b] + ' ' + g('lat_' + s + '_' + b)).join(' · ') || 'no calls';
  const row = (label, s, shown, acc, edit, dis, undo) => [label, shown + ' shown · ' + acc + ' accepted · ' + edit + ' edited · ' + dis + ' dismissed · ' + undo + ' undone · '
    + g('fb_' + s) + ' fell back · ' + g('valfail_' + s) + ' failed checks · latency ' + lat(s)];
  return [
    row('Beta: coach tip', 'coach', g('coach_shown'), g('coach_accepted'), g('coach_adjusted'), g('coach_dismissed'), g('coach_undone')),
    row('Beta: typed sets', 'nl', g('nl_local_ok') + g('nl_ai_ok') + g('nl_clarify'), g('nl_confirmed'), g('nl_edited'), g('nl_cancelled'), 0),
    row('Beta: weekly recap', 'recap', g('recap_ai_shown'), g('recap_helpful'), 0, g('recap_unhelpful'), 0),
    ['Beta: recap helpful?', g('recap_helpful') + ' yes · ' + g('recap_unhelpful') + ' no'],
    ['Beta: explanations read', AI_BETA_SURFACES.map(s => s + ' ' + (g('intro_' + s) ? 'yes' : 'no')).join(' · ')]
  ];
}
// Pure: failed cases for review — only codes, never facts, wording, ids or names.
function _aiFailureExport(entries){
  const skip = ['flag', 'off', 'signed_out', 'offline', 'not_in_beta'];
  return (Array.isArray(entries) ? entries : []).filter(e => e && (e.check || (e.fallback && skip.indexOf(e.fallback) === -1)))
    .slice(-50).map(e => ({
      day: _aiDayKey(e.t), kind: AI_BETA_SURFACES.indexOf(e.kind) !== -1 ? e.kind : 'other',
      reason: typeof e.fallback === 'string' && /^[a-z_]{1,20}$/.test(e.fallback) ? e.fallback : null,
      check: typeof e.check === 'string' && /^[a-z _]{1,30}$/.test(e.check) ? e.check : null,
      latency: typeof e.latMs === 'number' ? AI_LAT_LABELS[_aiLatencyBucket(e.latMs, e.fallback === 'timeout')] : null,
      model: typeof e.model === 'string' && /^[a-z0-9.-]{1,40}$/.test(e.model) ? e.model : null,
      prompt: typeof e.prompt === 'string' && /^[a-z0-9._-]{1,20}$/.test(e.prompt) ? e.prompt : null,
      events: (e.events || []).map(x => x && x.e).filter(x => AI_AUDIT_EVENTS.indexOf(x) !== -1)
    }));
}

// Pure: the account's AI consent, normalised. Anything unexpected → off.
function _aiPrefsNormalize(p){
  const o = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  const on = o.on === true && o.v === AI_CONSENT_VERSION;
  const ts = v => typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
  return { on, notes: on && o.notes === true, v: on ? AI_CONSENT_VERSION : 0, at: on ? ts(o.at) : null, changedAt: ts(o.changedAt) };
}
// Pure: merge this device's consent with the cloud copy — the most recent
// change wins, and on a tie (or no timestamps at all) OFF wins. A stale
// device can therefore never switch AI back on after it was turned off.
function _aiPrefsMerge(local, cloud){
  const l = _aiPrefsNormalize(local), c = _aiPrefsNormalize(cloud);
  const lt = l.changedAt || 0, ct = c.changedAt || 0;
  if(ct > lt) return c;
  if(lt > ct) return l;
  if(!l.on) return l;
  if(!c.on) return c;
  return (l.notes && !c.notes) ? c : l;
}
function _aiPrefsLoadLocal(){
  try { return _aiPrefsNormalize(JSON.parse(localStorage.getItem(AI_PREFS_KEY) || 'null')); } catch(e){ return _aiPrefsNormalize(null); }
}
function _aiConsented(p){ return !!p && p.on === true && p.v === AI_CONSENT_VERSION; }

// Pure: why an AI call must not happen ('' = allowed). Order matters: a
// feature that is not rolled out says nothing at all.
function _aiGate(s){
  const x = s || {};
  if(!x.master || !x.feature) return 'flag';
  if(!x.consented) return 'off';
  if(!x.signedIn) return 'signed_out';
  if(!x.online) return 'offline';
  if(x.capped) return 'cap';
  return '';
}

function _aiDayKey(ms){
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Small stable hash for facts (cache keys / audit), not security.
function _aiHash(str){
  let h = 0x811c9dc5;
  const s = String(str);
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// Pure loader/migrator for the two local stores. Anything unreadable, from
// another account, or from an unknown version starts fresh; old entries are
// pruned (≤ AI_AUDIT_MAX entries, ≤ AI_KEEP_DAYS days).
function _aiStoreLoad(raw, uid, kind, nowMs){
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e){ o = null; }
  const fresh = kind === 'audit' ? { v:1, uid, entries:[] } : { v:1, uid, days:{} };
  if(!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1 || o.uid !== uid) return fresh;
  const minT = nowMs - AI_KEEP_DAYS * 864e5;
  if(kind === 'audit'){
    const list = Array.isArray(o.entries) ? o.entries : [];
    fresh.entries = list.filter(e => e && typeof e === 'object' && typeof e.id === 'string' && /^a_[a-z0-9_]{1,40}$/.test(e.id)
        && typeof e.t === 'number' && isFinite(e.t) && e.t >= minT && e.t <= nowMs + 864e5)
      .map(e => Object.assign({}, e, { events: Array.isArray(e.events) ? e.events.filter(v => v && typeof v.e === 'string' && typeof v.t === 'number').slice(-20) : [] }))
      .slice(-AI_AUDIT_MAX);
    return fresh;
  }
  const minDay = _aiDayKey(minT);
  const days = (o.days && typeof o.days === 'object' && !Array.isArray(o.days)) ? o.days : {};
  Object.keys(days).forEach(k => {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < minDay) return;
    const row = days[k], clean = {};
    if(!row || typeof row !== 'object') return;
    Object.keys(row).forEach(n => { const v = row[n]; if(/^[a-z_]{1,40}$/.test(n) && typeof v === 'number' && isFinite(v) && v >= 0) clean[n] = v; });
    fresh.days[k] = clean;
  });
  return fresh;
}
function _aiUid(){ return (typeof getCurrentUserId === 'function' && getCurrentUserId()) || 'local'; }
function _aiStoreGet(key, kind){
  let raw = null;
  try { raw = localStorage.getItem(key); } catch(e){}
  return _aiStoreLoad(raw, _aiUid(), kind, Date.now());
}
function _aiStorePut(key, store){ try { localStorage.setItem(key, JSON.stringify(store)); } catch(e){} }

function _aiMetricBump(name, n){
  if(!/^[a-z_]{1,40}$/.test(String(name))) return;
  const st = _aiStoreGet(AI_METRICS_KEY, 'metrics');
  const day = _aiDayKey(Date.now());
  const row = st.days[day] || (st.days[day] = {});
  row[name] = (row[name] || 0) + (typeof n === 'number' && isFinite(n) ? n : 1);
  _aiStorePut(AI_METRICS_KEY, st);
}
function _aiCapped(){
  const row = _aiStoreGet(AI_METRICS_KEY, 'metrics').days[_aiDayKey(Date.now())] || {};
  return (row.capped || 0) > 0 || (row.calls || 0) >= AI_CLIENT_DAILY_CALLS;
}

// Audit trail: one entry per suggestion (AI-worded or deterministic).
function _aiAuditAdd(entry){
  const st = _aiStoreGet(AI_AUDIT_KEY, 'audit');
  const now = Date.now();
  const id = 'a_' + now.toString(36) + '_' + Math.floor(Math.random() * 1e8).toString(36);
  st.entries.push(Object.assign({ id, t: now, kind:'', model:null, prompt:null, source:'deterministic', facts:null, factsHash:'', out:null, fallback:null, costMicroUsd:0, events:[] }, entry || {}, { id, t: now }));
  st.entries = st.entries.slice(-AI_AUDIT_MAX);
  _aiStorePut(AI_AUDIT_KEY, st);
  return id;
}
const AI_REASON_LABELS = { off:'AI off', signed_out:'signed out', offline:'offline', cap:'daily limit', timeout:'slow reply', invalid:'failed checks', refusal:'declined', pain:'pain mentioned', auth:'sign-in expired', unavailable:'service off', not_in_beta:'not in the beta', error:'error' };
const AI_AUDIT_EVENTS = ['shown', 'accepted', 'adjusted', 'undone', 'why', 'confirmed', 'cancelled', 'edited', 'dismissed', 'helpful', 'unhelpful'];
function _aiAuditEvent(id, ev){
  if(AI_AUDIT_EVENTS.indexOf(ev) === -1) return false;
  const st = _aiStoreGet(AI_AUDIT_KEY, 'audit');
  const e = st.entries.find(x => x.id === id);
  if(!e) return false;
  e.events = (e.events || []).concat([{ t: Date.now(), e: ev }]).slice(-20);
  _aiStorePut(AI_AUDIT_KEY, st);
  return true;
}

// Map a server/transport failure to the fallback reason we record.
function _aiReasonFor(status, body){
  const r = body && typeof body.reason === 'string' ? body.reason : '';
  if(r === 'user_cap' || r === 'global_cap' || status === 429) return 'cap';
  if(r === 'timeout' || status === 504) return 'timeout';
  if(r === 'refusal') return 'refusal';
  if(r === 'invalid' || r === 'bad_facts') return 'invalid';
  if(r === 'pain') return 'pain';
  if(r === 'consent_off') return 'off';
  if(r === 'auth' || status === 401) return 'auth';
  if(r === 'disabled' || r === 'not_configured' || r === 'limits_unavailable') return 'unavailable';
  if(r === 'not_in_beta') return 'not_in_beta';
  return 'error';
}

// The ONLY network path to the model proxy.
async function _aiPost(task, facts, signal){
  return fetch('/api/ai', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + authToken },
    body: JSON.stringify({ task, facts }),
    signal
  });
}

// One AI request. Never throws, never blocks the caller's own text: resolves
// {ok:true, out, auditId} or {ok:false, reason, auditId} ('flag' = feature not
// rolled out → record nothing at all).
async function _aiCall(task, factsIn, feature){
  let facts = factsIn;
  try {
    const why = _aiGate({
      master: _aiFlagOn('master'),
      feature: _aiFlagOn(feature || task),
      consented: _aiConsented(typeof userPreferences === 'object' && userPreferences ? userPreferences.ai : null),
      signedIn: typeof isAuthenticated === 'function' && isAuthenticated(),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      capped: _aiCapped()
    });
    if(why === 'flag') return { ok:false, reason:'flag', auditId:null };
    const base = { kind: task, facts, factsHash: _aiHash(JSON.stringify(facts)) };
    const fallback = (reason, extra) => {
      const id = _aiAuditAdd(Object.assign({}, base, { source:'deterministic', fallback: reason }, extra || {}));
      _aiMetricBump('fallback_' + reason);
      if(AI_BETA_SURFACES.indexOf(task) !== -1) _aiMetricBump('fb_' + task);
      if(reason === 'invalid' && AI_BETA_SURFACES.indexOf(task) !== -1) _aiMetricBump('valfail_' + task);
      return { ok:false, reason, auditId:id };
    };
    const t0 = Date.now();
    const lat = () => { const ms = Date.now() - t0; base.latMs = ms; if(AI_BETA_SURFACES.indexOf(task) !== -1) _aiMetricBump('lat_' + task + '_' + _aiLatencyBucket(ms, timedOut)); };
    if(why) return fallback(why);
    // Notes go out only with the separate notes consent (the server checks too).
    const prefs = _aiPrefsNormalize(userPreferences.ai);
    if(task === 'coach' && facts && facts.note !== null && facts.note !== undefined && !prefs.notes){
      facts = Object.assign({}, facts, { note: null });
      base.facts = facts; base.factsHash = _aiHash(JSON.stringify(facts));
    }
    const factErr = _aiValidateFacts(task, facts);
    if(factErr) return fallback(factErr === 'pain' ? 'pain' : 'invalid');

    _aiMetricBump('calls');
    let res = null, body = null;
    var timedOut = false;   // var: read by lat() above
    for(let attempt = 0; attempt < 2; attempt++){
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { timedOut = true; if(ctl) ctl.abort(); }, AI_TIMEOUT_MS);
      try {
        res = await _aiPost(task, facts, ctl ? ctl.signal : undefined);
        try { body = await res.json(); } catch(e){ body = null; }
      }
      catch(e){ res = null; }
      finally { clearTimeout(timer); }
      if(!res || timedOut){ lat(); return fallback(timedOut ? 'timeout' : (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error')); }
      // An expired session token: refresh once (bounded) and retry once.
      if(attempt === 0 && res.status === 401 && typeof refreshAuthToken === 'function'){
        const refreshed = await Promise.race([refreshAuthToken(), new Promise(r => setTimeout(() => r(false), 5000))]);
        if(refreshed === true) continue;
      }
      break;
    }
    lat();
    const meta = body && typeof body === 'object' ? {
      model: typeof body.model === 'string' ? body.model.slice(0, 40) : null,
      prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 20) : null,
      costMicroUsd: typeof body.costMicroUsd === 'number' && isFinite(body.costMicroUsd) && body.costMicroUsd >= 0 ? Math.round(body.costMicroUsd) : 0
    } : { model:null, prompt:null, costMicroUsd:0 };
    if(meta.costMicroUsd) _aiMetricBump('cost_micro_usd', meta.costMicroUsd);
    if(!res.ok || !body || body.ok !== true){
      const reason = _aiReasonFor(res.status, body);
      if(reason === 'cap') _aiMetricBump('capped');
      if(reason === 'off') _aiAdoptServerOff();
      if(reason === 'not_in_beta') _aiBetaApply('leave');
      return fallback(reason, Object.assign({ check: reason === 'invalid' && body && typeof body.detail === 'string' ? body.detail.slice(0, 30) : null }, meta));
    }
    const chk = _aiCheckOutput(task, body.out, facts);
    if(!chk.ok) return fallback('invalid', Object.assign({ out: null, check: String(chk.reason || '').slice(0, 30) }, meta));
    const id = _aiAuditAdd(Object.assign({}, base, meta, { source:'ai', out: body.out, fallback:null }));
    _aiMetricBump('ai_ok');
    return { ok:true, out: body.out, auditId:id, model: meta.model, prompt: meta.prompt };
  } catch(e){
    return { ok:false, reason:'error', auditId:null };
  }
}

// ── Profile: AI coaching consent ──
// The server copy (Supabase ai_consent via ai_set_consent) is what /api/ai
// checks, so a switch-off on one device stops every device. Switching ON needs
// the server to confirm; switching OFF takes effect here at once and is
// retried until the server has it.
async function _aiSetServerConsent(p){
  if(typeof isAuthenticated !== 'function' || !isAuthenticated() || typeof sbFetch !== 'function') return false;
  const r = await sbFetch('rpc/ai_set_consent', { method:'POST', silent:true,
    body: JSON.stringify({ p_enabled: !!p.on, p_notes: !!p.notes, p_version: p.on ? AI_CONSENT_VERSION : 0 }) });
  return !!(r && r.ok === true);
}
function _aiSaveLocalPrefs(){
  try { localStorage.setItem(AI_PREFS_KEY, JSON.stringify(userPreferences.ai)); } catch(e){}
  if(typeof cloudSaveProfile === 'function') cloudSaveProfile();
}
async function _aiRetryConsentSync(){
  let q = null;
  try { q = JSON.parse(localStorage.getItem(AI_CONSENT_SYNC_KEY) || 'null'); } catch(e){ q = null; }
  if(!q || q.uid !== _aiUid()) return;
  if(await _aiSetServerConsent(q)){ try { localStorage.removeItem(AI_CONSENT_SYNC_KEY); } catch(e){} }
}
// The server said consent is off (switched off on another device): follow it here.
function _aiAdoptServerOff(){
  if(!_aiPrefsNormalize(userPreferences.ai).on) return;
  userPreferences.ai = _aiPrefsNormalize({ on:false, changedAt: Date.now() });
  try { localStorage.removeItem(AI_CACHE_KEY); } catch(e){}
  _aiSaveLocalPrefs();
  try { _renderAiSettings(); } catch(e){}
}

// ── Data health: AI outcomes on this device (internal view) ──
// Pure: totals over the last `days` days of the metrics store.
function _aiMetricsSummary(store, nowMs, days){
  const from = _aiDayKey(nowMs - (days - 1) * 864e5), to = _aiDayKey(nowMs);
  const tot = {};
  Object.keys((store && store.days) || {}).forEach(k => {
    if(k < from || k > to) return;
    const row = store.days[k];
    Object.keys(row).forEach(n => { tot[n] = (tot[n] || 0) + row[n]; });
  });
  return tot;
}
// Pure: rows for the Data health section. Plain text cells (caller escapes).
function _aiHealthRows(t7, t28, flags, consent){
  const g = (t, k) => t[k] || 0;
  const fb = t => Object.keys(t).filter(k => k.indexOf('fallback_') === 0).reduce((a, k) => a + t[k], 0);
  const usd = m => '$' + (m / 1e6).toFixed(4);
  const rate = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const reasons = Object.keys(t28).filter(k => k.indexOf('fallback_') === 0 && t28[k] > 0)
    .map(k => (AI_REASON_LABELS[k.slice(9)] || k.slice(9)) + ' ' + t28[k]).join(' · ');
  const shown = g(t28, 'coach_shown');
  const read = g(t28, 'nl_local_ok') + g(t28, 'nl_ai_ok');
  return [
    ['Rollout', 'coach ' + (flags.coach ? 'on' : 'off') + ' · typed sets ' + (flags.nl ? 'on' : 'off') + ' · recap ' + (flags.recap ? 'on' : 'off')],
    ['AI coaching', consent ? 'On (consented)' : 'Off — nothing is sent'],
    ['AI answers used', g(t7, 'ai_ok') + ' (7 days) · ' + g(t28, 'ai_ok') + ' (28 days)'],
    ['Own text shown instead', fb(t7) + ' (7 days) · ' + fb(t28) + ' (28 days)' + (reasons ? ' — ' + reasons : '')],
    ['Coach tips (28 days)', shown + ' shown · ' + rate(g(t28, 'coach_accepted'), shown) + ' accepted · ' + rate(g(t28, 'coach_adjusted'), shown) + ' adjusted · ' + rate(g(t28, 'coach_undone'), g(t28, 'coach_accepted')) + ' of accepts undone · ' + g(t28, 'coach_why') + ' Why? opened'],
    ['Typed sets (28 days)', read + ' read (' + g(t28, 'nl_local_ok') + ' by the app, ' + g(t28, 'nl_ai_ok') + ' by AI) · ' + g(t28, 'nl_clarify') + ' questions · ' + g(t28, 'nl_unparsed') + ' not understood · ' + rate(g(t28, 'nl_confirmed'), read) + ' saved · ' + g(t28, 'nl_cancelled') + ' cancelled · ' + g(t28, 'nl_edited') + ' edited'],
    ['Weekly recap (28 days)', g(t28, 'recap_views') + ' briefing days viewed · AI summary on ' + g(t28, 'recap_ai_shown')],
    ['Cost', usd(g(t7, 'cost_micro_usd')) + ' (7 days) · ' + usd(g(t28, 'cost_micro_usd')) + ' (28 days)' + (g(t28, 'calls') ? ' · ' + usd(g(t28, 'cost_micro_usd') / g(t28, 'calls')) + ' per request' : '')]
  ];
}
