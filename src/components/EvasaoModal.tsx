import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, UserX, Search, RefreshCw, AlertTriangle } from 'lucide-react';
import { fetchCancelamentosDetalhados, type CancelamentoRow } from '../services/evoApi';
import { formatBRL, formatNumber } from '../lib/format';
import { useDialog } from '../hooks/useDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Unidades em escopo (respeita RBAC + filtro de unidade da tela). Vazio = todas. */
  unitNames: string[];
  /** Mostra nome/documento do cliente (coluna + busca + export). Default true. */
  showClientName?: boolean;
}

/** Modal com a lista detalhada de cancelamentos (evasão) do mês + exportação Excel. */
export function EvasaoModal({ isOpen, onClose, unitNames, showClientName = true }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<CancelamentoRow[]>([]);
  const [complete, setComplete] = useState(true);
  const [periodLabel, setPeriodLabel] = useState('');
  const [error, setError] = useState(false);

  // ESC + focus-trap + foco inicial + retorno de foco (a11y de dialog).
  const dialogRef = useDialog<HTMLDivElement>(isOpen, onClose);

  // Busca os cancelamentos detalhados ao abrir (on-demand, sem cache).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // queueMicrotask difere o setState pra fora do body do effect
    // (anti-pattern set-state-in-effect).
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(false);
    });
    fetchCancelamentosDetalhados(unitNames)
      .then(res => {
        if (cancelled) return;
        setRows(res.list);
        setComplete(res.complete);
        setPeriodLabel(res.periodLabel);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[EvasaoModal] falha ao buscar cancelamentos:', err);
        setError(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, unitNames]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (showClientName && (r.name ?? '').toLowerCase().includes(q)) ||
      (r.branchName ?? '').toLowerCase().includes(q) ||
      (r.nameMembership ?? '').toLowerCase().includes(q) ||
      (r.reasonCancellation ?? '').toLowerCase().includes(q) ||
      (showClientName && (r.memberDocument ?? '').toLowerCase().includes(q)) ||
      String(r.idMember ?? '').includes(q),
    );
  }, [rows, query, showClientName]);

  const totalMulta = filtered.reduce((s, r) => s + (r.cancellationFine ?? 0), 0);

  async function exportExcel() {
    const { utils, writeFile } = await import('xlsx');
    const data = filtered.map(r => ({
      'ID Unidade':            r.idBranch,
      'Unidade':               r.branchName ?? '',
      'ID Member':             r.idMember ?? '',
      'Nome':                  showClientName ? (r.name ?? '') : '',
      'Documento':             showClientName ? (r.memberDocument ?? '') : '',
      'ID Plano':              r.idMembership ?? '',
      'Plano':                 r.nameMembership ?? '',
      'Valor Venda (R$)':      r.saleValue ?? 0,
      'Data Venda':            r.saleDate ?? '',
      'Início Contrato':       r.membershipStart ?? '',
      'Fim Contrato':          r.membershipEnd ?? '',
      'Data Registro Cancel.': r.registerCancelDate ?? '',
      'Data Cancelamento':     r.cancelDate ?? '',
      'Motivo Cancelamento':   r.reasonCancellation ?? '',
      'Multa Cancel. (R$)':    r.cancellationFine ?? 0,
      'Valor Restante (R$)':   r.remainingValue ?? 0,
      'Fidelidade (meses)':    r.minPeriodStayMembership ?? '',
      'Status':                r.statusMemberMembership ?? '',
    }));
    const ws = utils.json_to_sheet(data);
    ws['!cols'] = [
      { wch: 10 }, { wch: 22 }, { wch: 11 }, { wch: 24 }, { wch: 16 }, { wch: 9 }, { wch: 26 },
      { wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 30 },
      { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 9 },
    ];
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Evasão');
    const fileName = `evasao-${periodLabel.replace(/[^0-9]/g, '-') || 'mes'}.xlsx`;
    writeFile(wb, fileName);
  }

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="evasao-modal-title"
            initial={{ scale: 0.96, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="relative w-full max-w-6xl max-h-[88vh] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col focus:outline-none"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 px-6 sm:px-8 py-5 border-b border-slate-100">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 shrink-0 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center">
                  <UserX size={22} strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black text-rose-600 uppercase tracking-[0.2em]">
                    Evasão · Cancelamentos{periodLabel ? ` · ${periodLabel}` : ''}
                  </p>
                  <h2 id="evasao-modal-title" className="text-[1.6rem] sm:text-[2rem] font-black text-slate-900 tracking-tight leading-none mt-1">
                    {loading ? '...' : formatNumber(filtered.length)} {filtered.length === 1 ? 'cancelamento' : 'cancelamentos'}
                  </h2>
                  <p className="text-[12px] font-bold text-slate-400 mt-1.5 truncate">
                    Multa total {formatBRL(totalMulta)} · membros pagantes (sem transfers/agregadores/VIPs)
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Fechar"
                className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/50"
                title="Fechar (ESC)"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {/* Aviso de dados parciais */}
            {!loading && !complete && (
              <div className="flex items-center gap-2 px-6 sm:px-8 py-2.5 bg-amber-50 border-b border-amber-100 text-[12px] font-bold text-amber-700">
                <AlertTriangle size={14} />
                Dados parciais — alguma unidade falhou (EVO instável). A lista pode estar incompleta.
              </div>
            )}

            {/* Toolbar: search + export */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 px-6 sm:px-8 py-4 border-b border-slate-50 bg-slate-50/50">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  aria-label="Buscar cancelamentos"
                  placeholder={showClientName ? 'Buscar por nome, unidade, plano, motivo, documento ou ID...' : 'Buscar por unidade, plano, motivo ou ID...'}
                  className="w-full pl-10 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-300/40"
                />
              </div>
              <button
                onClick={exportExcel}
                disabled={loading || filtered.length === 0}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-rose-600 text-white rounded-xl text-[12px] font-black uppercase tracking-wider hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                <Download size={14} />
                Exportar Excel
              </button>
            </div>

            {/* Lista */}
            <div className="flex-1 overflow-auto scroll-contain px-2 sm:px-4 py-2">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <RefreshCw size={32} className="mb-3 animate-spin opacity-60" />
                  <p className="text-[13px] font-bold">Buscando cancelamentos no EVO...</p>
                  <p className="text-[11px] mt-1">Pode levar alguns segundos (paginação por unidade)</p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-16 text-rose-400">
                  <AlertTriangle size={36} className="mb-3 opacity-60" />
                  <p className="text-[13px] font-bold">Falha ao buscar dados do EVO</p>
                  <p className="text-[11px] mt-1 text-slate-400">Tente novamente em instantes (EVO pode estar instável)</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <UserX size={36} className="mb-3 opacity-40" />
                  <p className="text-[13px] font-bold">Nenhum cancelamento encontrado</p>
                </div>
              ) : (
                <table className="w-full text-[12px] sm:text-[13px]">
                  <thead className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-3 py-2.5">Unidade</th>
                      {showClientName && <th className="text-left px-3 py-2.5">Nome</th>}
                      <th className="text-left px-3 py-2.5 hidden sm:table-cell">Plano</th>
                      <th className="text-right px-2 py-2.5 hidden md:table-cell">Cancelou</th>
                      <th className="text-left px-3 py-2.5 hidden lg:table-cell">Motivo</th>
                      <th className="text-right px-3 py-2.5">Multa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => (
                      <tr key={`${r.idMember}-${r.idMembership}-${i}`} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="inline-flex items-center justify-center w-6 h-6 shrink-0 rounded-md bg-rose-500/10 text-rose-600 text-[10px] font-black">
                              {r.idBranch}
                            </span>
                            <span className="font-bold text-slate-700 truncate hidden sm:inline">{r.branchName ?? ''}</span>
                          </div>
                        </td>
                        {showClientName && <td className="px-3 py-2.5 font-bold text-slate-900 truncate max-w-[200px]">{r.name || '—'}</td>}
                        <td className="px-3 py-2.5 text-slate-500 truncate max-w-[180px] hidden sm:table-cell">{r.nameMembership || '—'}</td>
                        <td className="text-right px-2 py-2.5 font-mono text-[11px] text-slate-400 hidden md:table-cell tabular-nums">{r.cancelDate || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-500 truncate max-w-[220px] hidden lg:table-cell">{r.reasonCancellation || '—'}</td>
                        <td className="text-right px-3 py-2.5 font-black text-rose-600 tabular-nums whitespace-nowrap">{formatBRL(r.cancellationFine ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 sm:px-8 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-[11px] font-bold text-slate-400">
              <span>{filtered.length} {filtered.length === 1 ? 'registro' : 'registros'}{rows.length !== filtered.length ? ` de ${rows.length}` : ''}</span>
              <span className="hidden sm:inline">fonte: W12 /membermembership</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
