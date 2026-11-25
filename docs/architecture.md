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

4. **Gate 34 checks `app/sync.js`:** region equals the file, nothing it declares is declared again in `index.html`, no DOM or toasts. It then loads the file on its own in `jsc`: first bare (load time must not call into `index.html`), then with hand-written stubs for browser APIs, `sbFetch` and the documented run-time dependencies, and runs the queue scenarios (per-account normalisation, dequeue only on confirmed success, a failed weight upsert stays queued, `on_conflict=user_id,exercise_name` on every `custom_weights` upsert, keyset paging, merge, stash). `python3 tools/mutate_modules.py` plants bugs and confirms the gate catches each one; run it whenever a module gate or module changes.

5. **Gate 35 checks `app/session.js`** the same way (region, no duplicate declarations, no DOM), then loads it in `jsc` with nothing but a console stub and runs its scenarios: the state's empty shape at load, last-time sets, set delta, repeat-set, next-step text, Epley 1RM, the cooldown picker and trained groups.

6. **Gate 36 checks the AI modules:** both `app/ai-validators.js` regions (in `index.html` and in `core.mjs`) equal the file, no validator is declared again in either host, the validators stay pure (they run on the server), and `app/ai.js` has no DOM. The validators then run on their own with only a console; `app/ai.js` runs with `app/rollout.js` (its documented earlier-module dependency), the validators and stubs for the gate order, consent and notes, pain, grounding, the 401 retry, timeout, server consent-off, beta enrolment and the local stores.

7. **Gate 37 checks `app/rules.js`:** region, no duplicate declarations, pure (no storage, network or app state). It loads alone with only a console, then with `app/session.js`, and runs the rules: the session contract, the weight repair, the rank ladder, XP and comeback, week keys and streaks (also under `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles`, because this Mac sits at UTC+0 in winter, where a UTC bug would be invisible), weight steps, the adaptive engine's main rules, rotation, recency, balance, measurements and next-day ranking.

A module listed in `ALSO_INTO` is copied into a marked region of each named file as well. Editing that region by hand fails gate 33 (drift) and gate 36.

### Run-time vs load-time dependencies

A module may call functions or read state that still live in `index.html` **when its functions run**, never while the script loads. Every such dependency is listed in the module's header comment; the standalone test stubs exactly those.

The other gates still read the whole page, so every existing test keeps covering the moved code.

Never edit inside a region by hand. Gate 33 fails, and the next `bundle.py` run overwrites the edit.

## Order (from the next-priorities brief)

| # | Module | Status |
|---|---|---|
| 1 | Rollout and configuration registry: `app/rollout.js` (registry, `APP_VERSION`, every flag key, URL switch and flag function, nav migration rules, AI beta plan) | **Done**, build 2026.11.25.9 |
| 2 | Sync and pending-operation queue: `app/sync.js` (pending queue `maxgainz_pending_v1`, `_P`, `flushPending`, retry/backoff, `_uploadSession`, stash, `cloudSave*`/`cloudDeleteSession`/`cloudLoadAll`, keyset paging, `_sessionKey` + `_mergeSessions`). UI that drives it (`retrySync`, `confirmSignOut`, re-auth, save toasts, the status line) stays in `index.html`. Run-time dependencies on `index.html` are listed at the top of the file | **Done**, build 2026.11.25.10 |
| 3 | Active-session state, pure parts: `app/session.js` (declarations of the running workout's state; last-time sets, set delta, repeat-set, next-step text, `calc1RM`, `_buildCooldown`, `_sessionTrainedGroups`) | **Done (pure parts)**, build 2026.11.25.11 |
| 3b | Active-session transitions: `app/session.js` gains `_resetSessionLog` (all four start paths), `_recordSetValues` (rep dialog, typed sets, repeat set, swipe-to-log), `_markSetDone`, `_buildSessionRecord` (what `finishSession` saves; its old code unchanged inside, inputs passed in) and `_sessionPhase`. A refactor, not a move: proven equal to the old code by a differential run over 3,000 random workouts. Timers, DOM, XP, saving and the timed / core-circuit / AMRAP set paths stay in `index.html` | **Done**, build 2026.11.25.14 |
| 4 | AI validation and client: `app/ai-validators.js` is the **one source** of the validators, bundled into both `index.html` and `netlify/functions/ai/core.mjs` (`ALSO_INTO` in `tools/bundle.py`); `app/ai.js` holds consent merge, the call gate, `_aiCall` / `_aiPost`, the local audit and metrics stores, beta enrolment and the server consent sync. UI stays in `index.html` (consent toggles, intro cards, AI health HTML, every AI surface) | **Done**, build 2026.11.25.12 |
| 5 | Data contracts and pure training rules: `app/rules.js` (`_validateSession`, `_normalizeSessionWeights`, `_localYMD`; ranks, prestige, session XP, comeback bonus; week keys and streaks; weight steps, rep targets and the adaptive coaching engine `getLiftState`; rotation; recency and muscle-balance verdict; measurement deltas; next-path-day ranking). All pure; depends only on `calc1RM` from `app/session.js`. Glue that gathers app state (`buildLiftHistory`, `_calcMuscleGroupShare`, achievement checks) stays in `index.html` | **Done**, build 2026.11.25.13 |
| 6 | Step A (this release): `sw.js` precaches every module and serves `/app/*.js` network-first per version with an offline fallback (`MODULE_CAPS` tells the page); `/app/*` is `no-cache` on Netlify. Data moved out for later file loading: `app/media.js` (`EX_GIF_MAP`, `EX_MEDIA_FILES`, `EX_VIDEO_MAP`; `tests/gen_media_manifest.py` now writes there) and `app/profile-icons.js` (`PROFILE_ICONS`, ~140 KB), both `LAZY_CANDIDATES` in `tools/bundle.py`. Step B (load them as files) is **not shipped** — see below | **Step A done**, build 2026.11.25.15 |

### Rules for each slice

- Move code without changing it. Compare the lines before and after; only comments and markers may be added.
- Bump `APP_VERSION`.
- Make the module self-contained, or give it an explicit, documented dependency on an earlier module.
- Run `python3 tests/check.py`. All gates must stay green.
- Replace inline `on…=` handlers in any surface the slice touches.

8. **Gate 38 checks the module files:** `sw.js` `MODULE_FILES` equals `MODULES`, is precached (`SHELL.push`), and `CACHE_NAME` was bumped; the real `sw.js` runs in `jsc` (install precache, network-first per version, older versions dropped, offline exact/install-copy/504, server errors not cached, only same-origin GETs of `/app/*.js`, `MODULE_CAPS`); `/app/*` is `no-cache`; lazy candidates are data only and load with no globals; and the page does **not** load module files yet.

## When the page can load modules as files

Loading modules as separate files is what would actually shrink the initial page. It needs a service-worker release first that:

- precaches every module;
- serves `/app/` network-first, keyed by a version query, with a cached fallback.

That release has to be **live and activated** before any page that needs those files ships. Otherwise the offline-start problem above returns. Plan it as its own release with a two-step rollout.

### Status (slice 6)

**Step A shipped in build 2026.11.25.15** (`sw.js` with `CACHE_NAME = 'maxgainz-v4'`). Step B may ship only after that worker is live **and activated** on the devices that matter (users accept the "Update available" banner, or the app is fully closed and reopened). To check a device: in the console, post `{type:'MODULE_CAPS'}` to `navigator.serviceWorker.controller` with a `MessageChannel`; it answers with the module list.

Step B, when you decide to ship it:
1. Start with `app/profile-icons.js` (only the profile picture picker and avatar use it). Remove its region from `index.html`, add `app/profile-icons.js` to a new `LOAD_AS_FILES` list in `tools/bundle.py`, and load it with `<script src="app/profile-icons.js?v=<APP_VERSION>" defer>` (or lazily when the picker opens). Make the avatar renderer fall back to the emoji when `PROFILE_ICONS` is not defined yet.
2. Change gate 38's "page does not load module files" check to allow exactly `LOAD_AS_FILES`.
3. Media manifests (`app/media.js`) are needed in a workout offline: only move them once step A has been live for a while, and load them before the session screen can open.
