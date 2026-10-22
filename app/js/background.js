// HOME の背景を決める純粋関数（画面設計 §8）。DOM・通信・時計に依存しない。
//
// - 時間帯：朝 05:00〜10:59／昼 11:00〜16:59／夕 17:00〜19:59／夜 20:00〜04:59（日本時間）
// - 背景の日付：現在の時刻から5時間を引いた日付。0:00〜4:59 は前日の「夜」の背景を保つ
// - 優先の順位：誕生日 → 祝日の専用背景 → 季節の行事 → 通常（曜日 × 時間帯）
// - 祝日は現在の祝日法の規則で計算する（振替休日・国民の休日を含む）。外部の API は呼ばない

const JST_MS = 9 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const WEEKDAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
export const SLOT_KEYS = Object.freeze(['morning', 'noon', 'evening', 'night']);

/** 春分・秋分を官報の公表で上書きする表（年 → 日）。計算式の結果と食い違った年だけを書く */
export const EQUINOX_OVERRIDES = Object.freeze({ spring: {}, autumn: {} });

/** 特例の年の移動（年 → 月日）。2020・2021年は東京オリンピックのため海の日・スポーツの日・山の日が動いた */
export const MOVED_HOLIDAYS = Object.freeze({
  2020: { marine: [7, 23], sports: [7, 24], mountain: [8, 10] },
  2021: { marine: [7, 22], sports: [7, 23], mountain: [8, 8] },
});

/** 専用の背景がある特別な日の ID（背景の定義ファイルの ID と同じ） */
export const SPECIAL_IDS = Object.freeze([
  'newyear', 'comingofage', 'foundation', 'springequinox', 'showa', 'greenery', 'childrens',
  'marine', 'mountain', 'respect', 'autumnequinox', 'sports', 'culture', 'labor', 'christmas', 'birthday',
]);

// ---- 日付の部品（すべて日本時間の暦。月は 1〜12） ----

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** UTC のミリ秒から、日本時間の暦の部分を取り出す */
export function jstParts(ms) {
  const d = new Date(ms + JST_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay(),
  };
}

/** 暦の日付の曜日（0＝日曜）。時刻・時差に左右されない */
export function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** その月の第 n 月曜日の日 */
export function nthMonday(year, month, n) {
  const first = weekdayOf(year, month, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

/** 春分の日（1980〜2099 年の近似式。表で上書きできる） */
export function springEquinoxDay(year) {
  const o = EQUINOX_OVERRIDES.spring[year];
  if (o) return o;
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日（同上） */
export function autumnEquinoxDay(year) {
  const o = EQUINOX_OVERRIDES.autumn[year];
  if (o) return o;
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

// ---- 祝日 ----

/**
 * その年の祝日の表。キー＝'YYYY-MM-DD'、値＝{ name, special }。
 * special は専用の背景の ID。専用の背景のない祝日（天皇誕生日・憲法記念日・振替休日・国民の休日）は null。
 * 対象は 2007 年以降（みどりの日・昭和の日の現行の規則）。
 */
export function holidaysOf(year) {
  const table = new Map();
  const moved = MOVED_HOLIDAYS[year] ?? {};
  const add = (month, day, name, special) => table.set(dateKey(year, month, day), { name, special });

  add(1, 1, '元日', 'newyear');
  add(1, nthMonday(year, 1, 2), '成人の日', 'comingofage');
  add(2, 11, '建国記念の日', 'foundation');
  if (year >= 2020) add(2, 23, '天皇誕生日', null);
  add(3, springEquinoxDay(year), '春分の日', 'springequinox');
  add(4, 29, '昭和の日', 'showa');
  add(5, 3, '憲法記念日', null);
  add(5, 4, 'みどりの日', 'greenery');
  add(5, 5, 'こどもの日', 'childrens');
  if (moved.marine) add(moved.marine[0], moved.marine[1], '海の日', 'marine');
  else add(7, nthMonday(year, 7, 3), '海の日', 'marine');
  if (moved.mountain) add(moved.mountain[0], moved.mountain[1], '山の日', 'mountain');
  else if (year >= 2016) add(8, 11, '山の日', 'mountain');
  add(9, nthMonday(year, 9, 3), '敬老の日', 'respect');
  add(9, autumnEquinoxDay(year), '秋分の日', 'autumnequinox');
  if (moved.sports) add(moved.sports[0], moved.sports[1], 'スポーツの日', 'sports');
  else add(10, nthMonday(year, 10, 2), 'スポーツの日', 'sports');
  add(11, 3, '文化の日', 'culture');
  add(11, 23, '勤労感謝の日', 'labor');

  // 振替休日：祝日が日曜なら、その後の最初の祝日でない日（月曜以降）
  const base = [...table.keys()].sort();
  for (const key of base) {
    const [y, m, d] = key.split('-').map(Number);
    if (weekdayOf(y, m, d) !== 0) continue;
    let ms = Date.UTC(y, m - 1, d) + DAY_MS;
    for (;;) {
      const dt = new Date(ms);
      const k = dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      if (!table.has(k)) { if (dt.getUTCFullYear() === year) table.set(k, { name: '振替休日', special: null }); break; }
      ms += DAY_MS;
    }
  }

  // 国民の休日：前日と翌日がどちらも祝日で、日曜でない日（振替休日の確定後に判定する）
  for (let m = 1; m <= 12; m++) {
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const k = dateKey(year, m, d);
      if (table.has(k) || weekdayOf(year, m, d) === 0) continue;
      const prev = new Date(Date.UTC(year, m - 1, d) - DAY_MS);
      const next = new Date(Date.UTC(year, m - 1, d) + DAY_MS);
      const kp = dateKey(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
      const kn = dateKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
      if (table.has(kp) && table.has(kn)) table.set(k, { name: '国民の休日', special: null });
    }
  }
  return table;
}

/** その日が祝日か。祝日なら { name, special } */
export function holidayOn(year, month, day) {
  return holidaysOf(year).get(dateKey(year, month, day)) ?? null;
}

// ---- 背景の判定 ----

/** 日本時間の時刻から、時間帯のキー */
export function slotOfHour(hour) {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'noon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

/** 背景の日付（現在の時刻 − 5 時間の、日本時間の日付）。曜日・特別な日の判定はこれで行う */
export function backgroundDate(nowMs) {
  const p = jstParts(nowMs - 5 * HOUR_MS);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

function birthdayMatches(date, birthday) {
  if (!birthday) return false;
  const month = Number(birthday.month);
  const day = Number(birthday.day);
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (month === 2 && day === 29 && !isLeap(date.year)) return date.month === 2 && date.day === 28;   // うるう日の誕生日は平年の 2/28
  return date.month === month && date.day === day;
}

/**
 * 背景を決める。
 * @param {number} nowMs 現在（UTC ミリ秒）
 * @param {{ birthday?: { month: number, day: number } | null }} [settings]
 * @returns {{ id: string, kind: 'special'|'normal', reason: string }}
 *   id：通常は '{mon..sun}-{morning|noon|evening|night}'、特別は SPECIAL_IDS のどれか
 */
export function pickBackground(nowMs, settings = {}) {
  const date = backgroundDate(nowMs);

  if (birthdayMatches(date, settings?.birthday)) return { id: 'birthday', kind: 'special', reason: 'birthday' };

  const holiday = holidayOn(date.year, date.month, date.day);
  if (holiday?.special) return { id: holiday.special, kind: 'special', reason: `holiday:${holiday.name}` };

  // 季節の行事（元日は祝日の規則で 1/1 が先に決まる。1/2・1/3 はここ）
  if (date.month === 1 && date.day >= 1 && date.day <= 3) return { id: 'newyear', kind: 'special', reason: 'season:newyear' };
  if (date.month === 12 && (date.day === 24 || date.day === 25)) return { id: 'christmas', kind: 'special', reason: 'season:christmas' };

  const slot = slotOfHour(jstParts(nowMs).hour);
  return { id: `${WEEKDAY_KEYS[date.weekday]}-${slot}`, kind: 'normal', reason: holiday ? `normal:${holiday.name}` : 'normal' };
}

/** 次に背景を判定し直す時刻（UTC ミリ秒）。時間帯の境目（5・11・17・20 時）と、背景の日付が変わる 5:00 */
export function nextBoundaryMs(nowMs) {
  const p = jstParts(nowMs);
  const todayStart = nowMs - ((p.hour * 60 + p.minute) * 60_000) - (new Date(nowMs + JST_MS).getUTCSeconds() * 1000) - new Date(nowMs + JST_MS).getUTCMilliseconds();
  for (const h of [5, 11, 17, 20]) {
    const t = todayStart + h * HOUR_MS;
    if (t > nowMs) return t;
  }
  return todayStart + DAY_MS + 5 * HOUR_MS;
}
