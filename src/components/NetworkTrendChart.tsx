import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceDot, ReferenceLine, CartesianGrid,
} from 'recharts';
import { LineChart as LineChartIcon, Sparkles, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { aggregateHistoryByMonth, type EvoHistoryRow } from '../services/nocodbApi';
import { formatNumber, formatCompactBRL, formatBRL } from '../lib/format';
import {
  analyzeTrend, buildInsights, formatMonthShort,
  type MonthPoint, type MetricMeta, type Tone,
} from '../lib/trends';

/** Ponto do mês CORRENTE (ao vivo), já agregado pras unidades visíveis. */
export interface CurrentMonthPoint {
  month: string; // 'YYYY-MM'
  active_members: number;
  adimplentes: number;
  inadimplentes: number;
  faturamento_adimplentes: number;
  vendas_qtd: number;
  vendas_valor: number;
}

/** Valores do mês corrente de UMA unidade (pro modo "Por unidade"). */
export interface UnitMonthValues {
  active_members: number;
  adimplentes: number;
  inadimplentes: number;
  faturamento_adimplentes: number;
  vendas_qtd: number;
  vendas_valor: number;
}

interface Props {
  rows: EvoHistoryRow[];
  /** Unidades a incluir na agregação (filtro do Painel já resolvido). */
  includeUnits: string[];
  /** Mês corrente ao vivo — anexado como último ponto da série. */
  current: CurrentMonthPoint | null;
  loading?: boolean;
  /** Mês selecionado no filtro do Painel — destacado no gráfico (linha vertical). */
  selectedMonth?: string;
  /** Mês corrente POR UNIDADE (pro modo "Por unidade" incluir o mês ao vivo). */
  currentByUnit?: Record<string, UnitMonthValues>;
  /** Mostra a aba "Faturamento"? (toggle can_see_tendencia_faturamento — cotistas). Default true. */
  showFaturamento?: boolean;
  /** Mostra a aba "Vendas (R$)"? (reusa o toggle show_vendas_valor). Default true. */
  showVendasValor?: boolean;
}

type MetricId = 'ativos' | 'faturamento' | 'vendas' | 'vendas_qtd' | 'inadimplencia';

interface MetricConfig extends MetricMeta {
  id: MetricId;
  short: string;
  /** cor principal da série (hex). */
  color: string;
  /** métrica de contagem (formata como número, não como R$). */
  isCount?: boolean;
  /** extrai o valor de um agregado mensal. */
  pick: (m: { active_members: number; adimplentes: number; inadimplentes: number; faturamento_adimplentes: number; vendas_qtd: number; vendas_valor: number }) => number;
}

const METRICS: MetricConfig[] = [
  {
    id: 'ativos', label: 'Ativos', short: 'Ativos', color: '#141414',
    fmt: formatNumber, isCount: true, pick: m => m.active_members,
  },
  {
    id: 'faturamento', label: 'Faturamento Estimado', short: 'Faturamento', color: '#10b981',
    fmt: formatCompactBRL, pick: m => m.faturamento_adimplentes,
  },
  {
    id: 'vendas', label: 'Vendas (R$)', short: 'Vendas R$', color: '#fc3000',
    fmt: formatCompactBRL, pick: m => m.vendas_valor,
  },
  {
    id: 'vendas_qtd', label: 'Nº de Vendas', short: 'Nº Vendas', color: '#6366f1',
    fmt: formatNumber, isCount: true, pick: m => m.vendas_qtd,
  },
  {
    id: 'inadimplencia', label: '% Inadimplência', short: 'Inadimpl.', color: '#f43f5e',
    fmt: (n) => `${n.toFixed(2).replace('.', ',')}%`, lowerIsBetter: true, isPct: true,
    pick: m => (m.active_members > 0 ? (m.inadimplentes / m.active_members) * 100 : 0),
  },
];

// Paleta categórica colorblind-friendly (azul/laranja como par primário —
// evita depender de vermelho×verde) pro modo "Por unidade".
const UNIT_COLORS = ['#4C72B0', '#DD8452', '#55A868', '#C44E52', '#8172B3', '#0ea5e9', '#937860', '#e377c2'];

const TONE_CLASS: Record<Tone, string> = {
  good:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  bad:     'bg-rose-50 text-rose-700 border-rose-200',
  neutral: 'bg-slate-50 text-slate-600 border-slate-200',
};

export function NetworkTrendChart({ rows, includeUnits, current, loading, selectedMonth, currentByUnit, showFaturamento = true, showVendasValor = true }: Props) {
  const [metricId, setMetricId] = useState<MetricId>('ativos');
  // Visão: 'total' = rede agregada (área + tendência + projeção);
  //        'unidades' = uma linha POR UNIDADE, comparando a evolução por competência.
  const [viewMode, setViewMode] = useState<'total' | 'unidades'>('total');
  // Unidade em destaque no modo 'unidades' (clique no chip): as demais esmaecem.
  const [focusUnit, setFocusUnit] = useState<string | null>(null);
  // Abas visíveis conforme as permissões do usuário (ex.: cotista sem faturamento).
  const visibleMetrics = useMemo(
    () => METRICS.filter(m => {
      if (m.id === 'faturamento') return showFaturamento;
      if (m.id === 'vendas') return showVendasValor;
      return true;
    }),
    [showFaturamento, showVendasValor],
  );
  // Se a métrica selecionada ficou oculta (admin mudou o toggle), cai pra primeira visível.
  const metric = useMemo(
    () => visibleMetrics.find(m => m.id === metricId) ?? visibleMetrics[0],
    [visibleMetrics, metricId],
  );

  // Série mensal agregada (meses fechados) + mês corrente ao vivo no fim.
  const series = useMemo(() => {
    const agg = aggregateHistoryByMonth(rows, includeUnits);
    const months = [...agg];
    if (current && !months.some(m => m.month === current.month)) {
      months.push({
        month: current.month,
        active_members: current.active_members,
        adimplentes: current.adimplentes,
        inadimplentes: current.inadimplentes,
        faturamento_adimplentes: current.faturamento_adimplentes,
        vendas_qtd: current.vendas_qtd,
        vendas_valor: current.vendas_valor,
      });
    }
    return months;
  }, [rows, includeUnits, current]);

  // Pontos da métrica escolhida (mais antigo → mais recente).
  const points: MonthPoint[] = useMemo(
    () => series.map(m => ({ month: m.month, value: metric.pick(m) })),
    [series, metric],
  );

  const analysis = useMemo(() => (points.length >= 2 ? analyzeTrend(points) : null), [points]);
  const insights = useMemo(() => buildInsights(points, metric), [points, metric]);

  // Dados pro Recharts: valor real + linha de tendência + segmento projetado.
  const chartData = useMemo(() => {
    if (!analysis) return [];
    const base = points.map((p, i) => ({
      label: formatMonthShort(p.month),
      month: p.month,
      value: p.value,
      trend: analysis.trendline[i],
      projected: null as number | null,
      isCurrent: current ? p.month === current.month : false,
    }));
    if (analysis.projection !== null && base.length > 0) {
      // Conecta o último real ao ponto projetado via série tracejada separada.
      base[base.length - 1].projected = base[base.length - 1].value;
      base.push({
        label: '~próx',
        month: 'proj',
        value: null as unknown as number,
        trend: null as unknown as number,
        projected: analysis.projection,
        isCurrent: false,
      });
    }
    return base;
  }, [points, analysis, current]);

  const best = analysis?.best ?? null;
  const worst = analysis?.worst ?? null;
  const hasData = points.length >= 2;

  // ─── Série POR UNIDADE (modo 'unidades'): 1 linha por academia ────────────
  const unitChart = useMemo(() => {
    if (viewMode !== 'unidades') return { data: [] as Record<string, unknown>[], units: [] as string[], ranked: [] as { unit: string; last: number }[] };
    const monthsMap = new Map<string, Record<string, unknown>>();
    const ensure = (month: string) => {
      let o = monthsMap.get(month);
      if (!o) { o = { label: formatMonthShort(month), month }; monthsMap.set(month, o); }
      return o;
    };
    for (const r of rows) {
      if (r.period_kind !== 'monthly') continue;
      const unit = String(r.branch_name);
      if (!includeUnits.includes(unit)) continue;
      const month = String(r.snapshot_month);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      ensure(month)[unit] = metric.pick({
        active_members:          Number(r.active_members) || 0,
        adimplentes:             Number(r.adimplentes) || 0,
        inadimplentes:           Number(r.inadimplentes) || 0,
        faturamento_adimplentes: Number(r.faturamento_adimplentes) || 0,
        vendas_qtd:              Number(r.vendas_qtd) || 0,
        vendas_valor:            Number(r.vendas_valor) || 0,
      });
    }
    // Mês corrente ao vivo por unidade (não sobrescreve mês já importado).
    if (current && currentByUnit) {
      const o = ensure(current.month);
      for (const unit of includeUnits) {
        const v = currentByUnit[unit];
        if (v && o[unit] === undefined) o[unit] = metric.pick(v);
      }
    }
    const data = [...monthsMap.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)));
    const units = includeUnits.filter(u => data.some(o => o[u] !== undefined));
    // Ranking: último valor disponível de cada unidade (ordenado ↓) — vira a
    // legenda interativa com valor, no lugar da legenda padrão do recharts.
    const ranked = units
      .map(unit => {
        let last = 0;
        for (let i = data.length - 1; i >= 0; i--) {
          const v = data[i][unit];
          if (typeof v === 'number') { last = v; break; }
        }
        return { unit, last };
      })
      .sort((a, b) => (metric.lowerIsBetter ? a.last - b.last : b.last - a.last));
    return { data, units, ranked };
  }, [viewMode, rows, includeUnits, current, currentByUnit, metric]);

  // Foco só vale se a unidade ainda está visível no filtro atual.
  const focus = focusUnit && unitChart.units.includes(focusUnit) ? focusUnit : null;

  // Mês selecionado destacado (linha vertical) — só quando presente na série.
  const highlightLabel = useMemo(() => {
    if (!selectedMonth) return null;
    const inTotal = chartData.some(d => d.month === selectedMonth);
    const inUnits = unitChart.data.some(d => d.month === selectedMonth);
    return (viewMode === 'total' ? inTotal : inUnits) ? formatMonthShort(selectedMonth) : null;
  }, [selectedMonth, chartData, unitChart, viewMode]);

  return (
    <motion.section
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="mb-16"
      aria-label="Evolução da rede ao longo dos meses"
    >
      {/* Header da seção */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <LineChartIcon size={14} className="text-primary" />
            <span className="text-[10px] font-black text-primary uppercase tracking-[0.25em]">
              Evolução da Rede
            </span>
          </div>
          <h2 className="text-[1.4rem] sm:text-[1.75rem] font-black text-slate-900 leading-tight tracking-tighter">
            Tendência & Projeção
          </h2>
          <p className="text-[12px] font-medium text-slate-500 mt-1">
            {hasData
              ? (viewMode === 'unidades'
                  ? `Evolução por competência · ${unitChart.units.length} unidades · passe o mouse pra comparar`
                  : `${points.length} meses · linha tracejada = tendência · ponto final = projeção`)
              : 'Histórico mensal de cada métrica'}
          </p>
        </div>

        {/* Seletor de métrica + modo de visão */}
        <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
        <div role="tablist" aria-label="Métrica do gráfico" className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100/70 rounded-2xl shrink-0">
          {visibleMetrics.map(m => {
            const active = m.id === metric.id;
            return (
              <button
                key={m.id}
                role="tab"
                aria-selected={active}
                onClick={() => setMetricId(m.id)}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  active ? 'bg-white text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {m.short}
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="Modo de visão" className="flex items-center gap-1 p-1 bg-slate-100/70 rounded-2xl">
          {([['total', 'Rede'], ['unidades', 'Por unidade']] as const).map(([mode, lbl]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                viewMode === mode ? 'bg-white text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        </div>
      </div>

      <div className="card-base card-pad">
        {loading ? (
          <div className="h-[280px] w-full bg-slate-50 animate-pulse rounded-2xl" />
        ) : !hasData ? (
          <div className="h-[220px] flex flex-col items-center justify-center text-center gap-2 px-6">
            <Sparkles size={28} className="text-slate-300" />
            <p className="text-[14px] font-bold text-slate-600">Sem histórico suficiente ainda</p>
            <p className="text-[12px] text-slate-400 max-w-sm">
              São necessários pelo menos 2 meses. Um administrador pode preencher
              clicando em <strong>"Histórico"</strong> no topo do Painel pra sincronizar os últimos 12 meses do EVO.
            </p>
          </div>
        ) : viewMode === 'unidades' ? (
          /* ── Modo POR UNIDADE: evolução por competência, 1 linha por academia ── */
          <>
            {/* Legenda interativa RANQUEADA: chip = cor + unidade + valor atual.
                Clique destaca a unidade (demais esmaecem); clique de novo volta. */}
            <div className="flex flex-wrap items-center gap-1.5 mb-4" role="group" aria-label="Unidades (clique pra destacar)">
              {unitChart.ranked.map(({ unit, last }) => {
                const color = UNIT_COLORS[unitChart.units.indexOf(unit) % UNIT_COLORS.length];
                const isFocus = focus === unit;
                const dimmed = focus !== null && !isFocus;
                return (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={isFocus}
                    onClick={() => setFocusUnit(f => (f === unit ? null : unit))}
                    title={isFocus ? 'Clique pra ver todas de novo' : `Destacar ${unit}`}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-bold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      isFocus
                        ? 'border-transparent text-white shadow-sm'
                        : dimmed
                          ? 'bg-white border-slate-100 text-slate-300'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                    style={isFocus ? { background: color } : undefined}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: isFocus ? '#fff' : (dimmed ? '#cbd5e1' : color) }} />
                    {unit}
                    <span className={`font-black tabular-nums ${isFocus ? '' : dimmed ? 'text-slate-300' : 'text-slate-900'}`}>
                      {metric.fmt(last)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={unitChart.data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  {highlightLabel && (
                    <ReferenceLine x={highlightLabel} stroke="#141414" strokeDasharray="4 3" strokeOpacity={0.4} />
                  )}
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 700 }}
                    axisLine={{ stroke: '#e2e8f0' }}
                    tickLine={false}
                  />
                  <YAxis
                    width={48}
                    tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => metric.isPct ? `${Math.round(v)}%` : compactAxis(v)}
                  />
                  <Tooltip content={<UnitsTooltip metric={metric} units={unitChart.units} />} />
                  {unitChart.units.map((u, i) => {
                    const color = UNIT_COLORS[i % UNIT_COLORS.length];
                    const isFocus = focus === u;
                    const dimmed = focus !== null && !isFocus;
                    return (
                      <Line
                        key={u}
                        type="monotone"
                        dataKey={u}
                        name={u}
                        stroke={color}
                        strokeWidth={isFocus ? 3 : dimmed ? 1.5 : 2}
                        strokeOpacity={dimmed ? 0.18 : 1}
                        dot={dimmed ? false : { r: 2.5, fill: color, strokeWidth: 0 }}
                        activeDot={dimmed ? false : { r: 4 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    );
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <>
            {/* Gráfico */}
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
                  <defs>
                    <linearGradient id={`grad-${metric.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={metric.color} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={metric.color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  {highlightLabel && (
                    <ReferenceLine x={highlightLabel} stroke="#141414" strokeDasharray="4 3" strokeOpacity={0.4} />
                  )}
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 700 }}
                    axisLine={{ stroke: '#e2e8f0' }}
                    tickLine={false}
                  />
                  <YAxis
                    width={48}
                    tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => metric.isPct ? `${Math.round(v)}%` : compactAxis(v)}
                  />
                  <Tooltip content={<TrendTooltip metric={metric} />} />
                  {/* Área do valor real */}
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={metric.color}
                    strokeWidth={2.5}
                    fill={`url(#grad-${metric.id})`}
                    dot={{ r: 3, fill: metric.color, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  {/* Linha de tendência (regressão) */}
                  <Line
                    type="linear"
                    dataKey="trend"
                    stroke={metric.color}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    strokeOpacity={0.55}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                  {/* Segmento projetado */}
                  <Line
                    type="linear"
                    dataKey="projected"
                    stroke={metric.color}
                    strokeWidth={2}
                    strokeDasharray="2 3"
                    dot={{ r: 4, fill: '#fff', stroke: metric.color, strokeWidth: 2 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                  {/* Marcadores de pico / vale */}
                  {best && (
                    <ReferenceDot
                      x={formatMonthShort(best.month)} y={best.value}
                      r={4} fill="#10b981" stroke="#fff" strokeWidth={1.5}
                    />
                  )}
                  {worst && worst.month !== best?.month && (
                    <ReferenceDot
                      x={formatMonthShort(worst.month)} y={worst.value}
                      r={4} fill="#f43f5e" stroke="#fff" strokeWidth={1.5}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Resumo numérico + insights */}
            <div className="mt-5 pt-5 border-t border-slate-100">
              <TrendHeadline metric={metric} points={points} />
              {insights.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-4">
                  {insights.map((ins, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-bold ${TONE_CLASS[ins.tone]}`}
                    >
                      {ins.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </motion.section>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function TrendHeadline({ metric, points }: { metric: MetricConfig; points: MonthPoint[] }) {
  const last = points[points.length - 1]?.value ?? 0;
  const a = analyzeTrend(points);
  const mom = a.momPct;
  const Icon = mom === null || Math.abs(mom) < 0.05 ? Minus : mom > 0 ? TrendingUp : TrendingDown;
  // Tom da seta MoM considerando lowerIsBetter.
  const good = mom !== null && (metric.lowerIsBetter ? mom < 0 : mom > 0);
  const momColor = mom === null ? 'text-slate-400' : good ? 'text-emerald-600' : 'text-rose-600';
  const full = metric.isPct ? metric.fmt(last) : (metric.isCount ? formatNumber(last) : formatBRL(last));
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <p className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1">{metric.label} · mês atual</p>
        <p className="text-[2rem] font-black text-slate-900 leading-none tabular-nums" title={full}>
          {metric.fmt(last)}
        </p>
      </div>
      {mom !== null && (
        <div className={`inline-flex items-center gap-1.5 font-black tabular-nums ${momColor}`}>
          <Icon size={18} strokeWidth={2.75} />
          <span className="text-[15px]">
            {mom > 0 ? '+' : ''}{mom.toFixed(2).replace('.', ',')}%
          </span>
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">vs mês ant.</span>
        </div>
      )}
    </div>
  );
}

interface TooltipPayload { payload: { label: string; value: number | null; projected: number | null; isCurrent: boolean }; }
function TrendTooltip({ metric, active, payload }: { metric: MetricConfig; active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const val = p.value ?? p.projected;
  if (val === null || val === undefined) return null;
  const isProj = p.value === null && p.projected !== null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-0.5">
        {isProj ? 'Projeção' : p.label}{p.isCurrent ? ' · atual' : ''}
      </p>
      <p className="text-[15px] font-black text-slate-900 tabular-nums">{metric.fmt(val)}</p>
    </div>
  );
}

interface UnitsTooltipPayload {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
  payload?: { label?: string };
}
function UnitsTooltip({ metric, units, active, payload }: {
  metric: MetricConfig; units: string[]; active?: boolean; payload?: UnitsTooltipPayload[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const label = payload[0]?.payload?.label ?? '';
  const items = payload
    .filter(p => typeof p.value === 'number' && units.includes(String(p.dataKey)))
    .sort((a, b) => Number(b.value) - Number(a.value));
  if (items.length === 0) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">{label}</p>
      {items.map(p => (
        <p key={String(p.dataKey)} className="text-[12px] font-bold text-slate-700 tabular-nums flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: p.color }} />
          {String(p.dataKey)}: <span className="font-black">{metric.fmt(Number(p.value))}</span>
        </p>
      ))}
    </div>
  );
}

/** Eixo Y compacto: 1234 → "1,2k", 1500000 → "1,5M". */
function compactAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(Math.round(v));
}
