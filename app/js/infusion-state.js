// 点滴の「いまの状態」を、記録（infusions・infusion_events）と既存の計算（calc.js）から求める。
// 表示のための組み立てだけを行い、計算そのものは calc.js に任せる。計算上の推定であり、医療者の指示ではない。

import { estimate } from '../../src/infusion/calc.js';

export const toCalcEvent = (e) => ({
  seq: e.seq,
  type: e.type,
  occurredMs: e.occurred_ms,
  rate: e.rate,
  volumeMl: e.volume_ml,
  flushStatus: e.flush_status,
  correctsSeq: e.corrects_seq,
  field: e.field,
  newValue: e.new_value,
});

/** infusion_orders の記録 → calc.js の order */
export function toCalcOrder(o) {
  if (!o) return null;
  return {
    drugName: o.drug_name, volumeMl: o.volume_ml, rateMin: o.rate_min, rateMax: o.rate_max,
    rateStep: o.rate_step, orderedOn: o.ordered_on, orderedBy: o.ordered_by, validFrom: o.valid_from, validTo: o.valid_to,
  };
}

/** 現在有効な点滴の指示（最新の1件） */
export function currentOrder(data, nowMs) {
  const orders = data.list('infusion_orders');
  const day = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  const valid = orders.filter((o) => (!o.valid_from || o.valid_from <= day) && (!o.valid_to || o.valid_to >= day));
  const pool = valid.length ? valid : orders;
  return pool.sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0] ?? null;
}

/** 状態の表示名（要件§4-2）。色と文字と記号の3つで示すため、記号とクラス名も返す */
export const STATE_VIEW = Object.freeze({
  not_started:      { key: 'not_started', label: '未開始', mark: '○', cls: 'st-idle' },
  running:          { key: 'running', label: '投与中', mark: '●', cls: 'st-run' },
  paused:           { key: 'paused', label: '一時中断', mark: 'Ⅱ', cls: 'st-pause' },
  ended_pending:    { key: 'ended_pending', label: '終了処置待ち', mark: '△', cls: 'st-warn' },
  closed:           { key: 'closed', label: '終了処置 ✓ DONE', mark: '', cls: 'st-done' },
  closed_unknown: { key: 'closed', label: '終了処置 ? FORGET（実施したか不明）', short: '終了処置 ? FORGET', mark: '', cls: 'st-unknown' },
  closed_not_required: { key: 'closed', label: '終了処置 不要（医療者の指示）', mark: '✓', cls: 'st-done' },
  cancelled:        { key: 'cancelled', label: '中止', mark: '×', cls: 'st-cancel' },
});

/**
 * 画面に出す「いまの点滴」。
 * 終了処置が済んでいない（またはまだ終わっていない）点滴を優先し、なければ最後の点滴。
 */
export function currentInfusion(data, nowMs) {
  const infusions = data.list('infusions').sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0));
  if (!infusions.length) return null;
  const order = currentOrder(data, nowMs);
  const withState = infusions.map((inf) => describe(data, inf, order, nowMs));
  const open = withState.find((x) => x.view.key === 'not_started' || x.view.key === 'running' || x.view.key === 'paused' || x.view.key === 'ended_pending');
  return open ?? withState[0];
}

export function describe(data, inf, order, nowMs) {
  const events = data.list('infusion_events').filter((e) => e.infusion_id === inf.id).sort((a, b) => a.seq - b.seq);
  const result = estimate({ volumeMl: inf.volume_ml, events: events.map(toCalcEvent), nowMs, order: toCalcOrder(order) });
  const c = result.calculated;
  let view = STATE_VIEW.not_started;
  if (c) {
    if (c.status === 'running') view = STATE_VIEW.running;
    else if (c.status === 'paused') view = STATE_VIEW.paused;
    else if (c.status === 'ended') view = c.closureStatus === 'done' ? STATE_VIEW.closed : c.closureStatus === 'not_required' ? STATE_VIEW.closed_not_required : c.closureStatus === 'unknown' ? STATE_VIEW.closed_unknown : STATE_VIEW.ended_pending;
    else if (c.status === 'cancelled') view = c.closureStatus === 'pending' || c.closureStatus === 'not_done' ? STATE_VIEW.ended_pending : c.closureStatus === 'unknown' ? STATE_VIEW.closed_unknown : STATE_VIEW.cancelled;
  }
  return { infusion: inf, events, result, calc: c, view };
}
