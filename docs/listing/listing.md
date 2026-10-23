# App Store Connect listing: Max Gainz (iOS)

Drafted 16 Oct 2026. Placeholders in [SQUARE CAPITALS] need Max. Limits come from `requirements-apple.md` section 2. Nothing here has been entered in App Store Connect.

## 1. App information

| Field | Value | Limit / note |
|---|---|---|
| Name | `Max Gainz: Workout Tracker` (26) | 2-30. Availability of the name is not confirmed (requirements-apple.md Q10); trademark check pending per decisions.md. Fallback: `Max Gainz` (9) |
| Subtitle | `Log lifts, timers & progress` (28) | 30 |
| Promotional text | `Log sets, follow programmes, time your rest and track progress. Free for 1 week, then subscribe. No ads or trackers.` (116) | 170. Editable without a new version |
| Keywords | `gym,lifting,strength,log,hiit,tabata,timer,sets,reps,1rm,plate calculator,emom,amrap,training` (93 bytes) | 100 bytes. Words already in the name/subtitle are left out on purpose |
| Primary category | Health & Fitness | Secondary: none (a second health category would add no value; see medical-device note) |
| Support URL | https://maxgainz.netlify.app/support | |
| Marketing URL | https://maxgainz.netlify.app/ | Optional |
| Privacy Policy URL | https://maxgainz.netlify.app/privacy | Required |
| Terms of Use | No separate field. Apple's standard EULA link is in the description (below). The same link must appear in the app's paywall alongside https://maxgainz.netlify.app/terms | requirements-subscriptions.md section 5 |
| Copyright | `[YEAR] [CONTROLLER NAME]` | Update to the company on migration |
| Price | Free (with in-app subscription) | |
| Version "What's New" | Not shown for the first version. Template for 1.0.1 below | 4000 |

### What's New (for the first update, not v1.0)
```
- Bug fixes and small improvements.
```

### Description (2,642 characters; limit 4000)
```
Max Gainz is a workout tracker for people who lift. Log every set, follow a programme, time your rest and see your progress over weeks and months.

LOG YOUR TRAINING
- Fast set logging: tap to record reps, adjust weight in plate-aware steps
- Warm-up sets, supersets, exercise swaps, and adding or removing exercises mid-session
- Optional RPE tracking and a session timer
- Log other activity too, such as running, swimming or tennis

PROGRAMMES AND PLANS
- 13 ready-made programmes, plus built-in split routines including Push/Pull/Legs
- Build your own programmes and HIIT workouts
- Multi-week plans with a 4-week build, push and recover cycle
- Onboarding that suggests starting weights from your experience, body weight, goal and any injuries you tell us about

TIMERS
- Rest timer with countdown cues
- Tabata, AMRAP and EMOM timers
- Guided warm-up, cool-down and mobility flow

EXERCISE LIBRARY
- 235 exercises with target muscles, equipment, difficulty and coaching cues
- Written step-by-step form guides

SEE YOUR PROGRESS
- Calendar, body-weight log and body measurements
- Personal bests and strength charts, with estimated one-rep max and a 1RM calculator
- Muscle-balance heatmap, training frequency, rest-time and volume analysis
- Plate calculator
- Ranks, achievements and streaks for motivation

YOUR DATA
- Use it without an account, or sign up to sync and back up your history
- Export your data at any time
- Delete your account and data inside the app
- No ads. No analytics or advertising trackers.

MAX GAINZ PRO
Start with a 1-week free trial (one trial per Apple Account), then choose a monthly or annual subscription to keep logging workouts and using all features. Without an active trial or subscription you can still view your history, export your data and delete your account.

- Payment is charged to your Apple Account at confirmation of purchase, or when the free trial ends.
- Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period.
- Manage or cancel in iPhone Settings > your name > Subscriptions. Any unused part of a free trial is forfeited when you purchase a subscription.
- Prices are shown in the app before you subscribe.

IMPORTANT
Max Gainz is a training log, not medical advice. Speak to a doctor or qualified professional before starting an exercise programme, and stop if you feel pain.

Terms of Use (Apple Standard EULA): https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
Max Gainz Terms: https://maxgainz.netlify.app/terms
Privacy Policy: https://maxgainz.netlify.app/privacy
Support: https://maxgainz.netlify.app/support
```

Notes on the description:
- It contains the Apple Standard EULA link and the privacy link, as required.
- It says plainly that logging needs a subscription after the trial, to avoid a "bait and switch" objection (3.1.2(a)).
- It makes no health outcome claims. It does not mention notifications, haptics, Apple Health or exercise videos, which are not in v1 or not built yet; add notification wording only once the feature ships.
- It says "13 ready-made programmes", "235 exercises" and "written form guides", taken from audit.md section 6. Re-check these numbers against the final build (the 32 wger videos and ExerciseDB media are removed from iOS).
- The brand-adjacent names that Max chose to keep (Garry's Bootcamp classes, "Hot Girl Summer") are deliberately not used in the listing or screenshots. Do not show them in screenshots either.

## 2. Age rating questionnaire (expected result: 9+)

Answer in App Store Connect > App Information > Age Rating. The exact answer options (None / Infrequent / Frequent) could not be seen without an account (UNVERIFIED), so check the live calculated rating before submitting.

| Question | Answer |
|---|---|
| Parental controls / age assurance (in-app controls) | No |
| User-generated content | No (nothing is shared with other users) |
| Messaging and chat | No |
| Advertising | No |
| Unrestricted web access | No |
| Social media (feed / discovery of others' content) | No |
| Health or wellness topics (exercise recommendations, calorie or dieting advice) | **Yes** (this is what produces 9+) |
| Medical or treatment information (diagnosis, treatment, medication guidance) | **None**. Do not tick: infrequent gives 13+, frequent gives 16+ |
| Contests (users competing for rankings or rewards) | None. XP, ranks and achievements are personal, no leaderboard |
| Profanity or crude humour, horror or fear, mature or suggestive themes, violence (cartoon or realistic), guns or weapons, sexual content or nudity, alcohol, tobacco or drug references, simulated gambling, real gambling, loot boxes | None to all |
| Made for Kids | No (not offered as a target audience) |

**Expected calculated rating: 9+.**

**Decision needed (inconsistency):** the Terms and Privacy Policy say users must be at least 13. Apple says you must override the rating upwards if your EULA sets a minimum age above the calculated rating (requirements-apple.md section 3). So either (a) override to 13+ in App Store Connect to match the Terms, which is the simplest consistent option, or (b) lower the stated minimum age in privacy.html and terms.html. Recommendation: (a). 13 is also the UK GDPR age for children consenting to online services. Max to decide; the team's pages currently say 13.

### Regulated medical device declaration
Answer **No** for every region where it is asked (EU/EEA, UK, US). Max Gainz is a training log with general fitness suggestions, makes no diagnostic or treatment claims, and uses health data only to run its own features. Only the Account Holder or Admin can answer. Do not answer "frequent" on medical information, which would force the full declaration. Keep the Terms, privacy policy and listing wording consistent with "not a medical device".

## 3. App Privacy label (nutrition label)

Source: audit.md section 5 and requirements-subscriptions.md 7a. **Tracking: No. No third-party advertising. No data used to track you across other companies' apps and websites.** There is no ATT prompt. Every item below is **linked to the user** and **not used for tracking**.

| Apple data type | Collected? | Linked | Tracking | Purposes |
|---|---|---|---|---|
| Contact Info > Email Address | Yes (sign-up, feedback unless anonymous) | Yes | No | App Functionality |
| Contact Info > Name | Yes (account name, profile name) | Yes | No | App Functionality |
| Health & Fitness > Health | Yes (body weight, measurements, injury history, height) | Yes | No | App Functionality, Product Personalization |
| Health & Fitness > Fitness | Yes (workouts, sets, reps, weights, activities, personal bests) | Yes | No | App Functionality, Product Personalization |
| User Content > Photos or Videos | Yes (profile photo, optional feedback screenshot) | Yes | No | App Functionality |
| User Content > Customer Support | Yes (feedback text) | Yes | No | App Functionality |
| User Content > Other User Content | Yes (daily notes, exercise notes) | Yes | No | App Functionality |
| Identifiers > User ID | Yes (Supabase account ID; also the RevenueCat app user ID) | Yes | No | App Functionality |
| Purchases > Purchase History | Yes (subscription status and transactions via RevenueCat) | Yes | No | App Functionality |
| Other Data > Other Data Types | Yes (date of birth, gender, training experience and goals) | Yes | No | App Functionality, Product Personalization |

**Not collected:** Location, Contacts, Browsing History, Search History, Financial Info (Apple handles payment), Sensitive Info (see note), Usage Data (product interaction, advertising data), Diagnostics (crash data, performance data), Device ID/Advertising Identifier, Other usage data.

Notes for Max:
1. **Feedback "optional disclosure" exception: do not use it.** Disclose feedback collection.
2. **Guest mode.** Guest workouts stay on the device and are not collected. The data above is collected only if the user creates an account, but the label has to cover the app as a whole, so declare it. RevenueCat creates an anonymous ID for guests; it is covered by the User ID and Purchase History entries.
3. **Date of birth / gender.** Audit P6 recommends removing date of birth and age. If the team removes them, delete the "Other Data" row. Keep the privacy policy in step.
4. "Sensitive Info" in Apple's list covers items like racial or ethnic data, sexual orientation, biometric data and so on. Injury history is declared under Health, not Sensitive Info. Confirm in the live form.
5. RevenueCat's own privacy manifest (SDK 5.95.0) declares Purchase History, not linked, not tracking. Our label says linked because we pass the account ID. This is consistent with RevenueCat's guidance (requirements-subscriptions.md 7a). Re-check against the Xcode privacy report of the final build.
6. The label must match the privacy policy page and the privacy manifest in the build. If any SDK is added, update all three.

## 4. Export compliance

Set `ITSAppUsesNonExemptEncryption` = `NO` in the app target's Info.plist (Capacitor's template does not set it). In App Store Connect, if asked: the app uses only encryption built into the operating system (HTTPS/TLS through WKWebView and URLSession), so no export documentation is required and no French declaration is needed. Caveat: this assumes RevenueCat and Capacitor add no proprietary cryptography (requirements-apple.md section 8 marks this UNVERIFIED); the build team should confirm before submission.

## 5. EU Digital Services Act trader status

Required before submission, even if the app is not sold in the EU. Apple asks for a trader declaration at account level (Business > Agreements > Compliance > Digital Services Act).

- Selling subscriptions in the course of a business is likely to make Max a **trader**; a limited company certainly would be (requirements-apple.md section 7, subscriptions section 9). Apple does not make this decision for you and it is not legal advice.
- **Consequence for an individual account:** if declared a trader, Apple publishes the trader's address, phone number and email on the product page in each EU country, and verifies them. As an individual that could mean a **home address and personal phone number shown publicly**. Options: (1) wait and make the declaration once the company exists and has a business address and number; (2) exclude EU countries in Availability for the first release (declaration still required; apps without verified trader status are removed from the EU store); (3) use the company route before launch.
- Decision needed from Max before launch. Do not choose "not a trader" unless Max has taken advice, because the app earns subscription revenue.

## 6. Subscriptions

**Subscription group**
- Reference name: `Max Gainz Pro`
- Group display name (localisation, en-GB / en-US): `Max Gainz Pro`

| | Monthly | Annual |
|---|---|---|
| Product ID | `maxgainz_pro_monthly` | `maxgainz_pro_annual` |
| Reference name | Max Gainz Pro Monthly | Max Gainz Pro Annual |
| Duration | 1 month | 1 year |
| Display name (2-30) | `Pro Monthly` (11) | `Pro Annual` (10) |
| Description (max 45) | `Full access to Max Gainz, billed monthly` (40) | `Full access to Max Gainz, billed yearly` (39) |
| Price | [MONTHLY PRICE] | [ANNUAL PRICE] |
| Introductory offer | Free, 1 week, new subscribers | Free, 1 week, new subscribers |
| Group level | Same level (do not rank one above the other unless Max wants upgrade/downgrade behaviour) | |

- IDs cannot be changed or reused once created (decisions.md). Confirm the bundle ID `com.maxgainz.app` first.
- Each subscription needs a review screenshot of the paywall that shows price, trial length and the Terms and Privacy links.
- The first subscription must be submitted with an app version (requirements-subscriptions.md 3.3).
- Descriptions avoid prices and the word "free" so they cannot be wrong when prices change.

## 7. Other submission items (for Max)
- App Review contact: name, email, phone in international format with country code: [REVIEW CONTACT NAME / EMAIL / PHONE]
- Demo account: see `review-notes.md`. Create it and make sure it does not expire.
- Screenshots: iPhone Dynamic Island large and medium sets, signed-in/in-use screens only; no ExerciseDB GIFs; no brand-adjacent names.
- Content rights: confirm no third-party media is shipped in the iOS build (decisions.md: text form guides only).
- App availability: set territories (Texas age-assurance question is open in decisions.md).
- The three web pages (privacy, terms, support) must be live at the URLs above before submission.
