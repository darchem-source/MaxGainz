#!/usr/bin/env python3
"""Inline the app/ modules into index.html (Priority 7: incremental extraction).

The app ships as ONE file on purpose: the service worker caches the page, and a
page that needs a second file could open offline without it (an older worker
caches the new page but not the new file) and fail to start. So modules are
edited and tested as real files in app/, and copied into marked regions of
index.html:

    // ==== BEGIN MODULE app/rollout.js — generated: edit app/rollout.js, then run python3 tools/bundle.py ====
    ...exact file contents...
    // ==== END MODULE app/rollout.js ====

A module listed in ALSO_INTO is also copied into a region of each named file
(the AI validators into netlify/functions/ai/core.mjs).

Usage:  python3 tools/bundle.py          rewrite the regions from app/
        python3 tools/bundle.py --check  exit 1 if any region differs (gate 33)
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')
MODULES = ['app/rollout.js', 'app/sync.js', 'app/session.js', 'app/ai-validators.js', 'app/ai.js']   # load order = order in the page
# Modules that are ALSO copied into a marked region of another file. The AI
# validators run on the server too (core.mjs), so both copies come from one file.
ALSO_INTO = {'app/ai-validators.js': ['netlify/functions/ai/core.mjs']}

def begin(m): return f'// ==== BEGIN MODULE {m} — generated: edit {m}, then run python3 tools/bundle.py ===='
def end(m): return f'// ==== END MODULE {m} ===='

def region_re(m):
    return re.compile(re.escape(begin(m)) + r'\n([\s\S]*?)' + re.escape(end(m)))

def read(p):
    with open(p, encoding='utf-8') as f: return f.read()

def bundled(html):
    """{module: inlined text} for every module region present."""
    out = {}
    for m in MODULES:
        r = region_re(m).search(html)
        out[m] = r.group(1) if r else None
    return out

def drift(html, root=ROOT):
    """Problems (strings) — empty when every region equals its file."""
    probs = []
    regions = bundled(html)
    for m in MODULES:
        src = read(os.path.join(root, m))
        if not src.endswith('\n'): src += '\n'
        if regions[m] is None: probs.append(f'{m}: no BEGIN/END region in index.html')
        elif regions[m] != src: probs.append(f'{m}: index.html is out of date — run python3 tools/bundle.py')
        if html.count(begin(m)) != 1 or html.count(end(m)) != 1: probs.append(f'{m}: region markers must appear exactly once')
        for other in ALSO_INTO.get(m, []):
            op = os.path.join(root, other)
            if not os.path.exists(op): probs.append(f'{m}: {other} missing'); continue
            ot = read(op); r = region_re(m).search(ot)
            if not r: probs.append(f'{m}: no BEGIN/END region in {other}')
            elif r.group(1) != src: probs.append(f'{m}: {other} is out of date — run python3 tools/bundle.py')
            if ot.count(begin(m)) != 1 or ot.count(end(m)) != 1: probs.append(f'{m}: region markers must appear exactly once in {other}')
    return probs

def _write_region(text, m, src, where):
    r = region_re(m)
    if not r.search(text): sys.exit(f'{m}: add the BEGIN/END markers to {where} first')
    return r.sub(lambda _: begin(m) + '\n' + src + end(m), text, count=1)

def main():
    html = read(INDEX)
    if '--check' in sys.argv:
        p = drift(html)
        for x in p: print('✗ ' + x)
        if not p: print('✓ index.html matches ' + ', '.join(MODULES))
        return 1 if p else 0
    for m in MODULES:
        src = read(os.path.join(ROOT, m))
        if not src.endswith('\n'): src += '\n'
        html = _write_region(html, m, src, 'index.html')
        for other in ALSO_INTO.get(m, []):
            op = os.path.join(ROOT, other)
            out = _write_region(read(op), m, src, other)
            with open(op, 'w', encoding='utf-8') as f: f.write(out)
    with open(INDEX, 'w', encoding='utf-8') as f: f.write(html)
    print('bundled ' + ', '.join(MODULES))
    return 0

if __name__ == '__main__':
    sys.exit(main())
