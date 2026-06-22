// Pino logger com pretty print em dev, JSON em prod (compatível com Easypanel/Loki).
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'evo-scraper' },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } }
    : undefined,
});
