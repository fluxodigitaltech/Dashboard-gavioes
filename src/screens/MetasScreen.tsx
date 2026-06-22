import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Save, RefreshCw, Target, ShoppingBag, Users, DollarSign, AlertTriangle,
  CheckCircle2, ToggleLeft, ToggleRight, Sparkles, Smile, TrendingUp, TrendingDown, Megaphone,
} from 'lucide-react';
import { fetchReceivables, filterReceivablesByUnits, type ReceivablesData } from '../services/evoApi';
import { fetchKpis, saveKpisBulk, fetchComercialRange, getSession, canEditMetas as canEditMetasPerm, type ComercialDiarioRow } from '../services/nocodbApi';
import { MonthFilterBar } from '../components/MonthCalendarPopover';
import type { DashboardData } from '../App';

interface Props {
  data: DashboardData | null;
}

type MetaCategoria =
  | 'meta_vendas'
  | 'meta_vendas_receita'
  | 'meta_ativos'
  | 'meta_adimplentes'
  | 'meta_faturamento'
  | 'meta_inadimplentes'
  | 'meta_aulas_experimentais'
  | 'meta_evasao'
  | 'meta_nps'
  | 'meta_ltv'
  | 'meta_cac'
  | 'meta_leads';

interface MetaConfig {
  valor: number;       // valor da META (objetivo)
  valorReal?: number;  // valor REAL atual — só pra categorias com realSource='manual'.
                       //                    pras 'auto', vem do EVO em runtime.
  ativa: boolean;
}

type UnitMetas = Record<MetaCategoria, MetaConfig>;

interface MetaDef {
  key: MetaCategoria;
  label: string;
  description: string;
  icon: React.ElementType;
  lowerIsBetter: boolean;
  format: 'money' | 'count' | 'pct' | 'nps';
  /** 'auto' = real vem do EVO (vendas/ativos/etc); 'manual' = admin digita o real na própria tela */
  realSource: 'auto' | 'manual';
  accent: string;
  bg: string;
}

const META_DEFS: MetaDef[] = [
  // ── Operacionais (auto via EVO) ──────────────────────────────────────────
  { key: 'meta_vendas',         label: 'Meta de Vendas (Qtd)',   description: 'Qtd de matrículas novas no mês',     icon: ShoppingBag,   lowerIsBetter: false, format: 'count', realSource: 'auto',   accent: 'text-indigo-600', bg: 'bg-indigo-50' },
  { key: 'meta_vendas_receita', label: 'Meta de Vendas (R$)',    description: 'Receita das matrículas novas no mês', icon: DollarSign,   lowerIsBetter: false, format: 'money', realSource: 'auto',   accent: 'text-indigo-600', bg: 'bg-indigo-50' },
  { key: 'meta_ativos',         label: 'Meta de Ativos',         description: 'Qtd de membros com contrato em vigor', icon: Users,         lowerIsBetter: false, format: 'count', realSource: 'auto',   accent: 'text-blue-600',   bg: 'bg-blue-50' },
  { key: 'meta_adimplentes',    label: 'Meta de Adimplentes',    description: 'Qtd de membros adimplentes (em dia)', icon: CheckCircle2,  lowerIsBetter: false, format: 'count', realSource: 'auto',   accent: 'text-emerald-600',bg: 'bg-emerald-50' },
  { key: 'meta_faturamento',    label: 'Meta de Faturamento',    description: 'R$ recebido (receivable) no mês',     icon: DollarSign,    lowerIsBetter: false, format: 'money', realSource: 'auto',   accent: 'text-primary',    bg: 'bg-[#fde7e2]' },
  { key: 'meta_inadimplentes',  label: 'Meta de Inadimplência',  description: '% máxima de inadimplência (≤)',       icon: AlertTriangle, lowerIsBetter: true,  format: 'pct',   realSource: 'auto',   accent: 'text-rose-600',   bg: 'bg-rose-50' },
  { key: 'meta_evasao',         label: 'Meta de Evasão',         description: '% máxima de evasão (≤)',              icon: TrendingDown,  lowerIsBetter: true,  format: 'pct',   realSource: 'auto',   accent: 'text-rose-600',   bg: 'bg-rose-50' },
  // ── Marketing & Comercial (manual — admin entra real periodicamente) ──
  // Conversão de aula experimental usa dado AUTOMÁTICO da aba Comercial
  // (gb_comercial_diario): fecharam / compareceram do mês.
  { key: 'meta_aulas_experimentais', label: 'Aulas Experimentais', description: '% de conversão: aulas exp → matrícula', icon: Sparkles,    lowerIsBetter: false, format: 'pct',   realSource: 'auto', accent: 'text-violet-600', bg: 'bg-violet-50' },
  { key: 'meta_leads',          label: 'Leads (Marketing)',     description: 'Qtd de leads recebidos pela unidade',  icon: Megaphone,     lowerIsBetter: false, format: 'count', realSource: 'manual', accent: 'text-cyan-600',   bg: 'bg-cyan-50' },
  { key: 'meta_cac',            label: 'CAC',                   description: 'Custo de Aquisição (calculado nos KPIs)', icon: TrendingDown,  lowerIsBetter: true,  format: 'money', realSource: 'auto', accent: 'text-amber-600',  bg: 'bg-amber-50' },
  // ── Financeiro & Satisfação (manual) ──
  { key: 'meta_ltv',            label: 'LTV',                   description: 'Lifetime Value médio (calc. nos KPIs)', icon: TrendingUp,    lowerIsBetter: false, format: 'money', realSource: 'auto', accent: 'text-primary',    bg: 'bg-[#fde7e2]' },
  { key: 'meta_nps',            label: 'NPS',                   description: 'Net Promoter Score (-100 a 100)',       icon: Smile,         lowerIsBetter: false, format: 'nps',   realSource: 'manual', accent: 'text-pink-600',   bg: 'bg-pink-50' },
];

const emptyMetas = (): UnitMetas => {
  const out = {} as UnitMetas;
  for (const def of META_DEFS) out[def.key] = { valor: 0, valorReal: 0, ativa: false };
  return out;
};

function getCurrentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtMoney(v: number) {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtCount(v: number) {
  return v.toLocaleString('pt-BR');
}

function fmtPct(v: number) {
  return `${v.toFixed(2).replace('.', ',')}%`;
}

function fmtNps(v: number) {
  return v.toFixed(0); // -100 a 100
}

function fmtByFormat(v: number, format: 'money' | 'count' | 'pct' | 'nps'): string {
  if (format === 'money') return fmtMoney(v);
  if (format === 'pct')   return fmtPct(v);
  if (format === 'nps')   return fmtNps(v);
  return fmtCount(v);
}

// Texto CRU pra edição: sem separador de milhar, vírgula decimal. Usado
// enquanto o campo está focado pra não atrapalhar o cursor durante a digitação.
function numToEditText(v: number, format: MetaDef['format']): string {
  if (!v) return '';
  if (format === 'count') return String(Math.round(v));
  return String(v).replace('.', ',');
}

// Texto FORMATADO (bonito) pra exibir quando o campo NÃO está em foco.
function numToDisplayText(v: number, format: MetaDef['format']): string {
  if (!v) return '';
  if (format === 'count') return v.toLocaleString('pt-BR');
  if (format === 'nps')   return String(v).replace('.', ',');
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Campo numérico controlado que mantém o TEXTO digitado em estado local.
 *
 * Por quê: antes o input era controlado direto pelo número. Ao digitar "1,70"
 * o parseFloat virava 1.7 e o value re-renderizava como "1" — a vírgula sumia
 * na hora e era impossível inserir % quebrado (1,70%). Guardando o texto cru
 * enquanto o campo está focado, a vírgula e os zeros à direita sobrevivem; ao
 * sair do foco mostramos o número já formatado.
 *
 * Por formato: pct/money aceitam decimal (vírgula), nps aceita decimal E
 * negativo (-100 a 100), count só inteiro.
 */
function NumberField({
  value, onChange, format, disabled, readOnly, className, placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  format: MetaDef['format'];
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const allowDecimal = format !== 'count';
  const allowNeg = format === 'nps';
  // Texto local guarda só o que está sendo DIGITADO. Quando o campo não está
  // focado, exibimos o número da prop direto (sempre em sincronia com metas
  // carregadas / troca de unidade) — assim evitamos setState-em-effect.
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const display = focused ? text : numToDisplayText(value, format);

  return (
    <input
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={display}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      className={className}
      onFocus={() => { setText(numToEditText(value, format)); setFocused(true); }}
      onBlur={() => setFocused(false)}
      onChange={e => {
        // Mantém só dígitos, vírgula e ponto (e '-' à frente, se nps).
        let cleaned = e.target.value.replace(allowNeg ? /[^\d.,-]/g : /[^\d.,]/g, '');
        if (allowNeg) {
          const neg = cleaned.startsWith('-');
          cleaned = (neg ? '-' : '') + cleaned.replace(/-/g, '');
        }
        setText(cleaned); // preserva exatamente o que o usuário digitou ("1," / "1,7" / "1,70")
        if (allowDecimal) {
          // Aceita 80 / 80,5 / 1,70 / 17.034,56 → number. Vírgula = decimal,
          // ponto = milhar (só removido quando há vírgula no meio).
          const normalized = cleaned.includes(',')
            ? cleaned.replace(/\./g, '').replace(',', '.')
            : cleaned;
          const parsed = parseFloat(normalized);
          onChange(isNaN(parsed) ? 0 : parsed);
        } else {
          const parsed = parseInt(cleaned, 10);
          onChange(isNaN(parsed) ? 0 : parsed);
        }
      }}
    />
  );
}

/**
 * Indicador da meta:
 *  - higher is better (vendas/ativos/faturamento): atingiu se real >= meta
 *  - lower is better (inadimplentes): atingiu se real <= meta
 * Retorna pct (0-150+) e classe de cor.
 */
function calcStatus(real: number, meta: number, lowerIsBetter: boolean) {
  if (meta <= 0) return { pct: 0, status: 'neutral' as const, label: 'Meta não definida' };
  const ratio = real / meta;
  if (lowerIsBetter) {
    if (ratio <= 1.0) return { pct: Math.round(ratio * 100), status: 'great' as const, label: 'Dentro da meta' };
    if (ratio <= 1.2) return { pct: Math.round(ratio * 100), status: 'ok' as const,    label: 'Acima do limite' };
    return { pct: Math.round(ratio * 100), status: 'bad' as const,   label: 'Muito acima do limite' };
  }
  if (ratio >= 1.0) return { pct: Math.round(ratio * 100), status: 'great' as const, label: 'Atingida' };
  if (ratio >= 0.8) return { pct: Math.round(ratio * 100), status: 'ok' as const,    label: 'Próxima da meta' };
  return { pct: Math.round(ratio * 100), status: 'bad' as const,   label: 'Distante da meta' };
}

const STATUS_STYLES = {
  great:   { text: 'text-emerald-600', bg: 'bg-emerald-50', bar: 'bg-emerald-500',  ring: 'ring-emerald-200' },
  ok:      { text: 'text-amber-600',   bg: 'bg-amber-50',   bar: 'bg-amber-500',    ring: 'ring-amber-200' },
  bad:     { text: 'text-rose-600',    bg: 'bg-rose-50',    bar: 'bg-rose-500',     ring: 'ring-rose-200' },
  neutral: { text: 'text-slate-400',   bg: 'bg-slate-50',   bar: 'bg-slate-300',    ring: 'ring-slate-200' },
};

export function MetasScreen({ data }: Props) {
  const currentPeriod = getCurrentPeriod();
  // Mês selecionado (YYYY-MM). Metas ficam salvas por período no NocoDB, então
  // navegar pra um mês passado mostra as metas daquele mês (só leitura).
  const [period, setPeriod] = useState<string>(currentPeriod);
  const isHistoric = period < currentPeriod;
  // Edição de metas: admin OU usuário com a permissão can_edit_metas (liberada
  // por usuário na tela de Usuários). Demais veem em read-only. Mês passado =
  // sempre só leitura (não reescreve histórico sem querer).
  const canEditMetasPermFlag = (() => { const s = getSession(); return s ? canEditMetasPerm(s) : false; })();
  const canEditMetas = canEditMetasPermFlag && !isHistoric;
  // ⚠️ Importante: usar data.units (já filtrado pela matriz Página×Unidade
  // em App.tsx) em vez do UNITS global. Gestor da Altino só vê Altino.
  // Memo evita disparar useEffects que dependem desse array a cada re-render.
  const unitNames = useMemo(() => (data?.units ?? []).map(u => u.name), [data]);

  const [metas, setMetas] = useState<Record<string, UnitMetas>>(() => {
    const init: Record<string, UnitMetas> = {};
    for (const name of unitNames) init[name] = emptyMetas();
    return init;
  });

  const [unitFilter, setUnitFilter] = useState<string>('Todas');
  const [receivables, setReceivables] = useState<ReceivablesData | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMetas, setIsLoadingMetas] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [comercialMes, setComercialMes] = useState<ComercialDiarioRow[]>([]);

  // Quando user tem acesso a 1 unidade só, auto-seleciona ela.
  // Senão isAll=true ficaria em "modo rede" e gestor não conseguiria
  // editar suas próprias metas (toggle bloqueia em isAll).
  useEffect(() => {
    if (unitNames.length !== 1 || unitFilter !== 'Todas') return;
    // queueMicrotask difere o setState pra fora do body do effect.
    queueMicrotask(() => setUnitFilter(unitNames[0]));
  }, [unitNames, unitFilter]);

  // Carrega recebíveis (cache 15min, instantâneo se Financeiro/Unidades já carregaram).
  // Filtra pelas allowed_units do user — sem isso, meta_faturamento real puxaria
  // amount de unidades fora do escopo (perUnit.find roda na lista global).
  useEffect(() => {
    let cancelled = false;
    fetchReceivables()
      .then(r => {
        if (cancelled) return;
        setReceivables(filterReceivablesByUnits(r, unitNames));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [unitNames]);

  // Carrega dados do comercial diário do mês corrente — usado pra calcular
  // o REAL automático de meta_aulas_experimentais (= fecharam / compareceram).
  useEffect(() => {
    let cancelled = false;
    const today = new Date();
    const fromISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const toISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    fetchComercialRange(fromISO, toISO)
      .then(rows => { if (!cancelled) setComercialMes(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Carrega metas salvas do NocoDB — queueMicrotask difere o setIsLoadingMetas(true)
  // pra fora do effect body (anti-pattern set-state-in-effect).
  useEffect(() => {
    queueMicrotask(() => setIsLoadingMetas(true));
    fetchKpis()
      .then(kpis => {
        const periodKpis = kpis.filter(k => k.periodo === period);
        const validKeys = new Set(META_DEFS.map(d => d.key));
        // Dedup: kpis vêm ordenados por mais-recente-primeiro. Linhas duplicadas
        // de saves antigos ainda podem existir, então pegamos só a 1ª ocorrência
        // (= mais recente) de cada (unidade, categoria) e ignoramos as antigas.
        // Antes o loop sobrescrevia a cada iteração e a ANTIGA vencia — por isso
        // a meta recém-salva "sumia" no reload.
        const seen = new Set<string>();
        // Base SEMPRE vazia (não merge sobre o estado anterior): ao trocar de mês,
        // categorias sem meta salva no mês novo voltam a zero em vez de manter o
        // valor stale do mês anterior.
        const updated: Record<string, UnitMetas> = {};
        for (const name of unitNames) updated[name] = emptyMetas();
        for (const kpi of periodKpis) {
          if (!updated[kpi.unidade]) continue;
          const cat = kpi.categoria as MetaCategoria;
          if (!validKeys.has(cat)) continue;
          const dedupKey = `${kpi.unidade}|${cat}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          updated[kpi.unidade] = {
            ...updated[kpi.unidade],
            [cat]: {
              valor: kpi.meta,
              valorReal: Number(kpi.valor) || 0,    // valor real salvo (manual)
              ativa: (kpi.observacao ?? '').toLowerCase() === 'ativa',
            },
          };
        }
        setMetas(updated);
      })
      .catch(() => {})
      .finally(() => setIsLoadingMetas(false));
  }, [period, unitNames]);

  // ── Valores reais agregados pelo filtro ──
  const isAll = unitFilter === 'Todas';
  const filteredUnits = isAll ? (data?.units ?? []) : (data?.units ?? []).filter(u => u.name === unitFilter);

  const realVendas = filteredUnits.reduce((s, u) => s + (u.vendasMesQtd ?? 0), 0);
  const realVendasReceita = filteredUnits.reduce((s, u) => s + (u.vendasMesValor ?? 0), 0);
  const realAtivos = filteredUnits.reduce((s, u) => s + (u.activeMembers ?? 0), 0);
  const realAdimplentes = filteredUnits.reduce((s, u) => s + (u.adimplentesMembers ?? 0), 0);
  const realInadimplentes = filteredUnits.reduce((s, u) => s + (u.inadimplentesMembers ?? 0), 0);
  const realCancelamentos = filteredUnits.reduce((s, u) => s + (u.cancelamentosMes ?? 0), 0);
  const realFaturamento = isAll
    ? (receivables?.totalAmount ?? 0)
    : (receivables?.perUnit.find(p => p.unitName === unitFilter)?.amount ?? 0);
  // Inadimplência %: inadimplentes / ativos × 100. Cap em 100 só se houver ativos.
  const realInadimplenciaPct = realAtivos > 0 ? (realInadimplentes / realAtivos) * 100 : 0;
  // Evasão REAL %: cancelamentos do mês (W12 /api/v3/membermembership) / ativos × 100.
  // Não confundir com inadimplência — evasão = quem cancelou contrato, inad = atrasou pagamento.
  const realEvasaoPct = realAtivos > 0 ? (realCancelamentos / realAtivos) * 100 : 0;

  // Pra categorias 'manual' (NPS, LTV, CAC, Leads, Aulas exp), o real vem do
  // que o admin digitou e foi salvo no NocoDB (valorReal). Soma agregada quando
  // unitFilter='Todas', valor da unidade quando filtrado.
  function getRealManual(cat: MetaCategoria): number {
    if (!isAll) return metas[unitFilter]?.[cat]?.valorReal ?? 0;
    let total = 0;
    for (const name of unitNames) total += metas[name]?.[cat]?.valorReal ?? 0;
    // Pra NPS, fazer média simples (não soma)
    if (cat === 'meta_nps') {
      const validas = unitNames.filter(n => (metas[n]?.[cat]?.valorReal ?? 0) !== 0);
      return validas.length > 0 ? total / validas.length : 0;
    }
    return total;
  }

  // Conversão de aulas experimentais — auto via gb_comercial_diario (mês corrente).
  // Filtra pelo unitFilter atual (admin pode ver agregado, gestor vê só dele).
  const filteredCom = isAll
    ? comercialMes
    : comercialMes.filter(r => r.branch_name === unitFilter);
  const totalCompareceram = filteredCom.reduce((s, r) => s + (Number(r.compareceram) || 0), 0);
  const totalFecharam    = filteredCom.reduce((s, r) => s + (Number(r.fecharam) || 0), 0);
  const realConversaoAulaExp = totalCompareceram > 0
    ? (totalFecharam / totalCompareceram) * 100
    : 0;

  // CAC e LTV — auto a partir dos inputs persistidos pelo KPIsScreen no localStorage.
  // KPI keys: gb_kpi_mkt_investment, gb_kpi_sales_investment, gb_kpi_closed_sales,
  // gb_kpi_turnover, gb_kpi_avg_ticket. Quando admin atualiza no KPIs, Metas reflete.
  const readKpiNum = (key: string, fallback: number): number => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const n = Number(raw);
      return isFinite(n) ? n : fallback;
    } catch { return fallback; }
  };
  const kpiMktInv      = readKpiNum('gb_kpi_mkt_investment', 0);
  const kpiSalesInv    = readKpiNum('gb_kpi_sales_investment', 0);
  const kpiClosedSales = readKpiNum('gb_kpi_closed_sales', 0);
  const kpiTurnover    = readKpiNum('gb_kpi_turnover', 0);
  const kpiAvgTicket   = readKpiNum('gb_kpi_avg_ticket', 0);
  // CAC = (investimento mkt + vendas) / vendas fechadas
  const realCac = kpiClosedSales > 0 ? (kpiMktInv + kpiSalesInv) / kpiClosedSales : 0;
  // LTV = ticket médio × meses de vida (1/churn). Churn = turnover% / 100.
  const realLtv = (() => {
    if (kpiTurnover <= 0 || kpiAvgTicket <= 0) return 0;
    const monthlyChurnRate = kpiTurnover / 100;
    const avgLifetimeMonths = 1 / monthlyChurnRate;
    return avgLifetimeMonths * kpiAvgTicket;
  })();

  const realByCategoria: Record<MetaCategoria, number> = {
    meta_vendas:               realVendas,
    meta_vendas_receita:       realVendasReceita,
    meta_ativos:               realAtivos,
    meta_adimplentes:          realAdimplentes,
    meta_faturamento:          realFaturamento,
    meta_inadimplentes:        realInadimplenciaPct,
    meta_evasao:               realEvasaoPct,
    meta_aulas_experimentais:  realConversaoAulaExp,  // AUTO do comercial
    meta_nps:                  getRealManual('meta_nps'),    // sem fonte automática
    meta_ltv:                  realLtv,                       // AUTO dos KPIs
    meta_cac:                  realCac,                       // AUTO dos KPIs
    meta_leads:                getRealManual('meta_leads'),  // sem fonte automática
  };

  // ── Meta agregada pelo filtro (soma das metas das unidades filtradas) ──
  function getMetaAgregada(cat: MetaCategoria): MetaConfig {
    if (!isAll) return metas[unitFilter]?.[cat] ?? { valor: 0, ativa: false };
    let totalValor = 0;
    let temAtiva = false;
    for (const name of unitNames) {
      const m = metas[name]?.[cat];
      if (m && m.ativa) {
        totalValor += m.valor;
        temAtiva = true;
      }
    }
    return { valor: totalValor, ativa: temAtiva };
  }

  // ── Overview da rede por meta: lista de unidades com seu progresso individual ──
  // Em vez de comparar soma vs soma (confuso quando só algumas têm meta), mostramos
  // cada unidade isoladamente: quem atingiu sua meta, quem está perto, quem está longe.
  interface UnitProgress {
    unitName: string;
    real: number;
    meta: number;
    ativa: boolean;
    status: 'great' | 'ok' | 'bad' | 'neutral';
    pct: number;
    label: string;
  }
  function getNetworkOverview(cat: MetaCategoria, def: typeof META_DEFS[number]): {
    unitsAtingindo: number;
    unitsProximas: number;
    unitsDistantes: number;
    unitsComMeta: number;
    progresso: UnitProgress[];
  } {
    const progresso: UnitProgress[] = [];
    for (const name of unitNames) {
      const m = metas[name]?.[cat] ?? { valor: 0, ativa: false };
      const u = data?.units.find(x => x.name === name);
      let real = 0;
      // Categorias auto (vêm do EVO/receivables)
      if (cat === 'meta_vendas')          real = u?.vendasMesQtd ?? 0;
      if (cat === 'meta_vendas_receita')  real = u?.vendasMesValor ?? 0;
      if (cat === 'meta_ativos')          real = u?.activeMembers ?? 0;
      if (cat === 'meta_adimplentes')     real = u?.adimplentesMembers ?? 0;
      if (cat === 'meta_inadimplentes') {
        // Inadimplência agora em %: inadimplentes / total ativos.
        const total = u?.activeMembers ?? 0;
        const inad = u?.inadimplentesMembers ?? 0;
        real = total > 0 ? (inad / total) * 100 : 0;
      }
      if (cat === 'meta_faturamento')     real = receivables?.perUnit.find(p => p.unitName === name)?.amount ?? 0;
      if (cat === 'meta_evasao') {
        // Evasão REAL = cancelamentos do mês (W12) / ativos.
        const total = u?.activeMembers ?? 0;
        const canc = u?.cancelamentosMes ?? 0;
        real = total > 0 ? (canc / total) * 100 : 0;
      }
      // Conversão Aula Experimental: auto-calculada pela aba Comercial (mês corrente).
      if (cat === 'meta_aulas_experimentais') {
        const rows = comercialMes.filter(r => r.branch_name === name);
        const compar = rows.reduce((s, r) => s + (Number(r.compareceram) || 0), 0);
        const fech = rows.reduce((s, r) => s + (Number(r.fecharam) || 0), 0);
        real = compar > 0 ? (fech / compar) * 100 : 0;
      }
      // CAC e LTV: auto dos inputs do KPIs (localStorage). Por enquanto valor é
      // global da rede; quando admin tiver inputs por unidade, refinamos.
      if (cat === 'meta_cac') real = realCac;
      if (cat === 'meta_ltv') real = realLtv;
      // Categorias ainda manuais (sem fonte automática).
      if (cat === 'meta_nps' || cat === 'meta_leads') {
        real = m.valorReal ?? 0;
      }
      const { pct, status, label } = calcStatus(real, m.valor, def.lowerIsBetter);
      progresso.push({ unitName: name, real, meta: m.valor, ativa: m.ativa, status, pct, label });
    }
    return {
      unitsAtingindo: progresso.filter(p => p.ativa && p.status === 'great').length,
      unitsProximas:  progresso.filter(p => p.ativa && p.status === 'ok').length,
      unitsDistantes: progresso.filter(p => p.ativa && p.status === 'bad').length,
      unitsComMeta:   progresso.filter(p => p.ativa && p.meta > 0).length,
      progresso,
    };
  }

  // ── Update local (ainda não salvo) ──
  function handleChange(unitName: string, cat: MetaCategoria, patch: Partial<MetaConfig>) {
    setMetas(prev => ({
      ...prev,
      [unitName]: { ...prev[unitName], [cat]: { ...prev[unitName][cat], ...patch } },
    }));
  }

  function handleToggleCurrentUnit(cat: MetaCategoria) {
    if (isAll) return; // toggle só na visão de unidade
    const current = metas[unitFilter][cat];
    handleChange(unitFilter, cat, { ativa: !current.ativa });
  }

  // ── Salvar todas as metas no NocoDB ──
  async function handleSave() {
    if (!canEditMetas) {
      console.warn('[Metas] tentativa de salvar sem permissão de admin — ignorada');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      // Monta TODAS as metas (unidades × categorias) e grava em LOTE.
      // Antes era 1 request por linha (~84) em paralelo — o NocoDB derrubava a
      // maioria e, com Promise.allSettled, o erro era engolido: a tela dizia
      // "Salvo" mas nada persistia, então ao recarregar "sumia tudo".
      const payload = Object.entries(metas).flatMap(([unitName, unitMeta]) =>
        META_DEFS.map(def => {
          const m = unitMeta[def.key];
          return {
            nome:       def.label,
            // Categorias 'auto' têm valor real vindo do EVO em runtime — gravamos 0
            // (a comparação é em tempo real). 'manual' grava o que o admin digitou.
            valor:      def.realSource === 'manual' ? (m.valorReal ?? 0) : 0,
            meta:       m.valor,
            unidade:    unitName,
            categoria:  def.key,
            periodo:    period,
            observacao: m.ativa ? 'ativa' : 'inativa',
          };
        })
      );
      await saveKpisBulk(payload, period);
      setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      console.error('[Metas] save error:', e);
      setSaveError('Falha ao salvar as metas no servidor. Tente novamente.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* ── Header ── */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="mb-10">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">
          Planejamento Estratégico
        </span>
        <div className="flex items-end justify-between flex-wrap gap-6">
          <div>
            <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
              Metas <span className="text-accent">{period}</span>
            </h1>
            <p className="text-slate-400 text-[15px] font-semibold max-w-xl">
              {META_DEFS.length} metas estratégicas por unidade · ative/desative individualmente · acompanhe progresso em tempo real
            </p>
          </div>

          {/* Navegador de mês + Salvar (só mês corrente p/ quem edita). */}
          <div className="flex items-center gap-3 flex-wrap">
            <MonthFilterBar
              selectedMonth={period}
              isCurrent={!isHistoric}
              onPick={ym => setPeriod(ym > currentPeriod ? currentPeriod : ym)}
              onReset={() => setPeriod(currentPeriod)}
              legend="Mês passado = metas salvas (só leitura)"
            />
            {saveError ? (
              <span className="flex items-center gap-1.5 text-[12px] font-bold text-rose-600">
                <AlertTriangle size={14} /> {saveError}
              </span>
            ) : savedAt && (
              <span className="flex items-center gap-1.5 text-[12px] font-bold text-emerald-600">
                <CheckCircle2 size={14} /> Salvo às {savedAt}
              </span>
            )}
            {canEditMetas ? (
              <button
                onClick={handleSave}
                disabled={isSaving || isLoadingMetas}
                className="flex items-center gap-2 px-6 py-3 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[12px] font-black uppercase tracking-wider shadow-[0_8px_25px_rgba(15,60,35,0.2)] transition-all disabled:opacity-40"
              >
                {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                {isSaving ? 'Salvando…' : 'Salvar Metas'}
              </button>
            ) : (
              <span className="flex items-center gap-2 px-5 py-3 bg-slate-100 text-slate-500 rounded-2xl text-[11px] font-black uppercase tracking-wider">
                {isHistoric ? 'Mês passado · leitura' : 'Somente leitura'}
              </span>
            )}
          </div>
        </div>
      </motion.div>

      {/* ── Filtro de unidade — só pra users com 2+ unidades ── */}
      {unitNames.length > 1 ? (
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider mr-2">Unidade:</span>
          {(['Todas', ...unitNames]).map(name => (
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
      ) : unitNames.length === 1 && (
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
            Unidade: {unitNames[0]}
          </span>
        </div>
      )}

      {/* ── Cards grandes por meta ── */}
      {isLoadingMetas ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1,2,3,4].map(i => (
            <div key={i} className="h-72 rounded-[2.5rem] bg-slate-100 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {META_DEFS.map((def, i) => (
            <MetaCard
              key={def.key}
              def={def}
              meta={getMetaAgregada(def.key)}
              real={realByCategoria[def.key]}
              isAll={isAll}
              unitName={unitFilter}
              receivablesLoaded={receivables !== null}
              networkOverview={isAll ? getNetworkOverview(def.key, def) : undefined}
              onChange={(patch) => { if (!isAll && canEditMetas) handleChange(unitFilter, def.key, patch); }}
              onToggle={() => { if (canEditMetas) handleToggleCurrentUnit(def.key); }}
              readOnly={!canEditMetas}
              historic={isHistoric}
              onSelectUnit={(name) => setUnitFilter(name)}
              animationDelay={i * 0.05}
            />
          ))}
        </div>
      )}

      {/* ── Resumo por unidade quando "Todas" ── */}
      {isAll && !isLoadingMetas && (
        <motion.div
          initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.4, delay: 0.2 }}
          className="bg-white rounded-[2.5rem] border border-slate-100 overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.04)]"
        >
          <div className="px-8 py-5 border-b border-slate-100 bg-[#fafafa] flex items-center gap-3">
            <Sparkles size={16} className="text-accent" />
            <h2 className="text-[14px] font-black text-primary tracking-tight">Resumo por Unidade</h2>
            <span className="text-[11px] font-bold text-slate-400">selecione uma unidade no filtro pra editar</span>
          </div>
          <div className="divide-y divide-slate-50">
            {unitNames.map(unitName => {
              const u = data?.units?.find(x => x.name === unitName);
              if (!u) return null;
              const ativasCount = META_DEFS.filter(d => metas[unitName][d.key].ativa).length;
              return (
                <button
                  key={unitName}
                  onClick={() => setUnitFilter(unitName)}
                  className="w-full px-8 py-5 flex items-center justify-between hover:bg-[#fafafa] transition-colors group text-left"
                >
                  <div>
                    <p className="font-black text-[#0F172A] text-[14px]">{unitName}</p>
                    <p className="text-[11px] font-bold text-slate-400 mt-0.5">{u.location}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`text-[11px] font-black px-3 py-1 rounded-full ${ativasCount > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                      {ativasCount} de {META_DEFS.length} metas ativas
                    </span>
                    <span className="text-[12px] font-black text-primary group-hover:translate-x-1 transition-transform">
                      Editar →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ─── Card individual de meta ──────────────────────────────────────────────────
interface UnitProgress {
  unitName: string;
  real: number;
  meta: number;
  ativa: boolean;
  status: 'great' | 'ok' | 'bad' | 'neutral';
  pct: number;
  label: string;
}

interface NetworkOverview {
  unitsAtingindo: number;
  unitsProximas: number;
  unitsDistantes: number;
  unitsComMeta: number;
  progresso: UnitProgress[];
}

interface MetaCardProps {
  def: typeof META_DEFS[number];
  meta: MetaConfig;
  real: number;
  isAll: boolean;
  unitName: string;
  receivablesLoaded: boolean;
  networkOverview?: NetworkOverview;
  onChange: (patch: Partial<MetaConfig>) => void;
  onToggle: () => void;
  onSelectUnit: (name: string) => void;
  animationDelay: number;
  /** Quando true, oculta inputs/toggles de edição — usuário não pode salvar. */
  readOnly?: boolean;
  /** Mês passado: mostra só a meta salva, sem realizado/progresso (sem fonte histórica). */
  historic?: boolean;
}

function MetaCard({ def, meta, real, isAll, unitName, receivablesLoaded, networkOverview, onChange, onToggle, onSelectUnit, animationDelay, readOnly = false, historic = false }: MetaCardProps) {
  const Icon = def.icon;
  const isMoney = def.format === 'money';
  const fmt = (v: number) => fmtByFormat(v, def.format);
  const isLoadingReal = def.key === 'meta_faturamento' && !receivablesLoaded;

  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4, delay: animationDelay }}
      className={`bg-white rounded-[2rem] border border-slate-100 p-7 shadow-[0_4px_20px_rgba(0,0,0,0.03)] hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] transition-all ${!isAll && !meta.ativa ? 'opacity-70' : ''}`}
    >
      {/* Header: icon + label + toggle/badge */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 ${def.bg} rounded-2xl flex items-center justify-center`}>
            <Icon size={20} className={def.accent} strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-[12px] font-black text-slate-700 uppercase tracking-wider">{def.label}</p>
            <p className="text-[11px] font-semibold text-slate-400 mt-0.5">{def.description}</p>
          </div>
        </div>

        {!isAll ? (
          <button
            onClick={onToggle}
            disabled={readOnly}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${meta.ativa ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'} ${readOnly ? 'opacity-60 cursor-not-allowed hover:bg-emerald-50' : ''}`}
            title={readOnly ? 'Somente administradores podem alterar' : 'Liga ou desliga essa meta'}
          >
            {meta.ativa ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
            {meta.ativa ? 'Ativa' : 'Inativa'}
          </button>
        ) : (
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Rede</span>
        )}
      </div>

      {/* Valor real (atual) — em mês passado não há fonte histórica do realizado. */}
      <div className="mb-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">
          {historic ? 'Realizado (sem histórico)' : isAll ? 'Total da Rede (atual)' : 'Atual'}
        </p>
        <p className="text-[2.4rem] font-black text-[#0F172A] tracking-tighter leading-none tabular-nums">
          {historic || isLoadingReal ? '—' : fmt(real)}
        </p>
      </div>

      {/* ── MODO REDE: ranking de unidades ── */}
      {isAll && networkOverview ? (
        <NetworkRanking overview={networkOverview} def={def} onSelectUnit={onSelectUnit} historic={historic} />
      ) : (
        <UnitEditPanel
          meta={meta}
          real={real}
          unitName={unitName}
          def={def}
          isMoney={isMoney}
          fmt={fmt}
          onChange={onChange}
          readOnly={readOnly}
          historic={historic}
        />
      )}
    </motion.div>
  );
}

// ─── Painel de edição (modo unidade) ─────────────────────────────────────────
function UnitEditPanel({
  meta, real, unitName, def, isMoney, fmt, onChange, readOnly = false, historic = false,
}: {
  meta: MetaConfig;
  real: number;
  unitName: string;
  def: typeof META_DEFS[number];
  isMoney: boolean;
  fmt: (v: number) => string;
  onChange: (patch: Partial<MetaConfig>) => void;
  readOnly?: boolean;
  historic?: boolean;
}) {
  const { pct, status, label } = calcStatus(real, meta.valor, def.lowerIsBetter);
  const styles = STATUS_STYLES[status];

  const diff = meta.valor - real;
  const exceeded = def.lowerIsBetter ? real > meta.valor : real >= meta.valor;
  const faltaText = historic || !meta.ativa
    ? null
    : meta.valor === 0
      ? 'Defina um valor pra meta'
      : exceeded
        ? def.lowerIsBetter
          ? `${fmt(real - meta.valor)} acima do limite`
          : `${fmt(real - meta.valor)} acima da meta`
        : def.lowerIsBetter
          ? `${fmt(diff)} abaixo do limite`
          : `Faltam ${fmt(diff)}`;

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex-1">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">
            Meta · {unitName}
          </p>
          <div className="flex items-center gap-2">
            {isMoney && <span className="text-[16px] font-black text-slate-500">R$</span>}
            <NumberField
              value={meta.valor}
              onChange={(n) => onChange({ valor: n })}
              format={def.format}
              placeholder={def.format === 'pct' ? '0,0' : '0'}
              disabled={!meta.ativa || readOnly}
              readOnly={readOnly}
              className="flex-1 max-w-[220px] px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[18px] font-black text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 transition-all disabled:opacity-50 tabular-nums"
            />
            {def.format === 'pct' && <span className="text-[16px] font-black text-slate-500">%</span>}
            {def.format === 'nps' && <span className="text-[12px] font-bold text-slate-400">pts</span>}
          </div>
          {isMoney && meta.valor > 1000 && (
            <p className="text-[10px] font-medium text-slate-400 mt-1.5 ml-7 tabular-nums">
              = {meta.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          )}
        </div>

        <div className={`px-3 py-2 rounded-xl ${historic ? 'bg-slate-50 ring-slate-200' : `${styles.bg} ${styles.ring}`} ring-1`}>
          <p className={`text-[18px] font-black ${historic ? 'text-slate-400' : styles.text} tabular-nums leading-none`}>
            {!historic && meta.valor > 0 && meta.ativa ? `${pct}%` : '—'}
          </p>
        </div>
      </div>

      {/* Input de Valor REAL — só pra categorias 'manual' (NPS, Leads).
          Pras 'auto' o real vem das fontes apropriadas:
          - meta_aulas_experimentais → aba Comercial
          - meta_cac, meta_ltv → inputs persistidos no KPIs
          - meta_ativos, meta_vendas, etc → EVO direto */}
      {def.realSource === 'manual' && !historic && (
        <div className="mb-4 p-3 bg-amber-50/60 rounded-xl border border-amber-100">
          <p className="text-[10px] font-black text-amber-700 uppercase tracking-wider mb-1.5">
            Valor real (atualize manualmente — sem fonte automática)
          </p>
          <div className="flex items-center gap-2">
            {isMoney && <span className="text-[14px] font-black text-slate-500">R$</span>}
            <NumberField
              value={meta.valorReal ?? 0}
              onChange={(n) => onChange({ valorReal: n })}
              format={def.format}
              placeholder={def.format === 'pct' ? '0,0' : '0'}
              disabled={!meta.ativa || readOnly}
              readOnly={readOnly}
              className="flex-1 max-w-[160px] px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-[14px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30 transition-all disabled:opacity-50 tabular-nums"
            />
            <span className="text-[10px] font-bold text-slate-400">
              {def.format === 'pct' ? '%' : def.format === 'nps' ? 'pts' : ''}
            </span>
          </div>
        </div>
      )}

      <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden mb-3">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${pct}-${status}-${historic}`}
            initial={{ width: 0 }}
            animate={{ width: !historic && meta.valor > 0 && meta.ativa ? `${Math.min(pct, 100)}%` : '0%' }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className={`h-full rounded-full ${historic ? 'bg-slate-300' : styles.bar}`}
          />
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between gap-2 text-[12px]">
        {historic ? (
          <span className="font-bold text-slate-400">Meta salva deste mês · sem realizado</span>
        ) : meta.ativa ? (
          <span className={`font-black ${styles.text} flex items-center gap-1.5`}>
            <Target size={12} /> {label}
          </span>
        ) : (
          <span className="font-bold text-slate-400">Meta desativada</span>
        )}
        {faltaText && (
          <span className="text-[11px] font-bold text-slate-500 truncate">{faltaText}</span>
        )}
      </div>
    </>
  );
}

// ─── Ranking de unidades (modo rede) ─────────────────────────────────────────
function NetworkRanking({
  overview, def, onSelectUnit, historic = false,
}: {
  overview: NetworkOverview;
  def: typeof META_DEFS[number];
  onSelectUnit: (name: string) => void;
  historic?: boolean;
}) {
  const fmt = def.format === 'money' ? fmtMoney : fmtCount;

  // Ordena: ativas primeiro (atingindo > próximas > distantes), depois inativas
  const sorted = [...overview.progresso].sort((a, b) => {
    if (a.ativa !== b.ativa) return a.ativa ? -1 : 1;
    if (a.status === b.status) return b.pct - a.pct;
    const order = { great: 0, ok: 1, bad: 2, neutral: 3 };
    return order[a.status] - order[b.status];
  });

  return (
    <>
      {/* Resumo: chips de status. No histórico não há realizado → mostra só a
          contagem de unidades com meta salva (sem atingindo/próximas/distantes). */}
      {historic ? (
        <div className="flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-slate-50 border border-slate-100">
          <Target size={14} className="text-slate-400 shrink-0" />
          <p className="text-[12px] font-bold text-slate-500">
            {overview.unitsComMeta} de {overview.progresso.length} unidades com meta salva neste mês · sem realizado histórico
          </p>
        </div>
      ) : overview.unitsComMeta > 0 ? (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-black">
            <CheckCircle2 size={11} /> {overview.unitsAtingindo} atingindo
          </span>
          {overview.unitsProximas > 0 && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-[11px] font-black">
              <Target size={11} /> {overview.unitsProximas} próxima{overview.unitsProximas > 1 ? 's' : ''}
            </span>
          )}
          {overview.unitsDistantes > 0 && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 text-[11px] font-black">
              <AlertTriangle size={11} /> {overview.unitsDistantes} distante{overview.unitsDistantes > 1 ? 's' : ''}
            </span>
          )}
          <span className="text-[10px] font-bold text-slate-400 ml-auto">
            {overview.unitsComMeta} de 7 unidades com meta
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-slate-50 border border-slate-100">
          <Sparkles size={14} className="text-slate-400 shrink-0" />
          <p className="text-[12px] font-bold text-slate-500">
            Nenhuma unidade com meta ativa · clique numa unidade abaixo pra definir
          </p>
        </div>
      )}

      {/* Lista de unidades — clicáveis */}
      <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1 -mr-1">
        {sorted.map(u => {
          const styles = STATUS_STYLES[u.status];
          const showBar = !historic && u.ativa && u.meta > 0;
          return (
            <button
              key={u.unitName}
              onClick={() => onSelectUnit(u.unitName)}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-50 transition-colors group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-black text-[12px] text-[#0F172A] truncate group-hover:text-primary">
                  {u.unitName}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold text-slate-500 tabular-nums">
                    {historic ? (
                      u.meta > 0
                        ? <span className="text-slate-500">Meta {fmt(u.meta)}</span>
                        : <span className="text-slate-300">sem meta</span>
                    ) : (
                      <>
                        {fmt(u.real)}
                        {u.ativa && u.meta > 0 && (
                          <span className="text-slate-300"> / {fmt(u.meta)}</span>
                        )}
                      </>
                    )}
                  </span>
                  {!historic && (showBar ? (
                    <span className={`text-[11px] font-black tabular-nums ${styles.text}`}>
                      {u.pct}%
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">sem meta</span>
                  ))}
                </div>
              </div>
              {showBar && (
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(u.pct, 100)}%` }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                    className={`h-full rounded-full ${styles.bar}`}
                  />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
