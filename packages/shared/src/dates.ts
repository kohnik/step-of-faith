/** Возраст, если дата рождения известна (у гостя на месте её нет). */
export function ageOrNull(birthDate: string | null | undefined, on: Date | string = new Date()): number | null {
  return birthDate ? ageOn(birthDate, on) : null;
}

/** Полных лет на дату `on` (по календарю, без часовых поясов). */
export function ageOn(birthDate: string, on: Date | string = new Date()): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const d = typeof on === 'string' ? new Date(on) : on;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  let age = y - by;
  if (m < bm || (m === bm && day < bd)) age -= 1;
  return age;
}

export function fullName(p: { lastName: string; firstName: string; middleName?: string | null }): string {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
}
