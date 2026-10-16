#!/usr/bin/env node
// Max Gainz: build www/ for the Capacitor native shell.
//
//   npm run prepare-www        (then: npx cap sync ios)
//
// Copies exactly what index.html loads from its own origin into www/
// (Capacitor's webDir). It has no dependencies and changes nothing on the
// web: Netlify still publishes the repo root as-is. www/ is gitignored.
//
// Three steps:
//   1. Copy the files in WEB_FILES into a fresh www/ (skipping dotfiles).
//   2. Check that every relative src/href/poster in index.html's markup,
//      and the service-worker path, exists in www/. Exit 1 if anything is
//      missing, so CI stops before building an app with broken assets.
//   3. Bundle ID: capacitor.config.json "appId" is the one place to change
//      it. If the Xcode project disagrees, its PRODUCT_BUNDLE_IDENTIFIER is
//      rewritten to match, because `npx cap sync` never updates it.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');

// Everything the page loads locally. Add new local assets here.
const WEB_FILES = [
  'index.html',
  'native-bridge.js', // window.MGNative, loaded by a <script> tag in <head>
  'sw.js',            // registered on the web; WKWebView has no service workers
  'icon.png',
  'exercise-media',   // self-hosted demo frames and loops (EX_MEDIA_BASE)
];

function fail(msg) {
  console.error('prepare-www: ' + msg);
  process.exit(1);
}

// ── 1. Copy ──────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const rel of WEB_FILES) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) fail('missing ' + rel + ' in the repo root');
  cpSync(src, join(OUT, rel), {
    recursive: true,
    filter: (p) => !basename(p).startsWith('.'), // .DS_Store and friends
  });
}

// ── 2. Check local references ───────────────────────────────────────────
const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const refs = new Set();
for (const m of html.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])([^"']*)\1/g)) refs.add(m[2]);
for (const m of html.matchAll(/serviceWorker\.register\(\s*(["'])([^"']+)\1/g)) refs.add(m[2]);

const isLocal = (u) =>
  u && !u.includes('${') && !u.startsWith('#') && !u.startsWith('//') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(u); // http:, https:, data:, blob:, mailto:, javascript: ...

const missing = [];
let checked = 0;
for (const u of refs) {
  if (!isLocal(u)) continue;
  const path = decodeURIComponent(u.split(/[?#]/)[0]).replace(/^\.?\//, '');
  if (!path || path.startsWith('api/')) continue; // Netlify functions are not files
  checked++;
  if (!existsSync(join(OUT, path))) missing.push(u);
}
if (!existsSync(join(OUT, 'exercise-media'))) missing.push('exercise-media/');
if (missing.length) fail('index.html references files that are not in www/: ' + missing.join(', '));

// ── 3. Keep the Xcode bundle ID in step with capacitor.config.json ───────
const config = JSON.parse(readFileSync(join(ROOT, 'capacitor.config.json'), 'utf8'));
const pbxPath = join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj');
if (existsSync(pbxPath)) {
  const pbx = readFileSync(pbxPath, 'utf8');
  const re = /PRODUCT_BUNDLE_IDENTIFIER = ("?)([^";\n]+)\1;/g;
  const found = [...pbx.matchAll(re)].map((m) => m[2]);
  if (found.length === 0) fail('no PRODUCT_BUNDLE_IDENTIFIER in ' + pbxPath);
  if (found.some((id) => id !== config.appId)) {
    writeFileSync(pbxPath, pbx.replace(re, 'PRODUCT_BUNDLE_IDENTIFIER = ' + config.appId + ';'));
    console.log('prepare-www: Xcode bundle ID ' + [...new Set(found)].join(', ') + ' -> ' + config.appId +
      ' (from capacitor.config.json; commit ios/App/App.xcodeproj/project.pbxproj)');
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
let files = 0, bytes = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
  }
})(OUT);
console.log('prepare-www: www/ ready: ' + files + ' files, ' + (bytes / 1048576).toFixed(1) +
  ' MB; ' + checked + ' local references in index.html all present.');
