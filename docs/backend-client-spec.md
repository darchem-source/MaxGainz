# Account deletion: client spec for index.html

**From:** backend · **For:** the engineer applying changes to `index.html` · **Server side:** `supabase/delete_my_account.sql` (branch `app-store-backend`). The owner must install it in Supabase **before** this client change ships, or the new button will report "not available".

## What changes and why

Today `deleteUserAccount()` (≈ line 23667) deletes the `sessions` and `custom_weights` rows, then calls `/auth/v1/logout`. That leaves the login itself (`auth.users`) and any signed-in feedback in place, which fails Apple guideline 5.1.1(v).

The new flow makes **one** call to a database function. That function deletes every user-data row **and** the login in a single transaction. It either completes fully or changes nothing. The device is wiped only after the server confirms.

**Remove completely:** the two `sbFetch(... {method:'DELETE'})` calls and the `/auth/v1/logout` call in `deleteUserAccount()`. **Never** fall back to them, under any error. Partial client-side deletes are exactly the bug being fixed.

**Keep it reachable:** Profile → Delete My Account must stay available to a signed-in user behind the paywall too. decisions.md says that after the trial, users can still view history, export data and delete their account. Guests have no account, so they don't need the button.

---

## 1. The call

```
POST {SB_URL}/rest/v1/rpc/delete_my_account
apikey:        {SB_KEY}
Authorization: Bearer {authToken}        ← the user's access token, freshly refreshed (step 3). NEVER SB_KEY.
Content-Type:  application/json
body:          {}
```

- Use a **dedicated `fetch`**, not `sbFetch`. `sbFetch` turns every failure into `null` (you need the status code), shows a "Session expired" toast and returns `null` when a refresh fails, and aborts after 10 s.
- Timeout: **20 s per attempt** (AbortController).
- Success = `res.ok && body && body.ok === true`. The body looks like:
  `{"ok": true, "user_id": "…", "auth_user_deleted": true, "rows_deleted": {"public.sessions": 12, …}}`
  If `auth_user_deleted` is `false`, the account was already gone. That happens on a retry after a lost reply, and it **is still success**.

| Response | Meaning | Server changed? | Client action |
|---|---|---|---|
| 200 and `ok: true` | Deleted, or already deleted | Yes, completely | Success path (step 6) |
| 401 | Token rejected or expired | No | `refreshAuthToken()` once, then retry. If the refresh fails, show **"Sign in again"** (below) |
| 404 (`code` PGRST202) | Function not installed | No | **Definite failure** (step 7). Log `"delete_my_account not installed"` |
| 400 / 403 / other 4xx (`code` P0001, 42501…) | Server refused. Each response carries a `message` | No (rolled back) | **Definite failure** (step 7). `console.warn` the code and message |
| 408, 429, 5xx, network error, timeout | Unknown: it may have completed | Unknown | **Retry with the same token**, up to 3 attempts in total, waiting 1 s then 3 s. The function is safe to repeat. If all attempts fail, go to the **unknown outcome** state (step 8) |

A failure on the server never leaves partial deletion behind: the function runs in one database transaction.

## 2. Order of operations: new `deleteUserAccount()`

0. **Preconditions.** If `!isAuthenticated()`, stop. If `!navigator.onLine`, show **Offline** copy and stop. Nothing has changed at this point.
1. **Freeze cloud sync** with a new module-level flag `_accountDeletionInProgress = true`:
   - `_dashDisabled = true; clearTimeout(_dashTimer); _dashTimer = null;` (the existing line, kept)
   - In `sbFetch`: when the flag is set and `method !== 'GET'`, return `null` immediately with no request and no toast.
   - In `cloudLoadAll`: when the flag is set, `return false` immediately. Otherwise, if it ran mid-deletion, it would treat local sessions as "unsynced" and re-upload them.
   - Pull-to-refresh (≈ 3564), the `online` handler (≈ 24109) and boot (≈ 2104) all go through `cloudLoadAll`, so the flag covers them.
2. **Let in-flight writes finish.** Track sbFetch calls that are in progress: add each request's promise to a `Set` at the start of `sbFetch` and remove it in `finally`. Then `await Promise.allSettled([...set])`, capped at 10 s. This is belt and braces, because the server also refuses late writes.
3. **Refresh the token:** `if (!(await refreshAuthToken()))`, unfreeze (see step 7) and show **Sign in again**. Why: the call and every retry then run on a token valid for about an hour, and a deleted account can no longer refresh.
4. **Mark pending:** `localStorage.setItem('maxgainz_delete_pending', currentUser.id)`. This lets a killed app finish the job on next launch (§4).
5. **Call** per §1, with the retries. While it runs: final-modal button reads **"Deleting…"** and is disabled, and Cancel is hidden.
6. **Success:**
   1. `saveAuthState(null, null)`. This removes `maxgainz_auth` and `maxgainz_cloud_user`.
   2. `localStorage.clear()`. This removes everything else, including `maxgainz_v1` and `maxgainz_delete_pending`.
   3. `sessionStorage.clear(); sessionStorage.setItem('maxgainz_account_deleted', '1');`
   4. **Do not** call `/auth/v1/logout`. The server has already removed every session and refresh token, so logout would only return an error.
   5. `location.reload()`. On boot, right after `loadAuthState()`: if the `sessionStorage` flag is set, remove it, show the auth screen (sign-up form) with the **Account deleted** confirmation, and don't auto-open onboarding or the path wizard.
7. **Definite failure:** `_accountDeletionInProgress = false; _dashDisabled = false; scheduleDashboardSummary();`, then remove `maxgainz_delete_pending`. Keep every bit of local data, leave the user signed in, and show **Couldn't delete**.
8. **Unknown outcome** (retries exhausted): keep sync frozen and keep `maxgainz_delete_pending`. Show **Couldn't confirm** with a **Try again** button, which reruns step 5 (or step 3 first if more than ~50 minutes have passed). **Never show "deleted" here.**

Why this is safe: the server is all-or-nothing, so there is never a half-deleted account. The device is wiped and says "deleted" only after `ok: true`. After an unknown outcome the account may be gone while the app still looks signed in. That is the safe direction: nothing is claimed, the retry returns `ok`, and the server refuses any writes from that token.

## 3. What to clear on the device (step 6)

- **localStorage:** call `saveAuthState(null, null)` and then `localStorage.clear()`. Use `clear()` rather than a list so that keys added later are covered. Keys in use today:
  - auth: `maxgainz_auth`, `maxgainz_cloud_user`
  - data cache: `maxgainz_v1` (`STORAGE_KEY`)
  - personal content: `maxgainz_custom`, `maxgainz_custom_hiits`, `maxgainz_path`, `maxgainz_pathHistory`, `maxgainz_pbLifts`, `maxgainz_pending_name`, `maxgainz_pending_email`
  - app state and preferences: `maxgainz_onboarded`, `maxgainz_path_skipped`, `maxgainz_fg_seen`, `maxgainz_progSections`, `maxgainz_ladder_v2_seen`, `maxgainz_reminderDismissed`, `maxgainz_rotateExercises`, `maxgainz_trackRPE`, `maxgainz_periodize`, `userWeightUnit`, `userSpeedUnit`, `userRunnerLevel`, `userAudioEnabled`, `userDemoSex`, `appTheme`, `plateBarWt`, `progSubTab`
  - the new `maxgainz_delete_pending`
- **In-memory state:** `location.reload()` rebuilds it. Until then the sync freeze stops any write, and `_dashTimer` is already cleared.
- **sessionStorage:** clear it (unused today), then set only the one-shot `maxgainz_account_deleted`.
- **Service-worker cache** (`maxgainz-v2`): leave it alone. It holds only the public app shell (index.html, fonts, Lottie), and `sw.js` never caches Supabase responses.
- No IndexedDB or cookies are used.
- **RevenueCat (once integrated):** after the server confirms and before clearing storage, call `Purchases.logOut()` and ignore any error. Otherwise the SDK keeps the deleted user's id and RevenueCat re-creates that customer on the next launch. Deleting the customer record itself needs RevenueCat's secret key and must run server-side. That is an open item: see the backend report, not this spec.
- **iOS wrapper, later:** if the token is ever moved to Keychain or Capacitor Preferences, clear it here as well. If Sign in with Apple is ever added, revoke the Apple token at this step (Apple's guidance).

## 4. Edge cases

- **App killed mid-call.** At boot, if `maxgainz_delete_pending === currentUser?.id`: skip `cloudLoadAll`, open the final modal with the **Finish deleting** copy, and let the user tap to run steps 3–8. If the token can no longer refresh, show **Sign in again**. Signing in works only if the account still exists, and the pending key survives `authLogout()`, which doesn't clear it.
- **Account deleted on another device** (recommended). After deletion, a second phone's old token can't write: the server answers **403** with `message` starting `MG_ACCOUNT_DELETED`. In `sbFetch`, when `!res.ok` and the response text contains `MG_ACCOUNT_DELETED`, run the step-6 wipe and show the **Account deleted** confirmation. Without this, that phone keeps its local copy, and its saves fail quietly until its sign-in expires (≤ 1 h).
- **Feedback** (`submitFeedback`) uses its own fetch. It is not part of this flow and needs no change.

## 5. Copy

**Step 1: `deleteAccountMod`.** Replace the current contents. Remove the "📧 Email Data & Delete" button and `emailDataMod`: no email is ever sent (the code only downloads a CSV), and App Review can treat that promise as misleading.

> **Delete your account?**
> This permanently deletes your Max Gainz account and everything in it: your workout history, weights, profile and photo, body measurements, notes and custom workouts, and any feedback you sent while signed in. This can't be undone.
>
> **Subscribed through the App Store?** Deleting your account does **not** cancel your subscription. Apple bills you for it and keeps charging until you cancel. To cancel, open the **Settings** app on your iPhone → tap your name → **Subscriptions** → **Max Gainz** → **Cancel Subscription**. Please do this before you delete your account.
>
> [Manage subscription] [Download my data first] [Continue] [Cancel]

- **Manage subscription** opens `https://apps.apple.com/account/subscriptions` (the link Apple provides) in the system browser. Native `showManageSubscriptions` is optional.
- **Download my data first** calls `exportAllData()` (the full JSON backup). Check it on the iOS build: WKWebView ignores `<a download>` for blobs. If it doesn't save there, use the Capacitor Filesystem + Share sheet, or hide the button in the iOS build.

**Step 2: `finalDeleteMod`.** Also remove the `window.confirm()` in `confirmFinalDelete()`. Its text says "Type your email to confirm", but `confirm()` has no input field.

> **Delete account permanently?**
> Your account ({email}) and all its data will be deleted from our servers straight away, and you'll be signed out on every device. This can't be undone.
> Your App Store subscription, if you have one, is not cancelled by this. Cancel it in iPhone Settings → your name → Subscriptions.
>
> [**Delete my account**] (red) [Cancel]

While running: **"Deleting your account…"**

**Account deleted** (auth screen after reload, one-shot, with an OK button):
> **Your account has been deleted**
> Your Max Gainz account and all its data have been permanently removed from our servers and from this device. If you had an App Store subscription, remember to cancel it in iPhone Settings → your name → Subscriptions, because Apple bills it separately.

**Finish deleting** (pending at launch):
> **Finish deleting your account**
> Your last attempt to delete your account didn't finish. Tap Delete my account to complete it.

**Failure messages:** show these inside the final modal, and keep the user signed in.
- **Offline:** "You're offline. Connect to the internet to delete your account. Nothing has been deleted."
- **Sign in again:** "For your security, please sign in again and then delete your account. Nothing has been deleted."
- **Couldn't delete** (definite failure, including 404): "We couldn't delete your account right now. Nothing has been deleted. Please try again later, or contact support at [support contact, supplied by the owner]."
- **Couldn't confirm** (unknown outcome): "We couldn't confirm your account was deleted because the connection dropped. Tap Try again when you're back online." [Try again]

## 6. Acceptance checks

Use a throwaway account. The owner's runbook (Part C) covers the database side.

1. **Happy path.** In the Network tab, the deletion makes one token refresh and then exactly **one** `POST /rest/v1/rpc/delete_my_account` → 200. It makes **no** `DELETE /rest/v1/...` and **no** `/auth/v1/logout`. Then the app reloads to the sign-up screen showing **Account deleted**, `localStorage.length === 0`, and signing in with the same credentials fails ("Invalid login credentials").
2. **Offline before tapping:** the Offline message appears, and nothing changes.
3. **Function missing.** On a project without the SQL, or with a temporary wrong RPC name: the **Couldn't delete** message appears, the user stays signed in, and the data is intact.
4. **Reply lost.** Block the request once (DevTools request blocking, or go offline right after tapping): **Couldn't confirm** appears. Unblock and tap **Try again**: it succeeds. If the first attempt had reached the server, the response shows `auth_user_deleted: false`.
5. **Two devices.** Sign in on A and B, delete on A, then log a session on B. Nothing reappears in the database (runbook check), and with §4 implemented B shows **Account deleted**.
6. `python3 tests/check.py` still passes (parse gate).
