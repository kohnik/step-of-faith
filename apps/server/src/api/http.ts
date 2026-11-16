import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppError, badRequest } from '../lib/errors.ts';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new AppError(400, 'validation_error', 'Проверьте заполнение полей', res.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })));
  }
  return res.data;
}

export function idParam(params: unknown, key = 'id'): number {
  const value = Number((params as Record<string, string>)[key]);
  if (!Number.isInteger(value) || value <= 0) throw new AppError(400, 'invalid_id', 'Некорректный идентификатор');
  return value;
}

/**
 * Лимит запросов на пользователя (а не на IP: на площадке сотни людей за одним NAT).
 * Токен-бакет в памяти процесса - у нас один инстанс API.
 */
export class UserRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
    return true;
  }
}

export const tooManyRequests = () => new AppError(429, 'rate_limited', 'Слишком много запросов, подождите пару секунд');

/** Один файл из multipart-запроса; слишком большой - понятная ошибка вместо 413. */
export async function oneFile(req: FastifyRequest, maxBytes: number) {
  const part = await req.file({ limits: { fileSize: maxBytes } });
  if (!part) throw badRequest('no_file', 'Файл не пришёл');
  try {
    const data = await part.toBuffer();
    const fields = Object.fromEntries(
      Object.entries(part.fields).map(([k, v]) => [k, v && 'value' in v ? String(v.value) : undefined]),
    ) as Record<string, string | undefined>;
    return { data, mime: part.mimetype, name: part.filename, fields };
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw badRequest('too_big', `Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
    }
    throw err;
  }
}
