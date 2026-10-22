// 予定先マスタ（設定の key が place: で始まる記録）。名称・予定種別（複数）・電話番号・住所・移動時間・到着の余裕。
// 新しいコレクションは作らず、既存の設定（settings）を使う：母娘の両方が読め、書けるのは管理者のみ。
// 予定を作るときは、選んだ予定先の内容を予定に写す（予定は予定先の名前などをそのまま持つ＝既存の予定・計算・表示は変わらない）。

export const PLACE_PREFIX = 'place:';

export function listPlaces(data) {
  return data.list('settings')
    .filter((s) => typeof s.key === 'string' && s.key.startsWith(PLACE_PREFIX) && s.value && typeof s.value === 'object')
    .map((s) => ({ id: s.id, version: s.version, key: s.key, ...s.value }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/** 予定の事業所名・種別に合う予定先（編集のとき、選択の初期値に使う） */
export const findPlace = (places, provider, kind) => places.find((p) => p.name === provider && p.kinds.includes(kind)) ?? null;
