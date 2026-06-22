import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MapPin, Users, TrendingUp, ArrowRight, Activity, Calendar, Zap, CheckCircle2, AlertTriangle, DollarSign, ShoppingBag, Target, Download } from 'lucide-react';
import {
    formatNumber,
    type BranchStats,
    type ReceivablesData,
    fetchTodayEntriesForBranch,
    UNITS,
    type EntryRecord,
} from '../services/evoApi';
import {
    getSession,
    canSeeInadimplentes,
    canSeeVendasDetalhe,
    canSeeFinanceiroDetalhe,
    canSeeReceitaRisco,
    canSeeEvasao,
} from '../services/nocodbApi';
import { useDialog } from '../hooks/useDialog';

interface UnitDetailsModalProps {
    unit: BranchStats | null;
    receivables?: ReceivablesData | null;
    isOpen: boolean;
    onClose: () => void;
    onViewReport?: () => void;
}

const fmtMoney = (v: number) =>
    `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const UnitDetailsModal = ({ unit, receivables, isOpen, onClose, onViewReport }: UnitDetailsModalProps) => {
    const [todayEntries, setTodayEntries] = useState<EntryRecord[]>([]);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);
    const dialogRef = useDialog<HTMLDivElement>(isOpen, onClose);

    useEffect(() => {
        let cancelled = false;
        if (!isOpen || !unit) {
            queueMicrotask(() => { if (!cancelled) setTodayEntries([]); });
            return () => { cancelled = true; };
        }
        const config = UNITS[unit.name];
        if (!config) return () => { cancelled = true; };

        queueMicrotask(() => {
            if (!cancelled) setIsLoadingDetails(true);
        });

        fetchTodayEntriesForBranch(config.token)
            .then(entries => {
                if (!cancelled) setTodayEntries(entries);
            })
            .finally(() => {
                if (!cancelled) setIsLoadingDetails(false);
            });

        return () => { cancelled = true; };
    }, [isOpen, unit]);

    if (!unit) return null;

    // Permissões de visualização por usuário (drill-down ao clicar no card).
    const session = getSession();
    const showInadimplentes = session ? canSeeInadimplentes(session) : false;
    const showVendasDetalhe = session ? canSeeVendasDetalhe(session) : false;
    const showFinanceiro    = session ? canSeeFinanceiroDetalhe(session) : false;
    const showReceitaRisco  = session ? canSeeReceitaRisco(session) : false;
    const showEvasao        = session ? canSeeEvasao(session) : false;
    // Cabeçalho/bloco "Financeiro do Mês" aparece se houver ao menos um stat visível.
    const showBlocoFinanceiro = showFinanceiro || showVendasDetalhe;

    // Evasão = cancelamentos do mês / ativos (churn real da W12 /membermembership)
    const evasao = unit.activeMembers > 0
        ? ((unit.cancelamentosMes ?? 0) / unit.activeMembers) * 100
        : 0;
    // Inadimplência em % (substitui número absoluto na UI conforme pedido do user)
    const inadPct = unit.activeMembers > 0
        ? ((unit.inadimplentesMembers / unit.activeMembers) * 100)
        : 0;

    // Exportar lista de inadimplentes em CSV
    const handleExportInadimplentes = () => {
        const ids = unit.idsInadimplentes ?? [];
        const csv = [
            'IdCliente',
            ...ids.map(id => String(id)),
        ].join('\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inadimplentes_${unit.name}_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Faturamento real do mês — pega da planilha de receivables filtrando pela unidade
    const fatRealMes = receivables?.perUnit.find(p => p.unitName === unit.name)?.amount ?? 0;
    const lancamentosMes = receivables?.perUnit.find(p => p.unitName === unit.name)?.rows ?? 0;

    // Cruzamento member × receivables: quantos ativos da unidade aparecem no receivable
    const idsAtivos = new Set<number>([
        ...(unit.idsAdimplentes ?? []),
        ...(unit.idsInadimplentes ?? []),
    ]);
    const idsReceb = new Set<number>(receivables?.idsLancadosPorUnidade?.[unit.name] ?? []);
    let qtdPagaram = 0;
    idsAtivos.forEach(id => { if (idsReceb.has(id)) qtdPagaram++; });
    const pctPagaram = idsAtivos.size > 0 ? (qtdPagaram / idsAtivos.size) * 100 : 0;
    const pagosColor = pctPagaram >= 80 ? 'text-emerald-600' : pctPagaram >= 50 ? 'text-amber-600' : 'text-rose-600';

    return createPortal(
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        aria-hidden="true"
                        className="absolute inset-0 bg-[#0F172A]/40 backdrop-blur-sm"
                    />

                    {/* Modal Content — flex column: header fixo + miolo rolável + botão sticky */}
                    <motion.div
                        ref={dialogRef}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="unit-details-title"
                        initial={{ scale: 0.9, opacity: 0, y: 20 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.9, opacity: 0, y: 20 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                        className="relative w-full max-w-3xl max-h-[90vh] bg-white rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden focus:outline-none"
                    >
                        {/* Header Gradient (shrink-0 = não rola) */}
                        <div className={`shrink-0 h-2 ${unit.hasError ? 'bg-red-200' : 'bg-gradient-to-r from-[#141414] via-[#141414] to-[#fc3000]'}`} />

                        {/* Close Button — fixo no canto superior do modal */}
                        <button
                            onClick={onClose}
                            aria-label="Fechar"
                            className="absolute top-6 right-6 z-10 w-10 h-10 flex items-center justify-center rounded-xl bg-white/95 backdrop-blur text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all border border-slate-100 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            <X size={20} aria-hidden="true" />
                        </button>

                        {/* Miolo rolável — scroll-contain impede que o scroll vaze pro body em mobile */}
                        <div className="flex-1 overflow-y-auto scroll-contain p-6 sm:p-10 pb-4">


                            {/* Header */}
                            <div className="mb-8">
                                <div className="flex items-center gap-2 text-primary font-black text-[11px] uppercase tracking-[0.2em] mb-3">
                                    <Activity size={14} /> Detalhes da Unidade
                                </div>
                                <h2 id="unit-details-title" className="text-[2.5rem] font-black text-[#0F172A] leading-tight tracking-tighter mb-2">
                                    {unit.name}
                                </h2>
                                <div className="flex items-center gap-4 text-slate-400 text-[13px] font-semibold">
                                    <div className="flex items-center gap-1.5">
                                        <MapPin size={14} className="text-slate-300" />
                                        {unit.location}
                                    </div>
                                    <div className="w-1.5 h-1.5 rounded-full bg-slate-200" />
                                    <div className="flex items-center gap-1.5">
                                        <div className={`w-2 h-2 rounded-full ${unit.hasError ? 'bg-red-400' : 'bg-accent animate-pulse'}`} />
                                        {unit.hasError ? 'Erro na Conexão' : 'Operacional'}
                                    </div>
                                </div>
                            </div>

                            {/* ── Bloco MEMBROS — 4 stats ── */}
                            <div className="mb-3 flex items-center justify-between gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
                                <span className="flex items-center gap-2">
                                    <Users size={12} /> Base de Membros
                                </span>
                                {showInadimplentes && (unit.idsInadimplentes?.length ?? 0) > 0 && (
                                    <button
                                        onClick={handleExportInadimplentes}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[10px] font-black tracking-wider transition-colors"
                                        title={`Exportar ${unit.idsInadimplentes?.length} inadimplentes em CSV`}
                                    >
                                        <Download size={10} /> Inadimplentes ({unit.idsInadimplentes?.length})
                                    </button>
                                )}
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                                <StatBox icon={Users}        label="Ativos"        value={unit.hasError ? '—' : formatNumber(unit.activeMembers)}        color="text-blue-600"     bg="bg-blue-50" />
                                <StatBox icon={CheckCircle2} label="Adimplentes"   value={unit.hasError ? '—' : formatNumber(unit.adimplentesMembers)}   color="text-emerald-600"  bg="bg-emerald-50" />
                                {showInadimplentes && (
                                    <StatBox icon={AlertTriangle} label="% Inadimplência" value={unit.hasError ? '—' : `${inadPct.toFixed(2).replace('.', ',')}%`} color="text-rose-600" bg="bg-rose-50" sub={`${formatNumber(unit.inadimplentesMembers)} de ${formatNumber(unit.activeMembers)}`} />
                                )}
                                <StatBox icon={Zap}          label="Presenças Hoje" value={isLoadingDetails ? '…' : String(todayEntries.length)}         color="text-amber-600"    bg="bg-amber-50" />
                            </div>

                            {/* ── Bloco FINANCEIRO — stats por permissão de usuário ── */}
                            {showBlocoFinanceiro && (
                              <>
                                <div className="mb-3 flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
                                    <DollarSign size={12} /> Financeiro do Mês
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
                                    {showFinanceiro && (
                                      <StatBox
                                        icon={DollarSign}
                                        label="Faturamento Real"
                                        value={receivables ? fmtMoney(fatRealMes) : '—'}
                                        color="text-primary"
                                        bg="bg-[#fde7e2]"
                                        sub={receivables ? `${lancamentosMes} lançamentos` : 'Carregando…'}
                                      />
                                    )}
                                    {showFinanceiro && (
                                      <StatBox
                                        icon={TrendingUp}
                                        label="Faturam. Estimado"
                                        value={unit.hasError ? '—' : fmtMoney(unit.faturamentoAdimplentes ?? 0)}
                                        color="text-accent"
                                        bg="bg-accent/10"
                                        sub="ValorContrato adimp"
                                      />
                                    )}
                                    {showVendasDetalhe && (
                                      <StatBox
                                        icon={ShoppingBag}
                                        label="Vendas Mês"
                                        value={unit.hasError ? '—' : fmtMoney(unit.vendasMesValor ?? 0)}
                                        color="text-indigo-600"
                                        bg="bg-indigo-50"
                                        sub={`${unit.vendasMesQtd ?? 0} matrículas${!unit.vendasMesComplete ? ' · parcial' : ''}`}
                                      />
                                    )}
                                    {showFinanceiro && (
                                      <StatBox
                                        icon={Target}
                                        label="Já Pagaram"
                                        value={receivables ? `${formatNumber(qtdPagaram)} (${pctPagaram.toFixed(2).replace('.', ',')}%)` : '—'}
                                        color={pagosColor}
                                        bg={pctPagaram >= 80 ? 'bg-emerald-50' : pctPagaram >= 50 ? 'bg-amber-50' : 'bg-rose-50'}
                                        sub={receivables ? `de ${formatNumber(idsAtivos.size)} ativos` : 'Carregando…'}
                                      />
                                    )}
                                </div>
                              </>
                            )}

                            {/* ── Painel Verde: Resumo da unidade ── */}
                            <div className="bg-[#141414] rounded-[2rem] p-7 text-white mb-8 relative overflow-hidden">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16 blur-2xl" />
                                <div className="relative z-10 grid grid-cols-1 sm:grid-cols-3 gap-6">
                                    <div>
                                        <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.15em] mb-1.5">Status</p>
                                        <p className="text-[1.1rem] font-black leading-tight">
                                            {unit.activeMembers > 1000 ? 'Alto desempenho' : unit.activeMembers > 400 ? 'Estável' : 'Em crescimento'}
                                        </p>
                                        <p className="text-[#fc3000] text-[11px] font-bold mt-1">
                                            {formatNumber(unit.activeMembers)} ativos
                                        </p>
                                    </div>
                                    {showEvasao && (
                                      <div>
                                        <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.15em] mb-1.5">Evasão</p>
                                        <p className="text-[1.6rem] font-black tracking-tighter leading-none text-rose-300">
                                            {unit.hasError ? '—' : `${evasao.toFixed(2).replace('.', ',')}%`}
                                        </p>
                                        <p className="text-white/50 text-[11px] font-bold mt-1">
                                            cancelamentos / ativos
                                        </p>
                                      </div>
                                    )}
                                    {showReceitaRisco ? (
                                      <div>
                                          <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.15em] mb-1.5">Receita em Risco</p>
                                          <p className="text-[1.6rem] font-black text-amber-300 tracking-tighter leading-none">
                                              {unit.hasError ? '—' : fmtMoney(unit.faturamentoInadimplentes ?? 0)}
                                          </p>
                                          <p className="text-white/50 text-[11px] font-bold mt-1">
                                              ValorContrato em atraso
                                          </p>
                                      </div>
                                    ) : showInadimplentes ? (
                                      <div>
                                          <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.15em] mb-1.5">Inadimplência</p>
                                          <p className="text-[1.6rem] font-black text-rose-300 tracking-tighter leading-none">
                                              {unit.hasError ? '—' : `${inadPct.toFixed(2).replace('.', ',')}%`}
                                          </p>
                                          <p className="text-white/50 text-[11px] font-bold mt-1">
                                              {formatNumber(unit.inadimplentesMembers)} de {formatNumber(unit.activeMembers)}
                                          </p>
                                      </div>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                        {/* /miolo rolável */}

                        {/* Actions — fora do scroll, sempre visível embaixo */}
                        <div className="shrink-0 px-8 sm:px-10 py-5 border-t border-slate-100 bg-white">
                            <button
                                onClick={() => { onClose(); onViewReport?.(); }}
                                className="w-full h-14 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[13px] font-black uppercase tracking-wider shadow-[0_8px_25px_rgba(15,60,35,0.2)] transition-all flex items-center justify-center gap-2 group"
                            >
                                <Calendar size={18} /> Ver Relatório <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
    );
};

// ─── Mini stat box reusável ───────────────────────────────────────────────────
interface StatBoxProps {
    icon: React.ElementType;
    label: string;
    value: string;
    color: string;
    bg: string;
    sub?: string;
}

function StatBox({ icon: Icon, label, value, color, bg, sub }: StatBoxProps) {
    return (
        <div className="bg-[#F8FAFB] p-4 rounded-2xl border border-slate-100">
            <div className="flex items-center justify-between mb-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bg}`}>
                    <Icon size={14} className={color} strokeWidth={2.5} />
                </div>
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider text-right line-clamp-2 leading-tight">{label}</span>
            </div>
            <p className={`text-[1.3rem] font-black tracking-tighter ${color} leading-none`}>{value}</p>
            {sub && <p className="text-[10px] font-bold text-slate-400 mt-1.5 truncate">{sub}</p>}
        </div>
    );
}
