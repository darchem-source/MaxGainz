// Max Gainz training-day reminders (Phase 4) — Netlify SCHEDULED function, hourly.
// Sends "time to train" to accounts whose chosen local hour has come (3-hour
// catch-up window), on their planned weekdays, unless they already logged a
// workout today; at most one per account per local day. Only for devices that
// subscribed on this site's production origin (Netlify only runs scheduled
// functions on the published deploy; Deploy Previews use POST /api/push/run).
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_CRON_KEY,
//      PUSH_ENABLED=1 (kill switch); URL and SITE_NAME (set by Netlify); PUSH_ORIGINS (optional, comma-separated extra production origins).
// All logic is in netlify/lib/push-core.mjs (pure, gate-tested).
import webpush from 'web-push';
import { pushRunScheduled, pushRpcFetch } from '../../lib/push-core.mjs';

export default async () => {
  const env = process.env;
  const summary = await pushRunScheduled({
    env,
    now: Date.now(),
    rpcFetch: pushRpcFetch(fetch, () => AbortSignal.timeout(5000)),
    send: (sub, payload, opts) => webpush.sendNotification(sub, payload, {
      TTL: opts.ttl, urgency: 'normal', topic: opts.topic, timeout: opts.timeout,
      vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    }).then(r => ({ status: r.statusCode }))
  });
  // Counts only — never endpoints, ids or anything about a person.
  console.log('[push-reminders]', JSON.stringify(summary));
};

export const config = { schedule: '@hourly' };
