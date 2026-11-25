#!/usr/bin/env python3
"""Mutation check for the module gates (34: app/sync.js, 35: app/session.js,
36: app/ai-validators.js + app/ai.js, 37: app/rules.js).
Plants one bug at a time — in a module (re-bundled, so only that gate's
standalone scenarios can catch it) or in the bundle itself — and asserts the
gate FAILS for each, and PASSES on the real tree.
Usage: python3 tools/mutate_modules.py [app/sync.js|app/session.js|app/ai-validators.js|app/ai.js|app/rules.js]"""
import os, sys, shutil, tempfile, io, contextlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tests')); sys.path.insert(0, os.path.join(ROOT, 'tools'))
import check, bundle

HTML = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()

# (name, old, new) applied to the module file, then re-bundled
SYNC_MUTANTS = [
    ('queue not scoped to the account', "raw.userId !== userId) return _emptyPending(userId);", ") return _emptyPending(userId);"),
    ('_P() ignores an account switch', "if(!_pending || _pending.userId !== uid){", "if(!_pending){"),
    ('weight dequeued even when the upsert failed', "    if(res !== null){\n      if(p.weights[name] === weight){ delete p.weights[name]; _savePending(); }",
        "    delete p.weights[name]; _savePending();\n    if(res !== null){\n      if(p.weights[name] === weight){ delete p.weights[name]; _savePending(); }"),
    ('weight dequeued regardless of a newer local value', "if(p.weights[name] === weight){ delete p.weights[name]; _savePending(); }", "{ delete p.weights[name]; _savePending(); }"),
    ('flush dequeues a delete before it is confirmed', "      if(r === null){ ok = false; continue; }\n      const i = p.deletes.indexOf(id);",
        "      const i = p.deletes.indexOf(id);"),
    ('weight upsert without on_conflict', "const res = await sbFetch('custom_weights?on_conflict=user_id,exercise_name', {\n    method: 'POST',\n    silent: !!(opts && opts.silent),\n    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },\n    body: JSON.stringify({\n      user_id: uid,\n      exercise_name: name,",
        "const res = await sbFetch('custom_weights', {\n    method: 'POST',\n    silent: !!(opts && opts.silent),\n    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },\n    body: JSON.stringify({\n      user_id: uid,\n      exercise_name: name,"),
    ('profile upsert without on_conflict', "const res = await sbFetch('custom_weights?on_conflict=user_id,exercise_name', {\n    method: 'POST',\n    silent: !!(opts && opts.silent),\n    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },\n    body: JSON.stringify({\n      user_id: uid,\n      exercise_name: '__profile__',",
        "const res = await sbFetch('custom_weights?on_conflict=user_id', {\n    method: 'POST',\n    silent: !!(opts && opts.silent),\n    extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },\n    body: JSON.stringify({\n      user_id: uid,\n      exercise_name: '__profile__',"),
    ('failed write schedules no retry', "  _syncRetryTimer = setTimeout(() => {", "  if(false) _syncRetryTimer = setTimeout(() => {"),
    ('flush reports synced while work is left', "  if(_pendingCount() > 0){\n    setSyncStatus(_lastSyncError", "  if(false){\n    setSyncStatus(_lastSyncError"),
    ('keyset paging stops after one page', "    if(chunk.length < pageSize) return _sortSessionRows(rows);", "    return _sortSessionRows(rows);"),
    ('partial page list accepted', "    if(!Array.isArray(chunk)) return null;", "    if(!Array.isArray(chunk)) return _sortSessionRows(rows);"),
    ('merge drops local-only sessions', "    if(!(k in byKey)) byKey[k] = Object.assign({}, s, { _needsUpload: true });", ""),
    ('stash restored into another account', "if(!uid || !all || typeof all !== 'object' || !all[uid]) return 0;\n  const st = all[uid];",
        "if(!uid || !all || typeof all !== 'object') return 0;\n  const st = all[uid] || all[Object.keys(all)[0]]; if(!st) return 0;"),
    ('load-time call into index.html', "var _pending = null;", "var _pending = lsGet(PENDING_KEY, null);"),
    ('module renders DOM', "function _P(){", "function _P(){ if(0) document.title = '';"),
]

SESSION_MUTANTS = [
    ('state starts non-empty', "let rpeLogged={};", "let rpeLogged={0:{}};"),
    ('last time includes manual activities', "if(!s || !s.setLog || s.manualActivity) continue;", "if(!s || !s.setLog) continue;"),
    ('last time picks the oldest session', "if(!(t > bestT)) continue;", "if(t > bestT && best) continue;"),
    ('per-set weights ignored', "const w = wi > 0 ? wi : top;", "const w = top;"),
    ('delta direction inverted', "if((dw > 0 && dr >= 0) || (dw === 0 && dr > 0)) dir = 'up';", "if((dw > 0 && dr >= 0) || (dw === 0 && dr > 0)) dir = 'down';"),
    ('delta compares reps the wrong way', "const dr = Number(cur.r) - Number(prev.r);", "const dr = Number(prev.r) - Number(cur.r);"),
    ('next open set off by one', "for(let i = 0; i < (Number(sets) || 0); i++) if(!d.includes(i)) return i;", "for(let i = 1; i < (Number(sets) || 0); i++) if(!d.includes(i)) return i;"),
    ('repeat ignores this session', "  for(let j = setIdx - 1; j >= 0; j--){", "  for(let j = setIdx - 1; j >= setIdx; j--){"),
    ('next-step drops the rest time', "  if(Number(i.restSecs) > 0) t += ' after ' + i.restSecs + ' s rest';", ""),
    ('1RM formula wrong', "return weight * (1 + reps / 30);", "return weight * (1 + reps / 40);"),
    ('cooldown ignores trained volume', "const v = (weights && typeof weights[g] === 'number' && weights[g] > 0) ? weights[g] : 1;", "const v = 1;"),
    ('cooldown repeats a stretch', "if(!used.has(cand.slug)){ used.add(cand.slug); out.push(cand); taken++; }", "{ out.push(cand); taken++; }"),
    ('trained groups ignore what was logged', "if((setsDone[i]||[]).length > 0){ add(ex.name); any = true; }", "add(ex.name); any = true;"),
    ('load-time call into index.html', "let sessStartTime = null;", "let sessStartTime = getSplits('x');"),
    ('module touches the DOM', "function calc1RM(weight, reps){", "function calc1RM(weight, reps){ if(0) document.title = '';"),
    # slice 3b transitions
    ('start keeps last workout\'s timestamps', "warmupDone = {}; equipOverride = {}; setWeights = {}; setTimestamps = {};", "warmupDone = {}; equipOverride = {}; setWeights = {};"),
    ('start keeps the set count', "_pendingRPE = null; totalSets = 0; sessTimeSec = 0;", "_pendingRPE = null; sessTimeSec = 0;"),
    ('RPE wiped by callers that do not manage it', "  if(rpe === undefined) return;\n", ""),
    ('cleared RPE kept', "  else delete rpeLogged[exIdx][setIdx];", ""),
    ('re-marking a set counts it twice', "  if(isNew){ setsDone[exIdx].push(setIdx); totalSets++; }", "  setsDone[exIdx].push(setIdx); totalSets++;"),
    ('completion time overwritten', "  if(setTimestamps[exIdx][setIdx] === undefined) setTimestamps[exIdx][setIdx] = nowMs;", "  setTimestamps[exIdx][setIdx] = nowMs;"),
    ('finished workout still reported active', "  return finalized === true ? 'finished' : 'active';", "  return 'active';"),
    ('saved weight is the planned one', "      const _exW = _loggedW.length ? Math.max(..._loggedW) : _exWPlanned;", "      const _exW = _exWPlanned;"),
    ('volume ignores the rep fallback', "        const r=rl[s]||parseInt((ex.reps||'8').split('–')[0])||8;", "        const r=rl[s]||0;"),
    ('bodyweight in top lifts', "    .filter(([, e]) => !e.bw && e.weight > 0)", "    .filter(([, e]) => e.weight > 0)"),
    ('duration rounds to zero', "  const dMin=Math.max(1,Math.round(sessTimeSec/60));", "  const dMin=Math.round(sessTimeSec/60);"),
]

AI_VALIDATOR_MUTANTS = [
    ('every number counts as grounded', "const bad = _aiNumbersIn(text).filter(n => !(allowed || []).some(a => Math.abs(a - n) < 1e-6));", "const bad = _aiNumbersIn(text).filter(n => false);"),
    ('thousands separator split into two numbers', ".replace(/(\\d),(\\d{3})(?!\\d)/g, '$1$2');", ";"),
    ('pain no longer detected', "return /\\b(pain\\w*|hurt\\w*|", "return /\\b(hurt\\w*|"),
    ('markup allowed in coach notes', "!/[<>{}`\\\\\\u0000-\\u001f]/.test(s);", "true;"),
    ('extra fact keys accepted', "  return k.length === keys.length && keys.every(", "  return k.length >= keys.length && keys.every("),
    ('coach tip may omit the new weight', "if((D.action === 'increase' || D.action === 'deload') && D.to !== D.from && _aiNumbersIn(out.text).indexOf(D.to) === -1) return { ok:false, reason:'missing target' };", ""),
    ('medical advice allowed', "    if(unsafe(out.text)) return { ok:false, reason:'medical' };\n    const D = f.decision;", "    const D = f.decision;"),
    ('typed set may name an unlisted exercise', "      if(ids.indexOf(s.ex) === -1) return { ok:false, reason:'exercise' };", ""),
    ('typed set may invent a unit', "      if((s.unit === 'lb' && !saidLb) || (s.unit === 'kg' && !saidKg)) return { ok:false, reason:'unit' };", ""),
    ('validators read the clock (not pure)', "function _aiNum(v, lo, hi, isInt){", "function _aiNum(v, lo, hi, isInt){ if(0) Date.now();"),
]

AI_CLIENT_MUTANTS = [
    ('no consent needed', "  if(!x.consented) return 'off';", ""),
    ('signed-out calls allowed', "  if(!x.signedIn) return 'signed_out';", ""),
    ('daily cap ignored', "  if(x.capped) return 'cap';", ""),
    ('notes sent without the notes consent', "if(task === 'coach' && facts && facts.note !== null && facts.note !== undefined && !prefs.notes){", "if(false){"),
    ('facts not checked before sending', "    if(factErr) return fallback(factErr === 'pain' ? 'pain' : 'invalid');", ""),
    ('server answer not checked', "    if(!chk.ok) return fallback('invalid', Object.assign({ out: null, check: String(chk.reason || '').slice(0, 30) }, meta));", ""),
    ('expired token not refreshed', "        if(refreshed === true) continue;", ""),
    ('timeout ignored', "      if(!res || timedOut){", "      if(!res){"),
    ('server consent-off not followed', "      if(reason === 'off') _aiAdoptServerOff();", ""),
    ('consent tie turns AI on', "  if(!l.on) return l;\n  if(!c.on) return c;", ""),
    ("store keeps another account's entries", "o.v !== 1 || o.uid !== uid) return fresh;", "o.v !== 1) return fresh;"),
    ('failure export leaks the answer text', "      events: (e.events || [])", "      out: e.out, events: (e.events || [])"),
    ("consent sync sent for another account", "  if(!q || q.uid !== _aiUid()) return;", "  if(!q) return;"),
    ('beta members not enrolled', "      Object.keys(AI_FLAG_KEYS).forEach(k => localStorage.setItem(AI_FLAG_KEYS[k], '1'));", ""),
    ('load-time call into index.html', "const AI_BETA_SURFACES = ['coach', 'nl', 'recap'];", "const AI_BETA_SURFACES = isAuthenticated() ? [] : ['coach', 'nl', 'recap'];"),
    ('module touches the DOM', "function _aiHash(str){", "function _aiHash(str){ if(0) document.title = '';"),
]

RULES_MUTANTS = [
    ('bad dates accepted', "  if(isNaN(d)) return null;\n  const num", "  const num"),
    ('negative numbers kept', "const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;", "const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;"),
    ('validator mutates its input', "  const out = Object.assign({}, s);\n  out.date = d;", "  const out = s;\n  out.date = d;"),
    ('RPE outside 1–10 kept', "(typeof v === 'number' && v >= 1 && v <= 10) ? v : null", "(typeof v === 'number') ? v : null"),
    ('weight repair uses the planned weight', "        const top = Math.max(...sw);", "        const top = e.weight;"),
    ('weight repair touches manual activities', "    if(!s || s.manualActivity || !s.setLog || typeof s.setLog !== 'object') return;", "    if(!s || !s.setLog || typeof s.setLog !== 'object') return;"),
    ('rank boundary off by one', "  for(let i=RANKS.length-1;i>=0;i--) if(xp>=RANKS[i].min) return RANKS[i];", "  for(let i=RANKS.length-1;i>=0;i--) if(xp>RANKS[i].min) return RANKS[i];"),
    ('rank ladder gap', "{name:'First Steps',     emoji:'👟', min:250,", "{name:'First Steps',     emoji:'👟', min:260,"),
    ('prestige rounds up', "  return Math.floor((xp - top.min) / PRESTIGE_STEP);", "  return Math.ceil((xp - top.min) / PRESTIGE_STEP);"),
    ('20-set bonus dropped', "  if(sets >= 20) xp += 25;", ""),
    ('comeback counts manual activities', "    .filter(s => !s.manualActivity)\n", ""),
    ('week key in UTC', "  dt.setHours(0,0,0,0);\n  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back to Monday", "  dt.setUTCHours(0,0,0,0);\n  dt.setDate(dt.getDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday"),
    ('longest streak ignores gaps', "    else run=1;", ""),
    ('streak needs 2 sessions, not 3', "    if((weeks[key]||0)>=3) streak++;", "    if((weeks[key]||0)>=2) streak++;"),
    ('step up skips a plate', "    const next = steps.find(s => s > current);", "    const next = steps.find(s => s > current + 2.5);"),
    ('rep target uses the low end', "    if(!isNaN(lo) && !isNaN(hi)) return Math.round((lo + hi) / 2);", "    if(!isNaN(lo) && !isNaN(hi)) return lo;"),
    ('no gap deload', "  if(thisSession === null && weeksAway != null && weeksAway >= 4){", "  if(false){"),
    ('gap deload too gentle', "      const pct = weeksAway < 6 ? 0.15 : weeksAway < 8 ? 0.20 : 0.25;", "      const pct = 0.05;"),
    ('top of range does not add weight', "    out.rule='A_topRange'; out.action='increase'; out.suggested=stepUp;", "    out.rule='A_topRange'; out.action='increase'; out.suggested=baseline;"),
    ('rotation never returns to the original', "  return idx === 0 ? null : pool[idx - 1];", "  return pool[idx % pool.length];"),
    ('recency curve shifted', "  if(weeksAgo<=2) return 1.0;", "  if(weeksAgo<=1) return 1.0;"),
    ('critical imbalance missed', "  if(loPct<10){status='critical-low';level=3;", "  if(loPct<1){status='critical-low';level=3;"),
    ('measurement change from the wrong end', "  const first = vals[0][field], latest = vals[vals.length-1][field];", "  const first = vals[vals.length-1][field], latest = vals[0][field];"),
    ('fried muscles not demoted', "          if(s >= 0.35){ hard = true; warned.push(g); }", ""),
    ('load-time call', "const PRESTIGE_STEP = 25000;", "const PRESTIGE_STEP = calc1RM(25000, 0);"),
    ('rules read storage', "function _localYMD(d){", "function _localYMD(d){ if(0) localStorage.getItem('x');"),
]

def _html_mutants(m, html):
    end = bundle.end(m)
    if m == 'app/sync.js':
        return [('region edited by hand (drift)', html.replace('var _syncBackoff = 0;', 'var _syncBackoff = 1;', 1)),
                ('function re-declared in index.html', html.replace(end, end + '\nfunction flushPending(){ return Promise.resolve(true); }', 1)),
                ('var re-declared in index.html', html.replace(end, end + "\nvar PENDING_KEY = 'maxgainz_pending_v2';", 1))]
    if m == 'app/ai-validators.js':
        return [('region edited by hand (drift)', html.replace('function _aiNum(v, lo, hi, isInt){', 'function _aiNum(v, lo, hi, isInt){ ', 1)),
                ('validator re-declared in index.html', html.replace(end, end + '\nfunction _aiGrounded(){ return { ok:true, bad:[] }; }', 1))]
    if m == 'app/ai.js':
        return [('region edited by hand (drift)', html.replace('const AI_CLIENT_DAILY_CALLS = 30;', 'const AI_CLIENT_DAILY_CALLS = 300;', 1)),
                ('function re-declared in index.html', html.replace(end, end + '\nasync function _aiCall(){ return { ok:true }; }', 1)),
                ('const re-declared in index.html', html.replace(end, end + "\nconst AI_PREFS_KEY = 'x';", 1))]
    if m == 'app/rules.js':
        return [('region edited by hand (drift)', html.replace('const COMEBACK_XP = 100;', 'const COMEBACK_XP = 1000;', 1)),
                ('function re-declared in index.html', html.replace(end, end + '\nfunction getRank(xp){ return RANKS[0]; }', 1)),
                ('const re-declared in index.html', html.replace(end, end + '\nconst RANK_TIERS = [];', 1))]
    return [('region edited by hand (drift)', html.replace('let _pendingRPE=null;', 'let _pendingRPE=0;', 1)),
            ('function re-declared in index.html', html.replace(end, end + '\nfunction calc1RM(w, r){ return w; }', 1)),
            ('var re-declared in index.html', html.replace(end, end + '\nvar _activeSessionOwner = null;', 1))]

GATES = {'app/sync.js': ('gate_sync_module', SYNC_MUTANTS), 'app/session.js': ('gate_session_module', SESSION_MUTANTS),
         'app/ai-validators.js': ('gate_ai_module', AI_VALIDATOR_MUTANTS), 'app/ai.js': ('gate_ai_module', AI_CLIENT_MUTANTS),
         'app/rules.js': ('gate_rules_module', RULES_MUTANTS)}

def run(gate, html, root):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): ok = getattr(check, gate)(html, check.inline_script(html), root)
    return ok, buf.getvalue()

def tree(m, src):
    """A temp root with every module, the bundler and core.mjs; `m` replaced by
    `src` and re-bundled into any extra target (core.mjs for the validators)."""
    d = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, 'app'), os.path.join(d, 'app'))
    os.makedirs(os.path.join(d, 'tools'))
    shutil.copy(os.path.join(ROOT, 'tools/bundle.py'), os.path.join(d, 'tools/bundle.py'))
    os.makedirs(os.path.join(d, 'netlify/functions/ai'))
    shutil.copy(os.path.join(ROOT, 'netlify/functions/ai/core.mjs'), os.path.join(d, 'netlify/functions/ai/core.mjs'))
    open(os.path.join(d, m), 'w', encoding='utf-8').write(src)
    for other in bundle.ALSO_INTO.get(m, []):
        op = os.path.join(d, other)
        txt = open(op, encoding='utf-8').read()
        open(op, 'w', encoding='utf-8').write(bundle.region_re(m).sub(lambda _: bundle.begin(m) + '\n' + src + bundle.end(m), txt, count=1))
    return d

def check_module(m):
    gate, mutants = GATES[m]
    src0 = open(os.path.join(ROOT, m), encoding='utf-8').read()
    bad = 0
    ok, out = run(gate, HTML, ROOT)
    print(f'{m}: ' + ('✓' if ok else '✗') + ' real tree passes'); bad += not ok
    if not ok: print(out)
    for name, old, new in mutants:
        if src0.count(old) != 1: print(f'  ✗ {name}: anchor not found exactly once'); bad += 1; continue
        src = src0.replace(old, new)
        html = bundle.region_re(m).sub(lambda _: bundle.begin(m) + '\n' + src + bundle.end(m), HTML, count=1)
        d = tree(m, src)
        try: ok, out = run(gate, html, d)
        finally: shutil.rmtree(d)
        print(('  ✓ caught' if not ok else '  ✗ MISSED') + ': ' + name); bad += ok
    if m == 'app/ai-validators.js':
        d = tree(m, src0)
        try:
            cp = os.path.join(d, 'netlify/functions/ai/core.mjs')
            txt = open(cp, encoding='utf-8').read()
            open(cp, 'w', encoding='utf-8').write(txt.replace("reason:'missing target'", "reason:'missing'", 1))
            ok, out = run(gate, HTML, d)
        finally: shutil.rmtree(d)
        print(('  ✓ caught' if not ok else '  ✗ MISSED') + ': server copy (core.mjs) edited by hand'); bad += ok
    for name, html in _html_mutants(m, HTML):
        if html == HTML: print(f'  ✗ {name}: anchor not found'); bad += 1; continue
        ok, out = run(gate, html, ROOT)
        print(('  ✓ caught' if not ok else '  ✗ MISSED') + ': ' + name); bad += ok
    return bad

def main():
    mods = [a for a in sys.argv[1:] if a in GATES] or list(GATES)
    bad = sum(check_module(m) for m in mods)
    print('ALL MUTANTS CAUGHT' if not bad else f'{bad} problem(s)')
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
