# Rollout registry

The source of truth in code is `ROLLOUT_REGISTRY` in `index.html`. This page mirrors it. Gate 26 in `tests/check.py` fails if any of these are true:

- a flag key exists in the app but not in the registry;
- the registry disagrees with the real flag functions for any stored value;
- a key is missing from this page.

Every flag is stored per device in `localStorage`. Support can read the active configuration in **Profile → Data health → Configuration · this device**. That section shows the build (`APP_VERSION`), each flag's state and whether it is the default or was set on this device. It also shows a one-line support code.

Bump `APP_VERSION` (format `YYYY.MM.DD`, optionally with a suffix) on every production push.

## Flags

| Key | Feature | Fresh device | Audience | Kill switch | Scope | Owner | Removal condition |
|---|---|---|---|---|---|---|---|
| `maxgainz_nav_v2` | Simplified navigation | **On** (since build 2026.11.25.2). Only a stored `'0'` keeps classic | Everyone; existing users get a one-time notice | Profile → Simplified navigation: Off, or "Use classic navigation" on the notice (stores `'0'`) | device | Phase 1 · UX | Default-on for everyone for 4 weeks with no rollback needed → delete the classic nav bar and this key |
| `maxgainz_p5_profile` | Grouped Profile layout | **On** | Everyone | `?p5=0` (stores `'0'`) | device | Profile & settings | 4 weeks after rollout (25 Nov 2026) with no opt-outs → delete the old Profile layout and this key |
| `maxgainz_p4_reminders` | Training-day reminders card | **On** (the reminder itself stays off until the user turns it on) | Everyone | `?p4=0` on a device; unset `PUSH_ENABLED` on the server to stop all sends | device + account | Phase 4 | 4 weeks after rollout (25 Nov 2026) → keep the server kill switch, delete this key |
| `maxgainz_p3_offline` | Offline downloads | **Off** | Beta via `?p3=offline` | `?p3=0` | device | Phase 3 | After Priority 4 (offline coverage) ships → default on, then delete this key |
| `maxgainz_p3_discover` | Programme finder | **Off** | Beta via `?p3=discover` | `?p3=0` | device | Phase 3 | Decide default-on once the Priority 3 accessibility pass covers the filters → then delete this key |
| `maxgainz_p3_share` | Private share links | **Off** | Beta via `?p3=share` | `?p3=0` | device + account | Phase 3 | Decide default-on after 4 weeks of beta links with no privacy reports → then delete this key |
| `maxgainz_ai_v1` | AI features (master) | **Off**. Switched on at sign-in for accounts in the `ai_beta` table (`supabase/ai_beta.sql`), marked `maxgainz_ai_cohort='beta'` | Controlled AI beta (accounts you add to `ai_beta`); `?ai=` for testing | `?ai=0` (stores `'0'`: never re-enrolled); remove the account from `ai_beta`; unset `AI_ENABLED` on the server to refuse every call | device + account consent | Phase 2 · AI | Priority 6 beta proves value → replace with an account-level cohort, then delete this key |
| `maxgainz_ai_coach` | AI Today coach card (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |
| `maxgainz_nl_log` | AI typed sets (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |
| `maxgainz_ai_recap` | AI weekly recap (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |

There are two kinds of flag:

- **Opt-in** flags are on only when the key is `'1'`.
- **Opt-out** flags are on unless the key is `'0'`.

AI features also need the account's own consent, and the server checks that consent. A flag only decides whether the feature is shown.

### Fresh device today

A new install with no URL parameters gets:

- simplified navigation;
- the grouped Profile;
- the reminders card;
- no Phase 3 features;
- no AI.

Support code: `mg <build> nav:1d pf:1 p3:000 ai:0000- rem:10 sw:?`

## Migration policy

**Status: implemented in build 2026.11.25.2** (`_navMigrate`, `renderNavNotice`; gate 13).

| Who | Stored value | What happens |
|---|---|---|
| New user | `maxgainz_nav_v2` not set, no sessions dated before the switch | Simplified navigation from the first open. No notice. |
| Existing user who never chose | not set, with sessions dated before the switch | Simplified navigation, plus a one-time notice on Today. It explains the four tabs and has **Got it** and **Use classic navigation** buttons. |
| User who opted out | `'0'` | Never moved and no notice. A stored choice always wins. |
| User already on it | `'1'` | No change and no notice. |

How the notice works:

- On the first open after the switch, a device that never chose stores `maxgainz_nav_notice_v1 = 'pending:<time>'`. The migration never writes `maxgainz_nav_v2` itself, so an opt-out can't be overwritten.
- The notice shows on Today only while it is pending, the simplified navigation is showing, and at least one session predates that time. That covers an existing user signing in on a new device after cloud history loads.
- Any answer stores `'done'`: Got it, Use classic navigation, or the Profile toggle.

Profile layout and reminders are already on by default. Their opt-outs (`'0'`) are kept as they are.

No migration touches workout data, the pending sync queue or account settings. Flags are device-local, so signing out and back in keeps them.

**Rollback:**

- *Everyone:* change `_navV2On` back to `raw === '1'`. Users who explicitly chose `'1'` (Start today, the Profile toggle) stay on simplified; everyone else returns to classic.
- *One device:* Profile toggle or the notice button.

## Removing legacy paths

A legacy path can be removed only when all of these hold:

1. it has been the default for everyone for at least 4 weeks;
2. there has been no rollback and no report that needs it;
3. no gate or other feature still reads its DOM or key (check with `grep` and the gate suite).

Removing a legacy path then means:

1. delete the old DOM and code;
2. remove the key from `ROLLOUT_REGISTRY` and this table;
3. leave the stored `localStorage` value untouched. It is harmless, and deleting it gains nothing.

Planned order:

1. old Profile layout (`maxgainz_p5_profile`);
2. reminders device flag (`maxgainz_p4_reminders`);
3. classic navigation (`maxgainz_nav_v2` and `maxgainz_nav_notice_v1`), no earlier than 23 Dec 2026, 4 weeks after the switch.
