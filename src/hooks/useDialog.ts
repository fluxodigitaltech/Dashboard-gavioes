import { useEffect, useRef } from 'react';

/**
 * A11y de dialog (WCAG 2.4.3 / 2.1.2): ESC fecha, foco inicial no container,
 * focus-trap (Tab cicla dentro do modal) e retorno de foco ao elemento que abriu.
 *
 * Uso: const ref = useDialog<HTMLDivElement>(isOpen, onClose);
 *      <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="...">
 */
export function useDialog<T extends HTMLElement>(isOpen: boolean, onClose: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Foco inicial no container do diálogo.
    node?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !node) return;
      const focusables = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, onClose]);

  return ref;
}
