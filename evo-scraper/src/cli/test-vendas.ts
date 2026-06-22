// Testa o endpoint de VENDAS do EVO3 (host evo3.w12app.com.br, MVC/Kendo grid).
// Tenta autenticar com a mesma sessão do browser (headers evo5 + cookies que houver).
// Uso: npx tsx src/cli/test-vendas.ts
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { createEvoClient } from '../evoClient.js';
import { logger } from '../lib/logger.js';

const URL = 'https://evo3.w12app.com.br/Gerencial/Vendas/listarVendas';

/** DD/MM/YYYY */
function ddmmyyyy(d: Date) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

(async () => {
  const { context, page } = await ensureAuthenticated();
  const client = await createEvoClient(page);

  // filtro = mês corrente (igual a tela): 01/MM até hoje
  const hoje = new Date();
  const inicio = ddmmyyyy(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const fim = ddmmyyyy(hoje);

  // payload form-urlencoded (Kendo grid)
  const form: Record<string, string> = {
    sort: '', page: '1', pageSize: '15',
    group: 'NOME_FUNCIONARIO_VENDA-asc', aggregate: 'VALOR_VENDA-sum', filter: '',
    IdFuncionario: '', IdFuncionarioComis: '',
    Inicio: inicio, Fim: fim,
    Contrato: 'true', Produto: 'false', Servico: 'false',
    DebitoRecorrente: 'false', TrocaDeContrato: 'false', ContratosAdicionais: 'false',
    FL_MANUAIS: 'true', FL_ONLINE: 'true', FL_CONTRATO_SECUNDARIO: 'false',
    idsContrato: '', idsProduto: '', idsServico: '', IdsFiliais: '', ConsideraEspecial: 'false',
  };

  const auth = client.auth;
  const jwt = await page.evaluate(() => JSON.parse(localStorage.getItem('evo.authToken') || '""'));
  const out = await page.evaluate(async ({ url, form, auth, jwt }) => {
    const body = new URLSearchParams(form).toString();
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
    };
    const results: { label: string; status: number; snippet: string }[] = [];
    // tentativa A: só cookies
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers: baseHeaders, body });
      const t = await r.text();
      results.push({ label: 'só cookies', status: r.status, snippet: t.slice(0, 180) });
    } catch (e) { results.push({ label: 'só cookies', status: -1, snippet: String(e).slice(0, 120) }); }
    // tentativa B: headers evo5
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { ...baseHeaders, Authorization: `Bearer ${jwt}`, dns: auth.dns, filial: auth.filial, idw12: auth.idw12, chaveidfilial: auth.chaveidfilial, chaveidw12: auth.chaveidw12 },
        body,
      });
      const t = await r.text();
      results.push({ label: 'evo5 headers', status: r.status, snippet: t.slice(0, 180) });
    } catch (e) { results.push({ label: 'evo5 headers', status: -1, snippet: String(e).slice(0, 120) }); }
    return results;
  }, { url: URL, form, auth, jwt });

  console.log(`\nfiltro: ${inicio} → ${fim}`);
  for (const r of out) {
    console.log(`\n[${r.label}] HTTP ${r.status}`);
    console.log('  ', r.snippet.replace(/\s+/g, ' '));
  }

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'test-vendas failed'); process.exit(1); });
