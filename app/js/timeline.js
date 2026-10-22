// 記録画面の時系列（daily-ops-design §7）。既存の記録を、日付の新しい順の1本にまとめる表示用の組み立て。データは変えない。
// 誰が・いつ・何を記録したか、未送信かが分かる。訂正された記録は、最新の有効な内容だけを出す。

import { effectiveNotes, who, appointmentsOf, OUTCOME_LABEL, questionsView } from './schedule-view.js';
import { healthLine } from './health-view.js';

const SAMPLE = (n, s) => (s.length > n ? `${s.slice(0, n)}…` : s);

const EVENT_LABEL = { start: '点滴を開始', end: '点滴を終了', rate_change: '流量の変更', pause: '一時中断', resume: '再開', volume_visual: '残量を記録（目視）', volume_pump: '残量を記録（ポンプ）',
  flush: '終了処置（フラッシュ）', flush_skip: '終了処置（未実施・不要）', cancel: '点滴を中止', correction: '時刻の修正', note: 'メモ' };

export function buildTimeline(data) {
  const items = [];
  const push = (ms, kind, label, detail, rec) => { if (Number.isFinite(ms)) items.push({ ms, kind, label, detail, by: rec?.created_by, pending: Boolean(rec?._pending), id: rec?.id }); };

  for (const e of data.list('infusion_events')) {
    let d = '';
    if (e.type === 'rate_change') d = `${e.rate_before ?? '—'} → ${e.rate} mL/h`;
    else if (e.type === 'start') d = `${e.rate} mL/h`;
    else if (e.type === 'pause') d = e.reason ?? '';
    else if (e.volume_ml != null) d = `${e.volume_ml} mL`;
    else if (e.type === 'correction') d = `#${e.corrects_seq} の時刻を修正`;
    push(e.occurred_ms, 'infusion', EVENT_LABEL[e.type] ?? e.type, d, e);
  }
  for (const h of data.list('health_logs')) push(h.logged_ms, 'health', healthLine(h), h.memo ? SAMPLE(30, h.memo) : '', h);
  for (const n of data.list('needle_changes')) push(n.changed_ms ?? n.created_ms, 'needle', '針交換（訪問看護）', n.next_due_on ? `次回 ${n.next_due_on.slice(5).replace('-', '/')}` : '', n);
  for (const n of data.list('needle_handovers')) push(n.handover_ms ?? n.created_ms, 'handover', '使用済み針の回収（訪問診療）', n.destination ?? '', n);

  const appts = new Map(appointmentsOf(data).map((a) => [a.id, a]));
  const seen = new Set();
  for (const n of data.list('visit_notes')) {
    const key = `${n.appointment_id}:${n.occurrence_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const note of effectiveNotes(data, n.appointment_id, n.occurrence_date)) {
      const a = appts.get(note.appointment_id);
      const text = [note.did, note.talked, note.next_check].filter(Boolean).join(' / ');
      push(note.created_ms, 'visit', `${a?.kind ?? '訪問'}　${OUTCOME_LABEL[note.outcome] ?? ''}`, [a?.provider, note.trip ? '通院の時刻の記録あり' : '', text ? SAMPLE(30, text) : ''].filter(Boolean).join('　'), note);
    }
  }
  for (const q of questionsView(data)) {
    push(q.createdMs, 'question', '質問メモを追加', SAMPLE(30, q.content), { created_by: q.authorId, _pending: q.pending });
    for (const c of q.history) push(c.created_ms, 'question', c.checked ? '質問を済みにした' : '質問を未済に戻した', SAMPLE(30, q.content), c);
  }
  for (const w of data.list('waste_records')) {
    const [y, m, d] = String(w.disposed_on ?? '').split('-').map(Number);
    push(Number.isFinite(y) ? Date.UTC(y, m - 1, d, 12) - 9 * 3_600_000 : w.created_ms, 'waste', 'ルート・バッグの処分（過去の記録）', { route: '点滴ルート', bag: '点滴バッグ', other: 'その他' }[w.target] ?? '', w);
  }
  return items.sort((a, b) => b.ms - a.ms);
}

export { who };
