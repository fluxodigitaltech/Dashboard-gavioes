// Probe: login PROGRAMÁTICO (POST /auth/login) → injeta o JWT no localStorage do
// browser (evo.authToken) → navega as telas autenticado → sniffa todo XHR de dados.
//
// Substitui o UI login (instável em headless) pela API de login que já validamos.
// Uso: npm run probe
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const API = 'https://evo-abc-api.w12app.com.br';

// Login PROGRAMÁTICO mas executado DENTRO do browser (page.evaluate) — o fetch
// sai com o TLS fingerprint do Chromium e passa pelo Cloudflare. O fetch do Node
// (undici) é bloqueado com 403 por fingerprint, mesmo com headers de browser.
async function loginViaApi(page: import('playwright').Page): Promise<string> {
  const result = await page.evaluate(async ({ api, body }) => {
    const r = await fetch(`${api}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text };
  }, {
    api: API,
    body: { dns: config.evo.tenant, login: config.evo.username, senha: config.evo.password,
            fusoHorario: 180, chaveOTP: '', etapaAtual: 1, gofit: false, idFilial: null },
  });
  if (result.status !== 200) throw new Error(`login API ${result.status}: ${result.text.slice(0, 200)}`);
  const json = JSON.parse(result.text) as { tokenAcesso?: string };
  if (!json.tokenAcesso) throw new Error('login API sem tokenAcesso');
  logger.info({ jwtLen: json.tokenAcesso.length }, 'login via API (in-browser) OK');
  return json.tokenAcesso;
}

const PAGES = [
  { label: 'inicio',        path: '/inicio/geral' },
  { label: 'dash-clientes', path: '/dashboard/gerencial/clientes' },
  { label: 'vendas',        path: '/gerencial/vendas' },
  { label: 'checkins',      path: '/gerencial/checkins/dashboard' },
  { label: 'contas-receber',path: '/financeiro/contasReceber' },
];

interface Cap { page: string; method: string; url: string; status: number; ct?: string; body?: string; }

(async () => {
  const browser = await chromium.launch({
    headless: config.playwright.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 1. carrega o root (Cloudflare seta __cf_bm + estabelece origin evo5)
  await page.goto(config.evo.loginUrl, { waitUntil: 'domcontentloaded' });
  // 2. login programático DENTRO do browser (passa pelo Cloudflare)
  const jwt = await loginViaApi(page);
  // 3. injeta o token como a SPA faz (JSON-encoded string)
  await page.evaluate((token) => {
    localStorage.setItem('evo.authToken', JSON.stringify(token));
  }, jwt);
  logger.info('JWT injetado no localStorage; navegando autenticado…');

  const captured: Cap[] = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
    const ct = res.headers()['content-type'] ?? '';
    let body: string | undefined;
    try { if (ct.includes('json') || ct.includes('text')) body = (await res.text()).slice(0, 1500); } catch { /* */ }
    captured.push({ page: '(current)', method: req.method(), url: req.url(), status: res.status(), ct, body });
  });

  const branch = config.evo.branchIds[0];
  const finalUrls: Record<string, string> = {};
  for (const p of PAGES) {
    const url = `${config.evo.loginUrl.replace(/\/$/, '')}/#/app/${config.evo.tenant}/${branch}${p.path}`;
    captured.forEach((c) => { if (c.page === '(current)') c.page = 'prev'; });
    logger.info({ probe: p.label, url }, 'navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(7000);
    captured.forEach((c) => { if (c.page === '(current)') c.page = p.label; });
    finalUrls[p.label] = page.url();
  }

  await mkdir('./discovery', { recursive: true });
  const out = join('./discovery', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(out, JSON.stringify({ finalUrls, total: captured.length, captured }, null, 2));

  // resumo
  const loggedOut = Object.entries(finalUrls).filter(([, u]) => /\/acesso\//.test(u));
  console.log('\n=== final URLs por página ===');
  for (const [k, u] of Object.entries(finalUrls)) console.log(`  ${k}: ${u}`);
  if (loggedOut.length) console.log(`\n⚠️  ${loggedOut.length} página(s) caíram em /acesso/ (token não aceito pela SPA)`);

  const groups = new Map<string, { n: number; statuses: Set<number> }>();
  for (const c of captured) {
    const k = `${c.method} ${c.url.split('?')[0]}`;
    const g = groups.get(k) ?? { n: 0, statuses: new Set<number>() };
    g.n++; g.statuses.add(c.status); groups.set(k, g);
  }
  console.log('\n=== endpoints XHR capturados (host + path) ===');
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(g.n).padStart(3)}× [${[...g.statuses].join(',')}] ${k}`);
  }
  console.log(`\n→ detalhe completo em ${out}`);

  await context.close();
  await browser.close();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'probe failed'); process.exit(1); });
