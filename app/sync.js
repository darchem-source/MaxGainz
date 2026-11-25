// app/sync.js — Max Gainz pending-sync queue and sync engine.
// Priority 7, slice 2. Moved verbatim from index.html (no behaviour change).
//
// Edit THIS file, then run `python3 tools/bundle.py`: it is copied into a
// marked region at the top of index.html's script, directly after
// app/rollout.js (the app still ships as one file). Gate 34 fails if the copy
// drifts, and loads this file ON ITS OWN in jsc with stubs to test it.
//
// Classic script: top-level declarations are shared globals, exactly as
// before. Load time only runs the `var` initialisers below (literals,
// new Set(), Promise.resolve()); nothing here touches the DOM or shows a toast.
// UI that reads this state (status line, Retry, sign-out dialogs, save toasts)
// stays in index.html.
//
// RUN-TIME dependencies on index.html (called when a function runs, never at
// load time — the standalone test stubs each one):
//   network / auth   sbFetch, isAuthenticated, getCurrentUserId
//   storage          lsGet, lsSet, lsGetRaw, lsSetRaw, saveLocalCache, STORAGE_KEY
//   status           setSyncStatus (publishes on the bus; the UI subscribes)
//   session data     completedSessions, _validateSession, _normalizeSessionWeights
//                    (the last two are in app/rules.js since slice 5; still stubbed in gate 34)
//   profile state    userProfile, userPreferences, todayProg, userPath, pathHistory,
//                    bodyWeightLog, measurementsLog, dailyNotes, pbLifts,
//                    customWorkouts, customWeights, HIIT, applyCustomWeights,
//                    _dashWeightsOk (assigned by cloudLoadAll)
//   AI prefs         AI_PREFS_KEY, _aiPrefsNormalize, _aiPrefsMerge
//   optional (typeof-guarded): scheduleDashboardSummary, customHIITs,
//                    _sanitiseCustomWorkouts, _sanitiseCustomHIITs,
//                    _sanitisePBLifts, _renderAiSettings
// Browser APIs: localStorage, navigator.onLine, setTimeout, crypto (optional),
// console. State this file owns but index.html also writes: _lastSyncError /
// _lastSyncErrorDetail (set by sbFetch), _pending / LAST_SYNC_KEY /
// HYDRATED_KEY / PROFILE_SEEN_KEY / STASH_KEY (reset by authLogout).

// ── PENDING SYNC QUEUE ──
// Local-first: every write lands on this device first. Anything that has not
// been CONFIRMED by the cloud is tracked here so the UI never claims "synced"
// for data that only exists locally, and so failed writes are retried
// (online / app resume / backoff timer / manual Retry) instead of silently lost.
//   profile      — the __profile__ blob has local changes the cloud hasn't confirmed
//   weights      — exercise_name → weight awaiting a confirmed upsert
//   deletes      — cloud session ids whose DELETE hasn't been confirmed
//   deletedKeys  — _sessionKey()s deleted locally before they had a cloud_id
// Sessions themselves need no entry: a session without cloud_id IS pending.
// Persisted per account (stamped userId; a different account ignores it) and
// wiped by authLogout(). `var` + lazy init: safe if touched during early boot.
var PENDING_KEY = 'maxgainz_pending_v1';
var LAST_SYNC_KEY = 'maxgainz_last_synced';
var HYDRATED_KEY = 'maxgainz_hydrated_uid';
var PROFILE_SEEN_KEY = 'maxgainz_profile_seen_at'; // updated_at of the cloud profile blob this device last applied/wrote
var _pending = null;
var _lastSyncError = null;      // 'auth' | 'timeout' | 'network' | 'http' | null (set by sbFetch)
var _lastSyncErrorDetail = null; // { status, text } of the last HTTP error (set by sbFetch)
// Idempotent session inserts: every session carries a client-generated id and is
// UPSERTed on (user_id, client_id), so a retry after a lost response can never
// create a second row. Needs supabase/sessions_client_id.sql; until that has run,
// the first upsert fails with a schema error, this flips to false for the page,
// and uploads fall back to plain inserts (deduped by the reload+merge path).
var _sessClientIdSupported = null; // null = unknown, true = confirmed, false = column/constraint missing
var _syncInFlight = null;       // promise of the running flushPending(), if any
var _syncRetryTimer = null;
var _syncBackoff = 0;
var _cloudLoadInFlight = false;
var _cloudLoadedThisPage = false; // sessions are only re-uploaded after a load has merged (dedupes lost-response uploads)
var _sessUploading = new Set();   // _sessionKey()s with a POST in flight
var _cloudIdsByKey = {};          // _sessionKey → every cloud row id seen for it (pre-existing duplicates)
var _profileRev = 0, _profileQueued = null, _profileChain = Promise.resolve();

function _newClientId(){
  try { if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch(e){}
  let h = '';
  for(let i = 0; i < 32; i++) h += Math.floor(Math.random() * 16).toString(16);
  return h.slice(0,8) + '-' + h.slice(8,12) + '-4' + h.slice(13,16) + '-a' + h.slice(17,20) + '-' + h.slice(20,32);
}
// Pure: does this PostgREST error mean "sessions.client_id / its unique constraint isn't there yet"?
function _isClientIdSchemaError(detail){
  if(!detail || !detail.text) return false;
  const t = String(detail.text);
  return /client_id/i.test(t) || /PGRST204|42703|42P10/.test(t) || /no unique or exclusion constraint/i.test(t);
}
// Pure: content fingerprint — two rows are duplicates only if key AND this match
// (backdated activities on the same day share a key but are different sessions).
function _sessFingerprint(s){
  return [Math.round((s && s.durationMin) || 0), Math.round((s && s.volume) || 0), (s && s.exercises) || 0,
    (s && s.activityType) || '', (s && s.intensity) || '', (s && s.manualActivity) ? 1 : 0].join('|');
}
function _emptyPending(userId){
  return { userId: userId || null, profile: false, weights: {}, deletes: [], deletedKeys: [] };
}
// Pure: normalise a stored pending record for `userId`; anything else → empty.
function _normalisePending(raw, userId){
  if(!userId || !raw || typeof raw !== 'object' || raw.userId !== userId) return _emptyPending(userId);
  const out = _emptyPending(userId);
  out.profile = raw.profile === true;
  if(raw.weights && typeof raw.weights === 'object' && !Array.isArray(raw.weights)){
    Object.keys(raw.weights).forEach(k => {
      const w = raw.weights[k];
      if(typeof k === 'string' && !k.startsWith('__') && typeof w === 'number' && isFinite(w)) out.weights[k] = w;
    });
  }
  if(Array.isArray(raw.deletes)) out.deletes = raw.deletes.filter(id => typeof id === 'string' || typeof id === 'number');
  if(Array.isArray(raw.deletedKeys)) out.deletedKeys = raw.deletedKeys.filter(k => typeof k === 'string');
  return out;
}
function _P(){
  const uid = (typeof getCurrentUserId === 'function') ? getCurrentUserId() : null;
  if(!_pending || _pending.userId !== uid){
    _pending = _normalisePending(uid ? lsGet(PENDING_KEY, null) : null, uid);
  }
  return _pending;
}
function _savePending(){
  const p = _P();
  if(!p.userId) return;
  lsSet(PENDING_KEY, p);
}
function _unsyncedSessionCount(){
  try {
    if(typeof isAuthenticated !== 'function' || !isAuthenticated()) return 0;
    return completedSessions.filter(s => s && !s.cloud_id).length;
  } catch(e){ return 0; }
}
// Pure counter over a pending record (+ number of sessions lacking a cloud_id).
function _countPending(p, unsyncedSessions){
  if(!p) return unsyncedSessions || 0;
  return (p.profile ? 1 : 0) + Object.keys(p.weights || {}).length + (p.deletes || []).length
    + (p.deletedKeys || []).length + (unsyncedSessions || 0);
}
function _pendingCount(){ return _countPending(_P(), _unsyncedSessionCount()); }

function _isHydrated(){
  const uid = getCurrentUserId();
  return !!uid && lsGetRaw(HYDRATED_KEY) === uid;
}
function _setProfileSeen(at){
  const uid = getCurrentUserId();
  if(uid && at) lsSet(PROFILE_SEEN_KEY, { userId: uid, at: String(at) });
}
function _profileSeenAt(){
  const v = lsGet(PROFILE_SEEN_KEY, null);
  return (v && v.userId === getCurrentUserId() && v.at) ? v.at : null;
}
// Pure: when the cloud profile wins over unconfirmed local changes, keep the
// local-only ENTRIES of the append-style collections (a body-weight entry or
// note logged offline must not be erased by a newer blob from another device).
// Cloud wins on conflicts (same date / key / name). Returns merged copies plus
// how many local entries were carried over.
function _mergeLocalProfileExtras(cloud, local){
  cloud = cloud || {}; local = local || {};
  let added = 0;
  const byField = (c, l, keyOf) => {
    const out = Array.isArray(c) ? c.slice() : [];
    const seen = new Set(out.map(keyOf));
    (Array.isArray(l) ? l : []).forEach(e => {
      const k = keyOf(e);
      if(k == null || k === '' || seen.has(k)) return;
      seen.add(k); out.push(e); added++;
    });
    return out;
  };
  const date = e => (e && typeof e.date === 'string') ? e.date : null;
  const name = e => (e && typeof e.name === 'string') ? e.name : null;
  const out = {
    bodyWeightLog:   byField(cloud.bodyWeightLog, local.bodyWeightLog, date).sort((a,b) => String(a.date).localeCompare(String(b.date))),
    measurementsLog: byField(cloud.measurementsLog, local.measurementsLog, date).sort((a,b) => String(a.date).localeCompare(String(b.date))),
    customWorkouts:  byField(cloud.customWorkouts, local.customWorkouts, name),
    customHIITs:     byField(cloud.customHIITs, local.customHIITs, name),
    dailyNotes: Object.assign({}, (cloud.dailyNotes && typeof cloud.dailyNotes === 'object') ? cloud.dailyNotes : {})
  };
  const ln = (local.dailyNotes && typeof local.dailyNotes === 'object') ? local.dailyNotes : {};
  Object.keys(ln).forEach(k => { if(!(k in out.dailyNotes)){ out.dailyNotes[k] = ln[k]; added++; } });
  out.added = added;
  return out;
}
function _markSynced(){
  const uid = getCurrentUserId();
  if(uid) lsSet(LAST_SYNC_KEY, { userId: uid, at: new Date().toISOString() });
}
function _lastSyncedAt(){
  const v = lsGet(LAST_SYNC_KEY, null);
  return (v && v.userId === getCurrentUserId() && v.at) ? v.at : null;
}

// Pure: the status line text. status ∈ syncing|uploading|synced|local|offline|error|auth.
function _syncLabel(status, pendingCount, lastSyncedIso, signedIn, nowMs){
  const n = pendingCount || 0;
  const waiting = n ? ' · ' + n + ' waiting to sync' : '';
  if(!signedIn) return '💾 Saved on this device · not signed in';
  if(status === 'syncing' || status === 'uploading') return '🔄 Syncing…';
  if(status === 'synced'){
    let when = '';
    if(lastSyncedIso){
      const d = new Date(lastSyncedIso);
      if(!isNaN(d)){
        const now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
        const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        when = ' · ' + (d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' ' + hm);
      }
    }
    return '☁️ Synced to account' + when;
  }
  if(status === 'auth')    return '⚠️ Sign in again to sync · saved on this device' + waiting;
  if(status === 'offline') return '📱 Offline · saved on this device' + waiting;
  if(status === 'error')   return '⚠️ Sync failed · saved on this device' + waiting;
  return '💾 Saved on this device' + waiting; // 'local'
}

// Derive the honest status from real state and publish it.
function _recomputeSyncStatus(){
  if(typeof isAuthenticated !== 'function' || !isAuthenticated()){ setSyncStatus('local'); return; }
  if(_cloudLoadInFlight){ setSyncStatus('syncing'); return; }
  if(_syncInFlight || _sessUploading.size){ setSyncStatus('uploading'); return; }
  if(_pendingCount() > 0){
    setSyncStatus(_lastSyncError === 'auth' ? 'auth' : (navigator.onLine === false ? 'offline' : (_lastSyncError ? 'error' : 'local')));
    return;
  }
  setSyncStatus('synced');
}

function _scheduleRetry(){
  if(typeof isAuthenticated !== 'function' || !isAuthenticated()) return;
  if(_lastSyncError === 'auth' || _syncRetryTimer) return;
  if(_pendingCount() === 0) return;
  _syncBackoff = Math.min(60000, Math.max(2000, _syncBackoff * 2));
  _syncRetryTimer = setTimeout(() => {
    _syncRetryTimer = null;
    if(navigator.onLine === false) return; // the 'online' event resumes it
    if(!_cloudLoadedThisPage) cloudLoadAll(); // load first (merges, then flushes)
    else flushPending();
  }, _syncBackoff);
}

// Upload one session; assigns cloud_id only on a confirmed insert.
async function _uploadSession(s){
  if(!s || s.cloud_id) return true;
  const k = _sessionKey(s);
  if(_sessUploading.has(k)) return false;
  _sessUploading.add(k);
  // Give the session its idempotency key BEFORE the first attempt and persist
  // it, so every retry (this page or after a reload) reuses the same id.
  if(!s.client_id){ s.client_id = _newClientId(); saveLocalCache(); }
  try {
    const res = await cloudSaveSession(s, { silent: true });
    const id = Array.isArray(res) && res[0] && res[0].id;
    if(!id){
      // Outcome unknown (the insert may have landed with the response lost).
      // With confirmed client_id upserts a retry is idempotent. Otherwise plain
      // inserts aren't, so the next retry must go back through cloudLoadAll():
      // its merge adopts a row that did land (same _sessionKey) and only
      // re-uploads sessions that are really missing.
      if(_sessClientIdSupported !== true) _cloudLoadedThisPage = false;
      return false;
    }
    const p = _P();
    const di = p.deletedKeys.indexOf(k);
    if(di >= 0){
      // Deleted locally while the POST was in flight → delete the new cloud row too.
      p.deletedKeys.splice(di, 1);
      if(!p.deletes.includes(id)) p.deletes.push(id);
      _savePending();
    } else {
      // cloudLoadAll's merge may have swapped `s` for a copy while the POST was
      // in flight — tag the live copy too, or it would be uploaded twice.
      let live = null;
      try { live = completedSessions.find(x => x && x !== s && !x.cloud_id && _sessionKey(x) === k) || null; } catch(e){}
      [s, live].forEach(o => { if(o){ o.cloud_id = id; delete o._needsUpload; } });
      saveLocalCache();
    }
    _markSynced();
    return true;
  } finally {
    _sessUploading.delete(k);
  }
}

// Push every pending change. Single-flight; failures stay queued and back off.
function flushPending(){
  if(typeof isAuthenticated !== 'function' || !isAuthenticated()) return Promise.resolve(false);
  if(_syncInFlight) return _syncInFlight;
  _syncInFlight = (async () => {
    _recomputeSyncStatus();
    let ok = true;
    const p = _P();
    const same = () => getCurrentUserId() === p.userId; // abort if the account changes mid-flush
    if(p.profile && _isHydrated()){
      if(await cloudSaveProfile({ silent: true }) === null) ok = false;
    }
    for(const name of Object.keys(p.weights)){
      if(!same()) return false;
      if(await cloudSaveWeight(name, p.weights[name], { silent: true }) === null) ok = false;
    }
    for(const id of p.deletes.slice()){
      if(!same()) return false;
      const r = await sbFetch('sessions?id=eq.' + encodeURIComponent(id), { method: 'DELETE', silent: true });
      if(r === null){ ok = false; continue; }
      const i = p.deletes.indexOf(id);
      if(i >= 0) p.deletes.splice(i, 1);
      _savePending(); _markSynced();
    }
    if(_cloudLoadedThisPage){
      for(const s of completedSessions.filter(x => x && !x.cloud_id)){
        if(!same()) return false;
        if(!_cloudLoadedThisPage){ ok = false; break; } // a failed insert forces a reload+merge first
        if(!(await _uploadSession(s))) ok = false;
      }
    }
    return ok;
  })().finally(() => {
    _syncInFlight = null;
    if(_pendingCount() === 0) _syncBackoff = 0;
    else _scheduleRetry();
    _recomputeSyncStatus();
  });
  return _syncInFlight;
}

// ═══ Stash (moved from index.html) ═══
// ── Keeping unsynced work across sign-out / re-login ──
// An expired session is fixed by signing in AGAIN IN PLACE (no wipe), and a
// deliberate sign-out with unsynced work can keep it in a per-account stash
// that is restored only when the SAME account signs back in.
var STASH_KEY = 'maxgainz_stash_v1';

// Pure: the unsynced part of an account's local state, as a JSON-safe record.
function _buildStash(sessions, pending){
  const p = pending || {};
  return {
    at: new Date().toISOString(),
    sessions: (Array.isArray(sessions) ? sessions : []).filter(s => s && !s.cloud_id)
      .map(s => { const o = Object.assign({}, s, { date: s.date instanceof Date ? s.date.toISOString() : s.date }); delete o._needsUpload; return o; }),
    weights: Object.assign({}, p.weights || {}),
    deletes: Array.isArray(p.deletes) ? p.deletes.slice() : [],
    deletedKeys: Array.isArray(p.deletedKeys) ? p.deletedKeys.slice() : [],
    profile: !!p.profile
  };
}
function _stashUnsynced(){
  const uid = getCurrentUserId();
  if(!uid) return 0;
  const st = _buildStash(completedSessions, _P());
  if(st.profile){
    // Unconfirmed profile changes: keep the append-style data (body weight,
    // measurements, notes, custom workouts) — restored and merged on sign-in.
    try {
      st.profileData = JSON.parse(JSON.stringify({
        bodyWeightLog, measurementsLog, dailyNotes,
        customWorkouts: Array.isArray(customWorkouts) ? customWorkouts : [],
        customHIITs: JSON.parse(localStorage.getItem('maxgainz_custom_hiits') || '[]')
      }));
    } catch(e) { st.profileData = null; st.profile = false; }
  }
  const n = st.sessions.length + Object.keys(st.weights).length + st.deletes.length + st.deletedKeys.length + (st.profile ? 1 : 0);
  if(!n) return 0;
  const all = lsGet(STASH_KEY, {}) || {};
  all[uid] = st;
  lsSet(STASH_KEY, all);
  return n;
}
// Called right after a successful sign-in, before cloudLoadAll().
function _restoreStash(){
  const uid = getCurrentUserId();
  const all = lsGet(STASH_KEY, null);
  if(!uid || !all || typeof all !== 'object' || !all[uid]) return 0;
  const st = all[uid];
  const have = new Set(completedSessions.map(_sessionKey));
  let n = 0;
  (Array.isArray(st.sessions) ? st.sessions : []).forEach(raw => {
    const s = _validateSession(raw);
    if(!s || have.has(_sessionKey(s))) return;
    completedSessions.push(s); have.add(_sessionKey(s)); n++;
  });
  const p = _P();
  Object.keys(st.weights || {}).forEach(k => {
    const w = st.weights[k];
    if(typeof w === 'number' && isFinite(w) && !k.startsWith('__')){ p.weights[k] = w; customWeights[k] = w; n++; }
  });
  (st.deletes || []).forEach(id => { if(!p.deletes.includes(id)){ p.deletes.push(id); n++; } });
  (st.deletedKeys || []).forEach(k => { if(!p.deletedKeys.includes(k)) p.deletedKeys.push(k); });
  if(st.profile && st.profileData){
    // Put the kept entries back and mark the profile pending: cloudLoadAll()
    // applies the cloud blob, then merges these local-only entries back in.
    const d = st.profileData;
    if(Array.isArray(d.bodyWeightLog)) bodyWeightLog = d.bodyWeightLog;
    if(Array.isArray(d.measurementsLog)) measurementsLog = d.measurementsLog;
    if(d.dailyNotes && typeof d.dailyNotes === 'object') dailyNotes = d.dailyNotes;
    if(Array.isArray(d.customWorkouts)){
      const cw = (typeof _sanitiseCustomWorkouts === 'function') ? _sanitiseCustomWorkouts(d.customWorkouts) : d.customWorkouts;
      customWorkouts.length = 0; cw.forEach(w => customWorkouts.push(w));
      localStorage.setItem('maxgainz_custom', JSON.stringify(customWorkouts));
    }
    if(Array.isArray(d.customHIITs)){
      const ch = (typeof _sanitiseCustomHIITs === 'function') ? _sanitiseCustomHIITs(d.customHIITs) : d.customHIITs;
      localStorage.setItem('maxgainz_custom_hiits', JSON.stringify(ch));
    }
    p.profile = true; _profileRev++; n++;
  }
  _savePending();
  saveLocalCache(); // stamps this account, so cloudLoadAll() merges + uploads them
  delete all[uid];
  lsSet(STASH_KEY, all);
  return n;
}

// ── CLOUD SYNC ──
// Architecture: localStorage = fast cache, Supabase = source of truth
// On login: always load from Supabase (overrides local cache)
// On write: write-through to Supabase immediately, update local cache
// On load without auth: fall back to local cache

async function cloudSaveSession(s, opts) {
  if(!isAuthenticated()) return null;
  const useCid = !!(s && s.client_id) && _sessClientIdSupported !== false;
  const result = await sbFetch(useCid ? 'sessions?on_conflict=user_id,client_id' : 'sessions', {
    method: 'POST',
    silent: !!(opts && opts.silent),
    extraHeaders: useCid ? { 'Prefer': 'resolution=merge-duplicates,return=representation' } : undefined,
    body: JSON.stringify({
      ...(useCid ? { client_id: s.client_id } : {}),
      user_id: getCurrentUserId(),
      date: s.date instanceof Date ? s.date.toISOString() : s.date,
      day: s.day,
      exercises: s.exercises || 0,
      duration_min: s.durationMin || 0,
      volume: s.volume || 0,
      top_lifts: s.topLifts || [],
      set_log: s.setLog || {},
      manual_activity: s.manualActivity || false,
      activity_type: s.activityType || null,
      activity_emoji: s.activityEmoji || null,
      intensity: s.intensity || null,
      xp_awarded: s.xpAwarded || 0
    })
  });
  if(useCid){
    if(Array.isArray(result) && result[0] && result[0].id){
      _sessClientIdSupported = true;
    } else if(result === null && _lastSyncError === 'http' && _isClientIdSchemaError(_lastSyncErrorDetail)){
      // Migration not applied yet: fall back to a plain insert for this page.
      console.warn('[sync] sessions.client_id unavailable — run supabase/sessions_client_id.sql; using plain inserts');
      _sessClientIdSupported = false;
      return cloudSaveSession(s, opts);
    }
  }
  return result;
}

// Pending-aware: the delete is queued BEFORE the request and only dequeued on
// a confirmed DELETE, so a failed/offline delete is retried instead of the
// session resurrecting on the next cloudLoadAll().
async function cloudDeleteSession(s) {
  if (!s || typeof isAuthenticated !== 'function' || !isAuthenticated()) return null;
  const p = _P();
  if (!s.cloud_id) {
    // Never confirmed in the cloud — but its POST may be in flight, or may have
    // landed with the response lost. Remember the key so either outcome is undone.
    const k = _sessionKey(s);
    if (!p.deletedKeys.includes(k)) { p.deletedKeys.push(k); _savePending(); }
    // Settled by the next cloudLoadAll() (or by the in-flight upload itself),
    // so make sure a reload actually happens.
    if (!_sessUploading.has(k)) { _cloudLoadedThisPage = false; _scheduleRetry(); }
    _recomputeSyncStatus();
    return null;
  }
  // The session's own row plus any duplicate rows of it seen on the last load.
  const ids = [s.cloud_id].concat((_cloudIdsByKey[_sessionKey(s) + '#' + _sessFingerprint(s)] || []).filter(x => x !== s.cloud_id));
  ids.forEach(id => { if (!p.deletes.includes(id)) p.deletes.push(id); });
  _savePending();
  let res = [];
  for (const id of ids) {
    const r = await sbFetch('sessions?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    if (r === null) { res = null; continue; }
    const i = _P().deletes.indexOf(id);
    if (i >= 0) { _P().deletes.splice(i, 1); _savePending(); }
  }
  if (res !== null) _markSynced();
  else _scheduleRetry();
  _recomputeSyncStatus();
  return res;
}

// Write-through: save a single weight to Supabase immediately
// Pending-aware: queued before the request, dequeued only on a confirmed upsert
// of the SAME value (a newer local change made meanwhile stays queued).
async function cloudSaveWeight(name, weight, opts) {
  if(!isAuthenticated()) return null;
  if(typeof name !== 'string' || name.startsWith('__')) return null; // '__' names are reserved system rows
  const uid = getCurrentUserId();
  if(typeof weight === 'number' && isFinite(weight)){ _P().weights[name] = weight; _savePending(); }
  // on_conflict is required: (user_id, exercise_name) is a unique index, not the
  // primary key, so without it every re-save of an existing exercise is a 409
  // and the change stays queued forever ("N changes waiting to sync").
  const res = await sbFetch('custom_weights?on_conflict=user_id,exercise_name', {
    method: 'POST',
    silent: !!(opts && opts.silent),
    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: uid,
      exercise_name: name,
      weight,
      updated_at: new Date().toISOString()
    })
  });
  if(getCurrentUserId() === uid){
    const p = _P();
    if(res !== null){
      if(p.weights[name] === weight){ delete p.weights[name]; _savePending(); }
      _markSynced();
    } else {
      _scheduleRetry();
    }
    _recomputeSyncStatus();
  }
  return res;
}

// Write-through: save user profile + preferences to Supabase
// Stores as two special rows in custom_weights:
//   __profile_a__ and __profile_b__ (split to stay under weight field limit)
// NOTE: requires 'notes' column on custom_weights — see CLOUD_SETUP.md
// Falls back gracefully if column doesn't exist
async function cloudSaveProfile(opts) {
  if(!isAuthenticated()) return null;
  if(typeof scheduleDashboardSummary === 'function') scheduleDashboardSummary(); // path/prefs changes reach the profile blob only
  // Pending-aware: mark dirty first; cleared only when the cloud confirms an
  // upload of THIS revision (or a later one). Until this device has loaded the
  // account from the cloud at least once (_isHydrated), never upload: in-memory
  // state may still be defaults and would overwrite the real cloud profile.
  const uid = getCurrentUserId();
  _profileRev++; _P().profile = true; _savePending();
  if(!_isHydrated()){ _recomputeSyncStatus(); return false; } // false = held until this device has loaded the account
  // Serialise uploads (an older blob must never land after a newer one) and
  // coalesce bursts: callers arriving before the queued upload starts share it.
  if(_profileQueued) return _profileQueued;
  const run = _profileChain.then(async () => {
  _profileQueued = null;
  if(getCurrentUserId() !== uid || !isAuthenticated()) return null;
  const rev = _profileRev;
  // Read customHIITs from localStorage at save time (it may not be defined globally yet on first call)
  let cHIITs = [];
  try { cHIITs = JSON.parse(localStorage.getItem('maxgainz_custom_hiits') || '[]'); } catch(e){}
  const blob = JSON.stringify({
    userProfile,
    todayProg,
    customWorkouts,
    customHIITs: cHIITs,
    userPath,
    pathHistory: Array.isArray(pathHistory) ? pathHistory : [],
    bodyWeightLog,
    measurementsLog: Array.isArray(measurementsLog) ? measurementsLog : [],
    dailyNotes: (dailyNotes && typeof dailyNotes === 'object' && !Array.isArray(dailyNotes)) ? dailyNotes : {},
    onboarded: !!localStorage.getItem('maxgainz_onboarded'),
    pbLifts: Array.isArray(pbLifts) ? pbLifts : [],
    prefs: {
      speedUnit:    localStorage.getItem('userSpeedUnit')    || 'mph',
      weightUnit:   localStorage.getItem('userWeightUnit')   || 'kg',
      audioEnabled: userPreferences.audioEnabled,
      runnerLevel:  localStorage.getItem('userRunnerLevel')  || 'intermediate',
      trackRPE:     !!userPreferences.trackRPE,
      periodize:    !!userPreferences.periodize,
      rotateExercises: userPreferences.rotateExercises !== false,
      demoSex:      userPreferences.demoSex === 'female' ? 'female' : 'male',
      ai:           _aiPrefsNormalize(userPreferences.ai)
    }
  });
  const sentAt = new Date().toISOString();
  const res = await sbFetch('custom_weights?on_conflict=user_id,exercise_name', {
    method: 'POST',
    silent: !!(opts && opts.silent),
    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: uid,
      exercise_name: '__profile__',
      weight: 0,
      updated_at: sentAt,
      notes: blob
    })
  });
  if(getCurrentUserId() === uid){
    if(res !== null){
      if(rev === _profileRev){ _P().profile = false; _savePending(); }
      _setProfileSeen(sentAt);
      _markSynced();
    } else {
      _scheduleRetry();
    }
    _recomputeSyncStatus();
  }
  return res;
  });
  _profileQueued = run;
  _profileChain = run.catch(() => null);
  return run;
}

// Load everything from Supabase — sessions, weights, profile
// This is the source of truth on login and app start
// Fetch EVERY session row, paging past PostgREST's per-request cap. (A single
// `order=date.asc&limit=500` used to return only the OLDEST 500 — anything newer
// never loaded and its local copy was re-uploaded as a duplicate.) Returns null
// if any page fails, so a partial list is never mistaken for the full history.
// Keyset paging by id: each page starts AFTER the last id seen, so a row
// deleted on another device mid-load cannot shift the next page and make it
// skip a row (offset paging did). The result keeps the old date order.
async function _fetchAllSessionRows(userId){
  const pageSize = 500, maxPages = 40;
  const rows = [];
  let after = null;
  for(let page = 0; page < maxPages; page++){
    const chunk = await sbFetch('sessions?user_id=eq.' + userId + '&order=id.asc&limit=' + pageSize
      + (after !== null ? '&id=gt.' + encodeURIComponent(after) : ''));
    if(!Array.isArray(chunk)) return null;
    chunk.forEach(r => rows.push(r));
    if(chunk.length < pageSize) return _sortSessionRows(rows);
    const last = chunk[chunk.length - 1];
    if(!last || last.id == null || String(last.id) === String(after)) return null;   // no progress: refuse a partial list
    after = String(last.id);
  }
  return null; // > 20,000 sessions: refuse to treat a truncated list as complete
}
// Pure: the order the old query returned (date, then id).
function _sortSessionRows(rows){
  const t = r => { const v = new Date(r && r.date).getTime(); return isFinite(v) ? v : 0; };
  return rows.slice().sort((a, b) => (t(a) - t(b)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

async function cloudLoadAll() {
  if(!isAuthenticated()) return false;
  const userId = getCurrentUserId();
  // FETCH FIRST. Nothing local is reset until BOTH requests have succeeded: a
  // failed or partial load must leave this device's data exactly as it was
  // (previously the profile/path were wiped up front, and a later save could
  // then upload that blank state over the real cloud profile).
  _cloudLoadInFlight = true;
  setSyncStatus('syncing');
  // cloud_ids this device knew before fetching: only these can be judged
  // "deleted on another device" (an upload may land while we page).
  const _preFetchIds = new Set(completedSessions.filter(s => s && s.cloud_id).map(s => s.cloud_id));
  let sessRows = null, weightRows = null;
  try {
    [sessRows, weightRows] = await Promise.all([
      _fetchAllSessionRows(userId),
      sbFetch('custom_weights?user_id=eq.' + userId)
    ]);
  } catch(e) {
    sessRows = weightRows = null;
  } finally {
    _cloudLoadInFlight = false;
  }

  if (!Array.isArray(sessRows) || !Array.isArray(weightRows) || getCurrentUserId() !== userId) {
    // Failed, partial, or the account changed mid-request: report it honestly
    // and keep everything local. Never "synced".
    if (getCurrentUserId() === userId) {
      setSyncStatus(_lastSyncError === 'auth' ? 'auth' : (navigator.onLine === false ? 'offline' : 'error'));
      _scheduleRetry();
    }
    return false;
  }

  _dashWeightsOk = false; // state is reset below; no dashboard push until weights+profile reload
  const _pend = _P();
  // Drop sessions whose delete is still queued, and undo uploads that landed for
  // sessions deleted before they had a cloud_id (key match) — queue those ids.
  sessRows = sessRows.filter(r => !_pend.deletes.includes(r.id));
  const _profileRow = weightRows.find(r => r && r.exercise_name === '__profile__' && r.notes);
  // Local profile changes the cloud never confirmed win over the cloud copy —
  // but only once this device has been hydrated from the cloud for this account
  // (otherwise "local" may just be defaults), or when the cloud has no blob yet.
  // ...and only if the cloud blob hasn't changed since this device last saw it:
  // a newer blob means another device wrote in the meantime, and blindly
  // uploading this device's whole blob would erase that device's data.
  const _seenAt = _profileSeenAt();
  const _cloudNewer = !!_profileRow && (!_seenAt || !_profileRow.updated_at || new Date(_profileRow.updated_at) > new Date(_seenAt));
  const _profileLocalWins = _pend.profile && (!_profileRow || (_isHydrated() && !_cloudNewer));
  // Cloud wins over pending local changes: snapshot local append-style data so
  // its local-only entries can be merged back after the blob is applied.
  let _localExtras = null;
  if (_pend.profile && !_profileLocalWins) {
    try {
      _localExtras = JSON.parse(JSON.stringify({
        bodyWeightLog, measurementsLog, dailyNotes,
        customWorkouts: Array.isArray(customWorkouts) ? customWorkouts : [],
        customHIITs: JSON.parse(localStorage.getItem('maxgainz_custom_hiits') || '[]')
      }));
    } catch(e) { _localExtras = null; }
  }

  if (!_profileLocalWins) {
    // Reset profile to defaults before applying the cloud blob — ensures a new
    // user never inherits a previous user's in-memory state if their Supabase
    // account has no profile blob yet. Safe now: both fetches succeeded.
    Object.keys(userProfile).forEach(k => delete userProfile[k]);
    Object.assign(userProfile, { firstName:'', lastName:'', email:'', gender:'', dob:'', heightCM:180, weight:80 });
    // Cloud is source of truth for the path
    userPath = null;
    localStorage.removeItem('maxgainz_path');
  }

  // Cloud is authoritative, BUT we no longer blindly discard local sessions —
  // that silently lost any workout logged offline that never reached the cloud.
  // Conflict-safe merge instead: keep cloud copies, preserve local-only
  // (unsynced) sessions, and re-upload them. Gated to the SAME user (via the
  // userId stamped in the local cache) so a previous account's data can never
  // leak in after a re-login on a shared device.
  if (Array.isArray(sessRows)) {
    let _cachedUserId = null;
    try { const _raw = localStorage.getItem(STORAGE_KEY); if(_raw) _cachedUserId = (JSON.parse(_raw) || {}).userId || null; } catch(e){}
    const _sameUser = _cachedUserId && _cachedUserId === userId;
    // A local copy that HAS a cloud_id which is no longer in the (complete,
    // paginated) cloud list was deleted on another device — drop it instead of
    // letting the merge re-upload it. Only sessions without a cloud_id are
    // genuinely local-only.
    const _cloudIds = new Set(sessRows.map(r => r.id));
    const _localSnapshot = _sameUser ? completedSessions.filter(s => s && (!s.cloud_id || _cloudIds.has(s.cloud_id) || !_preFetchIds.has(s.cloud_id))) : [];

    const cloudArr = sessRows.map(r => ({
      cloud_id: r.id,
      date: new Date(r.date),
      day: r.day,
      exercises: r.exercises,
      durationMin: r.duration_min,
      volume: r.volume,
      topLifts: r.top_lifts || [],
      setLog: r.set_log || {},
      manualActivity: r.manual_activity,
      activityType: r.activity_type,
      activityEmoji: r.activity_emoji,
      intensity: r.intensity,
      xpAwarded: r.xp_awarded,
      ...(r.client_id ? { client_id: r.client_id } : {})
    })).filter(c => {
      const k = _sessionKey(c);
      if (!_pend.deletedKeys.includes(k)) return true;
      if (!_pend.deletes.includes(c.cloud_id)) _pend.deletes.push(c.cloud_id);
      _pend.deletedKeys.splice(_pend.deletedKeys.indexOf(k), 1);
      _savePending();
      return false;
    });
    // A deleted key with no cloud row and no upload in flight is settled.
    const _before = _pend.deletedKeys.length;
    _pend.deletedKeys = _pend.deletedKeys.filter(k => _sessUploading.has(k));
    if (_pend.deletedKeys.length !== _before) _savePending();

    // Older builds could insert the same session twice; the merge shows one, so
    // remember every row id per key — deleting the session deletes all of them.
    _cloudIdsByKey = {};
    cloudArr.forEach(c => { const k = _sessionKey(c) + '#' + _sessFingerprint(c); (_cloudIdsByKey[k] = _cloudIdsByKey[k] || []).push(c.cloud_id); });

    const merged = _mergeSessions(_localSnapshot, cloudArr).map(s => _validateSession(s) || s);
    completedSessions.length = 0;
    merged.forEach(s => completedSessions.push(s));
    _normalizeSessionWeights(completedSessions); // repair amended-weight sessions

    // Local-only (offline) sessions are re-uploaded by flushPending() below —
    // it keeps them queued until the cloud confirms, with retry/backoff.
    const _toUpload = completedSessions.filter(s => !s.cloud_id).length;
    if(_toUpload){ console.log('[sync] recovering', _toUpload, 'offline session(s)'); saveLocalCache(); }
  }

  // Load weights + profile blob
  if (Array.isArray(weightRows)) {
    weightRows.forEach(r => {
      if (r.exercise_name === '__profile__' && r.notes && _profileLocalWins) {
        // This device holds newer, unconfirmed profile changes — keep them;
        // flushPending() below uploads them. (Cloud blob intentionally skipped.)
      } else if (r.exercise_name === '__profile__' && r.notes) {
        // Restore profile, preferences, custom workouts from cloud
        try {
          const blob = JSON.parse(r.notes);
          // Cloud data is untrusted input: sanitise user-named collections
          // (names reach HTML) when the sanitisers are available.
          if (Array.isArray(blob.customWorkouts) && typeof _sanitiseCustomWorkouts === 'function') blob.customWorkouts = _sanitiseCustomWorkouts(blob.customWorkouts);
          if (Array.isArray(blob.customHIITs) && typeof _sanitiseCustomHIITs === 'function') blob.customHIITs = _sanitiseCustomHIITs(blob.customHIITs);
          if (blob.userProfile && typeof blob.userProfile === 'object' && !Array.isArray(blob.userProfile)) Object.assign(userProfile, blob.userProfile);
          if (typeof blob.todayProg === 'string' && blob.todayProg) todayProg = blob.todayProg;
          if (Array.isArray(blob.customWorkouts)) {
            customWorkouts.length = 0;
            blob.customWorkouts.forEach(w => customWorkouts.push(w));
            localStorage.setItem('maxgainz_custom', JSON.stringify(customWorkouts));
          }
          if (Array.isArray(blob.customHIITs)) {
            // Update local store and merge into runtime HIIT array
            localStorage.setItem('maxgainz_custom_hiits', JSON.stringify(blob.customHIITs));
            if(typeof customHIITs !== 'undefined'){
              customHIITs.length = 0;
              blob.customHIITs.forEach(w => customHIITs.push(w));
            }
            // Merge into HIIT array (avoid duplicates)
            blob.customHIITs.forEach(w => {
              if(!HIIT.find(h => h.name === w.name)) HIIT.push(w);
            });
          }
          if (blob.prefs) {
            if (blob.prefs.speedUnit)  { localStorage.setItem('userSpeedUnit',  blob.prefs.speedUnit);  userPreferences.speedUnit  = blob.prefs.speedUnit;  }
            if (blob.prefs.runnerLevel){ localStorage.setItem('userRunnerLevel', blob.prefs.runnerLevel); userPreferences.runnerLevel = blob.prefs.runnerLevel; }
            if (blob.prefs.weightUnit) { localStorage.setItem('userWeightUnit', blob.prefs.weightUnit); userPreferences.weightUnit = blob.prefs.weightUnit; }
            if (blob.prefs.audioEnabled !== undefined) {
              userPreferences.audioEnabled = !!blob.prefs.audioEnabled;
              localStorage.setItem('userAudioEnabled', userPreferences.audioEnabled ? '1' : '0');
            }
            if (blob.prefs.trackRPE !== undefined) {
              userPreferences.trackRPE = !!blob.prefs.trackRPE;
              localStorage.setItem('maxgainz_trackRPE', userPreferences.trackRPE ? '1' : '0');
            }
            if (blob.prefs.periodize !== undefined) {
              userPreferences.periodize = !!blob.prefs.periodize;
              localStorage.setItem('maxgainz_periodize', userPreferences.periodize ? '1' : '0');
            }
            if (blob.prefs.rotateExercises !== undefined) {
              userPreferences.rotateExercises = !(blob.prefs.rotateExercises === false || blob.prefs.rotateExercises === 0 || blob.prefs.rotateExercises === '0' || blob.prefs.rotateExercises === 'false');
              localStorage.setItem('maxgainz_rotateExercises', userPreferences.rotateExercises ? '1' : '0');
            }
            if (blob.prefs.demoSex === 'male' || blob.prefs.demoSex === 'female') {
              userPreferences.demoSex = blob.prefs.demoSex;
              localStorage.setItem('userDemoSex', blob.prefs.demoSex);
            }
            if (blob.prefs.ai !== undefined) {
              userPreferences.ai = _aiPrefsMerge(userPreferences.ai, blob.prefs.ai);
              try { localStorage.setItem(AI_PREFS_KEY, JSON.stringify(userPreferences.ai)); } catch(e){}
              if (typeof _renderAiSettings === 'function') _renderAiSettings();
            }
          }
          if (blob.userPath) {
            userPath = blob.userPath;
            localStorage.setItem('maxgainz_path', JSON.stringify(userPath));
          } else {
            // Cloud has no path — ensure local state matches
            userPath = null;
            localStorage.removeItem('maxgainz_path');
          }
          // Merge completed-path history by id (don't blindly overwrite: a
          // path archived offline must survive a cloud load of an older blob).
          // If either side has celebrated=true, keep it true.
          if (Array.isArray(blob.pathHistory)) {
            const byId = {};
            blob.pathHistory.forEach(p => { if(p && p.id) byId[p.id] = {...p}; });
            (Array.isArray(pathHistory) ? pathHistory : []).forEach(p => {
              if(!p || !p.id) return;
              if(!byId[p.id]) byId[p.id] = {...p};
              else if(p.celebrated) byId[p.id].celebrated = true;
            });
            pathHistory = Object.values(byId)
              .sort((a, b) => (b.completedDate || '').localeCompare(a.completedDate || ''));
            localStorage.setItem('maxgainz_pathHistory', JSON.stringify(pathHistory));
          }
          // Restore onboarded flag from cloud so it survives new devices/browsers
          if (blob.onboarded) {
            localStorage.setItem('maxgainz_onboarded', '1');
          }
          // Restore body weight log
          if (Array.isArray(blob.bodyWeightLog)) {
            bodyWeightLog = blob.bodyWeightLog;
          }
          // Restore body measurements log
          if (Array.isArray(blob.measurementsLog)) {
            measurementsLog = blob.measurementsLog;
          }
          // Restore daily notes (object keyed by date)
          if (blob.dailyNotes && typeof blob.dailyNotes === 'object' && !Array.isArray(blob.dailyNotes)) {
            dailyNotes = blob.dailyNotes;
          }
          // Restore Personal Best tile set
          if (Array.isArray(blob.pbLifts)) {
            pbLifts = (typeof _sanitisePBLifts === 'function') ? _sanitisePBLifts(blob.pbLifts) : blob.pbLifts;
            try { localStorage.setItem('maxgainz_pbLifts', JSON.stringify(pbLifts)); } catch(e){}
          }
        } catch(e) { console.warn('Profile blob parse error:', e); }
      } else if (typeof r.exercise_name === 'string' && r.exercise_name.startsWith('__')) {
        // Reserved system rows (__profile__ without notes, the __dashboard__
        // summary) are never exercise weights — skip them.
      } else if (Object.prototype.hasOwnProperty.call(_pend.weights, r.exercise_name)) {
        // A local weight change the cloud hasn't confirmed — keep the local value.
      } else {
        customWeights[r.exercise_name] = r.weight;
      }
    });
    applyCustomWeights();
    _dashWeightsOk = true; // safe to publish a dashboard summary: profile/path are hydrated
  }

  if (_profileRow && !_profileLocalWins) _setProfileSeen(_profileRow.updated_at);
  if (_pend.profile && !_profileLocalWins) {
    // Cloud blob applied over unconfirmed local changes — carry local-only
    // entries over; if any were, keep the profile pending so the merged
    // result is uploaded by flushPending() below.
    let carried = 0;
    if (_localExtras) {
      const m = _mergeLocalProfileExtras({
        bodyWeightLog, measurementsLog, dailyNotes, customWorkouts,
        customHIITs: JSON.parse(localStorage.getItem('maxgainz_custom_hiits') || '[]')
      }, _localExtras);
      carried = m.added;
      if (carried) {
        bodyWeightLog = m.bodyWeightLog;
        measurementsLog = m.measurementsLog;
        dailyNotes = m.dailyNotes;
        customWorkouts.length = 0; m.customWorkouts.forEach(w => customWorkouts.push(w));
        localStorage.setItem('maxgainz_custom', JSON.stringify(customWorkouts));
        localStorage.setItem('maxgainz_custom_hiits', JSON.stringify(m.customHIITs));
        try { if (typeof customHIITs !== 'undefined') { customHIITs.length = 0; m.customHIITs.forEach(w => customHIITs.push(w)); } } catch(e) {}
        m.customHIITs.forEach(w => { if (w && !HIIT.find(h => h.name === w.name)) HIIT.push(w); });
      }
    }
    _pend.profile = carried > 0;
    if (carried) _profileRev++;
    _savePending();
  }

  // Update local cache from cloud data
  saveLocalCache();
  lsSetRaw(HYDRATED_KEY, userId); // this device now holds the account's real cloud state
  _markSynced();
  _cloudLoadedThisPage = true;
  // Push anything still pending (offline sessions, queued deletes, local-wins
  // profile, unconfirmed weights). The status stays "Syncing…" until it's done,
  // and only reads "Synced to account" when nothing is left.
  flushPending();
  _recomputeSyncStatus();
  return true;
}

// ── Session match key + conflict-safe merge (moved from DATA-INTEGRITY HELPERS) ──
// Stable match key for a session: finish timestamp (to the second) + day.
// Distinct sessions never collide (a user can't finish two in the same second
// on the same day); a local copy and its cloud copy of the SAME session still
// match even if sub-second precision differs across the Supabase round-trip.
function _sessionKey(s){
  if(!s || !s.date) return '?';
  const d = s.date instanceof Date ? s.date : new Date(s.date);
  const iso = isNaN(d) ? String(s.date) : d.toISOString().slice(0,19);
  return iso + '|' + (s.day || '');
}

// Conflict-safe merge of local + cloud session lists. Cloud copies are
// authoritative (they carry cloud_id); any LOCAL session whose key is absent
// from the cloud set is an unsynced/offline session — keep it and flag it for
// re-upload (_needsUpload). Never drops data, never duplicates a matched one.
function _mergeSessions(localArr, cloudArr){
  const byKey = {};
  (cloudArr || []).forEach(s => { byKey[_sessionKey(s)] = s; });
  (localArr || []).forEach(s => {
    const k = _sessionKey(s);
    if(!(k in byKey)) byKey[k] = Object.assign({}, s, { _needsUpload: true });
  });
  return Object.values(byKey).sort((a, b) => new Date(a.date) - new Date(b.date));
}
