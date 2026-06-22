// Job queue in-memory. Apenas 1 job rodando por vez (browser headless é caro).
//
// Pipeline de cada job: autentica (reusa sessão) → cria evoClient → extrai os
// KPIs gerenciais via API direta → salva snapshot (arquivo local + NocoDB se on).

import { nanoid } from 'nanoid';
import { ensureAuthenticated, closeBrowser, invalidateSession } from './auth.js';
import { createEvoClient } from './evoClient.js';
import { extractGerencial } from './extractors/gerencial.js';
import { saveSnapshot } from './storage.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SyncJob {
  id: string;
  status: JobStatus;
  branches: string[];
  progress: { step: string; percent: number };
  result?: {
    branchesProcessed: number;
    snapshots: { branchId: string; clientesAtivos: number; inadimplentes: number; checkinsPeriodo: number | null }[];
    errors: string[];
  };
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const jobs = new Map<string, SyncJob>();
let running = false;
const queue: string[] = [];

export function getJob(id: string): SyncJob | undefined { return jobs.get(id); }

export function listRecentJobs(limit = 20): SyncJob[] {
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, limit);
}

export function lastSuccessfulJob(): SyncJob | undefined {
  return [...jobs.values()]
    .filter(j => j.status === 'done')
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
}

export function enqueueSync(branches?: string[]): SyncJob {
  const job: SyncJob = {
    id: nanoid(10),
    status: 'pending',
    branches: branches?.length ? branches : config.evo.branchIds.slice(),
    progress: { step: 'fila', percent: 0 },
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  setImmediate(processQueue);
  logger.info({ jobId: job.id, branches: job.branches }, 'job enqueued');
  return job;
}

async function processQueue(): Promise<void> {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return;
  running = true;

  try {
    job.status = 'running';
    job.progress = { step: 'autenticando', percent: 5 };
    const { context, page } = await ensureAuthenticated();
    const client = await createEvoClient(page);

    const snapshots: NonNullable<SyncJob['result']>['snapshots'] = [];
    const errors: string[] = [];
    let i = 0;
    for (const branchId of job.branches) {
      i++;
      job.progress = {
        step: `[${i}/${job.branches.length}] extraindo filial ${branchId}`,
        percent: 5 + Math.round((i / job.branches.length) * 85),
      };
      try {
        // NOTA: o evoClient está autenticado na filial do login (config padrão = 59).
        // Multi-filial exigiria trocar de filial server-side antes de cada extração.
        const snap = await extractGerencial(client);
        await saveSnapshot(branchId, snap);
        snapshots.push({
          branchId,
          clientesAtivos: snap.clientesAtivos,
          inadimplentes: snap.inadimplentes,
          checkinsPeriodo: snap.checkinsPeriodo,
        });
        if (snap.erros.length) errors.push(...snap.erros.map(e => `branch ${branchId}: ${e}`));
      } catch (err) {
        const msg = `branch ${branchId}: ${(err as Error).message}`;
        logger.error({ branchId, err: msg }, 'branch extraction failed');
        errors.push(msg);
        if (/login|unauthorized|401|auth/i.test(msg)) await invalidateSession();
      }
    }

    job.result = { branchesProcessed: snapshots.length, snapshots, errors };
    job.status = snapshots.length === 0 ? 'failed' : 'done';
    job.progress = { step: 'concluído', percent: 100 };
    job.finishedAt = new Date().toISOString();
    await context.close();
  } catch (err) {
    job.status = 'failed';
    job.error = (err as Error).message;
    job.finishedAt = new Date().toISOString();
    logger.error({ jobId: id, err: job.error }, 'job failed at top level');
  } finally {
    running = false;
    if (queue.length > 0) setImmediate(processQueue);
    else closeBrowser().catch(() => {});
  }
}

/** Cron interno: agenda sync periódico se config.cronIntervalMs > 0. */
export function startCronIfEnabled(): void {
  if (config.cronIntervalMs <= 0) {
    logger.info('cron disabled (CRON_INTERVAL_MS=0)');
    return;
  }
  logger.info({ intervalMs: config.cronIntervalMs }, 'cron enabled — first run in 30s');
  setTimeout(() => {
    enqueueSync();
    setInterval(() => enqueueSync(), config.cronIntervalMs);
  }, 30_000);
}
