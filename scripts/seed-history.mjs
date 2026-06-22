// scripts/seed-history.mjs
// ──────────────────────────────────────────────────────────────────────────
// Script Node pra popular gb_evo_history no NocoDB com os últimos 12 meses
// fechados de cada unidade. Lê tokens do .env.
//
// Uso:
//   node scripts/seed-history.mjs
//
// Variáveis lidas do .env:
//   VITE_NOCODB_TOKEN
//   VITE_EVO_TOKEN_<UNIT_KEY>
//
// Hard-coded (sincronize com src/services/nocodbApi.ts):
//   NOCODB_TABLE_ID = 'm8977z0p0caclq6'
//
// Hard-coded (sincronize com src/services/evoApi.ts UNITS):
const UNITS = [
  { name: 'Altino Arantes',    idBranch: 1, envKey: 'VITE_EVO_TOKEN_ALTINO_ARANTES' },
  { name: 'Saúde',             idBranch: 2, envKey: 'VITE_EVO_TOKEN_SAUDE' },
  { name: 'Parque das Nações', idBranch: 3, envKey: 'VITE_EVO_TOKEN_PARQUE_NACOES' },
  { name: 'Alto do Ipiranga',  idBranch: 4, envKey: 'VITE_EVO_TOKEN_ALTO_IPIRANGA' },
  { name: 'Jardins',           idBranch: 5, envKey: 'VITE_EVO_TOKEN_JARDINS' },
  { name: 'Belenzinho',        idBranch: 6, envKey: 'VITE_EVO_TOKEN_BELENZINHO' },
  { name: 'Campestre',         idBranch: 7, envKey: 'VITE_EVO_TOKEN_CAMPESTRE' },
];

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as XLSX from 'xlsx';
const xlsxRead = XLSX.read;
const xlsxUtils = XLSX.utils;

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
const NOCODB_TABLE = 'm8977z0p0caclq6';
const DNS = 'gavioes';
const EVO_BASE_INTEGRACAO = 'https://evo-integracao.w12app.com.br';
const EVO_BASE_API = 'https://evo-integracao-api.w12app.com.br';

if (!NOCODB_TOKEN) {
  console.error('❌ VITE_NOCODB_TOKEN ausente em .env');
  process.exit(1);
}

// ─── helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function lastDayOfMonthISO(y, m /* 0-indexed */) {
  const d = new Date(y, m + 1, 0).getDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function firstDayOfMonthISO(y, m) {
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function authHeader(token) {
  return 'Basic ' + Buffer.from(`${DNS}:${token}`).toString('base64');
}

// Parser tolerante de moeda: aceita 199, "199", "199,90", "1.234,56",
// "R$ 199,90", null/undefined → 0. Number() puro falha em formato BR.
function parseMoney(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v === null || v === undefined) return 0;
  let s = String(v).replace(/[^\d,.-]/g, '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    // 1.234,56 (BR) ou 1,234.56 (US): qual separador é o decimal?
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// ─── EVO: members/summary-excel ─────────────────────────────────────────
async function fetchBreakdown(token, effectiveDate) {
  const url = `${EVO_BASE_INTEGRACAO}/api/v1/members/summary-excel?effectiveDate=${effectiveDate}`;
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) throw new Error(`summary-excel ${res.status} (effectiveDate=${effectiveDate})`);
  const buffer = await res.arrayBuffer();
  const wb = xlsxRead(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsxUtils.sheet_to_json(ws);
  if (rows.length === 0) {
    return { ativos: 0, adimplentes: 0, inadimplentes: 0, vips: 0, faturamentoAdimplentes: 0, members: [] };
  }
  const trim = (k) => k.trim();
  const sample = rows[0];
  const allKeys = Object.keys(sample).map(trim);
  const find = (...candidates) => {
    for (const c of candidates) {
      const f = allKeys.find(k => k.toLowerCase() === c.toLowerCase());
      if (f) return f;
    }
    return null;
  };
  const statusKey = find('StatusContrato', 'Status Contrato', 'Status do Contrato', 'Status');
  const vipKey    = find('ContratoVip', 'Contrato Vip', 'VIP', 'Vip');
  const valorKey  = find('ValorContrato', 'Valor Contrato', 'Valor');
  // IdCliente é o ID estável da pessoa (pra cruzar entre meses).
  // IdMember/IdMembership pode mudar com renovação.
  const idKey     = find('IdCliente', 'idCliente', 'Id Cliente', 'IdMember', 'idMember', 'Id', 'ID');
  if (!statusKey || !vipKey) {
    throw new Error(`columns: status=${statusKey}, vip=${vipKey} (effectiveDate=${effectiveDate})`);
  }
  let adimplentes = 0, inadimplentes = 0, vips = 0;
  let faturamentoAdimplentes = 0;
  const members = []; // { id, valor } pra non-VIP — usado pra diff de matrículas novas
  for (const r of rows) {
    const cleaned = {};
    for (const k in r) cleaned[k.trim()] = r[k];
    const vip = String(cleaned[vipKey] ?? '').trim().toLowerCase();
    const isVip = vip === 'sim' || vip === 'yes' || vip === 's';
    if (isVip) { vips++; continue; }
    const status = String(cleaned[statusKey] ?? '').trim().toLowerCase();
    const valor = valorKey ? parseMoney(cleaned[valorKey]) : 0;
    const idRaw = idKey ? cleaned[idKey] : undefined;
    const id = typeof idRaw === 'number' ? idRaw : parseInt(String(idRaw ?? ''), 10);
    if (status === 'ativo') {
      adimplentes++;
      faturamentoAdimplentes += valor;
    } else if (status === 'inadimplente') {
      inadimplentes++;
    }
    // Inclui no diff TODOS os non-VIP com id válido (ativos + inadimplentes)
    if (Number.isFinite(id)) {
      members.push({ id, valor });
    }
  }
  return {
    ativos: adimplentes + inadimplentes,
    adimplentes,
    inadimplentes,
    vips,
    faturamentoAdimplentes,
    members,
  };
}

// ─── EVO: /sales paginado ────────────────────────────────────────────────
async function fetchVendasRange(token, idBranch, start, end) {
  const take = 50;
  let skip = 0;
  const all = [];
  let complete = true;
  while (true) {
    const path = `/api/v2/sales?dateSaleStart=${start}&dateSaleEnd=${end}`
      + `&showReceivables=false&take=${take}&skip=${skip}`
      + `&onlyMembership=false&atLeastMonthly=false`
      + `&showOnlyActiveMemberships=true&onlyTotalPass=false`;
    const url = `${EVO_BASE_API}${path}`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: authHeader(token), 'Content-Type': 'application/json' } });
    } catch (e) {
      complete = false;
      console.error(`  ⚠ sales fetch erro skip=${skip}:`, e.message);
      break;
    }
    if (res.status === 429) {
      // backoff e retry mesmo skip
      await sleep(3000);
      continue;
    }
    if (!res.ok) {
      complete = false;
      console.error(`  ⚠ sales ${res.status} skip=${skip}, parando paginação`);
      break;
    }
    const data = await res.json();
    const page = Array.isArray(data) ? data : [];
    all.push(...page);
    if (page.length < take) break;
    skip += take;
    if (skip >= 5000) {
      complete = false;
      break;
    }
    await sleep(150); // gentle pause
  }
  let qtd = 0;
  let valor = 0;
  for (const s of all) {
    if (s.removed) continue;
    const items = s.saleItens ?? [];
    // Matrícula nova = item de membership nova (idMembership!=null e idMembershipRenewed==null).
    // Inclui enrollment, re-enrollment e contrato sem kind; exclui renovação/anuidade/multa/produto.
    // Mesma regra de fetchVendasInRange em src/services/evoApi.ts.
    const isNewMembership = items.some(it =>
      it.idMembership != null && it.idMembershipRenewed == null && (Number(it.saleValue) || 0) > 0
    );
    if (!isNewMembership) continue;
    const total = items.reduce((acc, it) => acc + (Number(it.saleValue) || 0), 0);
    if (total <= 0) continue;
    qtd++;
    valor += total;
  }
  return { qtd, valor, complete, _total: all.length };
}

// ─── NocoDB com retry/backoff (essencial: free tier tem rate limit baixo) ─
async function nocoRequest(method, url, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'xc-token': NOCODB_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 || res.status === 503) {
      // backoff exponencial: 1s, 2s, 4s, 8s, 16s, 32s
      const wait = 1000 * Math.pow(2, attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`NocoDB ${method} ${res.status}: ${txt}`);
    }
    return res.status === 200 ? res.json() : null;
  }
  throw new Error(`NocoDB ${method} esgotou retries (rate limit persistente)`);
}
async function nocoFetch(branchName, snapshotMonth) {
  const where = `(branch_name,eq,${encodeURIComponent(branchName)})~and(snapshot_month,eq,${encodeURIComponent(snapshotMonth)})~and(period_kind,eq,monthly)`;
  const data = await nocoRequest('GET', `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records?where=${where}&limit=1`);
  return data?.list?.[0] ?? null;
}
async function nocoCreate(payload) {
  await nocoRequest('POST', `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records`, payload);
}
async function nocoUpdate(id, payload) {
  await nocoRequest('PATCH', `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records`, { Id: id, ...payload });
}

// ─── main loop ────────────────────────────────────────────────────────────
//
// Janela: ANO CALENDARIO PASSADO COMPLETO (Janeiro a Dezembro do ano anterior).
// Permite comparativo "Mes do ano atual vs mesmo mes do ano passado".
const today = new Date();
const plan = [];
const previousFullYear = today.getFullYear() - 1;
for (let m = 0; m < 12; m++) {
  const d = new Date(previousFullYear, m, 1);
  for (const u of UNITS) {
    plan.push({ unit: u, monthDate: d });
  }
}

// Agrupa por mes -> ondas com ate 7 unidades em paralelo (cada uma usa
// token proprio, sem competir por rate limit). Acelera ~7x vs sequencial.
const months = [...new Set(plan.map(p => monthKey(p.monthDate)))].sort();
console.log(`▶ Seed plan: ${plan.length} snapshots em ${months.length} meses (parallel ×${UNITS.length})\n`);

let ok = 0;
let errs = 0;
const errors = [];

// Cache em memória por unidade pra reusar snapshot entre meses consecutivos
// (evita 2x fetch do summary-excel — só puxa o "anterior" se não tem em cache).
const snapshotCache = {}; // { unitName: { month, members: [{id, valor}] } }

async function processOne(unit, monthDate) {
  const token = env[unit.envKey];
  if (!token) return { unit: unit.name, month: monthKey(monthDate), ok: false, error: 'token ausente' };
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const month = monthKey(monthDate);
  const effectiveDate = lastDayOfMonthISO(y, m);
  // Mês anterior (ex: hoje processando 2025-05, prevMonth = 2025-04)
  const prevD = new Date(y, m - 1, 1);
  const prevMonth = monthKey(prevD);
  const prevEffectiveDate = lastDayOfMonthISO(prevD.getFullYear(), prevD.getMonth());
  try {
    const breakdown = await fetchBreakdown(token, effectiveDate);

    // Snapshot do mês anterior — do cache se já temos, senão busca.
    let prevMembers = null;
    if (snapshotCache[unit.name]?.month === prevMonth) {
      prevMembers = snapshotCache[unit.name].members;
    } else {
      try {
        const prev = await fetchBreakdown(token, prevEffectiveDate);
        prevMembers = prev.members;
      } catch {
        prevMembers = null; // primeiro mês ou EVO 500 — sem comparativo
      }
    }
    // Guarda o atual no cache pra próximo mês reusar
    snapshotCache[unit.name] = { month, members: breakdown.members };

    // ─── Diff de IDs = matrículas novas reais ─────────────────────────────
    // Member presente no mês atual mas ausente no anterior = entrou no mês.
    // Soma ValorContrato dessas → vendas_valor; quantidade → vendas_qtd.
    let vendasQtd = 0;
    let vendasValor = 0;
    if (prevMembers) {
      const prevIds = new Set(prevMembers.map(mm => mm.id));
      for (const mm of breakdown.members) {
        if (!prevIds.has(mm.id)) {
          vendasQtd++;
          vendasValor += mm.valor;
        }
      }
    }
    // Pra MES CORRENTE (caso seed rodando antes do mês fechar), o EVO retorna
    // enrollment via /sales — fallback usa esse caminho. Pra meses passados
    // (uso primário deste seed), o diff é a fonte da verdade.
    const isCurrentOrFutureMonth = (() => {
      const today = new Date();
      return y === today.getFullYear() && m >= today.getMonth();
    })();
    if (isCurrentOrFutureMonth || (vendasQtd === 0 && !prevMembers)) {
      // fallback /sales (mantém comportamento legado pra mês corrente)
      const vendasFallback = await fetchVendasRange(token, unit.idBranch, firstDayOfMonthISO(y, m), effectiveDate)
        .catch(() => ({ qtd: 0, valor: 0, complete: false }));
      if (vendasFallback.qtd > vendasQtd) {
        vendasQtd = vendasFallback.qtd;
        vendasValor = vendasFallback.valor;
      }
    }

    const payload = {
      branch_name: unit.name,
      snapshot_month: month,
      period_kind: 'monthly',
      active_members: breakdown.ativos,
      adimplentes: breakdown.adimplentes,
      inadimplentes: breakdown.inadimplentes,
      faturamento_adimplentes: breakdown.faturamentoAdimplentes,
      vendas_qtd: vendasQtd,
      vendas_valor: vendasValor,
      source: prevMembers ? 'evo_excel_diff' : 'evo_excel',
      fetched_at: new Date().toISOString(),
    };
    const existing = await nocoFetch(unit.name, month);
    if (existing?.Id) await nocoUpdate(existing.Id, payload);
    else await nocoCreate(payload);
    return { unit: unit.name, month, ok: true, vendasQtd, vendasValor };
  } catch (e) {
    return { unit: unit.name, month, ok: false, error: e.message };
  }
}

// Concurrency limiter manual: max 3 unidades por vez (NocoDB rate limit
// bloqueia se passa muito). 7 paralelos mostrou 429 em massa.
const CONCURRENT = 3;

async function processWaveLimited(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENT) {
    const batch = items.slice(i, i + CONCURRENT);
    const r = await Promise.allSettled(batch.map(fn));
    results.push(...r);
    if (i + CONCURRENT < items.length) await sleep(500);
  }
  return results;
}

let waveIdx = 0;
for (const month of months) {
  waveIdx++;
  const wave = plan.filter(p => monthKey(p.monthDate) === month);
  process.stdout.write(`[Onda ${String(waveIdx).padStart(2, '0')}/${months.length}] ${month} (×${wave.length}) `);
  const t0 = Date.now();
  const results = await processWaveLimited(wave, p => processOne(p.unit, p.monthDate));
  let okWave = 0, errWave = 0;
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : { ok: false, unit: '?', month, error: String(r.reason) };
    if (v.ok) { ok++; okWave++; }
    else { errs++; errWave++; errors.push({ unit: v.unit, month: v.month, error: v.error }); }
  }
  console.log(`✓${okWave} ✗${errWave} (${Math.round((Date.now() - t0) / 1000)}s)`);
  await sleep(1500); // respiro maior entre ondas pra NocoDB
}

console.log(`\n──────────────────────────────────────`);
console.log(`✓ ok:  ${ok}`);
console.log(`✗ err: ${errs}`);
if (errors.length) {
  console.log(`\nErrors:`);
  for (const e of errors) console.log(`  - ${e.unit} ${e.month}: ${e.error}`);
}
console.log(`──────────────────────────────────────`);
