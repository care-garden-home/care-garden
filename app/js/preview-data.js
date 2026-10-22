// PC 内のプレビュー用データ（画面設計 §4 の各状態を、実データに触れずに確認するため）。
// - 通信しない・保存しない（台帳・IndexedDB・localStorage・Service Worker を使わない）。医療記録は作成・変更されない
// - 点滴の状態は、架空のイベントを既存の計算（calc.js）にかけて作る。表示の経路は本番と同じ
// - 書き込みの操作は、すべて「プレビューでは記録できません」で失敗する

const MIN = 60_000;
const HOUR = 3_600_000;
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const SCENARIOS = Object.freeze({
  none: '準備なし（開始前）',
  planned: '開始待ち',
  running: '投与中',
  paused: '一時中断',
  ended: '投与終了・終了処置待ち',
  closed: '終了処置 ✓ DONE',
  cancelled: '中止',
  history: '履歴の一覧（複数件）',
});

const FAIL = Object.freeze({ ok: false, reason: 'PREVIEW', message: 'プレビューでは記録できません' });

export function createPreviewData({ apptCount, scenario = 'running', role = 'admin', nowMs, staleSync = false, unsent = 0, rejected = false, extras = true, birthday = null } = {}) {
  const t = nowMs;
  const order = { id: uid(1), version: 1, drug_name: 'エルネオパNF2号', volume_ml: 1500, rate_min: 60, rate_max: 150, rate_step: 5, usual_rate_min: 120, usual_rate_max: 150, long_rate_min: 60, long_rate_max: 75, target_end_time: '06:00', created_ms: t - 30 * 24 * HOUR, deleted_ms: null };
  const inf = (over) => ({ id: uid(10), version: 1, order_id: order.id, drug_name: order.drug_name, volume_ml: 1500, plan_rate: 125, status: 'not_started', closure_status: 'none', created_ms: t - 20 * HOUR, deleted_ms: null, ...over });
  const ev = (n, type, atMs, extra = {}) => ({ id: uid(100 + n), version: 1, infusion_id: uid(10), seq: n, type, occurred_ms: atMs, deleted_ms: null, ...extra });

  const infusions = [];
  const events = [];
  switch (scenario) {
    case 'planned':
      infusions.push(inf({ plan_start_ms: t + 2 * HOUR + 15 * MIN, plan_target_end_ms: t + 14 * HOUR + 45 * MIN }));
      break;
    case 'running':
      infusions.push(inf({ plan_start_ms: t - 3 * HOUR }));
      events.push(ev(1, 'start', t - 3 * HOUR, { rate: 125 }), ev(2, 'volume_visual', t - HOUR, { volume_ml: 1100 }));
      break;
    case 'paused':
      infusions.push(inf({ plan_start_ms: t - 4 * HOUR }));
      events.push(ev(1, 'start', t - 4 * HOUR, { rate: 125 }), ev(2, 'pause', t - 30 * MIN, { reason: '閉塞' }));
      break;
    case 'ended':
      infusions.push(inf({ plan_start_ms: t - 13 * HOUR }));
      events.push(ev(1, 'start', t - 13 * HOUR, { rate: 125 }), ev(2, 'end', t - 10 * MIN));
      break;
    case 'closed':
      infusions.push(inf({ plan_start_ms: t - 13 * HOUR }));
      events.push(ev(1, 'start', t - 13 * HOUR, { rate: 125 }), ev(2, 'end', t - 40 * MIN), ev(3, 'flush', t - 30 * MIN, { flush_status: 'done' }));
      break;
    case 'cancelled':
      infusions.push(inf({ plan_start_ms: t + HOUR }));
      events.push(ev(1, 'cancel', t - 5 * MIN, { reason: '（プレビュー）' }));
      break;
    case 'history': {
      // 履歴の一覧の確認用：投与中・日またぎ・同日・開始前の中止・開始後の中止・先月、時刻の修正つき（すべて架空）
      let n = 1000;
      const add = (idx, createdAt, planStart, items) => {
        const id = uid(500 + idx);
        infusions.push(inf({ id, plan_start_ms: planStart, created_ms: createdAt }));
        items.forEach(([type, atMs, extra], i) => events.push({ id: uid(n++), version: 1, infusion_id: id, seq: i + 1, type, occurred_ms: atMs, created_by: 'u_admin', created_ms: atMs + MIN, deleted_ms: null, ...extra }));
      };
      const day0 = Math.floor((t + 9 * HOUR) / (24 * HOUR)) * 24 * HOUR - 9 * HOUR;   // 今日の 0:00（日本時間）
      add(1, t - 3 * HOUR, t - 3 * HOUR, [['start', t - 3 * HOUR, { rate: 125 }], ['volume_visual', t - HOUR, { volume_ml: 1100 }]]);
      add(2, day0 - 4 * HOUR, day0 - 3 * HOUR - 30 * MIN, [
        ['start', day0 - 3 * HOUR - 25 * MIN, { rate: 125 }], ['pause', day0 + 1 * HOUR, { reason: '閉塞', note: '（プレビュー）アラーム確認' }],
        ['resume', day0 + 1 * HOUR + 20 * MIN, {}], ['rate_change', day0 + 2 * HOUR, { rate: 135, rate_before: 125, reason: '（プレビュー）', out_of_range: false }],
        ['end', day0 + 6 * HOUR + 10 * MIN, {}], ['flush', day0 + 6 * HOUR + 20 * MIN, { flush_status: 'done' }],
        ['correction', day0 + 7 * HOUR, { corrects_seq: 1, field: 'occurredMs', old_value: day0 - 3 * HOUR - 25 * MIN, new_value: day0 - 3 * HOUR - 30 * MIN, reason: '（プレビュー）入力時刻のずれ' }]]);
      add(3, day0 - 3 * 24 * HOUR, day0 - 3 * 24 * HOUR + 13 * HOUR, [['start', day0 - 3 * 24 * HOUR + 13 * HOUR, { rate: 75 }], ['end', day0 - 3 * 24 * HOUR + 18 * HOUR + 45 * MIN, {}], ['flush_skip', day0 - 3 * 24 * HOUR + 19 * HOUR, { flush_status: 'not_required' }]]);
      add(4, day0 - 4 * 24 * HOUR, day0 - 4 * 24 * HOUR + 20 * HOUR, [['cancel', day0 - 4 * 24 * HOUR + 19 * HOUR, { reason: '（プレビュー）開始前に取りやめ' }]]);
      add(5, day0 - 5 * 24 * HOUR, day0 - 5 * 24 * HOUR + 21 * HOUR, [['start', day0 - 5 * 24 * HOUR + 21 * HOUR, { rate: 120 }], ['cancel', day0 - 5 * 24 * HOUR + 23 * HOUR, { reason: '（プレビュー）' }], ['flush_skip', day0 - 5 * 24 * HOUR + 23 * HOUR + 10 * MIN, { flush_status: 'not_done', reason: '（プレビュー）' }]]);
      add(6, day0 - 24 * 24 * HOUR, day0 - 24 * 24 * HOUR + 21 * HOUR, [['start', day0 - 24 * 24 * HOUR + 21 * HOUR, { rate: 120 }], ['end', day0 - 23 * 24 * HOUR + 7 * HOUR, {}], ['flush', day0 - 23 * 24 * HOUR + 7 * HOUR + 5 * MIN, { flush_status: 'done' }]]);
      break;
    }
    default: break;
  }

  const day = new Date(t + 9 * HOUR + 3 * 24 * HOUR).toISOString().slice(0, 10);
  const lists = {
    infusion_orders: [order],
    infusions,
    infusion_events: events,
    needle_changes: extras ? [{ id: uid(200), version: 1, changed_on: '2026-10-01', next_due_on: day, created_ms: t - 20 * 24 * HOUR, deleted_ms: null }] : [],
    waste_records: extras ? [{ id: uid(410), version: 1, kind: 'daily_disposal', disposed_on: new Date(t + 9 * HOUR - 24 * HOUR).toISOString().slice(0, 10), target: 'bag', created_ms: t - 24 * HOUR, deleted_ms: null }] : [],
    health_logs: extras ? [
      { id: uid(401), version: 1, logged_ms: t - 2 * HOUR, condition: 'uneasy', symptoms: ['便秘', '腹部の張り'], memo: '（プレビュー）夕食後から張る感じ', created_by: 'u_mother', created_ms: t - 2 * HOUR, deleted_ms: null },
      { id: uid(402), version: 1, logged_ms: t - 26 * HOUR, condition: 'ok', created_by: 'u_mother', created_ms: t - 26 * HOUR, deleted_ms: null },
      { id: uid(403), version: 1, logged_ms: t - 50 * HOUR, condition: 'hard', symptoms: ['頭痛', '吐き気'], created_by: 'u_admin', created_ms: t - 50 * HOUR, deleted_ms: null },
      { id: uid(404), version: 1, logged_ms: t - 74 * HOUR, condition: 'normal', created_by: 'u_mother', created_ms: t - 74 * HOUR, deleted_ms: null },
      { id: uid(405), version: 1, logged_ms: t - 100 * HOUR, temp_c: 36.6, bp_sys: 118, bp_dia: 72, pulse: 68, memo: '（プレビュー）以前の形式の記録', created_by: 'u_mother', created_ms: t - 100 * HOUR, deleted_ms: null },
    ].concat(Array.from({ length: 12 }, (_, i) => ({ id: uid(450 + i), version: 1, logged_ms: t - (5 + i) * 24 * HOUR - 3 * HOUR, condition: ['ok', 'ok', 'normal', 'ok', 'ok', 'uneasy', 'ok', 'normal', 'ok', 'ok', 'normal', 'ok'][i], created_by: 'u_mother', created_ms: t - (5 + i) * 24 * HOUR, deleted_ms: null }))) : [],
    // 予定・訪問・質問メモ（架空）。当日の予定ボタン・予定画面の確認用
    appointments: extras ? (() => {
      const day0 = Math.floor((t + 9 * HOUR) / (24 * HOUR)) * 24 * HOUR - 9 * HOUR;
      const dow = new Date(t + 9 * HOUR).getUTCDay();
      const base = { version: 1, created_by: 'u_admin', created_ms: t - 30 * 24 * HOUR, deleted_ms: null, booking: 'confirmed', recur: { freq: 'none' } };
      return [
        { ...base, id: uid(600), kind: '訪問看護', start_ms: day0 + 11 * HOUR + 20 * MIN, provider: 'さくら訪問看護ステーション', phone: '0467-12-3456', staff: '山田', recur: { freq: 'weekly', weekday: dow } },
        ...Array.from({ length: Math.max(0, (apptCount ?? 2) - 2) }, (_, i) => ({ ...base, id: uid(620 + i), kind: ['訪問診療', '訪問薬剤師', '通院', 'その他', '訪問看護'][i % 5], start_ms: day0 + (16 + i) * HOUR, provider: `（プレビュー）${i + 3}件目` })),
        { ...base, id: uid(601), kind: '訪問リハビリ', start_ms: day0 + 15 * HOUR + 30 * MIN, provider: 'みどりリハビリ', phone: '0467-23-4567' },
        { ...base, id: uid(602), kind: '通院', start_ms: day0 + 24 * HOUR + 11 * HOUR, provider: '日本赤十字社 医療センター', phone: '03-1234-5678', travel_min: 120, arrival_margin_min: 60, memo: '（プレビュー）診察券と薬手帳' },
        { ...base, id: uid(603), kind: '訪問診療', start_ms: day0 + 48 * HOUR + 14 * HOUR, provider: 'あおぞら在宅クリニック', phone: '0467-34-5678', booking: 'tentative' },
        { ...base, id: uid(604), kind: '訪問看護', series_id: uid(600), occurrence_date: new Date(day0 + 7 * 24 * HOUR + 9 * HOUR).toISOString().slice(0, 10), exception: 'cancelled', start_ms: day0 + 7 * 24 * HOUR + 11 * HOUR + 20 * MIN, provider: 'さくら訪問看護ステーション' },
        { ...base, id: uid(605), kind: '通院', start_ms: day0 - 20 * 24 * HOUR + 11 * HOUR, provider: '日本赤十字社 医療センター', travel_min: 120, arrival_margin_min: 60 },
      ].filter((a) => !(apptCount === 1 && a.id === uid(601)));
    })() : [],
    visit_notes: extras ? (() => {
      const day0 = Math.floor((t + 9 * HOUR) / (24 * HOUR)) * 24 * HOUR - 9 * HOUR - 20 * 24 * HOUR;
      return [{ id: uid(610), version: 1, appointment_id: uid(605), occurrence_date: new Date(day0 + 9 * HOUR).toISOString().slice(0, 10), outcome: 'done', created_by: 'u_mother', created_ms: day0 + 15 * HOUR, deleted_ms: null,
        trip: { depart_home_ms: day0 + 8 * HOUR + 10 * MIN, arrive_hospital_ms: day0 + 10 * HOUR + 20 * MIN, consult_start_ms: day0 + 11 * HOUR + 30 * MIN, consult_end_ms: day0 + 12 * HOUR + 10 * MIN, leave_hospital_ms: day0 + 12 * HOUR + 40 * MIN, arrive_home_ms: day0 + 14 * HOUR + 50 * MIN } }];
    })() : [],
    tasks: extras ? [
      { id: uid(700), version: 1, entry: 'question', content: '前回の血液検査の結果を教えてほしい', kind: '通院', provider: '日本赤十字社 医療センター', created_by: 'u_admin', created_ms: t - 3 * 24 * HOUR, deleted_ms: null },
      { id: uid(701), version: 1, entry: 'question', content: 'ドレッシング材の在庫は足りているか', kind: '訪問看護', provider: 'さくら訪問看護ステーション', created_by: 'u_mother', created_ms: t - 2 * 24 * HOUR, deleted_ms: null },
      { id: uid(702), version: 1, entry: 'question', content: '入浴の頻度はこのままでよいか', kind: '訪問看護', provider: 'さくら訪問看護ステーション', created_by: 'u_admin', created_ms: t - 9 * 24 * HOUR, deleted_ms: null },
      { id: uid(703), version: 1, entry: 'check', question_id: uid(702), checked: true, created_by: 'u_mother', created_ms: t - 24 * HOUR, deleted_ms: null },
    ] : [],
    settings: [
      ...(birthday ? [{ id: uid(300), version: 1, key: 'birthday', value: birthday, created_ms: t, deleted_ms: null }] : []),
      // 予定先マスタ（架空）。同じ事業者が訪問看護と訪問リハの両方を持つ例を含む
      { id: uid(310), version: 1, key: 'place:p1', value: { name: 'さくら訪問看護ステーション', kinds: ['訪問看護', '訪問リハビリ'], phone: '0467-00-0001' }, scope: 'global', created_ms: t, deleted_ms: null },
      { id: uid(311), version: 1, key: 'place:p2', value: { name: '日本赤十字社 医療センター', kinds: ['通院'], phone: '03-1234-5678', address: '（架空）東京都○○区1-2-3', travel_min: 120, arrival_margin_min: 60 }, scope: 'global', created_ms: t, deleted_ms: null },
      { id: uid(312), version: 1, key: 'place:p3', value: { name: 'あおぞら在宅クリニック', kinds: ['訪問診療'], phone: '0467-00-0003' }, scope: 'global', created_ms: t, deleted_ms: null },
    ],
    needle_handovers: extras ? [{ id: uid(420), version: 1, status: 'handed_over', handover_on: new Date(t + 9 * HOUR - 4 * 24 * HOUR).toISOString().slice(0, 10), destination: '訪問診療', created_ms: t - 4 * 24 * HOUR, deleted_ms: null }] : [],
  };

  return {
    preview: true,
    role,
    userId: role === 'admin' ? 'u_admin' : 'u_mother',
    hasToken: true,
    get lastSyncMs() { return staleSync ? t - 40 * MIN : t - 2 * MIN; },
    syncState: 'idle',
    counts: { unsent, conflict: 0, rejected: rejected ? 1 : 0, authRequired: 0, confirmed: 0 },
    subscribe: () => () => {},
    list: (c) => structuredClone(lists[c] ?? []),
    get: (c, id) => (lists[c] ?? []).find((d) => d.id === id) ?? null,
    init: async () => {},
    sync: async () => ({ ok: true }),
    flush: async () => 0,
    save: async () => FAIL,
    createRecord: async () => FAIL,
    updateRecord: async () => FAIL,
    softDelete: async () => FAIL,
    appendEvent: async () => FAIL,
    call: async () => null,
    allOps: async () => [],
    dismiss: async () => {},
    retryNow: async () => {},
    signOut: () => {},
    ledger: null,
  };
}
