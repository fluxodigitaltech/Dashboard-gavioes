import { useState, type ReactNode } from 'react';
import { Calendar, X } from 'lucide-react';
import { currentYM, monthLabelBR } from '../lib/date';

// Soma/subtrai meses em 'YYYY-MM' ancorado no dia 1 (sem rolagem de fim de mês).
function shiftYM(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendário de meses PADRÃO do dashboard — botão que abre um popover com a
// grade Jan..Dez e navegação por ano. Usado em todas as abas com filtro de
// período (Painel, Planos, Financeiro, Comercial, Campanhas) pra manter a
// mesma UX: clicou no mês → escolheu na grade → filtro aplicado.
// ─────────────────────────────────────────────────────────────────────────────

const MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

interface Props {
  /** Mês selecionado 'YYYY-MM' (destacado na grade). */
  month: string;
  /** Chamado ao escolher um mês válido na grade. */
  onPick: (ym: string) => void;
  /** Meses anteriores a este ficam desabilitados (ex.: início do histórico). */
  minMonth?: string;
  /** Meses posteriores a este ficam desabilitados. Default: mês corrente. */
  maxMonth?: string;
  /** Classe do botão que abre o popover (default: estilo discreto). */
  buttonClassName?: string;
  buttonTitle?: string;
  /** Legenda opcional no rodapé do popover. */
  legend?: string;
  /** Conteúdo do botão (default: rótulo do mês selecionado). */
  children?: ReactNode;
}

export function MonthCalendarPopover({
  month, onPick, minMonth, maxMonth, buttonClassName, buttonTitle, legend, children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState<number | null>(null);

  const max = maxMonth ?? currentYM();
  const year = pickerYear ?? Number(month.slice(0, 4));
  const maxYear = Number(max.slice(0, 4));
  const minYear = minMonth ? Number(minMonth.slice(0, 4)) : maxYear - 10;
  const isCurrentMonthSelectable = max === currentYM();

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => { setPickerYear(Number(month.slice(0, 4))); setOpen(o => !o); }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={buttonTitle ?? 'Abrir calendário de meses'}
        className={buttonClassName ?? 'px-2 py-1 rounded-lg text-[12px] font-black text-slate-800 hover:bg-primary/5 hover:text-primary transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'}
      >
        {children ?? monthLabelBR(month)}
      </button>

      {open && (
        <>
          {/* overlay: clique fora fecha */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="Escolher mês"
            className="absolute top-full right-0 mt-2 z-50 bg-white border border-slate-200 rounded-2xl shadow-xl p-4 w-[264px]"
          >
            {/* navegação de ano */}
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => setPickerYear(year - 1)}
                disabled={year <= minYear}
                aria-label="Ano anterior"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-[16px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >‹</button>
              <span className="text-[14px] font-black text-slate-800 tabular-nums">{year}</span>
              <button
                type="button"
                onClick={() => setPickerYear(year + 1)}
                disabled={year >= maxYear}
                aria-label="Próximo ano"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-[16px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >›</button>
            </div>

            {/* grade de meses */}
            <div className="grid grid-cols-3 gap-1.5">
              {MESES_ABREV.map((lbl, i) => {
                const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
                const fora = (minMonth !== undefined && ym < minMonth) || ym > max;
                const ativo = ym === month;
                const ehAtual = isCurrentMonthSelectable && ym === max;
                return (
                  <button
                    key={ym}
                    type="button"
                    disabled={fora}
                    onClick={() => { onPick(ym); setOpen(false); }}
                    title={fora ? 'Fora do período disponível' : monthLabelBR(ym)}
                    className={`h-9 rounded-xl text-[12px] font-black transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      ativo
                        ? 'bg-primary text-white shadow-sm'
                        : fora
                          ? 'text-slate-300 cursor-not-allowed'
                          : ehAtual
                            ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                            : 'text-slate-600 hover:bg-primary/5 hover:text-primary'
                    }`}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>

            {legend && (
              <p className="mt-3 text-[10px] font-bold text-slate-400 text-center">{legend}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Barra de filtro de mês PADRÃO do sistema: ícone + ‹ + [mês clicável que abre
// o calendário] + › + X (voltar pro mês atual). Mesmo visual em todas as abas.
// ─────────────────────────────────────────────────────────────────────────────

interface MonthFilterBarProps {
  /** Mês selecionado 'YYYY-MM'. */
  selectedMonth: string;
  /** true quando o mês corrente está selecionado (mostra "· ao vivo", esconde X). */
  isCurrent: boolean;
  /** Limite inferior de navegação (ex.: 1º mês do histórico). */
  minMonth?: string;
  /** Chamado com o novo 'YYYY-MM' (setas e calendário). */
  onPick: (ym: string) => void;
  /** Volta pro mês corrente (ao vivo). */
  onReset: () => void;
  /** Legenda no rodapé do calendário. */
  legend?: string;
}

export function MonthFilterBar({ selectedMonth, isCurrent, minMonth, onPick, onReset, legend }: MonthFilterBarProps) {
  return (
    <div
      role="group"
      aria-label="Filtro de mês"
      className={`flex items-center gap-1 px-2.5 py-1.5 bg-white border rounded-xl text-[11px] font-bold text-slate-600 shadow-sm transition-colors ${
        !isCurrent ? 'border-primary/40 ring-1 ring-primary/15' : 'border-slate-200'
      }`}
      title={isCurrent ? 'Mês atual — dados ao vivo' : 'Mês passado — dados do histórico'}
    >
      <Calendar size={13} className="text-primary shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={() => onPick(shiftYM(selectedMonth, -1))}
        disabled={minMonth !== undefined && selectedMonth <= minMonth}
        title="Mês anterior"
        aria-label="Mês anterior"
        className="w-7 h-7 flex items-center justify-center rounded-lg text-[15px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >‹</button>
      <MonthCalendarPopover
        month={selectedMonth}
        minMonth={minMonth}
        onPick={onPick}
        legend={legend}
        buttonClassName="min-w-[150px] text-center text-[12px] font-black text-slate-800 select-none px-2 py-1 rounded-lg hover:bg-primary/5 hover:text-primary transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {monthLabelBR(selectedMonth)}
        {isCurrent && <span className="ml-1.5 text-[9px] font-black uppercase tracking-wider text-emerald-600">· ao vivo</span>}
      </MonthCalendarPopover>
      <button
        type="button"
        onClick={() => onPick(shiftYM(selectedMonth, 1))}
        disabled={isCurrent}
        title="Próximo mês"
        aria-label="Próximo mês"
        className="w-7 h-7 flex items-center justify-center rounded-lg text-[15px] leading-none text-slate-500 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >›</button>
      {!isCurrent && (
        <button
          type="button"
          onClick={onReset}
          title="Voltar pro mês atual (ao vivo)"
          aria-label="Voltar pro mês atual"
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-rose-500 hover:bg-rose-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
