import { useState, useEffect } from 'react';
import {
  fetchAllEvoHistoryMonthly,
  isHistoryEnabled,
  type EvoHistoryRow,
} from '../services/nocodbApi';

interface EvoHistoryState {
  rows: EvoHistoryRow[];
  loading: boolean;
  /** false quando a tabela gb_evo_history não está configurada (esconde a seção). */
  enabled: boolean;
}

/**
 * Carrega TODAS as linhas mensais de gb_evo_history uma única vez. A agregação
 * por unidade (respeitando o filtro do Painel) é feita no componente via
 * `aggregateHistoryByMonth`, evitando refetch a cada troca de filtro.
 *
 * Cache de módulo: a primeira tela que montar busca; as próximas reusam (o
 * histórico é imutável — meses fechados não mudam). Um refresh de página
 * recarrega naturalmente.
 */
let _cache: EvoHistoryRow[] | null = null;
let _inflight: Promise<EvoHistoryRow[]> | null = null;

export function useEvoHistory(): EvoHistoryState {
  const enabled = isHistoryEnabled();
  const [rows, setRows] = useState<EvoHistoryRow[]>(_cache ?? []);
  const [loading, setLoading] = useState<boolean>(enabled && _cache === null);

  useEffect(() => {
    // Cache já preenchido → o state inicial (useState acima) já reflete os dados,
    // nada a fazer. Desabilitado → idem. Só buscamos quando ainda não há cache.
    if (!enabled || _cache !== null) return;

    let cancelled = false;
    _inflight = _inflight ?? fetchAllEvoHistoryMonthly();
    _inflight
      .then(list => {
        _cache = list;
        // setState dentro de callback assíncrono (não no corpo do effect) — ok.
        if (!cancelled) { setRows(list); setLoading(false); }
      })
      .catch(err => {
        console.error('[useEvoHistory] erro:', err);
        if (!cancelled) setLoading(false);
      })
      .finally(() => { _inflight = null; });

    return () => { cancelled = true; };
  }, [enabled]);

  return { rows, loading, enabled };
}
