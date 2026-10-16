import { Player, Role, WEAPON_SCHOOLS, CallRole } from '../types';

// Пул имён в духе уся для демо-состава
const NAME_POOL = [
  'Лиму', 'Вэй', 'Сяо Лун', 'Фэн', 'Тан', 'Бай Хэ', 'Цзинь', 'Хуа', 'Лун', 'Мэй',
  'Гао', 'Чжао', 'Ян', 'Сюэ', 'Ло', 'Дин', 'Пэн', 'Цинь', 'Ши', 'Ань',
  'Юй', 'Хэ', 'Ма', 'Ду', 'Су', 'Жэнь', 'Кун', 'Би', 'Цай', 'Линь',
  'Чэнь', 'Гу', 'Хань', 'Ню', 'Цзян', 'Вэнь', 'Сун', 'Тао', 'У Кун', 'Ся',
  'Цзы', 'Мо', 'Не', 'Шэнь', 'Юань', 'Чжу', 'Лэй', 'Гуй', 'Янь', 'Цюэ'
];

const ROLES: Role[] = [Role.TANK, Role.HEALER, Role.DPS];

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * Генерирует случайных бойцов с уникальными именами (с учётом уже занятых).
 */
export const generateRandomPlayers = (count: number, existingNames: string[] = []): Player[] => {
  const used = new Set(existingNames.map(n => n.toLowerCase()));
  const result: Player[] = [];
  const base = Date.now();

  for (let i = 0; i < count; i++) {
    let name = pick(NAME_POOL);
    let attempt = 1;
    // Гарантируем уникальность имени
    while (used.has(name.toLowerCase())) {
      attempt += 1;
      name = `${pick(NAME_POOL)} ${attempt}`;
    }
    used.add(name.toLowerCase());

    // Роли с лёгким перекосом в сторону ДД (как в реальном составе)
    const roleRoll = Math.random();
    const role = roleRoll < 0.5 ? Role.DPS : roleRoll < 0.75 ? Role.TANK : Role.HEALER;

    result.push({
      id: `demo-${base}-${i}`,
      name,
      role,
      weapons: [pick(WEAPON_SCHOOLS), pick(WEAPON_SCHOOLS)],
      callRoles: [
        ...(Math.random() < 0.12 ? [CallRole.SHOTCALLER] : []),
        ...(Math.random() < 0.12 ? [CallRole.RL] : [])
      ]
    });
  }
  return result;
};
