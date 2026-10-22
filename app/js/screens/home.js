// HOME：庭園の背景（全画面）の上に、下部の「情報パネル」と下部ナビだけを重ねる。上部の独立したヘッダーはない（庭園を上から下まで広く見せる）。
// 情報パネルの構成：
//   1段目  日付・曜日／点滴の状態／同期の操作（試用版・試験環境の表示もここ）
//   2段目  本日の訪問予定（0件なら出さない／1〜2件はチップ／3件以上は2件＋「ほか○件」）
//   3段目  点滴の状態に応じた情報
//   最下段 状態に応じた操作ボタン
// 状態の遷移・記録の内容・終了処置の意味（DONE＝実施済み／FORGET＝実施したか不明）は、点滴画面と同じ。

import { h, clear, fmtDuration, fmtDateShort, fmtWhen, icon, confirmSheet } from '../ui.js';
import { currentInfusion, currentOrder } from '../infusion-state.js';
import { todaysOccurrences, appointmentsOf, styleOf, shortKind } from '../schedule-view.js';
import { syncInfo } from '../status-bar.js';
import { quickClosure, closureSheet, acknowledgeForgot, FORGOT_LINES } from './infusion.js';

const STALE_SYNC_MS = 30 * 60_000;
const MAX_CHIPS = 2;   // 予定のチップは2件まで。3件以上は「ほか○件」で、予定の画面へ

const hhmm = (ms) => { const d = new Date(ms + 9 * 3_600_000); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

/** 状態に応じた操作ボタン（button 要素の配列） */
function actionsFor(ctx, cur) {
  const { nav } = ctx;
  const go = (intent) => nav('infusion', { intent, id: cur?.infusion.id });
  const btn = (label, fn, cls = 'btn btn-sage') => h('button', { class: cls, type: 'button', on: { click: fn } }, label);
  if (!cur) return [btn('点滴を準備', () => go('prepare'))];
  const order = currentOrder(ctx.data, ctx.now());
  const unknownClosure = cur.calc?.closureStatus === 'unknown';
  switch (cur.view.key) {
    case 'not_started': return [btn('点滴を始める', () => go('start'))];
    case 'running': return [btn('残量を記録', () => go('visual')), btn('点滴を終了', () => go('end'))];
    case 'paused': return [btn('再開する', () => go('resume')), btn('点滴を終了', () => go('end'))];
    case 'ended_pending': return [   // 終了処置：押したらその場で記録（確認画面なし）。意味は点滴画面と同じ
      btn('✓ DONE', async () => { const r = await quickClosure(ctx, cur, order, 'done'); if (r.ok) ctx.refresh(); }),
      btn('? FORGET', async () => { const r = await quickClosure(ctx, cur, order, 'forget'); if (r.ok) ctx.refresh(); }, 'btn btn-forget-home')];
    default:
      if (unknownClosure) return [btn('実施を確認できた（DONE に訂正）', () => closureSheet(ctx, cur, order, true), 'btn btn-sage'), btn('次の点滴を準備', async () => {   // FORGET のまま次へは、確認してから（無条件には進めない）
        if (!await confirmSheet({ title: '次の点滴を準備しますか？', lines: FORGOT_LINES, okLabel: 'このまま準備する' })) return;
        acknowledgeForgot(cur.infusion.id); go('prepare');
      }, 'btn btn-quiet')];
      return [btn('次の点滴を準備', () => go('prepare'))];   // 完了・中止のあと
  }
}

/** 3段目：状態に応じた情報 */
function infoFor(ctx, cur, t) {
  const rows = [];
  if (!cur) { rows.push(h('p', { class: 'muted hm-note' }, '次の点滴はまだ準備されていません')); return rows; }
  const { view, calc, infusion } = cur;
  if (view.key === 'running' && calc.estEndMs) {
    rows.push(h('div', { class: 'hm-end' }, h('span', { class: 'k' }, '終了予定（推定）'), h('span', { class: 'hm-val' }, fmtWhen(calc.estEndMs)),
      h('span', { class: 'hm-sub' }, calc.overdue ? '予定の時刻を過ぎています' : `のこり 約 ${fmtDuration(calc.remainingMs)}`)));
    if (ctx.data.lastSyncMs && t - ctx.data.lastSyncMs > STALE_SYNC_MS) rows.push(h('p', { class: 'note hm-note' }, '相手の端末の最新の操作が、まだ反映されていない可能性があります'));
  } else if (view.key === 'paused') {
    rows.push(h('div', { class: 'hm-row' }, h('span', { class: 'k' }, '再開後（推定）'), h('span', { class: 'hm-val' }, `約 ${fmtDuration(calc.remainingMs)}`)));
  } else if (view.key === 'not_started') {
    rows.push(h('div', { class: 'hm-row' }, h('span', { class: 'k' }, '開始予定'), h('span', { class: 'hm-val' }, infusion.plan_start_ms ? fmtWhen(infusion.plan_start_ms) : '未設定')));
  } else if (calc?.endedMs) {
    rows.push(h('div', { class: 'hm-row' }, h('span', { class: 'k' }, '点滴の終了'), h('span', { class: 'hm-val' }, fmtWhen(calc.endedMs))));
    if (view.key === 'closed' && calc.closureStatus === 'unknown') rows.push(h('p', { class: 'note hm-note' }, '終了処置を実施したか、確認が必要です'));
  }
  return rows;
}

export function renderHome(root, ctx) {
  const { data, nav, now } = ctx;
  const t = now();
  const cur = currentInfusion(data, t);
  clear(root);

  const panel = h('section', { class: 'panel hm-panel', 'aria-label': '点滴と今日の予定' });

  // ---- 1段目：日付・曜日／点滴の状態／同期 ----
  const view = cur?.view ?? { key: 'none', label: '未開始', mark: '○', cls: 'st-idle' };
  // 1段目に収まるよう、HOME では短い名前にする（終了処置：DONE＝実施済み／FORGET＝実施したか不明）
  const closure = cur?.calc?.closureStatus;
  const stateLabel = view.key === 'ended_pending' ? '処置待ち'
    : view.key === 'closed' ? ({ done: '✓ DONE', unknown: '? FORGET', not_required: '処置 不要' }[closure] ?? (view.short ?? view.label))
    : (view.short ?? view.label);
  const s = syncInfo(data);
  const mode = document.body.classList.contains('is-preview') ? 'プレビュー' : document.body.classList.contains('is-mock') ? '試験環境' : null;
  panel.append(h('div', { class: 'hm-top' },
    h('span', { class: 'hm-date' }, fmtDateShort(t)),
    h('button', { class: 'link hm-head', type: 'button', on: { click: () => nav('infusion') }, 'aria-label': `点滴の画面を開く（${view.label}）` },
      h('span', { class: `state ${view.cls}` }, h('span', { 'aria-hidden': 'true' }, view.mark), stateLabel)),
    mode ? h('span', { class: 'hm-mode' }, mode) : null,
    h('button', { class: `hm-sync${s.level ? ` ${s.level}` : ''}${s.busy ? ' busy' : ''}`, type: 'button', 'aria-label': '最新の記録を取得する', on: { click: () => ctx.syncNow() } },
      s.alertIcon ? icon('alert', 'sm') : null, s.text, icon('refresh', 'sm'))));

  // ---- 2段目：本日の訪問予定 ----
  const appts = data.hasToken ? todaysOccurrences(appointmentsOf(data), t) : [];
  if (appts.length) {
    const chip = (o) => { const [bg, fg] = styleOf(o.appt.kind); return h('button', { class: 'hm-appt', type: 'button', style: `background:${bg};color:${fg}`, on: { click: () => nav('schedule', { open: o.key }) } }, `${shortKind(o.appt.kind)} ${hhmm(o.startMs)}`); };
    const shown = appts.slice(0, MAX_CHIPS).map(chip);
    if (appts.length > MAX_CHIPS) shown.push(h('button', { class: 'hm-appt hm-more', type: 'button', on: { click: () => nav('schedule') } }, `ほか ${appts.length - MAX_CHIPS}件`));
    panel.append(h('div', { class: 'hm-appts', role: 'list', 'aria-label': 'きょうの予定' }, ...shown));
  }

  // ---- 3段目・最下段 ----
  panel.append(...infoFor(ctx, cur, t));
  const buttons = actionsFor(ctx, cur);
  panel.append(h('div', { class: `hm-actions${buttons.length === 1 ? ' one' : ''}` }, ...buttons));

  root.append(panel);
}
