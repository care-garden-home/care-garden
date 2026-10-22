// 設定・データ（管理者のみ）：端末、点滴の指示、誕生日（背景）、出力（CSV・JSON）、復元の検証、廃棄物（針の引き渡し）。
// 権限はサーバー側でも強制される。母の画面にはこのタブを出さない。

import { h, why, clear, openSheet, confirmSheet, toast, previewBlocked, fmtWhen, fmtDate, toDateInput } from '../ui.js';
import { textField, numberField, selectField, dateField, choiceField, showErrors } from '../forms.js';
import { validateRecord, normalizeBirthday, HANDOVER_STATUS, APPT_KINDS } from '../../../src/validation/records.js';
import { toCsv, filterByPeriod, dayRangeMs } from '../../../src/export/csv.js';
import { createBackup, serializeBackup, validateFile, verifyRestorable } from '../../../src/backup/backup.js';
import { sha256Hex } from '../sha256.js';
import { uuid } from '../data.js';
import { startRestore, showUnfinishedRestore } from '../restore-ui.js';
import { listPlaces, PLACE_PREFIX } from '../places.js';
import { phoneActions } from '../phone.js';

export const APP_VERSION = '0.1.0';

export function register(registerScreen) {
  registerScreen('settings', (root, ctx) => renderSettings(root, ctx));
}

let tab = 'devices';
const TABS = [['devices', '端末'], ['places', '予定先'], ['orders', '点滴の指示'], ['birthday', '背景'], ['export', '出力'], ['restore', '復元'], ['waste', '廃棄物']];

function renderSettings(root, ctx) {
  if (TABS.some(([k]) => k === ctx.params?.intent)) { tab = ctx.params.intent; ctx.params.intent = null; }
  clear(root);
  if (ctx.data.role !== 'admin') { root.append(h('section', { class: 'panel' }, 'この画面は管理者だけが使えます')); return; }
  root.append(h('div', { class: 'seg', role: 'tablist', style: 'margin-bottom:12px' },
    ...TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': k === tab ? 'true' : 'false', on: { click: () => { tab = k; ctx.refresh(); } } }, label))));
  ({ devices: renderDevices, places: renderPlaces, orders: renderOrders, birthday: renderBirthday, export: renderExport, restore: renderRestore, waste: renderWaste })[tab](root, ctx);
}

const panel = (title, ...children) => h('section', { class: 'panel', style: 'margin-bottom:12px' }, title ? h('h2', { style: 'font-size:19px;margin-bottom:6px' }, title) : null, ...children);
const dl = (name, text, type = 'text/plain;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
const stamp = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');

// ---------------------------------------------------------------------------
// 端末

function renderDevices(root, ctx) {
  const list = h('ul', { class: 'list' }, h('li', { class: 'muted' }, '読み込み中…'));
  const code = h('div', { 'aria-live': 'polite' });
  ctx.data.call('device.list').then((res) => {
    clear(list);
    if (!res || res.ok !== true) { list.append(h('li', { class: 'err' }, '端末の一覧を取得できませんでした（通信できないか、権限がありません）')); return; }
    if (!res.data.length) list.append(h('li', { class: 'muted' }, '登録された端末はありません'));
    for (const d of res.data) {
      const revoked = d.revokedMs != null;
      list.append(h('li', {}, h('strong', {}, d.label), h('span', { class: 'tag' }, d.userId === 'u_admin' ? '管理者' : '母'), revoked ? h('span', { class: 'tag pending' }, '失効') : null,
        h('div', { class: 'muted' }, `登録 ${fmtWhen(d.pairedMs, ctx.now())}　最後の通信 ${d.lastSeenMs ? fmtWhen(d.lastSeenMs, ctx.now()) : '—'}`),
        revoked ? null : h('button', { class: 'link', type: 'button', on: { click: async () => {
          if (!await confirmSheet({ title: 'この端末を失効しますか？', lines: [`${d.label}`, '失効すると、この端末は記録を読み書きできなくなります'], okLabel: '失効する', danger: true })) return;
          const r = await ctx.data.call('device.revoke', { device_id: d.deviceId });
          toast(r?.ok ? '失効しました' : '失効できませんでした'); ctx.refresh();
        } } }, '失効する')));
    }
  });
  root.append(panel('端末の登録コードを発行する',
    h('p', { class: 'fine' }, '新しい端末用のコード（10分で期限切れ）'),
    h('button', { class: 'btn', type: 'button', on: { click: () => issueSheet(ctx, code) } }, 'コードを発行する'), code),
  panel('登録されている端末', list,
    h('button', { class: 'btn danger', type: 'button', style: 'margin-top:12px', on: { click: async () => {
      if (!await confirmSheet({ title: 'すべての端末を失効しますか？', lines: ['この端末を含む、すべての端末が使えなくなります。', '端末をなくした、盗まれたなど、緊急のときに使います'], okLabel: 'すべて失効する', danger: true })) return;
      const r = await ctx.data.call('device.revokeAll'); toast(r?.ok ? 'すべて失効しました' : '失効できませんでした');
      if (r?.ok) ctx.data.signOut();
    } } }, 'すべての端末を失効する')));
}

function issueSheet(ctx, out) {
  const f = { user: choiceField('使う人', [['u_mother', '母'], ['u_admin', '管理者']], {}), label: textField('端末の名前', { placeholder: '例：母のiPhone' }) };
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet('端末の登録コードを発行する', (close) => [f.user.el, f.label.el, msg,
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      if (!f.user.get()) { f.user.setError('選んでください'); return; }
      if (!f.label.get()) { f.label.setError('端末の名前を入力してください'); return; }
      const r = await ctx.data.call('pair.issue', { user_id: f.user.get(), label: f.label.get() });
      if (!r?.ok) { msg.textContent = 'コードを発行できませんでした'; return; }
      close(); clear(out).append(h('div', { class: 'panel', style: 'margin-top:12px;border:2px solid var(--primary)' }, h('div', { class: 'muted' }, `${f.label.get()} 用の登録コード（10分間）`),
        h('div', { class: 'big', style: 'letter-spacing:.12em;text-align:center' }, r.code), h('p', { class: 'muted' }, 'コードは他の人に見せないでください。この画面を閉じると、もう表示されません。')));
    } } }, '発行する'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---------------------------------------------------------------------------
// 予定先マスタ：予定を作るたびに名称・電話番号を入力しなくてよいように、よく使う予定先を登録しておく（母娘で共有する設定）

function renderPlaces(root, ctx) {
  const places = listPlaces(ctx.data);
  root.append(panel('予定先', h('p', { class: 'fine' }, '登録した予定先は、予定の登録で選ぶだけで、名称・電話番号などが入ります'),
    h('button', { class: 'btn', type: 'button', on: { click: () => placeSheet(ctx, null) } }, '予定先を追加')));
  const list = h('ul', { class: 'list' });
  for (const p of places) {
    list.append(h('li', {},
      h('strong', {}, p.name), p.id && ctx.data.list('settings').find((x) => x.id === p.id)?._pending ? h('span', { class: 'tag pending' }, '未送信') : null,
      h('div', { class: 'muted' }, p.kinds.join('・')),
      p.phone ? phoneActions(p.phone, { compact: true }) : null,
      p.address ? h('div', { class: 'muted' }, p.address) : null,
      p.travel_min != null || p.arrival_margin_min != null ? h('div', { class: 'muted' }, `${p.travel_min != null ? `移動 ${p.travel_min}分` : ''}${p.arrival_margin_min != null ? `　到着の余裕 ${p.arrival_margin_min}分` : ''}`) : null,
      h('button', { class: 'link', type: 'button', on: { click: () => placeSheet(ctx, p) } }, '直す')));
  }
  root.append(panel('登録されている予定先', places.length ? list : h('p', { class: 'muted' }, 'まだ登録がありません')));
}

function placeSheet(ctx, existing) {
  const f = {
    name: textField('名称', { value: existing?.name }),
    phone: textField('電話番号', { value: existing?.phone, placeholder: '例 0467-00-0000' }),
    address: textField('住所（必要な場合）', { value: existing?.address, multiline: true }),
    travel: numberField('移動時間（分・通院など）', { value: existing?.travel_min, inputMode: 'numeric' }),
    margin: numberField('到着の余裕（分・通院など）', { value: existing?.arrival_margin_min, inputMode: 'numeric' }),
  };
  const picked = new Set(existing?.kinds ?? []);
  const kindBtns = APPT_KINDS.map((k) => h('button', { type: 'button', class: 'sbtn', 'aria-pressed': String(picked.has(k)), on: { click: (e) => {
    if (picked.has(k)) picked.delete(k); else picked.add(k);
    e.currentTarget.setAttribute('aria-pressed', String(picked.has(k)));
  } } }, k));
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet(existing ? '予定先を直す' : '予定先を追加', (close) => [h('div', { 'data-keep': '' },
    f.name.el,
    h('div', { class: 'lbl', style: 'font-size:15px;color:var(--ink-soft)' }, '予定の種類（同じ事業者で複数あれば、すべて選ぶ）'), h('div', { class: 'sgrid' }, ...kindBtns),
    f.phone.el, f.address.el, h('div', { class: 'grid2' }, f.travel.el, f.margin.el), msg),
  h('button', { class: 'btn', type: 'button', on: { click: async () => {
    msg.textContent = '';
    const value = { name: f.name.get(), kinds: APPT_KINDS.filter((k) => picked.has(k)) };
    if (f.phone.get()) value.phone = f.phone.get();
    if (f.address.get()) value.address = f.address.get();
    if (f.travel.get() !== undefined) value.travel_min = f.travel.get();
    if (f.margin.get() !== undefined) value.arrival_margin_min = f.margin.get();
    if (!value.name) { msg.textContent = '名称を入力してください'; return; }
    if (!value.kinds.length) { msg.textContent = '予定の種類を1つ以上選んでください'; return; }
    const data = { key: existing?.key ?? `${PLACE_PREFIX}${uuid()}`, value, scope: 'global' };
    const check = validateRecord('settings', data);
    if (!check.ok) { msg.textContent = check.errors.some((e) => e.code === 'BAD_CHOICE') ? '電話番号や数値の入力を確かめてください' : check.errors.map((e) => e.message).join(' / '); return; }
    if (previewBlocked()) return;
    const r = existing ? await ctx.data.updateRecord('settings', existing.id, existing.version, data) : await ctx.data.createRecord('settings', data);
    if (r.ok) { toast('予定先を保存しました'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '保存できませんでした';
  } } }, '保存する'),
  existing ? h('button', { class: 'btn secondary', type: 'button', on: { click: async () => {
    if (!await confirmSheet({ title: 'この予定先を消しますか？', lines: ['登録済みの予定は変わりません'], okLabel: '消す', danger: true })) return;
    if (previewBlocked()) return;
    const r = await ctx.data.softDelete('settings', existing.id, existing.version); toast(r.ok ? '消しました' : r.message); close(); ctx.refresh();
  } } }, 'この予定先を消す') : null,
  h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---------------------------------------------------------------------------
// 点滴の指示（要件§5-1）

function renderOrders(root, ctx) {
  root.append(panel('点滴の指示', why('医療者から受けた指示を登録します。計算（逆算・推定）と、範囲外の警告に使われます。実際の投与条件は医師の指示に従ってください。'),
    h('button', { class: 'btn', type: 'button', on: { click: () => orderSheet(ctx, null) } }, '指示を登録する')));
  const orders = ctx.data.list('infusion_orders').sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0));
  const list = h('ul', { class: 'list' });
  for (const o of orders) list.append(h('li', {}, h('strong', {}, `${o.drug_name} ${o.volume_ml}mL`), o._pending ? h('span', { class: 'tag pending' }, '未送信') : null,
    h('div', { class: 'muted' }, `流量 ${o.rate_min ?? '—'}〜${o.rate_max ?? '—'} mL/h（${o.rate_step ?? 5}mL/h 刻み）　通常 ${o.usual_rate_min ?? '—'}〜${o.usual_rate_max ?? '—'}　長時間 ${o.long_rate_min ?? '—'}〜${o.long_rate_max ?? '—'}`),
    h('div', { class: 'muted' }, `終了目標 ${o.target_end_time ?? '—'}　指示日 ${o.ordered_on ?? '—'}　指示元 ${o.ordered_by ?? '—'}　有効 ${o.valid_from ?? '—'}〜${o.valid_to ?? '—'}`),
    h('button', { class: 'link', type: 'button', on: { click: () => orderSheet(ctx, o) } }, '直す')));
  root.append(panel('登録されている指示', list.childElementCount ? list : h('p', { class: 'muted' }, 'まだ登録がありません（初期値を使用中）', why('初期値：エルネオパNF2号 1500mL、60〜150mL/h、5mL/h刻み、通常120〜150、長時間60〜75、翌朝6:00'))));
  // 安全に関わる指示の未登録は、見える場所に短く出す（アプリは手順を決めない）
  const cur = orders[0];
  const gaps = [['閉塞時', 'occlusion_procedure'], ['気泡時', 'bubble_procedure'], ['フラッシュ', 'flush_instruction']].filter(([, k]) => !cur?.[k]?.trim()).map(([n]) => n);
  if (gaps.length) root.children[0].after(h('p', { class: 'note', role: 'status', style: 'margin:8px 0 0;color:var(--danger)' }, `未登録の指示：${gaps.join('・')}（医療者の指示を確認して登録してください）`));
}

function orderSheet(ctx, o) {
  const d = o ?? {};
  const f = {
    drug_name: textField('輸液名', { value: d.drug_name ?? 'エルネオパNF2号' }),
    volume_ml: numberField('基本容量（mL）', { value: d.volume_ml ?? 1500, inputMode: 'numeric' }),
    rate_step: numberField('調整単位（mL/h）', { value: d.rate_step ?? 5, inputMode: 'numeric' }),
    rate_min: numberField('流量の下限（mL/h）', { value: d.rate_min ?? 60, inputMode: 'numeric' }),
    rate_max: numberField('流量の上限（mL/h）', { value: d.rate_max ?? 150, inputMode: 'numeric' }),
    usual_rate_min: numberField('通常の下限（mL/h）', { value: d.usual_rate_min ?? 120, inputMode: 'numeric' }),
    usual_rate_max: numberField('通常の上限（mL/h）', { value: d.usual_rate_max ?? 150, inputMode: 'numeric' }),
    long_rate_min: numberField('長時間の下限（mL/h）', { value: d.long_rate_min ?? 60, inputMode: 'numeric' }),
    long_rate_max: numberField('長時間の上限（mL/h）', { value: d.long_rate_max ?? 75, inputMode: 'numeric' }),
    target_end_time: textField('基本の終了目標の時刻', { value: d.target_end_time ?? '06:00', hint: '例 06:00' }),
    ordered_on: dateField('指示日', { value: d.ordered_on ?? '' }),
    ordered_by: textField('指示元（医師名・医療機関）', { value: d.ordered_by }),
    valid_from: dateField('有効期間の開始', { value: d.valid_from ?? '' }),
    valid_to: dateField('有効期間の終了', { value: d.valid_to ?? '' }),
    occlusion_procedure: textField('閉塞時に医療者から指示された手順', { value: d.occlusion_procedure, multiline: true, hint: '指示の原文をそのまま' }),
    bubble_procedure: textField('気泡のときの医療者からの指示', { value: d.bubble_procedure, multiline: true, hint: '指示の原文をそのまま（閉塞時とは別）' }),
    flush_instruction: textField('ヘパリンフラッシュに関する指示', { value: d.flush_instruction, multiline: true, hint: '指示の原文をそのまま' }),
    note: textField('備考', { value: d.note, multiline: true }),
  };
  // 関連する項目をまとめ、短い数値は2列に（幅が足りない画面では1列に戻る）。入力値と意味は変えない
  const grp = (title, ...children) => h('div', { class: 'fgroup' }, h('h3', {}, title), ...children);
  const two = (x, y) => h('div', { class: 'grid2' }, x.el, y.el);
  const layout = [
    grp('基本情報', f.drug_name.el, two(f.volume_ml, f.rate_step)),
    grp('流量', two(f.rate_min, f.rate_max), two(f.usual_rate_min, f.usual_rate_max)),
    grp('投与時間', two(f.long_rate_min, f.long_rate_max), f.target_end_time.el),
    grp('指示情報', f.ordered_on.el, f.ordered_by.el, two(f.valid_from, f.valid_to)),
    grp('自由記述', f.occlusion_procedure.el, f.bubble_procedure.el, f.flush_instruction.el, f.note.el),
  ];
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet(o ? '点滴の指示を直す' : '点滴の指示を登録する', (close) => [h('div', { 'data-keep': '' }, ...layout, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      const data = {};
      for (const [k, fld] of Object.entries(f)) { const v = fld.get(); if (v !== undefined && v !== '') data[k] = v; }
      const v = validateRecord('infusion_orders', data, { nowMs: ctx.now() });
      const rest = showErrors(f, v.errors);
      if (!v.ok) { msg.textContent = rest.join(' / '); return; }
      const yes = await confirmSheet({ title: '点滴の指示を保存しますか？', lines: [`${data.drug_name} ${data.volume_ml}mL`, `流量 ${data.rate_min}〜${data.rate_max} mL/h（${data.rate_step} mL/h 刻み）`, '医療者から受けた指示と同じか、確かめてください'], okLabel: '保存する' });
      if (!yes) return;
      const r = o ? await ctx.data.updateRecord('infusion_orders', o.id, o.version, data) : await ctx.data.createRecord('infusion_orders', data);
      if (r.ok) { toast('点滴の指示を保存しました'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '保存できませんでした';
    } } }, '確認へ'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}

// ---------------------------------------------------------------------------
// 背景（誕生日）。母の誕生日の月日を登録すると、その日は誕生日の背景になる

function renderBirthday(root, ctx) {
  const cur = ctx.data.list('settings').find((s) => s.key === 'birthday');
  const v = cur?.value;
  const month = selectField('月', [[undefined, '—'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}月`])], { value: v?.month });
  const day = selectField('日', [[undefined, '—'], ...Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1}日`])], { value: v?.day });
  const msg = h('p', { class: 'err', role: 'alert' });
  root.append(panel('母の誕生日（背景）', h('p', { class: 'fine' }, '登録した月日は HOME の背景が誕生日の背景になります（他の特別な日より優先）'),
    h('div', { 'data-keep': '' }, month.el, day.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      if (month.get() === undefined || day.get() === undefined) { msg.textContent = '月と日を選んでください'; return; }
      const norm = normalizeBirthday({ month: month.get(), day: day.get() });
      if (!norm) { msg.textContent = '月日が正しくありません'; return; }
      const data = { key: 'birthday', value: norm, scope: 'global' };
      const check = validateRecord('settings', data);
      if (!check.ok) { msg.textContent = check.errors.map((e) => e.message).join(' / '); return; }
      const r = cur ? await ctx.data.updateRecord('settings', cur.id, cur.version, data) : await ctx.data.createRecord('settings', data);
      if (r.ok) { toast('誕生日を登録しました'); ctx.refresh(); } else msg.textContent = r.message ?? '登録できませんでした';
    } } }, '登録する'),
    cur ? h('button', { class: 'btn secondary', type: 'button', on: { click: async () => {
      if (!await confirmSheet({ title: '誕生日の登録を消しますか？', lines: ['誕生日の背景は表示されなくなります'], okLabel: '消す', danger: true })) return;
      const r = await ctx.data.softDelete('settings', cur.id, cur.version); toast(r.ok ? '消しました' : r.message); ctx.refresh();
    } } }, '登録を消す') : null));
}

// ---------------------------------------------------------------------------
// 出力（CSV・JSON）

const CSV_TARGETS = [['health_logs', '体調'], ['infusions', '点滴（1回ごと）'], ['infusion_events', '点滴のイベント（開始・流量変更・残量・中断・終了・フラッシュ）'], ['needle_changes', '針交換'], ['waste_records', 'ルート・バッグの処分'], ['needle_handovers', '針の引き渡し'], ['infusion_orders', '点滴の指示'], ['settings', '設定']];

async function fetchTables(ctx) {
  const r = await ctx.data.call('export.json');
  if (!r || r.ok !== true) return null;
  return r.data;
}

function renderExport(root, ctx) {
  const target = selectField('CSV にする記録', CSV_TARGETS, { value: 'health_logs' });
  const from = dateField('期間の開始（空なら最初から）');
  const to = dateField('期間の終了（空なら最後まで）');
  const msg = h('p', { class: 'err', role: 'alert' });
  root.append(panel('CSV で出力する', h('p', { class: 'fine' }, 'Excel・Google スプレッドシートで開けます。削除した記録も印つきで含まれます'),
    h('div', { 'data-keep': '' }, target.el, from.el, to.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      const exp = await fetchTables(ctx);
      if (!exp) { msg.textContent = '取得できませんでした。通信を確かめてください'; return; }
      const name = target.get();
      const { fromMs, toMs } = dayRangeMs(from.get(), to.get());
      const rows = filterByPeriod(name, exp.tables[name] ?? [], { fromMs, toMs });
      dl(`care-garden-${name}-${stamp(ctx.now())}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
      toast(`${rows.length}件を出力しました`);
    } } }, 'CSV をダウンロード')));
  root.append(panel('すべてのデータを JSON で出力する', h('p', { class: 'fine' }, 'バックアップ用。他の人に渡さないでください', why('アプリの版・データ形式の版・件数・チェックサムが入ります。端末の情報は含まれません。')),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      const exp = await fetchTables(ctx);
      if (!exp) { toast('取得できませんでした。通信を確かめてください'); return; }
      const backup = createBackup({ kind: 'full', id: uuid(), tables: exp.tables, toMs: exp.exported_ms }, sha256Hex);
      backup.manifest.app_version = APP_VERSION;
      dl(`care-garden-backup-${stamp(exp.exported_ms)}.json`, serializeBackup(backup), 'application/json;charset=utf-8');
      toast('JSON を出力しました');
    } } }, 'JSON をダウンロード')));
}

// ---------------------------------------------------------------------------
// 復元：ファイルの検証と、現在との差の確認まで。実行は、実行方法の承認を得てから（画面設計 §10-8）

const RESTORE_ERR = { MALFORMED: 'ファイルの形が正しくありません', FORMAT_MISMATCH: 'Care Garden のバックアップではありません', FORMAT_VERSION_UNSUPPORTED: 'このアプリが扱えない形式の版です', SCHEMA_TOO_NEW: 'このアプリより新しい版のデータです', COUNT_MISMATCH: '件数が一致しません（ファイルが壊れている可能性）', CHECKSUM_MISMATCH: 'チェックサムが一致しません（ファイルが書き換えられた、または壊れています）', EXCLUDED_TABLE_PRESENT: '含めてはいけない情報が入っています' };

function renderRestore(root, ctx) {
  const result = h('div', { 'aria-live': 'polite' });
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'width:100%;min-height:52px' });
  input.addEventListener('change', async () => {
    clear(result);
    const file = input.files?.[0];
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { result.append(h('p', { class: 'err' }, 'ファイルを読み取れませんでした')); return; }
    const errors = validateFile(parsed, sha256Hex);
    if (errors.length) { result.append(h('p', { class: 'err' }, '復元に使えないファイルです'), h('ul', {}, ...errors.map((e) => h('li', {}, RESTORE_ERR[e] ?? e)))); return; }
    const check = verifyRestorable([parsed], { targetMs: parsed.manifest.to_ms, hash: sha256Hex });
    if (!check.ok) { result.append(h('p', { class: 'err' }, '復元できる状態になりません'), h('pre', { class: 'muted' }, JSON.stringify(check.errors).slice(0, 400))); return; }
    const box = h('div', {});
    result.append(panel('このファイルは、復元に使えます',
      h('div', { class: 'kv' }, h('span', { class: 'k' }, '作成した時点'), h('span', {}, fmtWhen(parsed.manifest.to_ms, ctx.now()))),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'アプリの版 / データ形式'), h('span', {}, `${parsed.manifest.app_version ?? '—'} / ${parsed.manifest.format_version}`)),
      h('p', { class: 'fine' }, '復元の前に、今の状態を自動でバックアップします。復元後に作られた記録は、選ばなければ残ります。'),
      h('button', { class: 'btn', type: 'button', on: { click: () => startRestore(box, ctx, parsed) } }, '復元の内容を確認する'), box));
  });
  const unfinished = h('div', {});
  showUnfinishedRestore(unfinished, ctx);   // 途中の復元があれば、先に出す
  root.append(panel('バックアップからの復元', unfinished, h('p', { class: 'fine' }, 'ファイルを選ぶと、復元に使えるかを検査します。実行は、内容を確認して最終承認したときだけです'),
    h('div', { 'data-keep': '' }, input), result));
}

// ---------------------------------------------------------------------------
// 廃棄物：使用済み針の訪問診療側への引き渡し確認（管理者のみ）。針は家庭ごみに出さない

const HANDOVER_LABEL = { handed_over: '引き渡し済み', pending: '確認待ち', not_handed: '未引き渡し' };

function renderWaste(root, ctx) {
  root.append(panel('使用済みの針の引き渡し', h('p', {}, '使用済みの針は家庭ごみに出しません。硬い耐穿刺性の容器に入れて保管し、訪問診療の担当者が管理・回収します。'),
    h('p', { class: 'fine' }, '引き渡した日と確認の状況を記録します（回収の方法は訪問診療側の指示に従う）'),
    h('button', { class: 'btn', type: 'button', on: { click: () => handoverSheet(ctx) } }, '引き渡しを記録する')));
  const logs = ctx.data.list('needle_handovers').sort((a, b) => String(b.handover_on ?? '').localeCompare(String(a.handover_on ?? '')) || (b.created_ms ?? 0) - (a.created_ms ?? 0));
  const list = h('ul', { class: 'list' });
  for (const w of logs) list.append(h('li', {}, h('strong', {}, HANDOVER_LABEL[w.status] ?? w.status), '　', h('span', { class: 'num' }, w.handover_on ?? '日付なし'), w._pending ? h('span', { class: 'tag pending' }, '未送信') : null,
    h('div', { class: 'muted' }, `引き渡し先 ${w.destination || '—'}${w.note ? `　${w.note}` : ''}`),
    w._pending ? null : h('button', { class: 'link', type: 'button', on: { click: () => handoverSheet(ctx, w) } }, '直す')));
  root.append(panel('記録', list.childElementCount ? list : h('p', { class: 'muted' }, 'まだ記録がありません')));
}

function handoverSheet(ctx, w) {
  const d = w ?? {};
  const f = {
    status: choiceField('確認の状況', HANDOVER_STATUS.map((k) => [k, HANDOVER_LABEL[k]]), { value: d.status }),
    handover_on: dateField('引き渡した日（引き渡し済みの場合は必須）', { value: d.handover_on ?? toDateInput(ctx.now()) }),
    destination: textField('引き渡し先', { value: d.destination ?? '訪問診療' }),
    note: textField('メモ', { value: d.note, multiline: true }),
  };
  const msg = h('p', { class: 'err', role: 'alert' });
  openSheet(w ? '針の引き渡しの記録を直す' : '針の引き渡しを記録する', (close) => [h('div', { 'data-keep': '' }, f.status.el, f.handover_on.el, f.destination.el, f.note.el, msg),
    h('button', { class: 'btn', type: 'button', on: { click: async () => {
      msg.textContent = '';
      if (!f.status.get()) { f.status.setError('確認の状況を選んでください'); return; }
      const data = Object.fromEntries(Object.entries({ status: f.status.get(), handover_on: f.handover_on.get(), destination: f.destination.get(), note: f.note.get() }).filter(([, v]) => v));
      const v = validateRecord('needle_handovers', data);
      const rest = showErrors(f, v.errors);
      if (!v.ok) { msg.textContent = rest.join(' / '); return; }
      const yes = await confirmSheet({ title: '針の引き渡しを記録しますか？', lines: [`確認の状況：${HANDOVER_LABEL[data.status]}`, `引き渡した日：${data.handover_on ?? '—'}`, `引き渡し先：${data.destination ?? '—'}`], okLabel: '記録する' });
      if (!yes) return;
      const r = w ? await ctx.data.updateRecord('needle_handovers', w.id, w.version, data) : await ctx.data.createRecord('needle_handovers', data);
      if (r.ok) { toast('記録しました'); close(); ctx.refresh(); } else msg.textContent = r.message ?? '記録できませんでした';
    } } }, '確認へ'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => close() } }, 'やめる')]);
}
