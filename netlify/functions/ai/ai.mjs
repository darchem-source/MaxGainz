// Max Gainz AI proxy (Phase 2) — POST /api/ai.
// The Anthropic key lives only in the Netlify env var ANTHROPIC_API_KEY and is
// never sent to the client. All logic is in core.mjs (pure, gate-tested);
// this file only adapts the Netlify Request/Response and owns the SDK client.
// Env: ANTHROPIC_API_KEY (required), AI_ENABLED=1 (server kill switch),
//      AI_EVAL_TOKEN (optional, ≥24 chars, lets the eval runner skip Supabase).
import Anthropic from '@anthropic-ai/sdk';
import { handleAiRequest } from './core.mjs';

let client = null;

export default async (req) => {
  const env = process.env;
  const result = await handleAiRequest({
    method: req.method,
    auth: req.headers.get('authorization') || '',
    bodyText: req.method === 'POST' ? await req.text() : ''
  }, {
    env,
    fetchFn: fetch,
    // One attempt, 7 s: a slow answer falls back to the app's own text.
    callModel: (params) => {
      if(!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 7000, maxRetries: 0 });
      return client.messages.create(params);
    },
    isTimeout: (e) => e instanceof Anthropic.APIConnectionTimeoutError
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
};

export const config = { path: '/api/ai' };
