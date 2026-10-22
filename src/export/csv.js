// CSV 出力（要件§14-1）。純粋関数。Excel で開ける形式（UTF-8 の BOM 付き・CRLF・必要な欄だけ引用符）。
//
// - 日時（*_ms）には、読みやすい日本時間の列（*_at。YYYY-MM-DD HH:mm）を隣に足す。元の数値の列も残す
// - Excel が式として実行してしまう先頭文字（= + - @ タブ CR）で始まる文字列には、先頭に「'」を付ける（式の注入の防止）。
//   数値型の値（負の数を含む）は変えない
// - 期間の指定は、記録ごとの「その記録が指す日時」で絞る（体調＝記録日時、点滴のイベント＝発生日時、針交換＝交換日 など）
// - 削除済みの記録も出力に含める（deleted_ms 列で区別できる。出力で記録を欠落させない）

export const BOM = '﻿';
const JST_MS = 9 * 3_600_000;
const SERVER_COLUMNS = ['version', 'created_ms', 'created_by', 'updated_ms', 'updated_by', 'deleted_ms', 'change_no'];

const pad = (n) => String(n).padStart(2, '0');

/** UTC ミリ秒 → 'YYYY-MM-DD HH:mm'（日本時間） */
export function formatJst(ms) {
  const d = new Date(ms + JST_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** セルの文字列化（引用符の付与と、式の注入の防止） */
export function cell(value) {
  if (value === null || value === undefined) return '';
  let text;
  let isNumber = false;
  if (typeof value === 'number') { text = Number.isFinite(value) ? String(value) : ''; isNumber = true; }
  else if (typeof value === 'boolean') text = value ? 'TRUE' : 'FALSE';
  else if (Array.isArray(value) && value.every((x) => typeof x === 'string')) text = value.join('／');   // 症状など、文字の配列は読みやすく
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (!isNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 列の並び：id、その他（名前順）、サーバー管理の列。*_ms の隣に *_at を足す */
export function columnsFor(docs) {
  const keys = new Set();
  for (const d of docs) for (const k of Object.keys(d)) keys.add(k);
  const rest = [...keys].filter((k) => k !== 'id' && !SERVER_COLUMNS.includes(k)).sort();
  const ordered = [...(keys.has('id') ? ['id'] : []), ...rest, ...SERVER_COLUMNS.filter((k) => keys.has(k))];
  const out = [];
  for (const k of ordered) {
    out.push({ key: k, header: k });
    if (k.endsWith('_ms')) out.push({ key: k, header: `${k.slice(0, -3)}_at`, jst: true });
  }
  return out;
}

export function toCsv(docs) {
  const cols = columnsFor(docs);
  const lines = [cols.map((c) => cell(c.header)).join(',')];
  for (const d of docs) {
    lines.push(cols.map((c) => {
      const v = d[c.key];
      if (c.jst) return typeof v === 'number' && Number.isFinite(v) ? cell(formatJst(v)) : '';
      return cell(v);
    }).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** 日付文字列 'YYYY-MM-DD'（日本時間）の範囲 [from, to]（両端を含む）→ ms の [開始, 終了の翌日0時) */
export function dayRangeMs(fromDate, toDate) {
  const parse = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t ?? ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST_MS : null; };
  const from = fromDate ? parse(fromDate) : null;
  const to = toDate ? parse(toDate) : null;
  return { fromMs: from, toMs: to === null ? null : to + 24 * 3_600_000 };
}

/** その記録が指す日時（ms）。日付だけの記録は、その日の日本時間 0 時 */
export function recordTimeMs(collection, d) {
  const dateMs = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t ?? ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST_MS : null; };
  switch (collection) {
    case 'health_logs': return d.logged_ms ?? d.created_ms ?? null;
    case 'infusion_events': return d.occurred_ms ?? d.created_ms ?? null;
    case 'infusions': return d.plan_start_ms ?? d.created_ms ?? null;
    case 'needle_changes': return dateMs(d.changed_on) ?? d.created_ms ?? null;
    case 'waste_records': return dateMs(d.disposed_on) ?? d.created_ms ?? null;
    case 'needle_handovers': return dateMs(d.handover_on) ?? d.created_ms ?? null;
    default: return d.created_ms ?? null;
  }
}

/** 期間で絞る（期間の指定がなければ全件）。日時が分からない記録は、期間を指定した場合は含めない */
export function filterByPeriod(collection, docs, { fromMs = null, toMs = null } = {}) {
  if (fromMs === null && toMs === null) return docs;
  return docs.filter((d) => {
    const t = recordTimeMs(collection, d);
    return t !== null && (fromMs === null || t >= fromMs) && (toMs === null || t < toMs);
  });
}
