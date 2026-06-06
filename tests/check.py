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
               '_comebackEvents', '_measureDelta']:
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

def main():
    html = read_index()
    js = inline_script(html)
    print('Max Gainz checks:')
    print('[1/2] parse')
    p = gate_parse(js)
    print('[2/2] invariants')
    inv = gate_invariants(js)
    print()
    if p and inv:
        print('✅ ALL CHECKS PASSED'); return 0
    print('❌ CHECKS FAILED'); return 1

if __name__ == '__main__':
    sys.exit(main())
