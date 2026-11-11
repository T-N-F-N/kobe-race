"use strict";
/* =========================================================
   追加の機能（計測の本体 app.js とは分けてある）
   - 完走証
   - くわしい記録（走ったルートの地図・関門の通過・1kmごとのラップ）
   - ゴール後のメッセージ（届いていない分の再生・当日のメッセージ一覧）
   - 途中経過のクラウド保存（5分ごと）
   - 自動ゴール（フィニッシュ地点を通過して10分たっても押されなかったとき）
   - 自動スタート（本番の日・9時以降・コースを走り始めたのにスタートが押されていないとき）
   ========================================================= */
window.Extras = (()=>{
  const recs = () => load(REC_KEY) || [];
  const findRec = id => recs().find(r=>String(r.id) === String(id)) || null;
  const jpDate = d => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : String(d || ""); };
  let tickAt = 0, ckptAt = 0, pollAt = 0, polling = false;

  /* ---------- 10秒ごとの見回り ---------- */
  const tick = safely("Extras.tick", function(force){
    const now = Date.now();
    if(!force && Math.abs(now - tickAt) < 5000) return;   // 2つの経路（画面のタイマー・本体の合図）から呼ばれるので間引く
    tickAt = now;
    // 自動スタートの待機
    if(Standby.want()){ if(!Standby.on) Standby.begin(); } else if(Standby.on) Standby.end();
    if(R && !R.sim){
      // 途中経過をクラウドへ（5分ごと）：ゴールを押さなくても、当日のデータが残るように
      if(Math.abs(now - ckptAt) > 300000 && Sync.ok){   // （時計が直されて時刻が戻っても止まらないよう、差の大きさで見る）
        ckptAt = now;
        const rec = recordOf(false); rec.partial = true; rec.note = "途中経過";
        withTimeout(Sync.post({record:rec}), 25000).then(()=>Diag.log("途中経過をクラウドに保存 " + rec.dist.toFixed(1) + "km")).catch(()=>{});
      }
    }
    // 自動ゴール：フィニッシュ地点を通過してから10分、ゴールボタンが押されなかったとき
    if(R && R.goalCand && nowMs() - R.goalCand.t > 600000){ Diag.log("自動ゴール"); finishRun(true, {auto:true}); return; }
    // サーバーに届いていない記録があれば、送り直す（1分ごと）
    if(Math.abs(now - recFlushAt) > 60000 && (load(PEND_KEY) || []).length) flushRecords();
    // ゴール後：アプリを開いている間、届いていないメッセージを受け取って再生する
    if(!R && !document.hidden && Math.abs(now - pollAt) > 30000) poll();
  });

  /* ---------- ゴール後のメッセージ ---------- */
  function lastFinish(){ const l = load(LAST_KEY); return l && (!l.sim || (S.sync && S.sync.simShare)) && Date.now() - l.at < 18*3600000 ? l : null; }
  async function poll(){
    const l = lastFinish();
    if(!l || !Sync.ok || polling) return;
    polling = true; pollAt = Date.now();
    try{
      const j = await withTimeout(Sync.post({}), 25000);
      const seen = Live.acked(), fresh = (j.msgs || []).filter(m=>!seen.has(m.id));
      if(fresh.length){
        Live.ack(fresh.map(m=>m.id)); Sync.post({ack:fresh.map(m=>m.id)}).catch(()=>{});
        const from = (l.id || l.at) - 3*3600000;   // その計測のスタート3時間前より古いもの（前のテストの残りなど）は読まない
        fresh.filter(m=>!(m.at < from)).forEach(m=>Live.queue.push(m));
        Diag.log(`ゴール後のメッセージ ${fresh.length}件`);
        Live.drain();
      }
    }catch(e){}
    polling = false;
  }

  /* ---------- ホームのカード ---------- */
  function homeCards(){
    let h = "";
    if(Standby.on) h += `<div class="card" style="border-color:var(--gold)"><b>自動スタート 待機中</b><p class="small muted">スタートラインを越えたら「スタート」を押してください。押し忘れても、9時以降にコースを走り始めると、自動で計測を始めます。</p></div>`;
    const l = load(LAST_KEY);
    if(l && l.sim) return h + lastResult();
    const all = recs(); let r = all[all.length - 1];
    if(!r) return h;
    // 本番で完走した記録があれば、3日間はそれを出す（そのあと間違えてスタートを押しても、完走証のボタンが隠れないように）
    const g = all.filter(x=>x.goal && x.mode === "本番").pop(); if(g && Date.now() - g.at < 3*86400000) r = g;
    const recent = Date.now() - r.at < 7*86400000;
    h += `<div class="card ${r.goal ? "goalcard" : ""}">
      <div class="spread"><b>${r.goal ? "🏁 完走おめでとうございます" : "前回の計測"}</b><span class="small muted">${esc(r.date)} ${esc(r.mode)}</span></div>
      <div class="small">${r.goal ? "記録" : "時間"} <b class="num" style="font-size:22px">${E.fmtDur(r.el)}</b>・${fmtKm(r.dist)}km${r.note ? "・" + esc(r.note) : ""}</div>
      <div class="row">${r.goal ? `<button class="btn primary" data-x="cert" data-id="${esc(r.id)}">完走証</button>` : ""}
        <button class="btn" data-x="result" data-id="${esc(r.id)}">記録を見る</button>
        ${recent && Sync.ok ? `<button class="btn" data-x="inbox" data-id="${esc(r.id)}">メッセージ</button>` : ""}</div></div>`;
    return h;
  }

  /* ---------- 完走証 ---------- */
  function laurel(){
    // 月桂樹のかざり（下から左右に伸びる2本の枝。文字と重ならないよう横長、色は緑）
    let s = "";
    const cx = 120, cy = 60, rx = 106, ry = 60;
    for(let side = -1; side <= 1; side += 2) for(let i = 0; i < 9; i++){
      const t = (14 + i*17) * Math.PI/180;
      const x = cx + side*rx*Math.sin(t), y = cy + ry*Math.cos(t);
      const ang = Math.atan2(-ry*Math.sin(t), side*rx*Math.cos(t)) * 180/Math.PI;
      for(const tilt of [-34, 34])
        s += `<ellipse cx="${(x + 7).toFixed(1)}" cy="${y.toFixed(1)}" rx="9" ry="3.6" fill="url(#leaf)" transform="rotate(${(ang + tilt).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    }
    return `<svg viewBox="0 0 240 130" class="laurel" aria-hidden="true"><defs><linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a9e2b4"/><stop offset=".55" stop-color="#4fae74"/><stop offset="1" stop-color="#1f7a4c"/></linearGradient></defs>${s}</svg>`;
  }
  // 画面の幅や文字サイズの設定がちがっても、1行におさまるまで文字を小さくする
  function fitLine(el, min){
    const box = el.parentElement; if(!box) return;
    const cs = getComputedStyle(box);
    const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let fs = parseFloat(getComputedStyle(el).fontSize), n = 0;
    while(el.getBoundingClientRect().width > avail && fs > min && n++ < 60){ fs -= 1; el.style.fontSize = fs + "px"; }
  }
  function fitCert(bg){
    const cert = bg.querySelector(".cert"); if(!cert) return;
    cert.style.zoom = "";
    bg.querySelectorAll(".cert-en,.cert-title,.cert-event,.cert-eventen,.cert-name,.cert-rec,.cert-stats b,.cert-date").forEach(el=>fitLine(el, 9));
    // 本文と小見出しは、いちばん小さくなった行に大きさをそろえる
    for(const sel of [".cert-text span", ".cert-stats span"]){
      const els = [...bg.querySelectorAll(sel)];
      els.forEach(el=>fitLine(el, 8));
      const m = Math.min(...els.map(el=>parseFloat(getComputedStyle(el).fontSize)));
      els.forEach(el=>{ el.style.fontSize = m + "px"; });
    }
    // 縦も画面におさめる（スクロールなしで全体が見えるように、全体を同じ比率で縮める）
    const cs = getComputedStyle(bg), btns = bg.querySelector(".cert-btns");
    const avail = bg.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (btns ? btns.offsetHeight : 0) - 12;
    const h = cert.offsetHeight;
    if(avail > 200 && h > avail) cert.style.zoom = Math.max(0.55, Math.floor(avail / h * 1000) / 1000);
  }
  function openCert(r, sample){
    if(!r) return;
    const bg = document.createElement("div"); bg.className = "cert-bg";
    const name = (r.name || S.runnerName || "").trim();
    bg.innerHTML = `<div class="cert">
      ${sample ? `<div class="cert-sample">見本</div>` : ""}
      <div class="cert-in">
        <div class="cert-en">FINISHER CERTIFICATE</div>
        <div class="cert-wreath">${laurel()}<div class="cert-title">完走証</div></div>
        <div class="cert-event"><span class="cert-kobe">神戸マラソン</span><span class="cert-year">2026</span></div>
        <div class="cert-eventen">KOBE MARATHON 2026</div>
        <div class="cert-name">${esc(name)}<small> 殿</small></div>
        <p class="cert-text"><span>あなたは 神戸マラソン2026 において</span><span>フルマラソン 42.195km を</span><span>見事に完走されました。</span><span>その健闘をたたえ、ここに証します。</span></p>
        <div class="cert-rec"><div class="cert-kanso">完走</div><div class="cert-time"><span>記録（ネットタイム）</span><b>${E.fmtDur(r.el)}</b></div></div>
        <div class="cert-stats">
          <div><span>走行距離</span><b>42.195<small>km</small></b></div>
          <div><span>スタート</span><b>${esc((r.start || "").replace(/^(\d+:\d+):\d+$/, "$1"))}</b></div>
          <div><span>フィニッシュ</span><b>${esc((r.finish || "").replace(/^(\d+:\d+):\d+$/, "$1"))}</b></div>
        </div>
        <div class="cert-date">${esc(jpDate(r.date))}</div>
        <div class="cert-foot">KOBEレースナビによる計測（スタートラインからの時間）${r.startEstimated ? "・スタート時刻は推定" : ""}${r.finishEstimated ? "・ゴール時刻は推定" : ""}</div>
      </div>
    </div>
    <div class="cert-btns"><button class="btn" data-x="result" data-id="${esc(r.id)}" ${sample ? "data-sample=1" : ""}>記録を見る</button><button class="btn primary" data-certclose>閉じる</button></div>`;
    document.body.appendChild(bg);
    // 「記録を見る」は完走証を閉じてから開く（完走証の裏に開いて見えなくなるのを防ぐ）
    const onResize = ()=>{ if(bg.isConnected) fitCert(bg); else removeEventListener("resize", onResize); };
    addEventListener("resize", onResize);
    bg.addEventListener("click", e=>{ if(e.target.closest("[data-certclose],[data-x=result]")) bg.remove(); });
    fitCert(bg);
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ if(bg.isConnected) fitCert(bg); });
  }

  /* ---------- くわしい記録（地図・関門・ラップ） ---------- */
  let resultMap = null;
  function openResult(r, sample){
    if(!r) return;
    const laps = r.laps || [], good = laps.filter(l=>!l[2] && l[1] > 0);
    const lo = good.length ? Math.min(...good.map(l=>l[1])) : 0, hi = good.length ? Math.max(...good.map(l=>l[1])) : 1;
    const bar = sec => Math.round(30 + 70 * (hi > lo ? (sec - lo)/(hi - lo) : 0.5));   // 遅いほど長い棒
    let cum = 0; const fives = [];
    laps.forEach(l=>{ cum += l[1]; if(l[0] % 5 === 0) fives.push([l[0], l[4] > 0 ? l[4] : cum]); });   // l[4]：スタートからの時間（古い記録にはないので、ラップの合計で代用）
    const avg = r.dist > 0.1 ? r.el / r.dist : null;
    const best = good.length ? good.reduce((a,b)=>a[1] <= b[1] ? a : b) : null;
    const splitRows = (r.splits || []).map(x=>{ const c = E.parseHM(x.clock), cl = E.parseHM(x.close); const m = c != null && cl != null ? cl - c : null;
      return `<tr><td style="text-align:left">${esc(x.name)}<span class="muted small"> ${Number(x.km).toFixed(1)}km</span></td><td class="num">${esc(String(x.clock).replace(/:\d\d$/, ""))}</td><td class="num">${esc(x.close)}</td><td class="num ${m != null && m < 300 ? "bad" : "good"}">${m == null ? "—" : m >= 0 ? Math.floor(m/60) + "分前" : "—"}</td></tr>`; }).join("");
    document.querySelectorAll(".sheet-bg[data-res]").forEach(x=>x.remove());   // 二重に開かない
    const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.style.zIndex = 70; bg.dataset.res = "1";
    bg.innerHTML = `<div class="sheet">
      <div class="spread"><h2>${sample ? "記録（見本）" : "記録"}</h2><button type="button" class="btn ghost" data-close>閉じる</button></div>
      <section class="card ${r.goal ? "goalcard" : ""}">
        <div class="spread"><b>${esc(jpDate(r.date))} ${esc(r.mode)}${r.goal ? " 🏁完走" : ""}</b>${r.goal ? `<button type="button" class="btn primary" data-x="cert" data-id="${esc(r.id)}" ${sample ? "data-sample=1" : ""} style="min-height:36px;padding:2px 12px;white-space:nowrap;flex:0 0 auto">完走証</button>` : ""}</div>
        <div class="resum">
          <div><span>${r.goal ? "記録（ネット）" : "時間"}</span><b>${E.fmtDur(r.el)}</b></div>
          <div><span>距離</span><b>${fmtKm(r.dist)}<small>km</small></b></div>
          <div><span>平均ペース</span><b>${avg ? E.fmtPace(avg) : "—"}<small>/km</small></b></div>
        </div>
        <div class="small muted">スタート ${esc(r.start || "")}${r.startEstimated ? "（推定）" : ""}・${r.goal ? "フィニッシュ" : "終了"} ${esc(r.finish || "")}${best ? `・いちばん速い1km：${best[0]}km（${E.fmtPace(best[1])}）` : ""}${r.autoStart ? "・自動スタート" : ""}${r.autoGoal ? "・自動ゴール" : ""}${r.finishEstimated ? "（ゴール時刻は推定）" : ""}${r.note ? "・" + esc(r.note) : ""}</div>
      </section>
      <section class="card"><h3>走ったルート</h3>
        <div class="map" id="resmap" style="height:300px"></div>
        <div class="small muted">青い線：実際に走った軌跡（GPS）／灰色：コース／青い丸：関門／数字：km${r.track && r.track.length > 1 ? "" : "（この記録には軌跡が残っていません）"}</div>
      </section>
      ${splitRows ? `<section class="card"><h3>関門の通過</h3><table class="laps"><tr><th style="text-align:left">関門</th><th>通過</th><th>閉鎖</th><th>余裕</th></tr>${splitRows}</table></section>` : ""}
      ${fives.length ? `<section class="card"><h3>5kmごと</h3><table class="laps"><tr><th>地点</th><th>スタートから</th><th>この5km</th></tr>${fives.map((f,i)=>`<tr><td>${f[0]}km</td><td class="num">${E.fmtDur(f[1])}</td><td class="num">${E.fmtDur(f[1] - (i ? fives[i-1][1] : 0))}</td></tr>`).join("")}</table></section>` : ""}
      <section class="card"><h3>1kmごとのラップ</h3>
        ${laps.length ? `<div class="lapchart">${laps.map(l=>{ const part = !!l[2], diff = l[3] ? l[1] - l[3] : null;
          return `<div class="laprow"><span class="lk num">${l[0]}</span><span class="lb"><i class="${part ? "p" : diff != null && diff > 3 ? "s" : "f"}" style="width:${part ? 40 : bar(l[1])}%"></i></span><span class="lt num">${E.fmtPace(l[1])}</span><span class="ld num ${part ? "muted" : diff > 3 ? "bad" : "good"}">${part ? "補正" : diff == null ? "" : (diff >= 0 ? "+" : "−") + Math.round(Math.abs(diff))}</span></div>`; }).join("")}</div>
          <div class="small muted">棒が短いほど速いラップ。右の数字は目標ペースとの差（秒）。緑は目標どおりか速い、赤は遅い。「補正」は、関門での距離の合わせ直しなどで正確に測れなかった区間です。</div>` : `<p class="muted small">1kmに届いていません</p>`}
      </section>
      <button type="button" class="btn" data-copyone>この記録を文字でコピー</button>
    </div>`;
    document.body.appendChild(bg);
    // 上の3つの数字（時間・距離・ペース）が枠からはみ出さないよう、同じ大きさで縮める
    const fitSum = ()=>{ const els = [...bg.querySelectorAll(".resum b")]; if(!els.length) return;
      els.forEach(el=>fitLine(el, 12));
      const m = Math.min(...els.map(el=>parseFloat(getComputedStyle(el).fontSize)));
      els.forEach(el=>{ el.style.fontSize = m + "px"; }); };
    fitSum();
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ if(bg.isConnected) fitSum(); });
    const close = ()=>{ try{ resultMap && resultMap.remove(); }catch(e){} resultMap = null; bg.remove(); };
    bg.addEventListener("click", e=>{
      if(e.target === bg || e.target.closest("[data-close]")) return close();
      if(e.target.closest("[data-copyone]")){
        const txt = [`${jpDate(r.date)} ${r.mode}${r.goal ? " 完走" : ""} 記録${E.fmtDur(r.el)} ${fmtKm(r.dist)}km スタート${r.start} ${r.goal ? "フィニッシュ" : "終了"}${r.finish}`]
          .concat((r.splits || []).map(x=>`${x.name}(${x.km}km) ${x.clock}通過 閉鎖${x.close}`)).concat(laps.map(l=>`${l[0]}km ${E.fmtPace(l[1])}${l[2] ? "（補正）" : ""}`)).join("\n");
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(()=>toast("コピーしました")).catch(()=>prompt("コピーしてください", txt));
      }
    });
    // 地図
    setTimeout(safely("resultMap", ()=>{
      const box = bg.querySelector("#resmap"); if(!box || !window.L) return;
      const c = course();
      resultMap = L.map(box, {zoomControl:true});
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:18, attribution:"© OpenStreetMap"}).addTo(resultMap);
      const tr = r.track && r.track.length > 1 ? r.track : null;
      resultMap.setView(tr ? tr[0] : (c ? [c.pts[0][0], c.pts[0][1]] : [34.66, 135.12]), 12);
      if(c && window.MapDeco) MapDeco.add(resultMap, c, cfg().gates);
      if(tr){ const line = L.polyline(tr, {color:"#1e88ff", weight:5, opacity:.95}).addTo(resultMap); resultMap.fitBounds(line.getBounds().pad(0.08)); }
      else if(c) resultMap.fitBounds(L.latLngBounds(c.pts.map(p=>[p[0], p[1]])).pad(0.05));
    }), 60);
  }

  /* ---------- 見本のデータ ---------- */
  function sampleRecord(){
    const c = course(), conf = cfg(), start = E.parseHM("09:21:30"), plan = E.makePlan(conf, 0, start);
    const laps = []; let t = 0; const jit = k => Math.round(Math.sin(k*2.1)*9 + Math.cos(k*0.7)*6 + (k > 30 ? 12 : 0));
    for(let k = 1; k <= 42; k++){ const target = E.paceAt(plan, k - 0.5), sec = Math.round(target + jit(k)); laps.push([k, sec, [4,8,11,21,28,32].includes(k) ? 1 : 0, Math.round(target)]); t += sec; }
    const el = t + Math.round(0.195 * 660);
    const at = km => { let x = 0; for(const l of laps){ if(l[0] <= km) x += l[1]; else { x += l[1] * (km - (l[0]-1)); break; } } return x; };
    const splits = conf.gates.map(g=>({name:g.name, km:g.km, el:Math.round(at(g.km)), clock:E.fmtClockS(start + at(g.km)), close:E.fmtClock(g.close)}));
    const track = c ? c.pts.filter((p,i)=>i % 2 === 0).map(p=>[p[0], p[1]]) : [];
    return {v:2, id:"sample", at:Date.now(), mode:"本番", goal:true, date:S.raceDate || "2026-11-15", name:S.runnerName || "岡田 耕治", start:E.fmtClockS(start), finish:E.fmtClockS(start + el), el, dist:42.195, splits, laps, track};
  }

  /* ---------- 当日のメッセージ一覧（ゴール後） ---------- */
  const voiceCache = {};
  async function openInbox(recId){
    const r = findRec(recId) || recs().slice(-1)[0]; if(!r) return;
    const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.style.zIndex = 70;
    bg.innerHTML = `<div class="sheet"><div class="spread"><h2>届いたメッセージ</h2><button type="button" class="btn ghost" data-close>閉じる</button></div>
      <p class="small muted">${esc(jpDate(r.date))}に届いた応援メッセージです。▶ を押すと、もう一度聞けます。</p>
      <div id="inboxlist"><p class="muted">読み込み中…</p></div></div>`;
    document.body.appendChild(bg);
    let items = [], playingAll = false;
    const day = new Date(String(r.date).replace(/-/g, "/") + " 00:00:00").getTime();
    const draw = ()=>{
      const box = bg.querySelector("#inboxlist"); if(!box) return;
      box.innerHTML = items.length ? `<button type="button" class="btn primary wide" data-playall>${playingAll ? "■ 止める" : "▶ 全部を順番に再生"}</button>` + items.map((m,i)=>{ const t = new Date(m.at);
        return `<div class="inrow"><button type="button" class="btn" data-play="${i}">▶</button><div><b>${esc(m.from || "応援")}</b> <span class="small muted num">${t.getHours()}:${E.pad(t.getMinutes())}</span><div>${m.voice ? `🎤 声のメッセージ${m.sec ? `（${m.sec}秒）` : ""}` : esc(m.text)}</div></div></div>`; }).join("")
        : `<p class="muted">この日のメッセージはまだありません。</p>`;
    };
    const playOne = async m => {
      const from = m.from ? m.from + "さんから。" : "";
      if(m.voice){
        await new Promise(ok=>say(`${from}声のメッセージです。`, true, ok));
        try{
          if(!voiceCache[m.voice]){ const j = await withTimeout(Sync.post({getvoice:m.voice}), 30000); if(j.data) voiceCache[m.voice] = {data:j.data, mime:j.mime || m.mime || "audio/webm"}; }
          const v = voiceCache[m.voice];
          if(v) await withTimeout(playAudio(v.data, v.mime), 45000); else toast("この声は保存期間を過ぎて残っていません");
        }catch(e){ toast("声を読み込めませんでした"); }
      } else await new Promise(ok=>say(`${from}${m.text}`, true, ok));
    };
    bg.addEventListener("click", async e=>{
      if(e.target === bg || e.target.closest("[data-close]")){ playingAll = false; try{ speechSynthesis.cancel(); }catch(_){} return bg.remove(); }
      const p = e.target.closest("[data-play]"); if(p){ playingAll = false; draw(); await playOne(items[Number(p.dataset.play)]); return; }
      if(e.target.closest("[data-playall]")){
        if(playingAll){ playingAll = false; try{ speechSynthesis.cancel(); }catch(_){} draw(); return; }
        playingAll = true; draw();
        for(const m of items){ if(!playingAll || !bg.isConnected) break; await playOne(m); }
        playingAll = false; draw();
      }
    });
    try{
      const j = await withTimeout(Sync.post({inbox:1, since:day, until:day + 86400000}), 30000);
      items = (j.items || j.msgs || []).filter(m=>m.at >= day && m.at < day + 86400000).sort((a,b)=>a.at - b.at);
    }catch(e){ const box = bg.querySelector("#inboxlist"); if(box) box.innerHTML = `<p class="bad">読み込めませんでした。電波のよい場所で、もう一度開いてください。</p>`; return; }
    draw();
  }

  /* ---------- 自動スタート（本番の日だけの保険） ----------
     待機：本番の日の8:00〜10:20、まだ計測していないときにアプリを開くと、GPSを見張る（画面を消しても続く）
     判定：9:00（号砲）以降に、コースの0.05〜3.8kmの線の上（40m以内）を、コースの向きに、15秒以上・30m以上進んだ
     時刻：スタートラインの手前にいるところを見ていれば、線を越えた時刻。見ていなければ、キロ8分30秒で逆算した推定（号砲より前にはしない） */
  const Standby = {
    on:false, buf:[], run:[], behindT:0,
    want(){
      if(R || S.autoStart === false || !isRaceDay() || !course()) return false;
      const c = clockOfDay(Date.now());
      if(c < 8*3600 || c > 10*3600 + 20*60) return false;
      return !recs().some(r=>r.date === todayStr() && (r.goal || r.dist > 5));   // 今日すでに走り終えているなら、待機しない
    },
    begin(){ this.on = true; this.buf = []; this.run = []; this.behindT = 0; Diag.log("自動スタートの待機を開始"); startGps(); if(!R) render(); },
    end(){ this.on = false; if(!R){ stopGps(); render(); } Diag.log("自動スタートの待機を終了"); },
    fix: safely("Standby.fix", function(f){
      if(!this.on || R) return;
      if(f.acc != null && f.acc > 40) return;
      const c = course(), p = [f.lat, f.lon], gun = E.parseHM(S.gun) || 9*3600, clock = clockOfDay(f.t);
      // 進む向き
      const b = this.buf; b.push([f.t, f.lat, f.lon]); while(b.length > 1 && (f.t - b[0][0] > 20000 || b.length > 25)) b.shift();
      let head = null;
      for(let i = b.length-2; i >= 0; i--){ if(E.hav([b[i][1], b[i][2]], p) >= 12){ const hx = (p[1]-b[i][2])*Math.cos(p[0]*Math.PI/180)*111320, hy = (p[0]-b[i][1])*110540, n = Math.hypot(hx, hy); if(n > 0) head = [hx/n, hy/n]; break; } }
      // スタートラインの手前（線から150m以内で、コースの0km地点に当たる）にいた時刻
      const raw = E.project(c, p, 0, 4.0);
      if(raw && raw.km <= 0.0005 && E.hav(p, [c.pts[0][0], c.pts[0][1]]) < 150) this.behindT = f.t;
      if(clock < gun){ this.run = []; return; }
      if(!head) return;   // ゆっくり（止まりながら）進んでいて向きがわからないとき：わかるまで待つ（それまでの分は捨てない）
      const pr = E.project(c, p, 0, 4.0, null, head);
      const ok = pr && pr.off < 40 && pr.km >= 0.05 && pr.km <= 3.8;
      const r = this.run;
      if(!ok || (r.length && pr.km < r[r.length-1][1] - 0.01)){ this.run = []; return; }
      r.push([f.t, pr.km]);
      while(r.length > 1 && f.t - r[0][0] > 120000) r.shift();   // 2分より前の分は使わない
      const first = r[0];
      if(r.length >= 12 && f.t - first[0] >= 15000 && pr.km - first[1] >= 0.03){
        const rate = (pr.km - first[1]) / ((f.t - first[0])/1000);               // km/秒
        let startAt, estimated;
        if(this.behindT && first[0] - this.behindT < 180000 && rate > 0){        // 線の手前から見ていた：線を越えた時刻
          startAt = Math.max(this.behindT, first[0] - first[1]/rate*1000); estimated = false;
        } else {                                                                  // 途中から：キロ8分30秒で逆算（推定）
          startAt = f.t - pr.km*510*1000; estimated = true;
        }
        const day0 = f.t - clock*1000;                                            // 今日の0時
        startAt = Math.min(f.t, Math.max(startAt, day0 + gun*1000));              // 号砲より前にはしない
        this.on = false; this.run = [];
        Diag.log(`自動スタート ${pr.km.toFixed(2)}km ${estimated ? "（時刻は推定）" : ""}`);
        startRun({auto:true, startAt, km:pr.km, estimated});
      }
    }),
  };

  /* ---------- ボタン ---------- */
  document.addEventListener("click", e=>{
    const b = e.target.closest("[data-x]"); if(!b) return;
    const x = b.dataset.x, sample = b.dataset.sample;
    if(x === "cert") openCert(sample ? sampleRecord() : findRec(b.dataset.id), !!sample);
    if(x === "result") openResult(sample ? sampleRecord() : findRec(b.dataset.id), !!sample);
    if(x === "inbox") openInbox(b.dataset.id);
    if(x === "samplecert") openCert(sampleRecord(), true);
    if(x === "sampleresult") openResult(sampleRecord(), true);
  });

  return {tick, poll, homeCards, openCert, openResult, openInbox, sampleRecord, Standby};
})();
