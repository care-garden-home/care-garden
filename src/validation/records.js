// 記録の種類ごとの入力検証（画面設計 §6）。純粋関数。画面での事前確認と、サーバー（deps.validateRecord）の両方で使う。
//
// **範囲の数値は、入力ミス（桁の間違い・単位の間違い）を防ぐためのもので、医療上の正常範囲ではない。**
// 範囲の外でも医療上は起こりうる値は拒否しない（アプリは医療上の判断をしない。要件§15-14）。
// 点滴の流量が医療者の指示の範囲外であることは、ここでは拒否せず、calc.js の警告と確認画面で扱う。
//
// 戻り値：{ ok, errors: [{ field, code, message }] }

import { EVENT_TYPES } from '../infusion/calc.js';

/** 入力ミスの検出に使う範囲（最小, 最大）。医療上の正常範囲ではない */
export const RANGES = Object.freeze({
  temp_c: [30, 45],
  bp_sys: [40, 300],
  bp_dia: [20, 200],
  pulse: [20, 250],
  weight_kg: [10, 300],
  water_ml: [0, 10_000],
  vomit_count: [0, 50],
  stool_count: [0, 50],
  volume_ml: [1, 5_000],
});

export const URINE = Object.freeze(['普段どおり', '少ない', '多い', 'その他']);
export const PERFORMERS = Object.freeze(['u_mother', 'u_admin']);   // 点滴の実施者（記録者は別に、サーバーが認証から付ける created_by）
export const FLUSH_STATUS = Object.freeze(['done', 'not_done', 'not_required', 'unknown']);
export const INFUSION_STATUS = Object.freeze(['not_started', 'running', 'paused', 'ended', 'cancelled']);
export const CLOSURE_STATUS = Object.freeze(['none', 'pending', 'done', 'not_done', 'not_required', 'unknown']);
export const WASTE_TARGETS = Object.freeze(['route', 'bag', 'other']);
export const HANDOVER_STATUS = Object.freeze(['handed_over', 'pending', 'not_handed']);
export const CORRECTION_FIELDS = Object.freeze(['occurredMs', 'rate', 'volumeMl']);
export const CONDITIONS = Object.freeze(['ok', 'normal', 'uneasy', 'hard']);   // 体調の4段階（OK／普通／おや？／つらい）
export const SYMPTOMS = Object.freeze(['便秘', '頭痛', '吐き気', '痛み', 'だるさ', 'めまい', '腹部の張り', 'その他']);
/** 旧形式（数値などの欄）の項目。過去の記録として保持する。新しい入力画面には出さない */
export const LEGACY_HEALTH_FIELDS = Object.freeze(['temp_c', 'bp_sys', 'bp_dia', 'pulse', 'weight_kg', 'abd_pain', 'abd_distension', 'vomit_count', 'stool_count', 'stool_form', 'urine', 'oral_intake', 'water_ml', 'sleep', 'activity', 'wound']);
export const APPT_KINDS = Object.freeze(['訪問看護', '訪問リハビリ', '訪問診療', '訪問薬剤師', '通院', 'その他']);
export const BOOKING = Object.freeze(['tentative', 'confirmed']);          // 予約の状態（予定／確定）
export const APPT_EXCEPTION = Object.freeze(['changed', 'cancelled']);     // 1回分の変更・中止（予定の変更。実績ではない）
export const VISIT_OUTCOME = Object.freeze(['done', 'not_done', 'cancelled']);   // 実績（実施済み／未実施／中止）
export const RECUR_FREQ = Object.freeze(['none', 'daily', 'weekly', 'monthly']);
export const TASK_ENTRY = Object.freeze(['question', 'check']);            // 質問の本体／済み・未済のチェック（追加記録）
export const PAUSE_REASONS = Object.freeze(['閉塞', '気泡', 'その他']);
export const TRIP_KEYS = Object.freeze(['depart_home_ms', 'arrive_hospital_ms', 'consult_start_ms', 'consult_end_ms', 'leave_hospital_ms', 'arrive_home_ms']);
const TEXT_MAX = 500;
const LONG_TEXT_MAX = 2000;

const MESSAGES = {
  REQUIRED: '入力してください',
  NOT_NUMBER: '数字で入力してください',
  NOT_INTEGER: '整数で入力してください',
  OUT_OF_RANGE: '値が大きすぎるか小さすぎます。単位や桁を確かめてください',
  BAD_CHOICE: '選択肢の中から選んでください',
  BAD_DATE: '日付の形が正しくありません',
  BAD_TIME: '時刻の形が正しくありません（例 06:00）',
  TOO_LONG: '文字数が多すぎます',
  NOT_TEXT: '文字で入力してください',
  BEFORE_START: '開始より前の日付です',
  RANGE_ORDER: '下限が上限より大きくなっています',
  OUTSIDE_RANGE: '全体の範囲の外です',
  BAD_KIND: 'この記録の種類は、ここでは記録できません',
  BP_ORDER: '下の血圧が上の血圧より大きくなっています',
  OBJECT: '内容が正しくありません',
  UNKNOWN_FIELD: '定義されていない項目です',
  BAD_PHONE: '電話番号の形が正しくありません',
  BAD_RECUR: '繰り返しの設定が正しくありません',
  BAD_TRIP: '通院の時刻の前後が合いません',
  BAD_UUID: '参照の形が正しくありません',
};

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 'YYYY-MM-DD' が実在する日付か */
export function isDateText(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? '');
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
const isTimeText = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v ?? '');

function checker(data, errors, nowMs) {
  const add = (field, code) => errors.push({ field, code, message: MESSAGES[code] ?? code });
  const has = (f) => data[f] !== undefined && data[f] !== null && data[f] !== '';
  const api = {
    add, has,
    required(f) { if (!has(f)) { add(f, 'REQUIRED'); return false; } return true; },
    num(f, [min, max] = [-Infinity, Infinity], { int = false } = {}) {
      if (!has(f)) return;
      const v = data[f];
      if (!isNum(v)) return add(f, 'NOT_NUMBER');
      if (int && !Number.isInteger(v)) return add(f, 'NOT_INTEGER');
      if (v < min || v > max) add(f, 'OUT_OF_RANGE');
    },
    positive(f, max = Infinity) {
      if (!has(f)) return;
      const v = data[f];
      if (!isNum(v)) return add(f, 'NOT_NUMBER');
      if (v <= 0 || v > max) add(f, 'OUT_OF_RANGE');
    },
    oneOf(f, list) { if (has(f) && !list.includes(data[f])) add(f, 'BAD_CHOICE'); },
    text(f, max = TEXT_MAX) {
      if (data[f] === undefined || data[f] === null) return;
      if (!isStr(data[f])) return add(f, 'NOT_TEXT');
      if (data[f].length > max) add(f, 'TOO_LONG');
    },
    date(f) { if (has(f) && !isDateText(data[f])) add(f, 'BAD_DATE'); },
    uuid(f) { if (has(f) && !(isStr(data[f]) && UUID_TEXT.test(data[f]))) add(f, 'BAD_UUID'); },
    phone(f) { if (has(f) && !(isStr(data[f]) && /^[0-9+()\-\s]{6,20}$/.test(data[f]) && /\d{5,}/.test(data[f].replace(/\D/g, '')))) add(f, 'BAD_PHONE'); },
    time(f) { if (has(f) && !isTimeText(data[f])) add(f, 'BAD_TIME'); },
    dateTime(f, { required = false } = {}) {
      if (!has(f)) { if (required) add(f, 'REQUIRED'); return; }
      const v = data[f];
      if (!isNum(v) || v <= 0) return add(f, 'NOT_NUMBER');
      // 未来の日時は一律には拒否しない（予定は未来が正しい）。記録の種類ごとの日時の制約は、承認された案に従って足す
    },
  };
  return api;
}

/** 繰り返しの規則の形。正しければ null、違えば true */
function recurIsBad(r) {
  if (!isObj(r)) return true;
  for (const k of Object.keys(r)) if (!['freq', 'weekday', 'day', 'until'].includes(k)) return true;
  if (!RECUR_FREQ.includes(r.freq)) return true;
  if (r.freq === 'weekly') { if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return true; }
  else if (r.weekday !== undefined) return true;
  if (r.freq === 'monthly') { if (!Number.isInteger(r.day) || r.day < 1 || r.day > 31) return true; }
  else if (r.day !== undefined) return true;
  if (r.until !== undefined && !isDateText(r.until)) return true;
  return false;
}

/** 通院の実績の時刻の形。任意の項目が、順番どおり（前の時刻以降）にそろっていれば OK */
function tripIsBad(t) {
  if (!isObj(t)) return true;
  let prev = null;
  for (const k of Object.keys(t)) if (!TRIP_KEYS.includes(k)) return true;
  for (const k of TRIP_KEYS) {
    if (t[k] === undefined || t[k] === null) continue;
    if (!isNum(t[k]) || t[k] <= 0) return true;
    if (prev !== null && t[k] < prev) return true;
    prev = t[k];
  }
  return false;
}

/** 項目の許可リスト。リストにない項目は拒否する（未定義の項目を無検証で保存しない） */
const ALLOWED = {
  health_logs: ['logged_ms', 'condition', 'symptoms', 'memo', ...LEGACY_HEALTH_FIELDS],
  appointments: ['kind', 'start_ms', 'end_ms', 'provider', 'phone', 'staff', 'memo', 'note', 'booking', 'recur', 'series_id', 'occurrence_date', 'exception', 'travel_min', 'arrival_margin_min'],
  visit_notes: ['appointment_id', 'occurrence_date', 'outcome', 'did', 'talked', 'next_check', 'corrects_id', 'trip', 'note'],
  tasks: ['entry', 'content', 'kind', 'provider', 'appointment_id', 'corrects_id', 'question_id', 'checked', 'answer', 'note'],
  needle_handovers: ['appointment_id', 'occurrence_date', 'handover_ms', 'handover_on', 'destination', 'status', 'note', 'corrects_id'],
  // 点滴の経過・点滴・日常の処分：許可リスト（未定義の項目は拒否。サーバーが付ける項目・所属の infusion_id・通し番号 seq は検証の前に除かれる）
  infusion_events: ['type', 'occurred_ms', 'rate', 'rate_before', 'volume_ml', 'flush_status', 'performed_by', 'reason', 'pump_alarm', 'action_taken', 'order_ref', 'note', 'contacted', 'out_of_range', 'corrects_seq', 'field', 'new_value'],
  infusions: ['order_id', 'drug_name', 'volume_ml', 'plan_target_end_ms', 'plan_rate', 'plan_start_ms', 'status', 'closure_status', 'note'],
  waste_records: ['kind', 'disposed_on', 'target', 'note'],
  needle_changes: ['changed_on', 'performed_by', 'next_due_on', 'appointment_id', 'note', 'occurrence_date', 'changed_ms'],
  infusion_orders: ['drug_name', 'volume_ml', 'rate_min', 'rate_max', 'rate_step', 'usual_rate_min', 'usual_rate_max', 'long_rate_min', 'long_rate_max',
    'target_end_time', 'ordered_on', 'ordered_by', 'valid_from', 'valid_to', 'occlusion_procedure', 'bubble_procedure', 'flush_instruction', 'note'],
};

const VALIDATORS = {
  appointments(d, c) {
    if (c.required('kind')) c.oneOf('kind', APPT_KINDS);
    c.dateTime('start_ms', { required: true });
    c.dateTime('end_ms');
    if (isNum(d.start_ms) && isNum(d.end_ms) && d.end_ms < d.start_ms) c.add('end_ms', 'BEFORE_START');
    c.text('provider', 100); c.text('staff', 100); c.text('memo', LONG_TEXT_MAX); c.text('note');
    c.phone('phone');
    if (c.required('booking')) c.oneOf('booking', BOOKING);
    if (d.recur === undefined || d.recur === null) c.add('recur', 'REQUIRED'); else if (recurIsBad(d.recur)) c.add('recur', 'BAD_RECUR');
    c.num('travel_min', [0, 600], { int: true }); c.num('arrival_margin_min', [0, 240], { int: true });
    c.uuid('series_id'); c.date('occurrence_date'); c.oneOf('exception', APPT_EXCEPTION);
    // 1回分の例外は、元の予定とその回の日付を必ず持つ
    if (has(d, 'exception') || has(d, 'series_id')) { c.required('series_id'); c.required('occurrence_date'); c.required('exception'); }
  },

  visit_notes(d, c) {
    if (c.required('appointment_id')) c.uuid('appointment_id');
    if (c.required('occurrence_date')) c.date('occurrence_date');
    if (c.required('outcome')) c.oneOf('outcome', VISIT_OUTCOME);
    for (const f of ['did', 'talked', 'next_check']) c.text(f, LONG_TEXT_MAX);
    c.text('note'); c.uuid('corrects_id');
    if (d.trip !== undefined && d.trip !== null && tripIsBad(d.trip)) c.add('trip', 'BAD_TRIP');
  },

  tasks(d, c) {
    if (!c.required('entry')) return;
    if (!c.oneOf('entry', TASK_ENTRY) && !TASK_ENTRY.includes(d.entry)) return;
    c.text('note'); c.uuid('corrects_id'); c.uuid('appointment_id');
    if (d.entry === 'question') {
      if (c.required('content')) c.text('content', 1000);
      c.oneOf('kind', APPT_KINDS); c.text('provider', 100);
      for (const f of ['question_id', 'checked', 'answer']) if (has(d, f)) c.add(f, 'BAD_KIND');
    } else {
      if (c.required('question_id')) c.uuid('question_id');
      if (d.checked === undefined || d.checked === null) c.add('checked', 'REQUIRED');
      else if (typeof d.checked !== 'boolean') c.add('checked', 'BAD_CHOICE');
      c.text('answer', 1000);
      for (const f of ['content', 'kind', 'provider', 'corrects_id']) if (has(d, f)) c.add(f, 'BAD_KIND');
    }
  },

  health_logs(d, c) {
    c.dateTime('logged_ms', { required: true });
    // 新しい記録では評価（condition）が必須。旧項目だけの既存の記録は、そのまま有効（更新で壊れない）
    c.oneOf('condition', CONDITIONS);
    if (!has(d, 'condition') && !LEGACY_HEALTH_FIELDS.some((f) => has(d, f))) c.add('condition', 'REQUIRED');
    if (d.symptoms !== undefined && d.symptoms !== null) {
      if (!Array.isArray(d.symptoms) || d.symptoms.some((x) => !SYMPTOMS.includes(x)) || new Set(d.symptoms).size !== d.symptoms.length) c.add('symptoms', 'BAD_CHOICE');
    }
    for (const f of ['temp_c', 'bp_sys', 'bp_dia', 'pulse', 'weight_kg', 'water_ml']) c.num(f, RANGES[f]);
    for (const f of ['vomit_count', 'stool_count']) c.num(f, RANGES[f], { int: true });
    for (const f of ['abd_pain', 'abd_distension']) c.num(f, [0, 3], { int: true });
    if (isNum(d.bp_sys) && isNum(d.bp_dia) && d.bp_dia > d.bp_sys) c.add('bp_dia', 'BP_ORDER');
    c.oneOf('urine', URINE);
    for (const f of ['stool_form', 'oral_intake', 'sleep', 'activity', 'wound']) c.text(f);
    c.text('memo', LONG_TEXT_MAX);
  },

  needle_changes(d, c) {
    if (c.required('changed_on')) c.date('changed_on');
    c.date('next_due_on');
    if (isDateText(d.changed_on) && isDateText(d.next_due_on) && d.next_due_on < d.changed_on) c.add('next_due_on', 'BEFORE_START');
    c.text('performed_by', 100); c.text('note'); c.text('appointment_id', 64);
    c.date('occurrence_date'); c.dateTime('changed_ms');
  },

  infusion_orders(d, c) {
    if (c.required('drug_name')) c.text('drug_name', 100);
    if (c.required('volume_ml')) c.positive('volume_ml', RANGES.volume_ml[1]);
    for (const f of ['rate_min', 'rate_max', 'rate_step', 'usual_rate_min', 'usual_rate_max', 'long_rate_min', 'long_rate_max']) c.positive(f, 1000);
    const pair = (lo, hi) => { if (isNum(d[lo]) && isNum(d[hi]) && d[lo] > d[hi]) c.add(lo, 'RANGE_ORDER'); };
    pair('rate_min', 'rate_max'); pair('usual_rate_min', 'usual_rate_max'); pair('long_rate_min', 'long_rate_max');
    for (const f of ['usual_rate_min', 'usual_rate_max', 'long_rate_min', 'long_rate_max']) {
      if (isNum(d[f]) && ((isNum(d.rate_min) && d[f] < d.rate_min) || (isNum(d.rate_max) && d[f] > d.rate_max))) c.add(f, 'OUTSIDE_RANGE');
    }
    c.time('target_end_time');
    for (const f of ['ordered_on', 'valid_from', 'valid_to']) c.date(f);
    if (isDateText(d.valid_from) && isDateText(d.valid_to) && d.valid_to < d.valid_from) c.add('valid_to', 'BEFORE_START');
    c.text('ordered_by', 200);
    for (const f of ['occlusion_procedure', 'bubble_procedure', 'flush_instruction']) c.text(f, LONG_TEXT_MAX);   // 閉塞時と気泡時の指示は別項目
    c.text('note');
  },

  infusions(d, c) {
    c.text('order_id', 64); c.text('drug_name', 100); c.text('note');
    if (c.required('volume_ml')) c.positive('volume_ml', RANGES.volume_ml[1]);
    c.positive('plan_rate', 1000);               // 指示の範囲・刻みは拒否せず、画面の確認で扱う
    for (const f of ['plan_target_end_ms', 'plan_start_ms']) c.dateTime(f);
    c.oneOf('status', INFUSION_STATUS); c.oneOf('closure_status', CLOSURE_STATUS);
  },

  infusion_events(d, c) {
    if (!c.required('type')) return;
    if (!EVENT_TYPES.includes(d.type)) return c.add('type', 'BAD_CHOICE');
    c.dateTime('occurred_ms', { required: true });
    c.positive('rate', 1000); c.positive('rate_before', 1000);
    c.num('volume_ml', [0, RANGES.volume_ml[1]]);
    c.oneOf('flush_status', FLUSH_STATUS);
    // 実施者（任意。未設定＝記録者と同じ）。開始・終了・DONE だけ。FORGET（処置の実施自体が不明）には付けない
    if (d.performed_by !== undefined && d.performed_by !== null) {
      if (!PERFORMERS.includes(d.performed_by) || !['start', 'end', 'flush'].includes(d.type)) c.add('performed_by', 'BAD_CHOICE');
    }
    for (const f of ['reason', 'pump_alarm', 'action_taken', 'order_ref', 'note']) c.text(f);
    c.text('contacted', 200);
    if (d.out_of_range !== undefined && d.out_of_range !== null && typeof d.out_of_range !== 'boolean') c.add('out_of_range', 'BAD_CHOICE');
    switch (d.type) {
      case 'start': case 'rate_change': c.required('rate'); break;
      case 'volume_visual': case 'volume_pump': c.required('volume_ml'); break;
      case 'flush': c.required('flush_status'); break;
      case 'pause': if (c.required('reason')) c.oneOf('reason', PAUSE_REASONS); break;   // 閉塞・気泡・その他から選ぶ
      case 'correction':
        if (!has(d, 'corrects_seq') || !Number.isInteger(d.corrects_seq) || d.corrects_seq < 1) c.add('corrects_seq', 'OUT_OF_RANGE');
        if (c.required('field') && !CORRECTION_FIELDS.includes(d.field)) c.add('field', 'BAD_CHOICE');
        if (c.required('new_value') && !isNum(d.new_value)) c.add('new_value', 'NOT_NUMBER');
        break;
      default: break;
    }
  },

  // 日常の処分確認（ルート・バッグ）。母も記録できる。針の引き渡しは needle_handovers（管理者のみ）
  waste_records(d, c) {
    if (d.kind !== 'daily_disposal') return c.add('kind', 'BAD_KIND');
    if (c.required('disposed_on')) c.date('disposed_on');
    if (c.required('target')) c.oneOf('target', WASTE_TARGETS);
    c.text('note');
  },

  // 使用済み針の回収（訪問診療）。回収日時が必須（旧形式の handover_on だけの記録も許す）
  needle_handovers(d, c) {
    c.uuid('appointment_id'); c.date('occurrence_date'); c.uuid('corrects_id');
    c.dateTime('handover_ms'); c.date('handover_on');
    if (!has(d, 'handover_ms') && !has(d, 'handover_on')) c.add('handover_ms', 'REQUIRED');
    c.oneOf('status', HANDOVER_STATUS);
    c.text('destination', 100); c.text('note');
  },

  settings(d, c) {
    if (!c.required('key')) return;
    c.text('key', 64);
    if (d.key === 'birthday') {
      const v = d.value;
      if (v === null || v === undefined) return;                 // 登録を消す
      if (!isObj(v) || !Number.isInteger(v.month) || !Number.isInteger(v.day) || v.month < 1 || v.month > 12) return c.add('value', 'BAD_DATE');
      const maxDay = new Date(Date.UTC(2024, v.month, 0)).getUTCDate();   // 2/29 を許す（うるう年を基準）
      if (v.day < 1 || v.day > maxDay) c.add('value', 'BAD_DATE');
    }
  },
};

const has = (d, f) => d[f] !== undefined && d[f] !== null && d[f] !== '';

/**
 * @param {string} collection
 * @param {object} data   送られる内容（サーバー管理の項目を除く）
 * @param {{ nowMs?: number }} [opts]
 */
export function validateRecord(collection, data, { nowMs } = {}) {
  const errors = [];
  if (!isObj(data)) return { ok: false, errors: [{ field: '', code: 'OBJECT', message: MESSAGES.OBJECT }] };
  const allowed = ALLOWED[collection];
  if (allowed) for (const k of Object.keys(data)) if (!allowed.includes(k)) errors.push({ field: k, code: 'UNKNOWN_FIELD', message: MESSAGES.UNKNOWN_FIELD });
  const fn = VALIDATORS[collection];
  if (fn) fn(data, checker(data, errors, nowMs), nowMs);
  return { ok: errors.length === 0, errors };
}

/** サーバーの deps.validateRecord に渡す形（真偽だけ）。型の検査は保存先（GAS）の検査と併用する */
export const isValidRecord = (collection, data, nowMs = Date.now()) => validateRecord(collection, data, { nowMs }).ok;

/**
 * 誕生日の月日を数値に正規化する（全角の数字・文字列の数字も受ける）。月日として成り立たなければ null。
 * 検証（validateRecord の settings）は数値だけを受けるので、保存の前にこれを通す。
 */
export function normalizeBirthday(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const toInt = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    if (typeof v !== 'string') return null;
    const t = v.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    return /^\d{1,2}$/.test(t) ? Number(t) : null;
  };
  const month = toInt(value.month);
  const day = toInt(value.day);
  if (month === null || day === null || month < 1 || month > 12) return null;
  if (day < 1 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return null;   // 2/29 は許す（うるう年を基準）
  return { month, day };
}

/** 更新では、変更した項目だけが送られる。現在の内容に重ねてから検査する */
export const validateMerged = (collection, current, changes, opts) => validateRecord(collection, { ...current, ...changes }, opts);
