// Extractor de VENDAS — host legado EVO3 (evo3.w12app.com.br, MVC + Kendo grid).
//
// EVO3 tem auth própria (cookies). Fluxo SSO descoberto:
//   1. GET https://evo3.w12app.com.br/Login/LogarEvo3?TokenEvo3=<evo.tokenEvo3>
//      → seta os cookies de sessão do evo3 e coloca a página na origin evo3.
//   2. POST /Gerencial/Vendas/listarVendas (same-origin) → { Total, AggregateResults }.
//
// IMPORTANTE: precisa rodar com a página AINDA na origin evo5 (pra ler o token do
// localStorage). Por isso é o ÚLTIMO passo da extração — depois a página fica no evo3.
import type { EvoClient } from '../evoClient.js';
import { uiLogin } from '../auth.js';
import { logger } from '../lib/logger.js';

const SSO = 'https://evo3.w12app.com.br/Login/LogarEvo3';
const LISTAR = 'https://evo3.w12app.com.br/Gerencial/Vendas/listarVendas';
// Base ativa por plano (Gerencial › Contratos). Mesmo host/origin do listarVendas,
// então roda de dentro do MESMO iframe evo3 (reusa a sessão + anti-forgery).
const CONTRATOS = 'https://evo3.w12app.com.br/Gerencial/Contratos/listarClientesContratosApenasQuantidade';

export interface PlanoBase { plano: string; qtde: number; }

export interface VendasResult {
  valorMes: number | null;            // soma VALOR_VENDA do mês (AggregateResults[0].Value)
  qtdMes: number | null;              // qtd de vendas (Total)
  valorMesAnterior: number | null;
  qtdMesAnterior: number | null;
  planosBase: PlanoBase[];            // base ativa agrupada por plano (Termômetro de Planos)
}

interface ContratoRow { DS_CONTRATO?: string; QTDE?: number; }
interface ContratosResp { Data?: ContratoRow[]; Total?: number; }

/** DD/MM/YYYY */
function ddmmyyyy(d: Date) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Payload Kendo do listarVendas (form-urlencoded). O DevTools mostra group/aggregate
 *  "resumidos", mas na rede o Kendo serializa com colchetes. Filtro por DT_VENDA. */
function vendasBody(inicio: string, fim: string): string {
  const p = new URLSearchParams();
  p.append('sort', '');
  p.append('page', '1');
  p.append('pageSize', '15');
  // group por funcionário (igual a tela) — necessário p/ o AggregateResults vir preenchido
  p.append('group[0][field]', 'NOME_FUNCIONARIO_VENDA');
  p.append('group[0][dir]', 'asc');
  p.append('group[0][aggregates][0][field]', 'VALOR_VENDA');
  p.append('group[0][aggregates][0][aggregate]', 'sum');
  // aggregate VALOR_VENDA sum (formato Kendo) — é daqui que sai AggregateResults
  p.append('aggregate[0][field]', 'VALOR_VENDA');
  p.append('aggregate[0][aggregate]', 'sum');
  p.append('filter', '');
  // campos custom do controller
  p.append('IdFuncionario', '');
  p.append('IdFuncionarioComis', '');
  p.append('Inicio', inicio);
  p.append('Fim', fim);
  p.append('Contrato', 'true');
  p.append('Produto', 'false');
  p.append('Servico', 'false');
  p.append('DebitoRecorrente', 'false');
  p.append('TrocaDeContrato', 'false');
  p.append('ContratosAdicionais', 'false');
  p.append('FL_MANUAIS', 'true');
  p.append('FL_ONLINE', 'true');
  p.append('FL_CONTRATO_SECUNDARIO', 'false');
  p.append('idsContrato', '');
  p.append('idsProduto', '');
  p.append('idsServico', '');
  p.append('IdsFiliais', '');
  p.append('ConsideraEspecial', 'false');
  return p.toString();
}

interface VendasItem { TOTAL_GERAL?: number; }
interface VendasGroup { Aggregates?: { VALOR_VENDA?: { Sum?: number } }; Items?: VendasItem[]; }
interface VendasResp {
  Total?: number;
  AggregateResults?: { Value?: number; Member?: string }[];
  // Data pode vir FLAT (itens diretos, c/ TOTAL_GERAL) ou AGRUPADO (grupos c/ Items).
  Data?: (VendasItem & VendasGroup)[];
}

/** Soma VALOR_VENDA do período. O TOTAL_GERAL (grand total do filtro) vem em todo item. */
function parseValorVenda(r: VendasResp): number | null {
  const agg = r.AggregateResults?.find(a => a.Member === 'VALOR_VENDA')?.Value ?? r.AggregateResults?.[0]?.Value;
  if (typeof agg === 'number') return agg;
  const d0 = r.Data?.[0];
  if (!d0) return null;
  // flat: item direto com TOTAL_GERAL | agrupado: grupo.Items[0].TOTAL_GERAL
  if (typeof d0.TOTAL_GERAL === 'number') return d0.TOTAL_GERAL;
  const tg = d0.Items?.[0]?.TOTAL_GERAL;
  if (typeof tg === 'number') return tg;
  const fromData = r.Data?.reduce((s, g) => s + (g.Aggregates?.VALOR_VENDA?.Sum ?? 0), 0);
  return fromData || null;
}

/** Faz SSO no evo3 e chama listarVendas pra 2 períodos (mês atual + anterior). */
export async function extractVendas(client: EvoClient, ref = new Date()): Promise<VendasResult> {
  const page = client.page;
  const tenant = client.auth.dns;
  const filial = client.auth.filial;

  // Usa o FLUXO REAL da SPA: ela cria um iframe do evo3 que faz o SSO completo e
  // renderiza o relatório COM o cookie anti-forgery + token. Navegar direto no
  // evo3 não monta essa sessão (faltam cookies / dá 500 CSRF). A navegação da SPA
  // pro módulo evo3 é INSTÁVEL no headless (às vezes cai pra /acesso/) → retry.
  const evo3Hash = `#/app/${tenant}/${filial}/evo3/-Gerencial-Gerencial-Index-VENDAS`;
  const findFrame = () => page.frames().find(f => /evo3\.w12app/.test(f.url()) && /VENDAS|Gerencial|Vendas/i.test(f.url()))
    ?? page.frames().find(f => /evo3\.w12app/.test(f.url()));

  // A SPA só navega nos módulos evo3 com o sessionStorage REAL do login (que o
  // storageState não persiste). Então fazemos um login UI fresco aqui — popula o
  // sessionStorage e a navegação pro iframe evo3 passa a funcionar.
  let frame = undefined as ReturnType<typeof findFrame>;
  for (let attempt = 1; attempt <= 3 && !frame; attempt++) {
    try { await uiLogin(page); } catch (e) { logger.warn({ attempt, err: (e as Error).message }, 'vendas: uiLogin falhou'); continue; }
    await page.waitForTimeout(2000);
    await page.evaluate((hash) => { window.location.hash = hash; }, evo3Hash);
    await page.waitForTimeout(11000);
    if (/\/acesso\//.test(page.url())) { logger.warn({ attempt }, 'vendas: SPA caiu no login, retry'); continue; }
    for (let i = 0; i < 5 && !frame; i++) { frame = findFrame(); if (!frame) await page.waitForTimeout(2000); }
    if (!frame) logger.warn({ attempt, url: page.url() }, 'vendas: iframe evo3 não apareceu, retry');
  }
  if (!frame) throw new Error('vendas: iframe do evo3 não carregou após retries');
  logger.info({ frameUrl: frame.url() }, 'iframe evo3 encontrado');
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);

  // 4. token anti-forgery de DENTRO do iframe (sessão correta)
  const antiforgery = await frame.evaluate(() => {
    const el = document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement | null;
    return el?.value ?? '';
  });
  if (!antiforgery) logger.warn('vendas: __RequestVerificationToken não achado no iframe');

  // 5. períodos
  const y = ref.getFullYear();
  const m = ref.getMonth(); // 0-11
  const curIni = ddmmyyyy(new Date(y, m, 1));
  const curFim = ddmmyyyy(ref);
  const prevIni = ddmmyyyy(new Date(y, m - 1, 1));
  const prevFim = ddmmyyyy(new Date(y, m, 0)); // último dia do mês anterior

  const callVendas = async (inicio: string, fim: string): Promise<VendasResp> => {
    let body = vendasBody(inicio, fim);
    if (antiforgery) body += `&__RequestVerificationToken=${encodeURIComponent(antiforgery)}`;
    // fetch de DENTRO do iframe evo3 (same-origin + cookies da sessão evo3)
    const res = await frame!.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });
      return { status: r.status, text: await r.text() };
    }, { url: LISTAR, body });
    if (res.status !== 200) throw new Error(`listarVendas → ${res.status}: ${res.text.slice(0, 120)}`);
    return JSON.parse(res.text) as VendasResp;
  };

  const cur = await callVendas(curIni, curFim);
  const prev = await callVendas(prevIni, prevFim);

  logger.info({ qtd: cur.Total, valor: parseValorVenda(cur) }, 'vendas extraídas (evo3)');

  // Base ativa por plano — mesmo iframe/sessão. Falha aqui NÃO derruba as vendas.
  const planosBase = await (async (): Promise<PlanoBase[]> => {
    try {
      let body = new URLSearchParams({ sort: '', page: '1', pageSize: '200', group: '', filter: '' }).toString();
      if (antiforgery) body += `&__RequestVerificationToken=${encodeURIComponent(antiforgery)}`;
      const res = await frame!.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST', credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
          },
          body,
        });
        return { status: r.status, text: await r.text() };
      }, { url: CONTRATOS, body });
      if (res.status !== 200) { logger.warn({ status: res.status, body: res.text.slice(0, 150) }, 'contratos: HTTP != 200'); return []; }
      const json = JSON.parse(res.text) as ContratosResp;
      const data = Array.isArray(json?.Data) ? json.Data : [];
      const out = data
        .map(d => ({ plano: String(d?.DS_CONTRATO ?? '').trim() || 'Sem plano', qtde: Number(d?.QTDE) || 0 }))
        .filter(p => p.qtde > 0);
      logger.info({ planos: out.length, base: out.reduce((s, p) => s + p.qtde, 0) }, 'contratos extraídos (evo3)');
      return out;
    } catch (e) { logger.warn({ err: (e as Error).message }, 'contratos: exceção'); return []; }
  })();

  return {
    valorMes: parseValorVenda(cur),
    qtdMes: cur.Total ?? null,
    valorMesAnterior: parseValorVenda(prev),
    qtdMesAnterior: prev.Total ?? null,
    planosBase,
  };
}
