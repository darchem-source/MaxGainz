# Architecture: moving out of the single file

Max Gainz ships as one `index.html` of about 31,000 lines. That stays true for users: the service worker caches the page, and a page that needs a second file can open offline without it. For example, an older worker caches the new page but not the new file, and the app then fails to start in the gym.

So code moves out **for editing and testing**, not for loading.

## How a module works

1. **Write the code in `app/<name>.js`.** It is a classic script, so its top-level declarations are shared globals exactly as before. It must not touch the DOM at load time.
2. **Run `python3 tools/bundle.py`.** This copies each file in `tools/bundle.py: MODULES` into a marked region at the very top of the page's script:

   ```
   // ==== BEGIN MODULE app/rollout.js — generated: edit app/rollout.js, then run python3 tools/bundle.py ====
   ...exact file contents...
   // ==== END MODULE app/rollout.js ====
   ```

3. **Gate 33 checks the result:**
   - the region equals the file;
   - the module is at the top;
   - nothing it declares is declared again elsewhere;
   - no flag key appears in code outside it.

   It also loads the module file on its own, with only browser-API stubs and no HTML parsing, and runs its tests there.

The other gates still read the whole page, so every existing test keeps covering the moved code.

Never edit inside a region by hand. Gate 33 fails, and the next `bundle.py` run overwrites the edit.

## Order (from the next-priorities brief)

| # | Module | Status |
|---|---|---|
| 1 | Rollout and configuration registry: `app/rollout.js` (registry, `APP_VERSION`, every flag key, URL switch and flag function, nav migration rules, AI beta plan) | **Done**, build 2026.11.25.9 |
| 2 | Sync and pending-operation queue: `_P`, `flushPending`, `_mergeSessions`, the pending queue, keyset paging | Next |
| 3 | Active-session state machine and renderers | |
| 4 | AI consent, validation and client: share validators with `netlify/functions/ai/core.mjs` from one file instead of keeping two byte-identical copies | |
| 5 | Data contracts and pure training rules: progression, rotation, PB and XP derivation | |
| 6 | Lower-priority screens and media manifests: these are the candidates for loading later, once a service-worker change makes extra files safe | |

### Rules for each slice

- Move code without changing it. Compare the lines before and after; only comments and markers may be added.
- Bump `APP_VERSION`.
- Make the module self-contained, or give it an explicit, documented dependency on an earlier module.
- Run `python3 tests/check.py`. All gates must stay green.
- Replace inline `on…=` handlers in any surface the slice touches.

## When the page can load modules as files

Loading modules as separate files is what would actually shrink the initial page. It needs a service-worker release first that:

- precaches every module;
- serves `/app/` network-first, keyed by a version query, with a cached fallback.

That release has to be **live and activated** before any page that needs those files ships. Otherwise the offline-start problem above returns. Plan it as its own release with a two-step rollout.
