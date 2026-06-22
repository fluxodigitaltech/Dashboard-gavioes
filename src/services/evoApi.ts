// W12 EVO API Integration Service
// Swagger: https://evo-integracao.w12app.com.br/swagger/index.html
// Base URL proxied via Vite: /evo-api → https://evo-integracao-api.w12app.com.br

// xlsx é pesado (~150KB). Import dinâmico aqui pra cair no mesmo chunk
// dos modais (HistoricalSeed, VendasMes) que também o usam — Vite consolida.
import { fetchEvoHistorySnapshot } from './nocodbApi';
import { localYMD } from '../lib/date';

const DNS = "gavioes";
const EVO_BASE = "/evo-api";

// ─── Unit Config ──────────────────────────────────────────────────────────────

export interface UnitConfig {
  idBranch: number;
  token: string;
  location: string;
}

// Tokens read from build-time env vars (Vite VITE_* prefix is required to expose to client).
// SECURITY NOTE: VITE_* values are bundled into the public JS — anyone loading the dashboard
// can extract them via DevTools. This is a stopgap until the Vercel/Cloudflare Functions backend
// proxy is implemented (see docs/SECURITY.md). Tokens MUST be rotated after public exposure.
// REBRAND Gaviões: as unidades do cliente anterior foram REMOVIDAS. Preencha
// abaixo as UNIDADES reais da Academia Gaviões 24h (nome, idBranch da EVO,
// variável de token correspondente no .env e localização). O `DNS` acima
// também precisa ser o slug do tenant da Gaviões na W12/EVO.
export const UNITS: Record<string, UnitConfig> = {
  "Unidade 1": { idBranch: 1, token: import.meta.env.VITE_EVO_TOKEN_UNIDADE_1, location: "" },
  "Unidade 2": { idBranch: 2, token: import.meta.env.VITE_EVO_TOKEN_UNIDADE_2, location: "" },
  "Unidade 3": { idBranch: 3, token: import.meta.env.VITE_EVO_TOKEN_UNIDADE_3, location: "" },
};

// ─── Status ───────────────────────────────────────────────────────────────────

// Official documented membershipStatus values (string param on /api/v1/members)
// These reflect the CONTRACT status — not the member account status.
// "active"    → has a currently paid/active contract
// "inactive"  → contract lapsed / paused (relevant churn, reactivation targets)
// "cancelled" → formally cancelled
// ─── Request Queue (Anti-429) ────────────────────────────────────────────────

class EvoQueue {
  private queue: (() => Promise<unknown>)[] = [];
  private running = false;
  private lastRequestTime = 0;
  private minDelay = 700; // ms entre requests (EVO 429s a partir de ~3 req/s sustentado)

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.minDelay - (now - this.lastRequestTime));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      const fn = this.queue.shift();
      if (fn) {
        await fn();
        this.lastRequestTime = Date.now();
      }
    }

    this.running = false;
  }
}

const evoQueue = new EvoQueue();

// ─── Auth & HTTP ──────────────────────────────────────────────────────────────

function getAuth(token: string): string {
  return btoa(`${DNS}:${token}`);
}

// Simple in-memory cache (com cap LRU-ish: SPA de longa duração + chaves únicas
// por página de paginação faziam o objeto crescer sem limite → leak de memória).
const memCache: Record<string, { data: unknown, timestamp: number }> = {};
const MEM_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const MEM_CACHE_MAX = 300;

function memCacheSet(key: string, data: unknown): void {
  const keys = Object.keys(memCache);
  if (keys.length >= MEM_CACHE_MAX) {
    // remove a entrada mais antiga (menor timestamp) — evita crescimento ilimitado
    let oldestKey = keys[0];
    for (const k of keys) if (memCache[k].timestamp < memCache[oldestKey].timestamp) oldestKey = k;
    delete memCache[oldestKey];
  }
  memCache[key] = { data, timestamp: Date.now() };
}

async function evoGet(path: string, token: string, retries = 8, backoff = 3000): Promise<unknown> {
  const cacheKey = `${token}:${path}`;
  if (memCache[cacheKey] && (Date.now() - memCache[cacheKey].timestamp < MEM_CACHE_TTL)) {
    return memCache[cacheKey].data;
  }

  return evoQueue.add(async () => {
    // Double check internal cache inside the queue in case multiple same requests were queued
    if (memCache[cacheKey] && (Date.now() - memCache[cacheKey].timestamp < MEM_CACHE_TTL)) {
      return memCache[cacheKey].data;
    }

    const res = await fetch(`${EVO_BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${getAuth(token)}`,
      },
    });

    // 429 retry with exponential backoff. 8 tentativas com cap em 60s = ~3+6+12+24+48+60+60+60 ≈ 4min total max.
    // Resiliente o suficiente pra sobreviver picos de rate-limit do EVO.
    if (res.status === 429 && retries > 0) {
      console.warn(`[EVO] 429 em ${path} — retry em ${(backoff / 1000).toFixed(1)}s (${retries} tentativas restantes)`);
      await sleep(backoff);
      return evoGet(path, token, retries - 1, Math.min(backoff * 2, 60_000));
    }

    if (!res.ok) throw new Error(`EVO API ${res.status}: ${path}`);

    const data = await res.json();
    memCacheSet(cacheKey, data);
    return data;
  });
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

/**
 * GET de um .xlsx (summary-excel) com retry em 429 E throttle pela evoQueue.
 * Antes os Excels iam direto via fetch (7 unidades em paralelo, sem fila) — o que
 * ajudava a sobrecarregar o EVO (429/500). Agora cada chamada entra na evoQueue
 * (700ms/req), igual aos GETs de vendas. O retry fica FORA do `add` (o sleep não
 * segura a fila e não deadlocka — cada tentativa é um novo item enfileirado).
 * Backoff exponencial: 2s, 4s, 8s… cap 30s, 5 tentativas.
 */
async function fetchExcelWithRetry(url: string, authHeader: string, retries = 5, backoff = 2000): Promise<Response> {
  const res = await evoQueue.add(() => fetch(url, { headers: { 'Authorization': authHeader } }));
  if (res.status === 429 && retries > 0) {
    console.warn(`[EVO] 429 (excel) em ${url} — retry em ${(backoff / 1000).toFixed(1)}s (${retries} restantes)`);
    await sleep(backoff);
    return fetchExcelWithRetry(url, authHeader, retries - 1, Math.min(backoff * 2, 30_000));
  }
  return res;
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

export function extractArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.members))     return o.members;
    if (Array.isArray(o.memberships)) return o.memberships;
    if (Array.isArray(o.data))        return o.data;
    if (Array.isArray(o.entries))     return o.entries;
    if (Array.isArray(o.result))      return o.result;
    if (Array.isArray(o.items))       return o.items;
    // Last resort: return the first array value found in the object
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Branch Stats (for Dashboard & Unidades) ──────────────────────────────────

export interface BranchStats {
  name: string;
  location: string;
  idBranch: number;
  activeMembers: number;            // total com contrato em vigor (Adimp + Inadimp, sem VIP)
  adimplentesMembers: number;       // StatusContrato = Ativo  AND  ContratoVip = Não
  inadimplentesMembers: number;     // StatusContrato = Inadimplente
  vipMembers: number;               // ContratoVip = Sim
  faturamentoAdimplentes: number;   // Soma da coluna ValorContrato dos adimplentes (MRR real)
  faturamentoInadimplentes: number; // Soma da coluna ValorContrato dos inadimplentes (receita em risco real)
  idsAdimplentes: number[];         // IDs dos membros adimplentes (pra cruzar com recebíveis)
  idsInadimplentes: number[];       // IDs dos membros inadimplentes
  vendasMesValor: number;           // Soma de saleItens dos enrollment do mês corrente
  vendasMesQtd: number;             // Qtde de matrículas novas (enrollment) no mês
  vendasMesComplete: boolean;       // false se a paginação de /sales quebrou — número é PARCIAL
  vendasMesList: VendaMin[];        // detalhe de cada matrícula nova (modal/export)

  // ─── Mês anterior (para comparativo) ────────────────────────────────────────
  activeMembersPrev: number;        // ativos há 30 dias (effectiveDate snapshot)
  adimplentesMembersPrev: number;
  inadimplentesMembersPrev: number;
  faturamentoAdimplentesPrev: number;   // soma ValorContrato adimplentes mês passado
  faturamentoInadimplentesPrev: number; // receita em risco mês passado
  vendasMesValorPrev: number;       // mês anterior completo
  vendasMesQtdPrev: number;
  vendasMesPrevComplete: boolean;   // mesma flag para o mês passado

  // ─── Snapshot anual (1 ano atrás) — pra crescimento direto financeiro ─────
  // Data fechada nunca muda → cache eterno. Fetch 1x e fica até cache key trocar (próximo dia).
  // has1yData = false se unidade não existia há 1 ano (alguns franqueados são novos).
  activeMembers1y: number;          // adimplentes + inadimplentes 1 ano atrás
  adimplentesMembers1y: number;
  vipMembers1y: number;             // VIPs/Cortesia 1 ano atrás
  faturamentoAdimplentes1y: number; // soma ValorContrato dos adimplentes 1 ano atrás
  faturamentoInadimplentes1y: number; // receita em risco 1 ano atrás
  has1yData: boolean;

  // ─── Vendas no MESMO MÊS DO ANO ANTERIOR (pra comparativo "vs ano anterior") ─
  // Mês fechado → cache 30 dias por (branch, monthKey1y). Fetch único de /sales
  // com offset=12 meses. has1yVendas=false se ainda não foi buscado ou unidade
  // não existia (resposta vazia).
  vendasMesValor1y: number;
  vendasMesQtd1y: number;
  vendasMes1yComplete: boolean;
  has1yVendas: boolean;

  // ─── Cancelamentos do MÊS CORRENTE (1º até hoje) ────────────────────────
  // Vem do endpoint /api/v3/membermembership?cancelDateStart=…&cancelDateEnd=…
  // showTransfers/Aggregators/Vips = false → só cancelamentos REAIS de membros pagantes.
  // Usado pra calcular evasão real (em vez do placeholder inad/ativos).
  // complete=false se a paginação quebrou ou bateu safety cap.
  cancelamentosMes: number;
  cancelamentosMesComplete: boolean;

  cancelledMembers: number;
  inactiveMembers: number;          // legacy alias = inadimplentesMembers (kept for compat)
  hasError: boolean;
  stale?: boolean;                  // true = dado de cache antigo, devolvido por instabilidade do EVO
  lastUpdate?: number;

  // ─── Faturamento via SCRAPER (Cobranças › Recorrência, "Data programada") ────
  // Só preenchidos no modo scraper (Gaviões). FATURAMENTO REAL = pago; ESTIMADO = total.
  faturamentoPagoMes?: number;      // card "Pago" (somatoria.totalPago)
  faturamentoTotalMes?: number;     // card "Total" (somatoria.total)
}

/** YYYY-MM-DD da data atual menos N dias. */
function dateMinusDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localYMD(d);
}

// ─── Sales (Vendas reais do mês) ──────────────────────────────────────────────

interface SaleItem {
  saleValue?: number;
  item?: string;
  idMembership?: number | null;        // contrato de membership (null = produto/serviço/multa)
  idMembershipRenewed?: number | null; // preenchido = renovação de membership existente
}
interface SaleMember {
  idMember?: number;
  firstName?: string;
  lastName?: string;
}
interface Sale {
  idSale: number;
  saleDate?: string;
  registrationKind?: string | null;  // 'enrollment' | 're-enrollment' | 'renewal' | null
  removed?: boolean;
  member?: SaleMember;
  saleItens?: SaleItem[];
}

/** Item resumido de venda — usado pelo modal de "Matrículas Novas" e exportação Excel. */
export interface VendaMin {
  idSale:    number;
  idBranch:  number;
  branchName?: string;
  idMember?: number;
  firstName: string;
  lastName:  string;
  saleDate:  string;  // YYYY-MM-DD
  plan:      string;  // item de maior valor
  total:     number;
}

/**
 * Wrapper compatível: calcula start/end do mês target (now − monthOffset) e
 * delega pra `fetchVendasInRange`. Mantido pra preservar callsites existentes.
 */
async function fetchVendasDoMes(
  token: string,
  idBranch: number,
  monthOffset = 0,
): Promise<{ valor: number; qtd: number; complete: boolean; list: VendaMin[] }> {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
  const y = target.getFullYear();
  const m = target.getMonth();
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return fetchVendasInRange(token, idBranch, start, end);
}

/**
 * Fetch real sales (matrículas novas) num intervalo arbitrário pra uma unidade.
 * Endpoint: GET /api/v2/sales — paginado.
 * Filtra: venda com item de membership NOVA (idMembership!=null e
 *   idMembershipRenewed==null), removed=false, total>0. Isso captura matrícula
 *   nova (enrollment), reentrada (re-enrollment) e contrato manual sem kind
 *   (ex.: checkout online pendente) — exatamente o relatório de Vendas do EVO —
 *   e exclui renovação/anuidade automática, multa de cancelamento e produtos.
 *
 * `start` e `end` em YYYY-MM-DD (inclusivo). Usado tanto pelo painel principal
 * (range mensal) quanto pelo filtro de data customizado da Visão Geral.
 */
export async function fetchVendasInRange(
  token: string,
  idBranch: number,
  start: string,
  end: string,
): Promise<{ valor: number; qtd: number; complete: boolean; list: VendaMin[] }> {
  const take = 50;
  let skip = 0;
  const all: Sale[] = [];
  let complete = true; // marca falso se quebrou no meio

  while (true) {
    const path = `/api/v2/sales?dateSaleStart=${start}&dateSaleEnd=${end}`
      + `&showReceivables=false&take=${take}&skip=${skip}`
      + `&onlyMembership=false&atLeastMonthly=false`
      + `&showOnlyActiveMemberships=true&onlyTotalPass=false`;

    try {
      const data = await evoGet(path, token) as Sale[] | unknown;
      const page = Array.isArray(data) ? data as Sale[] : [];
      all.push(...page);
      if (page.length < take) break;       // última página completa
      skip += take;
      if (skip >= 5000) {                   // safety cap → marca incompleto
        complete = false;
        console.error(`[EVO Vendas] safety cap atingido em skip=${skip}, dados podem estar incompletos`);
        break;
      }
    } catch (err) {
      // Falha no meio da paginação → marca explicitamente como incompleto
      complete = false;
      console.error(`[EVO Vendas] FALHA paginação skip=${skip}, ${all.length} registros parciais. Dados INCOMPLETOS:`, err);
      break;
    }
  }

  // Matrícula nova = venda com item de membership NOVA (idMembership preenchido e
  // idMembershipRenewed vazio). Inclui enrollment, re-enrollment e contrato manual
  // sem kind; exclui renovação/anuidade automática, multa e produto. Bate com o
  // relatório de Vendas do EVO. (antes: só registrationKind==='enrollment', que
  // deixava reentradas e contratos sem kind de fora)
  let qtd = 0;
  let valor = 0;
  const list: VendaMin[] = [];
  for (const s of all) {
    if (s.removed) continue;
    const items = s.saleItens ?? [];
    const isNewMembership = items.some(it =>
      it.idMembership != null && it.idMembershipRenewed == null && (Number(it.saleValue) || 0) > 0
    );
    if (!isNewMembership) continue;
    const total = items.reduce((acc, it) => acc + (Number(it.saleValue) || 0), 0);
    if (total <= 0) continue;
    qtd++;
    valor += total;

    // Plano principal = item de maior saleValue
    const planItem = items.reduce<SaleItem | null>(
      (best, it) => ((it.saleValue ?? 0) > (best?.saleValue ?? 0) ? it : best),
      null,
    );
    list.push({
      idSale:    s.idSale,
      idBranch,
      idMember:  s.member?.idMember,
      firstName: (s.member?.firstName ?? '').trim(),
      lastName:  (s.member?.lastName  ?? '').trim(),
      saleDate:  (s.saleDate ?? '').slice(0, 10),
      plan:      (planItem?.item ?? '').trim(),
      total,
    });
  }

  return { valor, qtd, complete, list };
}

/**
 * Cancelamentos de membership no MÊS CORRENTE (1º até hoje), por unidade.
 * Endpoint: GET /api/v3/membermembership — paginado.
 * Filtros fixos (decisão produto): showTransfers/Aggregators/Vips = false
 *   → conta só cancelamento REAL de membro pagante (transfers entre unidades,
 *     agregadores e VIPs/cortesia não são "evasão").
 * Retorna qtd absoluta de cancelamentos no mês. complete=false se paginação
 * quebrou no meio ou safety cap (5000) foi atingido — UI mostra ⚠ no card.
 */
async function fetchCancellationsMes(token: string): Promise<{ qtd: number; complete: boolean }> {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const start = `${year}-${month}-01`;
  const end = localYMD(today);
  const take = 25; // bate com exemplo do curl (W12 default)
  let skip = 0;
  let qtd = 0;
  let complete = true;
  while (true) {
    const path = `/api/v3/membermembership?cancelDateStart=${start}&cancelDateEnd=${end}`
      + `&showTransfers=false&showAggregators=false&showVips=false`
      + `&take=${take}&skip=${skip}`;
    try {
      const data = await evoGet(path, token);
      const page = extractArray(data);
      qtd += page.length;
      if (page.length < take) break;
      skip += take;
      if (skip >= 5000) {
        complete = false;
        console.warn(`[EVO Cancelamentos] safety cap em skip=${skip}, contagem pode estar incompleta`);
        break;
      }
    } catch (err) {
      complete = false;
      console.warn(`[EVO Cancelamentos] paginação falhou em skip=${skip}:`, err);
      break;
    }
  }
  return { qtd, complete };
}

/** Uma linha de cancelamento (evasão) com todos os campos úteis do /api/v3/membermembership. */
export interface CancelamentoRow {
  branchName: string;
  idBranch: number;
  idMember?: number;
  name?: string;
  memberDocument?: string;
  idMembership?: number;
  nameMembership?: string;
  saleValue?: number;
  saleDate?: string;
  membershipStart?: string;
  membershipEnd?: string;
  registerCancelDate?: string;
  cancelDate?: string;
  reasonCancellation?: string;
  cancellationFine?: number;
  remainingValue?: number;
  minPeriodStayMembership?: number;
  statusMemberMembership?: number;
}

export interface CancelamentosDetalhados {
  list: CancelamentoRow[];
  complete: boolean;       // false = alguma unidade falhou paginação (lista parcial)
  periodLabel: string;     // ex: "05/2026"
}

/**
 * Cancelamentos DETALHADOS do mês corrente (1º até hoje), com TODOS os campos,
 * por unidade — pra exportação/auditoria de evasão. Mesma fonte e filtros do
 * card de Evasão (showTransfers/Aggregators/Vips=false), mas mantém os registros
 * em vez de só contar. On-demand (sem cache) — chamado ao abrir o modal de export.
 */
export async function fetchCancelamentosDetalhados(unitNames?: string[]): Promise<CancelamentosDetalhados> {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const start = `${year}-${month}-01`;
  const end = localYMD(today);
  const periodLabel = `${month}/${year}`;
  const names = (unitNames && unitNames.length ? unitNames : Object.keys(UNITS)).filter(n => UNITS[n]);
  const take = 25;

  const settled = await Promise.allSettled(names.map(async (name) => {
    const cfg = UNITS[name];
    const rows: CancelamentoRow[] = [];
    let skip = 0;
    let complete = true;
    while (true) {
      const path = `/api/v3/membermembership?cancelDateStart=${start}&cancelDateEnd=${end}`
        + `&showTransfers=false&showAggregators=false&showVips=false&take=${take}&skip=${skip}`;
      let page: Array<Record<string, unknown>>;
      try {
        const data = await evoGet(path, cfg.token);
        page = extractArray(data) as Array<Record<string, unknown>>;
      } catch (err) {
        complete = false;
        console.warn(`[EVO Evasão] ${name} paginação falhou em skip=${skip}:`, err);
        break;
      }
      const slice = (v: unknown) => (v == null ? '' : String(v).slice(0, 10));
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      for (const r of page) {
        rows.push({
          branchName: name,
          idBranch: cfg.idBranch,
          idMember:                num(r.idMember),
          name:                    String(r.name ?? '').trim(),
          memberDocument:          r.memberDocument != null ? String(r.memberDocument) : undefined,
          idMembership:            num(r.idMembership),
          nameMembership:          String(r.nameMembership ?? '').trim(),
          saleValue:               num(r.saleValue),
          saleDate:                slice(r.saleDate),
          membershipStart:         slice(r.membershipStart),
          membershipEnd:           slice(r.membershipEnd),
          registerCancelDate:      slice(r.registerCancelDate),
          cancelDate:              slice(r.cancelDate),
          reasonCancellation:      String(r.reasonCancellation ?? '').trim(),
          cancellationFine:        num(r.cancellationFine),
          remainingValue:          num(r.remainingValue),
          minPeriodStayMembership: num(r.minPeriodStayMembership),
          statusMemberMembership:  num(r.statusMemberMembership),
        });
      }
      if (page.length < take) break;
      skip += take;
      if (skip >= 5000) { complete = false; console.warn(`[EVO Evasão] ${name}: safety cap em skip=${skip}`); break; }
    }
    return { rows, unitComplete: complete };
  }));

  const list: CancelamentoRow[] = [];
  let complete = true;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      list.push(...s.value.rows);
      if (!s.value.unitComplete) complete = false;
    } else {
      complete = false;
      console.error(`[EVO Evasão] ${names[i]} falhou:`, s.reason);
    }
  });
  // ordena por data de cancelamento desc (mais recentes primeiro)
  list.sort((a, b) => (b.cancelDate ?? '').localeCompare(a.cancelDate ?? ''));
  return { list, complete, periodLabel };
}

export interface InadimplenteRow {
  branchName: string;
  idBranch: number;
  idCliente?: number;
  name: string;
  phone: string;
  plano: string;
  valor: number;
}
export interface InadimplentesDetalhados {
  list: InadimplenteRow[];
  complete: boolean;   // false = alguma unidade falhou (lista parcial)
  periodLabel: string;
}

/**
 * Lista DETALHADA dos inadimplentes (nome, telefone, unidade, plano, valor em
 * risco), por unidade — pra o modal ao clicar no card "% Inadimplência".
 * Fonte: members/summary-excel (mesma do breakdown), filtrando StatusContrato=
 * Inadimplente com os MESMOS filtros do card (sem VIP/Suspenso/plano não-principal).
 * On-demand (sem cache) — chamado ao abrir o modal.
 */
export async function fetchInadimplentesDetalhados(unitNames?: string[]): Promise<InadimplentesDetalhados> {
  const names = (unitNames && unitNames.length ? unitNames : Object.keys(UNITS)).filter(n => UNITS[n]);
  const today = new Date();
  const periodLabel = `${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
  const EXCLUDED = ['cotista', 'colaborador', 'equipe', 'funcion', 'partner', 'gratuit'];

  const settled = await Promise.allSettled(names.map(async (name) => {
    const cfg = UNITS[name];
    const authHeader = 'Basic ' + btoa(`${DNS}:${cfg.token}`);
    const res = await fetchExcelWithRetry('/evo-integracao/api/v1/members/summary-excel', authHeader);
    if (!res.ok) throw new Error(`summary-excel ${res.status}`);
    const buffer = await res.arrayBuffer();
    const { read, utils } = await import('xlsx');
    const wb = read(new Uint8Array(buffer), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = utils.sheet_to_json<Record<string, unknown>>(ws);
    const rows = raw.map(r => { const c: Record<string, unknown> = {}; for (const k in r) c[k.trim()] = r[k]; return c; });
    if (!rows.length) return [] as InadimplenteRow[];
    const sample = rows[0];
    const statusKey   = pickKey(sample, ['StatusContrato', 'Status Contrato', 'Status do Contrato', 'Status']);
    const clienteKey  = pickKey(sample, ['StatusCliente', 'Status Cliente', 'SituacaoCliente', 'Situacao']);
    const vipKey      = pickKey(sample, ['ContratoVip', 'Contrato Vip', 'VIP', 'Vip']);
    const valorKey    = pickKey(sample, ['ValorContrato', 'Valor Contrato', 'Valor do Contrato', 'Valor']);
    const contratoKey = pickKey(sample, ['NomeContrato', 'Nome Contrato', 'Nome do Contrato', 'Contrato']);
    const idKey       = pickKey(sample, ['IdCliente', 'idCliente', 'Id Cliente', 'IdMember', 'idMember', 'Id', 'ID']);
    const nomeKey     = pickKey(sample, ['Nome', 'NomeCliente', 'Nome Cliente', 'Cliente', 'NomeAluno', 'Aluno', 'NomeCompleto']);
    const foneKey     = pickKey(sample, ['Telefone', 'Celular', 'TelefoneCelular', 'Telefone Celular', 'Fone', 'Contato', 'Telefone1', 'Celular1', 'Whatsapp', 'WhatsApp']);
    const out: InadimplenteRow[] = [];
    for (const row of rows) {
      const status = String(row[statusKey] ?? '').trim().toLowerCase();
      if (status !== 'inadimplente') continue;
      const vip = String(row[vipKey] ?? '').trim().toLowerCase();
      const isVip = vip === 'sim' || vip === 'yes' || vip === 's';
      const statusCliente = clienteKey ? String(row[clienteKey] ?? '').trim().toLowerCase() : '';
      const isSuspenso = statusCliente.includes('suspens');
      const nomeContrato = contratoKey ? String(row[contratoKey] ?? '') : '';
      const isPrincipal = !EXCLUDED.some(ex => nomeContrato.trim().toLowerCase().includes(ex));
      if (isVip || isSuspenso || !isPrincipal) continue;
      const idRaw = idKey ? row[idKey] : undefined;
      const id = typeof idRaw === 'number' ? idRaw : parseInt(String(idRaw ?? ''), 10);
      out.push({
        branchName: name,
        idBranch: cfg.idBranch,
        idCliente: isFinite(id) ? id : undefined,
        name: nomeKey ? String(row[nomeKey] ?? '').trim() : '',
        phone: foneKey ? String(row[foneKey] ?? '').trim() : '',
        plano: nomeContrato.trim(),
        valor: parseValorContrato(row[valorKey]),
      });
    }
    return out;
  }));

  const list: InadimplenteRow[] = [];
  let complete = true;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') list.push(...s.value);
    else { complete = false; console.error(`[EVO Inadimplentes] ${names[i]} falhou:`, s.reason); }
  });
  list.sort((a, b) => b.valor - a.valor); // maior risco primeiro
  return { list, complete, periodLabel };
}

/**
 * Aggregator pra Vendas filtradas por data customizada na Visão Geral.
 *
 * Itera por todas as unidades (UNITS) em paralelo, soma totais e devolve
 * breakdown por unidade pra UI poder filtrar por unidade depois sem refetch.
 * Usado quando o admin muda o date range da página Painel — fetch ad-hoc
 * (sem cache) porque o range é dinâmico.
 *
 * Convenção: se *qualquer* unidade falhar, devolve `complete=false` mas
 * mantém o que conseguiu (parcial). Erros não derrubam o agregado.
 */
export interface VendasRangeResult {
  totalQtd: number;
  totalValor: number;
  complete: boolean;       // false se alguma unidade quebrou paginação
  byUnit: Record<string, { qtd: number; valor: number; complete: boolean; list: VendaMin[] }>;
  list: VendaMin[];        // unificada (com branchName) pra reuso no VendasMesModal
}

export async function fetchVendasRangeAllBranches(
  start: string,
  end: string,
): Promise<VendasRangeResult> {
  const settled = await Promise.allSettled(
    Object.entries(UNITS).map(async ([name, cfg]) => {
      const r = await fetchVendasInRange(cfg.token, cfg.idBranch, start, end);
      return { name, ...r };
    })
  );
  let totalQtd = 0;
  let totalValor = 0;
  let complete = true;
  const byUnit: VendasRangeResult['byUnit'] = {};
  const list: VendaMin[] = [];
  settled.forEach((s, i) => {
    const name = Object.keys(UNITS)[i];
    if (s.status === 'fulfilled') {
      const r = s.value;
      byUnit[name] = { qtd: r.qtd, valor: r.valor, complete: r.complete, list: r.list };
      totalQtd += r.qtd;
      totalValor += r.valor;
      if (!r.complete) complete = false;
      list.push(...r.list.map(v => ({ ...v, branchName: name })));
    } else {
      console.error(`[EVO Vendas Range] ${name} falhou:`, s.reason);
      byUnit[name] = { qtd: 0, valor: 0, complete: false, list: [] };
      complete = false;
    }
  });
  return { totalQtd, totalValor, complete, byUnit, list };
}

/**
 * Vendas por intervalo lendo a tabela VendasEvo (NocoDB) via /api/vendas-range —
 * rápido e sem 429, ao contrário do fetch direto na EVO. Retorna o MESMO shape
 * (VendasRangeResult) + flag `enabled`. `enabled:false` = backend de histórico
 * não configurado → o caller deve cair no fetch ao vivo. Pros meses ausentes na
 * tabela, o servidor dispara backfill em background (não bloqueia esta resposta).
 */
export async function fetchVendasRangeFromHistory(
  start: string,
  end: string,
): Promise<(VendasRangeResult & { enabled: boolean }) | null> {
  try {
    const r = await fetch(`/api/vendas-range?from=${start}&to=${end}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.enabled) return { enabled: false, totalQtd: 0, totalValor: 0, complete: true, byUnit: {}, list: [] };
    return {
      enabled: true,
      totalQtd: Number(j.totalQtd) || 0,
      totalValor: Number(j.totalValor) || 0,
      complete: j.complete !== false,
      byUnit: (j.byUnit ?? {}) as VendasRangeResult['byUnit'],
      list: Array.isArray(j.list) ? (j.list as VendaMin[]) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Pulls the per-branch member summary Excel from W12 EVO and tallies the
 * StatusContrato / ContratoVip breakdown — gives ACCURATE Adimplentes count.
 *
 * Endpoint: GET /evo-integracao/api/v1/members/summary-excel
 *   Returns an .xlsx with one row per active membership and many columns.
 *   We need just two: `StatusContrato` and `ContratoVip`.
 */
async function fetchMemberBreakdownFromExcel(token: string, effectiveDate?: string): Promise<{
  ativos: number; adimplentes: number; inadimplentes: number; vips: number;
  faturamentoAdimplentes: number;
  faturamentoInadimplentes: number;
  idsAdimplentes: number[];     // pra cruzar com receivables (quem já pagou no mês)
  idsInadimplentes: number[];
}> {
  const authHeader = 'Basic ' + btoa(`${DNS}:${token}`);
  const params = effectiveDate ? `?effectiveDate=${effectiveDate}` : '';
  const url = `/evo-integracao/api/v1/members/summary-excel${params}`;

  const res = await fetchExcelWithRetry(url, authHeader);
  if (!res.ok) throw new Error(`EVO members/summary-excel ${res.status}`);

  const buffer = await res.arrayBuffer();
  const { read, utils } = await import('xlsx');
  const wb = read(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = utils.sheet_to_json<Record<string, unknown>>(ws);

  // Trim column names (Excel often has trailing spaces)
  const rows = rawRows.map(r => {
    const cleaned: Record<string, unknown> = {};
    for (const k in r) cleaned[k.trim()] = r[k];
    return cleaned;
  });

  if (rows.length === 0) {
    return { ativos: 0, adimplentes: 0, inadimplentes: 0, vips: 0, faturamentoAdimplentes: 0, faturamentoInadimplentes: 0, idsAdimplentes: [], idsInadimplentes: [] };
  }

  // Detect actual column names (W12 sometimes varies casing/spacing)
  const sample = rows[0];
  const statusKey   = pickKey(sample, ['StatusContrato', 'Status Contrato', 'Status do Contrato', 'Status']);
  // StatusCliente é SEPARADO do StatusContrato: o financeiro fica em StatusContrato
  // (Ativo/Inadimplente), mas a situação do cliente (Ativo/Suspenso) fica aqui.
  // Wesley 02/06/2026: desconsiderar clientes Suspensos (têm StatusContrato=Ativo
  // mas StatusCliente=Suspenso → não devem entrar em Ativos/Adimplentes).
  const clienteKey  = pickKey(sample, ['StatusCliente', 'Status Cliente', 'Status do Cliente', 'SituacaoCliente', 'Situacao']);
  const vipKey      = pickKey(sample, ['ContratoVip', 'Contrato Vip', 'VIP', 'Vip']);
  const valorKey    = pickKey(sample, ['ValorContrato', 'Valor Contrato', 'Valor do Contrato', 'Valor']);
  const contratoKey = pickKey(sample, ['NomeContrato', 'Nome Contrato', 'Nome do Contrato', 'Contrato']);
  // IdCliente primeiro — é o id da pessoa (bate com receivables). IdMember é id da matrícula (não bate).
  const idKey     = pickKey(sample, ['IdCliente', 'idCliente', 'Id Cliente', 'IdMember', 'idMember', 'IdAluno', 'idAluno', 'Id', 'ID']);

  if (!effectiveDate && !idKey) {
    console.warn('[EVO members/summary-excel] ⚠️ IdCliente NÃO detectado! Cruzamento vai falhar. Colunas disponíveis:', Object.keys(sample));
  }

  // Filtro de NOMES DE CONTRATO que NÃO contam como plano principal
  // (Marcelo 13/05/2026: "não contar massagem, cotista, colaborador, equipe,
  // funcionário, partner, gratuito" — ratificado pra bater com EVO Web).
  // Wesley 02/06/2026: voltar a CONTAR Massagem (removida da exclusão). ⚠ Membros
  // com plano principal + Massagem entram como 2 linhas → podem contar 2x.
  const EXCLUDED_NAMES = ['cotista', 'colaborador', 'equipe', 'funcion', 'partner', 'gratuit'];
  const isPlanoPrincipal = (nomeContrato: string): boolean => {
    const n = nomeContrato.trim().toLowerCase();
    return !EXCLUDED_NAMES.some(ex => n.includes(ex));
  };

  let ativos = 0, adimplentes = 0, inadimplentes = 0, vips = 0;
  let faturamentoAdimplentes = 0;
  let faturamentoInadimplentes = 0;
  const idsAdimplentes: number[] = [];
  const idsInadimplentes: number[] = [];

  for (const row of rows) {
    const status        = String(row[statusKey]     ?? '').trim().toLowerCase();
    const statusCliente = clienteKey ? String(row[clienteKey] ?? '').trim().toLowerCase() : '';
    const vip           = String(row[vipKey]        ?? '').trim().toLowerCase();
    const nomeContrato  = contratoKey ? String(row[contratoKey] ?? '') : '';
    const isVip         = vip === 'sim' || vip === 'yes' || vip === 's';
    const isSuspenso    = statusCliente.includes('suspens');
    const isPrincipal   = isPlanoPrincipal(nomeContrato);
    const valor         = parseValorContrato(row[valorKey]);
    const idRaw         = idKey ? row[idKey] : undefined;
    const id            = typeof idRaw === 'number' ? idRaw : parseInt(String(idRaw ?? ''), 10);

    if (isVip) vips++;

    // Pula tudo que NÃO é plano principal (Cotista/Colaborador/Equipe/etc).
    // Massagem agora CONTA (Wesley 02/06/2026). Também pula VIPs (Cortesia, Partner)
    // e clientes SUSPENSOS (StatusCliente=Suspenso, mesmo com StatusContrato=Ativo).
    // Estes NÃO entram em Ativos/Adimplentes/Inadimplentes.
    if (isVip || !isPrincipal || isSuspenso) {
      continue;
    }

    // Inadimplente = StatusContrato == Inadimplente.
    if (status === 'inadimplente') {
      inadimplentes++;
      ativos++;
      faturamentoInadimplentes += valor;
      if (isFinite(id)) idsInadimplentes.push(id);
    }
    // Adimplente = TODO o resto que passou pelos filtros acima (Wesley 02/06/2026:
    // "contar como adimplente quem NÃO for inadimplente"). Antes exigia
    // StatusContrato=='ativo' exato; agora qualquer status não-inadimplente conta.
    else {
      adimplentes++;
      ativos++;
      faturamentoAdimplentes += valor;
      if (isFinite(id)) idsAdimplentes.push(id);
    }
  }

  return { ativos, adimplentes, inadimplentes, vips, faturamentoAdimplentes, faturamentoInadimplentes, idsAdimplentes, idsInadimplentes };
}

/** Parse ValorContrato cell — pode vir como número, string "R$ 199,90", "199,90" ou "199.90". */
function parseValorContrato(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw)
    .replace(/R\$\s*/i, '')
    .trim()
    .replace(/\./g, '')   // remove milhar
    .replace(',', '.');   // vírgula decimal -> ponto
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function pickKey(row: Record<string, unknown>, candidates: string[]): string {
  for (const c of candidates) {
    if (c in row) return c;
  }
  // case-insensitive substring fallback
  const keys = Object.keys(row);
  for (const c of candidates) {
    const found = keys.find(k => k.toLowerCase() === c.toLowerCase());
    if (found) return found;
    const partial = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (partial) return partial;
  }
  return candidates[0];
}

// Cache version bump — forces refresh when counting method changes
const STATS_CACHE_VERSION = 18; // bump: vendas agora = membership nova (idMembership!=null & idMembershipRenewed==null), inclui re-enrollment e contrato sem kind — bate com relatório de Vendas do EVO

/** BranchStats zerado — base p/ fallback e normalização de cache antigo (shape garantido). */
function emptyBranchStats(name: string, location: string, idBranch: number, hasError = true): BranchStats {
  return {
    name, location, idBranch,
    activeMembers: 0, adimplentesMembers: 0, inadimplentesMembers: 0,
    vipMembers: 0, faturamentoAdimplentes: 0, faturamentoInadimplentes: 0,
    idsAdimplentes: [], idsInadimplentes: [],
    vendasMesValor: 0, vendasMesQtd: 0, vendasMesComplete: false, vendasMesList: [],
    activeMembersPrev: 0, adimplentesMembersPrev: 0, inadimplentesMembersPrev: 0,
    faturamentoAdimplentesPrev: 0, faturamentoInadimplentesPrev: 0,
    vendasMesValorPrev: 0, vendasMesQtdPrev: 0, vendasMesPrevComplete: false,
    activeMembers1y: 0, adimplentesMembers1y: 0, vipMembers1y: 0,
    faturamentoAdimplentes1y: 0, faturamentoInadimplentes1y: 0, has1yData: false,
    vendasMesValor1y: 0, vendasMesQtd1y: 0, vendasMes1yComplete: false, has1yVendas: false,
    cancelamentosMes: 0, cancelamentosMesComplete: false,
    inactiveMembers: 0, cancelledMembers: 0,
    hasError,
  };
}

export async function fetchBranchStats(name: string, force = false): Promise<BranchStats> {
  const cacheKey = `stats:${name}`;
  const { idBranch, token, location } = UNITS[name];
  const local = localStorage.getItem(cacheKey);
  // staleCache = último cache existente (MESMO expirado ou de versão antiga),
  // normalizado sobre um default zerado pra nunca faltar campo. Rede de segurança:
  // se o EVO estiver instável, devolvemos ele em vez de zerar a tela.
  let staleCache: BranchStats | null = null;
  if (local) {
    try {
      const parsed = JSON.parse(local) as Partial<BranchStats> & { _v?: number };
      staleCache = { ...emptyBranchStats(name, location, idBranch, false), ...parsed, name, location, idBranch };
      // Só serve cache fresco (sem rede) se for da versão atual e dentro de 3h.
      // force=true (botão "Atualizar") ignora o cache e re-puxa tudo da EVO.
      if (!force && parsed._v === STATS_CACHE_VERSION && parsed.lastUpdate && (Date.now() - parsed.lastUpdate < 3 * 60 * 60 * 1000)) {
        return staleCache;
      }
    } catch { /* cache corrompido → ignora e refaz */ }
  }

  try {
    // ─── 1ª onda: dados do MÊS ATUAL (prioridade alta) ─────────────────────
    // Excel + Vendas + Cancelamentos em paralelo, todos do mês corrente.
    // Cancelamentos puxa /api/v3/membermembership 1-a-1 por unidade (token próprio)
    // pra alimentar o card de Evasão com dado REAL (era inad/ativos antes).
    const [breakdown, vendas, cancelMes] = await Promise.all([
      fetchMemberBreakdownFromExcel(token),
      fetchVendasDoMes(token, idBranch, 0).catch(err => {
        console.error(`[EVO Vendas ${name}] erro total:`, err);
        return { valor: 0, qtd: 0, complete: false, list: [] as VendaMin[] };
      }),
      fetchCancellationsMes(token).catch(err => {
        console.warn(`[EVO Cancelamentos ${name}] erro:`, err);
        return { qtd: 0, complete: false };
      }),
    ]);

    // ─── 2ª onda: snapshot de ATIVOS/ADIMPLENTES do mês passado (cache 7d) ───
    // Mês fechado nunca muda — cacheia por (branch, mês) durante 7 dias.
    // NOTA: o fetch de /sales do mês passado foi REMOVIDO para reduzir carga
    // na API EVO (paginação extra × 7 unidades). Vendas comparativas ficam zeradas.
    // Ancora no dia 1 ANTES de subtrair o mês: setMonth() em dia 29-31 rola pro
    // mês seguinte quando o mês alvo é mais curto (ex.: 31/mar − 1 mês = 03/mar).
    const nowRef = new Date();
    const lastMonth = new Date(nowRef.getFullYear(), nowRef.getMonth() - 1, 1);
    const monthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
    const prevCacheKey = `prev:${name}:${monthKey}`;
    const PREV_TTL = 7 * 24 * 60 * 60 * 1000;

    let breakdownPrev: {
      adimplentes: number;
      inadimplentes: number;
      faturamentoAdimplentes: number;
      faturamentoInadimplentes: number;
    } | null = null;

    const cachedPrev = localStorage.getItem(prevCacheKey);
    if (cachedPrev) {
      try {
        const p = JSON.parse(cachedPrev);
        if (p && (Date.now() - p.t < PREV_TTL)) {
          // Cache pode ser de versão antiga sem faturamentos — tolera (assume 0).
          breakdownPrev = {
            faturamentoAdimplentes: 0,
            faturamentoInadimplentes: 0,
            ...p.breakdown,
          };
        }
      } catch { /* ignora cache corrompido */ }
    }

    if (!breakdownPrev) {
      const lastMonthDate = dateMinusDaysStr(30);
      const bp = await fetchMemberBreakdownFromExcel(token, lastMonthDate).catch(() => null);
      if (bp) {
        breakdownPrev = {
          adimplentes: bp.adimplentes,
          inadimplentes: bp.inadimplentes,
          faturamentoAdimplentes: bp.faturamentoAdimplentes,
          faturamentoInadimplentes: bp.faturamentoInadimplentes,
        };
        localStorage.setItem(prevCacheKey, JSON.stringify({
          t: Date.now(),
          breakdown: breakdownPrev,
        }));
      }
    }

    // ─── 3ª onda: snapshot ANUAL (1 ano atrás) — cache eterno por (branch, data) ─
    // Pro 'crescemos vs ano passado' que diretor financeiro pede.
    // Data passada nunca muda → cache de 30 dias por segurança (na pior hipótese refaz mensal).
    // Algumas unidades novas (<1 ano) vão ter has1yData=false — UI esconde o comparativo.
    //
    // Ordem de fontes (cascata): localStorage (rápido, per-user) → NocoDB
    // (compartilhado entre usuários) → EVO (custoso, último recurso).
    const oneYearAgo = dateMinusDaysStr(365);
    // Ancora no dia 1 antes de subtrair 12 meses (evita rolagem em 29-31).
    const nowRefKey = new Date();
    const lastYearSameMonthForKey = new Date(nowRefKey.getFullYear(), nowRefKey.getMonth() - 12, 1);
    const monthKey1yForNoco = `${lastYearSameMonthForKey.getFullYear()}-${String(lastYearSameMonthForKey.getMonth() + 1).padStart(2, '0')}`;
    const cacheKey1y = `gb_1y_v2:${name}:${oneYearAgo}`;
    const TTL_1Y = 30 * 24 * 60 * 60 * 1000;
    const NEG_TTL_1Y = 6 * 60 * 60 * 1000; // marca negativa (EVO falhou) dura só 6h → pega recuperação no mesmo dia
    let breakdown1y: {
      adimplentes: number;
      inadimplentes: number;
      vips: number;
      faturamentoAdimplentes: number;
      faturamentoInadimplentes: number;
      hasData: boolean;
    } | null = null;
    const cached1y = localStorage.getItem(cacheKey1y);
    if (cached1y) {
      try {
        const p = JSON.parse(cached1y);
        if (p?.neg && (Date.now() - p.t < NEG_TTL_1Y)) {
          // Marca negativa recente: EVO falhou p/ essa data antiga → não refaz por ora.
          breakdown1y = { adimplentes: 0, inadimplentes: 0, vips: 0, faturamentoAdimplentes: 0, faturamentoInadimplentes: 0, hasData: false };
        } else if (p?.data && (Date.now() - p.t < TTL_1Y)) {
          // Cache pode ser de versão antiga sem `vips` ou `faturamentoInadimplentes` — tolerante: assume 0.
          breakdown1y = { vips: 0, faturamentoInadimplentes: 0, ...p.data };
        }
      } catch { /* cache corrompido → refetch */ }
    }
    // Tenta NocoDB antes de bater no EVO (gb_evo_history populado via seed).
    // A mesma row do NocoDB tem TUDO que precisamos (membros + vendas), então
    // guardamos pra usar também na 4ª onda (vendas1y) sem refazer query.
    let nocoHistory1y: {
      adimplentes: number;
      inadimplentes: number;
      faturamento_adimplentes: number;
      vendas_qtd: number;
      vendas_valor: number;
    } | null = null;
    if (!breakdown1y) {
      try {
        const histRow = await fetchEvoHistorySnapshot(name, monthKey1yForNoco, 'monthly');
        if (histRow) {
          nocoHistory1y = {
            adimplentes: Number(histRow.adimplentes) || 0,
            inadimplentes: Number(histRow.inadimplentes) || 0,
            faturamento_adimplentes: Number(histRow.faturamento_adimplentes) || 0,
            vendas_qtd: Number(histRow.vendas_qtd) || 0,
            vendas_valor: Number(histRow.vendas_valor) || 0,
          };
          const totalMembers = nocoHistory1y.adimplentes + nocoHistory1y.inadimplentes;
          breakdown1y = {
            adimplentes: nocoHistory1y.adimplentes,
            inadimplentes: nocoHistory1y.inadimplentes,
            vips: 0,                       // schema do NocoDB não armazena vips ainda — fica 0
            faturamentoAdimplentes: nocoHistory1y.faturamento_adimplentes,
            faturamentoInadimplentes: 0,   // tampouco armazena receita-em-risco anual — fica 0
            hasData: totalMembers > 0,
          };
          localStorage.setItem(cacheKey1y, JSON.stringify({ t: Date.now(), data: breakdown1y }));
        }
      } catch (e) {
        console.warn(`[EVO Stats] ${name}: NocoDB lookup falhou, vou pra EVO`, e);
      }
    }
    if (!breakdown1y) {
      const bp1 = await fetchMemberBreakdownFromExcel(token, oneYearAgo).catch(() => null);
      if (bp1) {
        const totalMembers = bp1.adimplentes + bp1.inadimplentes;
        breakdown1y = {
          adimplentes: bp1.adimplentes,
          inadimplentes: bp1.inadimplentes,
          vips: bp1.vips,
          faturamentoAdimplentes: bp1.faturamentoAdimplentes,
          faturamentoInadimplentes: bp1.faturamentoInadimplentes,
          hasData: totalMembers > 0,
        };
        localStorage.setItem(cacheKey1y, JSON.stringify({ t: Date.now(), data: breakdown1y }));
      } else {
        // EVO falhou no snapshot de 1 ano (data antiga costuma dar 500). Grava marca
        // negativa curta pra não re-tentar — e gastar slot da fila — a cada load.
        try { localStorage.setItem(cacheKey1y, JSON.stringify({ t: Date.now(), neg: true })); } catch { /* ignore */ }
      }
    }

    // ─── 4ª onda: VENDAS no mesmo mês do ano anterior (offset=12) ─────────────
    // Mês fechado → cache 30 dias por (branch, monthKey1y). 1 chamada paginada
    // de /sales só na primeira vez do mês. NocoDB historical cache (Parte 8)
    // vai eventualmente substituir esse fetch.
    // Mesmo fix do monthKey acima: ancora no dia 1 antes de subtrair 12 meses
    // (29/fev − 12 meses rolaria pra 01/mar do ano anterior).
    const nowRef1y = new Date();
    const lastYearSameMonth = new Date(nowRef1y.getFullYear(), nowRef1y.getMonth() - 12, 1);
    const monthKey1y = `${lastYearSameMonth.getFullYear()}-${String(lastYearSameMonth.getMonth() + 1).padStart(2, '0')}`;
    const cacheKeyVendas1y = `gb_vendas_1y_v2:${name}:${monthKey1y}`;
    const TTL_VENDAS_1Y = 30 * 24 * 60 * 60 * 1000;
    let vendas1y: { valor: number; qtd: number; complete: boolean; hasData: boolean } | null = null;
    const cachedVendas1y = localStorage.getItem(cacheKeyVendas1y);
    if (cachedVendas1y) {
      try {
        const p = JSON.parse(cachedVendas1y);
        if (p && (Date.now() - p.t < TTL_VENDAS_1Y)) vendas1y = p.data;
      } catch { /* cache corrompido → refetch */ }
    }
    // Reusa snapshot do NocoDB (já carregado na 3ª onda) — evita 2ª query.
    if (!vendas1y && nocoHistory1y && (nocoHistory1y.vendas_qtd > 0 || nocoHistory1y.vendas_valor > 0)) {
      vendas1y = {
        valor: nocoHistory1y.vendas_valor,
        qtd: nocoHistory1y.vendas_qtd,
        complete: true,
        hasData: true,
      };
      localStorage.setItem(cacheKeyVendas1y, JSON.stringify({ t: Date.now(), data: vendas1y }));
    }
    if (!vendas1y) {
      const v1 = await fetchVendasDoMes(token, idBranch, 12).catch(err => {
        console.error(`[EVO Vendas 1y ${name}] erro:`, err);
        return null;
      });
      if (v1 && v1.complete) {
        vendas1y = {
          valor: v1.valor,
          qtd: v1.qtd,
          complete: v1.complete,
          hasData: v1.qtd > 0 || v1.valor > 0,
        };
        localStorage.setItem(cacheKeyVendas1y, JSON.stringify({ t: Date.now(), data: vendas1y }));
      } else if (v1) {
        // Vendas parciais (paginação quebrou) — usa em runtime mas NÃO cacheia
        vendas1y = { valor: v1.valor, qtd: v1.qtd, complete: false, hasData: v1.qtd > 0 };
      }
    }

    // Ativos = Adimplentes + Inadimplentes (SEM VIPs/cortesia) — matrículas reais pagantes
    const stats: BranchStats & { _v: number } = {
      name, location, idBranch,
      activeMembers:           breakdown.adimplentes + breakdown.inadimplentes,
      adimplentesMembers:      breakdown.adimplentes,
      inadimplentesMembers:    breakdown.inadimplentes,
      vipMembers:              breakdown.vips,
      faturamentoAdimplentes:  breakdown.faturamentoAdimplentes,
      faturamentoInadimplentes:breakdown.faturamentoInadimplentes,
      idsAdimplentes:          breakdown.idsAdimplentes,
      idsInadimplentes:        breakdown.idsInadimplentes,
      vendasMesValor:          vendas.valor,
      vendasMesQtd:            vendas.qtd,
      vendasMesComplete:       vendas.complete,
      vendasMesList:           vendas.list.map(v => ({ ...v, branchName: name })),

      // Histórico (30d atrás / mês passado) — vendas comparativas desativadas
      activeMembersPrev:           breakdownPrev ? (breakdownPrev.adimplentes + breakdownPrev.inadimplentes) : 0,
      adimplentesMembersPrev:      breakdownPrev?.adimplentes   ?? 0,
      inadimplentesMembersPrev:    breakdownPrev?.inadimplentes ?? 0,
      faturamentoAdimplentesPrev:  breakdownPrev?.faturamentoAdimplentes   ?? 0,
      faturamentoInadimplentesPrev:breakdownPrev?.faturamentoInadimplentes ?? 0,
      vendasMesValorPrev:          0,
      vendasMesQtdPrev:            0,
      vendasMesPrevComplete:       false,

      // Snapshot anual
      activeMembers1y:            breakdown1y ? (breakdown1y.adimplentes + breakdown1y.inadimplentes) : 0,
      adimplentesMembers1y:       breakdown1y?.adimplentes ?? 0,
      vipMembers1y:               breakdown1y?.vips ?? 0,
      faturamentoAdimplentes1y:   breakdown1y?.faturamentoAdimplentes ?? 0,
      faturamentoInadimplentes1y: breakdown1y?.faturamentoInadimplentes ?? 0,
      has1yData:                  breakdown1y?.hasData ?? false,

      // Vendas 1y atrás (mesmo mês)
      vendasMesValor1y:         vendas1y?.valor ?? 0,
      vendasMesQtd1y:           vendas1y?.qtd ?? 0,
      vendasMes1yComplete:      vendas1y?.complete ?? false,
      has1yVendas:              vendas1y?.hasData ?? false,

      // Cancelamentos do mês (pra card de Evasão)
      cancelamentosMes:          cancelMes.qtd,
      cancelamentosMesComplete:  cancelMes.complete,

      inactiveMembers:         breakdown.inadimplentes, // legacy alias
      cancelledMembers:        0,
      hasError:                false,
      lastUpdate:              Date.now(),
      _v:                      STATS_CACHE_VERSION,
    };
    // Só cacheia se vendas vieram íntegras — dado parcial não polui cache de 3h
    if (vendas.complete) {
      localStorage.setItem(cacheKey, JSON.stringify(stats));
      return stats;
    }
    // Vendas incompletas (EVO instável). Se há um cache anterior bom, devolve ele
    // (stale) em vez do número parcial/zerado — assim o dashboard nunca "esvazia".
    console.error(`[EVO Stats] ${name}: vendas INCOMPLETAS, não cacheado`);
    if (staleCache) {
      console.warn(`[EVO Stats] ${name}: devolvendo último cache válido (stale) — EVO instável`);
      return { ...staleCache, stale: true };
    }
    return stats;
  } catch (err) {
    console.error(`Error fetching stats for ${name}:`, err);
    // Qualquer falha (ex: 500 no Excel) → último cache bom, marcado como stale.
    if (staleCache) return { ...staleCache, stale: true };
    return emptyBranchStats(name, location, idBranch);
  }
}

export async function fetchAllBranchStats(force = false): Promise<BranchStats[]> {
  // Fonte SCRAPER (conta web EVO5) — usada quando a franqueadora não libera a API
  // de integração (Gaviões). Ativa com VITE_DATA_SOURCE=scraper. Mapeia o snapshot
  // gerencial do serviço evo-scraper pro contrato BranchStats. Ver scraperApi.ts.
  if (import.meta.env.VITE_DATA_SOURCE === 'scraper') {
    const { fetchScraperBranchStats } = await import('./scraperApi');
    return fetchScraperBranchStats(force);
  }

  // Paralelo entre unidades — cada uma tem token próprio e endpoint próprio na W12,
  // os Excels (members/summary-excel) vão direto via fetch (sem evoQueue),
  // e os GETs paginados (vendas) já entram na evoQueue com delay 700ms entre si.
  // Antes era sequencial: 7 unidades × ~3-10s = 21-70s. Agora ~3-10s totais.
  // force=true propaga pro botão "Atualizar": ignora cache de 3h e re-puxa da EVO.
  const settled = await Promise.allSettled(
    Object.keys(UNITS).map(name => fetchBranchStats(name, force))
  );
  const results: BranchStats[] = [];
  settled.forEach((r, i) => {
    const name = Object.keys(UNITS)[i];
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      console.error(`[EVO Stats] ${name} falhou:`, r.reason);
      const cfg = UNITS[name];
      results.push(emptyBranchStats(name, cfg.location, cfg.idBranch));
    }
  });
  return results;
}

// ─── Member List ──────────────────────────────────────────────────────────────

// ─── Today's Entries ─────────────────────────────────────────────────────────

export interface EntryRecord {
  date?: string;
  entryDate?: string;
  registerDate?: string;
  [key: string]: unknown;
}

export async function fetchTodayEntriesForBranch(token: string): Promise<EntryRecord[]> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm   = String(today.getMonth() + 1).padStart(2, '0');
  const dd   = String(today.getDate()).padStart(2, '0');
  const startDate = `${yyyy}-${mm}-${dd}T00:00:00`;
  const endDate   = `${yyyy}-${mm}-${dd}T23:59:59`;

  try {
    const data = await evoGet(
      `/api/v1/entries?take=1000&registerDateStart=${startDate}&registerDateEnd=${endDate}`,
      token
    );
    return extractArray(data) as EntryRecord[];
  } catch {
    return [];
  }
}

export function groupEntriesBySlotPerBranch(entries: EntryRecord[]): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  
  // Initialize grid
  Object.keys(UNITS).forEach(unitName => {
    result[unitName] = new Array(12).fill(0);
  });

  for (const e of entries) {
    const raw = e.date ?? e.entryDate ?? e.registerDate;
    const unitName = e._unitName;
    if (!raw || !unitName || !result[unitName]) continue;
    const h = new Date(raw).getHours();
    if (!isNaN(h)) {
      result[unitName][Math.min(Math.floor(h / 2), 11)]++;
    }
  }

  // Normalize percentages per row
  for (const unitName in result) {
    const max = Math.max(...result[unitName], 1);
    result[unitName] = result[unitName].map(v => Math.round((v / max) * 100));
  }

  return result;
}

export function groupEntriesBySlot(entries: EntryRecord[]): number[] {
  const slots = new Array(12).fill(0);
  for (const e of entries) {
    const raw = e.date ?? e.entryDate ?? e.registerDate;
    if (!raw) continue;
    const h = new Date(raw).getHours();
    if (!isNaN(h)) slots[Math.min(Math.floor(h / 2), 11)]++;
  }
  const max = Math.max(...slots, 1);
  return slots.map(v => Math.round((v / max) * 100));
}

export async function fetchTodayEntriesAllBranches(): Promise<EntryRecord[]> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm   = String(today.getMonth() + 1).padStart(2, '0');
  const dd   = String(today.getDate()).padStart(2, '0');
  const startDate = `${yyyy}-${mm}-${dd}T00:00:00`;
  const endDate   = `${yyyy}-${mm}-${dd}T23:59:59`;

  // Paralelo entre unidades — evoQueue cuida do rate-limit interno (700ms/req)
  const results = await Promise.allSettled(
    Object.entries(UNITS).map(async ([unitName, unit]) => {
      const data = await evoGet(
        `/api/v1/entries?take=1000&registerDateStart=${startDate}&registerDateEnd=${endDate}`,
        unit.token
      );
      const d = extractArray(data) as EntryRecord[];
      d.forEach(e => e._unitName = unitName);
      return d;
    })
  );

  const all: EntryRecord[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  return all;
}

// ─── Cached Ticket Helper ─────────────────────────────────────────────────────

/** Returns the EVO avg ticket from localStorage cache, or 180 if not yet loaded. */
export function getCachedAvgTicket(): number {
  try {
    const raw = localStorage.getItem('gb_ticket_data');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.data?.avgTicket === 'number') return parsed.data.avgTicket;
    }
  } catch { /* ignore */ }
  return 180;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatNumber(n: number): string {
  return n.toLocaleString('pt-BR');
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return '—'; }
}

// ─── Memberships / Plans ──────────────────────────────────────────────────────

export interface Membership {
  idMembership: number;
  nameMembership?: string;
  name?: string;
  membershipType?: string;
  // Price field — EVO may return it under various names
  value?: number | null;
  price?: number | null;
  amount?: number | null;
  monthlyFee?: number | null;
  regularValue?: number | null;
  membershipValue?: number | null;
  duration?: number | null;
  durationType?: string;
  description?: string;
  idBranch?: number | null;
  accessBranches?: { idBranch: number; nameBranch?: string }[];
  _unitName?: string;
}

export interface EntryRecord {
  idMember?: number;
  name?: string;
  registerDate?: string;
  entryDate?: string;
  date?: string;
  _unitName?: string;
}

/** Extract numeric price from a membership object, trying all known field names. */
function getMembershipPrice(p: Membership): number {
  const candidates = [p.value, p.price, p.amount, p.monthlyFee, p.regularValue, p.membershipValue];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return c;
  }
  return 0;
}

async function fetchMemberships(token: string): Promise<Membership[]> {
  let all: Membership[] = [];
  let skip = 0;
  const take = 50;
  while (true) {
    try {
      // Adicionando active=true para puxar apenas os planos que estão vigentes na unidade, evitando usar preços históricos mortos no cálculo.
      const data = await evoGet(`/api/v2/membership?take=${take}&skip=${skip}&active=true`, token);

      // (Hook reservado pra debug do shape da 1ª página — sem log em prod)

      const page = extractArray(data) as Membership[];
      if (page.length === 0) break;

      // Normalise: copy the detected price into `value` so the rest of the code works uniformly
      const normalised = page.map(p => ({ ...p, value: getMembershipPrice(p) || p.value }));
      all = all.concat(normalised);
      if (page.length < take) break;
      skip += take;
      if (skip >= 500) break;
    } catch (err) {
      console.error('[EVO Membership] fetch error:', err);
      break;
    }
  }
  return all;
}

export interface BranchMemberships {
  unitName: string;
  idBranch: number;
  plans: Membership[];
}

export async function fetchMembershipsPerBranch(): Promise<BranchMemberships[]> {
  const cacheKey = 'gb_memberships_per_branch';
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.timestamp && Date.now() - parsed.timestamp < 3 * 60 * 60 * 1000) {
        return parsed.data;
      }
    } catch { /* ignore */ }
  }

  // Paralelo entre unidades — fetchMemberships entra na evoQueue (700ms/req)
  const settled = await Promise.allSettled(
    Object.entries(UNITS).map(async ([unitName, unit]) => {
      const plans = await fetchMemberships(unit.token);
      const normalised = plans.map(p => ({
        ...p,
        nameMembership: p.nameMembership ?? p.name ?? `Plano #${p.idMembership}`,
        _unitName: unitName,
      }));
      return { unitName, idBranch: unit.idBranch, plans: normalised };
    })
  );

  const result: BranchMemberships[] = settled.map((r, i) => {
    const [unitName, unit] = Object.entries(UNITS)[i];
    return r.status === 'fulfilled'
      ? r.value
      : { unitName, idBranch: unit.idBranch, plans: [] };
  });

  localStorage.setItem(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }));
  return result;
}

export interface TicketData {
  avgTicket: number;
  minTicket: number;
  maxTicket: number;
  totalPlans: number;
  plans: { name: string; value: number; unitName: string }[];
  perBranch: BranchMemberships[];
}

export async function fetchAvgTicket(): Promise<TicketData> {
  const cacheKey = 'gb_ticket_data';
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.timestamp && Date.now() - parsed.timestamp < 3 * 60 * 60 * 1000) {
        return parsed.data;
      }
    } catch { /* ignore */ }
  }

  const perBranch = await fetchMembershipsPerBranch();

  // Deduplicate by idMembership across branches, keep priciest entry
  const seen = new Map<number, { name: string; value: number; unitName: string }>();
  for (const branch of perBranch) {
    for (const p of branch.plans) {
      const val = typeof p.value === 'number' && p.value > 0 ? p.value : null;
      if (!val) continue;
      const existing = seen.get(p.idMembership);
      if (!existing || val > existing.value) {
        seen.set(p.idMembership, {
          name: p.nameMembership ?? `Plano #${p.idMembership}`,
          value: val,
          unitName: branch.unitName,
        });
      }
    }
  }

  const plans = [...seen.values()].sort((a, b) => b.value - a.value);
  const values = plans.map(p => p.value);

  const result: TicketData = {
    avgTicket:  values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 180,
    minTicket:  values.length > 0 ? Math.min(...values) : 0,
    maxTicket:  values.length > 0 ? Math.max(...values) : 0,
    totalPlans: plans.length,
    plans,
    perBranch,
  };

  localStorage.setItem(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }));
  return result;
}

// ─── Base ativa POR PLANO (novo vs antigo) ─────────────────────────────────────
// Reaproveita o Excel members/summary-excel (1 linha por membership ativo), mas
// agrupa por NomeContrato (plano) e classifica cada ativo em NOVO (InicioContrato
// dentro do mês selecionado) vs ANTIGO. Usa effectiveDate = fim do mês escolhido,
// então reflete a base ativa daquele mês (navegação mês a mês). Aplica os MESMOS
// filtros do card "Ativos" (exclui VIP, planos não-principais e clientes
// suspensos) pra o total bater com o número oficial de ativos.

export interface PlanBreakdown {
  plano: string;   // NomeContrato
  total: number;   // ativos no plano (adimplentes + inadimplentes)
  novo: number;    // InicioContrato no mês selecionado
  antigo: number;  // InicioContrato antes do mês
  valor: number;   // soma ValorContrato dos ativos do plano
}
export interface BranchPlanBreakdown {
  unitName: string;
  totalAtivos: number;
  plans: PlanBreakdown[];
}

/** "dd/mm/yyyy" -> "yyyy-mm" (ou null se não casar). */
function ymFromBR(raw: unknown): string | null {
  const m = String(raw ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}` : null;
}

/** Último dia do mês "YYYY-MM" no formato ISO "YYYY-MM-DD". */
function lastDayOfMonthISOFromYM(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 0).getDate(); // m é 1-based aqui → Date(y, m, 0) = último dia do mês m
  return `${month}-${String(d).padStart(2, '0')}`;
}

async function fetchPlanBreakdownForBranch(token: string, month: string): Promise<{ plans: PlanBreakdown[]; totalAtivos: number }> {
  // Mês corrente (ou futuro) → snapshot de hoje (sem effectiveDate).
  // Mês passado → effectiveDate = fim daquele mês (base ativa retroativa).
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const effectiveDate = month >= curMonth ? undefined : lastDayOfMonthISOFromYM(month);

  const authHeader = 'Basic ' + btoa(`${DNS}:${token}`);
  const params = effectiveDate ? `?effectiveDate=${effectiveDate}` : '';
  const url = `/evo-integracao/api/v1/members/summary-excel${params}`;

  const res = await fetchExcelWithRetry(url, authHeader);
  if (!res.ok) throw new Error(`EVO members/summary-excel ${res.status}`);

  const buffer = await res.arrayBuffer();
  const { read, utils } = await import('xlsx');
  const wb = read(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = utils.sheet_to_json<Record<string, unknown>>(ws);
  const rows = rawRows.map(r => {
    const cleaned: Record<string, unknown> = {};
    for (const k in r) cleaned[k.trim()] = r[k];
    return cleaned;
  });
  if (rows.length === 0) return { plans: [], totalAtivos: 0 };

  const sample = rows[0];
  const statusKey   = pickKey(sample, ['StatusContrato', 'Status Contrato', 'Status']);
  const clienteKey  = pickKey(sample, ['StatusCliente', 'Status Cliente', 'SituacaoCliente', 'Situacao']);
  const vipKey      = pickKey(sample, ['ContratoVip', 'Contrato Vip', 'VIP', 'Vip']);
  const valorKey    = pickKey(sample, ['ValorContrato', 'Valor Contrato', 'Valor']);
  const contratoKey = pickKey(sample, ['NomeContrato', 'Nome Contrato', 'Contrato']);
  const inicioKey   = pickKey(sample, ['InicioContrato', 'Inicio Contrato', 'DataInicio', 'InicioVigencia']);

  // Mesmos exclui-dos do card Ativos (Marcelo/Wesley): não contar cotista,
  // colaborador, equipe, funcionário, partner, gratuito.
  const EXCLUDED_NAMES = ['cotista', 'colaborador', 'equipe', 'funcion', 'partner', 'gratuit'];
  const isPrincipal = (nome: string) => {
    const n = nome.trim().toLowerCase();
    return !EXCLUDED_NAMES.some(ex => n.includes(ex));
  };

  const map = new Map<string, PlanBreakdown>();
  let totalAtivos = 0;
  for (const row of rows) {
    const status        = String(row[statusKey] ?? '').trim().toLowerCase();
    const statusCliente = clienteKey ? String(row[clienteKey] ?? '').trim().toLowerCase() : '';
    const vip           = String(row[vipKey] ?? '').trim().toLowerCase();
    const nome          = contratoKey ? String(row[contratoKey] ?? '').trim() : '';
    const isVip         = vip === 'sim' || vip === 'yes' || vip === 's';
    const isSuspenso    = statusCliente.includes('suspens');

    if (isVip || !isPrincipal(nome) || isSuspenso) continue;
    if (status !== 'ativo' && status !== 'inadimplente') continue;

    const valor   = parseValorContrato(row[valorKey]);
    const ym      = inicioKey ? ymFromBR(row[inicioKey]) : null;
    const isNovo  = ym !== null && ym === month;
    const planoNome = nome || 'Sem plano';

    let pb = map.get(planoNome);
    if (!pb) { pb = { plano: planoNome, total: 0, novo: 0, antigo: 0, valor: 0 }; map.set(planoNome, pb); }
    pb.total++;
    pb.valor += valor;
    if (isNovo) pb.novo++; else pb.antigo++;
    totalAtivos++;
  }

  const plans = [...map.values()].sort((a, b) => b.total - a.total);
  return { plans, totalAtivos };
}

/**
 * Base ativa por plano (novo vs antigo) por unidade, num dado mês "YYYY-MM".
 * Cache por (unidade, mês) — 30min. Passe unitNames pra buscar só as unidades
 * permitidas (respeita a matriz Página×Unidade do usuário).
 */
export async function fetchPlansBreakdown(month: string, unitNames?: string[]): Promise<BranchPlanBreakdown[]> {
  const names = (unitNames && unitNames.length ? unitNames : Object.keys(UNITS)).filter(n => UNITS[n]);
  return Promise.all(names.map(async (name) => {
    const cacheKey = `gb_plans_breakdown_${name}_${month}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (p.timestamp && Date.now() - p.timestamp < 30 * 60 * 1000) return p.data as BranchPlanBreakdown;
      } catch { /* ignore */ }
    }
    try {
      const { plans, totalAtivos } = await fetchPlanBreakdownForBranch(UNITS[name].token, month);
      const data: BranchPlanBreakdown = { unitName: name, totalAtivos, plans };
      localStorage.setItem(cacheKey, JSON.stringify({ data, timestamp: Date.now() }));
      return data;
    } catch (e) {
      console.error(`[Plans] ${name} erro:`, e);
      return { unitName: name, totalAtivos: 0, plans: [] } as BranchPlanBreakdown;
    }
  }));
}

// ─── Receivables (Recebíveis) ─────────────────────────────────────────────────

export interface ReceivableRow {
  [key: string]: unknown;
}

export interface ReceivablesUnitData {
  unitName: string;
  amount: number;          // total lançado na unidade
  rows: number;
  received: number;        // já recebido na unidade
  pending: number;         // pendente
  overdue: number;         // em atraso
  multaCancelamento: number;
  avulso: number;
  manutencaoAnual: number; // soma da coluna Valor onde Descricao bate /manuten.*anual/
}

export interface ReceivablesData {
  data: ReceivableRow[];
  period: string;
  total: number;
  totalReceived: number;
  totalPending: number;
  totalOverdue: number;
  totalAmount: number;
  totalMultaCancelamento: number;              // soma dos lançamentos cujo tipo bate com /multa.*cancel|cancel.*multa/
  totalAvulso: number;                         // soma dos lançamentos cujo tipo contém "avulso"
  totalManutencaoAnual: number;                // soma da coluna Valor onde Descricao bate /manuten.*anual/
  perUnit: ReceivablesUnitData[];
  idsPagos: number[];                          // rede: clientes com >=1 lançamento pago no período
  idsLancados: number[];                       // rede: todos os clientes com qualquer lançamento
  idsPagosPorUnidade: Record<string, number[]>;    // por unidade: clientes pagantes
  idsLancadosPorUnidade: Record<string, number[]>; // por unidade: clientes com lançamento
}

/**
 * Reaplica filtro de unidades permitidas em um ReceivablesData. Recalcula
 * totais agregados (totalAmount, totalReceived, etc.) a partir de perUnit das
 * unidades permitidas. Garante que callers (PDF, Painel, Financeiro) nunca
 * recebam dados de unidades fora do escopo do usuário corrente.
 *
 * Use sempre que o ReceivablesData for renderizado/exportado num contexto
 * de usuário com allowed_units restrito.
 */
export function filterReceivablesByUnits(
  raw: ReceivablesData | null | undefined,
  allowedUnits: string[],
): ReceivablesData | null {
  if (!raw) return null;
  const allowed = new Set(allowedUnits);
  const perUnit = raw.perUnit.filter(p => allowed.has(p.unitName));
  const sum = (key: keyof Pick<ReceivablesUnitData, 'amount'|'rows'|'received'|'pending'|'overdue'|'multaCancelamento'|'avulso'|'manutencaoAnual'>) =>
    perUnit.reduce((s, p) => s + p[key], 0);
  const idsLancadosPorUnidade = Object.fromEntries(
    Object.entries(raw.idsLancadosPorUnidade ?? {}).filter(([u]) => allowed.has(u))
  );
  const idsPagosPorUnidade = Object.fromEntries(
    Object.entries(raw.idsPagosPorUnidade ?? {}).filter(([u]) => allowed.has(u))
  );
  const idsLancados = Array.from(new Set(Object.values(idsLancadosPorUnidade).flat()));
  const idsPagos    = Array.from(new Set(Object.values(idsPagosPorUnidade).flat()));
  return {
    ...raw,
    perUnit,
    total:                  sum('rows'),
    totalAmount:            sum('amount'),
    totalReceived:          sum('received'),
    totalPending:           sum('pending'),
    totalOverdue:           sum('overdue'),
    totalMultaCancelamento: sum('multaCancelamento'),
    totalAvulso:            sum('avulso'),
    totalManutencaoAnual:   sum('manutencaoAnual'),
    idsLancadosPorUnidade,
    idsPagosPorUnidade,
    idsLancados,
    idsPagos,
    // `data` é a lista bruta — não é segura, mas o caller (PDF/Financeiro) não usa.
    // Mantemos como está pra preservar contrato. Se uma tela ler `data` direto, filtre lá.
    data: raw.data,
  };
}

const RECEIVABLES_CACHE_KEY = 'gb_receivables_data_v11'; // bump v9→v10→v11: nova lógica DtRecebimento+ValorBaixa (força HMR)
// Cache de sessão por range custom (mês fechado não muda) — evita re-baixar o
// Excel do EVO toda vez que o usuário navega entre meses no Financeiro.
const _receivablesRangeCache = new Map<string, ReceivablesData>();
const RECEIVABLES_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function fetchReceivables(dtFrom?: string, dtTo?: string): Promise<ReceivablesData> {
  // Range CUSTOM (filtro de data do Financeiro) NUNCA usa o cache de localStorage:
  // ele não é indexado por período e devolvia o mês corrente mesmo filtrando outro
  // mês. Em vez disso usa cache de SESSÃO por range (mês fechado é imutável) —
  // voltar pro mesmo mês não re-baixa o Excel do EVO.
  const isCustomRange = dtFrom !== undefined || dtTo !== undefined;
  const rangeKey = `${dtFrom ?? ''}|${dtTo ?? ''}`;
  if (isCustomRange) {
    const hit = _receivablesRangeCache.get(rangeKey);
    if (hit) return hit;
  }
  // Check cache. staleReceivables = cache anterior (mesmo expirado) usado como
  // rede de segurança se o EVO falhar em todas as unidades.
  let staleReceivables: ReceivablesData | null = null;
  const cached = isCustomRange ? null : localStorage.getItem(RECEIVABLES_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.data) staleReceivables = parsed.data as ReceivablesData;
      if (Date.now() - parsed.timestamp < RECEIVABLES_CACHE_TTL) {
        return parsed.data;
      }
    } catch { /* ignore */ }
  }

  // Default to current month
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d: Date) => localYMD(d);

  const from = dtFrom ?? fmt(firstDay);
  const to   = dtTo   ?? fmt(lastDay);

  const { read, utils } = await import('xlsx');

  // Fetch receivables for every unit in parallel (each has its own token)
  const unitEntries = Object.entries(UNITS);
  const unitResults = await Promise.allSettled(
    unitEntries.map(async ([unitName, unit]) => {
      const authHeader = 'Basic ' + btoa(`${DNS}:${unit.token}`);
      const url = `/evo-integracao/api/v1/receivables/summary-excel?dtLancamentoDe=${from}&dtLancamentoAte=${to}`;

      const res = await fetchExcelWithRetry(url, authHeader);
      if (!res.ok) {
        console.warn(`[receivables] ${unitName}: HTTP ${res.status} — unidade ignorada`);
        return { unitName, rows: [] as ReceivableRow[] };
      }

      const buffer = await res.arrayBuffer();
      const workbook = read(new Uint8Array(buffer), { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows: ReceivableRow[] = utils.sheet_to_json(worksheet);

      const rows = rawRows.map(row => {
        const newRow: ReceivableRow = {};
        for (const key in row) newRow[key.trim()] = row[key];
        return newRow;
      });

      return { unitName, rows };
    })
  );

  // Merge all rows, keeping per-unit data
  const allRows: ReceivableRow[] = [];
  const fulfilledUnits = unitResults
    .map((r, i) => r.status === 'fulfilled' ? { unitName: unitEntries[i][0], rows: r.value.rows } : null)
    .filter(Boolean) as { unitName: string; rows: ReceivableRow[] }[];

  for (const u of fulfilledUnits) allRows.push(...u.rows);

  // Match EXATO primeiro — nunca usar fuzzy aqui, pra não pegar "Valor Multa"/"Valor Juros" no lugar de "Valor".
  const AMOUNT_CANDIDATES = ['Valor', 'valor', 'VALOR', 'Valor Lançamento', 'ValorLancamento', 'Valor Líquido', 'ValorLiquido'];
  const amountKey = AMOUNT_CANDIDATES.find(c => allRows[0] && c in allRows[0]) ?? '';

  // ValorBaixa = valor EFETIVAMENTE recebido (após taxas, descontos, etc).
  // Quando DtRecebimento está preenchida, usar ValorBaixa em vez de Valor.
  const valorBaixaKey = ['ValorBaixa', 'Valor Baixa', 'ValorRecebido'].find(c => allRows[0] && c in allRows[0]) ?? '';

  // ─── BUG ANTIGO ────────────────────────────────────────────────────────────
  // Antes a gente procurava a coluna 'Status' pra classificar pago/atrasado/pendente,
  // mas essa coluna NÃO EXISTE no XLSX do /receivables/summary-excel (sempre vazia).
  // Resultado: tudo virava "pendente" e Recebido sempre 0,00.
  //
  // Lógica CORRETA (validada com XLSX real Maio/2026):
  //   - RECEBIDO  = DtRecebimento preenchida  → soma ValorBaixa (ou Valor se ValorBaixa=0)
  //   - ATRASADO  = DtRecebimento vazia E DtVencimento < hoje  → soma Valor
  //   - PENDENTE  = DtRecebimento vazia E DtVencimento >= hoje → soma Valor
  // ───────────────────────────────────────────────────────────────────────────
  const dtRecebimentoKey = ['DtRecebimento', 'Data Recebimento', 'DataRecebimento'].find(c => allRows[0] && c in allRows[0]) ?? '';
  const dtVencimentoKey  = ['DtVencimento', 'Data Vencimento', 'DataVencimento'].find(c => allRows[0] && c in allRows[0]) ?? '';

  // IdCliente primeiro — bate com a planilha de members; IdMember/IdLancamento NÃO batem (são id da matrícula/cobrança)
  const ID_CANDIDATES = ['IdCliente', 'idCliente', 'Id Cliente', 'idcliente', 'IDCLIENTE', 'IdMember', 'idMember', 'IdAluno', 'idAluno', 'IdPessoa'];
  const idKey = ID_CANDIDATES.find(c => allRows[0] && c in allRows[0]) ?? '';

  // Tipo de lançamento (pra somar Multa de Cancelamento e Avulso)
  const TIPO_CANDIDATES = ['Tipo', 'tipo', 'TIPO', 'TipoLancamento', 'Tipo Lançamento', 'TipoReceita', 'Categoria', 'categoria', 'Descrição', 'Descricao', 'descricao'];
  const tipoKey = TIPO_CANDIDATES.find(c => allRows[0] && c in allRows[0]) ?? '';

  // Descricao — chave SEPARADA pra Manutenção Anual (texto vem nessa coluna específica)
  const DESC_CANDIDATES = ['Descricao', 'Descrição', 'descricao', 'descrição', 'DESCRICAO', 'DESCRIÇÃO', 'Description', 'description'];
  const descKey = DESC_CANDIDATES.find(c => allRows[0] && c in allRows[0]) ?? '';

  if (!idKey) {
    console.warn('[receivables] ⚠️ IdCliente NÃO detectado! Cruzamento member×receivable vai falhar.');
  }
  if (!dtRecebimentoKey || !dtVencimentoKey) {
    console.warn('[receivables] ⚠️ DtRecebimento ou DtVencimento não detectado — categoria pago/atrasado/pendente vai ficar zerada.');
  }

  // Parse de data BR (dd/MM/yyyy) — robusto: aceita Date object, ISO, ou "01/05/2026"
  const HOJE = new Date();
  HOJE.setHours(0, 0, 0, 0);
  function parseDateBR(raw: unknown): Date | null {
    if (raw == null || raw === '') return null;
    if (raw instanceof Date) return raw;
    const s = String(raw).trim();
    if (!s) return null;
    // dd/MM/yyyy
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const [, d, mo, y] = m;
      const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
      return new Date(year, parseInt(mo) - 1, parseInt(d));
    }
    // ISO yyyy-MM-dd
    const iso = new Date(s);
    return isNaN(iso.getTime()) ? null : iso;
  }

  /**
   * Parse robusto de valor monetário — aceita:
   *  - número JS direto (xlsx normalmente devolve Number pra células numéricas)
   *  - "R$ 155.955,15" / "155.955,15" (BR)
   *  - "155,955.15" / "155955.15" (US)
   *  - "155955" / "155955,15" / "155955.15" (sem milhar)
   * Decisão BR vs US: olha o ÚLTIMO separador da string.
   */
  function parseMoney(raw: unknown): number {
    if (raw == null) return 0;
    if (typeof raw === 'number') return raw;
    let s = String(raw).replace(/R\$\s*/i, '').replace(/\s/g, '').trim();
    if (!s) return 0;
    const lastDot   = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      // formato BR: vírgula é decimal, ponto é milhar
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      // formato US: ponto é decimal, vírgula é milhar
      s = s.replace(/,/g, '');
    } else {
      // sem separadores ou só dígitos
      s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  function calcAmount(row: ReceivableRow): number {
    if (amountKey && row[amountKey] !== undefined) return parseMoney(row[amountKey]);
    return 0;  // sem fallback "soma tudo numérico" — gerava lixo (somava ID, Multa, Juros, etc.)
  }

  let totalAmount   = 0;
  let totalReceived = 0;
  let totalPending  = 0;
  let totalOverdue  = 0;
  let totalMultaCancelamento = 0;
  let totalAvulso = 0;
  let totalManutencaoAnual = 0;
  const idsPagos    = new Set<number>();
  const idsLancados = new Set<number>();
  const idsPagosPorUnidade: Record<string, number[]>    = {};
  const idsLancadosPorUnidade: Record<string, number[]> = {};

  // Uma única passada por unidade — calcula amount, totais, idsPagos por unidade
  const perUnit: ReceivablesUnitData[] = fulfilledUnits.map(u => {
    let unitAmount = 0;
    let unitReceived = 0;
    let unitPending  = 0;
    let unitOverdue  = 0;
    let unitMulta    = 0;
    let unitAvulso   = 0;
    let unitManutencao = 0;
    const idsPagosUnit    = new Set<number>();
    const idsLancadosUnit = new Set<number>();

    for (const row of u.rows) {
      const amount = calcAmount(row);
      const valorBaixa = valorBaixaKey ? parseMoney(row[valorBaixaKey]) : 0;
      unitAmount  += amount;
      totalAmount += amount;

      const tipo   = tipoKey ? String(row[tipoKey] ?? '').trim().toLowerCase() : '';
      const desc   = descKey ? String(row[descKey] ?? '').trim().toLowerCase() : '';
      const idRaw  = idKey ? row[idKey] : undefined;
      const id     = typeof idRaw === 'number' ? idRaw : parseInt(String(idRaw ?? ''), 10);
      if (isFinite(id)) {
        idsLancados.add(id);
        idsLancadosUnit.add(id);
      }

      // Tipo: multa de cancelamento e avulso (somam paralelamente, não substituem o status)
      if (/multa.*cancel|cancel.*multa|multa de cancel/.test(tipo)) { totalMultaCancelamento += amount; unitMulta  += amount; }
      if (/avulso/.test(tipo))                                       { totalAvulso            += amount; unitAvulso += amount; }
      // Descricao: manutenção anual (texto na coluna Descricao, captura todas variações de caixa/acento)
      if (/manuten.*anual/.test(desc))                               { totalManutencaoAnual   += amount; unitManutencao += amount; }

      // ─── Classificação CORRETA — usa DtRecebimento + DtVencimento ───────────
      const dtRecebimento = dtRecebimentoKey ? parseDateBR(row[dtRecebimentoKey]) : null;
      const dtVencimento  = dtVencimentoKey  ? parseDateBR(row[dtVencimentoKey])  : null;

      if (dtRecebimento) {
        // RECEBIDO — usa ValorBaixa (valor real que entrou na conta), fallback Valor
        const recebido = valorBaixa > 0 ? valorBaixa : amount;
        totalReceived += recebido;
        unitReceived  += recebido;
        if (isFinite(id)) {
          idsPagos.add(id);
          idsPagosUnit.add(id);
        }
      } else if (dtVencimento && dtVencimento.getTime() < HOJE.getTime()) {
        // ATRASADO — vencimento passou e ainda não pagou
        totalOverdue += amount;
        unitOverdue  += amount;
      } else {
        // PENDENTE — vencimento ainda no futuro
        totalPending += amount;
        unitPending  += amount;
      }
    }

    idsPagosPorUnidade[u.unitName]    = Array.from(idsPagosUnit);
    idsLancadosPorUnidade[u.unitName] = Array.from(idsLancadosUnit);

    return {
      unitName: u.unitName,
      amount: unitAmount,
      rows: u.rows.length,
      received:           unitReceived,
      pending:            unitPending,
      overdue:            unitOverdue,
      multaCancelamento:  unitMulta,
      avulso:             unitAvulso,
      manutencaoAnual:    unitManutencao,
    };
  }).filter(u => u.rows > 0).sort((a, b) => b.amount - a.amount);

  const result: ReceivablesData = {
    data: allRows,
    period: `${from} até ${to}`,
    total: allRows.length,
    totalReceived,
    totalPending,
    totalOverdue,
    totalAmount,
    totalMultaCancelamento,
    totalAvulso,
    totalManutencaoAnual,
    perUnit,
    idsPagos:    Array.from(idsPagos),
    idsLancados: Array.from(idsLancados),
    idsPagosPorUnidade,
    idsLancadosPorUnidade,
  };
  // EVO instável: se NENHUMA linha veio (todas as unidades falharam/500) mas temos
  // um cache anterior com dados, devolve o stale em vez de zerar — e NÃO sobrescreve
  // o cache bom com zeros. (Mês legitimamente vazio sem cache anterior segue 0.)
  if (allRows.length === 0 && staleReceivables && (staleReceivables.total > 0 || staleReceivables.totalAmount > 0)) {
    console.warn('[receivables] todas as unidades falharam — devolvendo último cache válido (stale)');
    return staleReceivables;
  }

  // Cache SEM a lista bruta `data` (allRows): nenhum caller lê esse campo e ele
  // estourava o quota do localStorage (~5MB) → QuotaExceededError. Guardamos só
  // os agregados (leves). try/catch porque cache é best-effort, nunca quebra o fetch.
  if (!isCustomRange) {
    try {
      const cacheable: ReceivablesData = { ...result, data: [] };
      localStorage.setItem(RECEIVABLES_CACHE_KEY, JSON.stringify({ data: cacheable, timestamp: Date.now() }));
    } catch (err) {
      console.warn('[receivables] cache não persistido (quota/serialização):', err);
      try { localStorage.removeItem(RECEIVABLES_CACHE_KEY); } catch { /* ignore */ }
    }
  } else if (allRows.length > 0 || unitResults.every(r => r.status === 'fulfilled')) {
    // Só cacheia range custom se o fetch foi bem-sucedido (não congela erro).
    _receivablesRangeCache.set(rangeKey, result);
  }
  return result;
}

// findKey() removida — não usamos mais detecção fuzzy de coluna 'Status'
// (essa coluna não existe no XLSX do /receivables/summary-excel).
// Classificação agora vem de DtRecebimento + DtVencimento — ver loop principal.

// ─── Taxa de Ocupação (capacidade vs ocupação atual) ─────────────────────────
//
// EVO expõe GET /api/v1/configuration/occupation que devolve por filial:
//   { idBranch, name, occupation, maxOccupation, qtyMinutesOut }
//
// Onde:
//   - maxOccupation = capacidade nominal da unidade (vagas configuradas)
//   - occupation    = ocupação atual (alunos dentro da academia agora)
//   - qtyMinutesOut = minutos pra considerar saída quando catraca quebra
//
// Cada token é por filial, mas o endpoint pode listar todas as filiais
// associadas àquele DNS. Pra ser robusto, chamamos /occupation com cada token
// e procuramos a entrada do `idBranch` correspondente — se a entry vier
// agregada (várias filiais por token), pegamos a do branch certo; se vier
// como objeto único, usamos direto.

export interface OccupationUnit {
  name: string;        // nome local da unidade (UNITS key)
  idBranch: number;
  occupation: number;
  maxOccupation: number;
  pct: number;         // 0..100, arredondado
  hasError: boolean;
}

export interface OccupationData {
  total: { occupation: number; maxOccupation: number; pct: number };
  byUnit: OccupationUnit[];
  fetchedAt: number;
  hasAnyError: boolean;
}

interface OccupationApiRow {
  idBranch?: number;
  name?: string;
  occupation?: number;
  maxOccupation?: number;
  qtyMinutesOut?: number;
}

async function fetchOccupationForUnit(name: string): Promise<OccupationUnit> {
  const cfg = UNITS[name];
  try {
    const data = await evoGet('/api/v1/configuration/occupation', cfg.token);
    const arr: OccupationApiRow[] = Array.isArray(data)
      ? (data as OccupationApiRow[])
      : (data && typeof data === 'object' ? [data as OccupationApiRow] : []);
    // Procura pela filial correspondente (token pode listar várias filiais)
    const row = arr.find(r => r.idBranch === cfg.idBranch) ?? arr[0] ?? null;
    if (!row) {
      return {
        name, idBranch: cfg.idBranch,
        occupation: 0, maxOccupation: 0, pct: 0, hasError: true,
      };
    }
    const occ = Math.max(0, Number(row.occupation) || 0);
    const cap = Math.max(0, Number(row.maxOccupation) || 0);
    const pct = cap > 0 ? (occ / cap) * 100 : 0;
    return { name, idBranch: cfg.idBranch, occupation: occ, maxOccupation: cap, pct, hasError: false };
  } catch (err) {
    console.error(`[EVO Occupation] ${name} falhou:`, err);
    return { name, idBranch: cfg.idBranch, occupation: 0, maxOccupation: 0, pct: 0, hasError: true };
  }
}

/**
 * Cache em localStorage com TTL curto (5 min) — ocupação muda em tempo real
 * mas não vale gastar quota em refetch a cada navegação.
 */
const OCCUPATION_CACHE_KEY = 'gb_occupation_v1';
const OCCUPATION_TTL = 5 * 60 * 1000;

export async function fetchOccupation(force = false): Promise<OccupationData> {
  if (!force) {
    const cached = localStorage.getItem(OCCUPATION_CACHE_KEY);
    if (cached) {
      try {
        const p = JSON.parse(cached) as OccupationData;
        if (Date.now() - p.fetchedAt < OCCUPATION_TTL) return p;
      } catch { /* cache corrompido → refetch */ }
    }
  }
  const settled = await Promise.allSettled(
    Object.keys(UNITS).map(name => fetchOccupationForUnit(name))
  );
  const byUnit: OccupationUnit[] = [];
  let totalOcc = 0;
  let totalCap = 0;
  let hasAnyError = false;
  settled.forEach((s, i) => {
    const name = Object.keys(UNITS)[i];
    if (s.status === 'fulfilled') {
      byUnit.push(s.value);
      totalOcc += s.value.occupation;
      totalCap += s.value.maxOccupation;
      if (s.value.hasError) hasAnyError = true;
    } else {
      console.error(`[EVO Occupation] ${name} rejeitou:`, s.reason);
      byUnit.push({ name, idBranch: UNITS[name].idBranch, occupation: 0, maxOccupation: 0, pct: 0, hasError: true });
      hasAnyError = true;
    }
  });
  const result: OccupationData = {
    total: {
      occupation: totalOcc,
      maxOccupation: totalCap,
      pct: totalCap > 0 ? (totalOcc / totalCap) * 100 : 0,
    },
    byUnit,
    fetchedAt: Date.now(),
    hasAnyError,
  };
  localStorage.setItem(OCCUPATION_CACHE_KEY, JSON.stringify(result));
  return result;
}

// ─── Comercial: Auto (5 dos 6 campos vêm do EVO) ─────────────────────────────
//
// A tela "Gerencial > Aulas Experimentais" do EVO Web mostra esses dados via
// API privada (evo-app.w12app.com.br atrás de WAF). Não acessível via Basic Auth.
//
// MAS validamos que a métrica equivalente pode ser construída via API pública
// varrendo activity sessions: pessoas enrolled como PROSPECT (idProspect != null)
// estão fazendo aula experimental por definição (prospect ainda não pagou plano).
//
// Validação (Saúde 11/05/2026):
//   - tela EVO Web mostrava: MARIA, DEBORAH, ERICO, MARIANA, NOEMI (5 agendados)
//   - probe achou: ERICO (prospect 43275, session 757648 Pilates 20:00, status=Presente)
//     + NOEMI (member 19274 BE FREE — virou member no momento da aula)
//   - os outros aparecem em outras sessions
//
// Cálculo por unidade:
//   1) GET /v1/activities/schedule?date=X&take=200 → lista sessions do dia
//   2) Pra cada session com ocupation>0, GET /schedule/detail?idActivitySession=Y
//      → traz enrollments com idMember, idProspect, status
//   3) Filtra enrollments com idProspect != null + members "BE FREE" (cortesia)
//   4) status: 0=Attending(Compareceram), 1=Absent(Faltaram), 2=JustifiedAbsence(Reagendados)
//
// Fecharam continua via XLSX /v2/management/prospects (Status=CLIENTE,DtConversao=date).
//
// CUSTO: ~80 sessions/dia/unidade × 7 unidades = ~560 calls a 700ms = ~6min/load.
// Mitigação: cache 30min por (branch, date), Promise.allSettled paralelo, carrega
// só pra unidades visíveis ao user.
//
// IMPORTANTE: o IdFilial do EVO tem offset +1 vs nosso idBranch local (o EVO
// pulou o ID 2). Mapping em EVO_FILIAL_TO_BRANCH abaixo.

const EVO_FILIAL_TO_BRANCH: Record<number, string> = {
  1: 'Altino Arantes',
  3: 'Saúde',
  4: 'Parque das Nações',
  5: 'Alto do Ipiranga',
  6: 'Jardins',
  7: 'Belenzinho',
  8: 'Campestre',
};

/** Resumo de um lead/cliente pra drilldown na tela Comercial. */
export interface ComercialLead {
  id: number | string;       // idMember ou idProspect
  kind: 'member' | 'prospect';
  name: string;
  registerDate?: string;     // ISO ou dd/MM/yyyy
  lastAccessDate?: string;
  membership?: string;       // nome do plano (se houver)
}

export interface ComercialAutoData {
  agendados:    Record<string, number>;
  compareceram: Record<string, number>;
  faltaram:     Record<string, number>;
  reagendados:  Record<string, number>;
  fecharam:     Record<string, number>;
  // listas pra drilldown (clique no card → modal com leads)
  agendadosList:    Record<string, ComercialLead[]>;
  compareceramList: Record<string, ComercialLead[]>;
  faltaramList:     Record<string, ComercialLead[]>;
  reagendadosList:  Record<string, ComercialLead[]>;
  fecharamList:     Record<string, ComercialLead[]>;
  fetchedAt:    number;
  hasError:     boolean;
}

const COMERCIAL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2h — varredura é cara, vale persistir
const COMERCIAL_LS_KEY = 'gb_comercial_evo_cache_v1';
const comercialCache: Record<string, ComercialAutoData> = {};

/** Cache por (date+branch) — permite carregar unidades sob demanda. */
interface BranchEnrollmentsData {
  agendados:        number;
  compareceram:     number;
  faltaram:         number;
  reagendados:      number;
  agendadosList:    ComercialLead[];
  compareceramList: ComercialLead[];
  faltaramList:     ComercialLead[];
  reagendadosList:  ComercialLead[];
  fetchedAt:        number;
}
const branchEnrollCache: Record<string, BranchEnrollmentsData> = {};

/** Cache do XLSX Fecharam (global, 1 entrada por data). */
interface FecharamData {
  fecharam:     Record<string, number>;
  fecharamList: Record<string, ComercialLead[]>;
  fetchedAt:    number;
}
const fecharamCache: Record<string, FecharamData> = {};

/** Hidrata caches do localStorage no boot. Aceita corrupção silenciosamente. */
(function hydrateComercialCache() {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(COMERCIAL_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      branchEnrollCache?: Record<string, BranchEnrollmentsData>;
      fecharamCache?: Record<string, FecharamData>;
    };
    const now = Date.now();
    if (parsed.branchEnrollCache) {
      for (const [k, v] of Object.entries(parsed.branchEnrollCache)) {
        if (now - v.fetchedAt < COMERCIAL_CACHE_TTL) branchEnrollCache[k] = v;
      }
    }
    if (parsed.fecharamCache) {
      for (const [k, v] of Object.entries(parsed.fecharamCache)) {
        if (now - v.fetchedAt < COMERCIAL_CACHE_TTL) fecharamCache[k] = v;
      }
    }
  } catch (e) {
    console.warn('[EVO Comercial] cache hydrate falhou:', e);
  }
})();

function persistComercialCache() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COMERCIAL_LS_KEY, JSON.stringify({ branchEnrollCache, fecharamCache }));
  } catch (e) {
    // Pode dar QuotaExceeded se tiver muito dado — tudo bem, só pula
    console.warn('[EVO Comercial] cache persist falhou:', e);
  }
}

interface EvoSession {
  idAtividadeSessao?: number;
  idActivity?: number;
  name?: string;
  ocupation?: number;
  startTime?: string;
  status?: number;       // 6=Finalized (aula já rolou) · 3=BookingEnded (vai rolar)
  statusName?: string;
}

interface EvoEnrollment {
  idMember?: number | null;
  idProspect?: number | null;
  idEmployee?: number | null;
  name?: string | null;
  status?: number;
  // 0=Attending(Compareceu), 1=Absent(Faltou), 2=JustifiedAbsence(Reagendou)
}

interface EvoSessionDetail {
  enrollments?: EvoEnrollment[];
}

function emptyComercialAuto(): ComercialAutoData {
  const r: ComercialAutoData = {
    agendados: {}, compareceram: {}, faltaram: {}, reagendados: {}, fecharam: {},
    agendadosList: {}, compareceramList: {}, faltaramList: {}, reagendadosList: {}, fecharamList: {},
    fetchedAt: Date.now(), hasError: false,
  };
  for (const branchName of Object.values(EVO_FILIAL_TO_BRANCH)) {
    r.agendados[branchName] = 0;
    r.compareceram[branchName] = 0;
    r.faltaram[branchName] = 0;
    r.reagendados[branchName] = 0;
    r.fecharam[branchName] = 0;
    r.agendadosList[branchName] = [];
    r.compareceramList[branchName] = [];
    r.faltaramList[branchName] = [];
    r.reagendadosList[branchName] = [];
    r.fecharamList[branchName] = [];
  }
  return r;
}

/**
 * Busca SÓ o Fecharam (XLSX management/prospects). 1 chamada cobre todas as unidades.
 * Rápido (<2s) e barato em rate-limit. Cache 30min.
 */
async function fetchFecharamData(date: string): Promise<FecharamData> {
  const cached = fecharamCache[date];
  if (cached && Date.now() - cached.fetchedAt < COMERCIAL_CACHE_TTL) return cached;

  const fecharam: Record<string, number> = {};
  const fecharamList: Record<string, ComercialLead[]> = {};
  for (const bn of Object.values(EVO_FILIAL_TO_BRANCH)) {
    fecharam[bn] = 0;
    fecharamList[bn] = [];
  }

  const anyCfg = Object.values(UNITS).find(u => !!u.token);
  if (!anyCfg?.token) return { fecharam, fecharamList, fetchedAt: Date.now() };

  try {
    const url = `${EVO_BASE}/api/v2/management/prospects?dtStart=${date}T00:00:00&dtEnd=${date}T23:59:59`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${getAuth(anyCfg.token)}` } });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const { read, utils } = await import('xlsx');
      const wb = read(buf, { type: 'array' });
      const rows = utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: null });
      const [y, m, d] = date.split('-');
      const targetDmy = `${d}/${m}/${y}`;
      for (const r of rows) {
        if (r.Status !== 'CLIENTE') continue;
        if (r.DtConversao !== targetDmy) continue;
        const bn = EVO_FILIAL_TO_BRANCH[Number(r.IdFilial)];
        if (!bn) continue;
        fecharam[bn] = (fecharam[bn] ?? 0) + 1;
        fecharamList[bn].push({
          id:           Number(r.IdCliente) || Number(r.IdProspect) || 0,
          kind:         r.IdCliente ? 'member' : 'prospect',
          name:         String(r.Nome ?? '').trim(),
          registerDate: r.DtCadastro ? String(r.DtCadastro) : undefined,
          membership:   r.PrimeiroContrato ? String(r.PrimeiroContrato) : (r.Descricao ? String(r.Descricao) : undefined),
        });
      }
    }
  } catch (err) {
    console.warn(`[EVO Fecharam] erro:`, err);
  }

  const result = { fecharam, fecharamList, fetchedAt: Date.now() };
  fecharamCache[date] = result;
  persistComercialCache();
  return result;
}

/**
 * Busca enrollments de aula experimental de UMA unidade num dia.
 *
 * Regra de identificação (validada em 11/05/2026):
 *   - enrollment com idProspect != null → aula experimental (prospect ainda não paga
 *     plano, então qualquer aula que ele faz é experimental). Ex: ERICO 43275 e
 *     MARIANA 43276 na session 757648 — batem exatamente com a tela EVO Web.
 *   - enrollment com idMember criado no mesmo dia (registerDate.startsWith(date)) →
 *     também é aula experimental. Ex: NOEMI 19274 criada hoje 17:16, fez aula 16:00.
 *
 * Custo: 1 GET /members (lista criados no dia) + 1 GET /schedule + ~80 GET /detail.
 * A 1200ms entre requests = ~1.5min por unidade. Cache 30min por (date+branch).
 */
/** Verifica se branch tem cache válido (sem fazer chamadas). */
export function hasComercialCache(date: string, branchName: string): boolean {
  const cached = branchEnrollCache[`${date}:${branchName}`];
  return !!(cached && Date.now() - cached.fetchedAt < COMERCIAL_CACHE_TTL);
}

/**
 * Wrapper exposto: busca enrollments de UMA unidade (com cache).
 * `force=true` ignora o cache e re-puxa do EVO — usado pelo botão "Atualizar EVO".
 */
export async function fetchBranchEnrollmentsSingle(date: string, branchName: string, force = false): Promise<BranchEnrollmentsData> {
  return fetchBranchEnrollments(date, branchName, force);
}

async function fetchBranchEnrollments(date: string, branchName: string, force = false): Promise<BranchEnrollmentsData> {
  const cacheKey = `${date}:${branchName}`;
  const cached = branchEnrollCache[cacheKey];
  if (!force && cached && Date.now() - cached.fetchedAt < COMERCIAL_CACHE_TTL) {
    return cached;
  }

  const result: BranchEnrollmentsData = {
    agendados: 0, compareceram: 0, faltaram: 0, reagendados: 0,
    agendadosList: [], compareceramList: [], faltaramList: [], reagendadosList: [],
    fetchedAt: Date.now(),
  };

  const cfg = UNITS[branchName];
  if (!cfg?.token) return result;

  // EVO idBranch ≠ nosso interno (EVO pulou ID 2 — Saúde é 3 no EVO).
  // Reverse mapping de EVO_FILIAL_TO_BRANCH pra garantir que pedimos sempre da
  // unidade certa, mesmo que o token tenha visibilidade multi-unidade.
  const evoIdBranch = Number(Object.entries(EVO_FILIAL_TO_BRANCH).find(([, v]) => v === branchName)?.[0]) || cfg.idBranch;

  try {
    // 1) Members criados no dia COM membership ativo → considerados aula experimental.
    //    Validado: NOEMI (active+BE FREE) entra; PATRICIA/GISELE (Inactive sem
    //    membership) não entram — bate com o que aparece no EVO Web.
    const newMembersSet = new Set<number>();
    try {
      const memData = await evoGet(
        `/api/v2/members?registerDateStart=${date}T00:00:00&registerDateEnd=${date}T23:59:59&take=50&showMemberships=true&idBranch=${evoIdBranch}`,
        cfg.token,
      );
      type MemberLite = {
        idMember?: number;
        membershipStatus?: string;
        memberships?: Array<{ membershipStatus?: string }>;
      };
      const obj = memData as { list?: MemberLite[] } | MemberLite[];
      const list = Array.isArray(obj) ? obj : (obj.list ?? []);
      for (const m of list) {
        if (!m.idMember) continue;
        const isActive = m.membershipStatus === 'Active'
          || m.memberships?.some(mm => (mm.membershipStatus ?? '').toLowerCase() === 'active');
        if (isActive) {
          newMembersSet.add(m.idMember);
        }
      }
    } catch (err) {
      console.warn(`[EVO Comercial] ${branchName} members erro:`, err);
    }

    // 2) Prospects RECENTES (últimos 60 dias) — pra ler currentStep e excluir os
    //    que estão em etapa anterior à aula experimental ("Contato Inicial (IA)").
    //    Janela ampla porque um prospect criado em data anterior pode ainda
    //    aparecer enrolled em uma session de hoje (caso Julia 43377 em Saúde).
    const excludedProspects = new Set<number>();
    try {
      const sixtyDaysAgo = new Date(date);
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const startStr = localYMD(sixtyDaysAgo);
      // Pagina pra pegar todos (limite por página é 50, max 1000)
      const all: Array<{ idProspect?: number; currentStep?: string }> = [];
      let skip = 0;
      while (skip < 1000) {
        const proData = await evoGet(
          `/api/v1/prospects?registerDateStart=${startStr}T00:00:00&registerDateEnd=${date}T23:59:59&take=50&skip=${skip}`,
          cfg.token,
        );
        const list = Array.isArray(proData) ? proData as Array<{ idProspect?: number; currentStep?: string }> : [];
        if (list.length === 0) break;
        all.push(...list);
        if (list.length < 50) break;
        skip += 50;
      }
      for (const p of all) {
        if (!p.idProspect) continue;
        const step = (p.currentStep ?? '').toLowerCase();
        if (step.includes('contato inicial') || step.includes('sem interesse')) {
          excludedProspects.add(p.idProspect);
        }
      }
    } catch (err) {
      console.warn(`[EVO Comercial] ${branchName} prospects erro:`, err);
    }

    // 3) Lista sessions do dia (com idBranch explícito pra garantir só sessions da unidade)
    const schedData = await evoGet(
      `/api/v1/activities/schedule?date=${date}&take=200&showFullWeek=false&idBranch=${evoIdBranch}`,
      cfg.token,
    );
    const sessions: EvoSession[] = Array.isArray(schedData) ? schedData as EvoSession[] : [];
    const ocupadas = sessions.filter(s => (s.ocupation ?? 0) > 0 && s.idAtividadeSessao);

    // 4) Detail de cada ocupada — SEQUENCIAL, salvando cache parcial a cada session.
    // Se travar no meio (429 esgotado, network drop), o que já foi processado
    // fica gravado em branchEnrollCache + localStorage. Próximo Sync continua.
    let done = 0;
    for (const s of ocupadas) {
      try {
        const d = await evoGet(`/api/v1/activities/schedule/detail?idActivitySession=${s.idAtividadeSessao}`, cfg.token);
        const detail = d as EvoSessionDetail | null;
        if (detail) {
          const sessionFinalized = s.status === 6;
          for (const e of detail.enrollments ?? []) {
            const isExpProspect = !!e.idProspect && !excludedProspects.has(e.idProspect);
            const isExpMember   = !!e.idMember && newMembersSet.has(e.idMember);
            if (!isExpProspect && !isExpMember) continue;

            const lead: ComercialLead = {
              id:   e.idProspect ?? e.idMember ?? 0,
              kind: isExpProspect ? 'prospect' : 'member',
              name: (e.name ?? '').trim(),
              registerDate: s.startTime ? `${date}T${s.startTime}` : undefined,
              membership:   s.name,
            };
            result.agendados++;
            result.agendadosList.push(lead);
            if (sessionFinalized) {
              if      (e.status === 0) { result.compareceram++; result.compareceramList.push(lead); }
              else if (e.status === 1) { result.faltaram++;     result.faltaramList.push(lead); }
            }
            if (e.status === 2) { result.reagendados++; result.reagendadosList.push(lead); }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[EVO Comercial] ${branchName}: session ${s.idAtividadeSessao} falhou — ${errMsg}`);
      }

      done++;
      // Salva cache parcial a cada session (incremental save)
      result.fetchedAt = Date.now();
      branchEnrollCache[cacheKey] = result;
      if (done % 10 === 0) {
        persistComercialCache();
      }
    }

    persistComercialCache();
  } catch (err) {
    console.warn(`[EVO Comercial] ${branchName} erro:`, err);
  }

  return result;
}

/**
 * Busca dados auto da tela Comercial só pras unidades visíveis ao user (não todas
 * as 7), em paralelo. Aceita callback `onBranchReady` pra UI ir atualizando
 * progressivamente conforme cada unidade termina.
 *
 * Custo: Fecharam (~1 call) + ~80 calls/unidade visível a 700ms entre requests (rate-limit EVO).
 * 1 unidade = ~1min · 3 unidades = ~3min · 7 unidades = ~7min (sem contar retries 429).
 */
export async function fetchEvoComercialAuto(
  date: string,
  branchNames?: string[],
  onBranchReady?: (branchName: string, partial: ComercialAutoData) => void,
): Promise<ComercialAutoData> {
  // Default = todas as branches mapeadas. [] explícito = só Fecharam + cache.
  const branchesToLoad = branchNames ?? Object.values(EVO_FILIAL_TO_BRANCH);
  const allKnownBranches = Object.values(EVO_FILIAL_TO_BRANCH);

  // Caso especial: branchesToLoad vazio = não dispara varredura, só Fecharam + cache existente
  if (branchesToLoad.length === 0) {
    await fetchFecharamData(date);
    return buildResultFromCaches(date, allKnownBranches);
  }

  // Verifica se já temos tudo em cache — se sim, retorna direto
  const allCached = branchesToLoad.every(bn => {
    const c = branchEnrollCache[`${date}:${bn}`];
    return c && Date.now() - c.fetchedAt < COMERCIAL_CACHE_TTL;
  });
  if (allCached && fecharamCache[date]) {
    return buildResultFromCaches(date, allKnownBranches);
  }

  const result = emptyComercialAuto();

  // 1) Fecharam (rápido, espera essa antes de retornar)
  const fech = await fetchFecharamData(date);
  for (const bn of Object.keys(fech.fecharam)) {
    result.fecharam[bn]     = fech.fecharam[bn];
    result.fecharamList[bn] = fech.fecharamList[bn];
  }

  // 2) Enrollments por branch — SEQUENCIAL (o evoQueue serializa de qualquer jeito;
  // sequencial dá feedback mais cedo: primeira unidade termina em ~96s, não no fim
  // de 7 × 96s = 11min). Callback progressivo atualiza UI a cada unidade pronta.
  for (const bn of branchesToLoad) {
    const data = await fetchBranchEnrollments(date, bn);
    result.agendados[bn]    = data.agendados;
    result.compareceram[bn] = data.compareceram;
    result.faltaram[bn]     = data.faltaram;
    result.reagendados[bn]  = data.reagendados;
    result.agendadosList[bn]    = data.agendadosList;
    result.compareceramList[bn] = data.compareceramList;
    result.faltaramList[bn]     = data.faltaramList;
    result.reagendadosList[bn]  = data.reagendadosList;

    if (onBranchReady) {
      const snapshot = buildResultFromCaches(date, branchesToLoad);
      onBranchReady(bn, snapshot);
    }
  }

  comercialCache[date] = result;
  return result;
}

function buildResultFromCaches(date: string, branchNames: string[]): ComercialAutoData {
  const result = emptyComercialAuto();
  const fech = fecharamCache[date];
  if (fech) {
    for (const bn of Object.keys(fech.fecharam)) {
      result.fecharam[bn]     = fech.fecharam[bn];
      result.fecharamList[bn] = fech.fecharamList[bn];
    }
  }
  for (const bn of branchNames) {
    const data = branchEnrollCache[`${date}:${bn}`];
    if (!data) continue;
    result.agendados[bn]    = data.agendados;
    result.compareceram[bn] = data.compareceram;
    result.faltaram[bn]     = data.faltaram;
    result.reagendados[bn]  = data.reagendados;
    result.agendadosList[bn]    = data.agendadosList;
    result.compareceramList[bn] = data.compareceramList;
    result.faltaramList[bn]     = data.faltaramList;
    result.reagendadosList[bn]  = data.reagendadosList;
  }
  return result;
}

/** Backward-compat: wrapper que retorna só Fecharam. Mantido pra não quebrar consumers. */
export async function fetchEvoFecharamDoDia(date: string): Promise<{
  fecharam: Record<string, number>;
  fetchedAt: number;
  hasError: boolean;
}> {
  const data = await fetchFecharamData(date);
  return { fecharam: data.fecharam, fetchedAt: data.fetchedAt, hasError: false };
}

// ─── Ocupação das AULAS (modalidade × dia da semana) ─────────────────────────
//
// DIFERENTE de fetchOccupation (catraca / lotação física AGORA). Aqui medimos a
// ocupação das AULAS agendadas: por modalidade e por dia da semana.
// Fonte: GET /api/v1/activities/schedule?showFullWeek=true — cada sessão traz
//   name (modalidade), capacity (vagas), ocupation (vagas ocupadas), instructor,
//   area, activityDate, startTime/endTime, statusName.
// Doc/Swagger: https://evo-integracao.w12app.com.br/swagger/index.html
//
// ─── Inteligência anti-429 (rate limit da EVO) ────────────────────────────────
//   1) UMA chamada por unidade (a semana inteira vem de uma vez) → 7 reqs no total,
//      e não ~80/unidade como a varredura do Comercial.
//   2) Todas passam pela evoQueue (700ms/req) + retry exponencial em 429 (evoGet).
//   3) Cache local (localStorage, 10min) → navegação não refaz.
//   4) Snapshot COMPARTILHADO no servidor (/api/snapshot?key=class_occupation):
//      o 1º cliente busca na EVO e PUBLICA; os demais leem o snapshot e NEM TOCAM
//      na EVO durante a janela. Só o botão "Atualizar" (force) bate na EVO e
//      republica. Mesmo padrão do snapshot do Painel.
//   5) Dedupe de chamadas concorrentes (classOccInFlight) → vários componentes
//      montando ao mesmo tempo não disparam varreduras paralelas.

/** Linha crua de /activities/schedule (só os campos que usamos). */
interface ScheduleApiRow {
  name?: string;
  capacity?: number;
  ocupation?: number;
  instructor?: string;
  area?: string;
  activityDate?: string;   // ISO date-time
  startTime?: string;
  endTime?: string;
  statusName?: string;
  idActivitySession?: number;
  idAtividadeSessao?: number;
}

/** Sessão de aula normalizada. weekday: 0=Seg … 6=Dom. */
export interface ClassSession {
  unit: string;
  modality: string;
  instructor: string;
  area: string;
  date: string;        // YYYY-MM-DD
  weekday: number;     // 0=Seg .. 6=Dom
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm
  capacity: number;
  ocupation: number;
  statusName: string;
}

export interface ClassOccupationUnit {
  name: string;
  idBranch: number;
  hasError: boolean;
  sessions: ClassSession[];
  totalCapacity: number;
  totalOccupation: number;
  pct: number;          // 0..100
  sessionCount: number;
}

export interface ClassOccupationData {
  byUnit: ClassOccupationUnit[];
  fetchedAt: number;
  hasAnyError: boolean;
  weekStart: string;    // YYYY-MM-DD (menor activityDate visto)
  weekEnd: string;      // YYYY-MM-DD (maior activityDate visto)
}

/** 'YYYY-MM-DD' → weekday 0=Seg..6=Dom (TZ-safe, sem passar por UTC). */
function weekdayMondayFirst(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const js = new Date(y, (m || 1) - 1, d || 1).getDay(); // 0=Dom..6=Sáb
  return (js + 6) % 7;                                    // 0=Seg..6=Dom
}

/** IdFilial da EVO p/ a unidade (offset +1 vs idBranch local; a EVO pulou o id 2). */
function evoFilialId(name: string): number {
  const found = Object.entries(EVO_FILIAL_TO_BRANCH).find(([, v]) => v === name)?.[0];
  return Number(found) || UNITS[name]?.idBranch || 0;
}

/** Busca a agenda da semana de UMA unidade (1 request, via fila + backoff). */
async function fetchClassScheduleForUnit(name: string): Promise<ClassOccupationUnit> {
  const cfg = UNITS[name];
  const idBranch = cfg?.idBranch ?? 0;
  if (!cfg?.token) {
    return { name, idBranch, hasError: true, sessions: [], totalCapacity: 0, totalOccupation: 0, pct: 0, sessionCount: 0 };
  }
  try {
    const evoId = evoFilialId(name);
    const path = `/api/v1/activities/schedule?showFullWeek=true&take=1000${evoId ? `&idBranch=${evoId}` : ''}`;
    const data = await evoGet(path, cfg.token);
    const rows = (Array.isArray(data) ? data : extractArray(data)) as ScheduleApiRow[];
    const sessions: ClassSession[] = [];
    let totalCap = 0;
    let totalOcc = 0;
    for (const r of rows) {
      const dateRaw = String(r.activityDate ?? '').slice(0, 10);
      if (!dateRaw) continue;
      const cap = Math.max(0, Number(r.capacity) || 0);
      const occ = Math.max(0, Number(r.ocupation) || 0);
      sessions.push({
        unit: name,
        modality: String(r.name ?? '').trim() || '—',
        instructor: String(r.instructor ?? '').trim(),
        area: String(r.area ?? '').trim(),
        date: dateRaw,
        weekday: weekdayMondayFirst(dateRaw),
        startTime: String(r.startTime ?? '').slice(0, 5),
        endTime: String(r.endTime ?? '').slice(0, 5),
        capacity: cap,
        ocupation: occ,
        statusName: String(r.statusName ?? '').trim(),
      });
      totalCap += cap;
      totalOcc += occ;
    }
    return {
      name, idBranch, hasError: false, sessions,
      totalCapacity: totalCap, totalOccupation: totalOcc,
      pct: totalCap > 0 ? (totalOcc / totalCap) * 100 : 0,
      sessionCount: sessions.length,
    };
  } catch (err) {
    console.error(`[EVO ClassOccupation] ${name} falhou:`, err);
    return { name, idBranch, hasError: true, sessions: [], totalCapacity: 0, totalOccupation: 0, pct: 0, sessionCount: 0 };
  }
}

const CLASS_OCC_CACHE_KEY = 'gb_class_occupation_v1';
const CLASS_OCC_TTL = 10 * 60 * 1000;          // cache local: 10 min
const CLASS_OCC_SHARED_TTL = 30 * 60 * 1000;   // aceita snapshot compartilhado até 30 min

function readLocalClassOcc(): ClassOccupationData | null {
  try {
    const raw = localStorage.getItem(CLASS_OCC_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ClassOccupationData;
  } catch { return null; }
}
function writeLocalClassOcc(data: ClassOccupationData): void {
  try { localStorage.setItem(CLASS_OCC_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
}

/** Varredura real na EVO (7 unidades, fila serializa) + publica snapshot. Dedupe. */
let classOccInFlight: Promise<ClassOccupationData> | null = null;
function refreshClassOccupationFromEvo(): Promise<ClassOccupationData> {
  if (classOccInFlight) return classOccInFlight;     // dedupe concorrente
  classOccInFlight = (async () => {
    try {
      const names = Object.keys(UNITS);
      const settled = await Promise.allSettled(names.map(n => fetchClassScheduleForUnit(n)));
      const byUnit: ClassOccupationUnit[] = [];
      let hasAnyError = false;
      let minDate = '';
      let maxDate = '';
      settled.forEach((s, i) => {
        const name = names[i];
        if (s.status === 'fulfilled') {
          byUnit.push(s.value);
          if (s.value.hasError) hasAnyError = true;
          for (const sess of s.value.sessions) {
            if (!minDate || sess.date < minDate) minDate = sess.date;
            if (!maxDate || sess.date > maxDate) maxDate = sess.date;
          }
        } else {
          console.error(`[EVO ClassOccupation] ${name} rejeitou:`, s.reason);
          byUnit.push({ name, idBranch: UNITS[name].idBranch, hasError: true, sessions: [], totalCapacity: 0, totalOccupation: 0, pct: 0, sessionCount: 0 });
          hasAnyError = true;
        }
      });
      const result: ClassOccupationData = { byUnit, fetchedAt: Date.now(), hasAnyError, weekStart: minDate, weekEnd: maxDate };
      writeLocalClassOcc(result);
      // Publica pros outros usuários SÓ se veio dado real (não congela uma falha total).
      if (byUnit.some(u => u.sessionCount > 0)) {
        fetch('/api/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'class_occupation', payload: result }),
        }).catch(() => { /* melhor esforço — local já está atualizado */ });
      }
      return result;
    } finally {
      classOccInFlight = null;
    }
  })();
  return classOccInFlight;
}

/**
 * Ocupação das aulas da semana, por unidade. Estratégia anti-429 em cascata:
 *   force=false → cache local fresco → snapshot compartilhado do servidor →
 *                 stale local (revalida em bg) → EVO (último recurso).
 *   force=true  → ignora caches, bate na EVO e republica o snapshot.
 */
export async function fetchClassOccupation(force = false): Promise<ClassOccupationData> {
  if (!force) {
    // (a) cache local fresco — instantâneo, zero rede
    const local = readLocalClassOcc();
    if (local && Date.now() - local.fetchedAt < CLASS_OCC_TTL) return local;

    // (b) snapshot COMPARTILHADO (outro cliente já buscou na EVO nesta janela)
    try {
      const r = await fetch('/api/snapshot?key=class_occupation');
      if (r.ok) {
        const j = await r.json();
        const ts = j?.updated_at ? new Date(j.updated_at).getTime() : 0;
        if (j?.payload && ts > 0 && Date.now() - ts < CLASS_OCC_SHARED_TTL) {
          const shared = j.payload as ClassOccupationData;
          writeLocalClassOcc(shared);
          return shared;
        }
      }
    } catch { /* servidor sem snapshot → segue pro fluxo EVO */ }

    // (c) stale local — devolve já e revalida em background (sem travar a UI)
    if (local) {
      void refreshClassOccupationFromEvo().catch(() => { /* bg */ });
      return local;
    }
  }
  // (d) force, ou nenhum cache disponível → busca na EVO (fila + backoff) e publica
  return refreshClassOccupationFromEvo();
}

// ─── Agregação PURA (testável) — modalidade × dia da semana ───────────────────

export interface OccCell {
  capacity: number;
  ocupation: number;
  pct: number;        // 0..100 (0 se capacity == 0)
  sessions: number;
}
export interface OccMatrix {
  modalities: string[];                  // ordenadas por pct desc
  weekdays: number[];                    // dias presentes (0=Seg..6=Dom), asc
  cell: Record<string, OccCell>;         // chave `${modality}|${weekday}`
  modalityTotals: Record<string, OccCell>;
  dayTotals: Record<number, OccCell>;
  grand: OccCell;
}

const mkCell = (): OccCell => ({ capacity: 0, ocupation: 0, pct: 0, sessions: 0 });
const withPct = (c: OccCell): OccCell => ({ ...c, pct: c.capacity > 0 ? (c.ocupation / c.capacity) * 100 : 0 });

/**
 * Agrega sessões em matriz modalidade × dia da semana. Numa célula com várias
 * sessões (ex.: Yoga seg 07h e seg 18h), soma capacity e ocupation e divide —
 * exatamente como o doc de integração descreve a "taxa por modalidade".
 * collectiveOnly=true ignora sessões com capacity <= 1 (ex.: Massagem individual).
 */
export function buildOccupationMatrix(sessions: ClassSession[], collectiveOnly = false): OccMatrix {
  const cell: Record<string, OccCell> = {};
  const modalityTotals: Record<string, OccCell> = {};
  const dayTotals: Record<number, OccCell> = {};
  const grand = mkCell();
  const daysSet = new Set<number>();

  for (const s of sessions) {
    if (collectiveOnly && s.capacity <= 1) continue;
    const key = `${s.modality}|${s.weekday}`;
    if (!cell[key]) cell[key] = mkCell();
    if (!modalityTotals[s.modality]) modalityTotals[s.modality] = mkCell();
    if (!dayTotals[s.weekday]) dayTotals[s.weekday] = mkCell();
    for (const c of [cell[key], modalityTotals[s.modality], dayTotals[s.weekday], grand]) {
      c.capacity += s.capacity;
      c.ocupation += s.ocupation;
      c.sessions += 1;
    }
    daysSet.add(s.weekday);
  }

  for (const k in cell) cell[k] = withPct(cell[k]);
  for (const k in modalityTotals) modalityTotals[k] = withPct(modalityTotals[k]);
  for (const k in dayTotals) dayTotals[Number(k)] = withPct(dayTotals[Number(k)]);

  const modalities = Object.keys(modalityTotals)
    .sort((a, b) => modalityTotals[b].pct - modalityTotals[a].pct || a.localeCompare(b));
  const weekdays = [...daysSet].sort((a, b) => a - b);
  return { modalities, weekdays, cell, modalityTotals, dayTotals, grand: withPct(grand) };
}
