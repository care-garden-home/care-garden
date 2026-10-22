// 電話番号の表示・コピー・発信。保存されている文字列は変えない（表示と操作だけ）。
// 発信のリンク（tel:）は、検証と同じ規則に合う番号からだけ作る（不正な番号からは作らない）。

import { h, toast, icon } from './ui.js';
import { isDialable, telHref, displayPhone } from './phone-core.js';

async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* 下の方法で */ }
  try {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-1000px;top:0;opacity:0' });
    ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

/** 「コピー」「電話する」。番号がなければ何も出さない。不正な番号は、コピーだけ出す */
export function phoneActions(raw, { compact = false } = {}) {
  const text = displayPhone(raw);
  if (!text) return null;
  const href = telHref(raw);
  return h('div', { class: `phone-actions${compact ? ' compact' : ''}` },
    h('span', { class: 'phone-num num' }, text),
    h('button', { class: 'btn soft phone-btn', type: 'button', on: { click: async () => toast((await copyText(text)) ? '電話番号をコピーしました' : 'コピーできませんでした') } }, 'コピー'),
    href ? h('a', { class: 'btn soft phone-btn', href }, icon('phone', 'sm'), ' 電話する') : null);
}
