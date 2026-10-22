// 起動・画面の切り替え・同期のきっかけ（起動時、復帰時、30分ごと、手動更新）。

import { createData, uuid } from './data.js';
import { startBackground } from './bg-view.js';
import { h, clear, fmtDate, fmtTimeAmPm, icon } from './ui.js';
import { renderHome } from './screens/home.js';
import { renderPlaceholder } from './screens/placeholder.js';
import { todaysOccurrences, appointmentsOf, styleOf, shortKind } from './schedule-view.js';
import { staleSheet } from './restore-ui.js';
import { syncInfo } from './status-bar.js';
import { configuredApiUrl } from './api-config.js';

// 実運用版（接続先が設定されている）では、PC の模擬サーバー向けの開発用の呼び出し（/dev/…）は一切しない
const DEV_SERVER = configuredApiUrl() === '/api';

const SYNC_INTERVAL_MS = 30 * 60_000;

const TABS = {
  mother: [['home', 'ホーム', 'home'], ['infusion', '点滴', 'drop'], ['schedule', '予定', 'calendar'], ['records', '記録', 'pencil']],
  admin: [['home', 'ホーム', 'home'], ['infusion', '点滴', 'drop'], ['schedule', '予定', 'calendar'], ['records', '記録', 'pencil'], ['settings', '設定', 'gear']],
};

// プレビュー（?preview=状態）：実データに触れず、各状態の画面を確かめるためのモード。通信・保存・Service Worker は使わない。
// 使い方は app/preview.html。記録を作成・変更する操作は、すべて失敗する（preview-data.js）
const q = new URLSearchParams(location.search);
// 試用版の公開（tools/stage-site.mjs が index.html に cg-mode=preview-only を入れる）：架空データ・閲覧専用で開く。「端末の登録」画面は出さない
const PREVIEW_ONLY = Boolean(document.querySelector('meta[name="cg-mode"][content="preview-only"]'));
const PREVIEW = q.get('preview') || (PREVIEW_ONLY ? 'running' : null);
const previewNow = Number(q.get('now')) || Date.now();
const data = PREVIEW
  ? (await import('./preview-data.js')).createPreviewData({
    scenario: PREVIEW, role: q.get('role') === 'mother' ? 'mother' : 'admin', nowMs: previewNow,
    staleSync: q.get('stale') === '1', unsent: Number(q.get('unsent')) || 0, rejected: q.get('rejected') === '1', extras: q.get('extras') !== '0',
    apptCount: q.get('appts') !== null ? Number(q.get('appts')) : undefined,
    birthday: q.get('birthday') ? { month: Number(q.get('birthday').split('-')[0]), day: Number(q.get('birthday').split('-')[1]) } : null,
  })
  : createData();
const now = PREVIEW ? () => previewNow : () => Date.now();
if (PREVIEW) document.body.classList.add('is-preview');
const view = document.getElementById('view');
const tabs = document.getElementById('tabs');
const barDate = document.getElementById('bar-date');
const barSync = document.getElementById('bar-sync');
const barAppts = document.getElementById('bar-appts');

let screen = 'home';
let params = {};
let renderTimer = null;

const SCREENS = {};   // 画面名 → render(root, ctx)。ほかの画面のファイルが登録する
export function registerScreen(name, fn) { SCREENS[name] = fn; }

// 同期の操作（ヘッダーと HOME の情報パネルの同期ボタンで共通）。復元前の未送信は、内容を確かめてから選ぶ
async function syncNow() {
  if (data.counts.stale > 0) { staleSheet(ctx); return; }
  await data.flush(); await data.sync();
}
const ctx = { data, now, nav, syncNow, refresh: () => render(true), get params() { return params; } };

export function nav(to, p = {}) {
  screen = to; params = p;
  document.body.dataset.screen = to;
  render(true);
  view.scrollTop = 0;
}

function currentTabs() {
  return TABS[data.role] ?? TABS.mother;
}

function renderTabs() {
  clear(tabs);
  for (const [key, label, icon_] of currentTabs()) {
    tabs.append(h('button', { type: 'button', 'aria-current': key === screen ? 'page' : false, on: { click: () => nav(key) } },
      icon(icon_), label));
  }
}

/** 同期の状態の表示（ヘッダー右）。保存できていない記録だけ赤、未送信・同期できないは琥珀（赤にしない） */
/** 当日の予定ボタン（日付の横。種類別の淡い色・開始時刻順・収まらなければ次の行へ折り返す。予定のない日、HOME 以外は出さない） */
function renderBarAppts() {
  const list = screen === 'home' && data.hasToken ? todaysOccurrences(appointmentsOf(data), now()) : [];
  clear(barAppts);
  barAppts.hidden = list.length === 0;
  const hhmm = (ms) => { const d = new Date(ms + 9 * 3_600_000); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  for (const o of list) {
    const [bg, fg] = styleOf(o.appt.kind);
    barAppts.append(h('button', { class: 'hm-appt', type: 'button', role: 'listitem', style: `background:${bg};color:${fg}`, on: { click: () => nav('schedule', { open: o.key }) } }, `${shortKind(o.appt.kind)} ${hhmm(o.startMs)}`));
  }
}

function renderBar() {
  const t = now();
  barDate.textContent = fmtDate(t);
  renderBarAppts();
  const s = syncInfo(data);
  clear(barSync);
  if (s.alertIcon) barSync.append(icon('alert', 'sm'));
  barSync.append(s.text, icon('refresh', 'sm'));
  barSync.className = `bar-sync${s.level ? ` ${s.level}` : ''}${s.busy ? ' busy' : ''}`;
}

/** force＝画面の切り替え。そうでない更新（同期・時計）では、入力中のフォーム（data-keep）を作り直さない */
function render(force = false) {
  clearTimeout(renderTimer);
  renderBar();
  renderTimer = setTimeout(() => render(), 60_000);   // 経過時間・残り時間は端末の時計で毎分計算し直す（30分の同期に頼らない）
  if (!data.hasToken) { renderPairing(); tabs.hidden = true; return; }
  tabs.hidden = false;
  if (!force && (view.querySelector('[data-keep]') || !document.getElementById('overlay').hidden)) return;
  renderTabs();
  const fn = SCREENS[screen];
  if (screen === 'home') renderHome(clear(view), ctx);
  else if (fn) fn(clear(view), ctx);
  else renderPlaceholder(clear(view), screen);
}

// ---- 端末の登録 ----
function renderPairing() {
  document.body.dataset.screen = 'pair';
  clear(view);
  const err = h('p', { class: 'err', role: 'alert' });
  const input = h('input', { id: 'code', type: 'text', inputMode: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABCD-EFGH', style: 'letter-spacing:.1em' });
  const go = async (code, roleHint) => {
    err.textContent = '';
    const r = await data.pair(code, roleHint);
    if (!r.ok) err.textContent = '登録できませんでした。コードが違うか、期限が切れています。管理者に新しいコードを発行してもらってください。';
    else nav('home');
  };
  const box = h('section', { class: 'panel' },
    h('h1', {}, 'この端末を登録する'),
    h('p', {}, '管理者から受け取った登録コードを入力してください。'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, '登録コード'), input),
    err,
    h('button', { class: 'btn', type: 'button', on: { click: () => go(input.value, null) } }, '登録する'));
  view.append(box);
  // 開発用：模擬サーバーのときだけ、コードの発行を代行するボタンを出す（本番には存在しない）
  if (!DEV_SERVER) return;
  fetch('/dev/ping').then((r) => r.ok ? r.json() : null).then((j) => {
    if (!j?.mock || view.querySelector('.dev-panel') || document.body.dataset.screen !== 'pair') return;
    const dev = h('section', { class: 'panel dev-panel' }, h('h2', {}, '開発用（模擬サーバー）'),
      h('p', { class: 'muted' }, '架空のデータだけの試験環境です。'));
    for (const [user, label, role] of [['u_admin', '管理者の端末として登録', 'admin'], ['u_mother', '母の端末として登録', 'mother']]) {
      dev.append(h('button', { class: 'btn secondary', type: 'button', on: { click: async () => {
        const res = await fetch(`/dev/issue?user=${user}`).then((r) => r.json());
        if (res?.code) await go(res.code, role); else err.textContent = 'コードを発行できませんでした。';
      } } }, label));
    }
    view.append(dev);
  }).catch(() => {});
}

// ---- 同期のきっかけ ----
barSync.addEventListener('click', syncNow);
data.subscribe(() => render());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && data.hasToken) { data.flush(); data.sync(); } });
window.addEventListener('online', () => { data.flush(); data.sync(); });
setInterval(() => { if (document.visibilityState === 'visible' && data.hasToken) data.sync(); }, SYNC_INTERVAL_MS);

// 背景（HOME だけ表示される）。誕生日は settings の 'birthday'
const background = startBackground(document.getElementById('bg'), {
  clock: now,
  getSettings: () => {
    const b = data.list('settings').find((s) => s.key === 'birthday');
    const v = b?.value;
    return { birthday: v && typeof v === 'object' ? v : null };
  },
});

data.subscribe(() => background.update());   // 誕生日の設定が変わったときなどに、判定し直す

// 画面のファイルを読み込む（読み込めない画面があっても、ほかの画面は使える）
const screensReady = Promise.all(['./screens/infusion.js', './screens/schedule.js', './screens/records.js', './screens/settings.js']
  .map((mod) => import(mod).then((m) => m.register?.(registerScreen, ctx)).catch(() => {})));

// 画面のファイルをオフラインでも開けるようにする（記録は保存しない）。登録できなくても、アプリは使える
try { if ((!PREVIEW || PREVIEW_ONLY) && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch { /* 無視 */ }

// PC 内の試験環境（模擬サーバーで実際に保存できる）と、閲覧専用のプレビューを区別する。プレビューは「プレビュー」、模擬サーバーは「試験環境」の印
if (!PREVIEW && DEV_SERVER) fetch('/dev/ping').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.mock) { document.body.classList.add('is-mock'); render(); } }).catch(() => {});

data.init().then(() => render(true));
render(true);
screensReady.then(() => {
  const sc = PREVIEW ? q.get('screen') : null;   // プレビューで、点滴の履歴・記録・設定の各画面を直接開く
  if (sc === 'history') nav('infusion', { intent: 'history' });
  else if (['infusion', 'schedule', 'records', 'settings'].includes(sc)) nav(sc, { intent: q.get('tab'), open: q.get('open') });
  else render(true);
});
window.__cg = { data, nav, uuid };   // 開発用の確認窓口（PC の模擬環境だけで使う）
