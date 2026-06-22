import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  TrendingUp, DollarSign, BarChart2,
  UserX, AlertTriangle, Eye,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardData } from '../App';
import { formatNumber, getCachedAvgTicket } from '../services/evoApi';
import { getSession, canSeeMetaRegional as canSeeMetaRegionalPerm } from '../services/nocodbApi';
import { InfoTooltip } from '../components/ui/InfoTooltip';

interface Props {
  data: DashboardData | null;
  isLoading: boolean;
}

// ── KPI Card (somente leitura — todos os valores são automáticos) ───────────────
function KPICard({ label, value, icon: Icon, color = 'primary', sub, large, info }: {
  label: string; value: string; icon: LucideIcon; color?: string; sub?: string; large?: boolean; info?: string;
}) {
  const colors: Record<string, { bg: string; text: string; icon: string }> = {
    primary: { bg: 'bg-primary/5', text: 'text-primary', icon: 'text-primary' },
    accent:  { bg: 'bg-accent/10',  text: 'text-accent',  icon: 'text-accent' },
    rose:    { bg: 'bg-rose-50',    text: 'text-rose-500', icon: 'text-rose-400' },
    amber:   { bg: 'bg-amber-50',   text: 'text-amber-600', icon: 'text-amber-500' },
    blue:    { bg: 'bg-blue-50',    text: 'text-blue-600', icon: 'text-blue-500' },
    purple:  { bg: 'bg-purple-50',  text: 'text-purple-600', icon: 'text-purple-500' },
  };
  const c = colors[color] ?? colors.primary;
  return (
    <div className={`${large ? 'p-8' : 'p-6'} bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_20px_rgba(0,0,0,0.03)] hover:shadow-[0_12px_40px_rgba(0,0,0,0.06)] transition-all duration-500 group`}>
      <div className={`w-11 h-11 ${c.bg} rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
        <Icon size={20} className={c.icon} strokeWidth={2.5} />
      </div>
      <div className="flex items-center gap-1.5 mb-2">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em]">{label}</p>
        {info && <InfoTooltip text={info} label={`O que é: ${label}`} />}
      </div>
      <p className={`${large ? 'text-[2.4rem]' : 'text-[1.8rem]'} font-black ${c.text} tracking-tighter leading-none`}>{value}</p>
      {sub && <p className="text-[11px] font-bold text-slate-400 mt-2">{sub}</p>}
    </div>
  );
}

// ── Section Header ──────────────────────────────────────────────────────────────
function SectionHeader({ title, subtitle, borderColor = 'border-l-primary' }: { title: string; subtitle: string; borderColor?: string }) {
  return (
    <div className={`border-l-[6px] ${borderColor} pl-6 mb-10`}>
      <h2 className="text-[2rem] font-black text-primary tracking-tight">{title}</h2>
      <p className="text-[13px] text-slate-400 font-bold uppercase tracking-widest mt-1">{subtitle}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN — KPIs OPERACIONAIS, 100% automáticos e somente leitura.
// (Os KPIs de marketing — investido, CPL, CAC, ROAS, Mapa de Aquisição —
//  vivem na aba Marketing.)
// ═══════════════════════════════════════════════════════════════════════════════

const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function KPIsScreen({ data, isLoading }: Props) {
  const canSeeMetaRegional = (() => {
    const s = getSession();
    return s ? canSeeMetaRegionalPerm(s) : true;
  })();

  // ── Filtro por unidade ──
  const allUnitNames = (data?.units ?? []).map(u => u.name);
  const [unitFilter, setUnitFilter] = useState<string>('Todas');
  const filteredUnits = unitFilter === 'Todas'
    ? (data?.units ?? [])
    : (data?.units ?? []).filter(u => u.name === unitFilter);

  const activeMembers = unitFilter === 'Todas'
    ? (data?.totalActiveMembers ?? 0)
    : filteredUnits.reduce((s, u) => s + (u.activeMembers ?? 0), 0);
  const inactiveMembers = unitFilter === 'Todas'
    ? (data?.totalInactiveMembers ?? 0)
    : filteredUnits.reduce((s, u) => s + (u.inadimplentesMembers ?? 0), 0);
  const totalMembers = activeMembers + inactiveMembers;

  // ── Valores reais do snapshot EVO ──
  const dataReady = !!data && !isLoading;
  const vendasQtd = unitFilter === 'Todas'
    ? (data?.totalVendasMesQtd ?? 0)
    : filteredUnits.reduce((s, u) => s + (u.vendasMesQtd ?? 0), 0);
  const cancelamentos = unitFilter === 'Todas'
    ? (data?.totalCancelamentosMes ?? 0)
    : filteredUnits.reduce((s, u) => s + (u.cancelamentosMes ?? 0), 0);
  const churnPct = activeMembers > 0 ? (cancelamentos / activeMembers) * 100 : 0;
  const avgTicket = getCachedAvgTicket();

  // Persiste os valores reais nas chaves legadas que o MetasScreen lê.
  useEffect(() => {
    if (!dataReady) return;
    try {
      localStorage.setItem('gb_kpi_closed_sales', String(vendasQtd));
      localStorage.setItem('gb_kpi_turnover', String(Math.round(churnPct)));
      localStorage.setItem('gb_kpi_avg_ticket', String(avgTicket));
    } catch { /* ignore */ }
  }, [dataReady, vendasQtd, churnPct, avgTicket]);

  // ── Indicadores calculados (todos automáticos) ──
  const monthlyChurnRate = churnPct > 0 ? churnPct / 100 : 0.05;
  const avgLifetimeMonths = Math.round(1 / monthlyChurnRate);
  const ltv = avgLifetimeMonths * avgTicket;
  const retentionRate = unitFilter === 'Todas'
    ? (data?.retentionRate ?? 0)
    : (activeMembers > 0
        ? Math.round((filteredUnits.reduce((s, u) => s + (u.adimplentesMembers ?? 0), 0) / activeMembers) * 100)
        : 0);
  const evasionRate = totalMembers > 0 ? (inactiveMembers / totalMembers) * 100 : 0;
  const inadimplenciaPct = activeMembers > 0 ? (inactiveMembers / activeMembers) * 100 : 0;
  const mrr = activeMembers * avgTicket;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* ── Header ── */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="mb-14">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.4em] mb-4 block">
          Inteligência Operacional
        </span>
        <h1 className="text-[3.6rem] font-black text-primary leading-[0.9] tracking-tighter mb-4">
          KPIs <span className="text-accent">Gaviões</span>
        </h1>
        <p className="text-slate-400 text-[17px] font-semibold max-w-2xl">
          Indicadores operacionais 100% automáticos, apurados em tempo real da W12 EVO.
          Os KPIs de marketing (investimento, CPL, CAC, ROAS) ficam na aba <strong>Marketing</strong>.
        </p>

        {allUnitNames.length > 1 && (
          <div className="mt-6 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider mr-2">Unidade:</span>
            {(['Todas', ...allUnitNames]).map(name => (
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
        )}
        {allUnitNames.length === 1 && (
          <div className="mt-6">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
              Unidade: {allUnitNames[0]}
            </span>
          </div>
        )}
      </motion.div>

      {/* ═══ Valor do Cliente ═══ */}
      <section className="mb-20">
        <SectionHeader title="Valor do Cliente" subtitle="LTV · Ticket · MRR" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <KPICard label="LTV — Tempo de Vida" value={ltv > 0 ? brl(ltv) : '—'} icon={TrendingUp} color="accent" large
            info="Quanto um aluno gera em média durante todo o tempo que fica (ticket × meses de permanência, derivado do churn real)."
            sub={`${avgLifetimeMonths} meses × ${brl(avgTicket)}`} />
          <KPICard label="Ticket Médio" value={avgTicket > 0 ? brl(avgTicket) : '—'} icon={DollarSign} color="primary" large
            info="Valor médio mensal dos planos ativos (EVO)." sub="Planos EVO" />
          <KPICard label="MRR Projetado" value={mrr > 0 ? brl(mrr) : '—'} icon={BarChart2} color="blue" large
            info="Receita recorrente mensal projetada: alunos ativos × ticket médio." sub={`${formatNumber(activeMembers)} ativos × ticket`} />
        </div>
      </section>

      {/* ═══ Retenção & Risco ═══ */}
      <section className="mb-20">
        <SectionHeader title="Retenção & Risco" subtitle="Evasão · Inadimplência · Churn · Retenção" borderColor="border-l-accent" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <KPICard label="% Evasão" value={`${evasionRate.toFixed(2).replace('.', ',')}%`} icon={UserX} color="rose"
            info="% da base que está inativa/saiu." sub={`${formatNumber(inactiveMembers)} inativos · EVO`} />
          <KPICard label="% Inadimplência" value={`${inadimplenciaPct.toFixed(2).replace('.', ',')}%`} icon={AlertTriangle} color="amber"
            info="% dos alunos ativos com mensalidade em aberto." sub={`${formatNumber(inactiveMembers)} inadimplentes · EVO`} />
          <KPICard label="% Churn Mensal" value={`${churnPct.toFixed(2).replace('.', ',')}%`} icon={UserX} color="purple"
            info="Cancelamentos do mês ÷ base ativa. Alimenta o cálculo do LTV." sub={`${formatNumber(cancelamentos)} cancel. · base ${formatNumber(activeMembers)}`} />
          <KPICard label="Retenção" value={`${retentionRate}%`} icon={BarChart2} color="primary"
            info="% dos alunos ativos que estão em dia (adimplentes)." sub="Adimplentes ÷ ativos" />
        </div>
      </section>

      {/* ═══ Visão Regional ═══ */}
      {canSeeMetaRegional && (
        <section className="mb-20">
          <SectionHeader title="Visão Regional" subtitle="Consolidado da rede" borderColor="border-l-[#141414]" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <KPICard label="LTV Regional" value={ltv > 0 ? brl(ltv) : '—'} icon={TrendingUp} color="accent" sub={`${avgLifetimeMonths} meses de vida média`} />
            <KPICard label="Receita Regional (MRR)" value={brl(mrr)} icon={DollarSign} color="primary" sub={`${formatNumber(activeMembers)} alunos × ticket`} />
            <KPICard label="Retenção Regional" value={`${retentionRate}%`} icon={BarChart2} color="blue" sub="Adimplentes ÷ ativos" />
          </div>
        </section>
      )}

      {/* ═══ Resumo Estratégico ═══ */}
      <motion.div
        initial={{ y: 20, opacity: 0 }} whileInView={{ y: 0, opacity: 1 }} viewport={{ once: true }}
        className="p-10 bg-gradient-to-br from-primary to-[#3a0f06] rounded-[4rem] text-white relative overflow-hidden mb-12"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/3 rounded-full -mr-32 -mt-32 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-accent/10 rounded-full -ml-24 -mb-24 blur-3xl" />
        <div className="relative z-10">
          <h3 className="text-[2rem] font-black mb-8 tracking-tight">Resumo Estratégico</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div>
              <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.2em] mb-2">Base Total</p>
              <p className="text-[2rem] font-black">{isLoading ? '—' : formatNumber(totalMembers)}</p>
            </div>
            <div>
              <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.2em] mb-2">Alunos Ativos</p>
              <p className="text-[2rem] font-black text-accent">{isLoading ? '—' : formatNumber(activeMembers)}</p>
            </div>
            <div>
              <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.2em] mb-2">MRR Projetado</p>
              <p className="text-[2rem] font-black">{brl(mrr)}</p>
            </div>
            <div>
              <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.2em] mb-2">Evasão</p>
              <p className="text-[2rem] font-black text-rose-400">{evasionRate.toFixed(2).replace('.', ',')}%</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Nota */}
      <div className="p-6 bg-emerald-50/50 border border-emerald-100 rounded-2xl flex gap-4 text-[13px]">
        <Eye size={20} className="text-emerald-500 shrink-0 mt-0.5" />
        <div>
          <p className="font-black text-emerald-800 mb-1">Tudo automático</p>
          <p className="text-emerald-700 font-medium leading-relaxed">
            Nenhum valor desta tela é digitado: membros, evasão, inadimplência, ticket, vendas e churn vêm da
            <strong> W12 EVO</strong>. Os indicadores de aquisição (investimento, leads, CPL, CAC, ROAS e o
            Mapa de Aquisição) ficam na aba <strong>Marketing</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
