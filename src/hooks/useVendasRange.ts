import { useEffect, useMemo, useState } from 'react';
import { fetchVendasRangeAllBranches, fetchVendasRangeFromHistory, type VendasRangeResult } from '../services/evoApi';
import { localYMD } from '../lib/date';

function todayStr() {
  return localYMD();
}
function firstOfMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export interface UseVendasRangeResult {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (s: string) => void;
  setDateTo: (s: string) => void;
  isDefaultRange: boolean;
  vendasRange: VendasRangeResult | null;
  vendasRangeLoading: boolean;
  resetToDefault: () => void;
}

/**
 * Gerencia filtro de data customizado para Vendas. Quando o range é o default
 * (mês corrente), `vendasRange` fica null e o caller usa a soma padrão. Quando
 * é custom, dispara fetch debounced (300ms) em /sales e expõe o resultado.
 */
export function useVendasRange(): UseVendasRangeResult {
  const [dateFrom, setDateFrom] = useState(firstOfMonthStr());
  const [dateTo, setDateTo] = useState(todayStr());
  // Estado bruto do fetch. Quando isDefaultRange ou range inválido, expomos
  // null fora do effect (state derivado) — evita setState síncrono em useEffect.
  const [vendasRangeRaw, setVendasRangeRaw] = useState<VendasRangeResult | null>(null);
  const [vendasRangeLoadingRaw, setVendasRangeLoadingRaw] = useState(false);

  const isDefaultRange = useMemo(() => {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const fdStr = localYMD(firstDay);
    const todayS = localYMD(today);
    return dateFrom === fdStr && dateTo === todayS;
  }, [dateFrom, dateTo]);

  const isInvalidRange = !dateFrom || !dateTo || dateFrom > dateTo;

  useEffect(() => {
    if (isDefaultRange || isInvalidRange) return;
    let cancelled = false;
    // setLoading dentro do setTimeout (não sync no effect body) — evita
    // anti-pattern set-state-in-effect E só liga loading quando o fetch
    // realmente vai sair (após o debounce de 300ms).
    const timer = setTimeout(() => {
      if (cancelled) return;
      setVendasRangeLoadingRaw(true);
      // Histórico (VendasEvo) primeiro — rápido e sem 429. Cai pra EVO ao vivo
      // se o backend de histórico não existir ou o período ainda não tiver
      // vendas na tabela (mês não sincronizado → backfill roda em background).
      fetchVendasRangeFromHistory(dateFrom, dateTo)
        .then(hist => (hist?.enabled && hist.totalQtd > 0 ? hist : fetchVendasRangeAllBranches(dateFrom, dateTo)))
        .then(r => {
          if (!cancelled) setVendasRangeRaw(r);
        })
        .catch(err => {
          console.error('[useVendasRange] fetchVendasRangeAllBranches error:', err);
          if (!cancelled) setVendasRangeRaw(null);
        })
        .finally(() => {
          if (!cancelled) setVendasRangeLoadingRaw(false);
        });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [dateFrom, dateTo, isDefaultRange, isInvalidRange]);

  // Quando range é default/invalid, escondemos o resultado bruto — o caller
  // cai no caminho padrão (data.totalVendasMes...). Sem mexer no state.
  const vendasRange = isDefaultRange || isInvalidRange ? null : vendasRangeRaw;
  const vendasRangeLoading = isDefaultRange || isInvalidRange ? false : vendasRangeLoadingRaw;

  const resetToDefault = () => {
    setDateFrom(firstOfMonthStr());
    setDateTo(todayStr());
  };

  return {
    dateFrom, dateTo, setDateFrom, setDateTo,
    isDefaultRange, vendasRange, vendasRangeLoading,
    resetToDefault,
  };
}
