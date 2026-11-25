// app/rules.js — Max Gainz data contracts and pure training rules.
// Priority 7, slice 5. Moved verbatim from index.html (no behaviour change).
//
// Edit THIS file, then run `python3 tools/bundle.py` (bundled at the top of
// index.html's script, after app/ai.js). Gate 37 loads it on its own in jsc
// with nothing but a console and runs the rules there; gate 2 still runs them
// against the whole page.
//
// Everything here is pure: inputs in, values out. No DOM, no storage, no
// network, no app state. Functions that read the clock take it as an optional
// argument (getRecencyWeight nowMs) or use `new Date()` only for "this week"
// (calcWeekStreak), exactly as before. Load time only runs literal initialisers.
//
// Depends on an earlier module: app/session.js (calc1RM, used by getLiftState).
// No dependency on index.html. Callers that gather app state (buildLiftHistory,
// _calcMuscleGroupShare, the achievement checks, renderers) stay in index.html.


// ═══ Data contracts: session shape on load ═══
// Sanitize a session on load so malformed data can't NaN-poison analytics.
// Returns a cleaned COPY (preserving cloud_id / _needsUpload / adhoc / etc.),
// or null only when there's no usable date at all.
function _validateSession(s){
  if(!s || typeof s !== 'object') return null;
  const d = s.date instanceof Date ? s.date : new Date(s.date);
  if(isNaN(d)) return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;
  const out = Object.assign({}, s);
  out.date = d;
  out.day = (typeof s.day === 'string' && s.day) ? s.day : 'Workout';
  out.durationMin = num(s.durationMin);
  out.volume = num(s.volume);
  out.exercises = num(s.exercises);
  out.manualActivity = !!s.manualActivity;
  if(!Array.isArray(out.topLifts)) out.topLifts = [];
  if(s.setLog && typeof s.setLog === 'object'){
    const sl = {};
    for(const k in s.setLog){
      const e = s.setLog[k];
      if(e && typeof e === 'object'){
        sl[k] = Object.assign({}, e, {
          sets: num(e.sets),
          weight: num(e.weight),
          reps: Array.isArray(e.reps) ? e.reps : [],
          ...(Array.isArray(e.rpe)
            ? { rpe: e.rpe.map(v => (typeof v === 'number' && v >= 1 && v <= 10) ? v : null).filter(v => v != null) }
            : {})
        });
      }
    }
    out.setLog = sl;
  } else {
    out.setLog = {};
  }
  return out;
}

// One-time-per-load data repair for the "amended weight" bug. When a user
// amended a lift's weight while logging (e.g. dropped a planned 90kg bench to
// 80kg per set), older builds stored the PLANNED weight in setLog[name].weight
// and topLifts — while the ACTUAL lifted weights were always stored correctly
// in setLog[name].setWeights. That mis-stored the session weight (summary
// showed 90kg) and created false PBs (a 90kg best that never happened).
//
// This recomputes each exercise's representative weight from its logged sets
// (heaviest set) and rebuilds topLifts to match. Idempotent: sessions never
// amended are unchanged (max of setWeights already equals the stored weight),
// so it's safe to run on every load.
function _normalizeSessionWeights(sessions){
  if(!Array.isArray(sessions)) return;
  sessions.forEach(s => {
    if(!s || s.manualActivity || !s.setLog || typeof s.setLog !== 'object') return;
    Object.values(s.setLog).forEach(e => {
      if(!e || e.bw) return;
      const sw = Array.isArray(e.setWeights)
        ? e.setWeights.filter(w => typeof w === 'number' && isFinite(w) && w > 0)
        : [];
      if(sw.length){
        const top = Math.max(...sw);
        if(e.weight !== top) e.weight = top;
      }
    });
    // Rebuild topLifts from the corrected setLog (heaviest 2 non-bodyweight
    // lifts). Only when setLog has usable entries — never wipe topLifts for
    // legacy sessions that lack a setLog.
    const lifts = Object.entries(s.setLog)
      .filter(([, e]) => e && !e.bw && e.weight > 0)
      .map(([name, e]) => ({ name, weight: e.weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2);
    if(lifts.length) s.topLifts = lifts;
  });
}

// Local YYYY-MM-DD (NOT toISOString, which is UTC and can be off by a day).
function _localYMD(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ═══ XP, ranks and prestige ═══
// 16 ranks across 5 tiers, calibrated so a committed 4x/week lifter reaches
// the top in ~2–2.5 years. The old 7-rank ladder topped out at 10,000 XP —
// below the one-time achievement pool (21,740) — so it was trivially maxed
// in a month. The new curve front-loads early rank-ups (week-1 hook) then
// decelerates: the achievement pool alone only carries you to ~#9 (mid-
// ladder); the back half is earned purely through sustained training.
const RANK_TIERS = ['Foundations','Building','Tempered','Iron','Mastery'];
const RANKS=[
  {name:'Day One',         emoji:'🌱', min:0,      max:250,     color:'#7d8a99', tier:'Foundations'},
  {name:'First Steps',     emoji:'👟', min:250,    max:750,     color:'#9aa7b4', tier:'Foundations'},
  {name:'Finding Rhythm',  emoji:'🧭', min:750,    max:1700,    color:'#5fb3a3', tier:'Foundations'},
  {name:'Consistent',      emoji:'🔗', min:1700,   max:3200,    color:'#4caf78', tier:'Building'},
  {name:'Committed',       emoji:'💪', min:3200,   max:5400,    color:'#3fa66a', tier:'Building'},
  {name:'Driven',          emoji:'🚀', min:5400,   max:8200,    color:'#cd7f32', tier:'Building'},
  {name:'Conditioned',     emoji:'🏃', min:8200,   max:11800,   color:'#d98a2b', tier:'Building'},
  {name:'Hardened',        emoji:'🪨', min:11800,  max:16500,   color:'#b0763a', tier:'Tempered'},
  {name:'Veteran',         emoji:'🎖️', min:16500,  max:23000,   color:'#c0c0c0', tier:'Tempered'},
  {name:'Battle-Tested',   emoji:'🛡️', min:23000,  max:31000,   color:'#9fb6c4', tier:'Tempered'},
  {name:'Iron Disciple',   emoji:'⚙️', min:31000,  max:41000,   color:'#7f8fa6', tier:'Iron'},
  {name:'Relentless',      emoji:'🔥', min:41000,  max:53000,   color:'#ff8c42', tier:'Iron'},
  {name:'Forged',          emoji:'🔨', min:53000,  max:68000,   color:'#ffb347', tier:'Iron'},
  {name:'Unbreakable',     emoji:'💎', min:68000,  max:88000,   color:'#00d4ff', tier:'Mastery'},
  {name:'Lifetime Lifter', emoji:'🏛️', min:88000,  max:115000,  color:'#c8ff00', tier:'Mastery'},
  {name:'Iron Eternal',    emoji:'🔱', min:115000, max:Infinity,color:'#ff4d6a', tier:'Mastery'},
];

// Prestige past the top rank: one ⭐ Eternal Star per 25,000 XP beyond the
// Iron Eternal threshold (~7 months of committed training each). Never resets.
const PRESTIGE_STEP = 25000;
function getPrestigeStars(xp){
  const top = RANKS[RANKS.length-1];
  if(xp < top.min) return 0;
  return Math.floor((xp - top.min) / PRESTIGE_STEP);
}

function getRank(xp){
  for(let i=RANKS.length-1;i>=0;i--) if(xp>=RANKS[i].min) return RANKS[i];
  return RANKS[0];
}

// Re-derive the FULL XP a single gym session is worth, mirroring exactly
// what calcSessionReward() awards at finish: base + volume + sets + duration.
// (The old getXPEvents only credited base +100 and the +50 ≥5kg bonus on
// recompute, silently dropping the +50 elite-volume, +25 20-sets and +30
// 60-min bonuses — so lifetime XP under-counted what users were shown.)
function _sessionXP(s){
  let xp = 100;
  if(s.volume >= 5000)  xp += 50;
  if(s.volume >= 10000) xp += 50;
  // Total sets logged this session (sum across setLog entries).
  let sets = 0;
  if(s.setLog && typeof s.setLog === 'object') for(const k in s.setLog){ sets += (s.setLog[k]?.sets || 0); }
  if(sets >= 20) xp += 25;
  if((s.durationMin || 0) >= 60) xp += 30;
  return xp;
}

// Comeback bonus — deterministic, capped, not farmable. A "comeback" is a gym
// session logged >= COMEBACK_GAP_DAYS after the previous gym session; each
// earns a FIXED bonus (you'd have to stop training for two weeks to get it, so
// it can't be gamed). Pure → unit-tested in tests/check.py.
const COMEBACK_GAP_DAYS = 14;
const COMEBACK_XP = 100;
function _comebackEvents(sessions){
  const gym = (sessions || [])
    .filter(s => !s.manualActivity)
    .map(s => (s.date instanceof Date ? s.date : new Date(s.date)))
    .filter(d => !isNaN(d))
    .sort((a, b) => a - b);
  const out = [];
  for(let i = 1; i < gym.length; i++){
    const gapDays = (gym[i] - gym[i-1]) / 86400000;
    if(gapDays >= COMEBACK_GAP_DAYS){
      out.push({ date: gym[i], desc: `Welcome back — ${Math.round(gapDays)}-day comeback bonus`, pts: COMEBACK_XP, type: 'comeback' });
    }
  }
  return out;
}

// ═══ Weeks and streaks ═══
// Mon-start ISO-ish week key (local) for grouping sessions.
function _weekKey(d){
  const dt = d instanceof Date ? new Date(d) : new Date(d);
  dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back to Monday
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
}

function getMaxWeeklySessions(sessions){
  if(!sessions.length) return 0;
  const weeks={};
  sessions.forEach(s=>{
    const d=new Date(s.date);
    const mon=new Date(d); mon.setDate(d.getDate()-(d.getDay()+6)%7); mon.setHours(0,0,0,0);
    // Local date key (NOT toISOString — that shifts to UTC and, for non-UTC
    // users, buckets a local-Monday session into the previous week. This must
    // match _weekKey() so the weekly-challenge bonus and the week_3/5/6
    // achievements agree on what counts as "a week".)
    const key=mon.getFullYear()+'-'+String(mon.getMonth()+1).padStart(2,'0')+'-'+String(mon.getDate()).padStart(2,'0');
    weeks[key]=(weeks[key]||0)+1;
  });
  return Math.max(...Object.values(weeks));
}

function calcWeekStreak(sessions){
  // Count consecutive weeks (Mon-Sun) with 3+ sessions, ending with the most recent complete week
  const weeks={};
  sessions.forEach(s=>{
    const d=new Date(s.date);
    const mon=new Date(d); mon.setDate(d.getDate()-(d.getDay()+6)%7); mon.setHours(0,0,0,0);
    const key=mon.getTime();
    weeks[key]=(weeks[key]||0)+1;
  });
  // Get current week start
  const now=new Date(); const curMon=new Date(now); curMon.setDate(now.getDate()-(now.getDay()+6)%7); curMon.setHours(0,0,0,0);
  let streak=0, check=new Date(curMon);
  // Check current week too
  for(let w=0;w<52;w++){
    const key=check.getTime();
    if((weeks[key]||0)>=3) streak++;
    else if(w>0) break; // allow current incomplete week to not break streak
    check.setDate(check.getDate()-7);
  }
  return streak;
}

// Longest-ever run of consecutive weeks with 3+ sessions (for lifetime stats).
function getLongestWeekStreak(sessions){
  const weeks={};
  sessions.forEach(s=>{
    const d=new Date(s.date);
    const mon=new Date(d); mon.setDate(d.getDate()-(d.getDay()+6)%7); mon.setHours(0,0,0,0);
    weeks[mon.getTime()]=(weeks[mon.getTime()]||0)+1;
  });
  const qualifying=Object.keys(weeks).filter(k=>weeks[k]>=3).map(Number).sort((a,b)=>a-b);
  if(!qualifying.length) return 0;
  const WEEK=7*24*60*60*1000;
  let best=1, run=1;
  for(let i=1;i<qualifying.length;i++){
    if(qualifying[i]-qualifying[i-1]===WEEK){ run++; best=Math.max(best,run); }
    else run=1;
  }
  return best;
}

// ═══ Progression: weight steps, rep targets, adaptive coaching engine ═══
// Snap a calculated weight to the nearest valid value in a steps array
function snapToSteps(weight, steps){
  if(!steps || !steps.length) return Math.round(weight * 2) / 2;
  return steps.reduce((best, s) => Math.abs(s - weight) < Math.abs(best - weight) ? s : best);
}

function stepWeight(current, dir, steps) {
  const idx = steps.findIndex(s => s >= current);
  if (dir > 0) {
    const next = steps.find(s => s > current);
    return next !== undefined ? next : steps[steps.length-1];
  } else {
    const prev = [...steps].reverse().find(s => s < current);
    return prev !== undefined ? prev : steps[0];
  }
}

// Parse a rep target (midpoint of range, or single value). Returns null for timed/AMRAP strings.
function parseRepTarget(repsStr){
  if(!repsStr || typeof repsStr !== 'string') return null;
  if(/[a-zA-Z]/.test(repsStr)) return null;
  const parts = repsStr.split('–');
  if(parts.length === 2){
    const lo = parseInt(parts[0]), hi = parseInt(parts[1]);
    if(!isNaN(lo) && !isNaN(hi)) return Math.round((lo + hi) / 2);
  }
  const single = parseInt(repsStr);
  return isNaN(single) ? null : single;
}

// getLiftState is the SINGLE decision authority for weight/rep coaching. Both
// the pre-session cue (renderLastTimeRef) and the post-session Coach's Notes
// (computeProgressionSuggestions) derive their recommendation from it, so they
// can never disagree again. It is PURE and fully injected — nowMs and the
// equipment `steps` array are passed in (never Date.now()/getWeightSteps
// internally), no DOM, no globals — so tests/check.py unit-tests it directly.
// Currently DORMANT (the surfaces still use the old code); wired in next.
//
// Block week → mesocycle "lean": wk1-2 accumulate, wk3 intensify, wk4 recovery.
function _leanFor(w){
  if(w == null) return 'neutral';
  const m = ((w % 4) + 4) % 4;
  return m === 3 ? 'intensify' : m === 0 ? 'neutral' : 'accumulate';
}

function getLiftState(input){
  const I = input || {};
  const plannedWeight = (typeof I.plannedWeight === 'number') ? I.plannedWeight : 0;
  const bw = !!I.bw;
  const timed = !!I.timed;
  const steps = (Array.isArray(I.steps) && I.steps.length) ? I.steps : [];
  const nowMs = (typeof I.nowMs === 'number') ? I.nowMs : 0;
  const history = Array.isArray(I.history) ? I.history : [];
  const thisSession = I.thisSession || null;                     // null ⇒ PRE/cue mode
  const rpe = (typeof I.rpeThisSession === 'number') ? I.rpeThisSession : null;
  const blockWeek = (typeof I.blockWeek === 'number') ? I.blockWeek : null;

  // Every return path carries this full key set so surface mappers never read undefined.
  const out = {
    action:'hold', suggested:plannedWeight, current:plannedWeight,
    confidence:'medium', reason:'', rule:'untracked',
    diag:{ daysSince:null, weeksAway:null, avgPriorReps:null, avgThisReps:null,
           repAdjustedWeight:null, lastSameWeight:false, sessionsAtWeight:0 },
    plateau:{ detected:false, sessionsStuck:0, tactic:null, detail:null },
    rpeApplied:false,
    periodization:{ week: blockWeek, lean:_leanFor(blockWeek), applied:false }
  };

  const target = parseRepTarget(I.repRange);

  // 0. Untracked (timed / non-numeric reps): no recommendation.
  if(timed || target === null){ out.rule='untracked'; return out; }

  // 1. First time — no history.
  if(!history.length){
    out.rule='first'; out.action='hold'; out.confidence='low';
    out.reason = 'First time logging this — pick a weight you can control.';
    return out;
  }

  const last = history[history.length-1];
  const baseline = (typeof last.weight === 'number' && last.weight > 0) ? last.weight : plannedWeight;
  out.current = baseline;
  const stepUp   = steps.length ? stepWeight(baseline, 1, steps) : baseline;
  const stepDown = steps.length ? stepWeight(baseline,-1, steps) : baseline;

  // Rep-range bounds.
  const repsSpec = String(I.repRange||'8').split('–');
  const lo = parseInt(repsSpec[0]) || 5;
  const hi = parseInt(repsSpec[1]) || lo;

  // Trailing sessions stuck at the baseline weight (the unified stall counter).
  let sessionsAtWeight = 0;
  for(let k = history.length-1; k >= 0; k--){ if(history[k].weight === baseline) sessionsAtWeight++; else break; }
  out.diag.sessionsAtWeight = sessionsAtWeight;
  out.diag.lastSameWeight = sessionsAtWeight >= 2;

  const priorReps = Array.isArray(last.reps) ? last.reps.map(r=>parseInt(r)||0).filter(r=>r>0) : [];
  const avgPriorReps = priorReps.length ? priorReps.reduce((a,b)=>a+b,0)/priorReps.length : null;
  out.diag.avgPriorReps = avgPriorReps;

  // 2. Gap deload (G): >= 4 weeks since last logged session. PRE-mode only —
  // post-session you've just trained, so a gap that's already over must not
  // prescribe a deload for next time (this also matches the old post-session
  // logic, which had no gap rule → no regression).
  const daysSince = nowMs ? Math.floor((nowMs - new Date(last.date).getTime())/86400000) : null;
  const weeksAway = (daysSince != null) ? daysSince/7 : null;
  out.diag.daysSince = daysSince;
  out.diag.weeksAway = (weeksAway != null) ? Math.round(weeksAway*10)/10 : null;
  if(thisSession === null && weeksAway != null && weeksAway >= 4){
    out.rule = 'G_gapDeload';
    if(bw){
      out.action='hold'; out.suggested=plannedWeight;
      out.reason = `${Math.round(weeksAway)}w off — ease back in, focus on form before pushing.`;
    } else {
      const pct = weeksAway < 6 ? 0.15 : weeksAway < 8 ? 0.20 : 0.25;
      const dl = steps.length ? snapToSteps(baseline*(1-pct), steps) : Math.round(baseline*(1-pct)*10)/10;
      out.action='deload'; out.suggested=dl;
      out.reason = `${Math.round(weeksAway)}w off — drop ~${Math.round(pct*100)}% to ${dl}kg and rebuild.`;
    }
    return out; // deload ignores RPE & periodization
  }

  // 3. Rep-shift (H): PRE mode only — today's target differs from prior avg.
  if(thisSession === null && !bw && avgPriorReps != null && Math.round(avgPriorReps) !== target){
    const oneRM = calc1RM(baseline, avgPriorReps);
    const raw = oneRM / (1 + target/30);
    const adj = steps.length ? snapToSteps(raw, steps) : Math.round(raw*10)/10;
    out.diag.repAdjustedWeight = adj;
    out.rule='H_repShift'; out.action='hold';
    // Rusty gate: 2–4 weeks off (4+ already gap-deloaded in rule G). The
    // rep-math can "translate" a strong last session into MORE weight
    // (15/15/15 at 70kg with today's target 13 → "75kg matches your last
    // effort") — bad coaching after a layoff. Never suggest above the last
    // logged weight off a 2+ week-old session; lighter equivalents pass.
    if(weeksAway != null && weeksAway >= 2 && adj > baseline){
      out.suggested = baseline;
      out.reason = `${Math.round(weeksAway)}w since last time — hold at ${baseline}kg and re-groove before moving up.`;
    } else {
      out.suggested = adj;
      out.reason = `Rep target is now ${target} — ${adj}kg matches your last effort.`;
    }
    return out; // rep-shift ignores RPE & periodization
  }

  // 4. Performance rules off the sample (this session if POST, else last session).
  const sample = (thisSession && Array.isArray(thisSession.reps))
    ? thisSession.reps.map(r=>parseInt(r)||0).filter(r=>r>0)
    : priorReps;
  const avgThis = sample.length ? sample.reduce((a,b)=>a+b,0)/sample.length : 0;
  out.diag.avgThisReps = sample.length ? avgThis : null;
  const allAtOrAboveTop = sample.length && sample.every(r => r >= hi);
  const allBelowLo      = sample.length && sample.every(r => r <  lo);
  const minSet = sample.length ? Math.min(...sample) : 0;
  const maxSet = sample.length ? Math.max(...sample) : 0;

  if(allAtOrAboveTop && stepUp > baseline){
    out.rule='A_topRange'; out.action='increase'; out.suggested=stepUp;
    out.confidence = out.diag.lastSameWeight ? 'high' : 'medium';
    out.reason = `Hit ${hi}+ on every set${out.diag.lastSameWeight?' again':''} — add weight, try ${stepUp}kg.`;
  } else if(avgThis > hi + 1 && stepUp > baseline){
    out.rule='B_avgOverTop'; out.action='increase'; out.suggested=stepUp; out.confidence='medium';
    out.reason = `Averaged ${Math.round(avgThis*10)/10} > ${hi} target — bump to ${stepUp}kg.`;
  } else if(sessionsAtWeight >= 3 && !allAtOrAboveTop && !(avgThis > hi + 1)){
    // C_stalled — escalating plateau tactic. Only deload changes the weight;
    // the rest keep weight and change the PLAN, so the engine stays stateless.
    out.rule='C_stalled';
    out.plateau.detected = true; out.plateau.sessionsStuck = sessionsAtWeight;
    out.suggested = baseline; // advisory tactics keep the weight (no Apply row);
                              // only deload_then_accumulate changes it, below.
    if(bw){
      out.plateau.tactic='rep_pr'; out.action='hold';
      out.plateau.detail = 'Add a pause or slower tempo rep this session.';
      out.reason = `Stuck ${sessionsAtWeight} sessions — ` + out.plateau.detail;
    } else if(sessionsAtWeight >= 6){
      out.plateau.tactic='deload_then_accumulate'; out.action='deload'; out.suggested=stepDown; out.confidence='low';
      out.plateau.detail = `Deload to ${stepDown}kg for one session, then accumulate: rebuild to ${baseline} adding reps before weight.`;
      out.reason = `Stuck ${sessionsAtWeight} sessions — ` + out.plateau.detail;
    } else if(sessionsAtWeight >= 5){
      out.plateau.tactic='backoff'; out.action='hold';
      out.plateau.detail = `Keep ${baseline}kg for your top set, then drop ~10% for 1-2 higher-rep back-off sets.`;
      out.reason = `Stuck ${sessionsAtWeight} sessions — ` + out.plateau.detail;
    } else if(sessionsAtWeight >= 4){
      out.plateau.tactic='microload'; out.action='hold';
      out.plateau.detail = `Add the smallest jump (to ${stepUp}kg) next session — micro-progress beats stalling.`;
      out.reason = `Stuck ${sessionsAtWeight} sessions — ` + out.plateau.detail;
    } else {
      out.plateau.tactic='rep_pr'; out.action='hold';
      out.plateau.detail = `Hold ${baseline}kg and beat your top-set rep count before adding load.`;
      out.reason = `Stuck ${sessionsAtWeight} sessions — ` + out.plateau.detail;
    }
    return out; // stall ignores RPE & periodization
  } else if(maxSet >= hi && minSet < lo){
    out.rule='D_mixed'; out.action='reps'; out.confidence='medium';
    out.reason = `Chase ${hi}+ on every set before adding weight.`;
  } else if(allBelowLo){
    out.rule='E_belowLo'; out.action='hold'; out.confidence='medium';
    out.reason = `Below the ${lo}-rep target — hold ${baseline}kg and focus on form.`;
  } else if(thisSession === null && plannedWeight > baseline){
    out.rule='F_alreadyBumped'; out.action='hold'; out.confidence='medium';
    out.reason = `You've moved up from ${baseline}kg — make every rep count.`;
  } else {
    out.rule='fallthrough'; out.action='hold'; out.confidence='medium';
    out.reason = `On track at ${baseline}kg — aim for the top of your rep range.`;
  }

  // 5. RPE layer (null-guarded; touches only A/B increases and fallthrough holds).
  if(rpe != null){
    if(out.action==='increase' && (out.rule==='A_topRange' || out.rule==='B_avgOverTop') && rpe >= 9.5){
      out.action='hold'; out.suggested=baseline;
      out.confidence = out.confidence==='high' ? 'medium' : 'low';
      out.reason = 'Reps hit but effort was near-maximal (RPE ~10) — bank this weight one more session.';
      out.rpeApplied = true;
    } else if(out.action==='hold' && out.rule==='fallthrough' && rpe <= 7 && avgThis >= lo && avgThis <= hi && stepUp > baseline){
      out.action='increase'; out.suggested=stepUp; out.confidence='medium';
      out.reason = 'Left 3+ reps in reserve — room to add a little.';
      out.rpeApplied = true;
    }
  }

  // 6. Periodization layer (null-guarded; never overrides a strong A_topRange or any deload).
  if(blockWeek != null){
    const lean = out.periodization.lean;
    if(lean==='accumulate' && out.action==='increase'){
      out.reason += ' (accumulation week — small jump)';
      out.periodization.applied = true;
    } else if(lean==='neutral' && out.action==='increase' && out.rule==='B_avgOverTop'){
      out.action='hold'; out.suggested=baseline;
      out.reason = 'Recovery week — hold and sharpen technique.';
      out.periodization.applied = true;
    }
  }

  // 7. Rusty gate (PRE only): 2–4 weeks since this exercise was last done
  // (4+ already gap-deloaded in rule G). An increase earned by a stale
  // session isn't earned anymore — rules A/B (all sets at top) and the
  // low-RPE upgrade would otherwise still say "add weight" after a 3-week
  // layoff. Downgrade to a hold at the last logged weight.
  if(thisSession === null && weeksAway != null && weeksAway >= 2 && out.action === 'increase'){
    out.action='hold'; out.suggested=baseline; out.confidence='medium';
    out.reason = `${Math.round(weeksAway)}w since last time — hold at ${baseline}kg first; add weight once you've re-grooved.`;
  }

  return out;
}

// ═══ Exercise rotation ═══
// Pure: which pool alternate (if any) a rotating slot resolves to on a cycle.
// Returns null → keep the original exercise. Cycle 0 (first ever run of the
// day) is always the programme as written.
function _rotatePick(slotName, cycle, pools){
  const pool = pools ? pools[slotName] : null;
  if(!Array.isArray(pool) || !pool.length) return null;
  const n = pool.length + 1; // +1: the original occupies rotation position 0
  const c = Math.floor(Number(cycle) || 0);
  const idx = ((c % n) + n) % n;
  return idx === 0 ? null : pool[idx - 1];
}

// ═══ Muscle balance and recency ═══
// Pure: recency curve. nowMs is optional (tests inject a fixed clock).
function getRecencyWeight(sessionDate, nowMs){
  const weeksAgo=((nowMs||Date.now())-new Date(sessionDate))/(7*24*60*60*1000);
  if(weeksAgo<=2) return 1.0;
  if(weeksAgo<=4) return 0.75;
  if(weeksAgo<=6) return 0.5;
  if(weeksAgo<=12) return 0.25;
  return 0;
}

// Pure: verdict on a push/pull/legs/core share (fractions of 1). Thresholds mirror the
// Progress tab's muscle-balance card: <10/>50 critical, <15/>40 imbalance, spread>=15 tip.
// Returns plain-text headline/detail (the renderer adds its own bold/emoji markup).
function _muscleBalanceVerdict(share, hasData){
  const META=[
    {key:'push',label:'Push',name:'Push (Chest/Shoulders/Tri)',exs:['bench press','shoulder press','dips']},
    {key:'pull',label:'Pull',name:'Pull (Back/Biceps)',exs:['rows','pull-ups','face pulls']},
    {key:'legs',label:'Legs',name:'Legs & Glutes',exs:['squats','deadlifts','lunges']},
    {key:'core',label:'Core',name:'Core',exs:['planks','leg raises','Russian twists']}
  ];
  const rows=META.map(m=>{
    const sh=(share&&typeof share[m.key]==='number'&&isFinite(share[m.key]))?share[m.key]:0;
    return {key:m.key,label:m.label,name:m.name,exs:m.exs,share:sh,pct:Math.round(sh*100)};
  });
  const pct={},flags={};
  rows.forEach(r=>{pct[r.key]=r.pct;flags[r.key]=(r.pct<10||r.pct>50)?'red':((r.pct<15||r.pct>40)?'amber':'ok');});
  if(!hasData) return {status:'nodata',level:null,pct:pct,flags:flags,low:null,high:null,headline:'No data',detail:'No sessions in the window yet.'};
  const sorted=rows.slice().sort((a,b)=>a.share-b.share);
  const lo=sorted[0],hi=sorted[sorted.length-1];
  const loPct=lo.pct,hiPct=hi.pct;
  const low={key:lo.key,label:lo.label,name:lo.name,pct:loPct,exs:lo.exs};
  const high={key:hi.key,label:hi.label,name:hi.name,pct:hiPct,exs:hi.exs};
  let status,level,headline,detail;
  if(loPct<10){status='critical-low';level=3;headline='Critical imbalance';detail=lo.name+' is critically low at '+loPct+'%. Add '+lo.exs.join(', ')+' to every session this week.';}
  else if(hiPct>50){status='critical-high';level=3;headline='Critical imbalance';detail=hi.name+' dominates at '+hiPct+'%. Reduce its volume or add '+lo.exs.join(', ')+' to close the gap.';}
  else if(loPct<15||hiPct>40){status='imbalanced';level=2;headline='Imbalance detected';detail=lo.name+' is at '+loPct+'% — try '+lo.exs.join(', ')+' this week to balance with '+hi.name+' ('+hiPct+'%).';}
  else if(hiPct-loPct>=15){status='tip';level=1;headline='Tip';detail='Consider '+lo.exs.join(' or ')+' to bring '+lo.name+' ('+loPct+'%) closer to '+hi.name+' ('+hiPct+'%).';}
  else{status='balanced';level=0;headline='Well balanced';detail='Well balanced — keep it up!';}
  return {status:status,level:level,pct:pct,flags:flags,low:low,high:high,headline:headline,detail:detail};
}

// ═══ Body measurements ═══
// Pure: latest value + change since the first entry for a given field (cm).
function _measureDelta(log, field){
  const vals = (log || [])
    .filter(e => e && typeof e[field] === 'number' && isFinite(e[field]) && e[field] > 0)
    .sort((a,b) => String(a.date||'').localeCompare(String(b.date||'')));
  if(!vals.length) return null;
  const first = vals[0][field], latest = vals[vals.length-1][field];
  return { latest, first, change: Math.round((latest - first) * 10) / 10, count: vals.length };
}

// ═══ Next path day ═══
// Pure: rank a programme's days for "what should I do next?".
// cands: [{day, sinceDone (sessions since last done; 999=never), order, groups[]}]
// recent: [{groups[], daysAgo}] — the user's last couple of real sessions.
// Score = staleness − muscle-conflict penalty (a group trained <1.5 days ago
// is heavily demoted, <2.5 days mildly) − tiny written-order tiebreak.
function _rankNextPathDays(cands, recent){
  if(!Array.isArray(cands) || !cands.length) return [];
  const R = Array.isArray(recent) ? recent : [];
  // r.groups may be an array (equal weight) or {cat: share} where share is
  // that group's fraction of the session's volume. A MAJOR group (share
  // ≥0.35) trained <1.5 days ago hard-gates the day below every clean day —
  // staleness can never outrank fried muscles. Minor overlaps (a deadlift's
  // pull component on a leg day) only nudge.
  const shareOf = (r, g) => Array.isArray(r.groups)
    ? (r.groups.indexOf(g) >= 0 ? 1 : 0)
    : ((r.groups && typeof r.groups[g] === 'number') ? r.groups[g] : 0);
  return cands.map(c => {
    let score = Math.min(c.sinceDone == null ? 999 : c.sinceDone, 10) * 10;
    const reasons = [];
    if((c.sinceDone == null ? 999 : c.sinceDone) >= 999) reasons.push('not done yet');
    else if(c.sinceDone >= 3) reasons.push(c.sinceDone + ' sessions since last time');
    let hard = false;
    R.forEach(r => {
      const warned = [];
      (c.groups || []).forEach(g => {
        const s = shareOf(r, g);
        if(s <= 0) return;
        if(r.daysAgo < 1.5){
          if(s >= 0.35){ hard = true; warned.push(g); }
          score -= 60 * s;
        } else if(r.daysAgo < 2.5){
          score -= 20 * s;
        }
      });
      if(warned.length) reasons.push('⚠ ' + warned.join('/') + ' trained hard yesterday');
    });
    if(hard) score -= 1000; // conflicted tier: below every clean day
    score -= (c.order || 0) * 0.01;
    return { day: c.day, score, reasons };
  }).sort((a, b) => b.score - a.score);
}
