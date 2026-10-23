# Max Gainz: App Review audit (read-only)

Auditor: App Review auditor agent · 16 Oct 2026
Scope: `/home/claude/darchem-source/maxgainz` (git checkout of `main`, a shallow clone with one commit, `55e347a` "Merge dashboard summary publisher into main"). Nothing in the repo was modified.
Line numbers are for `index.html` unless another file is named.
"UNCONFIRMED" means it could not be verified from the repo or from public sources reachable from this sandbox.

Cross-reference: `decisions.md` in this folder. That file says a 1-week trial is followed by a hard paywall, the developer is a UK Ltd organisation, Apple Health is out of v1, and ExerciseDB media is used only if its licence allows. Several findings below change those plans. They are marked **[affects decisions.md]**.

---

## Summary

| Severity | Count | Items |
|---|---|---|
| Blocker | 6 | B1 account deletion · B2 privacy policy / support missing · B3 exercise-media IP · B4 ExerciseDB media terms · B5 auth email links have no native path · B6 developer/test UI shown to users |
| Likely rejection | 8 | R1–R8 |
| Breaks in the native shell | 18 | N1–N18 |
| Polish / lower risk | 12 | P1–P12 |

---

## 1) Blockers

### B1. Account deletion does not delete the account (5.1.1(v))
- **What:** `deleteUserAccount()` (23667–23695) deletes `sessions` (23673) and `custom_weights` (23676) rows, which includes the `__profile__` and `__dashboard__` rows because they live in `custom_weights`. It then calls `POST /auth/v1/logout` (23679). **It never deletes the Supabase auth user.** `/auth/v1/logout` only revokes the refresh token. The email, the password hash and the `auth.users` row all survive, so the user can sign in again to an empty account. The client cannot delete an auth user with the anon key, and nothing server-side does it. The code has no `/functions/v1/`, no RPC and no `admin` call.
- **Other problems in the same flow:**
  - Every result is ignored. `sbFetch` returns `null` on failure (3740–3743, 3746–3752) and never throws, so a failed or timed-out DELETE still shows "Account deleted — all your data has been removed" (23688). The code then calls `localStorage.clear()` (23690), which wipes the only other copy. If the token has expired, `sbFetch` tries one refresh and returns `null` (3718–3736), and the false success message still appears.
  - `feedback` rows are not deleted. They can hold `user_id`, `user_email`, the message and a base64 screenshot (23774–23782). RLS gives `feedback` no select or delete policy (rls_owner_only.sql 72–79), so the client could not delete them even if it tried.
  - `confirmFinalDelete()` (23660–23665) uses `confirm()` with text saying "Type your email to confirm", but `confirm()` has no text field. The prompt is misleading.
  - `localStorage.clear()` also clears device-level settings (theme, units). That is harmless, but worth knowing.
- **"Send Email & Delete Account" (`sendDataEmail`, 23612–23649):** No email is ever sent. The comment at 23624–23625 says "In a real app, you'd call a backend function… For now, we'll simulate success". The code triggers a CSV download via `<a download>` and then reports "✅ Data prepared! File downloaded. Now deleting your account...". Labels that promise an email: modal text 24224 ("Would you like us to email your workout data"), 24226 "📧 Email Data & Delete", 24237–24238 "Email Your Data / We'll send your complete workout history to your email address", button 24241 "Send Email & Delete Account", and the Settings blurb 1206. In WKWebView `<a download>` with a blob URL does nothing (see N10), so on iOS the user gets no file and no email, yet sees a success message. The CSV (`generateSessionsCSV`, 23651–23658) also covers only a few session columns. It leaves out the set logs, body weight, measurements, notes, profile and custom programmes.
- **Where user data lives (inventory for a complete deletion design):**

| Store | What | Written by | Deleted today? |
|---|---|---|---|
| Supabase `auth.users` (+ `auth.identities`, `auth.sessions`, `auth.refresh_tokens`) | email, password hash, sign-in metadata | `authSignup` 23276 | **No** |
| `public.sessions` | every workout and manual activity: date, day name, exercise count, duration, volume, `top_lifts`, `set_log` (per-exercise sets/reps/weights, per-set weights, equipment override, **free-text exercise note**, rest seconds, RPE; built at 11086), activity type and emoji, intensity, XP | `cloudSaveSession` 3764 | Yes, but unchecked |
| `public.custom_weights` normal rows | working weight per exercise | `cloudSaveWeight` 3793 | Yes, but unchecked |
| `public.custom_weights` row `__profile__` (`notes` = JSON blob) | `userProfile` (first and last name, email, preferred name, gender, **date of birth**, height, weight, **profile photo as a full-resolution base64 data URL** from camera or library with no resizing (22872–22895), avatar id, `onboarding` = experience level, body weight, equipment, **injury history**, previous lifts, goal, frequency, sports background, **age**, gender), `todayProg`, custom workouts, custom HIITs, current path and path history, **body-weight log**, **body measurements (chest, waist, arms, thighs, hips; 16243)**, **daily free-text notes**, onboarded flag, PB tiles, preferences | `cloudSaveProfile` 3813–3859 | Yes, as part of the custom_weights delete, unchecked |
| `public.custom_weights` row `__dashboard__` (`notes` = JSON) | first name, plan and schedule, today's status, headline stats, muscle-balance summary; read by a separate "file://" landing page | `cloudSaveDashboardSummary` 24081–24097 (comment 23886–23893) | Yes, as part of the custom_weights delete. `_dashDisabled` (23668) stops it being re-created afterwards |
| `public.feedback` | `user_id`, `user_email` (unless "Submit anonymously"), category, location, message, `image_data` (base64 screenshot, up to 5 MB), `image_filename` | `submitFeedback` 23763–23828 | **No**, and RLS forbids it from the client |
| Netlify function logs / RapidAPI logs | request metadata for `/api/edb-video` (IP, exercise id) | `edb-video.mjs` | Not user-linked; mention it in the privacy policy only |
| Supabase platform logs | API and auth logs (IP, user agent, user id) | platform | Retention is set by Supabase; mention it in the privacy policy |
| Device `localStorage` | `maxgainz_v1` (sessions, weights, profile, body weight, measurements, notes, plus the `userId` stamp), `maxgainz_auth` (**access and refresh tokens**), `maxgainz_cloud_user` (email), `maxgainz_custom`, `maxgainz_custom_hiits`, `maxgainz_path`, `maxgainz_pathHistory`, `maxgainz_pbLifts`, `maxgainz_pending_name` / `_email` (read 23386 but **never written**, so dead code), plus about 15 UI and preference keys (`userWeightUnit`, `userSpeedUnit`, `userRunnerLevel`, `userDemoSex`, `userAudioEnabled`, `maxgainz_trackRPE`, `_periodize`, `_rotateExercises`, `_onboarded`, `_path_skipped`, `_fg_seen`, `_progSections`, `_reminderDismissed`, `_ladder_v2_seen`, `appTheme`, `plateBarWt`, `progSubTab`) | throughout | `localStorage.clear()` 23690 |
| Service-worker Cache Storage | HTML shell, fonts, Lottie script (no user data) | sw.js | Not needed |

- **Fix intent:** Add a server-side delete, for example a Supabase Edge Function or a `security definer` RPC restricted to `auth.uid()`. It should delete the `feedback` rows for the user's id or email, the `custom_weights` rows, the `sessions` rows and the auth user (via `auth.admin.deleteUser` with the service role, which stays server-side). It must return success only when everything worked. The app should show success only on a confirmed response and clear local data afterwards, and should explain that subscriptions are cancelled separately in Apple settings. Either remove the "email" wording or actually send the email. Replace the CSV download with the native share/save path from N10. Note for post_fix_checks.sql check 4: once auth users are deleted, orphan rows must be zero.
- **[affects decisions.md]** The plan says users can "delete their account" after the trial. That is only true once this is fixed.

### B2. No privacy policy, terms or support link anywhere in the app (5.1.1(i), 5.1.2, 3.1.2, 1.5)
- **What:** A case-insensitive grep for privacy, terms, support@, contact us, mailto:, legal, EULA, disclaimer and medical advice found only base64 noise inside the icon blobs (lines 9 and 470). There is no privacy policy, terms, support or contact link. The only contact route is in-app feedback, which is stored in a table nobody is notified about.
- **Misleading claims shown to users:**
  - 24215 (auth screen): "Your data is encrypted and private. Only you can see your workouts." This is only defensible if the RLS in section 5 is confirmed live. "Encrypted" can only mean TLS in transit plus Supabase's at-rest encryption; there is no end-to-end encryption. The `__dashboard__` row is read by Max's own landing page using the user's own sign-in (comment 23890), so it is not public. Either way, a reviewer reads this as a privacy representation that the missing privacy policy has to back up.
  - 1148 (Profile, "How we use this info"): "All data is saved locally on your device". This is **false** for signed-in users, and everyone is signed in (R1). Profile, body weight, measurements, photo and notes are all uploaded (B1 table).
- **Where links fit:**
  1. The auth screen footer at 24215, next to or replacing the encryption line: "By creating an account you agree to the Terms and Privacy Policy".
  2. Profile → "SETTINGS & DATA" block (1152–1189), after "📬 Send Feedback" (1188): "Privacy Policy", "Terms of Use", "Support / Contact".
  3. Inside the "ℹ️ How we use this info" box (1143–1150), with the text corrected.
  4. The paywall (per decisions.md).
- **Fix intent:** Publish a privacy policy, terms and a support page on the company site (decisions.md already plans this). Link them from all four places, and fix the two claims above.

### B3. Self-hosted exercise media has no rights chain (5.2.1, 5.2.2)
- **What:** `exercise-media/` has 143 folders. Each holds `0.jpg` and `1.jpg` (about 17 MB in total, mostly 850×567). 32 folders also hold a `loop.mp4` (about 104 MB in total). The repo contains no README, licence or attribution file. The only provenance is in code comments:
  - 14387–14390 says "Self-hosted demo media (public-domain free-exercise-db frames, mirrored into this repo)".
  - 14690–14693 says "free-exercise-db id (public domain / Unlicense)".
  - 147 says "self-hosted public-domain images".
- **The "public domain" claim does not hold up.** The free-exercise-db repo is yuhonas/free-exercise-db, built on wrkout/exercises.json. It is Unlicensed, but its maintainer has written publicly about the images: *"I actually have no idea where the images are from or if they are royalty free so usage would be at your own risk"* (yuhonas/free-exercise-db issue #2). In issue #13 ("images has copyright?") other users say the images "are a huge problem" and suggest some come from ExRx.net. The Unlicense covers the repo's own work. It cannot grant rights in photos the author did not own. I looked at frames visually: `Ab_Crunch_Machine/0.jpg` is a studio photo with a model and a visible **Nautilus** brand logo on the machine, and `Barbell_Curl/0.jpg` is the same style of studio shoot. These are professional photos of identifiable people. Ownership and model releases are UNCONFIRMED.
- **The 32 `loop.mp4` files are a separate and worse problem.**
  - The comment at 14652–14654 calls them a "wger.de CC-BY-SA overlay". It says "Empty until the overlay ships", yet 32 IDs are listed (14655–14688) and all 32 exist on disk.
  - Every clip carries the visible caption "**Video: Goulart · CC BY-SA 4.0 · wger.de**" (14909), the same name for all 32.
  - ffprobe shows all 32 were exported through Apple Core Media between 10:17 and 10:18 on 2026-08-18 (the `creation_time` tags). 31 are 8.0 s long and one is 7.6 s, but frame rates are mixed (60, 59.94, 30, 29.97, 29.93 and 29.84 fps). Each has a stereo AAC track with **real ambient audio** (mean −23 to −29 dB, peaks up to −0.5 dB) and Apple `com.apple.quicktime.detected-face` metadata. One clip (`Barbell_Bench_Press_-_Medium_Grip`) was x264-encoded.
  - Frames I extracted show phone footage of **different people in different commercial gyms**: one shows bystanders and a gym logo on the wall, another shows "Nike"-swooshed trainers on a leg press. This does not look like one author's footage, so a blanket "Goulart" credit for every clip is doubtful.
  - The original wger video records (author, licence, exercise) could not be checked from here because wger.de is blocked by the sandbox egress proxy, so the attribution is UNCONFIRMED.
  - Even if it is correct, CC BY-SA 4.0 requires a link to the licence, an indication of changes (these were trimmed and re-encoded), and ShareAlike on the adapted clips. The current 9px overlay is incomplete. Identifiable third parties (bystanders) in gyms also raise a 5.1.1 / 5.2 consent question.
- **Fix intent:** Before submission, either (a) prove the rights (find each wger record and keep author, licence URL and source URL per clip in a manifest), drop any clip whose record cannot be found, strip the audio, and add full attribution (on screen plus an "Acknowledgements" screen); or (b) replace the 143 image pairs with media you own or licence (commissioned shoots, or a paid licence with app rights). The safest v1 is text and timer form guides only, which the code already supports when a map entry is missing. **[affects decisions.md]** The fallback in decisions.md ("iOS build uses only the self-hosted exercise-media/ set") is **not** a safe harbour. That set has the weakest rights chain of all three sources.

### B4. ExerciseDB media: licence terms unverified, used as the main visual source (5.2.1, 5.2.2)
- **What:**
  - Free tier: `EDB_GIF_BASE = 'https://static.exercisedb.dev/media/'` (14395) is used for 178 exercises (`EX_GIF_MAP` 14465–14644), rendered at 14893 and hotlinked from the client with no attribution in the UI.
  - Paid catalogue: `EX_V2_ID_MAP` (14401–14429, 27 exercises) plays MP4s via `/api/edb-video` → `netlify/functions/edb-video.mjs`, which calls RapidAPI `edb-with-videos-and-images-by-ascendapi`. The code comment says this is on "the user's RapidAPI **free plan**".
  - The ExerciseDB terms of use (dub.sh/exercisedb-api-tos → a Notion page) need JavaScript and could not be read from here, so the terms are UNCONFIRMED.
  - The exercisedb/exercisedb-api GitHub repo is AGPL-3.0 and says nothing about media rights. It calls the playground "not recommended for production integration".
  - The oss.exercisedb.dev page says nothing about commercial use or attribution.
- **Fix intent:** Max must get written confirmation from ExerciseDB/AscendAPI (support@ascendapi.com, listed on exercisedb.dev) covering GIFs and videos in a paid iOS app, whether hotlinking from a native app is allowed, and any attribution required. Without it, ship the iOS build with both ExerciseDB layers turned off (there is a single kill switch for each: `EDB_GIF_BASE` and `EX_V2_ID_MAP`). **[affects decisions.md]** This matches the plan, but note the interaction with B3: if both are off, the iOS app has no licensed exercise visuals.

### B5. Auth email links (confirm and reset) have no native path, and password reset cannot be completed anywhere (2.1, 5.1.1)
- **What:**
  - `authSignup` (23276–23283) posts `{email, password}` to `/auth/v1/signup` with **no `redirect_to` / `email_redirect_to`**.
  - `sendPasswordReset` (23501–23508) posts `{email}` to `/auth/v1/recover` with no `redirect_to`.
  - `sendConfirmationEmail` (23534–23541) posts to `/auth/v1/resend` with no redirect.
  - Supabase therefore uses the project's **Site URL**. That is UNCONFIRMED; check Dashboard → Authentication → URL Configuration, and it is presumably `https://maxgainz.netlify.app`.
  - The app has **no handler for the returned link**: no `location.hash` parsing, no `access_token=`, no `type=recovery`, no `/auth/v1/verify`, no `PUT /auth/v1/user` and no "set new password" screen (all greps empty).
- **Consequences:**
  - (a) A **password reset is impossible today, even on the web.** The link lands on the Netlify page with `#access_token=…&type=recovery`, the app ignores it and shows the sign-in screen, and the user can never set a new password.
  - (b) On iOS, any email link opens Safari on the Netlify site, not the app. With no Universal Link or associated domain, the native app never sees the token.
  - (c) The signup confirmation link works on the web only because confirming happens on Supabase's side before the redirect. In the native app the user taps the link, Safari opens the web app (where they may then sign in to the *web* copy), and they must return to the native app manually. That is confusing, but survivable.
- **Related:**
  - `authSignup` (23293–23296) shows a developer message when confirmation is on: "…or disable email confirmation in your Supabase dashboard." (see B6). The code assumes confirmation is **off** ("Go straight in — no confirmation required", 23299). The live setting is UNCONFIRMED.
  - The `#authResendForm` "Resend confirmation email" form (24191–24199) is never shown; no code sets it to `display:block`. The `#authConfirm` "Check your email" screen (24204–24212) is never shown either. Both are dead UI.
- **Fix intent:** Add a reset-password completion screen that reads the recovery token and calls `PUT /auth/v1/user`. Pass `redirect_to` explicitly: an iOS Universal Link on the company domain (decisions.md) or a custom scheme, both added to Supabase's Redirect URLs allow-list, handled through Capacitor App's `appUrlOpen`, and falling back to the web page. Decide the email-confirmation policy and make the UI match it. Plan: the web keeps its current redirect, and the native build sends its own `redirect_to`.

### B6. Developer and test instructions shown to ordinary users (2.1 completeness, 2.3 accuracy)
- **What:**
  - 24133–24139, the `#localFileWarning` box on the auth screen: "Login won't work from a local file", "For testing, run in Terminal: cd ~/Downloads / python3 -m http.server 8080", "Then open: localhost:8080/gymtracker.html", "Or deploy to: Netlify" with an `<a href="https://maxgainz.netlify.app">` link. It is shown when `location.protocol === 'file:'` (23194–23197). Capacitor uses `capacitor://localhost`, so this box should not show, but it ships in the bundle.
  - 23350–23352: `authLogin` refuses to run on `file:` with the message "Use localhost:8080 or maxgainz.netlify.app… Run: python3 -m http.server 8080 in your Downloads folder."
  - 23295: "disable email confirmation in your Supabase dashboard".
  - 23822–23823: feedback errors "Table not set up — run Supabase migration", "RLS policy blocking insert — check Supabase policies".
  - 3856: console only, not visible.
- **Fix intent:** Remove the file:// warning block and the developer copy from user-facing strings, and replace them with plain user errors ("Couldn't send feedback, try again"). Keep developer diagnostics in `console` only.

---

## 2) Likely rejection risks

### R1. An account is required just to open the app (5.1.1(i))
- **What:** After the splash, `dismissSplash()` (2069–2128) shows the full-screen `#authMod` sign-up form whenever `!isAuthenticated()` (2087–2095) and hides `.app`. There is no "continue without account" or guest mode (grep: none). `checkOnboarding()` (14159–14164) and cloud sync also need auth. The core features (logging sets, timers, programmes, history, progress) are all on-device first (`saveLocalCache`, localStorage), so nothing technical forces an account. The Settings copy even says "All data is saved locally" (1148), which makes forced sign-up harder to defend. Guideline 5.1.1(i) says apps may not require registration unless the core functionality needs it. Sync across devices is not core to tracking a workout.
- **Nuance:** A subscription app may require an account to *buy*. Apple accepts account-gated purchase flows and restore. The current gate is before *any* use, though.
- **What needs login today:** Everything (the whole UI is hidden). With a local mode, only cloud sync and backup, cross-device restore, the `__dashboard__` publisher, attaching an email to feedback, and the planned RevenueCat `logIn` would need it.
- **Fix intent:** Add "Continue without an account" on the auth screen: local-only, with the onboarding and path wizard running without auth (`checkOnboarding` checks `isAuthenticated()`), and sign-up offered later for sync and backup. **[affects decisions.md]** The paywall and RevenueCat design must work for an anonymous app user and alias to the Supabase id on sign-up. Otherwise give the reviewer a demo account and argue that the account is required for the subscription, which is weaker.

### R2. Third-party trademarks and personal names visible in the UI (5.2.1, 5.2.5)
User-visible strings (code identifiers such as `startTimedSetBarry`, `isBarrysWorkout`, `showBarryBlockRest`, `skipBarryRest` and the CSS classes are invisible and fine):
- **"Garry's" (7 classes plus a setting):** HIIT names "Garry's Bootcamp - 30 (Arms & Abs)", "Garry's Blast - 45 / 60", "Garry's Burn - 45 / 60", "Garry's Blaze - 45", "Garry's Bootcamp - 60" (11378–11392), format label "Garry's Style" (11817, 11835, 21067), filter chips "🏃 Garry's" (1340, 20727) and "🏃 Garry's classes" (12606), Settings header "🏃 Garry's Workout Settings" (1054), copy at 1099 ("Treadmill speed ranges in Garry's workouts adjust to suit") and 21995, an achievement description (18444), and the runner-level hint at 22953. The format is a treadmill block plus floor block, which is recognisably the **Barry's** (Barry's Bootcamp brand; trademark registration not checked here) class format. The code still calls these "Barry" (5800, 7708, 8181, 11843, and a comment at 19997 mentions "Barry's"). "Garry's Bootcamp" is a one-letter variant of a famous fitness brand and could be read as passing off. Whether Max wrote these classes or copied them from a specific gym's programming is UNCONFIRMED.
- **"Hot Girl Summer":** Series subtitle (11719), wizard card (22020), and achievements "Hot Girl Summer Begins" (18448) and "Hot Girl Summer" (18451). "Hot Girl Summer" is a registered US trademark of Megan Thee Stallion. Several outlets reported the registration in 2019, and a legal fight over it ended in 2022.
- **Programme Library (13 programmes; authors shown at 12252 "By …", 21835, 21861):** "StrongLifts 5×5" / Mehdi Hadim (2224), "Starting Strength" / Mark Rippetoe (2243), "Greyskull LP" / John Sheaffer (2262), "GZCLP" / Cody Lefever (2283), "Madcow 5×5" / Glenn Pendlay (2312), "5/3/1 Boring But Big" / Jim Wendler (2336), "PHUL" / Brandon Campbell (2365), "PHAT" / Layne Norton (2407), and "Arnold Split" / "Arnold Schwarzenegger (era)" (2458). StrongLifts, Starting Strength and 5/3/1 are commercial brands (books, apps, trademarks; specific registrations UNCONFIRMED). Naming real people next to programmes they did not endorse, in a paid app, risks 5.2.1 (IP) and implied endorsement (5.2.5, celebrities). One entry is credited to "Max Gainz" (2565), which is fine.
- **Brands in media:** the Nautilus logo in `Ab_Crunch_Machine/0.jpg`, Nike trainers in the leg-press clip, and gym logos on walls (B3).
- **Fine:** "Tabata", "AMRAP", "EMOM" and "Bro Split" are generic terms. The comment at 9415/9453 mentions Spotify and Apple Music but is not shown.
- **Fix intent:** Rename the Garry's classes to an original name (for example "Tread & Floor") everywhere visible; the stored session `day` names need a migration or alias, see P11. Rename the "Hot Girl Summer" strings. For the library, use descriptive names ("Linear 5×5 beginner", "4-day 5/3/1-style wave") or get permission, and drop the author credits. Credits are polite, but they imply association.

### R3. Health and injury claims without a disclaimer (1.4.1)
- **What:** No disclaimer anywhere (grep: no "disclaimer", "consult", "medical advice" or "doctor"). The app collects **injury history** at onboarding (13901–13907) and promises "We'll reduce weights for affected movements **to keep you safe**" (13905). It then cuts starting weights by fixed factors (14073: shoulder 0.7, lower back 0.6 …) and flags "risky" swaps (11274–11297). Exercise benefit text, shown in full in the form guide at 15019–15022 and truncated in swap lists at 8416/8477/11293/11368, includes "great injury rehab option" (2703), "rehab" (2743), "injury prevention" (2760), "supports knee health" (2764, 2818), "a rehab favourite for knee health" (2850), "knee health insurance" (2940), "posture insurance" (2950), "Bulletproofs the lower back / spinal erectors" (2856, 2903), "excellent for shoulder health" (2723), "the go-to for deload and injury weeks" (2914), "keeps metabolism elevated" (2807), and "burns more calories" (2800). Onboarding offers a "🔥 Fat loss / Burn calories" goal (13937). There are no calorie numbers or estimates, which is good. Notification and reminder copy is benign.
- **Why:** 1.4.1 covers apps that could cause physical harm and health claims that cannot be substantiated. Prescribing loads and suggesting "rehab" based on self-reported injuries, with no "not medical advice / consult a professional / stop if pain" notice, is a common rejection trigger for fitness apps.
- **Fix intent:** Add a one-time disclaimer at onboarding (before the injury step) and a persistent one in Settings and the form guide. Soften the step-4 copy (for example "We'll start lighter on movements that involve these areas. This is not medical advice."). Rewrite the "rehab", "injury prevention" and "bulletproof" benefits as training descriptions.

### R4. References to the web, to browsers and to the web-app nature (2.3.10, 4.2)
- **What (user-visible):**
  - "Netlify" and `https://maxgainz.netlify.app` (24138, 23351).
  - "localhost", "Terminal", "python3", "Downloads" (24135–24137, 23351).
  - "Notifications not supported **in this browser**" (4350).
  - "re-enable notifications in your **browser** settings" (4360).
  - "🆕 New version available" update banner (464), driven by the service worker (23837–23884). An app must not update itself outside App Review; see N3.
  - Not found (grep): Android, Google Play, "Add to Home Screen", `beforeinstallprompt`, install banners, "PWA" in visible text (PWA appears in comments only: 3044, 4271, 4477, 4485, 5143).
  - `apple-mobile-web-app-*` meta tags (5–8) are harmless.
- **Fix intent:** Remove or replace each string in the native build (detect it with `Capacitor.isNativePlatform()`). Hide the update banner and service-worker logic in native. Phrase the notification copy for iOS Settings.

### R5. Features that falsely claim to work (2.1, 2.3)
- "📧 Email Data & Delete" sends no email (B1).
- "🔔 Enable training reminders": in WKWebView `Notification` is undefined, so the button becomes "Notifications not supported" (4454–4458), a dead control in Settings (N1). Even on the web its caption says "(background push **coming later**)" (1177). That is "coming soon" copy, flagged under 2.1/2.3.
- "Screen on / 🔒 Auto-lock" (532, 5579–5603): on older iOS WKWebView builds `navigator.wakeLock` may be missing. The code then does nothing; it only shows "⚠️ Not supported" if `request` throws (N2).
- "📲 Share to apps" only appears if `navigator.canShare({files})` is true (14317). That is good, but "💾 Save image" (1355) does nothing in WKWebView (N10).
- **Fix intent:** Make each one work natively (N1, N2, N10) or remove it. Delete the "coming later" text.

### R6. 4.2 minimum functionality / 4.2.2 "repackaged website" perception
- **What:** Capacitor wrappers draw extra scrutiny. The app's own depth is large (see section 6), but reviewers also look for native integration and the web-app tell-tales listed in R4, N3 and N16.
- **Fix intent:** Ship with native local notifications (N1), native haptics (N4), a native share sheet (N10), a Keep Awake plugin (N2), and the timer-reliability work (N5). Remove every web tell-tale. Mention the native features in the review notes.

### R7. The web version must not become an unreviewed path to IAP content (3.1.1, 3.1.3) [affects decisions.md]
- **What:** decisions.md keeps the web app free and unchanged with the same Supabase account, so a user who signs in on the web gets everything free while iOS is paywalled. Apple allows web use, but the iOS app must not link to the web or steer users there (3.1.1/3.1.3). Today the only link to the web is at 24138, inside the file:// block (B6). After B5, auth emails will open the web app, which puts a free path one tap from the paywall.
- **Fix intent:** Remove all web links from the native build and point auth emails at the native app (B5). Confirm the strategy with the subscription workstream.

### R8. Feedback: personal data and possible abuse, anonymous inserts allowed (5.1.1, 1.2)
- **What:**
  - Anonymous inserts: anyone with the public anon key can POST to `feedback` (RLS policy `mg_feedback_insert` for `anon, authenticated`, rls_owner_only.sql 72–79), with up to 5 MB of base64 per row (23740). There is no size cap in the database and no rate limit. post_fix_checks.sql check 7 only monitors volume.
  - Personal data: email is attached by default unless "Submit anonymously" is toggled (23775–23776), and screenshots may contain personal data. This must be disclosed in the privacy label and policy.
  - The "Location" select offers "ULF Workouts" and "PPL Workouts" (24282–24283), which are internal jargon.
- **Fix intent:** Restrict inserts to `authenticated`, or add a DB check constraint on `octet_length(image_data)` and a rate limit (Edge Function). Disclose collection, and include `feedback` in the deletion (B1).

---

## 3) Breaks or behaviour changes inside a Capacitor WKWebView (iOS)

Assumes Capacitor 8, assets bundled and served from `capacitor://localhost`.

| # | Feature / API | Where | What happens in WKWebView | Native replacement / fix intent |
|---|---|---|---|---|
| N1 | Web Notification API | 4329–4375, 4451–4471, 4474–4476 | `window.Notification` does not exist in WKWebView. **Every access is guarded** with `'Notification' in window` (4331, 4349, 4454), so nothing throws. The Settings button turns permanently disabled: "Notifications not supported" (4455). | `@capacitor/local-notifications`. Schedule an "overdue muscle group" reminder for N days ahead whenever a session is saved, and cancel or reschedule on the next save. This gives real background reminders and justifies the permission prompt. Keep the web branch for Netlify. |
| N2 | Screen Wake Lock | 532, 5579–5609, 11016 | Feature-detected (5589). Support in WKWebView depends on the iOS version (UNCONFIRMED for the iOS 26 SDK; Safari has had it since 16.4). If it is missing, tapping does nothing silently. The re-acquire listener (5595) is added again on every toggle (a leak). | `@capacitor-community/keep-awake` in native, plus one visibility handler. |
| N3 | Service worker | registration 23853–23884; sw.js; update banner 464, 23837–23851 | Service workers do not run for the `capacitor://` scheme by default. On iOS they need App-Bound Domains (`WKAppBoundDomains`) and a limited domain list, so `register()` most likely rejects and only logs a warning (23877). The update banner then never appears. Even if it ran, the shell is bundled, so the SW adds nothing and the "New version available" flow would be a self-update path (2.5.2 concern). | Skip SW registration and the banner when `Capacitor.isNativePlatform()`. Updates come through the App Store. |
| N4 | `navigator.vibrate` | `haptic()` 3045–3047, about 14 call sites | Undefined on iOS, so a guarded no-op. There are no haptics at all today. | `@capacitor/haptics` (`impact`/`notification`) behind the existing `haptic()` wrapper, mapping the pattern lengths to light, medium or heavy. |
| N5 | Timers when the app is backgrounded | rest 9875–9936, HIIT 9650–9722, EMOM/AMRAP/Core-timed 7952–8170, circuit 6964–7055 | The rest and HIIT timers use wall-clock deltas (`Date.now() - start`), which is good: the display catches up on resume. But iOS suspends WKWebView JS within seconds of backgrounding or screen lock, so the **"3-2-1" beeps, the completion ding and the rest-done alert never fire while the phone is locked** or in a pocket. HIIT phase transitions stall until resume, then jump. | Schedule a local notification (N1) with a sound at rest or phase end when the app goes to background (`App` `pause`), and cancel it on `resume`. Optionally add a Live Activity or background-audio approach later (needs a justification for background modes). |
| N6 | AudioContext cues | `playHIITAudio` 9331–9378 (new AudioContext per beep, never closed), `_ac()` shared context 9383–9389, `_playCountdownBeep` 9423–9449, `playCompletionDing` 9392–9409 | WebAudio in WKWebView respects the **ring/silent switch**: with the default "ambient" audio session, cues are silent when the switch is on silent. A context created outside a user gesture starts suspended. `resume()` is attempted (9396, 9425) but there is no gesture-time unlock, so the first cue after a long idle may be dropped. `playHIITAudio` creates a new AudioContext per beep; iOS caps concurrent contexts (about 4–6), so long Tabata sessions can hit "too many contexts" and go silent. It also ignores the `audioEnabled` preference, so the HIIT work/rest beeps always play. | Use `_ac()` everywhere and unlock it on the first tap (start session). Decide the audio-session category natively (ambient so music keeps playing, or playback so cues play on silent) via a small native plugin or Capacitor config. Respect `audioEnabled` in `playHIITAudio`. |
| N7 | Google Fonts | `<link>`s 14–18; sw.js SHELL 28 and STATIC_HOSTS | Loaded from fonts.googleapis.com and fonts.gstatic.com at runtime. Offline at the gym it falls back to the system font (fine), but it is a third-party network call that discloses the user's IP to Google on every launch (privacy label: "Other" / tracking-adjacent). | Bundle Inter woff2 locally with `@font-face`. Inter is under the SIL OFL, so include the licence. |
| N8 | Lottie from unpkg | `_loadLottieScript` 3256–3268; sw.js SHELL 30 | Remote script injection from `https://unpkg.com/lottie-web@5.12.2/…` at runtime. Offline it fails silently (emoji fallback). Loading remote executable code is a 2.5.2 concern, even for a library, and a supply-chain risk. | Bundle `lottie_light.min.js` (MIT) locally. |
| N9 | Relative `/api/edb-video` | 14452 | From `capacitor://localhost` this resolves to `capacitor://localhost/api/edb-video`, which does not exist. It fails and falls back after 5 s (`_v2Bail`); the form guide shows "Loading demo…" for up to 5 s. If pointed at the absolute Netlify URL, the function returns no CORS headers, so WKWebView's fetch from origin `capacitor://localhost` is blocked. | Turn V2 off in native per B4, or use an absolute URL with CORS (`Access-Control-Allow-Origin: capacitor://localhost`) and a quota guard. |
| N10 | File downloads via `<a download>` + blob URL | backup `exportAllData` 4537–4555, `exportData` 22593–22604, share card `downloadShareCard` 14335–14343, deletion CSV 23626–23632 | WKWebView ignores the `download` attribute (Capacitor provides no download handler), so **Export, Export JSON, Save image and the deletion CSV do nothing on iOS**. Data portability, which the deletion flow promises, breaks. | `@capacitor/filesystem` (write to Cache) + `@capacitor/share` (opens the share sheet, where "Save to Files" or "Save Image" are offered). |
| N11 | `navigator.share` with files | `generateShareCard` 14169–14323 (canvas → PNG blob), `shareCardNative` 14345–14355 | WKWebView supports `navigator.share` on recent iOS (since iOS 14-ish, UNCONFIRMED for file sharing in Capacitor builds). `canShare({files})` gates the button, so if unsupported the button just never appears. | Use `@capacitor/share` with a file written by Filesystem. Saving the image to Photos needs `NSPhotoLibraryAddUsageDescription`. |
| N12 | File inputs (camera / photos / files) | profile photo 920–924 (`capture="environment"` camera input + library input), feedback screenshot 24316, backup import 1198 | They work in WKWebView and present the system picker or camera, but the app **crashes on camera open unless Info.plist has `NSCameraUsageDescription`**, and needs `NSPhotoLibraryUsageDescription` for the library picker (UNCONFIRMED whether PHPicker avoids that). The import picker opens the Files app (fine). Profile photos are stored at full camera resolution as base64 in localStorage and the cloud blob (22887), which can exceed the localStorage quota (about 5 MB) and make every `cloudSaveProfile` heavy. | Add the usage strings. Downscale photos on a canvas (for example 256 px, JPEG) before storing. Optionally use `@capacitor/camera`. |
| N13 | `confirm()` / `prompt()` | 13 `confirm()` (for example 4573, 5512, 10655, 13040, 13127, 15306, 18189, 21537, 22607, 22795, 22878, 23571, 23661) + `prompt()` 12808 | **Capacitor's iOS bridge implements the WKUIDelegate JS panels**, so these show as native alerts titled with the app name (this is the expected behaviour; exact styling UNCONFIRMED). They work, but look web-like, and 23661 tells the user to "type your email" in a confirm dialog that has no text field. | Replace them with the app's own modal (`showActionSheet` 3310 already exists) or `@capacitor/dialog`. |
| N14 | `location.reload()` | 23691 (after account deletion), 23881 (SW update) | It reloads `capacitor://localhost/`, which works. 23881 becomes unreachable once the SW is skipped (N3). | Prefer resetting state without a reload. Fine as is. |
| N15 | URL / hash routing | none: `goTab()` 4858, no `location.hash`, `history.*` or `popstate` (grep) | No breakage, since there is no URL dependency. `location.protocol` is read only for the `file:` checks (23194, 23350); `capacitor:` passes. | Nothing needed. Deep links arrive via B5 / `appUrlOpen`. |
| N16 | Safe areas (notch, status bar, home indicator) | viewport meta line 5 lacks `viewport-fit=cover`; `env(safe-area-inset-*)` used about 15 times (58, 119, 139–142, 240, 246, 248, 256, 272, 417, 454–455, 481); `.nav` has fixed `padding: 8px 0 20px` (60) | Without `viewport-fit=cover`, iOS WKWebView reports all insets as 0. Capacitor's default `ios.contentInset` also affects layout. Outcomes: either content is letterboxed below the status bar (web view inset by the system) or, with `viewport-fit=cover`, the nav needs `env(safe-area-inset-bottom)` (only the landscape media query at 454 has it). The status bar style relies on `apple-mobile-web-app-status-bar-style` (7), which WKWebView ignores. | Add `viewport-fit=cover`. Pad `.nav` bottom with `max(20px, env(safe-area-inset-bottom))`. Use `@capacitor/status-bar` (dark content, overlay). Test on a notched device and an iPad (iPhone-only in decisions.md, but iPad compatibility mode still runs it). |
| N17 | Text selection, long-press callouts, zoom, overscroll | `user-select:none` only on a few elements (88, 236, 13269); no `-webkit-touch-callout`; no `overscroll-behavior`; `touch-action` only on 121 and 295; `maximum-scale=1.0` but no `user-scalable=no`; custom pull-to-refresh (3511–3560, `triggerRefresh`) | In WKWebView: long-pressing text or images shows the iOS selection loupe or "Save Image / Copy" callout (very web-like, and it conflicts with the `attachLongPress` menus 3349–3410); double-tap zoom is mostly suppressed by `maximum-scale=1`, but iOS ignores maximum-scale for accessibility, so zoom stays possible (fine); rubber-band overscroll of the whole page plus the custom pull-to-refresh fight each other. | Global `-webkit-user-select:none; -webkit-touch-callout:none` (re-enable on inputs and textareas). Disable WKWebView scroll bounce (Capacitor `ios.scrollEnabled` / `overscroll-behavior:none` on html and body). Keep the custom pull-to-refresh. |
| N18 | localStorage as the only store for signed-out users, and the auth tokens | `STORAGE_KEY='maxgainz_v1'` 4066; `saveLocalCache` 4111–4134; tokens `maxgainz_auth` 2981–2992 | WKWebView localStorage for a custom-scheme Capacitor app is generally kept, but **iOS can purge WebKit website data under storage pressure** (and, for web-browsing contexts, after 7 days of no interaction under ITP; Capacitor apps are usually exempt, UNCONFIRMED for iOS 26). Today every user is signed in, so the cloud is the backup, but with R1's local mode the device is the only copy. A purge also signs the user out (tokens are in localStorage). | Mirror the critical state to `@capacitor/preferences` (native UserDefaults) or a SQLite/Filesystem JSON file, and keep localStorage as a cache. Keep the `maxgainz_v1` and `maxgainz_path` key formats unchanged for the web. Put tokens in the Keychain via a secure-storage plugin. Prompt local-only users to export or back up. |

Other native-shell notes:
- Lottie, fonts and the ExerciseDB GIF/MP4 hosts all need network access. Bundled `exercise-media/` (121 MB) would make the app download large; with B3 it may be removed anyway. Consider on-demand resources or a CDN you own.
- The cooldown "fullscreen" uses `requestFullscreen` with a CSS fallback (10891–10914). WKWebView has element fullscreen only on iPad (`isElementFullscreenEnabled`, UNCONFIRMED); the CSS fallback covers iPhone.
- The `cloudToggle` inline handler at 912 references the undefined `cloudUserId`, `cloudLogout` and `cloudLoginMod`. It is replaced by `updateCloudStatus()` (23560–23586) on the first visit to Profile (23590–23593). If anything ever shows that button before then, tapping it throws a ReferenceError. That is dead code to remove.
- `visibilitychange` (4474–4489) does fire in WKWebView, and the `keepalive` fetch for the dashboard flush is supported. In native, also listen to Capacitor `App` `pause` and `resume`.

---

## 4) Polish / lower risk

- **P1. Deleting a manual activity never deletes it from the cloud.** `deleteManualActivity` (22791–22805) calls `saveStore(null, null)` (22799), and `saveStore` (4685–4710) never deletes. The activity reappears on the next `cloudLoadAll`. Compare `deleteSession` (18188–18196), which does call `cloudDeleteSession`. That is a data-integrity bug and also a 5.1.1 "delete my data" expectation. Fix: call `cloudDeleteSession(s)`.
- **P2. The import promises cloud re-sync that doesn't fully happen.** `handleImportFile` says "Your cloud account (if signed in) will be re-synced from this backup on the next save" (4578), but the replaced sessions are not re-uploaded in bulk, and `cloudLoadAll` on the next launch may merge them back in or drop them depending on the `userId` stamp (3896–3899). This is UNCONFIRMED without runtime tests. Fix intent: an explicit upload after import, or clearer copy.
- **P3. Console logging of auth flow:** 23362 ("Attempting login to:" endpoint), 23374, 23383, 23543, 3016. These are not secrets (the body logging was already removed, per 23373), but strip them from release.
- **P4. Dead UI:** `#authResendForm` (24191–24199) and `#authConfirm` (24204–24212) are never shown; the `maxgainz_pending_name` / `_email` reads (23386–23397) never match because nothing writes them; the `cloudToggle` inline handler (912).
- **P5. The "Location" choices in feedback** use jargon ("ULF Workouts", "PPL Workouts", 24282–24283).
- **P6. Sign-up asks for "Name"** (24145), and the profile has First/Last/Email/Preferred name, Gender, **Date of Birth**, Height (954–978). DOB and height are stored and uploaded but **never used** by any feature (grep: `dob` only at 22836/23139; `heightCM` only as a default and form field). Onboarding also asks age and gender (13962–13969), which are stored but not used. Collecting data the app doesn't use is a 5.1.1(iii) data-minimisation concern. Fix: remove DOB, height and age, or explain their use.
- **P7. Profile placeholders** "Max" / "Gains" (932, 936), and the default `userProfile` `heightCM:180, weight:80` (3872, 23456), which shows up as real-looking values for new users (22837–22838). Minor.
- **P8. Splash auto-dismiss after 3 s** (23191). Reviewers dislike forced splash delays. Fine, but consider using the native splash screen (`@capacitor/splash-screen`).
- **P9. `playHIITAudio` ignores the user's sound toggle** (9331; no `audioEnabled` check), unlike `playCompletionDing` and `speakCountdown`. That is a settings bug (N6).
- **P10. `confirm('Sign out of your account?')`** (23571) and similar native-looking dialogs: see N13.
- **P11. The `sessions.day` value stores display names** such as "Garry's Bootcamp - 30 (Arms & Abs)". Renaming for R2 must keep old sessions mapping correctly (history, achievements `_hiitFormatsExplored` 18294–18308 and the format detection at 12603 use the `/garry/i` regex). Fix intent: alias old names to new IDs on load, and keep the localStorage formats backwards compatible as required.
- **P12. Background-colour flash and the 100vh layout:** `.app` uses `100vh`/`100dvh` (57), and `#authMod` uses `100vh` (117, 24128). In WKWebView with keyboard resize these can jump. Check keyboard behaviour on the auth forms (Capacitor `Keyboard` `resize` setting).

---

## 5) Privacy-label inputs (App Store Connect → App Privacy)

**No third-party analytics, crash-reporting, advertising or tracking SDKs** (grep: no gtag, Sentry, Firebase, PostHog, Mixpanel, Amplitude, Segment, pixels). There is no ATT prompt, and no tracking under Apple's definition **unless** RevenueCat is configured to share data. That belongs to the subscriptions workstream (RevenueCat collects purchase history and identifiers). All collection below is "linked to the user" because it is stored against the Supabase `user_id`, except where noted.

| Apple data type | What exactly | Where it goes | Linked? | Purpose (Apple categories) |
|---|---|---|---|---|
| Contact Info → **Email Address** | sign-up email; `profileEmail` field; the feedback `user_email` unless anonymous | Supabase Auth (`auth.users`), the `__profile__` blob, `feedback` | Yes | App Functionality (account), Developer Communications (password reset) |
| Contact Info → **Name** | sign-up name (`currentUser.name`, kept in localStorage `maxgainz_auth`, uploaded as `preferredName` once Profile is saved, 23137); profile first and last name (in the `__profile__` blob); first name in `__dashboard__` | Supabase DB | Yes | App Functionality |
| Health & Fitness → **Fitness** | every workout: exercises, sets, reps, weights, per-set weights, RPE, rest seconds, duration, volume, XP; manual activities (run, swim, tennis, … plus intensity and duration); custom programmes and HIITs; path and schedule; PBs; working weights | `sessions`, `custom_weights`, the `__profile__` / `__dashboard__` blobs | Yes | App Functionality |
| Health & Fitness → **Health** | **body weight log**, **body measurements** (chest, waist, arms, thighs, hips), **injury history** (shoulder, elbow/wrist, lower back, knee/ankle), height, current weight | `__profile__` blob | Yes | App Functionality |
| User Content → **Photos or Videos** | profile photo (camera or library, full resolution, base64); feedback screenshot (≤ 5 MB) | `__profile__` blob; `feedback.image_data` | Yes (feedback: No if anonymous) | App Functionality (profile photo); feedback screenshot: App Functionality (support) |
| User Content → **Other User Content** | free-text **daily notes**, **per-exercise session notes** (inside `set_log.note`), feedback message text | `__profile__` blob, `sessions.set_log`, `feedback` | Yes (feedback: No if anonymous) | App Functionality |
| Identifiers → **User ID** | Supabase auth UUID (on every row); will also be the RevenueCat `logIn` id (decisions.md) | Supabase; RevenueCat | Yes | App Functionality |
| **Sensitive Info** / other demographics (Apple "Other Data Types") | **date of birth**, **age**, **gender**, experience level, training goal and frequency, sports background, equipment access, previous lift numbers | `__profile__` blob | Yes | App Functionality. Recommend removing DOB and age (P6) |
| Usage Data → Product Interaction | **not collected** server-side as analytics, though XP, achievements and form-guide-seen are derived app state (local only: `maxgainz_fg_seen` etc. are not uploaded; XP is computed from sessions) | — | — | Declare "not collected" for Usage Data unless RevenueCat or others add it |
| Diagnostics | **not collected** (only `console.*`; no crash reporter) | — | — | Not collected |
| Purchases → Purchase History | (future) via StoreKit and RevenueCat | RevenueCat | Yes | App Functionality. The subscriptions workstream should confirm |
| Location / Contacts / Browsing / Search / Financial | not collected | — | — | — |

**Every third-party domain contacted at runtime (current code):**
1. `lxudaetjuefylgjddonm.supabase.co`: auth (`/auth/v1/signup`, `/token`, `/recover`, `/resend`, `/logout`) and REST (`/rest/v1/sessions`, `/custom_weights`, `/feedback`).
2. `fonts.googleapis.com` and `fonts.gstatic.com`: Inter font (IP disclosed to Google) (N7).
3. `unpkg.com`: lottie-web script (N8).
4. `static.exercisedb.dev`: exercise GIFs, hotlinked (B4).
5. Netlify origin `/api/edb-video` (web only) → the Netlify function calls `edb-with-videos-and-images-by-ascendapi.p.rapidapi.com`; the returned `videoUrl` points to an AscendAPI media host (exact host UNCONFIRMED; it rotates weekly per 14398–14400).
6. `pub-585d42eb1aa64a67aedf483ec328d3fe.r2.dev`: referenced but **disabled** (`EX_VIDEO_BASE = null`, 14386). Not contacted. Remove the code.
7. `maxgainz.netlify.app`: only as a link inside the file:// block (24138).
8. (future) RevenueCat and Apple StoreKit.

**Secrets check (A9):** The only credential in client code is the Supabase **anon** JWT (2957). Decoded payload: `{"iss":"supabase","ref":"lxudaetjuefylgjddonm","role":"anon",…,"exp":2092331538}`. It is public by design, and the remaining RLS checks are in R8 and the next section. No service-role key, RapidAPI key, GitHub, Google, Stripe or other tokens appear anywhere in the repo (index.html, sw.js, netlify/, supabase/, tests/). The RapidAPI key is read from the Netlify env var `RAPIDAPI_KEY` (edb-video.mjs 7) and never sent to the client. `.gitignore` excludes `.env`. History: the clone is **shallow (one commit)**, so earlier commits could not be scanned. That is UNCONFIRMED. Max should run a secret scan over the full history on GitHub (for example GitHub secret scanning, or `gitleaks detect` on a full clone).

**Supabase RLS (A10), from `supabase/rls_owner_only.sql` and `post_fix_checks.sql`:**
- `sessions`, `custom_weights`: RLS enabled. Four policies (`mg_owner_select`, `_insert`, `_update`, `_delete`), all `to authenticated` with `user_id = auth.uid()` (cast to text). Anon gets nothing. Update has USING and WITH CHECK, so a row cannot be reassigned to another user. This looks correct for owner-only access.
- `feedback`: RLS enabled, a single `mg_feedback_insert` for `anon, authenticated` with `user_id is null or user_id = auth.uid()`. No select, update or delete for anyone (read via the dashboard). Gaps:
  - (1) Anonymous inserts allow spam and storage abuse (R8).
  - (2) `user_email` is not checked against the caller, so a signed-in or anonymous caller can file feedback under any email address.
  - (3) Users cannot delete their own feedback (B1 needs a server-side path).
- **Not covered by the scripts:**
  - Any other table in `public`. Check 1 lists them, and the comment mentions an unused "workouts" table.
  - Views and SECURITY DEFINER functions (checks 2 and 3 detect them).
  - **Storage buckets** (the app doesn't use Storage: grep `storage/v1` = 0, but check that no public bucket exists).
  - Auth settings (email confirmation, redirect allow-list, leaked-password protection, rate limits).
  - The `notes` column size on `custom_weights` (the photo is stored inside it).
- **What Max should run (Supabase Dashboard → SQL Editor):**
  1. `supabase/post_fix_checks.sql` as-is. Expected: no "RLS off" rows, no view or definer rows, 0 orphan rows, 0 `<tag` rows, and check 6 showing a primary or unique key on `(user_id, exercise_name)`. Check 7 gives the feedback volume.
  2. ```sql
     select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname='public' order by 1,2;
     select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p');
     select table_name, privilege_type, grantee from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') order by 1,3,2;
     select id, name, public from storage.buckets;
     ```
  3. An anon-key probe from a terminal, which should return `[]` or a 401, never rows: `curl -s "https://lxudaetjuefylgjddonm.supabase.co/rest/v1/sessions?select=*&limit=1" -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>"`. Repeat for `custom_weights` and `feedback`, and for any table check 1 lists.
  4. Dashboard → Authentication → URL Configuration: record the **Site URL** and **Redirect URLs** (needed for B5). Under Providers → Email, record whether "Confirm email" is on (it determines which branch of `authSignup` 23293 runs).

---

## 6) Review-notes strengths (4.2 minimum functionality)

These are substantial, app-like features (all on-device logic, not a content wrapper), useful for the App Review notes. Line refs show where each lives.
- **Guided strength sessions:** a live set logger with tap-to-log rep bubbles and swipe gestures (`renderBubbles` 8571, `quickLogSet` 8595, `initBubbleSwipe` 8630, `initExerciseSwipe` 8688), per-set weight adjustment, a plate-aware weight stepper (`getWeightSteps` 5367, `snapToSteps` 5457), warm-up sets (7278–7314), supersets (builder 10243–10373), exercise swaps (11267–11328), mid-session add/remove exercise (12980–13086), and a session timer.
- **Adaptive coaching:**
  - Progressive-overload suggestions (`computeProgressionSuggestions` 6853, `getLiftState` 6408, `showWeightSuggestion` 6222).
  - Optional RPE tracking (4391, 6633–6662) and periodisation over a 4-week build/push/recover cycle (4421, 5696–5750).
  - Exercise rotation (4435, 5666–5750).
  - Estimated 1RM and a 1RM calculator (6342–6379, 13600–13808).
  - Onboarding that calculates starting weights from experience, body weight, goal and injuries (13809–14157).
- **Timers and interval engines:** a rest timer with countdown cues (9875–10048), Tabata (9478–9874), AMRAP and EMOM auto-timers (7763–8170), timed and two-phase sets (7350–7762), treadmill/floor block classes (7323, 8181–8396), a guided warm-up, cooldown and mobility flow with stretch media (10733–10999), and a core circuit (7063–7277).
- **Programmes and plans:**
  - 13 curated library programmes (2222–2665), plus built-in ULF and PPL.
  - A custom programme builder (12749–13188) and a custom HIIT builder (15177–15481).
  - 36 HIIT workouts across AMRAP, EMOM, Tabata, Core/Timed, Complex and treadmill formats (11376–11660).
  - A multi-week "Path" planner with wizard, adherence, catch-up and add-ons (19079–22414).
- **Exercise library:** 235 exercises with muscles, equipment, difficulty, cues, benefits and alternatives (`EXDB` 2690–2953), with an in-session form guide (14357–15054).
- **Progress analytics (Progress tab):** a calendar (15898–16138), a body-weight chart and log (16139–16450), body measurements (16243–16330), PB cards (13189–13397), strength charts (13425–13616), weekly insights (16529), a muscle-balance analysis and **front/back muscle heatmap** (16772–17337), strength ratios (17338), compound/isolation split (17479), time-under-tension (17660), rest-time analysis (17823–17986), training frequency (17987–18120), and a data-integrity check (4141–4200).
- **Gamification:** 16-rank XP ladder with prestige (18207–18240), 57 achievements (18392–18472), streaks (18489–18567), welcome-back and daily-focus cards (18611–18777), level-up modals and celebration animation.
- **Utilities:** a plate calculator with visualisation (15717–15897), a manual activity log for 13 sports (22635–22818), daily notes (18778–18813), a share-card image generator drawn on canvas (14169–14355), full JSON backup export/import (4497–4684), three themes (22912–23007), unit preferences, and offline use with conflict-safe sync (`_mergeSessions` 4218, offline re-upload 3922–3932).
- **Native additions to cite once built:** local-notification training reminders and rest-end alerts (N1/N5), haptics (N4), keep-awake during workouts (N2), native share sheet and save to Files (N10/N11), camera profile photo (N12), and (later) Apple Health (decisions.md).

---

## Sources used for licence and trademark checks
- [yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db) · [issue #2 "License of Images?"](https://github.com/yuhonas/free-exercise-db/issues/2) · [issue #13 "images has copyright?"](https://github.com/yuhonas/free-exercise-db/issues/13)
- [wrkout/exercises.json](https://github.com/wrkout/exercises.json)
- [exercisedb/exercisedb-api (AGPL-3.0)](https://github.com/exercisedb/exercisedb-api) · [oss.exercisedb.dev](https://oss.exercisedb.dev/) · ExerciseDB terms page (dub.sh/exercisedb-api-tos → Notion): could not be rendered, UNCONFIRMED
- wger.de video API: blocked from this sandbox, UNCONFIRMED
- "Hot Girl Summer" trademark: [The Root](https://theroot.com/hot-girl-summer-officially-belongs-to-megan-thee-stal-1838421414) · [Black Enterprise (2022)](https://blackenterprise.com/megan-thee-stallion-secures-the-hot-girl-summer-trademark-after-a-two-year-legal-fight/)
