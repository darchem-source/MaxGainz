# AI Workout Generation — Setup Guide

This spike adds a "✨ Generate AI workout" button to the Today tab. Tapping it
opens a modal where the user picks duration / focus / goal / equipment, and the
app calls a Supabase Edge Function that proxies to the Claude API and returns a
structured workout. The user previews it and taps "Start" to begin the session.

## Architecture

```
[Browser: index.html]
   │  POST /functions/v1/generate-workout
   │  Authorization: Bearer <Supabase JWT>
   ↓
[Supabase Edge Function: generate-workout]
   │  - Verifies the Supabase JWT (extracts user_id)
   │  - Holds ANTHROPIC_API_KEY (env var)
   │  - Calls Claude Haiku 4.5 with cached system prompt + exercise library
   │  - Forces structured JSON via tool use
   ↓
[Anthropic API]
```

The API key never leaves the Edge Function. Users do **not** need their own
Anthropic account.

## Cost expectation

- Claude Haiku 4.5: $1/M input, $5/M output
- Per generation: ~800 input + ~600 output tokens ≈ **$0.004**
- With prompt caching (90% off cached input within 5-min TTL): repeat
  generations within the cache window drop to ~$0.001

A user generating 10 workouts/month costs you about **4¢**.

## One-time setup

### 1. Get an Anthropic API key

1. Sign up at https://console.anthropic.com
2. Add a payment method (you get $5 free credit to start)
3. Go to **Settings → Limits** and set a monthly spend cap (e.g. $20)
4. Create an API key under **API Keys**

### 2. Deploy the Edge Function

You need the Supabase CLI installed:

```sh
npm install -g supabase
# or: brew install supabase/tap/supabase
```

From the project root (where `supabase/functions/generate-workout/index.ts` lives):

```sh
# Log in (one-time)
supabase login

# Link to your project (one-time) — find your ref in the Supabase dashboard URL
supabase link --project-ref lxudaetjuefylgjddonm

# Set your Anthropic API key as a secret
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# Deploy the function
supabase functions deploy generate-workout
```

The function URL will be:
```
https://lxudaetjuefylgjddonm.supabase.co/functions/v1/generate-workout
```

The frontend already points at this URL via `AI_WORKOUT_FN_URL` in `index.html`,
so no client-side config change is needed.

### 3. Verify it works

```sh
# Get your JWT (e.g. from the app's localStorage `maxgainz_auth`, or via supabase auth)
JWT="eyJ..."

curl -X POST https://lxudaetjuefylgjddonm.supabase.co/functions/v1/generate-workout \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "duration_min": 30,
    "focus": "push",
    "goal": "hypertrophy",
    "equipment": ["barbell","dumbbell"]
  }'
```

Expected response:
```json
{
  "workout": {
    "name": "30-min Push Hypertrophy",
    "rationale": "...",
    "exercises": [...]
  },
  "usage": { "input_tokens": 812, "output_tokens": 487, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 1856 },
  "model": "claude-haiku-4-5-20251001",
  "user_id": "..."
}
```

The first call writes the cache (`cache_creation_input_tokens > 0`). Subsequent
calls within 5 minutes will show `cache_read_input_tokens > 0` and ~10× lower
input cost.

## How it works

### Prompt caching
The system prompt is split into two text blocks:
1. A small "instructions" block (~150 tokens) — behavior and output format rules
2. The **exercise library** block (~1500 tokens) — stable, with `cache_control`

The cache marker on the library block also caches the tool definition (since
render order is `tools → system → messages`). That means **everything except
the user's request** is cached after the first call.

### Structured output
We pass a JSON schema as a tool definition (`generate_workout`) and force the
model to call it via `tool_choice: {type: "tool", name: "generate_workout"}`.
This guarantees the response has the exact shape the frontend expects — no
JSON parsing failures, no schema drift.

### Recent lifts
The frontend pulls the user's last working weight for up to 12 exercises from
`completedSessions` and sends them along. Claude uses these to set
`weight_pct` (a fraction of the user's most recent working weight for that
lift) so the suggested weights are calibrated to the user, not generic.

## Customization

### Changing the exercise library
Edit `EXERCISE_LIBRARY` in `supabase/functions/generate-workout/index.ts` and
redeploy with `supabase functions deploy generate-workout`. Any byte change to
the library invalidates the cache (next call writes a fresh entry).

For a tighter integration, generate the library at deploy time from the same
exercise catalog the app uses (e.g. dump the keys of `EX_META`). That way the
names always match what the app knows about.

### Switching models
In `index.ts`, change `model: "claude-haiku-4-5"` to:
- `claude-sonnet-4-6` — higher quality, ~3× cost
- `claude-opus-4-7` — best quality, ~5× cost on input, ~5× on output

### Rate limiting
The function has no rate limiting yet. For production, add a Supabase table
that tracks generations per user per day and rejects above a threshold (e.g.
20/day). Cheap insurance against a runaway client.

## Troubleshooting

- **401 from the function**: JWT expired. The frontend already retries once
  via `refreshAuthToken()`. If it persists, the user needs to re-sign-in.
- **502 with "No tool output"**: model refused or hit `max_tokens`. Check
  Edge Function logs (`supabase functions logs generate-workout`).
- **Cache always shows 0 reads**: prompt prefix is changing between requests.
  Diff two outbound payloads to find the culprit.
- **CORS errors in browser**: the function sets `Access-Control-Allow-Origin: *`
  by default. Tighten this to your Netlify domain in production.

## What's NOT in this spike (intentionally)

- No rate limiting (add a DB-backed counter for prod)
- No streaming responses (workout JSON is short, ~600 tokens)
- No exercise-name validation — Claude is asked to pick from the library, but
  if it hallucinates a name the frontend just inserts it (the user can rename)
- No saving generated workouts as templates (could push into `customWorkouts`
  if user wants to reuse)
- No A/B between models — Haiku 4.5 only

These are all easy follow-ups once the spike proves out.
