// Carrega .env e expõe a config tipada. Falha rápido (em boot) se algo crítico falta.
import 'dotenv/config';
import { logger } from './lib/logger.js';

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === '') {
    logger.fatal(`Missing required env: ${key}`);
    process.exit(1);
  }
  return v;
}

function optional(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function intOpt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolOpt(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

export const config = {
  port: intOpt('PORT', 8088),
  scraperToken: required('SCRAPER_TOKEN'),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',').map(s => s.trim()).filter(Boolean),

  evo: {
    loginUrl: optional('EVO_LOGIN_URL', 'https://evo5.w12app.com.br/'),
    username: required('EVO_USERNAME'),
    password: required('EVO_PASSWORD'),
    branchIds: optional('EVO_BRANCH_IDS', '1')
      .split(',').map(s => s.trim()).filter(Boolean),
    tenant: optional('EVO_TENANT', 'gavioes'),
  },

  playwright: {
    headless: boolOpt('PLAYWRIGHT_HEADLESS', true),
    timeoutMs: intOpt('PLAYWRIGHT_TIMEOUT_MS', 60_000),
    sessionDir: optional('SESSION_DIR', './session'),
  },

  // NocoDB é OPCIONAL no Gaviões (não tem instância). Se NOCODB_BASE não estiver
  // setado, o scraper persiste o snapshot em arquivo local e serve pela API HTTP.
  nocodb: {
    enabled: !!process.env.NOCODB_BASE?.trim(),
    base: optional('NOCODB_BASE').replace(/\/$/, ''),
    token: optional('NOCODB_TOKEN'),
    tableEvoSnapshot: optional('NOCODB_TABLE_EVO_SNAPSHOT'),
  },

  cronIntervalMs: intOpt('CRON_INTERVAL_MS', 0),
  isDev: process.env.NODE_ENV !== 'production',
} as const;

logger.info({ port: config.port, branches: config.evo.branchIds, headless: config.playwright.headless, cron: config.cronIntervalMs }, 'config loaded');
