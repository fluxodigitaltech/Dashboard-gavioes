// Fonte de dados via SCRAPER (conta web EVO5), usada quando a franqueadora não
// libera a API de integração (caso Gaviões). Busca o snapshot gerencial do
// serviço evo-scraper e mapeia pro mesmo contrato BranchStats que o dashboard
// já consome — então as telas funcionam sem mudança.
//
// O scraper roda separado (pasta evo-scraper/, `npm run dev`, porta 8088).
// Em dev, o Vite faz proxy de /scraper → http://localhost:8088 injetando o
// Authorization: Bearer (token NÃO vai pro bundle). Ver vite.config.ts.
import type { BranchStats, BranchPlanBreakdown } from './evoApi';

// Base do scraper atrás do proxy. Em prod, configure o mesmo path no nginx.
const BASE = (import.meta.env.VITE_SCRAPER_BASE as string | undefined)?.replace(/\/$/, '') || '/scraper';

/** Shape do snapshot que o scraper devolve em GET /data (extractors/gerencial). */
interface ScraperSnapshot {
  branchId: string;
  capturadoEm: string;
  clientesAtivos: number;
  clientesAtivosMesAnterior: number;
  adimplentes: number;
  inadimplentes: number;
  vips: number;
  suspensos: number;
  personais: number;
  agregadores: number;
  evasaoPerc: number | null;
  tempoMedioVida: number | null;
  cancelamentosMes: number | null;
  cancelamentosHoje: number | null;
  checkinsPeriodo: number | null;
  faturamentoPago: number | null;
  faturamentoPagoMesAnterior: number | null;
  faturamentoEmCobranca: number | null;
  faturamentoTentativasExcedidas: number | null;
  faturamentoProgramado: number | null;
  faturamentoTotal: number | null;
  vendasValor: number | null;
  vendasQtd: number | null;
  vendasValorMesAnterior: number | null;
  vendasQtdMesAnterior: number | null;
  jaPagaramQtd?: number | null;                     // Extrato aprovado na semana (qtd)
  jaPagaramValor?: number | null;                   // Extrato aprovado na semana (valor)
  planosBase?: { plano: string; qtde: number }[];   // base ativa por plano (Termômetro)
  erros: string[];
}

/** Nome amigável da unidade por idBranch (ajuste conforme as unidades reais). */
const BRANCH_LABELS: Record<string, { name: string; location: string }> = {
  '59': { name: 'Gaviões', location: '' },
};

function toBranchStats(s: ScraperSnapshot): BranchStats {
  const label = BRANCH_LABELS[s.branchId] ?? { name: `Filial ${s.branchId}`, location: '' };
  const adimplentes = s.adimplentes ?? 0;
  const inadimplentes = s.inadimplentes ?? 0;
  return {
    name: label.name,
    location: label.location,
    idBranch: Number(s.branchId) || 0,

    activeMembers: s.clientesAtivos ?? adimplentes + inadimplentes,
    adimplentesMembers: adimplentes,
    inadimplentesMembers: inadimplentes,
    vipMembers: s.vips ?? 0,
    // Faturamento = card "Pago" da Recorrência no mês (somatoria.totalPago)
    faturamentoAdimplentes: s.faturamentoPago ?? 0,
    // "em risco" ≈ em cobrança + tentativas excedidas (recorrências ainda não pagas)
    faturamentoInadimplentes: (s.faturamentoEmCobranca ?? 0) + (s.faturamentoTentativasExcedidas ?? 0),
    idsAdimplentes: [],
    idsInadimplentes: [],
    vendasMesValor: s.vendasValor ?? 0,
    vendasMesQtd: s.vendasQtd ?? 0,
    vendasMesComplete: s.vendasValor != null,
    vendasMesList: [],

    // mês anterior: o gerencial só dá o total de ativos do mês passado
    activeMembersPrev: s.clientesAtivosMesAnterior ?? 0,
    adimplentesMembersPrev: 0,
    inadimplentesMembersPrev: 0,
    faturamentoAdimplentesPrev: s.faturamentoPagoMesAnterior ?? 0,
    faturamentoInadimplentesPrev: 0,
    vendasMesValorPrev: s.vendasValorMesAnterior ?? 0,
    vendasMesQtdPrev: s.vendasQtdMesAnterior ?? 0,
    vendasMesPrevComplete: s.vendasValorMesAnterior != null,

    // sem histórico de 1 ano via gerencial
    activeMembers1y: 0,
    adimplentesMembers1y: 0,
    vipMembers1y: 0,
    faturamentoAdimplentes1y: 0,
    faturamentoInadimplentes1y: 0,
    has1yData: false,
    vendasMesValor1y: 0,
    vendasMesQtd1y: 0,
    vendasMes1yComplete: false,
    has1yVendas: false,

    cancelamentosMes: s.cancelamentosMes ?? 0,
    cancelamentosMesComplete: s.cancelamentosMes != null,

    cancelledMembers: s.cancelamentosMes ?? 0,
    inactiveMembers: inadimplentes, // alias legacy
    hasError: false,
    lastUpdate: s.capturadoEm ? Date.parse(s.capturadoEm) : Date.now(),

    // Faturamento (Recorrência): REAL = Pago, ESTIMADO = Total
    faturamentoPagoMes: s.faturamentoPago ?? 0,
    faturamentoTotalMes: s.faturamentoTotal ?? 0,
    // "Já pagaram" = cobranças aprovadas na semana (Extrato)
    jaPagaramQtd: s.jaPagaramQtd ?? null,
    jaPagaramValor: s.jaPagaramValor ?? null,
  };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`scraper ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Dispara um sync no scraper e aguarda terminar (polling). */
async function runSync(): Promise<void> {
  const { jobId } = await getJson<{ jobId: string }>('/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const job = await getJson<{ status: string }>(`/sync/${jobId}`);
    if (job.status === 'done') return;
    if (job.status === 'failed') throw new Error('sync do scraper falhou');
  }
  throw new Error('sync do scraper expirou (timeout)');
}

/**
 * Fonte de dados do dashboard quando rodando via scraper.
 * - force=false: devolve o último snapshot salvo (rápido). Se não houver, roda 1 sync.
 * - force=true: roda um sync novo (puxa da conta EVO agora) e devolve fresco.
 */
export async function fetchScraperBranchStats(force = false): Promise<BranchStats[]> {
  if (force) {
    await runSync();
  }
  let snap: ScraperSnapshot | null = null;
  try {
    snap = await getJson<ScraperSnapshot>('/data');
  } catch {
    // sem snapshot ainda → roda um sync e tenta de novo
    if (!force) { await runSync(); snap = await getJson<ScraperSnapshot>('/data'); }
    else throw new Error('scraper sem dados após sync');
  }
  return snap ? [toBranchStats(snap)] : [];
}

/**
 * Base ativa por plano (Termômetro de Planos) via SCRAPER. O snapshot traz a base
 * ATUAL agrupada por plano (planosBase, do Gerencial › Contratos do evo3). Não há
 * histórico por plano no scraper → só o mês corrente; meses passados = vazio.
 * O scraper não separa novo/antigo/valor → total=qtde, antigo=qtde, novo/valor=0.
 */
export async function fetchScraperPlansBreakdown(month: string): Promise<BranchPlanBreakdown[]> {
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month < cur) return []; // sem base histórica por plano no scraper

  let snap: ScraperSnapshot | null = null;
  try { snap = await getJson<ScraperSnapshot>('/data'); }
  catch { try { await runSync(); snap = await getJson<ScraperSnapshot>('/data'); } catch { return []; } }

  const base = snap?.planosBase ?? [];
  if (!base.length) return [];
  const label = BRANCH_LABELS[snap!.branchId] ?? { name: `Filial ${snap!.branchId}`, location: '' };
  const plans = base
    .map(p => ({ plano: p.plano, total: p.qtde, novo: 0, antigo: p.qtde, valor: 0 }))
    .sort((a, b) => b.total - a.total);
  const totalAtivos = plans.reduce((s, p) => s + p.total, 0);
  return [{ unitName: label.name, totalAtivos, plans }];
}
