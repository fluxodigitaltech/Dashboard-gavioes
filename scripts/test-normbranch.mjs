// Teste isolado da lógica de casamento de unidade no histórico (espelha
// normBranch + branchAllowed + aggregateHistoryByMonth de src/services/nocodbApi.ts).
// Prova que nomes "sujos" do Belenzinho passam a casar com o filtro "Belenzinho".
// Rodar: node scripts/test-normbranch.mjs

function normBranch(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/GAVIOES/g, '')
    .replace(/BE\s*FREE/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function branchAllowed(raw, allowNorm) {
  const n = normBranch(raw);
  if (!n) return false;
  return allowNorm.some(a => a === n || n.includes(a) || (n.length >= 4 && a.includes(n)));
}
function aggregate(rows, branchNames) {
  const allowNorm = branchNames ? branchNames.map(normBranch).filter(Boolean) : null;
  const byMonth = new Map();
  for (const r of rows) {
    if (allowNorm && !branchAllowed(r.branch_name, allowNorm)) continue;
    const acc = byMonth.get(r.snapshot_month) ?? { month: r.snapshot_month, active_members: 0 };
    acc.active_members += Number(r.active_members) || 0;
    byMonth.set(r.snapshot_month, acc);
  }
  return byMonth;
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('  ✗ FALHOU:', name); } };

const OFICIAIS = ['Altino Arantes', 'Saúde', 'Parque das Nações', 'Alto do Ipiranga', 'Jardins', 'Belenzinho', 'Campestre'];

// 1) Nomes sujos de Belenzinho que ANTES zeravam agora casam com ['Belenzinho'].
for (const sujo of ['Belenzinho', 'Belenzinho ', 'BELENZINHO', 'GAVIOES - BELENZINHO',
                    'Gaviões Belenzinho BE FREE', '  belenzinho  ', 'Belénzinho']) {
  check(`"${sujo}" casa Belenzinho`, branchAllowed(sujo, [normBranch('Belenzinho')]));
}

// 2) Belenzinho NÃO vaza pra outra unidade (sem falso-positivo).
for (const outra of OFICIAIS.filter(u => u !== 'Belenzinho')) {
  check(`Belenzinho não casa "${outra}"`, !branchAllowed('GAVIOES - BELENZINHO', [normBranch(outra)]));
}

// 3) Nenhum nome oficial é substring de outro (segurança do match por inclusão).
for (const a of OFICIAIS) for (const b of OFICIAIS) {
  if (a === b) continue;
  const na = normBranch(a), nb = normBranch(b);
  check(`"${a}" não ⊆ "${b}"`, !(na.includes(nb) || nb.includes(na)));
}

// 4) Agregação: escopo Belenzinho com dado sujo deixa de retornar VAZIO ("Sem histórico").
const rows = [
  { branch_name: 'GAVIOES - BELENZINHO', snapshot_month: '2026-05', active_members: 249 },
  { branch_name: 'Campestre',           snapshot_month: '2026-05', active_members: 242 },
];
const soBelen = aggregate(rows, ['Belenzinho']);
check('escopo Belenzinho retorna o mês 2026-05', soBelen.has('2026-05'));
check('escopo Belenzinho soma 249 ativos', soBelen.get('2026-05')?.active_members === 249);

// 5) "Todas" inclui Belenzinho no total (antes era silenciosamente omitido).
const todas = aggregate(rows, OFICIAIS);
check('Todas soma 249+242=491', todas.get('2026-05')?.active_members === 491);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
