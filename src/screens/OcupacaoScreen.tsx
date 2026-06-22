import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, RefreshCw, AlertCircle, Calendar, LayoutGrid, Users } from 'lucide-react';
import {
  fetchClassOccupation,
  buildOccupationMatrix,
  type ClassOccupationData,
  type OccCell,
} from '../services/evoApi';
import { type DashboardData } from '../App';
import { LoadingBar } from '../components/ui/LoadingBar';
import { formatNumber } from '../lib/format';

interface Props {
  data: DashboardData | null;
}

// Dias da semana (0=Seg … 6=Dom — mesma convenção do serviço).
const WD_SHORT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const WD_LONG = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

/** Tom de cor pelas faixas de ocupação. */
function pctTone(pct: number): { bg: string; text: string; bar: string; border: string } {
  if (pct >= 90) return { bg: 'bg-rose-50',    text: 'text-rose-700',    bar: 'bg-rose-500',    border: 'border-rose-200' };
  if (pct >= 70) return { bg: 'bg-amber-50',   text: 'text-amber-700',   bar: 'bg-amber-500',   border: 'border-amber-200' };
  if (pct >= 40) return { bg: 'bg-emerald-50', text: 'text-emerald-700', bar: 'bg-emerald-500', border: 'border-emerald-200' };
  if (pct > 0)   return { bg: 'bg-sky-50',     text: 'text-sky-700',     bar: 'bg-sky-500',     border: 'border-sky-200' };
  return { bg: 'bg-slate-50', text: 'text-slate-500', bar: 'bg-slate-300', border: 'border-slate-200' };
}

const pctBig = (n: number) => `${n.toFixed(1).replace('.', ',')}%`;
const pctSmall = (n: number) => `${Math.round(n)}%`;
const fmtDM = (ymd: string) => (ymd ? ymd.split('-').slice(1).reverse().join('/') : '');

export function OcupacaoScreen({ data }: Props) {
  const [occ, setOcc] = useState<ClassOccupationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<string>('all');
  const [collectiveOnly, setCollectiveOnly] = useState(false);

  const refresh = (force = false) => {
    setLoading(true);
    fetchClassOccupation(force)
      .then(setOcc)
      .catch(err => console.error('[OcupacaoScreen] error:', err))
      .finally(() => setLoading(false));
  };

  // Fetch inicial (usa cache local / snapshot compartilhado → não bate na EVO à toa).
  useEffect(() => {
    fetchClassOccupation(false)
      .then(setOcc)
      .catch(err => console.error('[OcupacaoScreen] mount fetch error:', err));
  }, []);

  // Unidades visíveis (respeita matriz Página×Unidade — data.units já vem filtrado).
  const allowedKey = (data?.units ?? []).map(u => u.name).join('|');
  const visibleUnits = useMemo(() => {
    if (!occ) return [];
    const allowed = new Set((data?.units ?? []).map(u => u.name));
    // Se o dashboard ainda não carregou (sem units), mostra todas como fallback.
    return allowed.size === 0 ? occ.byUnit : occ.byUnit.filter(u => allowed.has(u.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occ, allowedKey]);

  // Unidade efetiva: se a selecionada deixou de ser visível (troca de permissão),
  // cai pra "Todas" — derivado em render (sem setState em efeito).
  const effectiveUnit = selectedUnit !== 'all' && !visibleUnits.some(u => u.name === selectedUnit)
    ? 'all'
    : selectedUnit;

  // Sessões no escopo selecionado (rede inteira ou 1 unidade).
  const scopedSessions = useMemo(() => {
    if (effectiveUnit === 'all') return visibleUnits.flatMap(u => u.sessions);
    return visibleUnits.find(u => u.name === effectiveUnit)?.sessions ?? [];
  }, [visibleUnits, effectiveUnit]);

  const matrix = useMemo(
    () => buildOccupationMatrix(scopedSessions, collectiveOnly),
    [scopedSessions, collectiveOnly],
  );

  // Resumo por unidade (pros cards quando "Todas" está selecionado).
  const unitSummaries = useMemo(() => {
    return visibleUnits
      .map(u => {
        const m = buildOccupationMatrix(u.sessions, collectiveOnly);
        const top = m.modalities[0];
        return {
          name: u.name,
          hasError: u.hasError,
          cap: m.grand.capacity,
          occ: m.grand.ocupation,
          pct: m.grand.pct,
          sessions: m.grand.sessions,
          top: top ?? null,
          topPct: top ? m.modalityTotals[top].pct : 0,
        };
      })
      .sort((a, b) => b.pct - a.pct);
  }, [visibleUnits, collectiveOnly]);

  const scopeLabel = effectiveUnit === 'all' ? 'Rede — todas as unidades' : effectiveUnit;
  const grand = matrix.grand;
  const grandTone = pctTone(grand.pct);
  const weekRange = occ?.weekStart
    ? `${fmtDM(occ.weekStart)}–${fmtDM(occ.weekEnd)}`
    : '';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 lg:py-10">
      <LoadingBar active={loading} label="Carregando ocupação das aulas" />

      {/* ── Header ── */}
      <motion.div
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="mb-7"
      >
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-black text-violet-600 uppercase tracking-[0.25em]">Painel Gaviões</span>
              <span className="w-1 h-1 rounded-full bg-slate-300" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Ocupação das aulas</span>
            </div>
            <h1 className="text-[1.75rem] sm:text-[2.2rem] xl:text-[2.8rem] font-black text-slate-900 leading-tight tracking-tighter mb-1 flex items-center gap-3">
              <span className="w-11 h-11 rounded-2xl bg-violet-100 text-violet-600 flex items-center justify-center">
                <Activity size={22} strokeWidth={2.5} />
              </span>
              Taxa de Ocupação
            </h1>
            <div className="flex items-center gap-2 text-[12px] font-medium text-slate-400 flex-wrap">
              <Calendar size={13} className="text-violet-500 shrink-0" />
              <span>
                {weekRange ? `Semana ${weekRange}` : 'Semana atual'}
                {' · '}
                {occ?.fetchedAt
                  ? `atualizado ${new Date(occ.fetchedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  : 'carregando…'}
                {' · modalidade × dia da semana'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
            <button
              onClick={() => setCollectiveOnly(v => !v)}
              title="Massagem (capacity 1) é atendimento individual. Ative para isolar só turmas coletivas."
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors shadow-sm border ${
                collectiveOnly
                  ? 'bg-violet-600 border-violet-600 text-white hover:bg-violet-700'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-violet-300 hover:text-violet-700'
              }`}
            >
              <Users size={13} />
              <span>Só coletivas</span>
            </button>
            <button
              onClick={() => refresh(true)}
              disabled={loading}
              title="Atualizar agora (consulta a EVO e republica para todos)"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700 transition-colors shadow-sm disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              <span>Atualizar</span>
            </button>
          </div>
        </div>

        {/* Seletor de unidade */}
        <div className="flex items-center gap-2 flex-wrap">
          <UnitPill label="Todas" active={effectiveUnit === 'all'} onClick={() => setSelectedUnit('all')} />
          {visibleUnits.map(u => (
            <UnitPill
              key={u.name}
              label={u.name}
              active={effectiveUnit === u.name}
              hasError={u.hasError}
              onClick={() => setSelectedUnit(u.name)}
            />
          ))}
        </div>
      </motion.div>

      {/* ── KPI agregado do escopo ── */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.05 }}
        className="bg-white border border-slate-200/60 rounded-3xl p-6 lg:p-7 mb-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">{scopeLabel}</p>
            <p className="text-[12px] font-medium text-slate-500">
              Ocupação média das aulas {collectiveOnly ? 'coletivas ' : ''}da semana ·{' '}
              {formatNumber(grand.sessions)} {grand.sessions === 1 ? 'aula' : 'aulas'}
            </p>
          </div>
          <div className={`shrink-0 px-3 py-1.5 rounded-xl text-[12px] font-black tabular-nums ${grandTone.bg} ${grandTone.text}`}>
            {grand.capacity > 0 ? pctBig(grand.pct) : '—'}
          </div>
        </div>
        {grand.capacity > 0 ? (
          <>
            <div className="flex items-end gap-3 mb-4">
              <h2 className="text-5xl lg:text-6xl font-black text-slate-900 tracking-tighter tabular-nums leading-none">
                {pctBig(grand.pct)}
              </h2>
              <p className="text-base font-bold text-slate-500 tabular-nums pb-2">
                {formatNumber(grand.ocupation)} / {formatNumber(grand.capacity)} vagas
              </p>
            </div>
            <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${grandTone.bar} transition-all duration-500`}
                style={{ width: `${Math.min(grand.pct, 100)}%` }}
              />
            </div>
          </>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-[13px] font-medium text-amber-800 leading-relaxed">
              {!occ
                ? 'Carregando agenda das unidades…'
                : 'Nenhuma aula com vagas configuradas neste escopo. A capacidade das turmas é definida em cada unidade dentro do W12 EVO.'}
            </div>
          </div>
        )}
      </motion.div>

      {/* ── Matriz modalidade × dia da semana ── */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="bg-white border border-slate-200/60 rounded-3xl p-5 lg:p-6 shadow-sm mb-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <LayoutGrid size={15} className="text-violet-500" />
          <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.15em]">
            Modalidades × dia da semana
          </span>
        </div>

        {!occ ? (
          <div className="py-12 text-center text-slate-400 text-sm font-medium">Carregando agenda…</div>
        ) : matrix.modalities.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-sm font-medium">
            Nenhuma aula {collectiveOnly ? 'coletiva ' : ''}encontrada para {scopeLabel.toLowerCase()} nesta semana.
          </div>
        ) : (
          <div className="overflow-x-auto scroll-contain -mx-1">
            <table className="w-full border-separate border-spacing-1 min-w-[640px]">
              <thead>
                <tr>
                  <th className="text-left px-2 py-2 sticky left-0 bg-white z-10">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Modalidade</span>
                  </th>
                  {matrix.weekdays.map(d => (
                    <th key={d} className="px-1 py-2 text-center" title={WD_LONG[d]}>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">{WD_SHORT[d]}</span>
                    </th>
                  ))}
                  <th className="px-1 py-2 text-center">
                    <span className="text-[10px] font-black text-violet-500 uppercase tracking-wider">Semana</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrix.modalities.map(m => {
                  const tot = matrix.modalityTotals[m];
                  const totTone = pctTone(tot.pct);
                  return (
                    <tr key={m}>
                      <td className="px-2 py-1 sticky left-0 bg-white z-10 max-w-[180px]">
                        <div className="flex flex-col gap-1">
                          <span className="text-[13px] font-black text-slate-800 truncate" title={m}>{m}</span>
                          <div className="h-1 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${totTone.bar}`} style={{ width: `${Math.min(tot.pct, 100)}%` }} />
                          </div>
                        </div>
                      </td>
                      {matrix.weekdays.map(d => (
                        <Cell key={d} c={matrix.cell[`${m}|${d}`]} dayName={WD_LONG[d]} modality={m} />
                      ))}
                      <td className="px-1 py-1">
                        <div className={`rounded-lg px-1.5 py-1.5 text-center border ${totTone.bg} ${totTone.border}`}
                             title={`${tot.ocupation}/${tot.capacity} vagas na semana · ${tot.sessions} aulas`}>
                          <div className={`text-[12px] font-black tabular-nums leading-none ${totTone.text}`}>{pctSmall(tot.pct)}</div>
                          <div className="text-[9px] font-bold text-slate-400 tabular-nums mt-0.5 leading-none">{tot.ocupation}/{tot.capacity}</div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="px-2 py-1 sticky left-0 bg-white z-10">
                    <span className="text-[11px] font-black text-slate-600 uppercase tracking-wider">Todas</span>
                  </td>
                  {matrix.weekdays.map(d => {
                    const dt = matrix.dayTotals[d];
                    const tone = pctTone(dt?.pct ?? 0);
                    return (
                      <td key={d} className="px-1 py-1">
                        <div className="rounded-lg px-1.5 py-1.5 text-center border border-slate-200 bg-slate-50"
                             title={dt ? `${dt.ocupation}/${dt.capacity} vagas · ${dt.sessions} aulas` : ''}>
                          <div className={`text-[12px] font-black tabular-nums leading-none ${tone.text}`}>{dt ? pctSmall(dt.pct) : '·'}</div>
                          {dt && <div className="text-[9px] font-bold text-slate-400 tabular-nums mt-0.5 leading-none">{dt.ocupation}/{dt.capacity}</div>}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-1 py-1">
                    <div className={`rounded-lg px-1.5 py-1.5 text-center ${grandTone.bg} border ${grandTone.border}`}>
                      <div className={`text-[12px] font-black tabular-nums leading-none ${grandTone.text}`}>{pctSmall(grand.pct)}</div>
                      <div className="text-[9px] font-bold text-slate-400 tabular-nums mt-0.5 leading-none">{grand.ocupation}/{grand.capacity}</div>
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Legenda */}
        <div className="flex items-center gap-3 flex-wrap mt-4 pt-4 border-t border-slate-100">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Faixa</span>
          <Legend tone="bg-sky-500" label="1–39%" />
          <Legend tone="bg-emerald-500" label="40–69%" />
          <Legend tone="bg-amber-500" label="70–89%" />
          <Legend tone="bg-rose-500" label="90%+" />
          <span className="text-[10px] font-medium text-slate-400">· célula = ocupados/vagas (soma das aulas no dia)</span>
        </div>
      </motion.div>

      {/* ── Por unidade (só quando "Todas") ── */}
      {effectiveUnit === 'all' && visibleUnits.length > 1 && (
        <motion.div
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.15em]">Por unidade</span>
            <span className="text-[11px] font-medium text-slate-400">
              ({unitSummaries.length} {unitSummaries.length === 1 ? 'unidade' : 'unidades'})
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {unitSummaries.map(u => {
              const tone = pctTone(u.pct);
              return (
                <button
                  key={u.name}
                  onClick={() => setSelectedUnit(u.name)}
                  className={`text-left bg-white border rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow ${u.hasError ? 'border-rose-200' : 'border-slate-200/60'}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${u.hasError ? 'bg-rose-400' : tone.bar}`} />
                      <h3 className="text-[14px] font-black text-slate-800 truncate">{u.name}</h3>
                    </div>
                    <div className={`shrink-0 px-2 py-1 rounded-lg text-[12px] font-black tabular-nums ${tone.bg} ${tone.text}`}>
                      {u.cap > 0 ? pctSmall(u.pct) : '—'}
                    </div>
                  </div>
                  {u.cap > 0 ? (
                    <>
                      <div className="flex items-end gap-2 mb-2">
                        <span className="text-2xl font-black text-slate-900 tabular-nums leading-none">{pctBig(u.pct)}</span>
                        <span className="text-[11px] font-bold text-slate-500 tabular-nums pb-0.5">
                          {formatNumber(u.occ)}/{formatNumber(u.cap)} · {u.sessions} aulas
                        </span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden mb-2">
                        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(u.pct, 100)}%` }} />
                      </div>
                      {u.top && (
                        <p className="text-[11px] font-medium text-slate-400 truncate">
                          Top: <span className="font-black text-slate-600">{u.top}</span> ({pctSmall(u.topPct)})
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-[12px] font-medium text-slate-400 leading-relaxed">
                      {u.hasError ? 'Erro ao consultar esta unidade.' : 'Sem aulas com capacidade configurada.'}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
}

/** Célula da matriz: % grande + ocupados/vagas pequeno, com tom por faixa. */
function Cell({ c, dayName, modality }: { c?: OccCell; dayName: string; modality: string }) {
  if (!c || c.sessions === 0) {
    return (
      <td className="px-1 py-1 text-center">
        <span className="text-slate-300 text-sm">·</span>
      </td>
    );
  }
  const t = pctTone(c.pct);
  return (
    <td className="px-1 py-1">
      <div
        className={`rounded-lg px-1.5 py-1.5 text-center border ${t.bg} ${t.border}`}
        title={`${modality} · ${dayName}: ${c.ocupation}/${c.capacity} vagas · ${c.sessions} ${c.sessions === 1 ? 'aula' : 'aulas'}`}
      >
        <div className={`text-[12px] font-black tabular-nums leading-none ${t.text}`}>{pctSmall(c.pct)}</div>
        <div className="text-[9px] font-bold text-slate-400 tabular-nums mt-0.5 leading-none">{c.ocupation}/{c.capacity}</div>
      </div>
    </td>
  );
}

function UnitPill({ label, active, hasError, onClick }: { label: string; active: boolean; hasError?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12px] font-black tracking-tight transition-colors border ${
        active
          ? 'bg-primary text-white border-primary shadow-sm'
          : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300 hover:text-violet-700'
      }`}
    >
      {hasError && <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />}
      {label}
    </button>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded ${tone}`} />
      <span className="text-[10px] font-bold text-slate-500 tabular-nums">{label}</span>
    </span>
  );
}
