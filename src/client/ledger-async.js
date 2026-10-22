// 端末の送信台帳（非同期版・PWA 用）。gas-porting-guide §5。
//
// N-1 の同期版（ledger.js）と同じ判定の論理を、非同期の保存先（IndexedDB）の上で行う。
// 同期版は変更せず残し、両者の判定が一致することを試験で確かめる。
//
// 追加の原則
// - 「記録しました」を表示してよいのは saveOperation が ok:true を返したときだけ。
//   ok:true は、保存先への書き込みが完了し、読み戻して内容が一致したことを意味する
// - 書き込みの失敗・容量不足・中断は理由を区別して返し、成功とは扱わない
// - 操作ID・記録ID・内容は、再送でも変えない。同じ操作IDで内容が違う操作は受け付けない
// - 台帳への変更は内部で1件ずつ順に行う（同時に呼ばれても連番と順序が崩れない）

import { RETRY_SCHEDULE_MS, HOLD_STATES } from './ledger.js';

export { RETRY_SCHEDULE_MS, HOLD_STATES };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SAVE_FAILURE_MESSAGES = Object.freeze({
  STORAGE_FULL: '端末の空き容量が足りないため、記録できませんでした。空き容量を増やしてから、もう一度記録してください。',
  ABORTED: '記録の保存が中断されました。記録されていません。もう一度記録してください。',
  WRITE_FAILED: '端末への保存に失敗しました。記録されていません。もう一度記録してください。',
  READ_FAILED: '端末の記録を確認できませんでした。記録されていない可能性があります。もう一度記録してください。',
  ID_REUSED: '同じ操作が別の内容で送られました。記録されていません。画面を開き直してから記録してください。',
});

export class LedgerSaveError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'LedgerSaveError';
    this.reason = reason;
  }
}

/** 保存先の例外を、利用者に示す理由に分類する */
export function classifyStorageError(error) {
  const name = error?.name ?? '';
  if (name === 'QuotaExceededError' || /quota/i.test(String(error?.message ?? ''))) return 'STORAGE_FULL';
  if (name === 'AbortError') return 'ABORTED';
  return 'WRITE_FAILED';
}

function containsKey(value, key, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsKey(v, key, depth + 1));
  return Object.keys(value).some((k) => k === key || containsKey(value[k], key, depth + 1));
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 同期版と同じ状態遷移（ledger.js recordResult と一致させる） */
export function nextStateAfter(item, response, nowMs) {
  const next = { ...item, attempts: item.attempts + 1 };
  if (response && response.ok === true) {
    next.status = 'confirmed';
    next.confirmedMs = nowMs;
    next.lastCode = 'OK';
  } else if (response && response.ok === false && response.code === 'CONFLICT') {
    next.status = 'conflict';
    next.lastCode = 'CONFLICT';
  } else if (response && response.ok === false && (response.code === 'FORBIDDEN' || response.code === 'INVALID')) {
    next.status = 'rejected';
    next.lastCode = response.code;
  } else if (response && response.ok === false && response.code === 'EPOCH_STALE') {
    next.status = 'stale';
    next.lastCode = 'EPOCH_STALE';
  } else if (response && response.ok === false && response.code === undefined) {
    next.status = 'auth_required';
    next.lastCode = 'DENY';
  } else {
    const wait = RETRY_SCHEDULE_MS[Math.min(next.attempts - 1, RETRY_SCHEDULE_MS.length - 1)];
    next.status = 'pending';
    next.nextAttemptMs = nowMs + wait;
    next.lastCode = typeof response?.code === 'string' ? response.code : 'NETWORK';
  }
  return next;
}

/** 同期版の nextDue と同じ選び方（古い順、同じ点滴の保留を追い越さない） */
export function pickNextDue(items, nowMs) {
  const blocked = new Set();
  for (const it of [...items].sort((a, b) => a.seq - b.seq)) {
    const key = it.payload?.infusion_id;
    if (HOLD_STATES.includes(it.status)) {
      if (key) blocked.add(key);
      continue;
    }
    if (it.status !== 'pending') continue;
    if (key && blocked.has(key)) continue;
    return it.nextAttemptMs <= nowMs ? it : null;
  }
  return null;
}

/**
 * @param storage { get(id), put(item), delete(id), all() } いずれも Promise を返す
 * @param clock   () => ms
 */
export function createAsyncLedger(storage, clock) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function readAll() {
    try { return await storage.all(); } catch { throw new LedgerSaveError('READ_FAILED'); }
  }

  async function write(item) {
    try {
      await storage.put(item);
    } catch (e) {
      throw new LedgerSaveError(classifyStorageError(e));
    }
    // 書けたことを読み戻して確かめる
    let back;
    try { back = await storage.get(item.requestId); } catch { throw new LedgerSaveError('READ_FAILED'); }
    if (!back || !sameJson(back, item)) throw new LedgerSaveError('WRITE_FAILED');
    return back;
  }

  const ledger = {
    /**
     * 操作を台帳に保存する。保存が確認できたら item を返す。できなければ LedgerSaveError を投げる。
     * 同じ操作IDで同じ内容なら、既存の item を返す（二重に登録しない）。
     */
    enqueue({ requestId, action, payload, epoch }) {
      return serial(async () => {
        if (!UUID_RE.test(requestId ?? '')) throw new TypeError('INVALID_REQUEST_ID');
        if (typeof action !== 'string' || action.length === 0) throw new TypeError('INVALID_ACTION');
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('INVALID_PAYLOAD');
        if (containsKey(payload, 'token')) throw new TypeError('TOKEN_IN_PAYLOAD');

        let existing;
        try { existing = await storage.get(requestId); } catch { throw new LedgerSaveError('READ_FAILED'); }
        if (existing) {
          if (existing.action === action && sameJson(existing.payload, payload)) return existing;
          throw new LedgerSaveError('ID_REUSED');
        }

        const all = await readAll();
        const seq = all.reduce((m, it) => Math.max(m, it.seq), 0) + 1;
        const t = clock();
        const item = {
          requestId,
          action,
          payload: JSON.parse(JSON.stringify(payload)),
          seq,
          status: 'pending',
          attempts: 0,
          createdMs: t,
          nextAttemptMs: t,
          lastCode: null,
          confirmedMs: null,
          ...(typeof epoch === 'string' ? { epoch } : {}),
        };
        return write(item);
      });
    },

    nextDue() {
      return serial(async () => pickNextDue(await readAll(), clock()));
    },

    /** 送信用のリクエスト（操作ID・内容は保存されたものをそのまま使い、トークンだけ付ける） */
    buildRequest(item, token) {
      return { v: 1, token, action: item.action, request_id: item.requestId, payload: item.payload, ...(typeof item.epoch === 'string' ? { epoch: item.epoch } : {}) };
    },

    /** 復元前の世代で作られた未送信（古い順）。内容を本人に見せるために返す */
    listStale() {
      return serial(async () => (await readAll()).filter((it) => it.status === 'stale').sort((a, b) => a.seq - b.seq));
    },

    /**
     * 復元前の未送信を、本人が確認したうえで記録し直す。新しい操作として（新しい操作ID・今の世代で）積む。
     * 記録ID・点滴イベントのIDは同じまま（すでに同じ記録があれば、重複せず競合として表示される）。元の項目は消さず「記録し直した」にする。
     */
    rerecordStale(requestId, newRequestId, epoch) {
      return serial(async () => {
        let it;
        try { it = await storage.get(requestId); } catch { throw new LedgerSaveError('READ_FAILED'); }
        if (!it || it.status !== 'stale') return null;
        if (!UUID_RE.test(newRequestId ?? '')) throw new TypeError('INVALID_REQUEST_ID');
        const all = await readAll();
        const seq = all.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
        const t = clock();
        const fresh = { requestId: newRequestId, action: it.action, payload: JSON.parse(JSON.stringify(it.payload)), seq, status: 'pending', attempts: 0,
          createdMs: t, nextAttemptMs: t, lastCode: null, confirmedMs: null, resubmittedFrom: requestId, ...(typeof epoch === 'string' ? { epoch } : {}) };
        const saved = await write(fresh);
        await write({ ...it, status: 'resubmitted', resubmittedAs: newRequestId });
        return saved;
      });
    },

    /** 復元前の未送信を、送らないと決める（台帳には残す） */
    discardStale(requestId) {
      return serial(async () => {
        const it = await storage.get(requestId);
        if (!it || it.status !== 'stale') return false;
        await write({ ...it, status: 'discarded' });
        return true;
      });
    },

    recordResult(requestId, response) {
      return serial(async () => {
        let item;
        try { item = await storage.get(requestId); } catch { throw new LedgerSaveError('READ_FAILED'); }
        if (!item || item.status === 'confirmed') return item ?? null;
        return write(nextStateAfter(item, response, clock()));
      });
    },

    resumeAfterRepair() {
      return serial(async () => {
        const t = clock();
        let n = 0;
        for (const it of await readAll()) {
          if (it.status === 'auth_required') { await write({ ...it, status: 'pending', nextAttemptMs: t }); n++; }
        }
        return n;
      });
    },

    retryNow() {
      return serial(async () => {
        const t = clock();
        for (const it of await readAll()) {
          if (it.status === 'pending' && it.nextAttemptMs > t) await write({ ...it, nextAttemptMs: t });
        }
      });
    },

    dismiss(requestId) {
      return serial(async () => {
        const it = await storage.get(requestId);
        if (!it || !['conflict', 'rejected'].includes(it.status)) return false;
        await write({ ...it, status: 'dismissed' });
        return true;
      });
    },

    counts() {
      return serial(async () => {
        const c = { unsent: 0, conflict: 0, rejected: 0, authRequired: 0, confirmed: 0, stale: 0 };
        for (const it of await readAll()) {
          if (it.status === 'pending' || it.status === 'auth_required') c.unsent++;
          if (it.status === 'conflict') c.conflict++;
          if (it.status === 'rejected') c.rejected++;
          if (it.status === 'auth_required') c.authRequired++;
          if (it.status === 'confirmed') c.confirmed++;
          if (it.status === 'stale') c.stale++;
        }
        return c;
      });
    },

    purgeConfirmed(olderThanMs) {
      return serial(async () => {
        const t = clock();
        let n = 0;
        for (const it of await readAll()) {
          if (it.status === 'confirmed' && t - it.confirmedMs > olderThanMs) { await storage.delete(it.requestId); n++; }
        }
        return n;
      });
    },

    all() {
      return serial(async () => (await readAll()).sort((a, b) => a.seq - b.seq));
    },

    /**
     * 送れるものを順に送る（1件ずつ）。send は応答を返す Promise（失敗時は reject か null）。
     * getToken が null を返すあいだは送らない。
     * @returns 送信を試みた件数
     */
    async flush({ send, getToken, maxItems = 50 }) {
      let sent = 0;
      while (sent < maxItems) {
        const token = await getToken();
        if (!token) break;
        const item = await ledger.nextDue();
        if (!item) break;
        let response = null;
        try { response = await send(ledger.buildRequest(item, token)); } catch { response = null; }
        await ledger.recordResult(item.requestId, response);
        sent++;
        if (!response || response.ok !== true) break; // 失敗したら一旦止める（次の機会に再送）
      }
      return sent;
    },
  };
  return ledger;
}

/**
 * 画面から呼ぶ入口。ok:true のときだけ「記録しました」と表示する。
 * @returns {Promise<{ok:true, item} | {ok:false, reason, message}>}
 */
export async function saveOperation(ledger, op) {
  try {
    const item = await ledger.enqueue(op);
    return { ok: true, item };
  } catch (e) {
    const reason = e instanceof LedgerSaveError ? e.reason : 'WRITE_FAILED';
    return { ok: false, reason, message: SAVE_FAILURE_MESSAGES[reason] ?? SAVE_FAILURE_MESSAGES.WRITE_FAILED };
  }
}

/** 試験・PC 用の非同期メモリ保存先。fail を差し替えると、失敗を注入できる */
export function createAsyncMemoryStorage() {
  const map = new Map();
  const faults = { put: null, get: null, all: null };
  const maybeFail = (op) => { if (faults[op]) { const e = faults[op]; faults[op] = null; throw e; } };
  return {
    faults,
    get: async (id) => { maybeFail('get'); return map.has(id) ? structuredClone(map.get(id)) : null; },
    put: async (item) => { maybeFail('put'); map.set(item.requestId, structuredClone(item)); },
    delete: async (id) => { map.delete(id); },
    all: async () => { maybeFail('all'); return [...map.values()].map((v) => structuredClone(v)); },
  };
}
