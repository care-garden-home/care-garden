// 予定・訪問・質問メモの表示用の組み立て（HOME と予定画面で共通）。データの保存や計算は、src/schedule と既存の記録の経路が行う。

import { expandOccurrences, todaysOccurrences, dateOf } from '../../src/schedule/recur.js';

export const WHO = { u_admin: '管理者', u_mother: '母' };
/** 記録の共有の状態。端末に保存しただけで未送信なら「保存済み・未送信」、サーバーに届いて同期できたものだけ「共有済み」 */
export const shareText = (rec) => (rec?._pending ? '保存済み・未送信' : '共有済み');
export const who = (id) => WHO[id] ?? '';

/** 種類別の色（背景・文字）。予定の通常案内に赤は使わない */
export const KIND_STYLE = Object.freeze({
  '訪問看護': ['#B9DDB8', '#24432A'],
  '訪問リハビリ': ['#D3E8F1', '#1F4A5E'],
  '訪問診療': ['#F3D98B', '#4A3B00'],
  '訪問薬剤師': ['#E7DAF1', '#3F2A55'],
  '通院': ['#EBA6BF', '#4A2433'],
  'その他': ['#E5E7EB', '#2F3A40'],
});
export const shortKind = (kind) => (kind === '訪問リハビリ' ? '訪問リハ' : kind);
export const styleOf = (kind) => KIND_STYLE[kind] ?? KIND_STYLE['その他'];

export { expandOccurrences, todaysOccurrences, dateOf };

/** 画面に出す予定の一覧（元の予定と、1回分の例外を含む。削除済みは除く） */
export const appointmentsOf = (data) => data.list('appointments');

/**
 * その回の訪問記録（visit_notes）。訂正は「corrects_id を持つ新しい記録」なので、訂正された元の記録は除き、
 * 最新の有効な記録だけを返す（元の記録は、訂正履歴として corrections で参照できる）。
 */
export function effectiveNotes(data, seriesId, date) {
  const all = data.list('visit_notes').filter((n) => n.appointment_id === seriesId && n.occurrence_date === date);
  const superseded = new Set(all.map((n) => n.corrects_id).filter(Boolean));
  return all.filter((n) => !superseded.has(n.id)).sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
}
/** 記録 n を訂正した過去の版（古い順。n 自身は含まない） */
export function noteHistory(data, note) {
  const all = data.list('visit_notes');
  const out = [];
  let cur = note;
  while (cur?.corrects_id) { const prev = all.find((x) => x.id === cur.corrects_id); if (!prev) break; out.unshift(prev); cur = prev; }
  return out;
}

/** 実績（done／not_done／cancelled／null＝未記録）。その回の最新の有効な記録による */
export function outcomeOf(data, seriesId, date) {
  const notes = effectiveNotes(data, seriesId, date);
  return notes.length ? notes[notes.length - 1].outcome : null;
}
export const OUTCOME_LABEL = { done: '実施済み', not_done: '未実施', cancelled: '中止になった' };
export const BOOKING_LABEL = { tentative: '予定（未確定）', confirmed: '確定' };

/**
 * 質問メモ。質問の本体（entry=question）と、済み・未済のチェック（entry=check、追加記録）から、いまの状態を組み立てる。
 * 質問の訂正は corrects_id を持つ新しい記録。チェックは、訂正の連鎖の最初の質問（rootId）を指す。
 */
export function questionsView(data) {
  const tasks = data.list('tasks');
  const questions = tasks.filter((t) => t.entry === 'question');
  const checks = tasks.filter((t) => t.entry === 'check');
  const superseded = new Set(questions.map((q) => q.corrects_id).filter(Boolean));
  const rootOf = (q) => { let cur = q; const seen = new Set(); while (cur?.corrects_id && !seen.has(cur.id)) { seen.add(cur.id); cur = questions.find((x) => x.id === cur.corrects_id) ?? cur; if (cur === q) break; } return cur?.id ?? q.id; };
  return questions.filter((q) => !superseded.has(q.id)).map((q) => {
    const root = rootOf(q);
    const mine = checks.filter((c) => c.question_id === root).sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
    const last = mine[mine.length - 1];
    return { id: q.id, rootId: root, content: q.content, kind: q.kind, provider: q.provider, authorId: q.created_by, createdMs: q.created_ms,
      done: Boolean(last?.checked), doneBy: last?.checked ? last.created_by : null, doneMs: last?.checked ? last.created_ms : null, pending: Boolean(q._pending || last?._pending), history: mine };
  }).sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));
}

/** その予定（種類・事業所）で聞く、未済の質問。同じ種類の次の予定にも出続ける（コピーしない） */
export function openQuestionsFor(data, appt) {
  return questionsView(data).filter((q) => !q.done && q.kind === appt.kind && (!q.provider || q.provider === appt.provider));
}
export function doneQuestionsFor(data, appt) {
  return questionsView(data).filter((q) => q.done && q.kind === appt.kind && (!q.provider || q.provider === appt.provider));
}

/** 通院の過去の実績（同じ事業所）。参考の集計に使う */
export function pastTrips(data, provider) {
  const appts = new Map(appointmentsOf(data).map((a) => [a.id, a]));
  return data.list('visit_notes').filter((n) => n.trip && appts.get(n.appointment_id)?.provider === provider
    && !data.list('visit_notes').some((m) => m.corrects_id === n.id)).map((n) => n.trip);
}
