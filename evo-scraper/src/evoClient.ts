// Cliente HTTP autenticado pro EVO5. Faz as chamadas de dados DIRETO nos
// endpoints da API (sem navegar a SPA), de DENTRO do browser autenticado
// (page.evaluate) — assim passa pelo Cloudflare (TLS fingerprint) e reusa a
// sessão. Os headers customizados (dns/filial/idw12/chaveidfilial/chaveidw12)
// são lidos do localStorage que a SPA preenche no login.
//
// Ver memory/evo5-conta-web-auth.md pra a receita completa.
import type { Page } from 'playwright';
import { logger } from './lib/logger.js';

export interface EvoAuthContext {
  dns: string;
  filial: string;
  idw12: string;
  chaveidfilial: string;
  chaveidw12: string;
  tokenLen: number;
  tokenEvo3: string;   // token p/ SSO no EVO3 (vendas) — capturado cedo, antes da SPA mexer
}

export interface EvoClient {
  auth: EvoAuthContext;
  /** A Page autenticada (origin evo5). Usada por extractors que precisam navegar
   *  (ex: EVO3/vendas faz SSO e chama same-origin). */
  page: Page;
  /** GET um endpoint absoluto (https://...) e devolve JSON parseado. */
  get<T = unknown>(url: string): Promise<T>;
  /** POST com body JSON. */
  post<T = unknown>(url: string, body: unknown): Promise<T>;
}

interface RawResult { status: number; body: string; }

/** Lê o estado de auth do localStorage e devolve um client pronto. Lança se faltar token. */
export async function createEvoClient(page: Page): Promise<EvoClient> {
  // garante que estamos num documento evo5 (origin correta + localStorage acessível)
  if (!/evo5\.w12app/.test(page.url())) {
    await page.goto('https://evo5.w12app.com.br/', { waitUntil: 'domcontentloaded' });
  }

  const auth = await page.evaluate(() => {
    const token = JSON.parse(localStorage.getItem('evo.authToken') || '""');
    const user = JSON.parse(localStorage.getItem('evo.user') || '{}');
    const dns = JSON.parse(localStorage.getItem('evo.DNS') || '""');
    let tokenEvo3 = '';
    const rawT3 = localStorage.getItem('evo.tokenEvo3');
    if (rawT3) { try { tokenEvo3 = JSON.parse(rawT3); } catch { tokenEvo3 = rawT3.replace(/^"|"$/g, ''); } }
    return {
      token,
      dns: dns || '',
      filial: String(user.idFilial ?? ''),
      idw12: String(user.idW12 ?? ''),
      chaveidfilial: user.idFilialCripto ?? '',
      chaveidw12: user.idW12Cripto ?? '',
      tokenEvo3,
    };
  });

  if (!auth.token) throw new Error('evoClient: sem evo.authToken no localStorage (sessão não autenticada?)');
  if (!auth.chaveidfilial || !auth.idw12) {
    logger.warn({ filial: auth.filial, idw12: auth.idw12, temChaveFilial: !!auth.chaveidfilial },
      'evoClient: faltam chaves de filial/w12 — chamadas podem dar 401');
  }

  const headerBag = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json, text/plain, */*',
    dns: auth.dns,
    filial: auth.filial,
    idw12: auth.idw12,
    chaveidfilial: auth.chaveidfilial,
    chaveidw12: auth.chaveidw12,
  };

  async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const res = await page.evaluate<RawResult, { method: string; url: string; headers: Record<string, string>; body?: string }>(
      async ({ method, url, headers, body }) => {
        const r = await fetch(url, {
          method,
          headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ?? undefined,
        });
        return { status: r.status, body: await r.text() };
      },
      { method, url, headers: headerBag, body: body !== undefined ? JSON.stringify(body) : undefined },
    );

    if (res.status === 401 || res.status === 403) {
      throw new Error(`evoClient ${method} ${url.split('?')[0]} → ${res.status} (auth): ${res.body.slice(0, 120)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`evoClient ${method} ${url.split('?')[0]} → ${res.status}: ${res.body.slice(0, 120)}`);
    }
    try { return JSON.parse(res.body) as T; }
    catch { throw new Error(`evoClient ${method} ${url.split('?')[0]}: resposta não-JSON: ${res.body.slice(0, 120)}`); }
  }

  return {
    auth: { dns: auth.dns, filial: auth.filial, idw12: auth.idw12, chaveidfilial: auth.chaveidfilial, chaveidw12: auth.chaveidw12, tokenLen: auth.token.length, tokenEvo3: auth.tokenEvo3 },
    page,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
  };
}
