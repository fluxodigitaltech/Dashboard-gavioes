// Captura focada na tela Financeiro › Cobranças › Extrato (filtro "Data da
// tentativa: Este mês"). Navega autenticado e loga os XHR (URL + body + resposta)
// pra achar o endpoint que devolve as transações + o total Aprovado.
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { writeFile, mkdir } from 'node:fs/promises';

(async () => {
  const { context, page } = await ensureAuthenticated();
  const cap: any[] = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
    const url = req.url();
    if (/intercom|clarity|google|instatus|signalr|bing|hotjar/.test(url)) return;
    const ct = res.headers()['content-type'] ?? '';
    let body = ''; try { if (ct.includes('json') || ct.includes('text')) body = (await res.text()).slice(0, 2500); } catch { /* */ }
    let post: string | undefined; try { post = req.postData() ?? undefined; } catch { /* */ }
    cap.push({ method: req.method(), url, status: res.status(), post: post?.slice(0, 600), body });
  });

  const branch = config.evo.branchIds[0];
  const root = `${config.evo.loginUrl.replace(/\/$/, '')}/#/app/${config.evo.tenant}/${branch}`;
  // 1. bootstrap autenticado no início (cold-deeplink em rota profunda derruba pra login)
  logger.info('bootstrap em inicio/geral…');
  await page.goto(`${root}/inicio/geral`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  // 2. navega DENTRO do app pra cobranças (hash change, sem reload)
  logger.info('navegando p/ Cobranças › Extrato…');
  await page.evaluate((u) => { window.location.hash = u; }, `#/app/${config.evo.tenant}/${branch}/financeiro2/cobrancas/extrato`);
  await page.waitForTimeout(18000); // a grid carrega após render + filtro default
  logger.info({ finalUrl: page.url() }, 'URL final');
  await page.screenshot({ path: './discovery/cobrancas.png', fullPage: false }).catch(() => {});

  await mkdir('./discovery', { recursive: true });
  const out = `./discovery/cobrancas-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(out, JSON.stringify(cap, null, 2));

  console.log(`\n=== ${cap.length} XHR capturados em Cobranças ===`);
  for (const c of cap) {
    const path = c.url.replace(/^https:\/\/([^/]+)/, '$1');
    const money = /aprovad|valor|total|transac|cobranc|extrato|pagament/i.test(c.body) || /cobranc|extrato|transac|pagament|financ/i.test(c.url);
    console.log(`\n${money ? '💰' : '  '} ${c.method} ${path.split('?')[0]}  [${c.status}]`);
    if (c.post) console.log('   POST body:', c.post.replace(/\s+/g, ' ').slice(0, 300));
    if (money && c.body) console.log('   resp:', c.body.replace(/\s+/g, ' ').slice(0, 400));
  }
  console.log(`\n→ completo em ${out}`);

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'probe-cobrancas failed'); process.exit(1); });
