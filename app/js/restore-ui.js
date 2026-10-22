// 復元の画面部品（設定の「復元」と、全画面共通の「復元前の未送信」の確認）。docs/restore-safety-design.md
// 復元は日常の操作ではない：管理者が内容を確かめ、明示的に最終承認してから実行する。
// 普段の利用者に技術用語（世代・保守中など）は見せない。必要な判断だけを、平易な言葉で示す。

import { h, clear, openSheet, confirmSheet, toast, fmtWhen } from './ui.js';
import { CLASS_LABEL } from '../../src/backup/restore.js';

const COLLECTION_LABEL = {
  health_logs: '体調の記録', visit_notes: '訪問メモ', tasks: '質問メモ', needle_changes: '針交換の記録', waste_records: '日常の処分',
  needle_handovers: '針の引き渡し', appointments: '予定', infusions: '点滴', infusion_events: '点滴の経過', infusion_orders: '点滴の指示', settings: '設定',
  prescriptions: '処方', inventory: '在庫', inventory_logs: '在庫の記録', equipment: '機器', expenses: '費用',
};
const EVENT_LABEL = { start: '点滴の開始', rate_change: '流量の変更', volume_visual: '残量（目視）', volume_pump: 'ポンプの積算量', pause: '一時中断', resume: '再開', end: '点滴の終了', flush: '終了処置 DONE', flush_skip: '終了処置', cancel: '点滴の中止', correction: '時刻・値の修正', note: 'メモ' };
const ACTION_LABEL = { 'record.create': '追加', 'record.update': '変更', 'record.softDelete': '削除' };
const ERR_REASON = {
  BACKUP_FILE: 'バックアップのファイルが正しくありません', BACKUP_NOT_RESTORABLE: 'このファイルは復元に使えません',
  INFLIGHT_REMAINS: '送信の途中の記録が残っています。しばらくしてからやり直してください', LOCK_ANOMALY: '同期の異常が記録されています。先に確認が必要です',
  PREBACKUP_FAILED: '復元前のバックアップを作れなかったため、中止しました（何も変更していません）', PREPARE_FAILED: '準備に失敗しました（何も変更していません）',
  SELECTION: '選んだ組み合わせでは復元できません', INTEGRITY: '選んだ内容だと、記録のつながりが壊れるため復元できません',
  STALE_BEFORE: '復元の途中で、記録が想定と違う状態になっていました', HELD: '送信の途中の記録があり、書き込めませんでした',
  VERIFY_FAILED: '復元後の確認で、内容が一致しない記録がありました', EXCEPTION: '復元の途中でエラーが起きました',
  PREBACKUP_UNREADABLE: '復元前のバックアップを読み出せませんでした', PREBACKUP_INVALID: '復元前のバックアップが正しくありません',
};

const dateText = (ms, now) => (ms ? fmtWhen(ms, now) : '—');
const valText = (v) => (v === null || v === undefined ? '（なし）' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));

function itemRow(item, checked, onToggle, now) {
  const cb = item.cls === 'review' ? null : h('input', { type: 'checkbox', checked, 'aria-label': '復元に含める', on: { change: (e) => onToggle(e.target.checked) } });
  const only = item.cls === 'later_new' || item.cls === 'unknown_origin';   // 今だけにある記録：項目の一覧ではなく、中身の要点と「選ぶと削除」を出す
  const memo = item.changes.find((c) => c.field === 'memo' || c.field === 'note' || c.field === 'content')?.from;
  const changes = only ? [] : item.changes.filter((c) => !['created_ms', 'created_by', 'id'].includes(c.field)).slice(0, 4);
  return h('li', { class: 'rs-item' },
    cb,
    h('div', {},
      h('div', {}, h('strong', {}, COLLECTION_LABEL[item.collection] ?? item.collection), `　${dateText(item.dateMs, now)}`),
      ...changes.map((c) => h('div', { class: 'fine' }, `${c.field}：${valText(c.from)} → ${valText(c.to)}`)),
      only ? h('div', { class: 'fine' }, `${memo ? valText(memo) + '　' : ''}選ぶと、この記録を削除します（履歴には残ります）`) : null,
      item.cls === 'review' ? h('div', { class: 'fine' }, '要確認：復元できません') : null,
      h('div', { class: 'fine' }, `ID ${item.id.slice(0, 8)}`)));
}

/** 復元前の差分の確認と、最終承認 */
function renderPlan(root, ctx, prep) {
  const { job, plan, selected } = prep;
  const sel = new Set(selected);
  const now = ctx.now();
  const groups = {};
  for (const i of plan.items) (groups[i.cls] ??= []).push(i);
  const DEFAULT_TEXT = { add: '戻します', repair: '戻します', later_edit: '残します（選べば戻します）', later_new: '残します（選べば削除します）', unknown_origin: '残します（選べば削除します）', review: '' };
  clear(root).append(h('h3', { style: 'font-size:17px' }, '復元の内容を確認'));
  if (!plan.items.length) root.append(h('p', {}, '現在のデータと同じ内容です。復元することはありません。'));
  for (const [cls, list] of Object.entries(groups)) {
    root.append(h('details', { class: 'inf-detail', open: cls === 'add' || cls === 'repair' },
      h('summary', {}, `${CLASS_LABEL[cls] ?? cls}：${list.length}件（${DEFAULT_TEXT[cls]}）`),
      h('ul', { class: 'list' }, ...list.map((i) => itemRow(i, sel.has(i.key), (on) => { if (on) sel.add(i.key); else sel.delete(i.key); }, now)))));
  }
  const msg = h('p', { class: 'err', role: 'alert' });
  const agree = h('input', { type: 'checkbox', id: 'rs-agree' });
  const run = h('button', { class: 'btn danger', type: 'button', disabled: true, on: { click: async () => {
    msg.textContent = '';
    const ok = await confirmSheet({ title: '復元を実行しますか？', lines: ['復元の間は、母の端末も含め、記録と同期が止まります。', '「復元後に作られた記録」は、選ばなければそのまま残ります。', '実行前の状態は、復元前のバックアップとして保存済みです。'], okLabel: '復元を実行する', danger: true });
    if (!ok) return;
    await execute(root, ctx, job, plan.planHash, [...sel], msg);
  } } }, '復元を実行する');
  agree.addEventListener('change', () => { run.disabled = !agree.checked; });
  root.append(h('label', { style: 'display:flex;gap:8px;align-items:center;margin:12px 0' }, agree, '内容を確認しました'), run, msg,
    h('button', { class: 'link', type: 'button', on: { click: async () => {
      const r = await ctx.data.call('restore.abort', { job_id: job.id });
      if (r?.ok) { toast('復元をやめました。何も変更していません'); clear(root); ctx.refresh(); } else toast('取り消せませんでした');
    } } }, 'やめる（何も変更しません）'));
}

async function drive(root, ctx, job, first, msg) {
  let r = first;
  let guard = 0;
  while (r && r.ok === true && r.more === true && guard++ < 500) r = await ctx.data.call('restore.resume', { job_id: job.id });
  if (!r) { msg.textContent = '通信できませんでした。復元は途中です。もう一度、復元の画面を開いて続けてください'; return; }
  if (r.ok === true && r.data?.state === 'done') {
    toast('復元が完了しました');
    clear(root).append(h('p', {}, '復元が完了しました。母の端末も、次に開いたときに最新の内容を取り直します。'));
    await ctx.data.sync();
    ctx.refresh();
    return;
  }
  renderJob(root, ctx, r.data ?? job, msg);
}

async function execute(root, ctx, job, planHash, selected, msg) {
  const r = await ctx.data.call('restore.confirm', { job_id: job.id, plan_hash: planHash, approved: true, selected });
  if (r && r.ok === false && r.code !== 'RESTORE_STOPPED') {
    msg.textContent = r.code === 'PLAN_CHANGED' ? '内容が変わりました。最初からやり直してください' : (ERR_REASON[r.reason] ?? '復元できませんでした');
    return;
  }
  await drive(root, ctx, job, r, msg);
}

/** 途中の復元の状態（止まっているとき：続ける／復元前の状態に戻す） */
function renderJob(root, ctx, job, msg) {
  const stopped = job.state === 'stopped';
  clear(root).append(
    h('h3', { style: 'font-size:17px' }, stopped ? '復元が途中で止まっています' : '復元の途中です'),
    stopped ? h('p', { class: 'err', role: 'alert' }, `${ERR_REASON[job.reason] ?? '原因を確認してください'}。通常の記録・同期は、復元が終わるまで再開しません。`) : null,
    h('p', { class: 'fine' }, `進み具合：${job.pos ?? 0}／${job.total ?? 0}件`),
    h('button', { class: 'btn', type: 'button', on: { click: async () => { const r = await ctx.data.call('restore.resume', { job_id: job.id }); await drive(root, ctx, job, r, msg); } } }, '続ける'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: async () => {
      const ok = await confirmSheet({ title: '復元前の状態に戻しますか？', lines: ['復元を始める前に保存した状態へ、同じ方法で戻します。'], okLabel: '戻す', danger: true });
      if (!ok) return;
      const r = await ctx.data.call('restore.abort', { job_id: job.id });
      await drive(root, ctx, job, r, msg);
    } } }, '復元前の状態に戻す'), msg);
}

/** 復元の準備（サーバーで復元前のバックアップを作り、差分を計画する） */
export async function startRestore(root, ctx, backup) {
  const msg = h('p', { class: 'err', role: 'alert' });
  clear(root).append(h('p', {}, '準備しています…'));
  const r = await ctx.data.call('restore.prepare', { backup });
  if (!r) { clear(root).append(h('p', { class: 'err' }, '通信できませんでした。何も変更していません')); return; }
  if (r.ok !== true) {
    const text = r.code === 'JOB_ACTIVE' ? '復元の途中のものがあります。下の「続ける」か「復元前の状態に戻す」を選んでください' : (ERR_REASON[r.reason] ?? ERR_REASON[r.code] ?? '準備できませんでした（何も変更していません）');
    clear(root).append(h('p', { class: 'err', role: 'alert' }, text));
    if (r.code === 'JOB_ACTIVE' && r.data) renderJob(root, ctx, r.data, msg);
    return;
  }
  renderPlan(root, ctx, r.data);
}

/** 設定の「復元」を開いたとき：途中の復元があれば、状態を出す */
export async function showUnfinishedRestore(root, ctx) {
  const r = await ctx.data.call('restore.status', {});
  const job = r?.ok === true ? r.data?.job : null;
  if (!job || !['preparing', 'planned', 'applying', 'verifying', 'rotating', 'finishing', 'stopped'].includes(job.state)) return false;
  const msg = h('p', { class: 'err', role: 'alert' });
  if (job.state === 'planned') {
    const full = await ctx.data.call('restore.status', { with_plan: true });
    if (full?.ok === true && full.data.plan) { renderPlan(root, ctx, { job, plan: full.data.plan, selected: full.data.selected ?? [] }); return true; }
  }
  renderJob(root, ctx, job, msg);
  return true;
}

// ---------------------------------------------------------------------------
// 復元前の未送信：復元のあと、古い状態で作られていた未送信の記録。自動では送らず、内容を見て本人が選ぶ

function staleTitle(it) {
  const p = it.payload ?? {};
  if (it.action === 'infusion.event.append') return EVENT_LABEL[p.event?.type] ?? '点滴の記録';
  return `${COLLECTION_LABEL[p.collection] ?? '記録'}の${ACTION_LABEL[it.action] ?? '操作'}`;
}
function staleDetail(it) {
  const p = it.payload ?? {};
  const d = it.action === 'infusion.event.append' ? p.event : p.data;
  if (!d) return '';
  const bits = [];
  if (d.memo) bits.push(String(d.memo).slice(0, 40));
  if (d.condition) bits.push({ ok: 'OK', normal: '普通', uneasy: 'おや？', hard: 'つらい' }[d.condition] ?? d.condition);
  if (d.rate != null) bits.push(`${d.rate} mL/h`);
  if (d.note) bits.push(String(d.note).slice(0, 40));
  return bits.join('　');
}

export async function staleSheet(ctx) {
  const items = await ctx.data.listStale();
  openSheet('復元前に保存した記録', (close) => {
    const list = h('ul', { class: 'list' });
    const draw = (rows) => {
      clear(list);
      if (!rows.length) { list.append(h('li', {}, '確認する記録はありません')); return; }
      for (const it of rows) {
        list.append(h('li', {},
          h('div', {}, h('strong', {}, staleTitle(it)), `　${fmtWhen(it.createdMs, ctx.now())}`),
          staleDetail(it) ? h('div', { class: 'fine' }, staleDetail(it)) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn soft', type: 'button', on: { click: async () => { await ctx.data.rerecordStale(it.requestId); toast('記録し直します'); draw(await ctx.data.listStale()); } } }, 'この内容で記録し直す'),
            h('button', { class: 'btn soft', type: 'button', on: { click: async () => { await ctx.data.discardStale(it.requestId); draw(await ctx.data.listStale()); } } }, '送らない'))));
      }
    };
    draw(items);
    return [h('p', { class: 'fine' }, '復元の前に端末で保存された、まだ送られていない記録です。内容を確かめて、選んでください。'), list,
      h('button', { class: 'btn secondary', type: 'button', on: { click: () => { close(); ctx.refresh(); } } }, 'とじる')];
  });
}
