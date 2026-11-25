# Release checklist: next-priorities cycle (build 2026.11.25.9)

There are 11 local commits on `main`, none pushed to `main` (branch `release/2026-11-25` → PR #5 for the Deploy Preview):

- Priority 0: two slices
- Priorities 1–6: one slice each
- Priority 7: slice 1
- Fix: custom-weight changes stuck in the sync queue ("64 changes waiting to sync")

All 33 automated gates pass. **Nothing has been tried in a real browser yet**, because the preview tool was unavailable all session. The steps below are that missing test.

Tip: you can push a branch and open a PR to get a Netlify **Deploy Preview**. That costs one build and lets you run all of this without touching production.

**Warning:** the Deploy Preview uses the **production** Supabase project. The SQL in step A changes production straight away. Both scripts are safe for the app that is live today:

- The live app still sends feedback (it never sends `request_id`).
- The live AI function treats "not in beta" as "unavailable", so the app shows its own text.

---

## A. Supabase, before testing (SQL Editor)

1. Run `supabase/feedback_limits.sql`. Expect every result row to say **ok**.
2. Run `supabase/ai_beta.sql`, then add your own account **in the same sitting**. From then on, only listed accounts get AI.

   ```sql
   insert into public.ai_beta (user_id, note)
     select id, 'owner' from auth.users where email = '<your email>'
   on conflict (user_id) do nothing;
   ```

   Expect **ok, ok** and **beta members 1**.

## B. On the preview (iPhone home-screen app and desktop)

### 1. Build and configuration (Priority 0)
- [ ] Profile → Data health → **Configuration · this device** shows build **2026.11.25.9**.
- [ ] It shows the navigation mode, Profile layout, Phase 3 features, AI rollout and consent, and reminders.
- [ ] The support code can be selected and copied.

### 2. Simplified navigation (Priority 0)
- [ ] On your phone, which uses the classic nav today, the app opens with **Today · Plan · Progress · Profile** and a **"A simpler layout"** card on Today.
- [ ] **Got it** hides the card, and it stays hidden after a reload.
- [ ] In a private window, or on a second device, **Use classic navigation** brings back the classic nav. The card doesn't come back after a reload.
- [ ] Profile → Simplified navigation still switches between the two.

### 3. Today headline (Priority 1)
- [ ] Next to "Sessions this week" there is a useful number, not a fixed "Bench PB". For you that will probably be your biggest recent improvement or your most-trained lift.
- [ ] Tap it to open **What shows on Today**. Pin a lift, and the card shows that lift's best.
- [ ] Choose **Automatic** and it goes back.
- [ ] After a reload on another device, the pin is still there (it syncs).

### 4. Sign-in forms (Priority 2). Use a private window, signed out.
- [ ] **Enter** submits Sign In, Create Account, Reset and Resend.
- [ ] Your password manager offers to fill on Sign In and to save on Create Account.
- [ ] **Show / Hide** works.
- [ ] A wrong password shows "That email and password don't match…" with the password field marked.
- [ ] Signing in for real leaves your history and settings intact.
- [ ] Sign in with the phone in airplane mode: you get the "Couldn't reach the server… your workouts on this device are safe" message, and nothing local changes.
- [ ] VoiceOver reads the error out.

### 5. Keyboard and screen reader (Priority 3), on desktop
- [ ] Tab reaches the Progress section headers. Enter expands them, and VoiceOver says expanded or collapsed.
- [ ] In the exercise picker, filter chips are reachable by Tab, Space selects them, and VoiceOver says selected.
- [ ] Create a custom programme using only the keyboard.
- [ ] Log body weight and measurements using only the keyboard.
- [ ] The classic nav works by keyboard and VoiceOver announces the current page.
- [ ] Dialogs announce their title, Escape closes them, and focus returns to the control that opened them.
- [ ] The app doesn't feel slower on your phone during a workout.

### 6. Offline coverage (Priority 4). Open the app once with `?p3=offline`.
- [ ] Plan → Offline media shows **"After download, in the gym without signal: …"** for both sizes.
- [ ] Download images. **View coverage** then lists every exercise under video loop, images or text cues only.
- [ ] **Remove** asks first and shows the size to free and what stays. **Keep** cancels.
- [ ] **Airplane mode test (the important one):**
  - [ ] Open the app.
  - [ ] Start a session.
  - [ ] Open the form guide for an exercise with images, then for a text-only one.
  - [ ] Finish the session.
  - [ ] Turn signal back on: the session syncs.

### 7. Feedback (Priority 5)
- [ ] Send named feedback with a large iPhone photo. You get a **receipt** with reference **MG-…** and "Screenshot received (… KB, resized …)".
- [ ] In the Supabase Table Editor, the new row has a `request_id` and a small image.
- [ ] Anonymous feedback: the row has no user id or email.
- [ ] Send 6 quickly. The 6th says "try again in a few minutes".
- [ ] Send in airplane mode: you see the offline message. Send again online: there is **exactly one** row.

### 8. AI beta (Priority 6), signed in as yourself, with AI coaching on in Profile
- [ ] The coach tip, a typed set and the Progress recap each show a **"Beta:"** explanation once. **Got it** hides it.
- [ ] The recap asks **"Was this summary helpful?"**
- [ ] Data health shows the **Beta** rows. **Copy failed AI cases** copies codes only, with no workout details.
- [ ] Optional: an account that isn't in `ai_beta` sees no AI surfaces.

### 9. Update path (Priority 7 and everything above)
- [ ] On a device that still has the old version, the update banner appears. Accept it and the app reloads on **2026.11.25.9**.
- [ ] **Then airplane mode:** the app still opens, a set can be logged, and the session finishes.

## C. After pushing `main`
- [ ] On the production URL: sign in, log a set, and check Data health shows **2026.11.25.9**.
- [ ] **Weights that never synced (bug fix).** Do this on production, because the stuck queue lives in the production app's storage, not the preview's.
  - [ ] Open the app on your **phone** and wait about 10 seconds. Data health goes from "64 other change(s)… waiting to sync" to all green.
  - [ ] Reload on your **laptop**. The weights you changed on the phone appear there.

## Not covered by this cycle
- Phase 3 features (offline downloads, programme finder, share links) are **still off by default**. Turning them on is a separate decision.
- The live AI model evaluation was skipped because no API key was in the shell. Run it with `ANTHROPIC_API_KEY=$(pbpaste) node tests/evals/run.mjs`.
- Priority 7 has started (slice 1 of 6). Next comes the sync module; see `docs/architecture.md`.
