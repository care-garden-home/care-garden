// 復元の計画（記録単位）と整合性の検査（docs/restore-safety-design.md §3）。純粋関数。書き込みはしない。
//
// 方針：
//   - 既定で戻すのは「失われた記録」と「内容が壊れていると確認できた記録」だけ。バックアップ後に作られた・直された記録は残す。
//   - 壊れているかどうかは、時刻だけで決めない。同じ版（version）なのに内容が違う、または版が古い＝戻す。版が新しい＝復元後の正しい編集として残す。
//     復元後の新規かどうかは変更番号（change_no）で見る（時刻は表示のみ）。
//   - audit_logs・sync_summary は復元の対象にしない（監査の記録は消さない・書き換えない）。
//   - 物理削除はしない。消す扱いは論理削除（deleted_ms）。
//   - 選択のたびに、参照（点滴とその経過、訂正の元）が途切れないかを検査する。

import { canonicalJson, EXCLUDED_TABLES } from './backup.js';
import { estimate } from '../infusion/calc.js';

/** 復元の対象外（監査・同期の集約は、復元で書き換えない） */
export const RESTORE_EXCLUDED = Object.freeze([...EXCLUDED_TABLES, 'audit_logs', 'sync_summary']);

/** 内容の比較から外す項目（サーバーが付ける：版・変更番号・更新の情報） */
const SERVER_ONLY = ['version', 'change_no', 'updated_ms', 'updated_by'];

/** 保存するときの検証にかける形（サーバー管理の項目と、点滴の経過の所属・通し番号を除く） */
const VALIDATION_STRIP = ['id', 'version', 'created_ms', 'created_by', 'updated_ms', 'updated_by', 'deleted_ms', 'seq', 'change_no', 'infusion_id'];

export const CLASS_LABEL = Object.freeze({
  add: '失われた記録',
  repair: '内容が壊れている可能性',
  later_edit: '復元後に直された記録',
  later_new: '復元後に作られた記録',
  unknown_origin: '由来が不明な記録',
  review: '要確認',
});

// 参照の元になる順に適用する（親 → 子）
const ORDER = ['settings', 'infusion_orders', 'infusions', 'appointments', 'infusion_events', 'visit_notes', 'tasks', 'needle_handovers'];
const orderOf = (c) => { const i = ORDER.indexOf(c); return i < 0 ? ORDER.length : i; };

const without = (doc, keys) => {
  const o = {};
  for (const k of Object.keys(doc)) if (!keys.includes(k) && doc[k] !== undefined) o[k] = doc[k];
  return o;
};

export const contentOf = (doc) => without(doc, SERVER_ONLY);
export const contentHash = (doc, hash) => hash(canonicalJson(contentOf(doc)));
export const validationForm = (doc) => without(doc, VALIDATION_STRIP);

function diffFields(cur, tgt) {
  const a = cur ? contentOf(cur) : {};
  const b = tgt ? contentOf(tgt) : {};
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonicalJson(a[k]) !== canonicalJson(b[k])) out.push({ field: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return out;
}

const dateOf = (d) => d?.start_ms ?? d?.logged_ms ?? d?.occurred_ms ?? d?.handover_ms ?? d?.plan_start_ms ?? d?.created_ms ?? null;

/**
 * 記録単位の計画。
 * @param {{ current:Object<string,object[]>, target:Object<string,Object<string,object>>, hash:(s:string)=>string,
 *           isValid?:(collection:string, data:object)=>boolean, restorePointMs?:number }} p
 */
export function buildRestorePlan({ current, target, hash, isValid = () => true, restorePointMs = null }) {
  const names = new Set([...Object.keys(current ?? {}), ...Object.keys(target ?? {})]);
  let maxTargetNo = 0;
  for (const m of Object.values(target ?? {})) for (const d of Object.values(m)) if (Number.isInteger(d.change_no)) maxTargetNo = Math.max(maxTargetNo, d.change_no);

  const items = [];
  const push = (collection, cur, tgt, cls, defaultAction, extra = {}) => {
    const doc = tgt ?? cur;
    items.push({
      key: `${collection}:${doc.id}`, collection, id: doc.id, cls, defaultAction,
      createdMs: doc.created_ms ?? null, updatedMs: cur?.updated_ms ?? null, dateMs: dateOf(doc),
      before: cur ? { version: cur.version ?? 0, hash: contentHash(cur, hash), deleted: cur.deleted_ms != null } : null,
      after: tgt ?? null,
      afterHash: tgt ? contentHash(tgt, hash) : null,
      changes: diffFields(cur, tgt),
      ...extra,
    });
  };

  for (const name of [...names].sort()) {
    if (RESTORE_EXCLUDED.includes(name)) continue;
    const curMap = Object.fromEntries((current?.[name] ?? []).map((d) => [d.id, d]));
    const tgtMap = target?.[name] ?? {};
    // 点滴の経過：同じ点滴の同じ番号（seq）が、別の ID の記録で使われていないか
    const seqUsed = new Set();
    if (name === 'infusion_events') for (const d of Object.values(curMap)) seqUsed.add(`${d.infusion_id}#${d.seq}`);

    for (const [id, tgt] of Object.entries(tgtMap)) {
      const cur = curMap[id];
      if (cur && canonicalJson(contentOf(cur)) === canonicalJson(contentOf(tgt))) continue;   // 同じ
      if (!isValid(name, validationForm(tgt))) {
        push(name, cur ?? null, tgt, 'review', 'review', { reason: 'INVALID_BY_CURRENT_RULES' });
        continue;
      }
      if (!cur) {
        if (name === 'infusion_events' && seqUsed.has(`${tgt.infusion_id}#${tgt.seq}`)) {
          push(name, null, tgt, 'review', 'review', { reason: 'SEQ_CONFLICT' });
        } else push(name, null, tgt, 'add', 'apply');
        continue;
      }
      const cv = cur.version ?? 0;
      const tv = tgt.version ?? 0;
      if (cv > tv) push(name, cur, tgt, 'later_edit', 'keep', { selectable: 'revert' });   // 版が新しい＝復元後の編集（時刻では決めない）
      else push(name, cur, tgt, 'repair', 'apply');                                       // 同じ版で内容が違う／版が古い
    }
    for (const [id, cur] of Object.entries(curMap)) {
      if (tgtMap[id]) continue;
      if (cur.deleted_ms != null) continue;                                               // すでに論理削除：何もしない
      if (Number.isInteger(cur.change_no) && cur.change_no > maxTargetNo) push(name, cur, null, 'later_new', 'keep', { selectable: 'delete' });
      else push(name, cur, null, 'unknown_origin', 'keep', { selectable: 'delete' });
    }
  }
  items.sort((a, b) => orderOf(a.collection) - orderOf(b.collection) || (a.createdMs ?? 0) - (b.createdMs ?? 0) || (a.id < b.id ? -1 : 1));

  const planHash = hash(canonicalJson({ rp: restorePointMs, items: items.map((i) => [i.key, i.cls, i.before?.hash ?? null, i.afterHash]) }));
  const summary = {};
  for (const i of items) summary[i.cls] = (summary[i.cls] ?? 0) + 1;
  return { restorePointMs, maxTargetNo, planHash, summary, items };
}

/** 既定の選択（戻す・追加する対象のキー） */
export const defaultSelection = (plan) => plan.items.filter((i) => i.defaultAction === 'apply').map((i) => i.key);

/**
 * 選択から、実際の操作の一覧を作る。選べないもの（要確認）・選べない組み合わせは errors に入れる。
 * @returns {{ ok:boolean, ops:Array<{key, op:'put'|'softDelete', collection, id}>, errors:Array<{code, key?, id?}> }}
 */
export function resolveSelection(plan, selectedKeys) {
  const sel = new Set(selectedKeys);
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const errors = [];
  const ops = [];
  for (const key of sel) if (!byKey.has(key)) errors.push({ code: 'UNKNOWN_KEY', key });
  for (const item of plan.items) {
    if (!sel.has(item.key)) continue;
    if (item.cls === 'review') { errors.push({ code: 'NOT_SELECTABLE', key: item.key }); continue; }
    if (item.defaultAction === 'apply') ops.push({ key: item.key, op: 'put', collection: item.collection, id: item.id });
    else if (item.selectable === 'revert') ops.push({ key: item.key, op: 'put', collection: item.collection, id: item.id });
    else if (item.selectable === 'delete') ops.push({ key: item.key, op: 'softDelete', collection: item.collection, id: item.id });
  }
  return { ok: errors.length === 0, ops, errors };
}

const toCalcEvent = (e) => ({ seq: e.seq, type: e.type, occurredMs: e.occurred_ms, rate: e.rate, volumeMl: e.volume_ml, flushStatus: e.flush_status, correctsSeq: e.corrects_seq, field: e.field, newValue: e.new_value });
const CHAINED = ['visit_notes', 'tasks', 'needle_handovers'];

/**
 * 復元後の状態（現在の状態に、操作を当てはめたもの）の整合性。参照が途切れる選択・時系列が壊れる選択を見つける。
 * @param {Object<string,object[]>} current
 * @param {Array} ops resolveSelection の ops
 * @param {object} plan
 * @param {{ nowMs:number }} opts
 */
export function checkResultIntegrity(current, ops, plan, { nowMs }) {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const state = {};
  for (const [name, docs] of Object.entries(current ?? {})) state[name] = new Map(docs.map((d) => [d.id, d]));
  const touched = new Set();
  for (const op of ops) {
    const item = byKey.get(op.key);
    if (!state[op.collection]) state[op.collection] = new Map();
    if (op.op === 'put') state[op.collection].set(op.id, item.after);
    else { const cur = state[op.collection].get(op.id); if (cur) state[op.collection].set(op.id, { ...cur, deleted_ms: nowMs }); }
    if (op.collection === 'infusion_events') touched.add(item.after?.infusion_id ?? state[op.collection].get(op.id)?.infusion_id);
    if (op.collection === 'infusions') touched.add(op.id);
  }
  const errors = [];
  const live = (m, id) => { const d = m?.get(id); return d && d.deleted_ms == null ? d : null; };

  const infusions = state.infusions ?? new Map();
  const seqSeen = new Map();
  for (const ev of (state.infusion_events ?? new Map()).values()) {
    if (ev.deleted_ms != null) continue;
    if (!infusions.get(ev.infusion_id)) errors.push({ code: 'ORPHAN_EVENT', id: ev.id });
    else if (infusions.get(ev.infusion_id).deleted_ms != null) errors.push({ code: 'EVENT_OF_DELETED_INFUSION', id: ev.id });
    const k = `${ev.infusion_id}#${ev.seq}`;
    if (seqSeen.has(k) && seqSeen.get(k) !== ev.id) errors.push({ code: 'SEQ_CONFLICT', id: ev.id });
    seqSeen.set(k, ev.id);
  }
  for (const c of CHAINED) {
    const m = state[c];
    if (!m) continue;
    for (const d of m.values()) {
      if (d.deleted_ms != null || !d.corrects_id) continue;
      if (!live(m, d.corrects_id) && !m.get(d.corrects_id)) errors.push({ code: 'DANGLING_CORRECTION', id: d.id });
      else if (m.get(d.corrects_id)?.deleted_ms != null && ops.some((o) => o.collection === c && o.id === d.corrects_id && o.op === 'softDelete')) errors.push({ code: 'CORRECTION_CHAIN_BROKEN', id: d.id });
    }
  }
  // 点滴の経過の時系列：操作で触れた点滴だけ、操作の前から壊れていたものは数えない
  for (const infId of touched) {
    const inf = infusions.get(infId);
    if (!inf || inf.deleted_ms != null) continue;
    const evs = [...(state.infusion_events ?? new Map()).values()].filter((e) => e.infusion_id === infId && e.deleted_ms == null).sort((a, b) => a.seq - b.seq);
    const res = estimate({ volumeMl: inf.volume_ml, events: evs.map(toCalcEvent), nowMs });
    if (res.errors?.length) {
      const before = (current.infusion_events ?? []).filter((e) => e.infusion_id === infId && e.deleted_ms == null).sort((a, b) => a.seq - b.seq);
      const base = estimate({ volumeMl: inf.volume_ml, events: before.map(toCalcEvent), nowMs });
      const had = new Set((base.errors ?? []).map((e) => `${e.seq}|${e.code}`));
      for (const e of res.errors) if (!had.has(`${e.seq}|${e.code}`)) errors.push({ code: 'EVENT_TIMELINE_INVALID', id: infId, detail: e.code });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 適用後の確認：計画の操作がすべて目標どおりになっているか（内容の一致で判定する） */
export function verifyApplied(currentMap, ops, plan, hash) {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const bad = [];
  for (const op of ops) {
    const item = byKey.get(op.key);
    const cur = currentMap(op.collection, op.id);
    if (op.op === 'put') {
      if (!cur || contentHash(cur, hash) !== item.afterHash) bad.push({ key: op.key, code: 'NOT_AS_TARGET' });
    } else if (!cur || cur.deleted_ms == null) bad.push({ key: op.key, code: 'NOT_DELETED' });
  }
  return { ok: bad.length === 0, bad };
}
