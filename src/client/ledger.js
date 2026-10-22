// 端末の送信台帳（gas-verification-plan §2-4・§7-2）。
//
// 原則
// - 操作は、送信より先に台帳へ書く。台帳に書けなければ操作そのものを失敗にする
// - サーバから「確定（ok:true）」を受けるまで、どんな失敗でも消さない
// - サーバに届かない期間も、記録（enqueue）は止めない
// - 台帳にトークンを持たせない。送信の直前に、その時点のトークンを付ける
// - 送信は古い順に1件ずつ（点滴イベントの順序を守る）
//
// storage は同期の get/put/all を持つもの（試験はメモリ、本番は IndexedDB の上に同じ形を作る）。

export const RETRY_SCHEDULE_MS = Object.freeze([10_000, 30_000, 60_000, 300_000, 900_000]);

// 確定以外で、利用者の対応を待つ状態（自動では再送しない・消さない）
// stale＝復元前の世代で作られた未送信（自動では再送しない。本人が内容を見て、記録し直すか、送らないかを選ぶ）
export const HOLD_STATES = Object.freeze(['conflict', 'rejected', 'auth_required', 'stale']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LedgerWriteError extends Error {
  constructor() { super('LEDGER_WRITE_FAILED'); this.name = 'LedgerWriteError'; }
}

function containsKey(value, key, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsKey(v, key, depth + 1));
  return Object.keys(value).some((k) => k === key || containsKey(value[k], key, depth + 1));
}

export function createLedger(storage, clock) {
  const now = () => clock();
  const items = () => storage.all().slice().sort((a, b) => a.seq - b.seq);
  const save = (item) => {
    try { storage.put(item); } catch { throw new LedgerWriteError(); }
  };

  return {
    /** 操作を台帳に記録する。成功したら item を返す。失敗したら LedgerWriteError を投げる */
    enqueue({ requestId, action, payload, epoch }) {
      if (!UUID_RE.test(requestId ?? '')) throw new TypeError('INVALID_REQUEST_ID');
      if (typeof action !== 'string' || action.length === 0) throw new TypeError('INVALID_ACTION');
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('INVALID_PAYLOAD');
      if (containsKey(payload, 'token')) throw new TypeError('TOKEN_IN_PAYLOAD');
      if (storage.get(requestId)) return storage.get(requestId); // 同じ操作の二重登録はしない

      const all = storage.all();
      const seq = all.reduce((m, it) => Math.max(m, it.seq), 0) + 1;
      const t = now();
      const item = {
        requestId,
        action,
        payload: structuredClone(payload),
        seq,
        status: 'pending',
        attempts: 0,
        createdMs: t,
        nextAttemptMs: t,
        lastCode: null,
        confirmedMs: null,
        ...(typeof epoch === 'string' ? { epoch } : {}),
      };
      save(item);
      return item;
    },

    /**
     * 次に送るべき1件（古い順の先頭）。先頭がまだ再送待ちなら null（順序を飛ばさない）。
     * 同じ点滴（payload.infusion_id）で、より古い操作が保留中（競合・拒否・再登録待ち）なら、
     * その点滴の後続は送らない（前の操作に依存するため）。他の点滴・記録は送る。
     */
    nextDue() {
      const blocked = new Set();
      for (const it of items()) {
        const key = it.payload?.infusion_id;
        if (HOLD_STATES.includes(it.status)) {
          if (key) blocked.add(key);
          continue;
        }
        if (it.status !== 'pending') continue;
        if (key && blocked.has(key)) continue;
        return it.nextAttemptMs <= now() ? it : null;
      }
      return null;
    },

    /** 送信用のリクエストを組み立てる（トークンはここで初めて付く） */
    buildRequest(item, token) {
      return { v: 1, token, action: item.action, request_id: item.requestId, payload: item.payload, ...(typeof item.epoch === 'string' ? { epoch: item.epoch } : {}) };
    },

    /**
     * 送信結果を反映する。response が null／undefined なら通信失敗として扱う。
     * @returns 更新後の item
     */
    recordResult(requestId, response) {
      const item = storage.get(requestId);
      if (!item || item.status === 'confirmed') return item ?? null;
      const t = now();
      const next = { ...item, attempts: item.attempts + 1 };

      if (response && response.ok === true) {
        next.status = 'confirmed';
        next.confirmedMs = t;
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
        // DENY：トークンが無効（失効・未ペアリング）。再ペアリングまで保持する
        next.status = 'auth_required';
        next.lastCode = 'DENY';
      } else {
        // RETRY・QUOTA・通信失敗・想定外の応答：間隔を空けて再送する
        const wait = RETRY_SCHEDULE_MS[Math.min(next.attempts - 1, RETRY_SCHEDULE_MS.length - 1)];
        next.status = 'pending';
        next.nextAttemptMs = t + wait;
        next.lastCode = typeof response?.code === 'string' ? response.code : 'NETWORK';
      }
      save(next);
      return next;
    },

    /** 再ペアリングの後：トークン待ちの項目を再送の対象に戻す */
    resumeAfterRepair() {
      const t = now();
      let n = 0;
      for (const it of items()) {
        if (it.status === 'auth_required') { save({ ...it, status: 'pending', nextAttemptMs: t }); n++; }
      }
      return n;
    },

    /** 起動時・前面復帰時・online 時・手動更新：再送待ちの間隔を待たずに送れるようにする */
    retryNow() {
      const t = now();
      for (const it of items()) {
        if (it.status === 'pending' && it.nextAttemptMs > t) save({ ...it, nextAttemptMs: t });
      }
    },

    /** 利用者が競合・拒否を確認し、取り下げた場合のみ消せる（確定扱いにはしない） */
    dismiss(requestId) {
      const it = storage.get(requestId);
      if (!it || !['conflict', 'rejected'].includes(it.status)) return false;
      save({ ...it, status: 'dismissed' });
      return true;
    },

    counts() {
      const c = { unsent: 0, conflict: 0, rejected: 0, authRequired: 0, confirmed: 0, stale: 0 };
      for (const it of storage.all()) {
        if (it.status === 'pending' || it.status === 'auth_required') c.unsent++;
        if (it.status === 'conflict') c.conflict++;
        if (it.status === 'rejected') c.rejected++;
        if (it.status === 'auth_required') c.authRequired++;
        if (it.status === 'confirmed') c.confirmed++;
        if (it.status === 'stale') c.stale++;
      }
      return c;
    },

    /** 確定から一定期間を過ぎたものだけを掃除する（未確定は決して消さない） */
    purgeConfirmed(olderThanMs) {
      const t = now();
      let n = 0;
      for (const it of storage.all()) {
        if (it.status === 'confirmed' && t - it.confirmedMs > olderThanMs) { storage.delete(it.requestId); n++; }
      }
      return n;
    },

    all: () => items(),
  };
}

export function createMemoryLedgerStorage() {
  const map = new Map();
  return {
    get: (id) => (map.has(id) ? structuredClone(map.get(id)) : null),
    put: (item) => { map.set(item.requestId, structuredClone(item)); },
    delete: (id) => { map.delete(id); },
    all: () => [...map.values()].map((v) => structuredClone(v)),
  };
}
