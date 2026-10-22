// 記録の画面：体調、針交換、日常の処分確認（ルート・バッグ）。
// 毎日の必須入力は記録の日時だけ（要件§7）。入力は検証（src/validation/records.js）を通ってから確認画面へ進む。
// 更新はサーバー側の検証のため、完全な内容を送る（変更した項目だけを送らない）。

import { h, clear, openSheet, confirmSheet, toast, fmtWhen, fmtDate, fmtDateShort, toDateInput } from '../ui.js';
import { textField, numberField, selectField, dateTimeField, dateField, choiceField, showErrors } from '../forms.js';
import { validateRecord, SYMPTOMS } from '../../../src/validation/records.js';
import { healthLine, healthDetail, CONDITION_VIEW, isLegacyHealth } from '../health-view.js';
import { monthlySummary, jstYearMonth } from '../../../src/health/summary.js';
import { buildTimeline, who } from '../timeline.js';

export function register(registerScreen) {
  registerScreen('records', (root, ctx) => renderRecords(root, ctx));
}

let tab = 'timeline';
const TABS = [['timeline', '一覧'], ['health', '体調'], ['needle', '針交換']];

function renderRecords(root, ctx) {
  const { params } = ctx;
  if (params?.intent === 'health') { tab = 'health'; params.intent = null; queueMicrotask(() => healthSheet(ctx, null)); }
  if (params?.intent === 'needle') { tab = 'needle'; params.intent = null; }
  clear(root);
  // 新規の入口：どの切り替えを開いていても、いちばん上から体調を記録できる
  root.append(h('button', { class: 'btn', type: 'button', style: 'margin-bottom:12px', on: { click: () => healthSheet(ctx, null) } }, '＋ 体調を記録'));
  root.append(h('div', { class: 'seg', role: 'tablist', style: 'margin-bottom:12px' },
    ...TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': k === tab ? 'true' : 'false', on: { click: () => { tab = k; ctx.refresh(); } } }, label))));
  if (tab === 'health') renderHealth(root, ctx);
  else if (tab === 'needle') renderNeedle(root, ctx);
  else renderTimeline(root, ctx);
}

const tagPending = (d) => (d._pending ? h('span', { class: 'tag pending' }, '未送信') : null);

function save(ctx, r, text) {
  if (r.ok) toast(text); else toast(r.message ?? '記録できませんでした');
  return r;
}

/** 入力 → 検証 → 確認画面 → 保存 の共通の流れ。成功したらシートを閉じる */
function formSheet(ctx, title, fields, body, build, { confirm, submit, okText, submitLabel = '確認へ', okLabel = '記録する' }) {
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet(title, (close) => [
    h('div', { 'data-keep': '' }, ...body, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      const built = build();
      if (built.error) { msg.textContent = built.error; return; }
      const v = validateRecord(built.collection, built.data, { nowMs: ctx.now() });
      const rest = showErrors(fields, v.errors);
      if (!v.ok) { msg.textContent = rest.join(' / '); return; }
      const yes = await confirmSheet({ title: confirm.title, lines: confirm.lines(built.data), okLabel });
      if (!yes) return;
      const r = save(ctx, await submit(built), okText);
      if (r.ok) { close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
    } } }, submitLabel),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる'),
  ]);
}

// ---------------------------------------------------------------------------
// 体調：4段階（💗OK／😊普通／😅おや？／😰つらい）＋症状（複数選択）＋任意のメモ。数値（体温・血圧など）は別のアプリで記録するため入力しない。
// 保存は評価（condition）・症状（symptoms）・メモ（memo）を別々に持つ。過去の数値の記録は、そのまま保持して表示する。

function renderHealth(root, ctx) {
  const t = ctx.now();
  const logs = ctx.data.list('health_logs').sort((a, b) => b.logged_ms - a.logged_ms);
  root.append(monthSummary(ctx, logs));
  const box = h('section', { class: 'panel hist', style: 'margin-top:10px' });
  if (!logs.length) box.append(h('p', { class: 'muted' }, 'まだ記録がありません'));
  let last = null;
  const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  for (const d of logs.slice(0, 80)) {
    const dt = new Date(d.logged_ms + 9 * 3_600_000);
    const dayKey = `${dt.getUTCMonth()}-${dt.getUTCDate()}`;
    if (dayKey !== last) { box.append(h('div', { class: 'hmonth' }, `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}（${DAYS[dt.getUTCDay()]}）`)); last = dayKey; }
    const detail = healthDetail(d);
    const canEdit = !isLegacyHealth(d) && (ctx.data.role === 'admin' || d.created_by === ctx.data.userId);
    const body = h('div', { class: 'hbody', hidden: true },
      detail ? h('p', { style: 'white-space:pre-wrap;margin:2px 0 4px' }, detail) : h('p', { class: 'muted', style: 'margin:2px 0 4px' }, 'メモはありません'),
      h('div', { class: 'muted', style: 'font-size:13px' }, `${who(d.created_by)}　${fmtWhen(d.logged_ms)}　${d._pending ? '保存済み・未送信' : '共有済み'}`),
      canEdit ? h('button', { class: 'link', type: 'button', on: { click: () => healthSheet(ctx, d) } }, '直す') : null);
    const row = h('button', { class: 'hline hrow-health', type: 'button', 'aria-expanded': 'false', on: { click: () => { body.hidden = !body.hidden; row.setAttribute('aria-expanded', String(!body.hidden)); } } },
      h('span', { class: 'num htime' }, `${dt.getUTCHours()}:${String(dt.getUTCMinutes()).padStart(2, '0')}`), h('span', { class: 'hcond' }, healthLine(d)),
      detail ? h('span', { class: 'hmemo', 'aria-label': 'メモあり' }, '…') : null, d._pending ? h('span', { class: 'tag pending' }, '未送信') : null);
    box.append(h('div', { class: 'hitem' }, row, body));
  }
  root.append(box);
}

/** 当月の体調の傾向。1行（「10月の体調：💗【OK】が最多 60%（記録20日）」）、タップで4段階の件数と割合。表示側の集計だけ */
function monthSummary(ctx, logs) {
  const { year, month } = jstYearMonth(ctx.now());
  const s = monthlySummary(logs, { year, month });
  const label = (k) => `${CONDITION_VIEW[k].emoji}【${CONDITION_VIEW[k].label}】`;
  const pct = (k) => `${Math.round(s.percents[k])}%`;
  if (!s.days) return h('div', { class: 'msum' }, h('div', { class: 'msum-line' }, `${month}月の体調：まだ記録がありません`));
  const line = s.top.length === 1
    ? `${month}月の体調：${label(s.top[0])}が最多 ${pct(s.top[0])}（記録${s.days}日）`
    : `${month}月の体調：${s.top.map(label).join('・')}が同率最多 ${pct(s.top[0])}（記録${s.days}日）`;
  return h('details', { class: 'msum' }, h('summary', { class: 'msum-line' }, line),
    h('div', { class: 'msum-body' }, ...Object.keys(CONDITION_VIEW).map((k) => h('div', { class: 'kv' },
      h('span', {}, label(k)), h('span', { class: 'num' }, `${s.counts[k]}日　${pct(k)}`))),
    h('p', { class: 'fine' }, '記録のある日が分母（同じ日は最新の評価。以前の形式は含めません）')));
}

function healthSheet(ctx, existing) {
  const t = ctx.now();
  let cond = existing?.condition ?? null;
  const picked = new Set(existing?.symptoms ?? []);
  const condBtns = Object.entries(CONDITION_VIEW).map(([key, v]) => {
    const b = h('button', { type: 'button', class: 'cbtn', 'aria-pressed': String(cond === key), on: { click: () => { cond = key; condBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.k === cond))); } } },
      h('span', { class: 'cemoji', 'aria-hidden': 'true' }, v.emoji), `【${v.label}】`);
    b.dataset.k = key;
    return b;
  });
  const symBtns = SYMPTOMS.map((name) => h('button', { type: 'button', class: 'sbtn', 'aria-pressed': String(picked.has(name)), on: { click: (e) => {
    if (picked.has(name)) picked.delete(name); else picked.add(name);
    e.currentTarget.setAttribute('aria-pressed', String(picked.has(name)));
  } } }, name));
  const memo = textField('メモ（任意）', { value: existing?.memo, multiline: true });
  const when = dateTimeField('記録の日時', { value: existing?.logged_ms ?? t });
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet(existing ? '体調の記録を直す' : '体調を記録', (close) => [
    h('div', { 'data-keep': '' },
      h('div', { class: 'lbl', style: 'font-size:15px;color:var(--ink-soft)' }, '今の様子'), h('div', { class: 'cgrid' }, ...condBtns),
      h('div', { class: 'lbl', style: 'font-size:15px;color:var(--ink-soft);margin-top:12px' }, '症状（あれば。複数選べます）'), h('div', { class: 'sgrid' }, ...symBtns),
      h('details', { class: 'inf-detail' }, h('summary', {}, 'メモ・日時（任意）'), memo.el, when.el), msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      if (!cond) { msg.textContent = '今の様子を選んでください'; return; }
      const data = { logged_ms: when.get() ?? t, condition: cond };
      if (picked.size) data.symptoms = SYMPTOMS.filter((x) => picked.has(x));     // 候補の順に保存
      if (memo.get()) data.memo = memo.get();
      const v = validateRecord('health_logs', data, { nowMs: t });
      if (!v.ok) { msg.textContent = v.errors.map((e) => e.message).join(' / '); return; }
      // 日常の記録なので、確認画面は挟まない（誤りは「直す」で）
      const r = existing ? await ctx.data.updateRecord('health_logs', existing.id, existing.version, data) : await ctx.data.createRecord('health_logs', data);
      if (r.ok) { toast(`${healthLine(data)} を記録しました`); close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
    } } }, '記録する'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---------------------------------------------------------------------------
// 針交換（初期設定は週1回）

function renderNeedle(root, ctx) {
  root.append(h('button', { class: 'btn', type: 'button', on: { click: () => needleSheet(ctx) } }, '針交換を記録する'));
  const logs = ctx.data.list('needle_changes').sort((a, b) => String(b.changed_on).localeCompare(String(a.changed_on)));
  const next = logs.find((n) => n.next_due_on);
  root.append(h('section', { class: 'panel', style: 'margin-top:12px' },
    h('div', { class: 'kv' }, h('span', { class: 'k' }, '最終交換日'), h('span', { class: 'num', style: 'font-size:20px;font-weight:700' }, logs[0]?.changed_on ?? 'まだありません')),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, '次回予定日'), h('span', { class: 'num', style: 'font-size:20px;font-weight:700' }, next?.next_due_on ?? '未設定'))));
  const list = h('ul', { class: 'list' });
  for (const n of logs.slice(0, 60)) list.append(h('li', {}, h('strong', { class: 'num' }, n.changed_on), tagPending(n),
    h('div', { class: 'muted' }, `実施者 ${n.performed_by || '—'}　次回 ${n.next_due_on || '—'}`), n.note ? h('div', { class: 'muted' }, n.note) : null));
  root.append(h('section', { class: 'panel', style: 'margin-top:12px' }, h('h2', { style: 'font-size:19px' }, '交換の記録'), list.childElementCount ? list : h('p', { class: 'muted' }, 'まだ記録がありません')));
}

const addDays = (dateText, days) => { const [y, m, d] = dateText.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };

function needleSheet(ctx) {
  const today = toDateInput(ctx.now());
  const f = {
    changed_on: dateField('交換した日', { value: today }),
    next_due_on: dateField('次回の予定日', { value: addDays(today, 7), hint: '初期設定は1週間後です。訪問看護の予定に合わせて直せます' }),
    performed_by: textField('実施した人'),
    note: textField('備考', { multiline: true }),
  };
  f.changed_on.input.addEventListener('change', () => { if (f.changed_on.get()) f.next_due_on.set(addDays(f.changed_on.get(), 7)); });
  formSheet(ctx, '針交換を記録する', f, Object.values(f).map((x) => x.el),
    () => ({ collection: 'needle_changes', data: Object.fromEntries(Object.entries({ changed_on: f.changed_on.get(), next_due_on: f.next_due_on.get(), performed_by: f.performed_by.get(), note: f.note.get() }).filter(([, v]) => v)) }),
    { confirm: { title: '針交換を記録しますか？', lines: (d) => [`交換した日：${d.changed_on}`, `次回の予定日：${d.next_due_on ?? '未設定'}`] }, okText: '針交換を記録しました', submit: (b) => ctx.data.createRecord('needle_changes', b.data) });
}

// ---------------------------------------------------------------------------
// 一覧：これまでの記録を、新しい順の1本の時系列で。誰が・いつ・何を、未送信かが分かる（入力の入口は予定・点滴・HOME）

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JST_MS = 9 * 3_600_000;

function renderTimeline(root, ctx) {
  const items = buildTimeline(ctx.data).slice(0, 200);
  const box = h('section', { class: 'panel hist' });
  if (!items.length) box.append(h('p', { class: 'muted' }, 'まだ記録がありません'));
  let last = null;
  for (const it of items) {
    const d = new Date(it.ms + JST_MS);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (dayKey !== last) { box.append(h('div', { class: 'hmonth' }, `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${DAYS[d.getUTCDay()]}）`)); last = dayKey; }
    const row = h('div', { class: 'trow', role: 'button', tabindex: '0', 'aria-expanded': 'false' },
      h('span', { class: 'num ttime' }, `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`),
      h('span', { class: 'tmain' }, h('span', { class: 'tlabel' }, it.label), it.detail ? h('span', { class: 'tdetail' }, it.detail) : null),
      h('span', { class: 'twho' }, who(it.by), it.pending ? h('span', { class: 'tag pending' }, '未送信') : null));
    const toggle = () => { const open = row.classList.toggle('open'); row.setAttribute('aria-expanded', String(open)); };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    box.append(row);
  }
  root.append(box);
}
