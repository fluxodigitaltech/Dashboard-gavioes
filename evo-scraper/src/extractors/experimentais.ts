// Extractor de AULAS EXPERIMENTAIS — endpoint interno do painel gerencial do EVO
// (evo-abc-api-gerencial), o MESMO que alimenta a tela "Comercial / Aulas
// Experimentais" do dashboard. Esse endpoint NÃO está na API de integração (Basic
// token) — mora na API interna do painel web, atrás de Cloudflare + JWT da sessão.
// Por isso a chamada é feita de DENTRO do browser autenticado (evoClient.post →
// page.evaluate fetch), que já carrega JWT + cookies do Cloudflare.
//
// Portado da lógica do dashboard Goodbe (server/evoScraper.mjs). Diferença: a
// Gaviões é filial ÚNICA (59) — o evoClient já está logado na filial certa, então
// aqui NÃO tem troca de filial/empresa (toda a máquina de switchFilial do Goodbe
// não é necessária).
import type { EvoClient } from '../evoClient.js';
import { logger } from '../lib/logger.js';

const GERENCIAL = 'https://evo-abc-api-gerencial.w12app.com.br';
const PATH = '/api/v1/gerencial/obter-aula-experimental';

export interface ExpDay { agendados: number; compareceram: number; faltaram: number; reagendados: number; }
export interface ExpResult {
  byDay: Record<string, ExpDay>;
  totais: { agendados: number; compareceram: number; faltaram: number; reagendados: number; vendas: number };
  completo: boolean;
}

// Body do painel (filtro por data da atividade). O endpoint é nativo de intervalo:
// UMA chamada cobre o período inteiro do filtro do dashboard.
// ⚠️ timezone: o painel manda em Z (UTC). Brasil é UTC-3. Usa-se o range inteiro
// [from 00:00, to 23:59:59.999] em Z; se der off-by-one contra a tela, ajustar aqui.
function rangeBody(from: string, to: string) {
  return {
    skip: 0, take: 1000, ordem: 'ID_ATIVIDADE_SESSAO', ordemDirecao: 'DESC', colunas: '*',
    apenasMaisRecente: 0, comoConheceu: null, contratoComprado: null,
    dataInicioAtividade: `${from}T00:00:00.000Z`,
    dataFimAtividade: `${to}T23:59:59.999Z`,
    dataInicioPresenca: '', dataFimPresenca: '', dataInicioVenda: '', dataFimVenda: '',
    idAtividade: [], idContrato: [], idPasso: null, idProfessor: [], idResponsavelVenda: [],
    idServico: [], idTurma: null, origemVenda: [], status: null, temperatura: null,
    tipoAgendamento: null, tipoCadastro: [],
  };
}

interface GerRow { dataAtividade?: string; statusAluno?: number | string; dataPresenca?: string | null; idFilial?: number | string; }
interface GerResp { resultados?: GerRow[]; totalAulasAgendadas?: number; totalPresencas?: number; totalVendasNovosContratos?: number; }

/** DEBUG: devolve a estrutura crua do endpoint pra descobrir os nomes de campo reais. */
export async function debugExperimentais(client: EvoClient, from: string, to: string): Promise<unknown> {
  const raw = await client.post<Record<string, unknown>>(`${GERENCIAL}${PATH}`, rangeBody(from, to));
  const topKeys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
  // Acha o 1º array grande dentro da resposta (a "lista" de agendamentos, sob qualquer nome).
  let arrKey: string | null = null; let arr: unknown[] = [];
  for (const k of topKeys) {
    const v = (raw as Record<string, unknown>)[k];
    if (Array.isArray(v) && v.length > arr.length) { arr = v; arrKey = k; }
  }
  const numeric: Record<string, unknown> = {};
  for (const k of topKeys) { const v = (raw as Record<string, unknown>)[k]; if (typeof v === 'number') numeric[k] = v; }
  return {
    topKeys,
    numericFields: numeric,
    arrayKey: arrKey,
    arrayLen: arr.length,
    sampleRowKeys: arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0] as object) : null,
    sampleRow: arr[0] ?? null,
  };
}

/**
 * Raspa as aulas experimentais da unidade logada (filial 59) no intervalo [from,to]
 * e bucketiza por dia. Regra de contagem espelha o painel do EVO (Goodbe):
 *   agendados    = 1 por linha (cada agendamento)
 *   compareceram = statusAluno 0 COM dataPresenca (= totalPresencas do painel)
 *                  (statusAluno 2 = "Falta justificada": tem dataPresenca mas NÃO conta presença)
 *   faltaram     = dia JÁ PASSADO sem presença
 *   reagendados  = não vem no endpoint → 0 (segue manual/CENTRAL na tela)
 */
export async function extractExperimentais(client: EvoClient, from: string, to: string): Promise<ExpResult> {
  const json = await client.post<GerResp>(`${GERENCIAL}${PATH}`, rangeBody(from, to));
  const rows = Array.isArray(json?.resultados) ? json.resultados : [];
  if (rows.length >= 1000) logger.warn({ from, to, rows: rows.length }, 'exp: 1000 linhas (limite take) — range grande pode truncar');

  const hoje = new Date().toISOString().slice(0, 10);
  const byDay: Record<string, ExpDay> = {};
  for (const r of rows) {
    const dia = (r?.dataAtividade || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
    const d = (byDay[dia] ??= { agendados: 0, compareceram: 0, faltaram: 0, reagendados: 0 });
    d.agendados++;
    const presenca = Number(r?.statusAluno) === 0 && !!r?.dataPresenca;
    if (presenca) d.compareceram++;
    else if (dia < hoje) d.faltaram++;
  }

  const totais = { agendados: 0, compareceram: 0, faltaram: 0, reagendados: 0,
    vendas: Number(json?.totalVendasNovosContratos) || 0 };
  for (const d of Object.values(byDay)) {
    totais.agendados += d.agendados; totais.compareceram += d.compareceram; totais.faltaram += d.faltaram;
  }
  // Se o painel expõe os totais agregados, prefere eles pros cards (mais fiel que a soma das linhas).
  if (json?.totalAulasAgendadas != null) totais.agendados = Number(json.totalAulasAgendadas) || totais.agendados;
  if (json?.totalPresencas != null)      totais.compareceram = Number(json.totalPresencas) || totais.compareceram;

  return { byDay, completo: true, totais };
}
