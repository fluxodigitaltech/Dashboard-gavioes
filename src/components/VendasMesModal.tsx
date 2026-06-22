import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, ShoppingBag, Search } from 'lucide-react';
import type { VendaMin } from '../services/evoApi';
import { formatBRL, formatNumber } from '../lib/format';
import { useDialog } from '../hooks/useDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  vendas: VendaMin[];
  /** Texto do período mostrado no header (ex: "Abril/2026"). */
  periodLabel?: string;
  /** Mostra o nome do cliente (coluna + busca + export). Default true. */
  showClientName?: boolean;
}

/** Modal com a lista detalhada de matrículas novas + exportação Excel. */
export function VendasMesModal({ isOpen, onClose, vendas, periodLabel, showClientName = true }: Props) {
  const [query, setQuery] = useState('');

  // ESC + focus-trap + foco inicial + retorno de foco (a11y de dialog).
  const dialogRef = useDialog<HTMLDivElement>(isOpen, onClose);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendas;
    return vendas.filter(v =>
      (showClientName && (v.firstName.toLowerCase().includes(q) || v.lastName.toLowerCase().includes(q))) ||
      (v.branchName ?? '').toLowerCase().includes(q) ||
      v.plan.toLowerCase().includes(q) ||
      String(v.idMember ?? '').includes(q),
    );
  }, [vendas, query, showClientName]);

  const totalValor = filtered.reduce((s, v) => s + v.total, 0);

  async function exportExcel() {
    const { utils, writeFile } = await import('xlsx');
    const rows = filtered.map(v => ({
      'ID Unidade':   v.idBranch,
      'Unidade':      v.branchName ?? '',
      'ID Member':    v.idMember ?? '',
      ...(showClientName ? { 'Nome': v.firstName, 'Sobrenome': v.lastName } : {}),
      'Data':         v.saleDate,
      'Plano':        v.plan,
      'Valor (R$)':   v.total,
      'ID Sale':      v.idSale,
    }));
    const ws = utils.json_to_sheet(rows);
    // Larguras decentes pras colunas
    ws['!cols'] = showClientName
      ? [{ wch: 10 }, { wch: 22 }, { wch: 11 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 25 }, { wch: 13 }, { wch: 10 }]
      : [{ wch: 10 }, { wch: 22 }, { wch: 11 }, { wch: 12 }, { wch: 25 }, { wch: 13 }, { wch: 10 }];
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Matrículas');
    const fileName = `matriculas-${periodLabel?.toLowerCase().replace(/[^a-z0-9]/g, '-') ?? 'mes'}.xlsx`;
    writeFile(wb, fileName);
  }

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />

          {/* Modal */}
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="vendas-modal-title"
            initial={{ scale: 0.96, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="relative w-full max-w-5xl max-h-[88vh] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col focus:outline-none"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 px-6 sm:px-8 py-5 border-b border-slate-100">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 shrink-0 rounded-2xl bg-accent/15 text-accent flex items-center justify-center">
                  <ShoppingBag size={22} strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">
                    Matrículas Novas{periodLabel ? ` · ${periodLabel}` : ''}
                  </p>
                  <h2 id="vendas-modal-title" className="text-[1.6rem] sm:text-[2rem] font-black text-slate-900 tracking-tight leading-none mt-1">
                    {formatNumber(filtered.length)} {filtered.length === 1 ? 'matrícula' : 'matrículas'}
                  </h2>
                  <p className="text-[12px] font-bold text-slate-400 mt-1.5 truncate">
                    Total {formatBRL(totalValor)} · enrollment puro (sem rematrículas)
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Fechar"
                className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                title="Fechar (ESC)"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {/* Toolbar: search + export */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 px-6 sm:px-8 py-4 border-b border-slate-50 bg-slate-50/50">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  aria-label="Buscar matrículas"
                  placeholder={showClientName ? 'Buscar por nome, unidade, plano ou ID...' : 'Buscar por unidade, plano ou ID...'}
                  className="w-full pl-10 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <button
                onClick={exportExcel}
                disabled={filtered.length === 0}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-white rounded-xl text-[12px] font-black uppercase tracking-wider hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                <Download size={14} />
                Exportar Excel
              </button>
            </div>

            {/* Lista */}
            <div className="flex-1 overflow-auto scroll-contain px-2 sm:px-4 py-2">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <ShoppingBag size={36} className="mb-3 opacity-40" />
                  <p className="text-[13px] font-bold">Nenhuma matrícula encontrada</p>
                </div>
              ) : (
                <table className="w-full text-[12px] sm:text-[13px]">
                  <thead className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-3 py-2.5">Unidade</th>
                      <th className="text-center px-2 py-2.5">ID</th>
                      {showClientName && <th className="text-left px-3 py-2.5">Nome</th>}
                      <th className="text-left px-3 py-2.5 hidden sm:table-cell">Plano</th>
                      <th className="text-right px-2 py-2.5 hidden md:table-cell">Data</th>
                      <th className="text-right px-3 py-2.5">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(v => (
                      <tr
                        key={v.idSale}
                        className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors"
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="inline-flex items-center justify-center w-6 h-6 shrink-0 rounded-md bg-primary/10 text-primary text-[10px] font-black">
                              {v.idBranch}
                            </span>
                            <span className="font-bold text-slate-700 truncate hidden sm:inline">{v.branchName ?? ''}</span>
                          </div>
                        </td>
                        <td className="text-center px-2 py-2.5 font-mono text-[11px] text-slate-400 tabular-nums">
                          {v.idMember ?? '—'}
                        </td>
                        {showClientName && (
                          <td className="px-3 py-2.5 font-bold text-slate-900 truncate max-w-[180px]">
                            {v.firstName} {v.lastName}
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-slate-500 truncate max-w-[160px] hidden sm:table-cell">
                          {v.plan || '—'}
                        </td>
                        <td className="text-right px-2 py-2.5 font-mono text-[11px] text-slate-400 hidden md:table-cell tabular-nums">
                          {v.saleDate}
                        </td>
                        <td className="text-right px-3 py-2.5 font-black text-emerald-600 tabular-nums whitespace-nowrap">
                          {formatBRL(v.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 sm:px-8 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-[11px] font-bold text-slate-400">
              <span>{filtered.length} {filtered.length === 1 ? 'registro' : 'registros'}{vendas.length !== filtered.length ? ` de ${vendas.length}` : ''}</span>
              <span className="hidden sm:inline">enrollment puro (sem re-enrollment)</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
