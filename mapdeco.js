"use strict";
/* =========================================================
   地図の飾り（ランナー用・見守り用で共通）
   - 1kmごとの点と数字（離れて見ているときは5kmごとだけ）
   - 関門の位置と名前・km
   - スタート・フィニッシュ
   - 通過した区間（コースの0km〜今の距離）を青く塗る
   ========================================================= */
window.MapDeco = (()=>{
  const E = window.Engine;
  const GATES = [["御旅公園",3.8],["工業技術センター",8.0],["須磨一ノ谷プラザ",10.7],["舞子公園",17.5],["大蔵海岸西",20.7],["舞子駅",23.9],
    ["垂水下水処理場",27.1],["須磨一ノ谷プラザ",31.1],["須磨海浜公園",32.7],["駒ヶ林会館",35.4],["中央卸売市場第7門",39.8]].map(([name,km])=>({name, km}));

  // gates：[{name, km}]（省略すると神戸マラソンの関門）
  function add(map, course, gates){
    if(!map || !course || !window.L) return null;
    const g = L.layerGroup().addTo(map);
    L.polyline(course.pts.map(p=>[p[0],p[1]]), {color:"#8a93ad", weight:5, opacity:.9}).addTo(g);
    const total = course.total || course.pts[course.pts.length-1][2];
    for(let k=1;k<total;k++){
      const major = k % 5 === 0;
      L.circleMarker(E.pointAtKm(course, k), {radius:major?4:3, color:"#000", weight:1, fillColor:"#fff", fillOpacity:1, interactive:false})
        .bindTooltip(String(k), {permanent:true, direction:"right", offset:[4,0], className:"kmlbl" + (major ? "" : " minor")}).addTo(g);
    }
    (gates && gates.length ? gates : GATES).forEach(x=>{
      L.circleMarker(E.pointAtKm(course, x.km), {radius:7, color:"#fff", weight:2, fillColor:"#1060ff", fillOpacity:1})
        .bindTooltip(`${x.name} ${Number(x.km).toFixed(1)}km`, {permanent:true, direction:"left", offset:[-6,0], className:"gatelbl"}).addTo(g);
    });
    const s = course.pts[0], f = course.pts[course.pts.length-1];
    L.circleMarker([s[0],s[1]], {radius:7, color:"#fff", weight:2, fillColor:"#2a9d4b", fillOpacity:1}).bindTooltip("スタート", {permanent:true, direction:"top", className:"gatelbl start"}).addTo(g);
    L.circleMarker([f[0],f[1]], {radius:8, color:"#fff", weight:2, fillColor:"#e8202a", fillOpacity:1}).bindTooltip("フィニッシュ", {permanent:true, direction:"bottom", className:"gatelbl fin"}).addTo(g);
    // 離れて見ているとき（ズーム13以下）は、1kmごとの数字を5kmごとだけにする・関門の名前を隠す
    const box = map.getContainer();
    const upd = ()=>{ const z = map.getZoom(); box.classList.toggle("zfar", z < 14); box.classList.toggle("zvfar", z < 12); };
    map.on("zoomend", upd); upd();
    return g;
  }
  // コースの0km〜km（通過した区間）
  function passed(course, km){
    if(!course || !(km > 0)) return [];
    const out = [];
    for(const p of course.pts){ if(p[2] >= km) break; out.push([p[0],p[1]]); }
    out.push(E.pointAtKm(course, km));
    return out.length > 1 ? out : [];
  }
  return {add, passed, GATES};
})();
