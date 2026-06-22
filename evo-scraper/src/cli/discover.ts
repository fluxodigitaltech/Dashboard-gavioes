// CLI: roda discovery mode (loga todo XHR/fetch nas páginas-chave do EVO5).
// Uso: npm run discover
//
// Output: gera arquivo em ./discovery/<timestamp>.discover.json + resumo no stdout.
// Cole esse arquivo na conversa que eu refino os extractors com endpoints reais.

import { runDiscovery } from '../discover.js';
import { logger } from '../lib/logger.js';

runDiscovery()
  .then((file) => {
    console.log(`\n✓ Discovery salvo em ${file}`);
    console.log('Cole o conteúdo (ou só os "uniqueEndpoints" do final) no chat pra refinarmos os extractors.');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, 'discovery failed');
    process.exit(1);
  });
