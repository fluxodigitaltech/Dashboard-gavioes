// Inspeção do form de login do EVO5: abre a página, espera estabilizar,
// lista todos os inputs/buttons visíveis com seus atributos completos.
// Usa pra descobrir os seletores reais quando os candidatos default falham.

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

(async () => {
  const browser = await chromium.launch({
    headless: config.playwright.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  logger.info({ url: config.evo.loginUrl }, 'navigating');
  await page.goto(config.evo.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); // dá tempo SPA + Cloudflare

  // Captura screenshot + HTML completo
  await page.screenshot({ path: './session/inspect-login.png', fullPage: true });
  const html = await page.content();
  await writeFile('./session/inspect-login.html', html, 'utf8');

  const result = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      tag: 'input',
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'),
      classes: el.className,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type,
      name: (el as HTMLButtonElement).name,
      id: el.id,
      text: el.textContent?.trim().slice(0, 40),
      classes: el.className,
      visible: !!((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight),
    }));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action, method: f.method, id: f.id, classes: f.className,
    }));
    return { url: window.location.href, title: document.title, inputs, buttons, forms };
  });

  console.log('\n=== FINAL URL ===\n', result.url);
  console.log('=== TITLE ===\n', result.title);
  console.log('\n=== INPUTS ===');
  for (const i of result.inputs) console.log(JSON.stringify(i));
  console.log('\n=== BUTTONS ===');
  for (const b of result.buttons) console.log(JSON.stringify(b));
  console.log('\n=== FORMS ===');
  for (const f of result.forms) console.log(JSON.stringify(f));

  await ctx.close();
  await browser.close();
  process.exit(0);
})();
