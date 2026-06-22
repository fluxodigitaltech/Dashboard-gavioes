// scripts/seed-receivables.mjs
// ──────────────────────────────────────────────────────────────────────────
// Puxa receivables (cobros) do EVO mes a mes pra cada unidade dos ultimos
// 12 meses e popula a tabela gb_evo_receivables_history no NocoDB.
//
// Endpoint: GET /evo-integracao/api/v1/receivables/summary-excel
//   ?dtLancamentoDe=YYYY-MM-DD
//   &dtLancamentoAte=YYYY-MM-DD
//
// Uso:
//   node scripts/seed-receivables.mjs
//
// Idempotente — upsert por (branch_name, snapshot_month). Pode rodar de novo
// pra retentar erros sem duplicar.
//
// Hard-coded (sincronize com src/services/nocodbApi.ts):
const NOCODB_TABLE = 'mir3sp6fbi6si5v';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as XLSX from 'xlsx';
const xlsxRead = XLSX.read;
const xlsxUtils = XLSX.utils;

// Lista de unidades — espelha src/services/evoApi.ts UNITS
const UNITS = [
  { name: 'Altino Arantes',    envKey: 'VITE_EVO_TOKEN_ALTINO_ARANTES' },
  { name: 'Saúde',             envKey: 'VITE_EVO_TOKEN_SAUDE' },
  { name: 'Parque das Nações', envKey: 'VITE_EVO_TOKEN_PARQUE_NACOES' },
  { name: 'Alto do Ipiranga',  envKey: 'VITE_EVO_TOKEN_ALTO_IPIRANGA' },
  { name: 'Jardins',           envKey: 'VITE_EVO_TOKEN_JARDINS' },
  { name: 'Belenzinho',        envKey: 'VITE_EVO_TOKEN_BELENZINHO' },
  { name: 'Campestre',         envKey: 'VITE_EVO_TOKEN_CAMPESTRE' },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── .env loader ──────────────────────────────────────────────────────────
const env = {};
try {
  const txt = readFileSync(resolve(ROOT, '.env'), 'utf-8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch (e) {
  console.error('❌ Não achei .env em', ROOT);
  process.exit(1);
}

const NOCODB_TOKEN = env.VITE_NOCODB_TOKEN;
const NOCODB_BASE = 'https://app.nocodb.com/api/v2';
const DNS = 'gavioes';
const EVO_BASE = 'https://evo-integracao.w12app.com.br';

if (!NOCODB_TOKEN) {
  console.error('❌ VITE_NOCODB_TOKEN ausente em .env');
  process.exit(1);
}

// ─── helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function lastDayOfMonth(y, m /* 0-indexed */) {
  return new Date(y, m + 1, 0).getDate();
}
function firstDayOfMonthISO(y, m) {
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function lastDayOfMonthISO(y, m) {
  const d = lastDayOfMonth(y, m);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function authHeader(token) {
  return 'Basic ' + Buffer.from(`${DNS}:${token}`).toString('base64');
}

// ─── EVO: receivables/summary-excel ────────────────────────────────────
//
// Replica a lógica de parsing de fetchReceivables() em evoApi.ts.
// Retorna agregados (totais + breakdown por tipo).

function findKey(sample, candidates) {
  if (!sample) return null;
  const keys = Object.keys(sample).map(k => k.trim());
  for (const c of candidates) {
    const f = keys.find(k => k.toLowerCase() === c.toLowerCase());
    if (f) return f;
  }
  for (const c of candidates) {
    const f = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (f) return f;
  }
  return null;
}

function parseMoney(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  let s = String(v).replace(/[^\d,.-]/g, '').trim();
  if (s.includes(',') && s.includes('.')) {
    // ex: 1.234,56 (BR) ou 1,234.56 (US)
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

async function fetchReceivablesForMonth(token, dtFrom, dtTo) {
  const url = `${EVO_BASE}/api/v1/receivables/summary-excel`
    + `?dtLancamentoDe=${dtFrom}&dtLancamentoAte=${dtTo}`;
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) throw new Error(`receivables ${res.status} (${dtFrom}→${dtTo})`);
  const buffer = await res.arrayBuffer();
  const wb = xlsxRead(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = xlsxUtils.sheet_to_json(ws);
  // Trim column names (Excel often has trailing spaces)
  const rows = rawRows.map(r => {
    const c = {};
    for (const k in r) c[k.trim()] = r[k];
    return c;
  });
  if (rows.length === 0) {
    return { rows: 0, totalAmount: 0, totalReceived: 0, totalPending: 0, totalOverdue: 0, multaCancelamento: 0, manutencaoAnual: 0, avulso: 0 };
  }
  const sample = rows[0];
  const amountKey = findKey(sample, ['Valor', 'ValorTotal', 'Valor Total', 'Total']);
  const statusKey = findKey(sample, ['Status', 'StatusCobranca', 'Situação', 'Situacao']);
  const tipoKey   = findKey(sample, ['TipoCobranca', 'Tipo', 'Tipo de Cobrança', 'TipoCobrança']);
  const descKey   = findKey(sample, ['Descricao', 'Descrição', 'Description']);

  let totalAmount = 0;
  let totalReceived = 0;
  let totalPending = 0;
  let totalOverdue = 0;
  let multaCancelamento = 0;
  let manutencaoAnual = 0;
  let avulso = 0;

  for (const row of rows) {
    const amount = amountKey ? parseMoney(row[amountKey]) : 0;
    totalAmount += amount;
    const status = String(row[statusKey] ?? '').trim().toLowerCase();
    const tipo   = tipoKey ? String(row[tipoKey] ?? '').trim().toLowerCase() : '';
    const desc   = descKey ? String(row[descKey] ?? '').trim().toLowerCase() : '';

    if (/multa.*cancel|cancel.*multa|multa de cancel/.test(tipo)) multaCancelamento += amount;
    if (/avulso/.test(tipo))                                       avulso += amount;
    if (/manuten.*anual/.test(desc))                               manutencaoAnual += amount;

    const isPago     = /pag|receb|liquid|paid|quitad/.test(status);
    const isAtrasado = /atras|vencid|overdue|inadim/.test(status);
    if (isPago) totalReceived += amount;
    else if (isAtrasado) totalOverdue += amount;
    else totalPending += amount;
  }

  return {
    rows: rows.length,
    totalAmount,
    totalReceived,
    totalPending,
    totalOverdue,
    multaCancelamento,
    manutencaoAnual,
    avulso,
  };
}

// ─── NocoDB upsert ───────────────────────────────────────────────────────
async function nocoFetch(branchName, snapshotMonth) {
  const where = `(branch_name,eq,${encodeURIComponent(branchName)})~and(snapshot_month,eq,${encodeURIComponent(snapshotMonth)})`;
  const url = `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records?where=${where}&limit=1`;
  const res = await fetch(url, { headers: { 'xc-token': NOCODB_TOKEN } });
  if (!res.ok) throw new Error(`NocoDB GET ${res.status}`);
  const data = await res.json();
  return data.list?.[0] ?? null;
}
async function nocoCreate(payload) {
  const url = `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`NocoDB POST ${res.status}: ${txt}`);
  }
}
async function nocoUpdate(id, payload) {
  const url = `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: id, ...payload }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`NocoDB PATCH ${res.status}: ${txt}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────
//
// Janela: ANO CALENDARIO PASSADO COMPLETO (Janeiro a Dezembro do ano anterior).
// Permite comparativo "Mes do ano atual vs mesmo mes do ano passado".
//
// Exemplo (hoje = Maio/2026): puxa Jan/2025, Fev/2025, ..., Dez/2025 (12 meses).
// Os meses fechados do ano atual (Jan/2026 .. mes_passado/2026) NAO sao
// puxados aqui — eles vem do mes-a-mes via app + cron mensal (ultimo dia
// do mes salva no NocoDB).
const today = new Date();
const plan = [];
const previousFullYear = today.getFullYear() - 1;
for (let m = 0; m < 12; m++) {
  const d = new Date(previousFullYear, m, 1);
  for (const u of UNITS) {
    plan.push({ unit: u, monthDate: d });
  }
}

const monthsCount = plan.length / UNITS.length;
console.log(`▶ Seed receivables plan: ${plan.length} snapshots (${UNITS.length} unidades × ${monthsCount} meses)\n`);

let ok = 0;
let errs = 0;
const errors = [];

for (let i = 0; i < plan.length; i++) {
  const { unit, monthDate } = plan[i];
  const token = env[unit.envKey];
  if (!token) {
    console.warn(`⚠ ${unit.name}: token ausente, pulando`);
    errs++;
    continue;
  }
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const month = monthKey(monthDate);
  const dtFrom = firstDayOfMonthISO(y, m);
  const dtTo = lastDayOfMonthISO(y, m);
  const prefix = `[${String(i + 1).padStart(2, '0')}/${plan.length}] ${unit.name} · ${month}`;
  process.stdout.write(`${prefix} ... `);
  try {
    const stats = await fetchReceivablesForMonth(token, dtFrom, dtTo);
    const payload = {
      branch_name: unit.name,
      snapshot_month: month,
      total_amount: stats.totalAmount,
      total_received: stats.totalReceived,
      total_pending: stats.totalPending,
      total_overdue: stats.totalOverdue,
      multa_cancelamento: stats.multaCancelamento,
      manutencao_anual: stats.manutencaoAnual,
      avulso: stats.avulso,
      rows_count: stats.rows,
      source: 'evo_excel',
      fetched_at: new Date().toISOString(),
    };
    const existing = await nocoFetch(unit.name, month);
    if (existing?.Id) {
      await nocoUpdate(existing.Id, payload);
    } else {
      await nocoCreate(payload);
    }
    ok++;
    console.log(`✓ R$ ${stats.totalAmount.toFixed(0)} · ${stats.rows} linhas · pago R$ ${stats.totalReceived.toFixed(0)}`);
  } catch (e) {
    errs++;
    errors.push({ unit: unit.name, month, error: e.message });
    console.log(`✗ ${e.message}`);
  }
  await sleep(300);
}

console.log(`\n──────────────────────────────────────`);
console.log(`✓ ok:  ${ok}`);
console.log(`✗ err: ${errs}`);
if (errors.length) {
  console.log(`\nErrors:`);
  for (const e of errors) console.log(`  - ${e.unit} ${e.month}: ${e.error}`);
}
console.log(`──────────────────────────────────────`);
