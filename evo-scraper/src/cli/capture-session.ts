// Faz login pela UI e despeja TODO o estado que a SPA grava (localStorage,
// sessionStorage, cookies) — pra descobrir quais chaves o guard do Angular exige.
// Uso: npx tsx src/cli/capture-session.ts
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

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

  // captura a resposta do /auth/login pra confirmar que o submit disparou
  let loginResp: { status: number; bodyLen: number } | null = null;
  page.on('response', async (res) => {
    if (/\/auth\/login/.test(res.url())) {
      let body = ''; try { body = await res.text(); } catch { /* */ }
      loginResp = { status: res.status(), bodyLen: body.length };
      logger.info({ status: res.status(), body: body.slice(0, 300) }, '/auth/login respondeu');
    }
  });

  // URL de login ESPECÍFICA do tenant — senão a SPA posta dns="evo5" e dá 400.
  const loginUrl = `${config.evo.loginUrl.replace(/\/$/, '')}/#/acesso/${config.evo.tenant}/autenticacao`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input#usuario').first().waitFor({ state: 'visible', timeout: 20_000 });

  await page.locator('input#usuario').first().pressSequentially(config.evo.username, { delay: 20 });
  await page.keyboard.press('Tab');
  await page.locator('input#senha').first().pressSequentially(config.evo.password, { delay: 20 });
  await page.keyboard.press('Tab');

  // submit robusto: clica o botão específico; fallback p/ requestSubmit do form
  const submitBtn = page.locator('button[type="submit"][form="evoFormDefault"]').first();
  await submitBtn.click({ timeout: 5000 }).catch(async () => {
    logger.warn('click no submit falhou, tentando form.requestSubmit()');
    await page.evaluate(() => {
      const f = document.querySelector<HTMLFormElement>('#evoFormDefault, form');
      f?.requestSubmit();
    });
  });

  // espera sair de /acesso/ por até 45s
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    if (!/\/acesso\//.test(page.url())) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3000);

  const dump = await page.evaluate(() => {
    const ls: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      const v = localStorage.getItem(k) ?? '';
      ls[k] = v.length > 300 ? `${v.slice(0, 300)}…(${v.length} chars)` : v;
    }
    const ss: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      const v = sessionStorage.getItem(k) ?? '';
      ss[k] = v.length > 300 ? `${v.slice(0, 300)}…(${v.length} chars)` : v;
    }
    return { url: location.href, localStorage: ls, sessionStorage: ss };
  });
  const cookies = await context.cookies();

  const out = {
    loginResp,
    finalUrl: dump.url,
    loggedIn: !/\/acesso\//.test(dump.url),
    localStorageKeys: Object.keys(dump.localStorage),
    sessionStorageKeys: Object.keys(dump.sessionStorage),
    cookieNames: cookies.map((c) => `${c.name}@${c.domain}`),
    localStorage: dump.localStorage,
    sessionStorage: dump.sessionStorage,
  };
  await writeFile('./discovery/session-dump.json', JSON.stringify(out, null, 2));

  console.log('\n=== RESULTADO ===');
  console.log('final URL:', dump.url, '| logado:', out.loggedIn);
  console.log('login resp:', JSON.stringify(loginResp));
  console.log('localStorage keys:', out.localStorageKeys.join(', ') || '(vazio)');
  console.log('sessionStorage keys:', out.sessionStorageKeys.join(', ') || '(vazio)');
  console.log('cookies:', out.cookieNames.join(', ') || '(nenhum)');
  console.log('\n→ dump completo em discovery/session-dump.json');

  await context.close();
  await browser.close();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'capture failed'); process.exit(1); });
