# Max Gainz: account deletion and security check (owner runbook)

About 20 minutes. You need the Supabase dashboard for the Max Gainz project, and, for Part C only, the app build that contains the new "Delete my account" flow.

## The files

All of these live in the repo's `supabase/` folder on the `app-store-backend` branch, and on `main` once it's merged. Do Part A before testing the app on TestFlight.

| File | What it does | Changes data? |
|---|---|---|
| `delete_my_account.sql` | Installs account deletion. Run once; running it again is harmless. | Installs only. Deletes nothing when you run it. |
| `verify_security.sql` | Security check with PASS/FAIL results | No (read-only) |
| `check_test_account.sql` | Looks up one account, for the test in Part C | No (read-only) |
| `rls_owner_only.sql` | The existing fix that limits each user to their own rows | Yes (rebuilds policies) |
| `post_fix_checks.sql` | Existing data-tidiness checks. Its security checks are now replaced by `verify_security.sql`. | No |

**How to run a file:** open it on GitHub → **Copy raw file** (or open **Raw**, select all, copy) → Supabase dashboard → **SQL Editor** → **+ New query** → paste → **Run**.
- Paste the **whole** file.
- Make sure nothing is highlighted when you press Run, because Run on a selection runs only that part.
- Check that the role picker next to Run says **postgres**.
- Results appear in the grid below the editor.

Do the parts in order: **A → B → C**. Part C needs the app update to be live (or a preview link of it).

---

## Part A: Install account deletion

1. Run **`delete_my_account.sql`**.
2. Supabase may warn that the query contains *destructive operations*. That's expected: the file contains the word DELETE (inside the function) and "drop trigger if exists". Confirm and run. Nothing is deleted now.
3. **Success looks like** a small grid where every row says **PASS**:
   - `public.delete_my_account()`: *security definer: yes · search_path pinned: yes · signed-in users can run it: yes · anon key alone can run it: no*
   - one row each for `public.custom_weights`, `public.feedback`, `public.sessions` (and `public.workouts` if that old table still exists): *Cleared by delete_my_account() … guard trigger: on*
   - possibly a `public.feedback` row about a foreign key. That's fine.
4. **If you see an error starting "STOP —"**, nothing was changed. What each one means:
   - *"not allowed to delete from auth.users"*: the role picker isn't on **postgres**. Fix it and run again. If it still fails, see **Plan B**.
   - *"cannot delete from / add a trigger to public.…"*: that table belongs to a different database role. Send the message to the developer.
   - *"auth.users has row-level security …"*: see **Plan B**.
5. If any row says **FAIL**, run the file again. If it still fails, send the developer a screenshot.

What you just installed:
- A function the app calls when someone taps **Delete my account**. In one go it deletes all of that person's workouts, weights, profile and dashboard rows, and any feedback they sent while signed in, then it deletes their login. It is all or nothing: it never stops half way.
- A guard that stops a deleted account's old sign-in from saving anything. Without it, the app still open on a second phone could upload the history again.

## Part B: Check the security

1. Run **`verify_security.sql`**. It is read-only, so run it as often as you like.
2. Read the **first row** (`OVERALL`):
   - **PASS**: nothing to do.
   - **PASS (with warnings)**: no holes. Read the WARN rows, each of which explains itself.
   - **FAIL**: the row lists what failed. Find those rows. Each one's *detail* column says what's wrong and how to fix it.
3. The other columns:
   - **area**: the kind of thing being checked.
   - **object**: the table or function.
   - **policy**: a rule that controls access.
   - **roles**: who the rule applies to. `anon` means anyone holding the public key inside the app, which is effectively anyone. `authenticated` means signed-in users.
   - **cmd**: what the rule allows. SELECT = read, INSERT = add, UPDATE = change, DELETE = delete.
4. Common results and their fixes:
   - **"RLS is OFF"** on `sessions`, `custom_weights` or `feedback`: run `rls_owner_only.sql`, then run the check again.
   - **"RLS is OFF" on `workouts`**: this is likely in your project. It's an old table the app no longer uses, and `rls_owner_only.sql` doesn't cover it. Until it's fixed, anyone with the app's public key can read and change it. Run this in a new query: `alter table public.workouts enable row level security;` That locks it completely, and the app doesn't use it, so nothing breaks. Then run the check again.
   - **A policy marked FAIL** (for example *"Any signed-in user can read OTHER users' rows"*): run `rls_owner_only.sql`. It removes every rule on those three tables, rebuilds the owner-only ones, and lists what it removed.
   - **"Account deletion is NOT installed"**: do Part A.
   - **WARN "rows belong to accounts that no longer exist"**: these are leftovers. The detail column contains the exact command to remove them, and it only touches rows whose account is gone.
   - **WARN "Not touched by account deletion"**: a table without a `user_id` column. If it stores anything about a person, tell the developer.
5. **A healthy result** after Parts A and B:
   - `sessions` and `custom_weights`: *RLS ON* plus 4 *Owner-only* policy rows each.
   - `feedback`: *RLS ON* plus 1 row, *Expected: anyone can send feedback…*
   - Both functions: PASS.
   - *No storage buckets*: PASS.
   - All *Account deletion* and *Leftover rows* rows: PASS.
6. **Second opinion:** Dashboard → **Advisors → Security Advisor**. It may warn that `delete_my_account` is a "security definer function" that signed-in users can run. That is intentional, because people must be able to delete their own account. Any other warning there is worth reading.
7. Run the check again whenever a table is added or access rules change.

## Part C: Test deletion end to end with a throwaway account

1. **Create it.** In the app, sign up with a throwaway address, for example `yourname+deltest1@gmail.com`. Gmail delivers anything after the `+` to your normal inbox, so a confirmation email (if one is sent) still reaches you. Use any password.
2. **Give it data.**
   - Log a quick manual activity (for example a 10-minute walk) and save it.
   - Change one working weight or a profile detail.
   - Optional: send feedback with *anonymous* switched **off**.
3. **Look it up before deleting.** Open `check_test_account.sql`, replace `PUT-TEST-EMAIL-HERE@example.com` with the test address (keep the quotes), and run it. Expect:
   - *Account (login)*: **FOUND**
   - `public.sessions` and `public.custom_weights` rows owned by this account: **1 or more**
   - The *left behind by deleted accounts* numbers: **write them down** (normally all 0).

   You'll also see the address under **Authentication → Users**.
4. **Delete it in the app.**
   1. Go to **Profile → Delete My Account**.
   2. Read the subscription notice, then tap **Continue** → **Delete my account**.
   3. Expect to land on the sign-up screen with **"Your account has been deleted"**.
5. **Try to sign in** with the same address and password. Expect a failure: **"Invalid login credentials"**.
6. **Look it up again.** Run the same `check_test_account.sql`. Expect:
   - *Account (login)*: **NOT FOUND**
   - *feedback rows with this email*: **0**
   - *left behind by deleted accounts*: **the same numbers as in step 3**. If any number went up, rows were left behind: tell the developer.
7. **Authentication → Users:** the address is gone.
8. *(Optional, harder test)* Before step 4, also sign the test account in on a second phone or browser. After deleting on the first, log an activity on the second. Then repeat step 6: the numbers must not go up.

**The test passes when steps 4–7 all come out as described.** You can sign up again with the same address afterwards; it creates a brand-new, empty account.

If step 4 shows an error instead:
- *"We couldn't delete your account right now. Nothing has been deleted"*: Part A probably wasn't run on this project. Run it, then try again.
- *"We couldn't confirm…"*: a connection problem. Tap **Try again**.
- Anything else: take a screenshot and send it to the developer.

---

## Emergency: undo Part A

Only do this if saving workouts stops working straight after Part A and the developer asks you to. While it's undone, the app's delete button won't work, which blocks App Store approval, so treat it as temporary.

```sql
do $$ declare t record; begin
  for t in select tgrelid::regclass as tbl from pg_trigger where tgname = 'mg_refuse_deleted_account_writes' loop
    execute format('drop trigger mg_refuse_deleted_account_writes on %s', t.tbl);
  end loop;
end $$;
drop function if exists public.mg_refuse_deleted_account_writes();
drop function if exists public.delete_my_account();
```

## Plan B (only if Part A stops on auth.users permissions)

Part A works because Supabase lets the `postgres` role delete logins. If Supabase ever withdraws that, the fallback is a small Netlify function that holds the Supabase **service-role key** in a Netlify environment variable. It would check the caller's sign-in, delete their rows, then delete the login through Supabase's admin API. It isn't built, because it has real downsides:
- That key bypasses every security rule, so a leak would expose everything.
- The steps can't run as one all-or-nothing transaction.

Ask the developer if you ever need it.

## Facts for your privacy policy and App Store answers

- **Deleted straight away:**
  - the login
  - all workout sessions and working weights
  - the profile: name, email, gender, date of birth, height and weight, profile photo, onboarding answers including injuries, body-weight log, measurements, daily notes, personal bests, custom workouts and preferences
  - the dashboard summary
  - feedback sent while signed in

  Every device is signed out within an hour.
- **Not yet covered:** once subscriptions go live, RevenueCat keeps a customer record under the user's id. Deleting it needs a server-side step that isn't built yet, so check with the developer before launch.
- **Not deleted:**
  - Feedback sent with *anonymous* on: it can't be linked to anyone.
  - Supabase's own backups and sign-in security logs, which hold copies until they expire under Supabase's retention for your plan.
- **Subscriptions** are billed and held by Apple. Deleting the account doesn't cancel them, and the app tells people so before they confirm.
- The key built into the app is the public **anon** key, not the secret service-role key. That is correct.

## Part D: Supabase redirect URLs for password reset and sign-up confirmation (added by the app engineer, phase 2)

The app now sends an explicit `redirect_to` with every password-reset and
sign-up email, and handles the link when it comes back. Supabase refuses a
`redirect_to` that is not on its allow-list and silently falls back to the Site
URL, so add these once in **Supabase Dashboard → Authentication → URL
Configuration**:

- **Site URL:** `https://maxgainz.netlify.app` (keep as is).
- **Redirect URLs** (add all three):
  - `https://maxgainz.netlify.app/`
  - `https://maxgainz.netlify.app/**`
  - `maxgainz://auth` (the iPhone app; Info.plist registers the `maxgainz` URL scheme)

How it works: the email link returns the user to the redirect URL with the
session in the URL fragment (`#access_token=…&type=recovery`). On the web the
page reads it at load; in the iPhone app Capacitor's App plugin delivers it as
an `appUrlOpen` event. A `type=recovery` link opens the "Choose a new password"
screen, which calls `PUT /auth/v1/user`; a confirmation link signs the user in.

Email confirmation: the app works either way. If "Confirm email" is ON in
Authentication → Providers → Email, new users see "Check your email" and the
link signs them in. If it is OFF they go straight in (today's behaviour).
Reset emails open on whichever device the user taps them: a reset link tapped
on a phone without the app opens the web app, where the password can also be
changed.

## Part E: Test the subscription in the sandbox and on TestFlight (added by the app engineer, phase 3)

Do Part F first. Then build the app with the real RevenueCat public key
(native/capacitor.config.json → plugins.MaxGainzNative.revenueCatApiKey, then
`npm run prepare-www` and `npx cap sync ios` inside native/; CI does this).

**Sandbox tester.** App Store Connect → Users and Access → Sandbox → add a
tester with a fresh e-mail. On the iPhone: Settings → App Store → Sandbox
Account (iOS 15+ shows it after the first sandbox purchase attempt) → sign in
with that tester. Sandbox time runs fast: a 1-week trial lasts 3 minutes, a
monthly renewal 5 minutes, a yearly one 1 hour, and a subscription auto-renews
at most 6 times then expires (Apple's "Sandbox renewal" rule). Settings → App
Store → Sandbox Account → Manage lets you change the renewal speed and cancel.

**Script (delete the app between runs 1 and 4 so the trial state resets):**
1. Fresh install, continue as guest, finish onboarding. Expected: the paywall
   opens with "Start free trial", "1-week free trial, then £X per year", real
   prices in your storefront's currency, Restore, Terms, Privacy, Apple EULA.
   Today shows the "Unlock Max Gainz Pro" banner; Paths / Programme / Gainz
   tabs reopen the paywall; Progress → calendar and Settings still work.
2. Tap Start free trial → Apple sheet → confirm with the sandbox tester.
   Expected: paywall closes, "Welcome to Max Gainz Pro", everything unlocked,
   Settings shows "Free trial until <date>, then yearly plan". In RevenueCat →
   Customers the anonymous `$RCAnonymousID:…` customer shows the trial.
3. Create an account in Settings. Expected: RevenueCat now shows the Supabase
   user id as an alias of the same customer (no second trial). Sign out and
   back in: still Pro. Delete the app, reinstall, open it signed out:
   locked; tap Restore Purchases: unlocked again.
4. Wait ~3 minutes (sandbox trial ends and renews as a paid period).
   Expected: Settings switches to "Yearly plan, renews on <date>". After the
   6th sandbox renewal it expires: within a minute of foregrounding the app
   it locks, returns to Today with "Your subscription has ended", history
   still opens, "Expired on <date>" in Settings. The paywall now shows the
   plain price and "Subscribe" (no second trial).
5. Cancel inside the Apple sheet (tap Cancel). Expected: no error, paywall
   stays open, button active again.
6. Airplane mode, then relaunch while subscribed. Expected: still unlocked
   (cached state is trusted for 3 days). Airplane mode on the paywall:
   "Couldn't load the plans — check your connection" with Try again.
7. Manage subscription in Settings opens Apple's subscriptions page in the
   in-app browser. Delete My Account while subscribed: the notice about
   cancelling with Apple appears before the final confirmation.
8. TestFlight: repeat steps 1, 2 and 5 with a TestFlight build (TestFlight
   uses the sandbox too, with the tester's own Apple Account; nobody is
   charged). Then tell App Review in the notes: "Subscriptions use
   RevenueCat with StoreKit 2; sandbox products maxgainz_pro_monthly and
   maxgainz_pro_annual, 1-week free trial. Free review account: <email /
   password>."

If step 2 fails with "product not available" the products are not yet
Ready to Submit / attached to the app version, or the In-App Purchase key is
missing in RevenueCat (Part F). If step 1 shows "Subscriptions are not
available in this build", the public key was not set before the build.

## Part F: What to create in App Store Connect and RevenueCat (added by the app engineer, phase 3)

**App Store Connect** (Account Holder / Admin / App Manager):
1. Agreements, Tax and Banking: accept the Paid Apps agreement and enter
   banking and tax details, or products cannot be sold or tested.
2. Apps → Max Gainz → Subscriptions → Create Subscription Group: reference
   name **Max Gainz Pro** (one group only, so nobody can buy two plans).
3. In the group create two auto-renewable subscriptions (these product IDs
   can never be changed or reused, so type them exactly):
   - `maxgainz_pro_monthly`, duration 1 month
   - `maxgainz_pro_annual`, duration 1 year
   For each: subscription display name and description, at least one
   localization, review screenshot (any screenshot of the paywall) and a
   price (set your base price; Apple localizes the rest).
4. For each subscription: Subscription Prices → View all → Introductory
   Offers → all countries → no end date → **Free → 1 Week**. (One intro
   offer per group per customer; it cannot be edited later, only deleted
   and re-created.)
5. Group localization: a display name for the group ("Max Gainz Pro") and
   optional app name override.
6. Attach both products to the app version (Version page → In-App Purchases
   and Subscriptions) before submitting; products must be "Ready to Submit".
7. Users and Access → Integrations → In-App Purchase → Generate In-App
   Purchase Key. Download the .p8 ONCE and keep it; note the Key ID and
   Issuer ID.
8. (Optional but recommended) Users and Access → Integrations → App Store
   Connect API → key with App Manager role, for RevenueCat to import prices.
9. App Privacy: add "Purchase History" (linked to user if you keep logIn
   with the Supabase id) and "User ID" to the label for RevenueCat.

**RevenueCat** (free up to $2,500 monthly tracked revenue):
1. Create a project "Max Gainz" → add an App Store app: bundle ID
   `com.maxgainz.app` (must match capacitor.config.json appId).
2. Upload the In-App Purchase Key (.p8 + Issuer ID) from step 7 above; add
   the App Store Connect API key from step 8 if created.
3. Products: add `maxgainz_pro_monthly` and `maxgainz_pro_annual` (or import).
4. Entitlements: create **`pro`** and attach both products.
5. Offerings: the `default` offering with two packages: **Annual** →
   maxgainz_pro_annual, **Monthly** → maxgainz_pro_monthly. The app reads
   the *current* offering and looks for the ANNUAL and MONTHLY package types.
6. Copy the **Public Apple API key** (Project → API keys, starts with
   `appl_`) into native/capacitor.config.json →
   plugins.MaxGainzNative.revenueCatApiKey. Never put the secret key there.
7. (Recommended) Project → Apps → Max Gainz → App Store Server Notifications:
   copy RevenueCat's URL into App Store Connect → App Information → App Store
   Server Notifications (Production and Sandbox URL, version 2), so
   cancellations and refunds reach the app without a relaunch.
8. Customer deletion: when a user deletes their account the app calls
   logOut; the RevenueCat customer record itself must be deleted from the
   RevenueCat dashboard (Customers → … → Delete) or via the REST API with
   the secret key. This is a manual step until a server job exists.
