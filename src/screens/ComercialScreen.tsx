import { useState, useEffect, useCallback, useMemo } from 'react';
import { MonthCalendarPopover } from '../components/MonthCalendarPopover';
import { LoadingBar } from '../components/ui/LoadingBar';
import { motion } from 'framer-motion';
import {
  Calendar, RefreshCw, Save, CheckCircle2, X, Sparkles, Phone,
  UserCheck, UserX, DollarSign, RotateCw, Target, Lock, Zap, ChevronRight,
} from 'lucide-react';
import {
  fetchComercialDoDia,
  fetchComercialRange,
  upsertComercialDiario,
  getSession,
  fetchComercialExpRange,
  triggerComercialExpBackfill,
  fetchComercialExpStatus,
  type ComercialDiarioRow,
  type ComercialExpRange,
  type ComercialExpStatus,
} from '../services/nocodbApi';
import {
  fetchEvoComercialAuto,
  fetchBranchEnrollmentsSingle,
  hasComercialCache,
  type ComercialAutoData,
  type ComercialLead,
} from '../services/evoApi';
import type { DashboardData } from '../App';

type AutoField = 'agendados' | 'compareceram' | 'faltaram' | 'reagendados' | 'fecharam';

const AUTO_FIELD_LABELS: Record<AutoField, string> = {
  agendados:    'Agendados',
  compareceram: 'Compareceram',
  faltaram:     'Faltaram',
  reagendados:  'Reagendados',
  fecharam:     'Fecharam',
};

function leadsForField(evo: ComercialAutoData | null, branchName: string, field: AutoField): ComercialLead[] {
  if (!evo) return [];
  const map = field === 'agendados'    ? evo.agendadosList
            : field === 'compareceram' ? evo.compareceramList
            : field === 'faltaram'     ? evo.faltaramList
            : field === 'reagendados'  ? evo.reagendadosList
            : evo.fecharamList;
  return map[branchName] ?? [];
}

/** Tipo do lead enriquecido com a unidade (usado no modal consolidado). */
type LeadWithBranch = ComercialLead & { _branch: string };

/** Agrega leads de múltiplas unidades, anexando o nome da unidade em cada um. */
function leadsForFieldAggregated(
  evo: ComercialAutoData | null,
  branches: string[],
  field: AutoField,
): LeadWithBranch[] {
  if (!evo) return [];
  const all: LeadWithBranch[] = [];
  for (const b of branches) {
    for (const l of leadsForField(evo, b, field)) {
      all.push({ ...l, _branch: b });
    }
  }
  return all;
}

function formatDateBr(input?: string): string {
  if (!input) return '—';
  // ISO: 2026-05-11T10:05:15 → 11/05 10:05
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (isoMatch) {
    const [, , mm, dd, hh, mi] = isoMatch;
    return hh ? `${dd}/${mm} ${hh}:${mi}` : `${dd}/${mm}`;
  }
  // dd/MM/yyyy → dd/MM
  const dmyMatch = input.match(/^(\d{2})\/(\d{2})\/\d{4}/);
  if (dmyMatch) return `${dmyMatch[1]}/${dmyMatch[2]}`;
  return input.slice(0, 10);
}

interface Props {
  data: DashboardData | null;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Perfis que podem editar os campos. Outros perfis têm acesso de visualização apenas.
// Marcelo (12/05/2026): "consultor de vendas e cood de vendas precisa conseguir editar".
// O role 'consultor' no AdminUsuariosScreen é "Consultor (de vendas)" pelo padrão da gavioes.
const ROLES_EDITORES = new Set(['admin', 'consultor', 'coord_vendas']);

function emptyRow(branchName: string, date: string): ComercialDiarioRow {
  return {
    branch_name: branchName,
    snapshot_date: date,
    agendados: 0,
    confirmados: 0,
    compareceram: 0,
    faltaram: 0,
    fecharam: 0,
    reagendados: 0,
  };
}

type ManualField = 'agendados' | 'confirmados' | 'compareceram' | 'faltaram' | 'fecharam' | 'reagendados';

export function ComercialScreen({ data }: Props) {
  const session = getSession();
  const userEmail = session?.email ?? '';
  const hasEditRole = ROLES_EDITORES.has(session?.role ?? '');

  // Unidades visíveis (já filtradas pela matriz de permissões em App.tsx)
  const allowedUnits = useMemo(() => (data?.units ?? []).map(u => u.name), [data]);

  const [startDate, setStartDate] = useState<string>(todayISO);
  const [endDate, setEndDate]     = useState<string>(todayISO);
  const isSingleDay = startDate === endDate;
  // Em modo período (range): edição desabilitada (só visualização agregada).
  // Em modo dia único: edição liberada pra quem tem permissão.
  const canEdit = hasEditRole && isSingleDay;
  const date = startDate; // alias pra retrocompat com fetchEvo/upsert que só aceitam 1 dia
  const [unitFilter, setUnitFilter] = useState<string>('Todas');
  const [loading, setLoading] = useState(false);

  // Agendados, Confirmados, Compareceram, Faltaram, Reagendados: lançados manualmente.
  // Fecharam: vem automaticamente do EVO (Status=CLIENTE AND DtConversao=data) via
  // /api/v2/management/prospects. Se a central ajustou manualmente (row já no
  // NocoDB), o valor do NocoDB prevalece sobre o auto do EVO.
  const [rows, setRows] = useState<Record<string, ComercialDiarioRow>>({});
  const [evoData, setEvoData] = useState<ComercialAutoData | null>(null);
  const [savingUnit, setSavingUnit] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Unidades sendo sincronizadas com EVO no momento (mostra spinner)
  const [syncingBranches, setSyncingBranches] = useState<Set<string>>(new Set());

  // Modal de drilldown: clique em um número auto-EVO abre a lista de leads.
  // branch=null significa "consolidado de todas unidades visíveis"
  const [drillDown, setDrillDown] = useState<{ branch: string | null; field: AutoField } | null>(null);

  // ─── Aulas Experimentais (EVO, salvo no NocoDB) — visão do MÊS ──────────────
  const [expRange, setExpRange] = useState<ComercialExpRange | null>(null);
  const [expRecalc, setExpRecalc] = useState<ComercialExpStatus | null>(null);
  // O painel sempre mostra o MÊS do endDate (inclui dias futuros já reservados).
  const expBounds = useMemo(() => {
    const ym = endDate.slice(0, 7);
    const [yy, mm] = ym.split('-').map(Number);
    const last = new Date(yy, mm, 0).getDate();
    return { ym, from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
  }, [endDate]);

  useEffect(() => {
    let cancel = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const range = await fetchComercialExpRange(expBounds.from, expBounds.to);
      if (cancel) return;
      setExpRange(range);
      const st = await fetchComercialExpStatus();
      if (cancel) return;
      setExpRecalc(st && st.running ? st : null);
      if (range?.backfilling || st?.running) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { cancel = true; if (timer) clearTimeout(timer); };
  }, [expBounds]);

  const recalcularExp = async () => {
    setExpRecalc({ running: true, month: expBounds.ym, total: 0, done: 0, unidade: '' });
    await triggerComercialExpBackfill(expBounds.ym, true); // force=true → re-escaneia tudo (inclui dias passados)
    const poll = async () => {
      const st = await fetchComercialExpStatus();
      setExpRecalc(st && st.running ? st : null);
      if (st?.running) setTimeout(poll, 3000);
      else setExpRange(await fetchComercialExpRange(expBounds.from, expBounds.to));
    };
    setTimeout(poll, 1500);
  };

  const buildRows = useCallback((existingByUnit: Record<string, ComercialDiarioRow>, evo: ComercialAutoData | null): Record<string, ComercialDiarioRow> => {
    const map: Record<string, ComercialDiarioRow> = {};
    for (const u of allowedUnits) {
      const existing = existingByUnit[u];
      if (existing) {
        map[u] = {
          ...existing,
          agendados:    existing.agendados    || (evo?.agendados[u]    ?? 0),
          compareceram: existing.compareceram || (evo?.compareceram[u] ?? 0),
          faltaram:     existing.faltaram     || (evo?.faltaram[u]     ?? 0),
          reagendados:  existing.reagendados  || (evo?.reagendados[u]  ?? 0),
          fecharam:     existing.fecharam     || (evo?.fecharam[u]     ?? 0),
        };
      } else {
        map[u] = {
          ...emptyRow(u, ''),
          agendados:    evo?.agendados[u]    ?? 0,
          compareceram: evo?.compareceram[u] ?? 0,
          faltaram:     evo?.faltaram[u]     ?? 0,
          reagendados:  evo?.reagendados[u]  ?? 0,
          fecharam:     evo?.fecharam[u]     ?? 0,
        };
      }
    }
    return map;
  }, [allowedUnits]);

  // Carga inicial: NocoDB (manual) + Fecharam EVO + cache existente. NÃO faz
  // varredura de sessions automática (era o que engargalava com 429). Pra puxar
  // Agendados/Compareceram/Faltaram/Reagendados, user clica no botão "Sync EVO"
  // por unidade.
  //
  // Quando startDate === endDate: comportamento original (1 dia, edita/salva).
  // Quando diferente: agrega o range (soma os valores por unidade), modo
  // só-leitura — não dá pra editar/salvar/syncar pra um intervalo de dias.
  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    try {
      const singleDay = start === end;
      if (singleDay) {
        // Modo dia único: NocoDB (manual da central) + cache de Agendados/Comp/Falt/Reag
        // do EVO (só se já foi feito Sync). Fecharam virou MANUAL também (Marcelo
        // 13/05/2026: "O fecharam ele disse que ta errado, pode deixar manual tbm").
        const list = await fetchComercialDoDia(start);
        const existingByUnit: Record<string, ComercialDiarioRow> = {};
        for (const r of list) existingByUnit[r.branch_name] = r;

        const evo = await fetchEvoComercialAuto(start, []); // [] = só cache
        // Não usa mais auto do Fecharam — zera tanto o número quanto a lista
        // (lista alimentava o drilldown modal). Marcelo 13/05/2026: o auto pegava
        // cadastros Totalpass como "Fecharam" (Fernanda Azuma, Rafael Bezzon...)
        // que NÃO são conversões reais, só registros automáticos do parceiro.
        for (const u of Object.keys(evo.fecharam))     evo.fecharam[u]     = 0;
        for (const u of Object.keys(evo.fecharamList)) evo.fecharamList[u] = [];

        setRows(buildRows(existingByUnit, evo));
        setEvoData(evo);
      } else {
        // Modo período: soma valores de comercial_diario por unidade no range.
        // Fecharam fica zerado (Marcelo: só quer analisar números do que foi lançado pela central).
        const rows = await fetchComercialRange(start, end);
        const aggByUnit: Record<string, ComercialDiarioRow> = {};
        for (const u of allowedUnits) {
          aggByUnit[u] = { ...emptyRow(u, ''), snapshot_date: `${start}..${end}` };
        }
        for (const r of rows) {
          const agg = aggByUnit[r.branch_name];
          if (!agg) continue;
          agg.agendados    += Number(r.agendados)    || 0;
          agg.confirmados  += Number(r.confirmados)  || 0;
          agg.compareceram += Number(r.compareceram) || 0;
          agg.faltaram     += Number(r.faltaram)     || 0;
          agg.fecharam     += Number(r.fecharam)     || 0;
          agg.reagendados  += Number(r.reagendados)  || 0;
        }
        setRows(aggByUnit);
        setEvoData(null); // sem auto-EVO em modo período
      }
    } catch (e) {
      console.error('[Comercial] load error:', e);
    } finally {
      setLoading(false);
    }
  }, [allowedUnits, buildRows]);

  useEffect(() => {
    // queueMicrotask difere o setLoading(true) síncrono interno de load()
    // pra fora do body do effect (anti-pattern set-state-in-effect).
    queueMicrotask(() => { load(startDate, endDate); });
  }, [startDate, endDate, load]);

  /**
   * Botão "Sync EVO" / "Atualizar EVO": dispara varredura de UMA unidade (~1min).
   * `force=true` quando já tem cache (botão Atualizar) → ignora cache e re-puxa.
   */
  async function syncBranchEvo(branchName: string, force = false) {
    if (syncingBranches.has(branchName)) return;
    setSyncingBranches(prev => new Set(prev).add(branchName));
    try {
      const data = await fetchBranchEnrollmentsSingle(date, branchName, force);
      // Re-busca NocoDB + Fecharam pra ter o evo completo atualizado
      const list = await fetchComercialDoDia(date);
      const existingByUnit: Record<string, ComercialDiarioRow> = {};
      for (const r of list) existingByUnit[r.branch_name] = r;

      // Atualiza evoData com os novos dados desta unidade
      setEvoData(prev => {
        const next: ComercialAutoData = prev ? { ...prev } : {
          agendados: {}, compareceram: {}, faltaram: {}, reagendados: {}, fecharam: {},
          agendadosList: {}, compareceramList: {}, faltaramList: {}, reagendadosList: {}, fecharamList: {},
          fetchedAt: Date.now(), hasError: false,
        };
        next.agendados[branchName]    = data.agendados;
        next.compareceram[branchName] = data.compareceram;
        next.faltaram[branchName]     = data.faltaram;
        next.reagendados[branchName]  = data.reagendados;
        next.agendadosList[branchName]    = data.agendadosList;
        next.compareceramList[branchName] = data.compareceramList;
        next.faltaramList[branchName]     = data.faltaramList;
        next.reagendadosList[branchName]  = data.reagendadosList;
        setRows(buildRows(existingByUnit, next));
        return next;
      });
    } catch (e) {
      console.error(`[Comercial] sync ${branchName} error:`, e);
    } finally {
      setSyncingBranches(prev => {
        const next = new Set(prev);
        next.delete(branchName);
        return next;
      });
    }
  }

  function patchRow(branchName: string, patch: Partial<ComercialDiarioRow>) {
    setRows(prev => ({ ...prev, [branchName]: { ...prev[branchName], ...patch } }));
  }

  async function saveRow(branchName: string) {
    const row = rows[branchName] ?? emptyRow(branchName, date);
    setSavingUnit(branchName);
    try {
      await upsertComercialDiario({
        branch_name:  branchName,
        snapshot_date: date,
        agendados:    Number(row.agendados)    || 0,
        confirmados:  Number(row.confirmados)  || 0,
        compareceram: Number(row.compareceram) || 0,
        faltaram:     Number(row.faltaram)     || 0,
        fecharam:     Number(row.fecharam)     || 0,
        reagendados:  Number(row.reagendados)  || 0,
        notes:        row.notes,
        updated_by:   userEmail,
      });
      setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      console.error('[Comercial] save error:', e);
    } finally {
      setSavingUnit(null);
    }
  }

  const filteredUnits = useMemo(
    () => allowedUnits.filter(u => unitFilter === 'Todas' || u === unitFilter),
    [allowedUnits, unitFilter],
  );

  const totals = useMemo(() => {
    return filteredUnits.reduce(
      (acc, u) => {
        const row = rows[u] ?? emptyRow(u, date);
        return {
          agendados:    acc.agendados    + (Number(row.agendados)    || 0),
          confirmados:  acc.confirmados  + (Number(row.confirmados)  || 0),
          compareceram: acc.compareceram + (Number(row.compareceram) || 0),
          faltaram:     acc.faltaram     + (Number(row.faltaram)     || 0),
          fecharam:     acc.fecharam     + (Number(row.fecharam)     || 0),
          reagendados:  acc.reagendados  + (Number(row.reagendados)  || 0),
        };
      },
      { agendados: 0, confirmados: 0, compareceram: 0, faltaram: 0, fecharam: 0, reagendados: 0 },
    );
  }, [filteredUnits, rows, date]);

  const conversaoPct     = totals.compareceram > 0 ? (totals.fecharam    / totals.compareceram) * 100 : 0;
  const presencaPct      = totals.agendados    > 0 ? (totals.compareceram / totals.agendados)   * 100 : 0;
  const reagendamentoPct = totals.agendados    > 0 ? (totals.reagendados  / totals.agendados)   * 100 : 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 lg:py-10">
      <LoadingBar active={loading} label="Carregando dados comerciais" />

      {/* Header */}
      <motion.div
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="mb-8"
      >
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-black text-primary uppercase tracking-[0.25em]">Painel Gaviões</span>
              <span className="w-1 h-1 rounded-full bg-slate-300" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Aulas Experimentais</span>
            </div>
            <h1 className="text-[1.75rem] sm:text-[2.2rem] xl:text-[2.8rem] font-black text-slate-900 leading-tight tracking-tighter mb-1 flex items-center gap-3">
              <span className="w-11 h-11 rounded-2xl bg-cyan-100 text-cyan-600 flex items-center justify-center">
                <Sparkles size={22} strokeWidth={2.5} />
              </span>
              Comercial
            </h1>
            <p className="text-[12px] font-medium text-slate-400">
              {isSingleDay ? (
                <>Todos os campos preenchidos pela <span className="font-black text-blue-600">Central de Vendas</span>. Pra estimar Agendados/Compareceram/Faltaram/Reagendados via EVO como referência, clique no botão <span className="font-black text-emerald-600">Sync EVO</span> dela na tabela — o valor manual que a central lançar é o que vale e fica salvo.</>
              ) : (
                <>Modo <span className="font-black text-cyan-600">período agregado</span> ({startDate} → {endDate}): mostra a soma dos valores lançados pela central no intervalo. Edição/Sync EVO desabilitados — pra editar, volte pra um único dia.</>
              )}
              {savedAt && (
                <span className="ml-2 inline-flex items-center gap-1 text-emerald-600 font-bold">
                  <CheckCircle2 size={12} /> Salvo às {savedAt}
                </span>
              )}
            </p>
          </div>

          {/* Date range picker + atalhos + refresh */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => load(startDate, endDate)}
                disabled={loading}
                title="Recarregar dados"
                className="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-cyan-600 hover:border-cyan-300 transition-colors shadow-sm disabled:opacity-50"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <div className="flex items-center gap-2 px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-[11px] font-bold text-slate-600 shadow-sm">
                <Calendar size={13} className="text-primary shrink-0" />
                <MonthCalendarPopover
                  month={endDate.slice(0, 7)}
                  onPick={ym => {
                    const [y, m] = ym.split('-').map(Number);
                    const last = new Date(y, m, 0).getDate();
                    const today = todayISO();
                    setStartDate(`${ym}-01`);
                    setEndDate(ym === today.slice(0, 7) ? today : `${ym}-${String(last).padStart(2, '0')}`);
                  }}
                  buttonTitle="Escolher um mês inteiro no calendário"
                  buttonClassName="px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider text-primary hover:bg-primary/5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Mês
                </MonthCalendarPopover>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => {
                    const v = e.target.value;
                    setStartDate(v);
                    if (v > endDate) setEndDate(v); // mantém endDate >= startDate
                  }}
                  className="bg-transparent text-[12px] font-bold text-slate-700 focus:outline-none cursor-pointer"
                  title="Data inicial"
                />
                <span className="text-slate-400 font-bold">→</span>
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="bg-transparent text-[12px] font-bold text-slate-700 focus:outline-none cursor-pointer"
                  title="Data final"
                />
                {(startDate !== todayISO() || endDate !== todayISO()) && (
                  <button
                    type="button"
                    onClick={() => { setStartDate(todayISO()); setEndDate(todayISO()); }}
                    title="Voltar pra hoje"
                    className="ml-1 w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>
            {/* Atalhos de período */}
            <div className="flex items-center gap-1.5 text-[10px] font-bold">
              {([
                { label: 'Hoje',         start: 0,  end: 0 },
                { label: 'Ontem',        start: 1,  end: 1 },
                { label: '7 dias',       start: 6,  end: 0 },
                { label: '30 dias',      start: 29, end: 0 },
                { label: 'Este mês',     start: 'monthStart' as const, end: 0 },
              ]).map(p => {
                const apply = () => {
                  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                  const now = new Date();
                  const e = new Date(now); e.setDate(now.getDate() - (typeof p.end === 'number' ? p.end : 0));
                  const s = new Date(now);
                  if (p.start === 'monthStart') s.setDate(1);
                  else s.setDate(now.getDate() - p.start);
                  setStartDate(fmt(s));
                  setEndDate(fmt(e));
                };
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={apply}
                    className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-500 hover:text-cyan-600 hover:border-cyan-300 transition-colors uppercase tracking-wider"
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Filtro por unidade */}
      {allowedUnits.length > 1 ? (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider mr-2">Unidade:</span>
          {(['Todas', ...allowedUnits]).map(name => (
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
      ) : allowedUnits.length === 1 && (
        <div className="mb-6">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 text-primary rounded-full text-[11px] font-black uppercase tracking-wider">
            Unidade: {allowedUnits[0]}
          </span>
        </div>
      )}

      {/* Cards principais */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {[
          { label: 'Agendados',    value: totals.agendados,    icon: Calendar,   color: 'text-cyan-600',    bg: 'bg-cyan-50',    badge: 'evo' as const,     autoField: 'agendados'    as AutoField | undefined },
          { label: 'Confirmados',  value: totals.confirmados,  icon: Phone,      color: 'text-blue-600',    bg: 'bg-blue-50',    badge: 'central' as const, autoField: undefined },
          { label: 'Compareceram', value: totals.compareceram, icon: UserCheck,  color: 'text-emerald-600', bg: 'bg-emerald-50', badge: 'evo' as const,     autoField: 'compareceram' as AutoField | undefined },
          { label: 'Faltaram',     value: totals.faltaram,     icon: UserX,      color: 'text-rose-600',    bg: 'bg-rose-50',    badge: 'evo' as const,     autoField: 'faltaram'     as AutoField | undefined },
          { label: 'Fecharam',     value: totals.fecharam,     icon: DollarSign, color: 'text-primary',     bg: 'bg-[#fde7e2]',  badge: 'central' as const, autoField: undefined },
          { label: 'Reagendados',  value: totals.reagendados,  icon: RotateCw,   color: 'text-amber-600',   bg: 'bg-amber-50',   badge: 'evo' as const,     autoField: 'reagendados'  as AutoField | undefined },
        ].map(({ label, value, icon: Icon, color, bg, badge, autoField }) => {
          // Card é clicável quando: tem autoField + ao menos 1 lead em alguma filteredUnit
          const clickable = !!autoField && filteredUnits.some(u => leadsForField(evoData, u, autoField).length > 0);
          const onClick = clickable
            ? () => setDrillDown({
                branch: unitFilter === 'Todas' ? null : unitFilter,
                field: autoField!,
              })
            : undefined;
          return (
            <div
              key={label}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={onClick}
              onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
              className={`bg-white rounded-2xl p-4 border border-slate-200/60 shadow-sm relative transition-all ${
                clickable ? 'cursor-pointer hover:shadow-md hover:border-emerald-300 hover:-translate-y-0.5' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider leading-tight">{label}</p>
                <div className={`w-7 h-7 rounded-lg ${bg} ${color} flex items-center justify-center shrink-0`}>
                  <Icon size={13} strokeWidth={2.5} />
                </div>
              </div>
              {loading ? (
                <div className="w-10 h-8 bg-slate-100 animate-pulse rounded" />
              ) : (
                <p className={`text-[1.8rem] font-black ${color} tabular-nums leading-none`}>{value}</p>
              )}
              {badge === 'evo' && (
                <span className="absolute bottom-2 right-3 text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-0.5">
                  <Zap size={8} />EVO
                </span>
              )}
              {badge === 'central' && (
                <span className="absolute bottom-2 right-3 text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-0.5">
                  <Lock size={8} />Central
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Taxas */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-10">
        {[
          { label: 'Conversão',    value: conversaoPct,    sub: 'fecharam / compareceram',  tone: conversaoPct >= 30 ? 'emerald' : conversaoPct >= 15 ? 'amber' : 'rose' },
          { label: 'Presença',     value: presencaPct,     sub: 'compareceram / agendados', tone: presencaPct >= 70 ? 'emerald' : presencaPct >= 50 ? 'amber' : 'rose' },
          { label: 'Reagendamento',value: reagendamentoPct,sub: 'reagendados / agendados',  tone: reagendamentoPct <= 15 ? 'emerald' : reagendamentoPct <= 30 ? 'amber' : 'rose' },
        ].map(({ label, value, sub, tone }) => {
          const txt = tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-rose-600';
          const bg  = tone === 'emerald' ? 'bg-emerald-50'    : tone === 'amber' ? 'bg-amber-50'    : 'bg-rose-50';
          return (
            <div key={label} className={`rounded-2xl p-5 border border-slate-200/60 shadow-sm ${bg}`}>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Target size={11} /> {label}
              </p>
              <p className={`text-[2.2rem] font-black ${txt} tabular-nums leading-none mb-1`}>
                {value.toFixed(2).replace('.', ',')}<span className="text-[1rem] ml-0.5">%</span>
              </p>
              <p className="text-[10px] font-medium text-slate-400">{sub}</p>
            </div>
          );
        })}
      </div>

      {/* Tabela por unidade */}
      <div className="bg-white rounded-3xl border border-slate-200/60 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-black text-slate-900">Por unidade</h3>
            {loading && <RefreshCw size={13} className="animate-spin text-slate-400" />}
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1 text-slate-400 font-bold">
              <Zap size={11} className="text-emerald-500" /> Auto (EVO)
            </span>
            <span className="flex items-center gap-1 text-slate-400 font-bold">
              <Lock size={11} className="text-blue-400" /> Lançado pela central
            </span>
            {!canEdit && (
              <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full font-black">
                Somente visualização
              </span>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50/50 text-[10px] font-black text-slate-400 uppercase tracking-wider">
                <th className="px-6 py-3 text-left">Unidade</th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Zap size={9} className="text-emerald-500" />Agend.</span>
                </th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Lock size={9} className="text-blue-400" />Conf.</span>
                </th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Zap size={9} className="text-emerald-500" />Compar.</span>
                </th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Zap size={9} className="text-emerald-500" />Faltar.</span>
                </th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Zap size={9} className="text-emerald-500" />Fechar.</span>
                </th>
                <th className="px-3 py-3 text-center">
                  <span className="flex items-center justify-center gap-1"><Zap size={9} className="text-emerald-500" />Reagen.</span>
                </th>
                <th className="px-3 py-3 text-center">Conv.</th>
                <th className="px-6 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {allowedUnits.map(name => {
                const row = rows[name] ?? emptyRow(name, date);
                const compar = Number(row.compareceram) || 0;
                const fech   = Number(row.fecharam)     || 0;
                const conv   = compar > 0 ? (fech / compar) * 100 : 0;

                const ManualCell = ({ field, autoField }: { field: ManualField; autoField?: AutoField }) => {
                  const leadsCount = autoField ? leadsForField(evoData, name, autoField).length : 0;
                  const showLensBtn = autoField && leadsCount > 0;
                  return (
                    <td className="px-3 py-3">
                      <div className="relative w-16 mx-auto">
                        {canEdit ? (
                          <input
                            type="number"
                            min={0}
                            value={row[field] ?? 0}
                            onChange={e => patchRow(name, { [field]: Math.max(0, Number(e.target.value) || 0) })}
                            className="w-full block text-center py-1.5 px-2 bg-slate-50 border border-slate-200 rounded-lg text-[14px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300/50 transition-all tabular-nums"
                          />
                        ) : (
                          <div className="w-full flex items-center justify-center py-1.5 px-2 bg-slate-50 border border-slate-100 rounded-lg text-[14px] font-black text-slate-500 tabular-nums">
                            {Number(row[field]) || 0}
                          </div>
                        )}
                        {showLensBtn && (
                          <button
                            type="button"
                            onClick={() => setDrillDown({ branch: name, field: autoField! })}
                            title={`Ver ${leadsCount} ${AUTO_FIELD_LABELS[autoField!].toLowerCase()}`}
                            className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition-colors shadow-sm"
                          >
                            <ChevronRight size={10} strokeWidth={3} />
                          </button>
                        )}
                      </div>
                    </td>
                  );
                };

                return (
                  <tr key={name} className="hover:bg-slate-50/40 transition-colors">
                    <td className="px-6 py-3">
                      <p className="text-[13px] font-black text-slate-800">{name}</p>
                    </td>
                    <ManualCell field="agendados"    autoField="agendados" />
                    <ManualCell field="confirmados" />
                    <ManualCell field="compareceram" autoField="compareceram" />
                    <ManualCell field="faltaram"     autoField="faltaram" />
                    <ManualCell field="fecharam" />
                    <ManualCell field="reagendados"  autoField="reagendados" />
                    <td className="px-3 py-3 text-center">
                      <span className={`text-[12px] font-black tabular-nums ${conv >= 30 ? 'text-emerald-600' : conv >= 15 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {conv.toFixed(2).replace('.', ',')}%
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {(() => {
                          const isSyncing = syncingBranches.has(name);
                          const hasCache  = hasComercialCache(date, name);
                          return (
                            <button
                              type="button"
                              onClick={() => syncBranchEvo(name, hasCache)}
                              disabled={isSyncing}
                              title={hasCache ? 'Re-puxar dados frescos do EVO (~1min, descarta cache)' : 'Puxar Agendados / Compareceram / Faltaram / Reagendados do EVO (~1min)'}
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-colors disabled:opacity-50 ${
                                hasCache
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-emerald-500 text-white hover:bg-emerald-600'
                              }`}
                            >
                              {isSyncing
                                ? <><RefreshCw size={11} className="animate-spin" /> Sincronizando</>
                                : <><Zap size={11} /> {hasCache ? 'Atualizar EVO' : 'Sync EVO'}</>}
                            </button>
                          );
                        })()}
                        {canEdit && (
                          <button
                            onClick={() => saveRow(name)}
                            disabled={savingUnit === name}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-[10px] font-black uppercase tracking-wider hover:bg-[#0a0a0a] transition-colors disabled:opacity-50"
                          >
                            {savingUnit === name
                              ? <><RefreshCw size={11} className="animate-spin" /> Salvando</>
                              : <><Save size={11} /> Salvar</>}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {allowedUnits.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-slate-400 text-sm font-medium">
                    Nenhuma unidade disponível para você.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Aulas Experimentais (EVO) — agregado do período, salvo no NocoDB */}
      {expRange?.enabled && (() => {
        const empty = { agendados: 0, compareceram: 0, faltaram: 0, reagendados: 0, dias: 0, completos: 0 };
        const expUnits = filteredUnits.map(u => ({ name: u, ...(expRange.byUnit[u] ?? empty) }));
        const tot = expUnits.reduce((a, u) => ({
          agendados: a.agendados + u.agendados,
          compareceram: a.compareceram + u.compareceram,
          faltaram: a.faltaram + u.faltaram,
          reagendados: a.reagendados + u.reagendados,
          dias: a.dias + u.dias,
          completos: a.completos + u.completos,
        }), { ...empty });
        const busy = expRange.backfilling || !!expRecalc?.running;
        const pctJob = expRecalc && expRecalc.total > 0 ? Math.round((expRecalc.done / expRecalc.total) * 100) : 0;
        return (
          <div className="mt-10 bg-white rounded-3xl border border-slate-200/60 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-xl bg-cyan-50 text-cyan-600 flex items-center justify-center"><Sparkles size={15} strokeWidth={2.5} /></span>
                <div>
                  <h3 className="text-[14px] font-black text-slate-900 leading-tight">Aulas Experimentais &middot; EVO</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    M&ecirc;s {expBounds.ym} &middot; inclui dias futuros j&aacute; reservados &middot; salvo no NocoDB
                  </p>
                </div>
              </div>
              <button
                onClick={recalcularExp}
                disabled={busy}
                title="Recalcula o m&ecirc;s inteiro na EVO &mdash; inclusive dias passados e futuros"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider bg-cyan-600 text-white hover:bg-cyan-700 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
                {busy ? (expRecalc ? `Recalculando ${pctJob}%` : 'Atualizando...') : 'Recalcular mês'}
              </button>
            </div>
            {busy && (
              <div className="px-6 pt-3">
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-500 transition-all" style={{ width: `${pctJob || 8}%` }} />
                </div>
                {expRecalc?.unidade && <p className="text-[10px] font-bold text-slate-400 mt-1">Varredura EVO: {expRecalc.unidade}</p>}
              </div>
            )}
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {expUnits.map(u => (
                <div key={u.name} className="rounded-2xl border border-slate-200/60 p-4">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-[13px] font-black text-slate-800 truncate">{u.name}</p>
                    <span className="text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-0.5"><Zap size={8} />EVO</span>
                  </div>
                  <div className="flex items-end gap-2 mb-2">
                    <span className="text-[1.9rem] font-black text-cyan-600 tabular-nums leading-none">{u.agendados}</span>
                    <span className="text-[10px] font-bold text-slate-400 pb-1">agendados</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500">
                    <span className="text-emerald-600">{u.compareceram} comp.</span>
                    <span className="text-rose-500">{u.faltaram} falt.</span>
                    <span className="text-amber-600">{u.reagendados} reag.</span>
                  </div>
                  <p className="text-[9px] font-medium text-slate-400 mt-2">{u.completos}/{u.dias} dias varridos</p>
                </div>
              ))}
            </div>
            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/40 flex items-center justify-between text-[11px] font-bold text-slate-500">
              <span>Total do per&iacute;odo</span>
              <span className="tabular-nums text-cyan-700 font-black">{tot.agendados} agendados &middot; {tot.compareceram} comp &middot; {tot.faltaram} falt &middot; {tot.reagendados} reag</span>
            </div>
          </div>
        );
      })()}

      {/* Legenda */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-slate-500 font-medium">
        <div className="px-4 py-3 bg-blue-50/60 rounded-xl border border-blue-100 flex items-start gap-2">
          <Lock size={13} className="text-blue-400 shrink-0 mt-0.5" />
          <span>
            <strong className="text-slate-700">Central de Vendas:</strong> Todos os campos (Agendados, Confirmados, Compareceram, Faltaram, Fecharam, Reagendados) são preenchidos manualmente pelo Consultor/Coord. de Vendas. É o valor que prevalece e fica salvo.
          </span>
        </div>
        <div className="px-4 py-3 bg-emerald-50/60 rounded-xl border border-emerald-100 flex items-start gap-2">
          <Zap size={13} className="text-emerald-500 shrink-0 mt-0.5" />
          <span>
            <strong className="text-slate-700">Sync EVO (opcional):</strong> botão na linha de cada unidade que puxa uma estimativa do EVO de Agendados/Compareceram/Faltaram/Reagendados — útil pra comparar com o que a central lançou. O valor manual sempre prevalece.
          </span>
        </div>
      </div>

      {/* Modal de drilldown — lista os leads que compõem o número de um campo auto-EVO */}
      {drillDown && (() => {
        // branch=null → agrega de todas filteredUnits. Senão → só daquela unidade.
        const isConsolidated = drillDown.branch === null;
        const branchesToShow = isConsolidated ? filteredUnits : [drillDown.branch!];
        const leads = leadsForFieldAggregated(evoData, branchesToShow, drillDown.field);
        const fieldLabel = AUTO_FIELD_LABELS[drillDown.field];
        const titleSubject = isConsolidated
          ? (filteredUnits.length === allowedUnits.length ? 'Todas unidades' : `${filteredUnits.length} unidades`)
          : drillDown.branch;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
            onClick={() => setDrillDown(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl max-w-4xl w-full max-h-[80vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{titleSubject} · {date.split('-').reverse().join('/')}</p>
                  <h3 className="text-[18px] font-black text-slate-900 flex items-center gap-2">
                    <Zap size={16} className="text-emerald-500" />
                    {fieldLabel}: {leads.length}
                  </h3>
                </div>
                <button
                  onClick={() => setDrillDown(null)}
                  className="w-9 h-9 flex items-center justify-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                {leads.length === 0 ? (
                  <div className="px-6 py-12 text-center text-slate-400 text-sm font-medium">
                    Nenhum registro nesse campo {isConsolidated ? 'nas unidades visíveis' : `em ${drillDown.branch}`} nesse dia.
                  </div>
                ) : (
                  <table className="w-full text-left">
                    <thead className="sticky top-0 bg-slate-50/95 backdrop-blur">
                      <tr className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                        <th className="px-6 py-3 text-left">Nome</th>
                        {isConsolidated && <th className="px-3 py-3 text-left">Unidade</th>}
                        <th className="px-3 py-3 text-left">Cadastro</th>
                        {drillDown.field !== 'fecharam' && <th className="px-3 py-3 text-left">Acesso</th>}
                        <th className="px-3 py-3 text-left">{drillDown.field === 'fecharam' ? 'Contrato' : 'Plano'}</th>
                        <th className="px-3 py-3 text-right">ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {leads.map((l, i) => (
                        <tr key={`${l._branch}-${l.kind}-${l.id}-${i}`} className="hover:bg-slate-50/60">
                          <td className="px-6 py-3">
                            <p className="text-[13px] font-black text-slate-800">{l.name || '(sem nome)'}</p>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{l.kind === 'member' ? 'Cliente/Member' : 'Prospect'}</p>
                          </td>
                          {isConsolidated && (
                            <td className="px-3 py-3 text-[12px] font-black text-slate-700">{l._branch}</td>
                          )}
                          <td className="px-3 py-3 text-[12px] font-bold text-slate-600 tabular-nums">{formatDateBr(l.registerDate)}</td>
                          {drillDown.field !== 'fecharam' && (
                            <td className="px-3 py-3 text-[12px] font-bold tabular-nums">
                              {l.lastAccessDate
                                ? <span className="text-emerald-600">{formatDateBr(l.lastAccessDate)}</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                          )}
                          <td className="px-3 py-3 text-[12px] font-bold text-slate-600">{l.membership ?? '—'}</td>
                          <td className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 tabular-nums">{l.id || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </motion.div>
          </div>
        );
      })()}
    </div>
  );
}
