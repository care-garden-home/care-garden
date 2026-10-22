// 繰り返し予定の展開（daily-ops-design §5）。純粋関数。DOM・通信・時計に依存しない。
//
// - 繰り返しの予定は「規則を持った1件」だけを保存し、各回は、ここで計算して並べる
// - 1回分の変更・中止は、別の1件（series_id と occurrence_date と exception を持つ予定）として保存される。元の繰り返しの設定は変えない
// - 日付は日本時間。回の識別は `${series.id}:${YYYY-MM-DD}`

const JST = 9 * 3_600_000;
const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
export const dateOf = (ms) => { const d = new Date(ms + JST); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const partsOf = (dateText) => { const [y, m, d] = dateText.split('-').map(Number); return { y, m, d }; };
const dayStartMs = (dateText) => { const { y, m, d } = partsOf(dateText); return Date.UTC(y, m - 1, d) - JST; };
const weekdayOf = (dateText) => { const { y, m, d } = partsOf(dateText); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (dateText, n) => dateOf(dayStartMs(dateText) + n * DAY);
const timeOfDayMs = (ms) => ((ms + JST) % DAY + DAY) % DAY;

export const occurrenceKey = (seriesId, date) => `${seriesId}:${date}`;

/**
 * 規則から、期間 [fromMs, toMs) に入る各回の日付を返す。
 *  none：開始の日だけ ／ daily：毎日 ／ weekly：weekday（0＝日曜）の日 ／ monthly：毎月 day 日
 *  毎月で、その月に day 日がない場合（例：31日の2月）は、その月の末日にする
 *  最初の回は開始の日以降。until（日付）を含む日まで
 */
export function occurrenceDates(series, fromMs, toMs) {
  const recur = series.recur ?? { freq: 'none' };
  const startDate = dateOf(series.start_ms);
  const out = [];
  const lastDate = recur.until && recur.until < dateOf(toMs - 1) ? recur.until : dateOf(toMs - 1);
  if (toMs <= fromMs) return out;
  const inRange = (date) => date >= startDate && date <= lastDate && dayStartMs(date) + DAY > fromMs;
  switch (recur.freq) {
    case 'daily': {
      for (let d = startDate < dateOf(fromMs) ? dateOf(fromMs) : startDate; d <= lastDate; d = addDays(d, 1)) if (inRange(d)) out.push(d);
      break;
    }
    case 'weekly': {
      let d = startDate < dateOf(fromMs) ? dateOf(fromMs) : startDate;
      while (weekdayOf(d) !== recur.weekday) d = addDays(d, 1);
      for (; d <= lastDate; d = addDays(d, 7)) if (inRange(d)) out.push(d);
      break;
    }
    case 'monthly': {
      const s = partsOf(startDate);
      let y = s.y; let m = s.m;
      for (;;) {
        const d = `${y}-${pad(m)}-${pad(Math.min(recur.day, daysInMonth(y, m)))}`;
        if (d > lastDate) break;
        if (inRange(d)) out.push(d);
        m += 1; if (m > 12) { m = 1; y += 1; }
        if (y > s.y + 20) break;   // 無限ループの防止
      }
      break;
    }
    default:
      if (inRange(startDate)) out.push(startDate);
  }
  return out;
}

/** 同じ回への例外が複数あれば、新しい方（作成が後）を採用する */
function latest(a, b) { return (b.created_ms ?? 0) >= (a.created_ms ?? 0) ? b : a; }

/**
 * 期間 [fromMs, toMs) の各回を、開始時刻順に返す。
 * @param {object[]} appointments  appointments の記録（元の予定と、1回分の例外の両方。削除済みは除いて渡す）
 * @returns {{ key, seriesId, date, startMs, endMs, status:'normal'|'changed'|'cancelled', appt, exception }[]}
 *   appt：その回に適用される内容（元の予定に、変更の例外を重ねたもの）
 */
export function expandOccurrences(appointments, fromMs, toMs) {
  const series = appointments.filter((a) => !a.exception);
  const exceptions = new Map();
  for (const a of appointments) {
    if (!a.exception || !a.series_id || !a.occurrence_date) continue;
    const k = occurrenceKey(a.series_id, a.occurrence_date);
    exceptions.set(k, exceptions.has(k) ? latest(exceptions.get(k), a) : a);
  }
  const out = [];
  for (const s of series) {
    const todMs = timeOfDayMs(s.start_ms);
    const length = isFinite(s.end_ms) && s.end_ms >= s.start_ms ? s.end_ms - s.start_ms : null;
    for (const date of occurrenceDates(s, fromMs, toMs)) {
      const key = occurrenceKey(s.id, date);
      const ex = exceptions.get(key) ?? null;
      let appt = { ...s };
      let startMs = dayStartMs(date) + todMs;
      let endMs = length === null ? null : startMs + length;
      let status = 'normal';
      if (ex?.exception === 'changed') {
        appt = { ...s, ...ex, id: s.id, recur: s.recur, exception: undefined, series_id: undefined };
        startMs = ex.start_ms; endMs = ex.end_ms ?? null; status = 'changed';
      } else if (ex?.exception === 'cancelled') status = 'cancelled';
      if (startMs >= toMs || (endMs ?? startMs) < fromMs) continue;   // 変更で期間の外へ動いた回
      out.push({ key, seriesId: s.id, date, startMs, endMs, status, appt, exception: ex });
    }
  }
  // 別の日へ移した変更が、期間の内側に入る場合（元の日付は期間の外）も拾う
  for (const [key, ex] of exceptions) {
    if (ex.exception !== 'changed' || out.some((o) => o.key === key)) continue;
    const s = series.find((x) => x.id === ex.series_id);
    if (!s || ex.start_ms < fromMs || ex.start_ms >= toMs) continue;
    out.push({ key, seriesId: s.id, date: ex.occurrence_date, startMs: ex.start_ms, endMs: ex.end_ms ?? null, status: 'changed',
      appt: { ...s, ...ex, id: s.id, recur: s.recur, exception: undefined, series_id: undefined }, exception: ex });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
}

/** その日（日本時間）の、中止でない予定 */
export function todaysOccurrences(appointments, nowMs) {
  const start = dayStartMs(dateOf(nowMs));
  return expandOccurrences(appointments, start, start + DAY).filter((o) => o.status !== 'cancelled');
}
