// app/ai-validators.js — AI request/answer validators shared by the app and the
// server (netlify/functions/ai/core.mjs). Priority 7, slice 4.
//
// ONE source for both copies: edit THIS file, then run `python3 tools/bundle.py`.
// It is copied into a marked region in index.html (client: checks every answer
// before it reaches the UI or saved data) and into a marked region in core.mjs
// (server: checks before anything leaves the function). Gate 15 still compares
// the two copies function by function; gate 36 checks both regions equal this
// file and runs it on its own. Pure: no globals, no I/O, no DOM.
function _aiNum(v, lo, hi, isInt){
  return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi && (!isInt || Math.floor(v) === v);
}
function _aiIsObj(o, keys){
  if(!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const k = Object.keys(o);
  return k.length === keys.length && keys.every(x => Object.prototype.hasOwnProperty.call(o, x));
}
// Every number a text states: digits in any script (NFKC → ASCII), 82.5,
// 1,200, ranges (6–8 → 6 and 8), a leading minus (−12), and number words
// including compounds (eighty-eight). Placeholders ({EX}, L1, E2) are not
// numbers. Vulgar fractions (½) can never be grounded (NaN).
function _aiNumbersIn(text){
  const raw = String(text == null ? '' : text);
  const out = [];
  if(/[¼-¾⅐-⅟⁄∕]/.test(raw) || /\b(thousand|million|billion)\b/i.test(raw)) out.push(NaN);
  const s = raw.normalize('NFKC')
    .replace(/\{EX\}/g, ' ')
    .replace(/\b[LE]\d{1,2}\b/g, ' ')
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while((m = re.exec(s)) !== null){
    const v = parseFloat(m[0].replace(',', '.'));
    const i = m.index;
    const neg = i > 0 && (s[i - 1] === '-' || s[i - 1] === '−') && (i < 2 || !/[0-9A-Za-z]/.test(s[i - 2]));
    out.push(neg ? -v : v);
  }
  const W = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
    eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18,
    nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
    hundred:100, dozen:12 };
  const tensRe = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s]+(?:one|two|three|four|five|six|seven|eight|nine))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine';
  const val = w => w.split(/[-\s]+/).reduce((a, x) => a + (W[x] || 0), 0);
  const words = s.toLowerCase()
    .replace(new RegExp('\\b(a|one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+(?:and\\s+)?(' + tensRe + '))?\\b', 'g'),
      (all, h, rest) => { out.push((h === 'a' ? 1 : W[h]) * 100 + (rest ? val(rest) : 0)); return ' '; })
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s]+(one|two|three|four|five|six|seven|eight|nine)\b/g,
    (all, t, u) => { out.push(W[t] + W[u]); return ' '; });
  const wr = /[a-z]+/g;
  while((m = wr.exec(words)) !== null){ if(Object.prototype.hasOwnProperty.call(W, m[0])) out.push(W[m[0]]); }
  return out;
}
// Every number present anywhere in a facts object (values and inside strings).
function _aiFactNumbers(v){
  const out = [];
  (function walk(x){
    if(typeof x === 'number'){ if(isFinite(x)) out.push(x); }
    else if(typeof x === 'string') _aiNumbersIn(x).forEach(n => out.push(n));
    else if(Array.isArray(x)) x.forEach(walk);
    else if(x && typeof x === 'object') Object.keys(x).forEach(k => walk(x[k]));
  })(v);
  return out;
}
// {ok, bad[]}: every number stated in `text` must exist in `allowed`.
function _aiGrounded(text, allowed){
  const bad = _aiNumbersIn(text).filter(n => !(allowed || []).some(a => Math.abs(a - n) < 1e-6));
  return { ok: bad.length === 0, bad };
}
function _aiMentionsPain(text){
  return /\b(pain\w*|hurt\w*|injur\w*|tweak\w*|twinge\w*|ache[sd]?|aching|sore\w*|strain\w*|sprain\w*|pulled|numb\w*|tingl\w*|swell\w*|swollen|dizz\w*|faint\w*)\b/i.test(String(text == null ? '' : text));
}
// '' when the facts for `task` have exactly the allowed shape, else a reason.
function _aiValidateFacts(task, f){
  const safeText = (s, max) => typeof s === 'string' && s.length >= 1 && s.length <= max && !/[<>{}`\\\u0000-\u001f]/.test(s);
  if(task === 'coach'){
    if(!_aiIsObj(f, ['ex','unit','last','target','decision','guard','note'])) return 'coach shape';
    if(f.ex !== '{EX}') return 'coach ex';
    if(f.unit !== 'kg' && f.unit !== 'kg/hand') return 'coach unit';
    const L = f.last;
    if(!_aiIsObj(L, ['daysAgo','weight','reps','rpe'])) return 'coach last';
    if(!_aiNum(L.daysAgo, 0, 3650, true) || !_aiNum(L.weight, 0, 1000, false)) return 'coach last values';
    if(!Array.isArray(L.reps) || L.reps.length > 10 || !L.reps.every(r => _aiNum(r, 0, 200, true))) return 'coach reps';
    if(L.rpe !== null && !_aiNum(L.rpe, 1, 10, false)) return 'coach rpe';
    const T = f.target;
    if(!_aiIsObj(T, ['sets','reps']) || !_aiNum(T.sets, 1, 20, true) || typeof T.reps !== 'string' || !/^\d{1,3}([–-]\d{1,3})?$/.test(T.reps)) return 'coach target';
    const D = f.decision;
    if(!_aiIsObj(D, ['action','rule','from','to','confidence'])) return 'coach decision';
    if(['increase','hold','deload','reps'].indexOf(D.action) === -1) return 'coach action';
    if(typeof D.rule !== 'string' || !/^[A-Za-z_]{1,24}$/.test(D.rule)) return 'coach rule';
    if(!_aiNum(D.from, 0, 1000, false) || !_aiNum(D.to, 0, 1000, false)) return 'coach weights';
    if(['low','medium','high'].indexOf(D.confidence) === -1) return 'coach confidence';
    const G = f.guard;
    if(!_aiIsObj(G, ['rpeCeiling','fallbackWeight'])) return 'coach guard';
    if(G.rpeCeiling !== null && !_aiNum(G.rpeCeiling, 1, 10, false)) return 'coach guard rpe';
    if(G.fallbackWeight !== null && !_aiNum(G.fallbackWeight, 0, 1000, false)) return 'coach guard weight';
    if(f.note !== null && (!safeText(f.note, 140) || _aiMentionsPain(f.note))) return 'coach note';
    return '';
  }
  if(task === 'nl'){
    if(!_aiIsObj(f, ['text','exercises','unit'])) return 'nl shape';
    if(typeof f.text !== 'string' || f.text.trim().length < 1 || f.text.length > 140 || /[\u0000-\u001f]/.test(f.text)) return 'nl text';
    if(_aiMentionsPain(f.text)) return 'pain';
    if(f.unit !== 'kg' && f.unit !== 'lb') return 'nl unit';
    if(!Array.isArray(f.exercises) || f.exercises.length < 1 || f.exercises.length > 20) return 'nl exercises';
    const seen = {};
    for(let i = 0; i < f.exercises.length; i++){
      const e = f.exercises[i];
      if(!_aiIsObj(e, ['id','name']) || typeof e.id !== 'string' || !/^E\d{1,2}$/.test(e.id) || seen[e.id]) return 'nl exercise';
      if(typeof e.name !== 'string' || !/^[A-Za-z0-9 ()'&+.,\/–-]{1,60}$/.test(e.name)) return 'nl exercise name';
      seen[e.id] = 1;
    }
    return '';
  }
  if(task === 'recap'){
    if(!_aiIsObj(f, ['done','planned','plannedSource','activities','daysLeft','trend','pbs','under','balanced','smallSample','sessionsLogged','action'])) return 'recap shape';
    if(!_aiNum(f.done, 0, 50, true) || !_aiNum(f.planned, 1, 30, true) || !_aiNum(f.activities, 0, 50, true) || !_aiNum(f.daysLeft, 0, 6, true) || !_aiNum(f.sessionsLogged, 0, 100000, true)) return 'recap counts';
    if(f.plannedSource !== 'plan' && f.plannedSource !== 'default') return 'recap source';
    if(f.trend !== null && (!_aiIsObj(f.trend, ['dir','pct']) || ['up','down','steady'].indexOf(f.trend.dir) === -1 || !_aiNum(f.trend.pct, -100, 1000, true))) return 'recap trend';
    if(!Array.isArray(f.pbs) || f.pbs.length > 3) return 'recap pbs';
    for(let i = 0; i < f.pbs.length; i++){
      const p = f.pbs[i];
      if(!_aiIsObj(p, ['ref','weight','prev']) || p.ref !== 'L' + (i + 1) || !_aiNum(p.weight, 0, 1000, false) || !_aiNum(p.prev, 0, 1000, false)) return 'recap pb';
    }
    if(f.under !== null && (!_aiIsObj(f.under, ['label','pct']) || typeof f.under.label !== 'string' || !/^[A-Za-z &\/-]{1,24}$/.test(f.under.label) || !_aiNum(f.under.pct, 0, 100, true))) return 'recap under';
    if(typeof f.balanced !== 'boolean' || typeof f.smallSample !== 'boolean') return 'recap flags';
    if(!safeText(f.action, 200)) return 'recap action';
    return '';
  }
  return 'task';
}
// {ok, reason}: a model output is shown/saved only if this passes — the
// schema, plus grounding (no number the facts don't contain) and guardrails.
function _aiCheckOutput(task, out, f){
  const medical = /\b(injur\w*|pain\w*|diagnos\w*|physio\w*|doctor\w*|medic\w*|treat\w*|rehab\w*|inflam\w*|tendon\w*|tendin\w*|sprain\w*|surgery)\b/i;
  const str = (s, lo, hi) => typeof s === 'string' && s.trim().length >= lo && s.length <= hi;
  const unsafe = x => medical.test(x) || _aiMentionsPain(x);
  if(_aiValidateFacts(task, f)) return { ok:false, reason:'facts' };
  if(task === 'coach'){
    if(!_aiIsObj(out, ['text']) || !str(out.text, 1, 240)) return { ok:false, reason:'schema' };
    if(out.text.indexOf('{EX}') === -1) return { ok:false, reason:'placeholder' };
    if(unsafe(out.text)) return { ok:false, reason:'medical' };
    const D = f.decision;
    // Plain derivations of the facts the tip may state: the change, weeks off, % change.
    const wk = f.last.daysAgo / 7;
    const allowed = _aiFactNumbers(f).concat([Math.round(Math.abs(D.to - D.from) * 100) / 100, Math.round(wk), Math.floor(wk),
      D.from > 0 ? Math.round(Math.abs(D.to - D.from) / D.from * 100) : 0]);
    if(!_aiGrounded(out.text, allowed).ok) return { ok:false, reason:'ungrounded' };
    if((D.action === 'increase' || D.action === 'deload') && D.to !== D.from && _aiNumbersIn(out.text).indexOf(D.to) === -1) return { ok:false, reason:'missing target' };
    return { ok:true, reason:'' };
  }
  if(task === 'nl'){
    if(!_aiIsObj(out, ['sets','clarify'])) return { ok:false, reason:'schema' };
    if(out.clarify !== null && !str(out.clarify, 1, 140)) return { ok:false, reason:'schema' };
    if(!Array.isArray(out.sets) || out.sets.length > 10) return { ok:false, reason:'schema' };
    if(!out.sets.length && out.clarify === null) return { ok:false, reason:'empty' };
    const ids = f.exercises.map(e => e.id), said = _aiNumbersIn(f.text);
    const inText = n => said.some(a => Math.abs(a - n) < 1e-6);
    if(out.clarify !== null && (unsafe(out.clarify) || !_aiGrounded(out.clarify, said).ok)) return { ok:false, reason:'clarify' };
    if(out.sets.length > Math.max(said.length, said.indexOf(out.sets.length) !== -1 ? out.sets.length : 0)) return { ok:false, reason:'set count' };
    const saidLb = /\b(lbs?|pounds?)\b/i.test(f.text), saidKg = /\b(kgs?|kilos?|kilograms?)\b/i.test(f.text);
    const saidBw = /\b(bw|body ?weight)\b/i.test(f.text);
    for(let i = 0; i < out.sets.length; i++){
      const s = out.sets[i];
      if(!_aiIsObj(s, ['ex','weight','unit','reps','rpe'])) return { ok:false, reason:'schema' };
      if(ids.indexOf(s.ex) === -1) return { ok:false, reason:'exercise' };
      if(s.unit !== null && s.unit !== 'kg' && s.unit !== 'lb') return { ok:false, reason:'schema' };
      if(s.weight !== null && !_aiNum(s.weight, 0, 1100, false)) return { ok:false, reason:'range' };
      if(!_aiNum(s.reps, 1, 100, true)) return { ok:false, reason:'range' };
      if(s.rpe !== null && (!_aiNum(s.rpe, 1, 10, false) || Math.round(s.rpe * 2) !== s.rpe * 2)) return { ok:false, reason:'range' };
      if((s.unit === 'lb' && !saidLb) || (s.unit === 'kg' && !saidKg)) return { ok:false, reason:'unit' };
      if(s.weight === 0 && !saidBw && !inText(0)) return { ok:false, reason:'ungrounded' };
      if(!inText(s.reps) || (s.weight !== null && s.weight !== 0 && !inText(s.weight)) || (s.rpe !== null && !inText(s.rpe))) return { ok:false, reason:'ungrounded' };
    }
    return { ok:true, reason:'' };
  }
  if(task === 'recap'){
    if(!_aiIsObj(out, ['headline','body','mentionsSmallSample']) || !str(out.headline, 1, 80) || !str(out.body, 1, 400) || typeof out.mentionsSmallSample !== 'boolean') return { ok:false, reason:'schema' };
    const all = out.headline + ' ' + out.body;
    if(unsafe(all)) return { ok:false, reason:'medical' };
    const derived = f.pbs.map(p => Math.round((p.weight - p.prev) * 100) / 100)
      .concat([Math.max(0, f.planned - f.done), f.daysLeft + 1, Math.abs(f.trend ? f.trend.pct : 0), f.pbs.length]);   // PB count: also checked by 'pb count' below
    if(!_aiGrounded(all, _aiFactNumbers(f).concat(derived)).ok) return { ok:false, reason:'ungrounded' };
    // Labels: only L1..Ln for the PBs that exist; never exercise ids.
    const labels = all.match(/\b[LE]\d+\b/g) || [];
    if(labels.some(l => l[0] === 'E' || +l.slice(1) < 1 || +l.slice(1) > f.pbs.length)) return { ok:false, reason:'label' };
    // "N PBs / records" must be the real count.
    const pbClaim = all.match(/\b(\d+|one|two|three|four|five)\s+(?:new\s+)?(?:pbs?|personal\s+(?:bests?|records?)|records?)\b/i);
    if(pbClaim && _aiNumbersIn(pbClaim[1])[0] !== f.pbs.length) return { ok:false, reason:'pb count' };
    // A sentence with a percentage must point the same way as the trend.
    const up = /\b(up|above|higher|more|increas\w*|rose|grew|gain\w*)\b/i, down = /\b(down|below|lower|less|decreas\w*|fell|dropped|lighter)\b/i;
    // Percentages: only the volume trend's (pointing the right way) or the under-trained share.
    const tp = f.trend ? Math.abs(f.trend.pct) : null, up2 = f.under ? f.under.pct : null;
    const pctIn = s => (s.match(/\d+(?:\.\d+)?(?=\s*(?:%|per ?cent))/gi) || []).map(Number);
    for(const s of all.split(/[.!?]/)){
      for(const n of pctIn(s)){
        if(n === tp){
          const bad = (f.trend.dir === 'down' && up.test(s) && !down.test(s)) || (f.trend.dir === 'up' && down.test(s) && !up.test(s));
          if(bad) return { ok:false, reason:'direction' };
        } else if(n !== up2) return { ok:false, reason:'percent' };
      }
    }
    if(f.smallSample && (!out.mentionsSmallSample || !/\b(early|so far|few|small sample|limited|not enough|still building)\b|\bonly (?:\d+|one|two|three|four|five) sessions?\b/i.test(all))) return { ok:false, reason:'small sample' };
    return { ok:true, reason:'' };
  }
  return { ok:false, reason:'task' };
}
