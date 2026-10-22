// 入力欄の部品。値の取り出しと、欄ごとのエラー表示を持つ。確認画面は ui.js の confirmSheet を使う。

import { h, toLocalInput, fromLocalInput } from './ui.js';

let seq = 0;
const nextId = () => `f${++seq}`;

function wrap(label, control, { hint, id } = {}) {
  const bad = h('div', { class: 'bad', role: 'alert' });
  const el = h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('div', { class: 'hint' }, hint) : null, bad);
  return { el, setError(msg) { bad.textContent = msg ?? ''; }, focus() { control.focus?.(); } };
}

export function textField(label, { value = '', hint, placeholder, multiline = false, maxLength } = {}) {
  const id = nextId();
  const control = multiline
    ? h('textarea', { id, rows: 3, placeholder, maxLength })
    : h('input', { id, type: 'text', placeholder, maxLength, autocomplete: 'off' });
  control.value = value ?? '';
  return { ...wrap(label, control, { hint, id }), get: () => control.value.trim(), set: (v) => { control.value = v ?? ''; } };
}

/** 数値の欄。空なら undefined、数字でなければ NaN を返す（検証側で「数字で入力してください」にする） */
export function numberField(label, { value, hint, step = 'any', inputMode = 'decimal', min } = {}) {
  const id = nextId();
  const control = h('input', { id, type: 'text', inputMode, autocomplete: 'off' });
  control.value = value === undefined || value === null ? '' : String(value);
  const get = () => {
    const t = control.value.trim().replace(/[０-９．]/g, (c) => (c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
    if (t === '') return undefined;
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };
  return { ...wrap(label, control, { hint, id }), get, set: (v) => { control.value = v ?? ''; }, input: control };
}

export function selectField(label, options, { value, hint } = {}) {
  const id = nextId();
  const control = h('select', { id }, ...options.map(([v, text]) => h('option', { value: String(v) }, text)));
  if (value !== undefined) control.value = String(value);
  const lookup = new Map(options.map(([v]) => [String(v), v]));
  return { ...wrap(label, control, { hint, id }), get: () => lookup.get(control.value), set: (v) => { control.value = String(v); }, input: control };
}

/** 日時の欄。初期値は「いま」（ms）。日付が変わる場合も日付が見える */
export function dateTimeField(label, { value, hint } = {}) {
  const id = nextId();
  const control = h('input', { id, type: 'datetime-local' });
  if (value !== undefined) control.value = toLocalInput(value);
  return { ...wrap(label, control, { hint, id }), get: () => fromLocalInput(control.value), set: (ms) => { control.value = toLocalInput(ms); }, input: control };
}

/** 時刻の欄（HH:MM）。空なら undefined */
export function timeField(label, { value = '', hint } = {}) {
  const id = nextId();
  const control = h('input', { id, type: 'time' });
  control.value = value;
  return { ...wrap(label, control, { hint, id }), get: () => control.value || undefined, set: (v) => { control.value = v ?? ''; }, input: control };
}

export function dateField(label, { value = '', hint } = {}) {
  const id = nextId();
  const control = h('input', { id, type: 'date' });
  control.value = value;
  return { ...wrap(label, control, { hint, id }), get: () => control.value || undefined, set: (v) => { control.value = v ?? ''; }, input: control };
}

/** 選択ボタン（1つ選ぶ。最初から選ばれている状態にしたくないときは value を渡さない） */
export function choiceField(label, options, { value, hint } = {}) {
  let current = value;
  const buttons = options.map(([v, text]) => h('button', { type: 'button', 'aria-pressed': v === current ? 'true' : 'false',
    on: { click: () => { current = v; buttons.forEach((b, i) => b.setAttribute('aria-pressed', options[i][0] === current ? 'true' : 'false')); } } }, text));
  const el = h('div', { class: 'field' }, h('div', { class: 'lbl' }, label), h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...buttons),
    hint ? h('div', { class: 'hint' }, hint) : null);
  const bad = h('div', { class: 'bad', role: 'alert' });
  el.append(bad);
  return { el, get: () => current, set: (v) => { current = v; buttons.forEach((b, i) => b.setAttribute('aria-pressed', options[i][0] === current ? 'true' : 'false')); }, setError(msg) { bad.textContent = msg ?? ''; } };
}

/** 検証の結果（validateRecord の errors）を欄に表示する。表示できなかった分は文章にして返す */
export function showErrors(fields, errors) {
  for (const f of Object.values(fields)) f.setError?.('');
  const rest = [];
  for (const e of errors) {
    const f = fields[e.field];
    if (f) f.setError(e.message); else rest.push(e.message);
  }
  const first = errors.map((e) => fields[e.field]).find(Boolean);
  first?.focus?.();
  return rest;
}
