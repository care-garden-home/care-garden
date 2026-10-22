// 接続先（記録・同期の送り先）の設定。画面は、index.html の <meta name="cg-api" content="…"> から読む。
// 設定がなければ、従来どおり同じ場所の /api（PC の模擬サーバー）。
// 接続先を変えても、認証（端末のトークン）と権限の検証は、送り先のサーバー側で行われる（接続先だけで認証を迂回できない）。
// 想定外の接続先（別のサイトなど）には、トークンを送らない：許すのは「/api」と、Google Apps Script の公開 URL の形だけ。
// 接続先の設定は URL の検索条件（?…）からは変えられない（ファイルの生成時にだけ入る）。

const GAS_EXEC = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

/** @returns {string|null} 使ってよい接続先。許されない値なら null（送信しない） */
export function resolveApiUrl(configured) {
  if (configured === undefined || configured === null || configured === '' || configured === '/api') return '/api';
  return typeof configured === 'string' && GAS_EXEC.test(configured) ? configured : null;
}

export function configuredApiUrl(doc = globalThis.document) {
  const raw = doc?.querySelector?.('meta[name="cg-api"]')?.getAttribute('content');
  return resolveApiUrl(raw);
}
