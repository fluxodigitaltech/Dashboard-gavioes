// Testa chamar os endpoints de dados DIRETO (sem navegar a SPA), de dentro do
// browser autenticado, usando o JWT do localStorage como Bearer.
// Se funcionar, os extractors viram chamadas API diretas (rápido + robusto).
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const API = 'https://evo-abc-api.w12app.com.br';
const GER = 'https://evo-abc-api-gerencial.w12app.com.br';

(async () => {
  const { context, page } = await ensureAuthenticated();
  // garante que estamos num documento do evo5 (origin) com o token no storage
  if (!/evo5\.w12app/.test(page.url())) {
    await page.goto(config.evo.loginUrl, { waitUntil: 'domcontentloaded' });
  }

  const today = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}-${d.getFullYear()}`; // MM-DD-YYYY (formato que o EVO usa)
  })();

  const targets = [
    `${API}/api/v1/dashboards/gerencial-clientesativos?data=${today}&refresh=false`,
    `${API}/api/v1/dashboards/gerencial-clientesadimplentes?data=${today}&refresh=false`,
    `${API}/api/v1/dashboards/gerencial-clientesinadimplentes?data=${today}&refresh=false`,
    `${API}/api/v1/dashboards/gerencial-evasao?data=${today}&refresh=false`,
  ];

  const out = await page.evaluate(async (urls) => {
    const token = JSON.parse(localStorage.getItem('evo.authToken') || '""');
    const user = JSON.parse(localStorage.getItem('evo.user') || '{}');
    const dns = JSON.parse(localStorage.getItem('evo.DNS') || '""') || 'gavioes';
    // headers customizados que a SPA manda (descobertos via capture-headers)
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain, */*',
      dns,
      filial: String(user.idFilial ?? ''),
      idw12: String(user.idW12 ?? ''),
      chaveidfilial: user.idFilialCripto ?? '',
      chaveidw12: user.idW12Cripto ?? '',
    };
    const results: any[] = [];
    for (const u of urls) {
      const r = await fetch(u, { headers: h });
      results.push({ url: u, status: r.status, body: (await r.text()).slice(0, 200) });
    }
    return { tokenLen: String(token).length, headersSent: { ...h, Authorization: `Bearer …(${token.length})` }, results };
  }, targets);
  console.log('headers enviados:', JSON.stringify(out.headersSent, null, 2));

  console.log('\ntoken len:', out.tokenLen);
  for (const r of out.results) {
    console.log(`\n[${r.variant}] ${r.status}  ${r.url.replace(/^https:\/\/[^/]+/, '').split('?')[0]}`);
    console.log('  ', r.body.replace(/\s+/g, ' '));
  }

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'test-api failed'); process.exit(1); });
