// Игровые изображения Where Winds Meet (карта + иконки) из папки assets.
// Синий = союзник/оборона, красный = враг/атака.
import mapBg from './assets/map.webp';
import tank from './assets/tank.png';
import healer from './assets/healer.png';
import dps from './assets/dps.png';
import boss from './assets/boss.png';
import towerAlly from './assets/tower_blue.png';
import towerEnemy from './assets/tower_red.png';
import treeAlly from './assets/tree_blue.png';
import treeEnemy from './assets/tree_red.png';
import gooseAlly from './assets/goose_blue.png';
import gooseEnemy from './assets/goose_red.png';

// Школы оружия (transparent PNG)
import wBamboocut from './assets/upscayl_png_ultrasharp-4x_4x/Bamboocut - Wind.png';
import wHengblade from './assets/upscayl_png_ultrasharp-4x_4x/Stonesplit - Strength.png';
import wSplendor from './assets/upscayl_png_ultrasharp-4x_4x/Bellstrike - Splendor.png';
import wUmbra from './assets/upscayl_png_ultrasharp-4x_4x/Bellstrike - Umbra.png';
import wDmgUmbrella from './assets/upscayl_png_ultrasharp-4x_4x/Silkbind - Jade.png';
import wNewUmbrella from './assets/upscayl_png_ultrasharp-4x_4x/Bamboocut - Dust.png';
import wHea from './assets/upscayl_png_ultrasharp-4x_4x/Silkbind - Deluge.png';
import wMight from './assets/upscayl_png_ultrasharp-4x_4x/Stonesplit - Might.png';

export const IMAGES = {
  mapBg,
  tank,
  healer,
  dps,
  boss,
  towerAlly,
  towerEnemy,
  treeAlly,
  treeEnemy,
  gooseAlly,
  gooseEnemy,
} as const;

// Картинки школ оружия по их id (см. WeaponSchool в types.ts)
export const WEAPON_IMAGES: Record<string, string> = {
  bamboocut: wBamboocut,
  hengblade: wHengblade,
  splendor: wSplendor,
  umbra: wUmbra,
  dmg_umbrella: wDmgUmbrella,
  new_umbrella: wNewUmbrella,
  hea: wHea,
  might: wMight,
};
