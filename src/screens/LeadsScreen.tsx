import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Megaphone, Users, MessageCircle, Percent, Search, AlertTriangle, Inbox, RefreshCw, FileDown } from 'lucide-react';
import { StatsCard } from '../components/StatsCard';
import { LoadingBar } from '../components/ui/LoadingBar';
import { MonthFilterBar } from '../components/MonthCalendarPopover';
import { currentYM } from '../lib/date';
import { formatNumber } from '../lib/format';

// ─────────────────────────────────────────────────────────────────────────────
// Aba LEADS — relatório diário do Fluxo (webhook leads_report + pull).
// Mostra SOMENTE conversas com etiqueta de anúncio. (Cruzamento de conversão
// foi removido da tela a pedido — as tabelas no NocoDB seguem acumulando.)
// ─────────────────────────────────────────────────────────────────────────────

interface LeadContact { id?: number; name?: string; phone_number?: string | null; email?: string | null }
interface LeadRow {
  conversation_id: number;
  display_id?: number;
  status?: string;
  created_at?: string;
  contact?: LeadContact;
  ad_label?: string | null;
  team?: string;
  inbox?: string;
  unit?: string;
}
interface LeadsReport {
  event: string;
  account_id: number;
  account_name?: string;
  scope?: string;
  recomputed?: boolean;
  period?: { month?: string; from?: string; to?: string; generated_at?: string };
  totals?: {
    new_conversations?: number;
    leads_anuncio?: number;
    by_ad?: { ad_id?: number | null; ad_name?: string; label?: string; count?: number; team_name?: string }[];
    by_team?: { team_id?: number; team_name?: string; count?: number }[];
    by_inbox?: { inbox_id?: number; inbox_name?: string; count?: number }[];
  };
  truncated?: boolean;
  leads?: LeadRow[];
}

const STATUS_BADGE: Record<string, string> = {
  open:     'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending:  'bg-amber-50 text-amber-700 border-amber-200',
  snoozed:  'bg-slate-50 text-slate-500 border-slate-200',
  resolved: 'bg-sky-50 text-sky-700 border-sky-200',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'Aberta', pending: 'Pendente', snoozed: 'Adiada', resolved: 'Resolvida',
};

interface Props {
  /** Esconde nome/telefone do lead (toggle can_see_cliente_nome). */
  showClientData?: boolean;
  /** Pode baixar o relatório em PDF (toggle can_download_pdf). */
  canDownloadPdf?: boolean;
}

export function LeadsScreen({ showClientData = true, canDownloadPdf = true }: Props) {
  const [months, setMonths] = useState<{ month: string; generated_at?: string }[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [month, setMonth] = useState<string>(currentYM());
  const [report, setReport] = useState<LeadsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [unitFilter, setUnitFilter] = useState('Todas');
  const [statusFilter, setStatusFilter] = useState<string>('todos');
  const [adFilter, setAdFilter] = useState<string>('Todos');
  const [pullEnabled, setPullEnabled] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillInfo, setBackfillInfo] = useState<string | null>(null);
  const [backfillProg, setBackfillProg] = useState<{ done: number; total: number } | null>(null);
  const [gerandoPdf, setGerandoPdf] = useState(false);

  // Pull sob demanda: pede pro servidor buscar o relatório na API do Fluxo agora.
  const pullNow = async (m?: string) => {
    setPulling(true);
    setPullError(null);
    try {
      const r = await fetch('/api/leads-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m ? { month: m } : {}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setReloadKey(k => k + 1);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
    }
  };

  // Backfill ASSÍNCRONO com polling de status (proxy corta requisição longa).
  const backfill = async () => {
    setBackfilling(true);
    setPullError(null);
    setBackfillInfo(null);
    try {
      const r = await fetch('/api/leads-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months: 6 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const inicio = Date.now();
      let final: { month: string; ok: boolean; erro?: string }[] = [];
      while (Date.now() - inicio < 15 * 60 * 1000) {
        await new Promise(ok => setTimeout(ok, 2500));
        const st = await fetch('/api/leads-backfill/status').then(x => x.json()).catch(() => null);
        if (!st) continue;
        final = (st.resultados ?? []) as typeof final;
        const total = st.total ?? 6;
        setBackfillProg({ done: final.length, total });
        const ultimo = final[final.length - 1];
        setBackfillInfo(`importando ${final.length}/${total} meses${ultimo ? ` · último: ${ultimo.month} ${ultimo.ok ? '✓' : '✗'}` : ''}`);
        if (!st.running) break;
      }
      setBackfillProg(null);
      const okList = final.filter(x => x.ok).map(x => x.month);
      const falhas = final.filter(x => !x.ok);
      setBackfillInfo(
        `${okList.length} ${okList.length === 1 ? 'mês importado' : 'meses importados'}` +
        (okList.length ? ` (${okList.join(', ')})` : '') +
        (falhas.length ? ` · falharam: ${falhas.map(f => `${f.month} — ${f.erro}`).join(' | ')}` : ''),
      );
      setReloadKey(k => k + 1);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackfilling(false);
    }
  };

  // Relatório estruturado em PDF (gerado pelo dash, sem seção de conversão).
  const gerarPdf = async () => {
    if (!report) return;
    setGerandoPdf(true);
    try {
      const { generateLeadsReport } = await import('../services/leadsReportPdf');
      const anu = (report.leads ?? []).filter(l => l.ad_label);
      const contar = (key: (l: LeadRow) => string | undefined | null, vazio: string) => {
        const m = new Map<string, number>();
        for (const l of anu) { const k = key(l) || vazio; m.set(k, (m.get(k) ?? 0) + 1); }
        return [...m.entries()].map(([nome, n]) => ({ nome, n })).sort((a, b) => b.n - a.n);
      };
      const ST: Record<string, { nome: string; cor: 'verde' | 'ambar' | 'azul' | 'cinza' }> = {
        resolved: { nome: 'Resolvidos', cor: 'verde' }, snoozed: { nome: 'Adiados', cor: 'ambar' },
        open: { nome: 'Abertos', cor: 'azul' }, pending: { nome: 'Pendentes', cor: 'cinza' },
      };
      const stMap = new Map<string, number>();
      for (const l of anu) { const k = l.status ?? '?'; stMap.set(k, (stMap.get(k) ?? 0) + 1); }
      generateLeadsReport({
        month,
        totals: { conversas: report.totals?.new_conversations ?? 0, leadsAnuncio: report.totals?.leads_anuncio ?? anu.length },
        porTime: contar(l => l.team, 'Sem time atribuído'),
        porCampanha: contar(l => l.ad_label === 'anuncio' ? 'anuncio (genérica)' : l.ad_label, '—'),
        porStatus: [...stMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ nome: ST[k]?.nome ?? k, n, cor: ST[k]?.cor ?? 'cinza' })),
        truncated: !!report.truncated,
        amostra: anu.length,
      });
    } finally {
      setGerandoPdf(false);
    }
  };

  // Meses disponíveis (auto-pull do mês corrente quando vazio, no servidor).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/leads-report/months')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (!j?.enabled) { setEnabled(false); setLoading(false); return; }
        setPullEnabled(!!j.pull);
        const list = (j.months ?? []) as { month: string; generated_at?: string }[];
        setMonths(list);
        if (list.length > 0) setMonth(list[list.length - 1].month);
        else setLoading(false);
      })
      .catch(() => { if (!cancelled) { setEnabled(false); setLoading(false); } });
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Relatório do mês selecionado.
  useEffect(() => {
    if (!enabled || months.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setLoading(true); });
    fetch(`/api/leads-report?month=${month}`)
      .then(r => r.json())
      .then(j => { if (!cancelled) { setReport(j?.report ?? null); setLoading(false); } })
      .catch(() => { if (!cancelled) { setReport(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [enabled, months.length, month, reloadKey]);

  const totals = report?.totals;
  const taxa = (totals?.new_conversations ?? 0) > 0
    ? ((totals?.leads_anuncio ?? 0) / (totals?.new_conversations ?? 1)) * 100
    : 0;

  // A página mostra SOMENTE leads etiquetados.
  const baseLeads = useMemo(() => (report?.leads ?? []).filter(l => l.ad_label), [report]);

  const units = useMemo(() => {
    const s = new Set<string>();
    for (const l of baseLeads) if (l.unit) s.add(l.unit);
    return ['Todas', ...[...s].sort()];
  }, [baseLeads]);

  const ads = useMemo(() => {
    const s = new Set<string>();
    for (const l of baseLeads) if (l.ad_label) s.add(l.ad_label);
    return ['Todos', ...[...s].sort()];
  }, [baseLeads]);

  const preStatus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseLeads.filter(l => {
      if (unitFilter !== 'Todas' && l.unit !== unitFilter) return false;
      if (adFilter !== 'Todos' && l.ad_label !== adFilter) return false;
      if (!q) return true;
      return [l.contact?.name, l.contact?.phone_number, l.ad_label, l.team, l.inbox, l.unit]
        .some(v => String(v ?? '').toLowerCase().includes(q));
    });
  }, [baseLeads, search, unitFilter, adFilter]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { todos: preStatus.length };
    for (const l of preStatus) { const st = l.status ?? '?'; c[st] = (c[st] ?? 0) + 1; }
    return c;
  }, [preStatus]);

  const filteredLeads = useMemo(() => {
    const list = statusFilter === 'todos' ? preStatus : preStatus.filter(l => l.status === statusFilter);
    return [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  }, [preStatus, statusFilter]);

  const minMonth = months[0]?.month;
  const fmtDT = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-8 py-10">
      <LoadingBar active={loading} label="Carregando leads" />
      {/* Header */}
      <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.4 }}
        className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-8">
        <div>
          <span className="text-[10px] font-black text-primary uppercase tracking-[0.25em]">Aquisição · Fluxo</span>
          <h1 className="text-[2rem] sm:text-[2.6rem] font-black text-slate-900 leading-tight tracking-tighter">Leads</h1>
          <p className="text-slate-400 text-[14px] font-semibold max-w-2xl">
            Somente conversas com etiqueta de anúncio, atualizadas todo dia às 06:10 pelo Fluxo
            {report?.period?.generated_at ? ` · último envio ${fmtDT(report.period.generated_at)}` : ''}.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canDownloadPdf && months.length > 0 && (
            <button
              type="button"
              onClick={gerarPdf}
              disabled={gerandoPdf || loading || !report}
              title="Gerar relatório estruturado em PDF — leads por time, campanhas e status"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-white rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-[#0a0a0a] transition-colors disabled:opacity-50 shadow-sm"
            >
              <FileDown size={13} />
              {gerandoPdf ? 'Gerando…' : 'Relatório (PDF)'}
            </button>
          )}
          {pullEnabled && (
            <button
              type="button"
              onClick={backfill}
              disabled={backfilling || pulling}
              title="Importar os últimos 6 meses da API do Fluxo (backfill)"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-50 shadow-sm"
            >
              <RefreshCw size={13} className={backfilling ? 'animate-spin' : ''} />
              {backfilling ? 'Importando…' : 'Importar meses'}
            </button>
          )}
          {pullEnabled && (
            <button
              type="button"
              onClick={() => pullNow(month)}
              disabled={pulling || backfilling}
              title="Buscar o relatório AGORA na API do Fluxo (sem esperar o envio das 06:10)"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-primary hover:text-white transition-colors disabled:opacity-50 shadow-sm"
            >
              <RefreshCw size={13} className={pulling ? 'animate-spin' : ''} />
              {pulling ? 'Buscando…' : 'Atualizar agora'}
            </button>
          )}
          {months.length > 0 && (
            <MonthFilterBar
              selectedMonth={month}
              isCurrent={month === currentYM()}
              minMonth={minMonth}
              onPick={setMonth}
              onReset={() => setMonth(months[months.length - 1]?.month ?? currentYM())}
              legend="Cinza = sem relatório recebido"
            />
          )}
        </div>
      </motion.div>

      {pullError && (
        <div className="mb-6 px-5 py-3 bg-rose-50 border border-rose-100 rounded-2xl text-[13px] font-bold text-rose-600">
          Falha ao buscar agora: {pullError}
        </div>
      )}
      {backfillInfo && (
        <div className="mb-6 px-5 py-3.5 bg-indigo-50 border border-indigo-100 rounded-2xl">
          <div className="flex items-center justify-between gap-3 text-[13px] font-bold text-indigo-700">
            <span>Importação: {backfillInfo}</span>
            {backfillProg && (
              <span className="tabular-nums shrink-0">{Math.round((backfillProg.done / Math.max(backfillProg.total, 1)) * 100)}%</span>
            )}
          </div>
          {backfillProg && (
            <div className="mt-2 h-2 bg-indigo-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                style={{ width: `${(backfillProg.done / Math.max(backfillProg.total, 1)) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Estado: integração ainda sem dados */}
      {(!enabled || months.length === 0) && !loading && (
        <div className="py-20 text-center bg-white rounded-[2.5rem] border border-slate-100">
          <Megaphone size={36} className="mx-auto text-slate-200 mb-4" />
          <p className="text-slate-500 font-bold">Nenhum relatório de leads recebido ainda</p>
          <p className="text-slate-400 text-[13px] mt-2 max-w-md mx-auto">
            {pullEnabled
              ? 'Clique em "Buscar agora" pra puxar o mês corrente direto da API do Fluxo — ou aguarde o envio automático das 06:10.'
              : 'Cadastre o webhook no Fluxo (Configurações → Integrações → Webhooks) apontando pra /api/leads-report. Pra trazer os dados AGORA, configure também FLUXO_API_TOKEN e FLUXO_ACCOUNT_ID no servidor.'}
          </p>
          {pullEnabled && (
            <button
              type="button"
              onClick={() => pullNow()}
              disabled={pulling}
              className="mt-6 inline-flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-xl text-[12px] font-black uppercase tracking-wider hover:bg-[#0a0a0a] transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={pulling ? 'animate-spin' : ''} />
              {pulling ? 'Buscando…' : 'Buscar agora'}
            </button>
          )}
        </div>
      )}

      {(enabled && months.length > 0) && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
            <StatsCard title="Leads do mês" value={loading ? '—' : formatNumber(totals?.leads_anuncio ?? 0)}
              comparison={`etiqueta anuncio/anuncio-* · ${formatNumber(baseLeads.length)} detalhados na lista`}
              icon={Megaphone} color="primary" valueColorClass="text-primary" isLoading={loading} />
            <StatsCard title="Conversas novas" value={loading ? '—' : formatNumber(totals?.new_conversations ?? 0)}
              comparison="todas as conversas do canal no mês (contexto)"
              icon={MessageCircle} color="blue" valueColorClass="text-blue-600" isLoading={loading} />
            <StatsCard title="% via anúncio" value={loading ? '—' : `${taxa.toFixed(1).replace('.', ',')}%`}
              comparison="leads de anúncio ÷ conversas novas"
              icon={Percent} color="accent" valueColorClass="text-emerald-600" isLoading={loading} />
          </div>

          {/* Quebras: anúncio / time / caixa */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
            {([
              { titulo: 'Por anúncio', icone: Megaphone, linhas: (totals?.by_ad ?? []).map(a => ({ nome: a.ad_name || a.label || '—', extra: a.team_name, count: a.count ?? 0 })) },
              { titulo: 'Por time', icone: Users, linhas: (totals?.by_team ?? []).map(t => ({ nome: t.team_name || '—', extra: undefined, count: t.count ?? 0 })) },
              { titulo: 'Por caixa de entrada', icone: Inbox, linhas: (totals?.by_inbox ?? []).map(i => ({ nome: i.inbox_name || '—', extra: undefined, count: i.count ?? 0 })) },
            ]).map(({ titulo, icone: Icone, linhas }) => {
              const max = Math.max(1, ...linhas.map(l => l.count));
              return (
                <div key={titulo} className="bg-white rounded-[1.8rem] border border-slate-100 p-6 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <Icone size={14} className="text-primary" />
                    <h3 className="text-[12px] font-black text-slate-700 uppercase tracking-wider">{titulo}</h3>
                  </div>
                  {linhas.length === 0 ? (
                    <p className="text-[12px] text-slate-400 font-semibold">Sem dados neste mês</p>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {[...linhas].sort((a, b) => b.count - a.count).map((l, i) => (
                        <div key={i}>
                          <div className="flex items-center justify-between gap-2 text-[12px] font-bold">
                            <span className="text-slate-600 truncate">{l.nome}{l.extra ? <span className="text-slate-400 font-semibold"> · {l.extra}</span> : null}</span>
                            <span className="text-slate-900 font-black tabular-nums shrink-0">{formatNumber(l.count)}</span>
                          </div>
                          <div className="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                            <div className="h-full bg-primary/70 rounded-full" style={{ width: `${(l.count / max) * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Lista de leads */}
          <div className="bg-white rounded-[1.8rem] border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-4 border-b border-slate-100">
              <h3 className="text-[12px] font-black text-slate-700 uppercase tracking-wider">
                Leads do mês <span className="text-slate-400">({formatNumber(filteredLeads.length)})</span>
              </h3>
              <div className="flex items-center gap-2 flex-wrap">
                <select value={adFilter} onChange={e => setAdFilter(e.target.value)}
                  title="Filtrar por anúncio"
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[12px] font-bold text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  {ads.map(a => <option key={a} value={a}>{a === 'Todos' ? 'Todos os anúncios' : a}</option>)}
                </select>
                {units.length > 2 && (
                  <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)}
                    title="Filtrar por unidade"
                    className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[12px] font-bold text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                    {units.map(u => <option key={u} value={u}>{u === 'Todas' ? 'Todas as unidades' : u}</option>)}
                  </select>
                )}
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                  <Search size={13} className="text-slate-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nome, telefone, anúncio…"
                    className="bg-transparent text-[12px] font-bold text-slate-700 focus:outline-none w-[200px]" />
                </div>
              </div>
            </div>

            {/* Chips de STATUS com contagem */}
            <div className="flex items-center gap-1.5 px-6 py-3 border-b border-slate-100 bg-slate-50/40 flex-wrap">
              {([['todos', 'Todos'], ['open', 'Abertas'], ['pending', 'Pendentes'], ['snoozed', 'Adiadas'], ['resolved', 'Resolvidas']] as const).map(([st, lbl]) => {
                const active = statusFilter === st;
                const n = statusCounts[st] ?? 0;
                if (st !== 'todos' && n === 0 && !active) return null;
                return (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-black uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      active ? 'bg-primary text-white border-primary shadow-sm' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                    }`}
                  >
                    {lbl}
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
                  </button>
                );
              })}
            </div>

            {report?.truncated && (
              <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-100 flex items-center gap-2 text-[12px] font-bold text-amber-700">
                <AlertTriangle size={13} /> Relatório do Fluxo truncado em 2.000 — o dash acumula as entregas diárias por conversa. Totais oficiais completos.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-wider border-b border-slate-100">
                    <th className="px-6 py-3">Lead</th>
                    <th className="px-4 py-3">Telefone</th>
                    <th className="px-4 py-3">Anúncio</th>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Unidade</th>
                    <th className="px-4 py-3">Criado</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-400 font-bold">Carregando…</td></tr>
                  ) : filteredLeads.length === 0 ? (
                    <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-400 font-bold">Nenhum lead encontrado</td></tr>
                  ) : filteredLeads.map(l => {
                    const nome = showClientData ? (l.contact?.name || '—') : '•••';
                    const iniciais = showClientData
                      ? (l.contact?.name ?? '?').split(/\s+/).slice(0, 2).map(p => p.charAt(0)).join('').toUpperCase() || '?'
                      : '•';
                    const corAvatar = ['bg-emerald-100 text-emerald-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700'][(l.conversation_id ?? 0) % 5];
                    return (
                    <tr key={l.conversation_id} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-[11px] font-black ${corAvatar}`}>{iniciais}</span>
                          <div className="min-w-0">
                            <p className="font-black text-slate-800 truncate max-w-[220px]">{nome}</p>
                            {l.display_id != null && <p className="text-[10px] font-bold text-slate-400">conversa #{l.display_id}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-500 tabular-nums">
                        {showClientData
                          ? (l.contact?.phone_number
                              ? <a href={`https://wa.me/${l.contact.phone_number.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-bold hover:bg-emerald-100 transition-colors">
                                  {l.contact.phone_number}
                                </a>
                              : /insta/i.test(l.inbox ?? '')
                                ? <span className="inline-flex px-2.5 py-1 rounded-lg bg-fuchsia-50 text-fuchsia-700 text-[11px] font-bold">Instagram</span>
                                : <span className="inline-flex px-2.5 py-1 rounded-lg bg-slate-50 text-slate-400 text-[11px] font-bold">sem telefone</span>)
                          : '•••'}
                      </td>
                      <td className="px-4 py-3">
                        {l.ad_label
                          ? <span className="inline-flex px-2 py-0.5 rounded-md bg-primary/5 text-primary text-[11px] font-bold">{l.ad_label}</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-500">{l.team || '—'}</td>
                      <td className="px-4 py-3 font-semibold text-slate-500">{l.unit || '—'}</td>
                      <td className="px-4 py-3 font-semibold text-slate-500 tabular-nums">{fmtDT(l.created_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full border text-[10px] font-black uppercase tracking-wider ${STATUS_BADGE[l.status ?? ''] ?? 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                          {STATUS_LABEL[l.status ?? ''] ?? (l.status || '—')}
                        </span>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
