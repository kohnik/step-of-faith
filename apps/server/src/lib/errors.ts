export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Нужна авторизация') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Не найдено') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** Код ошибки PostgreSQL unique_violation. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; cause?: unknown };
  if (e?.code === '23505') return !constraint || e.constraint === constraint;
  if (e?.cause) return isUniqueViolation(e.cause, constraint);
  return false;
}
