<!-- Paste everything below the line into App Store Connect > App Review Information > Notes. Limit 4000 bytes. Fill every [PLACEHOLDER] and delete any native feature that is not in the submitted build. Current text is about 3,030 bytes. -->
---
Max Gainz is a workout tracker: live set logging, programmes, interval timers and progress analytics.

DEMO ACCOUNT
Email: [DEMO EMAIL]
Password: [DEMO PASSWORD]
The account has [8 weeks] of sample history and does not expire. Our backend (Supabase) is live. An account is optional, see below.

ACCOUNT IS NOT REQUIRED (GUEST MODE)
Tap "Continue without an account" on the first screen. Workouts then stay on the device. An account is offered only for sync and backup across installs. Sign-up uses our own email and password, so Sign in with Apple is not required (4.8).

HOW TO REACH THE PAYWALL AND SUBSCRIPTION
1. Launch the app (guest or demo account).
2. [Complete or skip onboarding, then tap Start Workout / open Settings > Subscription] to open the subscription screen.
It shows both plans, the price, the 1-week free trial and what is billed after it, Restore Purchases, and links to the Terms of Use (Apple standard EULA) and Privacy Policy. Products: auto-renewable subscription group "Max Gainz Pro", maxgainz_pro_monthly and maxgainz_pro_annual, each with a 1-week free introductory offer. Purchases use StoreKit with RevenueCat. Please test with the sandbox.
After the trial ends without a subscription the app is limited: users can still view history, export data and delete their account. Logging new workouts and other features need the subscription. Our description states this.

ACCOUNT DELETION
Settings > [Account > Delete Account]. It deletes the sign-in record, profile and all workout data on our servers, tells the user that an Apple subscription must be cancelled separately (with a link to Apple's subscription page), and works without an active subscription. Data export is under [Settings > Data > Export].

NATIVE FEATURES [keep only what is in the build]
- Local notifications: a daily training reminder when a muscle group is overdue (no other notifications)
- Haptic feedback when logging sets
- Screen kept awake during a workout
- Native share sheet and save to Files for data export and workout share cards
- Camera or photo library for the profile photo
- Offline use: workouts are stored on device and sync when online
Other features: swipe and tap set logger, plate-aware weight steps, supersets and exercise swaps, Tabata/AMRAP/EMOM timers, 13 programmes plus a custom programme builder, 235-exercise library, charts, muscle heatmap and estimated one-rep max.

TECHNICAL NOTES
- All app screens and scripts are bundled in the binary. The app does not load its interface or code from a website.
- Exercise visuals are written text form guides. The app contains no exercise videos or GIFs.
- No analytics, advertising or tracking SDKs; no App Tracking Transparency prompt. Third-party services used: Supabase (accounts, data), RevenueCat (subscriptions).
- Not a medical device. A health disclaimer appears in onboarding, Settings and the form guide. The medical device declaration is No.
- Age rating: [9+ / 13+ as set]. Minimum age in Terms is 13.

Contact: [REVIEW CONTACT NAME], [REVIEW CONTACT EMAIL], [REVIEW CONTACT PHONE].
