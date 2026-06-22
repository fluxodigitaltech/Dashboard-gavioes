// DIAGNÓSTICO de AULAS EXPERIMENTAIS na unidade Saúde — contra a EVO real.
// Mostra, sessão por sessão, se o campo allowExperimentalClass existe, o ocupation
// e quantos prospects/members há no detalhe — e destaca o caso "tinha lead mas
// ocupation=0" (sessões que o filtro antigo de ocupation>0 perdia).
//
// USO (na raiz do projeto, com o .env do projeto presente):
//   node scripts/test-exp-saude.mjs 2026-06-10            → diagnostica 1 dia (recomendado)
//   node scripts/test-exp-saude.mjs 2026-06-01 2026-06-16 → um intervalo (soma)
//   node scripts/test-exp-saude.mjs                       → hoje
//
// Só faz GET (não muda nada). Regra do Passo 5: lead = idProspect preenchido e idMember nulo.

import { readFileSync } from 'node:fs';

const EVO_API = 'https://evo-integracao-api.w12app.com.br';
const EVO_DNS = 'gavioes';
const UNIDADE = 'Saúde';
const EVO_FILIAL_ID = 3; // IdFilial da EVO p/ Saúde (a EVO pulou o id 2)

function loadToken() {
  if (process.env.VITE_EVO_TOKEN_SAUDE) return process.env.VITE_EVO_TOKEN_SAUDE.trim();
  for (const f of ['.env', '.env.local']) {
    try {
      const txt = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      const m = txt.match(/^\s*VITE_EVO_TOKEN_SAUDE\s*=\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch { /* tenta o próximo */ }
  }
  return '';
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error('Nao achei VITE_EVO_TOKEN_SAUDE (nem no ambiente, nem no .env). Rode na raiz do projeto.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${TOKEN}`).toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const asArray = (x) => Array.isArray(x) ? x : (x && (x.list || x.data || x.result || x.items)) || [];

async function evoGet(path) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(`${EVO_API}${path}`, { headers: { Authorization: AUTH, 'Content-Type': 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (t + 1)); continue; }
      console.warn(`   HTTP ${r.status} em ${path}`);
      return null;
    } catch (e) { await sleep(2000 * (t + 1)); if (t === 3) console.warn('   rede:', e.message); }
  }
  return null;
}

function* eachDay(from, to) {
  const d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
  while (d <= end) {
    yield `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    d.setDate(d.getDate() + 1);
  }
}

async function diagDia(dia) {
  const schedRaw = await evoGet(`/api/v1/activities/schedule?date=${dia}&take=200&showFullWeek=false&idBranch=${EVO_FILIAL_ID}`);
  if (schedRaw === null) { console.log(`[${dia}] falha ao listar a agenda`); return null; }
  const sched = asArray(schedRaw);

  const temFlag = sched.some(s => typeof s?.allowExperimentalClass === 'boolean');
  const aceitam = sched.filter(s => s?.allowExperimentalClass === true);
  const comOcup = sched.filter(s => (Number(s?.ocupation) || 0) > 0);

  console.log(`\n[${dia}]`);
  console.log(`  sessoes na agenda: ${sched.length}`);
  console.log(`  campo allowExperimentalClass presente? ${temFlag ? 'SIM' : 'NAO (usando fallback ocupation>0)'}`);
  if (temFlag) console.log(`    aceitam experimental (true): ${aceitam.length} - nao aceitam: ${sched.length - aceitam.length}`);
  console.log(`  sessoes com ocupation>0: ${comOcup.length}`);

  const alvo = temFlag ? aceitam : comOcup;
  console.log(`  inspecionando o detalhe de ${alvo.length} sessoes:`);

  let leads = 0, membersExp = 0, perdidasOcup0 = 0;
  for (const s of alvo) {
    const id = s.idAtividadeSessao ?? s.idActivitySession;
    const det = await evoGet(`/api/v1/activities/schedule/detail?idActivitySession=${id}`);
    const enr = asArray(det?.enrollments ?? det);
    let p = 0, mem = 0;
    for (const e of enr) {
      if (!!e?.idProspect && !e?.idMember) p++;
      else if (e?.idMember) mem++;
    }
    leads += p; membersExp += mem;
    const ocup = Number(s?.ocupation) || 0;
    const perdida = p > 0 && ocup === 0;
    if (perdida) perdidasOcup0++;
    if (p > 0 || mem > 0) {
      const nome = (s?.name ?? '').toString().trim().slice(0, 22).padEnd(22);
      const hora = (s?.startTime ?? '').toString().slice(0, 5).padStart(5);
      console.log(`    #${id} ${nome} ${hora}  ocup=${ocup}  enroll=${enr.length}  prospects=${p}  members=${mem}${perdida ? '   <-- lead com ocupation=0' : ''}`);
    }
    await sleep(350);
  }
  console.log(`  => dia: leads(prospect)=${leads} - members nessas sessoes=${membersExp} - com lead mas ocup=0: ${perdidasOcup0}`);
  return { leads, membersExp, perdidasOcup0 };
}

const argv = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
const from = argv[0] || today;
const to = argv[1] || from;

console.log(`\n=== DIAGNOSTICO - Aulas Experimentais - ${UNIDADE} (IdFilial EVO=${EVO_FILIAL_ID}) ===`);
console.log(`Token: ****${TOKEN.slice(-4)} - Periodo: ${from} -> ${to}`);

const tot = { leads: 0, membersExp: 0, perdidasOcup0: 0 };
for (const dia of eachDay(from, to)) {
  const r = await diagDia(dia);
  if (r) for (const k of Object.keys(tot)) tot[k] += r[k];
}

console.log(`\n=== TOTAL ${UNIDADE} ${from}..${to} ===`);
console.log(`leads (agendados) = ${tot.leads}`);
console.log(`members presentes em sessoes experimentais = ${tot.membersExp}  (o Passo 5 NAO conta como experimental)`);
console.log(`sessoes com lead mas ocupation=0 (que o filtro antigo perdia) = ${tot.perdidasOcup0}`);
console.log(`\nNotas:`);
console.log(`- Se "leads" aqui for MAIOR que o 11 do painel, era o filtro ocupation>0 perdendo aulas (ja corrigido no servidor).`);
console.log(`- Se voce esperava contar tambem os "members" (BE FREE/cortesia), me avise: o Passo 5 conta so prospect puro.`);
