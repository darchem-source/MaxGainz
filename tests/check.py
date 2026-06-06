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
    for fn in ['getRank', 'getPrestigeStars', '_sessionXP', '_weekKey',
               'getMaxWeeklySessions', 'calcWeekStreak', 'getLongestWeekStreak', '_localYMD',
               '_sessionKey', '_mergeSessions', '_validateSession']:
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
