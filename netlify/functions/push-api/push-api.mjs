// Max Gainz training-day reminders (Phase 4) — /api/push/*
//   GET  /api/push/key   the VAPID PUBLIC key (public by design; the private key never leaves Netlify)
//   POST /api/push/test  "Send a test notification" to the caller's own devices (needs their sign-in)
//   POST /api/push/run   run the scheduler for THIS deploy's origin (needs x-cron-key = PUSH_CRON_KEY);
//                        used to test delivery on a Deploy Preview, where scheduled functions never run
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_CRON_KEY, PUSH_ENABLED=1 (kill switch).
// All logic is in netlify/lib/push-core.mjs (pure, gate-tested); this file adapts
// Netlify's Request/Response and owns the web-push client.
import webpush from 'web-push';
import { handlePushApi, pushRpcFetch } from '../../lib/push-core.mjs';

export default async (req) => {
  const env = process.env;
  const url = new URL(req.url);
  const result = await handlePushApi({
    method: req.method,
    path: url.pathname,
    origin: url.origin,
    auth: req.headers.get('authorization') || '',
    cronKey: req.headers.get('x-cron-key') || ''
  }, {
    env,
    now: Date.now(),
    rpcFetch: pushRpcFetch(fetch, () => AbortSignal.timeout(5000)),
    send: (sub, payload, opts) => webpush.sendNotification(sub, payload, {
      TTL: opts.ttl, urgency: 'normal', topic: opts.topic, timeout: 8000,
      vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    }).then(r => ({ status: r.statusCode }))
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
};

export const config = { path: '/api/push/*' };
