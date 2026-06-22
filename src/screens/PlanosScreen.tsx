import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { MonthCalendarPopover } from '../components/MonthCalendarPopover';
import {
  Thermometer, ChevronLeft, ChevronRight, Filter, RefreshCw,
  Sparkles, Users, Layers, AlertTriangle,
} from 'lucide-react';
import { Pill } from '../components/ui/Pill';
import { LoadingBar } from '../components/ui/LoadingBar';
import { PlanThermometer } from '../components/PlanThermometer';
import { fetchPlansBreakdown, type BranchPlanBreakdown, type PlanBreakdown } from '../services/evoApi';
import type { DashboardData } from '../App';

interface Props {
  data: DashboardData | null;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function PlanosScreen({ data }: Props) {
  const unitNames = useMemo(() => (data?.units ?? []).map(u => u.name), [data]);
  const [month, setMonth] = useState<string>(currentMonth());
  const [unitFilter, setUnitFilter] = useState<string>('Todas');
  const [branchData, setBranchData] = useState<BranchPlanBreakdown[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cur = currentMonth();
  const isCurrent = month >= cur;

  // Usuário com 1 unidade só → trava o filtro nela.
  useEffect(() => {
    if (unitNames.length === 1 && unitFilter === 'Todas') {
      queueMicrotask(() => setUnitFilter(unitNames[0]));
    }
  }, [unitNames, unitFilter]);

  // Busca a base por plano do mês — recarrega ao mudar mês ou conjunto de unidades.
  const unitKey = unitNames.join('|');
  useEffect(() => {
    // Sem unidades ainda = data do App não chegou: mantém o skeleton (não flipa
    // pra "vazio") até as unidades permitidas carregarem.
    if (unitNames.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => { setIsLoading(true); setError(null); });
    fetchPlansBreakdown(month, unitNames)
      .then(rows => { if (!cancelled) setBranchData(rows); })
      .catch(err => {
        console.error('[Planos] fetch error:', err);
        if (!cancelled) setError('Não foi possível carregar a base por plano. Tente recarregar.');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [month, unitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Agrega pelos filtros: 'Todas' soma planos de mesmo nome entre unidades;
  // senão pega só a unidade selecionada.
  const plans = useMemo<PlanBreakdown[]>(() => {
    const scoped = unitFilter === 'Todas' ? branchData : branchData.filter(b => b.unitName === unitFilter);
    const map = new Map<string, PlanBreakdown>();
    for (const branch of scoped) {
      for (const p of branch.plans) {
        const cur = map.get(p.plano) ?? { plano: p.plano, total: 0, novo: 0, antigo: 0, valor: 0 };
        cur.total += p.total; cur.novo += p.novo; cur.antigo += p.antigo; cur.valor += p.valor;
        map.set(p.plano, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [branchData, unitFilter]);

  const baseTotal = plans.reduce((s, p) => s + p.total, 0);
  const novoTotal = plans.reduce((s, p) => s + p.novo, 0);
  const maxTotal  = plans.reduce((m, p) => Math.max(m, p.total), 0);
  const novoPct   = baseTotal > 0 ? (novoTotal / baseTotal) * 100 : 0;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <LoadingBar active={isLoading} label="Carregando planos" />
      {/* ── Header ── */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="mb-8">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">
          Composição da Base
        </span>
        <div className="flex items-end justify-between flex-wrap gap-6">
          <div>
            <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4 flex items-center gap-3">
              <Thermometer className="text-accent" size={44} strokeWidth={2.5} />
              Termômetro de <span className="text-accent">Planos</span>
            </h1>
            <p className="text-slate-400 text-[15px] font-semibold max-w-xl">
              Base ativa por plano · cada termômetro mostra o tamanho do plano e a divisão entre
              <span className="text-accent font-black"> novos no mês</span> e
              <span className="text-primary font-black"> base antiga</span>.
            </p>
          </div>

          {/* Navegador de mês */}
          <div className="flex items-center gap-2 bg-white border border-slate-100 rounded-2xl px-2 py-1.5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
            <button
              onClick={() => setMonth(m => shiftMonth(m, -1))}
              className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-primary hover:bg-slate-50 transition-colors"
              title="Mês anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <MonthCalendarPopover
              month={month}
              maxMonth={cur}
              onPick={setMonth}
              buttonClassName="text-[13px] font-black text-primary min-w-[130px] text-center tabular-nums px-2 py-1.5 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {monthLabel(month)}
            </MonthCalendarPopover>
            <button
              onClick={() => setMonth(m => (m >= cur ? m : shiftMonth(m, 1)))}
              disabled={isCurrent}
              className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-primary hover:bg-slate-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={isCurrent ? 'Mês atual (sem futuro)' : 'Próximo mês'}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </motion.div>

      {/* ── Filtro de unidade ── */}
      {unitNames.length > 1 ? (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <span className="flex items-center gap-1.5 text-[11px] font-black text-slate-400 uppercase tracking-wider mr-1">
            <Filter size={13} /> Unidade
          </span>
          {(['Todas', ...unitNames]).map(name => (
            <Pill key={name} active={unitFilter === name} onClick={() => setUnitFilter(name)}>
              {name}
            </Pill>
          ))}
        </div>
      ) : unitNames.length === 1 && (
        <div className="mb-6">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
            Unidade: {unitNames[0]}
          </span>
        </div>
      )}

      {/* ── Resumo agregado ── */}
      {!isLoading && !error && baseTotal > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <SummaryCard icon={Users}      label="Base ativa"        value={baseTotal.toLocaleString('pt-BR')}              accent="text-primary" />
          <SummaryCard icon={Sparkles}   label="Novos no mês"      value={novoTotal.toLocaleString('pt-BR')}              accent="text-accent" />
          <SummaryCard icon={Thermometer}label="% novos"           value={`${novoPct.toFixed(2).replace('.', ',')}%`}                                  accent="text-violet-600" />
          <SummaryCard icon={Layers}     label="Planos ativos"     value={plans.length.toLocaleString('pt-BR')}           accent="text-blue-600" />
        </div>
      )}

      {/* ── Conteúdo ── */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-56 rounded-[1.5rem] bg-slate-100 animate-pulse" />)}
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 px-6 py-5 bg-rose-50 border border-rose-100 rounded-2xl">
          <AlertTriangle size={20} className="text-rose-500 shrink-0" />
          <p className="text-[13px] font-bold text-rose-700">{error}</p>
        </div>
      ) : plans.length === 0 ? (
        <div className="py-16 text-center bg-white rounded-[2rem] border border-slate-100">
          <Thermometer size={36} className="mx-auto text-slate-200 mb-4" />
          <p className="text-slate-400 font-bold">Nenhuma base ativa encontrada em {monthLabel(month)}</p>
          <p className="text-slate-300 font-semibold text-[13px] mt-1">
            {isCurrent ? 'Verifique se há contratos ativos nesta unidade.' : 'Talvez não haja snapshot deste mês.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {plans.map((p, i) => (
            <PlanThermometer
              key={p.plano}
              plano={p.plano}
              total={p.total}
              novo={p.novo}
              antigo={p.antigo}
              valor={p.valor}
              maxTotal={maxTotal}
              baseTotal={baseTotal}
              animationDelay={Math.min(i * 0.04, 0.4)}
            />
          ))}
        </div>
      )}

      {/* Nota de rodapé */}
      {!isLoading && !error && plans.length > 0 && (
        <p className="text-[11px] font-semibold text-slate-400 mt-8 flex items-center gap-1.5">
          <RefreshCw size={11} />
          {isCurrent
            ? 'Base ativa de hoje. "Novos" = contratos iniciados neste mês.'
            : `Base ativa no fim de ${monthLabel(month)} (snapshot). "Novos" = contratos iniciados naquele mês.`}
        </p>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: string; accent: string }) {
  return (
    <div className="card-base p-5 flex items-center gap-3">
      <div className={`w-10 h-10 shrink-0 rounded-xl bg-slate-50 flex items-center justify-center ${accent}`}>
        <Icon size={18} strokeWidth={2.5} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider truncate">{label}</p>
        <p className={`text-[1.5rem] font-black leading-none tabular-nums ${accent}`}>{value}</p>
      </div>
    </div>
  );
}
