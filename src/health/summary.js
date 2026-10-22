// 月ごとの体調の傾向（表示用の集計。純粋関数。新たな保存項目・同期は増やさない）。
//
// - 集計は、保存済みの体調記録（health_logs）から、表示のときに計算する
// - 割合の分母は「評価の記録がある日数」。記録のない日は含めない
// - 同じ日に複数の記録があれば、その日の最新の有効な評価（condition）を採用する。訂正（更新）と取り消し（削除）は、
//   渡される記録がすでに反映しているので、削除済みの記録は渡さない（渡されても無視する）
// - 評価（condition）のない旧形式の記録は、集計の対象外（その日は数えない）

import { CONDITIONS } from '../validation/records.js';

const JST_MS = 9 * 3_600_000;
const pad = (n) => String(n).padStart(2, '0');
const jstParts = (ms) => { const d = new Date(ms + JST_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };

/**
 * @param {object[]} logs  health_logs の記録（condition・logged_ms・created_ms・deleted_ms）
 * @param {{ year:number, month:number }} target  日本時間の年・月（1〜12）
 * @returns {{ year, month, days:number, counts:Record<string,number>, percents:Record<string,number>, top:string[] }}
 *   top：最多の評価（同率なら複数。記録が0日なら空）。percents は 0〜100 の数（丸めない）
 */
export function monthlySummary(logs, { year, month }) {
  const byDay = new Map();
  for (const l of logs) {
    if (!l || (l.deleted_ms !== undefined && l.deleted_ms !== null)) continue;
    if (!CONDITIONS.includes(l.condition) || !Number.isFinite(l.logged_ms)) continue;
    const p = jstParts(l.logged_ms);
    if (p.y !== year || p.m !== month) continue;
    const key = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    const cur = byDay.get(key);
    if (!cur || l.logged_ms > cur.logged_ms || (l.logged_ms === cur.logged_ms && (l.created_ms ?? 0) > (cur.created_ms ?? 0))) byDay.set(key, l);
  }
  const counts = Object.fromEntries(CONDITIONS.map((c) => [c, 0]));
  for (const l of byDay.values()) counts[l.condition] += 1;
  const days = byDay.size;
  const percents = Object.fromEntries(CONDITIONS.map((c) => [c, days ? (counts[c] / days) * 100 : 0]));
  const max = Math.max(...Object.values(counts));
  return { year, month, days, counts, percents, top: days ? CONDITIONS.filter((c) => counts[c] === max) : [] };
}

/** 日本時間の「いま」の年・月 */
export function jstYearMonth(ms) { const p = jstParts(ms); return { year: p.y, month: p.m }; }
