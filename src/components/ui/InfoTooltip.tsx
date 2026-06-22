import { useState, useRef, useId, useCallback, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  /** Texto explicativo (ex.: "Custo de Aquisição de Cliente"). */
  text: string;
  /** Rótulo acessível do gatilho. Default: "Mais informações". */
  label?: string;
}

/**
 * Tooltip de AJUDA (ⓘ) acessível pra explicar jargão nos cards/labels.
 * - Aparece no hover, no foco (teclado) e no toque (mobile) — ao contrário do
 *   `title=` nativo, que some no mobile e é lento.
 * - Renderizado via PORTAL no body (position:fixed) pra NÃO ser cortado por
 *   cards com `overflow-hidden`.
 * - Gatilho é um <span role="button"> (não <button>) pra poder viver DENTRO de
 *   StatsCards clicáveis sem aninhar botões (HTML inválido); para a propagação
 *   do clique pro card.
 */
export function InfoTooltip({ text, label = 'Mais informações' }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.top, left: r.left + r.width / 2 });
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }
    else if (e.key === 'Escape') { setOpen(false); }
  }, []);

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={onKeyDown}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
        className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-slate-300 hover:text-primary focus:text-primary cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors align-middle"
      >
        <Info size={13} strokeWidth={2.5} aria-hidden="true" />
      </span>
      {open && pos && createPortal(
        <div
          id={id}
          role="tooltip"
          style={{ position: 'fixed', top: pos.top - 8, left: pos.left, transform: 'translate(-50%, -100%)', zIndex: 300 }}
          className="pointer-events-none max-w-[240px] px-3 py-2 rounded-xl bg-slate-900 text-white text-[11px] font-semibold leading-snug text-center shadow-[0_8px_30px_rgba(0,0,0,0.25)]"
        >
          {text}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full -translate-x-1/2 w-0 h-0 border-[5px] border-transparent border-t-slate-900"
          />
        </div>,
        document.body,
      )}
    </>
  );
}
