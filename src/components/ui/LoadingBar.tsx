interface LoadingBarProps {
  /** Quando true, mostra a barra de progresso indeterminada. */
  active: boolean;
  /** Rótulo acessível. */
  label?: string;
}

/**
 * Barra fina de loading no topo da área de conteúdo (logo abaixo da navbar),
 * indeterminada — feedback claro de "carregando dados" em telas que demoram.
 * Posição `fixed` → aparece sempre no mesmo lugar, independente da tela.
 * Não bloqueia o conteúdo (pointer-events-none) e some quando `active` é false.
 */
export function LoadingBar({ active, label = 'Carregando dados…' }: LoadingBarProps) {
  if (!active) return null;
  return (
    <div
      role="progressbar"
      aria-busy="true"
      aria-label={label}
      className="fixed left-0 right-0 top-16 lg:top-20 z-(--z-dropdown) h-[3px] bg-primary/10 overflow-hidden pointer-events-none"
    >
      <div className="gb-loading-bar rounded-full bg-gradient-to-r from-primary via-accent to-primary shadow-[0_0_8px_rgba(177,209,53,0.5)]" />
    </div>
  );
}
