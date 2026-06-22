// Diagnóstico: SSO → Index/VENDAS → espera o grid disparar o listarVendas sozinho
// e captura a resposta (Total + AggregateResults). Se não disparar, tenta clicar buscar.
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { createEvoClient } from '../evoClient.js';
import { logger } from '../lib/logger.js';

(async () => {
  const { context, page } = await ensureAuthenticated();
  const client = await createEvoClient(page);
  const t3 = client.auth.tokenEvo3;

  let listarResp: { status: number; total?: number; valor?: number } | null = null;
  let listarBody = '';
  page.on('request', (req) => { if (/listarVendas/.test(req.url())) { const p = req.postData(); if (p) listarBody = p; } });
  page.on('response', async (res) => {
    if (/listarVendas/.test(res.url())) {
      try {
        const j = JSON.parse(await res.text());
        listarResp = { status: res.status(), total: j.Total, valor: j.AggregateResults?.[0]?.Value };
      } catch { listarResp = { status: res.status() }; }
    }
  });

  await page.goto(`https://evo3.w12app.com.br/Login/LogarEvo3?TokenEvo3=${t3}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.goto('https://evo3.w12app.com.br/Gerencial/Gerencial/Index/VENDAS', { waitUntil: 'domcontentloaded' });
  logger.info('aguardando grid disparar listarVendas (12s)…');
  await page.waitForTimeout(12000);

  if (!listarResp) {
    // tenta achar e clicar um botão de busca/pesquisar
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit], .btn, i'));
      const alvo = btns.find(b => /pesquis|buscar|filtrar|search/i.test((b.textContent || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.className || '')));
      if (alvo) { (alvo as HTMLElement).click(); return (alvo.textContent || alvo.className).slice(0, 40); }
      return '';
    });
    logger.info({ clicked }, 'tentou clicar buscar');
    await page.waitForTimeout(8000);
  }

  console.log('\nlistarVendas disparou?', !!listarResp);
  console.log('resposta:', JSON.stringify(listarResp));
  console.log('\nbody real capturado:', listarBody ? decodeURIComponent(listarBody).slice(0, 600) : '(nenhum)');

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'probe failed'); process.exit(1); });
