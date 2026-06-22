// Testa o endpoint obterCobrancasExtrato direto (via evoClient autenticado).
// Confirma que dá pra pegar o "Aprovado do mês" sem paginar (somatorias respeita
// o filtro de status). Uso: npx tsx src/cli/test-cobrancas.ts
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { createEvoClient } from '../evoClient.js';
import { logger } from '../lib/logger.js';

const URL = 'https://evo-abc-api.w12app.com.br/api/v1/cobrancas/obterCobrancasExtrato';

/** Início/fim do mês em ISO UTC = meia-noite BRT (T03:00:00.000Z), igual a SPA manda. */
function mesRange(year: number, month1: number) {
  const de = new Date(Date.UTC(year, month1 - 1, 1, 3, 0, 0)).toISOString();
  const ate = new Date(Date.UTC(year, month1, 0, 3, 0, 0)).toISOString(); // dia 0 do próximo = último dia
  return { de, ate };
}

function body(de: string, ate: string, status: number | null) {
  return {
    skip: 0, take: 1, ordem: 'dtTentativa', ordemDirecao: 'asc',
    dsAdquirente: null, dsBandeira: null,
    dtCobrancaAte: null, dtCobrancaDe: null,
    dtPrevisaoCobrancaAte: null, dtPrevisaoCobrancaDe: null,
    dtTentativaAte: ate, dtTentativaDe: de,
    idsTipoOrigem: null, motivoRecusa: null,
    status, tipoRecusa: null, valor: null,
  };
}

interface Resp { somatorias?: { totalItens: number; totalCobrado: number } }

(async () => {
  const { context, page } = await ensureAuthenticated();
  const client = await createEvoClient(page);

  const meses = [
    { label: 'mai/2026', ...mesRange(2026, 5) },
    { label: 'jun/2026 (este mês)', ...mesRange(2026, 6) },
  ];

  for (const m of meses) {
    const all = await client.post<Resp>(URL, body(m.de, m.ate, null));
    const aprov = await client.post<Resp>(URL, body(m.de, m.ate, 1));
    console.log(`\n=== ${m.label} (${m.de.slice(0,10)} → ${m.ate.slice(0,10)}) ===`);
    console.log('  TODOS    → itens:', all.somatorias?.totalItens, '| total: R$', all.somatorias?.totalCobrado?.toLocaleString('pt-BR'));
    console.log('  APROVADO → itens:', aprov.somatorias?.totalItens, '| total: R$', aprov.somatorias?.totalCobrado?.toLocaleString('pt-BR'));
  }

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'test-cobrancas failed'); process.exit(1); });
