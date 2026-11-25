#!/usr/bin/env python3
"""Mutation check for the module gates (34: app/sync.js, 35: app/session.js).
Plants one bug at a time — in a module (re-bundled, so only that gate's
standalone scenarios can catch it) or in the bundle itself — and asserts the
gate FAILS for each, and PASSES on the real tree.
Usage: python3 tools/mutate_modules.py [app/sync.js|app/session.js]"""
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
]

def _html_mutants(m, html):
    end = bundle.end(m)
    if m == 'app/sync.js':
        return [('region edited by hand (drift)', html.replace('var _syncBackoff = 0;', 'var _syncBackoff = 1;', 1)),
                ('function re-declared in index.html', html.replace(end, end + '\nfunction flushPending(){ return Promise.resolve(true); }', 1)),
                ('var re-declared in index.html', html.replace(end, end + "\nvar PENDING_KEY = 'maxgainz_pending_v2';", 1))]
    return [('region edited by hand (drift)', html.replace('let _pendingRPE=null;', 'let _pendingRPE=0;', 1)),
            ('function re-declared in index.html', html.replace(end, end + '\nfunction calc1RM(w, r){ return w; }', 1)),
            ('var re-declared in index.html', html.replace(end, end + '\nvar _activeSessionOwner = null;', 1))]

GATES = {'app/sync.js': ('gate_sync_module', SYNC_MUTANTS), 'app/session.js': ('gate_session_module', SESSION_MUTANTS)}

def run(gate, html, root):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): ok = getattr(check, gate)(html, check.inline_script(html), root)
    return ok, buf.getvalue()

def tree(m, src):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, 'app')); os.makedirs(os.path.join(d, 'tools'))
    shutil.copy(os.path.join(ROOT, 'tools/bundle.py'), os.path.join(d, 'tools/bundle.py'))
    open(os.path.join(d, m), 'w', encoding='utf-8').write(src)
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
