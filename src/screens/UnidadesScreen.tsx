import { useState, useEffect } from 'react';
import { motion, type Variants } from 'framer-motion';
import { ArrowUpRight, Users, TrendingDown, MapPin, AlertTriangle } from 'lucide-react';
import { formatNumber, fetchReceivables, filterReceivablesByUnits, type BranchStats, type ReceivablesData } from '../services/evoApi';
import { getSession } from '../services/nocodbApi';

// Roles que NÃO devem ver bloco financeiro (faturamento mês) — gestores
// de unidade veem só base de membros + evasão.
const ROLES_SEM_FINANCEIRO = new Set(['gerente', 'coord_vendas', 'socio_cotista']);
import { UnitDetailsModal } from '../components/UnitDetailsModal';
import type { DashboardData, Page } from '../App';

const container: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.07 } },
};
const item: Variants = {
  hidden: { y: 16, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.4, ease: 'easeOut' } },
};

type SortKey = 'name' | 'activeMembers' | 'adimplentesMembers' | 'inactiveMembers' | 'evasaoRate';

interface Props {
  data: DashboardData | null;
  isLoading: boolean;
  onNavigate?: (page: Page) => void;
}

export function UnidadesScreen({ data, isLoading, onNavigate }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('activeMembers');
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedUnit, setSelectedUnit] = useState<BranchStats | null>(null);
  const [receivables, setReceivables] = useState<ReceivablesData | null>(null);

  // Receivables tem cache de 15min; se Financeiro já carregou, vem instantâneo do localStorage.
  // Filtramos pelas allowed_units do user — sem isso, o cache global incluiria
  // unidades fora do escopo.
  useEffect(() => {
    let cancelled = false;
    fetchReceivables()
      .then(r => {
        if (cancelled) return;
        const allowed = (data?.units ?? []).map(u => u.name);
        setReceivables(filterReceivablesByUnits(r, allowed));
      })
      .catch(err => console.error('[Unidades] fetchReceivables error:', err));
    return () => { cancelled = true; };
  }, [data]);

  // Mapa unitName → amount do receivable (pra lookup rápido por unidade)
  const recByUnit: Record<string, number> = {};
  for (const u of (receivables?.perUnit ?? [])) recByUnit[u.unitName] = u.amount;

  const units: BranchStats[] = data?.units ?? [];

  const sorted = [...units].sort((a, b) => {
    let av = 0, bv = 0;
    if (sortKey === 'name') return sortDesc
      ? b.name.localeCompare(a.name)
      : a.name.localeCompare(b.name);
    if (sortKey === 'activeMembers')      { av = a.activeMembers;        bv = b.activeMembers; }
    if (sortKey === 'adimplentesMembers') { av = a.adimplentesMembers;   bv = b.adimplentesMembers; }
    if (sortKey === 'inactiveMembers')    { av = a.inadimplentesMembers; bv = b.inadimplentesMembers; }
    if (sortKey === 'evasaoRate') {
      // Evasão REAL = cancelamentos de membership do mês / ativos.
      // Vem de /api/v3/membermembership (cada unidade puxa seu próprio).
      av = a.activeMembers > 0 ? (a.cancelamentosMes ?? 0) / a.activeMembers : 0;
      bv = b.activeMembers > 0 ? (b.cancelamentosMes ?? 0) / b.activeMembers : 0;
    }
    return sortDesc ? bv - av : av - bv;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(true); }
  }

  const totalActive        = units.reduce((s, u) => s + u.activeMembers, 0);          // total em vigor (adimp + inadimp)
  const totalAdimplentes   = units.reduce((s, u) => s + u.adimplentesMembers, 0);
  const totalInadimplentes = units.reduce((s, u) => s + u.inadimplentesMembers, 0);
  // Evasão global = cancelamentos REAIS do mês (W12 /api/v3/membermembership) / ativos.
  // Cada unidade puxa o seu via token próprio; aqui agregamos pra visão de rede.
  const totalCancelamentos = units.reduce((s, u) => s + (u.cancelamentosMes ?? 0), 0);
  const globalEvasao       = totalActive > 0 ? (totalCancelamentos / totalActive) * 100 : 0;

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
          Gestão de Unidades
        </span>
        <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
          Unidades <span className="text-accent">Operacionais</span>
        </h1>
        <p className="text-slate-400 text-[16px] font-semibold">
          Visão detalhada de desempenho por filial.
        </p>
      </motion.div>

      {/* ── Summary Cards ── */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-14"
      >
        {[
          { label: 'Total Unidades',  value: String(units.length),                icon: MapPin,       color: 'text-slate-700',   bg: 'bg-slate-100' },
          { label: 'Ativos',          value: formatNumber(totalActive),           icon: Users,        color: 'text-slate-700',   bg: 'bg-slate-100' },
          { label: 'Adimplentes',     value: formatNumber(totalAdimplentes),      icon: Users,        color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'Inadimplentes',   value: formatNumber(totalInadimplentes),    icon: TrendingDown, color: 'text-red-500',     bg: 'bg-red-50' },
          { label: 'Evasão Global',   value: `${globalEvasao.toFixed(2).replace('.', ',')}%`,                  icon: TrendingDown, color: 'text-rose-600',    bg: 'bg-rose-50' },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <motion.div key={label} variants={item} className="min-w-0">
            <div className="bg-white rounded-[2rem] border border-slate-100 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.04)] min-w-0">
              <div className={`w-10 h-10 ${bg} rounded-xl flex items-center justify-center mb-4`}>
                <Icon size={18} className={color} strokeWidth={2.5} />
              </div>
              <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1 truncate">{label}</p>
              <p className={`text-[1.5rem] xl:text-[1.75rem] font-black ${color} tracking-tight tabular-nums truncate`} title={typeof value === 'string' ? value : undefined}>{isLoading ? '—' : value}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* ── Sort Controls ── */}
      <div className="flex items-center gap-3 mb-8 flex-wrap">
        <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">Ordenar por:</span>
        {([
          { key: 'activeMembers',      label: 'Ativos'        },
          { key: 'adimplentesMembers', label: 'Adimplentes'   },
          { key: 'inactiveMembers',    label: 'Inadimplentes' },
          { key: 'evasaoRate',         label: 'Evasão'        },
          { key: 'name',               label: 'Nome'          },
        ] as { key: SortKey; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => toggleSort(key)}
            className={`px-4 py-2 rounded-full text-[12px] font-black transition-all ${
              sortKey === key
                ? 'bg-primary text-white shadow-[0_4px_12px_rgba(15,60,35,0.2)]'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            {label} {sortKey === key && (sortDesc ? '↓' : '↑')}
          </button>
        ))}
      </div>

      {/* ── Unit Cards Grid ── */}
      {isLoading ? (
        <motion.div variants={container} initial="hidden" animate="visible"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <motion.div key={i} variants={item}>
              <SkeletonUnitCard />
            </motion.div>
          ))}
        </motion.div>
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"
        >
          {sorted.map((unit) => (
            <motion.div key={unit.name} variants={item}>
              <DetailedUnitCard
                unit={unit}
                faturamentoMes={recByUnit[unit.name] ?? 0}
                hasReceivables={receivables !== null}
                onDetailsClick={() => setSelectedUnit(unit)}
              />
            </motion.div>
          ))}
        </motion.div>
      )}

      <UnitDetailsModal
        unit={selectedUnit}
        receivables={receivables}
        isOpen={!!selectedUnit}
        onClose={() => setSelectedUnit(null)}
        onViewReport={() => onNavigate?.('financeiro')}
      />

      {/* ── Comparison Table ── */}
      {!isLoading && units.length > 0 && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          whileInView={{ y: 0, opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mt-16"
        >
          <div className="flex items-center gap-4 mb-8 border-l-[6px] border-l-primary pl-5">
            <h2 className="text-[1.6rem] font-black text-[#1E293B] tracking-tight">Comparativo de Desempenho</h2>
          </div>

          <div className="bg-white rounded-[2rem] border border-slate-100 overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 bg-[#fafafa]">
                  {['Unidade', 'Ativos', 'Adimplentes', 'Inadimplentes', 'Evasão', 'Status'].map(h => (
                    <th key={h} className="text-left px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((unit, i) => {
                  // Evasão REAL = cancelamentos do mês (W12) / ativos. Alto = ruim (cor invertida).
                  const evasao = unit.activeMembers > 0 ? ((unit.cancelamentosMes ?? 0) / unit.activeMembers) * 100 : 0;
                  return (
                    <tr key={unit.name} className={`border-b border-slate-50 hover:bg-[#fafafa] transition-colors ${i === sorted.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-black text-[#0F172A] text-[14px]">{unit.name}</p>
                          <p className="text-[11px] text-slate-400 font-semibold">{unit.location}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-black text-slate-700 text-[15px]">{unit.hasError ? '—' : unit.activeMembers.toLocaleString('pt-BR')}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-black text-emerald-600 text-[15px]">{unit.hasError ? '—' : unit.adimplentesMembers.toLocaleString('pt-BR')}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-bold text-red-500 text-[14px]">{unit.hasError ? '—' : unit.inadimplentesMembers.toLocaleString('pt-BR')}</span>
                      </td>
                      <td className="px-6 py-4">
                        {unit.hasError ? <span className="text-slate-400 font-bold">—</span> : (
                          <div className="flex items-center gap-3">
                            <div className="flex-1 max-w-[80px] h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${evasao >= 20 ? 'bg-rose-600' : evasao >= 10 ? 'bg-rose-500' : 'bg-rose-300'}`}
                                style={{ width: `${Math.min(Math.max(evasao, 2), 100)}%` }}
                              />
                            </div>
                            <span className="text-[13px] font-black text-rose-600 tabular-nums">{evasao.toFixed(2).replace('.', ',')}%</span>
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {unit.hasError
                          ? <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-50 text-red-500 rounded-full text-[11px] font-black"><AlertTriangle size={10} /> Falha</span>
                          : <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#fde7e2] text-primary rounded-full text-[11px] font-black"><span className="w-1.5 h-1.5 bg-accent rounded-full" />Ativo</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Totals row */}
          <div className="mt-4 flex flex-wrap gap-4">
            {[
              { label: 'Total Ativos',        value: totalActive.toLocaleString('pt-BR'),        color: 'text-slate-700' },
              { label: 'Total Adimplentes',   value: totalAdimplentes.toLocaleString('pt-BR'),   color: 'text-emerald-600' },
              { label: 'Total Inadimplentes', value: totalInadimplentes.toLocaleString('pt-BR'), color: 'text-red-500' },
              { label: 'Evasão Global',       value: `${globalEvasao.toFixed(2).replace('.', ',')}%`,                         color: 'text-rose-600' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-white rounded-2xl border border-slate-100 px-5 py-3 shadow-sm">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{label}</p>
                <p className={`text-[1.4rem] font-black ${color} tracking-tighter`}>{value}</p>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ─── Detailed Unit Card ───────────────────────────────────────────────────────

interface DetailedUnitCardProps {
  unit: BranchStats;
  faturamentoMes: number;       // soma do receivable da unidade no mês
  hasReceivables: boolean;      // false = ainda carregando o XLSX de recebíveis
  onDetailsClick?: () => void;
}

function DetailedUnitCard({ unit, faturamentoMes, hasReceivables, onDetailsClick }: DetailedUnitCardProps) {
  // Permissão de visualização do bloco "Faturamento Mês" (receivables).
  // Gestor/Coord vendas/Sócio cotista NÃO veem o número total da loja.
  const canSeeFaturamento = (() => {
    const s = getSession();
    if (!s) return false;
    if (s.role === 'admin') return true;
    return !ROLES_SEM_FINANCEIRO.has(s.role);
  })();
  // Evasão REAL = cancelamentos do mês (W12 /api/v3/membermembership) / ativos.
  // Evasão é SEMPRE conceitualmente ruim → escala só em tons de rose (claro = baixa, escuro = alta).
  // Faixas: < 10% rose-300 · 10-19% rose-500 · ≥ 20% rose-600.
  const evasao = unit.activeMembers > 0 ? ((unit.cancelamentosMes ?? 0) / unit.activeMembers) * 100 : 0;
  const evasaoColor = evasao >= 20 ? '#E11D48' : evasao >= 10 ? '#F43F5E' : '#FDA4AF';

  // Formata moeda compacta — R$ 155.955 ou — quando não carregou
  const fmtMoney = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onDetailsClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDetailsClick?.(); } }}
      aria-label={`Detalhes da unidade ${unit.name}`}
      className="card-base card-interactive group cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className={`h-1.5 rounded-t-[calc(var(--radius-card)-1px)] ${unit.hasError ? 'bg-red-200' : 'bg-gradient-to-r from-[#141414] via-[#141414] to-[#fc3000]'}`} aria-hidden="true" />

      <div className="card-pad">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <h4 className="font-black text-slate-900 text-[1.3rem] leading-tight mb-1 tracking-tight">{unit.name}</h4>
            <div className="flex items-center gap-1.5 card-eyebrow">
              <MapPin size={10} aria-hidden="true" /> {unit.location}
            </div>
          </div>
          {unit.hasError ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 text-rose-600 rounded-full text-[10px] font-black">
              <AlertTriangle size={10} aria-hidden="true" /> Falha
            </span>
          ) : (
            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-primary rounded-full text-[10px] font-black">
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" aria-hidden="true" /> Ativo
            </span>
          )}
        </div>

        {/* Stats Grid */}
        {unit.hasError ? (
          <div className="h-24 flex items-center justify-center text-slate-400 text-[13px] font-bold">
            Dados indisponíveis
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-5">
              {[
                { label: 'Ativos',        value: unit.activeMembers.toLocaleString('pt-BR'),        color: 'text-slate-900' },
                { label: 'Adimplentes',   value: unit.adimplentesMembers.toLocaleString('pt-BR'),   color: 'text-emerald-600' },
                { label: 'Inadimplentes', value: unit.inadimplentesMembers.toLocaleString('pt-BR'), color: 'text-rose-600' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-slate-50 rounded-2xl p-3 border border-slate-100 min-w-0">
                  {/* Eyebrow: tracking apertado + quebra em 2 linhas no mobile (em vez de
                      cortar "Inadimplentes" em coluna estreita). hyphens evita corte feio. */}
                  <p className="text-[10px] font-bold uppercase tracking-[0.03em] text-slate-500 leading-tight mb-1.5 break-words hyphens-auto" title={label}>{label}</p>
                  <p className={`text-[1.2rem] font-black tracking-tight tabular-nums truncate ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* Evasão Bar */}
            <div className="mb-5">
              <div className="flex justify-between items-center mb-2">
                <span className="card-eyebrow">Evasão</span>
                <span className="text-[13px] font-black tabular-nums" style={{ color: evasaoColor }}>{evasao.toFixed(2).replace('.', ',')}%</span>
              </div>
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${Math.min(evasao, 100)}%`, backgroundColor: evasaoColor }}
                />
              </div>
            </div>

            {/* Faturamento — receivable (total mês) + sales (vendas mês) */}
            {/* Gerente/Coord. Vendas/Sócio Cotista veem só vendas (não o faturamento total). */}
            <div className={`grid ${canSeeFaturamento ? 'grid-cols-2' : 'grid-cols-1'} gap-3 mb-5`}>
              {canSeeFaturamento && (
                <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
                  <p className="card-eyebrow text-emerald-700/80 mb-1.5">Faturamento Mês</p>
                  <p className="text-[1.1rem] font-black text-emerald-700 tracking-tight tabular-nums">
                    {hasReceivables ? fmtMoney(faturamentoMes) : '—'}
                  </p>
                  <p className="text-[9px] font-bold text-emerald-700/60 mt-1">recebíveis (W12)</p>
                </div>
              )}
              <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100">
                <p className="card-eyebrow text-indigo-700/80 mb-1.5">Vendas Mês</p>
                <p className="text-[1.1rem] font-black text-indigo-700 tracking-tight tabular-nums">
                  {fmtMoney(unit.vendasMesValor ?? 0)}
                </p>
                <p className="text-[9px] font-bold text-indigo-700/60 mt-1">
                  {unit.vendasMesQtd ?? 0} {unit.vendasMesQtd === 1 ? 'matrícula nova' : 'matrículas novas'}
                  {!unit.vendasMesComplete && ' · parcial'}
                </p>
              </div>
            </div>
          </>
        )}

        <span className="block w-full py-4 rounded-2xl border border-primary/15 bg-white text-primary text-[12px] font-black uppercase tracking-[0.1em] group-hover:bg-primary group-hover:text-white group-hover:border-primary transition-all duration-300 text-center">
          <span className="inline-flex items-center justify-center gap-2">Ver Detalhes <ArrowUpRight size={14} aria-hidden="true" /></span>
        </span>
      </div>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonUnitCard() {
  return (
    <div className="card-base overflow-hidden animate-pulse" aria-hidden="true">
      <div className="h-1.5 bg-slate-100" />
      <div className="card-pad">
        <div className="h-5 bg-slate-100 rounded-xl mb-2 w-2/3" />
        <div className="h-3 bg-slate-50 rounded-xl mb-6 w-1/2" />
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[1,2,3].map(i => <div key={i} className="h-16 bg-slate-50 rounded-2xl" />)}
        </div>
        <div className="h-2.5 bg-slate-50 rounded-full mb-5" />
        <div className="h-12 bg-slate-50 rounded-2xl" />
      </div>
    </div>
  );
}
