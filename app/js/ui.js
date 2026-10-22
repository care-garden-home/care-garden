// 画面の共通部品：要素の作成、確認画面、メッセージ、日時の表示。
// 文字列は textContent で入れる（記録の内容を HTML として解釈しない）。

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

// ---- 日時（日本時間） ----
const JST = 9 * 3_600_000;
const parts = (ms) => { const d = new Date(ms + JST); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), w: d.getUTCDay() }; };
const pad = (n) => String(n).padStart(2, '0');
export const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export const fmtTime = (ms) => { const p = parts(ms); return `${p.h}:${pad(p.mi)}`; };
export const fmtDate = (ms) => { const p = parts(ms); return `${p.mo}月${p.d}日（${WEEK[p.w]}）`; };
export const fmtDateShort = (ms) => { const p = parts(ms); return `${p.mo}/${p.d}（${WEEK[p.w]}）`; };

/** 「10/22 AM 2:50」：日付と AM/PM で示す（「きょう」「あす」は使わない。日をまたいでも日付で明確）。nowMs は互換のため受け取るだけ */
export function fmtWhen(ms) {
  const p = parts(ms);
  return `${p.mo}/${p.d} ${p.h < 12 ? 'AM' : 'PM'} ${p.h % 12 || 12}:${pad(p.mi)}`;
}
export const fmtDateTimeFull = fmtWhen;

/** 時刻だけ「AM 2:50」 */
export function fmtTimeAmPm(ms) {
  const p = parts(ms);
  return `${p.h < 12 ? 'AM' : 'PM'} ${p.h % 12 || 12}:${pad(p.mi)}`;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60_000));
  const hh = Math.floor(total / 60); const mm = total % 60;
  if (hh === 0) return `${mm}分`;
  return mm === 0 ? `${hh}時間` : `${hh}時間${mm}分`;
}

/** datetime-local 用の文字列（日本時間）⇄ ms */
export const toLocalInput = (ms) => { const p = parts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; };
export function fromLocalInput(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST;
}
export const toDateInput = (ms) => toLocalInput(ms).slice(0, 10);

// ---- 確認画面・メッセージ ----

const overlay = () => document.getElementById('overlay');

/**
 * 確認画面。操作の内容を文章で再表示し、選ぶまで閉じない（最初から選ばれている状態にしない）。
 * @returns {Promise<boolean>}
 */
export function confirmSheet({ title, lines = [], okLabel = 'はい', cancelLabel = 'やめる', danger = false }) {
  return new Promise((resolve) => {
    const root = overlay();
    const under = [...root.childNodes];   // 入力フォームの上に重ねる場合は、閉じたあとに入力した内容ごと戻す
    const done = (v) => { clear(root); if (under.length) root.append(...under); else root.hidden = true; resolve(v); };
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title),
      ...lines.map((l) => h('p', {}, l)),
      h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', on: { click: () => done(true) } }, okLabel),
      h('button', { class: 'btn secondary', type: 'button', on: { click: () => done(false) } }, cancelLabel));
    clear(root).append(sheet);
    root.hidden = false;
    sheet.querySelector('button.secondary')?.focus();
  });
}

/** 画面の一部を差し込む下からのシート（入力フォームなど）。close() で閉じる */
export function openSheet(title, build) {
  const root = overlay();
  const close = () => { root.hidden = true; clear(root); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title),
    document.body.classList.contains('is-preview') ? h('p', { class: 'note' }, '閲覧専用プレビューです。入力しても保存されません。') : null);
  sheet.append(...[].concat(build(close)));
  clear(root).append(sheet);
  root.hidden = false;
  return close;
}

/** 閲覧専用プレビューでは、操作の最初に「保存されません」と伝えて、そこで止める（最後まで進めてから失敗させない） */
export function previewBlocked() {
  if (!document.body.classList.contains('is-preview')) return false;
  toast('閲覧専用プレビューのため、この操作は保存されません');
  return true;
}

let toastTimer = null;
export function toast(text, ms = 3500) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ---- 線画アイコン（24px・線幅 1.75・丸い端と角。色は文字色に従う。絵文字・多色は使わない） ----
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  home: ['M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z'],
  drop: ['M12 4c3.5 4 6 7.2 6 10a6 6 0 0 1-12 0c0-2.8 2.5-6 6-10z'],
  pencil: ['M4 20l1.2-4.4L16.3 4.5a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.4 18.8z', 'M14.5 6.4l3.1 3.1'],
  gear: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  refresh: ['M19 12a7 7 0 1 1-2.05-4.95', 'M19 5v4h-4'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17.2v.1'],
  back: ['M15 5l-7 7 7 7'],
  calendar: ['M5 6h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 4v4', 'M16 4v4'],
  phone: ['M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7l1.3-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z'],
};
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ic ${cls}`.trim());
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** 詳しい説明（既定では閉じる）。「？」を押したときだけ開く。必要な警告・未送信・入力エラーには使わない */
export function why(...children) {
  return h('details', { class: 'why' }, h('summary', { 'aria-label': '説明を見る' }, '？'), h('div', { class: 'why-body' }, ...children));
}
