// HTTP API. Express 5.
//
// Endpoints:
//   GET  /health             — healthcheck (sem auth, pra Easypanel/Loadbalancer)
//   POST /sync               — dispara um job de scraping. body: { branches?: string[] }
//   GET  /sync/:id           — retorna status do job (pra polling do dashboard)
//   GET  /sync               — lista últimos N jobs
//   GET  /last-sync          — info do último sync que deu certo (cache de 5 min é desnecessário, é fast)
//
// Auth: bearer token compartilhado via SCRAPER_TOKEN env. CORS strict pra origens
// listadas em CORS_ORIGINS.

import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { enqueueSync, getJob, listRecentJobs, lastSuccessfulJob } from './jobs.js';
import { getLatestSnapshot, getBranchSnapshot } from './storage.js';
import { ensureAuthenticated } from './auth.js';
import { createEvoClient } from './evoClient.js';
import { extractExperimentais } from './extractors/experimentais.js';
import { agregadoresCheckinsRange } from './extractors/gerencial.js';

export function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS — explícito por origin
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Bearer auth — exceto /health
  function requireBearer(req: Request, res: Response, next: NextFunction) {
    const auth = req.header('authorization') ?? '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== config.scraperToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'evo-scraper', version: '0.1.0' });
  });

  // Página inicial (localhost) — visão amigável do último snapshot + botão de atualizar.
  // O token fica embutido no HTML porque é uma ferramenta local de 1 usuário.
  app.get('/', async (_req, res) => {
    const snap = await getLatestSnapshot();
    res.type('html').send(renderHomePage(snap, config.scraperToken));
  });

  app.post('/sync', requireBearer, (req, res) => {
    const branches = Array.isArray(req.body?.branches) ? req.body.branches.map(String) : undefined;
    const job = enqueueSync(branches);
    res.status(202).json({ jobId: job.id, status: job.status, branches: job.branches });
  });

  app.get('/sync/:id', requireBearer, (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  });

  app.get('/sync', requireBearer, (_req, res) => {
    res.json({ jobs: listRecentJobs(20) });
  });

  // Dados extraídos — o dashboard consome daqui. Retorna o último snapshot salvo.
  // GET /data           → snapshot mais recente (qualquer filial)
  // GET /data/:branchId → snapshot de uma filial específica
  app.get('/data', requireBearer, async (_req, res) => {
    const snap = await getLatestSnapshot();
    if (!snap) return res.status(404).json({ error: 'sem snapshot ainda — rode POST /sync' });
    res.json(snap);
  });

  app.get('/data/:branchId', requireBearer, async (req, res) => {
    const snap = await getBranchSnapshot(String(req.params.branchId));
    if (!snap) return res.status(404).json({ error: 'sem snapshot pra essa filial' });
    res.json(snap);
  });

  // Aulas Experimentais (aba Comercial) — raspa o painel gerencial no intervalo
  // [from,to] e devolve por dia + totais. É a fonte da Comercial (a Gaviões não tem
  // API de integração pra isso). GET /exp?from=YYYY-MM-DD&to=YYYY-MM-DD (to opcional=from).
  app.get('/exp', requireBearer, async (req, res) => {
    const from = String(req.query.from ?? '');
    const to   = String(req.query.to ?? from) || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ error: 'from/to no formato YYYY-MM-DD, from <= to' });
    }
    let context;
    try {
      const auth = await ensureAuthenticated();
      context = auth.context;
      const client = await createEvoClient(auth.page);
      const r = await extractExperimentais(client, from, to);
      res.json({ unidade: 'Gaviões', from, to, ...r });
    } catch (e) {
      logger.error({ err: (e as Error).message, from, to }, 'exp scrape failed');
      res.status(502).json({ error: (e as Error).message });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });

  // Check-ins por agregador (Wellhub/Totalpass/Gurupass/GoGood) no intervalo
  // [from,to] — fonte da tela de Agregadores quando se filtra por período.
  // GET /agregadores/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD (to opcional=from).
  app.get('/agregadores/checkins', requireBearer, async (req, res) => {
    const from = String(req.query.from ?? '');
    const to   = String(req.query.to ?? from) || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ error: 'from/to no formato YYYY-MM-DD, from <= to' });
    }
    let context;
    try {
      const auth = await ensureAuthenticated();
      context = auth.context;
      const client = await createEvoClient(auth.page);
      const erros: string[] = [];
      // ISO com T03:00:00.000Z = meia-noite BRT (mesmo formato que a SPA manda).
      const list = await agregadoresCheckinsRange(client, `${from}T03:00:00.000Z`, `${to}T03:00:00.000Z`, erros);
      res.json({ unidade: 'Gaviões', from, to, agregadoresCheckins: list, erros });
    } catch (e) {
      logger.error({ err: (e as Error).message, from, to }, 'agregadores checkins scrape failed');
      res.status(502).json({ error: (e as Error).message });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });

  app.get('/last-sync', requireBearer, (_req, res) => {
    const j = lastSuccessfulJob();
    if (!j) return res.json({ lastSync: null });
    res.json({
      lastSync: {
        id: j.id,
        finishedAt: j.finishedAt,
        branchesProcessed: j.result?.branchesProcessed ?? 0,
        errors: j.result?.errors ?? [],
      },
    });
  });

  // Error handler global — log + 500
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

/** HTML simples (sem build) pra visualizar o snapshot no navegador. */
function renderHomePage(snap: Awaited<ReturnType<typeof getLatestSnapshot>>, token: string): string {
  const fmt = (n: number | null | undefined, suf = '') =>
    n === null || n === undefined ? '—' : `${typeof n === 'number' ? n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : n}${suf}`;
  const quando = snap?.capturadoEm
    ? new Date(snap.capturadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'nunca';

  const cards = snap ? [
    ['Clientes ativos', fmt(snap.clientesAtivos), `mês ant. ${fmt(snap.clientesAtivosMesAnterior)}`],
    ['Adimplentes', fmt(snap.adimplentes), ''],
    ['Inadimplentes', fmt(snap.inadimplentes), ''],
    ['VIPs', fmt(snap.vips), ''],
    ['Suspensos', fmt(snap.suspensos), ''],
    ['Personais', fmt(snap.personais), ''],
    ['Agregadores', fmt(snap.agregadores), ''],
    ['Evasão', fmt(snap.evasaoPerc, '%'), ''],
    ['Tempo médio de vida', fmt(snap.tempoMedioVida, ' meses'), ''],
    ['Cancelamentos no mês', fmt(snap.cancelamentosMes), `hoje ${fmt(snap.cancelamentosHoje)}`],
    ['Check-ins (7 dias)', fmt(snap.checkinsPeriodo), ''],
  ] : [];

  const cardsHtml = cards.map(([t, v, sub]) => `
    <div class="card">
      <div class="t">${t}</div>
      <div class="v">${v}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gaviões EVO Scraper</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0f1115; color:#e8eaed; }
  header { padding:24px 32px; border-bottom:1px solid #232733; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
  h1 { font-size:18px; margin:0; font-weight:600; }
  .meta { color:#9aa0a6; font-size:13px; margin-top:4px; }
  button { background:#7c5cff; color:#fff; border:0; padding:10px 18px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:14px; padding:28px 32px; }
  .card { background:#171a21; border:1px solid #232733; border-radius:12px; padding:16px 18px; }
  .card .t { color:#9aa0a6; font-size:13px; }
  .card .v { font-size:28px; font-weight:700; margin-top:6px; }
  .card .sub { color:#6b7280; font-size:12px; margin-top:4px; }
  .empty { padding:40px 32px; color:#9aa0a6; }
  #status { font-size:13px; color:#9aa0a6; }
  footer { padding:16px 32px; color:#6b7280; font-size:12px; border-top:1px solid #232733; }
  code { background:#171a21; padding:2px 6px; border-radius:4px; }
</style></head>
<body>
  <header>
    <div>
      <h1>🦅 Gaviões — EVO Scraper</h1>
      <div class="meta">Filial ${snap?.branchId ?? '—'} · última atualização: <b>${quando}</b> · <span id="status">pronto</span></div>
    </div>
    <button id="btn" onclick="atualizar()">Atualizar dados</button>
  </header>
  ${snap ? `<div class="grid">${cardsHtml}</div>` : `<div class="empty">Nenhum dado ainda. Clique em <b>Atualizar dados</b> pra puxar da conta EVO.</div>`}
  <footer>API: <code>GET /data</code> · <code>POST /sync</code> · <code>GET /sync/:id</code> — todas exigem <code>Authorization: Bearer &lt;token&gt;</code></footer>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  async function atualizar() {
    const btn = document.getElementById('btn'), st = document.getElementById('status');
    btn.disabled = true; st.textContent = 'disparando…';
    try {
      const r = await fetch('/sync', { method:'POST', headers:H, body:'{}' });
      const { jobId } = await r.json();
      for (let i=0;i<40;i++) {
        await new Promise(res=>setTimeout(res,3000));
        const j = await (await fetch('/sync/'+jobId, { headers:H })).json();
        st.textContent = j.progress.step + ' ' + j.progress.percent + '%';
        if (j.status === 'done') { st.textContent = 'concluído ✓'; return location.reload(); }
        if (j.status === 'failed') { st.textContent = 'falhou: ' + (j.error || (j.result&&j.result.errors&&j.result.errors[0]) || '?'); break; }
      }
    } catch (e) { st.textContent = 'erro: ' + e.message; }
    finally { btn.disabled = false; }
  }
</script>
</body></html>`;
}
