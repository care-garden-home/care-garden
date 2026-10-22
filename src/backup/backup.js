// バックアップの作成・保存確認・復元計算（storage-comparison §5、phase0-prep §8-5）。
//
// 「保存できたか」と「復元できるか」を別々に評価する：
//   verifySaved      … 書いたファイルを読み戻し、書いたものと同一かを確かめる（保存成功の確認）
//   verifyRestorable … ファイル群から、ある時点の状態を実際に組み立てられるかを確かめる（復元可能性）
// どちらも書き込みはしない（計算のみ）。ハッシュ関数は引数で受け取る（GAS では Utilities.computeDigest）。

export const FORMAT = 'care-garden-backup';
export const FORMAT_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 1;

// 認証に関わる情報はバックアップに含めない
export const EXCLUDED_TABLES = Object.freeze(['devices', 'pairing_codes', 'pairing', 'processed_requests']);

/** キーを並べ替えた JSON（チェックサムを安定させるため） */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function normalizeTables(tables) {
  const out = {};
  for (const name of Object.keys(tables).sort()) {
    if (EXCLUDED_TABLES.includes(name)) continue;
    out[name] = [...tables[name]].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return out;
}

const checksumOf = (tables, hash) => `sha256:${hash(canonicalJson(tables))}`;
const countsOf = (tables) => Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));

/**
 * @param {object} p { kind:'full'|'diff', id, baseFullId, prevId, fromMs, toMs, tables, schemaVersion }
 */
export function createBackup(p, hash) {
  if (p.kind !== 'full' && p.kind !== 'diff') throw new TypeError('INVALID_KIND');
  const tables = normalizeTables(p.tables ?? {});
  return {
    manifest: {
      format: FORMAT,
      format_version: FORMAT_VERSION,
      schema_version: p.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      kind: p.kind,
      id: p.id,
      base_full_id: p.kind === 'full' ? p.id : p.baseFullId,
      prev_id: p.kind === 'full' ? null : p.prevId,
      from_ms: p.kind === 'full' ? null : p.fromMs,
      to_ms: p.toMs,
      counts: countsOf(tables),
      checksum: checksumOf(tables, hash),
    },
    tables,
  };
}

export const serializeBackup = (backup) => canonicalJson(backup);

/** 1つのファイルの形式・版・件数・チェックサムを検査する */
export function validateFile(file, hash, { currentSchema = CURRENT_SCHEMA_VERSION } = {}) {
  const errors = [];
  const m = file?.manifest;
  if (!m || typeof file.tables !== 'object' || file.tables === null) return ['MALFORMED'];
  if (m.format !== FORMAT) errors.push('FORMAT_MISMATCH');
  if (m.format_version !== FORMAT_VERSION) errors.push('FORMAT_VERSION_UNSUPPORTED');
  if (!Number.isInteger(m.schema_version)) errors.push('SCHEMA_INVALID');
  else if (m.schema_version > currentSchema) errors.push('SCHEMA_TOO_NEW');
  if (m.kind !== 'full' && m.kind !== 'diff') errors.push('KIND_INVALID');
  if (typeof m.to_ms !== 'number') errors.push('TO_MS_INVALID');
  for (const name of Object.keys(file.tables)) {
    if (EXCLUDED_TABLES.includes(name)) errors.push('EXCLUDED_TABLE_PRESENT');
  }
  if (canonicalJson(countsOf(file.tables)) !== canonicalJson(m.counts ?? {})) errors.push('COUNT_MISMATCH');
  if (checksumOf(normalizeTables(file.tables), hash) !== m.checksum) errors.push('CHECKSUM_MISMATCH');
  return errors;
}

/**
 * 保存成功の確認：書いたバックアップと、保存先から読み戻した文字列が同一か。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function verifySaved(written, readBackText, hash) {
  let readBack;
  try { readBack = JSON.parse(readBackText); } catch { return { ok: false, errors: ['READBACK_UNPARSABLE'] }; }
  const errors = validateFile(readBack, hash);
  if (canonicalJson(readBack) !== canonicalJson(written)) errors.push('READBACK_DIFFERS');
  return { ok: errors.length === 0, errors };
}

function migrateTables(tables, fromVersion, toVersion, migrations) {
  let t = structuredClone(tables);
  for (let v = fromVersion; v < toVersion; v++) {
    const fn = migrations?.[v];
    if (typeof fn !== 'function') throw new Error(`MIGRATION_MISSING_${v}`);
    t = fn(t);
  }
  return t;
}

/**
 * 全件1つ＋差分の鎖から、targetMs 時点の状態を組み立てる。
 * 鎖が切れていたら、切れる直前の時点までで止め、その時点を返す。
 * @returns {{ok, state, restoredToMs, appliedIds, errors}}
 */
export function computeRestoreState(files, { targetMs, hash, migrations = {}, currentSchema = CURRENT_SCHEMA_VERSION }) {
  const errors = [];
  const fulls = files
    .filter((f) => f?.manifest?.kind === 'full' && f.manifest.to_ms <= targetMs)
    .sort((a, b) => b.manifest.to_ms - a.manifest.to_ms);

  let full = null;
  for (const f of fulls) {
    const errs = validateFile(f, hash, { currentSchema });
    if (errs.length === 0) { full = f; break; }
    errors.push({ id: f.manifest.id, codes: errs });
  }
  if (!full) return { ok: false, state: null, restoredToMs: null, appliedIds: [], errors: [...errors, { code: 'NO_VALID_FULL' }] };

  const state = {};
  const apply = (file) => {
    const tables = file.manifest.schema_version < currentSchema
      ? migrateTables(file.tables, file.manifest.schema_version, currentSchema, migrations)
      : file.tables;
    for (const [name, docs] of Object.entries(tables)) {
      if (EXCLUDED_TABLES.includes(name)) continue;
      state[name] ??= {};
      for (const doc of docs) state[name][doc.id] = structuredClone(doc);
    }
  };

  try { apply(full); } catch (e) {
    return { ok: false, state: null, restoredToMs: null, appliedIds: [], errors: [...errors, { code: 'MIGRATION_FAILED' }] };
  }
  const appliedIds = [full.manifest.id];
  let prevId = full.manifest.id;
  let prevTo = full.manifest.to_ms;

  const diffs = files
    .filter((f) => f?.manifest?.kind === 'diff' && f.manifest.base_full_id === full.manifest.id && f.manifest.to_ms <= targetMs)
    .sort((a, b) => a.manifest.to_ms - b.manifest.to_ms);

  for (const d of diffs) {
    const m = d.manifest;
    if (m.prev_id !== prevId || m.from_ms !== prevTo) {
      errors.push({ code: 'CHAIN_BROKEN', at: prevTo, next: m.id });
      break;
    }
    const errs = validateFile(d, hash, { currentSchema });
    if (errs.length) { errors.push({ id: m.id, codes: errs }); break; }
    try { apply(d); } catch { errors.push({ id: m.id, code: 'MIGRATION_FAILED' }); break; }
    appliedIds.push(m.id);
    prevId = m.id;
    prevTo = m.to_ms;
  }

  return { ok: errors.length === 0, state, restoredToMs: prevTo, appliedIds, errors };
}

/** 組み立てた状態の整合性（参照・ID）を検査する */
export function checkIntegrity(state) {
  const errors = [];
  for (const [name, docs] of Object.entries(state)) {
    for (const [id, doc] of Object.entries(docs)) {
      if (doc.id !== id) errors.push({ code: 'ID_MISMATCH', table: name, id });
    }
  }
  const infusions = state.infusions ?? {};
  for (const ev of Object.values(state.infusion_events ?? {})) {
    if (!infusions[ev.infusion_id]) errors.push({ code: 'ORPHAN_EVENT', id: ev.id });
  }
  return errors;
}

/**
 * 復元可能性の確認：時点 T の状態を組み立て、整合性まで確かめる（書き込みはしない）。
 * @returns {{ok, restoredToMs, counts, errors}}
 */
export function verifyRestorable(files, opts) {
  const r = computeRestoreState(files, opts);
  if (!r.state) return { ok: false, restoredToMs: null, counts: null, errors: r.errors };
  const integrity = checkIntegrity(r.state);
  const errors = [...r.errors, ...integrity];
  const counts = Object.fromEntries(Object.entries(r.state).map(([k, v]) => [k, Object.keys(v).length]));
  return { ok: errors.length === 0, restoredToMs: r.restoredToMs, counts, errors };
}

/** 現在の内容と、復元後の内容の差（管理者に提示する件数） */
export function planRestoreDiff(currentTables, targetState) {
  const plan = {};
  const names = new Set([...Object.keys(currentTables), ...Object.keys(targetState)]);
  for (const name of names) {
    if (EXCLUDED_TABLES.includes(name)) continue;
    const cur = Object.fromEntries((currentTables[name] ?? []).map((d) => [d.id, d]));
    const tgt = targetState[name] ?? {};
    const p = { add: 0, change: 0, unchanged: 0, softDelete: 0 };
    for (const [id, doc] of Object.entries(tgt)) {
      if (!cur[id]) p.add++;
      else if (canonicalJson(cur[id]) === canonicalJson(doc)) p.unchanged++;
      else p.change++;
    }
    // 復元時点より後に作られたもの：物理削除せず、論理削除の印を付ける
    for (const id of Object.keys(cur)) if (!tgt[id]) p.softDelete++;
    plan[name] = p;
  }
  return plan;
}
