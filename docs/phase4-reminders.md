# Phase 4 — training-day reminders (server-sent Web Push)

Status: built behind the `?p4=reminders` flag (device-level, reversible with `?p4=0`), plus a server kill switch (`PUSH_ENABLED=1`).

## The promise (what the app says, and what is true)

> We send one notification at about this time on the days you pick, even when the app is closed. We never send one on a day you've already logged a workout. It says only "Time to train" and the day type (for example "Upper day today"). Your weights, notes and name are never in a notification.

- **One per day, at most once.** Before sending, `push_claim` records (account, scope, local date) in `push_sent` atomically. That means:
  - Overlapping, repeated or crashed runs can't send twice. A run killed mid-way can lose that day's reminder, but never duplicate it.
  - An account none of whose devices was reached (a temporary failure, or the run ran out of time) is released for the next hourly run.
  - The record outlives the schedule for 3 days, so turning reminders off and on again can't send twice either.
  - Preview test runs use their own scope, so they never use up the production reminder.
- **Every device gets it.** All of the account's opted-in devices get that one reminder (same tag). An account can have at most 5 devices.
- **One schedule per account.** The account's schedule on the server is the source of truth: hour, days, "follow my Path" and time zone.
  - A device that turns reminders on while another device already has them adopts the account's settings, and says so.
  - Changes made on a device are pushed first. Other devices pick them up on their next sync, at most 30 minutes later.
  - The time zone changes only when someone taps "Use this device's time zone", so a laptop in another zone never moves the phone's reminder.
- **"At about this time".** An hourly run at :00 UTC. The reminder arrives within the chosen hour: at :00, or at :30 or :45 in half-hour and 45-minute zones (India, Nepal, parts of Australia).
  - A run that is missed, or fails temporarily, retries for up to 3 hours, but never past local midnight.
  - On DST change days it is still sent exactly once (gate 24).
- **"Never on a day you've already logged a workout".** "Logged" means the workout has reached the account. One finished offline and not yet synced can't be seen, so that day may still get a reminder.
- **Even when the app is closed.**
  - Android and desktop browsers: yes.
  - iPhone and iPad: only when Max Gainz is installed to the Home Screen (iOS 16.4+). The card detects this and shows install steps instead of a switch. In-app browsers (Instagram, Facebook…) are told to open Safari first.
- **Payload:** `{"v":1,"kind":"train","label":"upper","date":"2026-11-25"}`, encrypted end to end (aes128gcm).
  - The label is one word from a fixed list.
  - `sw.js` builds the text from its own copy of the wording and never shows payload text.

The existing in-app alert (muscle group 7+ days overdue) is unchanged. Its copy now says it only appears when the app is open.

## Where data lives and when it is deleted

| Data | Where | Deleted |
|---|---|---|
| Hour, weekdays, "follow my Path", a label per weekday, IANA time zone | `push_prefs` (one row per account) | when the account's last device is removed; on "Turn off on all my devices"; on account deletion |
| Push endpoint and its two public keys, site origin | `push_subscriptions` (one row per device) | on turn-off on that device; on sign-out on that device (refreshing an expired token once; if the server can't be reached, at the next sign-in on that device); on account deletion; when the push service says it's gone (404/410), or after 7 runs in a row rejected it |
| Local dates the account was reminded on | `push_sent` | after 3 days; on account deletion |
| Sends, trained-day skips, gone endpoints and failures per UTC day | `push_sends_daily` (no user ids) | after 120 days |
| Shown/opened counts | that device's Cache Storage (`maxgainz-push-v1`) | on sign-out and account deletion; never uploaded |

Neither clients nor the scheduler read the tables directly: RLS is on with no policies, and all grants are revoked. Signed-in users act only on their own rows, through SECURITY DEFINER functions scoped to `auth.uid()`. The scheduler uses the public anon key plus `PUSH_CRON_KEY`, whose SHA-256 is stored in `push_cron`. It can only list candidates (no user ids), claim, release and report. No service-role key is used.

## Setup (owner)

1. **Run the SQL.** Paste `supabase/push_reminders.sql` into the Supabase SQL editor and run it. It is idempotent.
2. **Generate VAPID keys locally.** Run `npx web-push generate-vapid-keys`.
3. **Generate a scheduler key.** For example, `openssl rand -hex 32`.
4. **Set Netlify environment variables** (functions scope):
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
   - `VAPID_SUBJECT`: the site URL, e.g. `https://<site>.netlify.app`. A URL keeps personal contact details out of push requests.
   - `PUSH_CRON_KEY`: the scheduler key.
   - `PUSH_ENABLED=1`.
   - Optional: `PUSH_ORIGINS` (comma-separated). The hourly run already covers Netlify's `URL` and `<site>.netlify.app`; list any other production domain here (www/apex).
5. **Store the key's hash in Supabase:**
   `insert into public.push_cron(id, key_hash) values (1, extensions.digest('<the key>', 'sha256')) on conflict (id) do update set key_hash = excluded.key_hash;`
6. **Turn off quickly** by removing `PUSH_ENABLED` (sends stop at the next run). To hide the UI on a device, open `?p4=0`.

**Deploy Previews.** Netlify does not run scheduled functions there. To test "app closed" delivery, close the app on the device and trigger one run for the preview's origin:
`curl -X POST https://<preview-url>/api/push/run -H "x-cron-key: <PUSH_CRON_KEY>"`
It sends only to devices that subscribed on that preview URL, under the preview's own scope, and only if one is due within its 3-hour window. Pick a reminder hour that has just started. On the production deploy, the same call is exactly one hourly run (same scope), so it can't double-send. If Netlify doesn't report the deploy context, the call refuses to run.

## Costs

- Push delivery: free. Browser vendors run the push services.
- Netlify: about 720 scheduled runs a month, each well under 2 s, plus the occasional test or key call. This is negligible next to the function allowance; check your current plan's credit pricing.
- Supabase: two small tables and an hourly read.
- One new dependency, `web-push` 3.6.7. It is used only in the functions; the app itself is unchanged.

## Measurement

- **Central, no user ids:** `select * from push_sends_daily order by day desc;`. Shows sent, skipped because the user already trained, endpoints gone, and failed.
- **Opt-in rate:** `select count(*) from push_prefs;` (accounts) and `select count(*) from push_subscriptions;` (devices).
- **Per device:** shown and opened counts in the Profile card ("On this device, last 30 days: N shown · M opened"). Never uploaded.

### Decision: an opt-in aggregate of shown/opened? Not now.

- **What we already have.** `push_sends_daily` answers "is delivery working?" without any per-person data. The opt-in count answers "do people want this?".
- **The gap.** Only the open rate is missing. It would help tune the default hour and the wording, but not decide whether the feature stays.
- **The cost.** Uploading shown/opened events means:
  - a new data flow from every device;
  - a consent switch, and a privacy-policy line saying the app reports notification interactions;
  - an endpoint that has to resist spam, and anonymous counts that become identifying while the user base is small.
- **When to revisit.** When at least 50 accounts have reminders on (`select count(*) from push_prefs`) and we want to change the default time or wording.
- **If built, then:**
  - a separate opt-in that is off by default;
  - daily per-device totals only (shown, opened), with no endpoint, user id or time of day;
  - sent through an RPC that adds them into a table without user ids;
  - shown only when at least 10 devices report on a given day.

## Known limits

- **iOS.**
  - Only from the Home Screen, on 16.4+.
  - Home Screen icons added before the manifest existed may need removing and adding again.
  - The Home Screen app has its own storage, so the `?p4=reminders` flag must be opened inside the installed app.
  - Focus modes can hold notifications back.
- **Android.** Battery saving can delay delivery.
- **Labels follow the Path's rotation** as of the last time the app was opened. If you skip a day, the label may name the previous day type until the app is opened again.
- **Signing out while offline** removes the browser subscription, which kills the endpoint. The server row is then deleted on the next send attempt (404/410), so at most one reminder attempt reaches nobody.
