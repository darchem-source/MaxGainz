// app/rollout.js — Max Gainz rollout registry and every device-level flag.
// Priority 7, slice 1: the first module out of index.html.
//
// Edit THIS file, then run `python3 tools/bundle.py`: it is copied into a
// marked region at the top of index.html's script (the app still ships as one
// file, so the service worker can never serve a page without its modules).
// Gate 33 fails if the copy drifts, and tests this file directly — no HTML
// parsing. Classic script: top-level declarations are shared globals, exactly
// as before. Nothing here touches the DOM at load time; functions may read
// localStorage / location / history when called.

// ═══ Registry (Priority 0) ═══════════════════════════════════════
// ── ROLLOUT REGISTRY (Priority 0) ─────────────────────────────────────────
// One description of every device-level rollout flag: what it is, what a
// fresh device gets, who it is for, how to switch it off, where it is stored,
// who owns it and when it goes away. docs/rollout.md mirrors this table.
// The flag functions (_navV2On, _p3FlagOn, _p4FlagOn, _p5FlagOn, _aiFlagOn)
// still decide behaviour; gate 26 runs them against this registry so the two
// can never disagree. mode: 'optIn' = on only when the key is '1';
// 'optOut' = on unless the key is '0'. requires = another entry that must be on.
const APP_VERSION = '2026.11.25.14';   // bump on every production push (shown in Data health)
const ROLLOUT_REGISTRY = [
  { id:'nav_v2', key:'maxgainz_nav_v2', mode:'optOut', label:'Simplified navigation',
    audience:'Everyone since 25 Nov 2026 (existing users get a one-time notice)', killSwitch:"Profile → Simplified navigation: Off, or 'Use classic navigation' on the notice (stores '0')",
    scope:'device', owner:'Phase 1 · UX', removeWhen:'Default-on for everyone for 4 weeks with no rollback needed → delete the classic nav bar and this key' },
  { id:'p5_profile', key:'maxgainz_p5_profile', mode:'optOut', label:'Grouped Profile layout',
    audience:'Everyone', killSwitch:"?p5=0 (stores '0')",
    scope:'device', owner:'Profile & settings', removeWhen:'4 weeks after rollout (25 Nov 2026) with no opt-outs → delete the old Profile layout and this key' },
  { id:'p4_reminders', key:'maxgainz_p4_reminders', mode:'optOut', label:'Training-day reminders',
    audience:'Everyone (the reminder itself is off until the user turns it on)', killSwitch:"?p4=0 on a device; PUSH_ENABLED unset on the server stops all sends",
    scope:'device + account', owner:'Phase 4', removeWhen:'4 weeks after rollout (25 Nov 2026) → keep the server kill switch, delete this key' },
  { id:'p3_offline', key:'maxgainz_p3_offline', mode:'optIn', label:'Offline downloads',
    audience:'Beta testers via ?p3=offline', killSwitch:'?p3=0 (removes the key)',
    scope:'device', owner:'Phase 3', removeWhen:'After Priority 4 (offline coverage) ships → default on, then delete this key' },
  { id:'p3_discover', key:'maxgainz_p3_discover', mode:'optIn', label:'Programme finder',
    audience:'Beta testers via ?p3=discover', killSwitch:'?p3=0 (removes the key)',
    scope:'device', owner:'Phase 3', removeWhen:'Decide default-on once accessibility pass (Priority 3) covers the filters → then delete this key' },
  { id:'p3_share', key:'maxgainz_p3_share', mode:'optIn', label:'Private share links',
    audience:'Beta testers via ?p3=share', killSwitch:'?p3=0 (removes the key)',
    scope:'device + account', owner:'Phase 3', removeWhen:'Decide default-on after 4 weeks of beta links with no privacy reports → then delete this key' },
  { id:'ai_v1', key:'maxgainz_ai_v1', mode:'optIn', label:'AI features (master)',
    audience:'Accounts in the ai_beta table (enrolled at sign-in; consent still required); ?ai= for testing', killSwitch:"?ai=0 on a device (stores '0': never re-enrolled); remove the account from ai_beta; AI_ENABLED unset on the server refuses every call",
    scope:'device + account consent', owner:'Phase 2 · AI', removeWhen:'Priority 6 beta proves value → replace with account-level cohort, then delete this key' },
  { id:'ai_coach', key:'maxgainz_ai_coach', mode:'optIn', requires:'ai_v1', label:'AI Today coach card',
    audience:'Controlled AI beta', killSwitch:'?ai=0', scope:'device', owner:'Phase 2 · AI', removeWhen:'With ai_v1' },
  { id:'ai_nl', key:'maxgainz_nl_log', mode:'optIn', requires:'ai_v1', label:'AI typed sets',
    audience:'Controlled AI beta', killSwitch:'?ai=0', scope:'device', owner:'Phase 2 · AI', removeWhen:'With ai_v1' },
  { id:'ai_recap', key:'maxgainz_ai_recap', mode:'optIn', requires:'ai_v1', label:'AI weekly recap',
    audience:'Controlled AI beta', killSwitch:'?ai=0', scope:'device', owner:'Phase 2 · AI', removeWhen:'With ai_v1' }
];

// Pure: is one registry entry on, given its raw stored value and (if it has
// one) whether the entry it requires is on? Mirrors the real flag functions.
function _rolloutOn(entry, raw, requiredOn){
  if(!entry) return false;
  if(entry.requires && !requiredOn) return false;
  return entry.mode === 'optOut' ? raw !== '0' : raw === '1';
}
// Pure: every entry's state. getItem(key) → stored string or null.
// source: 'default' (nothing stored) or 'device' (this device has a value).
function _rolloutSnapshot(reg, getItem){
  const raw = {}, out = {};
  reg.forEach(e => { let v = null; try { v = getItem(e.key); } catch(err){ v = null; } raw[e.id] = v === undefined ? null : v; });
  const on = id => { const e = reg.find(x => x.id === id); return !!e && _rolloutOn(e, raw[id], e.requires ? on(e.requires) : true); };
  reg.forEach(e => { out[e.id] = { on: on(e.id), source: raw[e.id] === null ? 'default' : 'device' }; });
  return out;
}

// ═══ Simplified navigation (Phase 1 / Priority 0 slice 2) ════════
const NAV_V2_KEY = 'maxgainz_nav_v2';
// One-time notice for people moved from the classic nav: 'pending:<ms>' from
// the first open after the default changed, 'done' once answered.
const NAV_NOTICE_KEY = 'maxgainz_nav_notice_v1';
// Pure: is the simplified nav on for this stored value? Only '0' (a choice) keeps classic.
function _navV2On(raw){ return raw !== '0'; }
// Pure: the notice value to store on this open, or null for no change. Only a
// device that never chose (raw null) and never had a notice starts one.
function _navMigrationStep(raw, notice, nowMs){
  return raw === null && notice === null ? 'pending:' + nowMs : null;
}
// Pure: show the one-time notice now? Only while it is pending, the simplified
// nav is showing, and there is a session from BEFORE the switch (a brand-new
// user has nothing to compare with, so never sees it).
function _navNoticeDue(notice, sessions, navOn){
  if(!navOn) return false;
  const m = /^pending:(\d+)$/.exec(String(notice || ''));
  if(!m) return false;
  const at = Number(m[1]);
  return (Array.isArray(sessions) ? sessions : []).some(x => { const t = x ? new Date(x.date).getTime() : NaN; return isFinite(t) && t < at; });
}
function _navMigrate(){
  try {
    const next = _navMigrationStep(localStorage.getItem(NAV_V2_KEY), localStorage.getItem(NAV_NOTICE_KEY), Date.now());
    if(next) localStorage.setItem(NAV_NOTICE_KEY, next);
  } catch(e){}
}

// ═══ Phase 3 (offline, discovery, sharing) ═══════════════════════
const P3_FLAG_KEYS = { offline:'maxgainz_p3_offline', discover:'maxgainz_p3_discover', share:'maxgainz_p3_share' };
// Pure: rollout flags from a ?p3= query value. 'all'/'1' → every Phase 3
// feature, '0'/'off' → none, 'offline,share' → those. null = no ?p3= present.
function _p3FlagsFromQuery(search){
  const m = /[?&]p3=([^&#]*)/.exec(String(search || ''));
  if(!m) return null;
  let v = '';
  try { v = decodeURIComponent(m[1]).toLowerCase(); } catch(e){ return null; }
  const all = Object.keys(P3_FLAG_KEYS);
  if(v === '0' || v === 'off') return { offline:false, discover:false, share:false };
  const want = (v === 'all' || v === '1') ? all : v.split(',').map(s => s.trim()).filter(s => all.indexOf(s) !== -1);
  if(!want.length) return null;
  const out = {};
  all.forEach(k => { out[k] = want.indexOf(k) !== -1; });
  return out;
}
function _p3ApplyFlagQuery(){
  let f = null;
  try { f = _p3FlagsFromQuery(location.search); } catch(e){ f = null; }
  if(!f) return;
  try {
    Object.keys(P3_FLAG_KEYS).forEach(k => { if(f[k]) localStorage.setItem(P3_FLAG_KEYS[k], '1'); else localStorage.removeItem(P3_FLAG_KEYS[k]); });
    const rest = location.search.replace(/[?&]p3=[^&#]*/, '').replace(/^&/, '?');
    history.replaceState(null, '', location.pathname + (rest && rest !== '?' ? rest : '') + location.hash);
  } catch(e){}
}
function _p3FlagOn(name){
  try { return !!P3_FLAG_KEYS[name] && localStorage.getItem(P3_FLAG_KEYS[name]) === '1'; } catch(e){ return false; }
}

// ═══ Phase 4 (reminders) ═════════════════════════════════════════
const P4_FLAG_KEYS = { reminders:'maxgainz_p4_reminders' };
// Pure: rollout flags from a ?p4= query value ('reminders'/'all'/'1' on, '0'/'off' off).
function _p4FlagsFromQuery(search){
  const m = /[?&]p4=([^&#]*)/.exec(String(search || ''));
  if(!m) return null;
  let v = '';
  try { v = decodeURIComponent(m[1]).toLowerCase(); } catch(e){ return null; }
  const all = Object.keys(P4_FLAG_KEYS);
  if(v === '0' || v === 'off'){ const o = {}; all.forEach(k => { o[k] = false; }); return o; }
  const want = (v === 'all' || v === '1') ? all : v.split(',').map(x => x.trim()).filter(x => all.indexOf(x) !== -1);
  if(!want.length) return null;
  const out = {};
  all.forEach(k => { out[k] = want.indexOf(k) !== -1; });
  return out;
}
function _p4ApplyFlagQuery(){
  let f = null;
  try { f = _p4FlagsFromQuery(location.search); } catch(e){ f = null; }
  if(!f) return;
  try {
    // Rolled out: on unless this device opted out (?p4=0 stores '0'; ?p4=1 clears it).
    Object.keys(P4_FLAG_KEYS).forEach(k => { if(f[k]) localStorage.removeItem(P4_FLAG_KEYS[k]); else localStorage.setItem(P4_FLAG_KEYS[k], '0'); });
    const rest = location.search.replace(/[?&]p4=[^&#]*/, '').replace(/^&/, '?');
    history.replaceState(null, '', location.pathname + (rest && rest !== '?' ? rest : '') + location.hash);
  } catch(e){}
}
function _p4FlagOn(name){
  // Rolled out to everyone; a device can still opt out with ?p4=0.
  try { return !!P4_FLAG_KEYS[name] && localStorage.getItem(P4_FLAG_KEYS[name]) !== '0'; } catch(e){ return !!P4_FLAG_KEYS[name]; }
}

// ═══ Profile layout ══════════════════════════════════════════════
const P5_FLAG_KEYS = { profile:'maxgainz_p5_profile' };
// Groups the Profile screen into Account · Your training · Body · About you ·
// Preferences · Data & account (audit P2). The flag only MOVES the existing
// elements (tagged data-pb) into new sections — nothing is duplicated, every id
// and handler stays the same, and with the flag off the screen is untouched.
function _p5FlagsFromQuery(search){
  const m = /[?&]p5=([^&#]*)/.exec(String(search || ''));
  if(!m) return null;
  let v = '';
  try { v = decodeURIComponent(m[1]).toLowerCase(); } catch(e){ return null; }
  const all = Object.keys(P5_FLAG_KEYS);
  if(v === '0' || v === 'off'){ const o = {}; all.forEach(k => { o[k] = false; }); return o; }
  const want = (v === 'all' || v === '1') ? all : v.split(',').map(x => x.trim()).filter(x => all.indexOf(x) !== -1);
  if(!want.length) return null;
  const out = {};
  all.forEach(k => { out[k] = want.indexOf(k) !== -1; });
  return out;
}
function _p5ApplyFlagQuery(){
  let f = null;
  try { f = _p5FlagsFromQuery(location.search); } catch(e){ f = null; }
  if(!f) return;
  try {
    // Rolled out: on unless this device opted out (?p5=0 stores '0'; ?p5=1 clears it).
    Object.keys(P5_FLAG_KEYS).forEach(k => { if(f[k]) localStorage.removeItem(P5_FLAG_KEYS[k]); else localStorage.setItem(P5_FLAG_KEYS[k], '0'); });
    const rest = location.search.replace(/[?&]p5=[^&#]*/, '').replace(/^&/, '?');
    history.replaceState(null, '', location.pathname + (rest && rest !== '?' ? rest : '') + location.hash);
  } catch(e){}
}
function _p5FlagOn(name){
  // Rolled out to everyone; a device can still opt out with ?p5=0.
  try { return !!P5_FLAG_KEYS[name] && localStorage.getItem(P5_FLAG_KEYS[name]) !== '0'; } catch(e){ return !!P5_FLAG_KEYS[name]; }
}

// ═══ AI (Phase 2 + Priority 6 beta) ══════════════════════════════
const AI_FLAG_KEYS = { master:'maxgainz_ai_v1', coach:'maxgainz_ai_coach', nl:'maxgainz_nl_log', recap:'maxgainz_ai_recap' };
const AI_COHORT_KEY = 'maxgainz_ai_cohort';
// Pure: rollout flags from a ?ai= query value. 'all' → everything on, '0'/'off'
// → everything off, 'coach,recap' → master + those. null = no ?ai= present.
function _aiFlagsFromQuery(search){
  const m = /[?&]ai=([^&#]*)/.exec(String(search || ''));
  if(!m) return null;
  const v = decodeURIComponent(m[1]).toLowerCase();
  const all = ['coach', 'nl', 'recap'];
  if(v === '0' || v === 'off') return { master:false, coach:false, nl:false, recap:false };
  const want = v === 'all' || v === '1' ? all : v.split(',').map(s => s.trim()).filter(s => all.indexOf(s) !== -1);
  if(v !== '1' && v !== 'all' && !want.length) return null;
  return { master:true, coach:want.indexOf('coach') !== -1, nl:want.indexOf('nl') !== -1, recap:want.indexOf('recap') !== -1 };
}
function _aiApplyFlagQuery(){
  let f = null;
  try { f = _aiFlagsFromQuery(location.search); } catch(e){ f = null; }
  if(!f) return;
  try {
    Object.keys(AI_FLAG_KEYS).forEach(k => {
      if(k === 'master') { if(f.master) localStorage.setItem(AI_FLAG_KEYS.master, '1'); else { localStorage.setItem(AI_FLAG_KEYS.master, '0'); localStorage.removeItem(AI_COHORT_KEY); } }
      else if(f[k]) localStorage.setItem(AI_FLAG_KEYS[k], '1');
      else if(!f.master) localStorage.removeItem(AI_FLAG_KEYS[k]);
    });
    history.replaceState(null, '', location.pathname + location.hash);
  } catch(e){}
}
// Device-level rollout flag (like maxgainz_nav_v2). Features need master + own flag.
function _aiFlagOn(name){
  try {
    if(localStorage.getItem(AI_FLAG_KEYS.master) !== '1') return false;
    return name === 'master' ? true : localStorage.getItem(AI_FLAG_KEYS[name]) === '1';
  } catch(e){ return false; }
}
// Pure: what enrolment should do. member: true / false / null (unknown — offline or SQL not run).
function _aiBetaPlan(member, masterRaw, cohortRaw){
  if(masterRaw === '0') return 'none';                       // this device opted out
  if(member === true) return masterRaw === '1' ? 'none' : 'enrol';
  if(member === false) return cohortRaw === 'beta' ? 'leave' : 'none';
  return 'none';
}
