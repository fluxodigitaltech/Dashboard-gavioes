import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Database, Play, CheckCircle2, AlertTriangle } from 'lucide-react';
import { UNITS, fetchVendasInRange } from '../services/evoApi';
import { upsertEvoHistorySnapshot, isHistoryEnabled } from '../services/nocodbApi';
import { useDialog } from '../hooks/useDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

interface ProgressItem {
  branch: string;
  month: string;       // 'YYYY-MM'
  status: 'pending' | 'fetching' | 'done' | 'error';
  error?: string;
}

/** YYYY-MM da data D (mês 1-indexed). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Último dia do mês de D, formato YYYY-MM-DD. */
function lastDayOfMonth(y: number, m: number): string {
  const last = new Date(y, m + 1, 0).getDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** First day of month, YYYY-MM-DD. */
function firstDayOfMonth(y: number, m: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * Helper interno: puxa breakdown via members/summary-excel pra um effectiveDate.
 * Ré-implementação minima — a função em evoApi.ts é internal (não exportada).
 * Usamos diretamente o endpoint pra evitar refatorar o evoApi inteiro só pra exportar.
 */
async function fetchBreakdownForDate(token: string, effectiveDate: string): Promise<{
  ativos: number;
  adimplentes: number;
  inadimplentes: number;
  faturamentoAdimplentes: number;
} | null> {
  const DNS = 'gavioes';
  const auth = 'Basic ' + btoa(`${DNS}:${token}`);
  const url = `/evo-integracao/api/v1/members/summary-excel?effectiveDate=${effectiveDate}`;
  try {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buffer = await res.arrayBuffer();
    const { read, utils } = await import('xlsx');
    const wb = read(new Uint8Array(buffer), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json<Record<string, unknown>>(ws);
    if (rows.length === 0) {
      return { ativos: 0, adimplentes: 0, inadimplentes: 0, faturamentoAdimplentes: 0 };
    }
    // Detect columns (case insensitive, ignora trailing spaces)
    const sample = rows[0];
    const trim = (k: string) => k.trim();
    const allKeys = Object.keys(sample).map(trim);
    const find = (...candidates: string[]): string | null => {
      for (const c of candidates) {
        const f = allKeys.find(k => k.toLowerCase() === c.toLowerCase());
        if (f) return f;
      }
      return null;
    };
    const statusKey = find('StatusContrato', 'Status Contrato', 'Status do Contrato', 'Status');
    const vipKey    = find('ContratoVip', 'Contrato Vip', 'VIP', 'Vip');
    const valorKey  = find('ValorContrato', 'Valor Contrato', 'Valor');
    if (!statusKey || !vipKey) {
      throw new Error(`colunas ausentes: status=${statusKey}, vip=${vipKey}`);
    }
    let adimplentes = 0;
    let inadimplentes = 0;
    let faturamentoAdimplentes = 0;
    for (const r of rows) {
      const cleaned: Record<string, unknown> = {};
      for (const k in r) cleaned[k.trim()] = r[k];
      const vip = String(cleaned[vipKey] ?? '').trim().toLowerCase();
      if (vip === 'sim' || vip === 'yes' || vip === 's') continue;
      const status = String(cleaned[statusKey] ?? '').trim().toLowerCase();
      const valor = valorKey ? Number(cleaned[valorKey]) || 0 : 0;
      if (status === 'ativo') {
        adimplentes++;
        faturamentoAdimplentes += valor;
      } else if (status === 'inadimplente') {
        inadimplentes++;
      }
    }
    return {
      ativos: adimplentes + inadimplentes,
      adimplentes,
      inadimplentes,
      faturamentoAdimplentes,
    };
  } catch (e) {
    console.error('[seed] fetchBreakdownForDate erro:', e);
    return null;
  }
}

export function HistoricalSeedModal({ isOpen, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [done, setDone] = useState(false);
  const enabled = isHistoryEnabled();
  // ESC + focus-trap + retorno de foco. Bloqueia fechar enquanto sincroniza.
  const dialogRef = useDialog<HTMLDivElement>(isOpen, () => { if (!running) onClose(); });

  // Gera lista de (branch, month) pra os últimos 12 meses fechados
  // (não inclui o mês corrente — ele ainda muda; só meses passados).
  function buildPlan(): ProgressItem[] {
    const items: ProgressItem[] = [];
    const today = new Date();
    for (let offset = 1; offset <= 12; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth() - offset, 1);
      const mk = monthKey(d);
      for (const branch of Object.keys(UNITS)) {
        items.push({ branch, month: mk, status: 'pending' });
      }
    }
    return items;
  }

  async function startSeed() {
    if (!enabled || running) return;
    const plan = buildPlan();
    setProgress(plan);
    setRunning(true);
    setDone(false);

    // Processa sequencialmente pra não martelar a API EVO (já tem evoQueue
    // no GET de sales mas /summary-excel vai direto). Sequencial ainda fica
    // ok — 12 × 7 = 84 fetches × ~3s = ~4min total na pior hipótese.
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      setProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'fetching' } : p));
      try {
        const cfg = UNITS[item.branch];
        const [yStr, mStr] = item.month.split('-');
        const y = Number(yStr);
        const m = Number(mStr) - 1; // 0-indexed
        const effectiveDate = lastDayOfMonth(y, m);
        const start = firstDayOfMonth(y, m);
        const end = effectiveDate;

        // 1. Snapshot de membros (no último dia do mês fechado)
        const breakdown = await fetchBreakdownForDate(cfg.token, effectiveDate);
        if (!breakdown) throw new Error('breakdown vazio');

        // 2. Vendas do mês (paginação completa)
        const vendas = await fetchVendasInRange(cfg.token, cfg.idBranch, start, end);

        await upsertEvoHistorySnapshot({
          branch_name: item.branch,
          snapshot_month: item.month,
          period_kind: 'monthly',
          active_members: breakdown.ativos,
          adimplentes: breakdown.adimplentes,
          inadimplentes: breakdown.inadimplentes,
          faturamento_adimplentes: breakdown.faturamentoAdimplentes,
          vendas_qtd: vendas.qtd,
          vendas_valor: vendas.valor,
          source: vendas.complete ? 'evo_excel' : 'evo_excel',
        });

        setProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'done' } : p));
      } catch (err) {
        console.error(`[seed] ${item.branch}/${item.month} erro:`, err);
        setProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'error', error: String(err) } : p));
      }
    }

    setRunning(false);
    setDone(true);
  }

  const totalCount = progress.length;
  const doneCount = progress.filter(p => p.status === 'done').length;
  const errorCount = progress.filter(p => p.status === 'error').length;
  const fetchingCount = progress.filter(p => p.status === 'fetching').length;
  const pct = totalCount > 0 ? Math.round((doneCount + errorCount) / totalCount * 100) : 0;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
          onClick={running ? undefined : onClose}
        >
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="seed-modal-title"
            initial={{ scale: 0.96, y: 8, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="bg-white rounded-3xl shadow-2xl border border-slate-200/60 w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col focus:outline-none"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                  <Database size={18} strokeWidth={2.5} />
                </div>
                <div className="min-w-0">
                  <h2 id="seed-modal-title" className="text-[1.05rem] font-black text-slate-900 leading-tight truncate">Sincronizar Histórico</h2>
                  <p className="text-[11px] font-bold text-slate-400 leading-tight">
                    Puxa últimos 12 meses do EVO e grava no NocoDB
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                disabled={running}
                aria-label="Fechar"
                title={running ? 'Aguarde término da sincronização' : 'Fechar'}
                className="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-100 text-slate-400 hover:text-rose-500 hover:border-rose-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/50"
              >
                <X size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto scroll-contain px-6 py-5">
              {!enabled && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-[12px] font-medium text-amber-800 leading-relaxed">
                      Tabela <code className="font-mono bg-amber-100 px-1 rounded text-[11px]">gb_evo_history</code> não configurada
                      no NocoDB. Crie a tabela com o schema documentado em <code className="font-mono">src/services/nocodbApi.ts</code> e
                      cole o table ID em <code className="font-mono">TABLES.evoHistory</code>.
                    </div>
                  </div>
                </div>
              )}

              {!running && progress.length === 0 && (
                <div className="text-[13px] text-slate-600 leading-relaxed space-y-3">
                  <p>
                    Vai buscar do EVO (<span className="font-mono text-[12px]">/members/summary-excel</span> +
                    <span className="font-mono text-[12px]"> /sales</span>) os últimos <strong>12 meses fechados</strong>
                    {' '}para todas as <strong>{Object.keys(UNITS).length} unidades</strong>.
                  </p>
                  <p>
                    Total: <strong>{Object.keys(UNITS).length * 12} snapshots</strong>.
                    Cada um vira uma linha na tabela <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">gb_evo_history</code>.
                    Roda sequencial pra não pressionar a API. Pode levar alguns minutos.
                  </p>
                  <p className="text-slate-400 text-[12px]">
                    Já existe um snapshot pra um par (unidade, mês)? É <strong>atualizado</strong> em vez de duplicado.
                  </p>
                </div>
              )}

              {progress.length > 0 && (
                <div className="space-y-3">
                  {/* Barra de progresso */}
                  <div>
                    <div className="flex items-center justify-between mb-1 text-[11px] font-bold text-slate-500">
                      <span>{doneCount + errorCount} / {totalCount}</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${errorCount > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 font-medium">
                      {fetchingCount > 0 ? '⏳ ' : ''}{doneCount} ok · {errorCount} erro{errorCount !== 1 ? 's' : ''}
                    </p>
                  </div>

                  {/* Lista (mostra só os últimos 8 itens em fetching ou error pra não poluir) */}
                  <div className="max-h-64 overflow-y-auto scroll-contain space-y-1 text-[11px] font-mono">
                    {progress
                      .filter(p => p.status === 'fetching' || p.status === 'error')
                      .slice(-8)
                      .map((p, i) => (
                        <div
                          key={`${p.branch}-${p.month}-${i}`}
                          className={`flex items-center gap-2 px-2 py-1 rounded ${
                            p.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-slate-50 text-slate-600'
                          }`}
                        >
                          <span className="font-bold">{p.branch}</span>
                          <span className="text-slate-400">·</span>
                          <span>{p.month}</span>
                          <span className="ml-auto text-[10px] uppercase tracking-wider font-bold">
                            {p.status}
                          </span>
                        </div>
                      ))}
                  </div>

                  {done && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mt-3 flex items-start gap-2">
                      <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                      <div className="text-[12px] font-medium text-emerald-800">
                        Sincronização concluída. {doneCount} snapshots gravados no NocoDB.
                        {errorCount > 0 && ` ${errorCount} falharam — clique novamente pra retentar.`}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/40 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                disabled={running}
                className="px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-100 transition-colors disabled:opacity-30"
              >
                {done ? 'Fechar' : 'Cancelar'}
              </button>
              <button
                onClick={startSeed}
                disabled={!enabled || running}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play size={12} />
                {running ? 'Sincronizando...' : (done ? 'Rodar de novo' : 'Iniciar sincronização')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
