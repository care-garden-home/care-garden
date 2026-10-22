// 予定の画面（daily-ops-design §5・§7）：一覧 → 詳細（電話・質問メモ・実施記録・通院の出発目安と実績）。
// 予定の登録・変更は管理者だけ（サーバー側でも強制）。母は、確認・電話・実施の記録・質問メモ・訪問メモを残せる。
// 予定（予約の状態）・予定の変更/中止・実績（実施済み/未実施）は、別の層として別々に表示する。

import { listPlaces, findPlace } from '../places.js';
import { h, why, clear, openSheet, confirmSheet, toast, previewBlocked, fmtWhen, fmtDuration, fmtDateShort, icon, toLocalInput, fromLocalInput, toDateInput } from '../ui.js';
import { textField, numberField, selectField, dateField, timeField, dateTimeField, choiceField, showErrors } from '../forms.js';
import { validateRecord, APPT_KINDS } from '../../../src/validation/records.js';
import { departureGuide, tripDurations, referenceStats, DEFAULT_ARRIVAL_MARGIN_MIN } from '../../../src/schedule/trip.js';
import { expandOccurrences, dateOf, styleOf, shortKind, who, effectiveNotes, noteHistory, outcomeOf, OUTCOME_LABEL, BOOKING_LABEL,
  questionsView, openQuestionsFor, doneQuestionsFor, pastTrips, appointmentsOf, shareText } from '../schedule-view.js';

export function register(registerScreen) {
  registerScreen('schedule', (root, ctx) => renderSchedule(root, ctx));
}

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
const dayStart = (ms) => Math.floor((ms + JST) / DAY) * DAY - JST;
const hhmm = (ms) => { const d = new Date(ms + JST); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const md = (ms) => { const d = new Date(ms + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`; };

let mode = { view: 'list' };

function chip(kind, text) {
  const [bg, fg] = styleOf(kind);
  return h('span', { class: 'kchip', style: `background:${bg};color:${fg}` }, text ?? shortKind(kind));
}
const tag = (text, cls = '') => h('span', { class: `tag ${cls}` }, text);
const isAdmin = (ctx) => ctx.data.role === 'admin';

function renderSchedule(root, ctx) {
  const { params, data, now } = ctx;
  if (params?.open) { mode = { view: 'detail', key: params.open }; params.open = null; }
  if (params?.intent === 'new') { params.intent = null; queueMicrotask(() => apptSheet(ctx, null)); }
  const t = now();
  const from = dayStart(t) - 3 * DAY;
  const all = expandOccurrences(appointmentsOf(data), from, from + 42 * DAY);
  clear(root);
  if (mode.view === 'detail') {
    const o = all.find((x) => x.key === mode.key);
    if (o) return renderDetail(root, ctx, o, t);
    mode = { view: 'list' };
  }
  renderList(root, ctx, all, t);
}

// ---------------------------------------------------------------------------
// 一覧：日ごとに、種類の色の小さなチップ・時刻・事業所を1行で

function renderList(root, ctx, all, t) {
  const { data } = ctx;
  if (isAdmin(ctx)) root.append(h('button', { class: 'btn', type: 'button', style: 'margin-bottom:10px', on: { click: () => apptSheet(ctx, null) } }, '予定を登録'));
  const today = dayStart(t);
  const box = h('section', { class: 'panel hist' });
  let last = null;
  const rows = all.filter((o) => o.startMs >= today - 3 * DAY);
  if (!rows.length) box.append(h('p', { class: 'muted' }, '予定はまだ登録されていません'));
  for (const o of rows) {
    const day = dayStart(o.startMs);
    if (day !== last) { box.append(h('div', { class: 'hmonth' }, `${md(o.startMs)}${day === today ? '　きょう' : ''}`)); last = day; }
    const outcome = outcomeOf(data, o.seriesId, o.date);
    box.append(h('button', { class: 'srow', type: 'button', on: { click: () => { mode = { view: 'detail', key: o.key }; ctx.refresh(); } } },
      chip(o.appt.kind), h('span', { class: 'num stime' }, hhmm(o.startMs)), h('span', { class: 'sname' }, o.appt.provider || ''),
      o.status === 'cancelled' ? tag('中止') : o.status === 'changed' ? tag('変更') : null,
      o.appt.booking === 'tentative' ? tag('予定') : null,
      outcome === 'done' ? h('span', { class: 'sdone', title: '実施済み' }, '✓') : null));
  }
  root.append(box);
}

// ---------------------------------------------------------------------------
// 詳細

function renderDetail(root, ctx, o, t) {
  const { data } = ctx;
  const a = o.appt;
  const admin = isAdmin(ctx);
  root.append(h('div', { class: 'toolbar' }, h('button', { class: 'link-back', type: 'button', on: { click: () => { mode = { view: 'list' }; ctx.refresh(); } } }, icon('back', 'sm'), '予定')));

  const outcome = outcomeOf(data, o.seriesId, o.date);
  const head = h('section', { class: 'panel' },
    h('div', { class: 'inf-top' }, chip(a.kind, a.kind), h('span', { class: 'muted' }, `${md(o.startMs)} ${hhmm(o.startMs)}${o.endMs ? `〜${hhmm(o.endMs)}` : ''}`)),
    h('div', { style: 'font-size:20px;margin:6px 0 2px' }, a.provider || '（事業所名なし）'),
    // 3つの層：①予約の状態　②この回の変更・中止　③実績
    h('div', { class: 'srow-tags' }, tag(`予約：${BOOKING_LABEL[a.booking] ?? '—'}`),
      o.status === 'changed' ? tag('この回は変更あり') : null, o.status === 'cancelled' ? tag('この回は中止') : null,
      tag(`実績：${outcome ? OUTCOME_LABEL[outcome] : '未記録'}`, outcome ? '' : 'pending')));
  const place = findPlace(listPlaces(ctx.data), a.provider, a.kind);
  if (place?.address) head.append(h('div', { class: 'fine' }, place.address));
  if (a.phone) head.append(h('a', { class: 'btn soft telbtn', href: `tel:${a.phone.replace(/[^0-9+]/g, '')}` }, icon('phone', 'sm'), ` ${a.phone}`));
  if (a.staff) head.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, '担当者'), h('span', {}, a.staff)));
  if (a.memo) head.append(h('p', { style: 'white-space:pre-wrap;margin:6px 0 0' }, a.memo));
  root.append(head);

  if (a.kind === '通院') root.append(tripPanel(ctx, o, t));
  if (o.status !== 'cancelled') root.append(recordPanel(ctx, o, t));
  root.append(notesPanel(ctx, o, t));
  root.append(questionsPanel(ctx, o));
  if (admin) root.append(adminPanel(ctx, o));
}

// ---- 通院：出発目安と、当日の実績 ----

function tripPanel(ctx, o, t) {
  const a = o.appt;
  const admin = isAdmin(ctx);
  const baseMargin = a.arrival_margin_min ?? DEFAULT_ARRIVAL_MARGIN_MIN;   // 既定は予約の60分前
  const baseTravel = a.travel_min;
  const state = { margin: baseMargin, travel: baseTravel };                // この画面での調整。その回だけの計算で、他の回には影響しない
  const p = h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '通院の時間'));
  const out = h('div', { 'aria-live': 'polite' });
  const timeOf = (ms) => { const d = new Date(ms + JST); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

  // 診療予約と、病院に着きたい時刻（到着希望）は別。診療の30／60／90／120分前から選ぶか、時刻を直接直せる
  const marginSel = h('select', { 'aria-label': '到着希望（診療の何分前）' },
    ...[30, 60, 90, 120].map((m) => h('option', { value: String(m) }, `診療の${m}分前`)), h('option', { value: 'custom' }, 'その他（時刻で指定）'));
  const timeIn = h('input', { type: 'time', 'aria-label': '到着希望の時刻' });
  const travelIn = h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '移動時間（分）', style: 'width:84px' });
  travelIn.value = baseTravel ?? '';
  const draw = () => {
    clear(out);
    const arriveMs = o.startMs - state.margin * 60_000;
    timeIn.value = timeOf(arriveMs);
    marginSel.value = [30, 60, 90, 120].includes(state.margin) ? String(state.margin) : 'custom';
    const g = departureGuide({ appointmentMs: o.startMs, arrivalMarginMin: state.margin, travelMin: state.travel });
    if (g.ok) {
      out.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, '出発の目安'), h('span', { class: 'big', style: 'font-size:26px' }, fmtWhen(g.departByMs))),
        h('p', { class: 'fine' }, `移動時間 ${g.travelMin}分の設定に基づく目安（渋滞は反映しません）`));
    } else out.append(h('p', { class: 'note' }, '移動時間を入れると、出発の目安が出ます。'));
    const changed = state.margin !== baseMargin || state.travel !== baseTravel;
    if (changed) {
      out.append(h('p', { class: 'fine' }, admin ? 'この画面での調整（他の回は変わりません）' : 'この画面だけの計算です（保存されません）'));
      if (admin) out.append(h('button', { class: 'btn soft', type: 'button', style: 'margin-top:6px', on: { click: () => saveForThisOccurrence(ctx, o, state) } }, 'この回だけに保存'));
    }
  };
  marginSel.addEventListener('change', () => { if (marginSel.value !== 'custom') { state.margin = Number(marginSel.value); draw(); } });
  timeIn.addEventListener('input', () => {
    if (!timeIn.value) return;
    const [hh, mm] = timeIn.value.split(':').map(Number);
    const day = dayStart(o.startMs);
    let arrive = day + (hh * 60 + mm) * 60_000;
    if (arrive > o.startMs) arrive -= DAY;           // 診療より後は選べない。前日の同じ時刻とみなす
    state.margin = Math.round((o.startMs - arrive) / 60_000);
    draw();
  });
  travelIn.addEventListener('input', () => { const v = travelIn.value.trim() === '' ? undefined : Number(travelIn.value); state.travel = Number.isFinite(v) ? v : baseTravel; draw(); });

  const row = (label, ...els) => h('div', { class: 'kv', style: 'align-items:center' }, h('span', { class: 'k' }, label), h('span', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;min-width:0' }, ...els));
  p.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, '診療予約'), h('span', { class: 'num', style: 'font-size:18px;font-weight:500' }, fmtWhen(o.startMs))),
    row('到着希望', marginSel, timeIn), row('移動時間', travelIn, h('span', { class: 'muted' }, '分')), out);
  draw();

  const trips = pastTrips(ctx.data, a.provider);
  const ref = referenceStats(trips);
  if (ref.total || ref.outbound || ref.stay) {
    const line = (label, st) => (st ? h('div', { class: 'kv' }, h('span', { class: 'k' }, label), h('span', { class: 'num', style: 'font-size:15px' }, `${fmtDuration(st.medianMs)}（${fmtDuration(st.minMs)}〜${fmtDuration(st.maxMs)}、${st.n}回）`)) : null);
    p.append(h('details', { class: 'inf-detail' }, h('summary', {}, '過去の実績（参考）'), line('往路', ref.outbound), line('病院での滞在', ref.stay), line('帰路', ref.inbound), line('通院全体', ref.total),
      h('p', { class: 'fine' }, '中央値（最短〜最長）')));
  }
  return p;
}

/** この回だけの設定として保存（管理者）。1回分の変更として保存するので、他の回・元の繰り返しの設定は変わらない */
async function saveForThisOccurrence(ctx, o, state) {
  if (previewBlocked()) return;
  const series = ctx.data.get('appointments', o.seriesId);
  if (!series) return;
  const data = exceptionData(series, o, 'changed', { arrival_margin_min: state.margin, travel_min: state.travel });
  const v = validateRecord('appointments', data, { nowMs: ctx.now() });
  if (!v.ok) { toast(v.errors.map((e) => e.message).join(' / ')); return; }
  const r = await ctx.data.createRecord('appointments', data);
  toast(r.ok ? 'この回だけに保存しました' : (r.message ?? '保存できませんでした'));
  ctx.refresh();
}

// ---- 実施の記録（ワンタップに近い）----

function recordPanel(ctx, o, t) {
  const { data } = ctx;
  const a = o.appt;
  const p = h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '記録'));
  const mine = (collection) => data.list(collection).filter((r) => r.appointment_id === o.seriesId && r.occurrence_date === o.date);
  // 記録済みの表示：「✓ 記録済み」と日時・記録した人・共有の状態（取り消しは確認を1回）
  const doneRow = (label, r, atMs) => h('div', { class: 'donerow' }, h('div', {}, h('span', { class: 'sdone' }, '✓ 記録済み'), '　', label),
    h('div', { class: 'muted', style: 'font-size:13px' }, `${who(r.created_by)}　${fmtWhen(atMs ?? r.created_ms ?? t)}　${shareText(r)}`, ' ',
      h('button', { class: 'link', type: 'button', style: 'font-size:13px;min-height:36px', on: { click: () => undo(ctx, r._collection, r) } }, '取り消す')));
  const noteDone = effectiveNotes(data, o.seriesId, o.date);
  const buttons = h('div', { class: 'row', style: 'flex-wrap:wrap' });
  const later = h('div', { class: 'row', style: 'gap:4px 16px;flex-wrap:wrap;margin-top:2px' });
  if (a.kind === '通院') buttons.append(btnMain('通院の記録', () => tripSheet(ctx, o)));
  else if (!noteDone.some((n) => n.outcome === 'done')) buttons.append(btnMain('訪問あり', () => quickVisit(ctx, o)));
  if (a.kind === '訪問看護') {
    const done = mine('needle_changes');
    if (done.length) done.forEach((r) => p.append(doneRow('針交換（訪問看護）', { ...r, _collection: 'needle_changes' }, r.changed_ms)));
    else { buttons.append(btnMain('針交換済み', () => quickNeedle(ctx, o))); later.append(h('button', { class: 'link', type: 'button', on: { click: () => needleSheet(ctx, o) } }, '日時を変えて記録')); }
  }
  if (a.kind === '訪問診療') {
    const done = mine('needle_handovers');
    if (done.length) done.forEach((r) => p.append(doneRow('使用済み針の回収（訪問診療）', { ...r, _collection: 'needle_handovers' }, r.handover_ms)));
    else { buttons.append(btnMain('使用済み針を回収済み', () => quickHandover(ctx, o))); later.append(h('button', { class: 'link', type: 'button', on: { click: () => handoverSheet(ctx, o) } }, '日時を変えて記録')); }
  }
  noteDone.filter((n) => n.outcome === 'done' && !n.did && !n.talked && !n.next_check).forEach((n) => p.append(doneRow('訪問あり', { ...n, _collection: 'visit_notes' })));
  if (buttons.childElementCount) p.append(buttons);
  if (later.childElementCount) p.append(later);
  if (!noteDone.length) p.append(h('button', { class: 'link', type: 'button', on: { click: () => visitSheet(ctx, o, 'not_done') } }, '訪問はなかった（未実施）'));
  return p;
}

// ---- ワンタップの記録：現在日時で、確認画面なしに保存する（誤りは「取り消す」で。履歴は残る）----

async function quickSave(ctx, collection, data, okText) {
  if (previewBlocked()) return;
  const v = validateRecord(collection, data, { nowMs: ctx.now() });
  if (!v.ok) { toast(v.errors.map((e) => e.message).join(' / ')); return; }
  const r = await ctx.data.createRecord(collection, data);
  toast(r.ok ? `${okText}（保存しました）` : (r.message ?? '記録できませんでした'));
  ctx.refresh();
}
const quickVisit = (ctx, o) => quickSave(ctx, 'visit_notes', { appointment_id: o.seriesId, occurrence_date: o.date, outcome: 'done' }, '訪問ありを記録しました');
function quickNeedle(ctx, o) {
  const ms = ctx.now(); const day = toDateInput(ms);
  const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 7)).toISOString().slice(0, 10);
  return quickSave(ctx, 'needle_changes', { changed_on: day, changed_ms: ms, next_due_on: next, appointment_id: o.seriesId, occurrence_date: o.date }, '針交換を記録しました');
}
const quickHandover = (ctx, o) => quickSave(ctx, 'needle_handovers', { handover_ms: ctx.now(), destination: '訪問診療', appointment_id: o.seriesId, occurrence_date: o.date }, '使用済み針の回収を記録しました');

const btnMain = (label, fn) => h('button', { class: 'btn', type: 'button', style: 'flex:1 1 150px', on: { click: fn } }, label);

async function undo(ctx, collection, r) {
  const yes = await confirmSheet({ title: 'この記録を取り消しますか？', lines: ['取り消した記録も、履歴に残ります'], okLabel: '取り消す', danger: true });
  if (!yes) return;
  const res = await ctx.data.softDelete(collection, r.id, r.version);
  toast(res.ok ? '取り消しました' : (res.message ?? '取り消せませんでした'));
  ctx.refresh();
}

function simpleConfirm(ctx, { title, lines, okLabel = '記録する', build, collection, okText }) {
  return async () => {
    const data = build();
    const v = validateRecord(collection, data, { nowMs: ctx.now() });
    if (!v.ok) { toast(v.errors.map((e) => e.message).join(' / ')); return; }
    if (!await confirmSheet({ title, lines, okLabel })) return;
    const r = await ctx.data.createRecord(collection, data);
    toast(r.ok ? `${okText}（相手の端末への共有待ち）` : (r.message ?? '記録できませんでした'));
    ctx.refresh();
  };
}

function visitSheet(ctx, o, outcome) {
  const label = outcome === 'done' ? '訪問あり' : '訪問はなかった（未実施）';
  simpleConfirm(ctx, { title: `${label}を記録しますか？`, lines: [`${o.appt.kind}　${md(o.startMs)} ${hhmm(o.startMs)}　${o.appt.provider || ''}`], collection: 'visit_notes', okText: '記録しました',
    build: () => ({ appointment_id: o.seriesId, occurrence_date: o.date, outcome }) })();
}

function dateSheet(ctx, o, { title, note, collection, label, build, okText }) {
  if (previewBlocked()) return;
  const f = { when: dateTimeField(label, { value: ctx.now() }) };
  const msg = h('p', { class: 'err' });
  openSheet(title, (close) => [note ? h('p', { class: 'muted' }, note) : null, h('div', { 'data-keep': '' }, f.when.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      const ms = f.when.get(); if (!ms) { msg.textContent = '日時を入力してください'; return; }
      const data = build(ms);
      const v = validateRecord(collection, data, { nowMs: ctx.now() });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      const r = await ctx.data.createRecord(collection, data);
      if (r.ok) { toast(`${okText}（保存しました）`); close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
    } } }, '記録する'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

const needleSheet = (ctx, o) => dateSheet(ctx, o, { title: '針交換済み（日時を指定）', collection: 'needle_changes', label: '実際に交換した日時', okText: '針交換を記録しました',
  build: (ms) => { const day = toDateInput(ms); const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 7)).toISOString().slice(0, 10); return { changed_on: day, changed_ms: ms, next_due_on: next, appointment_id: o.seriesId, occurrence_date: o.date }; } });
const handoverSheet = (ctx, o) => dateSheet(ctx, o, { title: '使用済み針の回収（日時を指定）', note: '実際に訪問診療側へ回収された日時を入れます。', collection: 'needle_handovers', label: '回収された日時', okText: '使用済み針の回収を記録しました',
  build: (ms) => ({ handover_ms: ms, destination: '訪問診療', appointment_id: o.seriesId, occurrence_date: o.date }) });

// ---- 通院の実績：6つの時刻（任意。その場で「今」を押すだけ） ----

const TRIP_FIELDS = [['depart_home_ms', '自宅を出発'], ['arrive_hospital_ms', '病院に到着'], ['consult_start_ms', '診療の開始'], ['consult_end_ms', '診療の終了'], ['leave_hospital_ms', '病院を出発'], ['arrive_home_ms', '帰宅']];

function tripSheet(ctx, o) {
  const t = ctx.now();
  const existing = effectiveNotes(ctx.data, o.seriesId, o.date).filter((n) => n.trip).pop() ?? null;
  const values = { ...(existing?.trip ?? {}) };
  const rows = h('div', {});
  const out = h('div', { 'aria-live': 'polite', class: 'inf-small' });
  const draw = () => {
    clear(rows); clear(out);
    for (const [key, label] of TRIP_FIELDS) {
      const f = dateTimeField(label, { value: values[key] });
      f.input.addEventListener('input', () => { const v = f.get(); if (v) values[key] = v; else delete values[key]; show(); });
      rows.append(h('div', { style: 'display:flex;gap:8px;align-items:flex-end' }, h('div', { style: 'flex:1;min-width:0' }, f.el),
        h('button', { class: 'btn soft', type: 'button', style: 'width:auto;min-height:46px;margin-bottom:12px;padding:0 14px', on: { click: () => { values[key] = Date.now(); draw(); } } }, '今')));
    }
    show();
  };
  const show = () => {
    clear(out);
    const d = tripDurations(values);
    const line = (k, v) => out.append(h('div', {}, `${k}：${v === null ? '—（時刻がそろっていません）' : fmtDuration(v)}`));
    line('往路', d.outbound); line('診療', d.consult); line('病院での滞在', d.stay); line('帰路', d.inbound); line('通院全体', d.total);
  };
  const msg = h('p', { class: 'err' });
  openSheet('通院の記録', (close) => [why('分かる時刻だけ入力してください。両端の時刻がそろった区間だけ、所要時間が計算されます（入力していない時刻から推測はしません）。'),
    h('div', { 'data-keep': '' }, rows, out, msg),
    h('button', { class: 'btn', type: 'button', onclick: null, on: { click: async () => {
      const data = { appointment_id: o.seriesId, occurrence_date: o.date, outcome: 'done', trip: { ...values } };
      if (existing) data.corrects_id = existing.id;
      const v = validateRecord('visit_notes', data, { nowMs: t });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      if (!await confirmSheet({ title: '通院の記録を保存しますか？', lines: TRIP_FIELDS.filter(([k]) => values[k]).map(([k, l]) => `${l}：${fmtWhen(values[k])}`).concat(TRIP_FIELDS.every(([k]) => !values[k]) ? ['時刻の入力はありません（通院があったことだけ記録します）'] : []), okLabel: '保存する' })) return;
      const r = await ctx.data.createRecord('visit_notes', data);
      if (r.ok) { toast('通院を記録しました（相手の端末への共有待ち）'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
    } } }, '確認へ'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
  draw();
}

// ---- 訪問メモ（何をしたか・何を話したか・次回確認したいこと） ----

function notesPanel(ctx, o, t) {
  const { data } = ctx;
  const notes = effectiveNotes(data, o.seriesId, o.date).filter((n) => n.did || n.talked || n.next_check);
  const p = h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '訪問メモ'));
  if (!notes.length) p.append(h('p', { class: 'muted', style: 'margin:0 0 6px' }, 'まだメモはありません'));
  for (const n of notes) {
    const hist = noteHistory(data, n);
    const mineOrAdmin = isAdmin(ctx) || n.created_by === data.userId;
    p.append(h('div', { class: 'note-item' },
      h('div', { class: 'muted', style: 'font-size:13px' }, `${who(n.created_by)} ${fmtWhen(n.created_ms ?? t)}`, n._pending ? tag('未送信', 'pending') : null, hist.length ? tag('訂正あり') : null),
      n.did ? h('div', {}, h('span', { class: 'k' }, '何をした　'), n.did) : null,
      n.talked ? h('div', {}, h('span', { class: 'k' }, '何を話した　'), n.talked) : null,
      n.next_check ? h('div', {}, h('span', { class: 'k' }, '次回確認　'), n.next_check) : null,
      hist.length ? h('details', { class: 'inf-detail' }, h('summary', {}, '訂正の履歴'), ...hist.map((x) => h('div', { class: 'muted', style: 'font-size:13px' }, `${who(x.created_by)} ${fmtWhen(x.created_ms ?? t)}　${[x.did, x.talked, x.next_check].filter(Boolean).join(' / ') || '（内容なし）'}`))) : null,
      mineOrAdmin ? h('button', { class: 'link', type: 'button', on: { click: () => memoSheet(ctx, o, n) } }, '直す') : null));
  }
  p.append(h('button', { class: 'btn soft', type: 'button', on: { click: () => memoSheet(ctx, o, null) } }, 'メモを追加'));
  return p;
}

function memoSheet(ctx, o, existing) {
  const f = { did: textField('何をしたか', { value: existing?.did, multiline: true }), talked: textField('何を話したか', { value: existing?.talked, multiline: true }), next: textField('次回確認したいこと', { value: existing?.next_check, multiline: true }) };
  const msg = h('p', { class: 'err' });
  openSheet(existing ? '訪問メモを直す' : '訪問メモを追加', (close) => [existing ? h('p', { class: 'fine' }, '直すと、元のメモは履歴に残ります') : null, h('div', { 'data-keep': '' }, f.did.el, f.talked.el, f.next.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      const data = { appointment_id: o.seriesId, occurrence_date: o.date, outcome: existing?.outcome ?? 'done' };
      for (const [k, fld] of [['did', f.did], ['talked', f.talked], ['next_check', f.next]]) if (fld.get()) data[k] = fld.get();
      if (!data.did && !data.talked && !data.next_check) { msg.textContent = '内容を入力してください'; return; }
      if (existing) { data.corrects_id = existing.id; if (existing.trip) data.trip = existing.trip; }
      const v = validateRecord('visit_notes', data, { nowMs: ctx.now() });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      const r = await ctx.data.createRecord('visit_notes', data);
      if (r.ok) { toast('メモを保存しました（相手の端末への共有待ち）'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '保存できませんでした';
    } } }, '保存する'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---- 質問メモ：単純なチェック操作。済み・未済は追加記録（履歴が残る）----

function questionsPanel(ctx, o) {
  const { data } = ctx;
  const a = o.appt;
  const open = openQuestionsFor(data, a);
  const done = doneQuestionsFor(data, a);
  const p = h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '次回質問メモ'));
  if (!open.length) p.append(h('p', { class: 'muted', style: 'margin:0 0 6px' }, '聞きたいことは登録されていません'));
  for (const q of open) p.append(qRow(ctx, q, false));
  p.append(h('button', { class: 'btn soft', type: 'button', on: { click: () => questionSheet(ctx, a, null) } }, '質問を追加'));
  if (done.length) p.append(h('details', { class: 'inf-detail' }, h('summary', {}, `済んだ質問（${done.length}）`), ...done.map((q) => qRow(ctx, q, true))));
  p.append(h('p', { class: 'fine' }, '未済の質問は、同じ種類の次の予定にも表示されます'));
  return p;
}

function qRow(ctx, q, done) {
  const canEdit = isAdmin(ctx) || q.authorId === ctx.data.userId;
  const box = h('input', { type: 'checkbox', class: 'qbox', checked: done, 'aria-label': done ? `${q.content}（済み。押すと未済に戻す）` : `${q.content}（未済。押すと済みにする）`,
    on: { change: async (e) => {
      if (previewBlocked()) { e.target.checked = done; return; }
      const r = await ctx.data.createRecord('tasks', { entry: 'check', question_id: q.rootId, checked: !done });
      toast(r.ok ? (done ? '未済に戻しました' : '済みにしました') : (r.message ?? '記録できませんでした'));
      ctx.refresh();
    } } });
  return h('label', { class: 'qrow' }, box, h('span', { class: 'qtext' }, q.content,
    h('span', { class: 'muted', style: 'font-size:13px;display:block' }, `${who(q.authorId)} ${fmtWhen(q.createdMs ?? 0)}${done ? `　済み：${who(q.doneBy)} ${fmtWhen(q.doneMs ?? 0)}` : ''}`, q.pending ? tag('未送信', 'pending') : null)),
    canEdit ? h('button', { class: 'link', type: 'button', style: 'font-size:14px', on: { click: (e) => { e.preventDefault(); questionSheet(ctx, { kind: q.kind, provider: q.provider }, q); } } }, '直す') : null);
}

function questionSheet(ctx, a, existing) {
  const f = { content: textField('質問', { value: existing?.content, multiline: true, hint: `${a.kind}${a.provider ? `（${a.provider}）` : ''}の次の予定で聞きます` }) };
  const msg = h('p', { class: 'err' });
  openSheet(existing ? '質問を直す' : '質問を追加', (close) => [h('div', { 'data-keep': '' }, f.content.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      const data = { entry: 'question', content: f.content.get(), kind: a.kind };
      if (a.provider) data.provider = a.provider;
      if (existing) data.corrects_id = existing.id;
      const v = validateRecord('tasks', data, { nowMs: ctx.now() });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      const r = await ctx.data.createRecord('tasks', data);
      if (r.ok) { toast('質問を保存しました（相手の端末への共有待ち）'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '保存できませんでした';
    } } }, '保存する'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---------------------------------------------------------------------------
// 管理者：予定の登録・変更・この回だけの変更/中止

function adminPanel(ctx, o) {
  const a = o.appt;
  const series = ctx.data.get('appointments', o.seriesId);
  const p = h('section', { class: 'panel' }, h('h2', { style: 'font-size:17px' }, '予定の管理（管理者）'));
  const recurring = series?.recur?.freq && series.recur.freq !== 'none';
  p.append(h('div', { class: 'row' }, h('button', { class: 'btn soft', type: 'button', on: { click: () => apptSheet(ctx, series, o) } }, recurring ? 'この回だけ変更' : '予定を変更'),
    o.status === 'cancelled' ? null : h('button', { class: 'btn soft', type: 'button', on: { click: () => cancelOne(ctx, o, series) } }, recurring ? 'この回だけ中止' : '予定を中止')));
  if (o.exception) p.append(h('button', { class: 'link', type: 'button', on: { click: () => undoException(ctx, o) } }, 'この回の変更・中止を元に戻す'));
  if (recurring) p.append(h('button', { class: 'link', type: 'button', on: { click: () => apptSheet(ctx, series, null) } }, '繰り返しの設定を編集（すべての回）'));
  if (series) p.append(h('button', { class: 'link', type: 'button', style: 'color:var(--danger)', on: { click: () => deleteSeries(ctx, series) } }, '予定を削除（すべての回）'));
  return p;
}

async function cancelOne(ctx, o, series) {
  const recurring = series?.recur?.freq && series.recur.freq !== 'none';
  const yes = await confirmSheet({ title: recurring ? 'この回だけ中止しますか？' : '予定を中止しますか？', lines: [`${o.appt.kind}　${md(o.startMs)} ${hhmm(o.startMs)}　${o.appt.provider || ''}`, recurring ? '他の回と、繰り返しの設定は変わりません' : '', '実績の記録とは別に、予定の中止として残ります'].filter(Boolean), okLabel: '中止する', danger: true });
  if (!yes) return;
  const data = exceptionData(series, o, 'cancelled', {});
  const v = validateRecord('appointments', data, { nowMs: ctx.now() });
  if (!v.ok) { toast(v.errors.map((e) => e.message).join(' / ')); return; }
  const r = await ctx.data.createRecord('appointments', data);
  toast(r.ok ? '中止しました' : (r.message ?? '中止できませんでした'));
  ctx.refresh();
}

function exceptionData(series, o, kind, over) {
  const base = { kind: series.kind, start_ms: o.startMs, provider: series.provider, phone: series.phone, staff: series.staff, memo: series.memo, booking: series.booking,
    travel_min: series.travel_min, arrival_margin_min: series.arrival_margin_min, end_ms: o.endMs ?? undefined, ...over };
  const out = { recur: { freq: 'none' }, series_id: series.id, occurrence_date: o.date, exception: kind };
  for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

async function undoException(ctx, o) {
  if (!o.exception) return;
  const yes = await confirmSheet({ title: 'この回を元の予定に戻しますか？', lines: ['この回の変更・中止の記録は取り消され（履歴には残ります）、元の予定の内容に戻ります'], okLabel: '元に戻す' });
  if (!yes) return;
  const r = await ctx.data.softDelete('appointments', o.exception.id, o.exception.version);
  toast(r.ok ? '元に戻しました' : (r.message ?? '戻せませんでした'));
  ctx.refresh();
}

async function deleteSeries(ctx, series) {
  const yes = await confirmSheet({ title: 'この予定を削除しますか？', lines: [`${series.kind}　${series.provider || ''}`, 'すべての回が表示されなくなります（記録は履歴に残ります）。この回だけをやめるときは「この回だけ中止」を使ってください'], okLabel: '削除する', danger: true });
  if (!yes) return;
  const r = await ctx.data.softDelete('appointments', series.id, series.version);
  toast(r.ok ? '削除しました' : (r.message ?? '削除できませんでした'));
  mode = { view: 'list' };
  ctx.refresh();
}

/** 予定のフォーム。series＝null で新規／series あり・occurrence なしで全体の編集／series と occurrence でこの回だけの変更 */
function apptSheet(ctx, series, occurrence) {
  const oneOff = Boolean(series && occurrence);
  const t = ctx.now();
  const base = oneOff ? { ...series, ...occurrence.appt, start_ms: occurrence.startMs, end_ms: occurrence.endMs } : (series ?? {});
  const startMs = base.start_ms ?? t;
  const f = {
    kind: selectField('種類', APPT_KINDS.map((k) => [k, k]), { value: base.kind ?? '訪問看護' }),
    date: dateField('日付', { value: toDateInput(startMs) }),
    start: timeField('開始時刻', { value: toLocalInput(startMs).slice(11) }),
    end: timeField('終了時刻（任意）', { value: base.end_ms ? toLocalInput(base.end_ms).slice(11) : '' }),
    provider: textField('医療機関・事業所名', { value: base.provider }),
    phone: textField('電話番号', { value: base.phone, placeholder: '例 0467-00-0000' }),
    staff: textField('担当者（任意）', { value: base.staff }),
    memo: textField('メモ', { value: base.memo, multiline: true }),
    booking: selectField('予約の状態', [['confirmed', '確定'], ['tentative', '予定（未確定）']], { value: base.booking ?? 'confirmed' }),
    freq: selectField('繰り返し', [['none', 'なし'], ['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月']], { value: base.recur?.freq ?? 'none' }),
    weekday: selectField('曜日', WEEK.map((w, i) => [i, `${w}曜日`]), { value: base.recur?.weekday ?? new Date(startMs + JST).getUTCDay() }),
    day: selectField('日にち', Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1}日`]), { value: base.recur?.day ?? new Date(startMs + JST).getUTCDate() }),
    until: dateField('繰り返しの終了日（任意）', { value: base.recur?.until ?? '' }),
    travel: numberField('移動時間（分）', { value: base.travel_min, inputMode: 'numeric', hint: '自宅から病院まで。出発の目安の計算に使います' }),
    margin: numberField('到着の余裕（分）', { value: base.arrival_margin_min ?? DEFAULT_ARRIVAL_MARGIN_MIN, inputMode: 'numeric', hint: '診療予約の何分前に着くか（日赤は60分）' }),
  };
  // 予定先（設定の予定先マスタ）：選ぶと、名称・電話番号・移動時間・到着の余裕が入る。「その他」は自由入力
  const places = listPlaces(ctx.data);
  const OTHER = '__other__';
  const candidates = () => places.filter((p) => p.kinds.includes(f.kind.get()));
  // 候補が複数なら、誤登録を避けるため初期は未選択（'')。1件だけなら自動で選ぶ。なければ「その他」だけ
  const placeOpts = () => {
    const c = candidates();
    return [...(c.length > 1 ? [['', '予定先を選んでください']] : []), ...c.map((p) => [p.id, p.name]), [OTHER, 'その他（自由入力）']];
  };
  const defaultPlace = () => { const c = candidates(); return c.length === 1 ? c[0].id : c.length > 1 ? '' : OTHER; };
  const initial = findPlace(places, base.provider, base.kind);
  f.place = selectField('予定先', placeOpts(), { value: series ? (initial && initial.kinds.includes(base.kind) ? initial.id : OTHER) : defaultPlace() });
  const redrawPlace = () => {
    const cur = f.place.input.value;
    const opts = placeOpts();
    f.place.input.replaceChildren(...opts.map(([v, text]) => h('option', { value: String(v) }, text)));
    f.place.input.value = opts.some(([v]) => v === cur) ? cur : defaultPlace();   // 種類を変えて合わなくなったら、その種類の既定（1件なら自動、複数なら未選択）
  };
  let autoFilled = false;
  const fillFromPlace = () => {
    const p = places.find((x) => x.id === f.place.input.value);
    if (!p && autoFilled) { f.provider.set(''); f.phone.set(''); autoFilled = false; }   // 自動で入れた内容は、「その他」に切り替えたら消す（手入力した内容は消さない）
    if (p) {
      autoFilled = true;
      f.provider.set(p.name); f.phone.set(p.phone ?? '');
      if (p.travel_min != null) f.travel.set(p.travel_min);
      if (p.arrival_margin_min != null) f.margin.set(p.arrival_margin_min);
    }
    detail.hidden = f.place.input.value !== OTHER;   // 名称・電話番号の入力欄は「その他（自由入力）」のときだけ
    placeSummary.textContent = p ? [p.phone, p.address].filter(Boolean).join('　') : '';
  };
  const placeSummary = h('p', { class: 'fine', style: 'margin:0 0 6px' });
  const detail = h('div', {}, f.provider.el, f.phone.el);
  const placeBox = places.length ? h('div', {}, f.place.el, placeSummary) : null;
  const recurBox = h('div', {}, f.freq.el, h('div', { class: 'wk' }, f.weekday.el), h('div', { class: 'dy' }, f.day.el), f.until.el);
  const tripBox = h('div', {}, h('div', { class: 'grid2' }, f.travel.el, f.margin.el));
  const sync = () => {
    const fr = f.freq.get();
    recurBox.querySelector('.wk').hidden = fr !== 'weekly'; recurBox.querySelector('.dy').hidden = fr !== 'monthly'; f.until.el.hidden = fr === 'none';
    tripBox.hidden = f.kind.get() !== '通院';
  };
  f.freq.input.addEventListener('change', sync); f.kind.input.addEventListener('change', () => { sync(); redrawPlace(); fillFromPlace(); });
  f.place.input.addEventListener('change', fillFromPlace);
  const msg = h('p', { class: 'err', role: 'alert' });
  const title = oneOff ? 'この回だけ変更' : series ? '予定を変更' : '予定を登録';
  openSheet(title, (close) => [h('div', { 'data-keep': '' },
    f.kind.el, placeBox, detail, h('div', { class: 'grid2' }, f.date.el, f.start.el), f.memo.el,
    h('details', { class: 'inf-detail' }, h('summary', {}, '詳細設定'), f.end.el, f.staff.el, f.booking.el,
      oneOff ? h('p', { class: 'fine' }, `${md(occurrence.startMs)} の回だけを変更します（他の回は変わりません）`) : recurBox, tripBox), msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      const sMs = fromLocalInput(`${f.date.get()}T${f.start.get()}`);
      const eMs = f.end.get() ? fromLocalInput(`${f.date.get()}T${f.end.get()}`) : undefined;
      if (!sMs) { msg.textContent = '日付と開始時刻を入力してください'; return; }
      if (f.place.input.value === '') { msg.textContent = '予定先を選んでください（該当がなければ「その他」を選びます）'; return; }
      const fr = f.freq.get();
      const data = { kind: f.kind.get(), start_ms: sMs, provider: f.provider.get(), phone: f.phone.get(), staff: f.staff.get(), memo: f.memo.get(), booking: f.booking.get() };
      if (eMs) data.end_ms = eMs;
      for (const k of ['provider', 'phone', 'staff', 'memo']) if (!data[k]) delete data[k];
      if (f.kind.get() === '通院') { if (f.travel.get() !== undefined) data.travel_min = f.travel.get(); if (f.margin.get() !== undefined) data.arrival_margin_min = f.margin.get(); }
      let record = data;
      if (oneOff) record = exceptionData(series, occurrence, 'changed', data);
      else { data.recur = { freq: fr }; if (fr === 'weekly') data.recur.weekday = f.weekday.get(); if (fr === 'monthly') data.recur.day = f.day.get(); if (fr !== 'none' && f.until.get()) data.recur.until = f.until.get(); }
      const v = validateRecord('appointments', record, { nowMs: t });
      const rest = showErrors(f, v.errors);
      if (!v.ok) { msg.textContent = rest.join(' / '); return; }
      const lines = [`${record.kind}　${md(record.start_ms)} ${hhmm(record.start_ms)}${record.end_ms ? `〜${hhmm(record.end_ms)}` : ''}`, record.provider ?? '', oneOff ? 'この回だけの変更です' : `繰り返し：${{ none: 'なし', daily: '毎日', weekly: `毎週${WEEK[record.recur?.weekday]}曜日`, monthly: `毎月${record.recur?.day}日` }[record.recur?.freq]}`].filter(Boolean);
      if (!await confirmSheet({ title: '予定を保存しますか？', lines, okLabel: '保存する' })) return;
      const r = series && !oneOff ? await ctx.data.updateRecord('appointments', series.id, series.version, record) : await ctx.data.createRecord('appointments', record);
      if (r.ok) { toast('予定を保存しました'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '保存できませんでした';
    } } }, '確認へ'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
  sync();
  if (!series) fillFromPlace(); else detail.hidden = f.place.input.value !== OTHER;
  if (series) placeSummary.textContent = initial ? [initial.phone, initial.address].filter(Boolean).join('　') : '';
}
