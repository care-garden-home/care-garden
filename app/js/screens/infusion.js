// 点滴の画面（画面設計 §5、設計 §7-4・§8）。要件§5 の機能をすべて含む。
//   準備（逆算）→ 開始 → 投与中（残量・流量変更・中断・再開）→ 終了 → ヘパリンフラッシュの確認 → 履歴・時刻の修正・中止
// 計算は calc.js、状態は infusion-state.js。ここは入力と確認画面と、記録の送信（データ層）だけ。
// 推定値は「推定」と明示する。アプリは医療上の判断をしない（指示範囲外は警告と確認、手順は医療者の指示を表示するだけ）。

import { h, why, clear, openSheet, confirmSheet, toast, previewBlocked, fmtWhen, fmtDate, fmtTime, fmtTimeAmPm, fmtDuration, fmtDateShort, toDateInput, icon } from '../ui.js';
import { textField, numberField, selectField, dateTimeField, choiceField, showErrors } from '../forms.js';
import { currentInfusion, currentOrder, toCalcEvent, toCalcOrder, describe, STATE_VIEW } from '../infusion-state.js';
import { planStart, planEnd, validateRate, validateVolume, estimate, appendCheck, nextJstTime, durationMs } from '../../../src/infusion/calc.js';
import { validateRecord, PAUSE_REASONS } from '../../../src/validation/records.js';
import { suggestRate } from '../../../src/infusion/suggest.js';

const DEFAULTS = { drugName: 'エルネオパNF2号', volumeMl: 1500, rateMin: 60, rateMax: 150, rateStep: 5, endHour: 6, endMinute: 0 };

const ERROR_TEXT = {
  RATE_NOT_NUMBER: '流量を数字で入力してください',
  RATE_NOT_POSITIVE: '流量は0より大きい数にしてください',
  RATE_NOT_STEP: '流量は設定の刻み（5mL/h ごと）で入力してください',
  VOLUME_NOT_NUMBER: '容量を数字で入力してください',
  VOLUME_NOT_POSITIVE: '容量は0より大きい数にしてください',
  TARGET_END_INVALID: '終了希望の日時を入力してください',
  EVENT_ORDER_INVALID: 'この時刻は、前の操作より前になっています。時刻を確かめてください',
  EVENT_BEFORE_START: 'まだ開始していません',
  EVENT_AFTER_FINISH: 'すでに終了しています',
  INVALID_TRANSITION: 'いまの状態では、この操作はできません',
  FLUSH_BEFORE_FINISH: 'まだ点滴が終了していません',
  FLUSH_ALREADY_DONE: 'フラッシュは記録済みです',
  VOLUME_OBSERVED_INVALID: '残量を正しく入力してください',
};
const errText = (code) => ERROR_TEXT[code] ?? `入力を確かめてください（${code}）`;

const CONTACT = [['none', '未連絡'], ['done', '連絡済み'], ['not_needed', '連絡不要']];
const CONTACT_LABEL = Object.fromEntries(CONTACT);

export function register(registerScreen, ctx) {
  registerScreen('infusion', (root, c) => renderInfusion(root, c));
}

let mode = { view: 'main' };

function renderInfusion(root, ctx) {
  const { data, now, params } = ctx;
  const t = now();
  const intent = params?.intent;
  if (params?.intent === 'history') mode = { view: 'history', open: new Set() };   // プレビューから履歴を直接開く
  if (params?.intent) params.intent = null;            // 意図は一度だけ使う

  if (mode.view === 'history') return renderHistory(root, ctx);
  if (mode.view === 'detail') return renderDetail(root, ctx, mode.id);

  const order = currentOrder(data, t);
  const cur = currentInfusion(data, t);
  const key = cur?.view.key ?? 'none';
  clear(root);

  root.append(h('div', { class: 'toolbar' },
    h('button', { class: 'link', type: 'button', on: { click: () => { mode = { view: 'history', open: new Set() }; ctx.nav('infusion'); } } }, '履歴'),
    cur ? h('button', { class: 'link', type: 'button', on: { click: () => { mode = { view: 'detail', id: cur.infusion.id }; ctx.nav('infusion'); } } }, 'この点滴の記録') : null));

  if (!cur || key === 'closed' || key === 'cancelled') {
    if (cur) root.append(summaryPanel(cur, t, ctx, order));
    root.append(preparePanel(ctx, order));
    if (intent === 'prepare') {/* 準備の欄がそのまま見えている */}
    return;
  }

  root.append(statusPanel(cur, t, ctx));
  const { infusion, calc } = cur;

  const actions = h('div', { class: 'inf-actions' });
  root.append(actions);
  const btn = (cls, label, fn) => h('button', { class: cls, type: 'button', on: { click: fn } }, label);
  if (key === 'not_started') {
    actions.append(btn('btn', '点滴を開始する', () => startSheet(ctx, cur, order)), btn('link', 'この点滴を中止する', () => cancelSheet(ctx, cur)));
    if (intent === 'start') queueMicrotask(() => startSheet(ctx, cur, order));
  } else if (key === 'running') {
    actions.append(h('div', { class: 'row' }, btn('btn', '残量を記録', () => visualSheet(ctx, cur, order)), btn('btn', '点滴を終了', () => endSheet(ctx, cur, order))),
      btn('btn soft', '終了希望から流量を計算', () => suggestSheet(ctx, cur, order)),
      h('div', { class: 'row', style: 'margin-top:12px' }, btn('btn soft', '流量の変更を記録', () => rateSheet(ctx, cur, order)), btn('btn soft', '一時中断', () => pauseSheet(ctx, cur, order))),
      btn('link', 'この点滴を中止する', () => cancelSheet(ctx, cur)));
    if (intent === 'visual') queueMicrotask(() => visualSheet(ctx, cur, order));
    if (intent === 'end') queueMicrotask(() => endSheet(ctx, cur, order));
  } else if (key === 'paused') {
    actions.append(h('div', { class: 'row' }, btn('btn', '再開する', () => resumeSheet(ctx, cur, order)), btn('btn', '点滴を終了', () => endSheet(ctx, cur, order))),
      btn('btn soft', '終了希望から流量を計算', () => suggestSheet(ctx, cur, order)), btn('link', 'この点滴を中止する', () => cancelSheet(ctx, cur)));
    root.append(occlusionPanel(order));
    if (intent === 'resume') queueMicrotask(() => resumeSheet(ctx, cur, order));
    if (intent === 'end') queueMicrotask(() => endSheet(ctx, cur, order));
  } else if (key === 'ended_pending') {
    actions.append(btn('btn', '終了処置', () => closureSheet(ctx, cur, order)));
    if (intent === 'flush') queueMicrotask(() => closureSheet(ctx, cur, order));
  }
}

// ---------------------------------------------------------------------------
// 表示

function statusPanel(cur, t, ctx) {
  const { view, calc, infusion, events } = cur;
  const p = h('section', { class: 'panel inf-card', 'aria-label': '点滴の状態' },
    h('div', { class: 'inf-top' }, h('span', { class: `state ${view.cls}` }, h('span', { 'aria-hidden': 'true' }, view.mark), view.label)));
  const band = (label, value) => h('div', { class: 'inf-end' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value));
  const flow = (rate) => h('div', { class: 'inf-flow' }, h('span', { class: 'muted' }, '現在の流量'), h('span', { class: 'v' }, `${rate} mL/h`));
  const small = [h('div', {}, `${infusion.drug_name ?? ''}　${infusion.volume_ml ?? ''} mL`)];
  if (view.key === 'running') {
    p.append(band('終了予定（推定）', calc.estEndMs ? fmtWhen(calc.estEndMs) : '—'), flow(calc.currentRate));
    small.push(h('div', {}, `経過 ${fmtDuration(calc.elapsedMs)}　のこり（推定）${calc.overdue ? '：予定の時刻を過ぎています' : `約 ${fmtDuration(calc.remainingMs)}`}`),
      );
  } else if (view.key === 'paused') {
    p.append(band('再開したあと（推定）', `約 ${fmtDuration(calc.remainingMs)}`), flow(calc.currentRate));
    small.push(h('div', {}, `経過 ${fmtDuration(calc.elapsedMs)}`));
  } else if (view.key === 'not_started') {
    p.append(band('開始予定', infusion.plan_start_ms ? fmtWhen(infusion.plan_start_ms) : '未設定'), flow(infusion.plan_rate ?? '—'));
    if (infusion.plan_target_end_ms) small.push(h('div', {}, `終了希望 ${fmtWhen(infusion.plan_target_end_ms)}`));
  } else if (view.key === 'ended_pending') {
    p.append(band('点滴の終了', calc?.endedMs ? fmtWhen(calc.endedMs) : '—'));
  }
  p.append(h('div', { class: 'inf-small' }, ...small));
  if (view.key === 'running' && t - (ctx.data.lastSyncMs ?? 0) > 30 * 60_000) p.append(h('p', { class: 'note' }, '相手の端末の最新の操作が、まだ反映されていない可能性があります'));
  if (cur.result.checks?.outOfOrder?.length) p.append(h('p', { class: 'note', style: 'color:var(--danger)' }, '指示の範囲外の流量が記録されています'));
  if (view.key === 'running') {
    const lastCheck = [...events].reverse().find((e) => e.type === 'volume_visual' || e.type === 'volume_pump');
    const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'num', style: 'font-size:15px' }, v));
    p.append(h('details', { class: 'inf-detail' }, h('summary', {}, '詳細'), h('p', { class: 'fine' }, '推定です。実際は、ポンプの表示と医療者の指示に従ってください。'),
      calc.basis ? kv('推定の根拠', basisText(calc.basis)) : null,
      kv('最終の残量確認', lastCheck ? fmtWhen(lastCheck.occurred_ms) : 'まだありません'),
      ctx.data.lastSyncMs ? kv('最終同期', fmtWhen(ctx.data.lastSyncMs)) : null));
  }
  return p;
}

const basisText = (b) => ({ start: '開始', visual: `${fmtTimeAmPm(b.atMs)} 残量 ${b.valueMl}mL（目視）`, pump: `${fmtTimeAmPm(b.atMs)} ポンプ積算 ${b.valueMl}mL` }[b.kind] ?? '');

function summaryPanel(cur, t, ctx, order) {
  const { view, calc, infusion, events } = cur;
  const flushed = [...events].reverse().find((e) => e.type === 'flush');
  const share = flushed ? (flushed._pending ? '　保存済み・未送信' : '　共有済み') : '';
  const p = h('section', { class: 'panel' }, h('div', { class: `state ${view.cls}` }, h('span', { 'aria-hidden': 'true' }, view.mark), view.label, flushed ? ` ${fmtTimeAmPm(flushed.occurred_ms)}` : ''),
    flushed ? h('div', { class: 'fine' }, `記録 ${share.trim()}`) : null,
    h('div', { class: 'muted', style: 'margin-top:6px' }, `${infusion.drug_name ?? ''}  ${infusion.volume_ml ?? ''}mL`));
  if (calc?.closureStatus === 'unknown') p.append(h('button', { class: 'link', type: 'button', on: { click: () => closureSheet(ctx, cur, order, true) } }, '実施を確認できた（DONE に訂正）'));
  if (calc?.startedMs) p.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, '開始〜終了'), h('span', {}, `${fmtWhen(calc.startedMs, t)} 〜 ${calc.endedMs ? fmtWhen(calc.endedMs, t) : '—'}`)),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, '実際の投与時間'), h('span', { class: 'num' }, fmtDuration(calc.activeMs ?? 0))));
  return p;
}

/** 中断時の指示（閉塞・気泡は別項目）。登録された医療者の指示を表示するだけで、アプリは処置の方法を判断しない */
function instructionText(order, reason) {
  const text = (reason === '気泡' ? order?.bubble_procedure : order?.occlusion_procedure)?.trim();
  return text || null;
}

function occlusionPanel(order) {
  const one = (title, text) => h('div', { style: 'margin-top:6px' }, h('h3', { style: 'font-size:15px' }, title),
    text ? h('p', { style: 'white-space:pre-wrap;margin:2px 0' }, text) : h('p', { class: 'fine', style: 'margin:2px 0' }, '未登録です（設定で登録できます）'));
  return h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '中断のときの指示'),
    one('閉塞', order?.occlusion_procedure?.trim()), one('気泡', order?.bubble_procedure?.trim()),
    h('p', { class: 'fine' }, '医療者から指示された内容を表示しています。'));
}

// ---------------------------------------------------------------------------
// 準備（逆算）

function preparePanel(ctx, order) {
  const { data, now } = ctx;
  const t = now();
  const oc = toCalcOrder(order);
  const [endH, endM] = (order?.target_end_time ?? '06:00').split(':').map(Number);
  const rates = allowedRates(oc);
  const f = {
    drug: textField('輸液名', { value: order?.drug_name ?? DEFAULTS.drugName }),
    volume: numberField('容量（mL）', { value: order?.volume_ml ?? DEFAULTS.volumeMl, inputMode: 'numeric' }),
    end: dateTimeField('終了希望の日時', { value: nextJstTime(t, endH ?? DEFAULTS.endHour, endM ?? DEFAULTS.endMinute) }),
    rate: selectField('ポンプの設定流量（mL/h）', rates.map((r) => [r, `${r}`]), { value: rates.includes(order?.usual_rate_max) ? order.usual_rate_max : (rates.includes(120) ? 120 : rates[0]) }),
  };
  const result = h('div', { 'aria-live': 'polite', class: 'prep-result' });
  const msg = h('p', { class: 'err', role: 'alert', style: 'margin:4px 0 0' });
  const plan = () => planStart({ volumeMl: f.volume.get(), rateMlPerH: f.rate.get(), targetEndMs: f.end.get(), order: oc });
  // 輸液名・容量は、通常の設定を1行で見せる。変えるときだけ「変更」で開く
  const summary = h('span', {});
  const drawSummary = () => { summary.textContent = `${f.drug.get() || '—'}　${f.volume.get() ?? '—'} mL`; };
  const edit = h('details', { class: 'inf-detail prep-edit' }, h('summary', {}, '変更'), f.drug.el, f.volume.el);
  const refresh = () => {
    drawSummary(); clear(result); msg.textContent = '';
    const p = plan();
    if (!p.ok) { msg.textContent = p.errors.map((e) => errText(typeof e === 'string' ? e : e.code)).join(' / '); return null; }
    const c = p.calculated;
    // 必要な投与時間・開始の目安・終了見込みを、1つのまとまりで
    result.append(h('div', { class: 'inf-end', style: 'margin-top:4px' }, h('div', { class: 'k' }, '開始の目安'), h('div', { class: 'v' }, fmtWhen(c.startMs))),
      h('div', { class: 'inf-small' }, `必要な投与時間 ${fmtDuration(c.durationMs)}　終了見込み ${fmtWhen(c.endMs)}（計算上）`));
    if (p.warnings.length) result.append(h('p', { class: 'note', style: 'color:var(--danger)' }, '設定流量が、登録されている指示の範囲の外です。医療者から許可された条件か確かめてください。'));
    return p;
  };
  for (const fld of Object.values(f)) fld.input?.addEventListener('input', refresh);
  const wrap = h('section', { class: 'panel prep' },
    h('div', { class: 'prep-head' }, h('strong', {}, '点滴を準備'), summary), edit,
    f.end.el, f.rate.el,
    h('div', { class: 'muted', style: 'font-size:13px;margin:-6px 0 4px' }, `指示の範囲 ${oc?.rateMin ?? DEFAULTS.rateMin}〜${oc?.rateMax ?? DEFAULTS.rateMax} mL/h・${oc?.rateStep ?? DEFAULTS.rateStep}mL/h 刻み`),
    result, msg,
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      const p = refresh();
      if (!p) return;
      const c = p.calculated;
      const data2 = { order_id: order?.id ?? null, drug_name: f.drug.get(), volume_ml: f.volume.get(), plan_target_end_ms: c.endMs, plan_rate: f.rate.get(), plan_start_ms: c.startMs, status: 'not_started', closure_status: 'none' };
      const v = validateRecord('infusions', data2, { nowMs: t });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      const ok = await confirmSheet({ title: 'この計画で準備しますか？', lines: [`${data2.drug_name}　${data2.volume_ml}mL　${data2.plan_rate}mL/h`, `開始の目安：${fmtWhen(c.startMs)}`, `終了見込み：${fmtWhen(c.endMs)}`], okLabel: '準備する' });
      if (!ok) return;
      const r = await data.createRecord('infusions', Object.fromEntries(Object.entries(data2).filter(([, x]) => x !== null)));
      if (saved(r, '点滴を準備しました')) ctx.refresh();
    } } }, 'この計画で準備'));
  wrap.addEventListener('input', () => wrap.setAttribute('data-keep', ''));   // 入力が始まったら、同期や時計の更新で作り直さない
  refresh();
  return wrap;
}

// ---------------------------------------------------------------------------
// 操作（確認画面を挟む）

function saved(r, okText) {
  if (r.ok) toast(`${okText}（相手の端末への共有待ち）`);
  else toast(r.message ?? '記録できませんでした');
  return r.ok;
}

/** 候補のイベントを足して計算し直し、この操作が受け付けられない理由を返す（サーバーと同じ判定） */
function tryEvent(cur, order, candidate, t) {
  const seq = cur.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1;
  const chk = appendCheck({ volumeMl: cur.infusion.volume_ml, existing: cur.events.map(toCalcEvent), candidate: toCalcEvent({ ...candidate, seq }), nowMs: Math.max(t, candidate.occurred_ms), order: toCalcOrder(order) });
  return { errors: chk.errors.map((e) => e.code), result: chk.result };
}

async function submitEvent(ctx, cur, order, fields, event, { title, lines, okLabel, danger = false, okText }) {
  const t = ctx.now();
  const v = validateRecord('infusion_events', event, { nowMs: t });
  const rest = showErrors(fields, v.errors);
  if (!v.ok) return { ok: false, message: rest.join(' / ') };
  const tried = tryEvent(cur, order, event, t);
  if (tried.errors.length) { const m = tried.errors.map(errText).join(' / '); return { ok: false, message: m }; }
  const yes = await confirmSheet({ title, lines, okLabel, danger });
  if (!yes) return { ok: false, cancelled: true };
  const r = await ctx.data.appendEvent(cur.infusion.id, event);
  saved(r, okText);
  return r;
}

function formSheet(ctx, title, fields, body, onSubmit, submitLabel) {
  const msg = h('p', { class: 'err', role: 'alert' });
  const close = openSheet(title, (closeFn) => [
    h('div', { 'data-keep': '' }, ...body, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      const r = await onSubmit();
      if (r?.ok) { closeFn(); ctx.refresh(); } else if (r?.message) msg.textContent = r.message;
    } } }, submitLabel),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => closeFn() } }, 'やめる'),
  ]);
  return close;
}

/** 実施者の選択。既定は記録している本人。違うときだけ変える（本人のままなら保存しない＝未設定は「記録者と同じ」） */
function performerField(ctx) {
  const me = ctx.data.userId;
  const fld = choiceField('実施した人', [['u_mother', '母'], ['u_admin', '管理者（娘）']], { value: me });
  return { ...fld, get: () => (fld.get() && fld.get() !== me ? fld.get() : undefined) };
}
const performerDetails = (by) => h('details', { class: 'inf-detail' }, h('summary', {}, '実施した人（記録した人と違うとき）'), by.el);

function startSheet(ctx, cur, order) {
  const t = ctx.now();
  const inf = cur.infusion;
  const f = { when: dateTimeField('開始した時刻', { value: t, hint: '初期値は「いま」です。実際に開始した時刻に直せます' }), by: performerField(ctx) };
  formSheet(ctx, '点滴を開始する', f, [h('p', {}, `${inf.drug_name ?? ''}  ${inf.volume_ml}mL  設定流量 ${inf.plan_rate}mL/h`), f.when.el, performerDetails(f.by)], async () => {
    const when = f.when.get();
    if (!when) return { ok: false, message: '開始時刻を入力してください' };
    const end = planEnd({ volumeMl: inf.volume_ml, rateMlPerH: inf.plan_rate, startMs: when, order: toCalcOrder(order) });
    const event = { type: 'start', occurred_ms: when, rate: inf.plan_rate, out_of_range: !(end.calculated?.withinOrder ?? true), performed_by: f.by.get() };
    return submitEvent(ctx, cur, order, { occurred_ms: f.when }, event, {
      title: '点滴を開始しますか？',
      lines: [`開始時刻：${fmtWhen(when, t)}`, `流量：${inf.plan_rate}mL/h`, end.ok ? `終了予定：${fmtWhen(end.calculated.endMs, t)}（推定）` : ''].filter(Boolean).concat(event.out_of_range ? ['指示の範囲外の流量です。医療者から許可された条件か確かめてください。'] : []),
      okLabel: '開始する', okText: '点滴を開始しました',
    });
  }, '確認へ');
}

const VOLUME_STEPS = (total) => { const a = []; for (let v = Math.floor(total / 100) * 100; v >= 0; v -= 100) a.push(v); return a; };

function visualSheet(ctx, cur, order) {
  const t = ctx.now();
  const total = cur.infusion.volume_ml;
  let kind = 'volume_visual';
  const kindField = choiceField('入力の方法', [['volume_visual', 'バッグの目盛りを見た（目視）'], ['volume_pump', 'ポンプの積算量']], { value: 'volume_visual' });
  const pick = choiceField('目盛りで選ぶ（のこりの量）', VOLUME_STEPS(total).map((v) => [v, `${v}`]), {});
  const f = {
    volume: numberField('数値で入力する（mL）', { inputMode: 'numeric', hint: '目視：バッグに残っている量。ポンプ：ポンプに表示された積算の投与量。目視は概算値です' }),
    when: dateTimeField('確認した時刻', { value: t }),
  };
  pick.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { f.volume.set(pick.get()); }));
  formSheet(ctx, '残量を記録する', f, [kindField.el, pick.el, f.volume.el, f.when.el], async () => {
    kind = kindField.get();
    const vol = f.volume.get();
    const event = { type: kind, occurred_ms: f.when.get(), volume_ml: vol };
    if (vol === undefined || Number.isNaN(vol)) { f.volume.setError(vol === undefined ? '残量を入力するか、目盛りを選んでください' : '数字で入力してください'); return { ok: false }; }
    const label = kind === 'volume_visual' ? `残量 ${vol}mL（目視）` : `ポンプの積算 ${vol}mL`;
    const trial = tryEvent(cur, order, event, t);
    const est = trial.result?.calculated;
    return submitEvent(ctx, cur, order, { volume_ml: f.volume, occurred_ms: f.when }, event, {
      title: '残量を記録しますか？',
      lines: [`${label}  確認した時刻 ${fmtWhen(event.occurred_ms, t)}`, est?.estEndMs ? `記録すると、終了予定は ${fmtWhen(est.estEndMs, t)} ごろ（推定）になります` : ''].filter(Boolean),
      okLabel: '記録する', okText: '残量を記録しました',
    });
  }, '確認へ');
}

const DEFAULT_RATE_REASON = '終了希望時刻に合わせるため';

/** 指示の範囲内の、刻みの流量（ドロップダウンの選択肢） */
function allowedRates(oc) {
  const step = oc?.rateStep ?? 5; const lo = oc?.rateMin ?? 60; const hi = oc?.rateMax ?? 150;
  const out = [];
  for (let r = Math.ceil(lo / step) * step; r <= hi; r += step) out.push(r);
  return out;
}

function rateSheet(ctx, cur, order, presetRate = null) {
  const t = ctx.now();
  const oc = toCalcOrder(order);
  const before = cur.calc.currentRate;
  const rates = allowedRates(oc);
  const OTHER = 'other';
  const f = {
    pick: selectField('変更後の流量（mL/h）', [...rates.slice().reverse().map((r) => [r, `${r}`]), [OTHER, '指示の範囲外の値…']], { value: presetRate ?? (rates.includes(before) ? before : rates[0]),
      hint: `いまは ${before} mL/h。指示の範囲 ${oc?.rateMin ?? 60}〜${oc?.rateMax ?? 150}、${oc?.rateStep ?? 5}mL/h 刻み` }),
    when: dateTimeField('変更した日時', { value: t }),
    other: numberField('範囲外の流量（mL/h）', { inputMode: 'numeric' }),
    reason: textField('範囲外にした理由', { multiline: true }),
    ref: textField('指示の確認（誰の・いつの指示か）', { placeholder: '例：訪問看護師の指示 10/20' }),
  };
  const extra = h('div', { hidden: true }, f.other.el, f.reason.el, f.ref.el);
  f.pick.input.addEventListener('change', () => { extra.hidden = f.pick.get() !== OTHER; });
  if (presetRate !== null && !rates.includes(presetRate)) { f.pick.set(OTHER); extra.hidden = false; f.other.set(presetRate); }
  formSheet(ctx, '流量の変更を記録', f, [f.pick.el, f.when.el, extra], async () => {
    const outside = f.pick.get() === OTHER;
    const rate = outside ? f.other.get() : f.pick.get();
    const check = validateRate(rate, oc);
    if (!check.ok) { (outside ? f.other : f.pick).setError(check.errors.map(errText).join(' / ')); return { ok: false }; }
    const out = check.warnings.length > 0;
    if (outside && !f.reason.get()) { f.reason.setError('範囲外にした理由を入力してください'); return { ok: false }; }
    if (out && !f.ref.get()) { f.ref.setError('指示の範囲外です。指示の確認（誰の・いつの指示か）を入力してください'); return { ok: false }; }
    const reason = outside ? f.reason.get() : DEFAULT_RATE_REASON;
    const event = { type: 'rate_change', occurred_ms: f.when.get(), rate, rate_before: before, reason, order_ref: f.ref.get() || undefined, out_of_range: out };
    const est = tryEvent(cur, order, event, t).result?.calculated;
    const lines = [`${before} → ${rate} mL/h`, `変更した日時：${fmtWhen(event.occurred_ms)}`];
    if (outside) lines.push(`理由：${reason}`);
    if (event.order_ref) lines.push(`指示：${event.order_ref}`);
    if (out) lines.push(`⚠ 医療者の指示の範囲（${oc.rateMin ?? '—'}〜${oc.rateMax ?? '—'} mL/h）の外です。許可された条件内か、もう一度確かめてください。`);
    if (est?.estEndMs) lines.push(`終了予定（推定）：${fmtWhen(est.estEndMs)}`);
    return submitEvent(ctx, cur, order, { occurred_ms: f.when, reason: f.reason, order_ref: f.ref }, event, { title: '流量の変更を記録しますか？', lines, okLabel: '記録する', okText: '流量の変更を記録しました', danger: out });
  }, '確認へ');
}

/** 終了希望時刻から、必要な流量の候補を計算する（表示のみ。記録はしない。ポンプで実際に変えたら「流量の変更を記録」で残す） */
function suggestSheet(ctx, cur, order) {
  const t = ctx.now();
  const oc = toCalcOrder(order);
  const [eh, em] = (order?.target_end_time ?? '06:00').split(':').map(Number);
  const f = { target: dateTimeField('終了希望の日時', { value: nextJstTime(t, eh ?? 6, em ?? 0) }),
    at: dateTimeField(cur.view.key === 'paused' ? '再開する日時（予定）' : 'この流量にする日時', { value: t }) };
  const out = h('div', { 'aria-live': 'polite' });
  const draw = () => {
    clear(out);
    const r = suggestRate({ remainingMl: cur.calc.remainingMl, atMs: f.at.get(), targetEndMs: f.target.get(),
      order: { rateMin: oc?.rateMin, rateMax: oc?.rateMax, rateStep: oc?.rateStep, usualMin: order?.usual_rate_min, usualMax: order?.usual_rate_max } });
    if (!r.ok) { out.append(h('p', { class: 'err' }, r.errors.map((e) => ({ REMAINING_INVALID: '推定の残量がありません', TARGET_NOT_AFTER_NOW: '終了希望が、流量にする日時より前です', TARGET_INVALID: '終了希望の日時を入力してください', AT_INVALID: '日時を入力してください' }[e] ?? e)).join(' / '))); return; }
    const min = Math.round(r.best.diffMs / 60_000);
    const diffText = (ms) => { const m = Math.round(ms / 60_000); return m === 0 ? '希望どおり' : m > 0 ? `希望より ${fmtDuration(m * 60_000)} 遅い` : `希望より ${fmtDuration(-m * 60_000)} 早い`; };
    if (r.status === 'too_late') out.append(h('p', { class: 'note', style: 'color:var(--danger)' }, `許可された範囲（上限 ${r.bounds.max} mL/h）では、希望の時刻に間に合いません。上限でも ${fmtWhen(r.best.endMs)} の見込みです。`));
    if (r.status === 'too_early') out.append(h('p', { class: 'note' }, `許可された範囲（下限 ${r.bounds.min} mL/h）でも、希望より早く終わる見込みです（${fmtWhen(r.best.endMs)}）。`));
    out.append(h('p', { class: 'fine' }, `残量の推定 ${Math.round(cur.calc.remainingMl)} mL ／ 計算上の必要流量 ${Math.round(r.idealRate * 10) / 10} mL/h`));
    // 希望時刻との差が最小の候補（同程度なら、従来の選び方＝r.best）を最上段に。ほかは「別の候補」として下に
    const ordered = [r.best, ...r.candidates.filter((c) => c.rate !== r.best.rate)];
    for (const c of ordered) {
      const isBest = c === r.best;
      out.append(h('div', { class: `panel${isBest ? ' cand-best' : ''}`, style: 'margin-top:8px;padding:10px 12px' },
        h('div', { class: 'kv' }, h('span', { class: 'k' }, isBest ? '希望時刻に最も近い候補' : '別の候補'), h('span', { class: 'num', style: 'font-size:24px;font-weight:500' }, `${c.rate} mL/h`)),
        h('div', {}, `終了の見込み（推定） `, h('strong', { class: 'num' }, fmtWhen(c.endMs))),
        h('div', { class: 'muted' }, `${diffText(c.diffMs)}${c.inUsual ? '　通常の範囲内' : ''}`),
        h('button', { class: 'btn soft', type: 'button', style: 'margin-top:8px', on: { click: () => { document.getElementById('overlay').hidden = true; clear(document.getElementById('overlay')); rateSheet(ctx, cur, order, c.rate); } } }, 'この流量で変更を記録')));
    }
    out.append(h('p', { class: 'fine' }, '計算上の候補です。ポンプに設定したら「流量の変更を記録」で残します。'));
  };
  for (const fld of [f.target, f.at]) fld.input.addEventListener('input', draw);
  openSheet('終了希望から流量を計算', (close) => [h('div', { 'data-keep': '' }, f.target.el, f.at.el, out),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, '閉じる')]);
  draw();
}

function pauseSheet(ctx, cur, order) {
  const t = ctx.now();
  const f = {
    reason: selectField('中断の理由', PAUSE_REASONS.map((r) => [r, r]), { value: '閉塞' }),
    when: dateTimeField('中断した日時', { value: t }),
    note: textField('メモ（任意）'),
    who: textField('医療者へ連絡した場合の相手（任意）'),
  };
  const instruction = h('div', { class: 'panel', style: 'margin:8px 0;padding:10px 12px' });
  const drawInstruction = () => {
    clear(instruction);
    const reason = f.reason.get();
    const text = reason === 'その他' ? null : instructionText(order, reason);
    if (reason === 'その他') { instruction.append(h('p', { class: 'muted', style: 'margin:0' }, '医療者の指示に従ってください。')); return; }
    instruction.append(h('h3', { style: 'font-size:15px' }, `${reason}のときの指示（登録されたもの）`),
      text ? h('p', { style: 'white-space:pre-wrap;margin:4px 0 0' }, text) : h('p', { class: 'fine', style: 'margin:4px 0 0' }, '未登録です（設定で登録できます）'));
  };
  f.reason.input.addEventListener('change', drawInstruction);
  drawInstruction();
  formSheet(ctx, '一時中断を記録', f, [f.reason.el, instruction, f.when.el, h('details', { class: 'inf-detail' }, h('summary', {}, '詳細（任意）'), f.note.el, f.who.el)], async () => {
    const event = { type: 'pause', occurred_ms: f.when.get(), reason: f.reason.get(), note: f.note.get() || undefined, contacted: f.who.get() ? `連絡：${f.who.get()}` : undefined };
    return submitEvent(ctx, cur, order, { reason: f.reason, occurred_ms: f.when }, event, {
      title: '一時中断を記録しますか？', lines: [`中断した日時：${fmtWhen(event.occurred_ms)}`, `理由：${event.reason}`, ...(event.contacted ? [`医療者への${event.contacted}`] : [])], okLabel: '記録する', okText: '一時中断を記録しました' });
  }, '確認へ');
}

function resumeSheet(ctx, cur, order) {
  const t = ctx.now();
  const f = { when: dateTimeField('再開した日時', { value: t }) };
  formSheet(ctx, '点滴を再開', f, [f.when.el], async () => {
    const event = { type: 'resume', occurred_ms: f.when.get() };
    return submitEvent(ctx, cur, order, { occurred_ms: f.when }, event, { title: '点滴を再開しますか？', lines: [`再開した日時：${fmtWhen(event.occurred_ms)}`, '中断していた時間は、終了予定に反映されます'], okLabel: '再開を記録する', okText: '再開を記録しました' });
  }, '確認へ');
}

function endSheet(ctx, cur, order) {
  const t = ctx.now();
  const f = { when: dateTimeField('終了した日時', { value: t }), by: performerField(ctx) };
  formSheet(ctx, '点滴を終了', f, [f.when.el, performerDetails(f.by)], async () => {
    const event = { type: 'end', occurred_ms: f.when.get(), performed_by: f.by.get() };
    // 終了の記録だけでは、終了処置（フラッシュなど）は完了扱いにならない。処置の記録は「終了処置を確認」から別に行う
    return submitEvent(ctx, cur, order, { occurred_ms: f.when }, event, { title: '点滴の終了を記録しますか？', lines: [`終了した日時：${fmtWhen(event.occurred_ms)}`, '終了処置（フラッシュなど）の完了は、別に記録します'], okLabel: '記録する', okText: '点滴の終了を記録しました' });
  }, '確認へ');
}

/** HOME から：確認画面なしで、いま DONE／FORGET を記録する（closureSheet の1タップと同じ記録・同じ検査） */
export async function quickClosure(ctx, cur, order, kind) {
  if (previewBlocked()) return { ok: false };
  const t = ctx.now();
  const event = kind === 'done'
    ? { type: 'flush', occurred_ms: t, flush_status: 'done' }
    : { type: 'flush_skip', occurred_ms: t, flush_status: 'unknown' };
  const v = validateRecord('infusion_events', event, { nowMs: t });
  if (!v.ok) { toast('記録できませんでした'); return { ok: false }; }
  const tried = tryEvent(cur, order, event, t);
  if (tried.errors.length) { toast(tried.errors.map(errText).join(' / ')); return { ok: false }; }
  const r = await ctx.data.appendEvent(cur.infusion.id, event);
  if (r.ok) toast(`${kind === 'done' ? '✓ DONE' : '? FORGET'} ${fmtTimeAmPm(t)} を記録しました（共有待ち）`); else toast(r.message ?? '記録できませんでした');
  return r;
}

// 終了処置：見出し＋【✓ DONE】【? FORGET】。押したらその場で記録する（確認画面なし。誤りは履歴の訂正で直す）。
//   DONE＝実施した記録（いまの時刻）／FORGET＝実施したか不明の記録（完了でも未実施でもない。再実施は促さない）。
// 日時の変更・メモ・医療者の指示は、必要なときだけ開く（任意）。
// correction＝FORGET のあとで、実施したと確認できたときだけ DONE に訂正する（確認あり。元の FORGET の記録は残る）。
export function closureSheet(ctx, cur, order, correction = false) {
  const t = ctx.now();
  const f = { when: dateTimeField('実施した日時', { value: t }), note: textField('メモ（任意）', { multiline: true }), by: performerField(ctx) };
  const instr = order?.flush_instruction?.trim();
  const msg = h('p', { class: 'err', role: 'alert' });
  const record = async (event, doneText, close) => {
    if (previewBlocked()) return;
    msg.textContent = '';
    const v = validateRecord('infusion_events', event, { nowMs: t });
    if (!v.ok) { msg.textContent = showErrors({ occurred_ms: f.when, note: f.note }, v.errors).join(' / '); return; }
    const tried = tryEvent(cur, order, event, t);
    if (tried.errors.length) { msg.textContent = tried.errors.map(errText).join(' / '); return; }
    const r = await ctx.data.appendEvent(cur.infusion.id, event);
    if (r.ok) { toast(`${doneText} ${fmtTimeAmPm(event.occurred_ms)} を記録しました（共有待ち）`); close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
  };
  const memo = () => f.note.get() || undefined;
  openSheet(correction ? '終了処置：DONE に訂正' : '終了処置', (close) => [
    h('div', { 'data-keep': '' },
      correction ? h('p', { style: 'margin:0 0 8px' }, '実施したことを確認できたときだけ、DONE に直します。FORGET の記録は残ります。') : null,
      h('div', { class: correction ? '' : 'cl-two' },
        h('button', { class: 'btn btn-done', type: 'button', on: { click: () => record({ type: 'flush', occurred_ms: f.when.get() ?? t, flush_status: 'done', performed_by: f.by.get(), note: correction ? `FORGETの訂正（実施を確認）${memo() ? '：' + memo() : ''}` : memo() }, '✓ DONE', close) } }, '✓ DONE'),
        correction ? null : h('button', { class: 'btn btn-forget', type: 'button', on: { click: () => record({ type: 'flush_skip', occurred_ms: f.when.get() ?? t, flush_status: 'unknown', reason: memo() }, '? FORGET', close) } }, '? FORGET')),
      msg,
      h('details', { class: 'inf-detail' }, h('summary', {}, '日時・メモ（任意）'), f.when.el, f.note.el, f.by.el),
      h('details', { class: 'inf-detail' }, h('summary', {}, '医療者の指示'),
        instr ? h('p', { style: 'white-space:pre-wrap;margin:4px 0 0' }, instr) : h('p', { class: 'fine', style: 'margin:4px 0 0' }, '未登録です（設定の「点滴の指示」）'))),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'とじる')]);
}

function cancelSheet(ctx, cur) {
  const t = ctx.now();
  const order = currentOrder(ctx.data, t);
  const f = { reason: textField('中止の理由', { multiline: true }), when: dateTimeField('中止した時刻', { value: t }) };
  formSheet(ctx, 'この点滴を中止する', f, [h('p', {}, '開始前に取りやめる、または投与の途中で中止するときに記録します。'), f.reason.el, f.when.el], async () => {
    if (!f.reason.get()) { f.reason.setError('中止の理由を入力してください'); return { ok: false }; }
    const event = { type: 'cancel', occurred_ms: f.when.get(), reason: f.reason.get() };
    return submitEvent(ctx, cur, order, { reason: f.reason, occurred_ms: f.when }, event, { title: '点滴を中止しますか？', lines: [`中止した時刻：${fmtWhen(event.occurred_ms, t)}`, `理由：${event.reason}`], okLabel: '中止を記録する', okText: '中止を記録しました', danger: true });
  }, '確認へ');
}

// ---------------------------------------------------------------------------
// 履歴・1回分の詳細・時刻の修正

const EVENT_LABEL = { start: '開始', rate_change: '流量の変更', volume_visual: '残量（目視）', volume_pump: 'ポンプの積算量', pause: '一時中断', resume: '再開', end: '終了', flush: '終了処置', flush_skip: '終了処置', cancel: '中止', correction: '時刻・値の修正', note: 'メモ' };

function eventLine(e, t) {
  const parts = [];
  if (e.rate != null && (e.type === 'start' || e.type === 'rate_change')) parts.push(e.type === 'rate_change' && e.rate_before != null ? `${e.rate_before}→${e.rate} mL/h` : `${e.rate} mL/h`);
  if (e.volume_ml != null) parts.push(`${e.volume_ml}mL`);
  if (e.flush_status) parts.push({ done: '✓ DONE', not_done: '未実施', not_required: '不要', unknown: '? FORGET（実施したか不明）' }[e.flush_status] ?? '');
  if (e.reason) parts.push(`理由：${e.reason}`);
  if (e.pump_alarm) parts.push(`アラーム：${e.pump_alarm}`);
  if (e.action_taken) parts.push(`対応：${e.action_taken}`);
  if (e.contacted) parts.push(`連絡：${e.contacted}`);
  if (e.order_ref) parts.push(`指示：${e.order_ref}`);
  if (e.out_of_range) parts.push('⚠ 指示の範囲外');
  if (e.type === 'flush' && e.note) parts.push(e.note);
  if (e.type === 'correction') parts.push(`#${e.corrects_seq} の ${e.field === 'occurredMs' ? '時刻' : e.field === 'rate' ? '流量' : '残量'} → ${e.field === 'occurredMs' ? fmtWhen(e.new_value, t) : e.new_value}`);
  return parts.filter(Boolean).join('　');
}

const JST_OFFSET = 9 * 3_600_000;
const dayKey = (ms) => Math.floor((ms + JST_OFFSET) / 86_400_000);
const WHO = { u_admin: '管理者', u_mother: '母' };
const CLOSURE_LABEL = { none: '—', pending: '未完了', done: '✓ DONE', not_done: '未実施', not_required: '不要', unknown: '? FORGET（実施したか不明）' };
const shortDate = (ms) => fmtDateShort(ms).replace('（', '(').replace('）', ')');

/** 履歴の1行に出す値。投与中・中断中・開始待ちは、終了時刻と所要時間を確定値として出さない */
function historyCells(x) {
  const { calc, view, events, infusion } = x;
  const startMs = calc?.startedMs ?? null;
  const first = events.find((e) => e.type === 'start');
  const rate = first?.rate ?? infusion.plan_rate ?? null;
  const out = { start: startMs ? fmtTime(startMs) : '—', end: '—', endNote: '', dur: '—', rate: rate ?? '—', pending: null };
  if (view.key === 'not_started') out.pending = '開始待ち';
  else if (view.key === 'running') out.pending = '投与中';
  else if (view.key === 'paused') out.pending = '中断中';
  else if (calc?.endedMs) {
    out.end = fmtTime(calc.endedMs);
    if (startMs && dayKey(calc.endedMs) > dayKey(startMs)) out.endNote = '翌';
    if (startMs) out.dur = fmtDuration(calc.activeMs ?? 0);
    if (calc.status === 'cancelled') out.pending = '中止';
  } else if (calc?.status === 'cancelled') out.pending = '中止';
  return out;
}

/** 経過の記録（開始・終了・中断・再開・流量変更・残量・フラッシュ・時刻の修正）。元の記録と修正の履歴・記録した人と時刻を並べる */
function eventListEl(ctx, cur, order, t) {
  const list = h('ul', { class: 'list' });
  for (const e of cur.events) {
    const correctable = ['start', 'end', 'pause', 'resume', 'rate_change', 'volume_visual', 'volume_pump', 'cancel', 'flush'].includes(e.type);
    // 時刻の修正は、元の記録を書き換えず、修正の記録を追加する。ここでは元の記録と修正の履歴の両方を見せる
    const fixes = cur.events.filter((c) => c.type === 'correction' && c.corrects_seq === e.seq && c.field === 'occurredMs').sort((p, q) => p.seq - q.seq);
    const effective = fixes.reduce((tm, c) => c.new_value, e.occurred_ms);
    list.append(h('li', {}, h('div', {}, h('strong', {}, `#${e.seq} ${EVENT_LABEL[e.type] ?? e.type}`), e._pending ? h('span', { class: 'tag pending' }, '未送信') : null, fixes.length ? h('span', { class: 'tag' }, '時刻を修正済み') : null, '　', h('span', { class: 'num' }, fmtWhen(effective, t))),
      h('div', { class: 'muted' }, eventLine(e, t)),
      fixes.length ? h('div', { class: 'note' }, `元の記録：${fmtWhen(e.occurred_ms, t)}`, ...fixes.map((c) => h('div', {}, `修正（#${c.seq}）：${fmtWhen(c.old_value ?? e.occurred_ms, t)} → ${fmtWhen(c.new_value, t)}　理由：${c.reason ?? '—'}　${WHO[c.created_by] ?? ''}${c.created_ms ? `　記録 ${fmtWhen(c.created_ms, t)}` : ''}`))) : null,
      e.created_ms ? h('div', { class: 'muted', style: 'font-size:14px' }, `${e.performed_by && e.performed_by !== e.created_by ? `実施：${WHO[e.performed_by] ?? '—'}／` : ''}記録：${WHO[e.created_by] ?? '—'}　${fmtWhen(e.created_ms, t)}`) : null,
      correctable ? h('button', { class: 'link', type: 'button', on: { click: () => correctSheet(ctx, cur, order, { ...e, occurred_ms: effective }) } }, '時刻を直す') : null));
  }
  return list.childElementCount ? list : h('p', { class: 'muted' }, 'まだ経過の記録がありません');
}

/** 1回分の詳細（履歴の展開部分と、「この点滴の記録」の画面で共通）。既存の情報はすべてここに置く */
function detailBody(ctx, x, order, t) {
  const { infusion, calc, events } = x;
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'num', style: 'font-size:17px' }, v));
  const rateChanges = events.filter((e) => e.type === 'rate_change').length;
  const checks = events.filter((e) => e.type === 'volume_visual' || e.type === 'volume_pump').length;
  const sec = (title, ...children) => h('div', { class: 'acc-sec' }, h('h3', { style: 'font-size:16px;margin:8px 0 2px' }, title), ...children);
  return h('div', { class: 'acc-body' },
    sec('点滴製剤と投与量',
      kv('製剤', infusion.drug_name ?? '—'), kv('容量', infusion.volume_ml != null ? `${infusion.volume_ml} mL` : '—'),
      kv('計画の流量', infusion.plan_rate != null ? `${infusion.plan_rate} mL/h` : '—'),
      infusion.plan_start_ms ? kv('計画の開始', fmtWhen(infusion.plan_start_ms, t)) : null,
      infusion.plan_target_end_ms ? kv('終了希望', fmtWhen(infusion.plan_target_end_ms, t)) : null),
    sec('流量と実績',
      kv('開始時の流量', events.find((e) => e.type === 'start')?.rate != null ? `${events.find((e) => e.type === 'start').rate} mL/h` : '—'),
      calc?.currentRate != null ? kv('最後の流量', `${calc.currentRate} mL/h（変更 ${rateChanges}回）`) : null,
      calc?.startedMs ? kv('開始', fmtWhen(calc.startedMs, t)) : null,
      calc?.endedMs ? kv('終了', fmtWhen(calc.endedMs, t)) : null,
      calc?.startedMs ? kv('経過（中断を含む）', fmtDuration(calc.elapsedMs)) : null,
      calc?.pausedMs ? kv('中断の合計', fmtDuration(calc.pausedMs)) : null,
      calc?.endedMs ? kv('実際に投与した時間', fmtDuration(calc.activeMs ?? 0)) : null,
      kv('残量の確認', `${checks}回`), kv('終了処置', CLOSURE_LABEL[calc?.closureStatus] ?? '—')),
    sec('経過の記録', eventListEl(ctx, x, order, t)),
    h('p', { class: 'fine' }, '記録は消さず、直した履歴が残ります。'));
}

function renderHistory(root, ctx) {
  const { data, now } = ctx;
  const t = now();
  const order = currentOrder(data, t);
  const open = mode.open ?? (mode.open = new Set());
  const all = data.list('infusions').map((inf) => describe(data, inf, order, t));
  const keyMs = (x) => x.calc?.startedMs ?? x.infusion.plan_start_ms ?? x.infusion.created_ms ?? 0;
  const rows = all.sort((a, b) => keyMs(b) - keyMs(a)).slice(0, 200);
  const ymOf = (ms) => { const d = new Date(ms + JST_OFFSET); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`; };
  clear(root);
  root.append(h('div', { class: 'toolbar' }, h('button', { class: 'link-back', type: 'button', on: { click: () => { mode = { view: 'main' }; ctx.nav('infusion'); } } }, icon('back', 'sm'), '点滴')));
  const box = h('section', { class: 'panel hist' },
    h('div', { class: 'fine' }, '流量 mL/h（変＝途中で変更）・所要は実投与時間。タップで詳細'),
    h('div', { class: 'hrow hhead', 'aria-hidden': 'true' }, h('span', {}), h('span', {}, '日付'), h('span', {}, '開始'), h('span', {}, '終了'), h('span', { class: 'r' }, '流量'), h('span', { class: 'r' }, '所要')));
  if (!rows.length) box.append(h('p', { class: 'muted' }, '点滴の記録はまだありません'));
  let lastYm = null;
  for (const x of rows) {
    const ym = ymOf(keyMs(x));
    if (ym !== lastYm) { box.append(h('div', { class: 'hmonth' }, ym)); lastYm = ym; }
    const c = historyCells(x);
    const id = x.infusion.id;
    const isOpen = open.has(id);
    const body = h('div', { class: 'hbody', id: `hb-${id}`, hidden: !isOpen });
    if (isOpen) body.append(detailBody(ctx, x, order, t));
    const head = h('button', { class: 'hrow hline', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': `hb-${id}`,
      'aria-label': `${shortDate(keyMs(x))} ${x.view.label}`, on: { click: () => {
        const nowOpen = !open.has(id);
        if (nowOpen) { open.add(id); clear(body).append(detailBody(ctx, describe(data, data.get('infusions', id) ?? x.infusion, currentOrder(data, ctx.now()), ctx.now()), currentOrder(data, ctx.now()), ctx.now())); } else { open.delete(id); clear(body); }
        body.hidden = !nowOpen; head.setAttribute('aria-expanded', String(nowOpen));
      } } },
      h('span', { class: `hmark ${x.view.cls}`, title: x.view.label, 'aria-hidden': 'true' }, x.view.mark),
      h('span', { class: 'hdate' }, shortDate(keyMs(x))),
      h('span', { class: 'num' }, c.start),
      c.pending && !c.endNote && c.end === '—' ? h('span', { class: `hpend ${x.view.cls}` }, c.pending) : h('span', { class: 'num' }, c.endNote ? h('small', {}, c.endNote) : null, c.end, view_cancel(c)),
      h('span', { class: 'num r' }, String(c.rate), x.events.some((e) => e.type === 'rate_change') ? h('small', { class: 'hchg', title: '流量の変更あり' }, '変') : null),
      h('span', { class: 'num r' }, c.dur));
    box.append(h('div', { class: 'hitem' }, head, body));
  }
  root.append(box);
}

const view_cancel = (c) => (c.pending === '中止' && c.end !== '—' ? h('small', { style: 'color:#5E4440' }, '中止') : null);

function renderDetail(root, ctx, id) {
  const { data, now } = ctx;
  const t = now();
  const order = currentOrder(data, t);
  const inf = data.get('infusions', id);
  clear(root);
  root.append(h('div', { class: 'toolbar' }, h('button', { class: 'link-back', type: 'button', on: { click: () => { mode = { view: 'history', open: new Set() }; ctx.nav('infusion'); } } }, icon('back', 'sm'), '履歴')));
  if (!inf) { root.append(h('section', { class: 'panel' }, '記録が見つかりません')); return; }
  const cur = describe(data, inf, order, t);
  root.append(summaryPanel(cur, t), h('section', { class: 'panel' }, detailBody(ctx, cur, order, t)));
}

function correctSheet(ctx, cur, order, ev) {
  const t = ctx.now();
  const f = { when: dateTimeField('正しい時刻', { value: ev.occurred_ms }), reason: textField('直す理由', { multiline: true }) };
  formSheet(ctx, `#${ev.seq} ${EVENT_LABEL[ev.type]} の時刻を直す`, f, [h('p', {}, `いまの記録：${fmtWhen(ev.occurred_ms, t)}`), f.when.el, f.reason.el], async () => {
    const when = f.when.get();
    if (!when) return { ok: false, message: '時刻を入力してください' };
    if (!f.reason.get()) { f.reason.setError('直す理由を入力してください'); return { ok: false }; }
    const event = { type: 'correction', occurred_ms: Math.max(t, ev.occurred_ms), corrects_seq: ev.seq, field: 'occurredMs', old_value: ev.occurred_ms, new_value: when, reason: f.reason.get() };
    return submitEvent(ctx, cur, order, { new_value: f.when, reason: f.reason }, event, { title: '時刻を直しますか？', lines: [`#${ev.seq} ${EVENT_LABEL[ev.type]}`, `${fmtWhen(ev.occurred_ms, t)} → ${fmtWhen(when, t)}`, `理由：${event.reason}`, '直す前の記録は、履歴に残ります'], okLabel: '直す', okText: '時刻を直しました' });
  }, '確認へ');
}
