import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Users, TrendingUp, AlertTriangle, Clock, Maximize2, CheckCircle2, ShoppingBag, DollarSign, Target, ChevronLeft, ChevronRight, Eye, EyeOff, Edit3, RotateCcw, Save } from 'lucide-react';
import gbElement from '../assets/gb_element-2.png';
import type { DashboardData } from '../App';
import { UNITS, fetchReceivables, filterReceivablesByUnits, type ReceivablesData } from '../services/evoApi';
import { getLayoutForCurrentUser, saveLayoutForCurrentUser, type PanelLayout } from '../services/nocodbApi';
import { formatNumber, formatCompactBRL } from '../lib/format';

interface Props {
  data: DashboardData | null;
  onClose: () => void;
  onRefresh?: () => void;
}

// ─── Cards do Modo TV (pra reordenação/ocultação) ───────────────────────────
const TV_CARDS = [
  { id: 'ativos',              label: 'Ativos' },
  { id: 'adimplentes',         label: 'Adimplentes' },
  { id: 'inadimplentes',       label: 'Inadimplentes' },
  { id: 'ja-pagaram',          label: 'Já Pagaram' },
  { id: 'faturamento-real',    label: 'Faturamento Real Mês' },
  { id: 'faturamento-est',     label: 'Faturamento Estimado' },
  { id: 'matriculas-novas',    label: 'Matrículas Novas' },
  { id: 'receita-risco',       label: 'Receita em Risco' },
] as const;
type TvCardId = typeof TV_CARDS[number]['id'];
const ALL_TV_IDS: TvCardId[] = TV_CARDS.map(c => c.id);

function mergeTvOrder(saved: string[]): TvCardId[] {
  const seen = new Set<string>();
  const result: TvCardId[] = [];
  for (const id of saved) {
    if ((ALL_TV_IDS as readonly string[]).includes(id) && !seen.has(id)) {
      result.push(id as TvCardId);
      seen.add(id);
    }
  }
  for (const id of ALL_TV_IDS) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

/** TV / presentation mode — fullscreen big-number layout for displaying on a screen at the gym. */
export function PresentationMode({ data, onClose, onRefresh }: Props) {
  const [now, setNow] = useState(new Date());
  const [unitIdx, setUnitIdx] = useState<number>(-1); // -1 = "all"
  const [receivables, setReceivables] = useState<ReceivablesData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Layout customizado dos cards do Modo TV ──
  // Lazy init lê de localStorage no mount — evita setState em useEffect.
  const [editLayoutMode, setEditLayoutMode] = useState(false);
  const [tvOrder, setTvOrder] = useState<TvCardId[]>(() => {
    const saved = getLayoutForCurrentUser('tv_layout');
    return saved ? mergeTvOrder(saved.order) : [...ALL_TV_IDS];
  });
  const [hiddenTv, setHiddenTv] = useState<Set<TvCardId>>(() => {
    const saved = getLayoutForCurrentUser('tv_layout');
    if (!saved) return new Set();
    return new Set(saved.hidden.filter(id => (ALL_TV_IDS as readonly string[]).includes(id)) as TvCardId[]);
  });
  const [tvSnapshot, setTvSnapshot] = useState<{ order: TvCardId[]; hidden: Set<TvCardId> } | null>(null);
  const [savingTv, setSavingTv] = useState(false);
  function startEditTv() {
    setTvSnapshot({ order: [...tvOrder], hidden: new Set(hiddenTv) });
    setEditLayoutMode(true);
  }
  function cancelEditTv() {
    if (tvSnapshot) { setTvOrder(tvSnapshot.order); setHiddenTv(tvSnapshot.hidden); }
    setEditLayoutMode(false); setTvSnapshot(null);
  }
  function resetTv() { setTvOrder([...ALL_TV_IDS]); setHiddenTv(new Set()); }
  async function saveTvLayout() {
    setSavingTv(true);
    try {
      const layout: PanelLayout = { order: tvOrder, hidden: Array.from(hiddenTv) };
      await saveLayoutForCurrentUser('tv_layout', layout);
      setEditLayoutMode(false); setTvSnapshot(null);
    } catch (e) { console.error('[TV] saveLayout error:', e); }
    finally { setSavingTv(false); }
  }
  function moveTvCard(id: TvCardId, dir: -1 | 1) {
    const idx = tvOrder.indexOf(id);
    const target = idx + dir;
    if (target < 0 || target >= tvOrder.length) return;
    const next = [...tvOrder];
    [next[idx], next[target]] = [next[target], next[idx]];
    setTvOrder(next);
  }
  function toggleHiddenTv(id: TvCardId) {
    const next = new Set(hiddenTv);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHiddenTv(next);
  }

  const unitNames = ['Todas as Unidades', ...Object.keys(UNITS)];
  const currentLabel = unitIdx === -1 ? unitNames[0] : unitNames[unitIdx + 1];
  const currentUnitName = unitIdx === -1 ? null : unitNames[unitIdx + 1];
  const currentUnitData = currentUnitName ? data?.units.find(u => u.name === currentUnitName) ?? null : null;

  // Carrega recebíveis 1x na montagem (cache 15min compartilhado com Financeiro).
  // Filtra pelas allowed_units do user (defensive — TV é admin-only, mas
  // garante isolamento se alguém manipular state via devtools).
  useEffect(() => {
    let cancelled = false;
    fetchReceivables()
      .then(r => {
        if (cancelled) return;
        const allowed = (data?.units ?? []).map(u => u.name);
        setReceivables(filterReceivablesByUnits(r, allowed));
      })
      .catch(err => console.error('[TV] fetchReceivables error:', err));
    return () => { cancelled = true; };
  }, [data]);

  // Aggregated stats for the current view
  const activeMembers       = currentUnitData ? currentUnitData.activeMembers           : (data?.totalActiveMembers          ?? 0);
  const adimplentesMembers  = currentUnitData ? currentUnitData.adimplentesMembers ?? 0 : (data?.totalAdimplentesMembers     ?? 0);
  const inadimplentesMembers= currentUnitData ? currentUnitData.inadimplentesMembers??0 : (data?.totalInadimplentesMembers   ?? 0);
  const faturamento         = currentUnitData ? currentUnitData.faturamentoAdimplentes??0: (data?.totalFaturamentoAdimplentes ?? 0);
  const riskRevenue         = currentUnitData ? currentUnitData.faturamentoInadimplentes??0: ((data?.units ?? []).reduce((s, u) => s + (u.faturamentoInadimplentes ?? 0), 0));
  const vendasValor         = currentUnitData ? currentUnitData.vendasMesValor??0       : (data?.totalVendasMesValor          ?? 0);
  const vendasQtd           = currentUnitData ? currentUnitData.vendasMesQtd??0         : (data?.totalVendasMesQtd            ?? 0);

  // Faturamento real do mês (recebíveis): por unidade ou total da rede
  const fatRealMes = currentUnitName
    ? (receivables?.perUnit.find(p => p.unitName === currentUnitName)?.amount ?? 0)
    : (receivables?.totalAmount ?? 0);

  // Cruzamento member × receivable: dos ativos, quantos têm IdCliente no receivable
  const idsAtivos = new Set<number>(
    currentUnitData
      ? [...(currentUnitData.idsAdimplentes ?? []), ...(currentUnitData.idsInadimplentes ?? [])]
      : (data?.units ?? []).flatMap(u => [...(u.idsAdimplentes ?? []), ...(u.idsInadimplentes ?? [])])
  );
  const idsReceb = new Set<number>(
    currentUnitName
      ? (receivables?.idsLancadosPorUnidade?.[currentUnitName] ?? [])
      : (receivables?.idsLancados ?? [])
  );
  let qtdPagaram = 0;
  idsAtivos.forEach(id => { if (idsReceb.has(id)) qtdPagaram++; });
  const pctPagaram = idsAtivos.size > 0 ? (qtdPagaram / idsAtivos.size) * 100 : 0;

  // Real-time clock (1s tick)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-cycle through unit views every 12s (skip if user just changed manually)
  // Domínio: -1 (Todas) → 0..6 (7 unidades) → -1 (volta).
  // Total = 8 estados. Bug antigo: `(i + 1) % len - 1` ficava preso (ex: i=-1 → -1).
  // Correto: mapeia [-1..6] pra [0..7], avança, volta a [-1..6].
  const lastChange = useRef<number>(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastChange.current < 11_000) return;
      setUnitIdx(i => ((i + 2) % unitNames.length) - 1);
      lastChange.current = Date.now();
    }, 12_000);
    return () => clearInterval(id);
  }, [unitNames.length]);

  // Auto refresh data every 5min
  useEffect(() => {
    if (!onRefresh) return;
    const id = setInterval(onRefresh, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [onRefresh]);

  // onClose vem como `() => setPresentationMode(false)` do pai — nova função
  // a cada render. Sem a ref, qualquer re-render do pai (fetch chega, range
  // muda) re-rodava o effect → cleanup chamava exitFullscreen → fullscreenchange
  // dispara → onClose() é chamado → modal fecha sozinho. Bug clássico.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Request fullscreen on mount + listen for fullscreenchange (browser intercepts ESC in fullscreen)
  // Effect sem deps → roda só no mount/unmount; usa onCloseRef pra valor atual.
  useEffect(() => {
    const el = containerRef.current ?? document.documentElement;
    el.requestFullscreen?.().catch(() => { /* user denied */ });

    function onFullscreenChange() {
      // Quando o browser sai do fullscreen (via ESC, F11, etc), fecha o modo TV
      if (!document.fullscreenElement) onCloseRef.current();
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    };
  }, []);

  // Keyboard: ESC (fallback se não estiver em fullscreen) + setas para navegar
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === 'ArrowRight') {
        setUnitIdx(i => Math.min(i + 1, unitNames.length - 2));
        lastChange.current = Date.now();
      }
      if (e.key === 'ArrowLeft') {
        setUnitIdx(i => Math.max(i - 1, -1));
        lastChange.current = Date.now();
      }
    }
    document.addEventListener('keydown', onKey, true); // capture phase, prioridade alta
    return () => document.removeEventListener('keydown', onKey, true);
  }, [unitNames.length]);

  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] bg-gradient-to-br from-slate-50 via-white to-slate-100 flex flex-col overflow-hidden"
    >
      {/* ── Top bar ── */}
      <header className="shrink-0 px-8 py-4 flex items-center justify-between border-b border-slate-200/60">
        <div className="flex items-center gap-6">
          <img src={gbElement} alt="Gaviões" className="h-12 w-auto object-contain select-none" draggable={false} />
          <div className="h-10 w-px bg-slate-200" />
          <div>
            <p className="text-[10px] font-black text-primary uppercase tracking-[0.3em]">Painel Operacional</p>
            <p className="text-[16px] font-black text-slate-900 tracking-tight capitalize">{currentLabel}</p>
          </div>
        </div>

        <div className="flex items-center gap-8">
          {/* Clock */}
          <div className="text-right">
            <p className="text-[2.4rem] font-black text-slate-900 leading-none tabular-nums tracking-tight">
              {timeStr}
            </p>
            <p className="text-[11px] font-bold text-slate-400 capitalize mt-1">{dateStr}</p>
          </div>

          <div className="h-10 w-px bg-slate-200" />

          {/* Edit Layout — só visível pra admin (que é quem entra no TV) */}
          {!editLayoutMode && (
            <button
              onClick={startEditTv}
              title="Editar layout do TV: reordenar/esconder cards"
              className="inline-flex items-center gap-2 px-3 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700 transition-colors"
            >
              <Edit3 size={13} /> Editar
            </button>
          )}
          {editLayoutMode && (
            <div className="flex items-center gap-2">
              <button onClick={resetTv} disabled={savingTv} title="Resetar pra default"
                className="inline-flex items-center gap-1 px-3 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-slate-50 transition-colors disabled:opacity-50">
                <RotateCcw size={12} /> Reset
              </button>
              <button onClick={cancelEditTv} disabled={savingTv}
                className="inline-flex items-center gap-1 px-3 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-rose-50 hover:text-rose-600 transition-colors disabled:opacity-50">
                <X size={12} /> Cancelar
              </button>
              <button onClick={saveTvLayout} disabled={savingTv}
                className="inline-flex items-center gap-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors disabled:opacity-50">
                <Save size={12} /> {savingTv ? 'Salvando' : 'Salvar'}
              </button>
            </div>
          )}

          {/* Exit button */}
          <button
            onClick={onClose}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-slate-800 transition-colors"
            title="ESC para sair"
          >
            <X size={14} />
            Sair (ESC)
          </button>
        </div>
      </header>

      {/* ── Main KPI grid ── */}
      <main className="flex-1 px-8 py-6 flex items-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentLabel}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="w-full grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {(() => {
              const renderers: Record<TvCardId, () => React.ReactNode> = {
                'ativos': () => <BigKpiCard label="Ativos" value={formatNumber(activeMembers)} footer="Contratos em vigor" icon={Users} accent="bg-blue-500" valueColor="text-blue-600" />,
                'adimplentes': () => <BigKpiCard label="Adimplentes" value={formatNumber(adimplentesMembers)} footer="Pagamentos em dia" icon={CheckCircle2} accent="bg-emerald-500" valueColor="text-emerald-600" />,
                'inadimplentes': () => {
                  const inadPct = activeMembers > 0 ? (inadimplentesMembers / activeMembers) * 100 : 0;
                  return <BigKpiCard label="Inadimplentes" value={formatNumber(inadimplentesMembers)} footer={`${inadPct.toFixed(2).replace('.', ',')}% da base ativa`} icon={AlertTriangle} accent="bg-rose-500" valueColor="text-rose-600" />;
                },
                'ja-pagaram': () => <BigKpiCard label="Já Pagaram" value={`${formatNumber(qtdPagaram)} (${pctPagaram.toFixed(2).replace('.', ',')}%)`} footer={receivables ? `de ${formatNumber(idsAtivos.size)} ativos · IdCliente ∩ receivable` : 'Carregando recebíveis…'} icon={Target} accent={pctPagaram >= 80 ? 'bg-emerald-500' : pctPagaram >= 50 ? 'bg-amber-500' : 'bg-rose-500'} valueColor={pctPagaram >= 80 ? 'text-emerald-600' : pctPagaram >= 50 ? 'text-amber-600' : 'text-rose-600'} />,
                'faturamento-real': () => <BigKpiCard label="Faturamento Real Mês" value={receivables ? formatCompactBRL(fatRealMes) : '—'} footer={receivables ? 'Recebíveis W12 (mês corrente)' : 'Carregando recebíveis…'} icon={DollarSign} accent="bg-primary" valueColor="text-primary" />,
                'faturamento-est': () => <BigKpiCard label="Faturamento Estimado" value={formatCompactBRL(faturamento)} footer={adimplentesMembers > 0 ? `Ticket médio R$ ${Math.round(faturamento / adimplentesMembers).toLocaleString('pt-BR')}` : 'Soma ValorContrato (member)'} icon={TrendingUp} accent="bg-accent" valueColor="text-accent" />,
                'matriculas-novas': () => <BigKpiCard label="Matrículas Novas" value={formatNumber(vendasQtd)} footer={vendasValor > 0 ? `${formatCompactBRL(vendasValor)} em vendas no mês` : 'Apenas matrículas novas'} icon={ShoppingBag} accent="bg-indigo-500" valueColor="text-indigo-600" />,
                'receita-risco': () => <BigKpiCard label="Receita em Risco" value={formatCompactBRL(riskRevenue)} footer={`${formatNumber(inadimplentesMembers)} inadimp · ValorContrato em atraso`} icon={AlertTriangle} accent="bg-amber-500" valueColor="text-amber-600" />,
              };
              return tvOrder.map((id, idx) => {
                const isHidden = hiddenTv.has(id);
                if (isHidden && !editLayoutMode) return null;
                return (
                  <div key={id} className={`relative ${isHidden ? 'opacity-40 ring-2 ring-rose-300 rounded-3xl' : ''}`}>
                    {renderers[id]()}
                    {editLayoutMode && (
                      <div className="absolute top-2 right-2 z-20 flex gap-0.5 bg-white/95 backdrop-blur rounded-lg shadow-md border border-slate-200 p-0.5">
                        <button type="button" onClick={() => moveTvCard(id, -1)} disabled={idx === 0}
                          className="w-8 h-8 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary disabled:opacity-30 transition-colors">
                          <ChevronLeft size={16} />
                        </button>
                        <button type="button" onClick={() => moveTvCard(id, 1)} disabled={idx === tvOrder.length - 1}
                          className="w-8 h-8 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary disabled:opacity-30 transition-colors">
                          <ChevronRight size={16} />
                        </button>
                        <button type="button" onClick={() => toggleHiddenTv(id)}
                          className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${isHidden ? 'text-emerald-600 hover:bg-emerald-50' : 'text-rose-500 hover:bg-rose-50'}`}>
                          {isHidden ? <Eye size={16} /> : <EyeOff size={16} />}
                        </button>
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </motion.div>

        </AnimatePresence>
      </main>

      {/* ── Footer / unit dot indicator ── */}
      <footer className="shrink-0 px-8 py-4 flex items-center justify-between border-t border-slate-200/60">
        <div className="flex items-center gap-2 text-[12px] font-bold text-slate-400">
          <Clock size={13} />
          <span>
            Atualização automática a cada 5 minutos · rodízio entre unidades a cada 12s · use ← → para navegar
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {unitNames.map((_, i) => {
            const isActive = (i === 0 && unitIdx === -1) || (i - 1 === unitIdx);
            return (
              <button
                key={i}
                onClick={() => { setUnitIdx(i - 1); lastChange.current = Date.now(); }}
                className={`h-2 rounded-full transition-all ${isActive ? 'w-8 bg-primary' : 'w-2 bg-slate-300 hover:bg-slate-400'}`}
                aria-label={unitNames[i]}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">
          <Maximize2 size={11} />
          Modo TV
        </div>
      </footer>
    </div>
  );
}

interface BigKpiCardProps {
  label: string;
  value: string;
  footer: string;
  icon: React.ElementType;
  accent: string;
  valueColor: string;
}

/**
 * Adaptive value font size for TV mode — biggest possible that still fits.
 * Em Full HD (1920px) cada card de 4-col tem ~440px width, ~390px de área útil após p-7.
 * Caps no max foram reduzidos pra evitar overflow em valores longos como 'R$ 1.234.567'.
 * 5 tiers granulares dão melhor distribuição visual entre cards curtos e longos.
 */
function getTvValueSizeClass(value: string): string {
  const len = value.length;
  if (len <= 5)  return 'text-[clamp(3.2rem,4.6vw,4.8rem)]'; // muito curto: ex '847', BIG
  if (len <= 8)  return 'text-[clamp(2.6rem,3.8vw,4rem)]';   // curto: ex '1.234', '87%'
  if (len <= 12) return 'text-[clamp(2.1rem,3vw,3.2rem)]';   // médio: ex 'R$ 567K', '1.234 (87%)'
  if (len <= 16) return 'text-[clamp(1.7rem,2.4vw,2.5rem)]'; // longo: ex 'R$ 1.234.567'
  return 'text-[clamp(1.3rem,1.8vw,2rem)]';                  // muito longo: fallback
}

function BigKpiCard({ label, value, footer, icon: Icon, accent, valueColor }: BigKpiCardProps) {
  const sizeClass = getTvValueSizeClass(value);
  return (
    <div className="relative bg-white border border-slate-200 rounded-3xl p-6 flex flex-col h-full overflow-hidden shadow-[0_8px_30px_rgba(15,23,42,0.04)] min-w-0">
      {/* Accent stripe */}
      <div className={`absolute top-0 left-0 right-0 h-1.5 ${accent}`} />

      <div className="flex items-start justify-between mb-5 mt-1 gap-2">
        <p className="text-[11px] font-black text-slate-500 uppercase tracking-[0.16em] line-clamp-2 flex-1 min-w-0">
          {label}
        </p>
        <div className="w-10 h-10 shrink-0 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
          <Icon size={19} strokeWidth={2.4} />
        </div>
      </div>

      <div className="flex-1 flex items-end min-w-0 overflow-hidden">
        <h2
          className={`${valueColor} ${sizeClass} font-black leading-none tracking-tight whitespace-nowrap tabular-nums w-full overflow-hidden`}
          title={value}
        >
          {value}
        </h2>
      </div>

      <p className="mt-4 text-[12px] font-bold text-slate-500 truncate">{footer}</p>
    </div>
  );
}
