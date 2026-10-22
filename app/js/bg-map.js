// 背景ID → アプリ用 WebP → 原本 PNG の対応（画面設計 §8）。原本は art/backgrounds/（非公開・Google ドライブにも保管）。
// WebP は tools/make-bg-webp.py が原本から作る（ファイル名の規則は同じ）。
const NORMAL = {
  mon: 'CG_01_Mon_{S}_LavenderPath.png', tue: 'CG_02_Tue_{S}_RoseCottage.png', wed: 'CG_03_Wed_{S}_BlueFlowerHills.png',
  thu: 'CG_04_Thu_{S}_HerbStreamBridge.png', fri: 'CG_05_Fri_{S}_ManorRoseGarden.png', sat: 'CG_06_Sat_{S}_HerbTerrace.png',
  sun: 'CG_07_Sun_{S}_RoseArcadeGarden.png',
};
const SLOT_NAME = { morning: 'Morning', noon: 'Noon', evening: 'Evening', night: 'Night' };
const SPECIAL = {
  newyear: 'CG_SP_NewYear_CamelliaTea.png', comingofage: 'CG_SP_ComingOfAge_WinterBirds.png',
  foundation: 'CG_SP_NationalFoundation_PlumLakeBench.png', springequinox: 'CG_SP_SpringEquinox_SakuraBench.png',
  showa: 'CG_SP_ShowaDay_SpringRoseBench.png', greenery: 'CG_SP_GreeneryDay_ShadedBench.png',
  childrens: 'CG_SP_ChildrensDay_KoinoboriTea.png', marine: 'CG_SP_MarineDay_SeasideHydrangeaBench.png',
  mountain: 'CG_SP_MountainDay_AlpineGardenBench.png', respect: 'CG_SP_RespectForAged_AutumnTea.png',
  autumnequinox: 'CG_SP_AutumnEquinox_SunsetGrasses.png', sports: 'CG_SP_SportsDay_ParkBench.png',
  culture: 'CG_SP_CultureDay_AutumnReading.png', labor: 'CG_SP_LaborThanksgiving_HarvestGarden.png',
  christmas: 'CG_SP_Christmas_WinterLanternBench.png', birthday: 'CG_SP_Birthday_FlowerCelebration.png',
};

/** 背景ID の対応表（44件） */
export const BACKGROUNDS = Object.freeze(Object.fromEntries([
  ...Object.entries(NORMAL).flatMap(([day, tpl]) => Object.entries(SLOT_NAME).map(([slot, name]) => [
    `${day}-${slot}`, { webp: `cg-${day}-${slot}.webp`, original: tpl.replace('{S}', name) },
  ])),
  ...Object.entries(SPECIAL).map(([id, original]) => [id, { webp: `cg-${id}.webp`, original }]),
]));

/** 背景ID → 画像のURL（app/ からの相対）。未知のIDは null */
export const backgroundUrl = (id) => (Object.prototype.hasOwnProperty.call(BACKGROUNDS, id) ? `../bg/${BACKGROUNDS[id].webp}` : null);
