// 通院の出発目安と、当日の実績・所要時間（daily-ops-design §7）。純粋関数。
//
// - 出発目安は、設定した移動時間に基づく目安であり、実際の交通状況や渋滞を反映した予測ではない
// - 実績の所要時間は、**両端の時刻がそろった区間だけ**計算する。未入力の時刻から推測して確定値にしない
// - 過去の実績は「参考」として示すだけ。次回の所要時間を保証せず、出発目安の計算には自動では使わない

const MIN = 60_000;

export const DEFAULT_ARRIVAL_MARGIN_MIN = 60;   // 日赤など：診療予約の60分前に到着

/** 到着目標＝診療予約−到着余裕、出発目安＝到着目標−移動時間 */
export function departureGuide({ appointmentMs, arrivalMarginMin = DEFAULT_ARRIVAL_MARGIN_MIN, travelMin }) {
  if (!Number.isFinite(appointmentMs)) return { ok: false, error: 'APPOINTMENT_INVALID' };
  if (!Number.isFinite(arrivalMarginMin) || arrivalMarginMin < 0) return { ok: false, error: 'MARGIN_INVALID' };
  if (!Number.isFinite(travelMin) || travelMin < 0) return { ok: false, error: 'TRAVEL_INVALID' };
  const arriveByMs = appointmentMs - arrivalMarginMin * MIN;
  return { ok: true, arriveByMs, departByMs: arriveByMs - travelMin * MIN, arrivalMarginMin, travelMin };
}

const SEGMENTS = [
  ['outbound', 'depart_home_ms', 'arrive_hospital_ms'],   // 往路
  ['consult', 'consult_start_ms', 'consult_end_ms'],      // 診療
  ['stay', 'arrive_hospital_ms', 'leave_hospital_ms'],    // 病院での滞在
  ['inbound', 'leave_hospital_ms', 'arrive_home_ms'],     // 帰路
  ['total', 'depart_home_ms', 'arrive_home_ms'],          // 通院全体
];

/** 区間ごとの所要時間（ms）。両端がそろい、終了≧開始のものだけ数を返し、それ以外は null（推測しない） */
export function tripDurations(trip) {
  const out = {};
  for (const [name, a, b] of SEGMENTS) {
    const x = trip?.[a]; const y = trip?.[b];
    out[name] = Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
  }
  return out;
}

const median = (xs) => { const s = [...xs].sort((p, q) => p - q); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/**
 * 過去の実績（trip の配列）から、区間ごとの参考値（件数・中央値・最短・最長）。実績がなければ null。
 * これは参考であり、次回の所要時間を保証しない。
 */
export function referenceStats(trips) {
  const out = {};
  for (const [name] of SEGMENTS) {
    const values = trips.map((t) => tripDurations(t)[name]).filter((v) => v !== null);
    out[name] = values.length ? { n: values.length, medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values) } : null;
  }
  return out;
}
