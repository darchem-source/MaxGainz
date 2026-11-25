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

   Modules are bundled in `MODULES` order: the first at the very top of the script, each next one directly after the previous region.

4. **Gate 34 checks `app/sync.js`:** region equals the file, nothing it declares is declared again in `index.html`, no DOM or toasts. It then loads the file on its own in `jsc`: first bare (load time must not call into `index.html`), then with hand-written stubs for browser APIs, `sbFetch` and the documented run-time dependencies, and runs the queue scenarios (per-account normalisation, dequeue only on confirmed success, a failed weight upsert stays queued, `on_conflict=user_id,exercise_name` on every `custom_weights` upsert, keyset paging, merge, stash). `python3 tools/mutate_sync.py` plants bugs and confirms the gate catches each one; run it whenever the gate or the module changes.

### Run-time vs load-time dependencies

A module may call functions or read state that still live in `index.html` **when its functions run**, never while the script loads. Every such dependency is listed in the module's header comment; the standalone test stubs exactly those.

The other gates still read the whole page, so every existing test keeps covering the moved code.

Never edit inside a region by hand. Gate 33 fails, and the next `bundle.py` run overwrites the edit.

## Order (from the next-priorities brief)

| # | Module | Status |
|---|---|---|
| 1 | Rollout and configuration registry: `app/rollout.js` (registry, `APP_VERSION`, every flag key, URL switch and flag function, nav migration rules, AI beta plan) | **Done**, build 2026.11.25.9 |
| 2 | Sync and pending-operation queue: `app/sync.js` (pending queue `maxgainz_pending_v1`, `_P`, `flushPending`, retry/backoff, `_uploadSession`, stash, `cloudSave*`/`cloudDeleteSession`/`cloudLoadAll`, keyset paging, `_sessionKey` + `_mergeSessions`). UI that drives it (`retrySync`, `confirmSignOut`, re-auth, save toasts, the status line) stays in `index.html`. Run-time dependencies on `index.html` are listed at the top of the file | **Done**, build 2026.11.25.10 |
| 3 | Active-session state machine and renderers | Next |
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
