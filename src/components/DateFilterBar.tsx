import { useState, type ReactNode } from 'react';
import { Calendar, X } from 'lucide-react';
import { localYMD, monthLabelBR } from '../lib/date';

// ─────────────────────────────────────────────────────────────────────────────
// Filtro de período com DRILL-DOWN mês → dia. Saída unificada = range {from,to}
// em 'YYYY-MM-DD'. Substitui gradualmente a MonthFilterBar (só mês) nas abas que
// precisam de granularidade diária (Painel, Financeiro, Unidades, Comercial,
// Marketing). O mês continua como ATALHO: clicou no mês → "Mês inteiro" pega o
// 1º→último dia (ou hoje, se for o mês corrente); ou escolhe um dia específico.
//
// Por que range e não "1 data só": unifica os 3 casos — 1 dia (from===to), mês
// inteiro e intervalo livre — num modelo só, que é o que os fetches já usam
// (receivables/vendas/cancelamentos aceitam from/to).
// ─────────────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
}

const MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const DIAS_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/** Último dia do mês 'YYYY-MM' (28..31). */
function lastDayOfMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
/** Mês inteiro como range, limitado a `max` (não passa de hoje no mês corrente). */
function wholeMonthRange(ym: string, max: string): DateRange {
  const from = `${ym}-01`;
  const last = `${ym}-${String(lastDayOfMonth(ym)).padStart(2, '0')}`;
  return { from, to: last > max ? max : last };
}
function isWholeMonth(r: DateRange, max: string): string | null {
  const ym = r.from.slice(0, 7);
  if (r.to.slice(0, 7) !== ym) return null;
  const wm = wholeMonthRange(ym, max);
  return r.from === wm.from && r.to === wm.to ? ym : null;
}
/** Rótulo curto de 1 dia: '2026-06-22' → '22 jun 2026'. */
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MESES_ABREV[m - 1].toLowerCase()} ${y}`;
}
/** Rótulo do range conforme o caso (dia / mês inteiro / intervalo). */
function rangeLabel(r: DateRange, max: string): string {
  if (r.from === r.to) return dayLabel(r.from);
  const ym = isWholeMonth(r, max);
  if (ym) return monthLabelBR(ym);
  return `${dayLabel(r.from)} – ${dayLabel(r.to)}`;
}

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
  /** Dia mínimo selecionável 'YYYY-MM-DD' (ex.: início do histórico). */
  minDate?: string;
  /** Dia máximo selecionável. Default: hoje. */
  maxDate?: string;
  /** true quando o range é "o padrão" (mês corrente até hoje) → mostra "ao vivo" e esconde o X. */
  isCurrent: boolean;
  /** Volta pro padrão (mês corrente até hoje). */
  onReset: () => void;
  legend?: string;
}

export function DateFilterBar({ value, onChange, minDate, maxDate, isCurrent, onReset, legend }: Props) {
  const [open, setOpen] = useState(false);
  // null = mostrando grade de MESES; 'YYYY-MM' = mostrando a grade de DIAS desse mês.
  const [dayMonth, setDayMonth] = useState<string | null>(null);
  const [pickerYear, setPickerYear] = useState<number>(Number(value.from.slice(0, 4)));

  const max = maxDate ?? localYMD();
  const maxYear = Number(max.slice(0, 4));
  const minYear = minDate ? Number(minDate.slice(0, 4)) : maxYear - 10;

  const openPopover = () => {
    setPickerYear(Number(value.from.slice(0, 4)));
    setDayMonth(null);
    setOpen(o => !o);
  };
  const pickWholeMonth = (ym: string) => { onChange(wholeMonthRange(ym, max)); setOpen(false); };
  const pickDay = (ymd: string) => { onChange({ from: ymd, to: ymd }); setOpen(false); };

  return (
    <div
      role="group"
      aria-label="Filtro de período"
      className={`relative inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border rounded-xl text-[11px] font-bold text-slate-600 shadow-sm transition-colors ${
        !isCurrent ? 'border-primary/40 ring-1 ring-primary/15' : 'border-slate-200'
      }`}
      title={isCurrent ? 'Período atual — dados ao vivo' : 'Período selecionado'}
    >
      <Calendar size={13} className="text-primary shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={openPopover}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="min-w-[150px] text-center text-[12px] font-black text-slate-800 select-none px-2 py-1 rounded-lg hover:bg-primary/5 hover:text-primary transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {rangeLabel(value, max)}
        {isCurrent && <span className="ml-1.5 text-[9px] font-black uppercase tracking-wider text-emerald-600">· ao vivo</span>}
      </button>
      {!isCurrent && (
        <button
          type="button"
          onClick={onReset}
          title="Voltar pro período atual (ao vivo)"
          aria-label="Voltar pro período atual"
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-rose-500 hover:bg-rose-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        >
          <X size={11} />
        </button>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Escolher período"
            className="absolute top-full right-0 mt-2 z-50 bg-white border border-slate-200 rounded-2xl shadow-xl p-4 w-[280px] max-w-[calc(100vw-2rem)]"
          >
            {dayMonth === null ? (
              // ── Grade de MESES (navega por ano) ──
              <>
                <div className="flex items-center justify-between mb-3">
                  <button type="button" onClick={() => setPickerYear(y => y - 1)} disabled={pickerYear <= minYear}
                    aria-label="Ano anterior"
                    className="w-9 h-9 flex items-center justify-center rounded-lg text-[16px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">‹</button>
                  <span className="text-[14px] font-black text-slate-800 tabular-nums">{pickerYear}</span>
                  <button type="button" onClick={() => setPickerYear(y => y + 1)} disabled={pickerYear >= maxYear}
                    aria-label="Próximo ano"
                    className="w-9 h-9 flex items-center justify-center rounded-lg text-[16px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">›</button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {MESES_ABREV.map((lbl, i) => {
                    const ym = `${pickerYear}-${String(i + 1).padStart(2, '0')}`;
                    const fora = (minDate !== undefined && `${ym}-31` < minDate) || `${ym}-01` > max;
                    const ativo = value.from.slice(0, 7) === ym;
                    return (
                      <button key={ym} type="button" disabled={fora}
                        onClick={() => setDayMonth(ym)}
                        title={fora ? 'Fora do período' : `Abrir dias de ${monthLabelBR(ym)}`}
                        className={`h-9 rounded-xl text-[12px] font-black transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                          ativo ? 'bg-primary text-white shadow-sm'
                            : fora ? 'text-slate-300 cursor-not-allowed'
                            : 'text-slate-600 hover:bg-primary/5 hover:text-primary'
                        }`}>{lbl}</button>
                    );
                  })}
                </div>
              </>
            ) : (
              // ── Grade de DIAS do mês escolhido ──
              <>
                <div className="flex items-center justify-between mb-3">
                  <button type="button" onClick={() => setDayMonth(null)} aria-label="Voltar pros meses"
                    className="px-2 h-8 flex items-center gap-1 rounded-lg text-[12px] font-black text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors">‹ meses</button>
                  <span className="text-[13px] font-black text-slate-800">{monthLabelBR(dayMonth)}</span>
                  <span className="w-12" />
                </div>
                <button type="button" onClick={() => pickWholeMonth(dayMonth)}
                  className="w-full mb-2 h-8 rounded-xl text-[11px] font-black uppercase tracking-wider bg-primary/5 text-primary hover:bg-primary hover:text-white transition-colors">
                  Mês inteiro
                </button>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {DIAS_SEMANA.map((d, i) => <span key={i} className="h-5 flex items-center justify-center text-[9px] font-black text-slate-400">{d}</span>)}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {(() => {
                    const [y, m] = dayMonth.split('-').map(Number);
                    const firstWeekday = new Date(y, m - 1, 1).getDay(); // 0=Dom
                    const days = lastDayOfMonth(dayMonth);
                    const cells: ReactNode[] = [];
                    for (let i = 0; i < firstWeekday; i++) cells.push(<span key={`b${i}`} />);
                    for (let d = 1; d <= days; d++) {
                      const ymd = `${dayMonth}-${String(d).padStart(2, '0')}`;
                      const fora = (minDate !== undefined && ymd < minDate) || ymd > max;
                      const ativo = value.from === ymd && value.to === ymd;
                      cells.push(
                        <button key={ymd} type="button" disabled={fora} onClick={() => pickDay(ymd)}
                          className={`h-8 rounded-lg text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                            ativo ? 'bg-primary text-white shadow-sm'
                              : fora ? 'text-slate-200 cursor-not-allowed'
                              : 'text-slate-600 hover:bg-primary/5 hover:text-primary'
                          }`}>{d}</button>
                      );
                    }
                    return cells;
                  })()}
                </div>
              </>
            )}
            {legend && <p className="mt-3 text-[10px] font-bold text-slate-400 text-center">{legend}</p>}
          </div>
        </>
      )}
    </div>
  );
}
