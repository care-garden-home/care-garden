// 点滴の計算ロジック（純粋関数のみ。DOM・通信・現在時刻への依存なし）
//
// 設計：docs/design-v0.md §8
// - 時刻はすべてエポックミリ秒（UTC基準の数値）で扱う。日本時間への変換は表示用の補助関数のみ
// - 内部は小数のまま保持し、丸めは表示用の関数（roundToMinute 等）でのみ行う
// - 結果は「calculated（計算上の推定）」と「instruction（医療者の指示）」を分けて返す
// - アプリは流量を提案しない。指示範囲外は警告として返すだけで、計算は止めない

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const DEFAULT_RATE_STEP = 5;
const JST_OFFSET_MS = 9 * MS_PER_HOUR; // 日本は夏時間なし

export const EVENT_TYPES = Object.freeze([
  'start', 'rate_change', 'volume_visual', 'volume_pump',
  'pause', 'resume', 'end', 'flush', 'flush_skip', 'cancel', 'correction', 'note',
]);

const CORRECTABLE_FIELDS = Object.freeze(['occurredMs', 'rate', 'volumeMl']);

// ---------------------------------------------------------------------------
// 入力検証

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** 指示（infusion_orders）を、計算結果と区別できる形に整える */
export function normalizeOrder(order) {
  if (!order) return null;
  return {
    drugName: order.drugName ?? null,
    volumeMl: order.volumeMl ?? null,
    rateMin: order.rateMin ?? null,
    rateMax: order.rateMax ?? null,
    rateStep: order.rateStep ?? DEFAULT_RATE_STEP,
    orderedOn: order.orderedOn ?? null,
    orderedBy: order.orderedBy ?? null,
    validFrom: order.validFrom ?? null,
    validTo: order.validTo ?? null,
  };
}

/**
 * 流量の検証。
 * errors：計算に使えない（数値でない・0以下・刻み違反）
 * warnings：計算はできるが、医療者の指示範囲外（保存は妨げない。確認と理由入力を求める用途）
 */
export function validateRate(rate, order = null) {
  const errors = [];
  const warnings = [];
  const step = order?.rateStep ?? DEFAULT_RATE_STEP;
  if (!isFiniteNumber(rate)) {
    errors.push('RATE_NOT_NUMBER');
  } else if (rate <= 0) {
    errors.push('RATE_NOT_POSITIVE');
  } else if (rate % step !== 0) {
    errors.push('RATE_NOT_STEP');
  } else {
    if (isFiniteNumber(order?.rateMin) && rate < order.rateMin) warnings.push('RATE_BELOW_ORDER');
    if (isFiniteNumber(order?.rateMax) && rate > order.rateMax) warnings.push('RATE_ABOVE_ORDER');
  }
  return { ok: errors.length === 0, errors, warnings, withinOrder: warnings.length === 0 };
}

export function validateVolume(volumeMl) {
  if (!isFiniteNumber(volumeMl)) return ['VOLUME_NOT_NUMBER'];
  if (volumeMl <= 0) return ['VOLUME_NOT_POSITIVE'];
  return [];
}

const validateTime = (ms, code) => (isFiniteNumber(ms) ? [] : [code]);

// ---------------------------------------------------------------------------
// 基本の計算

/** 投与時間（ms）＝ 容量 ÷ 流量 */
export function durationMs(volumeMl, rateMlPerH) {
  return (volumeMl / rateMlPerH) * MS_PER_HOUR;
}

/**
 * 開始前の逆算：終了希望日時から開始すべき日時を求める（design §8-3）
 * @returns {{ok, errors, warnings, calculated, instruction}}
 */
export function planStart({ volumeMl, rateMlPerH, targetEndMs, order = null }) {
  const rateCheck = validateRate(rateMlPerH, order);
  const errors = [
    ...validateVolume(volumeMl),
    ...rateCheck.errors,
    ...validateTime(targetEndMs, 'TARGET_END_INVALID'),
  ];
  const warnings = [...rateCheck.warnings];
  if (errors.length) {
    return { ok: false, errors, warnings, calculated: null, instruction: normalizeOrder(order) };
  }
  const dur = durationMs(volumeMl, rateMlPerH);
  return {
    ok: true,
    errors,
    warnings,
    calculated: {
      kind: 'plan',
      volumeMl,
      rateMlPerH,
      durationMs: dur,
      startMs: targetEndMs - dur,
      endMs: targetEndMs,
      withinOrder: rateCheck.withinOrder,
    },
    instruction: normalizeOrder(order),
  };
}

/** 開始時刻から終了予定を求める（点滴開始時の終了予定日時） */
export function planEnd({ volumeMl, rateMlPerH, startMs, order = null }) {
  const rateCheck = validateRate(rateMlPerH, order);
  const errors = [
    ...validateVolume(volumeMl),
    ...rateCheck.errors,
    ...validateTime(startMs, 'START_INVALID'),
  ];
  if (errors.length) {
    return { ok: false, errors, warnings: rateCheck.warnings, calculated: null, instruction: normalizeOrder(order) };
  }
  const dur = durationMs(volumeMl, rateMlPerH);
  return {
    ok: true,
    errors,
    warnings: rateCheck.warnings,
    calculated: { kind: 'plan', volumeMl, rateMlPerH, durationMs: dur, startMs, endMs: startMs + dur, withinOrder: rateCheck.withinOrder },
    instruction: normalizeOrder(order),
  };
}

/** 残量からの終了再計算：終了予定 ＝ 確認日時 ＋ 残量 ÷ 流量（design 要件§5-5） */
export function endFromRemaining({ remainingMl, rateMlPerH, atMs }) {
  const errors = [];
  if (!isFiniteNumber(remainingMl) || remainingMl < 0) errors.push('REMAINING_INVALID');
  const rateErrors = validateRate(rateMlPerH).errors;
  errors.push(...rateErrors, ...validateTime(atMs, 'AT_INVALID'));
  if (errors.length) return { ok: false, errors, remainingMs: null, estEndMs: null };
  const remainingMs = durationMs(remainingMl, rateMlPerH);
  return { ok: true, errors, remainingMs, estEndMs: atMs + remainingMs };
}

// ---------------------------------------------------------------------------
// 修正イベントの適用（design §8-5）

/**
 * correction イベントを元イベントに反映した新しい配列を返す。元の配列は変更しない。
 * 同じ元イベント・同じ項目への修正が複数あれば、seq の大きい（新しい）方を採用する。
 */
export function applyCorrections(events) {
  const errors = [];
  const bySeq = new Map();
  for (const ev of events) {
    if (ev.type !== 'correction') bySeq.set(ev.seq, { ...ev });
  }
  const corrections = events
    .filter((ev) => ev.type === 'correction')
    .sort((a, b) => a.seq - b.seq);
  for (const c of corrections) {
    const target = bySeq.get(c.correctsSeq);
    if (!target) {
      errors.push({ code: 'CORRECTION_TARGET_MISSING', seq: c.seq });
      continue;
    }
    if (!CORRECTABLE_FIELDS.includes(c.field)) {
      errors.push({ code: 'CORRECTION_FIELD_INVALID', seq: c.seq });
      continue;
    }
    if (!isFiniteNumber(c.newValue)) {
      errors.push({ code: 'CORRECTION_VALUE_INVALID', seq: c.seq });
      continue;
    }
    target[c.field] = c.newValue;
    target.corrected = true;
  }
  return { events: [...bySeq.values()], errors };
}

const byOccurredThenSeq = (a, b) => a.occurredMs - b.occurredMs || a.seq - b.seq;

// ---------------------------------------------------------------------------
// 投与中の推定（イベント再生、design §8-4）

/**
 * イベント列を時刻順に再生し、現在の状態・残量・推定終了を求める。
 * 不正なイベント（状態に合わない操作など）は errors に記録して無視し、計算は続ける。
 *
 * @param {object} p
 * @param {number} p.volumeMl   バッグの容量（点滴記録に複写された値）
 * @param {Array}  p.events     infusion_events（seq, type, occurredMs, rate, volumeMl, ...）
 * @param {number} p.nowMs      現在時刻
 * @param {object} [p.order]    医療者の指示（範囲チェックと表示用。計算には使わない）
 */
export function estimate({ volumeMl, events = [], nowMs, order = null }) {
  const errors = [];
  const warnings = [];
  const outOfOrder = []; // 指示範囲外の流量が使われたイベント

  const volErrors = validateVolume(volumeMl);
  if (volErrors.length || !isFiniteNumber(nowMs)) {
    return {
      ok: false,
      errors: [...volErrors.map((code) => ({ code })), ...(isFiniteNumber(nowMs) ? [] : [{ code: 'NOW_INVALID' }])],
      warnings,
      calculated: null,
      instruction: normalizeOrder(order),
      checks: { outOfOrder },
    };
  }

  const corrected = applyCorrections(events);
  errors.push(...corrected.errors);

  let status = 'not_started';
  let closureStatus = 'none';
  let remaining = volumeMl;
  let rate = null;
  let t = null; // 直前に処理した時刻
  let startedMs = null;
  let endedMs = null;
  let pausedMs = 0;
  let pauseStartedMs = null;
  let basis = null;
  let zeroAtMs = null; // 推定上、残量が0になった時刻

  // 投与中の区間 [t, until) で残量を減らす
  const consume = (until) => {
    if (status !== 'running' || until <= t) return;
    const ml = rate * (until - t) / MS_PER_HOUR;
    if (zeroAtMs === null && ml >= remaining) {
      zeroAtMs = t + (remaining / rate) * MS_PER_HOUR;
    }
    remaining = Math.max(0, remaining - ml);
  };

  const sorted = corrected.events.filter((ev) => ev.type !== 'note').sort(byOccurredThenSeq);

  for (const ev of sorted) {
    const reject = (code) => errors.push({ code, seq: ev.seq, type: ev.type });

    if (!EVENT_TYPES.includes(ev.type)) { reject('EVENT_TYPE_UNKNOWN'); continue; }
    if (!isFiniteNumber(ev.occurredMs)) { reject('EVENT_TIME_INVALID'); continue; }
    if (t !== null && ev.occurredMs < t) { reject('EVENT_ORDER_INVALID'); continue; } // 同時刻は可

    if (status === 'not_started' && !['start', 'cancel'].includes(ev.type)) {
      reject('EVENT_BEFORE_START');
      continue;
    }
    const finished = status === 'ended' || status === 'cancelled';
    if (finished && !['flush', 'flush_skip'].includes(ev.type)) {
      reject('EVENT_AFTER_FINISH');
      continue;
    }

    consume(ev.occurredMs);
    t = ev.occurredMs;

    switch (ev.type) {
      case 'start': {
        if (status !== 'not_started') { reject('INVALID_TRANSITION'); continue; }
        const check = validateRate(ev.rate, order);
        if (!check.ok) { reject(check.errors[0]); t = null; continue; }
        if (!check.withinOrder) outOfOrder.push({ seq: ev.seq, rate: ev.rate, warnings: check.warnings });
        status = 'running';
        rate = ev.rate;
        startedMs = ev.occurredMs;
        basis = { kind: 'start', atMs: ev.occurredMs, valueMl: volumeMl };
        break;
      }
      case 'rate_change': {
        const check = validateRate(ev.rate, order);
        if (!check.ok) { reject(check.errors[0]); continue; }
        if (!check.withinOrder) outOfOrder.push({ seq: ev.seq, rate: ev.rate, warnings: check.warnings });
        rate = ev.rate;
        break;
      }
      case 'volume_visual': {
        if (!isFiniteNumber(ev.volumeMl) || ev.volumeMl < 0) { reject('VOLUME_OBSERVED_INVALID'); continue; }
        if (ev.volumeMl > volumeMl) warnings.push({ code: 'VISUAL_ABOVE_TOTAL', seq: ev.seq });
        remaining = Math.min(ev.volumeMl, volumeMl);
        zeroAtMs = remaining === 0 ? ev.occurredMs : null;
        basis = { kind: 'visual', atMs: ev.occurredMs, valueMl: ev.volumeMl };
        break;
      }
      case 'volume_pump': {
        if (!isFiniteNumber(ev.volumeMl) || ev.volumeMl < 0) { reject('VOLUME_OBSERVED_INVALID'); continue; }
        if (ev.volumeMl > volumeMl) warnings.push({ code: 'PUMP_ABOVE_TOTAL', seq: ev.seq });
        remaining = Math.max(0, volumeMl - ev.volumeMl);
        zeroAtMs = remaining === 0 ? ev.occurredMs : null;
        basis = { kind: 'pump', atMs: ev.occurredMs, valueMl: ev.volumeMl };
        break;
      }
      case 'pause': {
        if (status !== 'running') { reject('INVALID_TRANSITION'); continue; }
        status = 'paused';
        pauseStartedMs = ev.occurredMs;
        break;
      }
      case 'resume': {
        if (status !== 'paused') { reject('INVALID_TRANSITION'); continue; }
        pausedMs += ev.occurredMs - pauseStartedMs;
        pauseStartedMs = null;
        status = 'running';
        break;
      }
      case 'end': {
        if (status !== 'running' && status !== 'paused') { reject('INVALID_TRANSITION'); continue; }
        if (status === 'paused') { pausedMs += ev.occurredMs - pauseStartedMs; pauseStartedMs = null; }
        status = 'ended';
        endedMs = ev.occurredMs;
        closureStatus = 'pending';
        break;
      }
      case 'cancel': {
        if (status === 'paused') { pausedMs += ev.occurredMs - pauseStartedMs; pauseStartedMs = null; }
        if (status !== 'not_started') endedMs = ev.occurredMs;
        status = 'cancelled';
        closureStatus = startedMs === null ? 'not_required' : 'pending';
        break;
      }
      case 'flush': {
        if (!finished) { reject('FLUSH_BEFORE_FINISH'); continue; }
        if (closureStatus === 'done') { reject('FLUSH_ALREADY_DONE'); continue; }   // 二重の DONE は受け付けない（FORGET・未実施からの DONE は通る）
        closureStatus = 'done';
        break;
      }
      case 'flush_skip': {
        if (!finished) { reject('FLUSH_BEFORE_FINISH'); continue; }
        if (closureStatus === 'done') { reject('FLUSH_ALREADY_DONE'); continue; }
        // unknown＝FORGET（実施したか不明）。完了でも未実施の確定でもない別の状態
        closureStatus = ev.flushStatus === 'not_required' ? 'not_required' : ev.flushStatus === 'unknown' ? 'unknown' : 'not_done';
        break;
      }
      default:
        break;
    }
  }

  // 現在時刻まで進める
  let effectiveNow = nowMs;
  if (t !== null && nowMs < t) {
    warnings.push({ code: 'NOW_BEFORE_LAST_EVENT' });
    effectiveNow = t;
  }
  consume(effectiveNow);
  if (status === 'running') t = effectiveNow;

  const currentPausedMs = pausedMs + (status === 'paused' ? effectiveNow - pauseStartedMs : 0);
  const untilMs = endedMs ?? effectiveNow;
  const elapsedMs = startedMs === null ? 0 : untilMs - startedMs;

  let remainingMs = null;
  let estEndMs = null;
  const overdue = status === 'running' && remaining === 0;
  if (status === 'running') {
    remainingMs = (remaining / rate) * MS_PER_HOUR;
    estEndMs = overdue ? zeroAtMs : effectiveNow + remainingMs;
  } else if (status === 'paused') {
    remainingMs = (remaining / rate) * MS_PER_HOUR; // 「再開後 約◯時間」用。終了時刻は出さない
  }

  return {
    ok: true,
    errors,
    warnings,
    calculated: {
      kind: 'estimate',             // 計算上の推定（医療者の指示ではない）
      status,
      closureStatus,
      remainingMl: status === 'running' || status === 'paused' ? remaining : null,
      remainingMs,
      estEndMs,
      overdue,
      currentRate: rate,
      startedMs,
      endedMs,
      elapsedMs,                    // 開始からの単純な経過
      pausedMs: currentPausedMs,
      activeMs: elapsedMs - currentPausedMs, // 実投与時間
      basis,                        // 推定の根拠（最新の観測）
    },
    instruction: normalizeOrder(order),
    checks: { outOfOrder },
  };
}

// ---------------------------------------------------------------------------
// 表示用（丸めはここでのみ行う）

export const roundToMinute = (ms) => Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
export const floorToMinute = (ms) => Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;

/** 時間の長さを {hours, minutes} に分ける（分は切り捨て。24時間超もそのまま時間で表す） */
export function splitDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / MS_PER_MINUTE);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** エポックmsを日本時間の年月日時分に分解する */
export function toJstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** 日本時間の年月日時分からエポックmsを作る */
export function fromJst(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
}

/** fromMs より後で最初に来る、日本時間 hh:mm の時刻（例：翌朝6:00の既定値） */
export function nextJstTime(fromMs, hour, minute = 0) {
  const p = toJstParts(fromMs);
  let candidate = fromJst(p.year, p.month, p.day, hour, minute);
  if (candidate <= fromMs) candidate = fromJst(p.year, p.month, p.day + 1, hour, minute);
  return candidate;
}

/**
 * イベントを足してよいかの判定（サーバーと画面で共通）。
 * calc は実施日時（occurredMs）順に並べ直して再生するので、実際の出来事を後から記録すること（記録の順序≠実施の順序）は許される。
 * ただし候補が、自分自身のエラーだけでなく、既存のイベントに新しい矛盾を起こす場合（例：すでにある流量変更より前の日時に「終了」を入れる）は拒否する。
 * 追加前から存在していたエラーは数えない。
 * @returns {{ ok:boolean, errors:Array<{code:string,seq?:number,type?:string}>, result:object }}
 */
export function appendCheck({ volumeMl, existing, candidate, nowMs, order = null }) {
  const before = estimate({ volumeMl, events: existing, nowMs, order });
  const after = estimate({ volumeMl, events: [...existing, candidate], nowMs, order });
  const key = (e) => `${e.seq}|${e.code}`;
  const had = new Set((before.errors ?? []).map(key));
  const errors = (after.errors ?? []).filter((e) => e.seq === candidate.seq || !had.has(key(e)));
  return { ok: after.ok !== false && errors.length === 0, errors, result: after };
}
