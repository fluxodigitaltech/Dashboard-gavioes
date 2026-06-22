// Extractor consolidado dos KPIs gerenciais do EVO5 via chamadas API diretas
// (autenticadas pelo evoClient). Substitui o scraping de DOM/SPA do scaffold
// BlueFit — aqui temos os endpoints reais, descobertos via discovery.
//
// Convenções de data (descobertas no discovery):
//   - host evo-abc-api (dashboards/*):  data=MM-DD-YYYY
//   - host evo-abc-api-gerencial:        dataInicio/dataFim = Y-M-D (sem zero à esquerda)
import type { EvoClient } from '../evoClient.js';
import { extractVendas } from './vendas.js';
import { logger } from '../lib/logger.js';

const API = 'https://evo-abc-api.w12app.com.br';
const GER = 'https://evo-abc-api-gerencial.w12app.com.br';
// Faturamento = aba Recorrência (cobranças recorrentes), filtro "Data programada".
// O card "Pago" (somatoria.totalPago) é o faturamento efetivo do mês.
const COB = `${API}/api/v1/cobrancas/obterCobrancasRecorrencia`;

/** Início/fim do mês em ISO UTC = meia-noite BRT (T03:00:00.000Z), igual a SPA manda. */
function mesRangeISO(year: number, month1: number) {
  const de = new Date(Date.UTC(year, month1 - 1, 1, 3, 0, 0)).toISOString();
  const ate = new Date(Date.UTC(year, month1, 0, 3, 0, 0)).toISOString(); // dia 0 do próximo = último dia
  return { de, ate };
}

/** Corpo do obterCobrancasRecorrencia. take=1 porque só precisamos da `somatoria`
 *  (o agregado cobre todo o filtro, independente da paginação). Filtro por data PROGRAMADA. */
function cobBody(de: string, ate: string) {
  return {
    skip: 0, take: 1, ordem: 'Programada', ordemDirecao: 'desc',
    dtEfetivadaAte: '', dtEfetivadaDe: '',
    dtProgramadaAte: ate, dtProgramadaDe: de,
    idCliente: 0,
    idsConsultor: [], idsContratos: [], idsFormaPagamento: [],
    idsFormaPagamentoOriginal: [], idsServicos: [],
    motivoRecusa: '', statusCliente: [], statusTransacao: [],
    tentativas: '', tipoRecusa: null, valorOriginal: '',
  };
}

interface CobrancasResp {
  somatoria?: {
    totalPago: number;            // card "Pago" — faturamento efetivo
    emCobranca: number;
    tentativasExcedidas: number;
    programadas: number;
    total: number;                // card "Total"
  };
}

/** MM-DD-YYYY (formato dos endpoints dashboards/*). */
function mdy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getFullYear()}`;
}
/** Y-M-D sem zero à esquerda (formato do host gerencial). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Shape comum dos cards de cliente: { qtdeAtivos, qtdeAtivosMesAnterior, ... } */
interface CardQtde { qtdeAtivos?: number; qtdeAtivosMesAnterior?: number; metaAtivos?: number; percMeta?: number; }

export interface GerencialSnapshot {
  data: string;                 // data de referência (MM-DD-YYYY)
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
  renovacoes: number | null;
  cancelamentosMes: number | null;
  cancelamentosHoje: number | null;
  checkinsPeriodo: number | null;
  // Faturamento (Cobranças › Recorrência), filtro "Data programada: este mês".
  faturamentoPago: number | null;               // card "Pago" — faturamento efetivo do mês
  faturamentoPagoMesAnterior: number | null;
  faturamentoEmCobranca: number | null;         // card "Em cobrança"
  faturamentoTentativasExcedidas: number | null;// card "Tentativas excedidas"
  faturamentoProgramado: number | null;         // card "Programadas"
  faturamentoTotal: number | null;              // card "Total"
  // Vendas (EVO3, Gerencial › Vendas detalhadas), filtro DT_VENDA do mês.
  vendasValor: number | null;                   // soma VALOR_VENDA do mês
  vendasQtd: number | null;                     // qtd de vendas (Total)
  vendasValorMesAnterior: number | null;
  vendasQtdMesAnterior: number | null;
  erros: string[];
  raw: Record<string, unknown>; // payloads crus pra auditoria/reprocessamento
}

/** Roda uma chamada e captura erro sem abortar as outras. */
async function safe<T>(label: string, fn: () => Promise<T>, erros: string[]): Promise<T | null> {
  try { return await fn(); }
  catch (e) { const m = `${label}: ${(e as Error).message}`; logger.warn({ label }, m); erros.push(m); return null; }
}

export async function extractGerencial(client: EvoClient, ref = new Date()): Promise<GerencialSnapshot> {
  const data = mdy(ref);
  const q = `data=${data}&refresh=false`;
  const erros: string[] = [];
  const raw: Record<string, unknown> = {};

  const card = async (slug: string) => {
    const r = await safe<CardQtde>(slug, () => client.get<CardQtde>(`${API}/api/v1/dashboards/${slug}?${q}`), erros);
    if (r) raw[slug] = r;
    return r;
  };

  const [ativos, adimpl, inadimpl, vip, susp, pers, agreg] = await Promise.all([
    card('gerencial-clientesativos'),
    card('gerencial-clientesadimplentes'),
    card('gerencial-clientesinadimplentes'),
    card('gerencial-clientesvip'),
    card('gerencial-clientessuspensos'),
    card('gerencial-clientespersonais'),
    card('gerencial-clientesagregadores'),
  ]);

  // Evasão e tempo médio de vida têm shape próprio
  const evasao = await safe<{ quantidadeAtual?: number }>('gerencial-evasao',
    () => client.get(`${API}/api/v1/dashboards/gerencial-evasao?${q}`), erros);
  if (evasao) raw['gerencial-evasao'] = evasao;
  const tmv = await safe<{ quantidadeAtual?: number }>('gerencial-tempomediovida',
    () => client.get(`${API}/api/v1/dashboards/gerencial-tempomediovida?${q}`), erros);
  if (tmv) raw['gerencial-tempomediovida'] = tmv;
  const renov = await safe<CardQtde>('gerencial-renovacoes',
    () => client.get(`${API}/api/v1/dashboards/gerencial-renovacoes?${q}`), erros);
  if (renov) raw['gerencial-renovacoes'] = renov;

  // Cancelamentos: array {name,value} → soma. tipo=0
  const cancel = await safe<{ cancelamentos?: { name: string; value: number }[] }>('gerencial-contratoscancelados',
    () => client.get(`${API}/api/v1/dashboards/gerencial-contratoscancelados?${q}&tipo=0`), erros);
  if (cancel) raw['gerencial-contratoscancelados'] = cancel;
  const cancelHoje = await safe<CardQtde>('gerencial-contratoscanceladosdia',
    () => client.get(`${API}/api/v1/dashboards/gerencial-contratoscanceladosdia?${q}`), erros);
  if (cancelHoje) raw['gerencial-contratoscanceladosdia'] = cancelHoje;

  // Check-ins da semana corrente (host gerencial)
  const fim = new Date(ref);
  const inicio = new Date(ref); inicio.setDate(inicio.getDate() - 6);
  const checkins = await safe<{ totalCheckins?: number }>('checkins-dashboard',
    () => client.get(`${GER}/api/v1/gerencial/checkins-dashboard?dataInicio=${ymd(inicio)}&dataFim=${ymd(fim)}&tipoPessoas[0]=1`), erros);
  if (checkins) raw['checkins-dashboard'] = checkins;

  const sumCancel = cancel?.cancelamentos?.reduce((s, c) => s + (c.value || 0), 0) ?? null;

  // ── Faturamento (Cobranças › Extrato) — mês corrente + mês anterior ──────────
  const y = ref.getFullYear();
  const m = ref.getMonth() + 1; // 1-12
  const cur = mesRangeISO(y, m);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prev = mesRangeISO(prevY, prevM);

  const cobMes = await safe<CobrancasResp>('cobrancas-recorrencia-mes',
    () => client.post<CobrancasResp>(COB, cobBody(cur.de, cur.ate)), erros);
  if (cobMes) raw['cobrancas-recorrencia-mes'] = cobMes.somatoria;
  const cobPrev = await safe<CobrancasResp>('cobrancas-recorrencia-mes-anterior',
    () => client.post<CobrancasResp>(COB, cobBody(prev.de, prev.ate)), erros);
  if (cobPrev) raw['cobrancas-recorrencia-mes-anterior'] = cobPrev.somatoria;
  const som = cobMes?.somatoria;

  // ── Vendas (EVO3) — POR ÚLTIMO: faz SSO e move a página pra origin evo3 ──────
  const vendas = await safe('vendas', () => extractVendas(client, ref), erros);

  return {
    data,
    clientesAtivos: ativos?.qtdeAtivos ?? 0,
    clientesAtivosMesAnterior: ativos?.qtdeAtivosMesAnterior ?? 0,
    adimplentes: adimpl?.qtdeAtivos ?? 0,
    inadimplentes: inadimpl?.qtdeAtivos ?? 0,
    vips: vip?.qtdeAtivos ?? 0,
    suspensos: susp?.qtdeAtivos ?? 0,
    personais: pers?.qtdeAtivos ?? 0,
    agregadores: agreg?.qtdeAtivos ?? 0,
    evasaoPerc: evasao?.quantidadeAtual ?? null,
    tempoMedioVida: tmv?.quantidadeAtual ?? null,
    renovacoes: renov?.qtdeAtivos ?? null,
    cancelamentosMes: sumCancel,
    cancelamentosHoje: cancelHoje?.qtdeAtivos ?? null,
    checkinsPeriodo: checkins?.totalCheckins ?? null,
    faturamentoPago: som?.totalPago ?? null,
    faturamentoPagoMesAnterior: cobPrev?.somatoria?.totalPago ?? null,
    faturamentoEmCobranca: som?.emCobranca ?? null,
    faturamentoTentativasExcedidas: som?.tentativasExcedidas ?? null,
    faturamentoProgramado: som?.programadas ?? null,
    faturamentoTotal: som?.total ?? null,
    vendasValor: vendas?.valorMes ?? null,
    vendasQtd: vendas?.qtdMes ?? null,
    vendasValorMesAnterior: vendas?.valorMesAnterior ?? null,
    vendasQtdMesAnterior: vendas?.qtdMesAnterior ?? null,
    erros,
    raw,
  };
}
