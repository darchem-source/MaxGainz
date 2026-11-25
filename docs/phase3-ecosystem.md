# Max Gainz — ecosystem integrations: build / no-build (Phase 3)

25 November 2026 · decision memo, no code · scope: Apple Health / Health Connect, Strava, watch support, home-screen widgets, scheduled (server-sent) reminders.

## Bottom line

| Integration | Decision | Build when |
|---|---|---|
| Scheduled reminders (Web Push) | **Build next** (small, Phase 4 candidate, behind a flag) | Now is reasonable; confirm with the reminder signal below first |
| Strava (post workouts) | **Not now** | Sharing is used and people ask for Strava by name |
| Apple Health / Health Connect | **Not now** | A native wrapper is decided for other reasons |
| Watch support | **No** | A native app exists *and* logging speed data says the phone is the bottleneck |
| Home-screen widgets | **No** | A native wrapper exists |

The common thread: four of the five need a native app (App Store / Play distribution, review, a second codebase). Max Gainz is a single-file PWA, so the honest choice is to build the one integration the web platform supports well (Web Push) and set a clear trigger for going native.

## What we can measure today

Phase 2's measurement (AI outcomes, and Phase 3's offline metrics) is **stored per device and never uploaded**, so there is no aggregate usage data to base these calls on. The signals that *are* central and need no new code:

- **Sharing demand.** `public.share_counts` holds links created per user per day. Example:
  `select date_trunc('week', day) w, count(distinct user_id) users, sum(n) links from share_counts group by 1 order by 1;`
- **Explicit requests.** The `feedback` table (dashboard only). Example:
  `select category, count(*) from feedback where message ~* '(strava|apple health|health connect|watch|widget|remind|notification)' group by 1;`
- **AI usage** (`ai_usage`). Shows engaged, consenting users, a proxy for an audience that wants deeper integrations.

Recommendation: review these monthly. If an aggregate view of the on-device metrics is wanted, that is a separate, opt-in design decision: it would upload usage data.

## 1. Scheduled reminders (server-sent Web Push) — build next

- **User gain.** "Time to train" arrives even when the app is closed, on the user's planned days. Today reminders only appear inside the app. The audit's P2 "Reminders need an honest product promise" is about exactly this gap.
- **What it needs.**
  - **Keys.** VAPID keys (one Netlify env var).
  - **Subscriptions.** A `push_subscriptions` table: endpoint plus keys, user id, local reminder time, timezone. RLS owner-only, written only through an RPC.
  - **Sending.** A Netlify *scheduled* function, run hourly, that sends to subscriptions due in that hour.
  - **Settings.** A settings toggle and an unsubscribe.
  - **iOS.** Web Push works only when the PWA is **installed to the Home Screen** (iOS/iPadOS 16.4+), and permission must be asked from a user tap. Android and desktop browsers work in normal tabs.
- **Privacy.** The push endpoint is a device identifier, so the subscription row is treated like any account data: deleted on sign-out on that device and on account deletion. The notification payload carries no workout data, just "Upper day today · 3 of 4 this week" built from counts at most, or a fixed text.
- **Cost.** Push delivery is free. One hourly scheduled function is well inside Netlify's free function allowance. No third-party push service is needed.
- **Effort.** About 1 week, including gates for "no workout data in payloads" and the unsubscribe and deletion paths.
- **Signal to confirm before building.** At least a meaningful share of active users (suggest 25%+) have the in-app reminder switched on, *or* weekly plan adherence drops in the weeks after a missed session. Both can be read from the profile blob (`prefs`) and session history without new tracking.

## 2. Strava — not now

- **User gain.** Each Max Gainz session appears on the user's Strava feed as a "Weight Training" activity (duration, title, a summary line). It is social visibility, not new training value.
- **What it needs.**
  - **Accounts.** OAuth with the client secret held in a Netlify function, and a token table with refresh handling and revocation.
  - **Writing.** An upload or create-activity call per session.
  - **Limits.** Default rate limits are 200 requests per 15 minutes and 2,000 per day. Higher limits need Strava's approval as users grow.
- **Terms.**
  - Since November 2024, Strava's API agreement limits third-party apps to showing a user's Strava data **only to that user**, and bars using API data in AI models. Coverage in 2026 reports stricter guidance on AI use.
  - A **write-only** integration (we post, never read) avoids most of this, and keeps Strava data out of the Phase 2 AI coaching entirely. Any read feature (importing runs, for example) would collide with the AI-use clause.
  - Check the current agreement before building.
- **Privacy.** OAuth tokens are credentials: encrypted at rest, scoped to `activity:write` only, deleted on disconnect and on account deletion.
- **Effort.** 1–2 weeks.
- **Trigger.** Private sharing (Phase 3) is used, with links created by a steady share of weekly users, *and* feedback names Strava repeatedly. Until then, the private share link and image cover "show someone my workout" without a third-party account.

## 3. Apple Health / Health Connect — not now

- **User gain.** Workouts written to Health / Health Connect (type, duration, maybe energy), contributing to rings and step and energy totals. Optionally, body weight read back.
- **What it needs.**
  - **Native only.** Neither is reachable from a web page. HealthKit needs an iOS app with the HealthKit entitlement and App Store review. Health Connect is Android-only and needs a Play app with a developer declaration form for each data type.
  - **A wrapper.** Realistically a Capacitor or similar wrapper around the existing app, plus a native plugin.
- **Privacy.** Health data is the most sensitive data the app would touch. Store policies require a privacy policy section and purpose limitation. Reading body metrics conflicts with the "no body measurements" stance in sharing, so writing workouts only is the safer start.
- **Cost.** Apple Developer Program at US$99/yr, a Play developer account, and ongoing review overhead.
- **Effort.** 2–4 weeks for the wrapper and both plugins, plus store setup.
- **Trigger.** A decision to ship native apps for a broader reason (for example push reliability on iOS without installing, or store discoverability). Health sync then rides on that decision; it shouldn't drive it alone.

## 4. Watch support — no

- **User gain.** Logging sets and seeing rest timers from the wrist.
- **What it needs.** A watchOS app (Swift) and a Wear OS app (Kotlin), each with phone sync. That means two new native codebases.
- **Privacy.** Low added risk, since it's the same data on the user's own devices.
- **Effort.** 4–8+ weeks, with continuing maintenance.
- **Trigger.** A native app exists *and* data shows set logging is slow on the phone. Phase 1/2 measured "time to log a set" and typed-set use; if typed sets and Repeat don't bring logging down to a few seconds, revisit this.

## 5. Home-screen widgets — no

- **User gain.** "Today: Upper · 3 of 4 this week" on the home screen.
- **What it needs.** iOS widgets need WidgetKit in a native app. Android Home Screen widgets for PWAs aren't generally available; there is only limited experimental support on Windows/Edge. So this is native-only in practice.
- **Effort.** About 1 week once a native wrapper exists; impossible without one.
- **Trigger.** A native wrapper exists. Until then, the Today screen and (if built) server-sent reminders cover the same "what's today" need.

## Sources

- Strava API agreement changes, November 2024: [DC Rainmaker](https://dcrainmaker.com/2024/11/stravas-changes-to-kill-off-apps.html), [Cyclingnews](https://www.cyclingnews.com/news/strava-plan-to-restrict-third-party-apps-has-users-in-an-uproar), [TechRepublic, 2026](https://www.techrepublic.com/article/news-strava-api-scraping-crackdown/)
- Strava rate limits: [developers.strava.com/docs/rate-limits](https://developers.strava.com/docs/rate-limits/)
- Web Push on iOS/iPadOS 16.4 (Home Screen apps only): [WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- Health Connect platform and declaration: [Android developers: availability](https://developer.android.com/health-and-fitness/guides/health-connect/plan/availability), [Play policy FAQ](https://support.google.com/googleplay/android-developer/answer/12991134)
