// Pipeline ponta-a-ponta: autentica → cria client → extrai KPIs gerenciais →
// salva snapshot em arquivo local (Gaviões não tem NocoDB).
// Uso: npm run snapshot
import { writeFile, mkdir } from 'node:fs/promises';
import { ensureAuthenticated, closeBrowser } from '../auth.js';
import { createEvoClient } from '../evoClient.js';
import { extractGerencial } from '../extractors/gerencial.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

(async () => {
  const { context, page } = await ensureAuthenticated();
  const client = await createEvoClient(page);
  logger.info({ filial: client.auth.filial, dns: client.auth.dns }, 'evoClient pronto');

  const snap = await extractGerencial(client);

  await mkdir('./data', { recursive: true });
  const payload = {
    capturadoEm: new Date().toISOString(),
    branchId: config.evo.branchIds[0],
    ...snap,
  };
  await writeFile('./data/snapshot-latest.json', JSON.stringify(payload, null, 2));

  console.log('\n=== SNAPSHOT GAVIÕES (filial ' + client.auth.filial + ') ===');
  console.log('  ativos:', snap.clientesAtivos, '(mês ant.', snap.clientesAtivosMesAnterior + ')');
  console.log('  adimplentes:', snap.adimplentes, '| inadimplentes:', snap.inadimplentes);
  console.log('  vips:', snap.vips, '| suspensos:', snap.suspensos, '| personais:', snap.personais, '| agregadores:', snap.agregadores);
  console.log('  evasão:', snap.evasaoPerc, '% | tempo médio vida:', snap.tempoMedioVida);
  console.log('  cancelamentos mês:', snap.cancelamentosMes, '| hoje:', snap.cancelamentosHoje, '| renovações:', snap.renovacoes);
  console.log('  check-ins (7d):', snap.checkinsPeriodo);
  console.log('  faturamento PAGO (mês):', snap.faturamentoPago?.toLocaleString('pt-BR'),
    '| mês ant.:', snap.faturamentoPagoMesAnterior?.toLocaleString('pt-BR'));
  console.log('    em cobrança:', snap.faturamentoEmCobranca?.toLocaleString('pt-BR'),
    '| tent. excedidas:', snap.faturamentoTentativasExcedidas?.toLocaleString('pt-BR'),
    '| programadas:', snap.faturamentoProgramado?.toLocaleString('pt-BR'),
    '| total:', snap.faturamentoTotal?.toLocaleString('pt-BR'));
  console.log('  VENDAS (mês):', snap.vendasValor?.toLocaleString('pt-BR'), '| qtd:', snap.vendasQtd,
    '| mês ant.:', snap.vendasValorMesAnterior?.toLocaleString('pt-BR'), '| qtd:', snap.vendasQtdMesAnterior);
  if (snap.erros.length) console.log('  ⚠️ erros:', snap.erros.length, '→', snap.erros.join(' | '));
  console.log('\n→ salvo em data/snapshot-latest.json');

  await context.close();
  await closeBrowser();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'snapshot failed'); process.exit(1); });
