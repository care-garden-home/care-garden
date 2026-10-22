// HOME：背景（全画面）の上に、ヘッダー・点滴パネル・ナビを重ねる（画面設計 §4）。操作は横2列（点滴の主操作／体調を記録）。
// 詳しい情報は点滴・記録の画面に置く。要件§4-1 の項目は1行ずつ残す。

import { h, clear, fmtDuration, fmtDateShort, fmtWhen } from '../ui.js';
import { currentInfusion } from '../infusion-state.js';

const STALE_SYNC_MS = 30 * 60_000;

/** 点滴パネルの主操作（画面設計 §4 の表）。intent は点滴画面へ渡す */
function primaryAction(view) {
  switch (view.key) {
    case 'not_started': return { label: '点滴を始める', intent: 'start' };
    case 'running': return { label: '残量を記録', intent: 'visual' };
    case 'paused': return { label: '再開する', intent: 'resume' };
    case 'ended_pending': return { label: '終了処置', intent: 'flush' };   // 既存の終了処置の記録画面へ。実施の方法・必要性はアプリが判断しない
    default: return { label: '点滴を準備', intent: 'prepare' };
  }
}

export function renderHome(root, ctx) {
  const { data, nav, now } = ctx;
  const t = now();
  const cur = currentInfusion(data, t);
  clear(root);

  // ---- ③ 点滴パネル ----
  const panel = h('section', { class: 'panel hm-panel', 'aria-label': '点滴' });
  if (!cur) {
    panel.append(
      h('div', { class: 'state st-idle' }, h('span', { 'aria-hidden': 'true' }, '○'), '未開始'),
      h('p', { class: 'muted hm-note' }, '次の点滴はまだ準備されていません'));
  } else {
    const { view, calc, infusion } = cur;
    // 狭い画面でバッジが折り返さないよう、HOME では終了処置待ちの表示を短くする
    const label = view.key === 'ended_pending' ? '投与終了・処置待ち' : (view.short ?? view.label);
    const head = h('button', { class: 'link hm-head', type: 'button', on: { click: () => nav('infusion') }, 'aria-label': `点滴の画面を開く（${view.label}）` },
      h('span', { class: `state ${view.cls}` }, h('span', { 'aria-hidden': 'true' }, view.mark), label));
    panel.append(head);
    if (view.key === 'running' && calc.estEndMs) {
      // 終了予定の日時は大きく。のこり時間は、プレッシャーにならないよう小さな補足にする
      head.append(h('span', { class: 'hm-sub' }, calc.overdue ? '予定の時刻を過ぎています' : `のこり 約 ${fmtDuration(calc.remainingMs)}`));
      panel.append(h('div', { class: 'hm-end' }, h('span', { class: 'k' }, '終了予定（推定）'), h('span', { class: 'hm-val' }, fmtWhen(calc.estEndMs))));
    } else if (view.key === 'paused') {
      panel.append(h('div', { class: 'hm-row' }, h('span', { class: 'k' }, '再開後（推定）'), h('span', { class: 'hm-val' }, `約 ${fmtDuration(calc.remainingMs)}`)));
    } else if (view.key === 'not_started') {
      const startMs = infusion.plan_start_ms;
      panel.append(h('div', { class: 'hm-row' }, h('span', { class: 'k' }, '開始予定'), h('span', { class: 'hm-val' }, startMs ? fmtWhen(startMs) : '未設定')));
    }
    // 終了日時は、状態バッジの右横に小さく（独立した行にしない）
    if (['ended_pending', 'closed', 'cancelled'].includes(view.key) && calc?.endedMs) {
      head.append(h('span', { class: 'hm-sub' }, `終了 ${fmtWhen(calc.endedMs)}`));
    }
    if (view.key === 'running' && ctx.data.lastSyncMs && t - ctx.data.lastSyncMs > STALE_SYNC_MS) {
      panel.append(h('p', { class: 'note hm-note' }, '相手の端末の最新の操作が、まだ反映されていない可能性があります'));
    }
  }

  // 針交換日・質問の件数・当日の予定は、HOME に詰め込まない（予定はヘッダーの日付の横、そのほかは予定詳細・記録画面）

  // ---- ⑤ 操作：点滴の状態に応じた主要ボタン。投与中・中断中は「点滴を終了」を並べる。「体調を記録」は記録タブから ----
  const act = primaryAction(cur?.view ?? { key: 'none' });
  const go = (intent) => nav('infusion', { intent, id: cur?.infusion.id });
  const buttons = [h('button', { class: 'btn btn-sage', type: 'button', on: { click: () => go(act.intent) } }, act.label)];
  if (cur && (cur.view.key === 'running' || cur.view.key === 'paused')) buttons.push(h('button', { class: 'btn btn-sage', type: 'button', on: { click: () => go('end') } }, '点滴を終了'));
  panel.append(h('div', { class: `hm-actions${buttons.length === 1 ? ' one' : ''}` }, ...buttons));

  root.append(panel);
}
