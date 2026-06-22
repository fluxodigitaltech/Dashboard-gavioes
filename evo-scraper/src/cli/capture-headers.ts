// Captura os REQUEST HEADERS exatos que a SPA manda numa chamada gerencial
// bem-sucedida (a discovery só pegava response). Assim descobrimos o que falta
// além do JWT pra não tomar 401 "Usuário não encontrado".
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

(async () => {
  const { context, page } = await ensureAuthenticated();

  const matcher = /\/api\/v1\/dashboards\/gerencial-clientesativos|\/api\/v1\/dashboards\/gerencial-evasao|\/api\/v1\/gerencial\//;
  const seen: any[] = [];
  page.on('request', async (req) => {
    if (!matcher.test(req.url())) return;
    try {
      const headers = await req.allHeaders();
      // não loga o valor inteiro do token, só o tamanho
      const redacted: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        redacted[k] = /authorization|token|cookie/i.test(k) ? `${v.slice(0, 24)}…(${v.length})` : v;
      }
      seen.push({ url: req.url().split('?')[0], headers: redacted });
    } catch { /* */ }
  });

  const branch = config.evo.branchIds[0];
  const url = `${config.evo.loginUrl.replace(/\/$/, '')}/#/app/${config.evo.tenant}/${branch}/dashboard/gerencial/clientes`;
  logger.info({ url }, 'navegando dashboard gerencial');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);

  console.log(`\n=== ${seen.length} requests gerenciais capturados ===`);
  for (const s of seen.slice(0, 3)) {
    console.log('\n● ' + s.url.replace(/^https:\/\/[^/]+/, (m: string) => m));
    for (const [k, v] of Object.entries(s.headers)) console.log(`   ${k}: ${v}`);
  }

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'capture-headers failed'); process.exit(1); });
