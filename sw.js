// オフライン対応：まずネットから取り、つながらないときは保存しておいたものを使う
const CACHE = "kobe-race-v8";
const SHELL = ["./", "index.html", "app.js", "engine.js", "course.js", "watch.js", "mapdeco.js", "extras.js", "watch.html", "style.css", "sim.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())); });
self.addEventListener("activate", e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch", e=>{
  if(e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if(u.origin !== location.origin && u.host !== "cdnjs.cloudflare.com") return;
  const key = e.request;   // ページごとに保存する（見守りページと混ざらないように）
  e.respondWith(fetch(e.request).then(r=>{ if(r.ok){ const c = r.clone(); caches.open(CACHE).then(x=>x.put(key, c)); } return r; }).catch(()=>caches.match(key, {ignoreSearch:true})));
});
