// Playwright login com sessão persistente.
//
// Estratégia:
//   1. Tenta carregar cookies/auth de session/storageState.json
//   2. Faz uma request de "smoke test" pra verificar se a sessão ainda vale
//   3. Se inválida, faz login UI completo (preenche form, submit, espera redirect)
//   4. Salva storageState atualizado pra próximas runs
//
// Login UI completo: ~10-30s + Cloudflare challenge se vier
// Login com sessão válida: ~2s (só restaura cookies)
//
// IMPORTANTE: o seletor do form de login do EVO5 PODE mudar — o módulo está
// preparado pra cair de volta no `discover` se o seletor falhar.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './lib/logger.js';

const STORAGE_PATH = join(config.playwright.sessionDir, 'storageState.json');

let cachedBrowser: Browser | null = null;

async function ensureBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.isConnected()) return cachedBrowser;
  cachedBrowser = await chromium.launch({
    headless: config.playwright.headless,
    args: [
      // Reduz fingerprint "playwright" — passa Cloudflare em mais cenários
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return cachedBrowser;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Cria um BrowserContext, reusando storageState salvo se existir. */
export async function getContext(): Promise<{ context: BrowserContext; hasStored: boolean }> {
  await mkdir(config.playwright.sessionDir, { recursive: true });
  const browser = await ensureBrowser();
  const hasStored = await fileExists(STORAGE_PATH);

  const context = await browser.newContext({
    storageState: hasStored ? STORAGE_PATH : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  context.setDefaultTimeout(config.playwright.timeoutMs);
  return { context, hasStored };
}

/** Decodifica JWT (sem validar assinatura — é só pra ler exp). */
function decodeJwtPayload(jwt: string): { exp?: number; [k: string]: unknown } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    if (!payload) return null;
    // base64url → base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(payload.length + (4 - payload.length % 4) % 4, '=');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

/** Lê evo.authToken do storageState salvo (mais rápido que abrir browser pra checar). */
async function readJwtFromStorage(): Promise<{ jwt: string; exp: number; secondsLeft: number } | null> {
  try {
    const raw = await import('node:fs/promises').then(fs => fs.readFile(STORAGE_PATH, 'utf8'));
    const state = JSON.parse(raw);
    const origin = state.origins?.find((o: { origin: string }) => o.origin?.includes('evo5.w12app.com.br'));
    const tokenEntry = origin?.localStorage?.find((e: { name: string }) => e.name === 'evo.authToken');
    if (!tokenEntry) return null;
    // O valor está envolto em aspas duplas (JSON-encoded string)
    const jwt = tokenEntry.value.replace(/^"|"$/g, '');
    const payload = decodeJwtPayload(jwt);
    if (!payload || typeof payload.exp !== 'number') return null;
    const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
    return { jwt, exp: payload.exp, secondsLeft };
  } catch { return null; }
}

/** Smoke test rápido: verifica se o JWT no storageState ainda não expirou.
 *  Bem mais barato e confiável que o smoke test DOM. */
async function isSessionValid(_page: Page): Promise<boolean> {
  const tokenInfo = await readJwtFromStorage();
  if (!tokenInfo) {
    logger.warn('no JWT found in storageState');
    return false;
  }
  const valid = tokenInfo.secondsLeft > 60; // margem de 1min
  logger.info(
    { exp: new Date(tokenInfo.exp * 1000).toISOString(), secondsLeft: tokenInfo.secondsLeft, valid },
    'JWT expiry check',
  );
  return valid;
}

/** Faz login UI completo. Atualiza o storageState do contexto ao final.
 *
 * Seletores confirmados via inspect-login.ts no EVO5 (Angular Material):
 *   <input id="usuario" placeholder="E-mail">     ← campo email
 *   <input id="senha" type="password">            ← campo senha
 *   <input id="emailRecuperacao" placeholder="E-mail">  ← APENAS visível na aba "Esqueci senha", IGNORAR
 *   <button type="submit">Entrar</button>         ← botão login
 *
 * Como Angular Material wrappa <input> em <mat-form-field>, usar locators tipados
 * (page.locator('input#usuario')) evita matchear o wrapper.
 */
export async function uiLogin(page: Page): Promise<void> {
  // ⚠️ URL de login ESPECÍFICA do tenant. Abrir a raiz (config.evo.loginUrl) faz a
  // SPA postar dns="evo5" e o /auth/login responde 400. Com /acesso/<tenant>/...
  // ela posta o dns certo (ex: "gavioes") e loga 200.
  const loginUrl = `${config.evo.loginUrl.replace(/\/$/, '')}/#/acesso/${config.evo.tenant}/autenticacao`;
  logger.info({ url: loginUrl }, 'starting UI login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  // Seletores tipados — forçam <input>/<button> pra evitar wrappers Material
  const userLocator   = page.locator('input#usuario, input[placeholder="E-mail"]:not(#emailRecuperacao)').first();
  const passLocator   = page.locator('input#senha, input[type="password"]').first();
  // Botão de submit do form de login (confirmado no DOM do EVO5). Fallback p/ role.
  const submitLocator = page.locator('button[type="submit"][form="evoFormDefault"]')
    .or(page.getByRole('button', { name: /entrar/i })).first();

  // Aguarda form aparecer (SPA Angular pode levar uns 5s)
  await userLocator.waitFor({ state: 'visible', timeout: 20_000 });
  await passLocator.waitFor({ state: 'visible', timeout: 5_000 });

  // O widget de chat "wehelp" às vezes injeta um overlay full-screen que INTERCEPTA
  // o clique no campo de login (Playwright trava: "wehelp-widget-overlay intercepts
  // pointer events" → click timeout). Esconde/desativa o widget antes de interagir.
  await page.evaluate(() => {
    for (const sel of ['#root-wehelp', '#wehelp-widget-overlay', '[id^="wehelp"]', '[class*="wehelp"]']) {
      document.querySelectorAll(sel).forEach((el) => {
        const h = el as HTMLElement;
        h.style.setProperty('display', 'none', 'important');
        h.style.setProperty('pointer-events', 'none', 'important');
      });
    }
  }).catch(() => {});

  // ⚠️ Importante: Angular Material reactive forms só registra o valor quando
  // dispara os eventos input/blur naturalmente. `fill()` seta `value` mas em
  // alguns componentes Material não dispara o ngModel binding — o form fica
  // como `ng-pristine` e o submit é ignorado silenciosamente.
  // Solução: digitar com pressSequentially (caractere por caractere) + Tab pra
  // disparar blur → ngTouched → validações Angular passam.
  await userLocator.click();
  await userLocator.pressSequentially(config.evo.username, { delay: 25 });
  await page.keyboard.press('Tab');

  await passLocator.click();
  await passLocator.pressSequentially(config.evo.password, { delay: 25 });
  await page.keyboard.press('Tab');

  // Submit: prefere Enter (gesto natural Angular) com fallback pro click do botão
  await passLocator.press('Enter').catch(() => {});
  await submitLocator.click({ timeout: 3_000 }).catch(() => {});

  // Aguarda mudança de estado: ou URL muda pra fora de /acesso/, ou input#senha desaparece,
  // ou aparece marcador autenticado. Polling de 500ms até 30s.
  const startedAt = Date.now();
  let success = false;
  while (Date.now() - startedAt < 30_000) {
    const state = await page.evaluate(() => ({
      url: window.location.href,
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasSnackbar: !!document.querySelector('.mat-snack-bar-container, snack-bar-container, .mat-mdc-snack-bar-container'),
      snackText:   (document.querySelector('.mat-snack-bar-container, snack-bar-container, .mat-mdc-snack-bar-container') as HTMLElement | null)?.innerText ?? null,
    }));
    if (!/\/acesso\//.test(state.url) || !state.hasPassword) {
      success = true;
      logger.info({ url: state.url, durationMs: Date.now() - startedAt }, 'login redirect detected');
      break;
    }
    if (state.hasSnackbar && state.snackText) {
      // Mensagem de erro do EVO (toast Material)
      const dbg = join(config.playwright.sessionDir, `login-error-${Date.now()}.png`);
      await page.screenshot({ path: dbg, fullPage: true }).catch(() => {});
      logger.error({ snackText: state.snackText, screenshot: dbg }, 'EVO returned error message');
      throw new Error(`EVO recusou login: "${state.snackText}"`);
    }
    await page.waitForTimeout(500);
  }

  if (!success) {
    const dbg = join(config.playwright.sessionDir, `login-stuck-${Date.now()}.png`);
    await page.screenshot({ path: dbg, fullPage: true }).catch(() => {});
    const html = await page.content();
    await import('node:fs/promises').then(fs => fs.writeFile(join(config.playwright.sessionDir, `login-stuck-${Date.now()}.html`), html));
    const finalUrl = page.url();
    logger.error({ url: finalUrl, screenshot: dbg }, 'login stuck on /acesso/ after 30s — captcha, credentials wrong, or hash routing not navigating');
    throw new Error(`login UI travou em ${finalUrl} (sem mensagem de erro). Veja ${dbg}`);
  }

  logger.info({ url: page.url() }, 'login UI succeeded');
}

/** Garante context autenticado: reusa storage se vale, senão re-loga via UI e salva. */
export async function ensureAuthenticated(): Promise<{ context: BrowserContext; page: Page }> {
  const { context, hasStored } = await getContext();
  const page = await context.newPage();

  // Sem storage prévio → vai direto pro login UI (smoke test seria desperdício)
  if (!hasStored) {
    logger.info('no storageState found → doing UI login');
    await uiLogin(page);
    await context.storageState({ path: STORAGE_PATH });
    return { context, page };
  }

  // Tem storage → tenta reusar
  const valid = await isSessionValid(page);
  if (valid) {
    logger.info('session restored from storageState (no UI login needed)');
    return { context, page };
  }

  // Storage existe mas expirou → re-loga e sobrescreve
  logger.info('storageState expired, doing UI login again');
  await uiLogin(page);
  await context.storageState({ path: STORAGE_PATH });
  return { context, page };
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser?.isConnected()) {
    await cachedBrowser.close();
    cachedBrowser = null;
  }
}

/** Apaga o storageState salvo. Chame se receber 401/redirect-pra-login durante uma run. */
export async function invalidateSession(): Promise<void> {
  if (await fileExists(STORAGE_PATH)) {
    await unlink(STORAGE_PATH);
    logger.warn('storageState invalidated — próxima run vai re-fazer UI login');
  }
}
