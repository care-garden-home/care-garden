// データ層：画面は保存方式（模擬サーバー／GAS）を知らず、ここだけを通る（画面設計 §7）。
//   書き：送信台帳（既存の ledger-async）に積む → 保存を確認できたら「記録しました」→ 送れるものから順に送る
//   読み：端末内のキャッシュ（同期で受け取った記録）＋未送信の操作を重ねた表示
// 通信は send(request) だけに依存する。本番では同じ形の要求を GAS へ送る実装に差し替える。

import { createAsyncLedger, saveOperation } from '../../src/client/ledger-async.js';
import { createIdbLedgerStorage } from '../../src/client/idb-storage.js';
import { createAsyncMemoryStorage } from '../../src/client/ledger-async.js';

const LS = {
  token: 'cg.token',
  role: 'cg.role',
  cache: 'cg.cache.v1',
};

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* 無視 */ } };

export const uuid = () => (globalThis.crypto?.randomUUID?.() ?? fallbackUuid());
function fallbackUuid() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 通信：本番の GAS と同じ形の要求を送り、応答（JSON）か null（通信できなかった）を返す */
export async function httpSend(request, { url = '/api', timeoutMs = 20_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(request), signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createData({ send: rawSend = httpSend, clock = () => Date.now(), storage = null } = {}) {
  const listeners = new Set();
  let maintenanceFlag = false;
  // 復元の作業中（MAINTENANCE）かどうかを、すべての応答から見張る（送信は台帳が間隔をあけて続ける）
  const send = async (req) => { const r = await rawSend(req); if (r && r.ok === false && r.code === 'MAINTENANCE') maintenanceFlag = true; else if (r && r.ok === true) maintenanceFlag = false; return r; };
  const ledger = createAsyncLedger(storage ?? safeStorage(), clock);
  let token = lsGet(LS.token);
  let role = lsGet(LS.role);
  let cache = loadCache();
  let pending = [];                // 台帳の未送信（表示に重ねる）
  let counts = { unsent: 0, conflict: 0, rejected: 0, authRequired: 0, confirmed: 0, stale: 0 };
  let lastSyncMs = cache.lastSyncMs ?? null;
  let syncState = 'idle';          // idle | syncing | failed
  let flushing = false;

  function safeStorage() {
    try { if (globalThis.indexedDB) return createIdbLedgerStorage(); } catch { /* メモリで代用 */ }
    return createAsyncMemoryStorage();
  }

  function loadCache() {
    try {
      const raw = lsGet(LS.cache);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && typeof c === 'object' && c.collections) return c;
      }
    } catch { /* 破損 → 空から */ }
    return { epoch: null, cursor: 0, collections: {}, lastSyncMs: null };
  }
  function saveCache() {
    cache.lastSyncMs = lastSyncMs;
    lsSet(LS.cache, JSON.stringify(cache));
  }
  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* 画面側の例外で止めない */ } } };

  async function refreshPending() {
    const all = await ledger.all();
    // 表示に重ねる操作：未送信のもの＋送れたが、まだ同期で取り込めていないもの（取り込めるまで記録が消えて見えないように）
    pending = all.filter((it) => it.status === 'pending' || it.status === 'auth_required'
      || (it.status === 'confirmed' && (lastSyncMs === null || it.confirmedMs >= lastSyncMs)));
    counts = await ledger.counts();
  }

  const api = {
    get role() { return role; },
    /** この端末の利用者の ID（表示の判断用。本人かどうかの判定は、サーバーが認証情報で行う） */
    get userId() { return role === 'admin' ? 'u_admin' : role === 'mother' ? 'u_mother' : null; },
    get hasToken() { return Boolean(token); },
    get lastSyncMs() { return lastSyncMs; },
    get syncState() { return syncState; },
    get counts() { return counts; },
    get maintenance() { return maintenanceFlag; },
    ledger,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** 引き換えコードで端末を登録する */
    async pair(code, roleHint = null) {
      const res = await send({ v: 1, action: 'pair.redeem', request_id: uuid(), payload: { code } });
      if (!res || res.ok !== true || typeof res.token !== 'string') return { ok: false };
      token = res.token;
      lsSet(LS.token, token);
      if (roleHint) { role = roleHint; lsSet(LS.role, role); }
      cache = { epoch: null, cursor: 0, collections: {}, lastSyncMs: null };
      lastSyncMs = null;
      await api.sync();
      emit();
      return { ok: true };
    },

    signOut() {
      token = null; role = null;
      lsDel(LS.token); lsDel(LS.role); lsDel(LS.cache);
      cache = { epoch: null, cursor: 0, collections: {}, lastSyncMs: null };
      lastSyncMs = null;
      emit();
    },

    /** 最新の記録を取得する（起動・復帰・30分ごと・手動更新） */
    async sync() {
      if (!token) return { ok: false, reason: 'NO_TOKEN' };
      syncState = 'syncing'; emit();
      let guard = 0;
      for (;;) {
        const res = await send({ v: 1, token, action: 'sync.pull', request_id: uuid(), payload: { since_no: cache.cursor, epoch: cache.epoch ?? undefined } });
        if (!res) { syncState = 'failed'; await refreshPending(); emit(); return { ok: false, reason: 'OFFLINE' }; }
        if (res.ok !== true) {
          if (res.code === 'RESYNC_REQUIRED' && guard++ < 2) {
            cache = { epoch: res.epoch ?? null, cursor: 0, collections: {}, lastSyncMs: null };
            continue;
          }
          syncState = 'failed';
          await refreshPending(); emit();
          return { ok: false, reason: res.code ?? 'DENIED' };
        }
        applyPull(res);
        if (!res.more) break;
      }
      if (cache.epoch === null) cache.epoch = null;
      lastSyncMs = clock();
      syncState = 'idle';
      saveCache();
      await refreshPending();
      emit();
      return { ok: true };
    },

    /** 記録の追加・更新・削除、点滴イベントの追記を台帳に積む。保存が確認できたときだけ ok:true */
    async save(action, payload) {
      const r = await saveOperation(ledger, { requestId: uuid(), action, payload, epoch: cache.epoch ?? undefined });
      await refreshPending();
      emit();
      if (r.ok) flushSoon();
      return r;
    },

    createRecord(collection, data, id = uuid()) {
      return api.save('record.create', { collection, id, data }).then((r) => ({ ...r, id }));
    },
    updateRecord(collection, id, baseVersion, data) {
      return api.save('record.update', { collection, id, base_version: baseVersion, data });
    },
    softDelete(collection, id, baseVersion) {
      return api.save('record.softDelete', { collection, id, base_version: baseVersion });
    },
    appendEvent(infusionId, event, id = uuid()) {
      return api.save('infusion.event.append', { id, infusion_id: infusionId, event }).then((r) => ({ ...r, id }));
    },

    /** 管理者の操作など、台帳に積まない1回きりの要求（端末の発行・失効、出力）。応答か null（通信できなかった） */
    async call(action, payload = {}) {
      if (!token) return null;
      return send({ v: 1, token, action, request_id: uuid(), payload });
    },

    /** 送れるものを順に送る（失敗しても止まらず、次の機会に再送） */
    async flush() {
      if (flushing || !token) return 0;
      flushing = true;
      try {
        const n = await ledger.flush({ send, getToken: async () => token });
        // 送れた分は、同期で取り込んでから「未送信」から外す（取り込む前に外すと、記録が一瞬見えなくなる）
        if (n > 0) await api.sync();
        else { await refreshPending(); emit(); }
        return n;
      } finally { flushing = false; }
    },

    /** 画面に出す記録（同期済み ＋ 未送信の操作を重ねたもの。削除済みは除く） */
    list(collection) {
      const base = new Map((cache.collections[collection] ?? []).map((d) => [d.id, d]));
      for (const it of pending) overlay(base, collection, it);
      return [...base.values()].filter((d) => d.deleted_ms == null);
    },
    get(collection, id) { return api.list(collection).find((d) => d.id === id) ?? null; },

    async init() {
      await refreshPending();
      emit();
      if (token) { await api.flush(); await api.sync(); }
    },
    /** 復元前の未送信の一覧・記録し直し・送らない（本人が内容を確認してから） */
    listStale() { return ledger.listStale(); },
    async rerecordStale(requestId) { const r = await ledger.rerecordStale(requestId, uuid(), cache.epoch ?? undefined); await refreshPending(); emit(); if (r) flushSoon(); return r; },
    async discardStale(requestId) { const r = await ledger.discardStale(requestId); await refreshPending(); emit(); return r; },
    async dismiss(requestId) { await ledger.dismiss(requestId); await refreshPending(); emit(); },
    async retryNow() { await ledger.retryNow(); await api.flush(); },
    /** 台帳の全件（同期の状態の画面用） */
    allOps() { return ledger.all(); },
  };

  let flushTimer = null;
  function flushSoon() { clearTimeout(flushTimer); flushTimer = setTimeout(() => { api.flush(); }, 50); }

  function applyPull(res) {
    // 検査：サーバーから来た内容は端末のキャッシュに入れるだけで、実行しない
    if (role === null || res.data?.audit_logs !== undefined) {
      const r = res.data?.audit_logs !== undefined ? 'admin' : 'mother';
      if (role !== r) { role = r; lsSet(LS.role, role); }
    }
    cache.epoch = res.epoch ?? cache.epoch;
    for (const [name, docs] of Object.entries(res.data ?? {})) {
      if (name === 'audit_logs' || name === 'sync_summary') continue;
      const arr = cache.collections[name] ?? (cache.collections[name] = []);
      const byId = new Map(arr.map((d) => [d.id, d]));
      for (const d of docs) {
        const cur = byId.get(d.id);
        if (!cur || (d.version ?? 0) >= (cur.version ?? 0)) byId.set(d.id, d);
      }
      cache.collections[name] = [...byId.values()];
    }
    cache.cursor = Math.max(cache.cursor, res.page_to ?? cache.cursor);
  }

  function overlay(base, collection, it) {
    const p = it.payload;
    const mark = it.status === 'confirmed' ? {} : { _pending: true, _requestId: it.requestId };
    if (it.action === 'record.create' && p.collection === collection) {
      if (!base.has(p.id)) base.set(p.id, { ...p.data, id: p.id, version: 0, created_ms: it.createdMs, deleted_ms: null, ...mark });
    } else if (it.action === 'record.update' && p.collection === collection) {
      const cur = base.get(p.id);
      if (cur) base.set(p.id, { ...cur, ...p.data, ...mark });
    } else if (it.action === 'record.softDelete' && p.collection === collection) {
      const cur = base.get(p.id);
      if (cur) base.set(p.id, { ...cur, deleted_ms: it.createdMs, ...mark });
    } else if (it.action === 'infusion.event.append' && collection === 'infusion_events') {
      if (!base.has(p.id)) {
        const seq = [...base.values()].filter((e) => e.infusion_id === p.infusion_id).reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1;
        base.set(p.id, { ...p.event, id: p.id, infusion_id: p.infusion_id, seq, version: 0, deleted_ms: null, ...mark });
      }
    }
  }

  return api;
}
