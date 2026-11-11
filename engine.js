"use strict";
/* =========================================================
   計測エンジン（画面に依存しない計算だけ。node でもテストできる）
   - 距離：GPSの積算 ＋ コース線への当てはめ ＋ 関門地点での補正
   - ペース計画：基本の配分を、関門の閉鎖◯分前に着くよう自動で補正
   - 読み上げの文章
   時刻は「その日の0時からの秒」（clock）で扱う。
   ========================================================= */
(function(root){
const E = {};

/* ---------- 数値・書式 ---------- */
const pad = n => (n < 10 ? "0" : "") + n;
E.pad = pad;
E.hav = function(a, b){
  const R = 6371000, r = Math.PI/180, dLa = (b[0]-a[0])*r, dLo = (b[1]-a[1])*r;
  const s = Math.sin(dLa/2)**2 + Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
};
E.parseHM = s => { const m = String(s||"").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); return m ? (+m[1])*3600 + (+m[2])*60 + (+(m[3]||0)) : null; };
E.parsePace = s => { const m = String(s||"").trim().match(/^(\d{1,2})[:分]?(\d{2})秒?$/); return m ? (+m[1])*60 + (+m[2]) : null; };
E.fmtPace = sec => { if(sec==null || !isFinite(sec)) return "—"; sec = Math.round(sec); return Math.floor(sec/60) + ":" + pad(sec%60); };
E.fmtDur = sec => { if(sec==null || !isFinite(sec)) return "—"; const neg = sec < 0; sec = Math.round(Math.abs(sec)); const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60; return (neg?"-":"") + (h ? h+":"+pad(m)+":"+pad(s) : m+":"+pad(s)); };
E.fmtClock = sec => { if(sec==null || !isFinite(sec)) return "—"; sec = Math.floor(sec); return Math.floor(sec/3600) + ":" + pad(Math.floor(sec%3600/60)); };
E.fmtClockS = sec => { sec = Math.floor(sec); return E.fmtClock(sec) + ":" + pad(sec%60); };

/* ---------- 読み上げ用の言い方 ---------- */
// 距離：1km以上は0.1km単位（切り捨て）、1km未満は10m単位
E.spDist = km => {
  km = Math.max(0, km);
  if(km < 1) return Math.max(10, Math.floor(km*100)*10) + "メートル";
  return (Math.floor(km*10)/10).toFixed(1).replace(/\.0$/, "") + "キロ";
};
// 時間（ふつう）：分未満は切り捨て。1分未満は秒
E.spMin = sec => {
  sec = Math.floor(Math.abs(sec));
  if(sec < 60) return sec + "秒";
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60);
  return (h ? h + "時間" : "") + (m ? m + "分" : "");
};
// 閉鎖までの時間：5分以上は分（切り捨て）、5分未満は10秒単位（切り捨て）
E.spLeft = sec => {
  sec = Math.max(0, Math.floor(sec));
  if(sec >= 300) return E.spMin(sec);
  const t = Math.floor(sec/10)*10, m = Math.floor(t/60), s = t%60;
  return (m ? m + "分" : "") + (s || !m ? s + "秒" : "");
};
// 差（秒単位）
E.spSec = sec => {
  sec = Math.round(Math.abs(sec));
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60;
  return (h ? h+"時間" : "") + (m ? m+"分" : "") + (s || (!h && !m) ? s+"秒" : "");
};
// ペース：floor10 なら10秒単位で切り捨て（速い側にそろえる）
E.spPace = (sec, floor10) => {
  if(sec==null || !isFinite(sec) || sec <= 0) return "不明";
  sec = floor10 ? Math.floor(sec/10)*10 : Math.round(sec);
  const m = Math.floor(sec/60), s = sec%60;
  return "キロ" + m + "分" + (s ? s + "秒" : "");
};
E.spClock = sec => { sec = Math.floor(sec); const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60); return h + "時" + (m ? m + "分" : ""); };

/* =========================================================
   ペース計画
   cfg = {segs:[{to:km, pace:秒}], gates:[{name,km,close:clock}], finishKm, finishClose,
          marginSec（閉鎖の何秒前に着くか。関門ごとに g.margin があればそちらを優先）, fastestSec（これより速いペースにはしない）}
   ========================================================= */
function basePace(cfg, km){
  const segs = cfg.segs.slice().sort((a,b)=>a.to-b.to);
  for(const s of segs) if(km <= s.to + 1e-9) return s.pace;
  return segs.length ? segs[segs.length-1].pace : 480;
}
E.basePace = basePace;

E.makePlan = function(cfg, fromKm, fromClock){
  const fin = cfg.finishKm || 42.195;
  fromKm = Math.max(0, Math.min(fin, fromKm));
  const cuts = new Set([fromKm, fin]);
  cfg.segs.forEach(s=>{ if(s.to > fromKm && s.to < fin) cuts.add(s.to); });
  cfg.gates.forEach(g=>{ if(g.km > fromKm && g.km < fin) cuts.add(g.km); });
  const ks = [...cuts].sort((a,b)=>a-b);
  const iv = [];
  for(let i=0;i<ks.length-1;i++){ const a = ks[i], b = ks[i+1]; const p = basePace(cfg, (a+b)/2); iv.push({a, b, base:p, pace:p}); }
  const fastest = cfg.fastestSec || 0, margin = cfg.marginSec || 0;
  const targets = cfg.gates.filter(g=>g.km > fromKm + 1e-9 && g.close!=null).map(g=>({km:g.km, limit:g.close - (g.margin != null ? g.margin : margin)}));
  if(cfg.finishClose!=null) targets.push({km:fin, limit:cfg.finishClose - margin});
  targets.sort((a,b)=>a.km-b.km);
  const tUpTo = idx => { let t = fromClock; for(let i=0;i<idx;i++) t += (iv[i].b-iv[i].a)*iv[i].pace; return t; };
  const regionTime = (lo, hi, f) => { let t = 0; for(let i=lo;i<=hi;i++){ const v = iv[i]; t += (v.b-v.a)*Math.max(v.pace*f, Math.min(fastest, v.pace)); } return t; };
  const applyF = (lo, hi, f) => { for(let i=lo;i<=hi;i++){ const v = iv[i]; v.pace = Math.max(v.pace*f, Math.min(fastest, v.pace)); } };
  const solve = (lo, hi, need) => {
    if(regionTime(lo, hi, 0) >= need){ applyF(lo, hi, 0); return false; }   // 最速にしても足りない
    let a = 0, b = 1;
    for(let k=0;k<50;k++){ const m = (a+b)/2; if(regionTime(lo, hi, m) > need) b = m; else a = m; }
    applyF(lo, hi, a); return true;
  };
  let lock = 0;
  for(const T of targets){
    let end = -1; for(let i=0;i<iv.length;i++) if(iv[i].b <= T.km + 1e-9) end = i;
    if(end < 0) continue;
    if(tUpTo(end+1) <= T.limit + 0.5) continue;
    if(lock > end) lock = 0;
    const ok = solve(lock, end, T.limit - tUpTo(lock));
    if(!ok && lock > 0) solve(0, end, T.limit - fromClock);   // 区間だけで足りなければ、今いる地点からまとめて上げる
    lock = end + 1;
  }
  const plan = {fromKm, fromClock, iv, finishKm:fin};
  plan.gates = cfg.gates.filter(g=>g.km > fromKm).map(g=>{ const eta = E.etaAt(plan, g.km); return {name:g.name, km:g.km, close:g.close, eta, margin:g.close!=null ? g.close-eta : null, need:g.margin != null ? g.margin : margin}; });
  plan.finishEta = E.etaAt(plan, fin);
  plan.finishMargin = cfg.finishClose!=null ? cfg.finishClose - plan.finishEta : null;
  return plan;
};
E.paceAt = function(plan, km){
  if(!plan || !plan.iv.length) return null;
  for(const v of plan.iv) if(km < v.b - 1e-9) return v.pace;
  return plan.iv[plan.iv.length-1].pace;
};
E.timeBetween = function(plan, a, b){
  let t = 0;
  if(a < plan.fromKm && plan.iv.length) t += (Math.min(b, plan.fromKm) - a) * plan.iv[0].pace;   // 計画を作った地点より手前の分
  for(const v of plan.iv){ const lo = Math.max(a, v.a), hi = Math.min(b, v.b); if(hi > lo) t += (hi-lo)*v.pace; }
  if(b > plan.finishKm) t += (b - Math.max(a, plan.finishKm)) * plan.iv[plan.iv.length-1].pace;
  return t;
};
E.etaAt = (plan, km) => plan.fromClock + E.timeBetween(plan, plan.fromKm, km);

/* =========================================================
   距離の計測
   course = {pts:[[lat,lon,km]], total}（km は公式の距離に補正済み）
   anchors = [{name, km, lat, lon}]：その地点を通ったら距離を km に合わせ直す
   ========================================================= */
function idxAt(pts, km){ let lo = 0, hi = pts.length-1; while(lo < hi){ const mid = (lo+hi) >> 1; if(pts[mid][2] < km) lo = mid+1; else hi = mid; } return lo; }
E.pointAtKm = function(course, km){
  const pts = course.pts, i = idxAt(pts, km);
  if(i === 0) return [pts[0][0], pts[0][1]];
  const a = pts[i-1], b = pts[i], t = Math.max(0, Math.min(1, (km-a[2])/((b[2]-a[2])||1)));
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
};
// prefer：今いるはずの km。行きと帰りで同じ道を通る区間では、近い方を選ぶ（1kmずれると40m離れているのと同じ扱い）
E.project = function(course, p, fromKm, toKm, prefer, head){
  const pts = course.pts, k = Math.cos(p[0]*Math.PI/180)*111320;
  let best = null;
  const i0 = Math.max(0, idxAt(pts, fromKm)-1), i1 = Math.min(pts.length-1, idxAt(pts, toKm)+1);
  for(let i=i0;i<i1;i++){
    const a = pts[i], b = pts[i+1];
    const ax = (a[1]-p[1])*k, ay = (a[0]-p[0])*110540, bx = (b[1]-p[1])*k, by = (b[0]-p[0])*110540;
    const dx = bx-ax, dy = by-ay, L = dx*dx+dy*dy;
    if(head && L && (dx*head[0] + dy*head[1]) / Math.sqrt(L) < 0.3) continue;   // 進む向きと合わない区間（折り返しの反対側など）
    const t = L ? Math.max(0, Math.min(1, -(ax*dx+ay*dy)/L)) : 0;
    const off = Math.hypot(ax+t*dx, ay+t*dy), km = a[2]+t*(b[2]-a[2]);
    const score = off + (prefer == null ? 0 : 40*Math.abs(km - prefer));
    if(!best || score < best.score) best = {off, km, score};
  }
  return best;
};

E.Tracker = class {
  constructor(course, anchors, opt){
    this.course = course || null;
    this.anchors = (anchors||[]).map(a=>({...a}));
    // resync：コース線（近似）とGPSが1km以上食い違ったときだけ、コース線に合わせる（近似コースの誤差でGPSを狂わせないため）
    // maxSnap：関門地点での補正は300mまで（それ以上は関門の位置か GPS がおかしいので使わない）
    // over／under：コース線の上の位置と比べて、距離が45m以上進みすぎ・150m以上遅れの状態が8秒続いたら、コース線に合わせ直す
    //   （GPSの速度に偏りがある機種でも、ずれが積み上がらないようにする安全装置）
    this.opt = Object.assign({gpsFactor:0.99, snapR:50, maxSnap:0.3, offCourse:100, resync:1.0, over:0.045, under:0.15, courseBack:0.03}, opt||{});
    this.s = {dist:0, accum:0, baseKm:0, baseAcc:0, prog:null, last:null, passed:[], near:{}, recent:[], fixes:0, offCourse:false};
  }
  export(){ return JSON.parse(JSON.stringify(this.s)); }
  import(s){ if(s) this.s = Object.assign(this.s, s); }
  get dist(){ return this.s.dist; }
  // km 看板などで、今の距離を手で直す
  setDist(km){ const s = this.s; s.baseKm = km; s.baseAcc = s.accum; s.dist = km; if(s.prog!=null) s.prog = km; }
  // GPS 1回分：{lat, lon, acc, t(ms), speed(m/秒・なければ null)}。起きたこと（関門地点での補正など）を返す
  // 距離の積み上げ：GPSの速度（ドップラー）があれば「速度×時間」、なければ位置の差。
  //   位置の差だけだと、GPSの細かいぶれが積み上がって長めに出る（特にゆっくり走る・歩くとき）
  fix(f){
    const s = this.s, o = this.opt, ev = [], p = [f.lat, f.lon];
    s.rej = null;
    if(f.acc != null && f.acc > 60){ s.rej = "acc"; return ev; }
    const sp = f.speed != null && isFinite(f.speed) && f.speed >= 0 && f.speed < 9 ? (f.speed < 0.5 ? 0 : f.speed) : null;
    // 進む向き：20秒以内に12m以上動いた向き（止まっているときは「なし」）
    const hb = s.hb || (s.hb = []);
    hb.push([f.t, f.lat, f.lon]); while(hb.length > 1 && (f.t - hb[0][0] > 20000 || hb.length > 25)) hb.shift();
    let head = null;
    for(let i = hb.length-2; i >= 0; i--){
      if(E.hav([hb[i][1], hb[i][2]], p) >= 12){
        const hx = (p[1]-hb[i][2]) * Math.cos(p[0]*Math.PI/180)*111320, hy = (p[0]-hb[i][1])*110540, n = Math.hypot(hx, hy);
        if(n > 0) head = [hx/n, hy/n];
        break;
      }
    }
    let gap = false;
    if(s.last){
      const d = E.hav(s.last.p, p), dtRaw = (f.t - s.last.t)/1000;
      if(dtRaw <= 0) return ev;
      const dt = Math.max(0.5, dtRaw);
      if(sp != null && s.last.sp != null && dt <= 10){
        s.accum += (sp + s.last.sp)/2 * dt / 1000;                       // 速度×時間
      } else {
        if(dt < 30 && d/dt > 8.5){ s.rej = "fast"; return ev; }        // 時速30km超の飛び
        gap = dt >= 30 || d > 250;
        // 止まっているか：12〜15秒前の位置から、ほとんど動いていなければ止まっているとみなす（ぶれを距離にしない）
        const w = s.win || (s.win = []);
        w.push([f.t, p]); while(w.length > 1 && f.t - w[0][0] > 15000) w.shift();
        const moved = !gap && w.length > 1 && f.t - w[0][0] >= 12000 ? E.hav(w[0][1], p) : Infinity;
        if(moved < Math.max(8, (f.acc || 10)*0.5)){ s.last = {p, t:f.t, sp}; s.rej = "still"; return ev; }   // 歩いても12秒で15m以上は動く
        if(dt < 30 && d < Math.max(20, (f.acc||10)*1.5)){ s.rej = "near"; return ev; }    // 20m以上離れた点どうしで測る（細かいぶれを足さない）
        if(!gap) s.accum += d/1000 * 0.993;   // 位置の差は、ぶれの分だけ長めに出るので少し割り引く（速度が取れない機種だけ）
      }
    }
    s.fixes++;
    let est = s.baseKm + (s.accum - s.baseAcc) * o.gpsFactor;
    // コース線への当てはめ（今いるはずの地点の少し手前〜先だけを探す）
    let proj = null;
    if(this.course){
      const gapSec = gap && s.last ? (f.t - s.last.t)/1000 : 0;
      const prefer = gap ? s.dist + gapSec/480 : est;            // 途切れた後は、キロ8分で進んだと仮定して探す
      const ahead = gap ? Math.min(8, 0.6 + gapSec*0.007) : 0.6;
      const pr = E.project(this.course, p, Math.max(0, Math.min(est, s.dist) - 0.3), Math.max(est, s.dist) + ahead, prefer);
      if(pr && pr.off < o.offCourse){ proj = pr; s.prog = Math.max(s.prog == null ? 0 : s.prog, pr.km); }
      s.offCourse = !pr || pr.off >= o.offCourse;
    }
    if(gap){
      // 電波が途切れた後：コース上の位置があればそれを使う。なければ直線距離で足す
      if(proj){ s.baseKm = Math.max(s.dist, proj.km); s.baseAcc = s.accum; }
      else if(s.last){ s.accum += E.hav(s.last.p, p)/1000; }
      est = s.baseKm + (s.accum - s.baseAcc) * o.gpsFactor;
    } else if(this.course && head && (f.acc == null || f.acc <= 30)){
      // コース線との照合：進む向きが合う区間だけを、広め（手前600m〜先900m）に探す
      const c2 = E.project(this.course, p, Math.max(0, est - 0.6), est + 0.9, est, head);
      if(c2 && c2.off < 50){
        // コースの終点に当てはまっているとき（フィニッシュを過ぎたあと）は「進みすぎ」と見ない（42.195kmから戻さない）
        const atEnd = c2.km >= this.course.pts[this.course.pts.length-1][2] - 0.0005;
        const diff = est - c2.km, sign = diff > o.over && !atEnd ? 1 : diff < -o.under ? -1 : 0;
        if(sign && sign === s.cSign) s.cN++; else { s.cSign = sign; s.cN = sign ? 1 : 0; s.cT = f.t; }
        if(sign && s.cN >= 8 && f.t - s.cT >= 8000){
          const target = Math.max(0, c2.km - o.courseBack);   // 少しだけ手前（安全側）に合わせる
          ev.push({type:"course", km:target, delta:target - est});
          s.baseKm = target; s.baseAcc = s.accum; est = target;
          if(sign > 0) s.dist = Math.min(s.dist, est);         // 進みすぎていたときは、戻す
          s.cSign = 0; s.cN = 0;
        }
      }
    }
    let nd = Math.max(s.dist, est);
    // 関門など、場所がはっきりしている地点の通過で合わせ直す
    for(const a of this.anchors){
      if(s.passed.includes(a.name + "@" + a.km)) continue;
      if(Math.abs(a.km - nd) > 1.5) continue;
      // 関門の地点から50m以内、かつコース線の上でも関門の前後150m以内のときだけ「関門の近く」とみなす
      // （コースが折れ曲がっていて、関門の手前の道が関門の地点の近くを通る場所があるため）
      const onSpot = !proj || Math.abs(proj.km - a.km) < 0.15;
      const d = E.hav(p, [a.lat, a.lon]), n = s.near[a.km];
      if(d < o.snapR && onSpot && (!n || d < n.d)) s.near[a.km] = {d, acc:s.accum};
      const nn = s.near[a.km];
      const leaving = nn && d > nn.d + 20 && (!proj || proj.km >= a.km);
      if(leaving || nd > a.km + 0.4){
        s.passed.push(a.name + "@" + a.km);
        if(nn){
          const corrected = a.km + (s.accum - nn.acc) * o.gpsFactor;
          const delta = corrected - nd;
          if(Math.abs(delta) <= o.maxSnap){ s.baseKm = a.km; s.baseAcc = nn.acc; nd = corrected; ev.push({type:"anchor", name:a.name, km:a.km, delta}); }
        }
      }
    }
    s.dist = nd;
    s.last = {p, t:f.t, sp};
    s.recent.push([f.t, nd]); while(s.recent.length > 2 && f.t - s.recent[0][0] > 90000) s.recent.shift();
    return ev;
  }
  // 直近（約1分半）のペース（秒/km）
  curPace(){ const r = this.s.recent; if(r.length < 2) return null; const a = r[0], b = r[r.length-1]; const dd = b[1]-a[1], dt = (b[0]-a[0])/1000; return dd > 0.03 && dt > 20 ? dt/dd : null; }
};

/* =========================================================
   読み上げの文章
   st = {dist, clock, elapsed, plan, base(スタート時の計画), gates:[{name,km,close}], finishKm, finishClose}
   ========================================================= */
E.nextGate = (st, extra) => st.gates.filter(g=>g.km > st.dist + (extra||0)).sort((a,b)=>a.km-b.km)[0] || null;

// 「次の関門」ボタン
E.gateText = function(st, g){
  g = g || E.nextGate(st);
  if(!g) return E.finishText(st);
  const rem = Math.max(0, g.km - st.dist), left = g.close - st.clock;
  let s = `次の関門、${g.name}まで、あと${E.spDist(rem)}`;
  if(left <= 0) return s + "。";
  s += `、閉鎖まで${E.spLeft(left)}。`;
  const buffer = Math.min(120, left*0.08);                // 時間の余裕：残り時間の8%（最大2分）
  const reqDist = rem*1.01 + 0.05;                        // 距離の余裕：1% ＋ 50m（GPSのずれ）
  const req = (left - buffer) / reqDist;
  if(rem <= 0.5){
    s += req >= 720 ? "歩いても間に合います。" : req >= 480 ? "止まらず走れば間に合います。" : "急いでください。";
    return s;
  }
  s += `必要ペースは${E.spPace(req, true)}。`;
  if(st.plan){
    const tp = E.paceAt(st.plan, st.dist), eta = st.clock + E.timeBetween(st.plan, st.dist, g.km), m = g.close - eta;
    s += `目標ペースは${E.spPace(tp)}` + (m >= 60 ? `、このペースなら余裕${E.spMin(m)}。` : m >= 0 ? "、閉鎖ぎりぎりです。" : "。目標ペースでは間に合いません。必要ペースを目安にしてください。");
  }
  return s;
};
E.gateButtonText = function(st){
  const g = E.nextGate(st);
  // 300m以内に通過したばかりの関門がまだ閉鎖前なら、念のため伝える（GPSの距離が長めに出ている場合の備え）
  const just = st.gates.filter(x=>x.km <= st.dist && x.km > st.dist - 0.3 && x.close > st.clock).pop();
  const pre = just ? `${just.name}の関門は通過したと判断しています。まだ通過していなければ、閉鎖まで${E.spLeft(just.close - st.clock)}です。` : "";
  if(!g) return pre + E.finishText(st);
  let s = pre + E.gateText(st, g);
  // 関門の目の前で押したとき（GPSの遅れで通過済みかもしれない）は、その次の関門も読む
  if(g.km - st.dist < 0.1){ const g2 = E.nextGate(st, g.km - st.dist + 0.001); if(g2) s += "その次、" + E.gateText(st, g2).replace(/^次の関門、/, ""); }
  return s;
};
E.finishText = function(st){
  const rem = Math.max(0, st.finishKm - st.dist);
  if(rem < 0.05) return "ゴール予定地点付近です。ゴールしたら、ゴールボタンを押してください。";
  let s = `フィニッシュまで、あと${E.spDist(rem)}。`;
  if(st.finishClose != null){ const left = st.finishClose - st.clock; if(left > 0) s += `制限時間まで${E.spLeft(left)}。`; }
  if(st.plan){ s += `目標ペース${E.spPace(E.paceAt(st.plan, st.dist))}、ゴール予想${E.spClock(st.clock + E.timeBetween(st.plan, st.dist, st.finishKm))}。`; }
  return s;
};
E.diffWords = (d, kind) => Math.abs(d) < 3 ? (kind==="lap" ? "目標どおり" : "予定どおり") : kind==="lap" ? `目標より${E.spSec(d)}${d>0?"遅い":"速い"}` : `予定より${E.spSec(d)}${d>0?"遅れ":"早い"}`;

// 1kmごと
E.kmText = function(st, lap, change){
  let s = lap.partial ? `${lap.km}キロ。` : `${lap.km}キロ。ラップ${E.spPace(lap.sec).replace(/^キロ/, "")}、${E.diffWords(lap.sec - lap.target, "lap")}。`;
  if(st.base) s += E.diffWords(st.clock - E.etaAt(st.base, st.dist), "cum") + "。";
  const g = E.nextGate(st);
  let short = false;   // 目標ペース（計画の最速）でも次の関門に届かない
  if(g && st.plan){
    const rem = g.km - st.dist, left = g.close - st.clock, m = left - E.timeBetween(st.plan, st.dist, g.km);
    s += `次の関門まで${E.spDist(rem)}`;
    if(m >= 60) s += `、余裕${E.spMin(m)}。`;
    else if(m >= 0) s += "、閉鎖ぎりぎりです。";
    else if(left > 0){ short = true; s += `、目標ペースでは間に合いません。必要ペースは${E.spPace((left - Math.min(120, left*0.08)) / (rem*1.01 + 0.05), true)}。`; }   // 必要なペースをそのまま伝える
    else s += "。";
  }
  if(short) return s;
  if(change) s += change;
  else if(st.plan && st.dist < st.finishKm - 0.3) s += `次の1キロは${E.spPace(E.paceAt(st.plan, st.dist + 0.01))}。`;
  return s;
};
// 序盤に速すぎるとき（否定しない言い方で）
E.overText = () => "目標ペースよりも少し速いペースです。少しペースを落としても大丈夫です。後半に温存しましょう。ペースを落とすのがつらい場合は、無理せず楽なペースで走りましょう。";
// 上り坂の手前（時間に余裕があるときだけ）
E.hillText = (meters, name) => `この先${Math.max(50, Math.round(meters/50)*50)}メートルで、${name ? name + "の" : ""}上り坂です。時間に余裕があります。上り坂は無理して走る必要はありません。戦略的に歩いて、登り切ったら走り始めましょう。`;
// 関門を通過したとき
E.passText = function(st, g){
  const lf = g.close - st.clock;
  let s = `${g.name}、通過。` + (lf >= 1 ? `閉鎖の${E.spMin(lf)}前。` : "");   // 閉鎖後の通過（GPSの遅れなど）では時間を言わない
  if(st.base){ s += E.diffWords(st.clock - E.etaAt(st.base, g.km), "cum") + "。"; }
  const n = E.nextGate(st);
  if(n){ s += `次は${n.name}、${E.spDist(n.km - st.dist)}先、${E.spClock(n.close)}閉鎖。`; if(st.plan) s += `目標ペース${E.spPace(E.paceAt(st.plan, st.dist + 0.01))}。`; }
  else s += E.finishText(st);
  return s;
};
// ゴール予想：計画どおり／最近のペースが続いた場合
E.predict = function(st, recentRatio){
  if(!st.plan) return null;
  const rest = E.timeBetween(st.plan, st.dist, st.finishKm);
  return {plan: st.clock + rest, recent: recentRatio ? st.clock + rest*recentRatio : null};
};

if(typeof module !== "undefined" && module.exports) module.exports = E;
root.Engine = E;
})(typeof window !== "undefined" ? window : globalThis);
