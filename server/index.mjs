// ─────────────────────────────────────────────────────────────────────────────
// Mini-backend de convites por e-mail (Node nativo + nodemailer).
//
// Roda no MESMO container do nginx (porta interna 3001). O nginx faz proxy de
// /api/ pra cá. Só precisa das variáveis de ambiente de e-mail no runtime.
//
// Endpoints:
//   GET  /api/health           → { ok: true }
//   POST /api/invite           → { email }            (admin convida; gera token + envia e-mail)
//   POST /api/set-password     → { token, password }  (pessoa define a senha pelo link do e-mail)
//
// Segurança: o convite só é gerado pra e-mail que JÁ EXISTE na tabela de
// usuários. O token é aleatório, de uso único e expira em 72h.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import nodemailer from 'nodemailer';

const PORT = Number(process.env.INVITE_PORT || 3001);

// ── NocoDB (mesma tabela do front) ───────────────────────────────────────────
const NOCO_BASE  = process.env.NOCODB_BASE   || 'https://outros-sistemas-nocodb.r3k7br.easypanel.host/api/v2';
const NOCO_TABLE = process.env.NOCODB_USERS_TABLE || 'm5gvxov7n0eah6o';
const NOCO_TOKEN = process.env.NOCODB_TOKEN || process.env.VITE_NOCODB_TOKEN || '';

// ── E-mail (nomes de env iguais aos que o usuário já usa) ─────────────────────
const SMTP_HOST   = process.env.SMTP_ADDRESS  || process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 587);
const SMTP_USER   = process.env.SMTP_USERNAME || process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASSWORD || process.env.SMTP_PASS || '';
const MAIL_FROM   = process.env.MAILER_SENDER_EMAIL || SMTP_USER;
const FRONTEND_URL  = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'Gaviões';
const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS || 72);

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // 465 = SSL; 587 = STARTTLS
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ── Rate limit simples (em memória, por IP) ──────────────────────────────────
// /api/invite e /api/set-password são públicos — sem isso, qualquer um pode
// martelar os endpoints (spam de e-mail de convite / brute-force de token).
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);     // req por janela
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const rateBuckets = new Map(); // ip → { count, resetAt }
function rateLimited(req) {
  const ip = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
    .toString().split(',')[0].trim();
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateBuckets.size > 10_000) rateBuckets.clear(); // evita crescimento sem fim
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT_MAX;
}


// ── Histórico de membros (NocoDB self-hosted, agregado em runtime) ───────────
// Lê a tabela "Membros" (1 linha por contrato × competência) e agrega por
// (unidade, mês): ativos, adimplentes, inadimplentes e faturamento estimado.
// O token fica SÓ aqui no runtime (Easypanel) — nunca vai pro bundle do navegador.
const HIST_BASE  = (process.env.NOCODB_HISTORY_BASE  || '').replace(/\/+$/, '');
const HIST_TOKEN =  process.env.NOCODB_HISTORY_TOKEN || '';
const HIST_TABLE =  process.env.NOCODB_HISTORY_TABLE || '';
const HIST_TTL_MS = Number(process.env.NOCODB_HISTORY_TTL_HOURS || 6) * 3600 * 1000;
// Tabela "Recebimentos" (mesma base/token) — histórico do Faturamento Real do Financeiro.
const RECEB_TABLE = process.env.NOCODB_RECEB_TABLE || '';
// ── Webhook de Relatório de Leads (Fluxo/Chatwoot → dashboard) ──────────────
const LEADS_TABLE = process.env.NOCODB_LEADS_TABLE || '';
// Tabela "Leads" (1 LINHA POR LEAD, upsert por mês) — navegável no NocoDB e
// imune ao limite de body (o payload mensal fica leve, sem a lista).
const LEADS_ROWS_TABLE = process.env.NOCODB_LEADS_ROWS_TABLE || '';
// Tabela "LeadConversoes": conversão detectada vira FATO GRAVADO (append-only).
// A contagem lê daqui — estável por construção; o scan só ADICIONA novas.
const CONV_TABLE = process.env.NOCODB_CONV_TABLE || '';
// ── Snapshot COMPARTILHADO do mês corrente ──────────────────────────────────
// Membros/vendas do mês ficam salvos no NocoDB: quem abre o painel lê o
// snapshot pronto (zero EVO); quem clica "Atualizar" busca na EVO e PUBLICA o
// dado novo pra todo mundo. A tabela é criada automaticamente se não existir.
const NOCODB_BASE_ID = process.env.NOCODB_BASE_ID || 'pbw1fuehehbh4im';
let SNAP_TABLE = process.env.NOCODB_SNAPSHOT_TABLE || '';
// ── Meta (Facebook) Marketing API — token lido em RUNTIME (env do EasyPanel) ──
// Antes ficava só no bundle do front (VITE_META_ACCESS_TOKEN, build-time +
// exposto no JS público). Agora o front chama /api/meta/* e o servidor injeta o
// token aqui — trocar o token = atualizar o env e reiniciar, SEM rebuild.
// Aceita META_ACCESS_TOKEN ou o nome legado VITE_META_ACCESS_TOKEN.
const META_GRAPH = 'https://graph.facebook.com/v19.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN || process.env.VITE_META_ACCESS_TOKEN || '';
const LEADS_SECRET = process.env.LEADS_WEBHOOK_SECRET || '';
// Pull sob demanda (seção 6 do handoff): busca o relatório direto na API do
// Fluxo — pra trazer dados AGORA sem esperar o webhook das 06:10, e pra
// reprocessar meses fechados. Token de Agent Bot recomendado.
const FLUXO_BASE    = (process.env.FLUXO_API_BASE || 'https://atendimento.fluxodigitaltech.com.br').replace(/\/+$/, '');
const FLUXO_TOKEN   = process.env.FLUXO_API_TOKEN || '';
const FLUXO_ACCOUNT = process.env.FLUXO_ACCOUNT_ID || '';

// Nomes oficiais das unidades no dashboard (mesmos do evoApi BRANCHES).
const HIST_UNITS = ['Altino Arantes', 'Saúde', 'Parque das Nações', 'Alto do Ipiranga', 'Jardins', 'Belenzinho', 'Campestre'];
// "GAVIOES - BELENZINHO" → "BELENZINHO"; "GAVIOES SAÚDE" → "SAUDE"; etc.
const histNorm = (s) => String(s || '')
  .toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/GAVIOES/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const HIST_UNIT_BY_NORM = new Map(HIST_UNITS.map(u => [histNorm(u), u]));

// Mapeia o NomeFilial cru pra um nome OFICIAL de unidade, tolerante a variações
// ("GAVIOES - BELENZINHO BE FREE", "Belenzinho - SP", etc.). Antes era match exato
// via HIST_UNIT_BY_NORM.get() e qualquer divergência (token extra) fazia a unidade
// inteira SUMIR do histórico (ex.: Campestre aparecia, Belenzinho não). Aqui:
//   1) tenta match exato pela chave normalizada;
//   2) senão, casa se o nome oficial estiver CONTIDO no nome dos dados (ou vice-versa)
//      — seguro porque nenhum nome oficial é substring de outro;
//   3) senão, loga 1x o valor não-mapeado (pra criar alias se for nome totalmente diferente).
const _histUnmapped = new Set();
function mapHistUnit(raw) {
  const n = histNorm(raw);
  if (!n) return null;
  const exact = HIST_UNIT_BY_NORM.get(n);
  if (exact) return exact;
  for (const [norm, official] of HIST_UNIT_BY_NORM) {
    if (n.includes(norm) || norm.includes(n)) return official;
  }
  if (!_histUnmapped.has(n)) {
    _histUnmapped.add(n);
    console.warn(`[history] NomeFilial sem mapeamento p/ unidade oficial: "${raw}" (norm="${n}")`);
  }
  return null;
}

let histCache = { at: 0, rows: null };
let histInflight = null;
let recebCache = { at: 0, rows: null };
let recebInflight = null;
let backfillJob = { running: false, startedAt: 0, total: 0, resultados: [] };
let convRowsCache = { at: 0, rows: null };
let lastConvScan = 0;
let convScanInflight = null;

async function buildHistoryRows() {
  // Pagina a tabela inteira só com os campos necessários.
  const fields = 'Competencia,NomeFilial,StatusCliente,StatusContrato,ContratoVip,ValorContrato,IdCliente';
  const all = [];
  for (let offset = 0; offset < 200000; offset += 1000) {
    const url = `${HIST_BASE}/tables/${HIST_TABLE}/records?fields=${fields}&limit=1000&offset=${offset}`;
    const r = await fetch(url, { headers: { 'xc-token': HIST_TOKEN } });
    if (!r.ok) throw new Error(`NocoDB history GET ${r.status}`);
    const data = await r.json();
    const list = data?.list || [];
    all.push(...list);
    if (list.length < 1000) break;
  }

  // Agrupa por (unidade, competência) com DEDUP por IdCliente (cliente com 2
  // contratos no mês conta 1x; inadimplente se QUALQUER contrato inadimplente;
  // VIP se qualquer contrato VIP; faturamento = Σ ValorContrato dos contratos
  // adimplentes de clientes não-VIP). Suspensos ficam fora (regra v11 do app).
  const groups = new Map(); // 'unidade|YYYY-MM' → Map(idCliente → { vip, inad, fat })
  for (const row of all) {
    if (String(row.StatusCliente) === 'Suspenso') continue;
    const unit = mapHistUnit(row.NomeFilial);
    const month = String(row.Competencia || '').slice(0, 7);
    if (!unit || !/^\d{4}-\d{2}$/.test(month)) continue;
    const gKey = `${unit}|${month}`;
    if (!groups.has(gKey)) groups.set(gKey, new Map());
    const clients = groups.get(gKey);
    const cid = String(row.IdCliente ?? `anon:${Math.random()}`);
    if (!clients.has(cid)) clients.set(cid, { vip: false, inad: false, fat: 0, val: 0 });
    const c = clients.get(cid);
    if (String(row.ContratoVip) === 'Yes') { c.vip = true; continue; }
    c.val += Number(row.ValorContrato) || 0; // total de contratos do cliente (pro risco)
    if (String(row.StatusContrato) === 'Inadimplente') c.inad = true;
    else c.fat += Number(row.ValorContrato) || 0;
  }

  const rows = [];
  for (const [gKey, clients] of groups) {
    const [branch_name, snapshot_month] = gKey.split('|');
    let adimp = 0, inad = 0, fat = 0, fatInad = 0;
    for (const c of clients.values()) {
      if (c.vip) continue;            // VIP fora da contagem de ativos (regra do Painel)
      if (c.inad) { inad += 1; fatInad += c.val; } // risco = contratos do inadimplente
      else { adimp += 1; fat += c.fat; }
    }
    rows.push({
      branch_name, snapshot_month, period_kind: 'monthly',
      active_members: adimp + inad,
      adimplentes: adimp,
      inadimplentes: inad,
      faturamento_adimplentes: Math.round(fat * 100) / 100,
      faturamento_inadimplentes: Math.round(fatInad * 100) / 100,
      vendas_qtd: 0, vendas_valor: 0,   // vendas vêm de outra fonte (merge no front)
      source: 'manual',
    });
  }
  rows.sort((a, b) => a.snapshot_month.localeCompare(b.snapshot_month) || a.branch_name.localeCompare(b.branch_name));
  return rows;
}

async function buildRecebimentosRows() {
  // Tabela "Recebimentos": 1 linha por cobrança × competência.
  //   Faturamento REAL  = Σ ValorBaixa das linhas COM DtRecebimento (pago de fato)
  //   total_amount      = Σ Valor de todas as linhas da competência (lançado)
  //   total_pending     = Σ Valor das linhas SEM DtRecebimento (a receber)
  const fields = 'Competencia,Filial,Valor,ValorBaixa,DtRecebimento,IdCliente';
  const groups = new Map(); // 'unidade|YYYY-MM' → { amt, rec, pend, n, payers:Set }
  for (let offset = 0; offset < 300000; offset += 1000) {
    const url = `${HIST_BASE}/tables/${RECEB_TABLE}/records?fields=${fields}&limit=1000&offset=${offset}`;
    const r = await fetch(url, { headers: { 'xc-token': HIST_TOKEN } });
    if (!r.ok) throw new Error(`NocoDB recebimentos GET ${r.status}`);
    const data = await r.json();
    const list = data?.list || [];
    for (const row of list) {
      const unit = mapHistUnit(row.Filial);
      const month = String(row.Competencia || '').slice(0, 7);
      if (!unit || !/^\d{4}-\d{2}$/.test(month)) continue;
      const key = `${unit}|${month}`;
      const g = groups.get(key) || { amt: 0, rec: 0, pend: 0, n: 0, payers: new Set() };
      g.n += 1;
      g.amt += Number(row.Valor) || 0;
      if (row.DtRecebimento) {
        g.rec += Number(row.ValorBaixa) || 0;
        if (row.IdCliente != null) g.payers.add(String(row.IdCliente));
      } else {
        g.pend += Number(row.Valor) || 0;
      }
      groups.set(key, g);
    }
    if (list.length < 1000) break;
  }
  const rows = [];
  for (const [key, g] of groups) {
    const [branch_name, snapshot_month] = key.split('|');
    rows.push({
      branch_name, snapshot_month,
      total_amount:   Math.round(g.amt * 100) / 100,
      total_received: Math.round(g.rec * 100) / 100,
      total_pending:  Math.round(g.pend * 100) / 100,
      pagantes: g.payers.size,
      rows_count: g.n,
    });
  }
  rows.sort((a, b) => a.snapshot_month.localeCompare(b.snapshot_month) || a.branch_name.localeCompare(b.branch_name));
  return rows;
}

// ── Leads: corpo bruto (pra HMAC), validação de assinatura e upsert ─────────
function readRawBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > maxBytes) { req.destroy(); reject(new Error('payload muito grande')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function leadsSignatureCheck(req, rawBody) {
  // HMAC-SHA256 de "{timestamp}.{corpo_bruto}" com o secret do webhook.
  // Retorna null se ok, ou o MOTIVO da recusa (vai no corpo do 401 e no log —
  // diagnóstico imediato em vez de "assinatura inválida" genérico).
  const ts = String(req.headers['x-chatwoot-timestamp'] || '');
  const sig = String(req.headers['x-chatwoot-signature'] || '');
  if (!ts || !sig) return 'headers X-Chatwoot-Timestamp/X-Chatwoot-Signature ausentes';
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (skew > 300) return `timestamp fora da janela anti-replay (skew ${Math.round(skew)}s > 300s)`;
  const expected = 'sha256=' + crypto.createHmac('sha256', LEADS_SECRET)
    .update(`${ts}.${rawBody}`).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return 'HMAC não confere — o secret configurado aqui não é o mesmo do webhook no Fluxo (LEADS_WEBHOOK_SECRET)';
    }
  } catch {
    return 'formato da assinatura inesperado (esperado sha256=<hex de 64 chars>)';
  }
  return null;
}

const leadsHeaders = () => ({ 'xc-token': HIST_TOKEN, 'Content-Type': 'application/json' });
let leadsMonthCache = new Map(); // month → { at, payload } (5 min)
const LEADS_CACHE_MS = 5 * 60 * 1000;
let convSummaryCache = { at: 0, months: null }; // resumo de conversão por mês (5 min)

async function upsertMonthRow(report, deliveryId) {
  // Upsert por (account_id, month): o relatório é month-to-date — SUBSTITUI, não soma.
  const accountId = Number(report.account_id) || 0;
  const month = String(report?.period?.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`period.month inválido: ${month}`);
  const where = `(account_id,eq,${accountId})~and(month,eq,${encodeURIComponent(month)})`;
  const found = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?where=${where}&fields=Id,delivery_id&limit=1`, { headers: leadsHeaders() }).then(r => r.json());
  const existing = found?.list?.[0];
  // Dedup por X-Chatwoot-Delivery: reentrega da MESMA entrega não regrava.
  if (existing && deliveryId && existing.delivery_id === deliveryId) return 'duplicado';
  // Com a tabela de linhas configurada, o payload mensal vai SEM a lista —
  // leve (só totais) e imune ao limite de body do NocoDB. A lista vive em
  // LEADS_ROWS_TABLE, 1 linha por lead.
  const leadsList = report?.leads ?? [];
  const storedReport = LEADS_ROWS_TABLE
    ? { ...report, leads: [], leads_count: leadsList.length }
    : report;
  const fields = {
    account_id: accountId,
    month,
    generated_at: String(report?.period?.generated_at || new Date().toISOString()),
    delivery_id: deliveryId || '',
    payload: JSON.stringify(storedReport),
  };
  const method = existing ? 'PATCH' : 'POST';
  const body = existing ? { Id: existing.Id, ...fields } : fields;
  const r = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records`, {
    method, headers: leadsHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    const kb = Math.round(JSON.stringify(body).length / 1024);
    throw new Error(`NocoDB leads ${method} ${r.status} (payload ~${kb}KB) ${detalhe.slice(0, 200)}`);
  }
  if (LEADS_ROWS_TABLE) {
    // SEMPRE acumula (merge por conversation_id, update+insert, NUNCA apaga):
    // payloads chegam com escopos diferentes (anuncio diário, all manual) e o
    // replace apagava as conversas orgânicas — que CONTAM pra conversão
    // ("todo mundo que virou venda conta como lead").
    await leadsRowsMergeMonth(accountId, month, leadsList);
  }
  leadsMonthCache.delete(month);
  convSummaryCache = { at: 0, months: null }; // resumo desatualizado
  return existing ? 'atualizado' : 'criado';
}

async function leadsUpsert(report, deliveryId) {
  const month = String(report?.period?.month || '');
  if (month !== 'all') return upsertMonthRow(report, deliveryId);

  // ── CARGA HISTÓRICA (period.month: "all") ─────────────────────────────────
  // Cobre o período inteiro: fatiamos os leads[] POR MÊS (created_at) e fazemos
  // upsert mês a mês — carga histórica e pushes diários convivem sem duplicar
  // (o push do mês corrente substitui a fatia recalculada depois).
  const leads = report?.leads ?? [];
  const porMes = new Map();
  for (const l of leads) {
    const m = String(l?.created_at || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    if (!porMes.has(m)) porMes.set(m, []);
    porMes.get(m).push(l);
  }
  const scopeAll = report?.scope === 'all';
  const resultados = [];
  for (const [m, ls] of [...porMes.entries()].sort()) {
    // Recalcula os totais da fatia. by_* só de leads COM anúncio (mesma
    // semântica do payload mensal). Com scope=anuncio não dá pra saber o total
    // geral de conversas do mês → fica 0 e recomputed=true sinaliza pro front.
    const byAd = new Map(), byTeam = new Map(), byInbox = new Map();
    let anuncio = 0;
    for (const l of ls) {
      if (!l.ad_label) continue;
      anuncio++;
      byAd.set(l.ad_label, (byAd.get(l.ad_label) || 0) + 1);
      if (l.team) byTeam.set(l.team, (byTeam.get(l.team) || 0) + 1);
      if (l.inbox) byInbox.set(l.inbox, (byInbox.get(l.inbox) || 0) + 1);
    }
    const fatia = {
      event: 'leads_report',
      account_id: report.account_id,
      account_name: report.account_name,
      scope: report.scope ?? 'anuncio',
      recomputed: true, // totais recalculados da carga histórica
      period: { month: m, from: report?.period?.from, to: report?.period?.to, generated_at: report?.period?.generated_at },
      totals: {
        new_conversations: scopeAll ? ls.length : 0,
        leads_anuncio: anuncio,
        by_ad:   [...byAd].map(([label, count]) => ({ ad_id: null, ad_name: label, label, count })),
        by_team: [...byTeam].map(([team_name, count]) => ({ team_name, count })),
        by_inbox:[...byInbox].map(([inbox_name, count]) => ({ inbox_name, count })),
      },
      truncated: !!report?.truncated,
      leads: ls,
    };
    resultados.push(`${m}:${await upsertMonthRow(fatia, deliveryId)}`);
  }
  return `histórico → ${resultados.length} meses (${resultados.join(', ')})`;
}

// ── Tabela Leads (1 linha por lead) ─────────────────────────────────────────
// Substituição por mês: apaga as linhas do (account, mês) e insere as novas em
// lotes — mantém a semântica month-to-date do relatório sem duplicar.
function leadRowFields(accountId, month, l) {
  return {
    conversation_id: Number(l.conversation_id) || 0,
    account_id: accountId,
    month,
    display_id: l.display_id ?? null,
    status: l.status ?? '',
    created_at_lead: String(l.created_at ?? ''),
    contact_id: l.contact?.id ?? null,
    contact_name: String(l.contact?.name ?? ''),
    phone: String(l.contact?.phone_number ?? ''),
    email: String(l.contact?.email ?? ''),
    ad_label: String(l.ad_label ?? ''),
    team: String(l.team ?? ''),
    inbox: String(l.inbox ?? ''),
    unit: String(l.unit ?? ''),
  };
}

// MERGE por conversation_id — usado quando o relatório vem TRUNCADO (cap de
// 2.000 do Fluxo): atualiza os que já existem (status muda!), insere os novos
// e NÃO apaga ninguém. A união das entregas diárias reconstrói o mês completo.
async function leadsRowsMergeMonth(accountId, month, leads) {
  if (!LEADS_ROWS_TABLE || !(leads ?? []).length) return;
  const where = `(account_id,eq,${accountId})~and(month,eq,${encodeURIComponent(month)})`;
  const byConv = new Map(); // conversation_id → Id existente
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records?where=${where}&fields=Id,conversation_id&limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    for (const x of list) byConv.set(Number(x.conversation_id), x.Id);
    if (list.length < 1000) break;
  }
  const updates = [], inserts = [];
  for (const l of leads) {
    const fields = leadRowFields(accountId, month, l);
    const id = byConv.get(fields.conversation_id);
    if (id) updates.push({ Id: id, ...fields });
    else inserts.push(fields);
  }
  for (let i = 0; i < updates.length; i += 200) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records`, {
      method: 'PATCH', headers: leadsHeaders(), body: JSON.stringify(updates.slice(i, i + 200)),
    });
    if (!r.ok) throw new Error(`NocoDB leads-rows PATCH ${r.status}`);
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records`, {
      method: 'POST', headers: leadsHeaders(), body: JSON.stringify(inserts.slice(i, i + 200)),
    });
    if (!r.ok) throw new Error(`NocoDB leads-rows POST ${r.status}`);
  }
}

async function leadsRowsReplaceMonth(accountId, month, leads) {
  if (!LEADS_ROWS_TABLE) return;
  const where = `(account_id,eq,${accountId})~and(month,eq,${encodeURIComponent(month)})`;
  // coleta os Ids existentes (paginado)
  const ids = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records?where=${where}&fields=Id&limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    ids.push(...list.map(x => ({ Id: x.Id })));
    if (list.length < 1000) break;
  }
  for (let i = 0; i < ids.length; i += 100) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records`, {
      method: 'DELETE', headers: leadsHeaders(), body: JSON.stringify(ids.slice(i, i + 100)),
    });
    if (!r.ok) throw new Error(`NocoDB leads-rows DELETE ${r.status}`);
  }
  const rows = (leads ?? []).map(l => leadRowFields(accountId, month, l));
  for (let i = 0; i < rows.length; i += 200) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records`, {
      method: 'POST', headers: leadsHeaders(), body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!r.ok) {
      const det = await r.text().catch(() => '');
      throw new Error(`NocoDB leads-rows POST ${r.status} ${det.slice(0, 150)}`);
    }
  }
}

async function leadsRowsFetchMonth(month) {
  const out = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${LEADS_ROWS_TABLE}/records?where=(month,eq,${encodeURIComponent(month)})&limit=1000&offset=${offset}&sort=created_at_lead`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    for (const x of list) {
      out.push({
        conversation_id: x.conversation_id,
        display_id: x.display_id ?? undefined,
        status: x.status || undefined,
        created_at: x.created_at_lead || undefined,
        contact: { id: x.contact_id ?? undefined, name: x.contact_name || undefined, phone_number: x.phone || null, email: x.email || null },
        ad_label: x.ad_label || null,
        team: x.team || undefined,
        inbox: x.inbox || undefined,
        unit: x.unit || undefined,
      });
    }
    if (list.length < 1000) break;
  }
  return out;
}

// Lê o relatório de 1 mês com cache (5 min). Fonte única pros endpoints de
// leitura e de conversão — evita buscar + parsear a mesma linha duas vezes.
async function getLeadsReport(month) {
  const hit = leadsMonthCache.get(month);
  if (hit && Date.now() - hit.at < LEADS_CACHE_MS) return hit.payload;
  const r = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?where=(month,eq,${encodeURIComponent(month)})&limit=1`, { headers: leadsHeaders() }).then(x => x.json());
  let payload = null;
  try { payload = r?.list?.[0] ? JSON.parse(r.list[0].payload) : null; } catch { payload = null; }
  // Formato novo: payload leve (sem a lista) + leads na tabela individual.
  if (payload && LEADS_ROWS_TABLE && (!payload.leads || payload.leads.length === 0)) {
    try { payload = { ...payload, leads: await leadsRowsFetchMonth(month) }; }
    catch (e) { console.warn('[leads] fetch das linhas falhou:', e); }
  }
  leadsMonthCache.set(month, { at: Date.now(), payload });
  return payload;
}

// fetch com timeout — sem isso, uma chamada pendurada trava o backfill inteiro.
async function fetchComTimeout(url, options = {}, ms = 120_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`timeout após ${Math.round(ms / 1000)}s`);
    throw e;
  } finally { clearTimeout(t); }
}

async function leadsPullScope(month, scope) {
  const qs = `?${scope === 'all' ? 'scope=all&' : ''}${month ? `month=${encodeURIComponent(month)}` : ''}`.replace(/&$/, '').replace(/\?$/, '');
  const url = `${FLUXO_BASE}/api/v1/accounts/${FLUXO_ACCOUNT}/leads_report${qs ? qs : ''}`;
  const r = await fetchComTimeout(url, { headers: { api_access_token: FLUXO_TOKEN } }, 120_000);
  if (!r.ok) throw new Error(`Fluxo API ${r.status}`);
  const report = await r.json();
  if (report?.event !== 'leads_report' || !report?.period?.month) {
    throw new Error('resposta da API do Fluxo não parece um leads_report');
  }
  await leadsUpsert(report, `pull-${scope}:${new Date().toISOString()}`);
  return report;
}

async function leadsPull(month) {
  // DOIS escopos, tudo acumulado na tabela (merge):
  //  1. anuncio → conjunto COMPLETO de leads etiquetados (não trunca);
  //  2. all     → conversas orgânicas (até o cap de 2.000) — contam pra
  //     conversão: "todo mundo que virou venda conta como lead".
  // O payload do escopo anuncio fica como oficial dos TOTAIS do mês.
  const all = await leadsPullScope(month, 'all').catch(e => { console.warn('[leads] pull all falhou:', e?.message || e); return null; });
  const anuncio = await leadsPullScope(month, 'anuncio');
  return anuncio ?? all;
}
const leadsPullEnabled = () => !!(FLUXO_TOKEN && FLUXO_ACCOUNT && HIST_BASE && HIST_TOKEN && LEADS_TABLE);

// ── Conversão lead → aluno: índice de MEMBROS por telefone e nome ───────────
// Cruza os leads do Fluxo com a tabela Membros (self-hosted). Telefone é o
// match forte (últimos 8 dígitos — tolera +55/DDD/9º dígito); nome completo
// normalizado é o fallback (exige ≥2 palavras pra não casar homônimo).
let membersIdx = { at: 0, idx: null };
let membersIdxInflight = null;
async function buildMembersIndex() {
  const fields = 'IdCliente,Nome,SNome,Celular,NomeFilial,Competencia,DataCadastro,DtVenda';
  // TODAS as competências contam: junta todos os telefones que o cliente já
  // usou e guarda a PRIMEIRA data de cadastro/venda (virou aluno = primeira
  // vez; renovação posterior não pode transformar "já era" em "virou").
  const clientes = new Map(); // IdCliente → { phones:Set, nome, unidade, comp, minCad, minVenda }
  for (let offset = 0; offset < 200000; offset += 1000) {
    const url = `${HIST_BASE}/tables/${HIST_TABLE}/records?fields=${fields}&limit=1000&offset=${offset}`;
    const r = await fetch(url, { headers: { 'xc-token': HIST_TOKEN } });
    if (!r.ok) throw new Error(`NocoDB members GET ${r.status}`);
    const list = (await r.json())?.list || [];
    for (const row of list) {
      const cid = String(row.IdCliente ?? '');
      if (!cid) continue;
      let c = clientes.get(cid);
      if (!c) { c = { phones: new Set(), nome: '', unidade: '', comp: '', minCad: '', minVenda: '' }; clientes.set(cid, c); }
      const digits = String(row.Celular ?? '').replace(/\D/g, '');
      if (digits.length >= 8) c.phones.add(digits.slice(-8));
      const cad = String(row.DataCadastro || '').slice(0, 10);
      const ven = String(row.DtVenda || '').slice(0, 10);
      if (cad && (!c.minCad || cad < c.minCad)) c.minCad = cad;
      if (ven && (!c.minVenda || ven < c.minVenda)) c.minVenda = ven;
      // nome/unidade da competência mais recente (exibição)
      if (String(row.Competencia) > c.comp) {
        c.comp = String(row.Competencia);
        c.nome = `${row.Nome ?? ''} ${row.SNome ?? ''}`.trim();
        c.unidade = mapHistUnit(row.NomeFilial) || String(row.NomeFilial || '');
      }
    }
    if (list.length < 1000) break;
  }
  const byPhone = new Map(); const byName = new Map();
  for (const [cid, c] of clientes) {
    const rec = { idCliente: cid, nome: c.nome, unidade: c.unidade, cadastro: c.minCad, venda: c.minVenda };
    for (const p of c.phones) if (!byPhone.has(p)) byPhone.set(p, rec);
    const nn = histNorm(c.nome);
    if (nn && nn.split(' ').length >= 2 && !byName.has(nn)) byName.set(nn, rec);
  }
  return { byPhone, byName };
}
// ── Vendas do mês na EVO (server-side) — pega quem FECHOU matrícula agora,
// antes mesmo de aparecer na importação mensal de Membros. Tokens VITE_EVO_*
// estão no env do runtime (Easypanel injeta as mesmas variáveis do build).
const EVO_API = 'https://evo-integracao-api.w12app.com.br';
const EVO_DNS = 'gavioes';
// Gaviões: unidade única "Gaviões" (branchId 59, DNS 'gavioes'). O token é o da
// API DE INTEGRAÇÃO do EVO (chave Basic), NÃO o login do scraper (usuário/senha).
// Definido em runtime via VITE_EVO_TOKEN_GAVIOES no serviço do dashboard.
const EVO_UNIT_TOKENS = () => ({
  'Gaviões': process.env.VITE_EVO_TOKEN_GAVIOES,
});

// DETERMINÍSTICO: unidades em sequência (ordem fixa), retry com backoff em
// falha transitória (429/5xx/timeout), e flag `completo`. Sem isso a EVO
// intermitente fazia o índice mudar a cada chamada — e a contagem de "virou
// aluno" dançava junto.
// ── PADRÃO ESTRUTURADO DE VENDAS ─────────────────────────────────────────────
// A EVO é só o SINCRONIZADOR: as vendas (matrículas novas) ficam gravadas na
// tabela VendasEvo (1 linha por venda, upsert por id_sale, auto-criada).
// O processo de conversão lê a TABELA — determinístico, auditável, sem 429.
let VENDAS_TABLE = process.env.NOCODB_VENDAS_TABLE || '';
let vendasEnsureInflight = null;
const vendasSyncGuard = new Map(); // month → timestamp do último sync COMPLETO
let vendasRowsCache = { at: 0, rows: null };
let vendasRowsInflight = null;
let vendasBackfillJob = { running: false, startedAt: 0, total: 0, done: 0, resultados: [] };
const VENDAS_ROWS_TTL_MS = 5 * 60 * 1000;

// Carrega a tabela VendasEvo INTEIRA (todos os meses) UMA vez e cacheia em
// memória — o cruzamento de leads e o /api/vendas-range leem daqui, sem bater
// no NocoDB a cada request. Dedup de inflight: chamadas concorrentes esperam o
// mesmo load. Invalidado em syncVendasMonth quando entram vendas novas.
async function getAllVendasRows() {
  if (vendasRowsCache.rows && Date.now() - vendasRowsCache.at < VENDAS_ROWS_TTL_MS) return vendasRowsCache.rows;
  if (vendasRowsInflight) return vendasRowsInflight;
  vendasRowsInflight = (async () => {
    const t = await ensureVendasTable();
    if (!t) return [];
    const rows = [];
    for (let offset = 0; offset < 200000; offset += 1000) {
      const r = await fetch(`${HIST_BASE}/tables/${t}/records?fields=id_sale,id_member,nome,unidade,sale_date,plano,valor,telefone&limit=1000&offset=${offset}&sort=sale_date`, { headers: leadsHeaders() }).then(x => x.json());
      const list = r?.list || [];
      rows.push(...list);
      if (list.length < 1000) break;
    }
    vendasRowsCache = { at: Date.now(), rows };
    return rows;
  })().finally(() => { vendasRowsInflight = null; });
  return vendasRowsInflight;
}

// ── Leitura do HISTÓRICO de vendas direto da tabela EXISTENTE do NocoDB ──────
// O Painel lê o histórico passado da tabela "Vendas" que JÁ está no NocoDB (não
// re-sincroniza da EVO — por isso é instantâneo). Detecção flexível de colunas
// (não sabemos os títulos exatos) + parsing tolerante de valor/data. ID padrão =
// o da URL que o usuário mandou; sobrescrevível por NOCODB_VENDAS_HIST_TABLE.
const HIST_VENDAS_TABLE = process.env.NOCODB_VENDAS_HIST_TABLE || 'mpt1rfojnhqnhtc';
let histVendasCache = { at: 0, rows: null, cols: null };
let histVendasInflight = null;

const vNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const V_ALIASES = {
  nome:     ['nome', 'name', 'aluno', 'cliente', 'nomealuno', 'nomecliente', 'nomedoaluno', 'nomedocliente'],
  unidade:  ['unidade', 'filial', 'branch', 'academia', 'nomefilial', 'unit', 'loja', 'franquia'],
  saledate: ['saledate', 'datavenda', 'datadavenda', 'datamatricula', 'dtmatricula', 'datacadastro', 'competencia', 'data', 'date'],
  valor:    ['valor', 'valortotal', 'valorvenda', 'valorcontrato', 'value', 'total', 'vlr', 'preco'],
  plano:    ['plano', 'planovendido', 'plan', 'produto', 'contrato', 'descricao'],
  idsale:   ['idsale', 'idvenda', 'codvenda', 'codigovenda', 'idsaleevo'],
  idmember: ['idmember', 'idcliente', 'idaluno', 'idmembro', 'membro'],
  telefone: ['telefone', 'celular', 'whatsapp', 'phone', 'fone', 'contato', 'tel'],
};
function resolveVendasCols(sample) {
  const entries = Object.keys(sample || {}).map(k => [vNorm(k), k]);
  const find = (aliases) => {
    for (const a of aliases) { const e = entries.find(([n]) => n === a); if (e) return e[1]; }       // match exato
    for (const a of aliases) { const e = entries.find(([n]) => n.includes(a)); if (e) return e[1]; } // contém
    return null;
  };
  const out = {};
  for (const key of Object.keys(V_ALIASES)) out[key] = find(V_ALIASES[key]);
  return out;
}
function parseVValor(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // BR: "1.234,56" → "1234.56"
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function parseVData(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);           // ISO YYYY-MM-DD
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);                   // dd/mm/yyyy
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;                     // YYYY-MM (competência)
  return s.slice(0, 10);
}
async function getHistVendasRows() {
  if (histVendasCache.rows && Date.now() - histVendasCache.at < VENDAS_ROWS_TTL_MS) return histVendasCache.rows;
  if (histVendasInflight) return histVendasInflight;
  histVendasInflight = (async () => {
    if (!HIST_BASE || !HIST_TOKEN || !HIST_VENDAS_TABLE) return [];
    const raw = [];
    for (let offset = 0; offset < 200000; offset += 1000) {
      const r = await fetch(`${HIST_BASE}/tables/${HIST_VENDAS_TABLE}/records?limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json()).catch(() => null);
      const list = r?.list || [];
      raw.push(...list);
      if (list.length < 1000) break;
    }
    if (!raw.length) { histVendasCache = { at: Date.now(), rows: [], cols: null }; return []; }
    const cols = resolveVendasCols(raw[0]);
    const rows = raw.map(v => ({
      id_sale:   cols.idsale ? Number(v[cols.idsale]) || 0 : 0,
      id_member: cols.idmember ? Number(v[cols.idmember]) || null : null,
      nome:      cols.nome ? String(v[cols.nome] || '').trim() : '',
      unidade:   cols.unidade ? String(v[cols.unidade] || '').trim() : '',
      sale_date: cols.saledate ? parseVData(v[cols.saledate]) : '',
      plano:     cols.plano ? String(v[cols.plano] || '').trim() : '',
      valor:     cols.valor ? parseVValor(v[cols.valor]) : 0,
      telefone:  cols.telefone ? String(v[cols.telefone] || '') : '',
    }));
    histVendasCache = { at: Date.now(), rows, cols };
    console.log(`[vendas-hist] ${rows.length} linhas da tabela ${HIST_VENDAS_TABLE} · colunas: ${JSON.stringify(cols)}`);
    return rows;
  })().finally(() => { histVendasInflight = null; });
  return histVendasInflight;
}

// ── Histórico de CANCELAMENTOS (tabela do NocoDB) — evasão de meses passados ──
// Mesma estratégia da VendasEvo: lê a tabela inteira, detecta colunas por apelido
// (nome/unidade/data do cancelamento/motivo) e cacheia em memória. ID padrão = o
// da URL que o usuário mandou; sobrescrevível por NOCODB_CANCEL_TABLE.
const HIST_CANCEL_TABLE = process.env.NOCODB_CANCEL_TABLE || 'mkw14ex7ysfgrr9';
let cancelCache = { at: 0, rows: null, cols: null };
let cancelInflight = null;
const C_ALIASES = {
  nome:    ['nome', 'name', 'aluno', 'cliente', 'nomealuno', 'nomecliente', 'nomedoaluno'],
  unidade: ['unidade', 'filial', 'branch', 'academia', 'nomefilial', 'unit', 'loja', 'franquia'],
  data:    ['datacancelamento', 'dtcancelamento', 'datacancel', 'canceldate', 'datasaida', 'datafim', 'datademissao', 'datacadastro', 'competencia', 'data', 'date'],
  motivo:  ['motivo', 'reason', 'causa', 'motivocancelamento', 'observacao', 'obs'],
};
function resolveCancelCols(sample) {
  const entries = Object.keys(sample || {}).map(k => [vNorm(k), k]);
  const find = (aliases) => {
    for (const a of aliases) { const e = entries.find(([n]) => n === a); if (e) return e[1]; }
    for (const a of aliases) { const e = entries.find(([n]) => n.includes(a)); if (e) return e[1]; }
    return null;
  };
  const out = {};
  for (const key of Object.keys(C_ALIASES)) out[key] = find(C_ALIASES[key]);
  return out;
}
async function getCancelamentosRows() {
  if (cancelCache.rows && Date.now() - cancelCache.at < VENDAS_ROWS_TTL_MS) return cancelCache.rows;
  if (cancelInflight) return cancelInflight;
  cancelInflight = (async () => {
    if (!HIST_BASE || !HIST_TOKEN || !HIST_CANCEL_TABLE) return [];
    const raw = [];
    for (let offset = 0; offset < 200000; offset += 1000) {
      const r = await fetch(`${HIST_BASE}/tables/${HIST_CANCEL_TABLE}/records?limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json()).catch(() => null);
      const list = r?.list || [];
      raw.push(...list);
      if (list.length < 1000) break;
    }
    if (!raw.length) { cancelCache = { at: Date.now(), rows: [], cols: null }; return []; }
    const cols = resolveCancelCols(raw[0]);
    const rows = raw.map(v => ({
      nome:    cols.nome ? String(v[cols.nome] || '').trim() : '',
      unidade: cols.unidade ? String(v[cols.unidade] || '').trim() : '',
      data:    cols.data ? parseVData(v[cols.data]) : '',
      motivo:  cols.motivo ? String(v[cols.motivo] || '').trim() : '',
    }));
    cancelCache = { at: Date.now(), rows, cols };
    console.log(`[cancel-hist] ${rows.length} linhas da tabela ${HIST_CANCEL_TABLE} · colunas: ${JSON.stringify(cols)}`);
    return rows;
  })().finally(() => { cancelInflight = null; });
  return cancelInflight;
}

async function ensureVendasTable() {
  if (VENDAS_TABLE) return VENDAS_TABLE;
  if (!HIST_BASE || !HIST_TOKEN || !NOCODB_BASE_ID) return '';
  if (vendasEnsureInflight) return vendasEnsureInflight;
  vendasEnsureInflight = (async () => {
    const metaBase = HIST_BASE.replace(/\/api\/v2$/, '') + '/api/v2/meta';
    const list = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, { headers: leadsHeaders() }).then(r => r.json());
    const ex = (list?.list || []).find(t => t.title === 'VendasEvo');
    if (ex) { VENDAS_TABLE = ex.id; return VENDAS_TABLE; }
    const created = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, {
      method: 'POST', headers: leadsHeaders(),
      body: JSON.stringify({ table_name: 'VendasEvo', title: 'VendasEvo', columns: [
        { column_name: 'id_sale', title: 'id_sale', uidt: 'Number' },
        { column_name: 'id_member', title: 'id_member', uidt: 'Number' },
        { column_name: 'nome', title: 'nome', uidt: 'SingleLineText' },
        { column_name: 'unidade', title: 'unidade', uidt: 'SingleLineText' },
        { column_name: 'sale_date', title: 'sale_date', uidt: 'SingleLineText' },
        { column_name: 'month', title: 'month', uidt: 'SingleLineText' },
        { column_name: 'plano', title: 'plano', uidt: 'SingleLineText' },
        { column_name: 'valor', title: 'valor', uidt: 'Decimal' },
        { column_name: 'synced_at', title: 'synced_at', uidt: 'SingleLineText' },
      ] }),
    }).then(r => r.json());
    VENDAS_TABLE = created?.id || '';
    if (VENDAS_TABLE) console.log(`[vendas] tabela VendasEvo criada: ${VENDAS_TABLE}`);
    return VENDAS_TABLE;
  })().finally(() => { vendasEnsureInflight = null; });
  return vendasEnsureInflight;
}

let vendasPhoneColOk = false;
async function ensureVendasPhoneColumn() {
  if (vendasPhoneColOk) return;
  const t = await ensureVendasTable();
  if (!t) return;
  const metaBase = HIST_BASE.replace(/\/api\/v2$/, '') + '/api/v2/meta';
  try {
    await fetch(`${metaBase}/tables/${t}/columns`, {
      method: 'POST', headers: leadsHeaders(),
      body: JSON.stringify({ column_name: 'telefone', title: 'telefone', uidt: 'SingleLineText' }),
    });
  } catch { /* já existe ou sem permissão — segue */ }
  vendasPhoneColOk = true;
}

// Telefone do aluno direto na EVO (members API) — é o que permite casar
// lead × venda por TELEFONE (nome do lead vem incompleto no Fluxo).
async function evoMemberPhone(idMember, auth) {
  if (!idMember) return '';
  try {
    const r = await fetchComTimeout(`${EVO_API}/api/v1/members/${idMember}`, { headers: { Authorization: auth, 'Content-Type': 'application/json' } }, 15_000);
    if (!r.ok) return '';
    const d = await r.json();
    const cands = [d?.cellphone, d?.cellPhone, d?.phone, d?.telephone, d?.mobilePhone];
    if (Array.isArray(d?.contacts)) {
      for (const c of d.contacts) cands.push(c?.description, c?.contact, c?.phone);
    }
    for (const c of cands) {
      const digits = String(c ?? '').replace(/\D/g, '');
      if (digits.length >= 10) return digits; // DDD+numero
    }
  } catch { /* sem telefone — segue só com nome */ }
  return '';
}

// Busca as vendas de UM mês na EVO (paced + retry) e grava as que faltam na
// tabela (insert por id_sale; venda é imutável — nunca atualiza nem apaga).
async function syncVendasMonth(month, opts = {}) {
  // skipPhone: pula o enriquecimento de telefone (lento — 1 chamada EVO + sleep
  // por venda). Telefone só importa pro match FORTE de leads recentes; meses
  // históricos (backfill) não precisam e ficam MUITO mais rápidos sem isso.
  const skipPhone = !!opts.skipPhone;
  const t = await ensureVendasTable();
  if (!t) return false;
  const guard = vendasSyncGuard.get(month) || 0;
  if (Date.now() - guard < 30 * 60 * 1000) return true; // sincronizado há pouco
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const entries = Object.entries(EVO_UNIT_TOKENS()).filter(([, tk]) => !!tk);

  // Unidades em PARALELO (cada uma com seu token) — antes era sequencial e
  // dominava o tempo. Cada unidade pagina independente, com pacing entre páginas.
  const porUnidade = await Promise.all(entries.map(async ([unidade, token]) => {
    const auth = 'Basic ' + Buffer.from(`${EVO_DNS}:${token}`).toString('base64');
    const vendasU = [];
    let unidadeOk = true;
    for (let skip = 0; skip < 3000; skip += 50) {
      const url = `${EVO_API}/api/v2/sales?dateSaleStart=${start}&dateSaleEnd=${end}`
        + `&showReceivables=false&take=50&skip=${skip}&onlyMembership=false&atLeastMonthly=false`
        + `&showOnlyActiveMemberships=true&onlyTotalPass=false`;
      let page = null;
      for (let tent = 0; tent < 4 && page === null; tent++) {
        try {
          const r = await fetchComTimeout(url, { headers: { Authorization: auth, 'Content-Type': 'application/json' } }, 30_000);
          if (r.ok) { page = await r.json(); break; }
          if (r.status === 429 || r.status >= 500) {
            const ra = Number(r.headers.get('retry-after')) || 0;
            await new Promise(ok => setTimeout(ok, ra > 0 ? ra * 1000 : 2500 * (tent + 1)));
            continue;
          }
          unidadeOk = false; break;
        } catch { await new Promise(ok => setTimeout(ok, 2500 * (tent + 1))); }
      }
      if (!Array.isArray(page)) { unidadeOk = false; break; }
      for (const sv of page) {
        if (sv.removed) continue;
        const items = sv.saleItens ?? [];
        const nova = items.some(it => it.idMembership != null && it.idMembershipRenewed == null && (Number(it.saleValue) || 0) > 0);
        if (!nova) continue;
        const total = items.reduce((acc, it) => acc + (Number(it.saleValue) || 0), 0);
        if (total <= 0) continue;
        const planItem = items.reduce((best, it) => ((it.saleValue ?? 0) > (best?.saleValue ?? 0) ? it : best), null);
        vendasU.push({
          id_sale: Number(sv.idSale) || 0,
          id_member: Number(sv.member?.idMember) || null,
          nome: `${sv.member?.firstName ?? ''} ${sv.member?.lastName ?? ''}`.trim(),
          unidade,
          sale_date: String(sv.saleDate ?? '').slice(0, 10),
          month,
          plano: String(planItem?.item ?? '').trim(),
          valor: Math.round(total * 100) / 100,
          synced_at: new Date().toISOString(),
        });
      }
      if (page.length < 50) break;
      await new Promise(ok => setTimeout(ok, 450)); // pacing entre páginas
    }
    if (!unidadeOk) console.warn(`[vendas] EVO ${unidade}/${month}: INCOMPLETO`);
    return { vendasU, unidadeOk };
  }));
  const vendas = porUnidade.flatMap(p => p.vendasU);
  let completo = porUnidade.every(p => p.unidadeOk);
  // grava SÓ as que faltam (id_sale é a chave; venda é imutável)
  const existentes = new Set();
  const semTelefone = []; // linhas antigas do mês ainda sem telefone → backfill
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${t}/records?where=(month,eq,${encodeURIComponent(month)})&fields=Id,id_sale,id_member,unidade,telefone&limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    for (const x of list) {
      existentes.add(Number(x.id_sale));
      if (!x.telefone && x.id_member) semTelefone.push(x);
    }
    if (list.length < 1000) break;
  }
  const novas = vendas.filter(v => v.id_sale && !existentes.has(v.id_sale));
  // Enriquecimento: telefone do aluno (members API, paced) — chave do match forte.
  // No backfill (skipPhone) isto é PULADO: é o que torna o sync lento e telefone
  // não é usado pelo filtro de período. Meses recentes seguem enriquecidos via
  // syncVendasRecentes (skipPhone=false).
  if (!skipPhone) {
    await ensureVendasPhoneColumn();
    const authPorUnidade = new Map(entries.map(([u, tk]) => [u, 'Basic ' + Buffer.from(`${EVO_DNS}:${tk}`).toString('base64')]));
    for (const v of novas) {
      v.telefone = await evoMemberPhone(v.id_member, authPorUnidade.get(v.unidade));
      await new Promise(ok => setTimeout(ok, 300));
    }
  }
  for (let i2 = 0; i2 < novas.length; i2 += 200) {
    const r = await fetch(`${HIST_BASE}/tables/${t}/records`, {
      method: 'POST', headers: leadsHeaders(), body: JSON.stringify(novas.slice(i2, i2 + 200)),
    });
    if (!r.ok) throw new Error(`NocoDB vendas POST ${r.status}`);
  }
  // Backfill de telefone nas vendas já gravadas (até 60 por rodada, paced).
  // Também pulado no skipPhone — fica pro sync recente preencher.
  let enriquecidas = 0;
  if (!skipPhone) {
    const authMap2 = new Map(entries.map(([u, tk]) => [u, 'Basic ' + Buffer.from(`${EVO_DNS}:${tk}`).toString('base64')]));
    for (const row of semTelefone.slice(0, 60)) {
      const tel = await evoMemberPhone(row.id_member, authMap2.get(row.unidade));
      if (tel) {
        await fetch(`${HIST_BASE}/tables/${t}/records`, {
          method: 'PATCH', headers: leadsHeaders(), body: JSON.stringify({ Id: row.Id, telefone: tel }),
        });
        enriquecidas++;
      }
      await new Promise(ok => setTimeout(ok, 300));
    }
  }
  if (novas.length || enriquecidas) {
    vendasRowsCache = { at: 0, rows: null };
    console.log(`[vendas] ${month}: ${novas.length} novas · ${enriquecidas} telefones preenchidos`);
  }
  if (completo) vendasSyncGuard.set(month, Date.now()); // incompleto → tenta de novo na próxima
  return completo;
}

// Sincroniza mês atual + anterior (janela de detecção) — meses fechados já
// gravados ficam imutáveis na tabela.
async function syncVendasRecentes() {
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prev = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}`;
  let tudoOk = true;
  for (const m of [prev, cur]) {
    try { if (!(await syncVendasMonth(m))) tudoOk = false; }
    catch (e) { tudoOk = false; console.warn(`[vendas] sync ${m} falhou:`, e?.message || e); }
  }
  return tudoOk;
}

// ── Aulas Experimentais por mês (server-side, salvo no NocoDB) ───────────────
// Espelha o padrão de Vendas: o servidor varre a EVO (throttled) e grava 1 linha
// por unidade×dia na tabela ExperimentalEvo; o cliente só LÊ (zero 429 no uso).
// Regra (Passo 5): nas sessões da agenda que aceitam experimental, conta os
// inscritos que são LEAD = idProspect preenchido E idMember nulo. Dia passado é
// imutável → re-escaneia só HOJE + dias ainda não gravados (incremental).
const expSleep = (ms) => new Promise(r => setTimeout(r, ms));
// EVO IdFilial por unidade (a EVO pulou o id 2 → offset +1 vs idBranch local).
const EVO_FILIAL_ID = {
  'Altino Arantes': 1, 'Saúde': 3, 'Parque das Nações': 4, 'Alto do Ipiranga': 5,
  'Jardins': 6, 'Belenzinho': 7, 'Campestre': 8,
};
let EXP_TABLE = process.env.NOCODB_EXP_TABLE || '';
let expEnsureInflight = null;
const expSyncGuard = new Map();   // month → timestamp do último backfill disparado
let expBackfillJob = { running: false, startedAt: 0, month: '', total: 0, done: 0, unidade: '' };

// ── Ponte com o evo-scraper ──────────────────────────────────────────────────
// A Gaviões NÃO tem API de integração pra aulas experimentais — a fonte é o
// scraper (loga no painel EVO5 e devolve as experimentais por dia). O server só
// repassa (Bearer) e cacheia no NocoDB. Aceita SCRAPER_UPSTREAM (nome usado no
// ambiente da Gaviões) ou SCRAPER_URL.
const SCRAPER_URL   = (process.env.SCRAPER_UPSTREAM || process.env.SCRAPER_URL || '').replace(/\/+$/, '');
const SCRAPER_TOKEN = process.env.SCRAPER_TOKEN || '';
async function scraperFetch(path) {
  if (!SCRAPER_URL || !SCRAPER_TOKEN) return null;
  const r = await fetchComTimeout(`${SCRAPER_URL}${path}`, { headers: { Authorization: `Bearer ${SCRAPER_TOKEN}` } }, 90_000);
  if (!r.ok) throw new Error(`scraper respondeu ${r.status}`);
  return r.json();
}

// Cache em memória das aulas experimentais. A Gaviões NÃO tem tabela NocoDB pra isso
// (o NocoDB só tem gb_users) — então servimos DIRETO do scraper e cacheamos aqui.
// Chave = "from|to". TTL 10min. Refresh em background (não bloqueia a resposta).
const EXP_MEM = new Map();            // key → { at, byUnit }
const EXP_MEM_TTL = 10 * 60 * 1000;
let expScrapeRunning = false;
async function scrapeExpRangeToByUnit(from, to) {
  const data = await scraperFetch(`/exp?from=${from}&to=${to}`);
  const bd = (data && data.byDay) || {};
  const agg = { agendados: 0, compareceram: 0, faltaram: 0, reagendados: 0, dias: 0, completos: 0 };
  for (const dia of Object.keys(bd)) {
    const d = bd[dia] || {};
    agg.agendados    += Number(d.agendados)    || 0;
    agg.compareceram += Number(d.compareceram) || 0;
    agg.faltaram     += Number(d.faltaram)     || 0;
    agg.reagendados  += Number(d.reagendados)  || 0;
    agg.dias++; agg.completos++;
  }
  return { 'Gaviões': agg };
}
// Dispara (no máx. 1 por vez) um scrape do range e guarda no cache. Não lança.
function kickExpScrape(key, from, to) {
  if (expScrapeRunning) return;
  expScrapeRunning = true;
  (async () => {
    try {
      const byUnit = await scrapeExpRangeToByUnit(from, to);
      EXP_MEM.set(key, { at: Date.now(), byUnit });
      console.log(`[exp] scraper ${from}..${to}: Gaviões =`, JSON.stringify(byUnit['Gaviões']));
    } catch (e) {
      console.error('[exp] scraper falhou:', e?.message || e);
    } finally { expScrapeRunning = false; }
  })();
}

async function ensureExpTable() {
  if (EXP_TABLE) return EXP_TABLE;
  if (!HIST_BASE || !HIST_TOKEN || !NOCODB_BASE_ID) return '';
  if (expEnsureInflight) return expEnsureInflight;
  expEnsureInflight = (async () => {
    const metaBase = HIST_BASE.replace(/\/api\/v2$/, '') + '/api/v2/meta';
    const list = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, { headers: leadsHeaders() }).then(r => r.json());
    const ex = (list?.list || []).find(t => t.title === 'ExperimentalEvo');
    if (ex) { EXP_TABLE = ex.id; return EXP_TABLE; }
    const created = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, {
      method: 'POST', headers: leadsHeaders(),
      body: JSON.stringify({ table_name: 'ExperimentalEvo', title: 'ExperimentalEvo', columns: [
        { column_name: 'unidade', title: 'unidade', uidt: 'SingleLineText' },
        { column_name: 'dia', title: 'dia', uidt: 'SingleLineText' },
        { column_name: 'month', title: 'month', uidt: 'SingleLineText' },
        { column_name: 'agendados', title: 'agendados', uidt: 'Number' },
        { column_name: 'compareceram', title: 'compareceram', uidt: 'Number' },
        { column_name: 'faltaram', title: 'faltaram', uidt: 'Number' },
        { column_name: 'reagendados', title: 'reagendados', uidt: 'Number' },
        { column_name: 'completo', title: 'completo', uidt: 'Checkbox' },
        { column_name: 'scanned_at', title: 'scanned_at', uidt: 'SingleLineText' },
      ] }),
    }).then(r => r.json());
    EXP_TABLE = created?.id || '';
    if (EXP_TABLE) console.log(`[exp] tabela ExperimentalEvo criada: ${EXP_TABLE}`);
    return EXP_TABLE;
  })().finally(() => { expEnsureInflight = null; });
  return expEnsureInflight;
}

// GET na EVO com retry 429/5xx + timeout. Devolve JSON ou null (falha real/esgotou).
async function evoGetJson(url, auth, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetchComTimeout(url, { headers: { Authorization: auth, 'Content-Type': 'application/json' } }, 30_000);
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get('retry-after')) || 0;
        await expSleep(ra > 0 ? ra * 1000 : 2000 * (t + 1));
        continue;
      }
      return null;
    } catch { await expSleep(2000 * (t + 1)); }
  }
  return null;
}

const expAsArray = (x) => Array.isArray(x) ? x : (x && (x.list || x.data || x.result || x.items)) || [];

// Varre UM dia de UMA unidade e conta aulas experimentais (regra Passo 5).
// Retorna null se a LISTA do dia falhar (dia fica "incompleto" → re-tenta depois).
async function scanExpDiaUnidade(unidade, token, dia) {
  const auth = 'Basic ' + Buffer.from(`${EVO_DNS}:${token}`).toString('base64');
  const filial = EVO_FILIAL_ID[unidade] || '';
  const schedUrl = `${EVO_API}/api/v1/activities/schedule?date=${dia}&take=200&showFullWeek=false`
    + (filial ? `&idBranch=${filial}` : '');
  const schedRaw = await evoGetJson(schedUrl, auth);
  const sched = expAsArray(schedRaw);
  if (!Array.isArray(schedRaw) && !sched.length && schedRaw === null) return null; // lista falhou
  // Candidatas: aceitam experimental (quando o campo vier) e têm gente inscrita.
  const temFlag = sched.some(s => typeof s?.allowExperimentalClass === 'boolean');
  const candidatas = sched.filter(s => {
    const id = s?.idAtividadeSessao ?? s?.idActivitySession;
    if (!id) return false;
    // COM o campo: toda sessão que ACEITA experimental (NÃO exige ocupation>0 — a
    // reserva de prospect às vezes não entra no ocupation da LISTA, só aparece no
    // detalhe; exigir ocupation>0 descartava aulas com lead e zerava a conta).
    // SEM o campo: cai pro filtro ocupation>0 só pra limitar chamadas de detalhe.
    return temFlag ? s.allowExperimentalClass === true : (Number(s?.ocupation) || 0) > 0;
  });
  let agendados = 0, compareceram = 0, faltaram = 0, reagendados = 0, ok = true;
  for (const s of candidatas) {
    const id = s.idAtividadeSessao ?? s.idActivitySession;
    const finalized = Number(s?.status) === 6; // 6 = sessão já realizada
    const det = await evoGetJson(`${EVO_API}/api/v1/activities/schedule/detail?idActivitySession=${id}`, auth);
    if (det === null) { ok = false; await expSleep(400); continue; }
    const enr = expAsArray(det?.enrollments ?? det);
    for (const e of enr) {
      const isLead = !!e?.idProspect && !e?.idMember; // Passo 5: prospect puro
      if (!isLead) continue;
      agendados++;
      const st = Number(e?.status);
      if (finalized && st === 0) compareceram++;
      else if (finalized && st === 1) faltaram++;
      if (st === 2) reagendados++;
    }
    await expSleep(400); // pacing anti-429
  }
  return { agendados, compareceram, faltaram, reagendados, completo: ok };
}

// Lê as linhas já gravadas de um mês → { table, byKey: Map("unidade|dia"→row) }.
async function getExpRowsMonth(month) {
  const t = await ensureExpTable();
  if (!t) return { table: '', byKey: new Map() };
  const byKey = new Map();
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${t}/records?where=(month,eq,${encodeURIComponent(month)})&fields=Id,unidade,dia,agendados,compareceram,faltaram,reagendados,completo,scanned_at&limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    for (const x of list) byKey.set(`${x.unidade}|${x.dia}`, x);
    if (list.length < 1000) break;
  }
  return { table: t, byKey };
}

// Sincroniza o mês via SCRAPER (painel EVO5) e grava no NocoDB. O scraper é
// range-native: UMA chamada cobre o mês inteiro (loga no painel, conta agendados/
// compareceram/faltaram por dia). Substitui a varredura por-dia da API de
// integração — que a Gaviões NÃO tem. (unidade única: "Gaviões", filial 59.)
async function syncExpMonth(month, opts = {}) {
  const t = await ensureExpTable();
  if (!t) return { ok: false, reason: 'sem-tabela' };
  if (!SCRAPER_URL) return { ok: false, reason: 'sem-scraper' };
  const [y, m] = month.split('-').map(Number);
  const ult = new Date(y, m, 0).getDate();
  const from = `${month}-01`;
  const to   = `${month}-${String(ult).padStart(2, '0')}`;
  let data;
  try {
    data = await scraperFetch(`/exp?from=${from}&to=${to}`);
  } catch (e) {
    console.warn('[exp] scraper falhou:', e?.message || e);
    return { ok: false, reason: 'scraper-erro' };
  }
  const byDay = (data && data.byDay) || {};
  const unidade = 'Gaviões';
  const { byKey } = await getExpRowsMonth(month);
  const dias = Object.keys(byDay).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (opts.job) { expBackfillJob.total = dias.length; expBackfillJob.done = 0; }
  let done = 0;
  for (const dia of dias) {
    const d = byDay[dia] || {};
    if (opts.job) expBackfillJob.unidade = `${unidade} · ${dia}`;
    const row = byKey.get(`${unidade}|${dia}`);
    const payload = { unidade, dia, month,
      agendados: Number(d.agendados) || 0, compareceram: Number(d.compareceram) || 0,
      faltaram: Number(d.faltaram) || 0, reagendados: Number(d.reagendados) || 0,
      completo: true, scanned_at: new Date().toISOString() };
    try {
      if (row?.Id) await fetch(`${HIST_BASE}/tables/${t}/records`, { method: 'PATCH', headers: leadsHeaders(), body: JSON.stringify({ Id: row.Id, ...payload }) });
      else { const ins = await fetch(`${HIST_BASE}/tables/${t}/records`, { method: 'POST', headers: leadsHeaders(), body: JSON.stringify(payload) }).then(x => x.json()).catch(() => null); if (ins?.Id) byKey.set(`${unidade}|${dia}`, { Id: ins.Id, ...payload }); }
    } catch (e) { console.warn(`[exp] gravar ${unidade} ${dia} falhou:`, e?.message || e); }
    done++;
    if (opts.job) expBackfillJob.done = done;
  }
  console.log(`[exp] ${month}: ${done} dias gravados (via scraper)`);
  return { ok: true, dias: dias.length, escaneados: done };
}

// Índice nome→venda lendo a TABELA inteira (todas as vendas já gravadas, de
// qualquer mês) — nome duplicado fica com a MENOR sale_date (1ª matrícula).
async function getVendasIdxFromTable() {
  const rows = await getAllVendasRows();
  if (!rows.length) return { byName: new Map(), byPhone: new Map() };
  const byName = new Map();
  const byPhone = new Map(); // últimos 8 dígitos → venda (match FORTE)
  for (const v of rows) {
    const sd = String(v.sale_date || '');
    const rec = { nome: v.nome, unidade: v.unidade, saleDate: sd };
    const digits = String(v.telefone || '').replace(/\D/g, '');
    if (digits.length >= 8) {
      const k = digits.slice(-8);
      const exP = byPhone.get(k);
      if (!exP || (sd && (!exP.saleDate || sd < exP.saleDate))) byPhone.set(k, rec);
    }
    const nn = histNorm(String(v.nome || ''));
    if (!nn || nn.split(' ').length < 2) continue;
    const ex = byName.get(nn);
    if (!ex || (sd && (!ex.saleDate || sd < ex.saleDate))) byName.set(nn, rec);
  }
  return { byName, byPhone };
}
// ── Conversões PERSISTIDAS (LeadConversoes) ─────────────────────────────────
async function getConvRows() {
  if (!CONV_TABLE) return [];
  if (convRowsCache.rows && Date.now() - convRowsCache.at < 5 * 60 * 1000) return convRowsCache.rows;
  const out = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await fetch(`${HIST_BASE}/tables/${CONV_TABLE}/records?limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
    const list = r?.list || [];
    out.push(...list);
    if (list.length < 1000) break;
  }
  convRowsCache = { at: Date.now(), rows: out };
  return out;
}

// Scan: roda o matching (Membros histórico + vendas EVO recentes, ambos
// cacheados) e GRAVA as conversões novas. Nunca remove nem reescreve — uma
// conversão detectada é fato. Guard de 15 min evita marteladas.
async function scanConversoes(force = false) {
  if (!CONV_TABLE || !HIST_TABLE || !LEADS_TABLE) return;
  if (!force && Date.now() - lastConvScan < 15 * 60 * 1000) return;
  if (convScanInflight) return convScanInflight;
  convScanInflight = (async () => {
    // PADRÃO: 1º sincroniza vendas EVO→tabela (paced, guard 30min); depois o
    // matching lê SÓ do NocoDB (VendasEvo histórica + Membros histórico).
    const vendasOk = await syncVendasRecentes();
    const [idx, vendasIdx, existentes] = await Promise.all([getMembersIndex(), getVendasIdxFromTable(), getConvRows()]);
    const known = new Set(existentes.map(c => Number(c.conversation_id)));
    const monthsR = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?fields=month&limit=200&sort=month`, { headers: leadsHeaders() }).then(x => x.json());
    const novos = [];
    for (const row of (monthsR?.list || [])) {
      const report = await getLeadsReport(row.month);
      for (const lead of (report?.leads ?? [])) {
        const cid = Number(lead.conversation_id) || 0;
        if (!cid || known.has(cid)) continue;
        const leadDate = String(lead.created_at || '').slice(0, 10);
        const nn = histNorm(String(lead?.contact?.name ?? ''));
        const nomeOk = nn && nn.split(' ').length >= 2;
        const digits = String(lead?.contact?.phone_number ?? '').replace(/\D/g, '');
        let hit = null;
        // VENDA por TELEFONE primeiro (forte — nome do lead pode vir incompleto),
        // depois venda por nome completo.
        const saleTel = digits.length >= 8 ? vendasIdx.byPhone.get(digits.slice(-8)) : undefined;
        const sale = saleTel ?? (nomeOk ? vendasIdx.byName.get(nn) : undefined);
        if (sale && (!leadDate || !sale.saleDate || sale.saleDate >= leadDate)) {
          hit = { nome: sale.nome, unidade: sale.unidade, via: saleTel ? 'venda-telefone' : 'venda', data: sale.saleDate || leadDate };
        } else {
          let rec = digits.length >= 8 ? idx.byPhone.get(digits.slice(-8)) : undefined;
          let via = rec ? 'telefone' : '';
          if (!rec && nomeOk) { rec = idx.byName.get(nn); if (rec) via = 'nome'; }
          // CADASTRO primeiro: é a data real de entrada (vem em toda linha);
          // DtVenda mínima dentro da janela seria renovação de aluno antigo.
          const dataAluno = rec ? (rec.cadastro || rec.venda) : '';
          if (rec && dataAluno && leadDate && dataAluno >= leadDate) {
            hit = { nome: rec.nome, unidade: rec.unidade, via, data: dataAluno };
          }
        }
        if (hit) {
          known.add(cid);
          novos.push({
            conversation_id: cid,
            month_lead: row.month,
            month_matricula: String(hit.data || row.month).slice(0, 7),
            nome: hit.nome, unidade: hit.unidade, via: hit.via,
            data_matricula: hit.data || '',
            detected_at: new Date().toISOString(),
          });
        }
      }
    }
    for (let i = 0; i < novos.length; i += 200) {
      const r = await fetch(`${HIST_BASE}/tables/${CONV_TABLE}/records`, {
        method: 'POST', headers: leadsHeaders(), body: JSON.stringify(novos.slice(i, i + 200)),
      });
      if (!r.ok) throw new Error(`NocoDB conversoes POST ${r.status}`);
    }
    if (novos.length) {
      convRowsCache = { at: 0, rows: null };
      convSummaryCache = { at: 0, months: null };
      console.log(`[leads] ${novos.length} conversões novas gravadas`);
    }
    // Vendas incompletas (429 da EVO)? Re-tenta o scan em ~2 min em vez de 15 —
    // conversões de leads recentes dependem da VendasEvo estar completa.
    lastConvScan = vendasOk ? Date.now() : Date.now() - 13 * 60 * 1000;
  })().finally(() => { convScanInflight = null; });
  return convScanInflight;
}

async function getMembersIndex() {
  if (membersIdx.idx && (Date.now() - membersIdx.at) < HIST_TTL_MS) return membersIdx.idx;
  membersIdxInflight = membersIdxInflight || buildMembersIndex();
  try {
    const idx = await membersIdxInflight;
    membersIdx = { at: Date.now(), idx };
    return idx;
  } finally { membersIdxInflight = null; }
}

// ── Snapshot: tabela auto-criada + leitura/gravação gzip ────────────────────
let snapMem = new Map(); // key → { at, payload, updated_at } (60s)
let snapEnsureInflight = null;
async function ensureSnapTable() {
  if (SNAP_TABLE) return SNAP_TABLE;
  if (!HIST_BASE || !HIST_TOKEN || !NOCODB_BASE_ID) return '';
  if (snapEnsureInflight) return snapEnsureInflight;
  snapEnsureInflight = (async () => {
    const metaBase = HIST_BASE.replace(/\/api\/v2$/, '') + '/api/v2/meta';
    const list = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, { headers: leadsHeaders() }).then(r => r.json());
    const ex = (list?.list || []).find(t => t.title === 'DashSnapshot');
    if (ex) { SNAP_TABLE = ex.id; return SNAP_TABLE; }
    const created = await fetch(`${metaBase}/bases/${NOCODB_BASE_ID}/tables`, {
      method: 'POST', headers: leadsHeaders(),
      body: JSON.stringify({ table_name: 'DashSnapshot', title: 'DashSnapshot', columns: [
        { column_name: 'skey', title: 'skey', uidt: 'SingleLineText' },
        { column_name: 'payload', title: 'payload', uidt: 'LongText' },
        { column_name: 'updated_at', title: 'updated_at', uidt: 'SingleLineText' },
        { column_name: 'updated_by', title: 'updated_by', uidt: 'SingleLineText' },
      ] }),
    }).then(r => r.json());
    SNAP_TABLE = created?.id || '';
    if (SNAP_TABLE) console.log(`[snapshot] tabela DashSnapshot criada: ${SNAP_TABLE}`);
    return SNAP_TABLE;
  })().finally(() => { snapEnsureInflight = null; });
  return snapEnsureInflight;
}

async function snapGet(key) {
  const hit = snapMem.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const t = await ensureSnapTable();
  if (!t) return null;
  const r = await fetch(`${HIST_BASE}/tables/${t}/records?where=(skey,eq,${encodeURIComponent(key)})&limit=1`, { headers: leadsHeaders() }).then(x => x.json());
  const row = r?.list?.[0];
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(gunzipSync(Buffer.from(String(row.payload), 'base64')).toString('utf8')); }
  catch { try { payload = JSON.parse(String(row.payload)); } catch { payload = null; } }
  const out = { at: Date.now(), payload, updated_at: row.updated_at || '', updated_by: row.updated_by || '' };
  snapMem.set(key, out);
  return out;
}

async function snapSet(key, payload, updatedBy) {
  const t = await ensureSnapTable();
  if (!t) throw new Error('snapshot não configurado');
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64'); // ~10x menor → passa folgado no body do NocoDB
  const r = await fetch(`${HIST_BASE}/tables/${t}/records?where=(skey,eq,${encodeURIComponent(key)})&fields=Id&limit=1`, { headers: leadsHeaders() }).then(x => x.json());
  const existing = r?.list?.[0];
  const fields = { skey: key, payload: gz, updated_at: new Date().toISOString(), updated_by: updatedBy || '' };
  const resp = await fetch(`${HIST_BASE}/tables/${t}/records`, {
    method: existing ? 'PATCH' : 'POST', headers: leadsHeaders(),
    body: JSON.stringify(existing ? { Id: existing.Id, ...fields } : fields),
  });
  if (!resp.ok) throw new Error(`NocoDB snapshot ${resp.status}`);
  snapMem.delete(key);
  return fields.updated_at;
}

const nocoHeaders = { 'xc-token': NOCO_TOKEN, 'Content-Type': 'application/json' };

async function nocoFindUser(field, value) {
  const url = `${NOCO_BASE}/tables/${NOCO_TABLE}/records?where=(${field},eq,${encodeURIComponent(value)})&limit=1`;
  const r = await fetch(url, { headers: nocoHeaders });
  if (!r.ok) throw new Error(`NocoDB GET ${r.status}`);
  const data = await r.json();
  return data?.list?.[0] || null;
}

async function nocoPatch(fields) {
  const r = await fetch(`${NOCO_BASE}/tables/${NOCO_TABLE}/records`, {
    method: 'PATCH', headers: nocoHeaders, body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`NocoDB PATCH ${r.status}`);
  return r.json();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── E-mail branded (identidade da empresa) ───────────────────────────────────
function inviteEmailHtml({ name, link }) {
  const greeting = name ? `Olá, ${name}!` : 'Olá!';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
   <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 30px rgba(15,60,35,.08);">
      <tr><td style="height:6px;background:linear-gradient(90deg,#141414,#141414,#fc3000);"></td></tr>
      <tr><td style="padding:36px 40px 8px;">
        <div style="font-size:22px;font-weight:800;color:#141414;letter-spacing:-.5px;">${PLATFORM_NAME}</div>
      </td></tr>
      <tr><td style="padding:8px 40px 0;">
        <h1 style="font-size:24px;color:#0F172A;margin:8px 0 6px;font-weight:800;">${greeting}</h1>
        <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 24px;">
          Você foi convidado para acessar o painel <b>${PLATFORM_NAME}</b>.
          Clique no botão abaixo para <b>definir sua senha</b> e entrar.
        </p>
        <a href="${link}" style="display:inline-block;background:#141414;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 28px;border-radius:14px;">
          Definir minha senha →
        </a>
        <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:24px 0 0;">
          Este link expira em ${INVITE_TTL_HOURS} horas. Se você não esperava este convite, pode ignorar este e-mail.
        </p>
        <p style="font-size:12px;color:#cbd5e1;line-height:1.6;margin:18px 0 0;word-break:break-all;">
          Ou copie e cole no navegador:<br>${link}
        </p>
      </td></tr>
      <tr><td style="padding:28px 40px 32px;">
        <hr style="border:none;border-top:1px solid #eef2f7;margin:0 0 14px;">
        <div style="font-size:11px;color:#94a3b8;">© ${PLATFORM_NAME}</div>
      </td></tr>
    </table>
   </td></tr>
  </table></body></html>`;
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      // Testa a conexão SMTP de verdade pra revelar problema de host/porta/senha.
      let smtpVerify = false; let smtpError = null;
      if (SMTP_USER) {
        try { await transporter.verify(); smtpVerify = true; }
        catch (e) { smtpError = String(e?.message || e); }
      }
      return send(res, 200, {
        ok: true,
        env: { smtp_user: !!SMTP_USER, smtp_pass: !!SMTP_PASS, host: SMTP_HOST, port: SMTP_PORT, from: MAIL_FROM, frontend_url: FRONTEND_URL, noco_token: !!NOCO_TOKEN, history: !!(HIST_BASE && HIST_TOKEN && HIST_TABLE), recebimentos: !!(HIST_BASE && HIST_TOKEN && RECEB_TABLE), leads: !!(HIST_BASE && HIST_TOKEN && LEADS_TABLE && LEADS_SECRET), leads_pull: leadsPullEnabled(), conversoes: !!(HIST_BASE && HIST_TOKEN && CONV_TABLE), snapshot: !!(HIST_BASE && HIST_TOKEN && (SNAP_TABLE || NOCODB_BASE_ID)), vendas: !!(HIST_BASE && HIST_TOKEN && (VENDAS_TABLE || NOCODB_BASE_ID)), cancelamentos: !!(HIST_BASE && HIST_TOKEN && HIST_CANCEL_TABLE), meta: !!META_TOKEN },
        smtpVerify, smtpError,
      });
    }

    // ── Proxy da Meta Marketing API — token injetado no servidor (runtime) ──
    // O front (metaApi.ts) chama estes endpoints; o token NUNCA vai pro browser.
    // `account` é validado (act_<digitos>) pra evitar proxy aberto/SSRF.
    if (req.method === 'GET' && req.url.startsWith('/api/meta/')) {
      if (!META_TOKEN) return send(res, 503, { error: 'META_ACCESS_TOKEN não configurado no servidor.', data: [] });
      const u = new URL(req.url, 'http://x');
      const path = u.pathname.replace('/api/meta/', '');
      const account = u.searchParams.get('account') || '';
      const accountOk = /^act_\d+$/.test(account);
      // Monta a URL do Graph conforme o recurso pedido.
      let graphUrl = null;
      if (path === 'adaccounts') {
        graphUrl = `${META_GRAPH}/me/adaccounts?fields=name,account_id`;
      } else if (path === 'campaigns' && accountOk) {
        graphUrl = `${META_GRAPH}/${account}/campaigns?fields=name,status,objective`;
      } else if (path === 'insights' && accountOk) {
        const from = u.searchParams.get('from') || '';
        const to   = u.searchParams.get('to')   || '';
        const dateParam = (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to))
          ? `&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}`
          : '&date_preset=last_30d';
        graphUrl = `${META_GRAPH}/${account}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,reach,clicks,cpc,ctr,actions${dateParam}`;
      } else if (path === 'spend' && accountOk) {
        graphUrl = `${META_GRAPH}/${account}/insights?fields=spend&date_preset=last_30d`;
      }
      if (!graphUrl) return send(res, 400, { error: 'Recurso Meta inválido ou account ausente (act_<id>).' });
      try {
        const r = await fetchComTimeout(`${graphUrl}&access_token=${encodeURIComponent(META_TOKEN)}`, {}, 20_000);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Repassa a mensagem do Graph (ex.: token inválido) pro front mostrar.
          return send(res, r.status, { error: j?.error?.message || `Meta API ${r.status}`, data: [] });
        }
        return send(res, 200, j);
      } catch (e) {
        return send(res, 502, { error: `Falha ao chamar a Meta: ${String(e?.message || e)}`, data: [] });
      }
    }

    // ── Snapshot compartilhado do painel (membros/vendas do mês) ──
    if (req.method === 'GET' && req.url.startsWith('/api/snapshot?')) {
      const key = new URL(req.url, 'http://x').searchParams.get('key') || 'dashboard';
      try {
        const snap = await snapGet(key);
        if (!snap?.payload) return send(res, 200, { enabled: !!(HIST_BASE && HIST_TOKEN), payload: null });
        return send(res, 200, { enabled: true, payload: snap.payload, updated_at: snap.updated_at, updated_by: snap.updated_by });
      } catch (e) {
        return send(res, 200, { enabled: false, payload: null, detail: String(e?.message || e) });
      }
    }
    if (req.method === 'POST' && req.url === '/api/snapshot') {
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas.' });
      let rawBody;
      try { rawBody = await readRawBody(req, 8 * 1024 * 1024); } catch { return send(res, 413, { error: 'payload muito grande' }); }
      let body;
      try { body = JSON.parse(rawBody); } catch { return send(res, 400, { error: 'JSON inválido' }); }
      const key = String(body?.key || 'dashboard');
      if (!body?.payload) return send(res, 400, { error: 'payload obrigatório' });
      try {
        const updatedAt = await snapSet(key, body.payload, String(body?.updated_by || ''));
        return send(res, 200, { ok: true, updated_at: updatedAt });
      } catch (e) {
        return send(res, 502, { error: 'Falha ao salvar snapshot.', detail: String(e?.message || e) });
      }
    }

    // ── Webhook: Relatório de Leads do Fluxo (POST diário 06:10) ──
    if (req.method === 'POST' && req.url === '/api/leads-report') {
      if (!HIST_BASE || !HIST_TOKEN || !LEADS_TABLE) return send(res, 503, { error: 'NOCODB_LEADS_TABLE não configurada' });
      if (!LEADS_SECRET) return send(res, 503, { error: 'LEADS_WEBHOOK_SECRET não configurado — cadastre o secret do webhook' });
      let rawBody;
      try { rawBody = await readRawBody(req); } catch { return send(res, 413, { error: 'payload muito grande' }); }
      const motivoRecusa = leadsSignatureCheck(req, rawBody);
      if (motivoRecusa) {
        console.warn(`[leads] webhook recusado: ${motivoRecusa}`);
        return send(res, 401, { error: 'assinatura inválida', motivo: motivoRecusa });
      }
      let report;
      try { report = JSON.parse(rawBody); } catch { return send(res, 400, { error: 'JSON inválido' }); }
      if (report?.event !== 'leads_report') return send(res, 422, { error: 'evento inesperado' });
      // Responde 200 RÁPIDO (o Fluxo só quer o "recebi") e grava async.
      send(res, 200, { ok: true });
      const deliveryId = String(req.headers['x-chatwoot-delivery'] || '');
      leadsUpsert(report, deliveryId)
        .then(r => console.log(`[leads] ${report?.period?.month}: ${r}`))
        .catch(e => console.error('[leads] upsert falhou:', e));
      return;
    }

    // GET na URL do webhook (alguém abriu no navegador) → explica em vez de 404.
    if (req.method === 'GET' && req.url === '/api/leads-report') {
      return send(res, 405, {
        error: 'Esta URL é o RECEPTOR do webhook — só aceita POST.',
        como_usar: 'Cadastre-a no Fluxo em Configurações → Integrações → Webhooks, evento leads_report. O Fluxo envia o POST assinado todo dia às 06:10.',
        configurado: !!(HIST_BASE && HIST_TOKEN && LEADS_TABLE && LEADS_SECRET),
      });
    }

    // ── Leads: pull manual da API do Fluxo (botão "Atualizar agora") ──
    if (req.method === 'POST' && req.url === '/api/leads-pull') {
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      if (!leadsPullEnabled()) {
        return send(res, 503, { error: 'Pull não configurado — defina FLUXO_API_TOKEN e FLUXO_ACCOUNT_ID no env.' });
      }
      const { month } = await readBody(req);
      try {
        const report = await leadsPull(month && /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : undefined);
        return send(res, 200, { ok: true, month: report.period.month });
      } catch (e) {
        return send(res, 502, { error: 'Falha ao puxar da API do Fluxo.', detail: String(e?.message || e) });
      }
    }

    // ── Leads: lista de meses disponíveis + relatório de 1 mês (pro front) ──
    if (req.method === 'GET' && req.url === '/api/leads-report/months') {
      if (!HIST_BASE || !HIST_TOKEN || !LEADS_TABLE) return send(res, 200, { enabled: false, months: [] });
      let r = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?fields=month,generated_at&limit=200&sort=month`, { headers: leadsHeaders() }).then(x => x.json());
      // Tabela vazia + pull configurado → primeira visita já traz o mês corrente.
      if ((r?.list || []).length === 0 && leadsPullEnabled()) {
        try {
          await leadsPull();
          r = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?fields=month,generated_at&limit=200&sort=month`, { headers: leadsHeaders() }).then(x => x.json());
        } catch (e) { console.warn('[leads] auto-pull falhou:', e); }
      }
      const months = (r?.list || []).map(x => ({ month: x.month, generated_at: x.generated_at }));
      return send(res, 200, { enabled: true, months, pull: leadsPullEnabled() });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/leads-report?')) {
      if (!HIST_BASE || !HIST_TOKEN || !LEADS_TABLE) return send(res, 200, { enabled: false, report: null });
      const month = new URL(req.url, 'http://x').searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { error: 'month=YYYY-MM obrigatório' });
      const payload = await getLeadsReport(month);
      return send(res, 200, { enabled: true, report: payload });
    }

    // ── Conversão lead → aluno (cruzamento com a tabela Membros) ──
    if (req.method === 'GET' && req.url.startsWith('/api/leads-conversion?')) {
      if (!HIST_BASE || !HIST_TOKEN || !LEADS_TABLE || !HIST_TABLE) return send(res, 200, { enabled: false, matches: {} });
      const month = new URL(req.url, 'http://x').searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { error: 'month=YYYY-MM obrigatório' });
      try {
        const report = await getLeadsReport(month);
        if (!report?.leads?.length) return send(res, 200, { enabled: true, matches: {}, summary: { leads: 0, viraram: 0, jaEram: 0 } });
        // 1) Dispara o scan em BACKGROUND (guard 15 min) — esperar aqui dava 524
        //    no Cloudflare (primeiro sync de vendas leva minutos). Responde já
        //    com os fatos gravados; o front re-consulta enquanto scanRunning.
        scanConversoes().catch(e => console.warn('[leads] scan falhou:', e?.message || e));
        const [convRows, idx] = await Promise.all([getConvRows(), getMembersIndex()]);
        const convByLead = new Map(convRows.map(c => [Number(c.conversation_id), c]));
        const matches = {};
        let viraram = 0, jaEram = 0;
        for (const lead of report.leads) {
          const cid = Number(lead.conversation_id) || 0;
          const fato = convByLead.get(cid);
          if (fato) {
            viraram++;
            matches[cid] = { nome: fato.nome, unidade: fato.unidade, via: fato.via, tipo: 'virou', data: fato.data_matricula || null };
            continue;
          }
          // 2) "Já era aluno": determinístico via histórico de Membros (1º cadastro
          //    antes do lead). Nada de vendas ao vivo aqui — fonte estável.
          const leadDate = String(lead.created_at || '').slice(0, 10);
          const nn = histNorm(String(lead?.contact?.name ?? ''));
          const nomeOk = nn && nn.split(' ').length >= 2;
          const digits = String(lead?.contact?.phone_number ?? '').replace(/\D/g, '');
          let rec = digits.length >= 8 ? idx.byPhone.get(digits.slice(-8)) : undefined;
          let via = rec ? 'telefone' : '';
          if (!rec && nomeOk) { rec = idx.byName.get(nn); if (rec) via = 'nome'; }
          if (!rec) continue;
          const dataAluno = rec.cadastro || rec.venda; // cadastro = entrada real
          if (dataAluno && leadDate && dataAluno >= leadDate) continue; // virou-like ainda não gravado → próximo scan persiste
          jaEram++;
          matches[cid] = { nome: rec.nome, unidade: rec.unidade, via, tipo: 'ja_era', data: dataAluno || null };
        }
        return send(res, 200, { enabled: true, matches, summary: { leads: report.leads.length, viraram, jaEram }, scanRunning: !!convScanInflight });
      } catch (e) {
        console.error('[leads-conversion]', e);
        return send(res, 502, { error: 'Falha no cruzamento lead × aluno.', detail: String(e?.message || e) });
      }
    }

    // ── Conversão: RESUMO por mês (pra tabela "Conversão por mês" da aba) ──
    if (req.method === 'GET' && req.url === '/api/leads-conversion-summary') {
      if (!HIST_BASE || !HIST_TOKEN || !LEADS_TABLE || !HIST_TABLE) return send(res, 200, { enabled: false, months: [] });
      if (convSummaryCache.months && Date.now() - convSummaryCache.at < LEADS_CACHE_MS) {
        return send(res, 200, { enabled: true, months: convSummaryCache.months });
      }
      try {
        // 1) Scan em BACKGROUND (mesma razão do endpoint de conversão: 524).
        scanConversoes().catch(e => console.warn('[leads] scan falhou:', e?.message || e));
        const r = await fetch(`${HIST_BASE}/tables/${LEADS_TABLE}/records?fields=month&limit=200&sort=month`, { headers: leadsHeaders() }).then(x => x.json());
        const [idx, convRows] = await Promise.all([getMembersIndex(), getConvRows()]);
        const convByLead = new Map(convRows.map(c => [Number(c.conversation_id), c]));
        const porMes = new Map();   // mês → { leads, leadsAnuncio, conversas, jaEram }
        const viraramConv = new Map(); // mês da MATRÍCULA → conversões (da tabela)
        for (const c of convRows) {
          const m = String(c.month_matricula || c.month_lead || '').slice(0, 7);
          if (m) viraramConv.set(m, (viraramConv.get(m) || 0) + 1);
        }
        for (const row of (r?.list || [])) {
          const report = await getLeadsReport(row.month); // hidrata da tabela de linhas
          const leads = report?.leads ?? [];
          const agg = { leads: leads.length, leadsAnuncio: report?.totals?.leads_anuncio ?? leads.length, conversas: report?.totals?.new_conversations ?? 0, jaEram: 0 };
          for (const lead of leads) {
            const cid = Number(lead.conversation_id) || 0;
            if (convByLead.has(cid)) continue; // conversão gravada — já contada acima
            const leadDate = String(lead.created_at || '').slice(0, 10);
            const nn = histNorm(String(lead?.contact?.name ?? ''));
            const nomeOk = nn && nn.split(' ').length >= 2;
            const digits = String(lead?.contact?.phone_number ?? '').replace(/\D/g, '');
            let rec = digits.length >= 8 ? idx.byPhone.get(digits.slice(-8)) : undefined;
            if (!rec && nomeOk) rec = idx.byName.get(nn);
            if (!rec) continue;
            const d = rec.cadastro || rec.venda; // cadastro = entrada real
            if (d && leadDate && d >= leadDate) continue; // virou-like ainda não gravado → próximo scan
            agg.jaEram++;
          }
          porMes.set(row.month, agg);
        }
        // 2ª passada: monta a saída (união dos meses com lead e com conversão).
        const mesesAll = [...new Set([...porMes.keys(), ...viraramConv.keys()])].sort();
        const out = mesesAll.map(m => {
          const agg = porMes.get(m) ?? { leads: 0, leadsAnuncio: 0, conversas: 0, jaEram: 0 };
          const viraram = viraramConv.get(m) || 0;
          return {
            month: m,
            leads: agg.leads,
            leadsAnuncio: agg.leadsAnuncio,
            conversas: agg.conversas,
            viraram, // matrículas NESTE mês vindas de leads (de qualquer mês)
            jaEram: agg.jaEram,
            taxa: agg.leads > 0 ? Math.round((viraram / agg.leads) * 1000) / 10 : 0,
          };
        });
        // Só cacheia quando NÃO há scan em andamento (senão congela o parcial).
        if (!convScanInflight) convSummaryCache = { at: Date.now(), months: out };
        return send(res, 200, { enabled: true, months: out, scanRunning: !!convScanInflight });
      } catch (e) {
        console.error('[leads-conversion-summary]', e);
        return send(res, 502, { error: 'Falha no resumo de conversão.', detail: String(e?.message || e) });
      }
    }

    // ── Backfill: importa meses ANTERIORES da API do Fluxo de uma vez ──
    if (req.method === 'POST' && req.url === '/api/leads-backfill') {
      // ASSÍNCRONO: os pulls sequenciais estouravam o timeout do proxy e o
      // front recebia a página de erro HTML. Agora responde na hora e o
      // progresso sai em GET /api/leads-backfill/status.
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      if (!leadsPullEnabled()) return send(res, 503, { error: 'Pull não configurado — defina FLUXO_API_TOKEN e FLUXO_ACCOUNT_ID.' });
      // Job preso (ex.: deploy no meio, chamada pendurada antiga) → libera após 10 min.
      if (backfillJob.running && Date.now() - backfillJob.startedAt < 10 * 60 * 1000) {
        return send(res, 200, { ok: true, started: false, jaRodando: true });
      }
      const { months: qtd } = await readBody(req);
      const n = Math.min(Math.max(Number(qtd) || 6, 1), 24);
      backfillJob = { running: true, startedAt: Date.now(), total: n, resultados: [] };
      send(res, 200, { ok: true, started: true, total: n });
      (async () => {
        const now = new Date();
        for (let i = 0; i < n; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          try {
            await leadsPull(m);
            backfillJob.resultados.push({ month: m, ok: true });
          } catch (e) {
            backfillJob.resultados.push({ month: m, ok: false, erro: String(e?.message || e) });
          }
        }
        backfillJob.running = false;
        console.log(`[leads] backfill: ${backfillJob.resultados.map(r => `${r.month}:${r.ok ? 'ok' : 'ERRO'}`).join(' ')}`);
      })().catch(e => { backfillJob.running = false; console.error('[leads] backfill quebrou:', e); });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/leads-backfill/status') {
      return send(res, 200, { running: backfillJob.running, total: backfillJob.total, resultados: backfillJob.resultados });
    }

    // ── AUDITORIA 360 da conversão: confere nome a nome contra as tabelas ──
    // GET /api/leads-360?month=YYYY-MM → todas as vendas do mês (VendasEvo),
    // quais casaram com lead (e de qual mês veio o lead), quais não casaram,
    // e os leads do mês que viraram. Tudo verificável no NocoDB.
    if (req.method === 'GET' && req.url.startsWith('/api/leads-360?')) {
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 200, { enabled: false });
      const month = new URL(req.url, 'http://x').searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { error: 'month=YYYY-MM obrigatório' });
      try {
        const vt = await ensureVendasTable();
        const vendas = [];
        if (vt) {
          for (let offset = 0; offset < 50000; offset += 1000) {
            const r = await fetch(`${HIST_BASE}/tables/${vt}/records?where=(month,eq,${encodeURIComponent(month)})&fields=nome,unidade,sale_date,plano,valor&limit=1000&offset=${offset}`, { headers: leadsHeaders() }).then(x => x.json());
            const list = r?.list || [];
            vendas.push(...list);
            if (list.length < 1000) break;
          }
        }
        const convRows = await getConvRows();
        const convMes = convRows.filter(c => String(c.month_matricula || '').slice(0, 7) === month);
        const convPorNome = new Map(convMes.map(c => [histNorm(String(c.nome || '')), c]));
        const vendasDetalhe = vendas.map(v => {
          const c = convPorNome.get(histNorm(String(v.nome || '')));
          return {
            nome: v.nome, unidade: v.unidade, data: v.sale_date, plano: v.plano, valor: v.valor,
            casouComLead: !!c,
            leadDoMes: c ? String(c.month_lead || '') : null,
            via: c ? c.via : null,
          };
        });
        const casadas = vendasDetalhe.filter(v => v.casouComLead);
        return send(res, 200, {
          enabled: true,
          month,
          vendasNoMes: vendas.length,
          matriculasDeLeads: convMes.length,
          dosLeadsDesteMes: convMes.filter(c => String(c.month_lead) === month).length,
          deLeadsDeMesesAnteriores: convMes.filter(c => String(c.month_lead) !== month).length,
          conversoes: convMes.map(c => ({ nome: c.nome, unidade: c.unidade, leadDoMes: c.month_lead, matriculaEm: c.data_matricula, via: c.via })),
          vendasQueCasaram: casadas.map(v => `${v.nome} (${v.unidade}) ← lead de ${v.leadDoMes} via ${v.via}`),
          vendasSemLead: vendasDetalhe.filter(v => !v.casouComLead).map(v => `${v.nome} (${v.unidade}) · ${v.data}`),
          scanRunning: !!convScanInflight,
        });
      } catch (e) {
        return send(res, 502, { error: 'Falha na auditoria 360.', detail: String(e?.message || e) });
      }
    }

    // ── Vendas por INTERVALO DE DATAS — lê o HISTÓRICO da tabela existente do ──
    // NocoDB (instantâneo, sem EVO, sem backfill). Agrega por unidade no shape
    // que o front espera (VendasRangeResult). Cai pra VendasEvo se a tabela
    // histórica estiver vazia/inacessível.
    if (req.method === 'GET' && req.url.startsWith('/api/vendas-range?')) {
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 200, { enabled: false });
      const q = new URL(req.url, 'http://x').searchParams;
      const from = q.get('from') || '';
      const to   = q.get('to')   || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return send(res, 400, { error: 'from e to (YYYY-MM-DD, from<=to) obrigatórios' });
      }
      try {
        // Histórico direto da tabela do NocoDB (cacheado em memória); fallback VendasEvo.
        let allRows = await getHistVendasRows();
        let fonte = 'nocodb-hist';
        if (!allRows.length) { allRows = await getAllVendasRows(); fonte = 'vendasevo'; }
        const rows = allRows.filter(v => {
          const sd = String(v.sale_date || '').slice(0, 10);
          return sd >= from && sd <= to;
        });
        const byUnit = {};
        const all = [];
        let totalQtd = 0, totalValor = 0;
        for (const v of rows) {
          // Canoniza o nome da unidade pro mesmo que o Painel usa (UNITS) — tolera
          // variações em linhas antigas ("GAVIOES - BELENZINHO", acento, caixa) via
          // histNorm + HIST_UNIT_BY_NORM. Sem isso o byUnit de uma unidade podia
          // não casar com o filtro de unidade do front.
          const rawUnidade = String(v.unidade || '').trim();
          const unidade = HIST_UNIT_BY_NORM.get(histNorm(rawUnidade)) ?? (rawUnidade || '—');
          const valor   = Number(v.valor) || 0;
          const nome    = String(v.nome || '').trim();
          const sp      = nome.indexOf(' ');
          const item = {
            idSale:    Number(v.id_sale) || 0,
            idBranch:  0,
            branchName: unidade,
            idMember:  Number(v.id_member) || undefined,
            firstName: sp > 0 ? nome.slice(0, sp) : nome,
            lastName:  sp > 0 ? nome.slice(sp + 1) : '',
            saleDate:  String(v.sale_date || '').slice(0, 10),
            plan:      String(v.plano || '').trim(),
            total:     valor,
          };
          if (!byUnit[unidade]) byUnit[unidade] = { qtd: 0, valor: 0, complete: true, list: [] };
          byUnit[unidade].qtd += 1;
          byUnit[unidade].valor += valor;
          byUnit[unidade].list.push(item);
          all.push(item);
          totalQtd += 1;
          totalValor += valor;
        }
        for (const k of Object.keys(byUnit)) byUnit[k].valor = Math.round(byUnit[k].valor * 100) / 100;
        return send(res, 200, { enabled: true, fonte, totalQtd, totalValor: Math.round(totalValor * 100) / 100, complete: true, byUnit, list: all });
      } catch (e) {
        console.error('[vendas-range]', e);
        return send(res, 502, { error: 'Falha ao ler vendas do histórico.', detail: String(e?.message || e) });
      }
    }

    // ── Aulas Experimentais por intervalo (lê a tabela; backfill em bg dos faltantes) ──
    if (req.method === 'GET' && req.url.startsWith('/api/comercial-exp-range?')) {
      if (!SCRAPER_URL) return send(res, 200, { enabled: false });
      const q = new URL(req.url, 'http://x').searchParams;
      const from = q.get('from') || '';
      const to   = q.get('to')   || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return send(res, 400, { error: 'from e to (YYYY-MM-DD, from<=to) obrigatórios' });
      }
      // Serve do CACHE (scraper). Se não tem cache fresco, dispara scrape em bg e
      // devolve o que tiver (front re-consulta enquanto backfilling=true).
      const key = `${from}|${to}`;
      const cached = EXP_MEM.get(key);
      const fresh = cached && (Date.now() - cached.at < EXP_MEM_TTL);
      if (!fresh) kickExpScrape(key, from, to);
      return send(res, 200, { enabled: true, byUnit: cached?.byUnit || {}, backfilling: expScrapeRunning && !fresh });
    }

    // ── Recalcular (força re-scrape do range, ignorando o cache) ──
    if (req.method === 'POST' && req.url === '/api/comercial-exp-backfill') {
      if (!SCRAPER_URL) return send(res, 200, { enabled: false });
      const body = await readBody(req);
      const from = String(body?.from || '');
      const to   = String(body?.to   || from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        EXP_MEM.delete(`${from}|${to}`);
        kickExpScrape(`${from}|${to}`, from, to);
      }
      return send(res, 200, { ok: true, started: true, running: expScrapeRunning });
    }
    if (req.method === 'GET' && req.url === '/api/comercial-exp-backfill/status') {
      return send(res, 200, { running: expScrapeRunning });
    }

    // ── Debug do mapeamento da tabela histórica de vendas (conferir colunas) ──
    if (req.method === 'GET' && req.url === '/api/vendas-hist-debug') {
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 200, { enabled: false });
      try {
        const rows = await getHistVendasRows();
        const meses = [...new Set(rows.map(r => String(r.sale_date || '').slice(0, 7)).filter(Boolean))].sort();
        return send(res, 200, {
          enabled: true, table: HIST_VENDAS_TABLE, count: rows.length,
          colunasDetectadas: histVendasCache.cols, meses, amostra: rows.slice(0, 3),
        });
      } catch (e) {
        return send(res, 502, { error: 'Falha no debug do histórico.', detail: String(e?.message || e) });
      }
    }

    // ── Cancelamentos por INTERVALO DE DATAS (tabela do NocoDB) ──
    // Alimenta a EVASÃO de períodos passados no Painel. Conta por unidade
    // (nome canônico), no mesmo espírito do /api/vendas-range.
    if (req.method === 'GET' && req.url.startsWith('/api/cancelamentos-range?')) {
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 200, { enabled: false });
      const q = new URL(req.url, 'http://x').searchParams;
      const from = q.get('from') || '';
      const to   = q.get('to')   || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return send(res, 400, { error: 'from e to (YYYY-MM-DD, from<=to) obrigatórios' });
      }
      try {
        const all = await getCancelamentosRows();
        const byUnit = {};
        const lista = [];
        let total = 0;
        for (const c of all) {
          const d = String(c.data || '').slice(0, 10);
          if (!(d >= from && d <= to)) continue;
          const unidade = HIST_UNIT_BY_NORM.get(histNorm(String(c.unidade || ''))) ?? (String(c.unidade || '').trim() || '—');
          byUnit[unidade] = (byUnit[unidade] || 0) + 1;
          total += 1;
          lista.push({ nome: c.nome, unidade, data: d, motivo: c.motivo });
        }
        return send(res, 200, { enabled: true, total, byUnit, lista });
      } catch (e) {
        console.error('[cancelamentos-range]', e);
        return send(res, 502, { error: 'Falha ao ler cancelamentos do histórico.', detail: String(e?.message || e) });
      }
    }

    // ── Debug do mapeamento da tabela de cancelamentos (conferir colunas) ──
    if (req.method === 'GET' && req.url === '/api/cancelamentos-debug') {
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 200, { enabled: false });
      try {
        const rows = await getCancelamentosRows();
        const meses = [...new Set(rows.map(r => String(r.data || '').slice(0, 7)).filter(Boolean))].sort();
        return send(res, 200, {
          enabled: true, table: HIST_CANCEL_TABLE, count: rows.length,
          colunasDetectadas: cancelCache.cols, meses, amostra: rows.slice(0, 3),
        });
      } catch (e) {
        return send(res, 502, { error: 'Falha no debug de cancelamentos.', detail: String(e?.message || e) });
      }
    }

    // ── Backfill EXPLÍCITO da VendasEvo (sync da EVO p/ meses recentes) ──
    if (req.method === 'POST' && req.url === '/api/vendas-backfill') {
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      if (!HIST_BASE || !HIST_TOKEN) return send(res, 503, { error: 'NocoDB não configurado.' });
      // Job preso (deploy no meio etc.) → libera após 30 min.
      if (vendasBackfillJob.running && Date.now() - vendasBackfillJob.startedAt < 30 * 60 * 1000) {
        return send(res, 200, { ok: true, started: false, jaRodando: true, total: vendasBackfillJob.total, done: vendasBackfillJob.done });
      }
      const { months: qtd } = await readBody(req);
      const n = Math.min(Math.max(Number(qtd) || 12, 1), 36);
      vendasBackfillJob = { running: true, startedAt: Date.now(), total: n, done: 0, resultados: [] };
      send(res, 200, { ok: true, started: true, total: n });
      (async () => {
        const now = new Date();
        for (let i = 0; i < n; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          try { const ok = await syncVendasMonth(m, { skipPhone: true }); vendasBackfillJob.resultados.push({ month: m, ok }); }
          catch (e) { vendasBackfillJob.resultados.push({ month: m, ok: false, erro: String(e?.message || e) }); }
          vendasBackfillJob.done = i + 1;
        }
        vendasBackfillJob.running = false;
        vendasRowsCache = { at: 0, rows: null }; // recarrega o cache já com tudo
        console.log(`[vendas] backfill: ${vendasBackfillJob.resultados.map(r => `${r.month}:${r.ok ? 'ok' : 'ERRO'}`).join(' ')}`);
      })().catch(e => { vendasBackfillJob.running = false; console.error('[vendas] backfill quebrou:', e); });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/vendas-backfill/status') {
      return send(res, 200, { running: vendasBackfillJob.running, total: vendasBackfillJob.total, done: vendasBackfillJob.done, resultados: vendasBackfillJob.resultados });
    }

    // ── Histórico mensal agregado (Tendência & Projeção) ──
    if (req.method === 'GET' && req.url === '/api/history') {
      if (!HIST_BASE || !HIST_TOKEN || !HIST_TABLE) {
        return send(res, 200, { enabled: false, rows: [] }); // front cai no fallback
      }
      const fresh = histCache.rows && (Date.now() - histCache.at) < HIST_TTL_MS;
      if (!fresh) {
        try {
          histInflight = histInflight || buildHistoryRows();
          const rows = await histInflight;
          histCache = { at: Date.now(), rows };
        } catch (e) {
          console.error('[history]', e);
          // Mantém cache velho se existir; senão repassa o erro pro front cair no fallback.
          if (!histCache.rows) return send(res, 502, { error: 'Falha ao agregar histórico do NocoDB.', detail: String(e?.message || e) });
        } finally {
          histInflight = null;
        }
      }
      return send(res, 200, { enabled: true, rows: histCache.rows, fetchedAt: new Date(histCache.at).toISOString() });
    }

    // ── Histórico de RECEBIMENTOS agregado (Faturamento Real do Financeiro) ──
    if (req.method === 'GET' && req.url === '/api/history-recebimentos') {
      if (!HIST_BASE || !HIST_TOKEN || !RECEB_TABLE) {
        return send(res, 200, { enabled: false, rows: [] });
      }
      const fresh = recebCache.rows && (Date.now() - recebCache.at) < HIST_TTL_MS;
      if (!fresh) {
        try {
          recebInflight = recebInflight || buildRecebimentosRows();
          const rows = await recebInflight;
          recebCache = { at: Date.now(), rows };
        } catch (e) {
          console.error('[recebimentos]', e);
          if (!recebCache.rows) return send(res, 502, { error: 'Falha ao agregar recebimentos do NocoDB.', detail: String(e?.message || e) });
        } finally {
          recebInflight = null;
        }
      }
      return send(res, 200, { enabled: true, rows: recebCache.rows, fetchedAt: new Date(recebCache.at).toISOString() });
    }

    // ── Convidar ──
    if (req.method === 'POST' && req.url === '/api/invite') {
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
      const { email } = await readBody(req);
      if (!email) return send(res, 400, { error: 'email obrigatório' });
      if (!SMTP_USER) return send(res, 500, { error: 'SMTP não configurado (faltam variáveis de e-mail no env)' });

      if (!FRONTEND_URL) return send(res, 500, { error: 'FRONTEND_URL não configurado no env (precisa pro link do convite).' });

      let user;
      try {
        user = await nocoFindUser('email', String(email).trim().toLowerCase());
      } catch (e) {
        return send(res, 502, { error: 'Falha ao consultar o NocoDB.', detail: String(e?.message || e) });
      }
      if (!user) return send(res, 404, { error: 'Usuário não encontrado. Crie o usuário antes de convidar.' });

      const token = crypto.randomBytes(24).toString('hex');
      const expires = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000).toISOString();
      try {
        await nocoPatch({ Id: user.Id, invite_token: token, invite_expires: expires });
      } catch (e) {
        return send(res, 502, { error: 'Falha ao gravar o convite no NocoDB (a coluna invite_token existe?).', detail: String(e?.message || e) });
      }

      const link = `${FRONTEND_URL.replace(/\/+$/, '')}/definir-senha?token=${token}`;
      try {
        await transporter.sendMail({
          from: `"${PLATFORM_NAME}" <${MAIL_FROM}>`,
          to: user.email,
          subject: `Seu acesso ao painel ${PLATFORM_NAME}`,
          html: inviteEmailHtml({ name: user.name, link }),
        });
      } catch (e) {
        return send(res, 502, { error: 'Falha ao enviar o e-mail (confira SMTP_ADDRESS/PORT/USERNAME/PASSWORD).', detail: String(e?.message || e) });
      }
      return send(res, 200, { ok: true });
    }

    // ── Definir senha pelo token ──
    if (req.method === 'POST' && req.url === '/api/set-password') {
      if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
      const { token, password } = await readBody(req);
      if (!token || !password) return send(res, 400, { error: 'token e senha obrigatórios' });
      if (String(password).length < 8) return send(res, 400, { error: 'senha mínima de 8 caracteres' });

      const user = await nocoFindUser('invite_token', token);
      if (!user) return send(res, 400, { error: 'convite inválido ou já usado' });
      if (user.invite_expires && new Date(user.invite_expires).getTime() < Date.now()) {
        return send(res, 400, { error: 'convite expirado — peça um novo convite' });
      }

      await nocoPatch({
        Id: user.Id,
        password_hash: sha256(password),
        active: true,
        invite_token: '',
        invite_expires: '',
      });
      return send(res, 200, { ok: true, email: user.email });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[invite-server]', e);
    send(res, 500, { error: 'erro interno', detail: String(e?.message || e) });
  }
});

server.listen(PORT, () => console.log(`[invite-server] ouvindo na porta ${PORT} · from=${MAIL_FROM} · noco=${!!NOCO_TOKEN}`));
