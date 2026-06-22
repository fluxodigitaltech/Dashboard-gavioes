// Inspeção profunda de uma página: dumpa iframes + TODOS XHR (incluindo de frames).
// Uso: npx tsx src/cli/inspect-page.ts <path>
// Ex: npx tsx src/cli/inspect-page.ts /clientes/listagem/1

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const path = process.argv[2] ?? '/clientes/listagem/1';

(async () => {
  await mkdir('./discovery', { recursive: true });
  const { context, page } = await ensureAuthenticated();

  const allRequests: { frameUrl: string; method: string; url: string; status?: number; ct?: string; bodyPreview?: string }[] = [];

  // Listener em TODA a network do contexto (cobre iframes também)
  context.on('response', async (res) => {
    const req = res.request();
    if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
    const ct = res.headers()['content-type'] ?? '';
    let bodyPreview: string | undefined;
    try {
      if (ct.includes('json') || ct.includes('text')) {
        bodyPreview = (await res.text()).slice(0, 1500);
      }
    } catch { /* ignore */ }
    allRequests.push({
      frameUrl: req.frame()?.url() ?? '(no frame)',
      method: req.method(),
      url: req.url(),
      status: res.status(),
      ct,
      bodyPreview,
    });
  });

  const fullUrl = `${config.evo.loginUrl.replace(/\/$/, '')}/#/app/${config.evo.tenant}/${config.evo.branchIds[0]}${path}`;
  logger.info({ url: fullUrl }, 'navigating');
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  await page.evaluate(() => window.scrollTo(0, 1000)).catch(() => {});
  await page.waitForTimeout(3_000);

  // Inspeciona estrutura
  const inspection = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src,
      id: f.id,
      name: f.name,
      visible: !!(f.offsetWidth || f.offsetHeight),
      rect: { w: f.offsetWidth, h: f.offsetHeight },
    }));
    const mainText = (document.querySelector('main, [ui-view], .main-content') ?? document.body).textContent?.slice(0, 500) ?? '';
    const url = window.location.href;
    return { url, iframeCount: iframes.length, iframes, mainTextSnippet: mainText.replace(/\s+/g, ' ').trim() };
  });

  // Lista todos frames
  const frames = page.frames().map(f => ({ name: f.name(), url: f.url() }));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join('./discovery', `inspect-${path.replace(/[\/]/g, '_')}-${stamp}.json`);
  await writeFile(outFile, JSON.stringify({
    url: fullUrl,
    inspection,
    framesInPage: frames,
    totalRequests: allRequests.length,
    requests: allRequests,
  }, null, 2));

  console.log('\n=== PÁGINA ===');
  console.log('URL final:', inspection.url);
  console.log('Iframes na página:', inspection.iframeCount);
  inspection.iframes.forEach(f => console.log(`  - id=${f.id || '(none)'}  src="${f.src.slice(0, 100)}"  visible=${f.visible}`));
  console.log('\n=== FRAMES NO BROWSER ===');
  frames.forEach(f => console.log(`  - name="${f.name}"  url="${f.url.slice(0, 100)}"`));
  console.log('\n=== TODOS XHR/FETCH (incl. iframes) ===');
  const groups = new Map<string, number>();
  for (const r of allRequests) {
    const k = `${r.method} ${stripQuery(r.url)}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}× ${k}`);
  }
  console.log('\n=== Snippet do main ===');
  console.log(inspection.mainTextSnippet.slice(0, 300));
  console.log('\n→ JSON completo:', outFile);

  await context.close();
  await closeBrowser();
  process.exit(0);
})();

function stripQuery(url: string) {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}
