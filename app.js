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
const REC_KEY = "kobe-records-v1";   // 記録：本番・練習の結果。アプリの中からは消せない（上書きもしない）
const PREV_KEY = "kobe-prev-run-v1"; // 直前に終了した計測（間違えて終了したときに続けられるように）
function recordOf(goal){
  const el = elapsed(), d = T ? Math.min(T.dist, FIN_KM) : 0;
  return {id:R.startWall, at:Date.now(), mode:R.raceDay ? "本番" : "練習", goal:!!goal, date:todayStr(),
    start:E.fmtClockS(R.startClock), finish:E.fmtClockS(R.startClock + el), el:Math.round(el), dist:+d.toFixed(3),
    splits:(R.splits || []).map(x=>({...x})), laps:R.laps.map(l=>[l.km, Math.round(l.sec), l.partial ? 1 : 0])};
}
// 同じ計測（id）は新しい内容で置き換える。別の計測は消さずに足していく
function saveRecord(rec){
  const all = load(REC_KEY) || [];
  const i = all.findIndex(r=>r.id === rec.id);
  if(i >= 0) all[i] = rec; else all.push(rec);
  store(REC_KEY, all);
  // 本番の記録は、念のため別の場所にも残す
  if(rec.mode === "本番") store("kobe-race-record-" + rec.date, rec);
  // サーバー（Googleのスプレッドシート）にも送る（届くまで何回か送り直す）
  if(Sync.ok){ (async()=>{ for(let k=0;k<5;k++){ try{ await withTimeout(Sync.post({record:rec}), 25000); Diag.log("記録をサーバーに保存"); return; }catch(e){ await new Promise(ok=>setTimeout(ok, 8000)); } } Diag.log("記録をサーバーに送れませんでした（スマホの中には保存済み）"); })(); }
}

function load(k){ try{ return JSON.parse(localStorage.getItem(k) || "null"); }catch(e){ return null; } }
function store(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
const saveS = () => store(SET_KEY, S);
/* ---------- 診断ログ（不具合のとき、何が起きたかを後から見るため。最新400行） ---------- */
const DIAG_KEY = "kobe-diag-v1";
const Diag = {
  lines: load(DIAG_KEY) || [], savedAt: 0,
  log(t){ const d = new Date(); this.lines.push(`${d.getHours()}:${E.pad(d.getMinutes())}:${E.pad(d.getSeconds())} ${t}`); if(this.lines.length > 400) this.lines.splice(0, this.lines.length - 400); if(Date.now() - this.savedAt > 30000) this.save(); },
  save(){ this.savedAt = Date.now(); store(DIAG_KEY, this.lines); },
};
// 画面の処理が止まっていないか（1秒ごとのタイマーが3秒以上遅れたら記録）
let lagLast = Date.now();
setInterval(()=>{ const now = Date.now(), lag = now - lagLast - 1000; lagLast = now; if(lag > 3000 && !document.hidden) Diag.log(`処理の遅れ ${(lag/1000).toFixed(1)}秒`); }, 1000);
// GPSの受け取りの集計（1分ごと）
const gpsStat = {n:0, used:0, fast:0, acc:0, still:0, near:0, at:Date.now()};
function gpsStatFlush(){ if(Date.now() - gpsStat.at < 60000) return; if(R) Diag.log(`GPS 1分: 受信${gpsStat.n} 使用${gpsStat.used} 速すぎ${gpsStat.fast} 精度不足${gpsStat.acc} 停止${gpsStat.still} 近すぎ${gpsStat.near} 距離${T ? T.dist.toFixed(2) : "-"}km`); Object.assign(gpsStat, {n:0, used:0, fast:0, acc:0, still:0, near:0, at:Date.now()}); }
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
const FIN_KM = 42.195;   // 表示する距離はここで止める
const fmtKm = d => (Number(d) || 0) >= FIN_KM - 1e-6 ? "42.195" : (Number(d) || 0).toFixed(2);   // ゴールの距離は 42.195 と出す
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
  return {dist:T ? Math.min(T.dist, FIN_KM) : 0, clock:clockNow(), elapsed:elapsed(), plan:R && R.plan, base:R && R.base, gates:c.gates, finishKm:c.finishKm, finishClose:c.finishClose};
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

// 自動の読み上げ（1kmごと・関門通過など）：話している途中に次が来たら、待っている古い案内は捨てて最新だけ読む
const AutoVoice = {
  busy:false, pending:null, since:0,
  say(text){
    if(this.busy && Date.now() - this.since > 60000) this.busy = false;   // 終わりの知らせが来なかったときの保険
    if(this.busy){ if(this.pending) Diag.log("古い案内を省略: " + this.pending.slice(0, 20)); this.pending = text; return; }
    this.busy = true; this.since = Date.now();
    say(text, false, ()=>{ this.busy = false; const n = this.pending; this.pending = null; if(n) this.say(n); });
  },
  clear(){ this.pending = null; },
};

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
  else if(S.practiceCross === "now" && !sim) startClock = clockOfDay(t);   // 練習「本番と同じ」：押した時刻のまま
  else startClock = E.parseHM(S.practiceCross) || E.parseHM("09:20"); // 練習・シミュレーション：選んだ時刻とみなす
  const lastEnd = (load(LAST_KEY) || {}).at || 0;
  R = {sim, startT:t, startWall:Date.now(), msgFrom:Math.max(lastEnd, Date.now() - 3*3600000), startClock, tracker:null, laps:[], lastLapEl:0, nextKm:1, passed:[], track:[], lastLive:0, lastVoice:0, savedAt:0, plan:null, base:null, raceDay:!sim && isRaceDay()};
  makeTracker();
  R.plan = newPlan(); R.base = R.plan;
  const g = E.nextGate(st());
  say(`計測を開始しました。スタート${E.spClock(startClock)}。最初の目標ペースは${E.spPace(E.paceAt(R.plan, 0))}。` + (g ? `最初の関門、${g.name}は${E.spClock(g.close)}閉鎖です。` : ""), true);
  persist(true);
  Diag.log(`計測開始 ${sim ? "シミュレーション" : R.raceDay ? "本番" : "練習"} スタート${E.fmtClockS(startClock)}`);
  if(!sim || Native) startGps();   // アプリ版はシミュレーションでもGPSを動かす（本番と同じく、画面OFFでも止まらない状態にする）
  keysEnable(); keepAwake();
  view = "run"; render();
  Live.push();
}
function finishRun(goal){
  if(goal && T && T.dist < FIN_KM) T.setDist(FIN_KM);   // ゴールを押したら、距離は42.195km
  const el = elapsed(), d = T ? Math.min(T.dist, FIN_KM) : 0;
  if(goal) say(`完走おめでとうございます！記録は${E.spSec(el)}です。お疲れさまでした。`, true);
  else say(`お疲れさまでした。${E.spDist(d)}、${E.spSec(el)}。`, true);
  if(R) R.goal = !!goal;
  Live.push(true);
  store(LAST_KEY, {at:Date.now(), goal:!!goal, sim:!!(R && R.sim), dist:+d.toFixed(3), el:Math.round(el), id:R ? R.startWall : null});
  if(R && R.sim && window.Sim) Sim.stop();
  stopGps(); keysDisable();
  try{ wakeLock && wakeLock.release(); }catch(e){}
  if(R && !R.sim){
    saveRecord(recordOf(goal));
    R.tracker = T ? T.export() : null; R.finishedAt = Date.now();
    store(PREV_KEY, R);   // 間違えて終了したときに続けられるように
  }
  Diag.log(goal ? "ゴール" : "終了"); Diag.save();
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
  gpsStat.n++; if(T.s.rej) gpsStat[T.s.rej]++; else if(accepted) gpsStat.used++;
  evs.forEach(e=>Diag.log(`距離の補正 ${e.type}${e.name ? " " + e.name : ""} ${e.delta != null ? (e.delta >= 0 ? "+" : "") + (e.delta*1000).toFixed(0) + "m" : ""}`));
  gpsStatFlush();
  const d = Math.min(T.dist, FIN_KM);
  const jumped = evs.some(e=>e.type !== "anchor" || Math.abs(e.delta) > 0.05) || (accepted && R.lastFixEl != null && el - R.lastFixEl > 30);
  // 関門地点で距離を補正した・電波が途切れたkmのラップは、補正の分だけ速く／遅く見えるので比べない
  if(evs.some(e=>e.type !== "anchor" || Math.abs(e.delta) > 0.02) || (accepted && R.lastFixEl != null && el - R.lastFixEl > 30)) R.corrInLap = true;
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
    kmLap = {km:k, sec:tc - R.lastLapEl, target, t:tc, partial:k === R.partialKm || !!R.corrInLap};
    R.laps.push(kmLap); R.lastLapEl = tc; R.nextKm++;
    R.corrInLap = false;
  }
  // 1回の位置で2km以上進んだ・電波切れや補正のあとのラップは、正確でないのでラップの比較を読まない
  if(R.laps.length - lapsBefore > 1 || (kmLap && jumped)) R.laps.slice(lapsBefore).forEach(l=>{ l.partial = true; });
  // 関門の通過
  const passedNow = [];
  st().gates.forEach(g=>{ const key = g.name + "@" + g.km; if(d >= g.km + 0.05 && !R.passed.includes(key)){ R.passed.push(key); passedNow.push(g); (R.splits = R.splits || []).push({name:g.name, km:g.km, el:Math.round(el), clock:E.fmtClockS(R.startClock + el), close:E.fmtClock(g.close)}); } });
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
  if(c0 && d > 40){
    const fp = c0.pts[c0.pts.length-1], fd = E.hav([f.lat, f.lon], [fp[0], fp[1]]);
    if(fd < 60) R.nearFinish = true;
    if(fd < 25 && T.dist < FIN_KM){ Diag.log(`フィニッシュ地点で距離を合わせる +${Math.round((FIN_KM - T.dist)*1000)}m`); T.setDist(FIN_KM); }   // フィニッシュ地点に着いた：42.195kmにする
  }
  if(!R.goalSaid && (d >= 42.195 || R.nearFinish)){ R.goalSaid = true; R.nearFinish = true; speech.length = 0; speech.push("ゴール予定地点付近です。ゴールしたら、ゴールボタンを押してください。"); }
  const every = Number(S.voice.every) || 0;
  if(!speech.length && every && el - R.lastVoice >= every*60) speech.push(statusText());
  if(speech.length){ R.lastVoice = el; const txt = speech.join(""); Diag.log("読み上げ: " + txt.slice(0, 40)); AutoVoice.say(txt); }
  if(accepted){ R.lastFixEl = el; R.lastFixAt = Date.now(); }
  if(nowMs() - R.lastLive > 30000) Live.push();
  persist();
  updateRun();
}

/* ---------- ボタン ---------- */
function onPress(kind, source){
  if(!R){ say("計測していません。", true); return; }
  const t0 = performance.now();
  R.plan = newPlan();
  AutoVoice.clear();   // ボタンの読み上げを優先（待っている自動の案内は捨てる）
  const text = kind === "status" ? statusText() : E.gateButtonText(st());
  say(text, true);
  const bb = document.querySelector(".bigbtn"); if(bb){ bb.classList.add("pressed"); setTimeout(()=>bb.classList.remove("pressed"), 600); }
  Diag.log(`ボタン(${source || "画面"}) 計算${Math.round(performance.now() - t0)}ms`);
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
   共有（応援）：30秒ごとに状況を送り、メッセージを受け取る
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
      // アプリの状態（応援側で「動いているか」を見るため）
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
      // 前の計測（テストなど）の残りのメッセージは読まずに「届いた」にする。スタート前3時間以内に送られた応援は読む
      if(fresh.length){ this.ack(fresh.map(m=>m.id)); Sync.post({ack:fresh.map(m=>m.id)}).catch(()=>{}); fresh.filter(m=>!(m.at < (R.msgFrom || (R.startWall || 0) - 60000))).forEach(m=>this.queue.push(m)); this.drain(); }
      setNet("");
      if(this.failN) Diag.log(`送信が回復（${this.failN}回失敗のあと）`); this.failN = 0;
    }catch(e){ setNet("共有：通信できません"); this.failN = (this.failN || 0) + 1; if(this.failN <= 3 || this.failN % 10 === 0) Diag.log(`送信失敗${this.failN}回目: ${e && e.message || e}`); }
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
// 生存の合図：GPSが取れないときも、30秒ごとに応援画面へ送る（画面OFFでも動く）
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
  const nowMode = S.practiceCross === "now";
  const cross = nowMode ? clockOfDay(Date.now()) : (E.parseHM(S.practiceCross) || E.parseHM("09:20"));
  const plan = E.makePlan(cfg(), 0, race ? Math.max(E.parseHM(S.gun), clockOfDay(Date.now())) : cross);
  const choices = ["09:05","09:10","09:15","09:20","09:25","09:30"];
  app.innerHTML = `<div class="wrap">
    <div class="hdr"><div class="brand">KOBE <span>42.195</span></div><span class="chip">${race ? "本番当日" : "練習モード"}</span></div>
    ${race ? `<div class="card"><b>スタートラインを越えたら押してください</b><p class="small muted">押した時刻（今の時計）で関門までの計算をします。号砲は${esc(S.gun)}。</p></div>`
      : `<div class="card"><b>練習：スタートを押した時刻を、何時とみなしますか？</b>
        <div class="picker">${choices.map(c=>`<button data-cross="${c}" aria-pressed="${!nowMode && E.parseHM(c)===cross}">${c.replace(/^0/,"")}</button>`).join("")}<button data-cross="now" aria-pressed="${nowMode}" style="grid-column:1/-1">本番と同じ（押した時刻のまま）</button></div>
        <p class="small muted">本番（${esc(S.raceDate)}）は、押した時刻そのままで計算します。「本番と同じ」を選ぶと、練習でも本番とまったく同じ計算になります（朝9時ごろに試すと、関門の時刻も本番どおりになります）。</p></div>`}
    ${prevRunCard()}
    ${lastResult()}
    <button class="btn go wide startbtn" data-act="start">スタート</button>
    <div class="card"><div class="spread"><b>${race ? "今スタートした場合" : E.fmtClock(cross) + "スタートの場合"}の計画</b><span class="small muted">関門ごとの余裕を確保するよう自動補正</span></div>
      ${planTable(plan)}
      <p class="small muted">余裕の目標（${esc(S.gates.slice(0,3).map(g=>(g.mg ?? S.margin)+"分").join("・"))}、以降${esc(S.margin)}分）を切る関門は赤。目標ペースは、ペース表の配分を基本に、間に合わない関門の手前だけ速くしています（最速 ${esc(S.fastest)}/km まで）。</p></div>
    <div class="row">
      <button class="btn" data-act="settings">設定</button>
      ${window.Sim && S.sim ? `<button class="btn" data-act="sim" style="border-color:var(--gold);color:var(--gold)">シミュレーション</button>` : ""}
      <button class="btn ghost" data-act="voicetest">音声テスト</button>
      <button class="btn" data-act="records">記録</button>
    </div>
    ${Native ? "" : `<p class="small muted">ブラウザで開いています。画面を消すと計測が止まるので、レースではAndroidアプリ版を使ってください。</p>`}
  </div>`;
}

function prevRunCard(){
  const p = load(PREV_KEY); if(!p || !p.finishedAt || Date.now() - p.finishedAt > 2*3600000 || p.goal) return "";
  return `<div class="card" style="border-color:var(--gold)"><b>間違えて終了しましたか？</b><p class="small muted">${new Date(p.finishedAt).getHours()}:${E.pad(new Date(p.finishedAt).getMinutes())}に終了した計測を、そのまま続けられます（終了してから2時間以内）。</p><button class="btn" data-act="resume">終了した計測を続ける</button></div>`;
}
function resumeRun(){
  const p = load(PREV_KEY); if(!p) return;
  if(!confirm("終了した計測を続けますか？（スタートからの時間はそのまま続きます）")) return;
  R = p; delete R.finishedAt; R.goal = false; store(PREV_KEY, null);
  makeTracker(); persist(true); startGps(); keysEnable(); view = "run"; render();
  Diag.log("終了した計測を再開"); say("計測を続けます。", true); Live.push();
}
function openRecords(){
  const all = (load(REC_KEY) || []).slice().reverse();
  const bg = document.createElement("div"); bg.className = "sheet-bg";
  const one = r => `<section class="card"><div class="spread"><b>${esc(r.date)} ${esc(r.mode)}${r.goal ? " 🏁完走" : ""}</b><span class="num">${E.fmtDur(r.el)}</span></div>
    <div class="small">スタート ${esc(r.start)}・${r.goal ? "ゴール" : "終了"} ${esc(r.finish)}・${fmtKm(r.dist)}km${r.note ? "・" + esc(r.note) : ""}</div>
    ${r.splits && r.splits.length ? `<table class="laps"><tr><th>関門</th><th>通過</th><th>閉鎖</th><th>経過</th></tr>${r.splits.map(x=>`<tr><td style="text-align:left">${esc(x.name)}</td><td class="num">${esc(x.clock)}</td><td class="num">${esc(x.close)}</td><td class="num">${E.fmtDur(x.el)}</td></tr>`).join("")}</table>` : ""}
    <details><summary class="small">1kmごとのラップ</summary><div class="small num" style="columns:3">${(r.laps||[]).map(l=>`${l[0]}km ${E.fmtPace(l[1])}${l[2] ? "*" : ""}`).join("<br>")}</div></details></section>`;
  bg.innerHTML = `<div class="sheet"><div class="spread"><h2>記録</h2><button type="button" class="btn ghost" data-close>閉じる</button></div>
    <p class="small muted">練習・本番で「終了」「ゴール」を押した記録です。アプリの中からは消えません。応援画面を使っているときは、Googleのスプレッドシート「KOBEレースナビ見守りデータ」の「記録」シートにも残ります。</p>
    ${all.length ? all.map(one).join("") : `<p class="muted">まだ記録はありません（シミュレーションは記録に残りません）</p>`}
    ${all.length ? `<button type="button" class="btn" data-copyrec>記録を文字でコピー</button>` : ""}</div>`;
  document.body.appendChild(bg);
  bg.addEventListener("click", e=>{
    if(e.target === bg || e.target.closest("[data-close]")) return bg.remove();
    if(e.target.closest("[data-copyrec]")){
      const txt = all.map(r=>[`${r.date} ${r.mode}${r.goal ? " 完走" : ""} 記録${E.fmtDur(r.el)} スタート${r.start} ${r.goal ? "ゴール" : "終了"}${r.finish} ${fmtKm(r.dist)}km`].concat((r.splits||[]).map(x=>`  ${x.name}(${x.km}km) ${x.clock}通過 閉鎖${x.close}`)).join("\n")).join("\n\n");
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(()=>toast("コピーしました")).catch(()=>prompt("コピーしてください", txt));
    }
  });
}
function lastResult(){
  const r = load(LAST_KEY); if(!r || Date.now() - r.at > 3*86400000) return "";
  const t = new Date(r.at);
  return `<div class="card"><b>${r.goal ? "🏁 完走" : "前回の計測"}${r.sim ? "（シミュレーション）" : ""}</b><div class="small">${t.getMonth()+1}/${t.getDate()} ${t.getHours()}:${E.pad(t.getMinutes())}に終了・${fmtKm(r.dist)}km・記録 <b class="num">${E.fmtDur(r.el)}</b></div></div>`;
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
  $("dist").textContent = fmtKm(d);
  $("el").textContent = E.fmtDur(s.elapsed);
  $("clock").textContent = E.fmtClockS(s.clock);
  if(!R.sim){ const rj = T && T.s.rej; $("gps").textContent = gpsAcc == null ? "GPS待機中…" : `GPS ±${Math.round(gpsAcc)}m` + (rj === "fast" ? "・速すぎる動きは距離に入れていません" : rj === "acc" ? "・精度が悪いので待っています" : "") + (T && T.s.offCourse ? "・コース外" : ""); }
  const g = E.nextGate(s);
  if(g){
    const left = g.close - s.clock, rem = g.km - d;
    const req = left > 0 ? (left - Math.min(120, left*0.08))/(rem*1.01+0.05) : null;
    const eta = R.plan ? s.clock + E.timeBetween(R.plan, d, g.km) : null, m = eta!=null ? g.close - eta : null;
    $("gate").innerHTML = `<div class="spread"><span class="gname">次の関門：${esc(g.name)}</span><span class="small muted num">${g.km.toFixed(1)}km・${E.fmtClock(g.close)}閉鎖</span></div>
      <div class="g3"><div><span>あと${rem<1 ? "" : "（km）"}</span><b>${rem<1 ? Math.max(0, Math.round(rem*1000))+"<small>m</small>" : rem.toFixed(2)}</b></div>
      <div><span>閉鎖まで</span><b class="${left<600?"bad":""} ${left>=3600?"long":""}">${left>0 ? E.fmtDur(left) : "閉鎖"}</b></div>
      <div><span>必要ペース</span>${!req ? "<b>—</b>" : `<b class="${req >= 3600 ? "long" : ""}">${req >= 3600 ? "60:00+" : E.fmtPace(req)}</b>${req >= 720 ? `<em class="okw">歩いてOK</em>` : ""}`}</div></div>
      <div class="marg">目標ペースなら 余裕 <b class="${m!=null && m<(g.margin ?? 600) ? "bad" : "good"}">${m==null ? "—" : m>=0 ? Math.floor(m/60)+"分" : "なし"}</b><span class="muted">（目標 ${Math.round((g.margin ?? 600)/60)}分以上）</span></div>`;
  } else {
    const rem = s.finishKm - d;
    const fl = s.finishClose - s.clock;
    $("gate").innerHTML = `<div class="spread"><span class="gname">${R.nearFinish || rem <= 0 ? "ゴール予定地点付近" : "フィニッシュまで"}</span><span class="small muted">制限 ${esc(S.finishClose)}</span></div><div class="g3 two"><div><span>あと${rem < 1 ? "" : "（km）"}</span><b>${rem <= 0 ? "0<small>m</small>" : rem < 1 ? Math.round(rem*1000)+"<small>m</small>" : rem.toFixed(2)}</b></div><div><span>制限まで</span><b class="${fl >= 3600 ? "long" : ""}">${fl > 0 ? E.fmtDur(fl) : "—"}</b></div></div>`;
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
    <section class="card"><h3>応援（共有）</h3>
      <label class="field">ウェブアプリのURL（Apps Script）<input class="inp" name="surl" value="${esc(S.sync.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="field">合言葉<input class="inp" name="skey" value="${esc(S.sync.key)}"></label>
      <label class="field">ランナーの名前（応援画面に表示）<input class="inp" name="sname" value="${esc(S.sync.name)}"></label>
      <label class="field">応援ページのURL（GitHub Pagesで公開した web フォルダ）<input class="inp" name="spage" value="${esc(S.sync.page||"")}" placeholder="https://ユーザー名.github.io/kobe-race/"></label>
      <label class="chk"><input type="checkbox" name="ssim" ${S.sync.simShare?"checked":""}> シミュレーション中も応援画面に送る（テスト用）</label>
      <div class="row"><button type="button" class="btn" data-act="synctest">接続テスト</button><button type="button" class="btn" data-act="watchlink">応援用リンクをコピー</button></div>
    </section>
    <section class="card"><h3>不具合の報告用</h3>
      <p class="small muted">GPSの受け取り、距離の補正、送信の失敗、読み上げ、処理の遅れを記録しています。うまく動かなかったときに、これをコピーして送ってください。</p>
      <div class="row"><button type="button" class="btn" data-act="diag">診断ログを見る</button></div>
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
    if(act === "diag"){ openDiag(); return; }
    if(act === "resetkobe"){ f.querySelector("#segs").innerHTML = KOBE_SEGS.map(segRow).join(""); f.querySelector("#gates").innerHTML = KOBE_GATES.map(gateRow).join(""); f.gun.value = "09:00"; f.finishClose.value = "16:00"; f.margin.value = 10; f.fastest.value = "7:00"; }
    if(act === "synctest" || act === "watchlink"){
      const url = f.surl.value.trim(), key = f.skey.value.trim();
      if(!url || !key){ toast("URLと合言葉を入れてください"); return; }
      if(act === "synctest"){ const keep = S.sync; S.sync = {...S.sync, url, key}; Sync.post({ping:1}).then(()=>toast("接続できました")).catch(e=>toast(e.message)).finally(()=>{ S.sync = keep; }); }
      else { const page = f.spage.value.trim() || (/^https?:\/\/(localhost|127\.)/.test(location.href) ? "" : location.href.split("#")[0].split("?")[0]);
        if(!page){ toast("応援ページのURLを入れてください"); return; }
        const link = page.replace(/(index|watch)\.html$/, "").replace(/\/?$/, "/") + "watch.html#u=" + encodeURIComponent(url) + "&k=" + encodeURIComponent(key);
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(()=>toast("コピーしました。応援する人に送ってください")).catch(()=>prompt("このリンクを応援する人に送ってください", link)); }
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

function openDiag(){
  Diag.save();
  const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.style.zIndex = 60;
  const text = Diag.lines.slice().reverse().join("\n") || "（まだ記録がありません）";
  bg.innerHTML = `<div class="sheet"><div class="spread"><h2>診断ログ</h2><button type="button" class="btn ghost" data-close>閉じる</button></div>
    <p class="small muted">新しい順。コピーしてLINEなどで送ってください。</p>
    <textarea class="inp" readonly rows="16" style="font-size:12px;font-family:monospace">${esc(text)}</textarea>
    <div class="row"><button type="button" class="btn primary" data-copy>コピー</button><button type="button" class="btn ghost" data-clear>消す</button></div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener("click", e=>{
    if(e.target === bg || e.target.closest("[data-close]")) return bg.remove();
    if(e.target.closest("[data-copy]")){ const ta = bg.querySelector("textarea"); (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).then(()=>toast("コピーしました")).catch(()=>{ ta.select(); try{ document.execCommand("copy"); toast("コピーしました"); }catch(_){ toast("長押しで選んでコピーしてください"); } }); }
    if(e.target.closest("[data-clear]")){ if(confirm("診断ログを消しますか？")){ Diag.lines = []; Diag.save(); bg.remove(); } }
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
  (R.splits || []).forEach(x=>{ x.el = Math.round(x.el + shift); });   // 通過した時刻（clock）はそのまま、経過時間だけ変わる
  R.partialKm = R.nextKm;
  R.plan = newPlan(); R.base = E.makePlan(cfg(), 0, c); persist(true); toast("スタート時刻を直しました"); render();
}

/* ---------- イベント ---------- */
document.addEventListener("click", e=>{
  const b = e.target.closest("[data-act],[data-cross]"); if(!b) return;
  if(b.dataset.cross){ S.practiceCross = b.dataset.cross; saveS(); render(); return; }
  const a = b.dataset.act;
  if(a === "start") startRun();
  if(a === "resume") resumeRun();
  if(a === "records") openRecords();
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
document.addEventListener("visibilitychange", ()=>{ if(R) Diag.log(document.hidden ? "画面OFF・裏へ" : "画面ON"); if(document.hidden) Diag.save(); if(!document.hidden && R){ keepAwake(); updateRun(); } if(document.hidden) persist(true); });
setInterval(()=>{ if(R && !document.hidden) updateRun(); }, 1000);

window.App = {
  boot(){
    if(location.hash.startsWith("#watch") && !Native){ location.replace("watch.html" + location.hash); return; }   // 以前の応援用リンク
    // 12時間以上前に始めた計測（練習で「終了」を押し忘れたものなど）は、終わったことにする。本番の日に古い計測が続かないように
    if(R && !R.sim && Date.now() - (R.startWall || 0) > 12*3600000){ try{ makeTracker(); const el = (R.lastFixEl || 0); saveRecord({id:R.startWall, at:Date.now(), mode:R.raceDay ? "本番" : "練習", goal:false, date:(d=>d.getFullYear()+"-"+E.pad(d.getMonth()+1)+"-"+E.pad(d.getDate()))(new Date(R.startWall)), start:E.fmtClockS(R.startClock), finish:E.fmtClockS(R.startClock + el), el:Math.round(el), dist:+(T ? Math.min(T.dist, FIN_KM) : 0).toFixed(3), splits:R.splits || [], laps:R.laps.map(l=>[l.km, Math.round(l.sec), l.partial ? 1 : 0]), note:"終了の押し忘れ"}); }catch(e){} T = null; R = null; persist(true); setTimeout(()=>toast("前回の計測（終了を押し忘れたもの）を終わりにしました"), 500); }
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
