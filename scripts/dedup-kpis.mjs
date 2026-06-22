// scripts/dedup-kpis.mjs
// ──────────────────────────────────────────────────────────────────────────
// Remove linhas duplicadas da tabela `kpis` no NocoDB.
//
// Contexto: antes do upsert em saveKpi (src/services/nocodbApi.ts), cada
// "Salvar Metas" dava POST cego e criava uma linha NOVA por
// (unidade, categoria, periodo). A tabela acumulou duplicatas. Este script
// mantém, pra cada chave, a linha de MAIOR Id (a mais recente — a mesma que o
// app passou a exibir após o fix de dedup) e apaga as demais.
//
// Uso:
//   node scripts/dedup-kpis.mjs           # DRY-RUN (só mostra o que faria)
//   node scripts/dedup-kpis.mjs --apply   # apaga de verdade
//
// Idempotente: rodar de novo após --apply não acha mais duplicatas.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Hard-coded (sincronize com src/services/nocodbApi.ts → TABLES.kpis)
const NOCODB_TABLE = 'm0e4fmdvti599he';
const NOCODB_BASE = 'https://app.nocodb.com/api/v2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── .env loader (mesmo padrão dos outros scripts) ──────────────────────────
const env = {};
try {
  const txt = readFileSync(resolve(ROOT, '.env'), 'utf-8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  console.error('❌ Não achei .env em', ROOT);
  process.exit(1);
}

const NOCODB_TOKEN = env.VITE_NOCODB_TOKEN;
if (!NOCODB_TOKEN) {
  console.error('❌ VITE_NOCODB_TOKEN ausente em .env');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const headers = { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' };
const recordsUrl = `${NOCODB_BASE}/tables/${NOCODB_TABLE}/records`;

// ─── 1. Busca TODAS as linhas (paginado) ────────────────────────────────────
async function fetchAll() {
  const all = [];
  let offset = 0;
  const limit = 100; // NocoDB cloud capa a página em 100 — pedir mais é ignorado.
  for (;;) {
    const res = await fetch(`${recordsUrl}?limit=${limit}&offset=${offset}&sort=Id`, { headers });
    if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const list = data?.list ?? [];
    all.push(...list);
    const total = data?.pageInfo?.totalRows ?? all.length;
    // Avança pelo nº real de linhas recebidas (não pelo limit pedido).
    offset += list.length;
    if (list.length === 0 || all.length >= total) break;
  }
  return all;
}

// ─── 2. Agrupa e separa quem fica de quem sai ────────────────────────────────
function plan(rows) {
  const byKey = new Map(); // key -> rows[]
  for (const r of rows) {
    const key = `${r.unidade}||${r.categoria}||${r.periodo}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const toDelete = [];
  let groupsWithDup = 0;
  for (const [, group] of byKey) {
    if (group.length <= 1) continue;
    groupsWithDup++;
    // mantém o de MAIOR Id (mais recente), apaga o resto
    group.sort((a, b) => b.Id - a.Id);
    toDelete.push(...group.slice(1));
  }
  return { totalRows: rows.length, uniqueKeys: byKey.size, groupsWithDup, toDelete };
}

// ─── 3. Bulk delete (em lotes) ───────────────────────────────────────────────
async function deleteRows(ids) {
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH).map(Id => ({ Id }));
    const res = await fetch(recordsUrl, { method: 'DELETE', headers, body: JSON.stringify(slice) });
    if (!res.ok) throw new Error(`DELETE ${res.status}: ${await res.text()}`);
    done += slice.length;
    console.log(`   apagadas ${done}/${ids.length}…`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🔎 Lendo tabela kpis (${NOCODB_TABLE})…`);
  const rows = await fetchAll();
  const { totalRows, uniqueKeys, groupsWithDup, toDelete } = plan(rows);

  console.log(`\n📊 Total de linhas:           ${totalRows}`);
  console.log(`   Chaves únicas (un/cat/per): ${uniqueKeys}`);
  console.log(`   Chaves com duplicata:       ${groupsWithDup}`);
  console.log(`   Linhas a remover:           ${toDelete.length}`);
  console.log(`   Linhas que sobram:          ${totalRows - toDelete.length}`);

  if (toDelete.length === 0) {
    console.log('\n✅ Nenhuma duplicata. Nada a fazer.');
    return;
  }

  if (!APPLY) {
    console.log('\n⚠️  DRY-RUN — nada foi apagado. Rode com --apply pra remover.');
    console.log('   Exemplos do que seria removido (até 10):');
    for (const r of toDelete.slice(0, 10)) {
      console.log(`     Id=${r.Id}  ${r.unidade} · ${r.categoria} · ${r.periodo}  (meta=${r.meta}, valor=${r.valor})`);
    }
    return;
  }

  console.log(`\n🗑️  Apagando ${toDelete.length} duplicatas…`);
  await deleteRows(toDelete.map(r => r.Id));
  console.log('\n✅ Limpeza concluída.');
})().catch(e => {
  console.error('\n❌ Erro:', e.message);
  process.exit(1);
});
