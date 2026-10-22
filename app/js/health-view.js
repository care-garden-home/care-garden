// 体調記録の表示（4段階＋症状＋任意メモ）。評価の絵文字は【】の前に置く。旧形式の記録（数値など）も、そのまま表示できる。

import { LEGACY_HEALTH_FIELDS } from '../../src/validation/records.js';

export const CONDITION_VIEW = Object.freeze({
  ok: { emoji: '💗', label: 'OK' },
  normal: { emoji: '😊', label: '普通' },
  uneasy: { emoji: '😅', label: 'おや？' },
  hard: { emoji: '😰', label: 'つらい' },
});

export const isLegacyHealth = (h) => !h.condition && LEGACY_HEALTH_FIELDS.some((f) => h[f] !== undefined && h[f] !== null && h[f] !== '');

/** 1行の表示：「😅【おや？】便秘／腹部の張り」。旧形式の記録は「体調の記録　体温 36.6℃ …」 */
export function healthLine(h) {
  const c = CONDITION_VIEW[h.condition];
  if (c) return `${c.emoji}【${c.label}】${Array.isArray(h.symptoms) ? h.symptoms.join('／') : ''}`;
  const p = [];
  if (h.temp_c != null) p.push(`体温 ${h.temp_c}℃`);
  if (h.bp_sys != null || h.bp_dia != null) p.push(`血圧 ${h.bp_sys ?? '—'}/${h.bp_dia ?? '—'}`);
  if (h.pulse != null) p.push(`脈 ${h.pulse}`);
  if (h.weight_kg != null) p.push(`体重 ${h.weight_kg}kg`);
  return `体調の記録（以前の形式）${p.length ? `　${p.join('　')}` : ''}`;
}

/** 詳細（メモと、旧形式の項目）。なければ null */
export function healthDetail(h) {
  const parts = [];
  if (h.memo) parts.push(h.memo);
  if (isLegacyHealth(h)) {
    const more = [];
    for (const [k, label] of [['abd_pain', '腹痛'], ['abd_distension', '腹部膨満'], ['vomit_count', '嘔吐'], ['stool_count', '排便'], ['stool_form', '便の性状'], ['urine', '排尿'], ['oral_intake', '経口'], ['water_ml', '飲水(mL)'], ['sleep', '睡眠'], ['activity', '活動'], ['wound', '創傷']]) if (h[k] !== undefined && h[k] !== null && h[k] !== '') more.push(`${label} ${h[k]}`);
    if (more.length) parts.push(more.join('　'));
  }
  return parts.length ? parts.join('\n') : null;
}
