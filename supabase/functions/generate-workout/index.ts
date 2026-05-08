// supabase/functions/generate-workout/index.ts
//
// Max Gainz — AI workout generation Edge Function
// =================================================
//
// Authenticates the caller via Supabase JWT, calls the Claude API with a
// cached system prompt + exercise library, and returns a structured workout
// JSON (forced via tool use). The user's app then inserts the workout into
// their session.
//
// Uses Claude Haiku 4.5 by default for cost (~$0.003 per generation).
// Prompt caching brings repeat-call cost down ~10x within the 5-min cache TTL.
//
// Required env vars (set via `supabase secrets set`):
//   ANTHROPIC_API_KEY    — your Anthropic API key
//   SUPABASE_URL         — auto-set by Supabase
//   SUPABASE_ANON_KEY    — auto-set by Supabase

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

// ─────────────────────────────────────────────────────────────────────
// EXERCISE LIBRARY — kept stable across requests so it caches well.
// To extend: add entries to this list. Any byte change invalidates the cache.
// ─────────────────────────────────────────────────────────────────────

const EXERCISE_LIBRARY = `
## COMPOUND LIFTS (barbell)
- Back Squat | quads, glutes, posterior chain | barbell + rack | 4-6 sets, 3-8 reps
- Front Squat | quads, core, upper back | barbell + rack | 3-5 sets, 3-8 reps
- Deadlift | full posterior chain, traps, grip | barbell + plates | 1-5 sets, 1-5 reps
- Romanian Deadlift | hamstrings, glutes | barbell | 3-4 sets, 6-12 reps
- Bench Press | chest, triceps, front delts | barbell + bench | 3-5 sets, 3-8 reps
- Incline Bench Press | upper chest, front delts | barbell + incline bench | 3-4 sets, 6-10 reps
- Overhead Press | shoulders, triceps, core | barbell | 3-5 sets, 3-8 reps
- Barbell Row | mid back, lats, biceps | barbell | 3-4 sets, 6-10 reps
- Pendlay Row | mid back, lats, traps | barbell | 4-5 sets, 3-6 reps

## DUMBBELL LIFTS
- Dumbbell Bench Press | chest, triceps | dumbbells + bench | 3-4 sets, 6-12 reps
- Incline Dumbbell Press | upper chest, front delts | dumbbells + incline bench | 3-4 sets, 8-12 reps
- Dumbbell Shoulder Press | shoulders, triceps | dumbbells + bench | 3-4 sets, 6-12 reps
- Dumbbell Row | lats, mid back, biceps | dumbbells + bench | 3-4 sets, 8-12 reps
- Dumbbell Lunge | quads, glutes | dumbbells | 3 sets, 8-12 reps per leg
- Bulgarian Split Squat | quads, glutes | dumbbells + bench | 3-4 sets, 8-12 reps per leg
- Goblet Squat | quads, core | dumbbell | 3 sets, 8-15 reps
- Dumbbell RDL | hamstrings, glutes | dumbbells | 3 sets, 8-12 reps

## ACCESSORIES & ISOLATION
- Lat Pulldown | lats, biceps | cable + lat-pulldown | 3-4 sets, 8-12 reps
- Seated Cable Row | mid back, lats | cable + row station | 3-4 sets, 8-12 reps
- Pull-up | lats, biceps | pull-up bar | 3-5 sets, max reps
- Chin-up | lats, biceps | pull-up bar | 3-5 sets, max reps
- Dips | chest, triceps | parallel bars | 3-4 sets, 6-12 reps
- Push-up | chest, triceps, core | bodyweight | 3-4 sets, max reps
- Cable Tricep Pushdown | triceps | cable + rope/bar | 3-4 sets, 10-15 reps
- Skullcrusher | triceps | barbell or EZ bar + bench | 3-4 sets, 8-12 reps
- Bicep Curl | biceps | dumbbells or barbell | 3-4 sets, 8-12 reps
- Hammer Curl | biceps, forearms | dumbbells | 3-4 sets, 10-12 reps
- Lateral Raise | side delts | dumbbells | 3-4 sets, 10-15 reps
- Rear Delt Fly | rear delts | dumbbells | 3-4 sets, 12-15 reps
- Face Pull | rear delts, upper back | cable + rope | 3-4 sets, 12-15 reps

## LEGS — ISOLATION & MACHINES
- Leg Press | quads, glutes | leg press machine | 3-4 sets, 8-15 reps
- Leg Extension | quads | machine | 3-4 sets, 10-15 reps
- Leg Curl | hamstrings | machine | 3-4 sets, 10-15 reps
- Hip Thrust | glutes, hamstrings | barbell + bench | 3-4 sets, 8-12 reps
- Calf Raise | calves | machine or dumbbells | 3-4 sets, 10-15 reps

## CORE
- Plank | core | bodyweight | 3 sets, 30-60s hold
- Hanging Leg Raise | abs, hip flexors | pull-up bar | 3 sets, 8-15 reps
- Cable Crunch | abs | cable + rope | 3 sets, 12-20 reps
- Ab Wheel Rollout | core | ab wheel | 3 sets, 8-12 reps
- Russian Twist | obliques | dumbbell | 3 sets, 15-20 reps per side

## CARDIO / CONDITIONING
- Burpees | full body | bodyweight | 3 sets, 8-15 reps
- Mountain Climbers | core, shoulders | bodyweight | 3 sets, 30-60s
- Jump Squat | quads, glutes, plyometric | bodyweight | 3 sets, 8-12 reps
`.trim();

// ─────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — small, stable, sits in front of the cached library.
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an expert strength & conditioning coach designing a single workout
for an experienced gym-goer using the Max Gainz app.

DESIGN PRINCIPLES
- Pick exercises that match the user's stated focus, equipment, and time budget.
- Open with a compound, finish with isolation/accessory work.
- 3–7 exercises is typical. Don't pad — fewer well-chosen exercises beats a list.
- Sets/reps should suit the goal: 3-6 reps for strength, 6-12 for hypertrophy,
  12-20 for endurance. Respect the user's stated focus.
- Rest periods: 180s for heavy compounds, 90-120s for moderate, 60s for isolation.
- weight_pct is a recommendation as a fraction of the user's most-recent working
  weight for that lift (e.g., 0.85 = 85% of last working weight). Use 0 for
  bodyweight-only movements. If the user has no recent data on the lift, suggest
  a starting fraction based on a related lift, or 0.7 as a generic starting point.

OUTPUT
Always call the generate_workout tool. Pick exercises ONLY from the library
provided. Be concise — your "rationale" field should be one sentence explaining
the structure of the session, not a sales pitch.
`.trim();

// ─────────────────────────────────────────────────────────────────────
// TOOL SCHEMA — forces structured output. Strict to avoid drift.
// ─────────────────────────────────────────────────────────────────────

const WORKOUT_TOOL = {
  name: "generate_workout",
  description:
    "Return the designed workout in structured form. Use exercises only from " +
    "the provided library; the 'name' field must match a library entry exactly.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short workout title, e.g. 'Push Day' or '30-min Dumbbell Upper'",
      },
      rationale: {
        type: "string",
        description:
          "One sentence explaining the structure (e.g. 'Strength-focused upper body, heavy compound first then volume accessories.')",
      },
      exercises: {
        type: "array",
        minItems: 3,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Must match an exercise name from the library exactly.",
            },
            sets: { type: "integer", minimum: 1, maximum: 6 },
            reps: {
              type: "string",
              description:
                "Rep range like '5', '8-12', 'AMRAP', or hold time like '30s'.",
            },
            weight_pct: {
              type: "number",
              minimum: 0,
              maximum: 1.5,
              description:
                "Fraction of user's last working weight for this lift. 0 for bodyweight.",
            },
            rest_sec: {
              type: "integer",
              enum: [30, 60, 90, 120, 180],
              description: "Rest between sets in seconds.",
            },
            notes: {
              type: "string",
              description: "Optional short cue (form, tempo). Keep under 80 chars.",
            },
          },
          required: ["name", "sets", "reps", "weight_pct", "rest_sec"],
        },
      },
    },
    required: ["name", "rationale", "exercises"],
  },
};

// ─────────────────────────────────────────────────────────────────────
// CORS — allow the deployed frontend (and localhost dev) to call us.
// ─────────────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Build the user-turn content from the per-request inputs.
// Everything that varies per request lives here (NOT in system) so the
// system+tools prefix stays cacheable.
// ─────────────────────────────────────────────────────────────────────

interface RecentLift {
  name: string;       // exercise name as known by the app
  weight: number;     // most recent working weight in kg
  reps: number;       // reps achieved
  date_iso?: string;  // optional, for staleness signal
}

interface GenerateRequest {
  duration_min?: number;       // target session length
  equipment?: string[];        // e.g. ['barbell','dumbbell','cable']
  focus?: string;              // e.g. 'push', 'legs', 'full body', 'arms'
  goal?: "strength" | "hypertrophy" | "endurance" | "conditioning";
  recent_lifts?: RecentLift[]; // for accurate weight recommendations
  notes?: string;              // free-form, e.g. 'shoulder is sore'
}

function buildUserMessage(req: GenerateRequest): string {
  const parts: string[] = [];
  parts.push("Design a workout for me with the following constraints:\n");
  if (req.duration_min) parts.push(`- Duration: ~${req.duration_min} minutes`);
  if (req.focus) parts.push(`- Focus: ${req.focus}`);
  if (req.goal) parts.push(`- Goal: ${req.goal}`);
  if (req.equipment && req.equipment.length) {
    parts.push(`- Equipment available: ${req.equipment.join(", ")}`);
  }
  if (req.notes) parts.push(`- Notes: ${req.notes}`);

  if (req.recent_lifts && req.recent_lifts.length) {
    parts.push("\nMy recent working weights (use these to calibrate weight_pct):");
    for (const lift of req.recent_lifts.slice(0, 12)) {
      parts.push(`- ${lift.name}: ${lift.weight}kg × ${lift.reps}`);
    }
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    // ── 1. Auth: verify Supabase JWT and extract user ─────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData.user) {
      return jsonResponse({ error: "Invalid or expired token" }, 401);
    }
    const userId = userData.user.id;

    // ── 2. Parse request body ─────────────────────────────────────
    let body: GenerateRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    // Basic input sanity checks (don't trust the client)
    if (body.duration_min && (body.duration_min < 5 || body.duration_min > 240)) {
      return jsonResponse({ error: "duration_min must be between 5 and 240" }, 400);
    }
    if (body.recent_lifts && body.recent_lifts.length > 30) {
      body.recent_lifts = body.recent_lifts.slice(0, 30);
    }

    // ── 3. Call Claude ────────────────────────────────────────────
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set");
      return jsonResponse({ error: "Server misconfigured" }, 500);
    }

    const anthropic = new Anthropic({ apiKey });

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      // System is split into two text blocks: a small instruction header
      // (changes rarely), then the large exercise library with cache_control.
      // Render order is tools → system → messages, so the cache breakpoint
      // on the last system block also caches the tools.
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        {
          type: "text",
          text: "# Exercise Library\n\n" + EXERCISE_LIBRARY,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [WORKOUT_TOOL],
      tool_choice: { type: "tool", name: "generate_workout" },
      messages: [
        { role: "user", content: buildUserMessage(body) },
      ],
    });

    // ── 4. Extract the tool_use block ─────────────────────────────
    const toolBlock = response.content.find(
      (b) => b.type === "tool_use" && b.name === "generate_workout",
    );
    if (!toolBlock || toolBlock.type !== "tool_use") {
      console.error("No tool_use in response:", JSON.stringify(response.content));
      return jsonResponse({ error: "Model did not produce a workout" }, 502);
    }

    // ── 5. Return result + usage metadata ─────────────────────────
    return jsonResponse({
      workout: toolBlock.input,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
      user_id: userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("generate-workout error:", message);
    // Distinguish auth/rate-limit/upstream errors so the client can react
    if (err instanceof Anthropic.RateLimitError) {
      return jsonResponse({ error: "Rate limited — try again in a minute" }, 429);
    }
    if (err instanceof Anthropic.APIError) {
      return jsonResponse({ error: `Upstream error: ${err.message}` }, 502);
    }
    return jsonResponse({ error: message }, 500);
  }
});
