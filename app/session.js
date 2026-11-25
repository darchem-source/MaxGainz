// app/session.js — Max Gainz active-session state and pure session logic.
// Priority 7, slice 3 (pure parts only). Moved verbatim from index.html (no
// behaviour change).
//
// Edit THIS file, then run `python3 tools/bundle.py`: it is copied into a
// marked region at the top of index.html's script, directly after app/sync.js
// (the app still ships as one file). Gate 35 fails if the copy drifts, and
// loads this file ON ITS OWN in jsc to test it.
//
// What is here: the declarations of the running workout's state (one place to
// read its shape), and the session logic that needs no page — last-time sets,
// set deltas, repeat-set values, next-step text, Epley 1RM, the cooldown
// picker and the trained-groups query. Classic script: top-level declarations
// are shared globals, exactly as before. Load time only runs the initialisers
// below (literals); nothing here touches the DOM.
//
// Slice 3b added the STATE TRANSITIONS the page calls (no DOM here):
//   _resetSessionLog   — every start path (ULF, PPL, custom, HIIT)
//   _recordSetValues   — reps / weight / optional RPE (rep modal, typed sets,
//                        repeat set, swipe-to-log)
//   _markSetDone       — done-set list, set count, completion timestamp
//   _buildSessionRecord— what finishSession saves (duration, volume, setLog,
//                        topLifts); pure, inputs passed in
//   _sessionPhase / _loggedSetCount — what _activeSessionInfo reports
// The page still owns timers, the DOM, toasts, XP, saving and navigation, and
// the timed / core-circuit / AMRAP paths that write sets their own way.
//
// RUN-TIME dependencies on index.html (never at load time):
//   _sessionTrainedGroups → getSplits (typeof-guarded)
// Everything else here is pure (inputs in, values out), a declaration, or a
// transition that only touches the state declared below.

// ═══ Running-workout state (declarations moved from STATE / SESSION STATE) ═══
let sessDay=null,sessExs=[],curIdx=0,setsDone={},repsLogged={},sessTimeSec=0,sessInterval=null,restInterval=null,restSec=0,totalSets=0;
let pendingRepSetIdx=-1;
let rpeLogged={};       // {exIdx: {setIdx: rpe 6-10}} — optional effort capture
let _pendingRPE=null;   // RPE selected in the open rep modal (null = unset)
var _activeSessionOwner = null; // uid that owned the running workout at sign-out
let sessStartTime = null;
let sessProgKey = null; // programme identity of the running session ('ULF','PPL','library:<id>','custom','hiit')
let supersets = {};
let warmupShown = {};
let warmupDone = {};
// Per-set completion timestamps: { exerciseIdx: { setIdx: ms } }. Used by Rest Time Analysis.
let setTimestamps = {};
let equipOverride = {};
let setWeights = {};
let exSetTimerInterval = null; // for timed exercise sets

// ── Phase 1: per-set "last time", repeat-set and post-set feedback ─────────
// All pure (inputs in, values out — no globals, no DOM) so tests/check.py
// gate 10 can run them in JXA. Read-only over history: no data-format change.

// One setLog entry → [{w, r}] per logged set. setLog.reps / setWeights are
// dense copies of index-keyed objects, so alignment with today's set index is
// best effort. Older rows have no setWeights: fall back to the top weight.
// Bodyweight moves report w:0. r is null when the stored value isn't a number.
function _lastSetsFromLog(entry){
  if(!entry || !Array.isArray(entry.reps)) return [];
  const sw = Array.isArray(entry.setWeights) ? entry.setWeights : null;
  const top = Number(entry.weight) || 0;
  return entry.reps.map((r, i) => {
    const rn = Number(r);
    const wi = sw ? Number(sw[i]) : NaN;
    // Bodyweight moves can carry added load (BW +10): keep whatever was recorded.
    const w = wi > 0 ? wi : top;
    return { w: w > 0 ? w : 0, r: (Number.isFinite(rn) && rn > 0) ? rn : null };
  });
}

// Newest session whose setLog has any of `names` (alias list, priority order)
// → {date, sets:[{w,r}], bw}. null when there's no history.
function getLastSessionSets(sessions, names){
  if(!Array.isArray(sessions) || !Array.isArray(names) || !names.length) return null;
  let best = null, bestT = -Infinity;
  for(const s of sessions){
    if(!s || !s.setLog || s.manualActivity) continue;
    const key = names.find(n => s.setLog[n]);
    if(!key) continue;
    const t = new Date(s.date).getTime();
    if(!(t > bestT)) continue;
    best = { s, key }; bestT = t;
  }
  if(!best) return null;
  const entry = best.s.setLog[best.key];
  return { date: best.s.date, sets: _lastSetsFromLog(entry), bw: !!entry.bw };
}

function _fmtKg(n){ return String(Math.round(Number(n) * 100) / 100); }

// What changed vs the same set last time. cur/prev = {w, r}; prev may be null.
// opts = {bw, timed}. Returns {text, dir} with dir ∈ up|down|same|mixed|new.
function _setDeltaText(cur, prev, opts){
  const o = opts || {};
  if(!cur || !(Number(cur.r) > 0)) return { text: '', dir: 'new' };
  if(!prev || !(Number(prev.r) > 0)) return { text: 'No matching set last time to compare', dir: 'new' };
  const unit = o.timed ? ' s' : '';
  const dr = Number(cur.r) - Number(prev.r);
  // Bodyweight compares added load (BW +10 vs BW +5) only when both sets carried some.
  const useW = !o.timed && Number(prev.w) > 0 && Number(cur.w) > 0;
  const dw = useW ? Math.round((Number(cur.w) - Number(prev.w)) * 100) / 100 : 0;
  const parts = [];
  if(dw) parts.push((dw > 0 ? '+' : '−') + _fmtKg(Math.abs(dw)) + ' kg');
  if(dr){
    if(o.timed) parts.push((dr > 0 ? '+' : '−') + Math.abs(dr) + unit);
    else parts.push((dr > 0 ? '+' : '−') + Math.abs(dr) + (Math.abs(dr) === 1 ? ' rep' : ' reps'));
  }
  if(!parts.length){
    const what = o.timed ? (cur.r + unit) : (useW ? (o.bw ? 'BW +' : '') + _fmtKg(cur.w) + ' kg × ' + cur.r : cur.r + (cur.r === 1 ? ' rep' : ' reps'));
    return { text: 'Matched last time (' + what + ')', dir: 'same' };
  }
  let dir;
  if((dw > 0 && dr >= 0) || (dw === 0 && dr > 0)) dir = 'up';
  else if((dw < 0 && dr <= 0) || (dw === 0 && dr < 0)) dir = 'down';
  else dir = 'mixed';
  return { text: parts.join(', ') + ' vs last time', dir };
}

// First set index not yet logged (0..sets-1), or -1 when all are done.
function _nextOpenSetIdx(done, sets){
  const d = Array.isArray(done) ? done : [];
  for(let i = 0; i < (Number(sets) || 0); i++) if(!d.includes(i)) return i;
  return -1;
}

// Values "Repeat previous set" would log for set `setIdx`.
// Set > 0: the latest earlier set logged THIS session. Set 0 (or nothing
// logged yet): the same set last time. null = nothing to repeat.
// sessReps / sessWts are this exercise's index-keyed objects.
function _repeatSetValues(setIdx, sessReps, sessWts, lastSets, plannedW, bw){
  const R = sessReps || {}, W = sessWts || {};
  for(let j = setIdx - 1; j >= 0; j--){
    const r = Number(R[j]);
    if(r > 0){
      const w = Number(W[j]);
      // bw moves keep their added load (BW +10) exactly like the rep modal does.
      return { r, w: w > 0 ? w : (Number(plannedW) || 0), src: 'session', from: j };
    }
  }
  const p = Array.isArray(lastSets) ? lastSets[setIdx] : null;
  if(p && Number(p.r) > 0) return { r: Number(p.r), w: Number(p.w) || 0, src: 'last', from: setIdx };
  return null;
}

// The next-step line shown after a set. info = {nextSetNo, totalSets, w,
// reps, restSecs, bw, timed, nextExName, suggestW}. Plain text (caller escapes).
function _nextStepText(info){
  const i = info || {};
  if(i.nextSetNo){
    let what;
    if(i.timed) what = (i.reps || '') ;
    else if(!(Number(i.w) > 0)) what = (i.reps ? i.reps + ' reps' : '');
    else what = (i.bw ? 'BW +' : '') + _fmtKg(i.w) + ' kg × ' + (i.reps || '');
    let t = 'Next: set ' + i.nextSetNo + ' of ' + i.totalSets + (what ? ' · ' + what : '');
    if(Number(i.suggestW) > 0 && Number(i.suggestW) !== Number(i.w)) t += ' (or try ' + _fmtKg(i.suggestW) + ' kg)';
    if(Number(i.restSecs) > 0) t += ' after ' + i.restSecs + ' s rest';
    return t;
  }
  if(i.nextExName) return 'Exercise done · Next: ' + i.nextExName;
  return 'All exercises done · Finish when ready';
}

// Epley 1RM estimate: weight × (1 + reps/30)
function calc1RM(weight, reps){
  if(!weight || !reps || reps < 1) return weight;
  return weight * (1 + reps / 30);
}

// ── Cooldown picker + trained groups (moved from FINISH SESSION + OPTIONAL COOLDOWN) ──
// Pure: pick `count` stretches covering the trained groups, cycling round-
// robin across the groups for even coverage; unique picks only. seed rotates
// the starting pick within each group so repeat days vary a little.
function _buildCooldown(groups, seed, lib, count, weights){
  const L = Array.isArray(lib) ? lib : [];
  const n = (typeof count === 'number' && count > 0) ? count : 6;
  let gs = Array.isArray(groups) ? groups.filter(g => ['push','pull','legs','core'].indexOf(g) >= 0) : [];
  if(!gs.length) gs = ['push','pull','legs','core'];
  const s = Math.abs(Math.floor(Number(seed) || 0));
  const byGroup = {};
  gs.forEach(g => { byGroup[g] = L.filter(x => x && Array.isArray(x.groups) && x.groups.indexOf(g) >= 0); });
  // Per-group quotas ∝ trained volume share (equal when no weights supplied),
  // largest-remainder rounding, every group guaranteed ≥1. A leg-dominant day
  // gets a leg-dominant cooldown instead of a flat round-robin.
  const w = {};
  let wSum = 0;
  gs.forEach((g, i) => { const v = (weights && typeof weights[g] === 'number' && weights[g] > 0) ? weights[g] : 1; w[g] = v; wSum += v; });
  const quota = {}, frac = [];
  let assigned = 0;
  gs.forEach(g => { const exact = n * w[g] / wSum; quota[g] = Math.max(1, Math.floor(exact)); assigned += quota[g]; frac.push([exact - Math.floor(exact), g]); });
  frac.sort((a, b) => b[0] - a[0]);
  for(let i = 0; assigned < n && i < frac.length; i++){ quota[frac[i][1]]++; assigned++; }
  const out = [], used = new Set(), idx = {};
  gs.forEach(g => { idx[g] = (byGroup[g] || []).length ? s % byGroup[g].length : 0; });
  const sorted = gs.slice().sort((a, b) => w[b] - w[a]);
  for(const g of sorted){
    const pool = byGroup[g] || [];
    let taken = 0;
    for(let k = 0; k < pool.length && taken < quota[g] && out.length < n; k++){
      const cand = pool[(idx[g] + k) % pool.length];
      if(!used.has(cand.slug)){ used.add(cand.slug); out.push(cand); taken++; }
    }
  }
  // Top up from the whole library when the targeted pools ran dry, so a
  // push-only day still gets a full-length cooldown.
  for(let k = 0; out.length < n && k < L.length; k++){
    const cand = L[(s + k) % L.length];
    if(cand && cand.slug && !used.has(cand.slug)){ used.add(cand.slug); out.push(cand); }
  }
  return out;
}

// Which broad groups did this session actually train? Sets logged → those
// exercises; nothing logged yet → every planned exercise.
function _sessionTrainedGroups(){
  const weights = {};
  const add = (name) => {
    const sp = (typeof getSplits === 'function') ? getSplits(name) : null;
    if(sp) sp.forEach(x => { if(x && x.f >= 0.3) weights[x.cat] = (weights[x.cat] || 0) + x.f; });
  };
  let any = false;
  sessExs.forEach((ex, i) => { if((setsDone[i]||[]).length > 0){ add(ex.name); any = true; } });
  if(!any) sessExs.forEach(ex => add(ex.name));
  return { groups: Object.keys(weights), weights };
}

// ═══ Transitions (Priority 7 slice 3b) ═══
// Fresh per-workout log. Called by every start path; the page then sets
// sessDay / sessExs / sessStartTime and its own window flags.
function _resetSessionLog(){
  curIdx = 0; setsDone = {}; repsLogged = {}; rpeLogged = {}; _pendingRPE = null; totalSets = 0; sessTimeSec = 0;
  supersets = {}; warmupShown = {}; warmupDone = {}; equipOverride = {}; setWeights = {}; setTimestamps = {};
}
// Record a set's reps and weight. rpe: a number stores it, null clears it,
// undefined leaves any stored RPE alone (callers that don't manage RPE).
function _recordSetValues(exIdx, setIdx, reps, weight, rpe){
  if(!repsLogged[exIdx]) repsLogged[exIdx] = {};
  if(!setWeights[exIdx]) setWeights[exIdx] = {};
  repsLogged[exIdx][setIdx] = reps;
  setWeights[exIdx][setIdx] = weight;
  if(rpe === undefined) return;
  if(!rpeLogged[exIdx]) rpeLogged[exIdx] = {};
  if(rpe != null) rpeLogged[exIdx][setIdx] = rpe;
  else delete rpeLogged[exIdx][setIdx];
}
// Mark a set done. Returns true the first time (counts it once); the
// completion time is kept from the first mark.
function _markSetDone(exIdx, setIdx, nowMs){
  if(!setsDone[exIdx]) setsDone[exIdx] = [];
  const isNew = !setsDone[exIdx].includes(setIdx);
  if(isNew){ setsDone[exIdx].push(setIdx); totalSets++; }
  if(!setTimestamps[exIdx]) setTimestamps[exIdx] = {};
  if(setTimestamps[exIdx][setIdx] === undefined) setTimestamps[exIdx][setIdx] = nowMs;
  return isNew;
}
// Pure: 'idle' (no workout on screen), 'active', or 'finished' (Finish ran;
// the Session tab may still show while the summary is open).
function _sessionPhase(tabShown, finalized){
  if(!tabShown) return 'idle';
  return finalized === true ? 'finished' : 'active';
}
// Pure: sets logged across every exercise.
function _loggedSetCount(done){
  let sets = 0;
  Object.keys(done || {}).forEach(k => { if(Array.isArray(done[k])) sets += done[k].length; });
  return sets;
}
// Pure: the record finishSession saves. The body is finishSession's own code,
// unchanged: its inputs arrive as locals named exactly like the globals.
// Returns { dMin, volume, setLog, topLifts }.
function _buildSessionRecord(input){
  const { sessExs, setsDone, repsLogged, setWeights, setTimestamps, rpeLogged, equipOverride, _exerciseNotes, sessTimeSec } = input;
  const dMin=Math.max(1,Math.round(sessTimeSec/60));
  let volume=0;
  sessExs.forEach((ex,i)=>{
    const done=(setsDone[i]||[]).length;
    if(done>0){
      const rl=repsLogged[i]||{}, sw=setWeights[i]||{};
      for(let s=0;s<done;s++){
        // Same sanitising as the setLog weight below: object/string weights
        // (some HIIT definitions) count as 0 instead of making volume NaN.
        const _w=sw[s]||ex.weight||0;
        const w=(typeof _w==='number'&&isFinite(_w)&&_w>=0)?_w:0;
        const r=rl[s]||parseInt((ex.reps||'8').split('–')[0])||8;
        volume+=w*r;
      }
    }
  });
  // console.log('finishSession: step 4 - setLog');
  // topLifts is computed AFTER setLog (below) so it uses each exercise's
  // actual logged top-set weight, not sessExs[i].weight (the planned value,
  // which is stale once the user amends weight per-set during logging).
  const setLog={};
  sessExs.forEach((ex,i)=>{
    const done=(setsDone[i]||[]).length;
    const rl=repsLogged[i]||{}, sw=setWeights[i]||{};
    if(done>0){
      // Per-set rest deltas in seconds: gap between consecutive set completions, minus the working set itself
      // Approximation: rest = (t[k] - t[k-1]) - estimated_working_seconds. We just store the raw deltas
      // (between consecutive completions) — they include the next set's working time, but for averaging
      // across many sets the working time is roughly constant and the trend is what matters.
      const ts = setTimestamps[i] || {};
      const sortedKeys = Object.keys(ts).map(k => parseInt(k)).sort((a,b)=>a-b);
      const restSecs = [];
      for(let k = 1; k < sortedKeys.length; k++){
        const dt = (ts[sortedKeys[k]] - ts[sortedKeys[k-1]]) / 1000;
        if(dt > 0 && dt < 600) restSecs.push(Math.round(dt)); // sanity: drop > 10min outliers
      }
      // Sanitize weight to a non-negative finite number. HIIT exercise
      // definitions sometimes set weight to objects ({kg:"12-15"}) or strings
      // ("bodyweight") — storing those would NaN-poison muscle balance.
      // Also sanitize each entry in setWeights (per-set logged weights).
      const _exWPlanned = (typeof ex.weight === 'number' && isFinite(ex.weight) && ex.weight >= 0) ? ex.weight : 0;
      const _swArr = Object.values(sw).map(v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0);
      // Representative weight for this exercise this session = the heaviest
      // set ACTUALLY logged. Weight amendments made while logging (e.g. the
      // user drops a planned 90kg bench to 80kg per set) live only in
      // setWeights — ex.weight keeps the planned value forever. Recording
      // ex.weight here mis-stored the session weight (summary showed 90kg
      // while the sets were logged at 80kg) AND created false PBs (a 90kg
      // "personal best" that never happened). Derive from the logged sets;
      // fall back to the planned weight only when no per-set weight was
      // captured. Bodyweight moves stay 0.
      const _loggedW = _swArr.filter(w => w > 0);
      const _exW = _loggedW.length ? Math.max(..._loggedW) : _exWPlanned;
      const _rpeArr = rpeLogged[i] ? Object.values(rpeLogged[i]).filter(v => typeof v === 'number' && v > 0) : [];
      // ord = position in the session's exercise list = performed order.
      // setLog is a name-keyed object; when round-tripped through Supabase
      // (jsonb), Postgres normalizes object key order by (length, bytewise),
      // scrambling the displayed exercise order on reload. Storing ord as a
      // NUMBER inside each value survives jsonb intact, so order-sensitive
      // views can re-sort by it. (Array/number values keep their order in
      // jsonb; only object KEY order is normalized.)
      setLog[ex.name]={ord:i,sets:done,reps:Object.values(rl),weight:_exW,bw:!!ex.bw,setWeights:_swArr,equipOverride:equipOverride[i]||null,note:_exerciseNotes[ex.name]||null,restSecs:restSecs.length?restSecs:undefined,...(_rpeArr.length?{rpe:_rpeArr}:{})};
    }
  });
  // Top lifts for the summary header / share card — derived from the
  // corrected setLog (actual logged top-set weights), excluding bodyweight.
  const topLifts = Object.entries(setLog)
    .filter(([, e]) => !e.bw && e.weight > 0)
    .map(([name, e]) => ({ name, weight: e.weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2);
  return { dMin, volume, setLog, topLifts };
}
