// 背景の表示。背景は飾りで、記録の処理とは完全に分けてある（画面設計 §8-4）。
// 読み込みの失敗・遅れ・定義の誤り・判定の例外は、すべてここで受け止め、無地の背景のままにする。
// 取得するのは、いま表示する1枚だけ（先読み・一括取得はしない）。

import { pickBackground, nextBoundaryMs } from './background.js';
import { backgroundUrl } from './bg-map.js';

export function startBackground(el, { getSettings = () => ({}), clock = () => Date.now(), base = new URL('.', import.meta.url) } = {}) {
  let timer = null;
  let current = null;

  function show(id) {
    if (id === current) return;
    const rel = backgroundUrl(id);
    if (!rel) { fallback(); return; }
    const url = new URL(rel, base).href;
    const img = new Image();
    img.onload = () => { current = id; el.style.backgroundImage = `url("${url}")`; el.dataset.bg = id; el.classList.add('has-image'); };
    img.onerror = () => { fallback(); };
    img.src = url;
  }
  function fallback() {
    current = null;
    el.style.backgroundImage = '';
    delete el.dataset.bg;
    el.classList.remove('has-image');
  }
  function update() {
    clearTimeout(timer);
    try {
      show(pickBackground(clock(), getSettings()).id);
      const wait = Math.max(1000, Math.min(nextBoundaryMs(clock()) - clock() + 500, 6 * 3_600_000));
      timer = setTimeout(update, wait);
    } catch {
      fallback();
      timer = setTimeout(update, 600_000);
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') update(); };
  document.addEventListener('visibilitychange', onVisible);
  update();
  return { update, stop() { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); } };
}
