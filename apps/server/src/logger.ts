import pino from 'pino';
import type { Config } from './config.ts';

export function createLogger(config: Config, name: string) {
  return pino({
    name,
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', '*.token', 'token'],
    ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  });
}
