// Persistência de snapshots. No Gaviões NÃO há NocoDB, então o padrão é gravar
// em arquivo local (data/) e servir pela API HTTP. Se NOCODB_BASE estiver setado,
// também empurra pro NocoDB (compat com o setup BlueFit).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import type { GerencialSnapshot } from './extractors/gerencial.js';

const DATA_DIR = './data';

export interface StoredSnapshot extends GerencialSnapshot {
  branchId: string;
  capturadoEm: string;
}

function latestPath() { return join(DATA_DIR, 'snapshot-latest.json'); }
function branchPath(branchId: string) { return join(DATA_DIR, `snapshot-${branchId}.json`); }

/** Grava o snapshot em arquivo local (sempre) e no NocoDB (se habilitado). */
export async function saveSnapshot(branchId: string, snap: GerencialSnapshot): Promise<StoredSnapshot> {
  await mkdir(DATA_DIR, { recursive: true });
  const stored: StoredSnapshot = { branchId, capturadoEm: new Date().toISOString(), ...snap };
  const json = JSON.stringify(stored, null, 2);
  await writeFile(branchPath(branchId), json);
  await writeFile(latestPath(), json);
  logger.info({ branchId, ativos: snap.clientesAtivos }, 'snapshot salvo em arquivo local');

  if (config.nocodb.enabled) {
    await pushNocoDB(stored).catch((e) => logger.error({ err: (e as Error).message }, 'NocoDB push falhou (ignorado)'));
  }
  return stored;
}

/** Lê o último snapshot salvo (qualquer filial) — pro endpoint GET /data do dashboard. */
export async function getLatestSnapshot(): Promise<StoredSnapshot | null> {
  try { return JSON.parse(await readFile(latestPath(), 'utf8')) as StoredSnapshot; }
  catch { return null; }
}

/** Lê o snapshot de uma filial específica. */
export async function getBranchSnapshot(branchId: string): Promise<StoredSnapshot | null> {
  try { return JSON.parse(await readFile(branchPath(branchId), 'utf8')) as StoredSnapshot; }
  catch { return null; }
}

async function pushNocoDB(snap: StoredSnapshot): Promise<void> {
  const url = `${config.nocodb.base}/api/v2/tables/${config.nocodb.tableEvoSnapshot}/records`;
  const body = {
    branch_name: `Filial ${snap.branchId}`,
    active_members: snap.clientesAtivos,
    inactive_members: snap.inadimplentes,
    today_entries: snap.checkinsPeriodo ?? 0,
    snapshot_date: new Date().toISOString().split('T')[0],
    raw_json: JSON.stringify(snap),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xc-token': config.nocodb.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NocoDB ${res.status}: ${(await res.text()).slice(0, 200)}`);
  logger.info({ branchId: snap.branchId }, 'snapshot empurrado pro NocoDB');
}
