#!/usr/bin/env python3
"""Mutation check for gate 34 (app/sync.js). Plants one bug at a time — in the
module (re-bundled, so only the standalone scenarios can catch it) or in the
bundle itself — and asserts gate_sync_module FAILS for each, and PASSES on the
real tree. Usage: python3 tools/mutate_sync.py"""
import os, sys, shutil, tempfile, io, contextlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tests')); sys.path.insert(0, os.path.join(ROOT, 'tools'))
import check, bundle

SRC = open(os.path.join(ROOT, 'app/sync.js'), encoding='utf-8').read()
HTML = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()

# (name, old, new) applied to app/sync.js, then re-bundled
MODULE_MUTANTS = [
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

def run(html, root):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): ok = check.gate_sync_module(html, check.inline_script(html), root)
    return ok, buf.getvalue()

def tree(src):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, 'app')); os.makedirs(os.path.join(d, 'tools'))
    shutil.copy(os.path.join(ROOT, 'tools/bundle.py'), os.path.join(d, 'tools/bundle.py'))
    open(os.path.join(d, 'app/sync.js'), 'w', encoding='utf-8').write(src)
    return d

def main():
    bad = 0
    ok, out = run(HTML, ROOT)
    print(('✓' if ok else '✗') + ' real tree passes'); bad += not ok
    if not ok: print(out)
    for name, old, new in MODULE_MUTANTS:
        if SRC.count(old) != 1: print(f'✗ {name}: anchor not found exactly once'); bad += 1; continue
        src = SRC.replace(old, new)
        html = bundle.region_re('app/sync.js').sub(lambda _: bundle.begin('app/sync.js') + '\n' + src + bundle.end('app/sync.js'), HTML, count=1)
        d = tree(src)
        try: ok, out = run(html, d)
        finally: shutil.rmtree(d)
        print(('✓ caught' if not ok else '✗ MISSED') + ': ' + name); bad += ok
    # bundle-level mutants (module file unchanged)
    end = bundle.end('app/sync.js')
    html_mutants = [
        ('region edited by hand (drift)', HTML.replace('var _syncBackoff = 0;', 'var _syncBackoff = 1;', 1)),
        ('function re-declared in index.html', HTML.replace(end, end + '\nfunction flushPending(){ return Promise.resolve(true); }', 1)),
        ('var re-declared in index.html', HTML.replace(end, end + "\nvar PENDING_KEY = 'maxgainz_pending_v2';", 1)),
    ]
    for name, html in html_mutants:
        ok, out = run(html, ROOT)
        print(('✓ caught' if not ok else '✗ MISSED') + ': ' + name); bad += ok
    print('ALL MUTANTS CAUGHT' if not bad else f'{bad} problem(s)')
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
