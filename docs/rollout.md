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
| `maxgainz_nav_v2` | Simplified navigation | **Off** (classic). Switched on when a new user finishes Start today, unless a choice is already stored | New users after Start today; anyone via Profile | Profile → Simplified navigation: Off (stores `'0'`) | device | Phase 1 · UX | Default-on for everyone for 4 weeks with no rollback needed → delete the classic nav bar and this key |
| `maxgainz_p5_profile` | Grouped Profile layout | **On** | Everyone | `?p5=0` (stores `'0'`) | device | Profile & settings | 4 weeks after rollout (25 Nov 2026) with no opt-outs → delete the old Profile layout and this key |
| `maxgainz_p4_reminders` | Training-day reminders card | **On** (the reminder itself stays off until the user turns it on) | Everyone | `?p4=0` on a device; unset `PUSH_ENABLED` on the server to stop all sends | device + account | Phase 4 | 4 weeks after rollout (25 Nov 2026) → keep the server kill switch, delete this key |
| `maxgainz_p3_offline` | Offline downloads | **Off** | Beta via `?p3=offline` | `?p3=0` | device | Phase 3 | After Priority 4 (offline coverage) ships → default on, then delete this key |
| `maxgainz_p3_discover` | Programme finder | **Off** | Beta via `?p3=discover` | `?p3=0` | device | Phase 3 | Decide default-on once the Priority 3 accessibility pass covers the filters → then delete this key |
| `maxgainz_p3_share` | Private share links | **Off** | Beta via `?p3=share` | `?p3=0` | device + account | Phase 3 | Decide default-on after 4 weeks of beta links with no privacy reports → then delete this key |
| `maxgainz_ai_v1` | AI features (master) | **Off** | Controlled AI beta via `?ai=` | `?ai=0`; unset `AI_ENABLED` on the server to refuse every call | device + account consent | Phase 2 · AI | Priority 6 beta proves value → replace with an account-level cohort, then delete this key |
| `maxgainz_ai_coach` | AI Today coach card (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |
| `maxgainz_nl_log` | AI typed sets (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |
| `maxgainz_ai_recap` | AI weekly recap (needs master) | **Off** | Controlled AI beta | `?ai=0` | device | Phase 2 · AI | With `maxgainz_ai_v1` |

There are two kinds of flag:

- **Opt-in** flags are on only when the key is `'1'`.
- **Opt-out** flags are on unless the key is `'0'`.

AI features also need the account's own consent, and the server checks that consent. A flag only decides whether the feature is shown.

### Fresh device today

A new install with no URL parameters gets:

- classic navigation until Start today finishes;
- the grouped Profile;
- the reminders card;
- no Phase 3 features;
- no AI.

Support code: `mg <build> nav:0d pf:1 p3:000 ai:0000- rem:10 sw:?`

## Migration policy

**Status: proposed. Navigation behaviour is not changed yet.** The next slice implements this once it is approved.

The rules for simplified navigation are:

- **New users** (no completed sessions and the key not set): simplified navigation from first open. Today, they only get it after Start today.
- **Existing users who never chose** (key not set): moved to simplified navigation once, with a one-time notice. The notice explains the four tabs, says where the old screens went and gives a one-tap "Use classic navigation" button. Showing the notice is recorded per device (`maxgainz_nav_notice_v1`) so it never repeats.
- **Users who opted out** (key `'0'`): never moved. A stored choice always wins.
- **Users already on it** (key `'1'`): no change and no notice.

Profile layout and reminders are already on by default. Their opt-outs (`'0'`) are kept as they are.

No migration touches workout data, the pending sync queue or account settings. Flags are device-local, so signing out and back in keeps them.

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
3. classic navigation (`maxgainz_nav_v2`), only after the migration above has run for 4 weeks.
