"use strict";
/* =========================================================
   シミュレーション（開発・テスト用）
   本物のGPSの代わりに、コース上を走る位置を作って流し込む。
   計算・読み上げ・共有は本番とまったく同じ処理を通る。
   本番前に index.html の sim.js の行を消せば、まるごとなくなる。
   ========================================================= */
window.Sim = (()=>{
  const E = window.Engine;
  const s = {on:false, t:0, km:0, speed:30, factor:1.0, noise:5, jitterUntil:0, dropUntil:0, timer:null, lastEmit:0};

  function now(){ return s.on ? s.t : Date.now(); }
  function gauss(){ return (Math.random()+Math.random()+Math.random()-1.5)/1.5; }

  function emit(){
    const c = App.course(); if(!c) return;
    if(s.t < s.dropUntil) return;                       // 電波が途切れている
    const p = E.pointAtKm(c, Math.min(c.total, s.km));
    const n = s.t < s.jitterUntil ? 45 : s.noise;       // GPSのずれ（m）。本物のGPSのように、ずれはゆっくり変わる
    s.ox = (s.ox||0)*0.85 + gauss()*n*0.5; s.oy = (s.oy||0)*0.85 + gauss()*n*0.5;
    const lat = p[0] + s.oy/110540, lon = p[1] + s.ox/(111320*Math.cos(p[0]*Math.PI/180));
    const pace = (App.R && App.R.plan ? E.paceAt(App.R.plan, s.km) : 480) / s.factor;
    App.onFix({lat, lon, acc: n > 20 ? 30 : 8, t:s.t, speed: s.km >= c.total ? 0 : Math.max(0, 1000/pace + gauss()*0.15)});   // フィニッシュに着いたら止まる
  }
  function tick(){
    const R = App.R; if(!R || !s.on) return;
    // 実際に経過した時間 × 倍率だけ進める（画面OFFでタイマーが遅れても、×1は本当の1倍になる）
    const real = Date.now(), dReal = Math.min(600000, real - (s.lastReal || real));
    s.lastReal = real;
    let left = dReal * s.speed;
    while(left > 0){
      const step = Math.min(1000, left); left -= step;
      const plan = R.plan, pace = (plan ? E.paceAt(plan, s.km) : 480) / s.factor;
      s.t += step;
      if(s.km < 42.195) s.km += step/1000/pace;
      if(s.t - s.lastEmit >= 2000){ s.lastEmit = s.t; emit(); }
    }
    App.updateRun();
  }
  function start(){
    s.on = true; s.t = Date.now(); s.lastReal = Date.now(); s.km = 0; s.lastEmit = 0; s.jitterUntil = 0; s.dropUntil = 0;
    App.startRun({sim:true});
    clearInterval(s.timer); s.timer = setInterval(tick, 250);
  }
  function stop(){ s.on = false; clearInterval(s.timer); s.timer = null; }

  // 場面を作る
  function nextGate(){ return E.nextGate(App.st()); }
  function jumpTo(km, clock){ s.km = km; s.lastEmit = s.t; App.jump(km, clock); }
  const scenes = {
    near300(){ const g = nextGate(); if(!g) return; jumpTo(g.km - 0.3, g.close - 240); App.toast(`${g.name}の300m手前・閉鎖4分前にしました`); },
    near40(){ const g = nextGate(); if(!g) return; jumpTo(g.km - 0.12, g.close - 40); App.toast(`${g.name}の120m手前・閉鎖40秒前にしました`); },
    behind(){ const g = nextGate(); if(!g) return; jumpTo(Math.max(0, g.km - 2), g.close - 2*60*9.5); App.toast("関門2km手前・かなり遅れている状態にしました"); },
    jitter(){ s.jitterUntil = s.t + 90000; App.toast("90秒間、GPSを大きくずらします"); },
    drop(){ s.dropUntil = s.t + 180000; App.toast("3分間、GPSが届かない状態にします"); },
    km(){ const v = prompt("何kmへ移動しますか？（時刻は計画どおりの時刻になります）", (App.T ? App.T.dist : 0).toFixed(1)); if(v==null) return; const km = Number(v); if(!(km>=0 && km<42.2)) return;
      const R = App.R; const clock = R.base ? E.etaAt(R.base, km) : null; jumpTo(km, clock); },
  };

  function bar(){
    return `<div class="simbar">
      <div class="spread"><b class="small" style="color:var(--gold);white-space:nowrap">シミュ</b><span class="small num" id="simstate"></span></div>
      <div class="row">${[1,10,30,60].map(v=>`<button class="btn" data-sim="speed" data-v="${v}" aria-pressed="${s.speed===v}">×${v}</button>`).join("")}
        <button class="btn" data-sim="slow">遅く</button><button class="btn" data-sim="fast">速く</button></div>
      <details><summary>場面を作る</summary><div class="row" style="margin-top:6px"><button class="btn" data-sim="near300">関門300m前・残り4分</button><button class="btn" data-sim="near40">関門直前・残り40秒</button>
        <button class="btn" data-sim="behind">遅れている</button><button class="btn" data-sim="jitter">GPSずれ</button><button class="btn" data-sim="drop">電波切れ3分</button><button class="btn" data-sim="km">km移動</button></div></details>
    </div>`;
  }
  function updateBar(){ const el = document.getElementById("simstate"); if(el) el.textContent = `×${s.speed}・計画の${Math.round(s.factor*100)}%の速さ・本当の位置 ${s.km.toFixed(2)}km` + (s.t < s.dropUntil ? "・電波切れ" : s.t < s.jitterUntil ? "・GPSずれ" : ""); }

  function open(){
    const S = App.S;
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet">
      <div class="spread"><h2>シミュレーション</h2><button class="btn ghost" data-close>閉じる</button></div>
      <p class="small muted">コース上を走る位置を作って、本番と同じ計算・読み上げ・ボタンを試せます。練習モードと同じく、スタートを押した時刻を次の時刻とみなします。</p>
      <div class="picker">${["09:05","09:10","09:15","09:20","09:25","09:30"].map(c=>`<button data-simcross="${c}" aria-pressed="${S.practiceCross===c}">${c.replace(/^0/,"")}</button>`).join("")}</div>
      <p class="small muted">走っている途中で、速さ（×1〜×60）や、走る速さ（計画より遅く・速く）を変えられます。「関門300m前・残り4分」などのボタンで、その場面に飛べます。</p>
      <button class="btn go wide startbtn" data-simstart>シミュレーション開始</button>
    </div>`;
    document.body.appendChild(bg);
    bg.addEventListener("click", e=>{
      if(e.target === bg || e.target.closest("[data-close]")) return bg.remove();
      const c = e.target.closest("[data-simcross]");
      if(c){ S.practiceCross = c.dataset.simcross; try{ localStorage.setItem("kobe-settings-v1", JSON.stringify(S)); }catch(_){} bg.querySelectorAll("[data-simcross]").forEach(b=>b.setAttribute("aria-pressed", b===c)); }
      if(e.target.closest("[data-simstart]")){ bg.remove(); start(); }
    });
  }

  document.addEventListener("click", e=>{
    const b = e.target.closest("[data-sim]"); if(!b) return;
    const a = b.dataset.sim;
    if(a === "speed"){ s.speed = Number(b.dataset.v); document.querySelectorAll("[data-sim=speed]").forEach(x=>x.setAttribute("aria-pressed", x===b)); }
    if(a === "slow") s.factor = Math.max(0.5, +(s.factor - 0.05).toFixed(2));
    if(a === "fast") s.factor = Math.min(1.5, +(s.factor + 0.05).toFixed(2));
    if(scenes[a]) scenes[a]();
    updateBar();
  });

  return {now, start, stop, open, bar, updateBar, tick, resume(){ /* 再読み込みしたらシミュレーションは終わり */ }, get speed(){ return s.speed; }, get on(){ return s.on; }};
})();
