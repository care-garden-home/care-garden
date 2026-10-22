// 終了希望時刻からの流量の逆算（daily-ops-design §3）。純粋関数。既存の計算（calc.js）を再利用し、calc.js は変更しない。
//
// - 候補は、医療者の指示の範囲（rateMin〜rateMax）と刻み（rateStep）の中だけ。範囲外は候補に出さない
// - 計算値は「計算上の候補」であり、医療者の指示ではない。実際にポンプへ設定した流量は、流量の変更の記録（rate_change）として別に残る
// - 範囲内で間に合わない（遅すぎる／早すぎる）場合は、その旨を返し、上限・下限の流量での終了見込みを示す

import { endFromRemaining, MS_PER_HOUR } from './calc.js';

export const DEFAULT_LIMITS = Object.freeze({ rateMin: 60, rateMax: 150, rateStep: 5 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {{ remainingMl:number, atMs:number, targetEndMs:number,
 *           order?:{ rateMin?:number, rateMax?:number, rateStep?:number, usualMin?:number, usualMax?:number } }} p
 *   remainingMl：現在の推定残量（calc.js の estimate の calculated.remainingMl）　atMs：この流量にする時刻（通常は今。中断中は再開する時刻）
 * @returns {{ ok:false, errors:string[] } |
 *   { ok:true, status:'ok'|'too_late'|'too_early', idealRate:number, bounds:{min:number,max:number,step:number},
 *     best:Candidate, candidates:Candidate[] }}
 *   Candidate＝{ rate, endMs, diffMs（終了見込み−希望。正＝希望より遅い）, inUsual }
 */
export function suggestRate({ remainingMl, atMs, targetEndMs, order = {} }) {
  const errors = [];
  if (!isNum(remainingMl) || remainingMl <= 0) errors.push('REMAINING_INVALID');
  if (!isNum(atMs)) errors.push('AT_INVALID');
  if (!isNum(targetEndMs)) errors.push('TARGET_INVALID');
  else if (isNum(atMs) && targetEndMs <= atMs) errors.push('TARGET_NOT_AFTER_NOW');
  const step = isNum(order.rateStep) && order.rateStep > 0 ? order.rateStep : DEFAULT_LIMITS.rateStep;
  const lo = isNum(order.rateMin) ? order.rateMin : DEFAULT_LIMITS.rateMin;
  const hi = isNum(order.rateMax) ? order.rateMax : DEFAULT_LIMITS.rateMax;
  if (lo > hi) errors.push('ORDER_RANGE_INVALID');
  if (errors.length) return { ok: false, errors };

  // 指示の範囲内の、刻みの倍数だけ
  const rates = [];
  for (let r = Math.ceil(lo / step) * step; r <= hi; r += step) rates.push(r);
  if (!rates.length) return { ok: false, errors: ['NO_ALLOWED_RATE'] };

  const hours = (targetEndMs - atMs) / MS_PER_HOUR;
  const idealRate = remainingMl / hours;
  const usualMin = isNum(order.usualMin) ? order.usualMin : null;
  const usualMax = isNum(order.usualMax) ? order.usualMax : null;
  const make = (rate) => {
    const end = endFromRemaining({ remainingMl, rateMlPerH: rate, atMs });
    return { rate, endMs: end.estEndMs, diffMs: end.estEndMs - targetEndMs, inUsual: usualMin !== null && usualMax !== null && rate >= usualMin && rate <= usualMax };
  };

  const minRate = rates[0];
  const maxRate = rates[rates.length - 1];
  let status = 'ok';
  let candidates;
  if (idealRate > maxRate) { status = 'too_late'; candidates = [make(maxRate)]; }          // 上限でも希望の時刻に間に合わない
  else if (idealRate < minRate) { status = 'too_early'; candidates = [make(minRate)]; }    // 下限でも希望より早く終わる
  else {
    // 希望に間に合う側（流量が必要以上）と、希望より少し遅れる側（流量が必要未満）の、前後の刻み
    const up = rates.find((r) => r >= idealRate);
    const down = [...rates].reverse().find((r) => r <= idealRate);
    const set = [...new Set([down, up])].filter((r) => r !== undefined);
    candidates = set.map(make);
  }
  const best = candidates.reduce((a, b) => (Math.abs(b.diffMs) < Math.abs(a.diffMs) ? b : a));
  return { ok: true, status, idealRate, bounds: { min: minRate, max: maxRate, step }, best, candidates };
}
