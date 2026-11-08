"use strict";
/* =========================================================
   KOBE 42.195 レースナビ：ランナー用の画面と計測
   ========================================================= */
const E = window.Engine;
const SET_KEY = "kobe-settings-v1", RUN_KEY = "kobe-run-v1", ACK_KEY = "kobe-ack-v1";

const KOBE_GATES = [
  ["御旅公園",3.8,"10:00"],["工業技術センター",8.0,"10:36"],["須磨一ノ谷プラザ",10.7,"10:59"],["舞子公園",17.5,"11:57"],
  ["大蔵海岸西",20.7,"12:25"],["舞子駅",23.9,"12:53"],["垂水下水処理場",27.1,"13:23"],["須磨一ノ谷プラザ",31.1,"14:02"],
  ["須磨海浜公園",32.7,"14:18"],["駒ヶ林会館",35.4,"14:46"],["中央卸売市場第7門",39.8,"15:33"]
].map(([name,km,time],i)=>({name, km, time, mg:[5,7,9][i] ?? 10}));   // mg：その関門で確保したい余裕（分）
// ペース表（アーティファクト）の基本の配分
const KOBE_SEGS = [[3.8,"8:30"],[20.7,"8:15"],[23.9,"8:30"],[27.1,"8:45"],[31.1,"9:00"],[32.7,"9:30"],[35.4,"10:00"],[39.8,"10:30"],[42.195,"11:00"]].map(([to,pace])=>({to,pace}));
// 場所がはっきりしている関門（ここを通ったら距離を合わせ直す）
const ANCHOR_KM = [[8.0,"工業技術センター"],[10.7,"須磨一ノ谷プラザ"],[17.5,"舞子公園"],[20.7,"大蔵海岸西"],[23.9,"舞子駅"],[27.1,"垂水下水処理場"],[31.1,"須磨一ノ谷プラザ"]];

const DEF = {
  raceDate:"2026-11-15", gun:"09:00", finishClose:"16:00",
  gates:KOBE_GATES, segs:KOBE_SEGS, margin:10, fastest:"7:00",
  practiceCross:"09:20",
  early:{over:true, overSec:15, untilKm:17.5, hillSpare:3},   // 序盤（舞子公園まで）の注意
  hills:[],                                                    // 上り坂 [{km, name}]（自分で登録）
  voice:{rate:1.0, km:true, pass:true, every:0},
  keys:{notif:true, media:true, volume:false},
  sync:{url:"", key:"", name:""},
  sim:true,
};
let S = load(SET_KEY) || {};
S = Object.assign(JSON.parse(JSON.stringify(DEF)), S);
if(S.gates.length && S.gates.every(g=>g.mg == null)) S.gates.forEach((g,i)=>{ g.mg = [5,7,9][i] ?? 10; });   // 以前の設定：関門ごとの余裕を足す
// アプリ（APK）に組み込んだ共有の設定（private/config.js）。設定画面で入れた値があればそちらを優先
const KC = window.KOBE_CONFIG || {};
["url","key","page"].forEach(k=>{ if(KC[k] && !(S.sync && S.sync[k])) S.sync = Object.assign({}, S.sync, {[k]:KC[k]}); });
S.voice = Object.assign({}, DEF.voice, S.voice); S.early = Object.assign({}, DEF.early, S.early); S.hills = S.hills || []; S.keys = Object.assign({}, DEF.keys, S.keys); S.sync = Object.assign({}, DEF.sync, S.sync);
let R = load(RUN_KEY);   // 計測中の状態
let T = null;            // Tracker
let watchId = null, gpsAcc = null, lastSaid = "", view = "home", finishArmed = false, goalArmed = false, wakeLock = null, map = null, mapLayers = {}, mapFollow = true;
const LAST_KEY = "kobe-last-v1";   // 前回の結果（ホームに出す）

function load(k){ try{ return JSON.parse(localStorage.getItem(k) || "null"); }catch(e){ return null; } }
function store(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
const saveS = () => store(SET_KEY, S);
// 通信や再生が終わらないまま固まらないよう、時間で打ち切る
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, ng)=>setTimeout(()=>ng(new Error("時間切れ")), ms))]);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(t){ const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(()=>d.remove(), 2600); }
const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + E.pad(d.getMonth()+1) + "-" + E.pad(d.getDate()); };
const isRaceDay = () => todayStr() === S.raceDate;
const clockOfDay = ms => { const d = new Date(ms); return d.getHours()*3600 + d.getMinutes()*60 + d.getSeconds() + d.getMilliseconds()/1000; };
// 「8:30」「830」「8分30秒」などを 8:30 にそろえる
function normPace(v){ v = String(v||"").trim().replace(/[０-９]/g, c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).replace(/分/, ":").replace(/秒/, ""); if(/^\d{3,4}$/.test(v)) v = v.slice(0,-2) + ":" + v.slice(-2); return E.parsePace(v) ? v : ""; }

/* ---------- 設定 → 計算用 ---------- */
function cfg(){
  return {
    segs:S.segs.map(s=>({to:Number(s.to), pace:E.parsePace(s.pace)})).filter(s=>s.to>0 && s.pace),
    gates:S.gates.map(g=>({name:g.name, km:Number(g.km), close:E.parseHM(g.time), margin:(g.mg === "" || g.mg == null ? Number(S.margin)||0 : Number(g.mg))*60})).filter(g=>g.km>0 && g.close!=null).sort((a,b)=>a.km-b.km),
    finishKm:42.195, finishClose:E.parseHM(S.finishClose), marginSec:(Number(S.margin)||0)*60, fastestSec:E.parsePace(S.fastest)||0,
  };
}
const course = () => window.KOBE_COURSE || null;
function anchors(){
  const c = course(); if(!c) return [];
  if(Array.isArray(c.anchors)) return c.anchors.map(a=>({...a}));   // コースのデータに入っている、場所がはっきりした関門
  return ANCHOR_KM.map(([km,name])=>{ const p = E.pointAtKm(c, km); return {name, km, lat:p[0], lon:p[1]}; });
}

/* ---------- 時間 ---------- */
const nowMs = () => R && R.sim && window.Sim ? Sim.now() : Date.now();
const elapsed = () => R ? (nowMs() - R.startT)/1000 : 0;
const clockNow = () => R ? R.startClock + elapsed() : clockOfDay(Date.now());
function st(){
  const c = cfg();
  return {dist:T ? T.dist : 0, clock:clockNow(), elapsed:elapsed(), plan:R && R.plan, base:R && R.base, gates:c.gates, finishKm:c.finishKm, finishClose:c.finishClose};
}

/* ---------- 読み上げ ---------- */
let jaVoice = null;
function pickVoice(){ try{ const vs = speechSynthesis.getVoices(); jaVoice = vs.find(v=>/^ja/i.test(v.lang) && /Google|Kyoko|O-?ren/i.test(v.name)) || vs.find(v=>/^ja/i.test(v.lang)) || null; }catch(e){} }
if("speechSynthesis" in window){ pickVoice(); try{ speechSynthesis.onvoiceschanged = pickVoice; }catch(e){} }
function say(text, interrupt, onend){
  lastSaid = text;
  const el = $("said"); if(el) el.textContent = "🔊 " + text;
  if(!("speechSynthesis" in window)){ onend && onend(); return; }
  if(R && R.sim && window.Sim && Sim.speed >= 20) interrupt = true;   // 早送り中は読み上げをためない
  try{
    if(interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; if(jaVoice) u.voice = jaVoice; u.rate = Number(S.voice.rate) || 1;
    if(onend){ let done = false; const fin = ()=>{ if(!done){ done = true; onend(); } }; u.onend = fin; u.onerror = fin; setTimeout(fin, 20000); }
    speechSynthesis.speak(u);
  }catch(e){ onend && onend(); }
}

/* ---------- 本体の追加機能（アプリ版のみ：通知のボタン・イヤホン・音量ボタン・音声再生） ---------- */
const Native = (()=>{
  const cap = window.Capacitor, ex = window.capacitorExports;
  if(!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !ex) return null;
  try{ return ex.registerPlugin("RaceKeys"); }catch(e){ return null; }
})();
let keysOn = false;
async function keysEnable(){
  if(!Native) return;
  try{
    if(!keysOn){ await Native.addListener("press", e=>onPress(e && e.kind || "gate", e && e.source)); await Native.addListener("tick", bgTick); keysOn = true; }
    await Native.enable({title:"KOBE 42.195 レース中", text:"「次の関門」で関門までの距離・時間・ペースを読み上げ", notif:!!S.keys.notif, mediaButtons:!!S.keys.media, volumeKeys:!!S.keys.volume});
  }catch(e){ console.warn(e); }
}
// 本体から10秒ごとに呼ばれる（画面OFF・裏画面でウェブ側のタイマーが止まっても動く）
function bgTick(){
  if(!R) return;
  if(R.sim && window.Sim && Sim.on) Sim.tick();
  if(nowMs() - R.lastLive > 30000) Live.push();
  persist();
}
async function keysDisable(){ if(Native) try{ await Native.disable(); }catch(e){} }
async function playAudio(b64, mime){
  if(Native){ try{ await Native.playAudio({data:b64, mime}); return; }catch(e){} }
  await new Promise(ok=>{ try{ const a = new Audio("data:" + mime + ";base64," + b64); a.onended = ok; a.onerror = ok; a.play().catch(ok); }catch(e){ ok(); } });
}

/* =========================================================
   計測
   ========================================================= */
function makeTracker(){ T = new E.Tracker(course(), anchors()); if(R && R.tracker) T.import(R.tracker); }
function newPlan(){ const s = st(); return E.makePlan(cfg(), s.dist, s.clock); }

function startRun(opt){
  opt = opt || {};
  const sim = !!opt.sim, t = sim ? Sim.now() : Date.now();
  let startClock;
  if(opt.clock != null) startClock = opt.clock;
  else if(!sim && isRaceDay()) startClock = clockOfDay(t);        // 本番：実際の時刻
  else startClock = E.parseHM(S.practiceCross) || E.parseHM("09:20"); // 練習・シミュレーション：選んだ時刻とみなす
  R = {sim, startT:t, startWall:Date.now(), startClock, tracker:null, laps:[], lastLapEl:0, nextKm:1, passed:[], track:[], lastLive:0, lastVoice:0, savedAt:0, plan:null, base:null, raceDay:!sim && isRaceDay()};
  makeTracker();
  R.plan = newPlan(); R.base = R.plan;
  const g = E.nextGate(st());
  say(`計測を開始しました。スタート${E.spClock(startClock)}。最初の目標ペースは${E.spPace(E.paceAt(R.plan, 0))}。` + (g ? `最初の関門、${g.name}は${E.spClock(g.close)}閉鎖です。` : ""), true);
  persist(true);
  if(!sim || Native) startGps();   // アプリ版はシミュレーションでもGPSを動かす（本番と同じく、画面OFFでも止まらない状態にする）
  keysEnable(); keepAwake();
  view = "run"; render();
  Live.push();
}
function finishRun(goal){
  const el = elapsed(), d = T ? T.dist : 0;
  if(goal) say(`完走おめでとうございます！記録は${E.spSec(el)}です。お疲れさまでした。`, true);
  else say(`お疲れさまでした。${E.spDist(d)}、${E.spSec(el)}。`, true);
  if(R) R.goal = !!goal;
  Live.push(true);
  store(LAST_KEY, {at:Date.now(), goal:!!goal, sim:!!(R && R.sim), dist:+d.toFixed(2), el:Math.round(el)});
  if(R && R.sim && window.Sim) Sim.stop();
  stopGps(); keysDisable();
  try{ wakeLock && wakeLock.release(); }catch(e){}
  const hist = load("kobe-history-v1") || [];
  if(R && !R.sim){ hist.push({at:Date.now(), dist:+d.toFixed(2), el:Math.round(el), laps:R.laps.map(l=>[l.km, Math.round(l.sec)])}); store("kobe-history-v1", hist.slice(-20)); }
  R = null; T = null; persist(true); finishArmed = false; goalArmed = false; view = "home"; render();
}
function persist(force){
  if(!R){ store(RUN_KEY, null); return; }
  if(!force && Date.now() - R.savedAt < 10000) return;
  R.savedAt = Date.now(); R.tracker = T ? T.export() : null;
  store(RUN_KEY, R);
}

/* ---------- GPS ---------- */
function startGps(){
  if(watchId != null || !navigator.geolocation) return;
  // 時刻はGPSが位置を測った時刻を使う（画面OFF中は、いくつかの位置がまとめて届くことがあるため）
  watchId = navigator.geolocation.watchPosition(p=>{
    if(R && R.sim){ if(window.Sim && Sim.on) Sim.tick(); return; }   // シミュレーション中：本物の位置は使わない（画面OFFでも動き続けるためだけにGPSを動かす）
    const now = Date.now(), ts = Number(p.timestamp); onFix({lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy, speed:p.coords.speed, t:ts > now - 600000 && ts < now + 5000 ? Math.min(ts, now) : now}); },
    e=>{ if(R && R.sim) return; const el = $("gps"); if(el) el.textContent = e.code===1 ? "位置情報が許可されていません" : "GPSを探しています…"; if(e.code===1) toast("位置情報の利用を許可してください"); },
    {enableHighAccuracy:true, maximumAge:0, timeout:20000});
}
function stopGps(){ if(watchId != null){ try{ navigator.geolocation.clearWatch(watchId); }catch(e){} watchId = null; } }
async function keepAwake(){ if(Native) return; try{ if(R && "wakeLock" in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request("screen"); }catch(e){} }

function onFix(f){
  gpsAcc = f.acc;
  if(!R || !T){ updateRun(); return; }
  if(T.s.last && f.t <= T.s.last.t){ updateRun(); return; }          // 古い位置・同じ位置の重複は使わない
  const prev = T.dist, el = Math.max(0, (f.t - R.startT)/1000);     // 位置を測った時点の経過時間
  const evs = T.fix(f);
  const accepted = T.s.last && T.s.last.t === f.t;
  const d = T.dist;
  const jumped = evs.some(e=>e.type !== "anchor" || Math.abs(e.delta) > 0.05) || (accepted && R.lastFixEl != null && el - R.lastFixEl > 30);
  const tr = R.track[R.track.length-1];
  if(!tr || E.hav(tr, [f.lat, f.lon]) >= 30){ R.track.push([+f.lat.toFixed(5), +f.lon.toFixed(5)]); if(R.track.length > 800) R.track.splice(0, R.track.length-800); }
  R.lastPos = [+f.lat.toFixed(5), +f.lon.toFixed(5)];
  evs.forEach(e=>{ if(e.type==="anchor") console.log("関門地点で距離を補正", e.name, e.delta.toFixed(3)); });
  const speech = [];
  // 1kmごと
  let kmLap = null;
  const lapsBefore = R.laps.length;
  while(d >= R.nextKm && R.nextKm <= 42){
    const k = R.nextKm;
    const tc = d > prev && prev < k && R.lastFixEl != null ? R.lastFixEl + (k-prev)/(d-prev)*(el-R.lastFixEl) : el;
    const target = E.paceAt(R.plan, k - 0.5) || 0;
    kmLap = {km:k, sec:tc - R.lastLapEl, target, t:tc, partial:k === R.partialKm};
    R.laps.push(kmLap); R.lastLapEl = tc; R.nextKm++;
  }
  // 1回の位置で2km以上進んだ・電波切れや補正のあとのラップは、正確でないのでラップの比較を読まない
  if(R.laps.length - lapsBefore > 1 || (kmLap && jumped)) R.laps.slice(lapsBefore).forEach(l=>{ l.partial = true; });
  // 関門の通過
  const passedNow = [];
  st().gates.forEach(g=>{ const key = g.name + "@" + g.km; if(d >= g.km + 0.05 && !R.passed.includes(key)){ R.passed.push(key); passedNow.push(g); } });
  if(kmLap || passedNow.length || evs.length){   // 距離を補正したときも、計画を作り直す
    const before = E.paceAt(R.plan, d + 0.01);
    R.plan = newPlan();
    const after = E.paceAt(R.plan, d + 0.01);
    const change = before && after && Math.abs(before - after) >= 10 ? `目標ペースを${E.spPace(after)}に変更します。` : "";
    const s = st();
    passedNow.forEach(g=>{ if(S.voice.pass && g.close - s.clock > -600) speech.push(E.passText(s, g)); });
    if(kmLap && S.voice.km && !(passedNow.length && S.voice.pass)) speech.push(E.kmText(s, kmLap, change));
    else if(change && passedNow.length) speech.push(change);
    // 序盤に速すぎるとき（2kmに1回まで）
    const ea = S.early;
    if(kmLap && ea.over && !kmLap.partial && kmLap.km <= ea.untilKm && kmLap.target && kmLap.target - kmLap.sec >= ea.overSec && kmLap.km - (R.lastOverKm || -9) >= 2){
      R.lastOverKm = kmLap.km; speech.push(E.overText());
    }
  }
  // 上り坂の手前（序盤で、次の関門の余裕が目標より◯分以上多いときだけ）
  (S.hills || []).forEach(h=>{
    const km = Number(h.km), key = "hill@" + km;
    if(!(km > 0) || (R.hillsSaid || []).includes(key) || d < km - 0.2 || d >= km) return;
    R.hillsSaid = (R.hillsSaid || []).concat(key);
    if(km > S.early.untilKm) return;
    const s = st(), g = E.nextGate(s); if(!g || !R.plan) return;
    const spare = g.close - (s.clock + E.timeBetween(R.plan, d, g.km)) - (g.margin || 0);
    if(spare >= (Number(S.early.hillSpare) || 0)*60) speech.push(E.hillText((km - d)*1000, h.name));
  });
  // フィニッシュの近く：GPSがフィニッシュ地点から60m以内（40km過ぎ）か、距離が42.195kmに達したら1回だけ案内
  const c0 = course();
  if(c0 && d > 40){ const fp = c0.pts[c0.pts.length-1]; if(E.hav([f.lat, f.lon], [fp[0], fp[1]]) < 60) R.nearFinish = true; }
  if(!R.goalSaid && (d >= 42.195 || R.nearFinish)){ R.goalSaid = true; R.nearFinish = true; speech.length = 0; speech.push("ゴール予定地点付近です。ゴールしたら、ゴールボタンを押してください。"); }
  const every = Number(S.voice.every) || 0;
  if(!speech.length && every && el - R.lastVoice >= every*60) speech.push(statusText());
  if(speech.length){ R.lastVoice = el; speech.forEach(t=>say(t)); }
  if(accepted){ R.lastFixEl = el; R.lastFixAt = Date.now(); }
  if(nowMs() - R.lastLive > 30000) Live.push();
  persist();
  updateRun();
}

/* ---------- ボタン ---------- */
function onPress(kind, source){
  if(!R){ say("計測していません。", true); return; }
  R.plan = newPlan();
  say(kind === "status" ? statusText() : E.gateButtonText(st()), true);
  if(source && source !== "screen") toast(source === "volume" ? "音量ボタンで読み上げ" : source === "media" ? "イヤホンのボタンで読み上げ" : "通知のボタンで読み上げ");
  updateRun();
}
function statusText(){
  const s = st(), el = s.elapsed;
  let t = `${E.spDist(s.dist)}、スタートから${E.spSec(el).replace(/\d+秒$/, m=>el>=600?"":m)}。`;
  if(s.base) t += E.diffWords(s.clock - E.etaAt(s.base, s.dist), "cum") + "。";
  const p = predict();
  if(p) t += `ゴール予想、目標ペースなら${E.spClock(p.plan)}` + (p.recent ? `、今のペースが続けば${E.spClock(p.recent)}。` : "。");
  const g = E.nextGate(s);
  if(g) t += E.gateText(s, g);
  return t;
}
// 最近3kmの「実際 ÷ スタート時の計画」の比で、今のペースが続いた場合を出す
function predict(){
  const s = st(); if(!R || !R.plan) return null;
  const last3 = R.laps.slice(-3).filter(l=>!l.partial);
  let ratio = null;
  if(last3.length && R.base){ const act = last3.reduce((a,l)=>a+l.sec,0), pl = last3.reduce((a,l)=>a+E.timeBetween(R.base, l.km-1, l.km),0); if(pl > 0) ratio = act/pl; }
  return E.predict(s, ratio);
}

/* =========================================================
   共有（見守り）：30秒ごとに状況を送り、メッセージを受け取る
   ========================================================= */
const Sync = {
  get ok(){ return !!(S.sync.url && S.sync.key); },
  async post(body){
    const r = await fetch(S.sync.url, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(Object.assign({key:S.sync.key}, body))});
    const j = await r.json();
    if(!j.ok) throw new Error(j.error==="key" ? "合言葉が違います" : (j.error || "通信エラー"));
    return j;
  },
};
const Live = {
  busy:false, queue:[],
  acked(){ return new Set(load(ACK_KEY) || []); },
  ack(ids){ const s = this.acked(); ids.forEach(i=>s.add(i)); store(ACK_KEY, [...s].slice(-200)); },
  snapshot(final){
    const s = st(), g = E.nextGate(s), p = predict();
    let gate = null;
    if(g){ const left = g.close - s.clock, rem = g.km - s.dist, eta = R.plan ? s.clock + E.timeBetween(R.plan, s.dist, g.km) : null;
      gate = {name:g.name, km:g.km, close:g.close, rem:+rem.toFixed(3), left:Math.round(left), req:left>0 ? Math.round((left - Math.min(120,left*0.08))/(rem*1.01+0.05)) : null, margin:eta!=null ? Math.round(g.close-eta) : null, need:g.margin}; }
    return {at:Date.now(), state:final ? "finished" : "running", goal:!!(final && R.goal), sim:!!R.sim, name:S.sync.name || "", off:!!(T && T.s.offCourse), near:!!R.nearFinish,
      dist:+s.dist.toFixed(3), el:Math.round(s.elapsed), clock:Math.round(s.clock), startClock:Math.round(R.startClock),
      cur:T && T.curPace() ? Math.round(T.curPace()) : null, avg:s.dist>0.05 ? Math.round(s.elapsed/s.dist) : null,
      cum:R.base ? Math.round(s.clock - E.etaAt(R.base, s.dist)) : null, target:R.plan ? Math.round(E.paceAt(R.plan, s.dist)) : null,
      predPlan:p ? Math.round(p.plan) : null, predRecent:p && p.recent ? Math.round(p.recent) : null,
      pos:R.lastPos || null, acc:gpsAcc ? Math.round(gpsAcc) : null, track:R.track.slice(-150), gate,
      laps:R.laps.slice(-45).map(l=>[l.km, Math.round(l.sec), Math.round(l.sec - l.target), l.partial ? 1 : 0]),
      // アプリの状態（見守り側で「動いているか」を見るため）
      app:{native:!!Native, gpsAge: Math.round((Date.now() - (R.lastFixAt || R.startWall || Date.now()))/1000), battery: batt.level, charging: batt.charging, hidden: document.hidden}};
  },
  async push(final){
    if(!Sync.ok || !R) return;
    if(R.sim && !S.sync.simShare) { R.lastLive = nowMs(); return; }
    if(final){   // 終了・ゴールは、ほかの通信中でも必ず送る（3回まで再送）
      const snap = this.snapshot(true);
      (async()=>{ for(let i=0;i<3;i++){ try{ await withTimeout(Sync.post({live:snap}), 25000); return; }catch(e){ await new Promise(ok=>setTimeout(ok, 4000)); } } })();
      return;
    }
    if(this.busy && Date.now() - (this.busyAt || 0) < 40000) return;
    if(R.sim && Date.now() - (this.realAt || 0) < 10000) return;   // シミュレーションの早回し中も、送るのは実時間で10秒に1回まで
    this.busy = true; this.busyAt = Date.now(); R.lastLive = nowMs(); this.realAt = Date.now();
    try{
      const j = await withTimeout(Sync.post({live:this.snapshot(false)}), 25000);   // 電波が悪くて返事が来なくても、次の送信を止めない
      const seen = this.acked(), fresh = (j.msgs || []).filter(m=>!seen.has(m.id));
      // 計測を始める前に送られたメッセージ（前回のテストの残りなど）は読まずに「届いた」にする
      if(fresh.length){ this.ack(fresh.map(m=>m.id)); Sync.post({ack:fresh.map(m=>m.id)}).catch(()=>{}); fresh.filter(m=>!(m.at < (R.startWall || 0) - 60000)).forEach(m=>this.queue.push(m)); this.drain(); }
      setNet("");
    }catch(e){ setNet("共有：通信できません"); }
    this.busy = false;
  },
  playing:false,
  async drain(){
    if(this.playing) return;
    this.playing = true;
    while(this.queue.length){
      const m = this.queue.shift(), from = m.from ? m.from + "さんから。" : "";
      showMsg(m);
      if(m.voice){
        await new Promise(ok=>say(`${from}声のメッセージです。`, false, ok));
        try{ const j = await withTimeout(Sync.post({getvoice:m.voice}), 30000); if(j.data) await withTimeout(playAudio(j.data, j.mime || m.mime || "audio/webm"), 45000); }catch(e){ say("声のメッセージを受け取れませんでした。"); }
      } else await new Promise(ok=>say(`応援メッセージ。${from}${m.text}`, false, ok));
    }
    this.playing = false;
  },
};
let netMsg = "";
// 電池の残り（取れる端末だけ）
const batt = {level:null, charging:null};
try{ navigator.getBattery && navigator.getBattery().then(b=>{ const up = ()=>{ batt.level = Math.round(b.level*100); batt.charging = b.charging; }; up(); b.addEventListener("levelchange", up); b.addEventListener("chargingchange", up); }).catch(()=>{}); }catch(e){}
// 生存の合図：GPSが取れないときも、30秒ごとに見守りへ送る（画面OFFでも動く）
setInterval(()=>{ if(R && nowMs() - R.lastLive > 30000) Live.push(); }, 10000);
function setNet(t){ netMsg = t; const el = $("net"); if(el) el.textContent = t; }
function showMsg(m){ R && (R.lastMsg = {text:m.voice ? "🎤 声のメッセージ" : m.text, from:m.from || "", at:Date.now()}); updateRun(); }

/* =========================================================
   画面
   ========================================================= */
function render(){
  const app = $("app");
  if(R){ renderRun(app); return; }
  renderHome(app);
}

function planTable(plan){
  return `<table class="plan"><thead><tr><th>関門</th><th>目標</th><th>予定</th><th>閉鎖</th></tr></thead><tbody>${
    plan.gates.map(g=>`<tr><td>${esc(g.name)}<div class="small muted num">${g.km.toFixed(1)}km</div></td>
      <td class="n">${E.fmtPace(E.paceAt(plan, g.km-0.01))}</td>
      <td class="n">${E.fmtClock(g.eta)} <span class="m ${g.margin<g.need?"tight":"safe"}">余裕${g.margin>=0?Math.floor(g.margin/60)+"分":"なし"}</span></td>
      <td class="n">${E.fmtClock(g.close)}</td></tr>`).join("")
    }<tr><td>フィニッシュ<div class="small muted num">42.195km</div></td><td class="n">${E.fmtPace(E.paceAt(plan, 42.1))}</td><td class="n">${E.fmtClock(plan.finishEta)}</td><td class="n">${esc(S.finishClose)}</td></tr></tbody></table>`;
}

function renderHome(app){
  const race = isRaceDay();
  const cross = E.parseHM(S.practiceCross) || E.parseHM("09:20");
  const plan = E.makePlan(cfg(), 0, race ? Math.max(E.parseHM(S.gun), clockOfDay(Date.now())) : cross);
  const choices = ["09:05","09:10","09:15","09:20","09:25","09:30"];
  app.innerHTML = `<div class="wrap">
    <div class="hdr"><div class="brand">KOBE <span>42.195</span></div><span class="chip">${race ? "本番当日" : "練習モード"}</span></div>
    ${race ? `<div class="card"><b>スタートラインを越えたら押してください</b><p class="small muted">押した時刻（今の時計）で関門までの計算をします。号砲は${esc(S.gun)}。</p></div>`
      : `<div class="card"><b>練習：スタートを押した時刻を、何時とみなしますか？</b>
        <div class="picker">${choices.map(c=>`<button data-cross="${c}" aria-pressed="${E.parseHM(c)===cross}">${c.replace(/^0/,"")}</button>`).join("")}</div>
        <p class="small muted">本番（${esc(S.raceDate)}）は、押した時刻そのままで計算します。</p></div>`}
    ${lastResult()}
    <button class="btn go wide startbtn" data-act="start">スタート</button>
    <div class="card"><div class="spread"><b>${race ? "今スタートした場合" : E.fmtClock(cross) + "スタートの場合"}の計画</b><span class="small muted">関門ごとの余裕を確保するよう自動補正</span></div>
      ${planTable(plan)}
      <p class="small muted">余裕の目標（${esc(S.gates.slice(0,3).map(g=>(g.mg ?? S.margin)+"分").join("・"))}、以降${esc(S.margin)}分）を切る関門は赤。目標ペースは、ペース表の配分を基本に、間に合わない関門の手前だけ速くしています（最速 ${esc(S.fastest)}/km まで）。</p></div>
    <div class="row">
      <button class="btn" data-act="settings">設定</button>
      ${window.Sim && S.sim ? `<button class="btn" data-act="sim" style="border-color:var(--gold);color:var(--gold)">シミュレーション</button>` : ""}
      <button class="btn ghost" data-act="voicetest">音声テスト</button>
    </div>
    ${Native ? "" : `<p class="small muted">ブラウザで開いています。画面を消すと計測が止まるので、レースではAndroidアプリ版を使ってください。</p>`}
  </div>`;
}

function lastResult(){
  const r = load(LAST_KEY); if(!r || Date.now() - r.at > 3*86400000) return "";
  const t = new Date(r.at);
  return `<div class="card"><b>${r.goal ? "🏁 完走" : "前回の計測"}${r.sim ? "（シミュレーション）" : ""}</b><div class="small">${t.getMonth()+1}/${t.getDate()} ${t.getHours()}:${E.pad(t.getMinutes())}に終了・${Number(r.dist).toFixed(2)}km・記録 <b class="num">${E.fmtDur(r.el)}</b></div></div>`;
}
function renderRun(app){
  app.innerHTML = `<div class="run">
    <div class="spread"><span class="chip ${R.sim?"sim":""}" id="gps">${R.sim ? "シミュレーション" : "GPS待機中…"}</span><span class="small muted num" id="clock"></span><span class="small bad" id="net">${esc(netMsg)}</span></div>
    ${R.sim && window.Sim ? Sim.bar() : ""}
    <div class="msg" id="msg" hidden></div>
    <div class="big"><div class="d num"><span id="dist">0.00</span><small>km</small></div>
      <div class="t"><b id="el">0:00</b><span>スタートから</span></div></div>
    <div class="card gatecard" id="gate"></div>
    <div class="tiles">
      <div><span>目標ペース</span><b id="tp">—</b></div>
      <div><span>現在ペース</span><b id="cp">—</b></div>
      <div><span>予定との差</span><b id="cum">—</b></div>
    </div>
    <div class="tiles">
      <div><span>直前のラップ</span><b id="lap">—</b></div>
      <div><span>ゴール予想(目標)</span><b id="pp">—</b></div>
      <div><span>今のペースなら</span><b id="pr">—</b></div>
    </div>
    <p class="said" id="said">${lastSaid ? "🔊 " + esc(lastSaid) : ""}</p>
    <button class="goalbtn" data-act="goal" id="goalbtn" hidden>ゴール！<small>ゴールしたら押す（2回）</small></button>
    <button class="bigbtn" data-act="press">次の関門<small>距離・閉鎖までの時間・ペースを読み上げ</small></button>
    <div class="tools">
      <button class="btn" data-act="status">状況を読む</button>
      <button class="btn" data-act="fix">距離を直す</button>
      <button class="btn" data-act="more">地図など</button>
      <button class="btn" data-act="finish" id="finbtn">${finishArmed ? "もう一度で終了" : "終了"}</button>
    </div>
    <div id="more" hidden>
      <div class="map" id="map"></div>
      <div class="mapbar"><button class="btn" data-act="mapme">現在地に戻す</button></div>
      <div class="card"><table class="laps" id="laps"></table></div>
      <div class="row"><button class="btn" data-act="settings">設定</button><button class="btn" data-act="startfix">スタート時刻を直す</button></div>
    </div>
  </div>`;
  updateRun();
}

let lastUi = 0;
function updateRun(){
  if(!R || !$("dist")) return;
  const s = st(), d = s.dist;
  $("dist").textContent = d.toFixed(2);
  $("el").textContent = E.fmtDur(s.elapsed);
  $("clock").textContent = E.fmtClockS(s.clock);
  if(!R.sim) $("gps").textContent = gpsAcc == null ? "GPS待機中…" : `GPS ±${Math.round(gpsAcc)}m` + (T && T.s.offCourse ? "・コース外" : "");
  const g = E.nextGate(s);
  if(g){
    const left = g.close - s.clock, rem = g.km - d;
    const req = left > 0 ? (left - Math.min(120, left*0.08))/(rem*1.01+0.05) : null;
    const eta = R.plan ? s.clock + E.timeBetween(R.plan, d, g.km) : null, m = eta!=null ? g.close - eta : null;
    $("gate").innerHTML = `<div class="spread"><span class="gname">次の関門：${esc(g.name)}</span><span class="small muted num">${g.km.toFixed(1)}km・${E.fmtClock(g.close)}閉鎖</span></div>
      <div class="grid"><div><span>あと</span><b>${rem<1 ? Math.round(rem*1000)+"m" : rem.toFixed(2)+"<small style='font-size:14px'>km</small>"}</b></div>
      <div><span>閉鎖まで</span><b class="${left<600?"bad":""} ${left>=3600?"long":""}">${left>0 ? E.fmtDur(left) : "閉鎖"}</b></div>
      <div><span>必要ペース</span>${!req ? "<b>—</b>" : req >= 720 ? `<b class="word">歩いてOK</b>` : `<b>${E.fmtPace(req)}</b>`}</div>
      <div><span>目標で余裕</span><b class="${m!=null && m<(g.margin ?? 600) ? "bad" : "good"}">${m==null ? "—" : m>=0 ? Math.floor(m/60)+"分" : "なし"}</b></div></div>`;
  } else {
    const rem = s.finishKm - d;
    const fl = s.finishClose - s.clock;
    $("gate").innerHTML = `<div class="spread"><span class="gname">${R.nearFinish || rem <= 0 ? "ゴール予定地点付近" : "フィニッシュまで"}</span><span class="small muted">制限 ${esc(S.finishClose)}</span></div><div class="grid"><div><span>あと</span><b>${rem <= 0 ? "0m" : rem < 1 ? Math.round(rem*1000)+"m" : rem.toFixed(2)}</b></div><div><span>制限まで</span><b class="${fl >= 3600 ? "long" : ""}">${fl > 0 ? E.fmtDur(fl) : "—"}</b></div></div>`;
  }
  // 残り1kmを切ったら（またはフィニッシュ地点の近く）、終了ボタンの代わりにゴールボタンを大きく出す
  const showGoal = d >= s.finishKm - 1 || !!R.nearFinish;
  const gb = $("goalbtn"), fb = $("finbtn");
  if(gb && gb.hidden === showGoal){ gb.hidden = !showGoal; if(fb) fb.hidden = showGoal; }
  $("tp").textContent = R.plan ? E.fmtPace(E.paceAt(R.plan, d)) : "—";
  const cp = T && T.curPace(); $("cp").textContent = cp ? E.fmtPace(cp) : "—";
  const cum = R.base ? s.clock - E.etaAt(R.base, d) : null;
  const ce = $("cum"); ce.textContent = cum == null ? "—" : (Math.abs(cum) < 3 ? "±0" : (cum>0?"+":"−") + E.fmtDur(Math.abs(cum))); ce.className = cum > 3 ? "bad" : "good";
  const last = R.laps[R.laps.length-1];
  $("lap").innerHTML = !last ? "—" : last.partial ? `<small style="font-size:15px">補正のため—</small>` : `${E.fmtPace(last.sec)}<small class="${last.sec-last.target>3?"bad":"good"}" style="font-size:14px"> ${last.sec-last.target>=0?"+":"−"}${Math.round(Math.abs(last.sec-last.target))}</small>`;
  const p = predict();
  $("pp").textContent = p ? E.fmtClock(p.plan) : "—";
  $("pr").textContent = p && p.recent ? E.fmtClock(p.recent) : "—";
  const mEl = $("msg");
  if(R.lastMsg && Date.now() - R.lastMsg.at < 5*60000){ mEl.hidden = false; mEl.innerHTML = `<b>${esc(R.lastMsg.from || "応援")}からのメッセージ</b><div>${esc(R.lastMsg.text)}</div>`; } else mEl.hidden = true;
  if(R.sim && window.Sim) Sim.updateBar();
  if(!$("more").hidden && Date.now() - lastUi > 3000){ lastUi = Date.now(); updateMore(); }
}
function updateMore(){
  const lapsDesc = R.laps.slice().reverse();   // （L は地図の部品の名前なので使わない）
  $("laps").innerHTML = `<tr><th>km</th><th>ラップ</th><th>目標差</th></tr>` + lapsDesc.map(l=>`<tr><td>${l.km}</td><td class="num">${E.fmtPace(l.sec)}</td>${l.partial ? `<td class="muted">補正</td>` : `<td class="num ${l.sec-l.target>3?"bad":"good"}">${l.sec-l.target>=0?"+":"−"}${Math.round(Math.abs(l.sec-l.target))}</td>`}</tr>`).join("");
  if(!window.L) return;
  const box = $("map"); if(!box) return;
  // 画面を作り直したとき（設定の保存など）は、地図も作り直す（古い地図は消えた場所に残っているため）
  if(map && map.getContainer() !== box){ try{ map.remove(); }catch(e){} map = null; }
  const c = course();
  if(!map){
    map = L.map(box, {zoomControl:true});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:18, attribution:"© OpenStreetMap"}).addTo(map);
    map.setView(R.lastPos || (c ? E.pointAtKm(c, T ? T.dist : 0) : [34.66,135.12]), 15);   // 先に表示位置を決める（決まる前に印を置くと地図の部品がエラーになる）
    if(c && window.MapDeco) MapDeco.add(map, c, cfg().gates);
    mapLayers.passed = L.polyline([], {color:"#1e88ff", weight:6, opacity:.9}).addTo(map);   // 通過した区間（コース上）
    mapLayers.track = L.polyline([], {color:"#7db2ea", weight:2, opacity:.8, dashArray:"4 4"}).addTo(map);   // 実際のGPSの軌跡
    mapLayers.me = L.circleMarker([34.69,135.19], {radius:9, color:"#fff", weight:2, fillColor:"#f5b83d", fillOpacity:1}).addTo(map);
    // 自分で動かしたり拡大したりしたら、現在地を追いかけるのをやめる（「現在地に戻す」で再開）
    map.on("dragstart zoomstart", ()=>{ if(!map._kobeAuto) mapFollow = false; });
    mapFollow = true;
  }
  if(c) mapLayers.passed.setLatLngs(window.MapDeco ? MapDeco.passed(c, T ? T.dist : 0) : []);
  mapLayers.track.setLatLngs(R.track);
  if(R.lastPos){ mapLayers.me.setLatLng(R.lastPos); if(mapFollow){ map._kobeAuto = true; map.panTo(R.lastPos, {animate:false}); map._kobeAuto = false; } }
}

/* ---------- 設定シート ---------- */
function openSettings(){
  const bg = document.createElement("div"); bg.className = "sheet-bg";
  const segRow = s => `<div class="seg-row"><input class="inp num" name="sto" inputmode="decimal" value="${esc(s.to)}" placeholder="km まで"><input class="inp num" name="space" inputmode="numeric" value="${esc(s.pace)}" placeholder="8:30"><button type="button" class="x" data-del>✕</button></div>`;
  const gateRow = g => `<div class="gate-row"><input class="inp" name="gname" value="${esc(g.name)}" placeholder="名前"><input class="inp num" name="gkm" inputmode="decimal" value="${esc(g.km)}" placeholder="km"><input class="inp num" name="gtime" type="time" value="${esc(g.time)}"><input class="inp num" name="gmg" inputmode="numeric" value="${esc(g.mg ?? "")}" placeholder="${esc(S.margin)}"><button type="button" class="x" data-del>✕</button></div>`;
  const hillRow = h => `<div class="seg-row"><input class="inp num" name="hkm" inputmode="decimal" value="${esc(h.km)}" placeholder="坂の始まり km"><input class="inp" name="hname" value="${esc(h.name||"")}" placeholder="メモ（例：橋）"><button type="button" class="x" data-del>✕</button></div>`;
  bg.innerHTML = `<form class="sheet" id="setf">
    <div class="spread"><h2>設定</h2><button type="button" class="btn ghost" data-close>閉じる</button></div>
    <section class="card"><h3>目標ペースの配分（基本）</h3>
      <p class="small muted">「◯kmまで、このペース」。ペース表と同じ配分が入っています。スタートが遅れて関門に間に合わない場合は、アプリが自動で手前を速くします。</p>
      <div class="seg-row small muted"><span>何kmまで</span><span>ペース(/km)</span><span></span></div>
      <div id="segs" style="display:grid;gap:6px">${S.segs.map(segRow).join("")}</div>
      <button type="button" class="btn" data-add="seg">＋ 区間を追加</button>
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label class="field">余裕（分）が空欄の関門・フィニッシュで確保する余裕<input class="inp num" name="margin" inputmode="numeric" value="${esc(S.margin)}"></label>
        <label class="field">これより速いペースにはしない<input class="inp num" name="fastest" inputmode="numeric" value="${esc(S.fastest)}"></label>
      </div>
    </section>
    <section class="card"><h3>関門</h3>
      <div class="gate-row small muted"><span>名前</span><span>km</span><span>閉鎖</span><span>余裕(分)</span><span></span></div>
      <div id="gates" style="display:grid;gap:6px">${S.gates.map(gateRow).join("")}</div>
      <button type="button" class="btn" data-add="gate">＋ 関門を追加</button>
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <label class="field">大会の日<input class="inp" name="raceDate" type="date" value="${esc(S.raceDate)}"></label>
        <label class="field">号砲<input class="inp" name="gun" type="time" value="${esc(S.gun)}"></label>
        <label class="field">フィニッシュ制限<input class="inp" name="finishClose" type="time" value="${esc(S.finishClose)}"></label>
      </div>
      <p class="small muted">閉鎖時刻は第1号砲（9:00）基準の公式の値（案）です。大会前の「競技注意事項」で確認してください。フィニッシュの制限時刻も要確認です。</p>
      <button type="button" class="btn ghost" data-act="resetkobe">神戸マラソンの初期値に戻す</button>
    </section>
    <section class="card"><h3>音声</h3>
      <label class="chk"><input type="checkbox" name="vkm" ${S.voice.km?"checked":""}> 1kmごとに、目標との差を読み上げる</label>
      <label class="chk"><input type="checkbox" name="vpass" ${S.voice.pass?"checked":""}> 関門を通過したら読み上げる</label>
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label class="field">状況の定期読み上げ<select class="inp" name="vevery">${[0,5,10,15,20,30].map(m=>`<option value="${m}" ${Number(S.voice.every)===m?"selected":""}>${m?m+"分ごと":"しない"}</option>`).join("")}</select></label>
        <label class="field">読み上げの速さ<select class="inp" name="vrate">${[[0.9,"ゆっくり"],[1,"ふつう"],[1.2,"速め"]].map(([v,l])=>`<option value="${v}" ${Number(S.voice.rate)===v?"selected":""}>${l}</option>`).join("")}</select></label>
      </div>
    </section>
    <section class="card"><h3>序盤の注意（舞子公園まで）</h3>
      <label class="chk"><input type="checkbox" name="eover" ${S.early.over?"checked":""}> 1kmのラップが目標より速すぎるとき、ペースを落としてよいと伝える（2kmに1回まで）</label>
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <label class="field">何秒以上速いとき<input class="inp num" name="eoversec" inputmode="numeric" value="${esc(S.early.overSec)}"></label>
        <label class="field">何kmまで<input class="inp num" name="euntil" inputmode="decimal" value="${esc(S.early.untilKm)}"></label>
        <label class="field">坂の案内：余裕が何分以上<input class="inp num" name="espare" inputmode="numeric" value="${esc(S.early.hillSpare)}"></label>
      </div>
      <span class="small muted">上り坂（自分で登録）：その200m手前で、次の関門の余裕が目標より上の分数以上多ければ「歩いて登っても大丈夫」と伝えます。標高のデータではコースはほぼ平らで、坂は見つかりませんでした。試走などで気になった場所があれば入れてください。</span>
      <div id="hills" style="display:grid;gap:6px">${S.hills.map(hillRow).join("")}</div>
      <button type="button" class="btn" data-add="hill">＋ 上り坂を追加</button>
    </section>
    <section class="card"><h3>「次の関門」ボタン（アプリ版）</h3>
      <label class="chk"><input type="checkbox" name="knotif" ${S.keys.notif?"checked":""}> 通知・ロック画面にボタンを出す（電源ボタン → 通知のボタン）</label>
      <label class="chk"><input type="checkbox" name="kmedia" ${S.keys.media?"checked":""}> イヤホンの再生ボタンで読み上げる</label>
      <label class="chk"><input type="checkbox" name="kvol" ${S.keys.volume?"checked":""}> 音量ボタンを2回すばやく押して読み上げる（試験的・機種により動かない）</label>
      <p class="small muted">音量ボタンを使う設定にすると、計測中は音量ボタン1回押しでの音量調整が少し遅れて反応します。</p>
    </section>
    <section class="card"><h3>見守り（共有）</h3>
      <label class="field">ウェブアプリのURL（Apps Script）<input class="inp" name="surl" value="${esc(S.sync.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="field">合言葉<input class="inp" name="skey" value="${esc(S.sync.key)}"></label>
      <label class="field">ランナーの名前（見守り画面に表示）<input class="inp" name="sname" value="${esc(S.sync.name)}"></label>
      <label class="field">見守りページのURL（GitHub Pagesで公開した web フォルダ）<input class="inp" name="spage" value="${esc(S.sync.page||"")}" placeholder="https://ユーザー名.github.io/kobe-race/"></label>
      <label class="chk"><input type="checkbox" name="ssim" ${S.sync.simShare?"checked":""}> シミュレーション中も見守りに送る（テスト用）</label>
      <div class="row"><button type="button" class="btn" data-act="synctest">接続テスト</button><button type="button" class="btn" data-act="watchlink">見守り用リンクをコピー</button></div>
    </section>
    <section class="card"><h3>開発用</h3>
      <label class="chk"><input type="checkbox" name="sim" ${S.sim?"checked":""}> シミュレーションのボタンを表示する</label>
    </section>
    <button class="btn primary wide" type="submit">保存</button>
  </form>`;
  document.body.appendChild(bg);
  const f = bg.querySelector("form"), close = ()=>bg.remove();
  bg.addEventListener("click", e=>{
    if(e.target === bg || e.target.closest("[data-close]")) return close();
    const add = e.target.closest("[data-add]")?.dataset.add;
    if(add === "seg") f.querySelector("#segs").insertAdjacentHTML("beforeend", segRow({to:"",pace:""}));
    if(add === "hill") f.querySelector("#hills").insertAdjacentHTML("beforeend", hillRow({km:"",name:""}));
    if(add === "gate") f.querySelector("#gates").insertAdjacentHTML("beforeend", gateRow({name:"",km:"",time:""}));
    const del = e.target.closest("[data-del]"); if(del) del.parentElement.remove();
    const act = e.target.closest("[data-act]")?.dataset.act;
    if(act === "resetkobe"){ f.querySelector("#segs").innerHTML = KOBE_SEGS.map(segRow).join(""); f.querySelector("#gates").innerHTML = KOBE_GATES.map(gateRow).join(""); f.gun.value = "09:00"; f.finishClose.value = "16:00"; f.margin.value = 10; f.fastest.value = "7:00"; }
    if(act === "synctest" || act === "watchlink"){
      const url = f.surl.value.trim(), key = f.skey.value.trim();
      if(!url || !key){ toast("URLと合言葉を入れてください"); return; }
      if(act === "synctest"){ const keep = S.sync; S.sync = {...S.sync, url, key}; Sync.post({ping:1}).then(()=>toast("接続できました")).catch(e=>toast(e.message)).finally(()=>{ S.sync = keep; }); }
      else { const page = f.spage.value.trim() || (/^https?:\/\/(localhost|127\.)/.test(location.href) ? "" : location.href.split("#")[0].split("?")[0]);
        if(!page){ toast("見守りページのURLを入れてください"); return; }
        const link = page.replace(/(index|watch)\.html$/, "").replace(/\/?$/, "/") + "watch.html#u=" + encodeURIComponent(url) + "&k=" + encodeURIComponent(key);
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(()=>toast("コピーしました。見守る人に送ってください")).catch(()=>prompt("このリンクを見守る人に送ってください", link)); }
    }
  });
  f.addEventListener("submit", e=>{
    e.preventDefault();
    S.segs = [...f.querySelectorAll("#segs .seg-row")].map(r=>({to:Number(r.querySelector("[name=sto]").value), pace:normPace(r.querySelector("[name=space]").value)})).filter(s=>s.to>0 && s.pace).sort((a,b)=>a.to-b.to);
    S.gates = [...f.querySelectorAll("#gates .gate-row")].map(r=>({name:r.querySelector("[name=gname]").value.trim()||"関門", km:Number(r.querySelector("[name=gkm]").value), time:r.querySelector("[name=gtime]").value, mg:r.querySelector("[name=gmg]").value === "" ? null : Number(r.querySelector("[name=gmg]").value)})).filter(g=>g.km>0 && g.time).sort((a,b)=>a.km-b.km);
    S.margin = Number(f.margin.value) || 0; S.fastest = normPace(f.fastest.value) || "7:00";
    S.raceDate = f.raceDate.value || S.raceDate; S.gun = f.gun.value || "09:00"; S.finishClose = f.finishClose.value || "16:00";
    S.voice = {km:f.vkm.checked, pass:f.vpass.checked, every:Number(f.vevery.value), rate:Number(f.vrate.value)};
    S.keys = {notif:f.knotif.checked, media:f.kmedia.checked, volume:f.kvol.checked};
    S.sync = {url:f.surl.value.trim(), key:f.skey.value.trim(), name:f.sname.value.trim(), page:f.spage.value.trim(), simShare:f.ssim.checked};
    S.sim = f.sim.checked;
    S.early = {over:f.eover.checked, overSec:Number(f.eoversec.value)||15, untilKm:Number(f.euntil.value)||17.5, hillSpare:Number(f.espare.value)||0};
    S.hills = [...f.querySelectorAll("#hills .seg-row")].map(r=>({km:Number(r.querySelector("[name=hkm]").value), name:r.querySelector("[name=hname]").value.trim()})).filter(h=>h.km>0).sort((a,b)=>a.km-b.km);
    saveS(); close();
    if(R){ R.plan = newPlan(); keysEnable(); }
    render(); toast("保存しました");
  });
}

function openFix(){
  const v = prompt("今の正しい距離（km）を入れてください。km表示の看板を通過したときに使います。", (T ? T.dist : 0).toFixed(2));
  if(v == null) return;
  const km = Number(String(v).replace(/[^\d.]/g, ""));
  if(!(km >= 0 && km <= 43)){ toast("数字で入れてください"); return; }
  T.setDist(km);
  while(R.nextKm <= km) R.nextKm++;
  R.partialKm = R.nextKm;
  st().gates.forEach(g=>{ const key = g.name + "@" + g.km; if(km >= g.km + 0.05 && !R.passed.includes(key)) R.passed.push(key); });
  R.plan = newPlan(); persist(true); toast("距離を直しました"); updateRun();
}
function openStartFix(){
  const cur = E.fmtClockS(R.startClock);
  const v = prompt("スタートラインを越えた時刻を入れてください（例 9:21:30）", cur);
  if(v == null) return;
  const c = E.parseHM(v.trim()); if(c == null){ toast("9:21:30 の形で入れてください"); return; }
  // 経過時間を変えずに時刻だけ直すのではなく、押し忘れを直す：今の時刻はそのまま、スタート時刻を差し替える
  const nowClock = clockNow();
  const shift = (nowClock - c) - elapsed();   // 経過時間が何秒増えるか
  R.startClock = c; R.startT = nowMs() - (nowClock - c)*1000;
  ["lastLapEl","lastFixEl","lastVoice"].forEach(k=>{ if(R[k] != null) R[k] += shift; });
  R.laps.forEach(l=>{ l.t += shift; });
  R.partialKm = R.nextKm;
  R.plan = newPlan(); R.base = E.makePlan(cfg(), 0, c); persist(true); toast("スタート時刻を直しました"); render();
}

/* ---------- イベント ---------- */
document.addEventListener("click", e=>{
  const b = e.target.closest("[data-act],[data-cross]"); if(!b) return;
  if(b.dataset.cross){ S.practiceCross = b.dataset.cross; saveS(); render(); return; }
  const a = b.dataset.act;
  if(a === "start") startRun();
  if(a === "press") onPress("gate", "screen");
  if(a === "status") onPress("status", "screen");
  if(a === "settings") openSettings();
  if(a === "sim" && window.Sim) Sim.open();
  if(a === "voicetest") say("次の関門、御旅公園まで、あと1.2キロ、閉鎖まで15分。必要ペースはキロ11分20秒。目標ペースはキロ8分30秒、このペースなら余裕4分。", true);
  if(a === "fix") openFix();
  if(a === "startfix") openStartFix();
  if(a === "more"){ const m = $("more"); m.hidden = !m.hidden; if(!m.hidden){ lastUi = 0; setTimeout(()=>{ updateMore(); map && map.invalidateSize(); }, 30); } }
  if(a === "mapme"){ mapFollow = true; if(map && R && R.lastPos) map.setView(R.lastPos, Math.max(map.getZoom(), 15)); }
  if(a === "goal"){
    if(goalArmed){ finishRun(true); return; }
    goalArmed = true; b.classList.add("armed"); b.innerHTML = "もう一度押してゴール<small>4秒以内にもう一度</small>";
    setTimeout(()=>{ goalArmed = false; const g = $("goalbtn"); if(g){ g.classList.remove("armed"); g.innerHTML = "ゴール！<small>ゴールしたら押す（2回）</small>"; } }, 4000);
  }
  if(a === "finish"){
    if(finishArmed){ finishRun(); return; }
    finishArmed = true; $("finbtn").textContent = "もう一度で終了";
    setTimeout(()=>{ finishArmed = false; const fb = $("finbtn"); if(fb) fb.textContent = "終了"; }, 4000);
  }
});
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden && R){ keepAwake(); updateRun(); } if(document.hidden) persist(true); });
setInterval(()=>{ if(R && !document.hidden) updateRun(); }, 1000);

window.App = {
  boot(){
    if(location.hash.startsWith("#watch") && !Native){ location.replace("watch.html" + location.hash); return; }   // 以前の見守り用リンク
    // 12時間以上前に始めた計測（練習で「終了」を押し忘れたものなど）は、終わったことにする。本番の日に古い計測が続かないように
    if(R && !R.sim && Date.now() - (R.startWall || 0) > 12*3600000){ R = null; persist(true); setTimeout(()=>toast("前回の計測（終了を押し忘れたもの）を終わりにしました"), 500); }
    if(R){ if(R.sim){ R = null; persist(true); } else { makeTracker(); startGps(); keysEnable(); view = "run"; } }   // シミュレーションは再読み込みで終わり
    render();
    if("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
  },
  get R(){ return R; }, get T(){ return T; }, get S(){ return S; },
  st, cfg, course, startRun, finishRun, onFix, onPress, newPlan, persist, render, updateRun, say, toast, esc, Sync, clockNow,
  // シミュレーション用：位置と時刻を飛ばす
  jump(km, clock){
    if(!R) return;
    T.setDist(km); T.s.last = null; T.s.prog = km; T.s.near = {}; T.s.recent = [];
    T.s.passed = anchors().filter(a=>a.km < km).map(a=>a.name + "@" + a.km);
    R.nextKm = Math.floor(km) + 1; R.partialKm = R.nextKm; R.lastLapEl = elapsed(); R.lastFixEl = null;
    R.passed = st().gates.filter(g=>g.km < km + 0.05).map(g=>g.name + "@" + g.km);
    if(clock != null){   // スタート時刻はそのままで、経過時間を動かす
      let el = clock - R.startClock;
      if(el < 0){ R.startClock = clock; el = 0; }
      R.startT = nowMs() - el*1000;
    }
    R.lastLapEl = elapsed(); R.lastVoice = elapsed();
    R.plan = newPlan(); persist(true); updateRun();
  },
};
