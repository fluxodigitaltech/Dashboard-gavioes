import { useState, useEffect, useCallback, useMemo } from 'react';
import { MonthFilterBar } from '../components/MonthCalendarPopover';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, Users, Zap, BarChart2, RefreshCw, X } from 'lucide-react';
import {
  formatNumber,
  fetchAvgTicket,
  fetchReceivables,
  type BranchStats,
  type TicketData,
  type ReceivablesData,
  type ReceivablesUnitData,
} from '../services/evoApi';
import type { DashboardData } from '../App';
import { StatsCard } from '../components/StatsCard';
import { DollarSign } from 'lucide-react';
import { fmtComparativosLines } from '../lib/format';
import { fetchReceivablesHistoryAggregate, aggregateHistoryByMonth } from '../services/nocodbApi';
import { useEvoHistory } from '../hooks/useEvoHistory';

interface Props {
  data: DashboardData | null;
  isLoading: boolean;
}

function clearMembershipCache() {
  localStorage.removeItem('gb_ticket_data');
  localStorage.removeItem('gb_memberships_per_branch');
}

export function FinanceiroScreen({ data, isLoading }: Props) {
  const [ticketData, setTicketData]             = useState<TicketData | null>(null);
  const [ticketLoading, setTicketLoading]       = useState(true);
  const [ticket, setTicket]                     = useState(180);
  const [ticketOverridden, setTicketOverridden] = useState(false);
  const [receivables, setReceivables]               = useState<ReceivablesData | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(true);
  const [receivablesError, setReceivablesError]     = useState<string | null>(null);
  const [showReceivablesModal, setShowReceivablesModal] = useState(false);

  // ─── Filtro de data (afeta receivables) ──────────────────────────────────
  // Default = mês corrente (1° dia → hoje). Quando user muda, refetch
  // de receivables com o range custom. Cards member-based (Ativos/
  // Faturamento Estimado/Receita em Risco) ignoram — são snapshot atual.
  const todayISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const firstOfMonthISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();
  const [dateFrom, setDateFrom] = useState(firstOfMonthISO);
  const [dateTo, setDateTo]     = useState(todayISO);
  const isDefaultRange = dateFrom === firstOfMonthISO && dateTo === todayISO;

  // ─── Mês selecionado (filtro padrão de calendário do sistema) ──────────────
  const curYM = todayISO.slice(0, 7);
  const selectedMonth = isDefaultRange ? curYM : dateTo.slice(0, 7);
  const isHistMode = selectedMonth < curYM; // mês passado → member-based vem do histórico
  const goToMonth = (ym: string) => {
    if (ym >= curYM) { setDateFrom(firstOfMonthISO); setDateTo(todayISO); return; }
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    setDateFrom(`${ym}-01`);
    setDateTo(`${ym}-${String(last).padStart(2, '0')}`);
  };

  // Histórico mensal (tabela Membros via /api/history) — snapshot + comparativos.
  const { rows: historyRows } = useEvoHistory();
  const oldestHistMonth = useMemo(() => {
    let min = '';
    for (const r of historyRows) {
      if (r.period_kind !== 'monthly') continue;
      if (!min || r.snapshot_month < min) min = r.snapshot_month;
    }
    return min || curYM;
  }, [historyRows, curYM]);

  // ─── Receivables histórico (NocoDB cache) ──────────────────────────────
  // Carrega snapshot do mês passado e mesmo mês ano passado pra comparativos
  // nos cards (Faturamento Real / Multa / Manutenção / Avulso). Sem isso
  // os cards mostram fallback "Histórico ainda não disponível".
  type ReceivablesAgg = {
    total_amount: number;
    total_received: number;
    multa_cancelamento: number;
    manutencao_anual: number;
    avulso: number;
    pagantes: number;
    lancamentos: number;
    hasData: boolean;
  };
  const [recPrev, setRecPrev]   = useState<ReceivablesAgg | null>(null);
  const [recYearAgo, setRecYearAgo] = useState<ReceivablesAgg | null>(null);
  const [recSel, setRecSel]     = useState<ReceivablesAgg | null>(null); // mês selecionado (modo histórico)

  const loadTickets = useCallback((forceRefresh = false) => {
    if (forceRefresh) clearMembershipCache();
    // Defer the loading flip so we don't trigger a synchronous cascade when
    // called from inside an effect (react-hooks/set-state-in-effect).
    queueMicrotask(() => setTicketLoading(true));
    fetchAvgTicket()
      .then(td => {
        setTicketData(td);
        // ticket inicial é calculado em useEffect próprio com base em
        // allowed_units (não usa td.avgTicket da rede — viewer vê só sua loja).
      })
      .catch(err => console.error('[Financeiro] fetchAvgTicket error:', err))
      .finally(() => setTicketLoading(false));
  }, []);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  // Atualiza o input "R$ /Membro" com a média APURADA dos planos visíveis ao
  // usuário (filtrado por allowed_units). Sem isso, viewer veria média da rede
  // como default — vazamento sutil. Só roda quando user não sobrescreveu manualmente.
  useEffect(() => {
    if (!ticketData || ticketOverridden) return;
    const allowed = new Set((data?.units ?? []).map(u => u.name));
    const values = ticketData.plans
      .filter(p => allowed.has(p.unitName) && p.value > 0)
      .map(p => p.value);
    const avg = values.length > 0
      ? Math.round(values.reduce((s, v) => s + v, 0) / values.length)
      : 180;
    queueMicrotask(() => setTicket(avg));
  }, [ticketData, data, ticketOverridden]);

  const loadReceivables = useCallback((from?: string, to?: string) => {
    queueMicrotask(() => {
      setReceivablesLoading(true);
      setReceivablesError(null);
    });
    fetchReceivables(from, to)
      .then(data => setReceivables(data))
      .catch(err => {
        console.error('[Financeiro] fetchReceivables error:', err);
        setReceivablesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReceivablesLoading(false));
  }, []);

  // Refetch receivables sempre que o range custom mudar.
  // Debounce 350ms pra não disparar enquanto user digita data.
  useEffect(() => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return;
    const timer = setTimeout(() => {
      // Se range é o default, chama sem args (mantém endpoint atual com TTL).
      // Se custom, passa range explícito.
      if (isDefaultRange) loadReceivables();
      else loadReceivables(dateFrom, dateTo);
    }, 350);
    return () => clearTimeout(timer);
  }, [dateFrom, dateTo, isDefaultRange, loadReceivables]);

  // Memo evita ref nova a cada render (useEffect depende dele).
  const allUnits: BranchStats[] = useMemo(() => data?.units ?? [], [data]);

  // ── Filtro por unidade (Todas | nome da unidade) ── (antes do efeito de
  // histórico: recPrev/recSel precisam respeitar a unidade selecionada)
  const [unitFilter, setUnitFilter] = useState<string>('Todas');
  const isAll = unitFilter === 'Todas';
  const units: BranchStats[] = isAll ? allUnits : allUnits.filter(u => u.name === unitFilter);

  // Carrega histórico de receivables (mes passado + mesmo mes ano passado)
  // Filtra por unidades visíveis (data.units já vem filtrado por matriz Página×Unidade)
  useEffect(() => {
    if (!data) return;
    // Âncora dos comparativos = mês do FILTRO (data final), não o mês corrente.
    // Filtrou maio → compara maio vs abril e vs maio do ano anterior.
    const [ry, rmRaw] = (dateTo || todayISO).slice(0, 7).split('-').map(Number);
    const rm = rmRaw - 1; // 0-based
    const prev = new Date(ry, rm - 1, 1);
    const year = new Date(ry - 1, rm, 1);
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // Respeita o filtro de unidade — sem isso, recSel/pagantes viriam da rede inteira.
    const allowed = isAll ? data.units.map(u => u.name) : [unitFilter];
    let cancelled = false;
    Promise.all([
      fetchReceivablesHistoryAggregate(monthKey(prev), allowed),
      fetchReceivablesHistoryAggregate(monthKey(year), allowed),
      fetchReceivablesHistoryAggregate((dateTo || todayISO).slice(0, 7), allowed),
    ]).then(([prevData, yearData, selData]) => {
      if (cancelled) return;
      setRecPrev(prevData);
      setRecYearAgo(yearData);
      setRecSel(selData);
    }).catch(err => console.error('[Financeiro] receivables história erro:', err));
    return () => { cancelled = true; };
  }, [data, dateTo, todayISO, isAll, unitFilter]);


  // ─── Snapshot do mês FILTRADO: mês passado → histórico (tabela Membros) ────
  const histByMonth = new Map(
    aggregateHistoryByMonth(historyRows, units.map(u => u.name)).map(m => [m.month, m]),
  );
  const histAgg = isHistMode ? (histByMonth.get(selectedMonth) ?? null) : null;
  // Unidades do escopo SEM histórico no mês selecionado (importação faltando) —
  // mostra aviso em vez de zeros silenciosos (ex.: Belenzinho mai/2026).
  const unitsSemHist = isHistMode
    ? units.map(u => u.name).filter(n =>
        !historyRows.some(r => r.period_kind === 'monthly' && r.snapshot_month === selectedMonth && String(r.branch_name) === n))
    : [];
  const histMissing = isHistMode && !histAgg;

  const activeMembers   = isHistMode ? (histAgg?.active_members ?? 0) : units.reduce((s, u) => s + (u.activeMembers ?? 0), 0);
  const inactiveMembers = isHistMode ? (histAgg?.inadimplentes ?? 0) : units.reduce((s, u) => s + (u.inadimplentesMembers ?? 0), 0);

  // ── Faturamento via SCRAPER (Gaviões, Cobranças › Recorrência) ──────────────
  // REAL = Pago (totalPago) · ESTIMADO = Total (somatoria.total).
  const isScraperFat   = units.some(u => u.faturamentoPagoMes != null);
  const scraperPagoMes = units.reduce((s, u) => s + (u.faturamentoPagoMes ?? 0), 0);
  const scraperTotMes  = units.reduce((s, u) => s + (u.faturamentoTotalMes ?? 0), 0);

  // ── Faturamento estimado (scraper: Total da Recorrência; senão ValorContrato adimplentes) ──
  const faturamentoEstimado = isHistMode ? (histAgg?.faturamento_adimplentes ?? 0)
    : (isScraperFat ? scraperTotMes : units.reduce((s, u) => s + (u.faturamentoAdimplentes ?? 0), 0));
  const riskRevenue         = isHistMode ? (histAgg?.faturamento_inadimplentes ?? 0) : units.reduce((s, u) => s + (u.faturamentoInadimplentes ?? 0), 0);
  const adimplentes         = isHistMode ? (histAgg?.adimplentes ?? 0) : units.reduce((s, u) => s + (u.adimplentesMembers ?? 0), 0);

  // ── Comparativos ancorados no mês SELECIONADO, direto do histórico real ──
  // Mesma fonte e agregação do Painel — números 100% consistentes entre abas.
  const shiftSel = (delta: number) => {
    const [y, m] = selectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const histPrevAgg = histByMonth.get(shiftSel(-1)) ?? null;
  const hist1yAgg   = histByMonth.get(shiftSel(-12)) ?? null;
  const activeMembersPrev = histPrevAgg?.active_members ?? 0;
  const fatAdimpPrev      = histPrevAgg?.faturamento_adimplentes ?? 0;
  const fatInadPrev       = histPrevAgg?.faturamento_inadimplentes ?? 0;
  const hasPrev           = !!histPrevAgg && activeMembersPrev > 0;
  const activeMembers1y   = hist1yAgg?.active_members ?? 0;
  const fatAdimp1y        = hist1yAgg?.faturamento_adimplentes ?? 0;
  const fatInad1y         = hist1yAgg?.faturamento_inadimplentes ?? 0;
  const has1y             = !!hist1yAgg && activeMembers1y > 0;

  // ── Receivables filtrados pela unidade selecionada ──
  // CRÍTICO: receivables vem completo do EVO. Filtramos por allowed_units do
  // user (data.units → allUnits). Sem esse filtro, viewer/gerente com 1 unidade
  // veria Faturamento Real da rede inteira (vazamento entre lojas).
  const allowedUnitNames = new Set(allUnits.map(u => u.name));
  const filteredPerUnit: ReceivablesUnitData[] =
    receivables
      ? (isAll
          ? receivables.perUnit.filter(p => allowedUnitNames.has(p.unitName))
          : receivables.perUnit.filter(p => p.unitName === unitFilter))
      : [];
  const recTotalAmount  = filteredPerUnit.reduce((s, u) => s + u.amount,            0);
  const recTotalLanc    = filteredPerUnit.reduce((s, u) => s + u.rows,              0);
  const recMulta        = filteredPerUnit.reduce((s, u) => s + u.multaCancelamento, 0);
  const recAvulso       = filteredPerUnit.reduce((s, u) => s + u.avulso,            0);
  const recManutencao   = filteredPerUnit.reduce((s, u) => s + u.manutencaoAnual,   0);

  // ── Cruzamento member × receivables (filtrado se unidade ≠ Todas) ──
  // Regra (definida pelo user 18/05/2026): IdCliente do member ∩ IdCliente do
  // receivable LANÇADO no mês. Mostra quantos ativos foram FATURADOS no mês
  // (independente de já ter pago ou não). O Set deduplica IDs duplicados.
  const idsAtivos = new Set<number>([
    ...units.flatMap(u => u.idsAdimplentes   ?? []),
    ...units.flatMap(u => u.idsInadimplentes ?? []),
  ]);
  // No modo 'Todas', agrega idsLancados APENAS das unidades permitidas
  // (sem o filtro, viewer/gerente cruzaria com receivables de outras lojas).
  const idsRecebivelSet = new Set<number>(
    isAll
      ? allUnits.flatMap(u => receivables?.idsLancadosPorUnidade?.[u.name] ?? [])
      : (receivables?.idsLancadosPorUnidade?.[unitFilter] ?? [])
  );
  let qtdAtivosQuePagaram = 0;
  idsAtivos.forEach(id => { if (idsRecebivelSet.has(id)) qtdAtivosQuePagaram++; });
  // Mês passado filtrado: cruzamento ao vivo não existe → pagantes distintos
  // do histórico de Recebimentos do mês selecionado.
  if (isHistMode) qtdAtivosQuePagaram = recSel?.pagantes ?? 0;
  const basePagos = isHistMode ? activeMembers : idsAtivos.size;
  const pctPagos = basePagos > 0 ? (qtdAtivosQuePagaram / basePagos) * 100 : 0;
  const pagosLines = fmtComparativosLines(
    qtdAtivosQuePagaram,
    recPrev?.pagantes ?? 0,
    recYearAgo?.pagantes ?? 0,
    (recPrev?.pagantes ?? 0) > 0,
    (recYearAgo?.pagantes ?? 0) > 0,
  );

  // ── Cor dinâmica para o card "Já Pagaram" (verde / âmbar / rosa) ──
  const pagosColorIcon: 'accent' | 'amber' | 'rose' =
    pctPagos >= 80 ? 'accent' : pctPagos >= 50 ? 'amber' : 'rose';
  const pagosColorText =
    pctPagos >= 80 ? 'text-emerald-600' : pctPagos >= 50 ? 'text-amber-600' : 'text-rose-600';

  // Total bruto de planos (pra mensagem de empty state se nenhum tiver preço).
  // Filtrado pelas allowed_units do user — viewer não vê quantos planos as
  // outras lojas têm.
  const totalRawPlans = (ticketData?.perBranch ?? [])
    .filter(b => allowedUnitNames.has(b.unitName))
    .reduce((s, b) => s + b.plans.length, 0);

  // ── Agrupa planos por NOME (cross-unidades) — respeita o filtro de unidade ──
  // Cada grupo: nome do plano, preço médio, lista de unidades que oferecem.
  // Quando filtro ≠ Todas, considera só os planos da unidade selecionada.
  // Quando filtro = Todas, ainda filtra pelas allowed_units (segurança).
  const planosFiltrados = (ticketData?.plans ?? []).filter(p =>
    allowedUnitNames.has(p.unitName) && (isAll || p.unitName === unitFilter)
  );
  // Stats agregadas dos planos visíveis ao usuário (substitui ticketData.* na UI).
  const planosVisiveisValues = planosFiltrados.map(p => p.value).filter(v => v > 0);
  const visibleTotalPlans = planosVisiveisValues.length;
  const visibleMinTicket  = planosVisiveisValues.length > 0 ? Math.min(...planosVisiveisValues) : 0;
  const visibleMaxTicket  = planosVisiveisValues.length > 0 ? Math.max(...planosVisiveisValues) : 0;
  const visibleAvgTicket  = planosVisiveisValues.length > 0
    ? Math.round(planosVisiveisValues.reduce((s, v) => s + v, 0) / planosVisiveisValues.length)
    : 0;
  type PlanGroup = { name: string; avgValue: number; minValue: number; maxValue: number; unitCount: number; units: string[]; pricedCount: number };
  const planGroupsMap = new Map<string, { values: number[]; units: Set<string> }>();
  for (const p of planosFiltrados) {
    const key = (p.name ?? 'Sem nome').trim();
    if (!planGroupsMap.has(key)) planGroupsMap.set(key, { values: [], units: new Set() });
    const g = planGroupsMap.get(key)!;
    if (p.value > 0) g.values.push(p.value);
    g.units.add(p.unitName);
  }
  const planGroups: PlanGroup[] = Array.from(planGroupsMap.entries()).map(([name, g]) => ({
    name,
    avgValue: g.values.length > 0 ? g.values.reduce((s, v) => s + v, 0) / g.values.length : 0,
    minValue: g.values.length > 0 ? Math.min(...g.values) : 0,
    maxValue: g.values.length > 0 ? Math.max(...g.values) : 0,
    unitCount: g.units.size,
    units: Array.from(g.units),
    pricedCount: g.values.length,
  })).sort((a, b) => b.avgValue - a.avgValue);

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* ── Header ── */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="mb-12"
      >
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">
          Visão Financeira
        </span>
        <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
          Análise <span className="text-accent">Financeira</span>
        </h1>
        <p className="text-slate-400 text-[16px] font-semibold max-w-xl">
          Receita calculada com base nos planos e membros reais da API W12 EVO.
        </p>
      </motion.div>

      {/* ── Ticket configurator ── */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="mb-10 p-8 bg-[#fdefea] border border-accent/20 rounded-[2.5rem] flex flex-col sm:flex-row items-start sm:items-center gap-6 shadow-sm"
      >
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-accent rounded-2xl flex items-center justify-center shadow-lg shadow-accent/20">
            {ticketLoading
              ? <RefreshCw size={22} className="text-primary animate-spin" strokeWidth={3} />
              : <span className="text-primary font-black text-[17px]">R$</span>
            }
          </div>
          <div>
            <p className="text-[12px] font-black text-primary uppercase tracking-widest mb-1">
              Ticket Médio Real — EVO
            </p>
            {ticketData && !ticketLoading ? (
              <p className="text-[13px] text-slate-500 font-semibold">
                <span className="text-primary font-black">{visibleTotalPlans}</span> planos com preço ·
                {' '}Min R$ {visibleMinTicket.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ·
                {' '}Max R$ {visibleMaxTicket.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            ) : (
              <p className="text-[13px] text-slate-400 font-semibold">Carregando planos da EVO…</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 ml-auto bg-white p-3 rounded-2xl border border-slate-100 shadow-inner">
          <span className="text-primary font-black text-[18px] ml-2">R$</span>
          <input
            type="number"
            value={ticket}
            onChange={e => { setTicket(Math.max(1, Number(e.target.value))); setTicketOverridden(true); }}
            className="w-28 text-center py-2 px-3 bg-slate-50 border-none rounded-xl text-[18px] font-black text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 transition-all font-mono"
          />
          <span className="text-slate-400 text-[12px] font-black uppercase tracking-wider mr-2">/ Membro</span>
        </div>
        {ticketOverridden && ticketData && (
          <button
            onClick={() => { setTicket(visibleAvgTicket); setTicketOverridden(false); }}
            className="text-[11px] font-black text-accent underline underline-offset-2 whitespace-nowrap"
          >
            Restaurar média EVO
          </button>
        )}
      </motion.div>

      {/* ── Filtros: unidade + data ── */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        {/* Filtro por unidade — esconde se user tem só 1 unidade */}
        {allUnits.length > 1 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider mr-2">Filtrar:</span>
            {(['Todas', ...allUnits.map(u => u.name)]).map(name => (
              <button
                key={name}
                onClick={() => setUnitFilter(name)}
                className={`px-4 py-2 rounded-full text-[12px] font-black transition-all ${
                  unitFilter === name
                    ? 'bg-primary text-white shadow-[0_4px_12px_rgba(15,60,35,0.2)]'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        ) : allUnits.length === 1 ? (
          <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
            Unidade: {allUnits[0].name}
          </span>
        ) : <div />}

        {/* Filtro de mês — calendário padrão do sistema */}
        <MonthFilterBar
          selectedMonth={selectedMonth}
          isCurrent={isDefaultRange}
          minMonth={oldestHistMonth}
          onPick={goToMonth}
          onReset={() => { setDateFrom(firstOfMonthISO); setDateTo(todayISO); }}
          legend="Verde = mês atual (ao vivo) · Cinza = sem histórico"
        />
      </div>

      {/* ── KPIs principais — Ativos / Faturamento Estimado (member) / Faturamento Real (receivable) / Já Pagaram ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
        {(() => {
          const lines = fmtComparativosLines(activeMembers, activeMembersPrev, activeMembers1y, hasPrev, has1y);
          return (
            <StatsCard
              title="Ativos"
              value={(isLoading || histMissing) ? '—' : formatNumber(activeMembers)}
              comparison={histMissing
                ? '⚠ Sem histórico deste mês — importe os Membros'
                : `${formatNumber(adimplentes)} adimp · ${formatNumber(inactiveMembers)} inadimp${unitsSemHist.length > 0 ? ` · ⚠ sem: ${unitsSemHist.join(', ')}` : ''}`}
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={Users}
              color="blue"
              valueColorClass="text-blue-600"
              isLoading={isLoading}
            />
          );
        })()}
        {(() => {
          const lines = fmtComparativosLines(faturamentoEstimado, fatAdimpPrev, fatAdimp1y, hasPrev && fatAdimpPrev > 0, has1y && fatAdimp1y > 0);
          return (
            <StatsCard
              title="Faturamento Estimado"
              value={(isLoading || histMissing) ? '—' : `R$ ${faturamentoEstimado.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              comparison={histMissing ? '⚠ Sem histórico deste mês — importe os Membros' : (isScraperFat ? 'Total do mês · Cobranças › Recorrência' : 'ValorContrato dos adimplentes (member)')}
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={TrendingUp}
              color="accent"
              valueColorClass="text-accent"
              isLoading={isLoading}
            />
          );
        })()}
        {(() => {
          // Mês passado filtrado: valor REAL vem do histórico de Recebimentos
          // (instantâneo) — sem esperar o Excel lento do EVO. Mês atual: ao vivo.
          // Scraper (Gaviões): REAL = Pago da Recorrência. Senão: receivables histórico.
          const fatRealValor = isHistMode ? (recSel?.total_amount ?? 0)
            : (isScraperFat ? scraperPagoMes : recTotalAmount);
          const fatRealBusy  = isHistMode ? !recSel : (isScraperFat ? false : receivablesLoading);
          const recLines = fmtComparativosLines(
            fatRealValor,
            recPrev?.total_amount ?? 0,
            recYearAgo?.total_amount ?? 0,
            !!recPrev?.hasData,
            !!recYearAgo?.hasData
          );
          return (
            <div className="cursor-pointer" onClick={() => receivables && setShowReceivablesModal(true)}>
              <StatsCard
                title="Faturamento Real Mês"
                value={fatRealBusy ? '—' : isHistMode
                  ? `R$ ${fatRealValor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : (isScraperFat || receivables ? `R$ ${fatRealValor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—')}
                comparison={fatRealBusy ? 'Carregando…' : isHistMode
                  ? `${recSel?.lancamentos ?? 0} lançamentos · histórico do mês`
                  : (isScraperFat ? 'Pago no mês · Cobranças › Recorrência'
                    : (receivables ? `${recTotalLanc} lançamentos · ver por unidade →` : receivablesError ?? '—'))}
                subComparison={recLines.mes}
                subComparison2={recLines.ano}
                icon={DollarSign}
                color="primary"
                valueColorClass="text-primary"
                isLoading={fatRealBusy}
              />
            </div>
          );
        })()}
        <StatsCard
          title="Já Pagaram"
          value={(isHistMode ? !recSel : (isLoading || receivablesLoading)) ? '—' : `${formatNumber(qtdAtivosQuePagaram)}${basePagos > 0 ? ` (${pctPagos.toFixed(2).replace('.', ',')}%)` : ''}`}
          comparison={(isHistMode ? !recSel : (isLoading || receivablesLoading)) ? '…' : basePagos > 0
            ? `de ${formatNumber(basePagos)} ativos · ${isHistMode ? 'pagantes distintos no mês (histórico)' : 'IdCliente member ∩ receivable'}`
            : '⚠ pagantes do histórico · sem Membros do mês pra calcular %'}
          subComparison={pagosLines.mes ?? 'Sem comparativo histórico ainda'}
          subComparison2={pagosLines.ano}
          icon={TrendingUp}
          color={pagosColorIcon}
          valueColorClass={pagosColorText}
          isLoading={isHistMode ? !recSel : (isLoading || receivablesLoading)}
        />
      </div>

      {/* ── Receita em Risco (KPI secundário) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
        {(() => {
          const lines = fmtComparativosLines(riskRevenue, fatInadPrev, fatInad1y, hasPrev && fatInadPrev > 0, has1y && fatInad1y > 0);
          return (
            <StatsCard
              title="Receita em Risco"
              value={(isLoading || histMissing) ? '—' : `R$ ${riskRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              comparison={histMissing ? '⚠ Sem histórico deste mês' : `${formatNumber(inactiveMembers)} inadimplentes · ValorContrato em atraso`}
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={Zap}
              color="amber"
              valueColorClass="text-amber-600"
              isLoading={isLoading}
            />
          );
        })()}
        {(() => {
          const lines = fmtComparativosLines(
            recMulta,
            recPrev?.multa_cancelamento ?? 0,
            recYearAgo?.multa_cancelamento ?? 0,
            !!recPrev?.hasData,
            !!recYearAgo?.hasData
          );
          return (
            <StatsCard
              title="Multa de Cancelamento"
              value={receivablesLoading ? '—' : receivables ? `R$ ${recMulta.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              comparison="Soma do tipo 'Multa de Cancelamento' (receivable)"
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={Zap}
              color="rose"
              valueColorClass="text-rose-600"
              isLoading={receivablesLoading}
            />
          );
        })()}
        {(() => {
          const lines = fmtComparativosLines(
            recManutencao,
            recPrev?.manutencao_anual ?? 0,
            recYearAgo?.manutencao_anual ?? 0,
            !!recPrev?.hasData,
            !!recYearAgo?.hasData
          );
          return (
            <StatsCard
              title="Manutenção Anual"
              value={receivablesLoading ? '—' : receivables ? `R$ ${recManutencao.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              comparison="Soma da coluna Valor onde Descrição = 'Manutenção Anual'"
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={DollarSign}
              color="primary"
              valueColorClass="text-primary"
              isLoading={receivablesLoading}
            />
          );
        })()}
        {(() => {
          const lines = fmtComparativosLines(
            recAvulso,
            recPrev?.avulso ?? 0,
            recYearAgo?.avulso ?? 0,
            !!recPrev?.hasData,
            !!recYearAgo?.hasData
          );
          return (
            <StatsCard
              title="Avulso"
              value={receivablesLoading ? '—' : receivables ? `R$ ${recAvulso.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              comparison="Soma do tipo 'Avulso' (receivable)"
              subComparison={lines.mes}
              subComparison2={lines.ano}
              icon={DollarSign}
              color="secondary"
              valueColorClass="text-indigo-600"
              isLoading={receivablesLoading}
            />
          );
        })()}
      </div>

      {/* ── Planos por Tipo — agrupa por nome do plano, reage ao filtro de unidade ── */}
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        whileInView={{ y: 0, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="mb-16"
      >
        <div className="flex items-center justify-between mb-8 border-l-[6px] border-l-accent pl-5">
          <div>
            <h2 className="text-[1.8rem] font-black text-[#1E293B] tracking-tight">
              Planos por Tipo
            </h2>
            <p className="text-slate-400 text-[13px] font-semibold mt-1">
              {ticketLoading
                ? 'Carregando planos da EVO…'
                : planGroups.length > 0
                  ? `${planGroups.length} ${planGroups.length === 1 ? 'tipo de plano' : 'tipos de plano'}${isAll ? '' : ` em ${unitFilter}`} · ticket médio R$ ${visibleAvgTicket.toLocaleString('pt-BR')}`
                  : 'Nenhum plano encontrado'
              }
            </p>
          </div>
          <button
            onClick={() => loadTickets(true)}
            disabled={ticketLoading}
            className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-100 rounded-2xl text-[11px] font-black text-slate-500 uppercase tracking-widest hover:bg-primary hover:text-white transition-all disabled:opacity-40 shadow-sm"
          >
            <RefreshCw size={13} className={ticketLoading ? 'animate-spin' : ''} />
            {ticketLoading ? 'Carregando…' : 'Forçar Atualização'}
          </button>
        </div>

        {ticketLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-32 rounded-[1.8rem] bg-slate-100 animate-pulse" />
            ))}
          </div>
        )}

        {!ticketLoading && planGroups.length === 0 && (
          <div className="py-16 text-center bg-white rounded-[2.5rem] border border-slate-100">
            <BarChart2 size={36} className="mx-auto text-slate-200 mb-4" />
            <p className="text-slate-400 font-bold">Nenhum plano encontrado{!isAll ? ` em ${unitFilter}` : ''}</p>
            <p className="text-slate-300 text-[13px] mt-2">
              {totalRawPlans > 0
                ? `${totalRawPlans} planos brutos · talvez sem preço cadastrado`
                : 'Verifique o console — clique em "Forçar Atualização"'}
            </p>
          </div>
        )}

        {!ticketLoading && planGroups.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {planGroups.map(g => (
              <div
                key={g.name}
                className="bg-white rounded-[1.8rem] border border-slate-100 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_30px_rgba(0,0,0,0.05)] hover:border-accent/30 transition-all"
              >
                <p className="font-black text-[#0F172A] text-[15px] leading-tight mb-3 line-clamp-2 min-h-[2.5rem]">
                  {g.name}
                </p>

                {g.avgValue > 0 ? (
                  <p className="text-[1.6rem] font-black text-primary tracking-tighter leading-none">
                    R$ {g.avgValue.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </p>
                ) : (
                  <p className="text-[1.2rem] font-black text-slate-300 tracking-tighter leading-none">
                    Sem preço
                  </p>
                )}

                {g.minValue !== g.maxValue && g.avgValue > 0 && (
                  <p className="text-[11px] font-bold text-slate-400 mt-1.5">
                    R$ {g.minValue.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} – R$ {g.maxValue.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </p>
                )}

                <div className="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                    {isAll
                      ? `${g.unitCount} ${g.unitCount === 1 ? 'unidade' : 'unidades'}`
                      : unitFilter
                    }
                  </span>
                  {g.pricedCount > 0 && (
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                      {g.pricedCount} c/ preço
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>

      {/* ── Faturamento por Unidade — vem do /receivables/summary-excel, ordenado desc ── */}
      {(receivablesLoading || (receivables && filteredPerUnit.length > 0)) && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          whileInView={{ y: 0, opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-16"
        >
          <div className="flex items-center gap-4 mb-10 border-l-[6px] border-l-primary pl-5">
            <h2 className="text-[1.8rem] font-black text-[#1E293B] tracking-tight">
              Faturamento por Unidade
            </h2>
          </div>

          <div className="bg-white rounded-[3rem] border border-slate-100 overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.03)]">
            <div className="p-10 pb-4">
              {receivablesLoading ? (
                <div className="space-y-6">
                  {[1,2,3,4,5].map(i => (
                    <div key={i} className="animate-pulse">
                      <div className="flex items-center justify-between mb-3">
                        <div className="h-4 bg-slate-100 rounded w-48" />
                        <div className="h-4 bg-slate-100 rounded w-24" />
                      </div>
                      <div className="h-3.5 bg-slate-100 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  {(() => {
                    const maxAmount = receivables!.perUnit[0]?.amount ?? 1;
                    return receivables!.perUnit.map(pu => {
                      const branch = units.find(u => u.name === pu.unitName);
                      const ativos = branch?.activeMembers ?? 0;
                      const pct    = maxAmount > 0 ? Math.round((pu.amount / maxAmount) * 100) : 0;

                      // Cruzamento member×receivables POR UNIDADE
                      // Regra: IdCliente do member que aparece em qualquer linha do receivable da unidade = pagou (Set deduplica)
                      const idsAtivosUnidade = new Set<number>([
                        ...(branch?.idsAdimplentes   ?? []),
                        ...(branch?.idsInadimplentes ?? []),
                      ]);
                      const idsRecebivelUnidade = new Set<number>(receivables!.idsLancadosPorUnidade?.[pu.unitName] ?? []);
                      let pagantes = 0;
                      idsAtivosUnidade.forEach(id => { if (idsRecebivelUnidade.has(id)) pagantes++; });
                      const pctPagantes = idsAtivosUnidade.size > 0 ? (pagantes / idsAtivosUnidade.size) * 100 : 0;

                      return (
                        <div key={pu.unitName} className="group">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-black text-[#0F172A] text-[15px] group-hover:text-primary transition-colors">
                                {pu.unitName}
                              </span>
                              <span className="text-[12px] font-bold text-slate-400">
                                {ativos.toLocaleString('pt-BR')} ativos · {pu.rows} lançamentos
                              </span>
                              <span
                                className={`text-[11px] font-black px-2 py-0.5 rounded-full ${
                                  pctPagantes >= 80 ? 'bg-emerald-50 text-emerald-700'
                                  : pctPagantes >= 50 ? 'bg-amber-50 text-amber-700'
                                  : 'bg-red-50 text-red-600'
                                }`}
                                title={`${pagantes} de ${idsAtivosUnidade.size} ativos têm IdCliente no receivable`}
                              >
                                {pagantes.toLocaleString('pt-BR')} pagaram ({pctPagantes.toFixed(2).replace('.', ',')}%)
                              </span>
                            </div>
                            <span className="font-black text-primary text-[15px]">
                              R$ {pu.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="h-3.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                            <motion.div
                              initial={{ width: 0 }}
                              whileInView={{ width: `${pct}%` }}
                              viewport={{ once: true }}
                              transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                              className="h-full rounded-full bg-gradient-to-r from-primary via-primary to-accent"
                            />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>

            <div className="p-10 pt-8 border-t border-slate-100 mt-8 bg-[#fafafa] flex flex-col sm:flex-row items-center justify-between gap-8">
              <div className="flex gap-12">
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Faturamento Total Mês</p>
                  <p className="text-[2.2rem] font-black text-primary tracking-tighter leading-none">
                    R$ {(receivables?.totalAmount ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Período</p>
                  <p className="text-[1rem] font-black text-accent tracking-tight leading-none mt-2">
                    {receivables?.period ?? '—'}
                  </p>
                </div>
              </div>
              <div className="px-6 py-3 bg-white border border-slate-100 rounded-2xl shadow-sm italic text-[12px] text-slate-400 font-medium">
                * Soma da coluna Valor da planilha de recebíveis da W12
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── Disclaimer ── */}
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="p-8 bg-amber-50/50 border border-amber-100 rounded-[2.5rem] flex gap-5 mb-8"
      >
        <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center shrink-0">
          <BarChart2 size={24} className="text-amber-600" strokeWidth={2.5} />
        </div>
        <div>
          <p className="text-[14px] font-black text-amber-800 mb-2 uppercase tracking-wide">
            Nota sobre os Dados
          </p>
          <p className="text-[14px] text-amber-700 font-semibold leading-relaxed">
            O ticket médio é calculado automaticamente a partir dos planos cadastrados na EVO.
            O MRR projetado multiplica membros <span className="underline decoration-amber-300">ativos</span> pelo ticket médio.
            Para inadimplência, conciliação bancária e receita efetivamente liquidada, é necessário habilitar
            os endpoints financeiros (<code className="bg-amber-100 px-1 rounded text-[12px]">/api/v1/financials</code>) no painel EVO.
          </p>
        </div>
      </motion.div>

      {/* ── Modal Recebimento por Unidade ── */}
      <AnimatePresence>
        {showReceivablesModal && receivables && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowReceivablesModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="px-10 pt-10 pb-6 border-b border-slate-100 flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <div className="w-9 h-9 bg-accent/10 rounded-xl flex items-center justify-center">
                      <DollarSign size={18} className="text-primary" />
                    </div>
                    <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Recebimento por Unidade</p>
                  </div>
                  <p className="text-[13px] text-slate-400 font-semibold mt-1">{receivables.period}</p>
                </div>
                <button
                  onClick={() => setShowReceivablesModal(false)}
                  className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors shrink-0"
                >
                  <X size={16} className="text-slate-500" />
                </button>
              </div>

              {/* Unit list — filtrado pelas allowed_units do user. Sem isso,
                  user com 1 unidade veria a lista da rede inteira aqui. */}
              <div className="px-10 py-6 space-y-3 max-h-[60vh] overflow-y-auto">
                {filteredPerUnit.length === 0 ? (
                  <p className="text-slate-400 text-center py-8 font-semibold">Nenhum dado por unidade disponível</p>
                ) : (
                  <>
                    {filteredPerUnit.map((u: ReceivablesUnitData, i: number) => {
                      const maxAmount = filteredPerUnit[0]?.amount ?? 1;
                      const pct = maxAmount > 0 ? Math.round((u.amount / maxAmount) * 100) : 0;
                      return (
                        <div key={u.unitName}>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center text-[9px] font-black text-primary shrink-0">
                                {u.unitName.slice(0, 2).toUpperCase()}
                              </span>
                              <span className="font-bold text-[14px] text-slate-700">{u.unitName}</span>
                              <span className="text-[11px] text-slate-400 font-semibold">{u.rows} lanç.</span>
                            </div>
                            <span className="font-black text-primary text-[14px] shrink-0 ml-4">
                              R$ {u.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: i * 0.05 }}
                              className={`h-full rounded-full ${i === 0 ? 'bg-gradient-to-r from-primary to-accent' : 'bg-slate-300'}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              {/* Footer total — usa total filtrado pela unidade selecionada */}
              <div className="px-10 py-6 bg-[#fafafa] border-t border-slate-100 flex items-center justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">{isAll ? 'Total Geral' : `Total ${unitFilter}`}</span>
                <span className="text-[1.6rem] font-black text-primary tracking-tighter">
                  R$ {recTotalAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
