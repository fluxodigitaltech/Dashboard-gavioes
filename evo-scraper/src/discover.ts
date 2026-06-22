// Discovery mode: navega pelas páginas-chave do EVO5 e LOGA todo XHR/fetch
// pra um arquivo JSON. Cole esse arquivo aqui que eu ajusto os extractors com
// os endpoints reais que apareceram.
//
// Uso: npm run discover
//
// O que ele faz:
//   1. Garante login (reusa storageState se houver, senão loga via UI)
//   2. Navega pra cada página da lista PAGES_TO_PROBE
//   3. Para CADA request XHR/fetch que sair na rede, registra: método, URL, status, content-type, primeiros 2KB do body
//   4. Salva tudo em discovery/<timestamp>.json e imprime resumo

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureAuthenticated, closeBrowser } from './auth.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// Paths REAIS extraídos do evo.menu do usuário (após login bem sucedido).
// EVO5 usa nomenclatura "clientes" (não "membros") e tem rotas Angular state-based.
const PAGES_TO_PROBE = [
  { label: 'inicio',          path: '/inicio/geral' },
  { label: 'dashboard',       path: '/dashboard/gerencial/clientes' },     // dashboard de clientes (KPIs)
  { label: 'clientes-list',   path: '/clientes/listagem/1' },              // lista de membros (clientes)
  { label: 'crescimento',     path: '/gerencial2/crescimento' },           // crescimento da rede
  { label: 'cancelamentos',   path: '/gerencial/cancelamentos' },          // cancelamentos
  { label: 'contratos',       path: '/gerencial/contratos' },              // contratos ativos
  { label: 'contas-receber',  path: '/financeiro/contasReceber' },         // recebíveis
  { label: 'cobrancas',       path: '/financeiro2/cobrancas/extrato' },    // cobranças
  { label: 'inadimplencia',   path: '/financeiro2/cobrancas/inadimplencia' },
  { label: 'caixa',           path: '/financeiro/caixas' },                // caixa do dia
  { label: 'checkins',        path: '/gerencial/checkins/dashboard' },     // entradas catraca
  { label: 'vendas-gerencial',path: '/gerencial/vendas' },                 // relatório de vendas
  { label: 'gestor',          path: '/gerencial/gestor' },                 // dashboard gestor
];

interface CapturedRequest {
  page: string;
  method: string;
  url: string;
  status?: number;
  contentType?: string;
  bodyPreview?: string;
  durationMs?: number;
  postDataPreview?: string;
}

export async function runDiscovery(): Promise<string> {
  const { context, page } = await ensureAuthenticated();
  const captured: CapturedRequest[] = [];

  for (const probe of PAGES_TO_PROBE) {
    const branch = config.evo.branchIds[0] ?? '1';
    const fullUrl =
      `${config.evo.loginUrl.replace(/\/$/, '')}/#/app/${config.evo.tenant}/${branch}${probe.path}`;
    logger.info({ url: fullUrl, probe: probe.label }, 'navigating');

    // Listener captura SÓ requests XHR/fetch (filtra estáticos: imgs, css, fontes)
    const requestStarts = new Map<string, number>();
    const onRequest = (req: import('playwright').Request) => {
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      requestStarts.set(req.url() + req.method(), Date.now());
    };
    const onResponse = async (res: import('playwright').Response) => {
      const req = res.request();
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      const key = req.url() + req.method();
      const startedAt = requestStarts.get(key);
      requestStarts.delete(key);

      const ct = res.headers()['content-type'] ?? '';
      let bodyPreview: string | undefined;
      try {
        // Só captura preview de respostas JSON/text (binário a gente ignora)
        if (ct.includes('json') || ct.includes('text')) {
          const text = await res.text();
          bodyPreview = text.slice(0, 2_000);
        }
      } catch { /* response já consumida */ }

      let postDataPreview: string | undefined;
      try {
        const post = req.postData();
        if (post) postDataPreview = post.slice(0, 1_000);
      } catch { /* sem body */ }

      captured.push({
        page: probe.label,
        method: req.method(),
        url: req.url(),
        status: res.status(),
        contentType: ct,
        bodyPreview,
        durationMs: startedAt ? Date.now() - startedAt : undefined,
        postDataPreview,
      });
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: config.playwright.timeoutMs });
      // Angular SPA pode levar 5-10s pra carregar dados após render inicial.
      // networkidle é fraco aqui porque o app fica polling (clarity/intercom).
      // Espera fixa generosa + scroll pra disparar lazy loads.
      await page.waitForTimeout(8_000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(3_000);
    } catch (err) {
      logger.warn({ err: (err as Error).message, probe: probe.label }, 'page navigation failed');
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
    }
  }

  await mkdir('./discovery', { recursive: true });
  const outFile = join('./discovery', `${new Date().toISOString().replace(/[:.]/g, '-')}.discover.json`);
  const summary = {
    capturedAt: new Date().toISOString(),
    tenant: config.evo.tenant,
    branch: config.evo.branchIds[0],
    pagesProbed: PAGES_TO_PROBE.map(p => p.label),
    totalRequests: captured.length,
    uniqueEndpoints: [...new Set(captured.map(c => `${c.method} ${stripQuery(c.url)}`))].length,
    requests: captured,
  };
  await writeFile(outFile, JSON.stringify(summary, null, 2), 'utf8');

  // Resumo no stdout
  logger.info(
    { file: outFile, total: captured.length, uniqueEndpoints: summary.uniqueEndpoints },
    'discovery complete',
  );
  const groups = new Map<string, number>();
  for (const c of captured) {
    const k = `${c.method} ${stripQuery(c.url)}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  console.log('\n=== unique endpoints captured ===');
  for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}× ${k}`);
  }

  await context.close();
  await closeBrowser();
  return outFile;
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}
