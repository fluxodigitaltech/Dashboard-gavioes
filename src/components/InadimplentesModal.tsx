import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, AlertCircle, Search, RefreshCw, AlertTriangle, Phone } from 'lucide-react';
import { fetchInadimplentesDetalhados, type InadimplenteRow } from '../services/evoApi';
import { formatBRL, formatNumber } from '../lib/format';
import { useDialog } from '../hooks/useDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Unidades em escopo (respeita RBAC + filtro de unidade da tela). Vazio = todas. */
  unitNames: string[];
  /** Mostra nome/telefone do cliente. Default true. */
  showClientName?: boolean;
}

/** Telefone → só dígitos (com DDI 55 quando faltar) pra link wa.me. */
function waLink(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  if (d.length < 10) return null;
  const full = d.length <= 11 ? `55${d}` : d;
  return `https://wa.me/${full}`;
}

/** Modal com a lista de inadimplentes do mês (nome · telefone · unidade) + export. */
export function InadimplentesModal({ isOpen, onClose, unitNames, showClientName = true }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<InadimplenteRow[]>([]);
  const [complete, setComplete] = useState(true);
  const [periodLabel, setPeriodLabel] = useState('');
  const [error, setError] = useState(false);

  const dialogRef = useDialog<HTMLDivElement>(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) { setLoading(true); setError(false); } });
    fetchInadimplentesDetalhados(unitNames)
      .then(res => {
        if (cancelled) return;
        setRows(res.list);
        setComplete(res.complete);
        setPeriodLabel(res.periodLabel);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[InadimplentesModal] falha:', err);
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
      (showClientName && (r.phone ?? '').toLowerCase().includes(q)) ||
      (r.branchName ?? '').toLowerCase().includes(q) ||
      (r.plano ?? '').toLowerCase().includes(q),
    );
  }, [rows, query, showClientName]);

  const totalRisco = filtered.reduce((s, r) => s + (r.valor ?? 0), 0);

  async function exportExcel() {
    const { utils, writeFile } = await import('xlsx');
    const data = filtered.map(r => ({
      'Unidade':            r.branchName ?? '',
      'Nome':               showClientName ? (r.name ?? '') : '',
      'Telefone':           showClientName ? (r.phone ?? '') : '',
      'Plano':              r.plano ?? '',
      'Valor em risco (R$)': r.valor ?? 0,
    }));
    const ws = utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 22 }, { wch: 26 }, { wch: 18 }, { wch: 26 }, { wch: 18 }];
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Inadimplentes');
    writeFile(wb, `inadimplentes-${periodLabel.replace(/[^0-9]/g, '-') || 'mes'}.xlsx`);
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
            aria-labelledby="inad-modal-title"
            initial={{ scale: 0.96, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="relative w-full max-w-4xl max-h-[88vh] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col focus:outline-none"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 px-6 sm:px-8 py-5 border-b border-slate-100">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 shrink-0 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center">
                  <AlertCircle size={22} strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black text-amber-600 uppercase tracking-[0.2em]">
                    Inadimplentes{periodLabel ? ` · ${periodLabel}` : ''}
                  </p>
                  <h2 id="inad-modal-title" className="text-[1.6rem] sm:text-[2rem] font-black text-slate-900 tracking-tight leading-none mt-1">
                    {loading ? '...' : formatNumber(filtered.length)} {filtered.length === 1 ? 'aluno' : 'alunos'}
                  </h2>
                  <p className="text-[12px] font-bold text-slate-400 mt-1.5 truncate">
                    Valor em risco {formatBRL(totalRisco)} · contratos com mensalidade em aberto
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Fechar"
                className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/50"
                title="Fechar (ESC)"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {!loading && !complete && (
              <div className="flex items-center gap-2 px-6 sm:px-8 py-2.5 bg-amber-50 border-b border-amber-100 text-[12px] font-bold text-amber-700">
                <AlertTriangle size={14} />
                Dados parciais — alguma unidade falhou (EVO instável). A lista pode estar incompleta.
              </div>
            )}

            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 px-6 sm:px-8 py-4 border-b border-slate-50 bg-slate-50/50">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  aria-label="Buscar inadimplentes"
                  placeholder={showClientName ? 'Buscar por nome, telefone, unidade ou plano...' : 'Buscar por unidade ou plano...'}
                  className="w-full pl-10 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-300/40"
                />
              </div>
              <button
                onClick={exportExcel}
                disabled={loading || filtered.length === 0}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-amber-600 text-white rounded-xl text-[12px] font-black uppercase tracking-wider hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
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
                  <p className="text-[13px] font-bold">Buscando inadimplentes no EVO...</p>
                  <p className="text-[11px] mt-1">Pode levar alguns segundos (planilha por unidade)</p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-16 text-amber-500">
                  <AlertTriangle size={36} className="mb-3 opacity-60" />
                  <p className="text-[13px] font-bold">Falha ao buscar dados do EVO</p>
                  <p className="text-[11px] mt-1 text-slate-400">Tente novamente em instantes (EVO pode estar instável)</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <AlertCircle size={36} className="mb-3 opacity-40" />
                  <p className="text-[13px] font-bold">Nenhum inadimplente encontrado</p>
                </div>
              ) : (
                <table className="w-full text-[12px] sm:text-[13px]">
                  <thead className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-3 py-2.5">Unidade</th>
                      {showClientName && <th className="text-left px-3 py-2.5">Nome</th>}
                      {showClientName && <th className="text-left px-3 py-2.5">Telefone</th>}
                      <th className="text-left px-3 py-2.5 hidden sm:table-cell">Plano</th>
                      <th className="text-right px-3 py-2.5">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => {
                      const wa = showClientName ? waLink(r.phone ?? '') : null;
                      return (
                        <tr key={`${r.idCliente ?? 'x'}-${i}`} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="inline-flex items-center justify-center w-6 h-6 shrink-0 rounded-md bg-amber-500/10 text-amber-600 text-[10px] font-black">
                                {r.idBranch}
                              </span>
                              <span className="font-bold text-slate-700 truncate hidden sm:inline">{r.branchName ?? ''}</span>
                            </div>
                          </td>
                          {showClientName && <td className="px-3 py-2.5 font-bold text-slate-900 truncate max-w-[200px]">{r.name || '—'}</td>}
                          {showClientName && (
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              {r.phone
                                ? (wa
                                  ? <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                                      <Phone size={12} /> {r.phone}
                                    </a>
                                  : <span className="font-bold text-slate-600">{r.phone}</span>)
                                : <span className="text-slate-300">—</span>}
                            </td>
                          )}
                          <td className="px-3 py-2.5 text-slate-500 truncate max-w-[200px] hidden sm:table-cell">{r.plano || '—'}</td>
                          <td className="text-right px-3 py-2.5 font-black text-amber-600 tabular-nums whitespace-nowrap">{formatBRL(r.valor ?? 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 sm:px-8 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-[11px] font-bold text-slate-400">
              <span>{filtered.length} {filtered.length === 1 ? 'registro' : 'registros'}{rows.length !== filtered.length ? ` de ${rows.length}` : ''}</span>
              <span className="hidden sm:inline">fonte: W12 /members/summary-excel</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
