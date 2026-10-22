// 送信台帳の保存先（IndexedDB）。gas-porting-guide §5。
//
// put は、トランザクションの完了通知（complete）を受けてから解決する。
// 中断（abort）・失敗（error）・容量不足（QuotaExceededError）はすべて reject する。
// 注意：iOS Safari での永続性（強制終了・再起動の後に残るか）と durability 指定の効果は未確認（test-env-plan T-P 群）。

export const DB_NAME = 'cg-ledger';
export const STORE_NAME = 'ops';
export const DB_VERSION = 1;

export function createIdbLedgerStorage({ indexedDB = globalThis.indexedDB, dbName = DB_NAME } = {}) {
  let dbPromise = null;

  function open() {
    if (!indexedDB) return Promise.reject(Object.assign(new Error('IndexedDB unavailable'), { name: 'UnknownError' }));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'requestId' });
        };
        req.onsuccess = () => {
          const db = req.result;
          // 接続が閉じられた・他のタブが版を上げた場合は、次の呼び出しで開き直す（iOS で報告のある切断への備え）
          db.onclose = () => { dbPromise = null; };
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(Object.assign(new Error('blocked'), { name: 'AbortError' }));
      });
      // 開けなかった場合は、次の呼び出しで開き直す
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  function run(mode, operate) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = mode === 'readwrite'
          ? db.transaction(STORE_NAME, mode, { durability: 'strict' })
          : db.transaction(STORE_NAME, mode);
      } catch (e) {
        // 接続が閉じられていた場合は、開き直せるようにしてから失敗として返す（呼び出し側が再実行する）
        if (e?.name === 'InvalidStateError') dbPromise = null;
        reject(e);
        return;
      }
      let result;
      let request;
      try {
        request = operate(tx.objectStore(STORE_NAME));
      } catch (e) {
        try { tx.abort(); } catch { /* 既に終わっている */ }
        reject(e);
        return;
      }
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request?.error ?? Object.assign(new Error('error'), { name: 'UnknownError' }));
      tx.onabort = () => reject(tx.error ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }));
  }

  return {
    get: (id) => run('readonly', (s) => s.get(id)).then((v) => v ?? null),
    put: (item) => run('readwrite', (s) => s.put(item)).then(() => undefined),
    delete: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
    all: () => run('readonly', (s) => s.getAll()).then((v) => v ?? []),
  };
}
