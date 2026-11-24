// On-demand evals for the AI function (NOT part of tests/check.py: it calls the
// real model, needs network and costs money — about $0.01 per full run).
//
//   cd <repo> && npm install            # once; installs @anthropic-ai/sdk (gitignored)
//   ANTHROPIC_API_KEY=sk-ant-... node tests/evals/run.mjs [filter]
//
// It runs the REAL handler (netlify/functions/ai/core.mjs) with the real SDK
// client, the same prompts, schema and validation as production. Only the
// Supabase limits/consent RPC is stubbed to "ok" (evals have no user JWT).
// Pass = the handler's own checks pass AND the expected structure matches.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { handleAiRequest, AI_MODEL } from '../../netlify/functions/ai/core.mjs';

const key = process.env.ANTHROPIC_API_KEY;
if(!key){ console.error('Set ANTHROPIC_API_KEY in this shell first.'); process.exit(2); }
const filter = process.argv[2] || '';
const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url)));
const client = new Anthropic({ apiKey: key, timeout: 15000, maxRetries: 1 });
let modelCalls = 0;
const deps = {
  env: { AI_ENABLED: '1', ANTHROPIC_API_KEY: key },
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  callModel: (p) => { modelCalls++; return client.messages.create(p); },
  isTimeout: (e) => e instanceof Anthropic.APIConnectionTimeoutError
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function judge(c, r){
  const b = r.body, e = c.expect;
  if(e.noModel) return b.ok === false && b.reason === e.reason;
  if(!b.ok) return false;
  if(c.task === 'nl'){
    if(e.clarify) return b.out.sets.length === 0 && typeof b.out.clarify === 'string';
    const got = b.out.sets.map(s => [s.ex, s.weight === null ? 0 : s.weight, s.reps, s.rpe]);   // bodyweight: null or 0
    return same(got, e.sets);
  }
  if(c.task === 'recap') return b.out.mentionsSmallSample === e.mentionsSmallSample;
  return true;
}
const rows = []; let pass = 0, micro = 0, inTok = 0, outTok = 0, n = 0;
for(const c of cases){
  if(filter && !c.name.includes(filter)) continue;
  n++;
  const before = modelCalls, t0 = Date.now();
  const r = await handleAiRequest({ method: 'POST', auth: 'Bearer ' + 'e'.repeat(40), bodyText: JSON.stringify({ task: c.task, facts: c.facts }) }, deps);
  const called = modelCalls > before;
  const ok = judge(c, r) && (!c.expect.noModel || !called);
  pass += ok ? 1 : 0;
  micro += r.body.costMicroUsd || 0; inTok += (r.body.usage && r.body.usage.in) || 0; outTok += (r.body.usage && r.body.usage.out) || 0;
  rows.push({ name: c.name, pass: ok, ms: Date.now() - t0, reason: r.body.reason || null, detail: r.body.detail || null, out: r.body.out || null, costMicroUsd: r.body.costMicroUsd || 0 });
  console.log((ok ? 'PASS ' : 'FAIL ') + c.name + (ok ? '' : '  → ' + JSON.stringify(r.body).slice(0, 300)));
}
const byTask = {};
rows.forEach(r => { const t = r.name.split(':')[0]; byTask[t] = byTask[t] || [0, 0]; byTask[t][0] += r.pass ? 1 : 0; byTask[t][1]++; });
const calls = rows.filter(r => r.costMicroUsd > 0).length;
const summary = { model: AI_MODEL, at: new Date().toISOString(), passed: pass, total: n, byTask,
  costUsd: micro / 1e6, avgCostPerCallUsd: calls ? micro / calls / 1e6 : 0, inputTokens: inTok, outputTokens: outTok };
console.log('\n' + JSON.stringify(summary, null, 2));
writeFileSync(new URL('./last-run.json', import.meta.url), JSON.stringify({ summary, rows }, null, 1));
