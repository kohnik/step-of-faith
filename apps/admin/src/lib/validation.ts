import type { FormErrors } from '@mantine/form';
import { ApiError } from '../api/client.ts';

/** Минимальная форма ошибки zod 4 - берём из схем `@sof/shared`, сам zod в админке не нужен. */
interface IssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  format?: unknown;
  input?: unknown;
}

interface SchemaLike {
  safeParse(data: unknown): { success: boolean; error?: { issues: readonly IssueLike[] } };
}

const hasCyrillic = (s: string) => /[а-яё]/i.test(s);

/** Понятное сообщение на русском по коду ошибки zod. */
export function issueMessage(issue: IssueLike): string {
  if (hasCyrillic(issue.message)) return issue.message;
  const min = Number(issue.minimum);
  const max = Number(issue.maximum);
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') return min <= 1 ? 'Обязательное поле' : `Минимум ${min} символов`;
      if (issue.origin === 'array' || issue.origin === 'set') return min <= 1 ? 'Выберите хотя бы одно значение' : `Минимум ${min}`;
      return `Не меньше ${min}`;
    case 'too_big':
      if (issue.origin === 'string') return `Максимум ${max} символов`;
      if (issue.origin === 'array' || issue.origin === 'set') return `Не больше ${max}`;
      return `Не больше ${max}`;
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null || issue.input === '') return 'Обязательное поле';
      if (typeof issue.input === 'number' && Number.isNaN(issue.input)) return 'Введите число';
      return 'Неверное значение';
    case 'invalid_format':
      switch (issue.format) {
        case 'date':
          return 'Дата в формате ДД.ММ.ГГГГ';
        case 'datetime':
          return 'Укажите дату и время';
        case 'url':
          return 'Ссылка должна начинаться с https://';
        case 'email':
          return 'Неверный e-mail';
        default:
          return 'Неверный формат';
      }
    case 'invalid_value':
      return 'Выберите значение из списка';
    case 'not_multiple_of':
      return 'Нужно целое число';
    default:
      return 'Неверное значение';
  }
}

/**
 * Прогоняет данные через схему из `@sof/shared` и раскладывает ошибки по полям формы.
 * `fieldMap` переименовывает пути (`amount` → `amountText`).
 */
export function schemaErrors(schema: SchemaLike, payload: unknown, fieldMap: Record<string, string> = {}): FormErrors {
  const res = schema.safeParse(payload);
  if (res.success || !res.error) return {};
  const errors: FormErrors = {};
  for (const issue of res.error.issues) {
    const path = issue.path.map(String).join('.');
    const key = fieldMap[path] ?? (path || 'form');
    if (!errors[key]) errors[key] = issueMessage(issue);
  }
  return errors;
}

/** Ошибки валидации от сервера (400 validation_error) → ошибки полей формы. */
export function serverErrors(error: unknown, fieldMap: Record<string, string> = {}): FormErrors {
  if (!(error instanceof ApiError) || error.status !== 400) return {};
  const out: FormErrors = {};
  for (const [path, message] of Object.entries(error.fieldErrors)) out[fieldMap[path] ?? path] = message;
  return out;
}

/** Строковое поле → null, если пустое. */
export const emptyToNull = (value: string | null | undefined): string | null => {
  const s = value?.trim() ?? '';
  return s === '' ? null : s;
};

/** Числовое поле Mantine (`number | string`) → number | null. */
export function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
