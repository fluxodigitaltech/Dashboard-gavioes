import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { motion } from 'framer-motion';
import gbElement from '../assets/gb_element-2.png';
import {
  Users,
  TrendingUp,
  Download,
  Filter,
  RefreshCw,
  CheckCircle2,
  Maximize2,
  Sparkles,
  ShoppingBag,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Edit3,
  RotateCcw,
  Save,
  Activity,
  Database,
  X as XIcon,
} from 'lucide-react';
import { type DashboardData, type Page } from '../App';
import { scopeDashboardData } from '../lib/scopeData';
import { StatsCard } from '../components/StatsCard';
import { Pill } from '../components/ui/Pill';
import { useDashboardLayout } from '../hooks/useDashboardLayout';
import { useVendasRange } from '../hooks/useVendasRange';
import { UnitDetailsModal } from '../components/UnitDetailsModal';
import { PresentationMode } from '../components/PresentationMode';
import { VendasMesModal } from '../components/VendasMesModal';
import { EvasaoModal } from '../components/EvasaoModal';
import { InadimplentesModal } from '../components/InadimplentesModal';
import { type CurrentMonthPoint, type UnitMonthValues } from '../components/NetworkTrendChart';
import { MonthFilterBar } from '../components/MonthCalendarPopover';
import { lazyWithRetry } from '../lib/lazyWithRetry';
import { type BranchStats, type ReceivablesData, fetchReceivables, filterReceivablesByUnits, type OccupationData, fetchOccupation } from '../services/evoApi';
import { HistoricalSeedModal } from '../components/HistoricalSeedModal';
import { useEvoHistory } from '../hooks/useEvoHistory';
import { isAdmin, canAccessPage, canSeeVendasValor, canSeeTaxaOcupacao, canDownloadPdf, canSeeEvasao, canSeeInadimplentes, canSeeVendasDetalhe, canSeeClienteNome, canSeeTendencia, canSeeTendenciaFaturamento, pdfIncludesFatEstimado, fetchKpis, type Kpi, fetchComercialRange, type ComercialDiarioRow, aggregateHistoryByMonth, type GbUser } from '../services/nocodbApi';
import { formatNumber, formatCompactBRL, formatBRL, compareToPrev, fmtComparativosLines } from '../lib/format';
import { generateReport } from '../services/pdfReport';

interface Props {
  data: DashboardData | null;
  isLoading: boolean;
  onNavigate: (page: Page) => void;
  // Usuário corrente (revalidado no load do App) — fonte das permissões/prefs
  // dos cards. Reativo: muda quando o admin altera os toggles e o user recarrega.
  currentUser: GbUser | null;
}

// ─── Configuração dos cards do Painel (pra reordenação/ocultação) ───────────
const PANEL_CARDS = [
  { id: 'ativos',         label: 'Ativos' },
  { id: 'adimplentes',    label: 'Adimplentes' },
  { id: 'faturamento',    label: 'Faturamento Estimado' },
  { id: 'vendas-qtd',     label: 'Vendas (Qtd)' },
  { id: 'vendas-valor',   label: 'Vendas (R$)' },
  { id: 'inadimplencia',  label: '% Inadimplência' },
  { id: 'evasao',         label: '% Evasão' },
  { id: 'conv-aula-exp',  label: 'Conversão Aula Exp.' },
  { id: 'taxa-ocupacao',  label: 'Taxa de Ocupação' },
] as const;
type PanelCardId = typeof PANEL_CARDS[number]['id'];
const ALL_PANEL_IDS: PanelCardId[] = PANEL_CARDS.map(c => c.id);

// Recharts é pesado (~vai pro chunk próprio). Lazy-load: o gráfico fica abaixo
// dos cards, então não precisa bloquear o primeiro paint do Painel.
const NetworkTrendChart = lazyWithRetry(() =>
  import('../components/NetworkTrendChart').then(m => ({ default: m.NetworkTrendChart })),
);

export function DashboardScreen({ data, isLoading, onNavigate, currentUser }: Props) {
  const [selectedUnit, setSelectedUnit] = useState<BranchStats | null>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  // Filtro de data customizado via hook — quando NÃO é o range default
  // (mês corrente), dispara refetch debounced só dos cards de Vendas.
  const {
    dateFrom, dateTo, setDateFrom, setDateTo,
    isDefaultRange, vendasRange, vendasRangeLoading,
    resetToDefault: resetDateRange,
  } = useVendasRange();
  // ─── Filtro de unidades — MULTI-seleção. [] = todas as unidades. ──────────
  const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
  const allUnitNames = useMemo(() => (data?.units ?? []).map(u => u.name), [data]);
  // Vazio OU seleção que cobre todas = "todas" (caminho dos totais agregados).
  const isAllUnits = selectedUnits.length === 0 || selectedUnits.length >= allUnitNames.length;
  // Nomes em escopo (pra somas, listas e PDF). 'todas' → todas as permitidas.
  const activeUnitNames = useMemo(() => (isAllUnits ? allUnitNames : selectedUnits), [isAllUnits, allUnitNames, selectedUnits]);
  const activeUnitSet = useMemo(() => new Set(activeUnitNames), [activeUnitNames]);
  // Alterna uma unidade. Se a seleção passar a cobrir todas, normaliza pra [] (=todas).
  const toggleUnit = (name: string) => setSelectedUnits(prev => {
    const next = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
    return next.length >= allUnitNames.length ? [] : next;
  });
  const [presentationMode, setPresentationMode] = useState(false);
  const [vendasModalOpen, setVendasModalOpen] = useState(false);
  const [evasaoModalOpen, setEvasaoModalOpen] = useState(false);
  const [inadimplentesModalOpen, setInadimplentesModalOpen] = useState(false);
  const [receivables, setReceivables] = useState<ReceivablesData | null>(null);

  // ─── Taxa de Ocupação (preview no card; detalhes na página /ocupacao) ───
  const [occupation, setOccupation] = useState<OccupationData | null>(null);
  // occupationLoading derivado de !occupation — evita um state extra e remove
  // o anti-pattern setState dentro de useEffect.
  // Modal de seed histórico (admin only — popula gb_evo_history no NocoDB)
  const [seedModalOpen, setSeedModalOpen] = useState(false);

  // ─── Metas (KPIs do NocoDB) ──────────────────────────────────────────────
  // Carrega metas configuradas pra exibir nos cards (Ativos/Vendas/
  // Adimplentes/Faturamento) com progresso vs meta. Período = mês corrente.
  const [kpis, setKpis] = useState<Kpi[]>([]);
  // Dados do mês corrente do gb_comercial_diario pra calcular Conversão Aula Experimental
  const [comercialMes, setComercialMes] = useState<ComercialDiarioRow[]>([]);
  const periodoAtual = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  // ─── Seletor de MÊS (substitui o range de datas livre, que confundia) ─────
  // Mês atual = dados ao vivo do EVO (range default). Mês passado = 1º→último
  // dia do mês: estoque via snapshot do histórico + Vendas ao vivo do período.
  const selectedMonth = isDefaultRange ? periodoAtual : dateTo.slice(0, 7);
  const goToMonth = useCallback((ym: string) => {
    if (ym >= periodoAtual) { resetDateRange(); return; } // mês atual (ou futuro) → ao vivo
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    setDateFrom(`${ym}-01`);
    setDateTo(`${ym}-${String(lastDay).padStart(2, '0')}`);
  }, [periodoAtual, resetDateRange, setDateFrom, setDateTo]);

  useEffect(() => {
    let cancelled = false;
    fetchKpis()
      .then(list => { if (!cancelled) setKpis(list); })
      .catch(err => console.error('[Dashboard] fetchKpis error:', err));
    return () => { cancelled = true; };
  }, []);

  // Comercial diário do mês corrente — pra calcular Conversão Aula Experimental
  useEffect(() => {
    let cancelled = false;
    const today = new Date();
    const fromISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const toISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    fetchComercialRange(fromISO, toISO)
      .then(list => { if (!cancelled) setComercialMes(list); })
      .catch(err => console.error('[Dashboard] fetchComercialRange error:', err));
    return () => { cancelled = true; };
  }, []);
  const refreshOccupation = useCallback((force = false) => {
    fetchOccupation(force)
      .then(o => setOccupation(o))
      .catch(err => console.error('[Dashboard] fetchOccupation error:', err));
  }, []);

  // ── Layout customizado dos cards (admin pode reordenar/esconder) ──
  const {
    cardOrder, hiddenCards, editLayoutMode, savingLayout,
    startEditLayout, cancelEditLayout, resetLayoutToDefault, saveLayout,
    moveCard, toggleHidden,
  } = useDashboardLayout<PanelCardId>('dashboard_layout', ALL_PANEL_IDS);

  // Permissões/prefs derivadas do currentUser (revalidado no load do App).
  // Reativo a [currentUser]: muda quando o admin altera os toggles e o user
  // recarrega a página — sem precisar de logout+login.
  const isAdminUser = useMemo(() => currentUser ? isAdmin(currentUser) : false, [currentUser]);
  // Granular: oculta cards do Painel de quem não tem acesso à página correspondente.
  // Ex: sem 'financeiro' → some o card "Faturamento Estimado".
  const canSeeFinanceiro = useMemo(() => currentUser ? canAccessPage(currentUser, 'financeiro') : true, [currentUser]);
  // Preferência por usuário: ocultar o card "Vendas (R$)" (vê só a quantidade).
  const canSeeVendasValorCard = useMemo(() => currentUser ? canSeeVendasValor(currentUser) : true, [currentUser]);
  // Card "Conversão Aula Exp." vem da página Comercial → some de quem não acessa.
  const canSeeComercial = useMemo(() => currentUser ? canAccessPage(currentUser, 'comercial') : true, [currentUser]);
  // Preferência por usuário: ocultar o card "Taxa de Ocupação" do Painel.
  // Default ligado (todo mundo vê) — admin desliga por usuário na tela de Usuários.
  const canSeeTaxaOcupacaoCard = useMemo(() => currentUser ? canSeeTaxaOcupacao(currentUser) : true, [currentUser]);
  // Preferência por usuário: liberar/bloquear o botão de baixar o relatório PDF.
  const canDownloadPdfBtn = useMemo(() => currentUser ? canDownloadPdf(currentUser) : true, [currentUser]);
  // Preferência por usuário: PODE CLICAR no card "% Evasão" pra abrir a lista de
  // cancelamentos (com dados de cliente). Desmarcado = vê o card, mas não abre nada.
  const canSeeEvasaoCard = useMemo(() => currentUser ? canSeeEvasao(currentUser) : true, [currentUser]);
  // PODE CLICAR no card "% Inadimplência" pra abrir a lista (nome/telefone/unidade).
  // Respeita o toggle "Inadimplentes"; nome/telefone ainda dependem de canSeeClienteNome.
  const canSeeInadimplentesVal = useMemo(() => currentUser ? canSeeInadimplentes(currentUser) : true, [currentUser]);
  // Preferência por usuário: PODE CLICAR nos cards de Vendas pra abrir a lista de
  // matrículas (com dados de cliente). Desmarcado = vê o card, mas não abre nada.
  const canSeeVendasDetalheVal = useMemo(() => currentUser ? canSeeVendasDetalhe(currentUser) : true, [currentUser]);
  // Preferência por usuário: esconder nome do cliente nas listas (matrículas, evasão).
  const showClienteNome = useMemo(() => currentUser ? canSeeClienteNome(currentUser) : true, [currentUser]);
  // Preferência por usuário: mostrar/esconder o gráfico "Evolução da Rede".
  const canSeeTendenciaVal = useMemo(() => currentUser ? canSeeTendencia(currentUser) : true, [currentUser]);
  // Aba "Faturamento" dentro do gráfico de tendência (cotistas podem ter isso desligado).
  const canSeeTendenciaFatVal = useMemo(() => currentUser ? canSeeTendenciaFaturamento(currentUser) : true, [currentUser]);

  // Receivables — cache 15min compartilhado com Financeiro/Unidades
  useEffect(() => {
    let cancelled = false;
    fetchReceivables()
      .then(r => { if (!cancelled) setReceivables(r); })
      .catch(err => console.error('[Dashboard] fetchReceivables error:', err));
    return () => { cancelled = true; };
  }, []);

  // Taxa de ocupação — fetch inicial; cache de 5min em localStorage
  useEffect(() => {
    refreshOccupation(false);
  }, [refreshOccupation]);

  // ── Cancelamentos do PERÍODO (tabela do NocoDB) — evasão de meses passados ──
  // A EVO só devolve cancelamento do mês corrente; pra um período passado lemos
  // da tabela de cancelamentos. Só busca quando há range custom (não o padrão).
  const [histCancel, setHistCancel] = useState<{ total: number; byUnit: Record<string, number>; ready: boolean }>({ total: 0, byUnit: {}, ready: false });
  useEffect(() => {
    if (isDefaultRange || !dateFrom || !dateTo) return;
    let cancelled = false;
    fetch(`/api/cancelamentos-range?from=${dateFrom}&to=${dateTo}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (cancelled || !j?.enabled) return;
        setHistCancel({ total: Number(j.total) || 0, byUnit: (j.byUnit ?? {}) as Record<string, number>, ready: true });
      })
      .catch(() => { /* indisponível → evasão histórica segue '—' */ });
    return () => { cancelled = true; };
  }, [dateFrom, dateTo, isDefaultRange]);

  // Filtered units based on selected store — memo evita recriar array a cada
  // render (e os reduces que dependem dele).
  const filteredUnits = useMemo(
    () => isAllUnits
      ? (data?.units ?? [])
      : (data?.units ?? []).filter(u => activeUnitSet.has(u.name)),
    [data, isAllUnits, activeUnitSet],
  );

  // Aggregated stats for filtered view
  const filteredActive   = useMemo(() => filteredUnits.reduce((s, u) => s + u.activeMembers, 0), [filteredUnits]);
  const filteredInactive = useMemo(() => filteredUnits.reduce((s, u) => s + u.inactiveMembers, 0), [filteredUnits]);

  // ─── Histórico mensal (gb_evo_history) → gráfico de tendência + sparklines ──
  const { rows: historyRows, loading: historyLoading, enabled: historyEnabled } = useEvoHistory();
  // Mês mais antigo disponível no histórico — limite inferior do seletor de mês.
  const oldestHistMonth = useMemo(() => {
    let min = '';
    for (const r of historyRows) {
      if (r.period_kind !== 'monthly') continue;
      if (!min || r.snapshot_month < min) min = r.snapshot_month;
    }
    return min || periodoAtual;
  }, [historyRows, periodoAtual]);
  // Unidades a incluir na série, respeitando o filtro de unidade do Painel.
  const includeUnits = useMemo(
    () => activeUnitNames,
    [activeUnitNames],
  );
  // Ponto do mês corrente (ao vivo) — anexado como última leitura das séries.
  const currentPoint = useMemo<CurrentMonthPoint | null>(() => {
    if (!data) return null;
    const sum = (pick: (u: BranchStats) => number) =>
      isAllUnits ? (data.units ?? []).reduce((s, u) => s + pick(u), 0) : filteredUnits.reduce((s, u) => s + pick(u), 0);
    return {
      month: periodoAtual,
      active_members: isAllUnits ? (data.totalActiveMembers ?? 0) : filteredActive,
      adimplentes: sum(u => u.adimplentesMembers ?? 0),
      inadimplentes: sum(u => u.inadimplentesMembers ?? 0),
      faturamento_adimplentes: sum(u => u.faturamentoAdimplentes ?? 0),
      vendas_qtd: sum(u => u.vendasMesQtd ?? 0),
      vendas_valor: sum(u => u.vendasMesValor ?? 0),
    };
  }, [data, filteredUnits, filteredActive, isAllUnits, periodoAtual]);

  // Mês corrente POR UNIDADE — alimenta o modo "Por unidade" do gráfico de evolução.
  const currentByUnit = useMemo<Record<string, UnitMonthValues> | undefined>(() => {
    if (!data) return undefined;
    const map: Record<string, UnitMonthValues> = {};
    for (const u of data.units ?? []) {
      map[u.name] = {
        active_members:          u.activeMembers ?? 0,
        adimplentes:             u.adimplentesMembers ?? 0,
        inadimplentes:           u.inadimplentesMembers ?? 0,
        faturamento_adimplentes: u.faturamentoAdimplentes ?? 0,
        vendas_qtd:              u.vendasMesQtd ?? 0,
        vendas_valor:            u.vendasMesValor ?? 0,
      };
    }
    return map;
  }, [data]);

  // Séries compactas (últimos ~8 meses) pra os sparklines dos cards.
  const sparkSeries = useMemo(() => {
    const months = aggregateHistoryByMonth(historyRows, includeUnits);
    if (currentPoint && !months.some(m => m.month === currentPoint.month)) {
      months.push({
        month: currentPoint.month,
        active_members: currentPoint.active_members,
        adimplentes: currentPoint.adimplentes,
        inadimplentes: currentPoint.inadimplentes,
        faturamento_adimplentes: currentPoint.faturamento_adimplentes,
        vendas_qtd: currentPoint.vendas_qtd,
        vendas_valor: currentPoint.vendas_valor,
      });
    }
    const tail = months.slice(-8);
    const take = (pick: (m: typeof tail[number]) => number) => tail.map(pick);
    return {
      enoughData: tail.length >= 2,
      ativos: take(m => m.active_members),
      adimplentes: take(m => m.adimplentes),
      faturamento: take(m => m.faturamento_adimplentes),
      vendasQtd: take(m => m.vendas_qtd),
      vendasValor: take(m => m.vendas_valor),
      inadimplencia: take(m => (m.active_members > 0 ? (m.inadimplentes / m.active_members) * 100 : 0)),
    };
  }, [historyRows, includeUnits, currentPoint]);
  const spark = (values: number[], color: string) =>
    sparkSeries.enoughData ? { values, color } : undefined;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 lg:py-10">

      {/* ── Branding Hero — sem container, logo direto na página ── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
        className="w-full mb-8 flex flex-col items-center"
      >
        {/* Logo real */}
        <img
          src={gbElement}
          alt="Gaviões"
          className="w-full max-w-[860px] h-auto object-contain select-none"
          draggable={false}
        />

        {/* Reflexo espelhado com máscara degradê — escondido em mobile pra não
            quebrar a proporção em telas estreitas (height fixo 56px). */}
        <div
          className="hidden sm:block w-full max-w-[860px] overflow-hidden pointer-events-none"
          style={{ height: 56, marginTop: -4 }}
          aria-hidden="true"
        >
          <img
            src={gbElement}
            alt=""
            aria-hidden
            className="w-full h-auto object-contain select-none"
            draggable={false}
            style={{
              transform: 'scaleY(-1)',
              transformOrigin: 'top',
              WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, transparent 100%)',
              maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, transparent 100%)',
            }}
          />
        </div>

      </motion.div>

      {/* ── Dashboard Header (functional) ── */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.15 }}
        className="mb-8"
      >
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-4">
          {/* Title block */}
          <div className="min-w-0">
            <h1 className="text-[1.75rem] sm:text-[2.2rem] xl:text-[2.8rem] font-black text-slate-900 leading-tight tracking-tighter whitespace-nowrap">
              Visão Geral
            </h1>
          </div>

          {/* Right side: date range + actions */}
          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
            <MonthFilterBar
              selectedMonth={selectedMonth}
              isCurrent={isDefaultRange}
              minMonth={oldestHistMonth}
              onPick={goToMonth}
              onReset={resetDateRange}
              legend="Verde = mês atual (ao vivo) · Cinza = sem histórico"
            />
            {isAdminUser && (
              <button
                onClick={() => setPresentationMode(true)}
                disabled={!data}
                title="Modo TV (apresentação fullscreen) — controle administrativo"
                className="hidden md:inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-slate-50 hover:border-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                <Maximize2 size={13} />
                <span>Modo TV</span>
              </button>
            )}
            {/* Edit layout controls — admin only */}
            {isAdminUser && !editLayoutMode && (
              <button
                onClick={startEditLayout}
                title="Editar layout do painel: reordenar e esconder cards"
                className="hidden md:inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700 transition-colors shadow-sm"
              >
                <Edit3 size={13} />
                <span>Editar Layout</span>
              </button>
            )}
            {/* Sincronização histórica — admin only */}
            {isAdminUser && !editLayoutMode && (
              <button
                onClick={() => setSeedModalOpen(true)}
                title="Sincronizar últimos 12 meses do EVO no NocoDB (cache compartilhado)"
                className="hidden md:inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors shadow-sm"
              >
                <Database size={13} />
                <span>Histórico</span>
              </button>
            )}
            {isAdminUser && editLayoutMode && (
              <div className="flex items-center gap-2">
                <button
                  onClick={resetLayoutToDefault}
                  disabled={savingLayout}
                  title="Voltar pro layout padrão"
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-slate-50 hover:text-slate-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  <span className="hidden sm:inline">Resetar</span>
                </button>
                <button
                  onClick={cancelEditLayout}
                  disabled={savingLayout}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors shadow-sm disabled:opacity-50"
                >
                  <XIcon size={12} />
                  <span className="hidden sm:inline">Cancelar</span>
                </button>
                <button
                  onClick={saveLayout}
                  disabled={savingLayout}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-primary hover:bg-[#0a0a0a] text-white rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors shadow-sm disabled:opacity-50"
                >
                  {savingLayout ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
                  <span>{savingLayout ? 'Salvando' : 'Salvar Layout'}</span>
                </button>
              </div>
            )}
            {canDownloadPdfBtn && (
              <button
                disabled={generatingPdf || !data}
                onClick={async () => {
                  if (!data) return;
                  setGeneratingPdf(true);
                  try {
                    // PDF respeita o filtro de unidades do Painel: se houver
                    // seleção, recorta o data (units + totais) pras selecionadas.
                    const pdfData = isAllUnits ? data : scopeDashboardData(data, activeUnitNames);
                    const pdfUnitNames = pdfData.units.map(u => u.name);
                    // Pré-filtra receivables pelas unidades em escopo — sem isso,
                    // o PDF sairia com totalAmount/perUnit/ids da rede inteira.
                    await generateReport(
                      pdfData,
                      filterReceivablesByUnits(receivables, pdfUnitNames),
                      {
                        hideFatEstimado: currentUser ? !pdfIncludesFatEstimado(currentUser) : false,
                        history: aggregateHistoryByMonth(historyRows, pdfUnitNames),
                      },
                    );
                  }
                  catch (e) { console.error('[PDF]', e); }
                  finally { setGeneratingPdf(false); }
                }}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-white rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {generatingPdf ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                <span className="hidden sm:inline">{generatingPdf ? 'Gerando' : 'Relatório'}</span>
              </button>
            )}
          </div>
        </div>
      </motion.div>

      {/* ── Unit Filter (segmented pills) ── */}
      <motion.div
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.25 }}
        className="mb-6"
      >
        {(data?.units?.length ?? 0) > 1 ? (
          <>
            <div className="flex items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-2">
                <Filter size={14} className="text-primary" />
                <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.15em]">
                  Filtrar por unidade
                </span>
                <span className="text-[10px] font-bold text-slate-300 normal-case tracking-normal hidden sm:inline">
                  · clique pra somar mais de uma
                </span>
              </div>
              {!isAllUnits && (
                <button
                  onClick={() => setSelectedUnits([])}
                  className="text-[11px] font-bold text-slate-500 hover:text-primary transition-colors focus:outline-none focus-visible:underline"
                >
                  {selectedUnits.length} selecionada{selectedUnits.length > 1 ? 's' : ''} · Limpar
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
              <Pill
                active={isAllUnits}
                onClick={() => setSelectedUnits([])}
              >
                Todas as Unidades
              </Pill>
          {/* Lista APENAS unidades permitidas pra este usuário (data já vem filtrado por App.tsx) */}
          {(data?.units ?? []).map(unitStats => {
            const name = unitStats.name;
            const active = selectedUnits.includes(name);
            return (
              <Pill
                key={name}
                active={active}
                onClick={() => toggleUnit(name)}
                className="inline-flex items-center gap-2"
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${
                    unitStats.hasError ? 'bg-rose-400' : active ? 'bg-accent' : 'bg-emerald-500/70'
                  }`}
                />
                {name}
                {!unitStats.hasError && (
                  <span className={`text-[10px] font-bold tabular-nums ${active ? 'text-white/70' : 'text-slate-500'}`}>
                    {formatNumber(unitStats.activeMembers)}
                  </span>
                )}
              </Pill>
            );
          })}
            </div>
          </>
        ) : (
          /* Usuário com 1 unidade só: mostra badge informativo, sem filtro redundante */
          (data?.units?.length ?? 0) === 1 && (
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-primary" />
              <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
                Unidade: {data?.units?.[0]?.name}
              </span>
            </div>
          )
        )}
      </motion.div>

      {/* ── Stats Grid (com edit layout: reordenar/esconder cards) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6 mb-16">
        {(() => {
          // ─── Modo HISTÓRICO: filtro num mês PASSADO → cards usam snapshot mensal ──
          // O EVO só devolve o estado ATUAL; meses passados vêm de gb_evo_history.
          // Vendas continua ao vivo (vendasRange, exato pro range). Métricas de
          // estoque (ativos/adimp/inadimp/faturamento) = snapshot do mês da data final.
          const histMonth = isDefaultRange ? '' : dateTo.slice(0, 7); // YYYY-MM da data final
          const isPastPeriod = (() => {
            if (isDefaultRange || !/^\d{4}-\d{2}$/.test(histMonth)) return false;
            const now = new Date();
            const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            return histMonth < curMonth;
          })();
          // Agregados mensais do HISTÓRICO (tabela Membros via /api/history) pras
          // unidades em escopo — alimenta o snapshot do mês selecionado E os
          // comparativos "Mês passado / Ano passado" de TODOS os cards de estoque.
          const histByMonth = new Map(
            aggregateHistoryByMonth(historyRows, activeUnitNames).map(m => [m.month, m]),
          );
          // Mês de referência dos comparativos: o selecionado (ou o corrente).
          const refMonth = isPastPeriod ? histMonth : periodoAtual;
          const shiftRefMonth = (delta: number) => {
            const [y, m] = refMonth.split('-').map(Number);
            const d = new Date(y, m - 1 + delta, 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          };
          const histAgg = isPastPeriod ? (histByMonth.get(histMonth) ?? null) : null;
          const isHistMode = isPastPeriod;                 // estamos olhando o passado
          const histMissing = isPastPeriod && !histAgg;    // passado sem dado no histórico

          // Cálculos compartilhados pra todos os cards (computa 1x)
          const ativos = isHistMode ? (histAgg?.active_members ?? 0) : (isAllUnits ? (data?.totalActiveMembers ?? 0) : filteredActive);
          const adimp = isHistMode ? (histAgg?.adimplentes ?? 0) : (isAllUnits ? (data?.totalAdimplentesMembers ?? 0) : filteredUnits.reduce((s, u) => s + (u.adimplentesMembers ?? 0), 0));
          const fatTotal = isHistMode ? (histAgg?.faturamento_adimplentes ?? 0) : (isAllUnits ? (data?.totalFaturamentoAdimplentes ?? 0) : filteredUnits.reduce((s, u) => s + (u.faturamentoAdimplentes ?? 0), 0));
          const ticketMedio = adimp > 0 ? fatTotal / adimp : 0;
          // Vendas: usa range customizado se ativo (filtro de data), senão default mês corrente.
          // Range customizado: SEMPRE soma por activeUnitNames (= unidades permitidas
          // no modo "Todas", ou a seleção). Nunca usa o total global da API de range,
          // que inclui TODAS as unidades e vazaria dados fora do escopo do usuário.
          const vendasValor = vendasRange
            ? activeUnitNames.reduce((s, n) => s + (vendasRange.byUnit[n]?.valor ?? 0), 0)
            : (isAllUnits
                ? (data?.totalVendasMesValor ?? 0)
                : filteredUnits.reduce((s, u) => s + (u.vendasMesValor ?? 0), 0));
          const vendasQtd = vendasRange
            ? activeUnitNames.reduce((s, n) => s + (vendasRange.byUnit[n]?.qtd ?? 0), 0)
            : (isAllUnits
                ? (data?.totalVendasMesQtd ?? 0)
                : filteredUnits.reduce((s, u) => s + (u.vendasMesQtd ?? 0), 0));
          const allUnitsComplete = vendasRange
            ? vendasRange.complete
            : (isAllUnits ? (data?.units ?? []).every(u => u.vendasMesComplete !== false) : filteredUnits.every(u => u.vendasMesComplete !== false));
          const vendasQtdPrev = isAllUnits ? (data?.totalVendasMesQtdPrev ?? 0) : filteredUnits.reduce((s, u) => s + (u.vendasMesQtdPrev ?? 0), 0);
          const vendasValorPrev = isAllUnits ? (data?.totalVendasMesValorPrev ?? 0) : filteredUnits.reduce((s, u) => s + (u.vendasMesValorPrev ?? 0), 0);
          // Quando filtro de data customizado tá ativo, comparativos "mês passado"
          // / "ano anterior" não fazem sentido (referem-se ao mês corrente).
          const cmpQtd = vendasRange ? '' : compareToPrev(vendasQtd, vendasQtdPrev);
          const cmpValor = vendasRange ? '' : compareToPrev(vendasValor, vendasValorPrev, formatCompactBRL);
          // ─── Vendas no MESMO MÊS DO ANO ANTERIOR (comparativo anual) ───────
          const filteredV1y = filteredUnits.filter(u => u.has1yVendas);
          const vendasQtd1y = isAllUnits
            ? (data?.totalVendasMesQtd1y ?? 0)
            : filteredV1y.reduce((s, u) => s + (u.vendasMesQtd1y ?? 0), 0);
          const vendasValor1y = isAllUnits
            ? (data?.totalVendasMesValor1y ?? 0)
            : filteredV1y.reduce((s, u) => s + (u.vendasMesValor1y ?? 0), 0);
          const has1yV = isAllUnits
            ? (data?.has1yVendasAny ?? false)
            : filteredUnits.some(u => u.has1yVendas);
          // Sufixo "Período: dd/mm → dd/mm" pros cards quando filtro ativo
          const fmtBR = (iso: string) => {
            const [y, m, d] = iso.split('-');
            return `${d}/${m}/${y.slice(2)}`;
          };
          const periodoSufix = vendasRange
            ? `Período: ${fmtBR(dateFrom)} → ${fmtBR(dateTo)}`
            : '';
          // Rótulo pros cards de estoque no modo histórico (mês passado selecionado).
          const histLabel = histMissing
            ? 'Sem histórico deste mês'
            : (isHistMode ? `Histórico · ${fmtBR(dateFrom)} → ${fmtBR(dateTo)}` : '');
          const partialPrefix = allUnitsComplete ? '' : '⚠ Dados parciais · ';
          const ticketMatricula = vendasQtd > 0 ? vendasValor / vendasQtd : 0;
          const inad = isHistMode ? (histAgg?.inadimplentes ?? 0) : (isAllUnits ? (data?.totalInadimplentesMembers ?? 0) : filteredInactive);
          const inadPct = ativos > 0 ? (inad / ativos) * 100 : 0;
          // ─── Snapshot anual: mês de referência − 12, direto do HISTÓRICO real ───
          const hist1yAgg = histByMonth.get(shiftRefMonth(-12)) ?? null;
          const ativos1y = hist1yAgg?.active_members ?? 0;
          const adimp1y  = hist1yAgg?.adimplentes ?? 0;
          const fat1y    = hist1yAgg?.faturamento_adimplentes ?? 0;
          const has1y    = !!hist1yAgg && ativos1y > 0;

          // ─── Helper UNIFICADO de comparativo anual ──────────────────────────
          // Todos os cards usam o mesmo padrão pedido:
          //   "↑ X% comparado ao ano anterior"  (subiu)
          //   "↓ X% comparado ao ano anterior"  (caiu)
          //   "= 0% comparado ao ano anterior"  (estável)
          //   undefined                         (sem dado histórico — não mostra)
          //
          // hasData: se a janela 1y existe pra esse cálculo (has1yData ou has1yVendas).
          // unitPP: true pra valores que JÁ são porcentagens (Inadimplência) — diferença
          //         vai em pp (pontos percentuais) em vez de % proporcional.
          // Comparativos: usa helper compartilhado fmtComparativos (mês + ano).
          // Saída: "Mês: ↑ X% · Ano: ↑ Y%" (ou subset). Mesmo padrão usado no Financeiro.
          // Mês anterior ao de referência, direto do HISTÓRICO real (tabela Membros).
          // 100% consistente com a Tendência & Projeção — mesma fonte, mesma agregação.
          const histPrevAgg = histByMonth.get(shiftRefMonth(-1)) ?? null;
          const ativosPrev = histPrevAgg?.active_members ?? 0;
          const adimpPrev  = histPrevAgg?.adimplentes ?? 0;
          const fatPrev    = histPrevAgg?.faturamento_adimplentes ?? 0;
          const inadPrevCount = histPrevAgg?.inadimplentes ?? 0;
          const inadPctPrev = ativosPrev > 0 ? (inadPrevCount / ativosPrev) * 100 : 0;
          const hasPrev = !!histPrevAgg && ativosPrev > 0;

          // Inadimplência do ano anterior (contagem real do histórico, em pp).
          const inad1y = hist1yAgg?.inadimplentes ?? 0;
          const inadPct1y = ativos1y > 0 ? (inad1y / ativos1y) * 100 : 0;

          // Comparativos valem TAMBÉM no modo histórico: a referência passa a ser
          // o mês selecionado (vs mês anterior a ele e vs 12 meses antes dele).
          const ativosCmp = fmtComparativosLines(ativos, ativosPrev, ativos1y, hasPrev, has1y);
          const adimpCmp  = fmtComparativosLines(adimp, adimpPrev, adimp1y, hasPrev, has1y);
          const fatCmp    = fmtComparativosLines(fatTotal, fatPrev, fat1y, hasPrev && fatPrev > 0, has1y && fat1y > 0);
          const inadCmpYoY = fmtComparativosLines(inadPct, inadPctPrev, inadPct1y, hasPrev, has1y, true);

          // Vendas: já tem mês passado (vendasMesValorPrev/QtdPrev). Combina com 1y.
          const vendasQtdLines = (() => {
            if (vendasRange) return { mes: undefined, ano: undefined };
            const lines = fmtComparativosLines(vendasQtd, vendasQtdPrev, vendasQtd1y, vendasQtdPrev > 0, has1yV);
            if (lines.mes || lines.ano) return lines;
            return { mes: "Sem histórico — clique em 'Histórico' pra sincronizar", ano: undefined };
          })();
          const vendasValorLines = (() => {
            if (vendasRange) return { mes: undefined, ano: undefined };
            const lines = fmtComparativosLines(vendasValor, vendasValorPrev, vendasValor1y, vendasValorPrev > 0, has1yV);
            if (lines.mes || lines.ano) return lines;
            return { mes: "Sem histórico — clique em 'Histórico' pra sincronizar", ano: undefined };
          })();

          // ─── Metas: agrega meta da categoria correspondente, calcula progresso ─
          // Pega kpis ativos do período corrente e filtra por unidade selecionada.
          // Quando todas selecionadas, soma metas de todas unidades visíveis.
          const allowedUnitNames = new Set((data?.units ?? []).map(u => u.name));
          // Metas PERCENTUAIS agregam por MÉDIA entre as unidades do escopo — somar
          // % de várias unidades não faz sentido (5% + 5% ≠ 10%). As metas absolutas
          // (ativos, adimplentes, vendas, faturamento) seguem SOMANDO normalmente.
          const PERCENT_META_CATEGORIES = new Set([
            'meta_inadimplentes',
            'meta_evasao',
            'meta_aulas_experimentais',
          ]);
          function getMetaTotal(categoria: string): number {
            // Usa o mês SELECIONADO (não só o corrente): num mês passado, mostra
            // a meta salva daquele mês. As metas ficam gravadas por período no NocoDB.
            const filtered = kpis.filter(k =>
              k.periodo === selectedMonth &&
              k.categoria === categoria &&
              (k.observacao ?? '').toString().toLowerCase() === 'ativa' &&
              (isAllUnits ? allowedUnitNames.has(k.unidade) : activeUnitSet.has(k.unidade))
            );
            const soma = filtered.reduce((s, k) => s + (Number(k.meta) || 0), 0);
            // Percentual → média das unidades COM meta no escopo; absoluto → soma.
            return PERCENT_META_CATEGORIES.has(categoria) && filtered.length > 0
              ? soma / filtered.length
              : soma;
          }
          function buildMetaInfo(real: number, categoria: string, fmtVal: (n: number) => string, lowerIsBetter = false) {
            const meta = getMetaTotal(categoria);
            if (meta <= 0) return undefined;
            const pct = Math.round((real / meta) * 100);
            const diff = meta - real;
            const exceeded = lowerIsBetter ? real > meta : real >= meta;
            let falta: string;
            if (lowerIsBetter) {
              falta = exceeded ? `${fmtVal(real - meta)} acima do limite` : `${fmtVal(diff)} de folga`;
            } else {
              falta = exceeded ? `Atingida ✓` : `Faltam ${fmtVal(diff)}`;
            }
            return { label: `Meta: ${fmtVal(meta)}`, pct, falta, lowerIsBetter };
          }
          // Formatter de % no padrão BR (uma casa, vírgula decimal) pras metas
          // percentuais (inadimplência/evasão/conversão).
          const fmtPct1 = (n: number) => `${n.toFixed(2).replace('.', ',')}%`;
          // Cards de estoque: num mês passado SEM snapshot no histórico (histMissing)
          // o real vem 0 — aí não mostramos meta (progresso contra 0 seria enganoso).
          const ativosMeta   = histMissing ? undefined : buildMetaInfo(ativos,   'meta_ativos',         formatNumber);
          const adimpMeta    = histMissing ? undefined : buildMetaInfo(adimp,    'meta_adimplentes',    formatNumber);
          const vendasQMeta  = buildMetaInfo(vendasQtd,   'meta_vendas',         formatNumber);
          const vendasVMeta  = buildMetaInfo(vendasValor, 'meta_vendas_receita', formatCompactBRL);
          const fatMeta      = histMissing ? undefined : buildMetaInfo(fatTotal, 'meta_faturamento',    formatCompactBRL);
          const inadMeta     = histMissing ? undefined : buildMetaInfo(inadPct,  'meta_inadimplentes',  fmtPct1, true);

          // Renderizadores indexados por card ID — ordem aplicada via cardOrder.map abaixo.
          // PADRÃO: linha 1 (comparison) = contexto local; linha 2 (subComparison) = comparativo anual.
          const renderers: Record<PanelCardId, () => React.ReactNode> = {
            'ativos': () => (
              <StatsCard
                title="Ativos"
                info="Alunos com contrato ativo (em dia + inadimplentes), sem contar VIPs."
                value={histMissing ? '—' : (data ? formatNumber(ativos) : '—')}
                comparison={isHistMode ? histLabel : undefined}
                subComparison={ativosCmp.mes}
                subComparison2={ativosCmp.ano}
                metaInfo={ativosMeta}
                sparkline={isHistMode ? undefined : spark(sparkSeries.ativos, '#141414')}
                icon={Users} color="primary" isLoading={isLoading}
              />
            ),
            'adimplentes': () => (
              <StatsCard
                title="Adimplentes"
                info="Alunos ativos que estão em dia com as mensalidades."
                value={histMissing ? '—' : (data ? formatNumber(adimp) : '—')}
                comparison={isHistMode ? histLabel : 'Ativos · em dia'}
                subComparison={adimpCmp.mes}
                subComparison2={adimpCmp.ano}
                metaInfo={adimpMeta}
                sparkline={isHistMode ? undefined : spark(sparkSeries.adimplentes, '#10b981')}
                icon={CheckCircle2} color="accent" valueColorClass="text-emerald-600" isLoading={isLoading}
              />
            ),
            'faturamento': () => (
              <StatsCard
                title="Faturamento Estimado"
                info="Receita mensal estimada: soma dos valores de contrato dos alunos ativos."
                value={histMissing ? '—' : (data ? formatCompactBRL(fatTotal) : '—')}
                fullValue={histMissing ? undefined : (data ? formatBRL(fatTotal) : undefined)}
                comparison={isHistMode ? histLabel : (ticketMedio > 0 ? `Ticket ${formatCompactBRL(ticketMedio)}` : 'Soma ValorContrato')}
                subComparison={fatCmp.mes}
                subComparison2={fatCmp.ano}
                metaInfo={fatMeta}
                sparkline={isHistMode ? undefined : spark(sparkSeries.faturamento, '#141414')}
                icon={TrendingUp} color="primary" valueColorClass="text-primary" isLoading={isLoading}
              />
            ),
            'vendas-qtd': () => (
              <StatsCard
                title={vendasRange ? 'Vendas (Qtd) · período' : 'Vendas (Qtd)'}
                info="Matrículas novas no período (não conta renovações de contrato)."
                value={vendasRangeLoading ? '...' : (data ? formatNumber(vendasQtd) : '—')}
                comparison={`${partialPrefix}${vendasRange ? periodoSufix : (cmpQtd || 'Matrículas novas no mês')}`}
                subComparison={vendasRange ? undefined : vendasQtdLines.mes}
                subComparison2={vendasRange ? undefined : vendasQtdLines.ano}
                metaInfo={vendasQMeta}
                sparkline={vendasRange ? undefined : spark(sparkSeries.vendasQtd, '#fc3000')}
                icon={ShoppingBag} color="accent"
                valueColorClass={allUnitsComplete ? 'text-accent' : 'text-amber-600'}
                isLoading={isLoading || vendasRangeLoading}
                onClick={vendasQtd > 0 && canSeeVendasDetalheVal ? () => setVendasModalOpen(true) : undefined}
              />
            ),
            'vendas-valor': () => (
              <StatsCard
                title={vendasRange ? 'Vendas (R$) · período' : 'Vendas (R$)'}
                info="Valor financeiro das matrículas novas no período."
                value={vendasRangeLoading ? '...' : (data ? formatCompactBRL(vendasValor) : '—')}
                fullValue={vendasValor > 0 ? formatBRL(vendasValor) : undefined}
                comparison={`${partialPrefix}${vendasRange ? periodoSufix : (cmpValor || (ticketMatricula > 0 ? `Ticket ${formatCompactBRL(ticketMatricula)}/matrícula` : 'Sem vendas no mês'))}`}
                subComparison={vendasRange ? undefined : vendasValorLines.mes}
                subComparison2={vendasRange ? undefined : vendasValorLines.ano}
                metaInfo={vendasVMeta}
                sparkline={vendasRange ? undefined : spark(sparkSeries.vendasValor, '#fc3000')}
                icon={ShoppingBag} color="accent"
                valueColorClass={allUnitsComplete ? 'text-accent' : 'text-amber-600'}
                isLoading={isLoading || vendasRangeLoading}
                onClick={vendasQtd > 0 && canSeeVendasDetalheVal ? () => setVendasModalOpen(true) : undefined}
              />
            ),
            'inadimplencia': () => (
              <StatsCard
                title="% Inadimplência"
                info="% dos alunos ativos com mensalidade em aberto (atrasada). Clique para ver a lista (nome, telefone, unidade)."
                value={histMissing ? '—' : (data ? `${inadPct.toFixed(2).replace('.', ',')}%` : '—')}
                comparison={histMissing ? histLabel : (data ? `Sobre ${formatNumber(ativos)} ativos${isHistMode ? ` · ${histLabel}` : ''}` : '—')}
                subComparison={inadCmpYoY.mes}
                subComparison2={inadCmpYoY.ano}
                metaInfo={inadMeta}
                sparkline={isHistMode ? undefined : spark(sparkSeries.inadimplencia, '#d97706')}
                icon={TrendingUp} color="amber" isLoading={isLoading}
                onClick={!isHistMode && data && canSeeInadimplentesVal ? () => setInadimplentesModalOpen(true) : undefined}
              />
            ),
            'evasao': () => {
              // Evasão REAL: cancelamentos no período / base ativa.
              // - Mês corrente (ao vivo): /api/v3/membermembership da EVO, agregado
              //   em totalCancelamentosMes (App.tsx).
              // - Período passado: tabela de cancelamentos do NocoDB (histCancel),
              //   contando por unidade (nome canônico) e respeitando o filtro.
              const canceladosLive = isAllUnits
                ? (data?.totalCancelamentosMes ?? 0)
                : filteredUnits.reduce((s, u) => s + (u.cancelamentosMes ?? 0), 0);
              // SEMPRE soma por activeUnitNames (= unidades permitidas no modo "Todas").
              // Usar histCancel.total vazaria cancelamentos de TODAS as unidades — e como
              // `ativos` é escopado, a evasão "não batia" (cancelados de todas / ativos das liberadas).
              const canceladosHist = activeUnitNames.reduce((s, u) => s + (histCancel.byUnit[u] ?? 0), 0);
              const cancelados = isHistMode ? canceladosHist : canceladosLive;
              const cancelComplete = isAllUnits
                ? (data?.cancelamentosMesAllComplete ?? true)
                : filteredUnits.every(u => u.cancelamentosMesComplete !== false);
              const evasaoPct = ativos > 0 ? (cancelados / ativos) * 100 : 0;
              const histCancelReady = isHistMode && histCancel.ready; // tem dado do período
              const partialPrefixCancel = cancelComplete ? '' : '⚠ Dados parciais · ';
              // Só mostra meta se houver real confiável: mês corrente, ou passado
              // com dado de cancelamento carregado (senão evasaoPct=0 falsearia).
              const evasaoMeta = (!isHistMode || histCancelReady)
                ? buildMetaInfo(evasaoPct, 'meta_evasao', fmtPct1, true)
                : undefined;
              return (
                <StatsCard
                  title="% Evasão"
                  info="% de alunos que cancelaram o contrato no período, sobre a base ativa."
                  value={isHistMode
                    ? (histCancelReady && ativos > 0 ? `${evasaoPct.toFixed(2).replace('.', ',')}%` : '—')
                    : (data ? `${evasaoPct.toFixed(2).replace('.', ',')}%` : '—')}
                  comparison={isHistMode
                    ? (histCancelReady
                      ? `${formatNumber(cancelados)} cancelamentos de ${formatNumber(ativos)} ativos · ${histLabel}`
                      : 'Sem dado histórico de evasão')
                    : (data
                      ? `${partialPrefixCancel}${formatNumber(cancelados)} cancelados de ${formatNumber(ativos)} ativos no mês`
                      : '—')}
                  metaInfo={evasaoMeta}
                  icon={TrendingUp} color="rose"
                  valueColorClass="text-rose-600"
                  isLoading={isLoading}
                  onClick={isHistMode || !data || !canSeeEvasaoCard ? undefined : () => setEvasaoModalOpen(true)}
                />
              );
            },
            'conv-aula-exp': () => {
              // Conversão = fecharam / compareceram (do mês, agregado pelo filtro de unidade).
              const filteredCom = isAllUnits
                ? comercialMes
                : comercialMes.filter(r => activeUnitSet.has(r.branch_name));
              const compareceram = filteredCom.reduce((s, r) => s + (Number(r.compareceram) || 0), 0);
              const fecharam    = filteredCom.reduce((s, r) => s + (Number(r.fecharam) || 0), 0);
              const agendados   = filteredCom.reduce((s, r) => s + (Number(r.agendados) || 0), 0);
              const convPct = compareceram > 0 ? Math.round((fecharam / compareceram) * 100) : 0;
              const hasData = compareceram > 0 || agendados > 0;
              // Conversão não tem histórico (comercialMes é do mês corrente) → no
              // modo histórico não mostra meta pra não comparar com dado do mês errado.
              const convMeta = (!isHistMode && hasData) ? buildMetaInfo(convPct, 'meta_aulas_experimentais', fmtPct1) : undefined;
              return (
                <StatsCard
                  title="Conversão Aula Exp."
                  info="% das aulas experimentais (presentes) que viraram matrícula."
                  value={isHistMode ? '—' : (hasData ? `${convPct.toFixed(2).replace('.', ',')}%` : '—')}
                  comparison={isHistMode
                    ? 'Sem dado histórico de conversão'
                    : (hasData
                      ? `${fecharam} fecharam de ${compareceram} presentes`
                      : 'Preencha em "Comercial" pra ver')}
                  subComparison={isHistMode ? undefined : (hasData ? `${agendados} agendados no mês` : undefined)}
                  metaInfo={convMeta}
                  icon={Sparkles} color="secondary" valueColorClass="text-cyan-600" isLoading={isLoading}
                  onClick={() => onNavigate('comercial')}
                />
              );
            },
            'taxa-ocupacao': () => {
              // Filtra unidades de ocupação respeitando o filtro do Painel (pills multi-seleção)
              // E também a matriz Página×Unidade já aplicada em data.units (vem de App.tsx).
              const allowedNames = new Set((data?.units ?? []).map(u => u.name));
              const visible = occupation
                ? (isAllUnits
                    ? occupation.byUnit.filter(u => allowedNames.has(u.name))
                    : occupation.byUnit.filter(u => activeUnitSet.has(u.name)))
                : [];
              const occ = visible.reduce((s, u) => s + u.occupation, 0);
              const cap = visible.reduce((s, u) => s + u.maxOccupation, 0);
              const pct = cap > 0 ? (occ / cap) * 100 : 0;
              const valorStr = !occupation ? '—' : (cap > 0 ? `${pct.toFixed(2).replace('.', ',')}%` : '—');
              const subtitle = !occupation
                ? 'Carregando capacidade...'
                : (cap > 0 ? `${formatNumber(occ)} / ${formatNumber(cap)} vagas` : 'Capacidade não configurada');
              return (
                <StatsCard
                  title="Taxa de Ocupação"
                  info="% de vagas preenchidas sobre a capacidade total das aulas."
                  value={isHistMode ? '—' : valorStr}
                  comparison={isHistMode ? 'Sem dado histórico de ocupação' : subtitle}
                  subComparison={isHistMode ? undefined : 'Ver detalhes por unidade →'}
                  icon={Activity} color="secondary" valueColorClass="text-violet-600"
                  isLoading={!occupation && !isHistMode}
                  onClick={isHistMode ? undefined : () => onNavigate('ocupacao')}
                />
              );
            },
          };

          // Filtra cards que dependem de permissão de página (oculta inteiro,
          // não dá pra reativar via edit-layout — é regra de acesso).
          const visibleOrder = cardOrder.filter(id => {
            if (id === 'faturamento' && !canSeeFinanceiro) return false;
            if (id === 'vendas-valor' && !canSeeVendasValorCard) return false;
            if (id === 'conv-aula-exp' && !canSeeComercial) return false;
            if (id === 'taxa-ocupacao' && !canSeeTaxaOcupacaoCard) return false;
            // Evasão/Vendas: o card SEMPRE aparece — o que muda é poder clicar
            // pra abrir a lista (controlado no onClick de cada card).
            return true;
          });

          return visibleOrder.map((id, idx) => {
            const isHidden = hiddenCards.has(id);
            // Em uso normal, esconde de fato. Em edit mode, mostra com ghost pra poder reativar.
            if (isHidden && !editLayoutMode) return null;
            return (
              <div
                key={id}
                className={`relative ${isHidden ? 'opacity-40 ring-2 ring-rose-200/50 rounded-3xl' : ''}`}
              >
                {renderers[id]()}
                {editLayoutMode && (
                  <div className="absolute top-2 right-2 z-(--z-dropdown) flex gap-0.5 bg-white/95 backdrop-blur rounded-lg shadow-md border border-slate-200 p-0.5">
                    <button
                      type="button"
                      onClick={() => moveCard(id, -1)}
                      disabled={idx === 0}
                      title="Mover pra esquerda"
                      className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveCard(id, 1)}
                      disabled={idx === visibleOrder.length - 1}
                      title="Mover pra direita"
                      className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleHidden(id)}
                      title={isHidden ? 'Mostrar este card' : 'Esconder este card'}
                      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${isHidden ? 'text-emerald-600 hover:bg-emerald-50' : 'text-rose-500 hover:bg-rose-50'}`}
                    >
                      {isHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>

      {/* ── Evolução da Rede (tendência + projeção + insights) ── */}
      {historyEnabled && canSeeTendenciaVal && (
        <Suspense fallback={<div className="mb-16 h-[380px] card-base animate-pulse" />}>
          <NetworkTrendChart
            rows={historyRows}
            includeUnits={includeUnits}
            current={currentPoint}
            loading={historyLoading}
            selectedMonth={selectedMonth}
            currentByUnit={currentByUnit}
            showFaturamento={canSeeTendenciaFatVal}
            showVendasValor={canSeeVendasValorCard}
          />
        </Suspense>
      )}


      <UnitDetailsModal
        unit={selectedUnit}
        receivables={filterReceivablesByUnits(receivables, (data?.units ?? []).map(u => u.name))}
        isOpen={!!selectedUnit}
        onClose={() => setSelectedUnit(null)}
        onViewReport={() => onNavigate('financeiro')}
      />

      {presentationMode && isAdminUser && (
        <PresentationMode
          data={data}
          onClose={() => setPresentationMode(false)}
        />
      )}

      <VendasMesModal
        isOpen={vendasModalOpen}
        onClose={() => setVendasModalOpen(false)}
        vendas={(() => {
          if (vendasRange) {
            // Filtro custom ativo: usa lista do agregador (já tem branchName)
            return isAllUnits
              ? vendasRange.list
              : activeUnitNames.flatMap(n => (vendasRange.byUnit[n]?.list ?? []).map(v => ({ ...v, branchName: n })));
          }
          return (isAllUnits ? (data?.units ?? []) : filteredUnits).flatMap(u => u.vendasMesList ?? []);
        })()}
        periodLabel={(() => {
          if (vendasRange) {
            const fmtBR = (iso: string) => {
              const [y, m, d] = iso.split('-');
              return `${d}/${m}/${y.slice(2)}`;
            };
            return `${fmtBR(dateFrom)} → ${fmtBR(dateTo)}`;
          }
          const m = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
          return m.charAt(0).toUpperCase() + m.slice(1);
        })()}
        showClientName={showClienteNome}
      />

      <EvasaoModal
        isOpen={evasaoModalOpen}
        onClose={() => setEvasaoModalOpen(false)}
        unitNames={(isAllUnits ? (data?.units ?? []) : filteredUnits).map(u => u.name)}
        showClientName={showClienteNome}
      />

      <InadimplentesModal
        isOpen={inadimplentesModalOpen}
        onClose={() => setInadimplentesModalOpen(false)}
        unitNames={(isAllUnits ? (data?.units ?? []) : filteredUnits).map(u => u.name)}
        showClientName={showClienteNome}
      />

      <HistoricalSeedModal
        isOpen={seedModalOpen && isAdminUser}
        onClose={() => setSeedModalOpen(false)}
      />
    </div>
  );
}
