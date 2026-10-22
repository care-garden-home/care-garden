// 電話番号の判定・リンクの組み立て（画面に依存しない純粋な関数）。発信のリンクは、記録の検証と同じ規則に合う番号からだけ作る

const VALID = /^[0-9+()\-\s]{6,20}$/;

/** 発信できる番号か（記録の検証と同じ規則：使える文字だけ、6〜20字、数字が5つ以上） */
export const isDialable = (raw) => typeof raw === 'string' && VALID.test(raw) && raw.replace(/\D/g, '').length >= 5;

/** tel: のリンク先。数字と先頭の + だけにする。不正な番号なら null */
export function telHref(raw) {
  if (!isDialable(raw)) return null;
  const t = raw.trim();
  const digits = t.replace(/[^0-9]/g, '');
  return `tel:${t.startsWith('+') ? '+' : ''}${digits}`;
}

/** 読みやすい表示：空白をそろえるだけ（桁の区切りは入力のまま。勝手にハイフンを足さない） */
export const displayPhone = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ');

