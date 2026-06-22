import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Activity, RefreshCw } from 'lucide-react';
import { type OccupationData } from '../services/evoApi';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  data: OccupationData | null;
  isLoading?: boolean;
  onRefresh?: () => void;
  /** Filtro de unidades visíveis (respeita matriz Página×Unidade do user). */
  allowedUnits?: 'all' | string[];
}

/** Cor do badge de % conforme faixa. */
function pctTone(pct: number): { bg: string; text: string; bar: string } {
  if (pct >= 90) return { bg: 'bg-rose-50',    text: 'text-rose-700',    bar: 'bg-rose-500' };
  if (pct >= 70) return { bg: 'bg-amber-50',   text: 'text-amber-700',   bar: 'bg-amber-500' };
  if (pct >= 40) return { bg: 'bg-emerald-50', text: 'text-emerald-700', bar: 'bg-emerald-500' };
  return { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' };
}

export function OccupationModal({ isOpen, onClose, data, isLoading, onRefresh, allowedUnits = 'all' }: Props) {
  const visibleUnits = data
    ? (allowedUnits === 'all' ? data.byUnit : data.byUnit.filter(u => allowedUnits.includes(u.name)))
    : [];

  // Recalcula totais sobre o filtro de unidades permitidas (admin vê tudo, gestor vê só as suas)
  const totalOcc = visibleUnits.reduce((s, u) => s + u.occupation, 0);
  const totalCap = visibleUnits.reduce((s, u) => s + u.maxOccupation, 0);
  const totalPct = totalCap > 0 ? (totalOcc / totalCap) * 100 : 0;
  const totalTone = pctTone(totalPct);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="bg-white rounded-3xl shadow-2xl border border-slate-200/60 w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
                  <Activity size={18} strokeWidth={2.5} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-[1.05rem] font-black text-slate-900 leading-tight truncate">Taxa de Ocupação</h2>
                  <p className="text-[11px] font-bold text-slate-400 leading-tight">
                    Capacidade · ocupação atual por unidade
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {onRefresh && (
                  <button
                    onClick={onRefresh}
                    disabled={isLoading}
                    title="Atualizar agora (ignora cache de 5min)"
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-100 text-slate-400 hover:text-violet-600 hover:border-violet-200 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  title="Fechar"
                  className="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-100 text-slate-400 hover:text-rose-500 hover:border-rose-200 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Total agregado */}
            <div className="px-6 py-5 border-b border-slate-100 bg-slate-50/40">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">Total agregado</p>
              <div className="flex items-end gap-3 mb-3">
                <h3 className="text-4xl font-black text-slate-900 tracking-tighter tabular-nums leading-none">
                  {totalPct.toFixed(2).replace('.', ',')}%
                </h3>
                <p className="text-sm font-bold text-slate-500 tabular-nums pb-1">
                  {totalOcc} / {totalCap} vagas
                </p>
              </div>
              <div className="h-2 w-full bg-slate-200/70 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${totalTone.bar} transition-all duration-500`}
                  style={{ width: `${Math.min(totalPct, 100)}%` }}
                />
              </div>
            </div>

            {/* Por unidade */}
            <div className="flex-1 overflow-y-auto scroll-contain px-6 py-4 space-y-2">
              {!data && (
                <div className="text-center text-slate-400 text-sm font-medium py-12">
                  Carregando dados de ocupação...
                </div>
              )}
              {data && visibleUnits.length === 0 && (
                <div className="text-center text-slate-400 text-sm font-medium py-12">
                  Nenhuma unidade disponível.
                </div>
              )}
              {visibleUnits.map(u => {
                const tone = pctTone(u.pct);
                return (
                  <div
                    key={u.name}
                    className={`px-4 py-3 rounded-xl border ${u.hasError ? 'border-rose-100 bg-rose-50/30' : 'border-slate-200/70 bg-white'}`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full ${u.hasError ? 'bg-rose-400' : tone.bar}`} />
                        <p className="text-[13px] font-black text-slate-700 truncate">{u.name}</p>
                        {u.hasError && (
                          <span className="text-[10px] font-bold text-rose-500 uppercase tracking-wider">erro</span>
                        )}
                      </div>
                      <div className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-black tabular-nums ${tone.bg} ${tone.text}`}>
                        {u.pct.toFixed(2).replace('.', ',')}%
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${tone.bar}`}
                          style={{ width: `${Math.min(u.pct, 100)}%` }}
                        />
                      </div>
                      <p className="text-[11px] font-bold text-slate-400 tabular-nums shrink-0">
                        {u.occupation} / {u.maxOccupation}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {data?.fetchedAt && (
              <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/40 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-center">
                Atualizado em {new Date(data.fetchedAt).toLocaleTimeString('pt-BR')} · cache 5 min
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
