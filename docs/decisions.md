# Max Gainz → App Store: decisions log

Owner: Max (non-developer). Orchestrated from a claude.ai Project session. Last updated 16 Oct 2026.

## Product decisions (from Max)
- Platform: iOS App Store first (Android later). iPhone only.
- Monetisation: auto-renewable subscription, ONE subscription group, two products: monthly and annual. Both carry Apple's introductory offer: 1-week free trial.
- After the trial without a subscription: user can view history, export their data, and delete their account. Everything else is locked behind the subscription ("hard paywall after trial").
- Web version (maxgainz.netlify.app) stays free and unchanged for now.
- Apple Health: not in v1 (first update candidate).
- Exercise demos (decided 16 Oct after licence research — see requirements-tooling.md §6–7):
  - iOS v1 launches WITHOUT ExerciseDB media: no static.exercisedb.dev GIFs (free tier is non-commercial only) and no V2 videos (not cleared for app use). In the native app these sources are switched off entirely.
  - iOS v1 shows TEXT FORM GUIDES ONLY. The 32 wger-credited loop.mp4 files are also dropped from the iOS build (audit B3: phone clips of different people/gyms, bystanders, audio; single blanket credit unverifiable). They are not shipped in www/.

## Audit-driven decisions (16 Oct, from audit.md)
- Guest mode: YES — "Continue without an account". Workouts stay on-device until sign-up; sign-up offered for sync/backup. Trial + paywall must work for guests (RevenueCat anonymous id, aliased to the Supabase id on sign-up).
- Brand-adjacent names ("Garry's Bootcamp" classes, "Hot Girl Summer" series, programme library coach credits): Max decided to KEEP ALL AS IS, accepting the 5.2.1/5.2.5 risk. Do not rename. If App Review rejects on these, renaming is the ready fix (session day-name migration needed for Garry's).
- Password reset: fix for web and native (recovery-token handler + set-new-password screen; explicit redirect_to per platform).
- Health disclaimer: add at onboarding before the injury step, in Settings and in the form guide; soften "keep you safe" copy.
- Remove developer/test copy from user-facing strings (file:// box, Supabase dashboard hints, RLS error text).
- Native build: no web/browser/Netlify references, no SW update banner, no links to the web app (R4, R7).
  - The free-exercise-db JPGs (exercise-media/*/N.jpg) are scraped/copyrighted: REMOVE them from the repo and from the web app too (Max approved). The web app must not show broken images afterwards.
  - The free web app may keep ExerciseDB GIFs/V2 videos but must show a visible credit to AscendAPI (free-tier requirement).
  - Licensed demos (e.g. ExerciseDB one-time dataset, $300–600) are a post-launch decision.
- Developer account: Max enrols as an INDIVIDUAL now (to unblock App Store Connect, TestFlight, name reservation, sandbox), then migrates the membership to his new UK limited company (Apple's migrate-individual-account request) before launch. Apple's own organisation verification has no published duration (forum reports 2–6+ weeks).
- Company: will be registered under a NEUTRAL name (not tied to "Gainz"), so the app can be renamed without touching the company or Apple account. Max will get a trademark check on "Max Gainz" before launch (US registered mark GAINZ, Reg. 6594311, class 9 fitness apps; 15+ "Gainz" apps on the store).
- Privacy/terms/support pages: host on the existing Netlify site first (maxgainz.netlify.app/privacy, /terms, /support) so they exist before the company domain does; the controller is Max as an individual until the company takes over, then update the policy.
- Open legal question for later (before choosing storefronts): Texas SB 2420 app-store age assurance for US users (Declared Age Range API). Not decided.

## Technical decisions (orchestrator)
- Wrapper: Capacitor 8.x (RevenueCat 13.x requires @capacitor/core >= 8; Capacitor 8 needs Xcode 26; App Store uploads must use the iOS 26 SDK since 28 Apr 2026).
- Builds: GitHub Actions macOS runners (no local Xcode needed). Blocked until Max installs the Claude GitHub app (push access refused as of 16 Oct).
- Purchases: RevenueCat core SDK (@revenuecat/purchases-capacitor, pin 13.7.4) with a paywall built in HTML inside the app (so every Apple-required disclosure is in versioned code we can review), not RevenueCat's remote paywall templates. RevenueCat `logIn` with the Supabase user id.
- Proposed product IDs (cannot be changed or reused once created — confirm before Max creates them): `maxgainz_pro_monthly`, `maxgainz_pro_annual`; subscription group "Max Gainz Pro"; RevenueCat entitlement `pro`.
- Bundle ID placeholder: `com.maxgainz.app` (confirm before the App Store Connect record is created).
- Terms: link to Terms of Use in the app (paywall + settings) and in the App Store description; privacy policy URL in App Store Connect and in the app.
- Code lives on branch `app-store` (iOS shell, app changes) and `app-store-backend` (Supabase SQL); merged via one PR to main once Max has tested on TestFlight.

## Apple organisation enrolment requirements (verified 16 Oct 2026 — see requirements-subscriptions.md §8)
- Legal entity, D-U-N-S number, legal binding authority.
- Public, functional website on a domain associated with the organisation (no placeholder/registrar pages).
- Work email on the organisation's domain.
→ The team builds the company website (landing + privacy + terms + support). Max picks the company name and domain.
