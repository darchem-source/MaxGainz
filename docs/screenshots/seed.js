(function(){
  if (location.hostname !== 'localhost') return;
  // ---- native environment stub (mirrors what Capacitor injects in the iOS app) ----
  const noop = () => Promise.resolve({});
  const pkg = (id, type, price, priceString, per, perMonth) => ({
    identifier: type === 'ANNUAL' ? '$rc_annual' : '$rc_monthly', packageType: type,
    product: { identifier: id, price, priceString, subscriptionPeriod: per, pricePerMonthString: perMonth || null,
      introPrice: { price: 0, periodNumberOfUnits: 1, periodUnit: 'WEEK' } }
  });
  const expires = new Date(Date.now() + 5*864e5).toISOString();
  window.Capacitor = {
    isNativePlatform: () => true, getPlatform: () => 'ios',
    Plugins: {
      Purchases: {
        configure: noop, logIn: noop, logOut: noop, getAppUserID: () => Promise.resolve({appUserID:'$RCAnonymousID:demo'}),
        addCustomerInfoUpdateListener: () => {},
        getCustomerInfo: () => Promise.resolve({ customerInfo: { entitlements: { active: { pro: {
          isActive: true, periodType: 'TRIAL', expirationDate: expires, willRenew: true, productIdentifier: 'maxgainz_pro_annual' } }, all: {} } } }),
        getOfferings: () => Promise.resolve({ current: { availablePackages: [
          pkg('maxgainz_pro_annual','ANNUAL',39.99,'£39.99','P1Y','£3.33'),
          pkg('maxgainz_pro_monthly','MONTHLY',4.99,'£4.99','P1M') ] } }),
        checkTrialOrIntroductoryPriceEligibility: (a) => { const o = {}; (a.productIdentifiers||[]).forEach(i => o[i] = { status: 2 }); return Promise.resolve(o); },
        purchasePackage: noop, restorePurchases: noop
      },
      SplashScreen: { hide: noop }, Haptics: { impact: noop, notification: noop, vibrate: noop },
      KeepAwake: { keepAwake: noop, allowSleep: noop }, App: { addListener: () => Promise.resolve({remove(){}}) },
      Share: { share: noop, canShare: () => Promise.resolve({value:true}) }, Browser: { open: noop },
      LocalNotifications: { checkPermissions: () => Promise.resolve({display:'granted'}), requestPermissions: () => Promise.resolve({display:'granted'}), schedule: noop, cancel: noop }
    }
  };
  // ---- seed demo data (only once per fresh context) ----
  if (localStorage.getItem('maxgainz_v1')) return;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const day = d => { const x = new Date(); x.setHours(18, 10, 0, 0); x.setDate(x.getDate() - d); return x; };
  const PPL = {
   'Push A':[['Bench Press',4,82.5,0],['Incline Dumbbell Press',5,32,0],['Push Press',4,52.5,0],["Cable Fly's",4,15,0],['Triceps Pushdowns',3,22.5,0]],
   'Push B':[['Bench Press',4,80,0],['Overhead Press',5,42.5,0],['Dips',4,15,0],['Skull Crushers',4,27.5,0],['Lateral Raises',3,12,0]],
   'Pull A':[['Deadlift',4,150,0],['Bent Over Barbell Row',5,80,0],['Pulldowns',4,115,0],['Barbell Curls',3,32.5,0]],
   'Pull B':[['Deadlift',4,140,0],['Pull-Ups',5,0,1],['Pulldowns',4,110,0],['Barbell Curls',3,27.5,0]],
   'Legs A':[['Squat',4,120,0],['Bulgarian Split Squats',5,26,0],['Leg Press',4,210,0],['Leg Curls',3,60,0]],
   'Legs B':[['Squat',4,110,0],['Lunges',5,50,0],['Leg Press',4,190,0],['Leg Extensions',3,55,0]]
  };
  const order = ['Push A','Pull A','Legs A','Push B','Pull B','Legs B'];
  const sessions = []; let k = 0;
  // 8 weeks, Mon/Wed/Fri (+ a Sat on some weeks), oldest first
  for (let w = 7; w >= 0; w--) {
    [[w*7 + 4, 0], [w*7 + 2, 0], [w*7 + 0, 0]].forEach(([off]) => {
      // week starts Monday: anchor on the most recent Monday
      const now = new Date(); const dow = (now.getDay() + 6) % 7; // 0=Mon
      const dAgo = off + dow - 0 - 0; // days ago of Fri/Wed/Mon of week w
      const d0 = (w*7) + dow - (off - w*7) ; // placeholder, replaced below
    });
  }
  const today = new Date(); const dow = (today.getDay() + 6) % 7;
  for (let w = 7; w >= 0; w--) {
    [0, 2, 4].forEach(wd => { // Mon, Wed, Fri
      const dAgo = w*7 + dow - wd;
      if (dAgo <= 0) return; // not today or future
      const name = order[k % 6]; const prog = 1 + (7 - w) * 0.012; k++;
      const setLog = {}; let volume = 0; const top = [];
      PPL[name].forEach(([ex, sets, base, bw], i) => {
        const w0 = bw ? 0 : Math.round(base * prog / 2.5) * 2.5;
        const reps = [], sw = [];
        for (let s = 0; s < sets; s++) { const r = i === 0 ? 5 - (s > 1 ? 1 : 0) : 10 - (s > 1 ? 1 : 0) + (rnd() > .7 ? 1 : 0); reps.push(r); sw.push(w0); volume += (w0 || 80) * r; }
        setLog[ex] = { ord: i, sets: sets, reps, weight: w0, bw: !!bw, setWeights: sw, equipOverride: null, note: null, restSecs: sw.map(() => 85 + Math.round(rnd()*40)) };
        if (!bw) top.push({ name: ex, weight: w0 });
      });
      top.sort((a,b) => b.weight - a.weight);
      const dt = day(dAgo);
      sessions.push({ date: dt.toISOString(), day: name, exercises: PPL[name].length, durationMin: 52 + Math.round(rnd()*16),
        volume: Math.round(volume), topLifts: top.slice(0,2), setLog, progressions: [], adhoc: false, progKey: 'PPL' });
    });
  }
  // a few non-gym activities
  [[3,'Run','🏃','running',38],[10,'Tennis','🎾','tennis',60],[17,'Run','🏃','running',42],[24,'Swim','🏊','swimming',35],[38,'Run','🏃','running',40]].forEach(([d, n, e, t, m]) => {
    sessions.push({ date: day(d).toISOString(), day: n, exercises: 0, durationMin: m, volume: 0, topLifts: [], setLog: {}, activityType: t, activityEmoji: e, intensity: 'moderate', manualActivity: true, custom_activity: true, notes: null, xpAwarded: Math.min(60, m) });
  });
  sessions.sort((a,b) => new Date(a.date) - new Date(b.date));
  const bwLog = []; for (let i = 7; i >= 0; i--) bwLog.push({ date: day(i*7 + 1).toISOString(), weight: Math.round((84.6 - (7-i)*0.35)*10)/10, unit: 'kg' });
  const meas = [{date: day(49).toISOString(), chest:101, waist:86, arms:35.5, thighs:59, hips:98},{date: day(7).toISOString(), chest:103, waist:84, arms:37, thighs:60.5, hips:98}];
  localStorage.setItem('maxgainz_v1', JSON.stringify({ userId: null, sessions, weights: {}, todayProg: 'PPL',
    userProfile: { firstName: 'Alex', lastName: '', email: '', gender: 'male', dob: '', heightCM: 180, weight: 82 },
    bodyWeightLog: bwLog, measurementsLog: meas, dailyNotes: {}, savedAt: new Date().toISOString() }));
  const iso = d => { const x = new Date(); x.setDate(x.getDate() - d); return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
  const end = new Date(); end.setDate(end.getDate() - 35 + 8*7 - 1);
  localStorage.setItem('maxgainz_path', JSON.stringify({ id: 'demo-path-1', programme: 'PPL', duration: 8, startDate: iso(35),
    endDate: end.getFullYear()+'-'+String(end.getMonth()+1).padStart(2,'0')+'-'+String(end.getDate()).padStart(2,'0'), status: 'active',
    coreSchedule: { daysPerWeek: 3, preferredDays: ['Monday','Wednesday','Friday'], variant: '3day' }, addOns: [], weeklyReports: [], currentWeek: 6, lastReportDate: null }));
  localStorage.setItem('maxgainz_guest', '1'); localStorage.setItem('maxgainz_onboarded', '1');
  localStorage.setItem('maxgainz_ladder_v2_seen', '1');
})();
