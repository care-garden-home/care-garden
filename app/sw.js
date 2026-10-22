// Service Worker：画面（HTML・CSS・JS・書体）をオフラインでも開けるようにする。
// - 画面のファイル：ネットワーク優先（更新が反映される）。つながらないときだけ保存したものを使う
// - 背景の画像：表示した1枚だけを保存する。**44枚をまとめて先に保存しない**。保存は最大8枚で、古いものから消す
// - 記録・同期の通信（/api など）には触れない。記録をここに保存しない

const SHELL = 'cg-shell-v1';
const BG = 'cg-bg-v1';
const BG_MAX = 8;
const SHELL_FILES = ['./', './index.html', './css/app.css', './fonts/KaiseiDecol-400.woff2', './fonts/KaiseiDecol-500.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, BG].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimBg() {
  const cache = await caches.open(BG);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - BG_MAX))) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // 通信（POST）・他のサイトには触れない
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;

  if (url.pathname.includes('/bg/') && url.pathname.endsWith('.webp')) {
    e.respondWith((async () => {
      const cache = await caches.open(BG);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { await cache.put(req, res.clone()); await trimBg(); }
      return res;
    })().catch(() => new Response('', { status: 504 })));
    return;
  }

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req)) ?? (await caches.match('./index.html')) ?? new Response('', { status: 504 });
    }
  })());
});
