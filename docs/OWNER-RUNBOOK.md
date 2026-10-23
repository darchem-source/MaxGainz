# Max Gainz → App Store: your runbook

Status 16 Oct 2026: the build is complete on branch `app-store` (draft PR #1: https://github.com/darchem-source/MaxGainz/pull/1). The live web app on `main` is untouched. Everything below is a step only you can do, in order. Each step says where the detailed instructions live (all in the `app-store` branch or the team folder).

## Phase A — this week (no Apple account needed yet)
1. **Apple Developer Program, as an individual.** Apple Developer app on your iPhone → Enroll (ID check). ~$99 / £78.99 a year. Later you'll migrate it to the company via Apple's "migrate individual account" request.
2. **Company, in the background.** GOV.UK One Login identity check → Companies House (£100, neutral name, registered-office service if you want your home address private) → a domain + mailbox on it → D-U-N-S via Apple's lookup → business bank account.
3. **Pick a support email** you're happy to publish (it goes on the App Store listing and in the privacy policy). Tell me and I'll replace the `[SUPPORT EMAIL]` placeholder everywhere.
4. **Decide the bundle ID.** Default `com.maxgainz.app` (in `native/capacitor.config.json`). It becomes permanent at the first upload.

## Phase B — once Apple approves you (App Store Connect)
5. Accept the latest agreements (Business → Agreements). Then **Paid Apps agreement** + tax (likely W-8BEN for you as an individual) + bank details. Enrol in the **Small Business Program** (15% commission).
6. **Create the app record** (name "Max Gainz", bundle ID from step 4, Health & Fitness, iPhone). EU DSA trader status: declare; for v1 exclude EU storefronts (your personal address would be published), add the EU once the company owns the account.
7. **Subscriptions**: one group "Max Gainz Pro"; products `maxgainz_pro_monthly` and `maxgainz_pro_annual`; prices; a **1-week free introductory offer** on each; localisations; the review screenshot (`screenshots/review-paywall-1290x2796.png`). Exact clicks: `backend-runbook.md` Part F.
8. **RevenueCat**: free account → project → iOS app with your bundle ID → entitlement `pro` → default offering with Annual/Monthly packages → generate the **In-App Purchase key** in App Store Connect and upload it → copy the **public API key** into `native/capacitor.config.json` (`plugins.MaxGainzNative.revenueCatApiKey`). Part F again.
9. **App Store Connect API key** (Users and Access → Integrations → Team key, Admin role; download the .p8 once) + your Team ID → four GitHub secrets (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` base64, `APPLE_TEAM_ID`). Steps: `.github/workflows/README` = `ci/README.md`.
10. **Supabase** (SQL Editor): run `supabase/delete_my_account.sql`, then `supabase/verify_security.sql` and read the PASS/FAIL table; add the three redirect URLs (Authentication → URL Configuration) listed in `backend-runbook.md` Part D. Plain-English walkthrough: `backend-runbook.md` Parts A–D.

## Phase C — first build and testing
11. Push anything to `app-store` (or run the workflow by hand in GitHub → Actions → TestFlight). First run = first real test of the upload; if it fails, send me the log.
12. Install from TestFlight on your iPhone and run `backend-runbook.md` Part E: guest mode, sign-up adoption, a full session with rest timer + reminder notification, share card, export, password reset via `maxgainz://auth`, sandbox purchase (trial shows), restore, and account deletion with a throwaway account.
13. Tell me what broke; the team fixes it on the branch.

## Phase D — listing and submission
14. Fill the placeholders: `listing/listing.md` (copy for every field, age-rating answers → override to 13+, privacy label answers, medical-device = No, export compliance = No), `listing/review-notes.md` (demo account), `privacy.html` / `terms.html` / `support.html` (your name/company and address, dates). Upload screenshots from `screenshots/iphone-6.9-1290x2796/` (and the 6.3" set).
15. Merge PR #1 so `/privacy`, `/terms`, `/support` go live on maxgainz.netlify.app (web users see one "new version" banner). Check the three URLs work.
16. Add the build to the version, attach the subscription group to the submission (the first subscription must go with an app version), **Submit for Review**. Apple: 90% reviewed within 48 hours. Any rejection → paste it to me.

## Later (not v1)
- Migrate the Apple membership to the company; update the privacy policy controller; add EU storefronts.
- Trademark check on "Max Gainz"; Texas age-assurance question before adding US-specific features.
- Licensed exercise demos (ExerciseDB one-time dataset) — ask AscendAPI for the licence text first.
- Apple Health; Android.
- Legal review of terms (liability cap) and ICO registration.

## Where everything is
- Code: branch `app-store`, PR #1. Team folder (this machine): `/home/claude/appstore-team/` — `decisions.md`, `audit.md`, `mock-review.md`, `requirements-*.md`, `listing/`, `screenshots/`, `ci/`, `backend-runbook.md`, `backend-client-spec.md`.
