import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * lazy() resiliente a "Failed to fetch dynamically imported module".
 *
 * Depois de um deploy novo, o index.html já carregado (em memória ou cache)
 * aponta pra chunks com hash que não existem mais no servidor → o import
 * dinâmico da tela falha e cai no ErrorBoundary. Aqui, na 1ª falha forçamos
 * UM reload (que busca o index.html novo, com os hashes atualizados). Se falhar
 * de novo depois do reload, aí sim propaga o erro (não fica em loop de reload).
 *
 * O flag fica em sessionStorage e é limpo a cada import bem-sucedido — então
 * uma falha futura, de outra tela, volta a ter direito ao seu próprio retry.
 */
// Espelha a assinatura do React.lazy (ComponentType<any>): restringir os props
// aqui quebra componentes com props obrigatórias por causa da contravariância.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  const KEY = 'gb_chunk_reloaded';
  return lazy(async () => {
    try {
      const mod = await factory();
      try { sessionStorage.removeItem(KEY); } catch { /* sessionStorage indisponível */ }
      return mod;
    } catch (err) {
      let alreadyReloaded = false;
      try { alreadyReloaded = !!sessionStorage.getItem(KEY); } catch { /* idem */ }
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(KEY, '1'); } catch { /* idem */ }
        window.location.reload();
        // Promise que nunca resolve: o reload assume antes de renderizar nada.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}
