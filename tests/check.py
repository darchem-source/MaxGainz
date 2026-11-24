#!/usr/bin/env python3
"""
Max Gainz check harness — runs with the system Python + JavaScriptCore (osascript),
no Node required. Two gates:

  1) PARSE   — the full inline <script> must parse (catches the syntax-error class,
               e.g. the template-string bug that silently broke the whole app).
  2) INVARIANTS — pure XP / rank / week-key functions are extracted from index.html
               and asserted against fixed expectations. These encode the bug classes
               we've already had to fix, so they can't silently regress:
                 - rank ladder monotonic, 0-based, Infinity-capped, tiered
                 - getRank boundary behaviour
                 - _sessionXP matches the documented bonus formula (must equal
                   calcSessionReward) — the "XP under-count on recompute" bug
                 - _weekKey / getMaxWeeklySessions use LOCAL dates (not UTC) — the
                   "week-key timezone drift" bug
                 - getPrestigeStars maths

Run:  python3 tests/check.py        (exit 0 = all pass, 1 = any failure)
"""
import os, re, sys, json, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')

def read_index():
    with open(INDEX, encoding='utf-8') as f:
        return f.read()

def inline_script(html):
    # The app has a single inline (non-src) <script>. Concatenate any matches.
    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html)
    return '\n'.join(scripts)

def run_jxa(js):
    """Evaluate JS via JavaScriptCore (JXA). Returns (stdout, returncode)."""
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as t:
        t.write(js); path = t.name
    try:
        p = subprocess.run(['osascript', '-l', 'JavaScript', path],
                           capture_output=True, text=True, timeout=120)
        return (p.stdout.strip() or p.stderr.strip()), p.returncode
    finally:
        os.unlink(path)

def extract_decl(js, name):
    """Extract `function NAME(...){...}` by brace-matching. Returns source or None."""
    m = re.search(r'function\s+' + re.escape(name) + r'\s*\(', js)
    if not m:
        return None
    i = js.index('{', m.start())
    depth = 0
    for j in range(i, len(js)):
        c = js[j]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return js[m.start():j+1]
    return None

def extract_const_array(js, name):
    """Extract `const NAME=[ ... ];` by bracket-matching."""
    m = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*\[', js)
    if not m:
        return None
    i = js.index('[', m.start())
    depth = 0
    for j in range(i, len(js)):
        c = js[j]
        if c == '[': depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                end = js.find(';', j)
                return js[m.start():(end+1 if end != -1 else j+1)]
    return None

def extract_const_line(js, name):
    m = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*[^;\n]+;', js)
    return m.group(0) if m else None

# ── Gate 1: parse ──────────────────────────────────────────────────────────
def gate_parse(js):
    # new Function(src) parses without executing — catches syntax errors anywhere.
    probe = (
        "ObjC.import('Foundation');\n"
        "var path=%s;\n"
        "var src=$.NSString.stringWithContentsOfFileEncodingError(path,$.NSUTF8StringEncoding,null).js;\n"
        "try{ new Function(src); 'PARSE_OK'; }catch(e){ 'PARSE_ERROR: '+e.message; }"
    )
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as t:
        t.write(js); jspath = t.name
    try:
        out, _ = run_jxa(probe % json.dumps(jspath))
    finally:
        os.unlink(jspath)
    ok = out.strip() == 'PARSE_OK'
    print(('  ✓' if ok else '  ✗') + ' inline script parses' + ('' if ok else '  — ' + out))
    return ok

# ── Gate 2: invariants ─────────────────────────────────────────────────────
ASSERTIONS = r"""
var fails = [];
function eq(label, got, want){ if(JSON.stringify(got)!==JSON.stringify(want)) fails.push(label+' — got '+JSON.stringify(got)+', want '+JSON.stringify(want)); }
function ok(label, cond){ if(!cond) fails.push(label); }

// ── RANKS ladder ──
ok('RANKS is array of 16', Array.isArray(RANKS) && RANKS.length===16);
eq('first rank min is 0', RANKS[0].min, 0);
eq('top rank max is Infinity', RANKS[RANKS.length-1].max===Infinity, true);
var mono=true; for(var i=1;i<RANKS.length;i++){ if(RANKS[i].min<=RANKS[i-1].min) mono=false; }
ok('rank mins strictly increasing', mono);
var tiered=true; for(var i=0;i<RANKS.length;i++){ if(!RANKS[i].tier) tiered=false; }
ok('every rank has a tier', tiered);

// ── getRank boundaries ──
eq('getRank(-1) = first', getRank(-1).name, RANKS[0].name);
eq('getRank(0) = first', getRank(0).name, RANKS[0].name);
eq('getRank at a threshold is inclusive', getRank(RANKS[8].min).name, RANKS[8].name);
eq('getRank just below threshold = prev', getRank(RANKS[8].min-1).name, RANKS[7].name);
eq('getRank(huge) = top', getRank(99999999).name, RANKS[RANKS.length-1].name);

// ── _sessionXP must equal the documented bonus formula (== calcSessionReward) ──
function mk(vol, sets, dur){ var sl={}; if(sets>0) sl['x']={sets:sets}; return {volume:vol, durationMin:dur, setLog:sl}; }
eq('base session = 100',                 _sessionXP(mk(0,0,0)), 100);
eq('vol>=5000 = +50',                    _sessionXP(mk(5000,0,0)), 150);
eq('vol>=10000 = +100 (both tiers)',     _sessionXP(mk(10000,0,0)), 200);
eq('20+ sets = +25',                     _sessionXP(mk(0,20,0)), 125);
eq('19 sets = no bonus',                 _sessionXP(mk(0,19,0)), 100);
eq('60min = +30',                        _sessionXP(mk(0,0,60)), 130);
eq('59min = no bonus',                   _sessionXP(mk(0,0,59)), 100);
eq('all bonuses stack = 255',            _sessionXP(mk(10000,20,60)), 255);

// ── _weekKey / getMaxWeeklySessions are LOCAL (no UTC drift) ──
// A local Monday must key to that same calendar Monday regardless of TZ.
var monday = new Date(2026, 0, 5, 0, 30, 0); // Mon 5 Jan 2026, 00:30 local
eq('_weekKey of a local Monday is that Monday', _weekKey(monday), '2026-01-05');
var sunday = new Date(2026, 0, 11, 23, 0, 0); // Sun 11 Jan 2026 (same Mon-Sun week)
eq('_weekKey groups Sun into the same week', _weekKey(sunday), '2026-01-05');
// 3 sessions in one local week count together (the weekly-challenge / week_3 path)
var wk = [ {date:new Date(2026,0,5,7,0)}, {date:new Date(2026,0,7,7,0)}, {date:new Date(2026,0,9,7,0)} ];
eq('getMaxWeeklySessions counts a 3-session local week', getMaxWeeklySessions(wk), 3);

// ── prestige stars ──
var topMin = RANKS[RANKS.length-1].min;
eq('no stars below top', getPrestigeStars(topMin-1), 0);
eq('0 stars at exactly top', getPrestigeStars(topMin), 0);
eq('1 star at +25000', getPrestigeStars(topMin+25000), 1);
eq('2 stars at +55000', getPrestigeStars(topMin+55000), 2);

// ── conflict-safe sync (the data-loss-prevention core) ──
var cloud = [
  {cloud_id:'c1', date:'2026-01-05T07:00:00.000Z', day:'Upper', volume:5000},
  {cloud_id:'c2', date:'2026-01-07T07:00:00.000Z', day:'Lower', volume:6000}
];
// (a) empty local + cloud → cloud as-is, nothing flagged for upload
var m1 = _mergeSessions([], cloud);
eq('merge([],cloud) length', m1.length, 2);
ok('merge([],cloud) flags nothing', m1.every(function(s){return !s._needsUpload;}));
// (b) a local-only (offline) session is preserved AND flagged for re-upload
var localOnly = {date:'2026-01-09T07:00:00.000Z', day:'Full Body', volume:7000};
var m2 = _mergeSessions([localOnly], cloud);
eq('merge keeps offline session', m2.length, 3);
ok('offline session flagged for upload', m2.filter(function(s){return s.day==='Full Body';})[0]._needsUpload===true);
// (c) a local copy of a session already in cloud does NOT duplicate; cloud wins
var dupOfCloud = {date:'2026-01-05T07:00:00.000Z', day:'Upper', volume:5000};
var m3 = _mergeSessions([dupOfCloud], cloud);
eq('matched session not duplicated', m3.length, 2);
ok('cloud copy wins (has cloud_id)', m3.filter(function(s){return s.day==='Upper';})[0].cloud_id==='c1');
// (d) result is date-sorted ascending
var sorted = m2.map(function(s){return +new Date(s.date);});
ok('merge result date-sorted', sorted[0]<=sorted[1] && sorted[1]<=sorted[2]);

// ── _sessionKey ──
ok('distinct dates → distinct keys', _sessionKey({date:'2026-01-05T07:00:00Z',day:'A'}) !== _sessionKey({date:'2026-01-06T07:00:00Z',day:'A'}));
eq('same date+day → same key',
   _sessionKey({date:'2026-01-05T07:00:00.123Z',day:'A'}),
   _sessionKey({date:'2026-01-05T07:00:00.999Z',day:'A'}));

// ── _validateSession ──
eq('invalid date → null', _validateSession({date:'not-a-date',day:'X'}), null);
eq('non-object → null', _validateSession(null), null);
var v = _validateSession({date:'2026-01-05T07:00:00Z', day:'', volume:-50, durationMin:'oops', exercises:3});
ok('valid session sanitized: negative volume → 0', v.volume===0);
ok('valid session sanitized: bad duration → 0', v.durationMin===0);
ok('valid session: empty day → fallback', v.day==='Workout');
ok('valid session: exercises preserved', v.exercises===3);
var vc = _validateSession({date:'2026-01-05T07:00:00Z', day:'Upper', cloud_id:'c9', _needsUpload:true});
ok('_validateSession preserves cloud_id', vc.cloud_id==='c9');
ok('_validateSession preserves _needsUpload', vc._needsUpload===true);

// ── adaptive coaching engine (getLiftState) — the unified decision authority ──
var STEPS=[60,62.5,65,67.5,70,72.5,75,77.5,80,82.5,85,87.5,90,92.5,95,97.5,100];
var NOW = Date.UTC(2026,0,15,12,0,0);
function days(n){ return NOW - n*86400000; }
function base(extra){
  return Object.assign({ plannedWeight:80, repRange:'5–8', bw:false, timed:false,
    steps:STEPS, nowMs:NOW, history:[], thisSession:null }, extra||{});
}
var STEP_UP = stepWeight(80,1,STEPS), STEP_DN = stepWeight(80,-1,STEPS);

// RULE A: all sets >= hi → increase to stepUp; confidence high when 2+ sessions at weight
var hA = [{date:days(10),weight:80,reps:[8,8,8]},{date:days(3),weight:80,reps:[8,8,8]}];
var inA = base({history:hA, thisSession:{reps:[8,8,8]}});
var rA = getLiftState(inA);
eq('A action increase', rA.action, 'increase');
eq('A suggested = stepUp', rA.suggested, STEP_UP);
eq('A confidence high (2 sessions at weight)', rA.confidence, 'high');
eq('A confidence medium (1 session)', getLiftState(base({history:[{date:days(3),weight:80,reps:[8,8,8]}], thisSession:{reps:[8,8,8]}})).confidence, 'medium');

// RULE B float boundary (RAW avg, strict >hi+1): >hi+1 → increase; ==hi+1 → not
eq('B avg>hi+1 → increase', getLiftState(base({repRange:'6–8', history:[{date:days(3),weight:80,reps:[7]}], thisSession:{reps:[12,12,7]}})).action, 'increase');
ok('B avg ==hi+1 → not increase', getLiftState(base({repRange:'6–8', history:[{date:days(3),weight:80,reps:[7]}], thisSession:{reps:[10,10,7]}})).action !== 'increase');

// RULE C / plateau: 3 trailing at W & reps not topping → detected + rep_pr hold; 2 → not
function stuck(n){ var a=[]; for(var i=n;i>0;i--) a.push({date:days(i*4),weight:80,reps:[6,6,6]}); return a; }
var rC = getLiftState(base({history:stuck(3), thisSession:{reps:[6,6,6]}}));
ok('C plateau detected at 3', rC.plateau.detected===true && rC.plateau.sessionsStuck===3);
eq('C tactic rep_pr', rC.plateau.tactic, 'rep_pr');
eq('C action hold', rC.action, 'hold');
ok('C NOT detected at 2', getLiftState(base({history:stuck(2), thisSession:{reps:[6,6,6]}})).plateau.detected===false);
// plateau escalation
var rE4 = getLiftState(base({history:stuck(4), thisSession:{reps:[6,6,6]}}));
eq('plateau 4 → microload', rE4.plateau.tactic, 'microload');
eq('microload keeps weight (advisory, no Apply)', rE4.suggested, 80);
eq('rep_pr keeps weight (advisory)', getLiftState(base({history:stuck(3), thisSession:{reps:[6,6,6]}})).suggested, 80);
var rE6 = getLiftState(base({history:stuck(6), thisSession:{reps:[6,6,6]}}));
eq('plateau 6 → deload_then_accumulate', rE6.plateau.tactic, 'deload_then_accumulate');
eq('plateau 6 action deload', rE6.action, 'deload');
eq('plateau 6 suggested = stepDown', rE6.suggested, STEP_DN);

// RULE D agreement: mixed reps → 'reps' in BOTH pre and post (when H doesn't
// intercept). reps [9,8,4] avg=7 rounds to the 5–8 target (7), so the pre-mode
// rep-shift rule is correctly skipped and D fires in both modes.
var mixedHist = [{date:days(3),weight:80,reps:[9,8,4]}];
eq('D post → reps', getLiftState(base({history:mixedHist, thisSession:{reps:[9,8,4]}})).action, 'reps');
eq('D pre  → reps', getLiftState(base({history:mixedHist, thisSession:null})).action, 'reps');

// RULE G gap-deload: 5 weeks → deload snapped 15%; bw → hold
var rG = getLiftState(base({history:[{date:days(35),weight:80,reps:[8,8,8]}], thisSession:null}));
eq('G action deload', rG.action, 'deload');
eq('G suggested snapped 15%', rG.suggested, snapToSteps(80*0.85,STEPS));
eq('G bw → hold (no weight change)', getLiftState(base({bw:true, plannedWeight:0, history:[{date:days(35),weight:0,reps:[10]}], thisSession:null})).action, 'hold');
ok('G does NOT fire in post mode (gap already over)', getLiftState(base({history:[{date:days(35),weight:80,reps:[8,8,8]}], thisSession:{reps:[8,8,8]}})).rule !== 'G_gapDeload');

// RULE H rep-shift (pre only): prior avg 5 at 100, today 8-12 → lower weight, hold
var rH = getLiftState(base({plannedWeight:100, repRange:'8–12', history:[{date:days(3),weight:100,reps:[5,5,5]}], thisSession:null}));
eq('H action hold', rH.action, 'hold');
ok('H suggested < 100', rH.suggested < 100);
eq('H suggested = snapped Epley', rH.suggested, snapToSteps(calc1RM(100,5)/(1+10/30),STEPS));
ok('H does NOT fire in post mode', getLiftState(base({plannedWeight:100, repRange:'8–12', history:[{date:days(3),weight:100,reps:[5,5,5]}], thisSession:{reps:[10,10]}})).rule !== 'H_repShift');

// RPE no-op (absence changes nothing) + influence
ok('RPE null deep-equals omitted', JSON.stringify(getLiftState(Object.assign({},inA,{rpeThisSession:null}))) === JSON.stringify(getLiftState(inA)));
ok('RPE null → rpeApplied false', getLiftState(Object.assign({},inA,{rpeThisSession:null})).rpeApplied===false);
var rR10 = getLiftState(Object.assign({},inA,{rpeThisSession:10}));
eq('RPE 10 downgrades increase→hold', rR10.action, 'hold');
ok('RPE 10 → rpeApplied true', rR10.rpeApplied===true);
eq('RPE 6 keeps increase', getLiftState(Object.assign({},inA,{rpeThisSession:6})).action, 'increase');
var inF = base({history:[{date:days(3),weight:80,reps:[6,6,6]}], thisSession:{reps:[6,6,6]}});
eq('fallthrough is hold', getLiftState(inF).action, 'hold');
eq('fallthrough + low RPE → increase', getLiftState(Object.assign({},inF,{rpeThisSession:7})).action, 'increase');

// Periodization no-op + wk4 behaviour
ok('periodization null deep-equals omitted', JSON.stringify(getLiftState(Object.assign({},inA,{blockWeek:null}))) === JSON.stringify(getLiftState(inA)));
ok('periodization null → applied false', getLiftState(Object.assign({},inA,{blockWeek:null})).periodization.applied===false);
var inB = base({repRange:'6–8', history:[{date:days(3),weight:80,reps:[7]}], thisSession:{reps:[12,12,7]}});
eq('wk4 downgrades B increase → hold', getLiftState(Object.assign({},inB,{blockWeek:4})).action, 'hold');
eq('wk4 keeps A increase (strong signal passes)', getLiftState(Object.assign({},inA,{blockWeek:4})).action, 'increase');

// ── comeback bonus (deterministic, capped, not farmable) ──
var DAY=86400000, T0=Date.UTC(2026,0,1);
function gd(n){ return {date:new Date(T0+n*DAY)}; }   // gym session on day n
function gact(n){ return {date:new Date(T0+n*DAY), manualActivity:true}; }
eq('no sessions → no comeback', _comebackEvents([]).length, 0);
eq('one session → no comeback', _comebackEvents([gd(0)]).length, 0);
eq('13-day gap → no comeback', _comebackEvents([gd(0),gd(13)]).length, 0);
eq('14-day gap → one comeback', _comebackEvents([gd(0),gd(14)]).length, 1);
eq('comeback bonus is +100', _comebackEvents([gd(0),gd(14)])[0].pts, 100);
eq('comeback dated to the RETURN session', +_comebackEvents([gd(0),gd(20)])[0].date, T0+20*DAY);
eq('two long gaps → two comebacks', _comebackEvents([gd(0),gd(20),gd(40)]).length, 2);
eq('manual activities ignored', _comebackEvents([gd(0),gact(5),gd(8)]).length, 0);
eq('comeback type tagged', _comebackEvents([gd(0),gd(30)])[0].type, 'comeback');

// Output shape + determinism/purity
var KEYS=['action','suggested','current','confidence','reason','rule','diag','plateau','rpeApplied','periodization'];
ok('output has full key set', KEYS.every(function(k){ return (k in rA); }));
var frozen = Object.freeze(base({history:hA, thisSession:Object.freeze({reps:[8,8,8]})}));
eq('deterministic (frozen input)', JSON.stringify(getLiftState(frozen)), JSON.stringify(getLiftState(frozen)));

// ── body measurements: _measureDelta(log, field) ──
eq('measure: no entries → null', _measureDelta([], 'chest'), null);
eq('measure: field absent → null', _measureDelta([{date:'2026-01-01', waist:80}], 'chest'), null);
eq('measure: single entry latest', _measureDelta([{date:'2026-01-01', chest:100}], 'chest').latest, 100);
eq('measure: single entry change 0', _measureDelta([{date:'2026-01-01', chest:100}], 'chest').change, 0);
eq('measure: single entry count 1', _measureDelta([{date:'2026-01-01', chest:100}], 'chest').count, 1);
eq('measure: change = latest - first', _measureDelta([{date:'2026-01-01', chest:100},{date:'2026-02-01', chest:104}], 'chest').change, 4);
eq('measure: negative change', _measureDelta([{date:'2026-01-01', waist:90},{date:'2026-02-01', waist:85}], 'waist').change, -5);
eq('measure: sorted by date not array order', _measureDelta([{date:'2026-03-01', chest:106},{date:'2026-01-01', chest:100}], 'chest').change, 6);
eq('measure: latest is most recent date', _measureDelta([{date:'2026-03-01', chest:106},{date:'2026-01-01', chest:100}], 'chest').latest, 106);
eq('measure: ignores non-numeric values', _measureDelta([{date:'2026-01-01', chest:'x'},{date:'2026-02-01', chest:102}], 'chest').count, 1);
eq('measure: ignores zero/negative values', _measureDelta([{date:'2026-01-01', chest:0},{date:'2026-02-01', chest:102}], 'chest').count, 1);
eq('measure: change rounds to 0.1', _measureDelta([{date:'2026-01-01', chest:100.04},{date:'2026-02-01', chest:101.07}], 'chest').change, 1);
ok('measure: tolerates null/undefined entries', _measureDelta([null, undefined, {date:'2026-01-01', chest:100}], 'chest').count===1);

// ── exercise demo clips: _exVideoEntry / _exVideoPickSex ──
var VMAP = {'Bench Press':'barbell-bench-press', 'Plank':'front-plank|f', 'Dips':'dips|m'};
eq('video: exact hit', _exVideoEntry('Bench Press', VMAP).slug, 'barbell-bench-press');
eq('video: exact hit g=mf', _exVideoEntry('Bench Press', VMAP).g, 'mf');
eq('video: case-insensitive hit', _exVideoEntry('bench press', VMAP).slug, 'barbell-bench-press');
eq('video: miss → null', _exVideoEntry('Nonexistent', VMAP), null);
eq('video: empty name → null', _exVideoEntry('', VMAP), null);
eq('video: null map → null', _exVideoEntry('Bench Press', null), null);
eq('video: female-only parse', _exVideoEntry('Plank', VMAP).g, 'f');
eq('video: male-only parse', _exVideoEntry('Dips', VMAP).g, 'm');
eq('video: female-only slug strips |f suffix', _exVideoEntry('Plank', VMAP).slug, 'front-plank');
eq('video: male-only slug strips |m suffix', _exVideoEntry('Dips', VMAP).slug, 'dips');
eq('video: pick mf+male', _exVideoPickSex('mf','male'), 'male');
eq('video: pick mf+female', _exVideoPickSex('mf','female'), 'female');
eq('video: pick m-only ignores female pref', _exVideoPickSex('m','female'), 'male');
eq('video: pick f-only ignores male pref', _exVideoPickSex('f','male'), 'female');
eq('video: pick invalid g → null', _exVideoPickSex('','male'), null);
eq('video: pick mf+garbage pref → male', _exVideoPickSex('mf', undefined), 'male');

// ── exercise rotation: _rotatePick(slot, cycle, pools) ──
var RPOOLS = {'Leg Curls': [{name:'A',reps:'10–15',weight:0,bw:true},{name:'B',reps:'8–12',weight:20}]};
eq('rotate: unknown slot → null', _rotatePick('Squat', 3, RPOOLS), null);
eq('rotate: cycle 0 → original (null)', _rotatePick('Leg Curls', 0, RPOOLS), null);
eq('rotate: cycle 1 → first alt', _rotatePick('Leg Curls', 1, RPOOLS).name, 'A');
eq('rotate: cycle 2 → second alt', _rotatePick('Leg Curls', 2, RPOOLS).name, 'B');
eq('rotate: cycle 3 wraps to original', _rotatePick('Leg Curls', 3, RPOOLS), null);
eq('rotate: cycle 4 wraps to first alt', _rotatePick('Leg Curls', 4, RPOOLS).name, 'A');
eq('rotate: negative cycle safe', _rotatePick('Leg Curls', -1, RPOOLS) === null || typeof _rotatePick('Leg Curls', -1, RPOOLS) === 'object', true);
eq('rotate: null pools → null', _rotatePick('Leg Curls', 1, null), null);
eq('rotate: empty pool → null', _rotatePick('X', 1, {X: []}), null);
eq('rotate: garbage cycle → original', _rotatePick('Leg Curls', undefined, RPOOLS), null);

// ── cooldown: _buildCooldown(groups, seed, lib, count) ──
var CLIB = [
  {name:'P1',slug:'p1',groups:['push']},{name:'P2',slug:'p2',groups:['push']},
  {name:'L1',slug:'l1',groups:['legs']},{name:'L2',slug:'l2',groups:['legs']},
  {name:'C1',slug:'c1',groups:['core']},{name:'B1',slug:'b1',groups:['pull']},
  {name:'X1',slug:'x1',groups:['core','legs']},
];
eq('cooldown: returns requested count', _buildCooldown(['push','legs'], 0, CLIB, 4).length, 4);
ok('cooldown: unique picks', (function(){ var r=_buildCooldown(['push','legs'],0,CLIB,4), s=new Set(r.map(x=>x.slug)); return s.size===r.length; })());
ok('cooldown: covers requested groups', (function(){ var r=_buildCooldown(['push','legs'],0,CLIB,4); return r.some(x=>x.groups.includes('push')) && r.some(x=>x.groups.includes('legs')); })());
eq('cooldown: deterministic (same seed)', JSON.stringify(_buildCooldown(['push','legs'],3,CLIB,4)), JSON.stringify(_buildCooldown(['push','legs'],3,CLIB,4)));
eq('cooldown: empty groups → all-group fallback still fills', _buildCooldown([], 0, CLIB, 4).length, 4);
eq('cooldown: unknown groups filtered → fallback', _buildCooldown(['cardio'], 0, CLIB, 3).length, 3);
ok('cooldown: lib smaller than count → all unique, no hang', (function(){ var r=_buildCooldown(['push'],0,CLIB,10); var s=new Set(r.map(x=>x.slug)); return r.length<=CLIB.length && s.size===r.length; })());
eq('cooldown: empty lib → empty', _buildCooldown(['push'], 0, [], 6).length, 0);
ok('cooldown: seed rotates start', (function(){ var a=_buildCooldown(['push'],0,CLIB,1)[0].slug, b=_buildCooldown(['push'],1,CLIB,1)[0].slug; return a!==b; })());

// ── smart next-path-day ranking ──
// The real-world PHUL case: Tue Upper Hyp, Wed Lower Power → Thu must NOT be
// another leg day; stale Upper Power should win.
var PHUL_CANDS = [
  {day:'Upper Power', sinceDone:5, order:0, groups:['push','pull']},
  {day:'Lower Power', sinceDone:0, order:1, groups:['legs','core']},
  {day:'Upper Hypertrophy', sinceDone:1, order:2, groups:['push','pull']},
  {day:'Lower Hypertrophy', sinceDone:4, order:3, groups:['legs','core']},
];
var PHUL_RECENT = [ {groups:{push:0.5,pull:0.5}, daysAgo:2}, {groups:{legs:0.7,core:0.15,pull:0.15}, daysAgo:1} ];
eq('smart: PHUL two-leg-days avoided → Upper Power next', _rankNextPathDays(PHUL_CANDS, PHUL_RECENT)[0].day, 'Upper Power');
// The reported live bug: a 17-sessions-overdue leg day must STILL lose to a
// recently-done upper day when legs were the bulk of yesterday's session.
var LIVE_CANDS = [
  {day:'Upper Power', sinceDone:2, order:0, groups:['push','pull']},
  {day:'Lower Power', sinceDone:0, order:1, groups:['legs','core']},
  {day:'Upper Hypertrophy', sinceDone:1, order:2, groups:['push','pull']},
  {day:'Lower Hypertrophy', sinceDone:17, order:3, groups:['legs','core']},
];
var LIVE_RECENT = [ {groups:{push:0.5,pull:0.5}, daysAgo:2}, {groups:{legs:0.7,core:0.15,pull:0.15}, daysAgo:1} ];
eq('smart: 17-overdue leg day never beats clean upper day', _rankNextPathDays(LIVE_CANDS, LIVE_RECENT)[0].day, 'Upper Power');
ok('smart: overdue leg day ranks below BOTH upper days', (function(){
  var r=_rankNextPathDays(LIVE_CANDS, LIVE_RECENT).map(x=>x.day);
  return r.indexOf('Lower Hypertrophy') > r.indexOf('Upper Hypertrophy') && r.indexOf('Lower Hypertrophy') > r.indexOf('Upper Power'); })());
ok('smart: minor pull overlap does not hard-gate upper days', (function(){
  var top=_rankNextPathDays(LIVE_CANDS, LIVE_RECENT)[0]; return top.score > -500; })());
ok('smart: fresh leg day demoted below both upper days', (function(){
  var r=_rankNextPathDays(PHUL_CANDS, PHUL_RECENT).map(x=>x.day);
  return r.indexOf('Lower Hypertrophy') > r.indexOf('Upper Hypertrophy'); })());
eq('smart: never-done day wins outright', _rankNextPathDays([
  {day:'A', sinceDone:2, order:0, groups:['push']},
  {day:'B', sinceDone:999, order:1, groups:['pull']}], [])[0].day, 'B');
eq('smart: written order breaks ties', _rankNextPathDays([
  {day:'A', sinceDone:3, order:0, groups:['push']},
  {day:'B', sinceDone:3, order:1, groups:['pull']}], [])[0].day, 'A');
eq('smart: empty candidates → empty', _rankNextPathDays([], []).length, 0);
eq('smart: no recent history → pure staleness', _rankNextPathDays(PHUL_CANDS, [])[0].day, 'Upper Power');
ok('smart: conflict reason surfaces', _rankNextPathDays(PHUL_CANDS, PHUL_RECENT).find(x=>x.day==='Lower Hypertrophy').reasons.join(' ').indexOf('trained hard yesterday') >= 0);

// ── Muscle balance (shared by Progress tab + dashboard summary) ──
// Stubs for the exercise→group mapping the helper consults (real getSplits needs EXDB).
var EXDB = [{name:'Push-Ups', bw:true}];
function getSplits(n){
  if(n==='Bench Press'||n==='Push-Ups') return [{cat:'push',f:1}];
  if(n==='Barbell Row') return [{cat:'pull',f:1}];
  if(n==='Squat') return [{cat:'legs',f:1}];
  if(n==='Plank'||n==='Abdominal Work') return [{cat:'core',f:1}];
  if(n==='Deadlift') return [{cat:'pull',f:0.6},{cat:'legs',f:0.4}];
  return null;
}
var MB_NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
var DAY = 86400000;
function mbSess(daysAgo, setLog, extra){ var o = {date:new Date(MB_NOW - daysAgo*DAY), setLog:setLog}; if(extra) for(var k in extra) o[k]=extra[k]; return o; }
eq('recency: this week = 1', getRecencyWeight(new Date(MB_NOW - 3*DAY), MB_NOW), 1);
eq('recency: 3 weeks = 0.75', getRecencyWeight(new Date(MB_NOW - 21*DAY), MB_NOW), 0.75);
eq('recency: 5 weeks = 0.5', getRecencyWeight(new Date(MB_NOW - 35*DAY), MB_NOW), 0.5);
eq('recency: 10 weeks = 0.25', getRecencyWeight(new Date(MB_NOW - 70*DAY), MB_NOW), 0.25);
eq('recency: 13 weeks = 0', getRecencyWeight(new Date(MB_NOW - 91*DAY), MB_NOW), 0);
eq('share: no sessions → hasData false', _calcMuscleGroupShare([], {windowWeeks:6, nowMs:MB_NOW}).hasData, false);
var MB_ONE = _calcMuscleGroupShare([mbSess(1, {'Bench Press':{sets:3, reps:[10,10,10], weight:60}})], {windowWeeks:6, nowMs:MB_NOW});
ok('share: single push session is ~100% push', MB_ONE.hasData && MB_ONE.share.push > 0.99 && MB_ONE.share.pull === 0);
eq('share: volume = weight×reps', Math.round(MB_ONE.vol.push), 1800);
var MB_EQ = _calcMuscleGroupShare([
  mbSess(1, {'Bench Press':{sets:3, reps:[10,10,10], weight:60}}),
  mbSess(2, {'Barbell Row':{sets:3, reps:[10,10,10], weight:60}}),
  mbSess(3, {'Squat':{sets:3, reps:[10,10,10], weight:60}}),
  mbSess(4, {'Plank':{sets:3, reps:[10,10,10], weight:60}})], {windowWeeks:6, nowMs:MB_NOW});
eq('share: four equal sessions → 25% each', [MB_EQ.share.push, MB_EQ.share.pull, MB_EQ.share.legs, MB_EQ.share.core].map(function(x){return Math.round(x*100);}), [25,25,25,25]);
ok('share: 13-week-old session is ignored', !_calcMuscleGroupShare([mbSess(91, {'Bench Press':{sets:3, reps:[10], weight:60}})], {windowWeeks:6, nowMs:MB_NOW}).hasData);
ok('share: 3-week-old session counts at 0.75', Math.abs(_calcMuscleGroupShare([mbSess(21, {'Bench Press':{sets:1, reps:[10], weight:100}})], {windowWeeks:6, nowMs:MB_NOW}).vol.push - 750) < 1e-6);
ok('share: manual activities are excluded', !_calcMuscleGroupShare([mbSess(1, {'Bench Press':{sets:3, reps:[10], weight:60}}, {manualActivity:true})], {windowWeeks:6, nowMs:MB_NOW}).hasData);
ok('share: bodyweight flag uses opts.bodyweight', Math.abs(_calcMuscleGroupShare([mbSess(1, {'Push-Ups':{sets:2, reps:[10,10], weight:0, bw:true}})], {windowWeeks:6, nowMs:MB_NOW, bodyweight:90}).vol.push - 1800) < 1e-6);
ok('share: Abdominal Work with no reps still yields core volume', _calcMuscleGroupShare([mbSess(1, {'Abdominal Work':{sets:3, weight:0}})], {windowWeeks:6, nowMs:MB_NOW, bodyweight:80}).vol.core > 0);
ok('share: legacy object/string weights do not NaN-poison', (function(){
  var r=_calcMuscleGroupShare([mbSess(1, {'Bench Press':{sets:3, reps:[10], weight:{kg:'12-15'}}, 'Squat':{sets:2, reps:[8], weight:'bodyweight'}})], {windowWeeks:6, nowMs:MB_NOW});
  return isFinite(r.total) && isFinite(r.share.push) && isFinite(r.share.legs); })());
ok('share: compound split credits both groups', (function(){
  var r=_calcMuscleGroupShare([mbSess(1, {'Deadlift':{sets:1, reps:[5], weight:100}})], {windowWeeks:6, nowMs:MB_NOW});
  return Math.abs(r.vol.pull-300)<1e-6 && Math.abs(r.vol.legs-200)<1e-6; })());
ok('share: long window takes 26–52 weeks ago only', (function(){
  var r=_calcMuscleGroupShare([mbSess(30*7, {'Bench Press':{sets:1, reps:[10], weight:100}}), mbSess(1, {'Squat':{sets:1, reps:[10], weight:100}})], {windowWeeks:'long', nowMs:MB_NOW});
  return r.hasData && r.vol.push===1000 && r.vol.legs===0; })());
function V(p,pu,l,c){ return _muscleBalanceVerdict({push:p/100, pull:pu/100, legs:l/100, core:c/100}, true); }
eq('verdict: nodata', _muscleBalanceVerdict({push:0,pull:0,legs:0,core:0}, false).status, 'nodata');
eq('verdict: balanced', V(25,25,25,25).status, 'balanced');
eq('verdict: spread 15 → tip', V(32,17,26,25).status, 'tip');
eq('verdict: spread 14 → balanced', V(31,17,26,26).status, 'balanced');
eq('verdict: low 14 → imbalanced', V(14,30,30,26).status, 'imbalanced');
eq('verdict: high 41 → imbalanced', V(41,20,20,19).status, 'imbalanced');
eq('verdict: high 40 low 15 → tip (not imbalance)', V(40,15,25,20).status, 'tip');
eq('verdict: low 9 → critical-low', V(9,31,30,30).status, 'critical-low');
eq('verdict: high 51 → critical-high', V(51,17,16,16).status, 'critical-high');
eq('verdict: critical-low beats critical-high', V(60,9,16,15).status, 'critical-low');
eq('verdict: low/high picked by share', (function(){ var v=V(9,31,30,30); return [v.low.key, v.high.key]; })(), ['push','pull']);
eq('verdict: flags per bar', V(9,45,31,15).flags, {push:'red', pull:'amber', legs:'ok', core:'ok'});
eq('verdict: rounds like the Progress tab', _muscleBalanceVerdict({push:0.246, pull:0.254, legs:0.25, core:0.25}, true).pct, {push:25, pull:25, legs:25, core:25});
ok('verdict: detail is plain text', V(9,31,30,30).detail.indexOf('<') < 0 && V(9,31,30,30).detail.indexOf('Push (Chest/Shoulders/Tri) is critically low at 9%') === 0);
ok('verdict: tie on low uses first in push/pull/legs/core order', V(20,20,30,30).low.key === 'push' && V(20,20,30,30).high.key === 'core');

JSON.stringify(fails);
"""

def gate_invariants(js):
    pieces = []
    ranks = extract_const_array(js, 'RANKS')
    if not ranks:
        print('  ✗ could not extract RANKS'); return False
    pieces.append(ranks)
    step = extract_const_line(js, 'PRESTIGE_STEP')
    if not step:
        print('  ✗ could not extract PRESTIGE_STEP'); return False
    pieces.append(step)
    for cname in ['COMEBACK_GAP_DAYS', 'COMEBACK_XP']:
        cline = extract_const_line(js, cname)
        if not cline:
            print(f'  ✗ could not extract {cname}'); return False
        pieces.append(cline)
    for fn in ['getRank', 'getPrestigeStars', '_sessionXP', '_weekKey',
               'getMaxWeeklySessions', 'calcWeekStreak', 'getLongestWeekStreak', '_localYMD',
               '_sessionKey', '_mergeSessions', '_validateSession',
               'getLiftState', '_leanFor', 'snapToSteps', 'stepWeight', 'calc1RM', 'parseRepTarget',
               '_comebackEvents', '_measureDelta', '_exVideoEntry', '_exVideoPickSex', '_rotatePick',
               '_buildCooldown', '_rankNextPathDays',
               'getRecencyWeight', '_calcMuscleGroupShare', '_muscleBalanceVerdict']:
        src = extract_decl(js, fn)
        if not src:
            print(f'  ✗ could not extract function {fn}'); return False
        pieces.append(src)
    sandbox = '\n'.join(pieces) + '\n' + ASSERTIONS
    out, _ = run_jxa(sandbox)
    try:
        fails = json.loads(out)
    except Exception:
        print('  ✗ invariant runner errored: ' + out); return False
    if fails:
        for f in fails: print('  ✗ ' + f)
        return False
    print('  ✓ all XP / rank / week-key invariants hold')
    return True

def gate_videomap(js):
    """Validate the real EX_VIDEO_MAP literal: value format, unique non-empty
    keys, and a sane entry count. Catches malformed hand-edits (space in a
    slug, missing quote, duplicated key) that the JS parse gate can't."""
    m = re.search(r'const EX_VIDEO_MAP = \{(.*?)\n\};', js, re.S)
    if not m:
        print('  ✗ EX_VIDEO_MAP literal not found'); return False
    body = m.group(1)
    entries = re.findall(r"'((?:[^'\\]|\\.)+)':\s*'((?:[^'\\]|\\.)+)',", body)
    if len(entries) < 90:
        print(f'  ✗ EX_VIDEO_MAP has only {len(entries)} entries (expected >= 90)'); return False
    bad = [(k, v) for k, v in entries if not re.fullmatch(r'[A-Za-z0-9_-]+(\|[mf])?', v)]
    if bad:
        for k, v in bad[:5]: print(f'  ✗ malformed map value: {k!r}: {v!r}')
        return False
    keys = [k for k, _ in entries]
    dupes = {k for k in keys if keys.count(k) > 1}
    if dupes:
        print(f'  ✗ duplicate map keys: {sorted(dupes)[:5]}'); return False
    print(f'  ✓ EX_VIDEO_MAP well-formed ({len(entries)} entries, unique keys)')
    # COOLDOWN_STRETCHES literal: slug format + unique slugs + sane count
    cm = re.search(r'const COOLDOWN_STRETCHES = \[(.*?)\n\];', js, re.S)
    if not cm:
        print('  ✗ COOLDOWN_STRETCHES literal not found'); return False
    slugs = re.findall(r"slug:'([^']+)'", cm.group(1))
    cbad = [s for s in slugs if not re.fullmatch(r'[a-z0-9-]+', s)]
    if cbad or len(slugs) < 12 or len(set(slugs)) != len(slugs):
        print(f'  ✗ COOLDOWN_STRETCHES invalid (n={len(slugs)}, bad={cbad[:3]}, dupes={len(slugs)-len(set(slugs))})'); return False
    gm = re.search(r'const EX_GIF_MAP = \{(.*?)\n\};', js, re.S)
    if not gm:
        print('  ✗ EX_GIF_MAP literal not found'); return False
    gentries = re.findall(r"'((?:[^'\\]|\\.)+)':\s*'([^']*)',", gm.group(1))
    gbad = [(k, v) for k, v in gentries if not re.fullmatch(r'[A-Za-z0-9]+', v)]
    gkeys = [k for k, _ in gentries]
    if gbad or len(set(gkeys)) != len(gkeys):
        print(f'  ✗ EX_GIF_MAP invalid (bad={gbad[:3]}, dupes={len(gkeys)-len(set(gkeys))})'); return False
    print(f'  ✓ EX_GIF_MAP well-formed ({len(gentries)} entries)')
    vm2 = re.search(r'const EX_V2_ID_MAP = \{(.*?)\n\};', js, re.S)
    if not vm2:
        print('  ✗ EX_V2_ID_MAP literal not found'); return False
    v2e = re.findall(r"'((?:[^'\\]|\\.)+)':\s*'([^']*)',", vm2.group(1))
    v2bad = [(k, v) for k, v in v2e if not re.fullmatch(r'exr_[A-Za-z0-9]+', v)]
    v2k = [k for k, _ in v2e]
    if v2bad or len(set(v2k)) != len(v2k):
        print(f'  ✗ EX_V2_ID_MAP invalid (bad={v2bad[:3]})'); return False
    print(f'  ✓ EX_V2_ID_MAP well-formed ({len(v2e)} entries)')
    print(f'  ✓ COOLDOWN_STRETCHES well-formed ({len(slugs)} stretches)')
    wm = re.search(r'const WARMUP_MOVES = \[(.*?)\n\];', js, re.S)
    if not wm:
        print('  ✗ WARMUP_MOVES literal not found'); return False
    ws = re.findall(r"slug:'([^']+)'", wm.group(1))
    wbad = [s for s in ws if not re.fullmatch(r'[a-z0-9-]+', s)]
    if wbad or len(ws) < 8 or len(set(ws)) != len(ws):
        print(f'  ✗ WARMUP_MOVES invalid (n={len(ws)}, bad={wbad[:3]})'); return False
    print(f'  ✓ WARMUP_MOVES well-formed ({len(ws)} moves)')
    return True

# ── Gate 4: inline-handler wiring ──────────────────────────────────────────
# The ReferenceError class: an inline on*="..." attribute calls a function or
# reads a global that does not exist, so the button throws the moment it's
# clicked and silently does nothing. Two real instances shipped:
#   - confirmClear() used an undefined USER_ID, so "Clear history" cleared nothing
#   - the #cloudToggle button called cloudLogout()/cloudUserId, neither defined
# The JS parse gate cannot see these — the handler is a string until clicked.

# Globals the browser provides, plus the handler-scope implicit names.
BROWSER_GLOBALS = {
    'window', 'document', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'console', 'event', 'this', 'self', 'top', 'parent',
    'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'setInterval',
    'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'getComputedStyle',
    'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Promise', 'Set', 'Map', 'RegExp', 'Error', 'Infinity', 'NaN', 'undefined',
    'null', 'true', 'false', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'Blob', 'URL', 'FileReader', 'Image', 'Audio', 'AbortController',
    'CustomEvent', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
    'structuredClone', 'queueMicrotask', 'caches', 'indexedDB', 'crypto',
    # reserved words that can appear inside a handler expression
    'if', 'else', 'return', 'typeof', 'new', 'delete', 'void', 'in', 'of',
    'let', 'const', 'var', 'function', 'try', 'catch', 'finally', 'throw',
    'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'instanceof',
    'async', 'await', 'yield', 'class', 'extends', 'super',
}

# SCREAMING_SNAKE names that legitimately appear without a local declaration.
SCREAMING_ALLOWED = {
    'XMLHttpRequest', 'NSUTF8StringEncoding',
}

def strip_js_noise(js):
    """Blank out comments and quoted spans so identifiers that merely appear in
    prose or data are not mistaken for live code references.

    Deliberately LINE-BOUNDED. A whole-file character scanner cannot tell a regex
    literal from division without a real parser, and one mis-read quote desyncs
    the rest of the file — an earlier version of this silently blanked 63% of the
    script, which turned the gate below into a permanent green light. Working a
    line at a time means a bad guess costs at most that one line. Multi-line
    block comments and template literals are tracked with explicit state, since
    those two are unambiguous."""
    out, in_block, in_tpl = [], False, False
    for raw in js.split('\n'):
        line = raw
        if in_block:
            end = line.find('*/')
            if end == -1:
                out.append(''); continue
            line = ' ' * (end + 2) + line[end + 2:]
            in_block = False
        if in_tpl:
            # inside a template literal: only a lone ` closes it
            end = line.find('`')
            if end == -1:
                out.append(''); continue
            line = ' ' * (end + 1) + line[end + 1:]
            in_tpl = False
        # opening block comment that runs past this line
        bm = re.search(r'/\*', line)
        if bm and '*/' not in line[bm.end():]:
            in_block = True
            line = line[:bm.start()]
        line = re.sub(r'/\*.*?\*/', ' ', line)          # closed block comment
        line = re.sub(r"'(?:[^'\\]|\\.)*'", "''", line)  # closed 'single'
        line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)  # closed "double"
        line = re.sub(r'`(?:[^`\\]|\\.)*`', '``', line)  # closed `template`
        # an unclosed ` opens a multi-line template literal
        if line.count('`') % 2 == 1:
            in_tpl = True
            line = line[:line.rfind('`')]
        line = re.sub(r'//.*$', '', line)                # line comment
        out.append(line)
    return '\n'.join(out)

def declared_globals(js):
    """Every name the inline script defines at any scope. Deliberately
    over-inclusive: a false 'declared' only weakens the check, while a false
    'undeclared' would make the gate cry wolf and get switched off."""
    names = set()
    names |= set(re.findall(r'\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(', js))
    names |= set(re.findall(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)', js))
    names |= set(re.findall(r'\bwindow\.([A-Za-z_$][\w$]*)\s*=', js))
    names |= set(re.findall(r'^[ \t]*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()', js, re.M))
    # `const {a, b} = ...` / `const [a, b] = ...` destructuring
    for grp in re.findall(r'\b(?:const|let|var)\s*[\{\[]([^\}\]]{1,200})[\}\]]\s*=', js):
        names |= set(re.findall(r'([A-Za-z_$][\w$]*)', grp))
    return names

def script_line_offset(html):
    """Lines to add to an inline-script line number to get an index.html line.
    Returns None when there is more than one inline block, since the harness
    concatenates them and the mapping is then ambiguous — better to print an
    honest 'inline script line N' than a confidently wrong file line."""
    ms = list(re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html))
    if len(ms) != 1:
        return None
    return html.count('\n', 0, ms[0].start(1))

def handler_attrs(html):
    """(line_no, attr_name, code) for every inline on*= handler."""
    out = []
    for m in re.finditer(r'\son([a-z]+)\s*=\s*"([^"]*)"', html):
        out.append((html.count('\n', 0, m.start()) + 1, 'on' + m.group(1), m.group(2)))
    return out

def strip_strings(code):
    """Blank out 'single' and \"double\" quoted spans so string contents are not
    mistaken for identifiers."""
    code = re.sub(r"'(?:[^'\\]|\\.)*'", "''", code)
    code = re.sub(r'`(?:[^`\\]|\\.)*`', '``', code)
    return code

def strip_interpolation(code):
    """Remove `${ ... }` spans (brace-matched, so nested object/ternary braces are
    handled). Most of this app's handlers are emitted from JS template literals,
    where the ${} holds render-local variables that are NOT globals. Blanking the
    span keeps the surrounding function name checkable — `f(${i})` still verifies
    that `f` exists — without flagging `i`."""
    out, i, n = [], 0, len(code)
    while i < n:
        if code[i] == '$' and i + 1 < n and code[i + 1] == '{':
            depth, j = 0, i + 1
            while j < n:
                if code[j] == '{': depth += 1
                elif code[j] == '}':
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            i = j                      # drop the whole ${...} span
        else:
            out.append(code[i]); i += 1
    return ''.join(out)

def gate_wiring(html, js):
    declared = declared_globals(js)
    known = declared | BROWSER_GLOBALS
    # Every element id anywhere in the file — including ids that only appear
    # inside JS template literals, which is how most of this app's DOM is built.
    element_ids = set(re.findall(r'\bid\s*=\s*["\']([A-Za-z0-9_:-]+)["\']', html))
    element_ids |= set(re.findall(r'\bid\s*=\s*([A-Za-z0-9_-]+)[\s>]', html))

    bad_names, bad_ids = [], []
    for line, attr, raw in handler_attrs(html):
        raw = strip_interpolation(raw)
        code = strip_strings(raw)
        # Identifiers that are not property accesses (no leading dot), not object
        # keys (`{foo:` / `foo:`), and not label-like.
        for im in re.finditer(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?![\w$])', code):
            name = im.group(1)
            rest = code[im.end():].lstrip()
            if rest.startswith(':'):      # object key / ternary-else handled below
                continue
            if name in known:
                continue
            bad_names.append((line, attr, name, raw[:90]))
        # getElementById('x') / querySelector('#x') inside the handler
        for gm in re.finditer(r"getElementById\(\s*'([A-Za-z0-9_:-]+)'\s*\)", raw):
            if gm.group(1) not in element_ids:
                bad_ids.append((line, attr, gm.group(1), raw[:90]))
        for qm in re.finditer(r"querySelector(?:All)?\(\s*'#([A-Za-z0-9_:-]+)'", raw):
            if qm.group(1) not in element_ids:
                bad_ids.append((line, attr, qm.group(1), raw[:90]))

    # De-dup while keeping the first sighting of each name
    seen, uniq = set(), []
    for line, attr, name, snippet in bad_names:
        if name in seen:
            continue
        seen.add(name); uniq.append((line, attr, name, snippet))

    handlers_ok = not (uniq or bad_ids)
    if handlers_ok:
        n = len(handler_attrs(html))
        print(f'  ✓ all {n} inline handlers reference defined functions and real element ids')
    else:
        for line, attr, name, snippet in uniq:
            print(f'  ✗ index.html:{line} {attr} calls/reads undefined `{name}`  — {snippet}')
        for line, attr, eid, snippet in bad_ids:
            print(f'  ✗ index.html:{line} {attr} targets missing element id "{eid}"  — {snippet}')

    # The confirmClear()/USER_ID instance lived in a function BODY, not in a
    # handler attribute, so the sweep above would have missed it. Config-style
    # SCREAMING_SNAKE names are how this file spells its globals, and one that is
    # read but never declared is the exact shape of that bug.
    code = strip_js_noise(js)
    declared_upper = {d for d in declared if re.fullmatch(r'[A-Z][A-Z0-9_]*', d)}
    ghosts = {}
    for gm in re.finditer(r'(?<![\w$.])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w$])', code):
        name = gm.group(1)
        if name in declared_upper or name in known or name in SCREAMING_ALLOWED:
            continue
        ghosts.setdefault(name, code.count('\n', 0, gm.start()) + 1)
    if ghosts:
        off = script_line_offset(html)
        for name, line in sorted(ghosts.items(), key=lambda kv: kv[1]):
            where = f'index.html:{line + off}' if off is not None else f'inline script line {line}'
            print(f'  ✗ {where} reads undeclared global `{name}` — ReferenceError when that line runs')
    else:
        print('  ✓ no SCREAMING_SNAKE global is read without being declared')
    return handlers_ok and not ghosts

# ── Gate 5: auth log hygiene ───────────────────────────────────────────────
# A shipped build printed the full Supabase auth response — access_token AND
# refresh_token — plus the user's email to the browser console. Nothing on an
# auth path may log a response body, a token, a password, or an email.
AUTH_FUNCS = ['authLogin', 'authSignup', 'refreshAuthToken', 'sendPasswordReset',
              'sendConfirmationEmail', 'deleteUserAccount', 'authLogout', 'saveAuthState']
# Bare identifiers that must never be passed to console.* on an auth path.
FORBIDDEN_ARGS = ['data', 'token', 'password', 'email', 'authToken', 'authRefreshToken',
                  'refreshToken', 'newToken', 'newRefresh', 'user', 'currentUser',
                  'result', 'res', 'json', 'body', 'blob', 'savedAuth']

def extract_async_decl(js, name):
    """extract_decl, but also matches `async function NAME(`."""
    m = re.search(r'(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(', js)
    if not m:
        return None
    i = js.index('{', m.start())
    depth = 0
    for j in range(i, len(js)):
        if js[j] == '{': depth += 1
        elif js[j] == '}':
            depth -= 1
            if depth == 0:
                return js[m.start():j + 1]
    return None

def gate_authlogs(js):
    problems, checked = [], 0
    for fn in AUTH_FUNCS:
        src = extract_async_decl(js, fn)
        if not src:
            problems.append(f'auth function {fn}() not found — update AUTH_FUNCS in this harness')
            continue
        checked += 1
        for cm in re.finditer(r'console\.(?:log|warn|error|info|debug)\s*\(', src):
            # Grab the argument list by paren-matching
            i = src.index('(', cm.start()); depth = 0
            for j in range(i, len(src)):
                if src[j] == '(': depth += 1
                elif src[j] == ')':
                    depth -= 1
                    if depth == 0: break
            args = strip_strings(src[i + 1:j])
            if re.search(r'JSON\.stringify', args):
                problems.append(f'{fn}(): console call passes JSON.stringify(...) — may serialize tokens')
                continue
            for bad in FORBIDDEN_ARGS:
                # bare identifier only — `result.status` and `e.message` are fine
                if re.search(r'(?<![\w$.])' + re.escape(bad) + r'\s*(?![\w$.])', args):
                    problems.append(f'{fn}(): console call logs bare `{bad}` — may expose credentials/PII')
                    break
    if problems:
        for p in problems: print('  ✗ ' + p)
        return False
    print(f'  ✓ no auth path ({checked} functions) logs a token, password, email, or response body')
    return True

# ── Gate 6: sign-out scrubs everything sign-in uploads ─────────────────────
# The cross-account leak class. authLogout() does not reload the page, so any
# user-data global left standing survives into the NEXT account on the device —
# and the next cloudSaveProfile() writes it into that account's __profile__ row,
# making one person's body measurements and private notes permanently theirs.
# The blob cloudSaveProfile() builds is the exact list of things that leak, so
# every key in it must be reset by authLogout(). This gate keeps the two in step
# when someone adds a field to the blob months from now.
#
# Keys that are legitimately NOT per-account state, with the reason:
LOGOUT_EXEMPT = {
    'prefs': 'device-level display prefs (units, audio, RPE) — not identifying, '
             'and resetting them on every sign-out would be a UX regression',
}
# Blob keys whose reset is a localStorage removal rather than a global assignment.
LOGOUT_VIA_STORAGE = {'onboarded': 'maxgainz_onboarded'}

def gate_logout_scrub(js):
    prof = extract_async_decl(js, 'cloudSaveProfile')
    out = extract_async_decl(js, 'authLogout')
    if not prof or not out:
        print('  ✗ could not extract cloudSaveProfile/authLogout'); return False
    m = re.search(r'JSON\.stringify\(\s*\{', prof)
    if not m:
        print('  ✗ could not find the profile blob literal in cloudSaveProfile'); return False
    i = prof.index('{', m.start()); depth = 0
    for j in range(i, len(prof)):
        if prof[j] == '{': depth += 1
        elif prof[j] == '}':
            depth -= 1
            if depth == 0: break
    blob = prof[i + 1:j]
    # Top-level keys only. Scanned character-wise rather than with one regex: a
    # regex that matches the separating comma CONSUMES it, so it cannot then use
    # it as the lead-in for the next key and silently finds every *other* key —
    # which made this gate report "all 7 fields" for a 12-field blob and pass.
    keys, depth, k = [], 0, 0
    while k < len(blob):
        c = blob[k]
        if c in '{[(':
            depth += 1; k += 1; continue
        if c in '}])':
            depth -= 1; k += 1; continue
        if c in '\'"`':                      # skip string literals wholesale
            q = c; k += 1
            while k < len(blob):
                if blob[k] == '\\': k += 2; continue
                if blob[k] == q: break
                k += 1
            k += 1; continue
        if depth == 0 and (c.isalpha() or c in '_$'):
            m2 = re.match(r'[A-Za-z_$][\w$]*', blob[k:])
            name = m2.group(0)
            after = blob[k + len(name):]
            # a top-level key is followed by ':' (key: value) or ',' / end (shorthand)
            if re.match(r'\s*[:,]', after) or after.strip() == '':
                keys.append(name)
            k += len(name)
            # jump past this entry's value to the next top-level comma
            while k < len(blob):
                ch = blob[k]
                if ch in '{[(': depth += 1
                elif ch in '}])': depth -= 1
                elif ch in '\'"`':
                    q = ch; k += 1
                    while k < len(blob):
                        if blob[k] == '\\': k += 2; continue
                        if blob[k] == q: break
                        k += 1
                elif ch == ',' and depth == 0:
                    break
                k += 1
            k += 1
            continue
        k += 1
    # cloudSaveProfile's blob is known to carry ~12 fields; a parse that finds far
    # fewer means this scanner broke, not that the app shrank. Fail loudly.
    if len(keys) < 10:
        print(f'  ✗ parsed only {len(keys)} blob keys ({", ".join(keys)}) — the parser '
              f'in this harness is wrong, not the app. Fix it rather than trusting a pass.')
        return False

    missing = []
    for k in keys:
        if k in LOGOUT_EXEMPT:
            continue
        if k in LOGOUT_VIA_STORAGE:
            if f"removeItem('{LOGOUT_VIA_STORAGE[k]}')" in out:
                continue
            missing.append(f'{k} (expected removeItem of {LOGOUT_VIA_STORAGE[k]})')
            continue
        reset = (re.search(r'(?<![\w$.])' + re.escape(k) + r'\s*=(?!=)', out)          # reassigned
                 or re.search(re.escape(k) + r'\.length\s*=\s*0', out)                  # emptied in place
                 or re.search(r'Object\.keys\(\s*' + re.escape(k) + r'\s*\)', out))     # keys deleted
        if not reset:
            missing.append(k)
    if missing:
        print('  ✗ authLogout() does not reset these fields that cloudSaveProfile() uploads:')
        for k in missing:
            print(f'      - {k}  → survives sign-out and lands in the NEXT account\'s cloud row')
        print('    Reset it in authLogout(), or add it to LOGOUT_EXEMPT here with a reason.')
        return False
    print(f'  ✓ authLogout() resets all {len(keys) - len(LOGOUT_EXEMPT)} per-account fields '
          f'cloudSaveProfile() uploads')
    return True

# ── GATE: sync honesty (save/sync status accuracy + retry) ─────────────────
# Drives the REAL sync functions (extracted by name) inside JavaScriptCore's
# `jsc` shell — unlike JXA it drains microtasks, so async code really runs —
# against a stubbed sbFetch that fails on demand (failure injection). Encodes
# audit P1 "Save and sync status can overstate success":
#   - a failed cloud write is a visible pending operation, never "synced"
#   - a failed/partial cloudLoadAll leaves local state untouched
#   - pending work survives a reload, is account-scoped, and is retried
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'

SYNC_FUNCS = ['_emptyPending', '_normalisePending', '_P', '_savePending', '_unsyncedSessionCount',
              '_countPending', '_pendingCount', '_isHydrated', '_markSynced', '_lastSyncedAt',
              '_setProfileSeen', '_profileSeenAt', '_mergeLocalProfileExtras',
              '_newClientId', '_isClientIdSchemaError', '_fetchAllSessionRows',
              '_buildStash', '_stashUnsynced', '_restoreStash', '_sessFingerprint',
              '_syncLabel', '_recomputeSyncStatus', '_scheduleRetry', '_uploadSession', 'flushPending',
              'cloudSaveSession', 'cloudDeleteSession', 'cloudSaveWeight', 'cloudSaveProfile',
              'cloudLoadAll', '_mergeSessions', '_validateSession', '_sessionKey',
              '_normalizeSessionWeights', 'lsGet', 'lsSet', 'lsGetRaw', 'lsSetRaw', 'setSyncStatus']

SYNC_PRELUDE = r'''
var console = { log(){}, warn(){}, error(){}, info(){} };
var __ls = {};
var localStorage = { getItem(k){ return Object.prototype.hasOwnProperty.call(__ls,k) ? __ls[k] : null; },
  setItem(k,v){ __ls[k] = String(v); }, removeItem(k){ delete __ls[k]; } };
var navigator = { onLine: true };
var __st = { auth: true, uid: 'userA' };
function isAuthenticated(){ return __st.auth; }
function getCurrentUserId(){ return __st.auth ? __st.uid : null; }
var __calls = [], __timers = [], __toasts = [], __statuses = [];
function setTimeout(f, ms){ __timers.push(ms); return __timers.length; }
function clearTimeout(){}
function showToast(m){ __toasts.push(String(m)); }
var __net = function(path, opts){ return []; };
async function sbFetch(path, opts){ opts = opts || {}; __calls.push({ path: path, method: opts.method || 'GET', body: opts.body || null }); return __net(path, opts); }
var bus = { emit(ev, d){ __statuses.push(d.status); } };
function _isColdSyncing(){ return false; }
var _isCloudSyncing = false;
function saveLocalCache(){ localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: getCurrentUserId() })); } // stamps the owner, like the real one
function applyCustomWeights(){}
var STORAGE_KEY = 'maxgainz_v1';
var _dashWeightsOk = false;
var completedSessions = [], customWeights = {}, customWorkouts = [], HIIT = [];
var userProfile = { firstName: 'Local', weight: 80 };
var userPreferences = { audioEnabled: true };
var todayProg = 'ULF', userPath = { id: 'p1' }, pathHistory = [], bodyWeightLog = [], measurementsLog = [], dailyNotes = {}, pbLifts = [];
localStorage.setItem('maxgainz_path', JSON.stringify(userPath));
function last(){ return __statuses[__statuses.length - 1]; }
function posts(re){ return __calls.filter(c => c.method === 'POST' && re.test(c.path)).length; }
'''

SYNC_SCENARIOS = {
    'profile save failure stays pending, persisted, retried, never synced': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      __net = () => null;
      const r = await cloudSaveProfile();
      const stored = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
      return r === null && _P().profile === true && stored.profile === true && __timers.length > 0 && last() !== 'synced';
    ''',
    'profile save success clears pending and records last-synced': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      __net = () => [];
      await cloudSaveProfile();
      return _P().profile === false && !!_lastSyncedAt() && last() === 'synced';
    ''',
    'un-hydrated device never uploads the profile blob (may be defaults)': r'''
      __net = () => [];
      const r = await cloudSaveProfile();
      return r === false && posts(/custom_weights/) === 0 && _P().profile === true && last() !== 'synced';
    ''',
    'weight write failure queues, later success clears': r'''
      __net = () => null;
      await cloudSaveWeight('Bench Press', 80);
      const queued = _P().weights['Bench Press'] === 80 && last() !== 'synced';
      __net = () => [];
      await cloudSaveWeight('Bench Press', 80);
      return queued && !('Bench Press' in _P().weights) && last() === 'synced';
    ''',
    'failed delete is queued and filtered out of the next cloud load': r'''
      __net = (p, o) => (o.method === 'DELETE') ? null : (/^sessions/.test(p) ? [{ id: 'c1', date: '2026-11-01T10:00:00Z', day: 'Push' }] : []);
      await cloudDeleteSession({ cloud_id: 'c1', date: new Date('2026-11-01T10:00:00Z'), day: 'Push' });
      const queued = _P().deletes.indexOf('c1') >= 0;
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return queued && ok === true && !completedSessions.some(s => s.cloud_id === 'c1');
    ''',
    'partial load (weights fail) keeps local profile/path and is not synced': r'''
      __net = (p) => /^sessions/.test(p) ? [] : null;
      const ok = await cloudLoadAll();
      return ok === false && userProfile.firstName === 'Local' && userPath && userPath.id === 'p1'
        && localStorage.getItem('maxgainz_path') !== null && __statuses.indexOf('synced') < 0;
    ''',
    'total load failure keeps local state and schedules a retry': r'''
      __net = () => null;
      completedSessions.push({ date: new Date('2026-11-02T10:00:00Z'), day: 'Legs' });
      const ok = await cloudLoadAll();
      return ok === false && userProfile.firstName === 'Local' && completedSessions.length === 1
        && __timers.length > 0 && __statuses.indexOf('synced') < 0;
    ''',
    'pending local profile wins over the cloud blob on a hydrated device, then uploads': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      _setProfileSeen('2026-11-20T10:00:00.000Z');              // this device last saw the current cloud blob
      __net = () => null; await cloudSaveProfile();            // fails → pending
      const blob = JSON.stringify({ userProfile: { firstName: 'Cloud' } });
      __net = (p, o) => o.method === 'POST' ? [] : (/^sessions/.test(p) ? [] : [{ exercise_name: '__profile__', notes: blob, updated_at: '2026-11-20T10:00:00.000Z' }]);
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const up = __calls.filter(c => c.method === 'POST' && /custom_weights/.test(c.path)).pop();
      return ok && userProfile.firstName === 'Local' && up && up.body.indexOf('Local') >= 0 && _P().profile === false && last() === 'synced';
    ''',
    'un-hydrated device takes the cloud blob over pending defaults': r'''
      __net = () => [];
      await cloudSaveProfile();                                 // not hydrated → pending, no upload
      const blob = JSON.stringify({ userProfile: { firstName: 'Cloud' } });
      __net = (p, o) => o.method === 'POST' ? [] : (/^sessions/.test(p) ? [] : [{ exercise_name: '__profile__', notes: blob }]);
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return ok && userProfile.firstName === 'Cloud' && _P().profile === false;
    ''',
    'newer cloud blob from another device wins, local-only entries are carried over and re-uploaded': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      _setProfileSeen('2026-11-20T10:00:00.000Z');
      bodyWeightLog = [{ date: '2026-11-23', weight: 81 }];
      __net = () => null; await cloudSaveProfile();             // offline edit → pending
      const blob = JSON.stringify({ userProfile: { firstName: 'Tablet' }, bodyWeightLog: [{ date: '2026-11-22', weight: 82 }],
        measurementsLog: [], dailyNotes: { '2026-11-22': 'tablet note' } });
      __net = (p, o) => o.method === 'POST' ? [] : (/^sessions/.test(p) ? [] : [{ exercise_name: '__profile__', notes: blob, updated_at: '2026-11-22T09:00:00.000Z' }]);
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const up = __calls.filter(c => c.method === 'POST' && /custom_weights/.test(c.path)).pop();
      const sent = up ? JSON.parse(JSON.parse(up.body).notes) : {};
      const dates = (sent.bodyWeightLog || []).map(e => e.date).join(',');
      return ok && userProfile.firstName === 'Tablet' && dailyNotes['2026-11-22'] === 'tablet note'
        && bodyWeightLog.length === 2 && dates === '2026-11-22,2026-11-23' && _P().profile === false;
    ''',
    'un-hydrated device keeps entries logged before the first load': r'''
      bodyWeightLog = [{ date: '2026-11-23', weight: 81 }];
      __net = () => [];
      const r = await cloudSaveProfile();                       // held: not hydrated
      const blob = JSON.stringify({ userProfile: { firstName: 'Cloud' }, bodyWeightLog: [{ date: '2026-11-01', weight: 84 }] });
      __net = (p, o) => o.method === 'POST' ? [] : (/^sessions/.test(p) ? [] : [{ exercise_name: '__profile__', notes: blob, updated_at: '2026-11-01T09:00:00.000Z' }]);
      await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return r === false && userProfile.firstName === 'Cloud' && bodyWeightLog.some(e => e.date === '2026-11-23') && bodyWeightLog.some(e => e.date === '2026-11-01');
    ''',
    'lost-response session insert is adopted on reload, never inserted twice': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      __net = () => [];
      await cloudLoadAll();                                      // page loaded → flag true
      const s = { date: new Date('2026-11-04T10:00:00Z'), day: 'Push' };
      completedSessions.push(s);
      let inserts = 0;
      __net = (p, o) => { if (o.method === 'POST' && /^sessions/.test(p)) { inserts++; return null; } return []; }; // lands, reply lost
      await _uploadSession(s);
      await flushPending();                                      // must NOT blindly re-POST
      const beforeReload = inserts;
      __net = (p, o) => { if (o.method === 'POST' && /^sessions/.test(p)) { inserts++; return [{ id: 'dup' }]; }
        return /^sessions/.test(p) ? [{ id: 'landed', date: '2026-11-04T10:00:00Z', day: 'Push' }] : []; };
      await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return beforeReload === 1 && inserts === 1 && completedSessions.length === 1 && completedSessions[0].cloud_id === 'landed';
    ''',
    'client_id upsert makes a retried session idempotent (same id, no reload needed)': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      __net = () => []; await cloudLoadAll();
      const server = {};                                         // client_id → row (what the DB unique key enforces)
      let lose = true;
      __net = (p, o) => {
        if (o.method === 'POST' && /^sessions/.test(p)) {
          const b = JSON.parse(o.body);
          if (!/on_conflict=user_id,client_id/.test(p) || !b.client_id) return null;
          server[b.client_id] = server[b.client_id] || { id: 'row' + Object.keys(server).length };
          if (lose) { lose = false; return null; }               // landed, reply lost
          return [server[b.client_id]];
        }
        return [];
      };
      _sessClientIdSupported = true;                             // migration applied
      const s = { date: new Date('2026-11-05T10:00:00Z'), day: 'Legs' };
      completedSessions.push(s);
      const first = await _uploadSession(s);
      const cid = s.client_id;
      const flagAfterFail = _cloudLoadedThisPage;
      await flushPending();
      return first === false && !!cid && flagAfterFail === true && Object.keys(server).length === 1
        && s.client_id === cid && s.cloud_id === 'row0';
    ''',
    'missing client_id column falls back to plain inserts': r'''
      __net = (p, o) => {
        if (o.method === 'POST' && /on_conflict=user_id,client_id/.test(p)) {
          _lastSyncError = 'http'; _lastSyncErrorDetail = { status: 400, text: '{"code":"PGRST204","message":"Could not find the \'client_id\' column of \'sessions\'"}' };
          return null;
        }
        if (o.method === 'POST' && /^sessions$/.test(p)) return [{ id: 'plain1' }];
        return [];
      };
      const s = { date: new Date('2026-11-06T10:00:00Z'), day: 'Push' };
      completedSessions.push(s);
      const ok = await _uploadSession(s);
      return ok === true && s.cloud_id === 'plain1' && _sessClientIdSupported === false
        && __calls.filter(c => c.method === 'POST' && /^sessions/.test(c.path)).length === 2;
    ''',
    'cloud load pages past 500 sessions (newest are not dropped)': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      const all = [];
      for (let i = 0; i < 1203; i++) all.push({ id: 'r' + i, date: new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString(), day: 'D' });
      __net = (p, o) => {
        if (/^sessions/.test(p) && !o.method) {
          const lim = +(/limit=(\d+)/.exec(p) || [0, 1e9])[1], off = +(/offset=(\d+)/.exec(p) || [0, 0])[1];
          return all.slice(off, off + lim);
        }
        return [];
      };
      const newest = { cloud_id: 'r1202', date: new Date(all[1202].date), day: 'D' };
      completedSessions.push(newest);
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return ok && completedSessions.length === 1203 && posts(/^sessions/) === 0;
    ''',
    'a failed page makes the whole load fail (no partial history)': r'''
      completedSessions.push({ cloud_id: 'keep', date: new Date('2026-11-01T10:00:00Z'), day: 'X' });
      __net = (p, o) => {
        if (/^sessions/.test(p)) { const off = +(/offset=(\d+)/.exec(p) || [0, 0])[1]; return off === 0 ? new Array(500).fill(0).map((_, i) => ({ id: 'p' + i, date: '2025-01-01T00:00:00Z', day: 'P' + i })) : null; }
        return [];
      };
      const ok = await cloudLoadAll();
      return ok === false && completedSessions.length === 1 && completedSessions[0].cloud_id === 'keep';
    ''',
    'a session deleted on another device is dropped, not re-uploaded': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      completedSessions.push({ cloud_id: 'gone', date: new Date('2026-11-07T10:00:00Z'), day: 'Pull' });
      completedSessions.push({ date: new Date('2026-11-08T10:00:00Z'), day: 'Legs' });   // genuinely local-only
      __net = (p, o) => o.method === 'POST' && /^sessions/.test(p) ? [{ id: 'up1' }] : [];
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return ok && completedSessions.length === 1 && completedSessions[0].day === 'Legs' && posts(/^sessions/) === 1;
    ''',
    'deleting a session also deletes its old duplicate rows': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      __net = (p, o) => /^sessions/.test(p) && !o.method
        ? [{ id: 'd1', date: '2026-11-09T10:00:00Z', day: 'Push' }, { id: 'd2', date: '2026-11-09T10:00:00Z', day: 'Push' }] : [];
      await cloudLoadAll();
      const s = completedSessions[0];
      await cloudDeleteSession(s);
      const del = __calls.filter(c => c.method === 'DELETE').map(c => c.path).join('|');
      return completedSessions.length === 1 && /id=eq\.d1/.test(del) && /id=eq\.d2/.test(del) && _P().deletes.length === 0;
    ''',
    'unsynced work kept at sign-out comes back on the same account, then uploads': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      completedSessions.push({ cloud_id: 'c9', date: new Date('2026-11-10T10:00:00Z'), day: 'Synced' });
      completedSessions.push({ date: new Date('2026-11-11T10:00:00Z'), day: 'Offline', volume: 1234 });
      __net = () => null; await cloudSaveWeight('Bench', 90);
      const n = _stashUnsynced();
      // what authLogout wipes:
      completedSessions.length = 0; for (const k in customWeights) delete customWeights[k];
      _pending = null; localStorage.removeItem(PENDING_KEY); localStorage.removeItem(STORAGE_KEY);
      const r = _restoreStash();
      __net = (p, o) => o.method === 'POST' && /^sessions/.test(p) ? [{ id: 'back1' }] : (o.method === 'POST' ? [] : (/^sessions/.test(p) ? [{ id: 'c9', date: '2026-11-10T10:00:00Z', day: 'Synced' }] : []));
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const off = completedSessions.find(s => s.day === 'Offline');
      return n === 2 && r === 2 && ok && off && off.cloud_id === 'back1' && off.volume === 1234
        && completedSessions.length === 2 && _pendingCount() === 0 && !(JSON.parse(localStorage.getItem(STASH_KEY) || '{}').userA);
    ''',
    'a stash is only ever restored for the account that saved it': r'''
      completedSessions.push({ date: new Date('2026-11-12T10:00:00Z'), day: 'Private' });
      _stashUnsynced();
      completedSessions.length = 0;
      __st.uid = 'userB';
      const r = _restoreStash();
      return r === 0 && completedSessions.length === 0 && !!JSON.parse(localStorage.getItem(STASH_KEY)).userA;
    ''',
    'an upload landing mid-load is not mistaken for a remote delete': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      const s = { date: new Date('2026-11-13T10:00:00Z'), day: 'Arms' };
      completedSessions.push(s);
      __net = (p, o) => { if (/^sessions/.test(p) && !o.method) { s.cloud_id = 'late1'; return []; } return []; }; // POST lands after the GET snapshot
      const ok = await cloudLoadAll();
      return ok && completedSessions.length === 1 && completedSessions[0].cloud_id === 'late1';
    ''',
    'deleting a never-confirmed session stays pending until a reload settles it': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      __net = () => []; await cloudLoadAll();
      const s = { date: new Date('2026-11-14T10:00:00Z'), day: 'Core', client_id: 'cid-x' };
      await cloudDeleteSession(s);                               // e.g. its POST landed but the reply was lost
      const pendingNow = _pendingCount(), flag = _cloudLoadedThisPage, label = last();
      __net = (p, o) => /^sessions/.test(p) && !o.method ? [{ id: 'ghost', date: '2026-11-14T10:00:00Z', day: 'Core' }] : [];
      await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const del = __calls.filter(c => c.method === 'DELETE').map(c => c.path).join('|');
      return pendingNow === 1 && flag === false && label !== 'synced' && /id=eq\.ghost/.test(del) && _pendingCount() === 0;
    ''',
    'same-day backdated activities are not deleted as duplicates': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      __net = (p, o) => /^sessions/.test(p) && !o.method
        ? [{ id: 'run1', date: '2026-11-09T12:00:00Z', day: 'Run', duration_min: 30, manual_activity: true, activity_type: 'run' },
           { id: 'run2', date: '2026-11-09T12:00:00Z', day: 'Run', duration_min: 45, manual_activity: true, activity_type: 'run' }] : [];
      await cloudLoadAll();
      await cloudDeleteSession(completedSessions[0]);
      return __calls.filter(c => c.method === 'DELETE').length === 1;
    ''',
    'kept profile changes (body weight logged offline) survive sign-out and re-sign-in': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      _setProfileSeen('2026-11-20T10:00:00.000Z');
      bodyWeightLog = [{ date: '2026-11-24', weight: 80.5 }];
      __net = () => null; await cloudSaveProfile();              // offline → pending
      const n = _stashUnsynced();
      bodyWeightLog = []; _pending = null; localStorage.removeItem(PENDING_KEY);   // authLogout wipe
      localStorage.removeItem(HYDRATED_KEY); localStorage.removeItem(STORAGE_KEY);
      const r = _restoreStash();
      const blob = JSON.stringify({ userProfile: { firstName: 'Cloud' }, bodyWeightLog: [{ date: '2026-11-01', weight: 82 }] });
      __net = (p, o) => o.method === 'POST' ? [] : (/^sessions/.test(p) ? [] : [{ exercise_name: '__profile__', notes: blob, updated_at: '2026-11-20T10:00:00.000Z' }]);
      await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const up = __calls.filter(c => c.method === 'POST' && /custom_weights/.test(c.path)).pop();
      const sent = up ? JSON.parse(JSON.parse(up.body).notes) : {};
      return n === 1 && r === 1 && (sent.bodyWeightLog || []).some(e => e.date === '2026-11-24') && _P().profile === false;
    ''',
    'offline session uploads after load; synced only once confirmed': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      completedSessions.push({ date: new Date('2026-11-03T10:00:00Z'), day: 'Pull' });
      __net = (p, o) => o.method === 'POST' && /^sessions/.test(p) ? [{ id: 'new1' }] : [];
      const ok = await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      return ok && completedSessions.length === 1 && completedSessions[0].cloud_id === 'new1' && last() === 'synced';
    ''',
    'failed session upload stays pending with a visible count': r'''
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'userA' }));
      completedSessions.push({ date: new Date('2026-11-03T10:00:00Z'), day: 'Pull' });
      __net = (p, o) => o.method === 'POST' ? null : [];
      await cloudLoadAll();
      if (_syncInFlight) await _syncInFlight;
      const label = _syncLabel(last(), _pendingCount(), null, true);
      return !completedSessions[0].cloud_id && last() !== 'synced' && /waiting to sync/.test(label) && /Saved on this device/.test(label);
    ''',
    'expired token stops retries and says sign in again': r'''
      localStorage.setItem(HYDRATED_KEY, 'userA');
      __net = () => { _lastSyncError = 'auth'; return null; };
      await cloudSaveProfile();
      return __timers.length === 0 && last() === 'auth' && /Sign in again/.test(_syncLabel('auth', 1, null, true));
    ''',
    'pending queue is account-scoped': r'''
      __net = () => null;
      await cloudSaveWeight('Squat', 100);
      const a = _pendingCount();
      __st.uid = 'userB';
      const b = _pendingCount();
      __st.uid = 'userA';
      return a === 1 && b === 0 && _pendingCount() === 1;
    ''',
    'setSyncStatus refuses to claim synced while work is pending': r'''
      __net = () => null;
      await cloudSaveWeight('Row', 60);
      __statuses.length = 0;
      setSyncStatus('synced');
      return __statuses[0] !== 'synced';
    ''',
    'status labels name where data is saved': r'''
      return /Saved on this device/.test(_syncLabel('local', 2, null, true))
        && /2 waiting to sync/.test(_syncLabel('local', 2, null, true))
        && _syncLabel('syncing', 0, null, true) === '🔄 Syncing…'
        && /^☁️ Synced to account · \d\d:\d\d$/.test(_syncLabel('synced', 0, new Date().toISOString(), true))
        && /not signed in/.test(_syncLabel('synced', 0, null, false));
    ''',
}

def _sync_module_vars(js):
    """The `var` state block of the pending-sync module (declarations only)."""
    m = re.search(r'// ── PENDING SYNC QUEUE ──([\s\S]*?)\n// ── CLOUD SYNC ──', js)
    if not m: return None
    return '\n'.join(l for l in m.group(1).split('\n') if l.startswith('var '))

def gate_sync(js):
    if not os.path.exists(JSC):
        print(f'  ✗ jsc not found at {JSC} — cannot run sync failure-injection tests'); return False
    vars_src = _sync_module_vars(js)
    if not vars_src:
        print('  ✗ pending-sync module (// ── PENDING SYNC QUEUE ──) not found'); return False
    srcs = []
    for fn in SYNC_FUNCS:
        src = extract_async_decl(js, fn)
        if not src:
            print(f'  ✗ {fn}() not found — update SYNC_FUNCS'); return False
        srcs.append(src)
    # Static ordering: cloudLoadAll must not reset local state before its fetch,
    # and must not hard-code a 'synced' status.
    load = extract_async_decl(js, 'cloudLoadAll')
    fetch_at = load.find('await Promise.all')
    problems = []
    for pat in ['delete userProfile[', 'userPath = null', "removeItem('maxgainz_path')"]:
        at = load.find(pat)
        if fetch_at < 0 or (0 <= at < fetch_at):
            problems.append(f'cloudLoadAll resets local state ({pat}) before the network fetch')
    if "setSyncStatus('synced')" in load:
        problems.append("cloudLoadAll hard-codes setSyncStatus('synced') — derive it via _recomputeSyncStatus()")
    lo = extract_async_decl(js, 'authLogout') or ''
    for pat in ['_pending = null', 'removeItem(PENDING_KEY)', 'removeItem(LAST_SYNC_KEY)', 'removeItem(HYDRATED_KEY)']:
        if pat not in lo: problems.append(f'authLogout() does not reset sync queue state ({pat})')
    ra = extract_async_decl(js, 'refreshAuthToken') or ''
    if not re.search(r"catch\s*\(\s*\w*\s*\)\s*\{[^{}]*return 'transient'", ra) or "status >= 500" not in ra:
        problems.append("refreshAuthToken() reports a network failure as a rejected session (no 'transient') — users get told to sign in again, and signing out discards unsynced data")
    if 'removeItem(PROFILE_SEEN_KEY)' not in lo:
        problems.append('authLogout() does not reset sync queue state (removeItem(PROFILE_SEEN_KEY))')
    if 'keepUnsynced' not in lo or '_stashUnsynced()' not in lo:
        problems.append('authLogout() cannot keep unsynced work (no keepUnsynced → _stashUnsynced path)')
    ucs = extract_async_decl(js, 'updateCloudStatus') or ''
    if 'confirmSignOut()' not in ucs:
        problems.append('the Sign Out button bypasses confirmSignOut() (unsynced work could be discarded silently)')
    li = extract_async_decl(js, 'authLogin') or ''
    scrub = r'currentUser\.id\s*!==\s*data\.user\.id\)\s*authLogout\(\{\s*keepUnsynced:\s*true\s*\}\)'
    if not re.search(scrub, li):
        problems.append('authLogin() re-login by a DIFFERENT account does not scrub (and stash) the previous account first')
    su = extract_async_decl(js, 'authSignup') or ''
    if not re.search(scrub, su) or su.find('authLogout(') > su.find('saveAuthState('):
        problems.append('authSignup() from the re-login screen does not scrub the previous account before saving the new one')
    if re.search(r"const savedName = savedAuth \?", li):
        problems.append("authLogin() takes the display name of whichever account was saved before (another account's name)")
    if li.find('_restoreStash()') < 0 or li.find('_restoreStash()') < li.find('saveAuthState('):
        problems.append('authLogin() does not restore the stash after the new auth state is saved')
    # An unfinished workout lives only in memory: sign-out must warn about it,
    # and a DIFFERENT account signing in must never inherit (and save) it.
    cso = extract_async_decl(js, 'confirmSignOut') or ''
    if '_activeSessionInfo()' not in cso:
        problems.append('confirmSignOut() does not warn about a workout in progress')
    if '_activeSessionOwner = getCurrentUserId()' not in lo:
        problems.append("authLogout() does not record whose unfinished workout is still open")
    for fn_name, src_ in (('authLogin', li), ('authSignup', su)):
        a_, b_ = src_.find('saveAuthState('), src_.find('_settleActiveSessionOwner()')
        if b_ < 0 or b_ < a_:
            problems.append(f"{fn_name}() does not end another account's unfinished workout after signing in")
    asi = extract_async_decl(js, '_activeSessionInfo') or ''
    if 'nav-active' not in asi or '_sessionFinalized' not in asi:
        problems.append('_activeSessionInfo() does not use the Session tab + _sessionFinalized (sessDay survives Finish)')
    ia = extract_async_decl(js, 'applyImportPayload') or ''
    if not re.search(r'delete s\.cloud_id', ia):
        problems.append("applyImportPayload() keeps backup cloud_ids — imported sessions look 'deleted elsewhere' and vanish on the next load")
    dma = extract_async_decl(js, 'deleteManualActivity') or ''
    if 'cloudDeleteSession' not in dma:
        problems.append('deleteManualActivity() never deletes the cloud copy (activity resurrects on next load)')
    for p in problems: print('  ✗ ' + p)
    ok = not problems
    base = SYNC_PRELUDE + '\n' + vars_src + '\n' + '\n'.join(srcs) + '\n'
    passed = 0
    for name, body in SYNC_SCENARIOS.items():
        script = base + ('(async function(){ ' + body + ' })().then(r => print(r === true ? "PASS" : "FAIL " + JSON.stringify(r)), '
                         'e => print("ERROR " + e + " " + (e && e.stack || "")));')
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as t:
            t.write(script); path = t.name
        try:
            out = subprocess.run([JSC, path], capture_output=True, text=True, timeout=60)
            res = (out.stdout.strip() or out.stderr.strip()).split('\n')[-1]
        finally:
            os.unlink(path)
        if res == 'PASS':
            passed += 1
        else:
            ok = False; print(f'  ✗ {name}: {res[:300]}')
    if ok:
        print(f'  ✓ sync honesty: {passed} failure-injection scenarios + static ordering/sign-out checks')
    return ok

# ── Gate 7: safe rendering of user-controlled text ─────────────────────────
# User-created names (custom programmes, days, exercises, HIITs) were pasted
# raw into innerHTML and into inline onclick="fn('NAME')" strings. HTML-escaping
# cannot make the second case safe (the browser entity-decodes the attribute
# before running it), so handlers must pass an index or read this.dataset.
SAFE_RENDER_HELPERS = ['esc', '_cleanText', '_cleanNumFields', '_cleanTextField', '_sanitiseExList',
                       '_sanitiseCustomWorkouts', '_sanitiseCustomHIITs', '_safePBColor',
                       '_sanitisePBLifts', '_isDatedLogEntry']
SAFE_RENDER_ASSERTIONS = r"""
var fails = [];
function eq(label, got, want){ if(JSON.stringify(got)!==JSON.stringify(want)) fails.push(label+' — got '+JSON.stringify(got)+', want '+JSON.stringify(want)); }
function ok(label, cond){ if(!cond) fails.push(label); }
eq('esc escapes & < > " \'', esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
eq('esc(null) is empty', esc(null), '');
eq('esc(undefined) is empty', esc(undefined), '');
eq('esc(0) is "0"', esc(0), '0');
eq('esc leaves normal text alone', esc('Push A — Day 1'), 'Push A — Day 1');
eq('_cleanText strips control chars', _cleanText('a\u0000b\u001Fc\u007Fd\n'), 'abcd');
eq('_cleanText trims', _cleanText('  Upper  '), 'Upper');
eq('_cleanText default cap 120', _cleanText(new Array(300).join('x')).length, 120);
eq('_cleanText explicit cap', _cleanText('abcdef', 3), 'abc');
eq('_cleanText null → empty', _cleanText(null), '');
eq('_cleanText keeps unicode/punctuation', _cleanText("Max's Push — Día 1 💪"), "Max's Push — Día 1 💪");
var CW = [
  null, 5, 'str', [], {name:''}, {name:'   '},
  {name:"Max's <Push>", extra:1, subcategories:[
     {name:'Day "A"', exercises:[{name:'Bench Press', sets:'3', reps:'8–12', weight:60, bw:false},
                                  {name:''}, null, {name:'Curl', sets:'x', weight:'20', reps:10}]},
     {name:''}, 7]},
  {name:'NoSubs'}
];
var CW_IN = JSON.stringify(CW);
var cw = _sanitiseCustomWorkouts(CW);
eq('sanitiser drops junk programmes', cw.length, 2);
eq('normal programme name byte-identical', cw[0].name, "Max's <Push>");
eq('unknown fields kept', cw[0].extra, 1);
eq('junk subcategories dropped', cw[0].subcategories.length, 1);
eq('subcategory name byte-identical', cw[0].subcategories[0].name, 'Day "A"');
eq('junk exercises dropped', cw[0].subcategories[0].exercises.length, 2);
eq('numeric string sets coerced', cw[0].subcategories[0].exercises[0].sets, 3);
eq('reps text kept', cw[0].subcategories[0].exercises[0].reps, '8–12');
ok('non-numeric sets removed', !('sets' in cw[0].subcategories[0].exercises[1]));
eq('numeric string weight coerced', cw[0].subcategories[0].exercises[1].weight, 20);
eq('numeric reps left as number', cw[0].subcategories[0].exercises[1].reps, 10);
ok('missing subcategories → array', Array.isArray(cw[1].subcategories) && cw[1].subcategories.length === 0);
eq('input not mutated', JSON.stringify(CW), CW_IN);
ok('returns copies', cw[0] !== CW[6] && cw[0].subcategories[0] !== CW[6].subcategories[0]);
eq('non-array input → []', _sanitiseCustomWorkouts({name:'x'}), []);
var long = new Array(120).join('n') + 'n';   // exactly 120 chars survives
eq('120-char name kept whole', _sanitiseCustomWorkouts([{name:long, subcategories:[]}])[0].name, long);
eq('control chars stripped from names', _sanitiseCustomWorkouts([{name:'A\u0007B', subcategories:[]}])[0].name, 'AB');
var CH = [{name:'Burn', format:'AMRAP', duration:'15', desc:'d\u0000', exercises:[{name:'Burpees', reps:'10 reps', weight:'abc'}]},
          {name:'Blocky', blocks:[{type:'floor', exercises:[{name:'Squat', duration:40}, {}]}]}, {}, 'x'];
var CH_IN = JSON.stringify(CH);
var ch = _sanitiseCustomHIITs(CH);
eq('HIIT sanitiser drops junk', ch.length, 2);
eq('HIIT name byte-identical', ch[0].name, 'Burn');
eq('HIIT duration coerced', ch[0].duration, 15);
eq('HIIT desc cleaned', ch[0].desc, 'd');
ok('HIIT bad weight removed', !('weight' in ch[0].exercises[0]));
ok('HIIT without exercises stays without', !('exercises' in ch[1]));
eq('HIIT block junk exercise dropped', ch[1].blocks[0].exercises.length, 1);
eq('HIIT input not mutated', JSON.stringify(CH), CH_IN);
eq('PB colour: css var ok', _safePBColor('var(--accent)'), 'var(--accent)');
eq('PB colour: hex ok', _safePBColor('#ff8cdd'), '#ff8cdd');
eq('PB colour: injection rejected', _safePBColor('red;background:url(x)'), null);
eq('PB colour: quote rejected', _safePBColor('#fff" onmouseover="x'), null);
var pb = _sanitisePBLifts([{label:'Bench Press', color:'x" onload="y'}, {label:''}, null, {label:'Squat', color:'var(--purple)'}]);
eq('PB sanitiser keeps labelled tiles', pb.length, 2);
ok('PB sanitiser drops unsafe colour', !('color' in pb[0]));
eq('PB sanitiser keeps safe colour', pb[1].color, 'var(--purple)');
ok('dated log entry accepted', _isDatedLogEntry({date:'2026-01-05', weight:80}));
ok('undated log entry rejected', !_isDatedLogEntry({date:"x');alert(1);//"}) && !_isDatedLogEntry(null));
JSON.stringify(fails);
"""

# Adversarial names: an HTML payload, both quote kinds, a backslash, a tag
# close, and a payload that survives HTML-escaping but breaks a JS string.
EVIL_NAMES = ['<img src=x onerror=alert(1)>', 'He said "hi"', "Max's Day", 'back\\slash',
              'x</div><b>y', "&#39;);alert(1);//"]

RENDER_HARNESS = r"""
function mkEl(id){ return { id:id, _html:'', textContent:'', style:{}, dataset:{},
  get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } }; }
var _els = {};
var document = { getElementById: function(id){ return _els[id] || (_els[id] = mkEl(id)); } };
var EVIL = %s;
var customWorkouts = EVIL.map(function(n, i){
  return { name:n, subcategories: EVIL.map(function(m){ return { name:m, exercises:[{name:m, sets:3, reps:m, weight:0, bw:true}] }; }) };
});
var todayProg = customWorkouts[0].name, selectedDay = null;
var ULF = {}, PPL = {};
function isPathActive(){ return false; }
var _clicked = [];
function setTP(p, el){ _clicked.push(p); }
function setDay(d){ _clicked.push(d); }
var out = {};
renderTodayToggle(); out.toggle = document.getElementById('todayToggleWrap').innerHTML;
renderDayPicker(); out.dayPicker = document.getElementById('dayPicker').innerHTML;
selectedDay = customWorkouts[0].subcategories[0].name;
renderTodayCustom(customWorkouts[0]);
out.custom = document.getElementById('todayHeroWrap').innerHTML + document.getElementById('todayList').innerHTML;
// Click-time resolution: every handler must reach the exact original name.
out.resolved = [];
if(typeof setTPIdx === 'function'){ for(var i=0;i<3+EVIL.length;i++){ _clicked=[]; setTPIdx(i, null); out.resolved.push(_clicked[0]); } }
out.dayResolved = [];
if(typeof setCustomDayIdx === 'function'){ for(var j=0;j<EVIL.length;j++){ _clicked=[]; setCustomDayIdx(j); out.dayResolved.push(_clicked[0]); } }
JSON.stringify(out);
"""

# A handler is "index-passing safe" when every argument is a number literal,
# `this`, `this.dataset.<key>`, `null`, or a call chain on those.
_SAFE_ARG = r'(?:-?\d+(?:\.\d+)?|this|this\.dataset\.[A-Za-z]\w*|null|event)'
_SAFE_CALL = r'(?:event\.stopPropagation\(\);)?[A-Za-z_$][\w$]*\(\s*(?:' + _SAFE_ARG + r'(?:\s*,\s*' + _SAFE_ARG + r')*)?\s*\)'

# Static lint allowlist: precomputed "\\'"-escaped values used in a handler that
# come ONLY from constant built-in data. Key = (variable, assignment substring).
QUOTE_ESCAPE_ALLOW = {
    ('safeDay', "(d.day || '')"): 'LIBRARY_PROGRAMMES day names (built-in constant data)',
    ('safeN', 't.name'):           'HIIT_TEMPLATES names (built-in constant data)',
    ('safe', 't.name'):            'HIIT_TEMPLATES names (built-in constant data)',
}

def _html_wellformed(fragment):
    """Every tag must be <name attr="..." ...> with double-quoted values and every
    text run must be free of < > ". Returns the first offending token or None."""
    for tok in re.split(r'(<[^>]*>)', fragment):
        if not tok:
            continue
        if tok.startswith('<'):
            if not re.fullmatch(r'</?[A-Za-z][\w-]*(?:\s+[A-Za-z_:][\w:.-]*(?:="[^"]*")?)*\s*/?>', tok):
                return tok
        elif re.search(r'[<>"]', tok):
            return tok
    return None

def gate_safe_render(html, js):
    ok_all = True
    # (a) helper semantics
    pieces, missing = [], []
    for fn in SAFE_RENDER_HELPERS:
        src = extract_decl(js, fn)
        if src: pieces.append(src)
        else: missing.append(fn)
    if missing:
        print(f'  ✗ could not extract helper function(s): {", ".join(missing)}')
        ok_all = False
    else:
        out, _ = run_jxa('\n'.join(pieces) + '\n' + SAFE_RENDER_ASSERTIONS)
        try:
            fails = json.loads(out)
        except Exception:
            fails = ['safe-render helper runner errored: ' + out]
        for f in fails: print('  ✗ ' + f)
        if fails: ok_all = False
        else: print('  ✓ esc / _cleanText / sanitisers behave (escape all 5, strip, cap, copy, names unchanged)')

    # (b) adversarial render of the Today toggle, custom day chips and custom hero
    pieces = []
    for fn in ['renderTodayToggle', 'renderDayPicker', 'renderTodayCustom']:
        src = extract_decl(js, fn)
        if not src:
            print(f'  ✗ could not extract function {fn}'); return False
        pieces.append(src)
    for fn in SAFE_RENDER_HELPERS + ['_todayToggleProgs', 'setTPIdx', 'setCustomDayIdx']:
        src = extract_decl(js, fn)
        if src: pieces.append(src)      # optional: absent on unfixed code → render still runs
    sandbox = '\n'.join(pieces) + '\n' + (RENDER_HARNESS % json.dumps(EVIL_NAMES))
    out, _ = run_jxa(sandbox)
    try:
        r = json.loads(out)
    except Exception:
        print('  ✗ adversarial render runner errored: ' + out[:300]); return False
    rfails = []
    for part in ['toggle', 'dayPicker', 'custom']:
        frag = r[part]
        if re.search(r'<img', frag, re.I):
            rfails.append(f'{part}: user name rendered as a live <img> tag')
        bad = _html_wellformed(frag)
        if bad:
            rfails.append(f'{part}: user text breaks out of markup/attribute near {bad[:70]!r}')
        for attr, code in re.findall(r'\son([a-z]+)\s*=\s*"([^"]*)"', frag):
            if not re.fullmatch(_SAFE_CALL + r'(?:;' + _SAFE_CALL + r')*;?', code.strip()):
                rfails.append(f'{part}: on{attr}="{code[:60]}" is not index/dataset-passing')
            decoded = code.replace('&quot;', '"').replace('&#39;', "'").replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
            for n in EVIL_NAMES:
                for chunk in re.findall(r'[A-Za-z]{3,}', n):
                    if re.search(r'(?<![A-Za-z])' + chunk + r'(?![A-Za-z])', decoded) and chunk not in ('this', 'dataset', 'null'):
                        rfails.append(f'{part}: on{attr} contains part of a user name ({chunk!r})'); break
    if r.get('resolved') != ['ULF', 'PPL', 'HIIT'] + EVIL_NAMES:
        rfails.append(f'toggle click does not resolve to the exact names: {r.get("resolved")!r}')
    if r.get('dayResolved') != EVIL_NAMES:
        rfails.append(f'day-chip click does not resolve to the exact names: {r.get("dayResolved")!r}')
    if rfails:
        for f in dict.fromkeys(rfails): print('  ✗ ' + f)
        ok_all = False
    else:
        print(f'  ✓ {len(EVIL_NAMES)} adversarial names render inert and round-trip via index-passing handlers')

    # (c) static lint: no quote-escaped user string inside an inline handler
    lint = []
    for line, attr, code in handler_attrs(html):
        if "replace(/'/g" in code:
            lint.append(f"index.html:{line} {attr} builds a JS string with .replace(/'/g …) — {code[:90]}")
    # Handlers built as a string and passed into a row helper (onclick="${attr}")
    # escape the handler_attrs() sweep above — catch '${x.replace(/'/g …)}' anywhere.
    seen = {int(f.split(':')[1].split()[0]) for f in lint}
    for m in re.finditer(r"'\$\{[^}`]*\.replace\(/'/g", html):
        line = html.count('\n', 0, m.start()) + 1
        if line not in seen:
            lint.append(f"index.html:{line} interpolates a quote-escaped value into a JS string literal — {m.group(0)[:70]}")
    for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^\n;]*)\.replace\(/'/g", html):
        var, rhs = m.group(1), m.group(2)
        if any(var == k and sub in rhs for (k, sub) in QUOTE_ESCAPE_ALLOW):
            continue
        used = re.search(r'\son[a-z]+\s*=\s*"[^"]*\$\{\s*' + re.escape(var) + r'\b', html)
        if used:
            line = html.count('\n', 0, m.start()) + 1
            lint.append(f'index.html:{line} `{var}` is a quote-escaped string interpolated into an inline handler')
    if lint:
        for f in lint: print('  ✗ ' + f)
        print("    HTML-escaping can't protect a JS string inside on*=\"…\". Pass an index or use data-* + this.dataset.")
        ok_all = False
    else:
        print('  ✓ no inline handler embeds a quote-escaped user string')
    return ok_all

def extract_const_object(js, name):
    """Extract `const NAME={ ... };` by brace-matching."""
    m = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*\{', js)
    if not m:
        return None
    i = js.index('{', m.start())
    depth = 0
    for j in range(i, len(js)):
        c = js[j]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return js[m.start():j+1] + ';'
    return None

MEDIA_FALLBACK_ASSERTIONS = r"""
var fails = [];
var names = {};
function walk(x, inEx){ if(Array.isArray(x)){ x.forEach(function(y){ walk(y, inEx); }); return; }
  if(x && typeof x === 'object'){ if(inEx && typeof x.name === 'string') names[x.name] = 1;
    for(var k in x){ walk(x[k], inEx || k === 'exercises'); } } }
for(var k in ULF) walk(ULF[k], true);
for(var k in PPL) walk(PPL[k], true);
walk(LIBRARY_PROGRAMMES, false); walk(WARMUP_MOVES, true); walk(COOLDOWN_STRETCHES, true);
walk(HIIT, false); walk(HIIT_TEMPLATES, false);
var all = Object.keys(names);
if(all.length < 150) fails.push('programme universe too small (' + all.length + ') — extraction broke');
var specific = 0;
all.forEach(function(n){
  var e = _findEXDBEntry(n);
  if(e && Array.isArray(e.cues) && e.cues.length){ specific++; return; }
  var g = _genericCues(n);
  if(!Array.isArray(g) || !g.length || g.some(function(c){ return typeof c !== 'string' || !c.trim(); }))
    fails.push('no text cues for ' + JSON.stringify(n));
});
function nm(n){ var e = _findEXDBEntry(n); return e ? e.name : null; }
function bad(label, n, re){ var r = nm(n); if(r && re.test(r)) fails.push(label + ' — got ' + JSON.stringify(r)); }
bad("'Incline Dumbbell Press' must not resolve to a curl", 'Incline Dumbbell Press', /curl/i);
bad("'Seated Calf Stretch' must not resolve to a raise", 'Seated Calf Stretch', /raise/i);
bad("'Single Leg Stretch' must not resolve to a press", 'Single Leg Stretch', /press/i);
bad("'Press' must not resolve to Bench Press", 'Press', /bench/i);
bad("'Side Plank Dips (Left)' must not resolve to tricep Dips", 'Side Plank Dips (Left)', /^dips$/i);
if(nm('Incline Dumbbell Press') !== 'Incline Dumbbell Press') fails.push('Incline Dumbbell Press has no exact EXDB entry');
if(nm('Dumbbell Bicep Curls') !== 'Dumbbell Bicep Curls') fails.push('Dumbbell Bicep Curls has no exact EXDB entry');
if(!/squat/i.test(nm('Goblet Squat') || '')) fails.push('Goblet Squat lost its squat match');
if(nm('Dumbbell Row') !== 'Dumbbell Rows') fails.push('Dumbbell Row lost its Dumbbell Rows match');
if(nm('Dumbbell Lunges') !== 'Lunges') fails.push('Dumbbell Lunges lost its Lunges match');
[['Pull-Up','Pull-Ups'],['Push-Up','Push-Ups'],['Squats','Squat'],['Dumbbell Flyes','Dumbbell Fly'],['Face Pull','Face Pulls'],['Dip','Dips']].forEach(function(p){
  if(nm(p[0]) !== p[1]) fails.push('singular/plural ' + JSON.stringify(p[0]) + ' should resolve to ' + JSON.stringify(p[1]) + ', got ' + JSON.stringify(nm(p[0])));
});
bad("bare 'Crunch' must not borrow cable-machine cues", 'Crunch', /cable/i);
if(!_hasExerciseGuide('Some Unmapped Move')) fails.push('_hasExerciseGuide false for a non-empty name');
if(_hasExerciseGuide('')) fails.push('_hasExerciseGuide true for an empty name');
JSON.stringify({fails: fails, n: all.length, specific: specific});
"""

def gate_media_fallback(js, html):
    """Offline text fallback for exercise media + honest reminder copy:
    (a) every programme-universe exercise yields text cues (EXDB or generic),
    (b) fuzzy EXDB lookup never crosses movement patterns,
    (c) every self-hosted demo <video>/<img> has an onerror fallback,
    (d) reminder copy makes no background-push promise; dismiss-day is local."""
    ok_all = True
    # (a)+(b) sandboxed lookups over the real programme literals
    pieces = []
    missing_src = []
    for o in ['ULF', 'PPL']:
        src = extract_const_object(js, o)
        if src: pieces.append(src)
        else: missing_src.append(o)
    for a in ['_EX_STEMS', 'LIBRARY_PROGRAMMES', 'WARMUP_MOVES', 'COOLDOWN_STRETCHES', 'HIIT', 'HIIT_TEMPLATES', 'EXDB']:
        src = extract_const_array(js, a)
        if src: pieces.append(src)
        else: missing_src.append(a)
    for fn in ['_exStem', '_findEXDBEntry', '_genericCues', '_hasExerciseGuide']:
        src = extract_decl(js, fn)
        if src: pieces.append(src)
        else: missing_src.append(fn)
    if missing_src:
        print(f'  ✗ could not extract {missing_src}'); ok_all = False
    else:
        out, _ = run_jxa('\n'.join(pieces) + '\n' + MEDIA_FALLBACK_ASSERTIONS)
        try:
            res = json.loads(out)
        except Exception:
            res = None
            print('  ✗ media-fallback runner errored: ' + out); ok_all = False
        if res is not None and res['fails']:
            for f in res['fails'][:20]: print('  ✗ ' + f)
            ok_all = False
        elif res is not None:
            print(f"  ✓ all {res['n']} programme exercises have text cues ({res['specific']} exercise-specific, rest general); fuzzy lookup stays within movement pattern")
    # (c) static: every self-hosted media element falls back on error
    fb = extract_decl(js, '_exFallbackBlockHtml')
    cd = extract_decl(js, '_renderCooldownStretch')
    if not fb or not cd:
        print('  ✗ could not extract _exFallbackBlockHtml / _renderCooldownStretch'); ok_all = False
    else:
        vids = re.findall(r'<video\b[^>]*>', fb)
        imgs = re.findall(r'<img\b[^>]*>', fb)
        cimgs = re.findall(r'<img\b[^>]*>', cd)
        tags_ok = len(vids) >= 1 and len(imgs) >= 2 and len(cimgs) >= 2
        if not tags_ok:
            print(f'  ✗ expected media tags not found (video={len(vids)}, img={len(imgs)}, cooldown img={len(cimgs)})'); ok_all = False
        missing = [t for t in vids + imgs + cimgs if 'onerror=' not in t]
        for t in missing: print('  ✗ media tag without onerror: ' + t[:90])
        if missing: ok_all = False
        elif tags_ok:
            print('  ✓ self-hosted demo <video>/<img> (form guide + cooldown) all have onerror fallbacks')
    # (d) reminder copy honesty + local dismiss day
    bad_copy = [p for p in ['background push coming later', "we'll nudge you", "we\\'ll nudge you"] if p in html]
    if bad_copy:
        print(f'  ✗ dishonest reminder copy still present: {bad_copy}'); ok_all = False
    tdk = extract_decl(js, '_todayDateKey')
    tdk_ok = bool(tdk) and 'toISOString' not in tdk and 'getFullYear' in tdk
    if not tdk_ok:
        print('  ✗ _todayDateKey is not a LOCAL date (missing, uses toISOString, or no getFullYear)'); ok_all = False
    if not bad_copy and tdk_ok:
        print('  ✓ reminder copy is honest (no background-push promise) and dismiss-day is local')
    return ok_all


# ─────────────────────────────────────────────────────────────────────────────
# Gate 10 — Phase 1 session logic (per-set last time, repeat, post-set feedback)
# Pure helpers run in JXA against fixed expectations; the real renderers run
# against adversarial exercise names; and a whole-script lint makes sure no
# `window.X = …` assignment clobbers a top-level function X (in a classic
# script every top-level function IS a window property — that exact bug broke
# the session screen during Phase 1 development: window._sessRestSecs=null
# replaced function _sessRestSecs and the next render threw).
# ─────────────────────────────────────────────────────────────────────────────
PHASE1_FNS = ['_lastSetsFromLog', 'getLastSessionSets', '_fmtKg', '_setDeltaText',
              '_nextOpenSetIdx', '_repeatSetValues', '_nextStepText']

PHASE1_ASSERTIONS = r"""
var fails = [];
function eq(label, got, want){ if(JSON.stringify(got)!==JSON.stringify(want)) fails.push(label+' — got '+JSON.stringify(got)+', want '+JSON.stringify(want)); }
function ok(label, cond){ if(!cond) fails.push(label); }

// ── _lastSetsFromLog ──
eq('per-set weights + reps align', _lastSetsFromLog({reps:[8,8,6], setWeights:[60,62.5,65], weight:65}),
   [{w:60,r:8},{w:62.5,r:8},{w:65,r:6}]);
eq('older rows without setWeights fall back to the top weight', _lastSetsFromLog({reps:[5,5], weight:100}),
   [{w:100,r:5},{w:100,r:5}]);
eq('a zero/missing per-set weight falls back to the top weight', _lastSetsFromLog({reps:[5,5], setWeights:[0], weight:90}),
   [{w:90,r:5},{w:90,r:5}]);
eq('bodyweight reports w:0', _lastSetsFromLog({reps:[12,10], setWeights:[0,0], weight:0, bw:true}),
   [{w:0,r:12},{w:0,r:10}]);
eq('bodyweight keeps added load (BW +10)', _lastSetsFromLog({reps:[8,8], setWeights:[10,12.5], weight:12.5, bw:true}),
   [{w:10,r:8},{w:12.5,r:8}]);
eq('non-numeric reps become null', _lastSetsFromLog({reps:['x',7], weight:20}), [{w:20,r:null},{w:20,r:7}]);
eq('no reps array → []', _lastSetsFromLog({weight:20}), []);
eq('null entry → []', _lastSetsFromLog(null), []);

// ── getLastSessionSets ──
var S = [
  {date:new Date('2026-11-01T10:00:00Z'), setLog:{'Bench Press':{reps:[5,5],setWeights:[80,80],weight:80}}},
  {date:'2026-11-10T10:00:00Z',          setLog:{'Bench Press':{reps:[6,5],setWeights:[82.5,82.5],weight:82.5}}},
  {date:new Date('2026-11-20T10:00:00Z'), setLog:{'Squat':{reps:[5],weight:120}}},
  {date:new Date('2026-11-22T10:00:00Z'), manualActivity:true, setLog:{'Bench Press':{reps:[99],weight:999}}},
  {date:new Date('2026-11-05T10:00:00Z'), setLog:{'Barbell Curl':{reps:[10],weight:30}}}
];
var g = getLastSessionSets(S, ['Bench Press']);
eq('newest matching session wins (Date and ISO dates mixed)', g && g.sets, [{w:82.5,r:6},{w:82.5,r:5}]);
eq('manual activities are ignored', g && g.sets[0].w, 82.5);
eq('alias names are searched', (getLastSessionSets(S, ['Barbell Curls','Barbell Curl'])||{}).sets, [{w:30,r:10}]);
eq('no history → null', getLastSessionSets(S, ['Deadlift']), null);
eq('bad input → null', getLastSessionSets(null, ['x']), null);

// ── _setDeltaText ──
eq('heavier, same reps → up', _setDeltaText({w:82.5,r:8},{w:80,r:8},{}), {text:'+2.5 kg vs last time', dir:'up'});
eq('same weight, more reps → up', _setDeltaText({w:80,r:9},{w:80,r:8},{}), {text:'+1 rep vs last time', dir:'up'});
eq('lighter, fewer reps → down', _setDeltaText({w:77.5,r:6},{w:80,r:8},{}), {text:'−2.5 kg, −2 reps vs last time', dir:'down'});
eq('heavier but fewer reps → mixed', _setDeltaText({w:85,r:6},{w:80,r:8},{}), {text:'+5 kg, −2 reps vs last time', dir:'mixed'});
eq('identical → matched', _setDeltaText({w:80,r:8},{w:80,r:8},{}), {text:'Matched last time (80 kg × 8)', dir:'same'});
eq('float noise is rounded (72.5 vs 70)', _setDeltaText({w:72.5,r:8},{w:70,r:8},{}).text, '+2.5 kg vs last time');
eq('plain bodyweight compares reps', _setDeltaText({w:0,r:12},{w:0,r:10},{bw:true}), {text:'+2 reps vs last time', dir:'up'});
eq('bodyweight + more added load → up', _setDeltaText({w:15,r:8},{w:10,r:8},{bw:true}), {text:'+5 kg vs last time', dir:'up'});
eq('bodyweight + same load → matched with BW +', _setDeltaText({w:10,r:8},{w:10,r:8},{bw:true}).text, 'Matched last time (BW +10 kg × 8)');
eq('timed compares seconds', _setDeltaText({w:0,r:45},{w:0,r:40},{timed:true}), {text:'+5 s vs last time', dir:'up'});
eq('no previous set → new', _setDeltaText({w:80,r:8}, null, {}).dir, 'new');
eq('previous set without reps → new', _setDeltaText({w:80,r:8}, {w:80,r:null}, {}).dir, 'new');

// ── _nextOpenSetIdx ──
eq('first open index', _nextOpenSetIdx([0,1], 4), 2);
eq('fills a gap first', _nextOpenSetIdx([0,2], 4), 1);
eq('all done → -1', _nextOpenSetIdx([0,1,2], 3), -1);
eq('nothing logged → 0', _nextOpenSetIdx(undefined, 3), 0);

// ── _repeatSetValues ──
var LAST = [{w:70,r:8},{w:72.5,r:7},{w:75,r:6}];
eq('set 1 repeats last time\'s set 1', _repeatSetValues(0, {}, {}, LAST, 80, false), {r:8, w:70, src:'last', from:0});
eq('set 2 repeats THIS session\'s set 1', _repeatSetValues(1, {0:6}, {0:85}, LAST, 80, false), {r:6, w:85, src:'session', from:0});
eq('skips an unlogged set to the latest logged one', _repeatSetValues(2, {0:6}, {0:85}, LAST, 80, false), {r:6, w:85, src:'session', from:0});
eq('missing session weight falls back to planned', _repeatSetValues(1, {0:6}, {}, null, 80, false), {r:6, w:80, src:'session', from:0});
eq('plain bodyweight logs w:0', _repeatSetValues(1, {0:12}, {0:0}, null, 0, true), {r:12, w:0, src:'session', from:0});
eq('bodyweight repeat keeps added load (BW +10)', _repeatSetValues(1, {0:8}, {0:10}, null, 10, true), {r:8, w:10, src:'session', from:0});
eq('nothing to repeat → null', _repeatSetValues(0, {}, {}, null, 80, false), null);
eq('no matching set last time → null', _repeatSetValues(3, {}, {}, LAST, 80, false), null);

// ── _nextStepText ──
eq('next set line', _nextStepText({nextSetNo:3, totalSets:4, w:80, reps:'6–8', restSecs:90}), 'Next: set 3 of 4 · 80 kg × 6–8 after 90 s rest');
eq('suggests a heavier weight when given', _nextStepText({nextSetNo:2, totalSets:3, w:80, reps:'6–8', suggestW:82.5}), 'Next: set 2 of 3 · 80 kg × 6–8 (or try 82.5 kg)');
eq('bodyweight next set', _nextStepText({nextSetNo:2, totalSets:3, bw:true, reps:'10–15'}), 'Next: set 2 of 3 · 10–15 reps');
eq('bodyweight + load next set', _nextStepText({nextSetNo:2, totalSets:3, bw:true, w:10, reps:'8–10'}), 'Next: set 2 of 3 · BW +10 kg × 8–10');
eq('exercise done hands off', _nextStepText({nextExName:'Row'}), 'Exercise done · Next: Row');
eq('everything done', _nextStepText({}), 'All exercises done · Finish when ready');

JSON.stringify(fails);
"""

# The real renderers, fed adversarial names. Stubs only what they read.
PHASE1_RENDER_HARNESS = r"""
function mkEl(id){ var e = { id:id, _html:'', textContent:'', style:{}, dataset:{}, attrs:{}, title:'',
  setAttribute:function(k,v){ this.attrs[k]=String(v); }, getAttribute:function(k){ return this.attrs[k]; },
  get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } }; return e; }
var _els = {};
var document = { getElementById: function(id){ return _els[id] || (_els[id] = mkEl(id)); } };
var EVIL = %s;
function _exerciseLookupNames(n){ return [n]; }
function isCoreCircuit(ex){ return false; }
function isTimedExercise(ex){ return false; }
var hiitState = null;
var completedSessions = [{ date:new Date('2026-11-20T10:00:00Z'), setLog:{} }];
var sessExs = EVIL.map(function(n){ return { name:n, sets:3, reps:n, weight:60 }; });
EVIL.forEach(function(n){ completedSessions[0].setLog[n] = { reps:[8,8,8], setWeights:[57.5,57.5,60], weight:60 }; });
var setsDone = {}, repsLogged = {}, setWeights = {}, curIdx = 0;
var out = { bubbles:'', repeat:'', feedback:'' };
for(var i=0;i<EVIL.length;i++){
  curIdx = i; setsDone[i] = [0]; repsLogged[i] = {0:8}; setWeights[i] = {0:60};
  renderBubbles(sessExs[i]); out.bubbles += document.getElementById('setsRow').innerHTML;
  _updRepeatBtn(); var rb = document.getElementById('repeatSetBtn');
  out.repeat += rb.innerHTML + '|' + rb.attrs['aria-label'] + '|';
  window._setFb = { exIdx:i, setIdx:0, delta:{ text:EVIL[i], dir:EVIL[i] }, next:EVIL[i], handoffTo:-1, handoffHead:EVIL[i] };
  _renderSetFeedback(); out.feedback += document.getElementById('setFeedback').innerHTML;
  window._setFb = { exIdx:99, setIdx:0, delta:{ text:'', dir:'' }, next:'', handoffTo:i, handoffHead:EVIL[i] };
  _renderSetFeedback(); out.feedback += document.getElementById('setFeedback').innerHTML;
}
out.lastLabel = (document.getElementById('setsRow').innerHTML.indexOf('last 57.5×8') !== -1);
JSON.stringify(out);
"""

def _phase1_window_shadow(js):
    """window.X = … where X is a top-level `function X(` declaration."""
    top_fns = set(re.findall(r'^function\s+([A-Za-z_$][\w$]*)\s*\(', js, re.M))
    top_fns |= set(re.findall(r'^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(', js, re.M))
    hits = []
    for m in re.finditer(r'window\.([A-Za-z_$][\w$]*)\s*=(?!=)', js):
        name = m.group(1)
        if name in top_fns:
            line = js.count('\n', 0, m.start()) + 1
            rhs = js[m.end():m.end() + 40].strip()
            # Deliberate re-export of the same function (window.f = f) is fine.
            if re.match(re.escape(name) + r'\b', rhs):
                continue
            hits.append(f'script line {line}: window.{name} = … overwrites function {name}()')
    return hits

def gate_phase1_session(js):
    ok_all = True
    pieces, missing = [], []
    for fn in PHASE1_FNS:
        src = extract_decl(js, fn)
        if src: pieces.append(src)
        else: missing.append(fn)
    if missing:
        print(f'  ✗ could not extract function(s): {", ".join(missing)}'); return False
    out, _ = run_jxa('\n'.join(pieces) + '\n' + PHASE1_ASSERTIONS)
    try:
        fails = json.loads(out)
    except Exception:
        fails = ['phase-1 logic runner errored: ' + out[:300]]
    for f in fails: print('  ✗ ' + f)
    if fails: ok_all = False
    else: print('  ✓ last-time per set, delta text, repeat-set values and next-step copy hold (43 cases)')

    # Real renderers vs adversarial names
    rpieces = []
    for fn in PHASE1_FNS + ['esc', 'renderBubbles', '_currLastSets', '_lastSetLabel', '_repeatCandidate',
                            '_updRepeatBtn', '_renderSetFeedback']:
        src = extract_decl(js, fn)
        if not src:
            print(f'  ✗ could not extract function {fn}'); return False
        rpieces.append(src)
    out, _ = run_jxa('var window = this;\n' + '\n'.join(rpieces) + '\n' + (PHASE1_RENDER_HARNESS % json.dumps(EVIL_NAMES)))
    try:
        r = json.loads(out)
    except Exception:
        print('  ✗ phase-1 render runner errored: ' + out[:300]); return False
    rfails = []
    for part in ['bubbles', 'repeat', 'feedback']:
        frag = r[part].replace('|', '')
        if re.search(r'<img', frag, re.I):
            rfails.append(f'{part}: exercise name rendered as a live <img> tag')
        bad = _html_wellformed(frag)
        if bad:
            rfails.append(f'{part}: exercise text breaks out of markup/attribute near {bad[:70]!r}')
        for attr, code in re.findall(r'\son([a-z]+)\s*=\s*"([^"]*)"', frag):
            if not re.fullmatch(_SAFE_CALL + r'(?:;' + _SAFE_CALL + r')*;?', code.strip()):
                rfails.append(f'{part}: on{attr}="{code[:60]}" is not index/dataset-passing')
    if not r.get('lastLabel'):
        rfails.append('set bubbles do not show last time\'s per-set value ("last 57.5×8")')
    if rfails:
        for f in dict.fromkeys(rfails): print('  ✗ ' + f)
        ok_all = False
    else:
        print(f'  ✓ set bubbles, Repeat button and set feedback render {len(EVIL_NAMES)} adversarial names inert')

    hits = _phase1_window_shadow(js)
    if hits:
        for h in hits: print('  ✗ ' + h)
        print('    In a classic script every top-level function is a window property — use another name for state.')
        ok_all = False
    else:
        print('  ✓ no window.X assignment overwrites a top-level function')
    return ok_all


# ─────────────────────────────────────────────────────────────────────────────
# Gate 11 — core-journey accessibility (Session + its dialogs)
# (a) the shared dialog layer really behaves (JXA with a tiny DOM stub):
#     role/aria-modal/labelledby on open, focus in (never into a text field),
#     focus back to the opener on close (or the declared fallback), no focus
#     stealing, Escape only for backdrop-dismissable overlays, Tab trapped.
# (b) static lint of the session screen + the renderers it uses: no clickable
#     div/span, labelled inputs, live regions wired, disclosure state exposed,
#     reduced-motion support intact.
# ─────────────────────────────────────────────────────────────────────────────
DIALOG_FNS = ['_dlgFocusables', '_dlgTop', '_dlgBox', '_dlgOnOpen', '_dlgOnClose', 'closeDialog', '_dlgKeydown']

DIALOG_HARNESS = r"""
var fails = [];
function eq(label, got, want){ if(JSON.stringify(got)!==JSON.stringify(want)) fails.push(label+' — got '+JSON.stringify(got)+', want '+JSON.stringify(want)); }
function ok(label, cond){ if(!cond) fails.push(label); }
var _focused = null, _byId = {}, _dlgSeqN = 0;
function setTimeout(f){ f(); }
function getComputedStyle(el){ return { zIndex: el._z || '200' }; }
function MouseEvent(type, o){ this.type = type; this.bubbles = !!(o && o.bubbles); }
function N(tag, o){
  o = o || {};
  var n = { tagName:tag, id:o.id||'', _cls:{}, attrs:{}, dataset:o.dataset||{}, children:[], parent:null,
    isConnected:true, offsetParent:{}, disabled:false, _z:o.z };
  (o.cls||[]).forEach(function(c){ n._cls[c]=1; });
  Object.keys(o.attrs||{}).forEach(function(k){ n.attrs[k]=o.attrs[k]; });
  n.classList = { contains:function(c){ return !!n._cls[c]; }, add:function(c){ n._cls[c]=1; }, remove:function(c){ delete n._cls[c]; } };
  n.setAttribute = function(k,v){ n.attrs[k]=String(v); if(k==='id') n.id=String(v); };
  n.getAttribute = function(k){ return (k in n.attrs) ? n.attrs[k] : null; };
  n.hasAttribute = function(k){ return k in n.attrs; };
  n.focus = function(){ _focused = n; };
  // Simulates the inline backdrop handler `if(event.target===this)…` firing for a click ON the overlay.
  n.dispatchEvent = function(ev){ if(ev && ev.type === 'click'){ n._clicked = (n._clicked || 0) + 1; var oc = n.attrs.onclick || ''; if(oc.indexOf("this.classList.remove('open')") !== -1) n.classList.remove('open'); if(oc.indexOf('closeCircuitTimer()') !== -1){ n._cleanedUp = true; n.classList.remove('open'); } } return true; };
  n.contains = function(x){ for(var c=x; c; c=c.parent){ if(c===n) return true; } return false; };
  n.closest = function(sel){ var cls = sel.replace('.',''); for(var c=n; c; c=c.parent){ if(c._cls[cls]) return c; } return null; };
  n.add = function(){ for(var i=0;i<arguments.length;i++){ arguments[i].parent=n; n.children.push(arguments[i]); } return n; };
  function walk(f){ var acc=[]; (function rec(x){ x.children.forEach(function(c){ if(f(c)) acc.push(c); rec(c); }); })(n); return acc; }
  function match(c, part){
    part = part.trim();
    if(part === ':scope > .modal') return c.parent===n && !!c._cls.modal;
    if(part === '[id$="Title"]') return /Title$/.test(c.id);
    if(/^h[1-3]$/.test(part)) return c.tagName.toLowerCase()===part;
    if(part === '.modal-title') return !!c._cls['modal-title'];
    if(part === '[data-autofocus]') return 'autofocus' in c.dataset;
    if(part === '.sel') return !!c._cls.sel;
    if(part === '[aria-pressed="true"]') return c.attrs['aria-pressed']==='true';
    return false;
  }
  n.querySelector = function(sel){ var parts = sel.split(','); var r = walk(function(c){ return parts.some(function(p){ return match(c,p); }); }); return r[0] || null; };
  n.querySelectorAll = function(sel){ return walk(function(c){ return /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(c.tagName) || ('tabindex' in c.attrs && c.attrs.tabindex!=='-1'); }); };
  if(n.id) _byId[n.id] = n;
  return n;
}
var body = N('BODY');
var document = {
  body: body,
  get activeElement(){ return _focused || body; },
  getElementById: function(id){ return _byId[id] || null; },
  querySelectorAll: function(sel){ var acc=[]; (function rec(x){ x.children.forEach(function(c){ if(c._cls['modal-ov'] && c._cls.open) acc.push(c); rec(c); }); })(body); return acc; }
};

// Page: an opener button, a fallback button, two overlays.
var opener = N('BUTTON', {id:'opener'}), nextBtn = N('BUTTON', {id:'nextBtn'}), other = N('BUTTON', {id:'other'});
var title = N('DIV', {id:'repModTitle'}), wMinus = N('BUTTON'), rep6 = N('BUTTON', {cls:['rep-btn','sel'], attrs:{'aria-pressed':'true'}}), inp = N('INPUT', {id:'repCustom'}), logB = N('BUTTON');
var box = N('DIV', {cls:['modal']}).add(title, wMinus, rep6, inp, logB);
var rep = N('DIV', {id:'repMod', cls:['modal-ov'], dataset:{returnFallback:'nextBtn'}, attrs:{onclick:"if(event.target===this)this.classList.remove('open')"}}).add(box);
var fin = N('DIV', {id:'finMod', cls:['modal-ov']}).add(N('DIV', {cls:['modal']}).add(N('BUTTON')));
var onlyInput = N('DIV', {cls:['modal']}).add(N('DIV', {id:'noteTitle'}), N('TEXTAREA'));
var note = N('DIV', {id:'noteMod', cls:['modal-ov'], attrs:{onclick:"if(event.target===this)this.classList.remove('open')"}}).add(onlyInput);
var timerMod = N('DIV', {id:'circuitTimerMod', cls:['modal-ov'], attrs:{onclick:"if(event.target===this)closeCircuitTimer()"}}).add(N('DIV', {cls:['modal']}).add(N('BUTTON')));
var innerBtn = N('BUTTON', {id:'addExBtn'});
var sheet = N('DIV', {id:'customProgMod', cls:['modal-ov'], attrs:{onclick:"if(event.target===this)this.classList.remove('open')"}}).add(N('DIV', {cls:['modal']}).add(N('DIV', {id:'cpTitle'}), innerBtn, N('BUTTON')));
var picker = N('DIV', {id:'customExPickerMod', cls:['modal-ov'], z:'300', attrs:{onclick:"if(event.target===this)this.classList.remove('open')"}}).add(N('DIV', {cls:['modal']}).add(N('BUTTON'), N('BUTTON')));
body.add(opener, nextBtn, other, rep, fin, note, timerMod, sheet, picker);

// 1. open → semantics + focus on the selected rep (not the text field)
opener.focus(); rep.classList.add('open'); _dlgOnOpen(rep);
eq('dialog role on open', box.getAttribute('role'), 'dialog');
eq('aria-modal on open', box.getAttribute('aria-modal'), 'true');
eq('labelled by its title', box.getAttribute('aria-labelledby'), 'repModTitle');
ok('focus moves to the selected option', _focused === rep6);
// 2. Tab trap
_focused = logB; var prevented = false;
_dlgKeydown({key:'Tab', shiftKey:false, preventDefault:function(){ prevented = true; }});
ok('Tab on the last control wraps to the first', prevented && _focused === wMinus);
_dlgKeydown({key:'Tab', shiftKey:true, preventDefault:function(){}});
ok('Shift+Tab on the first control wraps to the last', _focused === logB);
// 3. Escape closes a backdrop-dismissable dialog and focus returns to the opener
_dlgKeydown({key:'Escape', preventDefault:function(){}});
ok('Escape closes a backdrop-dismissable overlay', !rep.classList.contains('open'));
_dlgOnClose(rep);
ok('focus returns to the opener on close', _focused === opener);
// 4. opener re-rendered away → declared fallback
opener.focus(); rep.classList.add('open'); _dlgOnOpen(rep); opener.isConnected = false;
closeDialog('repMod'); _dlgOnClose(rep);
ok('detached opener → focus goes to data-return-fallback', _focused === nextBtn);
opener.isConnected = true;
// 5. never steal focus the app moved elsewhere
opener.focus(); rep.classList.add('open'); _dlgOnOpen(rep); other.focus();
rep.classList.remove('open'); _dlgOnClose(rep);
ok('does not steal focus moved outside the dialog', _focused === other);
// 6. Escape leaves overlays without backdrop-dismiss alone
opener.focus(); fin.classList.add('open'); _dlgOnOpen(fin);
_dlgKeydown({key:'Escape', preventDefault:function(){}});
ok('Escape does not dismiss a non-dismissable overlay', fin.classList.contains('open'));
fin.classList.remove('open'); _dlgOnClose(fin);
// 7. a dialog with only a text field does not auto-focus it (mobile keyboard)
opener.focus(); note.classList.add('open'); _dlgOnOpen(note);
ok('text field is not auto-focused on open', _focused === opener);
note.classList.remove('open'); _dlgOnClose(note);
// 8. Escape runs the overlay's own close handler (its cleanup), not a bare class strip
opener.focus(); timerMod.classList.add('open'); _dlgOnOpen(timerMod);
_dlgKeydown({key:'Escape', preventDefault:function(){}});
ok('Escape routes through the overlay\'s own close handler (cleanup runs)', timerMod._cleanedUp === true && !timerMod.classList.contains('open'));
_dlgOnClose(timerMod);
// 9. a picker stacked on an open sheet: closing it returns focus INTO the sheet
opener.focus(); sheet.classList.add('open'); _dlgOnOpen(sheet); innerBtn.focus();
picker.classList.add('open'); _dlgOnOpen(picker);
picker.classList.remove('open'); _dlgOnClose(picker);
ok('closing a stacked picker returns focus to its opener inside the still-open sheet', _focused === innerBtn);
sheet.classList.remove('open'); _dlgOnClose(sheet);
ok('closing the sheet then returns focus to the page opener', _focused === opener);
JSON.stringify(fails);
"""

SESSION_RENDERERS = ['renderBubbles', 'renderWarmupBubbles', 'renderCoreCircuit', 'renderSessionExerciseList',
                     'openRepInput', '_updRepeatBtn', 'renderRestLenPicker', '_renderSetFeedback']
# Clickable non-buttons allowed on the session screen, with the reason.
SESSION_DIV_ONCLICK_ALLOW = {
    'miniPlateViz': 'aria-hidden duplicate of the "Plate guide" button beside it',
}

def gate_core_a11y(html, js):
    ok_all = True
    pieces, missing = [], []
    for fn in DIALOG_FNS:
        src = extract_decl(js, fn)
        if src: pieces.append(src)
        else: missing.append(fn)
    if missing:
        print(f'  ✗ could not extract dialog function(s): {", ".join(missing)}'); ok_all = False
    else:
        out, _ = run_jxa('\n'.join(pieces) + '\n' + DIALOG_HARNESS)
        try:
            fails = json.loads(out)
        except Exception:
            fails = ['dialog runner errored: ' + out[:300]]
        for f in fails: print('  ✗ ' + f)
        if fails: ok_all = False
        else: print('  ✓ dialogs: role/aria-modal/label, focus in, Tab trap, Escape via own handler, focus return + fallback, stacked, no stealing')
    # Must be STARTED, not just declared (`function _initDialogA11y(){` itself contains "_initDialogA11y()").
    if not re.search(r"(?<!function )(?<!function)\b_initDialogA11y\(\)\s*;|addEventListener\('DOMContentLoaded',\s*_initDialogA11y\)", js):
        print('  ✗ _initDialogA11y is never started'); ok_all = False

    lint = []
    m1, m2 = html.find('id="s-active"'), html.find('id="s-game"')
    sess = html[m1:m2] if m1 != -1 and m2 != -1 else ''
    if not sess:
        lint.append('could not find the #s-active markup')
    for m in re.finditer(r'<(div|span)\b[^>]*\sonclick=', sess):
        tag = sess[m.start():sess.find('>', m.start()) + 1]
        idm = re.search(r'\sid="([^"]+)"', tag)
        if not (idm and idm.group(1) in SESSION_DIV_ONCLICK_ALLOW):
            lint.append(f'session markup has a clickable <{m.group(1)}> (use a <button>): {tag[:90]}')
    for fn in SESSION_RENDERERS:
        src = extract_decl(js, fn) or ''
        if not src:
            lint.append(f'could not extract session renderer {fn}'); continue
        for m in re.finditer(r'<(div|span)\b[^>`]*\sonclick=', src):
            lint.append(f'{fn}() renders a clickable <{m.group(1)}> (use a <button>): {src[m.start():m.start()+80]}')
    # labelled inputs: session screen + rep dialog
    rm1 = html.find('id="repMod"'); rm2 = html.find('<!-- FINISH MODAL -->', rm1)
    scope = sess + (html[rm1:rm2] if rm1 != -1 and rm2 != -1 else '')
    for m in re.finditer(r'<(input|select|textarea)\b[^>]*>', scope):
        tag = m.group(0)
        if re.search(r'type="hidden"', tag) or re.search(r'\saria-label(?:ledby)?="[^"]+"', tag):
            continue
        idm = re.search(r'\sid="([^"]+)"', tag)
        if not idm or f'for="{idm.group(1)}"' not in scope:
            lint.append(f'unlabelled form field: {tag[:80]}')
    # live regions / announcements
    if not re.search(r'id="sessLive"[^>]*aria-live="polite"', html) and not re.search(r'aria-live="polite"[^>]*id="sessLive"', html):
        lint.append('#sessLive polite live region is missing')
    if not re.search(r'id="setFeedback"[^>]*role="status"', html):
        lint.append('#setFeedback is not a role=status region')
    if re.search(r'id="restNum"[^>]*aria-live', html):
        lint.append('#restNum is a live region — it would announce every tick')
    for fn in ['startRest', 'showPRAlert']:
        if '_sessAnnounce(' not in (extract_decl(js, fn) or ''):
            lint.append(f'{fn}() does not announce via _sessAnnounce')
    # disclosure state
    if not re.search(r'id="sessMoreBtn"[^>]*aria-expanded="false"[^>]*aria-controls="sessMoreBody"', html):
        lint.append('#sessMoreBtn lacks aria-expanded/aria-controls="sessMoreBody"')
    if not re.search(r'id="sessMoreBody"[^>]*\shidden\b', html):
        lint.append('#sessMoreBody is not hidden by default')
    if "setAttribute('aria-expanded'" not in (extract_decl(js, '_sessMoreSet') or ''):
        lint.append('_sessMoreSet() does not update aria-expanded')
    # reduced motion stays honoured
    if not re.search(r'@media\s*\(prefers-reduced-motion:\s*reduce\)', html):
        lint.append('prefers-reduced-motion CSS block is gone')
    if 'prefers-reduced-motion' not in (extract_decl(js, 'toggleSessMore') or ''):
        lint.append('toggleSessMore() smooth-scrolls without checking prefers-reduced-motion')
    if lint:
        for f in lint: print('  ✗ ' + f)
        ok_all = False
    else:
        print('  ✓ session screen: buttons not clickable divs, labelled fields, live regions, disclosure state, reduced motion')
    return ok_all


def main():
    html = read_index()
    js = inline_script(html)
    print('Max Gainz checks:')
    print('[1/11] parse')
    p = gate_parse(js)
    print('[2/11] invariants')
    inv = gate_invariants(js)
    print('[3/11] video map')
    vm = gate_videomap(js)
    print('[4/11] inline handler wiring')
    wi = gate_wiring(html, js)
    print('[5/11] auth log hygiene')
    au = gate_authlogs(js)
    print('[6/11] sign-out scrub')
    sc = gate_logout_scrub(js)
    print('[7/11] safe rendering of user text')
    sr = gate_safe_render(html, js)
    print('[8/11] sync honesty')
    sy = gate_sync(js)
    print('[9/11] media fallback + reminder copy')
    mf = gate_media_fallback(js, html)
    print('[10/11] Phase 1 session logic (last time, repeat, feedback)')
    ps = gate_phase1_session(js)
    print('[11/11] core-journey accessibility (session + dialogs)')
    ca = gate_core_a11y(html, js)
    print()
    if p and inv and vm and wi and au and sc and sr and sy and mf and ps and ca:
        print('✅ ALL CHECKS PASSED'); return 0
    print('❌ CHECKS FAILED'); return 1

if __name__ == '__main__':
    sys.exit(main())
