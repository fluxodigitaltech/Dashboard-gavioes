import { useCallback, useState } from 'react';
import { getLayoutForCurrentUser, saveLayoutForCurrentUser, type PanelLayout } from '../services/nocodbApi';

type LayoutStorageKey = Parameters<typeof getLayoutForCurrentUser>[0];

export interface UseDashboardLayoutResult<Id extends string> {
  cardOrder: Id[];
  hiddenCards: Set<Id>;
  editLayoutMode: boolean;
  savingLayout: boolean;
  startEditLayout: () => void;
  cancelEditLayout: () => void;
  resetLayoutToDefault: () => void;
  saveLayout: () => Promise<void>;
  moveCard: (id: Id, dir: -1 | 1) => void;
  toggleHidden: (id: Id) => void;
}

/**
 * Mescla layout salvo com IDs default — preserva ordem salva, adiciona novos cards ao final.
 */
function mergeOrder<Id extends string>(saved: string[], allIds: readonly Id[]): Id[] {
  const seen = new Set<string>();
  const result: Id[] = [];
  for (const id of saved) {
    if ((allIds as readonly string[]).includes(id) && !seen.has(id)) {
      result.push(id as Id);
      seen.add(id);
    }
  }
  for (const id of allIds) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

/**
 * Gerencia layout persistido (ordem + cards escondidos) do Painel.
 * @param storageKey chave usada em saveLayoutForCurrentUser (ex: 'dashboard_layout')
 * @param allIds lista canônica de IDs (ordem default)
 */
export function useDashboardLayout<Id extends string>(
  storageKey: LayoutStorageKey,
  allIds: readonly Id[],
): UseDashboardLayoutResult<Id> {
  // Lazy init lê localStorage uma vez no mount — evita setState síncrono em
  // useEffect (anti-pattern do React 19) e elimina o flicker do default→saved.
  const [cardOrder, setCardOrder] = useState<Id[]>(() => {
    const saved = getLayoutForCurrentUser(storageKey);
    return saved ? mergeOrder(saved.order, allIds) : [...allIds];
  });
  const [hiddenCards, setHiddenCards] = useState<Set<Id>>(() => {
    const saved = getLayoutForCurrentUser(storageKey);
    if (!saved) return new Set();
    return new Set(saved.hidden.filter(id => (allIds as readonly string[]).includes(id)) as Id[]);
  });
  const [editLayoutMode, setEditLayoutMode] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutSnapshot, setLayoutSnapshot] = useState<{ order: Id[]; hidden: Set<Id> } | null>(null);

  const startEditLayout = useCallback(() => {
    setLayoutSnapshot({ order: [...cardOrder], hidden: new Set(hiddenCards) });
    setEditLayoutMode(true);
  }, [cardOrder, hiddenCards]);

  const cancelEditLayout = useCallback(() => {
    if (layoutSnapshot) {
      setCardOrder(layoutSnapshot.order);
      setHiddenCards(layoutSnapshot.hidden);
    }
    setEditLayoutMode(false);
    setLayoutSnapshot(null);
  }, [layoutSnapshot]);

  const resetLayoutToDefault = useCallback(() => {
    setCardOrder([...allIds]);
    setHiddenCards(new Set());
  }, [allIds]);

  const saveLayout = useCallback(async () => {
    setSavingLayout(true);
    try {
      const layout: PanelLayout = { order: cardOrder, hidden: Array.from(hiddenCards) };
      await saveLayoutForCurrentUser(storageKey, layout);
      setEditLayoutMode(false);
      setLayoutSnapshot(null);
    } catch (e) {
      console.error('[useDashboardLayout] saveLayout error:', e);
    } finally {
      setSavingLayout(false);
    }
  }, [cardOrder, hiddenCards, storageKey]);

  const moveCard = useCallback((id: Id, dir: -1 | 1) => {
    setCardOrder(prev => {
      const idx = prev.indexOf(id);
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  const toggleHidden = useCallback((id: Id) => {
    setHiddenCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return {
    cardOrder,
    hiddenCards,
    editLayoutMode,
    savingLayout,
    startEditLayout,
    cancelEditLayout,
    resetLayoutToDefault,
    saveLayout,
    moveCard,
    toggleHidden,
  };
}
