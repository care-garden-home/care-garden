// 同期の状態の表示（ヘッダーと HOME の情報パネルで同じ文言を使う）。
// 保存できていない記録・復元前の未送信は赤、未送信・同期できないは琥珀（赤にしない）。

import { fmtTimeAmPm } from './ui.js';

/** @returns {{ text:string, level:''|'warn'|'alert', alertIcon:boolean, busy:boolean }} */
export function syncInfo(data) {
  const c = data.counts;
  let text; let level = ''; let alertIcon = false;
  if (data.maintenance) { text = '復元の作業中（記録は端末に保存されます）'; level = 'warn'; }
  else if (c.stale > 0) { text = `復元前の未送信 ${c.stale}件`; level = 'alert'; alertIcon = true; }
  else if (c.rejected > 0 || c.conflict > 0 || c.authRequired > 0) { text = '保存できていない記録あり'; level = 'alert'; alertIcon = true; }
  else if (c.unsent > 0) { text = `未送信 ${c.unsent}件`; level = 'warn'; }
  else if (data.syncState === 'failed') { text = '同期できませんでした'; level = 'warn'; }
  else if (data.lastSyncMs) text = `${fmtTimeAmPm(data.lastSyncMs)} 同期`;
  else text = '未同期';
  return { text, level, alertIcon, busy: data.syncState === 'syncing' };
}
