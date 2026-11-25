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

Usage:  python3 tools/bundle.py          rewrite the regions from app/
        python3 tools/bundle.py --check  exit 1 if any region differs (gate 33)
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')
MODULES = ['app/rollout.js', 'app/sync.js', 'app/session.js']   # load order = order in the page

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
    return probs

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
        r = region_re(m)
        if not r.search(html): sys.exit(f'{m}: add the BEGIN/END markers to index.html first')
        html = r.sub(lambda _: begin(m) + '\n' + src + end(m), html, count=1)
    with open(INDEX, 'w', encoding='utf-8') as f: f.write(html)
    print('bundled ' + ', '.join(MODULES))
    return 0

if __name__ == '__main__':
    sys.exit(main())
