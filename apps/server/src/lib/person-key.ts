export function normalizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

/**
 * Ключ человека для поиска дублей: фамилия + имя + дата рождения (отчество часто не пишут).
 * У гостя на месте даты рождения нет - вместо неё цифры телефона.
 */
export function personKey(p: { lastName: string; firstName: string; birthDate: string | null; phone?: string | null }): string {
  const tail = p.birthDate ?? `tel:${(p.phone ?? '').replace(/\D/g, '')}`;
  return `${normalizeNamePart(p.lastName)}|${normalizeNamePart(p.firstName)}|${tail}`;
}
