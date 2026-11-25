// Max Gainz — read-only viewer for a private share link (share.html#t=<token>).
// Runs NONE of the app's code and never reads localStorage, cookies or the
// app's session: it sends the link token to share_get (anon key, the same
// public key the app ships) and draws the copy it gets back with textContent
// only. The token travels in the #fragment, so it never reaches a server log
// or a Referer header.
(function(){
'use strict';
var SB_URL = 'https://lxudaetjuefylgjddonm.supabase.co';
var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4dWRhZXRqdWVmeWxnamRkb25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NTU1MzgsImV4cCI6MjA5MjMzMTUzOH0.Wr-9l63vjBQKu1NQPQsTJFwHwJiE9jhMxvJnR4P9wjg';

// ── shared share renderer (byte-identical in index.html and share.js — gate 21) ──
// Pure: a whitelisted share payload → what a viewer sees, as plain strings.
// Callers must escape (the app) or use textContent (share.js).
function _shareModel(p){
  const o = (p && typeof p === 'object') ? p : {};
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const kg = v => { const n = num(v); return n === null ? null : (Math.round(n * 100) / 100) + ' kg'; };
  const day = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if(!m) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
  };
  const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  const out = { heading:'', sub:'', stats:[], sections:[] };
  if(o.kind === 'session'){
    out.heading = str(o.title, 60) || 'Workout';
    out.sub = [day(o.date), str(o.programme, 60)].filter(Boolean).join(' · ');
    const t = (o.totals && typeof o.totals === 'object') ? o.totals : {};
    if(num(o.durationMin) !== null) out.stats.push(['Time', Math.round(o.durationMin) + ' min']);
    if(num(t.sets) !== null) out.stats.push(['Sets', String(Math.round(t.sets))]);
    if(num(t.volumeKg) !== null) out.stats.push(['Volume', Math.round(t.volumeKg).toLocaleString('en-GB') + ' kg']);
    const exs = Array.isArray(o.exercises) ? o.exercises.slice(0, 25) : [];
    const pbs = exs.filter(e => e && e.pb === true).length;
    if(pbs) out.stats.push(['PBs', String(pbs)]);
    if(exs.length) out.sections.push({ title:'Exercises', rows: exs.map(e => {
      const sets = Array.isArray(e && e.sets) ? e.sets.slice(0, 15) : [];
      const detail = sets.map(st => { const r = num(st && st.r), w = kg(st && st.w); return (r === null ? '–' : r) + (w ? ' × ' + w : ''); }).join(', ');
      return { label: str(e && e.name, 60) || 'Exercise', detail, badge: e && e.pb === true ? 'PB' : '', note: str(e && e.note, 200) };
    }) });
  } else if(o.kind === 'week'){
    out.heading = 'Week of ' + (day(o.weekStart) || '—');
    const done = num(o.done), planned = num(o.planned);
    if(done !== null) out.stats.push(['Sessions', planned ? done + ' of ' + planned : String(done)]);
    if(num(o.trendPct) !== null) out.stats.push(['Volume vs usual', (o.trendPct > 0 ? '+' : '') + Math.round(o.trendPct) + '%']);
    const pbs = Array.isArray(o.newPBs) ? o.newPBs.slice(0, 20) : [];
    if(pbs.length) out.sections.push({ title:'New PBs', rows: pbs.map(b => ({ label: str(b && b.name, 60) || 'Exercise', detail: kg(b && b.weight) || '', badge:'PB', note:'' })) });
    const ss = Array.isArray(o.sessions) ? o.sessions.slice(0, 14) : [];
    if(ss.length) out.sections.push({ title:'Workouts', rows: ss.map(x => ({ label: str(x && x.title, 60) || 'Workout', detail: day(x && x.date), badge:'', note:'' })) });
  } else {
    out.heading = 'Shared workout';
  }
  return out;
}
// ── end shared share renderer

function el(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); return n; }
function tokenFromHash(h){ var m = /^#t=([A-Za-z0-9_-]{24})$/.exec(String(h || '')); return m ? m[1] : null; }
function message(title, body){
  var app = document.getElementById('app'); app.textContent = '';
  app.appendChild(el('div', 'brand', 'Max Gainz'));
  var box = el('div', 'msg'); box.appendChild(el('h1', null, title)); box.appendChild(el('p', 'sub', body)); app.appendChild(box);
}
function draw(res){
  var m = _shareModel(res.payload);
  var app = document.getElementById('app'); app.textContent = '';
  app.appendChild(el('div', 'brand', 'Max Gainz · shared ' + (res.kind === 'week' ? 'week' : 'workout')));
  app.appendChild(el('h1', null, m.heading));
  if(m.sub) app.appendChild(el('div', 'sub', m.sub));
  if(m.stats.length){
    var st = el('div', 'stats');
    m.stats.forEach(function(s){ var d = el('div', 'stat'); d.appendChild(el('b', null, s[1])); d.appendChild(el('span', null, s[0])); st.appendChild(d); });
    app.appendChild(st);
  }
  m.sections.forEach(function(sec){
    var s = el('section'); s.appendChild(el('h2', null, sec.title));
    sec.rows.forEach(function(r){
      var row = el('div', 'row'); row.appendChild(el('strong', null, r.label));
      if(r.badge) row.appendChild(el('span', 'pb', r.badge));
      if(r.detail) row.appendChild(el('div', 'detail', r.detail));
      if(r.note) row.appendChild(el('div', 'note', '\u201c' + r.note + '\u201d'));
      s.appendChild(row);
    });
    app.appendChild(s);
  });
  var made = new Date(res.created_at), ends = new Date(res.expires_at);
  var f = function(d){ return isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }) : ''; };
  app.appendChild(el('p', 'foot', 'A read-only copy shared on ' + f(made) + '. It doesn\u2019t update, and the owner can turn this link off at any time. Link ends ' + f(ends) + '.'));
  document.title = m.heading + ' · Max Gainz';
}
// A different link pasted into the same tab only changes the #fragment: start over.
window.addEventListener('hashchange', function(){ location.reload(); });
var token = tokenFromHash(location.hash);
if(!token){ message('This link isn\u2019t complete', 'Ask the person who shared it to send the full link again.'); return; }
fetch(SB_URL + '/rest/v1/rpc/share_get', {
  method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_token: token })
}).then(function(r){ return r.ok ? r.json() : null; }).then(function(res){
  if(res && res.ok === true && res.payload) draw(res);
  else message('This link has ended', 'It was turned off by the person who shared it, or it expired.');
}).catch(function(){ message('Couldn\u2019t load this link', 'Check your connection and try again.'); });
})();
