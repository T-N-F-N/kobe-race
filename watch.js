"use strict";
/* =========================================================
   応援画面（応援する人用）
   - ランナーの状況（30秒ごと）を表示
   - 文字のメッセージ → ランナーのスマホで読み上げ
   - 録音した声 → ランナーのスマホで再生
   ========================================================= */
window.Watch = (()=>{
  const E = window.Engine;
  const W = {timer:null, tick:null, layers:{}, centered:false, live:null, msgs:[], err:"", map:null, layers:{}, rec:null, chunks:[], recStart:0, recTimer:null, blob:null, mime:""};
  const KEY = "kobe-watch-v1";
  let conf = (()=>{ try{ return JSON.parse(localStorage.getItem(KEY) || "null"); }catch(e){ return null; } })() || {url:"", key:"", from:""};
  // リンク（#watch&u=…&k=…）で開いたとき
  // リンクの # のあと（または ? のあと：アプリによっては # 以降が消えるため）から読む
  function fromLink(str){
    str = String(str || "");
    for(const part of [str.split("#")[1], str.split("?")[1]]){
      if(!part) continue;
      const q = new URLSearchParams(part.replace(/^(watch&?)/, "").split("#")[0]);
      if(q.get("u") && q.get("k")) return {url:q.get("u"), key:q.get("k")};
    }
    return null;
  }
  const hp = fromLink(location.href);
  if(hp){ conf.url = hp.url; conf.key = hp.key; save(); history.replaceState(null, "", location.pathname); }
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(conf)); }catch(e){} }
  const cfgOk = () => !!(conf.url && conf.key);
  async function post(body){
    const url = conf.url, key = conf.key;
    const r = await Promise.race([fetch(url, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(Object.assign({key}, body))}),
      new Promise((_, ng)=>setTimeout(()=>ng(new Error("通信に時間がかかっています")), 30000))]);
    const j = await r.json(); if(!j.ok) throw new Error(j.error === "key" ? "合言葉が違います" : (j.error || "通信エラー")); return j;
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const toast = t => { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(()=>d.remove(), 2600); };
  const course = () => window.KOBE_COURSE || null;
  const fmtKm = d => (Number(d) || 0) >= 42.195 - 1e-6 ? "42.195" : (Number(d) || 0).toFixed(2);
  let root = null;

  function render(app){
    root = app;
    app.innerHTML = `<div class="wrap">
      <div class="hdr"><div class="brand">KOBE <span>応援</span></div></div>
      ${cfgOk() ? "" : `<div class="card"><b>共有の設定</b>
        <label class="field">応援用リンク（まるごと貼り付け）または ウェブアプリのURL<input class="inp" id="wurl" placeholder="https://…"></label>
        <label class="field">合言葉<input class="inp" id="wkey"></label>
        <button class="btn primary" data-w="conn">接続する</button>
        <p class="small muted">ランナーから送られた「応援用リンク」を開くと、自動で入ります。</p></div>`}
      <div class="card" id="wstatecard"><div class="spread"><b id="wstate">読み込み中…</b><button class="btn ghost" data-w="refresh">更新</button></div><div class="small" id="wstate2"></div></div>
      <div id="wbody"></div>
      <div class="card" id="wmapcard" hidden>
        <div class="spread"><b>現在地</b><button class="btn ghost" data-w="center">ランナーを中心に</button></div>
        <div class="map" id="wmap"></div>
        <div id="west" class="small"></div>
        <p class="small muted">黄色の丸：今ごろいる場所の目安（最後に届いた位置から、今のペースでコースに沿って進めたもの）／白い丸：最後に届いたGPSの位置／青い線：通過した区間／青い丸：関門。地図のコースをタップすると、そこを「応援地点」にして、着くまでの目安を出します。</p>
        <a id="wgmap" class="btn ghost" style="text-align:center;text-decoration:none" target="_blank" rel="noopener" hidden>Googleマップで最後に届いた位置を開く</a>
      </div>
      <div class="card">
        <b>メッセージを送る</b>
        <label class="field">あなたの名前（読み上げで「◯◯さんから」と言います）<input class="inp" id="wfrom" value="${esc(conf.from)}" placeholder="例：パパ"></label>
        <div class="quick">${["いいペース！そのままいこう","少しペースを落とそう","次の給水は必ず取ろう","ジェルを補給しよう","腕を振ろう！","あと少し！がんばれ！"].map(t=>`<button class="btn" data-w="quick">${t}</button>`).join("")}</div>
        <textarea class="inp" id="wtext" rows="2" placeholder="自由にメッセージを書く（短めがおすすめ）"></textarea>
        <button class="btn primary" data-w="send">文字で送る（読み上げ）</button>
        <hr style="border:none;border-top:1px solid var(--line);width:100%">
        <b>声で送る（30秒まで）</b>
        <button class="btn rec" id="wrec" data-w="rec">● 録音する</button>
        <div id="wprev" hidden class="row"><audio id="waudio" controls style="flex:1;min-width:0"></audio><button class="btn primary" data-w="sendvoice">この声を送る</button><button class="btn ghost" data-w="discard">やめる</button></div>
        <div id="wmsgs"></div>
      </div>
      ${cfgOk() ? `<p class="small muted" style="text-align:right"><button class="btn ghost" data-w="reset" style="min-height:30px;padding:2px 10px;font-size:12px">接続をやり直す（ふつうは使いません）</button></p>` : ""}
      <p class="small muted">ランナーのアプリから30秒ごとに状況が届きます。メッセージは、ランナーのアプリが次に通信したとき（最大30秒ほど）に読み上げ・再生されます。</p>
    </div>`;
    if(W.map){ try{ W.map.remove(); }catch(e){} } W.map = null; W.layers = {}; W.centered = false;
    paint(); poll();
    clearInterval(W.timer); W.timer = setInterval(()=>{ if(!document.hidden) poll(); else paintState(); }, 15000);
    clearInterval(W.tick); W.tick = setInterval(()=>{ if(!document.hidden){ paintState(); moveEst(); } }, 2000);
  }
  async function poll(){
    if(!cfgOk()) { paintState(); return; }
    if(W.polling && Date.now() - W.polling < 35000) return;   // 前の問い合わせがまだ終わっていない
    W.polling = Date.now();
    try{ const j = await post({watch:1}); W.live = j.live || null; W.msgs = j.msgs || []; W.err = ""; }
    catch(e){ W.err = e.message || "通信できませんでした"; }
    W.polling = 0;
    paint();
  }
  const liveEl = lv => lv.state === "running" ? lv.el + (Date.now() - lv.at)/1000 : lv.el;
  // ランナーのアプリの状態：アプリは30秒ごとに合図を送る（GPSが取れないときも）
  function appStatus(lv){
    const age = Math.round((Date.now() - lv.at)/1000), t = new Date(lv.at), hm = `${t.getHours()}:${E.pad(t.getMinutes())}`;
    const a = lv.app || {}, bat = a.battery != null ? `・電池${a.battery}%${a.charging ? "（充電中）" : ""}` : "";
    const ago = age < 90 ? `${age}秒前` : `${Math.floor(age/60)}分${age%60}秒前`;
    if(lv.state === "finished" && lv.goal) return {lv:"done", c:"#5fd18f", t:"🏁 ゴールしました！", d:`${hm}にゴール・記録 ${E.fmtDur(lv.el)}`};
    if(lv.state === "finished") return {lv:"done", c:"#9fb0c4", t:"⚪ 計測は終了しています", d:`${hm}に終了・${fmtKm(lv.dist)}km・${E.fmtDur(lv.el)}`};
    if(age <= 75){
      if(a.gpsAge != null && a.gpsAge > 90) return {lv:"nogps", c:"#f5b83d", t:"🟡 アプリは動いていますが、GPSが取れていません", d:`GPSを${Math.floor(a.gpsAge/60)}分受け取れていません（高架下・ビルの間など）。${ago}に受信${bat}`};
      return {lv:"ok", c:"#5fd18f", t:"🟢 アプリは正常に動いています", d:`${ago}に受信${lv.acc ? `・GPS ±${lv.acc}m` : ""}${bat}`};
    }
    if(age <= 180) return {lv:"late", c:"#ff9f43", t:"🟠 受信が遅れています", d:`最後の受信は${ago}。電波が弱い場所にいる可能性があります${bat}`};
    return {lv:"lost", c:"#ff5a4c", t:`🔴 ${Math.floor(age/60)}分間、受信がありません`, d:`アプリが止まっているか、電波がありません。最後の受信 ${hm}・${fmtKm(lv.dist)}km${bat}。地図の黄色の丸（今ごろの位置）は、あてにしないでください`};
  }
  function paintState(){
    const el = document.getElementById("wstate"), el2 = document.getElementById("wstate2"), card = document.getElementById("wstatecard"); if(!el) return;
    const lv = W.live;
    if(W.err){ el.textContent = "⚠ " + W.err; el2.textContent = "応援画面の通信がうまくいっていません。電波を確認してください"; return; }
    if(!lv){ el.textContent = "まだ計測の記録がありません"; el2.textContent = "ランナーが「スタート」を押すと、ここに状況が出ます"; return; }
    const st = appStatus(lv);
    el.textContent = (lv.sim ? "【シミュレーション】" : "") + st.t; el.style.color = st.c; el2.textContent = st.d;
    if(card) card.style.borderColor = st.c;
  }
  function paint(){
    const body = document.getElementById("wbody"); if(!body) return;
    const lv = W.live;
    paintState(); paintMsgs();
    if(!lv){ body.innerHTML = `<div class="card"><p class="small muted">ランナーが「スタート」を押すと、ここに状況が出ます。</p></div>`; return; }
    const g = lv.gate, last = lv.laps && lv.laps[lv.laps.length-1];
    body.innerHTML = `
      <div class="card">
        <div class="spread"><b>${esc(lv.name || "ランナー")}</b><span class="small muted">スタート ${E.fmtClockS(lv.startClock)}</span></div>
        <div class="big"><div class="d num"><span>${fmtKm(lv.dist)}</span><small>km</small></div><div class="t"><b class="num">${E.fmtDur(liveEl(lv))}</b><span>スタートから</span></div></div>
        <div class="tiles">
          <div><span>目標ペース</span><b>${E.fmtPace(lv.target)}</b></div>
          <div><span>現在ペース</span><b>${E.fmtPace(lv.cur)}</b></div>
          <div><span>予定との差</span><b class="${lv.cum>3?"bad":"good"}">${lv.cum==null ? "—" : (Math.abs(lv.cum)<3 ? "±0" : (lv.cum>0?"+":"−") + E.fmtDur(Math.abs(lv.cum)))}</b></div>
        </div>
        <div class="tiles">
          <div><span>直前のラップ</span><b>${last && !last[3] ? E.fmtPace(last[1]) : "—"}</b></div>
          <div><span>ゴール予想(目標)</span><b>${E.fmtClock(lv.predPlan)}</b></div>
          <div><span>今のペースなら</span><b>${E.fmtClock(lv.predRecent)}</b></div>
        </div>
      </div>
      ${g && lv.state === "running" ? `<div class="card gatecard"><div class="spread"><span class="gname">次の関門：${esc(g.name)}</span><span class="small muted num">${g.km.toFixed(1)}km・${E.fmtClock(g.close)}閉鎖</span></div>
        <div class="g3"><div><span>あと${g.rem<1 ? "" : "（km）"}</span><b>${g.rem<1 ? Math.max(0, Math.round(g.rem*1000))+"<small>m</small>" : g.rem.toFixed(2)}</b></div>
        <div><span>閉鎖まで</span>${(()=>{ const l = g.left - (lv.state==="running" ? (Date.now()-lv.at)/1000 : 0); return `<b class="${l>=3600?"long":""}">${l>0 ? E.fmtDur(l) : "閉鎖"}</b>`; })()}</div>
        <div><span>必要ペース</span><b class="${g.req && g.req >= 3600 ? "long" : ""}">${g.req && g.req >= 3600 ? "60:00+" : E.fmtPace(g.req)}</b>${g.req && g.req >= 720 ? `<em class="okw">歩いてOK</em>` : ""}</div></div>
        <div class="marg">目標ペースなら 余裕 <b class="${g.margin!=null && g.margin<(g.need ?? 600) ? "bad" : "good"}">${g.margin==null ? "—" : g.margin>=0 ? Math.floor(g.margin/60)+"分" : "なし"}</b><span class="muted">（目標 ${Math.round((g.need ?? 600)/60)}分以上）</span></div></div>`
      : lv.state === "running" ? (()=>{ const rem = Math.max(0, 42.195 - Number(lv.dist)); return `<div class="card gatecard"><div class="spread"><span class="gname">${lv.near || rem < 0.05 ? "ゴール予定地点付近" : "フィニッシュまで"}</span></div>
        <div class="g3 two"><div><span>あと${rem < 1 ? "" : "（km）"}</span><b>${rem < 1 ? Math.round(rem*1000)+"<small>m</small>" : rem.toFixed(2)}</b></div></div></div>`; })() : ""}
`;
    updateMap(lv);
  }

  /* ---------- 地図：一度だけ作り、更新では印だけ動かす（拡大・移動はそのまま） ---------- */
  function initMap(){
    const box = document.getElementById("wmap");
    if(W.map || !window.L || !box) return;
    W.map = L.map(box, {zoomControl:true});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:18, attribution:"© OpenStreetMap"}).addTo(W.map);
    W.map.setView([34.66,135.12], 12);   // 先に表示位置を決める（決まる前に印を置くと地図の部品がエラーになる）
    const c = course();
    if(c && window.MapDeco) MapDeco.add(W.map, c);
    W.layers.passed = L.polyline([], {color:"#1e88ff", weight:6, opacity:.9}).addTo(W.map);   // 通過した区間（コース上の0km〜届いた距離）
    W.layers.track = L.polyline([], {color:"#7db2ea", weight:2, opacity:.8, dashArray:"4 4"}).addTo(W.map);   // 実際のGPSの軌跡（最近の分）
    W.layers.last = L.circleMarker([0,0], {radius:7, color:"#0a1f3a", weight:2, fillColor:"#ffffff", fillOpacity:1});
    W.layers.est = L.circleMarker([0,0], {radius:10, color:"#fff", weight:3, fillColor:"#f5b83d", fillOpacity:1});
    W.layers.spot = L.marker([0,0]);
    W.map.on("click", e=>setSpot(e.latlng));
    if(conf.spot && c){ W.layers.spot.setLatLng(E.pointAtKm(c, conf.spot)).bindTooltip("応援地点", {permanent:true, direction:"top"}).addTo(W.map); }
  }
  function updateMap(lv){
    const card = document.getElementById("wmapcard"); if(!card) return;
    card.hidden = !lv;
    if(!lv) return;
    initMap(); if(!W.map) return;
    setTimeout(()=>W.map && W.map.invalidateSize(), 50);
    W.layers.track.setLatLngs(lv.track && lv.track.length > 1 ? lv.track : []);
    const c = course(); if(c && window.MapDeco) W.layers.passed.setLatLngs(MapDeco.passed(c, Number(lv.dist) || 0));
    if(lv.pos){ W.layers.last.setLatLng(lv.pos); if(!W.map.hasLayer(W.layers.last)) W.layers.last.addTo(W.map); }
    const g = document.getElementById("wgmap");
    if(g){ g.hidden = !lv.pos; if(lv.pos) g.href = `https://www.google.com/maps?q=${lv.pos[0]},${lv.pos[1]}`; }
    moveEst();
    if(!W.centered){ const e = estimate(lv); const p = e.pos || lv.pos; if(p){ W.map.setView(p, 15); W.centered = true; } }
  }
  // 今ごろの位置：最後に届いた距離 ＋ 経過時間 ÷ ペース（最大15分ぶんまで）
  function estimate(lv){
    const c = course(), recv = Math.max(0, (Date.now() - lv.at)/1000);
    const gpsAge = lv.app && lv.app.gpsAge != null ? Math.max(0, lv.app.gpsAge) : 0;
    const age = recv + Math.min(gpsAge, 3600);                 // 最後に位置が取れてからの時間
    const pace = lv.cur || lv.avg || lv.target || null;
    let base = Number(lv.dist) || 0, moving = false;
    // アプリの距離は安全側（少し短め）に出るので、GPSの位置がコースの上（80m以内）なら、その位置を起点にする
    if(c && lv.pos && !lv.off){ const pr = E.project(c, lv.pos, Math.max(0, base - 0.5), Math.min(42.195, base + 1.5), base); if(pr && pr.off < 80) base = pr.km; }
    let km = base;
    if(lv.state === "running" && !lv.near && pace && pace > 150){ km = Math.min(42.195, km + Math.min(age, 900)/pace); moving = true; }
    return {km, base, age, recv, pace, moving, off:!!lv.off, pos: c ? E.pointAtKm(c, km) : null};
  }
  function moveEst(){
    const lv = W.live, box = document.getElementById("west");
    if(!lv || !W.map) return;
    const e = estimate(lv);
    const lost = lv.state === "running" && e.recv > 180;
    // コースの外（練習など）では、コース上の推定は出さない（白い丸が実際の位置）
    if(e.pos && !e.off){ W.layers.est.setLatLng(e.pos).setStyle({fillColor: lost ? "#9fb0c4" : "#f5b83d"}); if(!W.map.hasLayer(W.layers.est)) W.layers.est.addTo(W.map); }
    else if(W.map.hasLayer(W.layers.est)) W.map.removeLayer(W.layers.est);
    let t = lv.state !== "running" ? `最後の位置：${fmtKm(lv.dist)}km` :
      e.off ? `コースの外にいます（練習など）。計測の距離は <b>${fmtKm(lv.dist)}km</b>。地図の白い丸が実際の位置です` :
      lv.near ? `<b>ゴール予定地点付近</b>にいます` :
      `今ごろ <b>${e.km.toFixed(2)}km</b> あたり（最後に位置が取れた ${e.base.toFixed(2)}km 地点から${Math.round(e.age)}秒、${e.pace ? "キロ" + E.fmtPace(e.pace) : "ペース不明"}で計算）` + (e.age > 900 ? "。15分以上位置が取れていないので、ここで止めています" : lost ? "。<b style='color:#ff5a4c'>受信が途切れているので、あてにしないでください</b>" : "");
    if(conf.spot && !e.off){
      const rem = conf.spot - e.km;
      if(rem <= 0.02) t += `<br>応援地点（${conf.spot.toFixed(2)}km）：<b>もう通過したころ</b>`;
      else if(e.pace){ const sec = rem * e.pace, at = new Date(Date.now() + sec*1000);
        t += `<br>応援地点（${conf.spot.toFixed(2)}km）まで あと${rem.toFixed(2)}km・<b>約${Math.max(1, Math.round(sec/60))}分</b>（${at.getHours()}:${E.pad(at.getMinutes())}ごろ）`; }
      t += ` <button class="btn ghost" data-w="unspot" style="min-height:30px;padding:2px 8px;font-size:12px">応援地点を消す</button>`;
    }
    if(box) box.innerHTML = t;
  }
  // 地図をタップ：ランナーの先にあるコース上の点を応援地点にする（同じ道を行き帰りで通る区間もあるため）
  function setSpot(ll){
    const c = course(); if(!c) return;
    const from = W.live ? estimate(W.live).km : 0;
    let pr = E.project(c, [ll.lat, ll.lng], from, 42.195);
    if(!pr || pr.off > 150) pr = E.project(c, [ll.lat, ll.lng], 0, 42.195);
    if(!pr || pr.off > 150){ toast("コースの近く（150m以内）をタップしてください"); return; }
    conf.spot = +pr.km.toFixed(3); save();
    W.layers.spot.setLatLng(E.pointAtKm(c, conf.spot)).unbindTooltip().bindTooltip("応援地点 " + conf.spot.toFixed(1) + "km", {permanent:true, direction:"top"});
    if(!W.map.hasLayer(W.layers.spot)) W.layers.spot.addTo(W.map);
    moveEst();
  }
  function paintMsgs(){
    const box = document.getElementById("wmsgs"); if(!box) return;
    // 今の計測（スタート以降）に送ったメッセージだけを出す
    const lv = W.live, since = lv ? lv.at - (Number(lv.el) || 0)*1000 - 3*3600000 : 0;   // スタートの3時間前から
    const list = W.msgs.filter(m=>!(m.at < since));
    box.innerHTML = list.length ? `<p class="small muted" style="margin-top:6px">送ったメッセージ</p>` + list.slice().reverse().slice(0,12).map(m=>{ const t = new Date(m.at);
      return `<div class="spread small" style="border-top:1px solid var(--line);padding:4px 0"><span>${t.getHours()}:${E.pad(t.getMinutes())} ${m.voice ? "🎤 声のメッセージ" : esc(m.text)}</span><b class="${m.deliveredAt?"good":"muted"}">${m.deliveredAt ? "届いた" : "未達"}</b></div>`; }).join("") : "";
  }
  async function sendText(text){
    text = String(text||"").trim(); if(!text) return;
    if(!cfgOk()){ toast("共有が設定されていません"); return; }
    conf.from = (document.getElementById("wfrom")||{}).value || conf.from || ""; save();
    try{ await post({msg:{text, from:conf.from}}); toast("送信しました"); const ta = document.getElementById("wtext"); if(ta) ta.value = ""; poll(); }
    catch(e){ toast(e.message || "送信できませんでした"); }
  }

  /* ---------- 録音 ---------- */
  async function recToggle(){
    const btn = document.getElementById("wrec");
    if(W.rec && W.rec.state === "recording"){ W.rec.stop(); return; }
    if(!navigator.mediaDevices || !window.MediaRecorder){ toast("この端末・ブラウザでは録音できません"); return; }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      const types = ["audio/webm;codecs=opus","audio/mp4","audio/webm","audio/ogg;codecs=opus"];
      const type = types.find(t=>MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
      W.rec = new MediaRecorder(stream, type ? {mimeType:type, audioBitsPerSecond:24000} : undefined);
      W.chunks = [];
      W.rec.ondataavailable = e=>{ if(e.data && e.data.size) W.chunks.push(e.data); };
      W.rec.onstop = ()=>{
        stream.getTracks().forEach(t=>t.stop()); clearInterval(W.recTimer);
        W.mime = (W.rec.mimeType || type || "audio/webm").split(";")[0];
        W.blob = new Blob(W.chunks, {type:W.mime});
        btn.classList.remove("on"); btn.textContent = "● 録音しなおす";
        document.getElementById("wprev").hidden = false;
        document.getElementById("waudio").src = URL.createObjectURL(W.blob);
      };
      W.rec.start(); W.recStart = Date.now();
      btn.classList.add("on");
      W.recTimer = setInterval(()=>{ const s = Math.floor((Date.now()-W.recStart)/1000); btn.textContent = `■ 止める（${s}秒）`; if(s >= 30) W.rec.stop(); }, 250);
    }catch(e){ toast("マイクを使えません。ブラウザでマイクを許可してください"); }
  }
  async function sendVoice(){
    if(!W.blob) return;
    if(!cfgOk()){ toast("共有が設定されていません"); return; }
    conf.from = (document.getElementById("wfrom")||{}).value || conf.from || ""; save();
    const b64 = await new Promise((ok, ng)=>{ const r = new FileReader(); r.onload = ()=>ok(String(r.result).split(",")[1] || ""); r.onerror = ng; r.readAsDataURL(W.blob); });
    try{ await post({voice:{data:b64, mime:W.mime, from:conf.from, sec:Math.round((Date.now()-W.recStart)/1000)}}); toast("声を送りました"); W.blob = null; document.getElementById("wprev").hidden = true; poll(); }
    catch(e){ toast(e.message || "送信できませんでした"); }
  }

  document.addEventListener("click", e=>{
    const b = e.target.closest("[data-w]"); if(!b) return;
    const a = b.dataset.w;
    if(a === "reset"){ if(!confirm("接続の設定を消します。消すと、もう一度「応援用リンク」を開くまで状況が見られなくなります。消しますか？")) return; conf.url = ""; conf.key = ""; save(); W.live = null; render(root); }
    if(a === "refresh") poll();
    if(a === "center" && W.map && W.live){ const e = estimate(W.live); if(e.pos || W.live.pos) W.map.setView(e.pos || W.live.pos, Math.max(W.map.getZoom(), 15)); }
    if(a === "unspot"){ conf.spot = null; save(); if(W.map && W.layers.spot) W.map.removeLayer(W.layers.spot); moveEst(); }
    if(a === "conn"){
      const u = document.getElementById("wurl").value.trim(), k = document.getElementById("wkey").value.trim(), l = fromLink(u);   // 応援用リンクをまるごと貼っても使える
      if(l){ conf.url = l.url; conf.key = l.key; } else { conf.url = u; conf.key = k; }
      if(!conf.url || !conf.key){ toast("応援用リンクを貼るか、URLと合言葉を入れてください"); return; }
      save(); render(root);
    }
    if(a === "quick") sendText(b.textContent);
    if(a === "send") sendText(document.getElementById("wtext").value);
    if(a === "rec") recToggle();
    if(a === "sendvoice") sendVoice();
    if(a === "discard"){ W.blob = null; document.getElementById("wprev").hidden = true; }
  });
  return {render};
})();
