// CLI: testa só o login. Útil pra validar que credenciais e seletores funcionam
// ANTES de sair scraping. Uso: npm run test:login

import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { logger } from '../lib/logger.js';

(async () => {
  try {
    const { context, page } = await ensureAuthenticated();
    logger.info({ url: page.url(), cookies: (await context.cookies()).length }, 'login OK');
    await context.close();
    await closeBrowser();
    process.exit(0);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'login FAILED');
    await closeBrowser();
    process.exit(1);
  }
})();
